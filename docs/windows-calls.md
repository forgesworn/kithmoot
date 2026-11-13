# A one-to-one call between two Windows PCs

For two people on Windows who want chat, voice, video and screen sharing
when their networks won't connect directly, for example because one or both
of them is on a VPN. The same guide is on the website at
[kithmoot.app/windows-calls/](https://kithmoot.app/windows-calls/), an
unlisted page that search engines are asked not to index
(`site/windows-calls/index.html`). Keep the two in step. For other kinds of
relay, see [Calls when you are both behind a VPN](calls-behind-vpn.md).

Written 13 November 2026, for the Windows desktop app 0.1.149.

One of you, the host, starts a room and turns on the call relay built into
the KithMoot app on their own PC. The other, the guest, joins from the
invite link. The relay lets the call through when your networks can't
connect. Neither of you rents a server and there's nothing to pay. The
app's messages and the relay's requests still travel over the Nostr relays
in your Connections list, as section 4.5 of the
[privacy notice](https://kithmoot.app/privacy/) describes.

The Windows app is an unsigned preview. A full call and screen share on a
fresh Windows PC hasn't been checked yet, and the built-in relay hasn't been
tried on Windows either. If something goes wrong, write down exactly what
each screen said.

## Who should host

The host needs a normal home broadband connection, with their VPN turned
off for the call. The guest can stay on their VPN. While the host's VPN is
off, the guest's app can see the host's home internet address, and the
host's relay sees the guest's.

## Both of you: install

1. Go to [kithmoot.app/downloads/](https://kithmoot.app/downloads/) and
   choose **Download for Windows** (Windows 10 or 11, 64-bit).
2. Extract the whole ZIP into a folder you own, such as Documents, not
   Program Files. Keep the folder together, because the app updates itself
   there.
3. Open **KithMoot.exe**. If Windows warns about an unknown publisher,
   choose **More info**, then **Run anyway**.

You don't need an account. Starting or joining a room is enough.

## Host: start the room and turn on the relay

1. Turn your VPN off.
2. In KithMoot, choose **Start a room**. If you tick **Ask me before anyone
   joins**, a forwarded link can't get anyone in unless you let them in.
   Then choose **Start a room** again. You must have a room open before the
   relay will start.
3. Go to **Settings → Calls → Call relay on this computer** and turn it on.
   Confirm when asked.
4. Windows Firewall may ask whether to allow KithMoot or spry-node. Choose
   **Allow**. If it offers private and public networks and you're not sure
   which yours is, tick both.
5. The page tells you whether the relay is running and whether people can
   reach it. If it says your router didn't allow automatic setup, turn on
   UPnP in your router's settings, or swap so the other person hosts. If it
   says your internet provider shares one address between many customers,
   or that there's a second router, this connection can't host, so swap.
6. Go back to the room, choose **Copy invite link** and send it to the guest
   privately. A room you started shares your relay with whoever joins, so
   the guest sets nothing up.

The relay is off until you turn it on. Turn it on before each call, or tick
**Start it when KithMoot opens**. It has a daily allowance of 5 GB. Video and
screen sharing both ways use that up faster than voice, and once it's used
the relay stops until the next day.

## Guest: join

In the KithMoot app, choose **Open an invite link** and paste in the link.
Don't just click the link, because that opens the browser version instead.
Type your name and choose **Join**. If you see **Request to join**, choose it
and wait for the host to let you in.

## Host: check the relay

Once you're both in the room, go to **Settings → Calls → Call relay on this
computer**, choose **Check from another device…** and pick the guest. It
should say the relay can be reached.

## Call

Either of you chooses **Start call**. The other hears a ring and chooses
**Answer**. Answering turns the microphone on but not the camera. Use
**Camera** for video and **Screen share** to share your screen. The room's
chat works the whole time, during a call or not.

Leave **Hide my IP address on calls** off for the first call.

## If it doesn't work

- **The relay won't start and asks you to start or open a room first.** Do
  that, then turn it on again.
- **The relay is running but the check says the guest can't reach it.**
  Windows Firewall may be blocking it. Open Windows Security, **Firewall &
  network protection**, **Allow an app through firewall**, and make sure
  KithMoot and spry-node are allowed on the network type you're using.
- **The guest joined before the relay was running and the call won't
  connect.** The guest leaves the room and joins again with the same invite
  link.
- **The call starts but never connects.** Try swapping host and guest.
- **The guest's app misbehaves.** The guest can open the invite link in
  Chrome instead. Only the host needs the app.
- **Neither of you can host.** Try with both VPNs off. Two home connections
  can often connect directly with no relay at all.
  [Calls when you are both behind a VPN](calls-behind-vpn.md) covers other
  kinds of relay.
- **The room won't load, or messages don't arrive, for whoever is on a
  VPN.** Switch to another VPN server and try again.

If none of that works,
[report an issue](https://github.com/forgesworn/kithmoot/issues) with what
each screen said. Issues are public, so leave out the invite link and
anything that identifies either of you.

## Helping someone with an AI assistant

The labels in bold are the app's exact wording. Don't change other
settings.
