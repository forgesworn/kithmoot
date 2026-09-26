# KithMoot desktop preview

Apple Silicon macOS, Linux x64/ARM64 and Windows x64 previews using Electron 44.4.1 and the bundled KithMoot client. Current release: 0.1.20 on every platform. Mac signing: `source ~/.kithmoot-signing/release-env.sh` before `npm run package:mac`.
The desktop client shares the web call/video, mobile layout, long-text and notification controls.

## Build and run

Use Node 24 from the repository root. Root dependencies must already be installed.

```sh
npm ci --prefix desktop
npm run setup --prefix desktop
npm run build --prefix desktop
npm test --prefix desktop
npm run test:smoke --prefix desktop
npx playwright test --config desktop/playwright.config.ts
npm run package:mac --prefix desktop
npm run package:linux --prefix desktop
npm run package:windows --prefix desktop
```

Open `desktop/out/KithMoot-darwin-arm64/KithMoot.app`, or copy it to `~/Applications`.

The Windows build is a portable `KithMoot-<version>-windows-x64.zip`. Extract the whole archive and open `KithMoot.exe`. It is currently unsigned, has manual updates and may be reported as an unknown publisher or refused by local Windows security policy. Building the archive on macOS verifies the x64 PE executable and packaged ASAR; it is not clean-machine Windows acceptance.
The ZIP alongside it is the same app for another Apple Silicon Mac.

## Behaviour

- The app serves its bundled web assets inside an isolated, persistent Electron session. No local HTTP listener is required. HTTPS is intercepted only for `/j/` on the KithMoot origin; network services such as TURN and encrypted file storage retain their normal endpoints. Browser and desktop profiles are separate.
- Sign in with the same Nostr account using an existing supported remote signer or account option. Browser signer extensions are not installed in Electron. Project/room sync follows the existing account policies; installing the app does not copy browser keys or local history.
- Microphone and camera start only through existing call controls and macOS consent. Screen sharing uses the native macOS 15+ picker when available and an explicit screen/window menu otherwise. Without macOS Screen Recording permission the app says so and offers to open System Settings rather than failing with "Invalid capture constraints". Because the preview is ad-hoc signed, macOS may forget that permission when the app bundle is replaced. Closing during a call asks first. Leaving a call keeps the room chat available.
- Calls disable app suspension while joined. Closing the window ends its call; the macOS Dock app remains available to reopen. There is no incoming-call background daemon.
- Chat and its composer fill the available width when there is no media beside them.
- Share an area has four large corner resize handles and a draggable Move bar; focused controls support arrow keys. The pane stays above normal windows and across Mac fullscreen spaces. Its KithMoot control restores and raises the call window, then the sharing frame retakes the front when focus moves away. Drawing colours appear in a bottom legend once per author, fading with their last mark.
- Wide windows show call video beside the conversation. Smaller windows stack bounded panels while keeping the composer and red Leave call control visible.
- Native Edit, zoom, fullscreen and window menus are available. External links require confirmation and open in the browser. Downloads use a save dialog.
- The renderer is sandboxed, has no Node APIs and receives a narrow IPC bridge for call state, unread counts, bounded notifications and notification room clicks. Main-frame sender checks, navigation restrictions, CSP, asset traversal guards and a permission allowlist protect that boundary. Clipboard reading, USB, serial and location permissions are denied.
- PWA service workers and update reloads are disabled. Desktop preview upgrades are manual replacements of the app bundle, retaining its profile.

## Distribution and acceptance boundaries

The published 0.1.12 Mac preview is **Developer ID signed and notarised**, with hardened runtime and a stapled Apple ticket. Mac 0.1.14 is the next release candidate. It remains a preview: physical capture/audio acceptance and the first automatic update from 0.1.12 still require a completed installed-app check. Earlier published previews were ad-hoc signed.

Linux x64 and ARM64 tarballs include a user-level Python installer and a matching applications-menu desktop entry. Windows x64 is a portable unsigned preview with manual updates. iOS remains future work. Linux preview archives are not repository-signed.

