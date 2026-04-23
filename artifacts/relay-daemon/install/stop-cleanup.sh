#!/bin/sh
# Limpieza post-parada: mata procesos ALSA residuales y resetea el USB.
# Se llama desde ExecStopPost del servicio systemd.

pkill -KILL -x aplay   2>/dev/null || true
pkill -KILL -x arecord 2>/dev/null || true

for dev_dir in /sys/bus/usb/devices/*/; do
    product_file="${dev_dir}product"
    if grep -qiE "audio|CM108|C-Media" "$product_file" 2>/dev/null; then
        auth_file="${dev_dir}authorized"
        echo 0 > "$auth_file" 2>/dev/null || true
        sleep 0.5
        echo 1 > "$auth_file" 2>/dev/null || true
    fi
done

exit 0
