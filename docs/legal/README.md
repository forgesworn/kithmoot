# Legal cover: index

Drafts prepared for UK Online Safety Act and UK GDPR cover for KithMoot.
None of these are in force. **All of them are drafts an AI assistant wrote
from the code, for a human owner to check, complete and sign.** None has
been reviewed by a lawyer. Last revised 28 September 2026: the claim that
the operator cannot read any room is narrowed to rooms it does not keep,
deadlines are dated, and agents and payments are described.

The law itself is written up, with its sources and evidence marks, in
[the online services law note](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md).
These documents hold only this project's facts and decisions.

- [`online-safety-risk-assessment-draft.md`](online-safety-risk-assessment-draft.md)
  — the illegal content risk assessment, covering rooms, calls, the
  default file store, the default drop tier, the relay the operator
  also runs (no longer a default) and any keeper the operator runs.
- [`childrens-access-assessment-draft.md`](childrens-access-assessment-draft.md)
  — whether children can and do access KithMoot. Honest answer: they can,
  and we do not have evidence either way on whether they do.
- [`terms-draft.md`](terms-draft.md) — terms of use.
- [`privacy-notice-draft.md`](privacy-notice-draft.md) — privacy notice.
- [`report-handling.md`](report-handling.md) — the operator runbook for
  acting on a report, surface by surface, including what is and is not
  technically possible today.

## Before any of this is true

1. **Decide who the operator is in law.** These documents name a project,
   ForgeSworn, and a project name that is not a registered legal person
   cannot be the provider or the controller. The law note sets out what
   each regime needs and what the alternatives are
   ([section 9](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md)).
   `[DECISION: who the provider and controller are in law.]`
2. **Carry out and record the two assessments by their deadline.** A new
   service has three months from launch for the illegal content risk
   assessment and the children's access assessment (law note, section
   2.4). Counted from the first deploy commit, 24 August 2026, that is
   **24 November 2026**. `[INPUT: the launch date, if not 24 August 2026.]`
   The records are kept, not sent to Ofcom unless it asks (law note,
   section 2.3, marked `[U]` there).
3. **Say which rooms the operator keeps.** A keeper holds its room's key,
   so a room kept on a keeper the operator runs is one the operator can
   read. `[INPUT: whether the operator keeps rooms that other people use.]`
4. **Keep payments off, or apply the trading rules.** Nothing in the
   default service takes payment. Switching on any payment, including the
   paid TURN kit in `deploy/l402/` or the donor ring, brings the trading
   rules of the law note's section 8 into play.
   `[INPUT: whether either is switched on anywhere.]`
5. **Watch the `abuse@safety.forgesworn.dev` inbox.** Every one of these
   documents refers to it. It exists (Cloudflare Email Routing, forwarding
   to the owner's inbox, set up 25 September 2026); send it a test message
   and make sure reports are read.
6. **Read and adopt the assessments and drafts**, or send them for legal
   review first. They are written honestly, including the gaps, but an AI
   assistant drafting them is not the same as an owner deciding to stand
   behind them.
7. **Name the person accountable** for the Online Safety Act's illegal
   content and reporting duties (referred to throughout as a role, e.g.
   "the maintainer on call", never a name) — both documents that need this
   (the risk assessment and the report-handling runbook) currently leave
   it as `[DECISION]`.
8. **Decide whether KithMoot states a minimum age**, which the terms and
   the children's access assessment both currently leave open rather than
   assume.
9. **Publish the linked pages** (`site/terms/`, `site/privacy/`,
   `site/report/`, this PR) and keep them in sync with these source
   documents as the product changes.
