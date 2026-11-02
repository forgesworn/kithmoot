# TURN over TLS on port 443

Keep UDP TURN on 3478 and TLS TURN on 5349. A dedicated TLS hostname on 443
provides another route for networks which block those ports. A network that
blocks TURN or intercepts TLS can still refuse it; verify the intended network.

This uses an existing Caddy build with
[`caddy-l4` SNI routing](https://github.com/mholt/caddy-l4/blob/master/docs/matchers/tls.md).
Add the following route inside its existing
`servers :443 { listener_wrappers { layer4 { ... } } }` block. Preserve all
other routes and the `tls` listener wrapper after `layer4`.

```caddyfile
@kithmoot_turn tls sni call-relay.kithmoot.forgesworn.dev
route @kithmoot_turn {
    tls
    proxy 62.238.98.53:3478
}
```

The upstream is the existing coturn TCP listener. Caddy terminates TLS; media
remains protected by WebRTC. Neither coturn's secret nor its allocations change.
Create a **DNS-only** A record for that hostname pointing at `62.238.98.53`;
an HTTP CDN proxy cannot carry this connection. Add this certificate host:

```caddyfile
call-relay.kithmoot.forgesworn.dev {
    tls {
        issuer acme {
            disable_tlsalpn_challenge
        }
    }
    respond 404
    log {
        output discard
    }
}
```

Port 80 must remain reachable for HTTP-01 certificate issuance. Validate the
complete Caddy configuration before reloading. Back up the Caddy configuration,
credential service module and its environment file before activation. Keep
the credential environment's ownership and mode; do not print its secret.

## Public-IP alternative when DNS access is unavailable

An existing public IP can provide the same TLS/443 route without another DNS
record. This requires an ACME client supporting IP certificates and the
`shortlived` profile. [Let's Encrypt issues trusted IP certificates lasting
160 hours](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/);
automatic renewal and reachable HTTP-01 on port 80 are essential. The existing
Caddy 2.11.7 deployment supports this profile.

First confirm that HTTPS by IP and TLS without SNI do not already serve another
application. Install this explicit public certificate host, validate and reload,
then verify a normally trusted TLS handshake to the IP before adding routing:

```caddyfile
https://62.238.98.53 {
    tls {
        issuer acme {
            profile shortlived
            disable_tlsalpn_challenge
        }
    }
    respond 404
    log {
        output discard
    }
}
```

Add this route inside the existing `layer4` listener wrapper. An IP URL's TLS
connection usually omits SNI, so the route matches either empty SNI or this
literal IP. Its connection policy selects the IP certificate. Named HTTPS and
RTMPS routes retain their existing handling:

```caddyfile
@kithmoot_turn_ip tls sni_regexp ^(62[.]238[.]98[.]53)?$
route @kithmoot_turn_ip {
    tls {
        connection_policy {
            default_sni 62.238.98.53
        }
    }
    proxy 62.238.98.53:3478
}
```

Validate and reload the complete current configuration again. Verify the IP
certificate and a real coturn STUN response through this route, and check named
HTTPS and RTMPS handshakes. Qualify the browser route before advertising it.
Use `turns:62.238.98.53:443` in the optional browser list below instead of the
dedicated hostname. No certificate-verification bypass is needed. Once routed,
HTTPS requests by IP reach TURN; normal websites continue to use their names.

Also verify that the existing coturn container returns after a crash or host
reboot. The running `kithmoot-coturn` container had restart policy `no`; it now
uses `unless-stopped`, which preserves an operator's deliberate stop. Updating
this policy does not restart a running container. Its previous policy can be
restored with `docker update --restart=no kithmoot-coturn`. The port-443 route
still depends on this same coturn process; it is not a second relay backend.

For the existing TLS/5349 listener, keep `kithmoot-turn-certs.timer` enabled.
It copies Caddy's renewed hostname certificate into coturn's readable mount;
coturn reads those files only at startup. Before a catch-up run, back up both
certificate and key with their ownership and permissions. The existing sync
service restarts coturn if the files changed, so do that between call checks
and verify a call afterwards. The timer's daily quiet-hour schedule avoids
restarting calls unnecessarily. TLS/443 uses Caddy's certificate directly and
does not need this copy step.

## Preserve released native clients

Android 0.6.132 pins the existing hostname and ports and rejects an entire
credential containing an unfamiliar address. **Leave `TURN_URLS` unchanged.**
Updated web clients request `X-KithMoot-Turn-Urls: extended-v1` from their own
same-origin `/turn`. The updated credential service uses `TURN_WEB_URLS` only
for that explicit capability. Old clients, unknown capabilities and operators
without `TURN_WEB_URLS` retain the existing response. Independent issuers receive
the existing request by default.

After the selected address and certificate work, set the credential service's
optional `TURN_WEB_URLS` to the full browser list:

```text
turn:kithmoot.forgesworn.dev:3478,turn:kithmoot.forgesworn.dev:3478?transport=tcp,turns:kithmoot.forgesworn.dev:5349,turns:call-relay.kithmoot.forgesworn.dev:443
```

Deploy the matching `server/turn-credentials.mjs`, then restart only
`turn-credentials.service`. The secret, TTL, allowed origins, rate limits and
coturn remain as configured. Check both legacy and extended responses without
recording credentials. Only the extended response may contain the new address.

## Acceptance and rollback

The [2 November browser receipt](../docs/evidence/browser-turn443-20261102.json)
records five-minute calls through the IP route, including Android Chrome and
a repeat after certificate sync restarted coturn. It distinguishes emulator
and forced-route evidence from physical devices and actual VPNs.

Run a five-minute call through **only** the port-443 TLS URL:

```sh
TURN_E2E_BASE_URL=https://kithmoot.forgesworn.dev/j/ \
TURN_E2E_TRANSPORT=tcp-tls TURN_E2E_TLS_PORT=443 npm run test:turn
```

Add `TURN_E2E_ANDROID_SERIAL=<owned-device-serial>` to use Android Chrome for
the second endpoint. Check 30 advancing audio/video samples in both directions,
playing audio sinks, relay candidate pairs, TLS transport and the selected
candidate's TURN URL port. The test keeps this constraint on credential refresh
as well as the initial connection. Emulator evidence remains separate from a
physical device, VPN or mobile-data transition.

To undo: remove `TURN_WEB_URLS` and restart the credential service first. Once
clients have returned to the legacy URLs, remove the dedicated Caddy route and
certificate host, validate and reload. Leave working UDP/5349 listeners,
firewall rules and `TURN_URLS` intact. Retain the timestamped backups until
the operator has accepted the change.
