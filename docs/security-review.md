# Reviewing KithMoot's security

For anyone, a person or an agent, asked to review this code for security.
Read this before the code. It says what the review is for, the three
yardsticks a finding is measured against, and what a finding has to
contain. Most of a review's value here is in finding where the code fails
its own claims. Very little of it is in importing controls from products
that have an operator, because this one does not, on purpose.

The product is judged by a stranger opening a link on a phone. A control
that stranger trips over is a cost, and it has to buy something.

## Three yardsticks, in this order

**1. Privacy: who learns what.** Relays learn opaque ids and timing, never
contents and never names. A service that carries media or files, a
forwarder, a TURN server, a Blossom store, learns a device key and at most
an opaque room id. Nothing learns a person from what it carries. A device
key is per room, so two rooms cannot be joined by it, and the participant
identity signs only what the participant is doing, never a request to a
third party that a device key could sign instead.

**2. Decentralisation: nobody operates it.** No mandated operator. Relays,
TURN, forwarders, keepers and stores are plural, swappable and optional,
and nothing that carries media holds the key. Nobody registers and nobody
holds a guest list: the link is a capability. A control that needs an
account, an allowlist of people, a token in the app bundle, or an
operator's list of the rooms it serves is wrong here by construction,
however standard it is elsewhere. An operator's list of rooms is a guest
list under another name.

**3. Security.** The room key never leaves the members. A person's identity
is theirs across their devices. A removed member is out by the epoch. A
bearer capability that leaks is rotatable. Untrusted input is projected
onto named fields, never validated and passed through. A secret is never
on a command line, in a URL a relay sees, or in a log.

When two of these conflict, the order decides, and the answer is almost
always a different design rather than a weaker one. The worked example: a
service that must refuse strangers gets an authority-signed, epoch-bound,
device-bound pass it can verify blind, not a bearer token and not an
allowlist. See "The direction for service admission" below.

## The claims the code must keep

From the README. A finding that costs one of these is a product change,
not a fix. It may still be right, and then it is proposed as a design with
the claim it costs named, not shipped as a patch.

- The person, not the device, is the member. Identity and membership
  survive a closed tab, a restart and a new day.
- A room stays open with nobody online, and a member returns to it.
- The link is the key. No registration, no account, no guest list.
- Calls hold, on the networks where STUN alone does not.
- A file can be shared privately by any member.
- An agent is a member with attested ownership, a sender-side consent
  switch, and approvals answered in the room.

## What a finding looks like

- **The claim it protects and the adversary.** Who they are, what they
  hold, what they get. "A stranger with the room id", "the next person at
  a shared machine", "a removed member with yesterday's descriptor", "the
  operator of a relay".
- **Where, with a test that fails today.** A finding without a failing
  test is an opinion.
- **The fix, additive and reversible for existing users.** A migration
  that deletes what a person had is never acceptable in any form.
- **What it costs on each yardstick, stated.** "Nothing" is a fine answer.
  Not saying is not.
- **If it changes the wire**, a kind, a field on an event, a signal, it is
  a proposal for the protocol milestone, with interop vectors, the Android
  reader and a migration for whatever is already running. It does not ship
  in a review branch.

## Out of bounds

Each of these has been proposed and declined, with the reasoning in
`docs/decisions.md` under "Three security-review proposals declined".

- Moving identity, memberships or room capabilities to tab storage.
- A token or a secret in the browser bundle.
- An allowlist of people or of rooms at any service.
- Signing a request to a third party with the participant identity where
  the device key already does.
- Replacing a pinned dependency with a different one as part of a fix.
- Rewriting a test so it accepts a weaker product.
- A deploy-kit change that stops a running service until an operator edits
  a file by hand.

## The direction for service admission

So a reviewer proposes the intended design rather than another: a blind
service admits a member by a **member pass**. The room authority signs
"device D is admitted to room R until T, at epoch E"; the device presents
it and signs the request; the service checks two signatures and a time. It
is bound to the device, not the identity, so the service cannot tie what it
serves to a person. It is issued on admission and re-issued on each epoch,
so no keeper has to be online to keep it fresh, and a member may sign
passes for their own devices under it. It names the room by a per-service
pseudonym, never the id the relay sees. No pass means degrade, never fail:
the mesh instead of the forwarder, STUN instead of TURN, no push. An open
service accepts any valid pass and quotas per room; it never asks a room to
register. The forwarder is the first consumer, and the pass arrives as a
protocol change with vectors, not as a patch.

## Read before reviewing

- `README.md`: "The claim", "The link, and what a relay sees", "No
  operator, not no infrastructure".
- `docs/decisions.md`, all of it. Every design that looks like an omission
  has an entry saying why it is the way it is.
- `docs/messages.md`, `docs/persistent-groups.md`, `docs/agents.md`.
- `vectors/README.md`: what is pinned on the wire and how a second
  implementation checks it.

## The deliverable

Findings in the shape above, the tests that demonstrate them, and at most
small additive fixes on a branch, each in its own commit with the claim it
protects in the message. Wire proposals as a document. Storage, deploy and
server semantics are never rewritten in one branch.
