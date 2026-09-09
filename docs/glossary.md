# The words

One page. If a word is not here, it does not go in the interface. The
rule exists because the app used four names for two things (room, group,
conversation, project) and explained itself on every screen instead of
having a shape. A reader who knows Slack should never need this page; it
is for the people writing the interface.

## In the interface

| Word | Means | Never say |
| --- | --- | --- |
| **Room** | The thing a link opens. Long-lived. Has people, agents, conversations and calls. | group, workspace, channel, meeting |
| **Conversation** | A tab inside a room. Chat is the one every room has. Transcript and Minutes appear when a call has produced them. | channel (in the interface; the code may say channel) |
| **Person** / **people** | A human member. | participant, user, principal, visitor |
| **Agent** | A program that is a member, with a proof of whose it is. | bot, computer helper, clerk, keeper (a keeper is an agent with a job; say what it does) |
| **Name** | What somebody typed or their profile says. A claim, not a check. | display name, handle |
| **Sign in with Nostr** | The one way to bring an identity you already have. The only place "Nostr" appears by default. | log in, connect, signer |
| **Invite link** | The link that admits somebody. | invitation, capability, join link, share link |
| **Call** | Microphone, camera and screen share, in a room, while it is on. | media, session |
| **File** | Something sent in a message. | attachment, blob, share |
| **Room details** | The one drawer that holds who is here, the invite link, conversations, agents, you, and Settings. | menu, sheet, panel |
| **Settings** | Relays, servers, keyboard shortcuts, the Wildbloom import. Bottom of Room details, and only there. | preferences, advanced, options (except "File options") |
| **Just a name** | Going in without an account: a name and a key made for the room. The phrase for it is "with just a name"; the chip on a message says "Name only". | visitor, guest, anonymous |
| **Checked** | You did the words-out-loud check with this person. Shown as a badge on the member row. | verified, trusted |

## The code beside a name

A name never stands alone when it has to do work: when two people in view
have made the same claim, or when there is no name at all. Otherwise the
name stands alone. The code is both ends of the npub, never raw hex, and
the whole npub is one tap away in Room details. Room ids are not keys and
are shown only in Room details.

## Only behind Settings or in the docs

relay, key, signer, keeper, epoch, pass, forwarder, Blossom, Wildbloom,
lane, hex, visitor, project (until there are rooms to organise), browser,
device (except in Room details when adding one), TURN, STUN, ICE, kind.

## Tone

Say what it does, not how it works. "Files are encrypted before they
leave this device" is enough; the key schedule is for `docs/`. One
sentence where one will do, and no sentence where the control already
says it.
