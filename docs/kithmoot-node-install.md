# KithMoot node private Linux installer

This is a private engineering candidate for Debian 12+ or Ubuntu 24.04+ with
systemd, on a rented server or hosted Archy. Whoever deploys it runs it.
Do not run it at home. The node keeps encrypted room traffic and device access
records, and holds no room or keeper signing keys. Disable provider snapshots
and backups where the deployment permits it; deletion cannot erase those copies.

The candidate is not publicly downloadable. A public release still needs
approved signed Spry and Shelter artefacts, corresponding source and complete
licence notices. This workflow does not publish the private Shelter repository.
The existing ForgeSworn public TURN service remains unchanged.

## Build and verify a private candidate

Use Node 24. Supply a protected local input directory containing Linux `node`,
`spry-node`, `bothyd`, `Node-LICENSE.txt`, `Spry-LICENSE.txt`,
`Shelter-LICENSE.txt` and `provenance.json`. The provenance array has exactly
three entries with `name` (`node`, `spry`, `shelter`), exact `revision`,
`visibility` (`public` or `private`) and a provenance description. Use the
merged node-profile versions of Spry and Shelter; arbitrary older builds lack
required access and purge controls.

```
node deploy/node/build-release.mjs --inputs INPUTS --output NEW_OUTPUT --platform linux-arm64
```

`linux-x64` is also a packaging target; only ARM64 has the recorded Linux
execution proof. The builder reads current source, creates no network request
and never uploads binaries. It records the exact files, modes and SHA-256
hashes in `release.json`. Installation verifies the source bundle and its
copied staging directory. This detects damaged or substituted files; an
integrity manifest is not a publisher signature. Verify external archive
provenance before running any downloaded executable with root authority.

## Install

Both `node.example` and `turn.node.example` must resolve to this server's
assigned, publicly routable IPv4 address. This first profile requires that
address on an interface. It refuses private, reserved and carrier NAT ranges.
Selecting `rented` or `archy` is an operator assertion, not ISP detection.

From a verified private bundle, run its `kithmoot-node` executable with sudo:

```
sudo ./kithmoot-node install --name node.example
```

The terminal wizard asks for hosting, interface address, aggregate bytes per
second, storage ceiling, free-space reserve, maximum rooms, allowed KithMoot
sites, firewall management and an existing certificate and protected key.
The certificate must cover both names. A non-interactive installation supplies
those values with `--hosting`, `--relay-ip`, `--bandwidth`, `--storage-bytes`,
`--min-free-bytes`, `--max-rooms`, `--origins`, `--certificate` and
`--certificate-key`, or a version-1 configuration file with `--configuration`.
All resource limits require explicit choices. `--public-ip` is optional.

The firewall plan is TCP 443, TCP/UDP 3478, TCP 5349 and UDP 49160:49191.
`--firewall ufw` adds tagged rules to an already active UFW firewall, preserving
identical existing rules. It never enables UFW or changes SSH rules.
`--firewall external` leaves host and provider firewall changes to the
operator. Provider firewall rules always need operator configuration.

Instead of existing certificate files, `--acme --accept-acme-terms` installs
Certbot and requests a certificate for both names. HTTP validation requires
inbound TCP 80 and that port to be free. ACME terms must be accepted explicitly.
The installer uses a certificate name scoped to this node, creates a deploy
hook that copies only that lineage into the protected TLS directory and
reloads the front and supervisor, and enables the Certbot renewal timer.
Existing ACME lineages are not overwritten. To supply renewed external
certificates, run `certificates --certificate FILE --certificate-key FILE`.
Invalid or mismatched pairs are refused before replacement.

The two systemd services use separate unprivileged users. Only the TLS front
has permission to bind a privileged port. Its sole public listener is 443:
HTTPS/WSS uses the node name and TURN TLS uses `turn.<node-name>`. Spry also
listens on 3478 UDP/TCP and 5349 TLS. Internal HTTP and Unix control endpoints
are not exposed. Services have no request, address, room or pairing logs.

Installation retains ownership and grants under `/var/lib/kithmoot-node`,
root-owned setup under `/etc/kithmoot-node`, and verified immutable releases
under `/opt/kithmoot-node/releases`. The front can read the certificate key but
cannot read supervisor state or its service identity and TURN secret.

## Pair and check

```
sudo /opt/kithmoot-node/current/kithmoot-node doctor
sudo /opt/kithmoot-node/current/kithmoot-node pair
```

Pairing requires a local terminal and prints a one-use link and QR code valid
for six minutes. Open it on the owner's device and approve there. Do not paste
the code into logs, evidence or support messages. Guests use the room's ask
link; they do not enter server names, logins or ports.

Doctor checks local readiness, service identity, both names' DNS, storage,
STUN on all four transports and the relay's authentication challenge. A green
result does not prove outside reachability, TURN allocation or media. The
JSON output lists those remaining checks. The recorded private proof adds
actual authenticated allocation on all four transports, including the real
TLS 443 front, and the complete SDK admission/chat/close journey.

## Update, recovery and removal

Run `sudo ./kithmoot-node update` from a separately verified new bundle.
Updates interrupt calls, retain ownership and durable access and close
operations, and keep the previous release for rollback. A journal is committed
before services stop. A failed update restores the old release and requires
its doctor to pass before reporting recovery. Modified service units are
preserved and require operator review. No automatic update ping is sent.

Run `sudo ./kithmoot-node resume` from a verified bundle after an interrupted
install or update. Initial setup fills only missing secret files and preserves
existing valid identity material; changed configuration, unsafe files or
invalid partial writes fail closed. Recovery never erases existing node data.
A killed update rolls back to the recorded prior release before further
updates. Operator mutations hold an OS lock released on process exit.

Close each hosted room from its keeper's app and wait for signed completion.
Then run:

```
sudo /opt/kithmoot-node/current/kithmoot-node uninstall --delete-everything
```

Removal refuses active rooms, grants or pending close operations. The server
cannot sign a keeper closure or command a device wipe by itself. Removal stops
both services, deletes their state and installed releases, removes their own
users, units, tagged firewall rules and certificate copies, and removes an
installer-managed ACME lineage and deploy hook. It preserves supplied source
certificates, unrelated ACME accounts and certificates, and existing firewall
rules. Do not delete server files as a substitute for closing rooms.

The final empty-node check records a durable deletion intent before teardown.
It serialises against enrolment and refuses new rooms, grants and owner claims,
including after restart. An interrupted removal can be retried. To abandon
removal and use the retained node again, start its service and explicitly run:

```
sudo runuser -u kithmoot-node -- /opt/kithmoot-node/current/kithmoot-node cancel-delete --state /var/lib/kithmoot-node
```

Archy's host controller uses the same local `prepare-delete --state DIRECTORY`
command before destructive removal. These operations use the private local
socket; they are not public HTTP endpoints.

## Evidence and remaining acceptance

[The installer receipt](evidence/kithmoot-node-installer-20261102.json) records
the exact private Linux bundle and checks. The opt-in tests
`test/kithmoot-node-installed.mjs` and
`test/kithmoot-node-install-lifecycle.mjs` run only in the disposable offline
systemd fixture identified by `E2E_NODE_INSTALLED_FIXTURE`. They intentionally
pair, update, close and remove that fixture; never run them against a live node.

Public certificate issuance and renewal, outside firewall reachability,
independent NATs, forced TLS 443 media across clients, capacity and
physical GrapheneOS acceptance remain separate gates. Web and Android UI
candidates are held for the maintainer's reviewed-revision approval. Archy
packaging has its own install, app-gate, port coexistence and UI acceptance.
