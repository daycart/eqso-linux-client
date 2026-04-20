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

echo "==> parar servicios para poder recargar el modulo de audio"
sudo systemctl stop eqso-relay 2>/dev/null || true
sudo systemctl stop eqso       2>/dev/null || true
sleep 1

echo "==> deshabilitar autosuspend del modulo snd_usb_audio (permanente)"
echo "options snd_usb_audio autosuspend=-1" \
  | sudo tee /etc/modprobe.d/usb-audio-nosuspend.conf > /dev/null

echo "==> recargar snd_usb_audio con autosuspend=-1 (modulo libre ahora)"
sudo modprobe -r snd_usb_audio 2>/dev/null || true
sleep 1
sudo modprobe snd_usb_audio
sleep 2

echo "==> crear /opt/eqso-asorapa/wake-audio.sh (ExecStartPre del servicio)"
sudo tee /opt/eqso-asorapa/wake-audio.sh > /dev/null << 'WAKE_SCRIPT'
#!/bin/bash
# Despierta la tarjeta USB de audio y espera a que ALSA la registre.
# Se ejecuta como root antes de que arranque el relay-daemon.

# 1. power/control=on en todas las tarjetas de audio USB
for card_sysfs in /sys/class/sound/card*/; do
  usb_dev=$(readlink -f "${card_sysfs}device" 2>/dev/null)
  for i in 1 2 3 4; do
    usb_dev=$(dirname "$usb_dev" 2>/dev/null)
    if [ -f "${usb_dev}/idVendor" ] && [ -f "${usb_dev}/power/control" ]; then
      echo on > "${usb_dev}/power/control" 2>/dev/null || true
      break
    fi
  done
done

# 2. Esperar hasta 10s a que la tarjeta USB aparezca en ALSA
for i in $(seq 1 10); do
  grep -q " 1 \[" /proc/asound/cards 2>/dev/null && break
  sleep 1
done

# 3. Dar tiempo al TCP 2171 a que este escuchando
sleep 4
exit 0
WAKE_SCRIPT
sudo chmod +x /opt/eqso-asorapa/wake-audio.sh

echo "==> actualizar eqso-relay.service con ExecStartPre"
sudo tee /etc/systemd/system/eqso-relay.service > /dev/null << 'SERVICE_FILE'
[Unit]
Description=eQSO Relay Daemon
After=network.target eqso.service
Requires=eqso.service

[Service]
Type=simple
User=david
WorkingDirectory=/opt/eqso-asorapa/artifacts/relay-daemon
ExecStartPre=+/opt/eqso-asorapa/wake-audio.sh
ExecStart=/usr/bin/node --enable-source-maps dist/main.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICE_FILE
sudo systemctl daemon-reload

echo "==> verificar tarjeta USB disponible"
arecord -l 2>/dev/null || true

echo "==> start eqso (api-server + TCP)"
sudo systemctl start eqso

echo "==> esperando 6s iniciales..."
sleep 6

echo "==> start eqso-relay (wake-audio.sh esperara tarjeta + TCP)"
sudo systemctl start eqso-relay

echo "==> status"
sudo systemctl is-active eqso eqso-relay

echo "==> done"
