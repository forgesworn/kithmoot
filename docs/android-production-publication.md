# Publishing the first production Android APK

The public download remains the debug-signed 0.5.12 preview until the owner-held
production key, exact-preview upgrade and physical-phone gates in the Android
repository are complete. This runbook starts after those gates. It does not
create a key, sign an APK or weaken them.

## Prepare one reviewable publication

The Android build must produce `kithmoot-0.6.0-production.apk` and print its APK,
production-certificate and lineage SHA-256 values. Record those values with the
physical acceptance evidence before changing this repository.

1. Copy `deploy/android-production-release.template.json` over
   `site/android-release.json`.
2. Replace the two placeholders with the independently recorded APK and
   production-certificate SHA-256 values. Leave the published preview
   certificate and its five reviewed capabilities unchanged.
3. Change the Android article in `site/index.html` to the production attributes
   and copy below. Keep the stable `/apk/kithmoot-latest.apk` link.

```html
<article id="android" class="platform" data-android-channel="production" data-android-version="0.6.0" data-android-version-code="23">
  <p class="platform-label">Android</p>
  <h3>A native client for your phone.</h3>
  <p>Android 13 or later. Version 0.6.0 is the first production-signed release. It updates the public preview in place and keeps its encrypted rooms, projects, Link consent and cadence state. A retained preview local-key account must be restored through a signer using the same identity; a different identity is refused before stored account data changes.</p>
  <p class="release-note"><strong>Production release.</strong> Signed with the owner-held KithMoot certificate and the reviewed preview-to-production lineage. No private key or room data is exported during the update.</p>
  <a class="button" href="apk/kithmoot-latest.apk?download=1">Download Android</a>
  <a class="source-link" href="https://github.com/forgesworn/kithmoot-android/releases">Release notes and source <span aria-hidden="true">↗</span></a>
</article>
```

The verifier binds the copy and manifest to the exact APK. It checks the file
hash, package, version, SDK floor and target, debuggable flag, current signing
certificate, v1/v2/v3 scheme states, both embedded lineage certificates and all
five capabilities granted to the previous signer.

```bash
nvm use 24
export ANDROID_APK=/absolute/path/to/kithmoot-0.6.0-production.apk
npm run verify:android-publication -- --apk "$ANDROID_APK"
DEPLOY_HOST=deploy@YOUR_BOX deploy/deploy.sh --dry-run
```

Review and merge the manifest/copy change before the public deployment. Use the
same immutable APK for the website and GitHub release; do not rebuild between
them.

## Publish and prove the exact result

State the exact host, source commit, APK hash and certificate before running the
real command:

```bash
ANDROID_APK=/absolute/path/to/kithmoot-0.6.0-production.apk \
DEPLOY_HOST=deploy@YOUR_BOX \
  deploy/deploy.sh
```

The deploy uploads the timestamped website and APK without activating either.
It rechecks the APK hash on the box, refuses to overwrite a different file with
the same versioned name, then switches the stable APK link and website release
together. If the website switch fails, it restores the previous APK link.

Afterwards, download the public stable URL and independently repeat the APK
hash, `aapt` and `apksigner` checks. Confirm that the live
`/android-release.json` matches it, the production copy is visible, the old
preview upgrades in place on the accepted physical phone, and the old-signed
APK is still refused. Publish the GitHub release only with that same artifact
and recorded evidence.
