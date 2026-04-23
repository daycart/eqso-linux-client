#!/bin/sh
# Configura los niveles del mixer ALSA del CM108 tras el reset USB.
# Los niveles vuelven a los defaults del driver (puede ser 0%) con cada reset.
#
# Playback (Speaker/Headphone/PCM) al 100%: la senal del servidor llega
#   con suficiente nivel al microfono de la radio CB.
# Capture (Mic/Capture) al 40%: evita saturacion y distorsion en la
#   codificacion GSM del audio de la radio.

CARD=$(aplay -l 2>/dev/null | grep -iE "CM108|C-Media|USB Audio" | head -1 | sed 's/.*card //;s/:.*//' | tr -d ' ')

if [ -z "$CARD" ]; then
    echo "ALSA setup: no se encontro tarjeta CM108, omitiendo"
    exit 0
fi

echo "ALSA setup: configurando tarjeta $CARD"

amixer -c "$CARD" sset "Speaker"   100% unmute 2>/dev/null && echo "  Speaker   100%" || true
amixer -c "$CARD" sset "Headphone" 100% unmute 2>/dev/null && echo "  Headphone 100%" || true
amixer -c "$CARD" sset "PCM"       100%         2>/dev/null && echo "  PCM       100%" || true
amixer -c "$CARD" sset "Mic"        40% unmute  2>/dev/null && echo "  Mic        40%" || true
amixer -c "$CARD" sset "Capture"    40% unmute  2>/dev/null && echo "  Capture    40%" || true

exit 0
