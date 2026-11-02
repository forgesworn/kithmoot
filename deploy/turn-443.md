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

## Preserve released native clients

Android 0.6.132 pins the existing hostname and ports and rejects an entire
credential containing an unfamiliar address. **Leave `TURN_URLS` unchanged.**
Updated web clients request `X-KithMoot-Turn-Urls: extended-v1` from their own
same-origin `/turn`. The updated credential service uses `TURN_WEB_URLS` only
for that explicit capability. Old clients, unknown capabilities and operators
without `TURN_WEB_URLS` retain the existing response. Independent issuers receive
the existing request by default.

After the hostname and certificate work, set the credential service's optional
`TURN_WEB_URLS` to the full browser list:

```text
turn:kithmoot.forgesworn.dev:3478,turn:kithmoot.forgesworn.dev:3478?transport=tcp,turns:kithmoot.forgesworn.dev:5349,turns:call-relay.kithmoot.forgesworn.dev:443
```

Deploy the matching `server/turn-credentials.mjs`, then restart only
`turn-credentials.service`. The secret, TTL, allowed origins, rate limits and
coturn remain as configured. Check both legacy and extended responses without
recording credentials. Only the extended response may contain the new address.

## Acceptance and rollback

Run a five-minute call through **only** the port-443 TLS URL:

```sh
TURN_E2E_BASE_URL=https://kithmoot.forgesworn.dev/j/ \
TURN_E2E_TRANSPORT=tcp-tls TURN_E2E_TLS_PORT=443 npm run test:turn
```

Add `TURN_E2E_ANDROID_SERIAL=<owned-device-serial>` to use Android Chrome for
the second endpoint. Check 30 advancing audio/video samples in both directions,
playing audio sinks, relay candidate pairs and TLS transport. Emulator evidence
remains separate from a physical device, VPN or mobile-data transition.

To undo: remove `TURN_WEB_URLS` and restart the credential service first. Once
clients have returned to the legacy URLs, remove the dedicated Caddy route and
certificate host, validate and reload. Leave working UDP/5349 listeners,
firewall rules and `TURN_URLS` intact. Retain the timestamped backups until
the operator has accepted the change.
