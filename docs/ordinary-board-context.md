# Protected board-context custody

Current main adds `kithmoot.board-context.v1.<account>.<boardId>` through
`saveBoardContext`. These personal labels connect a board to a named project or
chat on this browser. They do not confer board or room membership. The writer
does not persist a card ID, invitation, signing secret, room capability or card
contents.

The ordinary physical classifier routes this exact browser-owned name once to
the protected metadata partition. Accounts are lowercase 64-hex; board IDs are
1–160 ASCII letters, digits, underscores or hyphens. Tab placement, wrappers,
unsupported versions and aliases hold. Other unknown reserved names continue
to hold rather than escaping plaintext migration.

The strict metadata validator accepts exactly the writer's JSON: `boardId`,
`boardName`, optional `project`, then optional `room`. Each optional scope is
exactly `{id,name}`. Names must already be nonempty and unchanged by the actual
display-name sanitiser. Scope IDs retain the writer's opaque nonempty strings
of at most 200 UTF-16 units. No room-key grammar or authenticated identity is
inferred from them. The canonical reconstruction rejects unknown fields,
duplicate JSON keys, whitespace alternatives, reordered fields, mismatched
board IDs and labels that the permissive reader would repair or discard.
The public result contains only counts.

Tests use the actual writer for plain, project, room, combined, fallback and
boundary-size rows. Native tests migrate actual Storage into nonextractable
AES-backed IndexedDB custody, then read both owners under the native lock and
run the complete ordinary snapshot composer. Malformed raw rows must hold
before entropy, key generation, encryption or plaintext deletion. Malformed
retained rows must hold without rewriting either frame. Tab relocation,
changed/added/deleted captured images, scope revocation and live-fence changes
must also refuse. The migration client barrier is synthetic in this harness.

`OrdinaryBoardContextState` provides awaited personal-label custody for one
captured account, foreground generation and live view. Open, reads and writes
require both completed native owners and run the full composer. Reads retain
the exact selected row or absence privately; a save requires that preceding
read and compares those bytes under the paired mutation lock. Other accounts
are preserved. Caller inputs are captured before yielding; accessors and
unknown fields are refused. The actual writer canonicalises new labels, then
the full candidate is validated before native encryption. Any hold revokes the
view through its required stop callback. This is local conditional custody,
not independent rollback resistance; a byte-identical rewrite is not a new
semantic label version. Close revokes synchronously and joins pending work.

The actual Boards panel now requires an awaited context provider for each
foreground or popup view. It serialises context work, hides stale label actions
while a board changes, and waits before publishing labels or moving windows.
Captured session, signer, expiry and abort lifetime fence results. Closing
revokes and joins late-opening custody and unabortable borrowed signer calls;
it never closes the host signer. Sign-out awaits that reset. A provider must
not await a close that joins its own unsettled call: revoke, settle, then let
the external owner join it. Cross-account or stale-view completions cannot
revive a panel or label save.

Current main explicitly supplies `legacyBoardContextCustody`, retaining its
plaintext storage path until protected startup mounts the native provider.
There is no silent plaintext fallback from the protected adapter. Native
signer effect boundaries, publication and room-discussion authority still
require integration with the protected foreground root; these labels cannot
supply that authority. The selected board also fences each save through the
native commit; a superseded protected save holds that view for reopening and
preserves both frames. Authentication evidence passed to the child is detached
and deeply frozen. Session acquisition is tracked and checked before and after
settlement. Sign-in, sign-out and browser forgetting await view reset before
starting new signer work or clearing the browser's state. No full production migration, Signet registry
reproducibility, Tor, deployment or physical acceptance is established;
DG08 remains open.

Native consumer tests also instantiate the actual Boards panel, inject the
native context provider and use a small mocked Girnel host solely to drive
view callbacks. They cover native label saves, a replaced account during a
blocked read, a real popup closing during a pending read, and reset joining
that work. Separate full-app board journeys use the actual vendored Girnel
package through current main's explicit legacy provider. Neither fixture is
evidence of a production protected startup mount or authenticated native
signer effect boundaries.
