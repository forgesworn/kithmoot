# Terms of use

> **DRAFT for legal review, 25 September 2026.** It has not been reviewed
> by a lawyer and it is not legal advice. HTML comments name the code
> behind each statement about the service. Text in `[square brackets]` is
> a placeholder or a decision still open.

## 1. About these terms

These terms apply when you use KithMoot: its website, its web app, and its
desktop and Android apps. KithMoot is run by **ForgeSworn** ("we", "us").
You can reach us at `abuse@forgesworn.dev` for anything to do with content,
safety or reports, and `[general contact address]` for anything else.

KithMoot is an encrypted workspace: rooms, messages, files and calls
between the people you invite. It is built on Nostr, an open network, and
uses relays, TURN servers and file stores that you can choose; some of
those are run by us by default, and you can point a room at others
instead.

By using KithMoot you agree to these terms. If we change them, we will say
so on the site before the change takes effect. If you do not agree to a
change, stop using the service.

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
- **We cannot see who is in your room, or what your room contains.**
  Everything meaningful in a room is end-to-end encrypted; we have no
  membership list and no content to review (section 6).

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

- **We cannot read your messages, your files, or your calls.** Rooms are
  end-to-end encrypted; the traffic key never leaves the room's own link
  and the devices in it.
  <!-- docs/protocol.md, "Identities and trust boundaries": "Participant secrets never go to relays, forwarders or stores. ... Encryption hides payloads, not these observations." -->
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

## 7. Reporting content and complaints

Write to **`abuse@forgesworn.dev`**, or use the `/report/` page, to report
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

## 8. Removing access

We may take default infrastructure we control offline for a room, a
credential, or a specific hash, or block a pubkey where the underlying
software allows it, at our discretion, for example to act on a report or
to protect people. This is a metadata-level action, described precisely in
`docs/legal/report-handling.md`; it never involves us reading room content,
because we cannot. We will tell you why unless the law or safety prevents
it. Nothing here reaches a room's own key holders, a keeper's own
infrastructure, or a self-hosted deployment of KithMoot, none of which we
control.

## 9. Our responsibility to you

- We provide the service as it is, and we are improving it all the time.
  We do our best to keep the default infrastructure running, but we
  cannot promise it will always be available.
- We are not responsible for what other people say, share or do in a room,
  because we cannot see it and cannot pre-review it.
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

## 10. Privacy

How we handle personal data is in our privacy notice
(`docs/legal/privacy-notice-draft.md`).

## 11. Law

These terms are governed by the law of England and Wales.
`[LEGAL REVIEW: governing law and courts, given users outside the UK.]`

## 12. Contact

**ForgeSworn.** Content, safety and reports: `abuse@forgesworn.dev`.
`[general contact address]`.
