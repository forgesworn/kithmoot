# Calls when you are both behind a VPN

For two or a few people who want a KithMoot chat, voice or video call
while each of them is on a VPN, a mobile network or another restrictive
network. The same guide is on the website at
[kithmoot.app/calls-behind-vpn/](https://kithmoot.app/calls-behind-vpn/),
an unlisted page that search engines are asked not to index
(`site/calls-behind-vpn/index.html`). Keep the two in step.

## Why a call needs a relay here

KithMoot calls connect directly between devices when they can. Two people
behind VPNs usually can't: each VPN hides its users behind a shared exit
that won't accept a connection it didn't start, so neither side can reach
the other. The call then needs a TURN relay that both devices can reach.

KithMoot's makers no longer run a public call relay. Ours closed on
8 November 2026 (see the privacy notice, section 4.5). The relay has to
come from you, the room or one of its members.

A relay passes the call along but can't see or hear it: WebRTC encrypts
the media between the devices and the relay is never given the keys. It
does see the IP address each device connects from (with a VPN, the VPN's
exit), the call's timing and how much data it carries.

## Choose a relay

In order of preference:

1. **The room starter's Spry node.** If the person who starts the room has
   paired a Spry node under **Settings → Calls → Your Spry node**, rooms
   they start share it with everyone in them. Guests set nothing up.
2. **The room starter's desktop app.** If one of you uses the desktop app
   on home broadband and can turn their VPN off for the call, they can run
   the relay built into the app: **Settings → Calls → Call relay on this
   computer**. It is off until they turn it on. Rooms they start share
   it, so guests set nothing up. It asks the router to open its ports
   (UPnP or similar), so the host turns their VPN off for the call. It
   can't run behind a second router, or where the internet provider shares
   one address between many customers. The page says which. Once
   another person is in the room, **Check from another device…** confirms
   they can reach it. People who use it see the host's internet address,
   and the host's relay sees theirs. For two Windows PCs,
   [A one-to-one call between two Windows PCs](windows-calls.md) walks
   through it step by step.
3. **A relay server with a login for each person.** Either a small relay
   one of you runs ([Your own relay for a one-to-one
   call](private-call-relay.md)) or a managed TURN service. Each person
   gets their own login, usually as a connection file, and keeps it
   private. Either can cost money.
4. **Public call relays.** Off by default. They are run by strangers who
   advertise them on Nostr. Use them only as a last resort.

**Your KithMoot node** on the same page isn't covered here.

## Each person, before the call

These are the web and desktop labels.

1. Use a current Chrome, Firefox or Safari at
   [kithmoot.forgesworn.dev/j/](https://kithmoot.forgesworn.dev/j/), or the
   desktop app from [kithmoot.app/downloads/](https://kithmoot.app/downloads/).
   On iPhone or iPad, use Safari. No account is needed to join.
2. If you were given a relay login (option 3 above), open **Settings →
   Calls → Relay server**. Choose **Import a connection file…** and pick
   your file, or type the addresses, username and password you were given.
   Nothing is saved until you choose **Save**.
3. Once it's saved, choose **Test**. It contacts only the relay and uses
   no camera or microphone. Don't go on until it passes.
4. For the first call, leave **Hide my IP address on calls** off, and leave
   **Hide my IP address from other people in this call** unticked when you
   join. With it on, the call is refused if the relay doesn't work.
   Without it, the others on the call can see your device's local network
   addresses as well as the address you connect from, which on a VPN is the
   VPN's exit.

On Android, the relay is under **Settings → Calls**. If there is no
import option, enter the details from the file by hand.

## The person starting the room

1. Choose **Start a room**. Tick **Ask me before anyone joins**, because an
   invite link can be forwarded. Then choose **Start a room** again.
2. Choose **Copy invite link** and send it privately. Never put a relay
   password in a link or in the room's chat; KithMoot never adds one.
3. Stay in the room. You let each person in yourself.

## Joining and calling

1. Open the invite link, or choose **Open an invite link** and paste it.
   Type the name others will see.
2. If the room asks before anyone joins, you can preview your camera and
   test your microphone, then choose **Request to join** and wait to be
   let in.
3. Either person chooses **Start call**. The others get a ring and choose
   **Answer**, or **Join**. Answering turns the microphone on and leaves the
   camera off; turn the camera on with **Camera**.

## When it doesn't work

- **The relay changed while a room was open.** Leave the room and open it
  again; a new relay is used only after that.
- **Test fails, or the call starts but never connects.** The VPN may be
  blocking UDP. Try another server or protocol in the VPN app. A relay that
  offers only UDP can't help on a network that blocks it. One with a
  `turns:` address on port 443 can; [Your own relay for a one-to-one
  call](private-call-relay.md) explains what that needs.
- **Safari refuses the relay.** Safari needs a UDP or TLS (`turns:`)
  address. A relay offering only plain TCP is refused.
- **The room won't load or messages don't arrive.** Public Nostr relays
  sometimes rate-limit a VPN exit address that many people share. Switch to
  another VPN server and reload.

## Passing this to someone else's AI assistant

The labels in bold are the app's exact wording. A connection file holds a
password. Keep its contents out of chats, logs, issue reports and an
assistant's memory.
