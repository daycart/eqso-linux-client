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

echo "==> regla udev permanente: deshabilitar autosuspend en tarjetas USB de audio"
sudo tee /etc/udev/rules.d/91-usb-audio-nosuspend.rules > /dev/null << 'UDEV_RULE'
# Mantener encendidos todos los dispositivos USB de audio (no autosuspend)
SUBSYSTEM=="usb", ATTR{product}=="USB Audio Device", ATTR{power/control}="on", ATTR{power/autosuspend}="-1"
SUBSYSTEM=="usb", DRIVER=="snd-usb-audio", ATTR{power/control}="on"
UDEV_RULE
sudo udevadm control --reload-rules 2>/dev/null || true

echo "==> recargar modulo snd_usb_audio para despertar la tarjeta (PCM re-enumeration)"
sudo modprobe -r snd_usb_audio 2>/dev/null || true
sleep 1
sudo modprobe snd_usb_audio
sleep 2  # dar tiempo al dispositivo a inicializarse

echo "==> verificar que la tarjeta USB esta disponible"
arecord -l 2>/dev/null || true

echo "==> restart eqso (api-server + TCP)"
sudo systemctl restart eqso

echo "==> esperando 8s a que el puerto TCP 2171 este listo..."
sleep 8

echo "==> restart eqso-relay"
sudo systemctl restart eqso-relay

echo "==> status"
sudo systemctl is-active eqso eqso-relay

echo "==> done"
