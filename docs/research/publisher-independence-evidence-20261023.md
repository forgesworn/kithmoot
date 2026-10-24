# Protected sharing and local publisher independence: 23 October 2026

**Result:** a production web build completes a real room journey in two fresh
browser contexts when all external HTTP and WebSocket access is denied. The
contexts create/share/join a room, exchange chat, receive two-way video and
audio, publish/decode a protected share, reload/rejoin and communicate again.
This is a self-contained local runtime result with publisher endpoints
unavailable and an explicitly supplied fixture relay. It is not a proof of
independent Internet connectivity, operator independence or OSA exemption.

## Implementation

- `app/src/browser-share.ts`: browser-only **Share an area** and **Share with
  redaction**, exposed through the call's More menu. The browser picker chooses
  a window or tab; the local preview supplies crop and mask controls.
  No desktop bridge or native helper is used by this path.
- `app/src/browser-share-plan.ts`: source-relative rectangles, outward mask
  padding, crop intersection and whole-share cover for invalid or changed
  geometry. Masks cover fixed regions, not moving secrets or semantic content.
- Only the protected canvas track reaches the caller. Manual frame requests
  follow drawing and opaque masking. Raw video remains local. Hidden shares
  silence their shared audio; visual masks do not redact sound.
- Visible previews are also composited; the raw video element is kept out of
  the document. Monitor/unknown-source captures and a source labelled as the
  sharing-controls window are refused before publication. A monitor can capture
  its own preview and reproduce content outside masks, so browser monitor
  redaction remains gated pending real capture qualification. Picker hints
  alone do not enforce that gate. Desktop whole-screen redaction remains the
  existing separate path.
- Live edits cover the whole share until Show my share is pressed. Source
  size/observable identity changes require explicit confirmation. Source
  closure, cancel, leave and compositor failure stop capture. Late picker
  results after cancellation have all tracks stopped.
- `CallTimeline` discards entries by default without reading the clock.
  The application enables it only in explicit synthetic diagnostic builds.
  Call-declared/ring console output was removed. Ordinary builds expose no
  diagnostic hook, and `collectDiagnostics` returns an empty object there.
  This closes those specific paths, not every logging path in the product.

The ordinary browser Share button retains its existing capture path. This
increment adds an explicit protected path; it does not claim automatic
redaction for all shares. Existing desktop capture is preserved. Android
share protection has not been implemented in this work.

## Reproduce and evidence

After installing the locked dependencies and Playwright Chromium:

```sh
npm run typecheck
npx vitest run app/src/browser-share-plan.test.ts app/src/redaction-geometry.test.ts app/src/redaction.test.ts app/src/share-area-geometry.test.ts app/src/call-timeline.test.ts
npm run test:publisher
```

`playwright.publisher.config.ts` builds static assets without TURN issuer or
meeting-code endpoints, starts an isolated local Nostr relay and stops both
test services on completion. `.github/workflows/ci.yml` contains a separate
job for this gate; it has not run on hosted CI for these local changes.

Recorded validation: **69 focused unit tests, five Chromium browser cases,
type checking and production build passed locally**. The production build's
existing no-telemetry-marker check passed as part of the browser run. No full
unit suite, other browser suite, Android build or hosted CI is claimed.

The [structured evidence](../evidence/publisher-independence-20261023/result.json)
records the tested source hashes, environment, case results and limitations.
The local run reused the existing checkout's dependency installation; it
was not a new `npm ci` qualification.

The compositor case checks the protected sender canvas identity and scans
each observed remotely decoded synthetic frame for the red secret marker.
It verifies permitted green content, mask/crop operation, live editing cover,
hide/resume, shared-audio state and source-resize confirmation. Separate
cases test late picker cancellation, source closure and drawing failure.
The full room journey additionally samples the actual remote share's pixels.
These fixtures use generated video/audio only, never a real screen or camera.

The initial journey completed but its stricter final assertion failed:
profile discovery attempted `purplepag.es`, `relay.damus.io` and
`relay.primal.net`. All attempts were denied. The final test records the
denied origins explicitly and rejects unexpected external destinations; it
does not turn a successful block into a claim of no attempts. A revised crop
test was also interrupted after it inadvertently toggled its crop controls
off; that test driver was corrected before the final passing run.

## What this says about the legal position

Intended position: software publisher without operating or controlling the
underlying communications service. Current evidence: a **local model** of
that runtime boundary. There was no fresh production deployment/host audit,
and local fixture operators are not evidence of legally independent parties.

The legal-cover notes are `jurisdiction-kit` revision `9243203`, verified
28 September 2026 with relevant updates on 23 October. The primary text is
recorded as `[P]`; its application to this architecture remains `[U]`.
Two bounded independent AI reviews of the requirements and this increment
support the factual distinction, not a guaranteed legal conclusion.

The statutory question concerns actual control of use of the underlying
user-to-user service; access facilities are treated separately in
[OSA section 226](https://www.legislation.gov.uk/ukpga/2023/50/section/226).
Encryption, private rooms and disabling logs are not standalone exemptions.
The strongest counterargument is an integrated communications service still
operated through mandatory defaults, credentials, contractors or gateways.
Infrastructure can also remain subject to
[section 100](https://www.legislation.gov.uk/ukpga/2023/50/section/100) and
[section 146](https://www.legislation.gov.uk/ukpga/2023/50/section/146).

Remaining evidence gates, in order:

1. **Real independent connectivity and usable defaults.** Ordinary browser
   guests across separate NATs, mobile networks and blocked UDP; legitimately
   available independent infrastructure; provider failure/replacement without
   publisher permission. The test injects a local relay, so it does not prove
   download-and-call onboarding or the availability of suitable public TURN.
2. **Actual participant authority.** Trace room invitations, admission,
   refusal, removal, keys and subsequent access. Review deployments and
   credentials for retained publisher authority, including indirect control.
   The two-context journey is not that audit.
3. **Complete logging boundary.** Review error paths, dependencies, native
   stacks, storage/export, proxies, journals, firewall, CDN/provider and
   backups. Optional profile queries can reveal metadata. This browser block
   test is not a process/host network or logging audit. Deliberately saved
   user rooms/messages remain separate from operator call records.
4. **Endpoint-only transport.** The original FIPS `leaf_only` counterexample
   remains a blocker to claiming enforced no-transit behaviour. No FIPS,
   RelaySwarm or Sapflow transport was integrated by this increment.
5. **Platform and protection acceptance.** Real screen/window/area pickers,
   multiple displays/scales, minimisation, backgrounding and recording/export
   sinks; other browsers; physical GrapheneOS without Play. Synthetic Chromium
   checks do not establish these properties.

Passing these gates would strengthen the factual publisher position. Statutory
application remains a reasoned assessment of the actual offering and roles,
not a result a browser test can guarantee. Separate privacy, communications
and infrastructure obligations are not decided by this result.

Nothing was deployed or published. No credentials or production logs were
changed, and the existing private call relay was left untouched.
