# Independent review: browser account and vault flows

Reviewed on 9 October 2026 by the available independent reviewer agent,
authorised by the owner in place of the ticket's Opus/Astra requirement.
Reviewed source: `2c21778f3c2ab5cdf1d084c300c15755d51809df`, against
`43f4e8468e57d8ad1055c3035513a6f66ca2a58b`.

**Verdict: no remaining blocking findings for merging this
production-disabled account/vault UI slice.** This is not approval to enable
production MLS, a human cryptographic audit, or MLS room acceptance.

The first pass found two issues in the new account wrapper:

1. `approveScope` retained caller-owned input across an awaited consent prompt.
   A caller could change the scope after it had been displayed. The wrapper
   now copies it synchronously before its first await and uses that snapshot
   for validation, the prompt and the witnessed approval. A regression changes
   the original box identifier during consent and verifies only the displayed
   identifier is approved.
2. A successful typed operation could be followed by an enrolment reread that
   discovered a storage fence, while the wrapper still returned success. The
   wrapper now invalidates vault authority and refuses prior success for every
   non-genesis final state, with a specific restore-fenced refusal. Overview
   results receive the same treatment; signatures undergo provenance and expiry
   acceptance after the wrapper's final await. A regression removes the inner
   key after a signature is produced and verifies no header is released.

The follow-up review inspected account/room/mode lifetime binding, exact-device
replacement, explicit migration, credential-specific revocation, consent
withdrawal and the regression hooks. It also checked that the Vite development
middleware serves only the exact four pinned runtime files, with no arbitrary
path or production runtime hook. Asset pin and diff checks passed.

The reviewer did not independently rerun heavy suites. Automated and real-Bothy
results belong to the release validation record and are separate from this
source review. Room-store/box-client integration, Android/browser composition,
physical devices and production enablement remain open.

## Live shutdown finding and scoped merge judgement

The full-app real-Bothy journey passed, but a longer repeated typed-signing
journey timed out during Link shutdown. Instrumentation showed signed reads in
7–10 ms and advances in 2–3 ms, followed by a close of 48.751 seconds; a later
close did not finish before the diagnostic was stopped. The writer lock stays
held and success stays withheld. This is an availability failure, with no
observed fail-open release.

The reviewer confirmed that this may remain a production liveness gate while
merging the disabled app slice. The repeated journey is **not accepted live
coverage**. It remains reproducible with `LAB_SHUTDOWN_STRESS=1`; transport
shutdown repair and a successful rerun are required before production enablement
or a claim of complete typed live acceptance.

Do not remove `wait_idle` as a workaround. In the pinned Link source, relay
close signals driver shutdown but does not await it; WebSocket destruction
requests closure without awaiting its close event, and sends can remain queued
until the driver drops its receiver. The reviewer found no alternative exposed
safe shutdown API. A future completion barrier must prove driver/transport
termination before ownership is released. No Link library or pinned runtime
change was made in this slice.
