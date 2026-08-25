# KithMoot on the web — build and deploy report

25 August 2026. Repository `forgesworn/kithmoot`, branch `main`.

## Status

Built, pushed, deployed. The workflow ran green and GitHub Pages published the
artefact. The site is live on the temporary Pages URL and is **waiting on one
DNS change** before it answers on `kithmoot.forgesworn.dev`.

| | |
|---|---|
| Live now | <https://forgesworn.github.io/kithmoot/> (marketing page only — see below) |
| Live once DNS lands | <https://kithmoot.forgesworn.dev/> and `/j` |
| Pages source | GitHub Actions (`build_type: workflow`), enabled via `gh api` |
| Custom domain in Pages settings | **not set yet** — blocked on DNS |

## Commits

| SHA | |
|---|---|
| `feac4cf` | `feat: serve the app from /j so the root can carry a page about it` |
| `3c39457` | `feat: a page at the root explaining what this is` |
| `fc6caee` | `ci: publish the page and the app to GitHub Pages on every push to main` |
| `43e928c` | `docs: the live URL, the sub-path, and the DNS record it needs` |
| `5ec6a90` | `fix: build the library before the tests, or CI runs 391 of 454` |

All pushed to `origin/main`. No `Co-Authored-By` lines.

## What was built

**`site/`** — the marketing page. Plain HTML and one stylesheet, copied into
the artefact verbatim; no framework, no build step. Two fully specified
palettes rather than a dark theme with a light fallback, body type at
`clamp(1.125rem, 0.95rem + 0.55vw, 1.375rem)` and an `h1` at up to 88px, and
no grey text on a grey field at either end of the switch. Every URL in it is
relative, so it renders correctly from a sub-path as well as from the root.

The screenshots are real, from the Pixel 10 Pro XL series in
`kithmoot-android/docs/screenshots/`: `56-real-start-screen`,
`65-real-mic-and-camera-live` and `70-real-entire-screen-share-live`. Resized
to 540px wide and re-encoded to WebP — 130–670 KB of PNG became 26–37 KB — and
each links back to its full-size original in that repository. Nothing on the
page is a mockup.

Content follows the brief's order: name and tagline, the claim, what it does,
the screenshots, the platform table copied from `README.md` verbatim including
the iOS `getDisplayMedia` paragraph, what does not work yet, the Android
download routes (Releases, Obtainium, Zapstore), how it is checked, and the
source links with the MIT licence and the Nostr line.

**`base: '/j/'` in `app/vite.config.ts`** — moves the asset URLs, the web
manifest and the service worker's scope together. The scope matters as much as
the assets: a worker registered at `/` would have answered navigations to the
marketing page out of the app's own precache.

A hand-written `<link rel="manifest" href="/manifest.webmanifest">` came out of
`app/index.html` with it. vite-plugin-pwa injects its own, base-aware, in both
dev and build; the hand-written one was absolute and Vite left it alone,
because the file is generated rather than sitting in `public/`. Under a base it
pointed at a 404 — and won, because a browser takes the first manifest link it
finds.

`playwright.config.ts` and `test/e2e.spec.ts` follow the app to the sub-path.
`vite preview` now serves nothing at the root, and `grantPermissions` keys on
an origin, so it gets `new URL(baseURL).origin`.

**`.github/workflows/deploy.yml`** — on push to `main` and on
`workflow_dispatch`: `npm ci`, `npm run build:lib`, `npx vitest run`,
`npm run typecheck`, `npm run build`, assemble, `configure-pages@v5`,
`upload-pages-artifact@v3`, then a separate `deploy` job with
`needs: build` running `deploy-pages@v4`. Permissions are `contents: read`,
`pages: write`, `id-token: write`; concurrency group `pages` with
`cancel-in-progress: false`.

The assemble step copies `site/.` to `_site/` (dotfiles included, so `CNAME`
and `.nojekyll` come with it) and `app/dist/.` to `_site/j/`, then asserts
`_site/CNAME`, `_site/index.html`, `_site/j/index.html` and — the one that
matters — `grep -q 'src="/j/assets/' _site/j/index.html`. A wrong base path is
invisible until the page is live and blank, which is the worst place to find
it.

## The bug CI found

The first run failed, and correctly did not deploy.

`server/forwarder.mjs`, `server/forwarder.test.mjs`,
`server/turn-credentials.test.mjs` and `test/forwarder-blindness.test.ts`
import the library from `dist/`, which is a `tsc` output (`npm run build:lib`)
and is gitignored. On a clean checkout nothing resolves there, so three suites
fail to *load* rather than failing an assertion — vitest reports
`Test Files 3 failed | 24 passed` and `Tests 391 passed (391)`, which reads
green enough to skim past.

