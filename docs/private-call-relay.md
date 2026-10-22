# Your own relay for a one-to-one call

KithMoot can use an authenticated TURN relay chosen on each device. This
works in existing rooms; you do not need a new invitation. Each person
enters their relay address, username and password in **Settings →
Connections → Call relay (TURN)**, saves, then leaves and reopens the room.
The web app has these fields on Connections; Android opens a dialog there.

Each device keeps its own login. It is never added to a room invitation or
published to Nostr. On Android it is encrypted using the Android Keystore
and excluded from backups. The web app keeps it in this browser's local
storage, like its other device settings; use a trusted browser profile.
Removing the relay deletes the saved login. Neither client substitutes an
unrelated relay when the saved configuration cannot be read.

A relay you already run, or a managed TURN provider, supplies:

- **Relay addresses:** for example `turn:relay.example:3478,
  turns:relay.example:5349`. Use the provider's exact addresses, separated
  by commas. `turn:` supports UDP and TCP; `turns:` uses TLS over TCP.
  Safari/WebKit needs UDP or TLS; a plain TCP-only relay is refused with an
  explanation. Other browsers retain plain TCP support.
- **Relay username** and **Relay password:** the account issued for that
  device. A permanent coturn authentication secret is an administrator
  secret, not a password to enter in the client.

The existing STUN field is separate: it supplies address-discovery servers
to new room links and cannot carry TURN passwords. Device relay settings
take precedence over those room hints. Credentials are attached only to
the relay addresses entered alongside them.

## Prepare a small private server

For a Linux server with Docker Compose and a public IPv4 address assigned
directly to it, generate
the files on your trusted machine first. Replace the example hostname and
address with your own. The output directory must be new and outside the
repository; it contains passwords and must stay private.

```sh
python3 deploy/private-call-relay/prepare.py \
  --host relay.example \
  --public-ip 203.0.113.10 \
  --output "$HOME/private-kithmoot-relay"
```

The documentation address above is a placeholder; the generator refuses
it until replaced with a public address. It creates a coturn configuration,
`compose.yaml`, and separate `you.json` and `friend.json` login files. It
refuses to overwrite an existing directory or print passwords. Transfer
the generated directory securely to your server, preserve its permissions,
and run:

```sh
sudo docker compose up -d
```

Run that command **inside the generated directory**. The Compose file is
for Linux with host networking. Allow inbound **3478 UDP and TCP** and
**49180–49211 UDP** on both the host and provider firewalls. The public
hostname must resolve to the server's public address. The generated setup
binds listening and relay sockets to that address, including on hosts with
Docker bridge interfaces. Servers behind NAT need an internal relay address,
an explicit public/internal mapping and port forwarding instead; use the
full deployment runbook below for that arrangement.

When 3478 is already occupied, choose a separate free listener and relay
range with `--port`, `--relay-min` and `--relay-max`. For example,
`--port 49300 --relay-min 49301 --relay-max 49332 --udp-only` creates a
UDP-only private instance. Reserve that range for it and allow it through
both firewalls. It does not provide a TCP or TLS alternative for restrictive
networks. Keep an existing service's allocated ports separate.

Enter `you.json` on your device and privately give your friend the details
from `friend.json`. These are persistent credentials for this small private
relay; remove its accounts or stop the server when you finish:

```sh
sudo docker compose down
```

This minimal configuration serves TURN over UDP/TCP on 3478. Networks
which permit only TLS on 443 need a TLS listener and valid certificate on
a free public port 443. For a full TLS deployment, the existing
[coturn deployment runbook](../deploy/README.md) covers certificates and
time-limited credentials. Use a `turns:` address in the clients when your
server has that listener configured.

The relay is authenticated, restricts private peer targets, bounds
allocations and per-allocation throughput, and keeps no coturn/container
logs. It relays encrypted WebRTC traffic. It does not provide signalling;
the room's existing Nostr relays still do that.

After deployment, check the real server from another network using the
private login files kept on your trusted machine:

```sh
node test/private-call-relay-live.mjs "$HOME/private-kithmoot-relay"
```

Add `--udp-only` when that is the deployed listener. This sends synthetic
audio and video between two relay-only peers, requires decoded media in
both directions, and checks that a wrong password obtains no allocation.
It prints aggregate results without credentials. It is separate from a
real call with your friend or GrapheneOS device acceptance.

## Local verification

```sh
npm run test:call-relay -- --project=chromium
```

Requires Docker, Playwright Chromium and the repository's prepared web
dependencies. Install the browser with `npx playwright install chromium`
if needed. The test
starts a loopback-only coturn with separate generated accounts, configures
both browsers through Settings after creating the room, and forces
relay-only ICE. It requires relay candidates, received bytes, displayed
video, decoded frames and audio energy in both directions while `/turn`
returns 410. It also checks password exclusion from share links, persistence
and removal. The fixture removes its container and temporary files on
shutdown. Its loopback permissions are for local testing only.

The same config includes a constructor compatibility check for WebKit:
install its Playwright browser and run
`npm run test:call-relay -- --project=webkit`. This checks the application's
actual URI fallback with a relay-only policy; it does not establish a
physical Safari call. On macOS 14 Playwright supplies a frozen WebKit build,
which may be unavailable on the local host.

This is browser transport evidence. Android build/unit checks and a real
GrapheneOS device without Google Play remain separate acceptance gates.

The [local validation record from 22 October 2026](evidence/private-call-relay-20261022.json)
records the source hashes, browser media proof, Android checks and remaining
device/deployment gates. The local WebKit runtime could not create a page
because its protocol lacks `PushAPIEnabled`; no application code ran there.
The same constructor compatibility case subsequently passed in Playwright
1.62.1's Ubuntu 24.04 container, using the actual application function and
a relay-only policy. Physical Safari acceptance remains separate.
