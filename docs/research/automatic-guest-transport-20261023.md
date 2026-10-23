# Automatic credentials for guests on an independent deployment

Local implementation and qualification, 23 October 2026. This exercises an
existing deployment option rather than inventing another room protocol.
An independent operator can build the static web app with
`VITE_TURN_CREDENTIAL_ENDPOINT=https://issuer.example/turn`. Fresh visitors
then obtain their own temporary transport login when joining a room on the
default network hints, without Connections settings or an imported file.
The operator supplies actual relay capacity. A room link supplies no capacity.

ForgeSworn's normal build still selects no issuer. This increment does not
add provider selection to its website, enable a public service, create a
provider account or publish a deployment. A separate build is an operator
setup step; it is not a claim that every ordinary room creator can already
select a provider without setup. Device-selected TURN credentials retain
precedence, and rooms with custom ICE hints still bypass this issuer.

## Credential and privacy boundary

The issuer receives a GET at its configured endpoint. The client supplies no
room identifier, invitation, room/media key, npub, request body, authorisation
header, cookies or referrer. The request still reveals the caller's network
address and normally the static app's Origin. Neither encrypted rooms nor
referrer omission makes the transport operator unable to observe metadata.

The existing `server/turn-credentials.mjs` can serve a self-hosted coturn
REST issuer. Its shared secret remains on the server; it generates a random
label and a timestamp-bound HMAC login on each request. It does not receive
or enforce room membership. It currently exposes unauthenticated issuance:
CORS and its in-memory per-IP rate limiter are not access control. An
operator must choose its own permission, capacity and abuse arrangement;
this test fixture is not a production deployment prescription.

The browser expects a flat response:

```json
{
  "urls": ["turns:relay.example:443?transport=tcp"],
  "username": "server-issued-expiry-and-random-label",
  "credential": "server-issued-temporary-password",
  "ttl": 3600
}
```

No example here is a working credential. The optional standard
`credentialType: "password"` is accepted. Unknown fields, master-key fields,
STUN/HTTP entries and malformed TURN addresses are refused. The schema
cannot detect a root key mistakenly supplied as the `credential` value.
The issuer must return only legitimate client credentials and an accurate
remaining lifetime, not its configured maximum before upstream delays.

The current session refreshes every forty minutes. This increment therefore
accepts integer `ttl` values from 3,600 to 86,400 seconds and refuses shorter,
missing or unsupported leases instead of assuming they last an hour. An
adapter for shorter-lived credentials needs a different renewal scheduler;
do not pad its TTL to pass this check. The monotonic deadline starts before
the request, so network delay is not added to validity. Credentials remain
in runtime memory and are filtered before new peer allocations after expiry,
including when refresh failed and the device has selected its own STUN.
This does not revoke already established allocations, prove long-call
renewal or prevent the operator enforcing an earlier expiry.

The fetch has a four-second default bound, including a stalled body or a
fetch ignoring abort, and a 16 KiB streamed-body limit. It omits cookies and
referrers, requests no-store, refuses redirects and requires JSON. Endpoint
configuration accepts a same-origin absolute path or HTTPS URL without
userinfo, query or fragment. It is build configuration, not an untrusted
room hint. Failure returns no credential and emits no raw provider error.
Relay-only policy still refuses a call without usable authenticated TURN;
chat does not depend on successful issuance. Direct connectivity remains
available only under the person's existing non-relay-only setting.

## Independent provider findings

Checked against primary provider documentation on 23 October 2026:

