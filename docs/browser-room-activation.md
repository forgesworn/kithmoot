# Browser room routing to Bothy

A signed-in person can pair a browser in Settings, open a room, then choose
**Bothy room routing** from the room menu. The keeper explicitly grants the
listed current devices; each participant selects their own paired route and
activates it. Pairing by itself changes no room routing.

This first journey carries main-chat text and presence, plus the control
scope, for ordinary rooms before their first rekey. Calls, media, new
invitations, quiet rooms and ungranted channels/epochs are unavailable. It
does not supply MLS, restore-witness gating or membership administration.
Account and profile connections retain their separate public-relay policy.
The Link relay can observe connection timing and volume.

## Persistence and closure

`BrowserRoomConsents` stores account/room/route/device consent and the exact
signed active/revoked grants in encrypted IndexedDB. The withdrawal is signed
first; the complete plan is persisted before any active grant is published.
Installing, active, renewing, withdrawing and retired are durable states.
A lost acknowledgement replays the same statement and grant ID. Retirement
requires an acknowledgement for every retained keeper withdrawal. A guest's
local withdrawal does not revoke a keeper's server grant.

Room and invitation-lookup pools pass through `BrowserRoomPool`. Public pools
hold shared Web Locks for their lifetime. Activation takes exclusive locks,
closes session/media work, then requires both publication acknowledgement and
exact signed readiness readback. A service-worker preflight requires a gate
acknowledgement from every current app tab. Old or frozen tabs block activation.
Broadcasts carry only a change notification, with no room or account IDs.

Reload, sign-out, a different account, expiry and route failure cannot choose
public relays implicitly. Background room watches cannot take Link endpoint
ownership from the foreground tab. Settings → Bothy connection → Current room
routing and recovery can resume an interrupted transition. Forgetting a pairing
or browser is blocked while a non-retired selection still needs recovery.
The room's join screen also offers **Recover Bothy room access** whenever a
saved route remains. Recovery therefore does not depend on joining a room
whose unfinished grant operation deliberately holds its traffic.

Public history recovery and public cleanup are conservatively paused across
this browser while any Bothy room selection remains saved. Ordinary unrelated
public-room pools continue to use their own routing settings.

## Validation and limits

- Unit coverage includes lost acknowledgements, failed durable writes,
  retained withdrawals, renewal, expiry followed by withdrawal, signer
  mutation, account changes and exact readiness readback.
- `playwright.link.config.ts` covers endpoint ownership, encrypted persistence,
  frozen closure locks, cross-tab pool closure, reload and foreign accounts
  in Chromium, Firefox and WebKit.
- `test/browser-room-live.mjs` drives the built PWA through visible pairing,
  keeper/guest activation, another watching tab, old-client refusal, messages,
  reload, real box/relay restarts, renewal and withdrawal. It requires local
  public relay port 7777, `LINK_TEST_RELAY` (WebPKI WSS), loopback
  `LINK_BOTHY_CONTROL` and loopback `LINK_RELAY_CONTROL` (POST `/restart`).
  The Vennel lab owns these services. Its native WebSocket positive control
  counts exact room/control REQ and EVENT frames; the accepted private window
  must contain zero public room frames. Account traffic is separate.

The Vennel runner also supports these acceptance switches:

- `ROOM_RECOVERY_MATRIX=1` closes the entire owner browser and reopens its
  persisted profile before publication, after losing the first real grant OK,
  and after all acknowledgements but before local completion. It does this for
  installation, renewal and withdrawal, comparing the exact saved statements.
- `ROOM_EXPIRY=1` uses a separate fixture keeper to sign short-lived replacement
  terms over paired Link. The product's 30-day term stays unchanged. Bothy's
  real clock expires those grants; the guest is refused, and visible renewal
  restores delivery under the same IDs. A read-only fixture endpoint checks
  exact room grant rows, including retained inactive revocation records.
- `ROOM_PERSISTENT_INVITATION=1` starts with a signed persistent invitation,
  reopens the guest in a fresh tab, and wakes the owner's room-list tab. The
  native frame monitor includes the invitation lookup scope.

Ordinary text grant expiry removes authority, not existing encrypted history.
Signed grant rows and their expiration watermarks remain to prevent replay;
renewal replaces the same rows. MLS custody cleanup has its own acceptance.
These disposable local journeys do not prove physical-device or independent
production room delivery. P3-06 remains open for those acceptance gates.
