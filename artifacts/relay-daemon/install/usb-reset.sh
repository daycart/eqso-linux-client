#!/bin/sh
# Resetea el dispositivo USB de audio (CM108) via sysfs para liberar
# cualquier aplay/arecord en D-state antes de arrancar el servicio.
set -e

pkill -KILL -x aplay   2>/dev/null || true
pkill -KILL -x arecord 2>/dev/null || true
sleep 0.3

python3 - <<'PYEOF'
import fcntl, subprocess, re, time

USBDEVFS_RESET = 21524

try:
    out = subprocess.check_output(["lsusb"]).decode()
except Exception:
    out = ""

for line in out.splitlines():
    m = re.search(r"Bus (\d+) Device (\d+)", line)
    if m and re.search(r"audio|CM108|C-Media", line, re.IGNORECASE):
        path = "/dev/bus/usb/{}/{}".format(m.group(1), m.group(2).zfill(3))
        try:
            fd = open(path, "wb")
            fcntl.ioctl(fd, USBDEVFS_RESET, 0)
            fd.close()
            print("USB reset: " + path)
            time.sleep(1)
        except Exception as e:
            print("USB reset error: " + str(e))
PYEOF

sleep 2