| Candidate | Useful capability | Qualification finding |
| --- | --- | --- |
| Self-hosted coturn and existing issuer | Per-request expiring credentials, with no room input | Implemented locally. A real operator, permission/capacity arrangement, public TLS and separate-network acceptance are still needed. No ordinary-user hosted service is supplied |
| Cloudflare TURN | Backend generates short-lived client credentials | [Official guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/) requires the long-term TURN key to stay out of browsers/apps. An independent backend must normalise its `iceServers` wrapper and enforce an accurate supported TTL. Account eligibility, terms, metadata retention and a real independent issuer have not been qualified |
| Metered/Open Relay | Browser credential retrieval and managed TURN | The REST credential route in [Open Relay documentation](https://www.metered.ca/tools/openrelay/) requires an account/API key. The page also publishes static-auth integration; permission and suitability for accountless KithMoot use have not been qualified. [Terms](https://www.metered.ca/terms), effective 24 September 2026, clause 2.2 restrict account holders to business purposes, including a prohibition on personal/household account signup. This is not a prohibition on every downstream consumer user; authorised end users and account-holder responsibility are separate. Not selected for the proposed ordinary personal room-creator path |

Cloudflare hosting by itself is not operational independence. A worker
running under ForgeSworn's account with ForgeSworn's key would remain an
operated dependency. No provider account, signup, payment, live credential
request to a commercial provider, benchmarking publication, external message or production change
was made for this increment. No commercial provider is qualified here.

Further Cloudflare primary-source review found that its
[Realtime-specific terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)
(updated 28 September 2026) permit video functionality for customers'
Internet Properties, retain customer content/support responsibility, and
restrict telecommunications services including PSTN calling. The
[self-serve agreement](https://www.cloudflare.com/terms/) addresses individuals
and represented entities and restricts third-party sale/loan of service
access. Those provisions need applying to the specific deployment; this
review establishes neither a consumer signup prohibition nor permission
for an arbitrary public relay resale arrangement. The
[TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/) identifies
client IP addresses, ports and session timing as processed metadata and
offers usage analytics. These pages do not establish zero retention. Do
not use HTTP Logpull settings or the DNS resolver's privacy promises as
evidence of TURN retention settings.

## Validation

The local gate is `npm run test:automatic-calls`, using three fresh Chromium
contexts, synthetic media, the real existing Node issuer and a disposable
coturn instance with REST authentication. The TLS certificate is temporary
and self-signed, using a test-only browser exception. HTTP/WS requests to
non-loopback hosts are blocked in the group journey under test. Browser media
uses relay-only ICE and TURN/TLS; there is no injected ICE configuration.

The gate asks for 1:1 and group media, subsequent rejoin, distinct temporary
browser logins, no login persisted in local/session storage or placed in the
room link, no guest configuration/import, and no cookie/referrer/query/body
at the issuer. A separate refusal case asks for a joined chat with no media
peer created under relay-only policy. Media acceptance requires growing
decoded video and audio energy for each remote peer; connection state or
stale RTP counters cannot pass. These are bounded synthetic local checks,
not independent real operators, real networks, public PKI or physical phones.

The [media result and tested source hashes](../evidence/automatic-guest-transport-20261023/result.json)
record **one failed media/rejoin case and one passed refusal case**. The
automatic 1:1, initial three-person group and distinct-login/local-storage
assertions passed before rejoin failed: one receiving peer decoded zero
video frames while receiving audio over a nominated relay/relay TLS path;
the other five receiving directions decoded video. The bounded attachment
also records the available video sinks. It does not establish the root cause.
No production video repair was made. This gate remains red.

The independent [HTTP boundary case](../evidence/automatic-guest-transport-20261023/boundary-result.json)
passed after that failure. Two fresh browsers entered the real call controls,
obtained distinct temporary logins without Settings/import, left neither
login in local/session storage or the room link, and sent no cookie,
authorisation header, referrer, query or body to the issuer. A seeded cookie
made cookie omission a real negative control. The full media case had not
reached its own post-rejoin HTTP assertions; the separate case supplies that
bounded evidence. The final three-case file was not run as an all-green suite.

Seventy-nine targeted unit tests passed across five files, including
malformed/root-key/unsupported-lease refusal, response/time limits and
expiry after failed refresh with a custom device STUN setting. Type checking
passed for the library and app. Production builds passed, including pinned
native asset and no-telemetry-marker checks. The existing checkout's locked
dependency installation was reused by a temporary symlink, not freshly
installed. No hosted CI or Android/device qualification ran.

Earlier attempts remain recorded: the
[initial media run](../evidence/automatic-guest-transport-20261023/initial-result.json)
failed the fresh-counter requirement during the initial group; the sampler
then gained RTP-epoch/reset handling while retaining fresh video/audio
requirements. The subsequent
[startup timeout](../evidence/automatic-guest-transport-20261023/startup-timeout.json)
ran no browser cases. The fixture now bundles the real Node issuer against
`src/turn.ts` using esbuild instead of compiling the entire library first.
An [initial boundary-test setup](../evidence/automatic-guest-transport-20261023/boundary-initial-result.json)
only entered chat on one guest; the corrected case drives call entry on both.
These corrections do not erase the final, independently reproduced rejoin
failure. Hosted CI, sustained refresh, real screen capture, GrapheneOS and
real-network acceptance remain outstanding.

## Legal position

Apply jurisdiction-kit `9243203`, law note verified 28 September 2026 with
relevant sections updated 23 October. The authorised independent AI review
supports a publisher-only position conditional on actual independence;
the exact application remains `[U]`. ForgeSworn must hold no provider/master
credentials, operate or direct no issuer and retain no application-admission
or mandatory-update entitlement. The independent operator must separately
assess its combined static-app/issuer/transport offering, application
admission and metadata processing. Room-blind issuance supports a factual
transport distinction; it does not automatically settle service-provider
status or establish an OSA exemption. See the shared
[transport-infrastructure note](../../../jurisdiction-kit/law/gb/online-services.md#211-transport-infrastructure-and-personal-endpoints)
and [project position](../legal/call-transport-position.md).

This increment minimises one request path. It does not complete the client,
dependency, proxy, container, OS, crash, provider or backup logging audit.
It does not prove a zero-logging product or transfer all duties to an operator
merely by changing its name. The owner requirements remain in
[call independence requirements](call-independence-requirements.md).
