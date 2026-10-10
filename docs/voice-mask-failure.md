# Browser voice mask failure handling

A selected mask keeps its preset when startup, the audio clock or the processor
fails. The pipeline disconnects processing, disables its output and raw source,
and reports that the microphone is muted. Foreground recovery cannot replace
that failure with raw capture. Pressing Microphone deliberately opens a new
pipeline with the same selected mask.

Off is an explicit choice to use the person's own voice. It may use raw capture
when the browser's audio graph is unavailable. Changing a failed mask to Off
keeps that capture muted until the person unmutes. Selecting a mask while an
Off fallback is running stops that raw track and requires reopening processing.

The controls allow selecting a preset before capture. Failed startup displays a
notice outside the folded settings; preview never uses a raw alternative for a
selected failed mask. Settings are supplied to the worklet constructor before
its first render. Changing a healthy preset replaces the processor and discards
its previous buffered samples while retaining the destination track. Missing or
invalid worklet settings produce silence. A bounded progress message checks
actual rendering independently of the context's clock. Processor errors mute
immediately; two missed one-second progress checks detect a stall.

Fifty focused unit checks cover voice DSP, first-block settings, invalid input,
clock/processor faults, interrupted source recovery, stale processor errors,
startup timeouts and explicit Off. Real-browser journeys use synthetic tones,
real AudioWorklets/WebRTC and loopback relays: a native missing-module rejection
publishes no audio sender, stopping a real processor stops new audio energy at
the receiver, retry restores the selected mask, and Off still needs unmute.
Three failure/retry journeys passed in the phone layout (390 × 844, touch)
and three in the desktop build (1440 × 900). Two existing call preference
journeys and two media/effects journeys also passed. The [source receipt](evidence/voice-mask-failure-2026-10-10.json)
records source and log hashes. These are
automated fixtures rather than physical microphone or OS interruption evidence.

This does not complete G8. Native Android voice masking, physical-device
interruptions and device changes, temporary identity/admission/storage,
retention controls, partition handling and authoritative teardown remain open.
Source checks, hosted CI, deployed availability and physical acceptance remain
separate gates.

The [publication receipt](evidence/voice-mask-publication-2026-10-10.json) records
all twelve hosted checks and the exact public web readback. The
desktop 0.1.68 candidate has been rebuilt with this fix and remains awaiting
Apple notarisation; its packages are not published.
