# Shared MLS group pin in the browser consumer

KithMoot now pins reviewed Vennel main
`6df0803012ad194f033ecbad27ad2858df26477e`, containing the independently reviewed
actual-group query and expected-group guard from Vennel PRs #222 and #223.
The web assets are rebuilt from that exact source with Rust 1.94.1 and
wasm-bindgen 0.2.129 using the checked-in build script, locked dependency graph
and local-path remapping. The loader version and SHA-256 manifest match.
No test trap export is enabled.

`BrowserMlsRoomOperations.join` now requires `expectedGroupId`, a canonical
32-byte lowercase hex string, before consent or persistence. It passes that
pin through the shared WASM capability boundary. The private authenticated
admission owner must supply the group from its validated invitation answer;
a caller-supplied string is not itself admission authority. Public development
join options remain a low-level prerequisite, and production MLS stays disabled.

`groupId(context, savedSessionId)` reads the actual loaded engine group through
the witnessed session host and current vault context. It returns null for a
PendingJoin and the actual group after adoption. The local session id, paired
box, installation, keeper key and room name cannot substitute for this value.
This getter exposes no new signing authority and does not designate a keeper.

The shared engine retains the authenticated expected group in pinned pending
snapshot frame 2 and checks it before adopting or persisting Welcome. A valid
Welcome for another real group at the same box is refused. Exact-group Welcome
can still be accepted later, including after restart. Adoption transitions to
Active framing without retaining obsolete pending secrets/pins.

Snapshot compatibility remains the shared contract: new readers hold old
unpinned PendingJoin v1; older binaries refuse new pinned frame 2. Older binaries
can still consume their legacy unpinned frame 1, so this is not a universal
old-client admission barrier. No reset, deletion or fabricated pin repairs an
uncertain pending join. Recovery reopens the saved operation and preserves its
sealed engine state.

Browser fixtures obtain pins from actual created groups rather than session
ids or invented placeholders. A same-box two-group test refuses one real
Welcome, retains PendingJoin across restart, and accepts only the exact pinned
group's Welcome. Separate malformed-pin coverage confirms no saved join is
created. Existing custody, admission, session-host interruption, membership and
removal tests continue exercising the rebuilt engine.

These are browser component prerequisites with actual IndexedDB/Web Locks/WASM
and signed synthetic witness/peer fixtures. They do not demonstrate the new live
keeper-witness service, an authenticated invitation UI, two real accounts,
installed PWA/phone or physical acceptance. Purpose device proofs, current
account/child custody, global counter reservation, conditional authoritative
keeper witness and durable one-shot effects still require private composition.
