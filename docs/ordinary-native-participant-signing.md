# Native visitor signing

The protected invitation query, creator publisher and visitor member bootstrap
have two explicit local operations: NIP-42 relay authentication and a Fold
device credential. They are unmounted source consumers. A `ParticipantIdentity`
object is a selection/consent carrier; its generic async sign function cannot
prove that a later private effect still has permission.

For visitor selections (`account === null`), these operations capture the
bounded data-only unsigned statement, constrain its exact kind and tags, and
read the global visitor participant from the same acknowledged native browser
image. Authentication binds the relay/challenge/time. Credentials bind the
room/device/seal/expiry/time. The complete composer rejects conflicting tab or
alias state. The selected pubkey must match the actual native scalar.

Signing requires a currently active **read** token, current owner lifetimes,
generations, scope fences and tab lease. A fabricated/escaped token or a
writable mutation projection cannot authorise signing with an unacknowledged
key. Native component validators also check their exact owner instances and
room/carrier/source selection in this callback. These checks do not establish
current membership, keeper authority or independent rollback continuity.

The helper decodes a fresh owned key buffer, signs synchronously within the
native lock, independently verifies the exact result, and returns a detached
deeply frozen event. It invokes no caller-supplied sign function. Its owned
scalar copy is wiped on success and refusal; the retained immutable hex string
is not wiped by this operation. Account selections require the reviewed SDK
foreground boundary and cannot fall back to a visitor key.

Native tests cover exact owner and scope binding, stale/escaped/mutation tokens,
reentrant close, constrained authentication/credential statements, scalar
cleanup, ignored generic async providers, actual SDK delayed upgrades/retries,
queued relay cancellation and joined owner close. SDK wallets and scheduling
remain controlled fixtures. Loopback query/creator tests use real browser
WebSockets and actual signed protocol events. Production startup, RoomSession,
remaining login/restore/carriers, credential/tab renewal, current authority,
independent continuity, registry release and physical acceptance remain open.
