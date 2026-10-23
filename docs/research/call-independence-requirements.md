# Calling: no publisher control and no call logging

Owner decision, 23 October 2026: **"we want zero control, zero logging!"**

This is the required design for the proposed calling transport. It is not a
claim that released clients, the FIPS experiment or existing hosting already
meet it. No deployment or deletion of existing records is made by this note.

## The user journey

The owner clarified the required product on 23 October:

1. Open the website or install the software.
2. Create a private room on the device.
3. Share the room link with friends.
4. Friends open the link in an ordinary browser or installed client.
5. Exchange text chat and have two-way voice/video calls, including groups.
6. Share a screen, a selected window/app or a selected area, with local
   redaction controls and a preview of what friends actually receive.

The normal journey must not require a server deployment, relay URL entry,
transport credentials or a ForgeSworn calling account. Self-hosting remains
an optional supported path. Browser guests must not need a native mesh helper
or VPN installation. Keep room capabilities out of hosting requests, logs,
telemetry and third-party request payloads.

These usability requirements apply together with the authority/logging
requirements below. Manual infrastructure setup or a same-host helper demo
does not complete this journey.

## Screen, window and area sharing with redaction

Owner clarification, 23 October: all three sharing modes and redaction are
part of the required product. Changing the media transport or reusing Sapflow
must preserve these capabilities. A successful camera-only call is not full
product acceptance.

- Offer whole-screen, window/app and selected-area capture wherever the
  platform permits them. Browser guests must be able to view shares without
  installing a helper. Publishing support must be qualified per browser/OS;
  do not promise that every mobile browser exposes display capture.
- Let the sharer select and preview the source and crop, add/move/resize
  opaque redaction masks, hide/resume the entire share and stop capture.
  Make the transmitted picture clear before publishing. Do not substitute a
  whole-screen share when the selected mode is unavailable.
- Keep the raw capture on the device. The outgoing pipeline is **capture →
  crop/redact locally → encode → encrypt → send**. Every recipient, forwarding
  path and any separately chosen recording/export must receive only the
  protected share. A receiver overlay, blur or pixelation does not satisfy
  redaction. Do not upload raw frames to a server for protection.
- Apply protection from the first transmitted frame. If source identity,
  geometry, mask state or the compositor cannot be trusted, cover the whole
  share or stop it. Never fall back to raw capture. Recheck movement, resize,
  display-scale changes, rotation, source switching, minimisation and capture
  restart. Window masks need a defined anchor in the captured window's
  coordinates; desktop coordinates alone do not establish safe mapping.
- Treat masks as user-selected regions, not automatic tracking of sensitive
  content. Say so in the controls: a secret moved outside a mask is no longer
  covered. Automatic text/content detection is a separate unqualified feature.
- Keep microphone and shared app/system audio controls distinct. Visual
  masks do not redact audio. Hiding the entire share must silence its shared
  audio, without unexpectedly changing the microphone or listening device.
- Stop all capture tracks on cancel, stop, leave, revoked permission and
  source closure, including late permission results after cancellation.
  Do not persist source names, window titles, pixels, masks or capture
  diagnostics as call logs. No automatic recording or cloud processing.

### Existing implementation and gaps

Read-only source inspection on 23 October used the web prototype's base
`bd322c6de13c389f67713171487e54fdba763e6b` and the separate Android working
checkout. These are source findings, not fresh device acceptance.

| Client | Existing source | Gap to the required experience |
| --- | --- | --- |
| Desktop | [`share-redaction.md`](../share-redaction.md), `app/src/redaction.ts` and `share-area.ts`: local canvas crop/masks and whole-share cover; desktop bridge supplies screen geometry | Active masks refuse or wholly cover single-window capture; window-following masks remain a design note. Existing desktop boxes are unavailable on Wayland. Requalify platform protection and lifecycle paths |
| Ordinary browser | New local `browser-share.ts` window/tab path behind **Share an area** and **Share with redaction**: source-relative crop/masks, protected preview, manual protected canvas frames, hide/resume and audio silence | Chromium synthetic remote-pixel and two-context room checks pass locally. Monitor/unknown sources are refused pending capture-recursion qualification. The ordinary Share button retains its existing path; no claim that every browser share is protected. Real OS pickers, other browsers and recording/export acceptance remain open |
| Android | `media/LocalMedia.kt` uses `ScreenCapturerAndroid` with MediaProjection and optional playback-audio capture | The inspected screen path passes capture directly to its video source; no share crop/mask compositor was found there. Add protection before encoding and qualify on physical GrapheneOS without Play |

