# Redaction boxes on shares

Redaction boxes let a person black out parts of their screen in a desktop
share. The rule they serve: pixels inside an active box are never encoded or
sent. Whenever KithMoot cannot be sure where a box falls in the outgoing
picture, it sends black, never the raw frame.

## Stage 1 (desktop app: whole screen and area)

A box is a frameless, transparent, always-on-top window on the real screen
(`desktop/redaction.mjs`). The sharer sees through it, and clicks inside it
pass through to whatever is beneath; the main process watches the real cursor
to decide when, because forwarded mouse moves are unreliable on Windows and
Linux. The bar across the top moves it, the corners resize it (both follow
`screen.getCursorScreenPoint()` in the main process, not a CSS drag region),
and arrow keys nudge it. Each box can be turned off ("Shown") and on
("Hidden from share"), and the call controls turn every box on or off at
once. Boxes can be added before or during a share and close when the call
ends. `setContentProtection(true)` keeps a box out of the capture where the
OS honours it; nothing relies on that.

The path from capture to publish:

1. Before asking for a picture the page calls `redactionBegin`, and the main
   process forgets the last source. It also turns Chromium's system picker
   off while any box exists, because that picker never says what was chosen.
2. The display handler in `desktop/main.mjs` records the source it answers
   with: a screen and its display id (`captureOf` in
   `desktop/redaction-geometry.mjs`), a window, or, for an area share, the
   monitor under the frame. While a box is on, the chooser offers screens only.
3. The main process reports every box's real window bounds and every
   display's bounds, in DIP, with the recorded source, and reports again
   whenever a box moves, resizes, toggles or closes, or a display changes.
4. In the page, a whole-screen share never publishes the raw track:
   `DesktopRedaction#redact` (`app/src/redaction.ts`) draws it into a canvas
   and only the canvas track reaches the call, boxes or not, so a box can
   appear mid-share without a track swap. An area share already crops through
   a canvas (`app/src/share-area.ts`) and redacts in the same step.
5. Each frame is planned before anything is drawn (`planRedaction` and
   `cropPlan` in `app/src/redaction-geometry.ts`): box bounds are mapped from
   DIP to frame pixels by frame size over display size, padded by 3 DIP and
   rounded outwards. A box on another display does not intersect. While a box
   moves, the hull of its old and new places stays black for 400 ms, and a
   box turned off or closed keeps its last place black as long.
6. The plan is black, and the raw frame is never drawn, when the source is
   unknown, when it is a window, when the track's own `displaySurface`
   disagrees with the main process, when the display is gone, or when the
   picture's shape differs from the display's by more than 2%. It is also
   black for 1 s after any display is added, removed or rescaled, while the
   OS may still be moving and rescaling windows; the main process reads the
   state again at 250 ms and just after 1 s in case no window event follows.
   And it is black while any held box touches two displays whose scale
   factors differ (or are not reported): Windows converts a straddling
   window's bounds by the display holding most of it, so the other part
   would be misplaced.
7. The main process keeps every box on one display: a move slides it back
   onto whichever display holds most of it, and a resize stops at the edge of
   the display it started on.

Known rough edge: a share started through the macOS 15 system picker before
any box existed has no recorded source, so it goes black (and stays black)
once a box is turned on. That is the fail-closed answer; stopping and sharing
again with a box present uses KithMoot's own chooser and works normally.

A window share is refused while any box is on. A window share started with
every box off goes black the moment one is turned on, and says why.

Boxes are not offered on Wayland, where an app cannot place its own window or
read screen coordinates; the preview area share is the way to keep things
private there. Browsers get no boxes and behave as before.

`desktop/test/redaction.spec.ts` reads the pixels of the published RTP sender
track, and of the picture the far end decodes, to check the boxed region is
black and the rest is not, for a screen share and an area share.

## Stage 2 design note: single-app shares

Electron's `desktopCapturer` names a window but never says where it is, so a
box cannot yet be mapped into a single app's picture. Stage 2 adds an in-house
window locator per OS, with no third-party dependency, that returns the chosen
window's bounds in screen coordinates while it is shared:

- **macOS:** `CGWindowListCopyWindowInfo` through JXA (`osascript -l
  JavaScript` with the ObjC bridge), matching the source's `CGWindowID` (the
  number in `window:<id>:0`) and reading `kCGWindowBounds`. Polled, or kept as
  one long-lived `osascript` process reading requests on stdin to avoid a
  spawn per frame. Needs no extra permission beyond Screen Recording.
- **Windows:** the source id carries the `HWND`. A long-lived PowerShell
  process with a small `Add-Type` P/Invoke of `GetWindowRect`,
  `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` (the captured frame
  excludes the invisible resize border) and `IsIconic`, answering requests
  over stdin and stdout.
- **X11:** the source id carries the X window id. A small in-house helper
  asks the X server for `_NET_FRAME_EXTENTS` and translates the window's
  geometry to root coordinates (`XGetGeometry`, `XTranslateCoordinates`),
  rather than depending on an external tool such as `xwininfo`. Wayland stays
  out of scope for the same reason as stage 1.

The same fail-closed rules apply: the window's bounds must be fresh (a
timestamped answer no older than a few frames), the picture's shape must match
the window's, and the window must be on one display with a known scale; a
minimised, off-screen, mid-resize or unanswered window sends
black while any box is on. Box geometry would then map by window origin
rather than display origin, reusing `planRedaction` with the window standing
in for the display. Occluding windows are the sharer's own concern: the
capture of a single app does not include what is on top of it.
