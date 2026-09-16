# Desktop preview downloads, 16 September 2026

Marketing source: worktree `kithmoot-desktop-downloads`, branch
`docs/desktop-downloads`, based on 97c1866. The original checkout's dirty
Caddy configuration is unrelated and was not changed.

The homepage links `/downloads/`, which publishes preview 0.1.2 for macOS
Apple Silicon and Linux x64/ARM64. Sizes and SHA-256 values in
`site/downloads/release.json` were calculated from the existing desktop
artifacts, not rebuilt. `site/downloads/SHA256SUMS.txt` is the human-readable
manifest. The Mac bundle declares macOS 13.0 as its minimum.

These are previews: Mac is ad-hoc signed without Developer ID/notarisation;
Linux ARM64 has a container install/launch test, while x64 has not run.
Physical native notification/platform acceptance remains outstanding.
The page documents these limitations, manual updates, and notification
lifecycle, privacy, sound and launcher-dependent badge behaviour.
Apple's opening guidance is linked instead of asking users to disable
Gatekeeper globally or strip quarantine attributes.

## Publication layout

Use the existing `/apk/*` static-file route for immutable desktop artifacts:
`/var/www/kithmoot/apk/desktop/0.1.2/`. This directory is outside website
releases, so future site deploys and rollbacks retain versioned downloads.
No Caddy changes or reload are needed. Do not replace a versioned artifact
with different bytes. New versions need a new directory and manifest.

Website release: `/var/www/kithmoot/releases/20260916-desktop-downloads`.
Baseline/rollback: `/var/www/kithmoot/releases/20260916T110444Z`.
The new release copies the live release, then replaces only `index.html`,
`style.css` and adds `downloads/`. In particular it does not rebuild `/j/`
from an older or dirty checkout. Before activation, compare the baseline
pointer, all `/j/` files, current Android download and the artifact hashes.
Activation uses an atomic replacement of the `current` symlink.

For future full deploys, include these `site/` changes in the checkout
being deployed so the downloads page remains available. The normal deploy
script copies `site/`; the binaries already reside outside that tree.
Do not add the binary archives to Git.

## Verification

- Homepage and downloads page at 320, 390 and 1440 px: no horizontal overflow
  or JavaScript errors. Download-page screenshots visually reviewed.
- Linux installation disclosure opens and exposes the installer command.
- Axe WCAG A/AA and 2.1 AA checks pass in light and dark mode.
- `git diff --check` passes.
- Existing public Android remains 0.5.12, SHA-256
  `077af82e5f4fc2ecf890217630c9db1c20d95935ffeb16aad023a08ce66d03ba`;
  this publication does not promote the separate Pixel development build.
- Existing PWA index SHA-256:
  `1ffe6eea6521487892f8e2c0eda1b6ad0fc6bd3547c9cf5c86dc8895b3c47961`.
- Existing PWA service worker SHA-256:
  `356c73bfa534c87e36b20d4b48931eceb63191b697f146b9ac1b51f061f1f517`.

Publication completed. The public homepage, stylesheet, download page and both
manifests byte-match this source. All three archives were fully downloaded
through public HTTPS on the M1 and independently on the server; each size and
SHA-256 matches `release.json`. Public PWA index/service-worker hashes remain
unchanged, and the Android download returns HTTP 200. All files under `/j/`
also match the prior release on the server. Live homepage and downloads
layouts passed at 320, 390 and 1440 px; the live mobile screenshot was visually
reviewed. The page retains the existing strict marketing CSP.

No Git commits, pushes or merges were performed. These source changes are
retained in this isolated worktree; the live deployment is complete.
