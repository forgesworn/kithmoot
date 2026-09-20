# Sharing, listening and attachment viewing

Web and desktop preview 0.1.9 changes. Deployment and download availability are verified separately from the implementation checks below.

## Behaviour

- Returning to the mobile Call tab keeps an existing call running. The tab invokes the idempotent Join action instead of the header action that leaves a call. This also fixes the pre-existing main CI phone-navigation failure.

- Camera and screen capture preserve an existing listening device. `Listen here` works even with no local camera, microphone or screen track, and its choice survives stopping capture. Leaving the call clears the claim. Rapid explicit handovers advance beyond observed claims rather than tying within one second.
- Image attachments remain explicitly fetched and decrypted on demand. Clicking their preview opens a modal with fit/actual-size and pop-out controls. Images, including SVG, stay in image elements; attachment bytes are never executed as an HTML document. Room cleanup closes the viewer and its pop-out.
- Drawing sends connected stroke segments during pointer movement, at up to 20 updates per second, instead of waiting for pointer release. It uses the existing encrypted annotation protocol and remains compatible with existing receivers. Network/relay latency still applies.
- The Mac desktop app has **Share an area**. Position the transparent frame, resize using its top-right handle, then press **Start sharing** inside it. The frame stays above other apps. With Draw off, its interior lets mouse actions reach the applications underneath; with Draw on, local and remote marks share the existing annotation store.
- Only a cropped canvas track is published for area sharing. The raw monitor track stays local. Toolbar and frame insets are excluded. Crossing the original monitor's bounds, removing it or changing its bounds produces black. Keep the frame on one monitor; restart sharing to change monitors. Stop, cancel, leave and frame closure stop capture.
- Browser capture requests window audio where supported. Desktop fallback capture includes loopback audio, and Mac packaging includes the required audio-capture purpose string. Capture requests ask the browser to exclude its own audio where supported.

## Evidence

- TypeScript check and web/desktop builds passed. The packaged Mac 0.1.9 app passed the native smoke check and ad-hoc signature verification; its audio-capture purpose string is present. Linux x64 and ARM64 archives are packaged; their execution was not repeated for this release.
- 167 Vitest files / 2,424 tests passed. After adding the same-second handover regression, the session suite passed all 63 tests and the paired-device browser check passed again.
- Browser checks cover paired-device speaker preservation, shared-audio delivery and teardown, image expansion/pop-out, drawing received while the pointer is held, annotation colours/clearing/fading, cropped source pixels and black output for invalid bounds.
- Image expansion and pop-out passed in Chromium and Firefox. WebKit could not initialise on this macOS 14 host: `Page.overrideSetting: Unknown setting: PushAPIEnabled`. A fresh isolated WebKit installation also failed to initialise; no Safari/iPhone acceptance is claimed.
- Native Electron checks cover the actual always-on-top frame, programmatic resizing, bridge boundaries, chooser entry from the frame's own user gesture, closure and the existing sandbox/profile checks. Capture source enumeration is stubbed in that check; it does not capture the user's desktop.

## Remaining platform work and physical acceptance

- Verify actual Mac display and system-audio capture on a packaged build, including the audio permission prompt, moving/resizing the frame, underlying application interaction, drawing alignment and no feedback of remote callers. A browser-provided live audio track alone does not prove audible sound or echo exclusion. The native custom picker and system picker need separate audio acceptance.
- The browser/PWA cannot put a transparent drawing frame over arbitrary desktop applications. Its existing floating video preview remains available where supported.
- The iPhone product is currently a PWA, without outgoing screen capture. Sharing iPhone screen/audio requires a native iOS app with a ReplayKit broadcast path. No iOS implementation was added here.
- The Android app currently receives `screen-audio` but `LocalMedia.startScreenShare` publishes video only. Playback capture, microphone-independent audio publication/muting, projection teardown, capture-policy handling and device acceptance remain to implement. The current WebRTC dependency exposes an audio-buffer callback, but using that on the microphone path alone would incorrectly couple screen sound to microphone mute. Android attachment previews also require native UI work.
- The Android checkout had unrelated edits in progress when inspected; no Android files were changed by this work.

## References

- [Electron desktop capture and macOS audio permission](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Display capture audio options](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [Own-audio exclusion](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/restrictOwnAudio)
