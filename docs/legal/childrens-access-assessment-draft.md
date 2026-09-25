# Children's access assessment

> **DRAFT for legal review, 25 September 2026.** Drafted from the code on
> `main` for the owner to check and sign. It is not legal advice and it has
> not been reviewed by a lawyer. Evidence marked `[INPUT]` is needed before
> signing.
>
> **Conclusion: we cannot show that children do not or will not access the
> service.** There is no age check anywhere in the code. Whether the child
> user condition is actually *met* depends on evidence this record does not
> have (section, Stage 2) and on decisions the owner has not yet made. This
> is honestly unresolved, not resolved in either direction.

## Sources

- Ofcom, *Children's Access Assessments Guidance* (24 April 2025).
  <https://www.ofcom.org.uk/siteassets/resources/documents/consultations/category-1-10-weeks/statement-age-assurance-and-childrens-access/childrens-access-assessments-guidance.pdf>
- Ofcom, *Quick guide to children's access assessments*.
  <https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/quick-guide-to-childrens-access-assessments>
- Ofcom, *Children's Risk Assessment Guidance and Children's Risk Profiles*
  (24 April 2025).
  <https://www.ofcom.org.uk/siteassets/resources/documents/consultations/category-1-10-weeks/statement-protecting-children-from-harms-online/main-document/childrens-risk-assessment-guidance-and-childrens-risk-profiles.pdf>
