# Publishing the first production Android APK

The first-production procedure below is historical. The current production
version and artifact identity come from `site/android-release.json`; subsequent
releases use the same immutable APK across the website, GitHub and Zapstore.
This runbook does not create an Android key, sign an APK or replace the
physical-phone gates in the Android repository.

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

## Publish and verify Zapstore separately

A website deployment or GitHub release does not publish a Zapstore release.
Treat Zapstore as a separate delivery gate for every production Android version.
Use [Zapstore's publisher](https://zapstore.dev/docs/publish) with the exact
already-verified APK, the Android repository's `zapstore.yaml` metadata and
release notes for that version. Point `release_source` at that one APK rather
than relying on whichever local build happens to match a glob. The repository
changelog may lag the signed GitHub release notes.

The existing KithMoot listing belongs to
`npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`.
Preserve that publisher. The Nostr publisher key is separate from the Android
APK signing certificate. Keep signer connections and client keys in private
local configuration, outside repository files, command history and release logs.

Check the connected signer's actual public key before uploading or publishing.
In `zsp` 0.4.12, the config's publisher check resolves local `nsec`/`npub` values
but does not enforce the returned key for asynchronous bunker/browser signers.
The 0.6.75 publication used a local post-connection publisher check before the
normal publisher workflow. A rejected or expired bunker connection is a failed
connection, not evidence that a release-signing request reached the signer.

After publication, run the read-only channel verifier from this repository:

```bash
npm run verify:zapstore-publication -- --output /tmp/kithmoot-zapstore-receipt.json
```

It waits for the Zapstore relay to complete its query, verifies Nostr event
signatures and the existing publisher, checks the latest `main` release against
the production manifest, follows its signed APK asset reference, and compares
the advertised version/code, SDKs, certificate, filename and size. It then
downloads the public CDN artifact and verifies its byte count and SHA-256.
It signs nothing and reads no private key. `--manifest /path/to/manifest.json`
can check a prepared release manifest before it becomes the website manifest.
An absent/stale release, invalid signature, mismatched asset, incomplete relay
query or unavailable/mismatched download fails the command.

The APK's Android signature and lineage remain the responsibility of
`verify:android-publication` above. A successful channel receipt does not prove
that Zapstore's Android client has indexed the update or that a physical phone
has installed and accepted it; the receipt leaves those gates explicitly open.

Latest verified publication, 9 October 2026 at 23:44 UTC: version **0.6.76**,
code **99**, channel `main`, APK SHA-256
`733a1a778e53edfe083d59b5480279dbc18126b3b38634f1b55206b0d6c474d5`,
79,137,438 bytes. Signed release
`6158b03a5c051967200e2878eb59d506f3758799adcf226fa8b55ea907d9d939`
references asset
`984be9a9e7124073a2cc50d3d184b22aea43618c4a85998a6ddc896ecfd08db9`.
The existing publisher, both event signatures, release reference, certificate,
version/code and complete CDN download matched the production manifest. The
same APK was independently downloaded from the
[GitHub release](https://github.com/forgesworn/kithmoot-android/releases/tag/v0.6.76)
and matched its recorded hash and size. Zapstore-client indexing and physical
installation remain unverified. This Android release adds signed capture notices;
it does not provide native recording/export.

Earlier verification, 9 October 2026 at 21:22 UTC: version **0.6.75**, code **98**, channel
`main`, APK SHA-256
`9eeb8ef7a301568455247b94f791153cb8ba99153258ad95085d45e05d5f78db`,
79,088,286 bytes. The signed release event is
`c493f7e442ed447971fdf2cbc3ad48adbf1c580b221f0cc24a6b92668e2be674`,
referencing APK asset
`2a11e34ac43c689f7213584970a9dd4f678bfe0624f508367898bc063eb5bca0`.
The public download matched the production manifest. Store-client and physical
installation acceptance were not claimed by that publication check.
