# Calling: no publisher control and no call logging

Owner decision, 23 October 2026: **"we want zero control, zero logging!"**

This is the required design for the proposed calling transport. It is not a
claim that released clients, the FIPS experiment or existing hosting already
meet it. No deployment or deletion of existing records is made by this note.

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
| No publisher runtime dependency | Create, join, call and reconnect using independent infrastructure while blocking publisher endpoints, including discovery, issuer, gateway and update/config hosts | Not tested |
| Participant-only room authority | Trace invitation, admission, revocation and keys through web, Android and any gateway; test membership refusal without publisher participation | Not tested by the synthetic fixture |
| No hidden central authority | Review deployed configuration, administrator credentials, remote configuration and software-update prerequisites | Not established |
| No persistent/exported call logs | Exercise successful, refused, failed and interrupted calls; inspect storage and network outputs across dependency, OS, container and provider paths | Not established |
| Bounded transient state | Verify expiry/cleanup after disconnect, crash and restart without restoring call history | Not established |
| Enforced endpoint-only behaviour | Refuse third-party forwarding while preserving legitimate endpoint calls | FIPS leaf-only counterexample reproduced |
| Simple independent connectivity | Two separate networks, ordinary browser guests and physical GrapheneOS without Play; four real participants after two-device acceptance | Local synthetic helper-assisted media proof only |

The [FIPS fixture](../../test/fips-call/README.md) writes temporary daemon
diagnostics for synthetic runs and deletes them at teardown. It is not a
zero-logging product implementation. Its retained JSON evidence describes
synthetic test outcomes and is not a record of users' calls.

A previous read-only host assessment on 23 October found HTTP redirect
records in the system journal/syslog and firewall records mentioning private
relay ports. CDN/provider and backup retention were not fully audited.
These are dated findings, not a fresh live readback or proof of call logging.
Production zero-logging cannot be claimed from the coturn log settings alone.

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
