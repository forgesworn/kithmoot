# Terms of use

> **DRAFT for legal review, 28 September 2026.** It has not been reviewed
> by a lawyer and it is not legal advice. HTML comments name the code
> behind each statement about the service. Text in `[square brackets]` is
> a placeholder or a decision still open.
>
> Changed on 28 September 2026: "we cannot read your room" is narrowed to
> rooms we do not keep; a new section 7 covers agents and transcription;
> payments are described as they are; later sections renumbered.
>
> The law behind these terms is written up in
> [the online services law note](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md)
> (section 2.3 for what terms must explain).

## 1. About these terms

These terms apply when you use KithMoot: its website, its web app, and its
desktop and Android apps. KithMoot is run by **ForgeSworn** ("we", "us").
You can reach us at `abuse@safety.forgesworn.dev` for anything to do with content,
safety or reports, and `[general contact address]` for anything else.

KithMoot is an encrypted workspace: rooms, messages, files and calls
between the people you invite. It is built on Nostr, an open network, and
uses relays, TURN servers and file stores that you can choose; some of
those are run by us by default, and you can point a room at others
instead.

By using KithMoot you agree to these terms. If we change them, we will say
so on the site before the change takes effect. If you do not agree to a
change, stop using the service.

**Payment.** Nothing in the service we run by default asks
you for payment. The source code also contains a kit for a separately run
TURN server that charges a room's keeper, never a person in the room, and
a feature that shows on a profile picture how much a person has donated
to the project, worked out from public receipts; that feature takes no
payment and is switched off as shipped.
<!-- deploy/l402/README.md, "What this does not change": the default /turn stays free; "A participant must never be asked to pay to be in a room"; src/node/l402.ts is imported only by its test; app/src/main.ts DONATION_RECIPIENT = '' leaves src/donations.ts disabled -->
`[INPUT: whether the paid TURN endpoint or the donor ring is switched on
anywhere. If either is, the trading rules in section 8 of the law note apply
and this paragraph changes.]`

These terms do not take away any rights you have by law as a consumer.

## 2. Who can use the service

- **Anyone with a room's link can join that room.** There is no sign-up,
  no account requirement, and no central membership list. A room's link is
  a capability: whoever holds it can use it, in the same way a physical
  key works for whoever is holding it.
  <!-- docs/protocol.md, "Room links and admission": the capability lives only in the URL fragment, never sent to a server -->
- **Signing in with a Nostr key is optional.** It lets your room bookmarks
  and settings follow you between devices. It is not required to create,
  join or use a room.
- **Age.** `[DECISION: KithMoot has not yet set a minimum age. Until this
  is decided, do not publish a specific age figure in this section; see
  docs/legal/childrens-access-assessment-draft.md, which explains why this
  matters and cannot be skipped.]`

## 3. Rooms, links and who is responsible for them

- **A room's link is its access control.** Whoever creates a room decides
  who to send it to, and is responsible for who they invite.
- **Changing an invitation stops future use of the old one by cooperating
  clients. It does not remove people already admitted, and it cannot
  reach a copy of the link someone already has and has not yet used**, if
  that copy is opened before the change takes effect.
  <!-- site/index.html #privacy: "Changing the invitation stops future use by cooperating clients; it doesn't remove people already admitted." -->
- **A "kept" room**, run by a keeper on their own computer or server, can
  name hosts who remove members or close the room. Removal changes the
  room's key for everyone still in it, but it cannot erase a message
  someone already received on their device.
- **A keeper holds the room's key.** It made the room, it is a member of
  it, and whoever runs the computer it runs on can read the room as any
  member can: its messages, its files, and who is in it.
  <!-- deploy/keeper@.service: "It holds the room's traffic secret and the root inviter key"; deploy/README.md, "Running a keeper": "the operator of the box can read that room the way any member can" -->
- **Unless we keep your room, we cannot see who is in it or what it
  contains.** Everything meaningful in a room is end-to-end encrypted; for
  a room we do not keep, we have no membership list and no content to
  review (section 6). If we run the keeper for a room, we can read that
  room.
  `[INPUT: whether the operator keeps any room that people other than the
  maintainers use; if so, say which rooms, or how their members are told.]`

## 4. Your identity and your keys

- **Your Nostr key, if you use one, is yours.** We never ask you to send
  your private key to us.
- **A per-device, per-room key is the default** if you do not sign in with
  Nostr. It is generated on your device and is not linked to any account.
- We cannot recover a lost key, a lost room link, or a lost device
  pairing for you. If you lose the link to a room and nobody currently in
  it can send you a fresh one, we cannot get you back in.

## 5. What is not allowed

You must not use KithMoot, or any of the default infrastructure we run for
it (relays, TURN, the default file store, the default drop tier), for:

1. **unlawful or harmful content**, including anything terrorist, anything
   that sexually exploits or abuses children, and anything that encourages
   suicide or self-harm;
2. **harassment or abuse**, including threats, bullying, stalking and
   hate, whether inside a room or aimed at another person through it;
3. **infringing other people's rights**, including copyright and other
   people's private information;
4. **scams or fraud**, including pretending to be someone else to gain a
   person's trust in a room;
5. **abusing the default infrastructure itself**: minting TURN credentials
   or posting to the default drop tier for any purpose other than using
   KithMoot as intended, running automated load against any default
   endpoint, or using the relay we run, TURN server or file store to
   relay or store material unconnected to a KithMoot room;
6. **disrupting or exploiting the service**, including malware and getting
   round rate limits or access controls.

## 6. What we can see, and what we cannot

Read this section before relying on anything else in these terms about
reports or removal.

