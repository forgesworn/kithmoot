# Native room-board catalogue storage

`OrdinaryRoomBoardStorage` is an unmounted native storage prerequisite. It
loads and saves the selected account/room catalogue through completed browser
and tab custody and the exact frozen session exposed by
`OrdinaryForegroundSigner`. The root supplies the current room and foreground
generation; that selection is trusted control state, not membership, current
MLS authority or independent rollback protection. Production still uses the
legacy `RoomBoards` storage path.

The physical browser key stays `kithmoot.room-boards.v1.ACCOUNT.ROOM`, with the
same canonical opaque `{chunks:[...]}` outer value. Visible NIP-44 framing is
only a custody classification. Each new authenticated plaintext is instead a
canonical version-2 object containing `account`, `roomId`, a SHA-256 digest of
the complete canonical catalogue, `index`, `count` and `boards`. All chunks
must match the selected account/room and the exact canonical ordered chunk
set. Duplicate boards, copied, reordered, missing or mixed chunks, unknown
fields and noncanonical encodings hold without returning a partial catalogue.
There are at most 50 boards and 10 chunks, with at most 20,000 UTF-8 bytes per
plaintext. Board fields are bounded and captured through data descriptors
before asynchronous work. The room protocol canonicalises their three fields.

The selected wallet's NIP-44 implementation authenticates each ciphertext.
Before saving, the adapter decrypts the actual generated chunks, requires an
exact plaintext round-trip and verifies the complete version-2 binding.
This assumes the selected wallet implements NIP-44 correctly; it is not an
independent MAC attestation. An invitation URL is opaque protocol-shaped
data here. This layer does not verify its Girnel signature, grant, board
membership or current authority. The board client must do those checks before
joining. Immutable JavaScript plaintext strings cannot be wiped; temporary
arrays and digest byte buffers are cleared after use.

The legacy decrypted format contains bare board arrays. It has no authenticated
room or complete-chunk-set binding. Those bytes hold intact; the adapter never
silently adopts, repairs, replaces or treats them as an empty catalogue.
Explicit recovery using authenticated current-room evidence remains open.
The outer custody classifier still preserves supported legacy ciphertext.
An absent catalogue loads as an empty list only after fresh full-pair checks;
saving requires a successful load first.

Every operation checks complete authenticated browser/tab images, the exact
SDK partition, selected foreground/session and both captured room fences.
`borrowNip44` adds the catalogue row, room fences and capacity checks to the
same native paired read that starts each actual SDK provider attempt. These
extra trusted restrictions cannot replace the signer's own checks. They must
be synchronous; accessor-backed, unknown and asynchronous consumer fields
are refused. The base signer checks again after the additional validation.
Providers start under the native lock, but waiting for them happens outside
it. Both native owners join each operation before its first continuation.
Revocation or concurrent/reentrant access holds the component and suppresses
results while joining already started work. Component close does not close
the parent foreground or its privately owned raw SDK connection.

Before first-use wallet entropy, exact NIP-44 length projections preflight
capacity and native control retention acknowledges both room fences. Those
control frames may change even if the wallet later fails; the source catalogue
row remains exact. Zero-byte framing placeholders are used only for sizing,
never retention, provider input, restoration or authentication. A final fresh
pair decision retains the real ciphertext; the comparison advances only after
acknowledgement. Unknown retention, failed clients, changed SDK/catalogue bytes,
forgotten room fences and full capacity hold rather than granting an effect.

Browser tests exercise real IndexedDB, Web Locks, WebCrypto and NIP-44 through
the published SDK pinned by the dependency and lockfile, with synthetic
extension callbacks and room
selection. Multi-chunk round-trips and changes specifically between the
initial SDK read and actual wallet start are covered. This is source/browser
evidence, not a real wallet, board grant, production or physical acceptance.
See [SDK provenance](ordinary-sdk-provenance.md) for the published package and
the limits of historical local overlay evidence.

The [awaited `RoomBoards` consumer](ordinary-room-board-consumer.md) can now own
this adapter's complete queued operations through `joinLifetime`; its `check`
performs a fresh paired read. Production still selects the explicit legacy
adapter. Native RoomSession binding, guarded actual transport frames, legacy
recovery, protected production startup and other login/restore carriers remain
open. Current MLS authority, independent continuity, protected SDK consumer
release, deployment, physical acceptance and DG08 are not complete.