Automated media checks use disposable accounts, a local relay, a fake camera, a synthetic oscillator microphone and a separate browser. They never capture the user's camera, microphone or screen. Real M1/M4 permission prompts, device switching, Bluetooth audio, screen picker, screen audio, notifications, sleep/reconnect, remote signer login and account sync still need physical acceptance. Screen/system audio support must not be inferred from camera/microphone tests.

The test-only profile override is ignored in packaged apps; the standard `--user-data-dir=/absolute/path` argument can isolate a packaged smoke check without relaxing production security.

Sources: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [session permissions and screen picker](https://www.electronjs.org/docs/latest/api/session), [supported releases](https://releases.electronjs.org/).

## 16 September 2026 evidence

- Root and app TypeScript checks passed; desktop build passed.
- Three desktop boundary tests passed (allowed navigation, bundled asset containment/service worker blocking, external schemes/denied permissions).
- Development and packaged-app smoke checks passed: bundled UI, secure context, no renderer Node APIs, narrow preload bridge, CSP, asset traversal rejection, no service worker, notification permission available, and profile persistence across an actual app restart.
- Desktop-to-browser call test passed in 18.9 seconds with a local relay: moving decoded camera images, incoming synthetic audio energy, messages both ways, cancelling a native close, leaving only the Mac call and continuing to chat. Composer and Leave call bounds passed at 1320×852, 1024×700 and 900×612.
- Home and call screenshots were inspected (`desktop/artifacts/`).
- `codesign --verify --deep --strict` passed for the local preview; this verifies the ad-hoc signature, not notarisation.
- ZIP SHA-256: `c06955db3bdbd707d525dd4e134e4293cf0583eb54af8e44507bf3699fdc5edc`.
- Installed app.asar SHA-256: `90a1a5bc2a7a855660c69ac5c5036a33ca9221fa0c1db4f918971227818e156f`. Installed main/preload/policy/web entry bytes matched the tested source.
- No Git commits, pushes, public release or PWA deployment were performed.
- Installed at `~/Applications/KithMoot.app` on both M1 and M4. M4 ZIP and installed ASAR hashes match the values above, and its ad-hoc signature verifies. Automated launch/media evidence is from the M1; M4 physical runtime acceptance remains open.

## Version 0.1.1: room switching

Room changes now keep the desktop frame in place with an Opening message, rather than flashing the invitation/home layout. Saved rooms open in place. Local media and old-room handlers stop synchronously, while the old relay transport stays alive only long enough to send its bounded farewell. Cleanup captures that old transport and cannot close the next room's connections.

Normal chat joins prepare default TURN credentials in the background. Explicit relay-only joins still wait and fail closed without usable TURN credentials. Each asynchronous result is checked against its room generation so an old room cannot replace the new room's ICE state. Admission and epoch checks are unchanged.

Validation: typechecks/build passed; 18 ICE/privacy unit tests passed; native/browser moving video, synthetic audio, chat, close/leave and window layout checks passed. The desktop switching test measured **83 ms** to an editable next room with the farewell acknowledgement withheld and the TURN fetch delayed 4.5 seconds. It also checked no entry-screen flash, the same document, and separate drafts across repeated switches. A second desktop test confirmed relay-only mode makes no peer connections while TURN is pending or after its failure. This is a local controlled measurement, not a promise about arbitrary relay/admission latency.

Packaged-app smoke and ad-hoc signature checks passed. ZIP SHA-256: `5b6b43f9a074a1ad43aa52f84f5b1db5444bc4aafcbbaee9f5620dbfb6b96afe`. ASAR SHA-256: `be94449b99cd423eadf6b4f5ae8b7d9da9642430081061b9e2855bf20dc30a9e`.

The checked installer is staged at `~/kithmoot-desktop-update-20260916/install.py`. It refuses to replace a running or unexpected app, preserves the previous 0.1.0 bundle and leaves the account profile untouched. Installation status is recorded separately below.

0.1.1 delivery: installed and signature/hash verified on both M1 and M4. The M1 installation completed after the user quit 0.1.0; its installed ASAR matches the tested candidate above. The previous app bundle was retained for rollback. No account data was read or changed during packaging/installation.


## 0.1.2: Linux and desktop notifications

Extract the matching `KithMoot-0.1.2-linux-x64.tar.gz` or `KithMoot-0.1.2-linux-arm64.tar.gz`, then run `python3 install.py` inside the extracted folder. No sudo is required. The installer checks the ELF CPU type, installs under `$XDG_DATA_HOME/kithmoot-desktop` (default `~/.local/share`), creates `dev.forgesworn.kithmoot.desktop`, refuses to replace a running installed executable and keeps the profile separate. Each tarball has a `.sha256` file. Current desktop Linux with GTK3/NSS/ALSA and permitted unprivileged user namespaces is required. The production launcher never disables the Chromium sandbox; distributions restricting user namespaces may require administrator configuration.

Native notification banners name the room and sender. Text previews remain opt-in; room keys and invitation links are never sent to the OS notification service. Clicking a banner uses its room ID to find the current account's local bookmark, then follows the existing room-switch confirmation rules. Banners are rate-limited per conversation to five seconds, with bounded retained notification objects.

The Zen bell is an original three-partial bowl tone with a soft attack, quiet level and decay to silence. Its switch and Preview sound control appear when desktop notifications are enabled. Automatic bells are limited to one per five seconds and suppressed while on a call, including listen-only calls. The bell is application audio; its switch controls it independently of the OS notification sound. Native banners are silent to avoid a doubled sound. OS focus/notification settings still control native banners.

Desktop badges count resolved, unretracted messages from other participants, using existing room read positions and active conversation read state. Counts do not depend on notification permission and do not disappear merely because another room has focus. Saved rooms for which the device holds a valid key remain watched while another room is open. Quiet rooms retain their existing open-room-only delivery restriction. The app must remain open or minimised; closing the last Linux window or quitting stops delivery. No push service or background daemon was added.

Linux badge integration uses Electron's LauncherEntry D-Bus API with the installed `.desktop` identity. KDE/Ubuntu-style launchers can display the number; plain GNOME setups may need a dock extension. The window title carries the same count as a fallback. See [Electron badge documentation](https://www.electronjs.org/docs/latest/api/app#appsetbadgecountcount-linux-macos) and [native notifications](https://www.electronjs.org/docs/latest/tutorial/notifications).

Share Area is available in the Linux desktop app on X11 and Wayland. On X11 it uses the same movable, resizable crop frame and annotation overlay as macOS and Windows. Wayland does not let an app position its own window or read screen coordinates, so there Share an area opens a preview window instead: the system's screen-share dialog chooses the monitor, the person drags a box on the preview, and only that box is sent, through the same crop and drawing path. The selection can be moved while sharing. `KITHMOOT_DESKTOP_AREA_MODE=preview` forces the preview in an unpackaged run so `test/area-preview.spec.ts` can drive it on a Mac; the portal itself is only exercised on a real Wayland desktop. Ordinary screen sharing on Wayland takes the portal's one answer without a second KithMoot menu. Linux shares video without system audio: Electron's display-media loopback output is not supported on Linux. An id-less capture source is accepted only on a single-display desktop; KithMoot refuses to guess on a multi-display setup because guessing could expose the wrong monitor.

Validation:

- Root/app typechecks and 25 notification/scope/room-watch tests pass; five native boundary/security tests pass.
- All five desktop end-to-end checks pass (15.7 seconds in the final run). They exercise synthetic native/browser calls, fast room changes, relay-only failure, background saved-room messages, badge clearing on reading, private notification content and room-click routing. Playwright's routed WebSocket fixture throws on closing-state sends, unlike Chromium's native socket; only that exact fixture diagnostic is excluded from the notification test's page-error assertion.
- Test teardown now destroys only the disposable test windows before closing Electron, avoiding orphaned helper processes from abrupt `app.exit()` teardown.
- The actual Preview sound handler was rendered into OfflineAudioContext: peak 0.145, early RMS 0.064, late RMS 0.000149 and a silent tail. Nothing was played through the user's speakers. Listening acceptance remains pending.
- Linux ARM64 package installed and launched under Debian Bookworm/Xvfb with dunst in a disposable container. The actual native D-Bus notification carried the synthetic room/sender, and LauncherEntry published count 7 with the correct desktop identity. Installation while running was refused; an update after exit preserved a synthetic localStorage profile value. The Linux home screenshot was visually inspected.
- The root-owned container test alone uses `--no-sandbox`; this is not production sandbox acceptance. Linux x64's ELF architecture and package were checked, but x64 execution and physical GNOME/KDE/Wayland, microphone, camera, sound and dock appearance are not yet verified.
- The macOS packaged smoke verifies secure context, restricted bridge, traversal denial, service-worker exclusion and profile persistence; ad-hoc signature verification passes. Real macOS notification delivery, notification permission and Dock badge appearance still need user acceptance.

Final archives:

- Linux x64 SHA-256: `ab985cf0c79af93d1ddd735f1f1832b1dbbea2f1bd735fa20fbef539789b742d`.
- Linux ARM64 SHA-256: `e22b5d3f2e37ca2f4912f96766b11458cf18c56f46011b95740ceae1e95df8f0`.
- macOS arm64 ZIP SHA-256: `18e7e579e4191fd65fe901736029e0d43c5d7939e88a4308f6d343c8635f3a31`.
- macOS app ASAR SHA-256: `2deb459115f129fbbde6e8b0f8ba3151b2ff315f92a35f7d0f22208ef979cb59`.

0.1.2 delivery: installed and signature/hash verified on both M1 and M4. M1 installation completed after the user confirmed the app was closed; its bundle version is 0.1.2 and its ASAR matches the tested candidate above. The checked installer and ZIP are retained on both Macs at `~/kithmoot-desktop-notifications-20260916`. The installer preserves 0.1.1 and refuses running or unexpected apps. The macOS and both Linux 0.1.2 archives were subsequently published as desktop previews at https://kithmoot.forgesworn.dev/downloads/ on 16 September 2026. Marketing source and release evidence live in the `kithmoot-desktop-downloads` worktree, branch `docs/desktop-downloads`. Versioned binaries are served from `/apk/desktop/0.1.2/`. The marketing-only release preserves the deployed PWA and Android APK. No commits or pushes were performed.


## Mac signing and permission continuity

Normal `npm run package:mac` now requires a Developer ID Application identity
and a `notarytool` keychain profile. There is no silent ad-hoc fallback:
ad-hoc designated requirements change between builds and macOS cannot rely on
them to retain screen-recording consent across upgrades.

Set `KITHMOOT_MAC_SIGNING_IDENTITY` to the full `Developer ID Application: ...`
name, `KITHMOOT_MAC_NOTARY_PROFILE` to the existing notarytool credential profile,
and, if needed, `KITHMOOT_MAC_SIGNING_KEYCHAIN` to its keychain path. The packager
signs Electron's nested code with hardened runtime, submits the ZIP to Apple,
requires Accepted status, staples and validates the ticket, and checks Gatekeeper
before creating the public archive filename.

For a disposable local build only, `KITHMOOT_MAC_LOCAL_PREVIEW=1 npm run package:mac`
produces an explicitly named `-local-preview.zip`. Do not publish it as a normal
Mac update. Developer ID signing still needs physical upgrade/capture acceptance;
it cannot silently transfer a permission previously granted to an ad-hoc build.

## Automatic Mac updates

Signed Apple Silicon builds check the static Squirrel.Mac feed at
`/downloads/updates/darwin/arm64/RELEASES.json`. Electron downloads the ZIP in
the background, verifies its declared SHA-256 and size, and requires the new app
to satisfy the running app's code-signing requirement. KithMoot asks before
restarting and uses the same unfinished-work and active-call gates as PWA
updates. Development builds and Linux builds keep the updater disabled.

Every Mac release must update `site/downloads/release.json`, its archive and the
static feed together. `npm test` in this directory refuses version, URL, size or
digest drift. The first updater-capable release still needs a manual install;
automatic delivery starts with the following signed release.
