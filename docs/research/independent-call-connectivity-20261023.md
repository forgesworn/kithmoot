# Separate call servers and transport replacement: 23 October 2026

**Result:** the production web application passes a local three-participant
call through two separate TURN instances. Every browser uses authenticated
TURN over TLS/TCP, with no direct or STUN alternative. Stopping one instance
does not remove its user from the room or stop chat. Choosing the other
instance on that device, then reopening, restores the group call using the
original room link. This is a transport interoperability and replacement
proof, not automatic provider selection or separate-network acceptance.

## What ran

`npm run test:independent-calls` builds the ordinary static application with
no TURN credential endpoint, meeting-code service or diagnostic export hook.
It starts a local Nostr relay and two disposable coturn containers. These
containers have separate realms, randomly generated credentials and TLS
listeners, on one task-owned Docker network. Only loopback TCP listeners are
published. They exchange relayed packets over UDP inside that network.

Three fresh Chromium contexts use synthetic camera/microphone sources in
1920-by-1080 viewports, selecting Gallery through the product's More/Layout
menu so all cameras are displayed. Off-page video sinks are deliberately
paused by the application and are not a valid simultaneous-decoding probe. The
fixture saves each person's relay-only privacy preference and opts out of
public profile lookup. Actual call credentials are entered through the
application's Connections settings, never injected into a peer-connection
factory. Each device gets a distinct account. Ada uses alpha; Rowan and
PeerC use beta. No external HTTP or WebSocket destination is allowed.

The test requires:

1. Before any server is configured, the real call action refuses relay-only
   calling and creates no peer connection. Host candidates cannot rescue it.
2. A two-person call uses both server instances. Actual nominated pairs are
   `relay`/`relay`, with Chromium reporting `relayProtocol: tls`.
3. Adding PeerC produces six receiving directions. Every connected peer
   must decode video and receive non-zero audio energy; a second observation
   requires both counters to grow. A changed peer/RTP stream establishes a
   new baseline, then must still demonstrate growth. Old RTP counters cannot
   establish a pass.
4. Every browser's actual `RTCConfiguration` contains only its own selected
   authenticated `turns:` URL, with `iceTransportPolicy: relay`. Neither
   transport passwords nor device-specific URLs appear in shared room links.
5. After alpha is stopped, Ada can still send chat to both beta users and
   the beta users continue receiving video. Ada chooses beta through Settings
   and reopens the same room. All six media directions must pass again. Three
   additional reload/rejoin cycles require all six directions to pass afresh.
6. There are no intercepted non-loopback HTTP/WebSocket attempts. Ordinary
   diagnostic export remains absent.

`playwright.independent-calls.config.ts` disables non-proxied browser UDP as
an additional Chromium test restriction. The decisive evidence is the actual
configuration and selected TLS pair. This is not a firewall, NAT or OS-level
egress audit. The local certificate is self-signed; the dedicated test browser
has a certificate exception. Public certificate validation is **not** qualified
by this run. No exception is added to application code or deployment settings.

The fixture suppresses its HTTP access log and coturn/Docker logs. Generated
passwords, configuration, certificate/private key, containers and network are
removed on shutdown. The retained report contains synthetic RTP counters,
ordinals and explicit limitations, not credentials or packet captures. This
does not establish absence of other application, Docker-host or OS records.

## Validation and reproduction

Requires the locked npm dependencies, Playwright Chromium, Docker and OpenSSL:

```sh
npm run typecheck
npm run test:independent-calls
npm run test:publisher
```

The [structured result](../evidence/independent-call-connectivity-20261023/result.json)
records final executed case results, tested source hashes, image digest and
bounded media measurements. The new CI job runs this gate separately; hosted
CI has not run for this local change. Dependencies were reused from the
existing web checkout, rather than qualified by a fresh `npm ci`.

Final local validation passed: **one new group/connectivity browser case,
all five existing publisher/protected-sharing browser cases, TypeScript
checking and production builds**. The strengthened group case took 58.756
seconds. Its selected-pair evidence covers two receiving directions for the
one-to-one phase and six for each group phase. No new unit-test suite or
Android/device acceptance is claimed by this increment.

The first two diagnostic runs failed at room creation: the inherited test
configuration started its Nostr relay on 5693 while helper defaults targeted
7777. `playwright.publisher.config.ts` now exports its chosen relay port to
workers and honours an explicit `E2E_RELAY_PORT`. This also fixes reproduction
of the earlier publisher gate without requiring `E2E_PORT` in the shell.
The initial experiment additionally blocked service workers; final runs allow
the application's local state worker. Browser interception is therefore not
being presented as a complete service-worker or process egress audit.

Further repeats exposed failed media/growth predicates, including a connected
TLS receiver with audio energy but zero decoded video after a rejoin. A
subsequent failure snapshot showed all six directions live, so those probes
do not establish one root cause. The final sampler accounts for replaced
RTP streams, explicitly displays Gallery in a larger viewport and rejects
off-page video sinks. A direct click on the hidden Layout controls also caused
one test-driver timeout; the final driver uses the actual More/Layout menu.
The [bounded investigation](../evidence/independent-call-connectivity-20261023/reconnect-investigation.json)
retains the negative observations. No production media repair was made or
inferred. Other/default layout behaviour is not qualified by this final pass.

## Independent-provider investigation

The current [Open Relay documentation](https://www.metered.ca/tools/openrelay/)
requires an account/API key for its REST credential path. It also documents a
static-auth hostname and publicly supplied shared secret for integrations
such as Nextcloud. The hostname resolves, but no allocation or media test was
made against that service. An advertised integration does not establish
unrestricted account-free use as a KithMoot default.

Metered's [terms](https://www.metered.ca/terms), effective 24 September 2026,
describe an account-based, business-only service and make the account holder
responsible for use through its credentials. Schedule 1.3 specifies 30-day
retention of connection IP metadata. Its [privacy policy](https://www.metered.ca/privacy)
also describes connection metadata processing. This is a researched candidate,
not a qualified default or a zero-logging service. No account was created,
terms accepted, master key adopted, provider contacted or public TURN
credential used. No production configuration changed.

## What the legal review can now rely on

The existing legal review agent read the implementation and current provider
pages. The concrete improvement is that transport credentials and denial are
separate from room membership in the exercised product path: users select
their own transport, alpha can disappear without removing room access, and
replacement requires no publisher permission or new invitation.

This supports the intended software-publisher position. It does not establish
the statutory classification of a real deployment. Shared jurisdiction-kit
notes at revision `9243203` were verified 28 September 2026, with relevant
updates on 23 October. The application of those notes to this offering remains
`[U]`; the test does not convert it into a legal exemption.

## Decisive gaps

- **Guest setup:** each test user still enters credentials. A normal guest
  must ultimately join without handling server URLs or passwords. No suitable
  independently operated automatic-provider path has been qualified.
- **Real networks and operators:** home/mobile NATs, blocked UDP, TLS on a
  publicly reachable permitted port, valid public PKI, genuinely independent
  operators, four real participants and physical GrapheneOS remain untested.
- **Replacement experience:** Settings plus reopening works; seamless runtime
  failover and credential renewal are not proved. A refused or lost transport
  must not silently weaken the person's relay-only choice.
- **Application authority:** admission, unauthorised join, removal, key custody
  and absence of indirect publisher control still need their own audit.
- **Logging and capture:** complete app/dependency/host/provider retention and
  real screen/window/area protection remain separate outstanding gates.

The [owner requirements](call-independence-requirements.md) still apply. Manual
configuration is useful evidence of replaceability, not the accepted final
download-and-call experience.
