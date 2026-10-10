# Desktop 0.1.67 candidate

Video recording adds gallery, speaker and selected-screen layouts to the existing mixed-audio recorder. Signed notices identify the recorder and capture scope; camera inputs follow the same processed output and participant policy as the call. Pauses omit time, switching rooms retains the originating call, and backgrounded video pauses for explicit resume.

Finished recordings remain local until an explicit save or encrypted message share. Add to message keeps Save available during storage refusal, upload failure and retry; Send is still required. Recording controls sit above the call gallery, including phone layouts. Existing original Donkey animations and ForgeMoji artwork remain bundled.

The release builds on the reviewed recording and sharing fixes. The desktop version allocation and a native Electron regression fixture are the only additional runtime/release changes.

Local evidence: all 95 desktop boundary tests and the desktop build passed. The Mac package is Developer ID signed, Apple notarised, stapled and Gatekeeper accepted, including an independent assessment on the M4. All four native packages contain the same 264 canonical web files and 22 desktop source files. The actual ZIP and tar archives contain the verified application code and executables; both Debian packages match all 75 packaged application files. Both APT signatures, repository indices and package hashes verify independently using the public key. The signed Mac package passed actual Save, full short-clip video playback, decoded audio energy, pause/resume and peer recording notices with synthetic inputs; the fixture preserves the exported file and receipt.

Public download and signed-feed verification are separate from installed-device acceptance. The [45-minute browser capture and complete playback](evidence/recording-long-session-2026-10-10.json) passed with synthetic inputs on the earlier recording runtime; that is recording-engine evidence rather than a complete latest-UI/native/physical long-session journey. Native Android recording is not included in this desktop release.
