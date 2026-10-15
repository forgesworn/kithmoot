# Ordinary client SDK provenance

As of 15 October 2026, this candidate's dependency and lockfile pin the published
`signet-login@0.18.2`. It includes the provider-effect boundary and two-stage
extension discovery used by the unmounted ordinary adapters. Capability and
native custody checks still apply; a package version alone grants no authority.

The [official v0.18.2 release](https://github.com/forgesworn/signet-login/releases/tag/v0.18.2)
uses immutable tag commit `59ab6b027846b17287b63a3650e68f1d60e52cb3`.
Its [release workflow](https://github.com/forgesworn/signet-login/actions/runs/38698394374)
completed all six strict consumer compatibility checks, two builds,
reproducibility verification and publication. The npm archive and all 33 package
files matched the release candidate and GitHub asset. Archive SHA-256:

```
034c016b5c7cc107f5f12334ecca57027f6d1abb22d9c475779cad28cd5bba1a
```

The lockfile selects that registry archive and records its SHA-512 integrity.
Earlier local source checks used recorded development overlays, including an
unpublished 0.18.0 candidate. Those receipts retain their original scope; they
do not become fresh registry or deployed-client acceptance because a later
package was published. Current client CI must validate the exact candidate with
a fresh registry installation separately.

SDK publication does not mount the protected ordinary UI or complete its
consumer release. The [production root guard](ordinary-startup-entry.md) holds
every existing protected database before importing the legacy application.
An absent database permits legacy startup under document-held native leases;
it does not migrate that application's retained secrets. Protected consumer
composition, other login and carrier paths, current MLS admission authority,
independent allocation continuity, deployment and physical acceptance retain
their separate gates. Production MLS remains disabled and DG08 remains open.
