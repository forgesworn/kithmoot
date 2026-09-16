# Apple notification controls, 16 September 2026

Home and room settings now expose Notifications & sound, a Zen bell toggle and preview. Message text remains opt-in. Web Home Screen badges use the platform API where supported; updates are serialised and permission failures are harmless. Web foreground chimes use local synthesis; background banners use system sound; calls and bell-off suppress sound. Closed/suspended-app push is not connected. macOS retains its native notification bridge and Dock unread count fix.

Web deployed to /var/www/kithmoot/releases/20260916-notification-settings on stall, retaining marketing, APK links and existing hashed assets. All 25 production build files verified byte-for-byte over HTTPS. Phone settings UI inspected at 390px; 320px browser test passes. Typecheck and badge queue test pass. Previous release: 20260916-android-account-sync.

macOS 0.1.3 build 4 prepared at /tmp/kithmoot-notification-release. This snapshot excludes unfinished reply-thread changes from the desktop checkout; original drafts are preserved. Six native unit tests and two Electron end-to-end tests pass, including actual app/Dock badge numbers and offline bell envelope. Initial concurrent test timed out; isolated rerun passed in 4.7 seconds. Archive SHA-256: 6280090beb997e22fc338ee172ba03dc7979f2d42e10474e81aa22ee1473daa9. Ad-hoc signed, not notarised. Installed on M4 with 0.1.2 backup retained; M1 app still running so installation awaits quit. Website desktop download remains 0.1.2; Linux not repackaged by this Apple/Android change.

Android 0.6.3 candidate prepared separately; signing and physical-device acceptance remain outstanding. iPhone physical sound/badge acceptance also remains outstanding; browser/emulator proof does not establish background delivery.

## Source shipment

The release branch reconciles the tested desktop snapshot with current main and includes public download metadata. Desktop 0.1.3 is now packaged for macOS ARM64 and Linux x64/ARM64; exact new hashes are in site/downloads/SHA256SUMS.txt. Original dirty worktrees and the unfinished thread experiment remain untouched. Android main had already allocated 0.6.3 (26), so its reconciled release advances to 0.6.4 (27), retaining rendezvous and signer setup. The earlier unsigned 0.6.3 candidate is superseded.
