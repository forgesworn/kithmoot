# Ordinary private UI custody preparation

This dormant helper is a prerequisite for DG08's protected ordinary persistence.
It does not change the production entry point or activate migration. A passing
helper test does not establish complete namespace classification, client fencing,
protected consumers, authentic admission, or the delivery goal.

`validateOrdinaryUiSnapshot` checks selected writer formats offline and returns
frozen counts only. It never exposes identities, names, links, catalogue choices,
media permission, deletion permission or navigation authority. It does not read a
clock, generate randomness, prune old entries, run loaders or contact endpoints.
Raw and completed images have the same format checks. Unsupported versions,
reserved-family variants, account wrapping and wrong physical ownership hold.
Each recognized value receives the existing 8 MiB UTF-8 bound before JSON parsing;
JSON must retain its exact canonical bytes. Other families remain for the complete
composite to classify and bind, rather than being authorised by this helper.

| Physical owner | Families and supported bytes |
| --- | --- |
| Browser | `kithmoot.name`: nonempty sanitised display name; `last-nostr-account`: lowercase 64-hex account reminder; `last-nostr-method`: nonempty opaque method reminder. None establishes a live identity. |
| Browser | `kithmoot.profiles.lastKnownName.v1`: 0–500 string-valued cache entries. The actual seed reader/class can carry opaque keys and empty values; a later primary save retains them. No signed profile is present. |
| Browser | `kithmoot.room-name.v1.<64-hex room>`: exact name, 32-hex rename ID and positive safe millisecond time. Room and accepted-control binding remain a separate gate. |
| Browser | `kithmoot.home.fold.<section>`: open/closed for six typed section IDs. Current UI folds only older/ended; the typed setter supports pinned/unread/recent/older/other/ended. |
| Browser | `kithmoot.send-delay`: 0/5/10; `kithmoot.nudge.<room>`: true, with off represented by removal; `kithmoot.destruct-heads-up.<room>`: canonical nonnegative safe integer string. These records do not authorise sending. |
| Browser | `kithmoot.destructed.v1`: 0–50 rows with 16–64 lowercase hex ID and finite time. The actual read/dismiss writer carries JSON extensions, duplicate IDs and old/fractional times. Custody does not prune, sort or delete anything remotely. |
| Browser | `kithmoot:emoji:skinTone`: 0–5; `kithmoot:emoji:recents`: 0–36 nonempty strings. Actual picker writes can carry duplicates of other choices; old catalogue choices stay inert. These colon namespaces are selected for protection. |
| Browser | Exact true/false choices for mirror-self, fish.enabled, camera.framing, agents-hear, zen-bell and profiles.enabled. Live media consent and permission checks still apply. |
| Browser | `kithmoot.desktop-bell`: true/false compatibility reader format. This fixture is explicitly synthetic: a historical primary writer was not found. The current bell reader accepts it as a fallback. |
| Tab | `kithmoot.way-back`: exact nonempty opaque link plus string name; `kithmoot.room-switch.v1`: exact hash (empty or # prefix), null/64-hex account and nonnegative safe millisecond time; `kithmoot.notice`: bounded display text, including empty. |

The main writer fixture extracts exact functions using the TypeScript AST. The UI
writer utility extracts exact set/setItem expressions and the exact picker
recents read/write methods. Each capture records primary file/snippet hashes and
injected dependencies. Imported `LastKnownNames`, `renameRoomOp` and tombstone
writers execute directly and carry whole primary-module hashes. This is source
writer evidence, not actual app-control acceptance: surrounding DOM, consent,
transport, reload and admission paths are omitted. The picker known-choice callback
is synthetic. IDs, account, room secret, endpoints, cache seeds and fixture times
are synthetic. The captured way-back encoder uses the primary main codecs with a
synthetic relay selector and secret; its output never becomes admission evidence.

Unit tests preserve exact bytes and exercise valid carry-forward cases, caps,
scope and malformed rows. Native tests migrate actual writer-cut bytes through
Storage, WebCrypto and IndexedDB in Chromium, Firefox and WebKit, including both
physical owners, colon namespaces, reload retention, non-extractable keys, and
raw/completed refusal without rewriting ciphertext. The harness uses a no-op
client fence. Its tab owner purpose and deadline are explicitly synthetic, so it
does not establish `OrdinaryTabLifetime` or all-client fencing acceptance.

Before runtime use, the complete same-image composite must classify every selected
physical name exactly once and bind related room/account records. The protected
root must precede bootstrap and independently loaded roots, require the real
client/capacity fences and await durable consumers and coordinated forgetting.
Live account authentication, current admission, freshness and media/deletion
consent must be rechecked before effects. Restored tab links/intents must not
trigger dialing or admission from custody acceptance alone. `kithmoot.textSize`
is deliberately unclassified here; any exact visual exception needs its own
source-backed decision. No blanket UI, home, call or colon exemption is made.

The generic `scrubStore` API is also a primary writer: a sweep can retain an empty
profile dictionary or empty tombstone/recents list. Those cuts are now preserved,
not treated as proof of absence of identity, deletion history or preferences.
Regression fixtures execute actual primary save followed by actual generic
sweep with synthetic targets. The recents target is an emoji: that tests the
generic API, not main's room-ID-only forget caller. No composed app forgetting
or authorised deletion is established. Invalid profile arrays and tombstone/
recents objects still hold. Generic sweep effects on signed/protocol journals
remain part of the complete producer and coordinated-forget audit.
