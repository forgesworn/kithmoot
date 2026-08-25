# KithMoot on the web: Hetzner and Caddy

25 August 2026. Repository `forgesworn/kithmoot`, branch `main`.

## Status

**Live at <https://kithmoot.forgesworn.dev/>**, with the app at `/j` and the
APK at `/apk`. Deployed, verified from outside, and driven in a browser.
Nothing is blocked.

The delivery mechanism changed mid-task from GitHub Pages to the Hetzner box.
The marketing page, the `/j` sub-path and the Vite `base` all carried over
unchanged; only the delivery was rebuilt.

## Commits

| SHA | |
|---|---|
| `ea53e2b` | `feat: serve the site from the Hetzner box behind Caddy` |
| `e93db7f` | `ci: drop the GitHub Pages workflow and CNAME` |
| `3819281` | `docs: how the site is published, and what is easy to get wrong in it` |

Pushed to `origin/main` as a fast-forward on top of `282ea7e`. The GitHub Pages
site was deleted through the API, so there is no second, drifting copy.

## What is on the box

```
/var/www/kithmoot/
  releases/<ts>/            site/ at the root, app/dist under j/
  current -> releases/<ts>  what Caddy's root points at
  apk/                      kithmoot-0.1.0-debug.apk, kithmoot-latest.apk -> it
```

`/etc/caddy/conf.d/kithmoot.forgesworn.dev.Caddyfile`, an additive drop-in
picked up by the main Caddyfile's `import /etc/caddy/conf.d/*.Caddyfile`. The
committed `deploy/Caddyfile.kithmoot` is byte-identical to what is installed.
No other tenant's directory, unit or vhost was touched, and cambium,
lite.mysignet.app and hang-on-fren all still answer 200.

`deploy/deploy.sh` builds, assembles, rsyncs a timestamped release, flips the
`current` symlink atomically, ships the APK, and optionally installs the vhost,
reloads Caddy and prunes old releases. `--prune` never removes whatever
`current` points at. Re-running it is safe and was done four times.

## Three failures worth recording

**1. The reload failed on a root-owned log file.** `sudo caddy validate` runs
as root and creates any log file the config names, owned by `root:root`. Caddy
itself runs as `caddy`, could not open it, and every reload then failed. It
failed *atomically*, so the old config stayed live and no other tenant was
affected. Fixed by dropping the file log entirely for `log { output discard }`,
which is what every other conf.d drop-in on the box already does and what the
page's own claims imply. The stray root-owned file was removed.

**2. Everything 403'd.** `mktemp -d` creates the staging directory 0700 and
`rsync -a` carried that faithfully to the box, where Caddy runs as its own user.
`--chmod=D755,F644` looked like the fix but macOS ships openrsync, which
rejects it as an invalid argument, and the script aborted mid-deploy leaving
`current` pointed at the previous release. Fixed by setting the modes on the
staging tree before rsync, which is portable and also makes the result
independent of the operator's umask.

**3. The one that would have broken everything silently.** The app was being
served the marketing page's `default-src 'none'` and `camera=()` despite a
`header @app` block setting the right values. A base `header` block containing
`-Server` or a `?` set is *deferred* by Caddy to response-write time, so it
runs after every matched block regardless of file order, and its `set`
overwrote the app's. Confirmed by reading `caddy adapt`'s JSON. Fixed by giving
the two policies disjoint matchers, `/j /j/*` and `not path /j /j/*`, so no
ordering or deferral can make one clobber the other.

## The CSP, and where each part comes from

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; media-src 'self' blob: mediastream:;
connect-src 'self' wss: https:; worker-src 'self'; font-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

- `connect-src wss:`: relays. A room carries its own relay list in the join
  link, so no fixed list can be right. `https:` is for the TURN credential
  endpoint when it is turned on.
- `img-src https:`: a kind-0 profile picture is an arbitrary URL belonging to
  whoever published it (`app/src/profiles.ts`).
