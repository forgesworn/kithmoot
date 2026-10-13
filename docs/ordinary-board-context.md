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

This source is unmounted. Foreground and popup board consumers still require
an awaited protected store bound to the captured account and view lifetime.
Their borrowed signer, logout/reset/close, publication and room-discussion
effects require the same native effect boundaries as other app consumers.
The labels cannot supply that authority. These tests do not establish full
production migration, Signet registry reproducibility, board-session acceptance,
Tor, deployment or physical acceptance; DG08 remains open.
