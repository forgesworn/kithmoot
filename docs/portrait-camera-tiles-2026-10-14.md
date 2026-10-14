# Portrait camera tiles — 14 October 2026

A phone camera sent upright was preserved with `object-fit: contain`, but
its participant box stayed landscape. This left bands inside the tile.

The desktop call stage now fits a single upright camera’s participant box
to its decoded aspect ratio. One-to-one and featured speaker video use the
available stage height. Gallery and strip tiles fit inside their existing
slots, keeping the other people and screen shares in place. Turning the
same live camera landscape restores the existing landscape layout. Multiple
camera angles retain their existing split presentation.

The change affects the browser at desktop sizes and the installed desktop
client. It does not change phone layouts or crop portrait video.

Validation: 47 layout unit tests, TypeScript checks, and a real two-browser
call with a synthetic portrait camera. The receiving web and desktop builds
show a filled upright tile, follow rotation without replacing the stream,
and preserve the portrait shape in gallery and speaker views. This is
automated media evidence; physical Linux microphone noise and real phone
camera acceptance remain separate checks.

Desktop version: 0.1.81, macOS build 66. The earlier contacts/header release
remains 0.1.80 with its original immutable artefacts.

## Microphone recovery

When an interrupted microphone needed reopening, the pipeline requested the
system default even if this call had selected a headset. Recovery now tries
the actual previous microphone first, retains the existing processed and
muted publication, and falls back to the default only if that device cannot
open. The reported device follows the actual replacement. Both headset and
unplugged-headset paths failed before the change and pass with it; all 62
layout and microphone pipeline unit tests pass.

This can prevent a call from switching to a room microphone after an
interruption. It does not establish the cause of the reported background
voices and does not add speaker isolation or change noise/gain processing.
