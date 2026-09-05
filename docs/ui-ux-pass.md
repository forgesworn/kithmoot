# UI and UX pass — 5 September 2026

The main problems were discovery and navigation: agent conversations were
inside Room details, saved rooms required a picker on every visit, and rooms
could not be organised into projects.

| Task | Result | Evidence |
| --- | --- | --- |
| Watch agents talking | Visible Agents button and Watch agents action; live shared messages, agent names and a direct invitation action | `test/workspace.spec.ts`: two Node agents exchange messages; the browser reads and replies over the local relay |
| Notice activity elsewhere in the room | Unread counts for Chat, Agents, Transcript, Minutes and verified named conversations; drafts marked separately | Workspace test checks arrival while another conversation or a dialog is open, and clearing after reading |
| Move between projects and rooms | Desktop sidebar, searchable picker, project filters on the picker and home page, Ctrl K / Command K shortcut | Workspace tests cover grouping, filtering, reload, desktop-to-mobile navigation and returning to the last conversation |
| Organise rooms | Assign an existing project, create one by name, or remove a room from its project | Workspace tests cover assignment/removal; project unit tests check account isolation and bounded labels |
| Preserve current work | Conversations retain their own text and files; room switches with unfinished work offer a new tab; live calls ask before leaving | `drafts.spec.ts`, `room-switching.spec.ts` |
| Use a phone or keyboard | Horizontal conversation navigation, keyboard arrows, focused search on opening, explicit focus return from dialogs, wrapping at large text sizes | Workspace renders at 320, 390, 768 and 1440 pixels, both themes, 320×540 and 200% text; room-switching checks focus restoration |
| Keep existing tools usable | Entry/sign-in, search, file staging and cancellation, reactions, profile choices, named conversations and screen sharing | Home, Nostr rooms, conversation search, drafts, chat comfort, channels, rooms and share viewer browser suites |

Projects are personal labels stored on this browser, separately for visitors
and each Nostr account. They do not synchronise or change membership. The
last conversation is remembered per room and identity for the current tab.
Unread counts cover loaded messages in the current visit, not a remote
archive or live monitoring of every saved room. The presence summary says
which agents are present; it does not infer that they are thinking or busy.

Validation used Node 24, the production Vite build, and a local relay.
`npm test` passed 1,240 tests; `npm run typecheck` and `npm run build` passed.
The existing build warning about a JavaScript chunk exceeding 500 kB remains.

The wider Chromium/Firefox run passed 61 checks, with two media checks
reserved for Chromium. The WebKit run covered the same applicable UI flows;
its initial failures exposed a focus-return issue and an SVG test that
mistook an engine-specific intrinsic size for evidence of decoding. Both
were fixed and rechecked. Final focused navigation runs also cover the
subsequent unread-state refinement: the final workspace checks passed in
Chromium, Firefox and WebKit. The final narrow-screen render also keeps
the agent summary and invitation action on one row to leave more space
for messages.

On macOS 14.6.1, the installed Playwright 1.62.1 runner cannot initialise its
frozen WebKit v2251: it sends an unsupported `PushAPIEnabled` setting before
loading the page. WebKit verification therefore used an isolated Playwright
1.58.2 installation in `/tmp/kithmoot-webkit-check`, the same v2251 browser,
copies of the repository tests and the same built app. The repository's
Playwright version and lockfile remain unchanged. This is browser-engine
verification, not physical iPhone or installed-PWA acceptance.

Reproduce the standard checks against a Vite preview server (the development
server does not provide the test relay's TLS proxy):

```sh
npm run typecheck
npm test
npm run build
# With the local relay and preview server running:
E2E_BASE_URL=https://localhost:4179/j/ npx playwright test \
  test/workspace.spec.ts test/home.spec.ts test/room-switching.spec.ts \
  test/channels.spec.ts test/drafts.spec.ts test/conversation-search.spec.ts \
  test/chat-comfort.spec.ts test/rooms.spec.ts test/nostr-rooms.spec.ts \
  test/share-viewer.spec.ts --project=chromium --project=firefox
```

The workspace specification is included in all three CI browser projects.
Screenshots and traces from this pass are under `/tmp/kithmoot-ux-final`,
`/tmp/kithmoot-ux-final-navigation` and `/tmp/kithmoot-webkit-final`; the last
unread-state checks use `/tmp/kithmoot-ux-acceptance` and
`/tmp/kithmoot-webkit-acceptance`.

These are local implementation and verification changes. No deployment,
real room messages, external agent invitation or physical-device action was
performed as part of this pass.
