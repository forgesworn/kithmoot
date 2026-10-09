# Desktop 0.1.67 candidate

Video recording adds gallery, speaker and selected-screen layouts to the existing mixed-audio recorder. Signed notices identify the recorder and capture scope; camera inputs follow the same processed output and participant policy as the call. Pauses omit time, switching rooms retains the originating call, and backgrounded video pauses for explicit resume.

Finished recordings remain local until an explicit save or encrypted message share. Add to message keeps Save available during storage refusal, upload failure and retry; Send is still required. Recording controls sit above the call gallery, including phone layouts. Existing original Donkey animations and ForgeMoji artwork remain bundled.

The release builds on the reviewed recording and sharing fixes. The desktop version allocation and a native Electron regression fixture are the only additional runtime/release changes.

Local evidence: all 95 desktop boundary tests and the desktop build passed. The Mac package is Developer ID signed, Apple notarised, stapled and Gatekeeper accepted. Its 264 bundled web files and 17 desktop source files match the canonical build. The signed package passed actual Save, full short-clip video playback, decoded audio energy, pause/resume and peer recording notices with synthetic inputs; the fixture preserves the exported file and receipt. Initial fixture failures were corrected without changing the app: its local relay now preserves production WSS/CSP, native Save supplies the bytes, and decoding audio uses a copy because decodeAudioData transfers its buffer.

Public downloads, automatic update and installed-device acceptance remain separate gates. The real-time 45-minute browser recording/playback check is still running. Native Android recording is not included in this desktop release.
