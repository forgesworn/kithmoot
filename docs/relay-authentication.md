# Choosing an identity for a relay

Relay settings offer **Use signed-in account** for an applied relay. The
confirmation names the exact relay URL and the account's npub. Permission
applies to the selected room, or to the default account-sync connections.
It lasts in this tab; it is not saved or put into an invitation. Defaults,
contact cards and a **Box of my circle** mark never grant this permission.

The relay learns the chosen public identity. Ordinary room encryption still
applies, but authentication changes what the relay can associate with that
connection. Choose this only for a relay you intend to identify yourself to.

**Stop identifying** closes that connection and leaves it disconnected.
Sign-out and account replacement withdraw all permissions. Reconnecting
does not undo a withdrawal; approving the identity again does. Removing a
relay also forgets its permission, including when a room inherits defaults.

The client waits for the relay's NIP-42 challenge, asks the chosen signer
for a kind-22242 event, verifies the returned signature and exact statement,
and waits for the relay's positive acknowledgement before sending room
filters or events. Refusal and timeout stop automatic authentication retries;
the relay settings show the failure and offer an explicit retry. A delayed
signer response cannot restore a withdrawn connection.

## Library use

```ts
import { NostrRelayPool } from 'kithmoot'

// identity is a ParticipantIdentity the caller has explicitly approved
// for this exact endpoint. Do not derive this permission from an invitation.
const url = 'wss://keeper.example/events'
const pool = new NostrRelayPool([url], undefined, {
  authentication: [{ url, identity }],
})

// Withdraw permission and keep the endpoint disconnected.
pool.setAuthentication([{ url, identity: null }])
pool.close()
```

`websocketImplementation` is an optional per-pool socket implementation for
Node or a transport owned by the caller. Authentication uses the configured
relay URL; the transport must preserve its meaning. There is no relay-supplied
URL override. The default authentication deadline is 30 seconds, configurable
between 100 milliseconds and 120 seconds.

## Acceptance and remaining integration

Local real-WebSocket tests cover delayed consent, exact-relay isolation,
refusal, timeout, withdrawal, stale signer responses, malicious signer output,
fresh reconnect challenges, history deduplication and unsubscribe. Browser
acceptance uses actual loopback TLS sockets, including mobile-width layout,
cancel, approve, withdraw, reapprove and sign-out. The CI browser matrix runs
the same test in Chromium, Firefox and WebKit.

The relay must issue its authentication challenge when the socket opens.
This client does not discover a private endpoint, implement a Link carrier,
transfer permission between an invitation rendezvous and an admitted room,
or grant membership in a circle. A server's keeper policy decides whether
the selected account is accepted. A complete private-room journey through
the keeper's Link endpoint still needs separate interoperability acceptance.
