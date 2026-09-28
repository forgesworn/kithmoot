#!/bin/bash
# Two 1600x900 monitors side by side under Cinnamon's window manager, then the command given.
export DISPLAY=:99 XDG_SESSION_TYPE=x11
rm -f /tmp/.X99-lock
Xorg :99 -noreset -config /work/xorg.conf -logfile /tmp/xorg.log >/tmp/xorg.out 2>&1 &
for i in $(seq 1 80); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
xrandr --output DUMMY0 --mode 1600x900 --pos 0x0 --primary
xrandr --addmode DUMMY1 1600x900
xrandr --output DUMMY1 --mode 1600x900 --pos 1600x0
eval "$(dbus-launch --sh-syntax)"
muffin >/tmp/muffin.log 2>&1 &
sleep 2
pgrep muffin >/dev/null || { echo "Cinnamon's window manager did not start:"; cat /tmp/muffin.log; exit 1; }
exec "$@"
