# Reserved service admission, version 1

M2 defines and verifies these shapes; it publishes no passes/policies and enables
no enforcement. No existing room, forwarder, TURN minter, Blossom store or
nudger changes its admission rules because this module exists.

## Scope and key separation

An audience is `{type,id}`. Types are `forwarder`, `turn`, `blossom`, `nudger`.
A forwarder's ID is its lower-case 32-byte public key in hex. TURN and Blossom
IDs are canonical HTTPS origins without a trailing slash, userinfo, query or
fragment. A nudger ID is its canonical HTTPS endpoint including its path, with
no userinfo/query/fragment. The `type` is part of the cryptographic scope.
Hostnames use lower-case ASCII DNS labels (international names use A-labels),
IPv4 uses four decimal octets and IPv6 uses compressed lower-case hexadecimal.
Default port 443, empty ports, zero-padded ports, dot path segments (including
percent-encoded dots), invalid percent escapes and empty query/fragment markers
are not canonical. Endpoint paths retain repeated slashes and valid percent
escapes. The `serviceAudience` vectors bind both independent URL readers.

Given a 32-byte root secret, a lower-case room ID and a canonical audience,
derive a scoped authority/device key with HKDF-SHA256, empty salt, 32-byte output.
The info is compact UTF-8 JSON:

`["kithmoot.service.v1",role,roomId,audience.type,audience.id,counter]`

`role` is `authority` or `device`. Start `counter` at 0 and use the first output
that is a valid nonzero secp256k1 secret scalar, trying at most 256 values.
Authority roots belong to the authority, never to all traffic-key holders.
Device roots belong to the presenting device. A pass contains no root key or
certificate chain linking its signer to another audience. A forwarder is the
explicit exception: the presenting key is the existing room device key because
the forwarder is already a signalling peer; do not derive a replacement.

For TURN/Blossom, derive the room pseudonym from the shared initial traffic
secret, HKDF-SHA256, empty salt, info
`["kithmoot.service.v1","room",roomId,audience.type,audience.id]`, 32 bytes as
lower-case hex. Forwarders use the actual room ID to bind signals, and nudgers
use it to watch room events. These exceptions reveal the room selector to those
services. Other services see independent scope keys and pseudonyms; timing and
traffic correlation remain possible.

## Member pass: kind 20470

Signed by the per-room, per-audience authority key. Content is compact JSON in
this field order for reproduction:

```json
{"v":1,"audience":{"type":"blossom","id":"https://files.example"},"room":"<64-hex pseudonym>","device":"<64-hex scoped device pubkey>","epoch":2,"expiresAt":1800000060,"permissions":["upload"]}
```

Tags: exactly one each of `d` = room pseudonym, `p` = scoped device key and
`expiration` = expiry as decimal seconds. All three agree with content. Allowed
permissions are `relay`, `credentials`, `upload`, `notify`; writers sort them,
readers reject duplicates and unknown permissions. One to four permissions.
Kind 20470 is ephemeral: it is a presentation, never persistent policy storage.
Do not broadcast it automatically or expose a bearer room link in it.

## Service policy: kind 30460

Signed by the same per-audience authority. Content:

```json
{"v":1,"audience":{"type":"blossom","id":"https://files.example"},"room":"<64-hex pseudonym>","enforcementEpoch":2,"activateAt":1800000010,"graceEnd":1800000030}
```

Exactly one `d` tag agrees with `room`. This is addressable by kind, author and
`d`, so a service can recover the policy after restarting. `graceEnd >= activateAt`.
30461–30469 remain reserved without payload semantics. Do not treat an arbitrary
regular or ephemeral event as a replacement for this policy.

Both codecs verify signatures, project named fields, require integral
non-negative safe timestamps/epochs, and bound content at 4,096 characters and
event tags at eight. A pass expiry must be later than its issue time. Unknown
content fields grant nothing; malformed required fields fail. A successful
`decode` means a valid signed shape, not current permission to use a service.

## Future consumer checks, deliberately inactive

A scoped service trusts its configured per-audience authority. An open service
uses the root of the signed policy as its scope and quotas that room; it never
requires an operator-maintained guest list. At enforcement, a consumer must:

1. Verify the trusted authority signature and exact audience/room binding.
2. Resolve the authoritative addressable policy, retain anti-rollback state and
   apply its explicit activation/grace times. A first pass must never turn on
   enforcement. Missing/conflicting policy must not cause an unannounced switch.
3. Require the pass epoch at or above the enforcement epoch after the grace end.
4. Require `now < expiresAt` and a request authenticated by the named device.
5. Check the requested operation against permissions. Request authentication must
   bind the exact operation/resource/body, audience and freshness; replay handling
   belongs to the service's request protocol and is not supplied by the pass.
6. Apply per-room quotas alongside existing IP/global resource limits.

No pass means the available fallback: mesh rather than forwarder, STUN rather
than TURN, no push rather than inability to enter a room. M2 never installs a
policy, changes the live minter or blocks uploads. Each consumer's milestone must
supply old/new compatibility tests before enforcement is enabled.

The authority may issue passes at admission and reissue on epoch changes. When
it is offline, a missing pass waits for its next availability while fallback
continues. No member delegation chain is defined in M2. Future delegation must
retain per-room/per-service separation, with no cryptographic parent link in
presentations. The `serviceScope`, `memberPass` and `servicePolicy` vectors pin
these derivations and decoders in TypeScript and Kotlin.