- Online Safety Act 2023, sections 35 to 37 (children's access assessments)
  and sections 11 and 12 (children's risk assessment and safety duties).

## Record details

| Item | Entry |
| --- | --- |
| Service | KithMoot, at `kithmoot.forgesworn.dev` and its clients |
| Provider | ForgeSworn |
| Date completed | `[date signed]` (draft of 25 September 2026) |
| Completed by | Drafted from the code by an AI assistant; checked by `[name]` |
| Named person responsible | `[the role named in the illegal content risk assessment]` |
| Approved by | `[Operator]` |
| Next review | At least once a year, and before any change to how a room is created or joined |

## Part A: the assessment

### Stage 1: is it possible for children to access the service?

Ofcom's test: a provider can only conclude that children cannot access the
service if it uses highly effective age assurance, with access controls,
so that children are not normally able to get in.

**What the service does today:**

- **There is no age check of any kind**: no age question, no age
  estimation, no age verification, anywhere in the web app, the desktop
  app or the Android app.
  <!-- No age field, age gate or age-assurance integration found in app/src, server/ or deploy/. -->
- **Joining a room needs only its link.** A room's capability lives in the
  URL fragment after `#`, which is never sent to a server, so there is no
  server-side membership check that could carry an age condition even in
  principle.
  <!-- docs/protocol.md, "Room links and admission" -->
- **Signing in with a Nostr key is optional.** A Nostr key says nothing
  about the age of the person who holds it, and most joins do not use one
  at all.
- Anyone who receives a room link, by any means (a message, a QR code, a
  forwarded chat), can open it. Nothing about the flow assumes or requires
  the recipient to be an adult.

**Answer: yes, it is possible for children to access the service.**

### Stage 2: is the child user condition met?

The condition is met if the service, or a part of it, has a significant
number of child users, or is of a kind likely to attract a significant
number of children. Ofcom's guidance says "significant" can mean a
relatively small number, that providers should base the first limb on
evidence of who actually uses the service rather than who it is meant for,
that a user need not have an account to count, and that providers should
err on the side of caution.

**(a) Does it have a significant number of child users?**

`[INPUT: the operator holds no age data and, as a small, mostly technical
and early-stage audience distributed by direct invitation, has no basis
today to say either way. This is a genuine gap, not a rhetorical one: state
plainly to the owner that "we don't know" is not the same as "no".]`

**(b) Is it of a kind likely to attract a significant number of children?**

Ofcom's factors, applied honestly to what KithMoot actually is (a
general-purpose encrypted group chat and calling tool, distributed by
invitation link, positioned as a Slack alternative for teams, families and
project groups):

| Factor | Finding |
| --- | --- |
| Benefits to children | Possible. A family or a school project group is exactly the "small community that would rather not put its conversation on somebody else's platform" use case the product markets itself on (`site/index.html`: "A family. A community group.") |
| Content that appeals to children | Neutral to low. No music, games, video or content library of any kind; it is a blank chat tool, not a content service |
| Design that appeals to children | Neutral. No games, rewards, streaks or engagement mechanics of any kind |
| Children in the commercial strategy | No. There is no commercial strategy identified, and no marketing aimed at children |
| Distribution mechanism | **Invitation-only, not a public discovery surface.** This is the most material difference from a typical U2U service Ofcom's guidance is written against: there is no public sign-up page, no app-store listing a child could find unprompted (the Android build is a direct APK download, not a Play Store listing), and no way to arrive at a room without someone already in it sending a link |

**Answer: unresolved, and the honest position is "we cannot show the
condition is not met."** The product's own marketing names families and
community groups as an intended use ("A family. A community group." —
`site/index.html`), which on its own is enough that a family could include
under-18s in a room a parent or older sibling set up. What differs from a
typical case is that KithMoot has no public discovery surface at all: a
child cannot stumble into it the way they could a social app or a game.
Ofcom's guidance still asks for evidence to conclude the condition is *not*
met, which this record does not have, so caution points toward treating it
as met, or at minimum toward closing the gap in section, "Still to do",
before relying on any other conclusion.

### Conclusion

**The service is likely to be accessed by children, on the current
evidence, and no minimum age or other product decision has been made to
change that.**

This differs from a service that has decided on and stated a minimum age
(as some comparable services have): KithMoot's terms draft
(`docs/legal/terms-draft.md`) does not yet set one, because the owner has
not made that decision. Until it does, there is no rule for an age check
to enforce even if one were built, so "no age check" here means something
slightly different from a service that has a stated age policy it merely
fails to enforce: KithMoot has neither the policy nor the enforcement.

This means, as required work:

1. a **children's risk assessment** (part B);
2. the **children's safety duties**, using the measures in Ofcom's
   Protection of Children Codes, or other effective measures, once the
   product decisions below are made;
3. **terms** that say, honestly, what protects children today (very
   little, beyond the absence of any content-discovery surface) and what
   the operator's position is.

Highly effective age assurance was not built and, on the evidence
available, does not look proportionate for a small, invitation-distributed
tool with no content library — but that is a judgement call for the owner
to make explicitly, not a default this record should assume.

## Part B: outline of the children's risk assessment

An outline of required work, to be completed and signed. It follows
Ofcom's four steps.

### B1. Content to assess

Ofcom's primary priority and priority content kinds apply in principle, but
KithMoot carries no content the operator can see (section 2.1 of the
illegal content risk assessment), so this assessment is necessarily about
**what a room's own design permits**, not about content the operator could
review and rate.

### B2. Where each could appear here

| Surface | Kinds most relevant | Notes |
| --- | --- | --- |
| Direct messaging (a room of two) | Grooming; bullying; self-harm encouragement | Private, encrypted, no operator visibility |
| Group rooms | Bullying; hate; abuse | Same |
| Calls (audio/video) | Any of the above, live | No recording by the service; a keeper-run room may record separately (out of scope here) |
| File sharing (opt-in) | Cannot itself carry viewable media through the default store (illegal content risk assessment, 2.3) | The exchange risk, if any, is anonymous bulk storage, not on-service viewing |
| Agents in a room | Content an agent might generate or relay | `docs/agents.md` governs agent consent and scope; not separately assessed here |

### B3. Age groups

Unknown. `[INPUT]` Without any age signal at all, this record cannot even
provisionally split by age band the way a service with partial age data
could.

### B4. Measures to consider

- a named role accountable for the children's safety duties (shared with
  ICU A2 in the illegal content risk assessment);
- report and complaint routes that a child (or a concerned adult on a
  child's behalf) can find and use without an account — the `/report/`
  page (this PR);
- a decision on whether KithMoot states a minimum age at all, and if so
  what it is, and what follows from someone breaking that rule (there is
  no persistent account to remove in most cases, only a room to leave or a
  link to revoke);
- terms that say plainly what a parent or guardian should know before
  letting a child use the product for a family or group chat.

### B5. Provisional risk levels

Not assigned. Assigning a level without any usage or age evidence would be
guessing, not assessing, and this record does not overclaim in either
direction.

## Still to do

1. Decide, and record, whether KithMoot states a minimum age.
2. Complete and sign part B once the decision above is made, since several
   of its questions depend on it.
3. Gather whatever usage evidence the operator can reasonably get (even
   informal: how the product is actually being used today, by whom) to
   replace the `[INPUT]` markers in Stage 2.
