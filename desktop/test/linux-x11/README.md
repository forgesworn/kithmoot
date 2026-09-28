# Linux X11 check for area share and redaction boxes

The area frame and the redaction boxes are windows with a see-through
middle. Whether a press reaches them is decided by the X server and the
window manager, so this check drives the packaged app with the real pointer
(`xdotool`) on a real X server, under Cinnamon's window manager, with two
monitors. It is run by hand before a desktop release; it is not part of
`npm test`.

It creates one room on the app's default public relays, so it needs the
network.

```sh
docker build -t kithmoot-x11 desktop/test/linux-x11
docker run --rm --shm-size=1g \
  -v "$PWD/desktop/out/KithMoot-linux-arm64:/opt/kithmoot:ro" \
  -v "$PWD/desktop/test/linux-x11/share.mjs:/work/share.mjs:ro" \
  kithmoot-x11 /work/session.sh node /work/share.mjs
```

Use the package that matches the machine (`KithMoot-linux-x64` on Intel).
Every line should read `PASS`; the exit status is 0 only when they all do.

Flags that must stay out of the launch: `--use-fake-ui-for-media-stream`
answers every capture request inside Chromium, so the app's own capture
handler never runs and the check proves nothing about it.
