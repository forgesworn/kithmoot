# KithMoot

KithMoot is an open, serverless workspace built on Nostr: rooms, chat, files
and Jitsi-grade calls, with agents as members on the same terms as people. No
operator holds the guest list or the room state; membership follows whoever
holds the link. The library lives in `src/`; the PWA is under `app/`.

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm ci` | Install dependencies |
| `npm run build:lib` | Build the library and declarations into `dist/` |
| `npm run build` | Production PWA build, to `app/dist` |
| `npm test` | Unit and protocol tests, in-process relay simulator, no network |
| `npm run test:live` | Wire format against real public relays (needs network) |
| `npm run test:e2e` | Acceptance tests in a real browser against a local test relay |
| `npm run typecheck` | Type-check the library and the app |
| `npm run demo` | HTTPS dev server for driving the app by hand |
| `npm run agent -- --help` | `kithmoot-agent`: join a room without a browser |

`npm test` builds the library first through its `pretest` script.
`npm run test:live` and `npm run test:e2e` are excluded from `npm test`
(network weather and browser cost respectively); CI runs `test:e2e` against
the offline relay in `test/ws-relay.mjs`.

## Structure

```
src/            library source (protocol, identity, rooms, agent runtime)
app/            the PWA (Vite), served under /j/
server/         forwarder (server/forwarder.mjs)
bin/            CLI entry points (kithmoot-agent, kithmoot-context)
packages/       workspace packages (@forgesworn/context, @forgesworn/context-tools)
desktop/        desktop client
docs/           design docs, decisions, protocol notes
deploy/         deploy.sh and the Caddy vhost
test/           test suite, including the offline relay and e2e specs
vectors/        protocol test vectors
```

## Conventions

- British English in prose and comments.
- `npm run build:lib` must run before anything that imports from `dist/`
  (the forwarder, some acceptance fixtures, `bin/kithmoot-agent.mjs`).
- The `nostr-tools` version is pinned via `overrides` and guarded by
  `src/nostr-tools-version-guard.test.ts`: versions `>=2.23.11 <2.24.2`
  silently kill long-lived subscriptions, which a room depends on.
- `npm run demo` serves over HTTPS with a self-signed certificate;
  `getUserMedia`/`getDisplayMedia` need a secure context.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Public library entry point (protocol, identity, room, agent exports) |
| `src/agent.ts` | `RoomAgent`, the headless counterpart to a browser's `RoomSession` |
| `src/identity.ts` | `ParticipantIdentity`: the pubkey + `signEvent` surface an identity satisfies |
| `src/display-name.ts` | `sanitiseDisplayName`: strips hostile Unicode, caps length |
| `docs/decisions.md` | Why the protocol is not built on NIP-29 or Marmot |
| `docs/agents.md` | Design of agents-as-members and the brain types `kithmoot-agent` supports |

## Common Pitfalls

- Do not read `dist/` as source; it is a build output and not committed.
- `test:e2e` runs against a deterministic offline relay by default; a red run
  under `E2E_RELAYS=live` can be relay weather, not a regression.
- The APK is never committed; publishing checks a signed artifact against
  `site/android-release.json` (see `docs/android-production-publication.md`).