- `style-src 'unsafe-inline'`: `signet-login` builds its signer picker by
  creating a `<style>` element and setting `cssText`. Nothing in this repo
  needs it, and it is the only relaxation that is not self-evident.
- `worker-src 'self'`: the service worker at `/j/sw.js`.

Permissions-Policy on `/j/*` is
`camera=(self), microphone=(self), display-capture=(self)` with everything else
denied. Everywhere else denies all three.

The TURN reverse-proxy route is commented out: the service is not on this box,
and a live `reverse_proxy` to a dead port is a 502 for anyone who finds the
path. `TURN_CREDENTIAL_ENDPOINT` in `app/src/main.ts` is `undefined` to match.

## Verification

| Check | Result |
|---|---|
| `npx vitest run` | **454 passed**, 27 files |
| `npm run typecheck` | clean |
| `caddy validate` (whole box config) | Valid configuration |
| `bash -n deploy/deploy.sh` | clean |
| Certificate | Let's Encrypt, `CN=kithmoot.forgesworn.dev`, valid to 23 Nov 2026 |
| Other tenants after reload | cambium, lite.mysignet.app, hang-on-fren all 200 |

From outside: `/` 200, `/style.css` 200, all three images 200, `/j` 308 to
`/j/`, `/j/` 200, `/j/sw.js` 200, `/j/manifest.webmanifest` 200,
`/apk/kithmoot-latest.apk` 200 with `content-length: 51894033`.

Headers confirmed by `curl -I` on both paths: `/` gets `default-src 'none'` and
`camera=()`; `/j/` gets the application policy above. Hashed assets under
`/j/assets/` are `public, max-age=31536000, immutable`; `/j/`, `/j/index.html`,
`/j/sw.js` and the manifest are `no-cache, no-store, must-revalidate`.

Driven in a real browser against the live URL:

- **The marketing page**: zero CSP violations, zero console errors, zero failed
  requests. All three screenshots load at their natural 540px once scrolled to
  (they are `loading="lazy"`, which is why a full-page capture shows the lower
  two blank).
- **The app genuinely works.** `featurePolicy.allowsFeature` returns true for
  camera, microphone and display-capture. The service worker registers with
  scope `https://kithmoot.forgesworn.dev/j/` and the manifest reports
  `scope: "/j/"`. Started a room, which produced a 250-character join link on
  `https://kithmoot.forgesworn.dev/j/`, clicked **Join room**, and the roster
  rendered `Darren fdde889f9eed… (you) · 1 device`. Three relay sockets opened,
  to `wss://relay.trotters.cc`, `wss://nos.lol` and `wss://relay.primal.net`,
  which is the only thing that actually proves `connect-src wss:`. Sent a chat
  message and it round-tripped through the relays and back into the log. Zero
  CSP violations throughout.

Screenshots taken and read: the live page at 1280px full-length, the screenshot
strip, the live app in a joined room, and the chat.

## Notes for the user

- **The APK is a debug build**, `kithmoot-0.1.0-debug.apk`, 49&nbsp;MB, signed
  with Android's shared debug key because `app/build.gradle.kts` has no release
  `signingConfig`. There is no release variant under
  `app/build/outputs/apk/`. The page says all of this plainly, including that a
  future release-signed build cannot update over it.
- **Two untracked files sit in the repo root**: `COPY-REPORT.md` and
  `kithmoot-PRE-REWRITE-backup.bundle` (627&nbsp;KB), left by the copy and
  imagery pass. I did not commit or delete them. Worth removing or ignoring
  before someone runs `git add -A`.
- The copy and imagery pass reverted `deploy/deploy.sh` and
  `deploy/Caddyfile.kithmoot` in the working tree at 11:43 while this work was
  in progress. Both were rewritten and the vhost was restored from the box, so
  the repository and the running config now agree exactly.
