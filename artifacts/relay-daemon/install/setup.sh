#!/usr/bin/env bash
# setup.sh — Instala el demonio de radioenlace eQSO en la VM
#
# Uso:
#   sudo bash setup.sh [INSTANCIA]
#
# Ejemplo (sala CB):
#   sudo bash setup.sh CB
#
# Requisitos previos:
#   - Node.js 20+
#   - ffmpeg   (sudo apt install ffmpeg)
#   - alsa-utils (sudo apt install alsa-utils)
#   - Usuario "eqso" existente con grupo "audio"

set -euo pipefail

INSTANCE="${1:-CB}"
INSTALL_DIR="/opt/eqso-asorapa/artifacts/relay-daemon"
CONFIG_DIR="/etc/eqso-relay"
SERVICE="eqso-relay@${INSTANCE}"

echo "========================================"
echo "  Instalando eQSO Relay — instancia: $INSTANCE"
echo "========================================"

# ── Dependencias del sistema ──────────────────────────────────────────────────
echo "[1/5] Verificando dependencias del sistema…"
for cmd in node ffmpeg arecord aplay; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "  ERROR: '$cmd' no encontrado."
    case "$cmd" in
      ffmpeg)  echo "  Instala con: sudo apt install ffmpeg" ;;
      arecord|aplay) echo "  Instala con: sudo apt install alsa-utils" ;;
      node)    echo "  Instala Node.js 20: https://nodejs.org" ;;
    esac
    exit 1
  fi
  echo "  OK: $cmd $(${cmd} --version 2>&1 | head -1)"
done

# ── Compilar el demonio ───────────────────────────────────────────────────────
echo "[2/5] Compilando relay-daemon…"
cd "$(dirname "$0")/.."
sudo -u eqso bash -c "cd $INSTALL_DIR && pnpm install && pnpm run build"

# ── Directorio de configuracion ───────────────────────────────────────────────
echo "[3/5] Creando directorio de configuracion $CONFIG_DIR…"
mkdir -p "$CONFIG_DIR"
chmod 750 "$CONFIG_DIR"

CONFIG_FILE="$CONFIG_DIR/${INSTANCE}.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "  Copiando config de ejemplo a $CONFIG_FILE"
  cp "$(dirname "$0")/config.example.json" "$CONFIG_FILE"
  # Ajustar la sala al nombre de la instancia
  sed -i "s/\"room\": \"CB\"/\"room\": \"${INSTANCE}\"/" "$CONFIG_FILE"
  chown eqso:eqso "$CONFIG_FILE"
  chmod 640 "$CONFIG_FILE"
  echo ""
  echo "  IMPORTANTE: edita $CONFIG_FILE antes de arrancar el servicio."
  echo "  Ajusta: callsign, password, server, captureDevice, playbackDevice"
  echo ""
else
  echo "  Config existente encontrada: $CONFIG_FILE (no se sobreescribe)"
fi

# ── Instalar unidad systemd ───────────────────────────────────────────────────
echo "[4/5] Instalando unidad systemd…"
UNIT_SRC="$(dirname "$0")/eqso-relay@.service"
UNIT_DST="/etc/systemd/system/eqso-relay@.service"

cp "$UNIT_SRC" "$UNIT_DST"
# Actualizar la ruta de instalacion en el archivo de servicio
sed -i "s|/opt/eqso-asorapa/artifacts/relay-daemon|${INSTALL_DIR}|g" "$UNIT_DST"

systemctl daemon-reload
echo "  Unidad instalada: $UNIT_DST"

# ── Habilitar y arrancar ──────────────────────────────────────────────────────
echo "[5/5] Habilitando y arrancando $SERVICE…"
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  echo ""
  echo "  SERVICIO ACTIVO"
  echo ""
  systemctl status "$SERVICE" --no-pager -l
else
  echo ""
  echo "  ERROR: el servicio no arranco. Comprueba los logs:"
  echo "  journalctl -u $SERVICE -n 50 --no-pager"
  exit 1
fi

echo ""
echo "========================================"
echo "  Instalacion completa"
echo ""
echo "  Comandos utiles:"
echo "    Ver logs:       journalctl -u $SERVICE -f"
echo "    Estado:         systemctl status $SERVICE"
echo "    Reiniciar:      systemctl restart $SERVICE"
echo "    Parar:          systemctl stop $SERVICE"
echo "    Control HTTP:   curl http://127.0.0.1:8009/status"
echo "    PTT manual:     curl -X POST http://127.0.0.1:8009/ptt/start"
echo "    Reconectar:     curl -X POST http://127.0.0.1:8009/reconnect"
echo "========================================"
