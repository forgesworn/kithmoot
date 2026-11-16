# Direct drawings on native Wayland

KithMoot uses an opt-in compositor companion on GNOME Shell and KDE Plasma.
It paints over the shared window or display without an XWayland preview.
The companion runs inside your desktop compositor. Install it only if you
want this feature; KithMoot never enables it or changes compositor settings.

From an extracted Linux KithMoot package:

```
python3 resources/drawing/install.py gnome
# or, on Plasma:
python3 resources/drawing/install.py plasma
```

GNOME needs `glib-compile-schemas` and a supported Shell version named in
`gnome/metadata.json`. Log out and back in after installing, then enable
**KithMoot shared-window drawings** in Extensions. Disable it there to revoke
access. The initial runtime qualification uses GNOME Shell 48.

Plasma needs CMake, a C++23 compiler, ECM, Qt 6 development files,
`KF6GlobalAccel`, and the KWin development package matching your running KWin.
The installer builds locally and prints the system installation command for
you to run. Enable the effect in **System Settings > Window Management >
Desktop Effects**. KWin provides no binary compatibility guarantee for native
effects: rebuild after upgrading it. Builds are checked against KWin 6.3 and 6.7.4, with runtime qualification on
6.3. Versioned adapters cover the newer
6.6 output/region types, 6.7 pointer events and 6.8 paint return value.

Start sharing using the usual portal chooser. Focus the window you selected,
then press **Super+Shift+D** to attach drawings and enter drawing mode. For an
entire display, focus a window on that display and use **Super+Shift+S**.
Press **Escape** to use the app normally. **Super+Shift+C** clears drawings;
on Plasma **Super+Shift+X** stops sharing. GNOME also shows Draw, Clear and Stop
sharing buttons. Shortcuts can be changed in your desktop's settings.

The explicit attach step is necessary: the portal does not give Electron the
identity of a native window chosen in its picker. Attach the same window or
display that you selected there. Marks follow its moves and resizes and hide
when that window is minimised or another app takes focus. If you close the
chosen window, stop sharing and select a new one.

Only ephemeral normalised drawing points, colour and fade strength pass
between KithMoot and the companion over authenticated loopback HTTP. Discovery
is under `$XDG_STATE_HOME/kithmoot/annotations.json` (default
`~/.local/state/kithmoot`), in a private directory with a private file. A new
random capability and session are created per share and revoked when it ends.
The connection never carries captured pixels, room keys, participant names or
window lists. The companion keeps the selected native window locally. Stopping
the share or losing the connection removes drawings and releases input.
