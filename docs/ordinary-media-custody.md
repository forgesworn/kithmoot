# Call preference custody

This unpublished count-only helper validates the six current `call-prefs.ts`
writers, the current `readCallProfile` writer and the exact historical
`readCallProfile` source from commit `76ee9bc` (archived under test fixtures). It does not connect the
protected production root, finish the complete source inventory or satisfy DG08.

| Physical name | Owner | Custody rule |
| --- | --- | --- |
| `kithmoot.call.effectMode` | Browser | Exact off, blur or replace |
| `kithmoot.call.background` | Browser | Arbitrary opaque text, including empty and obsolete IDs |
| `kithmoot.call.blurStrength` | Browser | Exact `String` of a finite number from zero to one |
| `kithmoot.call.voicePreset` | Browser | Exact off, lower, higher, neutral, deep or bright |
| `kithmoot.call.cameraDeviceId` | Browser | Nonempty opaque text |
| `kithmoot.call.micDeviceId` | Browser | Nonempty opaque text |
| `kithmoot.callProfile` | Browser | Exact 1 or 2; historical 2 remains inert and the current loader ignores it |
| `kithmoot.callProfile` | Tab | Exact 1 or 2, current page-session writer |

Reserved unknown keys, versions, account wrapping, invalid values, values above
the 8 MiB UTF8 custody limit and relocation of browser media choices to a tab
owner hold the complete original bytes. The older durable profile-2 form is
preserved byte-exactly as inert custody, without promotion into page-session
state or activation of media negotiation. No default
is substituted and no malformed row is dropped. Completed images receive the
same checks. Unrelated families remain for the required complete composite.

The helper returns frozen numeric counts only. It does not return device IDs,
background text, profile values or media permission. It does not read a clock,
start media, interpret URLs, enumerate hardware, fetch, prune or call runtime
loaders. A background value resembling a URL is never a destination here.

Fixtures call the actual primary current writers with injected memory stores.
Browser tests exercise native Storage, IDB, WebCrypto, Web Locks and the existing
migration owner, with a no-op client fence. Tab tests use a synthetic owner
purpose and fixed deadline; they do not establish the real tab lifetime, marker
clone fence, complete tab inventory, authenticated authority or physical media
acceptance. Full routing, navigation, private UI settings, cross-family binding,
startup wiring and durable-before-effect consumers remain required.