The [W3C display-capture specification](https://www.w3.org/TR/screen-capture/)
describes user-authorised display capture, including browser-selected surfaces;
it is not evidence of uniform implementation across browsers. Android's
[MediaProjection documentation](https://developer.android.com/media/grow/media-projection)
describes whole-display capture and Android 14+ app-window selection. Neither
API supplies the application's redaction policy or proves its implementation.

Acceptance must inspect the **sender's protected track and the remotely
decoded frames**, using synthetic secret markers inside and outside masks.
Exercise startup, moving/resizing masks and sources, mixed display scales,
rotation, hide/resume, permission withdrawal, cancellation and reconnect.
Check that covered markers never reach the receiver, including the first
frame and failure cases, while permitted content stays readable. Prove the
same boundary for any recording/export sink and verify shared-audio silence
while hidden. Run desktop/browser coverage separately from physical
GrapheneOS acceptance; the FIPS synthetic camera fixture proves none of this.

The [23 October implementation evidence](publisher-independence-evidence-20261023.md)
records the first protected browser path and its bounded local acceptance.

## Authority belongs to participants

ForgeSworn publishes software. Participants' devices create rooms, control
membership and retain their own room/media keys. ForgeSworn must have no
runtime authority to approve, revoke, inspect or administer their calls.

- No publisher calling account, global entitlement, central room approval,
  remote room administration, remote call kill switch or remotely required
  permission token.
- No required ForgeSworn-operated discovery directory, signalling relay,
  credential issuer, transport peer or browser gateway. Every network
  dependency needed for a call must work independently of ForgeSworn.
- Users can select and replace independent transport/discovery providers or
  self-host. Any defaults must remain replaceable without publisher approval.
  This must preserve the intended simple download-and-call experience; a
  manual server setup requirement is not an accepted final usability result.
- No ForgeSworn master room key, participant roster, key escrow, hidden
  administrative identity or service-wide membership credential.
- Software updates remain a publishing function. Installing an update must
  not be a publisher-controlled prerequisite for access to existing rooms;
  no remote configuration may introduce call authorisation or a kill switch.
  Compatible independent implementations remain possible.

"Zero control" means no retained publisher call-service authority. It does
not remove participants' room controls or independent network operators'
ability to refuse packets. Changing a server's owner in name while retaining
its credentials or operational authority does not satisfy this requirement.

Caller devices must not forward unrelated third-party payloads by default.
Any separately chosen transit role needs explicit operator choice, enforced
bounds and its own privacy/operating assessment. The tested FIPS `leaf_only`
flag does not establish that enforcement.

## No call records from the calling stack

No persistent or exported call logs: call content, IP addresses, participant
or room identifiers, npubs, connection times, durations, access records,
packet captures, authentication events, automatic call history or per-user
usage records. No calling analytics, telemetry or automatic crash uploads
containing those data. This applies to normal operation, errors and shutdown.

The implementation must audit every path, including native dependencies,
stdout/stderr, diagnostic buffers, files, HTTP proxies, container drivers,
system journals, firewall logs, core dumps and backup/export integrations.
Discarding the application's main log file alone is insufficient. An opt-in
support flow must not silently weaken this requirement or collect real call
metadata; synthetic diagnostics are a separate development activity.

Only the bounded in-memory state needed to route and complete the current
communication may exist. Expire it on session end, failure, timeout and
restart; do not persist it or convert it into a session history. This is not
a claim of forensic erasure of every memory, swap or OS copy.

Room membership and messages deliberately saved by users are user-owned
application state, separate from operator logs. This decision does not
authorise deleting their saved data. Participants and independent providers
can observe or record information themselves; ForgeSworn cannot promise
their behaviour. Public npub/endpoint adverts can also persist on other
people's relays, so minimise their publication, identity linkage and lifetime
rather than calling the design anonymous or globally unlogged.

Any ForgeSworn-managed component assessed against this requirement must be
checked through its host/proxy/provider chain. If a third party retains
metadata, we must describe that boundary accurately and cannot advertise
that deployment as universally unlogged. Operating a component ourselves
would also require reassessing the intended software-publisher position.

## Acceptance evidence and current gaps

| Requirement | Evidence needed | Current status |
| --- | --- | --- |
| No publisher runtime dependency | Create, join, call and reconnect using independent infrastructure while blocking publisher endpoints, including discovery, issuer, gateway and update/config hosts | Two-context local product journey passes; three-context TURN/TLS group and transport replacement also pass with external HTTP/WS denied. Real independent operators and separate networks remain untested |
| Participant-only room authority | Trace invitation, admission, revocation and keys through web, Android and any gateway; test membership refusal without publisher participation | Not tested by the synthetic fixture |
| No hidden central authority | Review deployed configuration, administrator credentials, remote configuration and software-update prerequisites | Not established |
| No persistent/exported call logs | Exercise successful, refused, failed and interrupted calls; inspect storage and network outputs across dependency, OS, container and provider paths | Ordinary-build timeline disabled and call-event console output removed; full client/dependency/host audit remains open |
| Bounded transient state | Verify expiry/cleanup after disconnect, crash and restart without restoring call history | Not established |
| Enforced endpoint-only behaviour | Refuse third-party forwarding while preserving legitimate endpoint calls | FIPS leaf-only counterexample reproduced |
| Simple independent connectivity | Two separate networks, ordinary browser guests and physical GrapheneOS without Play; four real participants after two-device acceptance | Three local browsers pass via separate TURN/TLS instances, including replacement in the same room; manual credentials, separate networks, independent operators and device acceptance remain open |

The [separate-call-server evidence](independent-call-connectivity-20261023.md)
requires growing decoded video and audio counters for every peer. It proves
transport interoperability and explicit replacement locally; it does not
qualify a public provider or remove guest setup.

The local [connection-file import](call-relay-import-20261023.md) adds explicit
review/save and a relay-only data test without manual address/password entry.
An independently supplied file is still an extra guest setup step. It does
not supply a provider, automatically provision a room guest or change the
unqualified separate-network and operator gates above.

The [FIPS fixture](../../test/fips-call/README.md) writes temporary daemon
diagnostics for synthetic runs and deletes them at teardown. It is not a
zero-logging product implementation. Its retained JSON evidence describes
synthetic test outcomes and is not a record of users' calls.

A previous read-only host assessment on 23 October found HTTP redirect
records in the system journal/syslog and firewall records mentioning private
relay ports. CDN/provider and backup retention were not fully audited.
These are dated findings, not a fresh live readback or proof of call logging.
Production zero-logging cannot be claimed from the coturn log settings alone.

## Sapflow reuse for the web

The owner wants to reuse Sapflow where it can provide the browser experience.
Read-only inspection on 23 October used Sapflow source commit
`18bf6606cf723babcde95e2a6c236a6dee73b532`. Its unrelated Android qualification
work was preserved.

| Component | Current source evidence | Proposed role and qualification needed |
| --- | --- | --- |
| KithMoot rooms and chat | Existing client-side room capabilities, signalling and chat | Preserve this application layer; exercise the complete create/share/join/chat/call journey |
| Browser WebRTC | Existing KithMoot peer connections and media encryption | Initial conversational media path; qualify cross-network connectivity and ordinary guests |
| Sapflow shared libraries | `sapflow-client/src/lib.rs`, `media.rs` and `queue.rs`: runtime-free compressed H.264/AAC validation, queues and publishing session policy | Evaluate a WebAssembly/browser adapter and useful shared primitives; no shipped browser SDK was found or proved |
| Sapflow origin | SRT/RTMP input, LL-HLS output and optional recording in current README/server | Existing broadcast function; not a proven conversational transport or opaque forwarding service |
| Sapflow scoped publishing | `docs/scoped-publish-sessions.md` and server `publish_sessions.rs`: origin admission, refresh/revocation and transport secrets | Do not introduce this origin-controlled publishing authority into private calls as a shortcut |
| Independent connectivity | Default-MTU, no-transit, separate-network and browser compatibility gaps remain | Must supply automatic reachability without required publisher-operated infrastructure; no qualified complete solution established |

WebRTC already provides browser media communication. A custom WebCodecs path
would expose codec primitives but still need transport, encryption, timing,
loss/congestion handling and browser qualification. WebTransport connects a
browser to a server; it would still need an independent server path. A
WebAssembly build alone establishes none of these connectivity properties.
Primary API references: [WebRTC](https://www.w3.org/TR/webrtc/),
[WebCodecs](https://www.w3.org/TR/webcodecs/),
[WebTransport](https://www.w3.org/TR/webtransport/),
[WebAssembly web integration](https://www.w3.org/TR/wasm-web-api-2/).

The implementation sequence is browser-first: prove the user journey with
existing KithMoot media, qualify a useful Sapflow browser adapter separately,
and require measured improvement before changing the call engine. Broadcast
playback and local media decoding cannot substitute for interactive group
call acceptance. Any new media gateway must preserve participant-held media
keys, local admission and the no-logging requirement. Transport code reuse
does not settle the legal role of whoever operates it.

## Legal assessment

The intended position is software publication without operating or
controlling the underlying calling service. Removing retained authority
supports that position; disabling logs alone does not decide provider status.
The statutory distinction is control over who can use the user-to-user part,
including the separate treatment of access facilities:
[OSA section 226](https://www.legislation.gov.uk/ukpga/2023/50/section/226).
Infrastructure can still be subject to legal process, including
[section 146](https://www.legislation.gov.uk/ukpga/2023/50/section/146).

This applies legal-cover notes at `9243203`, overall verified 28 September
2026 and relevant updates 23 October 2026. The independent AI legal review
supports the stated boundary and qualifications. It does not establish an
OSA exemption, settle every operator's role or remove data-protection duties
for transient processing. The existing [prototype assessment](fips-call-prototype-20261023.md)
remains the evidence for what was actually tested.
