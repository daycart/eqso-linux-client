#!/usr/bin/env bash
# dev-setup.sh — entorno de desarrollo/pruebas sin radio ni COM
# Al terminar las pruebas restaura automaticamente la configuracion de produccion.
set -euo pipefail
cd "$(dirname "$0")"

# ─── FUNCIONES ────────────────────────────────────────────────────────────────

restaurar_produccion() {
  echo ""
  echo "==> Restaurando configuracion de produccion..."

  echo "==> wake-audio.sh + servicio con ExecStartPre"
  sudo tee /opt/eqso-asorapa/wake-audio.sh > /dev/null << 'WAKE_SCRIPT'
#!/bin/bash
chmod -R a+rw /dev/snd/ 2>/dev/null || true
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
amixer -c 1 sset "Mic" 100% cap 2>/dev/null || true
amixer -c 1 sset "Capture" 100% cap 2>/dev/null || true
amixer -c 1 sset "Speaker" 80% 2>/dev/null || true
amixer -c 1 sset "PCM" 90% 2>/dev/null || true
for i in $(seq 1 15); do
  grep -q " 1 \[" /proc/asound/cards 2>/dev/null && break
  sleep 1
done
sleep 4
exit 0
WAKE_SCRIPT
  sudo chmod +x /opt/eqso-asorapa/wake-audio.sh

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
ExecStartPre=+/opt/eqso-asorapa/wake-audio.sh
ExecStart=/usr/bin/node --enable-source-maps dist/main.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICE_FILE
  sudo systemctl daemon-reload

  echo "==> Config produccion: USB audio + PTT serial"
  sudo mkdir -p /etc/eqso-relay
  sudo tee /etc/eqso-relay/default.json > /dev/null << 'EQSO_PROD'
{
  "callsign": "0R-IN70WN",
  "room": "CB",
  "password": "",
  "message": "Radio Enlace IN70WN",
  "server": "127.0.0.1",
  "port": 2171,
  "audio": {
    "captureDevice": "plughw:Device,0",
    "playbackDevice": "plughw:Device,0",
    "vox": true,
    "voxThresholdRms": 2000,
    "voxHangMs": 1200,
    "inputGain": 4.0,
    "outputGain": 2.5
  },
  "ptt": {
    "device": "/dev/ttyACM0",
    "method": "rts",
    "inverted": false
  }
}
EQSO_PROD
  sudo chmod 644 /etc/eqso-relay/default.json

  echo "==> Descargar modulo loopback"
  sudo modprobe -r snd-aloop 2>/dev/null || true

  echo "==> Recargar modulo USB audio"
  sudo modprobe -r snd_usb_audio 2>/dev/null || true
  sleep 1
  sudo modprobe snd_usb_audio
  sleep 2

  echo "==> Reiniciar servicios en modo produccion"
  sudo systemctl stop eqso-relay 2>/dev/null || true
  sudo systemctl stop eqso       2>/dev/null || true
  sleep 1
  sudo systemctl start eqso
  sleep 6
  sudo systemctl start eqso-relay
  sleep 2

  echo "==> Status produccion:"
  sudo systemctl is-active eqso eqso-relay
  echo "==> Produccion restaurada."
}

# Capturar Ctrl+C para restaurar igualmente
trap 'echo ""; echo "Interrupcion detectada."; restaurar_produccion; exit 0' INT TERM

# ─── FASE 1: BUILD ────────────────────────────────────────────────────────────

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

# ─── FASE 2: ENTORNO DEV ──────────────────────────────────────────────────────

echo "==> cargar modulo loopback de audio virtual"
sudo modprobe snd-aloop 2>/dev/null || true
sleep 1
echo "Tarjetas disponibles:"
arecord -l 2>/dev/null || true

echo "==> asegurar que david pertenece al grupo audio"
sudo usermod -aG audio david 2>/dev/null || true

echo "==> config relay-daemon modo DEV (sin PTT, loopback, VOX desactivado)"
sudo mkdir -p /etc/eqso-relay
sudo tee /etc/eqso-relay/default.json > /dev/null << 'EQSO_CONFIG'
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

echo "==> servicio sin ExecStartPre (no necesario en dev)"
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

echo "==> iniciar servicios en modo DEV"
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
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  MODO DEV ACTIVO — sin PTT serial, audio via loopback ALSA  ║"
echo "║                                                              ║"
echo "║  Inyectar audio de prueba:                                   ║"
echo "║    aplay -D plughw:Loopback,1 archivo.wav                    ║"
echo "║  Grabar lo que reproduce el relay:                           ║"
echo "║    arecord -D plughw:Loopback,0 -f S16_LE -r 8000 -c 1 out.wav ║"
echo "║                                                              ║"
echo "║  Cuando termines pulsa ENTER para restaurar produccion       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
read -r -p "Pulsa ENTER para restaurar produccion... "

restaurar_produccion
