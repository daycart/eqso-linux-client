#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> git pull"
git pull

echo "==> pnpm install"
pnpm install

echo "==> build eqso-client"
pnpm --filter @workspace/eqso-client run build

echo "==> build api-server (copies client dist into dist/public)"
pnpm --filter @workspace/api-server run build

echo "==> build relay-daemon"
pnpm --filter @workspace/relay-daemon run build

echo "==> escribir configuracion relay-daemon"
sudo mkdir -p /etc/eqso-relay
sudo tee /etc/eqso-relay/default.json > /dev/null << 'EQSO_CONFIG'
{
  "callsign": "0R-IN70WN",
  "room": "CB",
  "password": "",
  "message": "Radio Enlace IN70WN",
  "server": "127.0.0.1",
  "port": 2171,
  "audio": {
    "captureDevice": "plughw:1,0",
    "playbackDevice": "plughw:1,0",
    "vox": true,
    "voxThresholdRms": 600,
    "voxHangMs": 1000,
    "inputGain": 1.0,
    "outputGain": 1.0
  },
  "ptt": {
    "device": "/dev/ttyACM0",
    "method": "rts",
    "inverted": false
  }
}
EQSO_CONFIG
sudo chmod 644 /etc/eqso-relay/default.json

echo "==> mantener tarjetas USB de audio siempre encendidas (evitar autosuspend)"
for dev in /sys/bus/usb/devices/*/; do
  echo on  | sudo tee "${dev}power/control"              > /dev/null 2>&1 || true
  echo -1  | sudo tee "${dev}power/autosuspend_delay_ms" > /dev/null 2>&1 || true
done

echo "==> despertar tarjeta de audio USB si estaba dormida (plughw:1,0)"
# Abrir el dispositivo brevemente fuerza al kernel a hacer USB resume
sudo timeout 2 arecord -D plughw:1,0 -f S16_LE -r 8000 -c 1 -q /dev/null 2>/dev/null || true
sleep 1

echo "==> restart eqso (api-server + TCP)"
sudo systemctl restart eqso

echo "==> esperando 8s a que el puerto TCP 2171 este listo..."
sleep 8

echo "==> restart eqso-relay"
sudo systemctl restart eqso-relay

echo "==> status"
sudo systemctl is-active eqso eqso-relay

echo "==> done"
