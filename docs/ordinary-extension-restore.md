# Native extension session restore

`OrdinaryExtensionRestore` owns one restore of a retained NIP-07 session and
its raw SDK wrapper. It requires complete browser/tab migrations, a live native
tab and foreground generation, old-client fencing, the SDK's versioned guarded
headless contract, and a complete authentic paired image. The controller remains
unmounted: the coordinated production root must adopt its returned session and
close this owner on reset, selection change or exit.

Opening validates every physical family and the full SDK partition. The stored
proof is independently verified at its signed time, then captured as the exact
canonical shape accepted by the foreground signer before any extension account
request. Its account, origin and app must agree with the retained session. An
expired session, other method, absent session, unknown private record, incomplete
migration or overlapping redirect/relay/initial login holds without contacting
the extension. A historical proof does not become a fresh server login, current
room membership, MLS admission or independently protected continuity evidence.

All ten SDK row values are captured from the authentic native image. Every
account-discovery boundary and final handoff revalidates the full image, exact
SDK bytes, both `@ordinary-signet` fences, generation, client fencing and session/
tab lifetime. Discovery starts synchronously inside the fresh native read, then
awaits outside the origin lock. The operation is registered with both native
owners before its first continuation. Concurrent or reentrant restore refuses
and cannot start another account request.

The selected extension account must match the retained account. This controller
does not use the SDK's general restore helper, whose discovery/reconnection
starts are outside this contract and whose failures can clear stored sessions.
Native restore never rewrites, removes or promotes retained rows, generates a
challenge or asks for a new login signature. Refusal or a wallet error preserves
the exact native frames for explicit recovery. No silent auth-only downgrade is
made. Other auth-only and bunker restore paths remain required separately.

Only the established native foreground wrapper escapes. Its signing/encryption
attempts have their own fresh native decisions. The restore owner revokes that
wrapper synchronously, joins discovery and foreground operations, then closes
the privately owned raw SDK wrapper. Session/tab expiry also closes the owner.
An unabortable extension request stays joined before close finishes; its result
cannot escape after cancellation or supersession. A provider must not await the
close that joins its own operation.

Browser tests use real IndexedDB, Web Locks, encryption and complete paired
image validation, with a synthetic extension backend. Those tests do not prove
real-wallet/device acceptance or deployment. The dependency and lockfile now
pin published `signet-login@0.18.2`; see [SDK provenance](ordinary-sdk-provenance.md).
Full native root startup, modal/redirect/Amber/NIP-46 initial connection,
management and transport, auth-only/bunker restore, tab/credential renewal,
consumer release and physical acceptance remain open. Production MLS and DG08
remain held behind their separate gates.
