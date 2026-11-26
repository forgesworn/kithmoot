# Browser room routing to a private relay

A signed-in person can pair a browser in Settings, open a room, then choose
**Bothy room routing** from the room menu. The keeper explicitly grants the
listed current devices; each participant selects their own paired route and
activates it. Pairing by itself changes no room routing.

## Standalone Wok

Settings → Bothy connection also offers **Standalone Wok relay (optional)**.
Enter the exact `wss://<host>[:port]/events` URL of a relay operated directly,
without Bothy, Link or Archipelago. Saving only offers that route. Room
activation, the current-device review and the signed grant/withdrawal lifecycle
are the same as for Bothy. Standalone Wok does not resume a Link endpoint, and
reopening a room resumes only the selected route.

The Vennel [standalone room admission contract](https://github.com/forgesworn/vennel/blob/main/docs/standalone-room-admission.md)
defines the shared kind-24242 WSS grant. Wok keeps its operator's listed
keepers and signed guest scopes; it never replaces the room's invitation or
membership rules. Calls, protected MLS and broader channels remain outside
this first profile.

This first journey carries main-chat text and presence, plus the control
scope and the room's board, for ordinary rooms before their first rekey.
Each is a stream of its own with its own grant: three grants per device, and
a saved permission holds eight devices in each. A route activated by an earlier
version of the app was granted the first two only. **Renew keeper grants**
adds the board's grant for the devices the room's own grant names, and
**Activate or resume room** adds the board to a member's own selection; the
keeper goes first, since a member's selection grants nothing. Each renewal
asks the keeper's signer for one more pair of signed statements per device. Calls, media, new invitations, quiet rooms, the room's tasks and
ungranted channels/epochs are unavailable. It
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
The desktop shell permits only one app instance per profile and checks that
the caller is the only room window in that session. The same Web Locks close
public traffic before changing the route. Broadcasts carry only a change
notification, with no room or account IDs.

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
- `npm run test:wok-room` covers real Wok activation, scoped publication and
  readback, restart, renewal and withdrawal. Set `WOKD_BIN` to a local binary,
  or run with `WOK_EXTERNAL=1` and the Docker socket available against the
  Compose gateway. `npm run test:wok-room-ui` additionally drives two visible
  PWA sessions through standalone configuration, activation, reopening and a
  private message. It needs the standalone Compose profile running its local
  `relay.example.org` fixture and no production account data.

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
