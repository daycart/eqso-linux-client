#!/usr/bin/env python3
"""
Helper persistente de PTT serial.
Lee comandos '1' / '0' desde stdin y activa / desactiva RTS o DTR
en el dispositivo serie indicado.

Uso: python3 ptt-helper.py <device> [rts|dtr] [true|false (inverted)]

Solo usa modulos de la biblioteca estandar de Python 3 (fcntl, os).
"""
import sys
import os
import fcntl

TIOCM_DTR = 0x002
TIOCM_RTS = 0x004
TIOCMGET  = 0x5415
TIOCMSET  = 0x5418

def get_mctrl(fd):
    buf = bytearray(4)
    fcntl.ioctl(fd, TIOCMGET, buf, True)
    return int.from_bytes(buf, sys.byteorder)

def set_mctrl(fd, value):
    fcntl.ioctl(fd, TIOCMSET, value.to_bytes(4, sys.byteorder))

def main():
    if len(sys.argv) < 2:
        print("uso: ptt-helper.py <device> [rts|dtr] [true|false]", file=sys.stderr)
        sys.exit(1)

    device   = sys.argv[1]
    method   = sys.argv[2].lower() if len(sys.argv) > 2 else "rts"
    inverted = (len(sys.argv) > 3 and sys.argv[3].lower() == "true")
    mask     = TIOCM_RTS if method == "rts" else TIOCM_DTR

    try:
        fd = os.open(device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        print(f"error abriendo {device}: {e}", file=sys.stderr)
        sys.exit(1)

    # Aseguramos que PTT empieza en OFF
    try:
        mctl = get_mctrl(fd)
        mctl &= ~mask
        set_mctrl(fd, mctl)
    except OSError as e:
        print(f"error ioctl inicial: {e}", file=sys.stderr)
        os.close(fd)
        sys.exit(1)

    sys.stdout.write("ready\n")
    sys.stdout.flush()

    for line in sys.stdin:
        cmd = line.strip()
        if cmd not in ("0", "1"):
            continue
        activate = (cmd == "1") ^ inverted
        try:
            mctl = get_mctrl(fd)
            if activate:
                mctl |= mask
            else:
                mctl &= ~mask
            set_mctrl(fd, mctl)
        except OSError as e:
            print(f"error ioctl PTT: {e}", file=sys.stderr)

    # Apagar PTT al salir
    try:
        mctl = get_mctrl(fd)
        mctl &= ~mask
        set_mctrl(fd, mctl)
    except OSError:
        pass
    os.close(fd)

if __name__ == "__main__":
    main()
