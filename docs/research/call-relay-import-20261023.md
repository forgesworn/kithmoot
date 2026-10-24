# Importing and checking an independent call service

Local prototype, 23 October 2026. This removes typing TURN settings from the
guest setup step. It does **not** supply a public service, automatically
provision transport from a room invitation or complete the normal guest
journey in [the owner requirements](call-independence-requirements.md).

## Where the service and file come from

A provider or self-hosting operator must supply an authorised per-device
TURN login. ForgeSworn does not create a provider account, hold its master
key, issue a transport credential or operate a public service through this
feature. The two disposable coturn instances in the local test are **test
fixtures on one machine**, not newly available public providers. The existing
private deployment has not changed.

An operator can prepare a private JSON file in this shape; these values are
examples, not a working service or login:

```json
{
  "urls": ["turns:relay.example:443?transport=tcp"],
  "username": "device-login",
  "credential": "device-password"
}
```

`urls` can also be one URL string. The only optional field is
`"credentialType": "password"`. Unknown fields are rejected, including
provider API keys, shared-secret fields and `expiresAt`. The importer cannot
determine whether someone mistakenly placed an account master key inside
the password field; the operator must supply the right credential.

Coturn REST credentials can use an expiry embedded in the username, enforced
by that server. This client does not parse it, renew it or promise a usable
lifetime. There is no standard expiry field supported by this file format.
Do not send an unrestricted provider API key or coturn shared secret.

The file is a bearer secret. Share it privately with its intended recipient;
do not commit it, publish it, put it in a room link or reuse one unrestricted
login for every software user. The format does not itself enforce audience,
room scope, quota, lifetime or a provider contract. Those are operator facts
to qualify, not guarantees supplied by the import button.

## What the guest does

1. Open **Settings → Connections → Import call relay file**.
2. Choose the file and review the displayed server addresses.
3. Choose **Save call relay**. Saving uses the existing browser-local JSON
   storage; it is not an encrypted credential vault.
4. Optionally choose **Test saved call relay**, then open or reopen the room.

Importing parses at most 16 KiB locally and does not save the login or contact
the named server. Invalid files leave the previous settings intact and show
a fixed error without echoing passwords, provider keys or file contents.
The whole application can make other requests independently; this statement
is about importing the file. Closing settings or editing the form invalidates
late import results.

Testing is a separate explicit action. Its notice explains that it contacts
the saved operator, revealing the device's network address and authentication
information. It sends a small test payload through two temporary relay-only
WebRTC data connections, verifies the nominated candidates are relay/relay
and confirms an echoed payload. It requests no camera, microphone, screen,
room identifier or room key. It never falls back to direct or STUN traffic.
Unsaved edits must be saved before testing, so a hidden old endpoint is not
contacted in place of the addresses the person reviewed.

A pass checks a data path from **this device** through this server. It does
not qualify another participant's network, audio/video decoding, capacity,
browser/platform support, provider identity, terms, independence or absence
of logging. A provider may prohibit two local allocations communicating
with each other; a failed self-test therefore does not establish that every
possible call would fail. Test timeout is 12 seconds. Success, failure,
cancellation, settings navigation, removal and replacement close the test
connections. Ordinary calls keep their existing selected-server behaviour.

No test result, candidate address, payload or error object is persisted by
this feature. This is a bounded code finding, not a full client/OS/provider
zero-logging claim. Existing dependency and host audits remain outstanding.

## Validation

The [final structured result](../evidence/call-relay-import-20261023/result.json)
records both browser cases passing: the new import/check/refusal/cancellation
case and the existing two-/three-participant TLS call and replacement case,
now using imported files for the two guests. All three additional reload/
rejoin cycles passed in that run. Importing and saving are still separate
guest actions; no automatic guest provisioning is claimed.

Thirty-nine targeted unit cases passed across the new profile parser,
existing device relay and relay-only privacy tests. Type checking and the
production build passed. Locked dependencies were reused through a temporary
symlink to the existing checkout installation, not freshly installed. No
hosted CI or Android/physical-device qualification ran for this increment.

The [initial result](../evidence/call-relay-import-20261023/initial-result.json)
retains a failed group repeat-rejoin case and a passed import/check case.
The group failed on repeat reconnect 2 with one connected TLS receiver
receiving audio but decoding zero video frames; the other five directions
were decoding. Its sink was connected and unpaused but not visible in the
failure snapshot. Initial group calling, server replacement and the first
extra rejoin had already passed. The Mac's reported load average reached
94.99 during this run. Load is an observation, **not an established cause**.

No production video repair was made. The subsequent pass, richer bounded
failure diagnostics and final Gallery selection do not establish that this
intermittent issue is fixed. Keep it open alongside the earlier
[rejoin investigation](independent-call-connectivity-20261023.md). The
structured reports retain only synthetic participant ordinals and media
counters, not connection credentials or packet captures.

## Legal boundary

The existing AI legal review assessed the proposal against jurisdiction-kit
revision `9243203`: law notes verified 28 September 2026, relevant updates
23 October. Explicit per-device configuration supports the intended publisher
position without adding a publisher issuer or room-admission authority. Its
application to the final offering remains `[U]`. Importing a file does not
establish an Online Safety Act exemption, qualify the provider's obligations
or turn transport credentials into room permission. See the
[current call-transport position](../legal/call-transport-position.md).

## Still needed for the intended product

- An independently operated, legitimately available provider path with
  consumer eligibility, bandwidth terms, metadata retention and credential
  provisioning qualified. No provider has been selected or contacted here.
- Automatic guest provisioning without typing settings **or separately
  importing a file**, without a required ForgeSworn account or issuer.
- Real separate-network, valid-public-certificate and blocked-UDP tests,
  physical GrapheneOS acceptance, and the outstanding capture/authority/log
  checks. The local self-signed fixture does not establish these.

An eventual room-creator-sponsored transport design must keep account/master
keys local, issue bounded per-device transport access, preserve participants'
ability to choose another transport, and avoid leaking room capabilities to
providers. That is a candidate design, not an implemented or authorised
provider integration. A room link cannot manufacture relay capacity.

Further read-only provider research on 23 October found that Cloudflare's
[credential guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
requires a long-term TURN key kept out of the browser/app and short-lived
client logins generated by a backend. Its API returns an `iceServers`
wrapper, not this importer's single-login file: an operator would need to
extract the authenticated TURN entry when preparing the file. That research
has not qualified consumer terms, retention or a no-publisher guest issuer.
No account, key, purchase, signup, provider allocation or live call was made.
