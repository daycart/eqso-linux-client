#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${CYAN}[..] $1${NC}"; }
warn() { echo -e "${YELLOW}[!!] $1${NC}"; }
fail() { echo -e "${RED}[ERROR] $1${NC}"; exit 1; }

echo ""
echo "=============================================="
echo "   eQSO ASORAPA - Script de instalacion"
echo "=============================================="
echo ""

if [ "$EUID" -ne 0 ]; then
  fail "Ejecuta el script como root: sudo bash install-server.sh"
fi

INSTALL_DIR="/opt/eqso-asorapa"
SERVICE_USER="eqso"

echo -e "${CYAN}Configuracion inicial${NC}"
echo "---------------------------------------------"

read -p "Contrasena para la base de datos PostgreSQL: " -s DB_PASS; echo
[ -z "$DB_PASS" ] && fail "La contrasena no puede estar vacia"

read -p "Clave secreta de sesion (enter para generar automaticamente): " SESSION_SECRET
if [ -z "$SESSION_SECRET" ]; then
  SESSION_SECRET=$(openssl rand -hex 32)
  ok "Clave de sesion generada automaticamente"
fi

read -p "Dominio o IP publica del servidor (ej: eqso.midominio.com o 1.2.3.4): " SERVER_HOST
[ -z "$SERVER_HOST" ] && fail "Debes indicar el dominio o IP"

read -p "Configurar nginx con SSL (solo si tienes dominio real, no IP)? [s/N]: " SETUP_SSL
SETUP_SSL=${SETUP_SSL,,}

echo ""

info "Actualizando paquetes del sistema..."
apt-get update -qq
ok "Paquetes actualizados"

info "Instalando dependencias del sistema..."
apt-get install -y -qq \
  curl wget git nginx ffmpeg \
  postgresql postgresql-contrib \
  certbot python3-certbot-nginx \
  ufw openssl
ok "Dependencias instaladas"

info "Instalando Node.js 20..."
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
  apt-get install -y -qq nodejs
fi
ok "Node.js $(node -v) instalado"

info "Instalando pnpm..."
npm install -g pnpm@10 &>/dev/null
ok "pnpm $(pnpm -v) instalado"

info "Configurando base de datos PostgreSQL..."
systemctl start postgresql
systemctl enable postgresql &>/dev/null

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='eqso'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER eqso WITH PASSWORD '${DB_PASS}';" &>/dev/null

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='eqso'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE eqso OWNER eqso;" &>/dev/null

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE eqso TO eqso;" &>/dev/null
ok "Base de datos lista"

DATABASE_URL="postgresql://eqso:${DB_PASS}@localhost:5432/eqso"

if id "$SERVICE_USER" &>/dev/null; then
  ok "Usuario del servicio '$SERVICE_USER' ya existe"
else
  info "Creando usuario del sistema '$SERVICE_USER'..."
  useradd --system --shell /bin/bash --home "$INSTALL_DIR" "$SERVICE_USER"
  ok "Usuario '$SERVICE_USER' creado"
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Actualizando codigo existente en $INSTALL_DIR..."
  cd "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" git pull origin main
else
  info "Clonando repositorio en $INSTALL_DIR..."
  git clone https://github.com/daycart/eqso-linux-client.git "$INSTALL_DIR"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
fi
ok "Codigo listo"

info "Instalando dependencias de Node.js..."
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" pnpm install --frozen-lockfile &>/dev/null
ok "Dependencias instaladas"

info "Compilando cliente web..."
sudo -u "$SERVICE_USER" env \
  PORT=8080 \
  BASE_PATH=/ \
  NODE_ENV=production \
  pnpm --filter @workspace/eqso-client run build &>/dev/null
ok "Cliente web compilado"

info "Compilando servidor API..."
sudo -u "$SERVICE_USER" pnpm --filter @workspace/api-server run build &>/dev/null
ok "Servidor API compilado"

