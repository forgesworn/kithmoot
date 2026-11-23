# Drawings over the window being shared

Desktop 0.1.163 adds a transparent drawing canvas over a selected native
window, following its moves and resizes. Earlier releases placed this canvas
only over whole-display shares; a window presenter saw marks only in KithMoot's
preview. The new small toolbar offers Draw, Use window, Clear marks and Stop
sharing. Ordinary app input passes through the canvas until Draw is selected.
Hiding/minimising the target turns drawing off; restoring it restores marks.
Ending the share or call removes both windows and the native geometry watcher.

macOS, Windows and X11 use the capture ID recorded by the main process's
chooser. A small bundled helper reads only that window's geometry/visibility;
it receives no room data and reads no UI text or pixels. Windows geometry is
converted from physical coordinates to Electron's display coordinates.
Building packages on another platform needs Zig for this small C helper.

Native Wayland uses an explicitly installed GNOME Shell extension or KDE
Plasma effect. Setup, shortcuts and permission revocation are documented in
[the packaged instructions](../desktop/compositors/README.md). After the normal
portal chooser, focus the same shared window and press Super+Shift+D; use
Super+Shift+S for a display. The portal does not expose the chosen native
window ID, so the companion requires this explicit attachment. KithMoot does
not enable an extension, alter compositor settings or replace the portal's
capture choice. The extension/effect can be disabled in desktop settings.

The companion exchanges ephemeral normalised points, colour and fading only,
using a per-share random capability on authenticated IPv4 loopback. Requests
with browser Origins, invalid points or revoked sessions are rejected. The
private discovery file is removed on close. No additional remote service,
telemetry, window list, room keys or participant identity is introduced.

Android 0.6.159 independently adds direct overlays for whole-screen and one-app
sharing. Android's optional display-over-apps permission is needed for either;
explicit one-app attachment also needs the user-enabled window-geometry
accessibility service. This does not require Google Play. Open the shared app
and tap App, or tap Screen for an entire display, then Draw. Sharing without
the optional overlay permissions remains available.

## Verification

- Two-party Electron/Chromium checks cover received and local strokes, native
  macOS window geometry, move/resize, minimise/restore and share/call cleanup.
  Their video capture track is synthetic; they do not prove native capture.
- The X11 C watcher is exercised against an actual Xvfb window, including
  geometry changes, hiding, restoring and deletion. Windows x64 and Linux
  x64/arm64 helpers cross-compile; macOS arm64 compiles locally.
- GNOME Shell 48 native Wayland runtime checks cover received paint, local
  pointer strokes, geometry changes, hiding/restoring, display mode and stop.
  KDE KWin 6.3 native Wayland loads the compiled effect, paints received marks
  into a native target's frame and sends actual pointer strokes. Tests run in
  isolated desktop sessions. KWin 6.7.4 also builds against the installed SDK, exercising the newer
  output/region and pointer-event APIs. KWin's QPainter path is exercised; OpenGL rendering
  awaits a host with the required graphics interfaces. GNOME 50/51 cursor
  compatibility follows the published API migration; runtime qualification of
  those versions is pending.
- Android API 35 instrumentation uses real MediaProjection consent in both
  capture modes and a separate-UID native target: incoming paint, ordinary
  touch pass-through, local normalised strokes and input release on close.
  The fixture grants permissions only on its disposable emulator; product
  permission-consent and physical GrapheneOS acceptance remain separate.

Physical Windows, mixed-DPI/multi-monitor desktops, real portal capture alignment
and simultaneous physical desktop/web/GrapheneOS call acceptance are pending.
