# Browser and home messaging goals

Recorded 2026-09-09. These are accepted product goals; all remain open.
Individual foundations already exist, but none of the complete journeys below
is declared finished by this document.

## The need

A person wants to use messaging from their phone's browser, keep the supporting
services and data on a computer at home, and avoid installing a collection of
messaging apps. They may also need to keep conversations with people already
using WhatsApp, Signal or Telegram.

KithMoot should serve this need through a usable browser experience and optional
infrastructure the person owns. A Windows desktop inside a browser must not be
necessary for native KithMoot conversations. Access to existing networks is a
separate goal: inviting someone to KithMoot does not satisfy it.

## G1 — Everyday messaging from a phone browser

Complete the ordinary messaging journey without requiring a native KithMoot
app, a phone number, a paid account or a desktop computer.

Acceptance:

- On physical iPhone and Android devices, open an invitation, establish a
  recoverable identity, send and receive direct and group messages, share and
  retrieve encrypted files, and make and answer voice/video calls.
- Reopen after browser suspension, a device restart and a Wi-Fi/mobile-data
  change without losing membership or acknowledged messages. Pending and
  failed sends remain visible and retry without duplicate messages.
- Recover on a replacement device using an explicitly saved recovery method;
  explain what cannot be recovered when the person has not saved one.
- Document any browser permission or home-screen installation requirement per
  feature. A required external signer app must not be hidden inside a claim
  that no native app is needed.

## G2 — Notifications while the phone is in a pocket

Deliver useful message and incoming-call alerts when the conversation is not
open, with explicit consent and control over what a lock screen reveals.

Acceptance:

- Demonstrate delivery on physical iOS and Android devices while locked and
  with the app closed, recording the browser/OS versions, installation mode,
  latency and any platform-imposed limits separately.
- Opening a message alert reaches the correct conversation and catches up;
  answering a supported call alert joins the intended call. Expired calls
  become missed calls rather than invitations to a dead session.
- Exercise denied/revoked permission, expired subscriptions, offline delivery,
  duplicate alerts, mute settings and notification-host replacement.
- Keep message contents and room keys out of push infrastructure. Disclose
  remaining metadata and any browser/OS push-provider dependency. An owned
  nudger alone is not proof of independence from platform push services.

This extends the existing M5 optional nudger direction. Open-tab notifications
or a Nostr nudge alone do not close this goal.

## G3 — Durable history and useful search

Let a person find and recover their conversations beyond the current
30-day/500-message client window, using an optional encrypted archive.

Acceptance:

- Recover and search a conversation older than 90 days containing more than
  500 messages on a fresh browser, including replies and file references.
- Verify archive data before use and enforce membership/epoch access rules;
  a storage host must not receive plaintext messages or room keys.
- Restore after loss of an archive node from an independently held copy,
  retrieve referenced file bytes, and identify incomplete history honestly.
- Provide understandable retention, export, recovery and local cache controls;
  distinguish local deletion from deletion of copies held by other parties.

This extends M3. Bothy is the preferred optional archive host; a Bothy mailbox
with bounded retention is not by itself a durable KithMoot archive.

## G4 — An integrated home messaging setup

Offer a documented setup that brings KithMoot, Bothy and Wildbloom storage
together on hardware the person controls. Include an Umbrel installation path
alongside a standalone Linux path, with explicit supported hardware and versions.

Acceptance:

- From a clean supported machine, install, pair a phone, create a conversation,
  store an encrypted attachment on owned storage and retrieve it from another
  member's device. Show which services and copies are actually in use.
- Repeat away from home over mobile data, with no manual router changes on the
  default supported path. Record any public relay, reachability, HTTPS or push
  dependency rather than describing the deployment as entirely local.
- Demonstrate restart, upgrade, rollback, backup and restoration on a replacement
  host. Archive and notification integration must meet G2 and G3, not merely
  start their processes successfully.
- Replace each configured service without changing the person's identity or
  losing access to recoverable conversations. Hosted and independently operated
  alternatives remain usable; Bothy is never mandatory for joining a room.

Wildbloom supplies encrypted file delivery and owned Blossom storage; Bothy
supplies the personal shelter and planned archive/nudger integration. This is
an integration goal, not a claim that the complete appliance exists today.

## G5 — Existing conversations from one browser surface

Enable a person to retain conversations with WhatsApp, Signal and Telegram
contacts through an optional integration they operate. Those contacts should
not have to move to KithMoot to satisfy this goal.

Acceptance and feasibility gates, tracked separately for each service:

- Establish the supported integration route, account/number requirements,
  primary-device obligations and service terms from current primary sources
  before choosing an implementation. Record restrictions and unsupported
  features; usernames alone are not evidence of phone independence.
- Prove bidirectional text and attachment delivery with a real consenting
  contact, then exercise relinking, restart, offline catch-up and disconnect.
  Show feature support, including calls, per service instead of implying parity.
- Keep credentials and sessions on the explicitly chosen host. Explain where
  messages are decrypted and who can read them: a connector that sees plaintext
  changes the end-to-end encryption boundary.
- Make each connector opt-in, isolated and revocable. Its failure must not
  interrupt native KithMoot rooms. Existing networks remain external services
  even when their clients or connectors run at home.

A feasibility report is the first deliverable, not completion of this goal.
If a service prevents the intended journey, retain that service as blocked
with evidence and an explicit limitation; an invitation link is not a bridge.

## G6 — A clear option for keeping messaging execution at home

Serve people who want the messaging client and persistent decrypted state on
their home machine, beyond simply avoiding a native phone app.

Acceptance:

- Define and prototype an explicit home-execution mode, then verify what
  executes and persists on the home host and phone. Screen display and input
  still expose content to the phone; promise no stronger boundary than measured.
- Demonstrate mobile text entry, attachments, session locking, reconnection and
  remote-access authentication. Document call/media support and notification
  behaviour rather than inheriting claims from native browser mode.
- Explain the trade-off: normal KithMoot decrypts in the member's browser;
  home execution makes the selected home host a trusted endpoint. Neither
  mode silently changes the other's custody model.

Oathrun may optionally host a permissioned assistant participating in a room.
It is not a prerequisite for messaging, a remote desktop, or an assumed bridge
to the existing networks. Agent access must remain explicit and revocable.

## Delivery and evidence

Preserve the existing protocol, archive, search and push ordering described in
the README. G1 spans those releases; G4 integrates them into an owned deployment.
Investigate G5 and G6 independently so external-service restrictions do not
hold up native messaging improvements.

For each goal, link implementation work and acceptance evidence here as it
lands. Evidence must name revisions, devices, service versions, configuration,
observed results and unresolved limits, using synthetic or consented data with
no credentials or recovery keys. Automated checks, physical-device acceptance
and published availability are separate states. Adding this roadmap does not
change the [current limitations](../README.md#what-does-not-work-yet).