info "Copiando archivos estaticos del cliente..."
cp -r "$INSTALL_DIR/artifacts/eqso-client/dist/public" \
      "$INSTALL_DIR/artifacts/api-server/dist/public"
ok "Archivos estaticos copiados"

info "Creando archivo de configuracion..."
cat > /etc/eqso.env << EOF
NODE_ENV=production
PORT=8080
DATABASE_URL=${DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}
EQSO_TCP_PORT=2171
EQSO_TCP_PORT_ALT=8008
EOF
chmod 600 /etc/eqso.env
ok "Configuracion guardada en /etc/eqso.env"

info "Aplicando esquema de base de datos..."
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" env DATABASE_URL="$DATABASE_URL" \
  pnpm --filter @workspace/db run push &>/dev/null || \
  warn "Fallo db:push (puede que ya exista el esquema)"
ok "Esquema de base de datos aplicado"

info "Creando servicio systemd..."
cat > /etc/systemd/system/eqso.service << EOF
[Unit]
Description=eQSO ASORAPA Server
After=network.target postgresql.service

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=/etc/eqso.env
ExecStart=/usr/bin/node --enable-source-maps artifacts/api-server/dist/index.mjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable eqso &>/dev/null
systemctl restart eqso
sleep 2

if systemctl is-active --quiet eqso; then
  ok "Servicio eqso arrancado correctamente"
else
  warn "El servicio no arranco. Comprueba: journalctl -u eqso -n 30"
fi

info "Configurando nginx..."
cat > /etc/nginx/sites-available/eqso << EOF
server {
    listen 80;
    server_name ${SERVER_HOST};

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
EOF

ln -sf /etc/nginx/sites-available/eqso /etc/nginx/sites-enabled/eqso
rm -f /etc/nginx/sites-enabled/default
nginx -t &>/dev/null && systemctl reload nginx
ok "nginx configurado"

if [ "$SETUP_SSL" = "s" ]; then
  info "Obteniendo certificado SSL con Let's Encrypt..."
  certbot --nginx -d "$SERVER_HOST" --non-interactive --agree-tos \
    --email "admin@${SERVER_HOST}" --redirect &>/dev/null && \
    ok "Certificado SSL instalado" || \
    warn "No se pudo obtener el certificado SSL. Comprueba que el dominio apunta a esta IP."
fi

info "Configurando firewall..."
ufw allow 22/tcp &>/dev/null
ufw allow 80/tcp &>/dev/null
ufw allow 443/tcp &>/dev/null
ufw allow 2171/tcp &>/dev/null
ufw allow 8008/tcp &>/dev/null
ufw --force enable &>/dev/null
ok "Firewall configurado"

echo ""
echo "=============================================="
echo -e "${GREEN}   Instalacion completada${NC}"
echo "=============================================="
echo ""
echo "  Servidor web:    http://${SERVER_HOST}"
if [ "$SETUP_SSL" = "s" ]; then
echo "  Servidor web:    https://${SERVER_HOST}"
echo "  WebSocket URL:   wss://${SERVER_HOST}/ws"
else
echo "  WebSocket URL:   ws://${SERVER_HOST}/ws"
fi
echo "  Puerto eQSO TCP: ${SERVER_HOST}:2171 y :8008"
echo ""
echo "  Logs del servidor:  journalctl -u eqso -f"
echo "  Reiniciar:          systemctl restart eqso"
echo "  Estado:             systemctl status eqso"
echo ""
if [ "$SETUP_SSL" = "s" ]; then
echo -e "${YELLOW}  Para GitHub Pages, configura el secreto:${NC}"
echo "  VITE_API_WS_URL = wss://${SERVER_HOST}/ws"
else
echo -e "${YELLOW}  Para GitHub Pages necesitas SSL (dominio + certbot).${NC}"
echo "  Sin SSL los navegadores bloquearan WebSocket."
fi
echo ""
