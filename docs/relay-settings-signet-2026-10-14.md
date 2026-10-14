# Relay settings and Signet sign-in

The relay list now has Move up/down controls. The saved order survives a
reload and selects the first default relay used by Signet sign-in. All
readable/writable relays remain in use; this is not sequential failover.
Shared room relays remain ahead of personal choices.

Health stays scoped to the selected room or account-sync connections. When
a relay is idle here but connected for another feature, the screen says
"Not in use here · Connected elsewhere in KithMoot". Another connection's
authentication and accepted writes do not count as permission or delivery
for this one. Opening defaults from app settings explicitly selects defaults.

A Signet identity proof without a live signer is still refused. The error
now explains how to enable Signet signing or use another signer connection.
Explicit `?signin=nostr` errors are displayed rather than swallowed by the
background session-restore handler.

## Local evidence

- 67 focused relay/preferences/protocol unit tests passed.
- Typechecks and 99 desktop unit tests passed.
- All five relay/sign-in browser cases passed in Chromium, the desktop
  renderer build and Firefox (15 cases total).
- Cases cover encrypted Signet approval, a subsequent NIP-46 handshake and
  signed room join, rejection of identity-only approval, saved order used
  in the next Signet request, read-only traffic and explicit relay identity
  permission. Relay controls fit 320 px with 200% text.
- The actual current My Signet app was also exercised with a disposable
  local identity: signing enabled completes KithMoot desktop-renderer login
  and a room join; signing disabled produces the explicit error.

Local WebKit could not create a page: `Page.overrideSetting` reported
`Unknown setting: PushAPIEnabled`. This is not a passing Safari check.

## Remaining field report

The tester reports desktop staying waiting after approving in Signet; its
exact waiting message is unknown. An initial real-app integration run also
stayed at Signet "Signing…" and KithMoot "Waiting for approval…". Later
controlled runs completed without changing Signet's handoff code. Neither
the root cause nor a fix for that persistent field stall is established.
The tests above use disposable browsers and a local relay, not the tester's
installed desktop client, saved pairing or public network.
