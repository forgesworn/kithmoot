# Legal cover: index

ForgeSworn publishes KithMoot's software. Since 1 November 2026 it again
runs a public call relay (TURN) with an anonymous credential issuer, used
by the apps by default. relay.trotters.cc, the Nostr relay ForgeSworn runs
for the project's own work, closed again at 00:33 UTC on 2 November 2026
after the recorded open window of 1-2 November 2026: reads and ordinary
writes need a sign-in with a key on its list, and from anyone else it
accepts only sealed messages and signer requests addressed to those keys,
as recorded in the operator's relay position note. The web app's suggested
relays are third-party only (relay.primal.net, relay.ditto.pub,
offchain.pub); the in-development Android client leads with
relay.trotters.cc, a divergence the owner blessed on 2 November 2026
(docs/decisions.md, decision (a), bounded by three conditions). Its file
store, meeting codes and message-drop service stay closed. A separate
authenticated private call relay is recorded below.

- [`call-transport-position.md`](call-transport-position.md) opens with
  the 2 November 2026 section: the relay closed again, the default-relay
  divergence settled as decision (a), and the position this leaves. Its
  1 November 2026 section records the reopening as written on that date;
  where they disagree, the newer section governs. It then distinguishes
  the current private deployment, the public software and the planned choice
  of independent providers or self-hosting. It records the service and
  infrastructure distinction, the open operator-capacity input, and what is
  not yet implemented. Its section on the built-in call relay (30 October,
  updated 31 October 2026) covers the owner's decision to release it to
  everyone, off by default: what is built and what still gates it, who
  operates it, what the person running it and their guests see and reveal,
  the Hide my IP rule, the approved Turn on notice checked against the code,
  and where the law note leaves the home relay unsettled.

- [`closure-record.md`](closure-record.md) is the current record: what
  ForgeSworn ran for KithMoot users from 24 August 2026, what closed on 21
  and 22 October 2026, the deletion of the stored files and their archive
  copies on 22 and 23 October, the historical assessment timetable, and
  what would bring KithMoot back into scope. Section 7 records the
  reopening on 1 November 2026, which is such a change; section 8 records
  the relay closing again on 2 November 2026 and the default-relay
  decision of that date.

It is a draft for the owner to check. It is not legal advice, and no lawyer
has read it. The law is in jurisdiction-kit's `law/gb/online-services.md`.

## Archive

[`archive/`](archive/) holds the documents written while ForgeSworn ran
default infrastructure for KithMoot. They described the service while it
ran and were never adopted.

- [`online-safety-risk-assessment-draft.md`](archive/online-safety-risk-assessment-draft.md):
  the illegal content risk assessment.
- [`childrens-access-assessment-draft.md`](archive/childrens-access-assessment-draft.md):
  the children's access assessment.
- [`terms-draft.md`](archive/terms-draft.md): terms of use.
- [`privacy-notice-draft.md`](archive/privacy-notice-draft.md): privacy notice.
- [`report-handling.md`](archive/report-handling.md): the operator runbook
  for acting on a report about the surfaces ForgeSworn ran.