- **We cannot read your messages, your files, or your calls, unless we
  keep your room.** Rooms are end-to-end encrypted; the traffic key never
  leaves the room's own link, the devices in it, and its keeper if it has
  one. The relays, forwarders, TURN server and file store we run never
  get the key.
  <!-- docs/protocol.md, "Identities and trust boundaries": "Participant secrets never go to relays, forwarders or stores. ... Encryption hides payloads, not these observations." -->
- **If we run the keeper for a room, we hold that room's key** and can
  read it the way any member can (section 3). A key we hold is one the law
  can require us to hand over.
  <!-- deploy/README.md, "Running a keeper"; law note section 5.4 (RIPA s49) -->
- **What relays, forwarders and TURN servers see instead:** event kinds,
  device public keys, opaque room selectors, timing and the size of what
  is sent. Not who a person is, and not what was said.
- **What we can act on, when something is reported to us, is metadata**:
  a room link, an event id, a file hash, a pubkey, and your account of
  what happened. See `docs/legal/report-handling.md` for exactly what each
  action does and does not do, surface by surface. We will not promise a
  capability we do not have.
- **The default relays are independent public relays.** Rooms whose links
  were written before September 2026 may also name a relay we run. On that
  relay, and only that one, we have relay-operator-level control over what
  it stores and serves. We have no such control over any other relay,
  including the defaults, or any relay a room's creator chooses instead.
- **The default file store accepts only sealed, encrypted files it cannot
  itself read or display.** It cannot serve a viewable image, video or
  document under any circumstances; what is stored there is meaningless
  bytes without a room's own key.

## 7. Agents in a room

A room can have agents as members: programs that read the room and can
write in it. Each is marked "agent" beside its name, because it says it is
one.
<!-- src/agent.ts (RoomAgent); app/src/main.ts renders an "agent" badge for a participant whose roster entry says agent -->

- **An agent reads what members can read.** It is a member, so it has
  the room's key for as long as it is in the room: the chat, the files
  shared there, and the agents' channel.
- **A listening agent transcribes speech.** An agent that listens writes
  what people say on a call into the room's transcript channel, where
  every member can read it. It hears only people who have switched on
  "Let agents hear me", which is off until each person turns it on for
  their own device. The transcript is what the agent reckons was said,
  not a record anyone vouches for.
  <!-- src/agent.ts TRANSCRIPT_CHANNEL; src/node/transcriber.ts; app/src/main.ts setAgentsMayHear ("Off: nothing that says it is an agent is sent your camera or microphone") and the transcript channel note -->
- **An agent may send what it reads elsewhere.** Depending on how it is
  set up, it passes room content to a model on its own machine, to a
  program its owner chose, or to an online model provider.
  <!-- src/node/brains.ts: StdioBrain, OllamaBrain (default http://127.0.0.1:11434), AnthropicBrain; src/node/transcriber.ts: WhisperX, loopback by default -->
- **Whoever brings an agent into a room is responsible for it**: for
  telling the people in the room, and for where the agent sends what it
  reads or hears. We are not that person unless we run the agent.

## 8. Reporting content and complaints

Write to **`abuse@safety.forgesworn.dev`**, or use the `/report/` page, to report
illegal content or abuse connected with KithMoot. Tell us:

- the room link, if you have or can share one, or the context you
  encountered the problem in;
- any event id or file link you have;
- what happened and why you believe it breaks these terms or the law.

You do not need an account to report to us. See
`docs/legal/report-handling.md` for how we handle a report, what we can
and cannot do about it, and our timescales.

**Complaints.** If you reported something and are unhappy with what we
did, or think we removed or restricted something wrongly, write to the
same address and say what happened. We acknowledge, look at it again, and
tell you what we decided. If you are not satisfied, you can contact Ofcom,
which regulates online safety, or seek independent advice.

## 9. Removing access

We may take default infrastructure we control offline for a room, a
credential, or a specific hash, or block a pubkey where the underlying
software allows it, at our discretion, for example to act on a report or
to protect people. This is a metadata-level action, described precisely in
`docs/legal/report-handling.md`; for a room we do not keep, it never
involves us reading room content, because we cannot. For a room we keep,
we can also act as its keeper: remove a member or close the room. We will
tell you why unless the law or safety prevents it. Nothing here reaches a
room's own key holders, a keeper someone else runs, or a self-hosted
deployment of KithMoot, none of which we control.
<!-- deploy/README.md, "Hosts: who may remove people": a keeper is "the only party that can remove a member" -->

## 10. Our responsibility to you

- We provide the service as it is, and we are improving it all the time.
  We do our best to keep the default infrastructure running, but we
  cannot promise it will always be available.
- We are not responsible for what other people say, share or do in a room,
  because we cannot pre-review it, and outside rooms we keep we cannot see
  it.
- If you self-host KithMoot or run your own keeper, relay, TURN server or
  file store, these terms cover only the default infrastructure we run;
  your own deployment is your own responsibility.
- **What we do not limit.** Nothing in these terms limits or excludes our
  liability for death or personal injury caused by our negligence, for
  fraud or fraudulent misrepresentation, or for anything else the law
  does not allow us to limit.
- `[LEGAL REVIEW: a liability cap, and whether consumer users and business
  users (a self-hosting keeper, an agency running rooms for clients) need
  different wording.]`

## 11. Privacy

How we handle personal data is in our privacy notice
(`docs/legal/privacy-notice-draft.md`).

## 12. Law

These terms are governed by the law of England and Wales.
`[LEGAL REVIEW: governing law and courts, given users outside the UK.]`

## 13. Contact

**ForgeSworn.** Content, safety and reports: `abuse@safety.forgesworn.dev`.
`[general contact address]`.
