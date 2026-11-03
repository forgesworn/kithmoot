# KithMoot node UI candidate: maintainer review pack

Status: implementation candidate, not approved or deployed. Tested UI source
revision: `d18b0c57d8f97a6cac9789515143878b4fcbecff`. This pack and its evidence metadata are recorded in a
following documentation commit. Candidate-only privacy/terms copy is recorded
at `142b1a3b439779896ec6006326de6e1d1f75a3e1`; it changes no application UI
logic. Its four static-page browser checks passed.

**Maintainer must review and approve UI work on KithMoot's Settings → Calls →
Your KithMoot node, New room → Host on my node, the node room's ask and waiting
screens, Room details → Hosted on, member removal and room closure before
merging or approval. ZAT pending.**

The Archy catalogue/install, launch, pairing hand-off, delete-everything and
status screens have a separate [private candidate and review pack](https://github.com/forgesworn/archipelago-apps/pull/53). No maintainer
has been contacted. CI and this browser evidence do not replace acceptance.

## Build and setup

The candidate uses the existing KithMoot components and styles. No new CSS or
new design system is introduced. Local review URL: `https://localhost:4517/j/`.
The merged source baseline is `10de6eef7deef18658a0f576af163038e8006426`; the
candidate's frozen source manifest is recorded in the evidence file below.
No review server is left running. The web and desktop production asset hashes
are recorded separately. The Fold protocol pin is 0.17.0.

Run `npm ci`, `npm run typecheck` and `npm run build` from this checkout.
Use the checked Spry and private Shelter candidate executables named by
`E2E_NODE_SPRY_BINARY` and `E2E_NODE_SHELTER_BINARY`. Shelter is not a public
signed dependency yet. This setup is a local review fixture, not the public
one-command installer.

```sh
E2E_PORT=4517 PWDEBUG=1 npx playwright test test/kithmoot-node-ui.spec.ts --project=chromium
```

Playwright builds and serves the candidate and starts the local relay fixture.
Its inspector permits stepping and pausing at the settings and Hosted on
screens. The test starts the actual supervisor, Spry and Shelter processes;
it creates a synthetic account signer and independent guest browsers. Stop
the run when finished; its `finally` blocks close the browsers, child
processes, sockets and private temporary directory. It requires free TURN
ports 34790 and 53499. Local TLS routing substitutes for public DNS, while
signed HTTP and relay audiences remain pinned to `node.example`.

For the unattended check, omit `PWDEBUG=1`. The test is explicitly skipped if
the two private candidate executables are not supplied. The pinned binary
hashes and build hash are in
[the evidence record](evidence/kithmoot-node-ui-20261102/evidence.json).

## Screens and expected results

1. Settings → Calls → Your KithMoot node: a signed-out visitor can see the
   explanation but cannot pair. A signed-in account pastes a six-minute
   pairing link. Pair asks to confirm the host before any node request.
   The pairing code is cleared after success and is never saved with the
   public pairing metadata. Check status shows version, room/device counts,
   child availability and storage usage. An unreachable child reports
   unavailable or unknown, never a fabricated zero. An empty healthy node
   does not require an active room lease to be ready.
2. Unpair asks for confirmation and removes only this device's saved pairing.
   Existing hosted rooms continue. It neither deletes the server nor changes
   its owner. The original account can reconnect using a fresh local code.
3. New room offers Host on my node only for the paired account. It explains
   admission, relay-only calls, files off and self-destruct. Keeper recovery
   is saved before enrolment; a lost response must leave the same room
   recoverable. The room link contains no room key or usable grant. For an
   Archy node, pairing, saved account state and the signed room retain TURN
   ports 34790/53499; HTTPS and TURN over TLS on 443 remain fixed. Damaged saved
   port profiles must refuse recovery rather than silently select defaults.
4. A guest opens the v6 link and presses Ask to join. No name, address, password
   or server settings are required. The waiting screen can be cancelled and
   the request expires after ten minutes. Let in admits the guest only after
   both backends acknowledge the signed device grant. Decline sends no answer
   and no room key. The guest remains waiting until cancellation or timeout.
5. Admitted guests can exchange encrypted chat. Files and the legacy agent
   and phone bearer-pairing controls are unavailable in this room path.
   Room details → Hosted on names the signed node; Privacy and connection
   says calls use that node. Ordinary relay/storage controls cannot replace
   it. A node failure does not switch to public relays, public STUN or the
   default call server.
6. Remove revokes the guest's devices and calls, then changes the room key.
   The removed guest's app wipes its local room state. The remaining room
   and its messages remain available. Existing copies elsewhere cannot be
   erased by this app.
7. End room persists signed closing intent, delivers the closing records,
   revokes access and purges the room partition. Member apps run their local
   self-destruct. The owner can check the node's signed completion receipt
   after the room's private state is gone, including after local unpairing.
   A missing receipt or unreachable node says completion is unknown.

Check the existing light/dark themes, keyboard focus, Back, text-size settings,
reduced motion and narrow/landscape layouts. Captures cover desktop 1280 × 860
and phone 390 × 844; other sizes, the installed desktop shell and embedded
Archy surfaces remain separate acceptance checks.

## Evidence and limits

The refreshed actual-process Chromium journey passes using custom node ports.
It exercises pairing consent, owner status, creation, admission, chat,
local unpairing during a room, removal without room purge, silent decline,
whole-room purge, device wipes and the owner's post-wipe completion check.
Forty-seven focused custody/control/access/HTTP tests across seven files and
full type checking pass. Web and desktop production builds pass. The earlier
revision's broad suite passed 8,789 tests with eight skipped; that result is
retained as prior-revision evidence, not attributed to this refreshed build.
The legacy captured-writer fixture supplies
`nodeRoom: undefined`; its byte-preservation assertions remain unchanged.

The actual Electron 44.9.3 HTTPS renderer also paired, enrolled and created a
room with the same signed custom ports through the production app runtime.
Its origin remained `https://kithmoot.forgesworn.dev`, with web security enabled.
Electron's existing HTTPS loader uses main-process `net.fetch`, which omitted
Origin on these requests; body-bound NIP-98 proofs still applied. No CORS or
production web-security settings were changed. This fixture uses a DNS mapping
and a certificate exception for its self-signed local HTTPS/WSS bridge. It does
not qualify the actual desktop account sign-in UI or public certificate trust.
The temporary qualification module, Electron profile and processes were removed.

To reproduce after building `desktop/web` and installing the pinned Electron
runtime, run `npx playwright test --config desktop/playwright.config.ts
kithmoot-node.spec.ts` with the same two checked backend binary variables.

These tests do not qualify native media, a public TLS443 listener, an internet
node, physical GrapheneOS, the Android UI or a signed public installer. Archy
has separate offline integration evidence in its held review pack.
Those remain part of full node delivery.

- [Desktop node settings](evidence/kithmoot-node-ui-20261102/node-settings.png)
- [Phone node settings](evidence/kithmoot-node-ui-20261102/node-settings-phone.png)
- [Room details: Hosted on](evidence/kithmoot-node-ui-20261102/node-hosted-on.png)

Maintainer decision: pending. Reviewed source revision: pending. Refresh this
pack and obtain approval again after material UI changes.

The prior full hosted Node22/24 unit matrix on `04bd861b` passed 8,820 tests
with eight skips; realtime CI also passed. The new [delivery map](kithmoot-node-delivery-20261103.md)
records stage-specific evidence, candidate choices and remaining approvals.
The [legal-cover gap check](legal/kithmoot-node-release-gate.md) keeps the
unpublished node separate from ordinary-room defaults and the existing public
TURN service. No website deployment is performed by this candidate.