It never shows locally because `dist/` is already sitting there from an earlier
`npm run forwarder` or `npm run vectors`, and nothing removes it. Reproduced
by hand:

```
rm -rf dist && npx vitest run   ->  391 passed, 3 files failed to load
npm run build:lib && npx vitest run  ->  454 passed (27 files)
```

Fixed by a `Build the library` step ahead of `Test` in the workflow, and
documented in `README.md` so a fresh clone is not bitten by it.

## Verification

| Check | Result |
|---|---|
| `npx vitest run` locally | **454 passed**, 27 files |
| `npx vitest run` in CI (run 32836773864) | **454 passed**, 27 files |
| `npm run typecheck` | clean |
| `npm ci --dry-run` | lockfile in sync |
| `yamllint` on the workflow | clean (default rules, 100-col line length) |
| Workflow run | `build` 40s green, `deploy` 10s green |

The artefact was assembled exactly as the workflow does it and served from
`python3 -m http.server`, then driven in a real browser:

- `/` 200, `/style.css` 200, `/img/*.webp` 200, `/j` 301 → `/j/` 200, all app
  assets 200. Zero failed requests, zero console errors.
- **The app genuinely works from `/j/`.** Typed a name, clicked *Start a room*,
  and it produced a join link on `http://127.0.0.1:8787/j/#…` — 240 characters,
  216 of them fragment. The QR canvas rendered (320×320, non-blank). Opening
  that join link in a fresh page resolved the room: `#setup` hidden, device
  controls and *Join room* visible.
- **The service worker is confined to the app.** Registered scope is
  `/j/`, the manifest resolves at `/j/manifest.webmanifest` with `scope: "/j/"`
  and `start_url: "."`, and after the worker was installed and active,
  navigating to `/` still returned the marketing page with
  `navigator.serviceWorker.controller === null`.
- Screenshots taken and read: the page at 1280px in light and dark, at 390px on
  a phone, the app in a room at `/j/`, and the live deployment.
- No horizontal overflow at 390px (`scrollWidth === clientWidth === 390`). The
  platform table scrolls inside its own `overflow-x: auto` container, as
  intended.

Live check against the deployed artefact: `https://forgesworn.github.io/kithmoot/`
renders correctly — dark palette applied, all three screenshots loaded at their
natural 540px, zero failed requests.

## What the user has to do

### 1. The DNS record

`kithmoot.forgesworn.dev` **already exists** and points at the Hetzner box
(`62.238.98.53`, `static.53.98.238.62.clients.your-server.de`, ports 80 and 443
open, no certificate for this hostname). It has to be **changed**, not added.

| Field | Value |
|---|---|
| Zone | `forgesworn.dev` |
| Name | `kithmoot` |
| Type | `CNAME` |
| Target | `forgesworn.github.io` |
| Proxy status | **DNS only — grey cloud** |
| TTL | Auto |

**Grey cloud, not orange.** A proxied record puts Cloudflare's certificate in
front of the name, GitHub's certificate authority cannot then complete the
challenge for the custom domain, and Pages never finishes provisioning TLS.
The apex `forgesworn.dev` is already set up this way — four A records straight
to the GitHub Pages IPs, unproxied — so this matches what is already there.

Nothing was changed in DNS, and the DO server was not touched.

### 2. Set the custom domain on the repository

The `CNAME` file is in the artefact as asked, and it lands at the root of the
published site — but it does **not** set the custom domain when the Pages
source is GitHub Actions. `gh api repos/forgesworn/kithmoot/pages` still
reports `cname: null` after a successful deploy. The domain has to be set on
the repository itself, and GitHub verifies DNS at the moment it is set.

So this was deliberately left undone: setting it now, while DNS still points at
Hetzner, would either be rejected or would take the site off the working
`github.io` URL without putting anything in its place. Once the DNS record
above has propagated:

```sh
gh api -X PUT repos/forgesworn/kithmoot/pages -f cname=kithmoot.forgesworn.dev
gh api -X PUT repos/forgesworn/kithmoot/pages -F https_enforced=true
```

or Settings → Pages → Custom domain in the browser. No redeploy is needed.

## Known limitation until then

`https://forgesworn.github.io/kithmoot/` serves the marketing page correctly,
but **the app at `/kithmoot/j/` is blank there**: its assets are absolute at
`/j/assets/…`, which is the org root on `github.io`, so they 404. That is
expected — `base: '/j/'` is set for the custom domain, which serves this
repository from the root. It resolves itself the moment the custom domain is
live, and no code change is wanted for it.
