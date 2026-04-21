#!/usr/bin/env bash
# dev-setup.sh — entorno de desarrollo/pruebas sin radio ni COM
# Usar en la VM cuando el servidor Windows esta activo y no hay hardware RF disponible.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> git pull"
git pull

echo "==> pnpm install"
pnpm install

echo "==> build eqso-client"
pnpm --filter @workspace/eqso-client run build

echo "==> build api-server"
pnpm --filter @workspace/api-server run build

echo "==> build relay-daemon"
pnpm --filter @workspace/relay-daemon run build

echo "==> cargar modulo loopback de audio virtual"
sudo modprobe snd-aloop 2>/dev/null || true
sleep 1
echo "Tarjetas de audio disponibles:"
arecord -l 2>/dev/null || true

# Detectar numero de tarjeta loopback
LOOPBACK_CARD=$(arecord -l 2>/dev/null | grep -i loopback | head -1 | grep -oP 'card \K[0-9]+' || echo "")
if [ -z "$LOOPBACK_CARD" ]; then
  echo "AVISO: no se encontro tarjeta loopback, usando card 2 por defecto"
  LOOPBACK_CARD="2"
fi
echo "Loopback detectado en card ${LOOPBACK_CARD}"

echo "==> escribir configuracion relay-daemon (modo desarrollo — sin PTT, audio loopback)"
sudo mkdir -p /etc/eqso-relay
sudo tee /etc/eqso-relay/default.json > /dev/null << EQSO_CONFIG
{
  "callsign": "0R-IN70WN",
  "room": "CB",
  "password": "",
  "message": "Radio Enlace IN70WN [DEV]",
  "server": "127.0.0.1",
  "port": 2171,
  "audio": {
    "captureDevice": "plughw:Loopback,0",
    "playbackDevice": "plughw:Loopback,1",
    "vox": false,
    "voxThresholdRms": 2000,
    "voxHangMs": 1200,
    "inputGain": 1.0,
    "outputGain": 1.0
  },
  "ptt": {
    "device": "",
    "method": "rts",
    "inverted": false
  }
}
EQSO_CONFIG
sudo chmod 644 /etc/eqso-relay/default.json

echo "==> asegurar que david pertenece al grupo audio"
sudo usermod -aG audio david 2>/dev/null || true

echo "==> actualizar eqso-relay.service (ExecStartPre simplificado para dev)"
sudo tee /etc/systemd/system/eqso-relay.service > /dev/null << 'SERVICE_FILE'
[Unit]
Description=eQSO Relay Daemon
After=network.target eqso.service
Requires=eqso.service

[Service]
Type=simple
User=david
SupplementaryGroups=audio
WorkingDirectory=/opt/eqso-asorapa/artifacts/relay-daemon
ExecStart=/usr/bin/node --enable-source-maps dist/main.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICE_FILE
sudo systemctl daemon-reload

echo "==> reiniciar servicios"
sudo systemctl stop eqso-relay 2>/dev/null || true
sudo systemctl stop eqso       2>/dev/null || true
sleep 1
sudo systemctl start eqso
sleep 5
sudo systemctl start eqso-relay
sleep 2

echo "==> status"
sudo systemctl is-active eqso eqso-relay

echo ""
echo "==> Entorno DEV activo. Sin PTT serial, audio via loopback virtual."
echo "    Para inyectar audio de prueba al relay:"
echo "      aplay -D plughw:Loopback,1 archivo.wav"
echo "    Para capturar lo que el relay reproduce:"
echo "      arecord -D plughw:Loopback,0 -f S16_LE -r 8000 -c 1 salida.wav"
echo ""
echo "==> done"
