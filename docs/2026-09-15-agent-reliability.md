# Agent requests and reconnect notices — 15 September 2026

## Reproduced code failures and local fixes

- Requests ingested between `AgentRuntime.start()` and a brain attaching were
  marked seen and never delivered to that brain. The runtime now drains a
  bounded startup buffer once to the stdio or model brain. Older relay history
  remains context and is not replayed as new work.
- Built-in model brains did not request the available connection receipt. They
  now acknowledge addressed requests before inference or queueing. Standalone
  runtimes can opt in with `automaticReceipts: true`. External stdio hosts retain
  their explicit acknowledgement after caller acceptance; NanoClaw relies on
  that gate. This is evidence of reception, not acceptance
  of an assignment or completion of work. Explicit acknowledgement remains
  idempotent. Transcript messages and the agent's own messages are excluded.
- Built-in model failures were only logged, and a provider that never finished
  blocked all subsequent turns. Context lookup and inference now have a two-minute
  deadline, abort support, a linked failure/retry response to direct human
  requests, and queue recovery. Empty or `/quiet` answers to a direct human request
  get a visible outcome. Late completions and stopped brains cannot publish.
- The chat now shows waiting, received and disconnected states beside the
  sender's addressed requests. A signed receipt must come from the addressed
  agent in that conversation. A directly linked reply clears the status; an
  unrelated message or ordinary thumbs-up does not. Older drivers that send
  unthreaded replies still need the reader to check the conversation.
- Roster disappearances previously wrote a leave notice immediately, followed
  by an arrival on recovery. Notices now wait thirty seconds before announcing
  departure and cancel if the same participant returns. Live roster, media,
  membership and access decisions still change immediately. Sustained departures
  and new arrivals remain visible.

The release includes these runtime and web changes. They do not prove the cause
of the original 14:17 request or establish that the external agent host has
installed this build.

## Runtime investigation

Read-only checks on 15 September found two persistent room keepers with no
recorded process restarts since 10 September. Their runtime files were dated
9 September. The Docker instances and host processes checked did not contain
the deployed Tally, Chip or Morgs inference host.

The clerk runbook last recorded Tally using NanoClaw on the principal's Mac on
8 September: inference in per-session containers, with a separate host process
for the room connection. That record does not identify the machine, and the
current runtime configuration and logs were not found. Working files in the
clerk and NanoClaw repositories were not changed.

An uptime counter establishes process stability only. It does not establish
relay subscription health, successful routing, model availability or reply
delivery. The pasted leave/join lines establish the browser's changing roster,
not process restarts. The original incident's root cause remains unconfirmed.

To complete live acceptance, locate the deployed agent host and correlate the
request's message ID and timestamp through receipt, routing, inference and
outbound delivery. Check container/process restart counts and relay reconnects
over the same interval. Test with an explicitly authorised room request; do not
replay the original roadmap request automatically, because it may have caused
work elsewhere despite the missing answer.

## Validation

- Unit/integration coverage: startup delivery exactly once; automatic receipts;
  failure and quiet outcomes; hung provider followed by another request; late
  completion and stop cancellation; receipt author/conversation matching;
  reply/retraction handling; brief versus sustained departures; relay recovery.
- Chromium and WebKit: automatic receipt in a named conversation without an
  external acknowledgement driver; visible request status; linked reply clears
  it; Chip and room-wide mentions retain their existing routing/receipt coverage.
- Final Node 24 suite: 137 files, 1,898 tests passed. Type checking and the app build passed.
- Six browser acceptance cases passed across Chromium and WebKit. Receipt and
  disconnected-status screenshots were inspected after the tests.
- Browser reconnect coverage additionally checks immediate roster removal, named
  disconnected status, suppressed brief leave/return pairs, and a sustained
  departure announced once.
- Physical device and deployed agent-host acceptance remain separate checks.

The browser suite saves `agent-request-received.png` and
`agent-request-disconnected.png` under `test-results/agent-receipts-*`.
Release validation also covers the combined tree with current main. The web
deployment does not upgrade an external agent host; that installation and its
live incident acceptance remain outstanding.
