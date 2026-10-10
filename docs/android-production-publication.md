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

A local APK source advertises the publisher's Blossom download URL. To keep
Zapstore downloads available during a CDN outage, the private publication
configuration can instead name the verified immutable GitHub APK URL as
`release_source`, with `BLOSSOM_URL=https://kithmoot.app/apk` for the prepared
owner mirror. The publisher includes the upstream URL first and the
content-addressed mirror second. Use the exact versioned GitHub asset, never a
moving `latest` URL.

Before signing, stage that same APK and the configured icon under their SHA-256
names in the public APK directory. Check server-side hashes and full public
downloads, and confirm HEAD returns 200 at both mirror paths. The publisher's
existence check then uses the already prepared files; the website's APK
directory is a download mirror. Keep the existing versioned APK immutable and
retain its production signing certificate and lineage.

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
downloads every advertised public artifact and verifies its byte count and SHA-256.
It checks every advertised download against the same manifest, accepting only
the exact versioned GitHub APK and owner-hosted versioned/content-addressed
mirrors alongside Zapstore's content-addressed CDN. An unavailable source,
duplicate URL, unexpected host/path, partial response, truncated file or
different payload fails verification. It signs nothing and reads no private
key. `--manifest /path/to/manifest.json`
can check a prepared release manifest before it becomes the website manifest.
An absent/stale release, invalid signature, mismatched asset, incomplete relay
query or unavailable/mismatched download fails the command.

The APK's Android signature and lineage remain the responsibility of
`verify:android-publication` above. A successful channel receipt does not prove
that Zapstore's Android client has indexed the update or that a physical phone
has installed and accepted it; the receipt leaves those gates explicitly open.

Prepared release, 10 October 2026: **0.6.79**, code **102**, from Android
main `04062201179cb41bb993c08c0c9e255bbc8a166c`. Opening a chat no longer
changes its activity time or list position. The single-message Send guard
from 0.6.78 remains. GitHub publishes the immutable production APK; website
and Zapstore publication still require their independent release gates.

The APK is 79,362,718 bytes, SHA-256
`39f819ae81ec1efb9990ea89d7872e143bddc06fcb7f6f751a1dba1a1df5cfbc`.
Full downloaded APK verification checked version/SDKs, the production
certificate, V3-only signatures and the reviewed previous-signer capabilities.
401 protocol, 1,911 debug app and 1,911 release app unit tests, both lint gates,
and hosted recovery/signing-lineage checks passed. Physical-device acceptance
remains open. The [release evidence](evidence/conversation-admission-release-2026-10-10.json)
records the separate publication states.

Earlier Prepared release, 10 October 2026: **0.6.78**, code **101**, from Android
source `7eccbea6decc40457a806692d44ec105e8149054`. Repeated Send taps claim
the composer synchronously, preventing copies of the same pending draft. A new
draft can queue as soon as its predecessor is encrypted and retained locally,
while relay confirmation is pending. Intentional repeated text remains allowed.
The immutable APK is 79,334,046 bytes, SHA-256
`f3ee6f3033236dc90f136588e69c1365477da659bed22fe489f7fda887f351e9`.
The existing M4 production key signed it; independent M1 verification checked
all 799 unchanged ZIP payload entries, version/SDKs, certificate, V3 signing
and previous-signer capabilities. The [signed-build receipt](evidence/android-0.6.78-signed-build-2026-10-10.json)
records local unit/lint/build and real-composer emulator evidence. Both update
manifests are signed. All four hosted checks passed on that exact source; the
merged native tree `9647360` matches it. Publication readbacks, Zapstore-client
indexing and physical tester acceptance remain separate gates.

Prepared release, 10 October 2026: **0.6.77**, code **100**, from Android
source `e4b080cb37acfdeb5e1d204bb28291971a4f545d`. The immutable APK is
79,305,374 bytes, SHA-256
`8f6465ac113e8060aae539ece7218d5283cc7d0a2338f7aa47d7e780bb954234`.
The M4 signed it with the existing production certificate and lineage;
independent M1 verification checked all 799 unchanged ZIP payload entries,
version/SDKs, certificate, V3-only signing and previous-signer capabilities.
Both unit-test variants and both lint checks passed. The [signed-build receipt](evidence/android-0.6.77-signed-build-2026-10-10.json)
keeps source, signed artefact and publication gates distinct. Hosted release CI,
public website/GitHub/Zapstore readbacks and physical/client acceptance require
their own evidence; this preparation paragraph does not claim publication.

Latest verified publication, 10 October 2026: **0.6.77**, code **100**, channel
`main`, APK SHA-256
`8f6465ac113e8060aae539ece7218d5283cc7d0a2338f7aa47d7e780bb954234`,
79,305,374 bytes. The [production receipt](evidence/android-0.6.77-publication-2026-10-10.json)
records all four native release gates, exact merged/build tree equality, website
main `5a59381`, all twelve publication checks and release
`20261010T052716Z`. All 305 deployed files and thirteen public assets matched;
the downloaded stable APK passed full signature and lineage verification.
GitHub and the Zapstore CDN returned the same immutable bytes. Signed Zapstore
release `4656e5b24f1f6997c38ab85ddf2c702b43437240cb0df1ffd09790571705af77`
references asset `53c77ab91055bea62b48ab2b191a4d9e3cf6ade3d8ec7ca1efffe9d60c836f4e`
under the existing publisher. Relay EOSE, signatures and the entire CDN download
were verified. Physical installation and Zapstore-client acceptance remain open.

Previous verified publication, 9 October 2026 at 23:44 UTC: version **0.6.76**,
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
