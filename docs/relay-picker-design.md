# Relay picker: show good relays, choose them in one tap

Status: design, 21 October 2026. Branch `design/relay-picker` from
origin/main 44bddc8. Web (PWA, and the desktop app that wraps it) and
Android (`kithmoot-android`, origin/main ae9f6645).

## 1. Goal

A person who starts or joins rooms sees, in plain words, which relays answer
from their device right now and what each one is like. They add a good
public relay or their own in one tap, and they always know which relays a
room is fixed to and that everyone in it uses those relays. The primary
action is **Add** (to the person's own relays), and when a room starts,
**Start a room** fixes only relays that answered.

In scope: the relay dialog (`#relaySettings`) and the new-room form on the
web, the Relays page and the new-room form on Android, the room's relay
status, and one shared list of public relays run by other people.

## 2. Assumptions and open questions

Each has the choice this spec makes. The owner accepted every choice below
on 21 October 2026, including the write test in Q1 and the three defaults in
Q2. Because Primal kept kind 1463 for under a day on 1 October, the release
check re-measures retention for every default at each release.

| # | Question | Choice made |
|---|---|---|
| Q1 | May the release check write one test event of each room kind to each candidate relay (throwaway key, NIP-40 expiry of 10 minutes, then a NIP-09 delete)? | Yes (owner agreed 21 October 2026). Until PR W2 runs the write test, the list ships on read-only evidence and each entry says so (`test: "read"`). PR W1 can ship on read evidence alone, because two of the three current defaults are down and that is doing harm now. |
| Q2 | Which three relays become the defaults? | `relay.primal.net`, `nostr.oxtr.dev`, `relay.nostr.net` (section 8.3). All three name a contact, are free, held chat, rekey and invitation events on 21 October and answered in under 1.6 s. Two of the three hold gift wraps without sign-in. |
| Q3 | When someone with their own relay starts a room, is a public relay added next to it by default? | Yes, as a visible ticked box in the new-room form, which they can untick. This follows `docs/run-your-own.md` ("keep one public relay beside your own"), and the box makes sure it never happens silently. |
| Q4 | What replaces the legacy fallback (`PUBLIC_FALLBACK_RELAY = wss://nostr.mom/` on the web, `RoomRelays.PUBLIC_FALLBACK` on Android), which adds a third relay to rooms made on the old two-relay pair? | Point it at `wss://nostr.oxtr.dev/`. It joins the person's **own** relays for that room (it is added in `#configuration`, never in `c`), so it is listed under **Also used by you in this room** with the tag "Added by the app for rooms made before October 2026", and Remove works on it. Dropping it would leave those rooms with nos.lol, which is down, and primal, which keeps events for less than a day. |
| Q5 | Should `relay.trotters.cc` be written into a deny-list test in this public repo? It is the owner's relay. `docs/decisions.md` (17 and 25 September entries) already calls it "the project's own relay", so a test entry exposes nothing new. | No, for now: the owner decides. The guard test checks only ForgeSworn's own domains (`forgesworn.dev`, `kithmoot.app`, the same list as `isForgeSwornHost`). The list criteria (8.1) exclude any relay run by ForgeSworn or its maintainers, and the release checklist names the owner's hosts in a private note. Owner's call. |
| Q6 | Changes apply at once, or with an Apply or Save button? | At once, on both platforms, with Undo after a removal. One-tap selection is the request. The web's **Apply changes** and **Reconnect**, and Android's **Save relay choices** with its discard dialog, are removed. |
| Q7 | Can people edit their own relays for a room while they are in it? | Yes, on both platforms. The web already allows it. Android's read-only in-room page ("Leave the room to change relays") moves to match the web (PR A3). |
| Q8 | Can the authority remove a relay it added for everyone? | Not in this design. The `relays` op replaces the added list, so removal is possible on the wire, but Android's handling of a shorter list has not been checked. v1 only adds. A relay a room was **made** on (`c`) can never be removed: that would need a protocol change, and it is out of scope. |
| Q9 | "Quiet rooms" appear in copy only where that feature ships. | The "Carries quiet rooms" fact is rendered only when the build has quiet rooms (`feat/quiet-rooms`). Until then the data is kept but not shown. |
| Q10 | Rename "Box of my circle"? `docs/glossary.md` has no entry for box, circle or sheltered. | "Run by my circle" on the web, matching Android's existing "circle relays" wording. "Circle" and "sheltered" are kept as the project's terms. |
| Q11 | How many relays can a person save? The web refuses more than 8 (`MAX_RELAY_HINTS` in `save()`). Android allows 16 (`RelaySelection.validate`, `MAX_RELAYS`). | 8 on both, for parity with what a link can carry. Android keeps any longer list already saved and keeps using it, but refuses new additions while 8 or more are saved, with "You can use up to 8 relays here." Nothing saved is cut on upgrade. |

## 3. Current state (critique)

Evidence: `app/dist` from the main `kithmoot` checkout, which is at 2865775,
one commit past this worktree's base. That commit only adds a line to
versions.json, so the relay code is the same. It was served on 127.0.0.1:5491
and opened in Chromium headless shell 1243, with the dialogs opened by
script. The screenshots, and a second set with axe, were kept locally and
are not committed. Android was read from source only.

| # | Severity | Platform | Where | Problem | Principle | Evidence |
|---|---|---|---|---|---|---|
| 1 | blocker | both, plus agents | `DEFAULT_RELAYS` (`app/src/main.ts:652`, `src/agent.ts:51`, Android `RoomViewModel.kt:832`), install scripts | Two of the three defaults (nos.lol, nostr.mom) are unreachable. They are one host (142.132.206.70, `docs/decisions.md`). New rooms fix dead relays for good. Keepers crash-loop. | Feedback and trust; every state designed | Brief's measurement, 21 Oct; decisions.md, 5 Oct |
| 2 | blocker | both | room creation (`startNewRoom`, Android `startRoom`) | A room is fixed to whatever the person's list holds, unchecked. A dead relay becomes a permanent part of every member's pool. | Feedback and trust | code |
| 3 | major | both | relay dialog / Relays page | No suggestions at all. The only way to add a relay is to type a `wss://` address you already know. The owner's request ("show the best relays") has no surface. | Simplicity; familiar patterns | `relays-phone-light.png` |
| 4 | major | web | relay dialog, defaults scope | Every default relay reads "Not in use here" when no room is open. There is no way to learn whether a relay works before trusting a room to it. | Feedback and trust | `relays-phone-light.png` |
| 5 | major | web | relay row | Seven controls per row: order label, Move up, Move down, access select, Remove, Box of my circle, Use signed-in account. Three relays take 1934 px on an 844 px phone, about 2.3 screens. | Subtraction pass; one focal point | report.json `sh: 1934`; `relays-phone-light-end.png` |
| 6 | major | web | relay dialog | Two paragraphs of jargon before the list ("Signet sign-in uses the first default relay", "shared room relays stay first"). On a landscape phone the list starts below the fold. | Words are design; landscape phone | `relays-phone-landscape-dark.png` |
| 7 | major | both | room's relays | The room's fixed relays look like any other row ("This room's relay: everyone in it uses it"). Nothing says they can't be removed, that they were set at creation, or which ones the authority added. A dead fixed relay looks the same as a dead personal one. | Hierarchy; feedback | `relay-settings.ts:515-523` |
| 8 | major | web | `.relayHealth[data-state]` | Hard-coded `#168368` and `#b95040` instead of tokens. Computed contrast at `--fs-1`: 4.32:1 and 3.77:1 (green on light and dark panel), 4.52:1 and 3.60:1 (red). Three of the four fail 4.5:1. Axe did not flag this because no row was connected or disconnected when captured. | Contrast 1.4.3 | `style.css:3817-3818`; computed |
| 9 | major | web | relay rows | Every row's health span is `aria-live="polite"` and is rewritten every second by `setInterval`. That can flood a screen reader with announcements. | Status announced without noise 4.1.3 | `relay-settings.ts:519, 527, 503` |
| 10 | major | Android | authority | Android can repost a room's `relays` op but cannot write a new one, so a room made on Android has no way to add a relay for everyone. | Parity | `RoomWork.kt:244-258`; no signing path found |
| 11 | minor | web | scope select | "Defaults for new rooms and account sync" is cut off on a phone ("…account s"). | Clean at the extremes | `relays-phone-light.png` |
| 12 | minor | web | "How to run your own relay" link | 188 x 18 px target: fails 44 px on touch and 24 px with a pointer. | Target size | shots-2 report |
| 13 | minor | web | authority share | **Use these relays for everyone** sends this device's whole personal list. The confirm opens a dialog on top of the dialog. | No modals on modals | `main.ts:8083`, `relay-settings.ts:476` |
| 14 | minor | both | copy | "Read / write", "Access", "Box of my circle", "Use signed-in account", "Connected means the socket is open" are developer words. | Name things the way users speak | screenshots |
| 15 | polish | web | dialog | The header scrolls away with the list. Close is out of reach at the bottom of a long list. | Landscape phone | `relays-phone-light-end.png` |

What already works and must be kept: the honest evidence model (`RelayHealth`,
`READ_EVIDENCE_RANK`, `unreturned`, `writeRefusal`). Room relays are kept
apart from personal ones and never written into a saved list. The NIP-42
consent flow. Order and circle marks. The file-server precedent
(`PUBLIC_FILE_SERVERS`). Axe found no violations inside the dialog in any
mode captured.

## 4. Structure

### Information architecture

One relay surface with two scopes. Its title is **Relays** on both
platforms.

- **New rooms** (always). The person's own relays, which new rooms start on
  and account sync uses. Then suggested public relays. Then a field to add
  your own. Then **Check relays**.
- **This room** (only when opened from a room). First, the relays fixed for
  the room, which everyone uses. Then the relays this device also uses here.
  Then **Use these for new rooms**.

Entry points, which do not change:

- Web: Settings, Connections, **Nostr relays** (`#defaultRelaySettings`), which
  opens the New rooms scope. The room sheet's **Relays for this room**
  (`#roomRelaySettings`) opens This room. The arrival failure's **Add a relay**
  (`#arrivalRelays`) opens This room.
- Android: Settings, Connections, **Relays**, and the room menu's Relays
  page (`AccountMenu.kt` page `"relays"`).
- New: the new-room form gets a **Relays** disclosure (section 5.5).

### Primary paths

1. **Pick good relays.** Open Relays, press **Check relays**, see which
   answer, press **Add** on a suggestion. Done: there is nothing to save.
2. **Use my own relay.** Type its address, press **Add**. It is checked at
   once and its status appears. The next room started carries it.
3. **Start a room.** **Start a room** checks the chosen relays and fixes only
   those that answer. The person is told what was left out.
4. **Mend a room on a dead relay.** The room sheet row says "1 of 3 isn't
   answering". In the dialog the authority presses **Add a relay for
   everyone**, picks one that answered, and confirms inline. A member is told
   only the maker can do that, and can add a relay for themselves.

## 5. Layout by width and orientation

### 5.1 Web dialog, compact portrait (under 600 px wide)

The dialog keeps `.profileSettings` (`min(30rem, 100vw - 2rem)`, max height
`100dvh - 2rem`). The header row (title, scope switch, Close) becomes sticky
inside the dialog, as `#mlsWitnessSettings .profileSettingsHeader` already
does. Rows are one column.

```
+--------------------------------------+
| Relays                       [Close] |  sticky
| [ This room | New rooms ]            |  only in a room; aria-pressed pair
|--------------------------------------|
| Relays are servers, run by other     |
| people or by you, that pass on your  |
| rooms' encrypted messages.           |
|                                      |
| Your relays                          |  h3
| New rooms start on these. Account    |
| sync uses them too.                  |
|                                      |
| relay.primal.net            [Remove] |
| Run by Primal · Free                 |
| Answered quickly at 14:02            |  status, coloured text + words
| > Options                            |  <details>
|                                      |
| nostr.oxtr.dev              [Remove] |
| ...                                  |
|                                      |
| Suggested public relays              |  h3
| Run by other people, not by          |
| KithMoot. Each one names who runs it.|
|                                      |
| offchain.pub                   [Add] |
| Free · Checked 21 Oct                |
| Not checked yet                      |
|                                      |
| Add your own                         |  h3
| Relay address                        |
| [wss://relay.example.org     ] [Add] |
| Your own relay, or one a friend      |
| runs. Rooms you start carry it to    |
| everyone you invite.                 |
|                                      |
| [Check relays]                       |
| Checking connects this device to ... |
| (status line, role=status)           |
| How to run your own relay            |
+--------------------------------------+
```

Order: Your relays in the person's saved order. Suggestions in the data file's order. After a check, suggestions that didn't answer move to the bottom of their section; nothing else reorders, and nothing is ranked by speed.

The host is shown without `wss://` or a trailing slash. The full URL is the
row's `title` and its accessible description, and it appears in Options.
Remove and Add sit on the host's line, right-aligned. When the host and the
button cannot share a line (320 px, or 200% text), the button wraps under
the host, left-aligned. Text is never cut short.

### 5.2 Web dialog, compact landscape (height 500 px or less)

- `@media (max-height: 500px)`: the dialog's max height becomes
  `100dvh - 1rem`. The sticky header drops to one line: title at `--fs-3`,
  the scope switch inline after it, Close 44 px tall. The header must take
  no more than 64 px, well under a third of 390 px.
- The intro sentence is hidden in this media query. It repeats what the
  section headings already say.
- Safe areas: the dialog's inline padding includes
  `var(--safe-area-inset-left, env(safe-area-inset-left, 0px))` and the same
  for the right, so it clears a notch in landscape.

### 5.3 Web dialog, medium (600 to 839 px)

Same single column. The dialog widens to `min(36rem, 100vw - 2rem)`, so
rows have room for host and button on one line.

### 5.4 Web dialog, expanded (840 px wide and over, and 560 px tall or more)

Two columns inside a wider dialog (`min(56rem, 100vw - 4rem)`):

```
+------------------------------------------------------------------+
| Relays                     [ This room | New rooms ]     [Close] |
|------------------------------------------------------------------|
| Your relays                     | Suggested public relays        |
| New rooms start on these...     | Run by other people...         |
|                                 |                                |
| relay.primal.net       [Remove] | offchain.pub            [Add]  |
| Run by Primal · Free            | Free · Carries quiet rooms     |
| Answered quickly at 14:02       | Answered slowly at 14:02       |
| > Options                       |                                |
| ...                             | relay.damus.io          [Add]  |
|                                 | ...                            |
| Add your own                    |                                |
| [wss://...             ] [Add]  | [Check relays]                 |
|                                 | Checking connects...           |
|                                 | How to run your own relay      |
+------------------------------------------------------------------+
```

In the This room scope the left column is **Fixed for this room** followed by
**Also used by you in this room**. The right column holds suggestions and
the authority's **Add a relay for everyone** panel. Each column scrolls with
the dialog, not on its own. Lines stay under 75 characters (each column is
about 26rem).

### 5.5 New-room form (web `#createRoomForm`, Android `NewRoomForm.kt`)

The form stays short. A disclosure goes between **Ends** (or **When it
ends**) and the buttons:

```
| Ends  [Never      v]                 |
| > Relays: relay.primal.net,          |  <details>, closed by default
|   nostr.oxtr.dev and 1 more          |
|   (open)                             |
|   Fixed when the room starts: ...    |
|   [x] relay.primal.net               |
|   [x] nostr.oxtr.dev                 |
|   [x] my-relay.example.org           |
|   [x] Also add a public relay:       |  only when none ticked is on the list
|       relay.primal.net (recommended) |
|       So people who can't reach your |
|       relays can still find the room.|
| [Start a room]  Cancel               |
| (status line, role=status)           |
```

The candidates are the person's New rooms relays that are set to read and
send. Relays set to read only or send only are left out, as today
(`invitationRelaysFrom(...filter(read && write))`).

### 5.6 Android Relays page

A full Settings page (Material 3 top app bar, title **Relays**, Up arrow).

- Compact (under 600 dp), portrait and landscape: one `LazyColumn` with the
  same sections and order as the web. Each relay is a `ListItem`: headline
  is the host, supporting text is the facts and status, trailing is a
  `TextButton` (**Remove** or **Add**). Tapping the row's body opens a
  `ModalBottomSheet` titled with the host, holding the Options (access radio
  group, Move up, Move down, the circle switch). **Check relays** is a
  `FilledTonalButton` at the end of the list. In a room the scope switch is
  a `SingleChoiceSegmentedButtonRow` under the app bar. In landscape the app
  bar is the standard small top app bar, so nothing is sticky but it.
- Medium (600 to 839 dp): the same list, padding 24 dp.
- Expanded (840 dp and over): two panes side by side, Your relays (or Fixed
  for this room) on the left and Suggested on the right, using
  `ListDetailPaneScaffold` if `material3-adaptive` is already a dependency,
  otherwise a `Row` of two weighted `LazyColumn`s branched on
  `currentWindowAdaptiveInfo()` or `screenWidthDp`.
- Removal shows a `Snackbar` "Removed nostr.mom" with **Undo**.
- `RelayEditorState`'s draft, dirty and discard model is removed: every
  change is saved at once through `actions.saveRelays`. Rotation keeps the
  scroll position, an open bottom sheet and typed text (`rememberSaveable`).

## 6. States

For one relay row, the first line that applies is the status. Section 9
gives the exact words.

| State | When | Shown |
|---|---|---|
| Not checked | No check result and no live evidence on this device | "Not checked yet" (muted) |
| Checking | A check for this relay is running | "Checking…" |
| Answered | The check connected and got EOSE | "Answered quickly at 14:02" (under 2 s) or "Answered slowly at 14:02" (2 s or more), in `--ok` |
| Didn't answer | The check failed: no connection, no EOSE within 10 s | "Didn't answer when checked at 14:02", in `--danger` |
| Not answering in use | In use, and every connection attempt failed for 10 minutes | "Hasn't answered since 19 Oct, 14:02", in `--danger` |
| Needs sign-in | NIP-11 `limitation.auth_required`, or a read answered `auth-required:` | "Needs sign-in: it asks which Nostr account you are", in `--warn` |
| Paid | NIP-11 `limitation.payment_required` | "Asks for payment before it takes messages", in `--warn` |
| Turned a message away | `lastError` from `writeRefusal` | Section 9, in `--danger` |
| Didn't keep a message | `unreturned` present | "Doesn't keep chat: took a message, then didn't return it" or "Took a message, then didn't return it", in `--danger` |
| Connected | Live socket in this scope | "Connected", plus " · last message taken at 14:03" when `lastPublishedAt` is set |
| Connected elsewhere | `connectedElsewhere` | appended: " · connected elsewhere in KithMoot" |
| Identified | NIP-42 authenticated | appended: " · knows your account" |

Facts after a check go on the second line: "Holds room messages" (held at
least one of 1460, 1462, 1463), and "Carries quiet rooms" (held 1059 without
sign-in) or "Quiet rooms need sign-in here" (1059 read refused). The second
is shown only where quiet rooms ship (Q9).

Live evidence newer than the last check wins. A check result is kept on the
device for 7 days and is shown with its time. If it is more than a day old,
its date is shown too ("Answered quickly on 19 Oct").

Whole-surface states:

| State | Behaviour |
|---|---|
| First run | Your relays shows the three defaults, all "Not checked yet". Suggestions show the other curated relays. Nothing connects until the person presses Check relays, or until a room or account sync uses the relays. |
| Empty suggestions | Every curated relay is already in the list: the section reads "You use all the suggested relays." |
| Loading | **Check relays** becomes "Checking…" (disabled, `aria-busy="true"`). Rows show "Checking…". The status line counts answers ("3 of 5 answered so far") at most once a second. |
| Success | Status line: "Checked 5 relays at 14:02: 4 answered, 1 didn't." |
| Error, all failed | "None of these relays answered. Check your internet connection and try again." |
| Offline (`navigator.onLine === false`, or no network on Android) | Check relays is disabled with the note "You're offline. Relays can be checked when you're back online." Rows keep their last results. |
| Last reader or sender | Removing would leave no relay for reading or sending: Remove is disabled, with the reason as its description: "Keep at least one relay for reading and one for sending." |
| Full | 8 relays saved (`MAX_RELAY_HINTS`): Add is disabled, with "You can use up to 8 relays here." On Android a longer list saved before this change is kept as it is (Q11). |
| Duplicate | "relay.primal.net is already in your list." |
| Invalid address | "Use an address that starts with wss://" (beside the field, `aria-invalid`). |
| Permission denied | Not applicable: no OS permission is involved. NIP-42 consent stays as it is (`docs/relay-authentication.md`). |
| Tor-only room (Android anonymous) | Checks go through the room's Tor sockets. Suggestions are hidden, because clearnet relays are refused by `TorOnlyRelayUrls`. The note reads "This room uses Tor, so only .onion relays can be added." |
| Sheltered room (circle or Bothy) | Suggestions are hidden. The room's guard decides what can join (`2026-10-01-room-relays-design.md`). |

### Room scope states

| State | Shown |
|---|---|
| All fixed relays answering | Section note only. |
| One or more fixed relays not answering (authority) | Under that row: "This relay isn't answering. Add a working relay so everyone in the room can still reach each other." with button **Add a relay for everyone**. |
| Same (member) | "This relay isn't answering. Only the room's maker can add a relay for everyone. You can add one for yourself below." |
| Every fixed and added relay not answering, own relays connected | Room notice (in the room, above the composer, the existing status area): "This room's own relays aren't answering. People who use only those won't get your messages." **See relays** |
| Nothing answering at all | Room notice: "None of this room's relays are answering. New messages may not reach anyone." **See relays** |
| Room sheet row | `#roomRelaySettings` gets a subtitle: "1 of 3 isn't answering", or nothing when all answer. Android: the same text in the room menu's Relays item, replacing "· N issue(s)". |
| Authority picker: room already has 8 added | "This room already has 8 relays added for everyone, the most it can carry." Picker is disabled. |

### Creation states

| State | Behaviour |
|---|---|
| Checking | **Start a room** becomes "Checking relays…" (disabled, `aria-busy`). The status line reads "2 of 3 relays answered". Every candidate is checked at once, each with `RELAY_ANSWER_MS` (10 s). |
| Waiting on a slow relay | After 3 s, if at least one candidate answered and no ticked public relay is still pending, the button becomes **Start now with 2 relays**. Pressing it starts the room with those. Otherwise the room starts when every candidate has answered or timed out. |
| Some answered | The room starts, fixed to those that answered, in the person's order, at most 8. Status after opening: "Started on 2 relays. nostr.mom didn't answer, so this room isn't fixed to it." The unanswering relay stays in the person's own list, marked "Didn't answer when checked at 14:02". |
| Needs sign-in or paid | Answered, but left out of the fixed list, because invited people can't sign in or pay. Status: "my-relay.example.org asks for sign-in, so it isn't fixed to this room. You still use it yourself." |
| None answered | The room is not started. Inline error beside the button: "None of your relays answered, so the room wasn't started. Check your internet connection, or choose relays that answer." Buttons **Try again** and **Choose relays** (which opens the Relays disclosure and focuses its first box). This applies to group rooms and to rooms that ask before anyone joins: neither can admit anyone without a relay. |
| Offline | Not started: "You're offline. Connect to the internet to start a room." |
| Nearby-only (Android `RoomRoute.NEARBY`) | No relay check. MIXED checks the internet relays only. |
| Tor-only (Android anonymous) | The check runs over Tor and only decides whether the room starts. `c` stays empty for these rooms, as it does today (`roomRelays = emptyList()` in `startRoom`). No public relay is offered. |

## 7. Interaction

### Touch

- Every button and link is at least 44 x 44 CSS px on the web
  (`any-pointer: coarse`) and 48 x 48 dp on Android. The guide link gets
  `display: inline-block; padding-block` to reach it.
- Pressed state the moment a finger lands (existing button `:active`
  styles). On Android shells, `-webkit-tap-highlight-color: transparent` is
  already global; check it is.
- **Add** gives a light haptic on Android (`HapticFeedbackType.Confirm` on
  API 30 and later, otherwise none). The web does not use haptics.

### Pointer

- Hover styles only under `@media (hover: hover)`.
- The host's full URL shows in a native `title` tooltip. It is not the only
  place: Options shows the full address too.

### Keyboard (web)

Tab order in New rooms scope: Close, the scope switch (two buttons,
`aria-pressed`), then for each of Your relays: Remove, then the Options
summary; inside open Options: Use for (select), Move up, Move down, the
circle checkbox, Identify. Then the Relay address field, Add. Then each
suggestion's Add. Then Check relays, then the guide link.

- Enter in the address field adds (`enterkeyhint="done"`, `type="url"`,
  `inputmode="url"`, `autocomplete="off"`, `spellcheck="false"`, font size at
  least 16 px).
- Escape closes the dialog (native `<dialog>`), and focus returns to the
  opener (existing `#returnFocus`).
- After **Remove**, focus moves to the next row's Remove. If that was the
  last row, it goes to the previous row's Remove, and failing that to the
  Your relays heading (`tabindex="-1"`).
- After **Add** on a suggestion, focus moves to the next suggestion's Add.
  If there is none, it goes to the Suggested heading. The new row appears in
  Your relays without taking focus.
- After **Undo**, focus returns to the restored row's Remove.
- Move up and Move down keep focus on the moved row (existing behaviour,
  `relay-settings.ts:559-563`).
- No new global shortcuts.

### Screen reader

- The dialog is labelled by its `h2`. Sections are `h3`. Each relay is an
  `li` inside a `ul` labelled by its section heading.
- Button names contain the visible label and the host: "Remove
  relay.primal.net", "Add offchain.pub", "Options for relay.primal.net".
- Each row's status is plain text. **No per-row live regions**: remove the
  `aria-live` on `.relayHealth` and stop the one-second rewrite from
  announcing anything. A single `#relaySettingsStatus` (`role="status"`,
  already in the DOM) announces actions and check summaries: "Added
  offchain.pub to your relays.", "Removed nostr.mom. Undo is available.",
  "Checked 5 relays at 14:02: 4 answered, 1 didn't."
- The scope switch is a `div role="group" aria-label="Which relays"` with two
  `aria-pressed` buttons (the pattern `.workFilters` already uses).
- The new-room Relays summary has the accessible name "Relays for this room:
  3 chosen". The creation progress goes to the existing `#status`
  (`role="status"`).
- Android: each row is `semantics(mergeDescendants = true)` with
  `onClickLabel = "Options"`. The trailing button is its own node with
  `contentDescription` "Remove relay.primal.net". Section titles get
  `heading()`. The check summary and Undo use a `Snackbar` or a text with
  `liveRegion = Polite`. The status text is a `stateDescription`, not a live
  region.

### Motion

- A new row fades in over 150 ms (opacity only). A removed row is removed
  with no animation. Under `prefers-reduced-motion: reduce` and Android's
  animator scale 0, nothing animates.
- Nothing blinks. "Checking…" is static text, with no spinner needed. If a
  spinner is kept, it must be the existing one and must stop under reduced
  motion.

## 8. Visual, and the curated list

### 8.1 Tokens (web), no new tokens

- Type: `--fs-1` for status and facts, `--fs-2` for notes, `--fs-3` for the
  host and body, `--fs-4` for the dialog title. Weights 400 and 600 (host
  600). That is four sizes and two weights, inside the budget.
- Colour: `--text` (host), `--muted` (facts, notes), status text in `--ok`,
  `--warn` or `--danger`. Each also has words, so colour is never alone.
  Computed on `--panel`: `--ok` 5.72:1 light and 9.37:1 dark, `--danger`
  7.28:1 and 7.74:1, `--warn` 7.94:1 and 11.72:1. **Delete** the hard-coded
  `#168368` and `#b95040` in `style.css:3817-3818`.
- Space: `--s2` within a row, `--s4` between rows, `--s5` between sections.
  Rows are separated by space, not borders. Delete the per-row
  `border-bottom`; keep one `--border` rule between sections only if the
  squint test needs it.
- Shape: `--r-m` (dialog), existing button radius. No cards around rows: a
  row is not a unit you act on as a whole.
- Forced colours: status words carry the meaning, and the buttons keep real
  borders.

### 8.2 Android

`MaterialTheme.typography` (host `bodyLarge`, facts and status `bodyMedium`
in `onSurfaceVariant`, and status in `colorScheme.error` for the danger
states and `tertiary` for warn). No `Color(0x…)` in screens.

### 8.3 The curated public relays

**Home.** One source: `src/public-relays.ts`, a frozen typed list beside
`PUBLIC_FILE_SERVERS`, with the criteria in its doc comment. It is exported
verbatim to `data/public-relays.json`. A unit test fails if the JSON is not
byte-identical to `JSON.stringify(PUBLIC_RELAYS, null, 2) + '\n'`, so the two
cannot drift. Android copies `data/public-relays.json` byte for byte into
`app/src/test/resources/public-relays.json`. Kotlin keeps the same entries in
`relay/PublicRelays.kt`, and an Android unit test parses the copy and
asserts the Kotlin list equals it. This is the same discipline as
`kithmoot-vectors.json` (a copy, never an edit).

Why not the vectors: `vectors/README.md` says vectors pin the wire format
and are generated, never hand-edited. This list is reviewed product data
that changes on a release schedule. Putting it there would blur both.

**Shape.**

```ts
export interface PublicRelay {
  readonly url: string          // canonical, wss://host/
  readonly operator: string     // as its relay information (NIP-11) names it
  readonly default: boolean     // one of the relays new devices start on
  readonly quietRooms: boolean  // held and served kind 1059 without sign-in
  readonly keeps?: 'under-a-day' | 'days' | 'week-or-more'  // measured retention band, when measured
  readonly test: 'read' | 'round-trip'  // what the last check did
  readonly checked: string      // ISO date the last check passed
}
```

**Criteria.** An entry qualifies only if, on its `checked` date:

1. It is run by someone other than ForgeSworn or its maintainers. No host
   under `forgesworn.dev` or `kithmoot.app` (the test checks), and none of
   the owner's own relays (the release checklist checks).
2. Its relay information (NIP-11) names a contact or an operator pubkey.
3. It is free: no `payment_required`, and no sign-in (`auth_required`) to
   read or write kinds 1460, 1462 and 1463.
4. It supports NIP-40 expiry, which ended rooms rely on.
5. It answered from a UK home line with connect and EOSE both under 2 s,
   on two tries.
6. It is a general relay that keeps any kind. A profile-only relay such as
   purplepag.es does not qualify.
7. `test: "round-trip"` requires a throwaway key to have published one event
   each of 1460, 1462, 1463 and 1059 (and 20462, where an `OK` is enough),
   each with a NIP-40 `expiration` 10 minutes ahead. Each event must have
   been read back by id, then removed with a NIP-09 deletion. That is one
   event per kind per relay, with the owner's agreement (Q1). Until then,
   `test: "read"`: the relay held at least one event of each room kind.

List rules: at most six entries. Exactly three defaults, from at least
three different operators and on three different hosts. The release check
resolves A and AAAA records and fails if two defaults share an address
(nos.lol and nostr.mom were one host). At least two entries have
`quietRooms: true`, and at least one default does.

**Proposed list** (from the 21 October measurement):

| Relay | Operator | Default | Quiet rooms | Evidence 21 Oct | Note |
|---|---|---|---|---|---|
| `wss://relay.primal.net/` | Primal | yes | yes | NIP-11 contact and pubkey, strfry, NIPs 11/40/70, 721/787 ms, all four kinds held | Kept kind 1463 for under a day on 1 Oct: `keeps: 'under-a-day'` |
| `wss://nostr.oxtr.dev/` | 0xtr relay | yes | yes | contact and pubkey, NIPs 11/40/70/77, 539/589 ms, all four held | fastest |
| `wss://relay.nostr.net/` | as its NIP-11 names it | yes | no | contact and pubkey, NIPs 11/40/59/70/77, 388/524 ms, chat, rekey, invitation held; 1059 read needs sign-in | Room kinds fine; quiet rooms need sign-in |
| `wss://offchain.pub/` | as its NIP-11 names it | no | yes, pending the write test | contact and pubkey, NIPs 11/40/70/77, 1143/1518 ms, chat, invitation, wrap held; no rekey seen | Refused 1059 from a key outside its web of trust on 25 Sept (`decisions.md`): the write test decides |
| `wss://relay.damus.io/` | damus.io | no | no | contact and pubkey, NIPs 11/40/59/70, 410/675 ms, chat and invitation held, 1059 read needs sign-in, failed once then worked | Large; rate-limited the project's test machine in September |

The builder fills `operator` for relay.nostr.net and offchain.pub from each
one's NIP-11 `name` at the time of the check, and never makes one up.

Left out, with the reason recorded in the doc comment as the file-server
list does: nos.lol and nostr.mom (unreachable on 21 Oct from the UK and from
Germany; one host). nostr-pub.wellorder.net (no contact). nostr.bitcoiner.social
(3.2/3.5 s; only gift wraps seen). nostr.data.haus and relay.angor.io (only gift
wraps seen; angor names no contact). nostr.wine, nostr.land and nostr21.com
(paid or sign-in). relay.snort.social, relay.0xchat.com and relay.nostr.band
(unreachable or errored). purplepag.es (profiles only).

**Kept fresh.** `scripts/check-public-relays.mjs` (PR W2) runs at every
release, as part of the release checklist. It is read-only by default:
NIP-11, a `REQ` with limit 1 per room kind, a separate `REQ` for 1059,
retention bands (`until` now minus 1 day, and minus 7 days), DNS
independence and timings. With `--write`, and only with the owner's
agreement, it does the round trip in criterion 7. It writes
`docs/evidence/public-relays-YYYY-MM-DD.json` and prints the entries whose
`checked` it would advance and those that now fail. A failing entry is
removed or loses `default` in the same release. The doc comment and
`docs/run-your-own.md` list what was left out and why.

## 9. Copy

British English, sentence case, no exclamation marks. Hosts are shown bare
(`relay.primal.net`). `{host}`, `{time}`, `{n}` and similar are
placeholders. Times use `toLocaleTimeString([], { hour: '2-digit', minute:
'2-digit' })`. A date uses `{ day: 'numeric', month: 'short' }`.

### Relay dialog / Relays page

| Key | String |
|---|---|
| title | Relays |
| close | Close |
| close (accessible name) | Close relays |
| scope group label | Which relays |
| scope room | This room |
| scope new | New rooms |
| intro | Relays are servers, run by other people or by you, that pass on your rooms' encrypted messages. |
| your heading | Your relays |
| your note | New rooms start on these. Account sync uses them too. |
| suggested heading | Suggested public relays |
| suggested note | Run by other people, not by KithMoot. Each one names who runs it, is free to use, and carried KithMoot rooms when it was last checked. |
| checked fact | Checked {date} (the entry's `checked`, on each suggestion's facts line) |
| suggested all used | You use all the suggested relays. |
| own heading | Add your own |
| own label | Relay address |
| own placeholder | wss://relay.example.org |
| own hint | Your own relay, or one a friend runs. Rooms you start carry it to everyone you invite. |
| add | Add |
| add (accessible name) | Add {host} |
| remove | Remove |
| remove (accessible name) | Remove {host} |
| options | Options |
| options (accessible name) | Options for {host} |
| options full address | Address: {url} |
| access label | Use for |
| access both | Reading and sending |
| access read | Reading only |
| access write | Sending only |
| move up / down | Move up / Move down |
| move (accessible name) | Move {host} up / Move {host} down |
| order note (in Options) | Order matters: a room's link names the first 8, and Signet sign-in uses the first. |
| circle | Run by my circle |
| circle note | Tick only if you or someone in your circle runs it. Messages that go only through such relays are shown as sheltered. |
| circle verified | Run by my circle (checked) |
| identify | Identify with my account |
| stop identify | Stop identifying |
| identify note | The relay will learn which Nostr account you are. Some relays ask for this, a step called sign-in (NIP-42). |
| check | Check relays |
| check busy | Checking… |
| check note | Checking connects this device to every relay on this page. Each one sees your internet address and can tell the check came from KithMoot. |
| check progress | {n} of {total} answered so far |
| check done | Checked {total} relays at {time}: {ok} answered, {failed} didn't. |
| check all failed | None of these relays answered. Check your internet connection and try again. |
| offline | You're offline. Relays can be checked when you're back online. |
| guide link | How to run your own relay |
| added | Added {host} to your relays. |
| own added | Added {host}. Checking it now. |
| removed | Removed {host}. |
| undo | Undo |
| undone | {host} is back in your relays. |
| last guard | Keep at least one relay for reading and one for sending. |
| full | You can use up to 8 relays here. |
| duplicate | {host} is already in your list. |
| invalid | Use an address that starts with wss:// |
| tor note | This room uses Tor, so only .onion relays can be added. |
| sheltered note | This room is sheltered, so only your circle's relays can be added. |

### Facts and status

| Key | String |
|---|---|
| run by | Run by {operator} |
| free | Free |
| added by you | Added by you |
| keeps under a day | Keeps messages for about a day |
| keeps days | Keeps messages for a few days |
| keeps week | Keeps messages for a week or more |
| holds | Holds room messages |
| quiet yes | Carries quiet rooms |
| quiet sign-in | Quiet rooms need sign-in here |
| not checked | Not checked yet |
| checking | Checking… |
| quick | Answered quickly at {time} |
| slow | Answered slowly at {time} |
| quick old / slow old | Answered quickly on {date} / Answered slowly on {date} |
| no answer | Didn't answer when checked at {time} |
| not answering in use | Hasn't answered since {date}, {time} |
| never answered here | Hasn't answered on this device |
| sign-in | Needs sign-in: it asks which Nostr account you are |
| paid | Asks for payment before it takes messages |
| connected | Connected |
| last taken | Connected · last message taken at {time} |
| elsewhere | · connected elsewhere in KithMoot |
| identified | · knows your account |
| identifying | Identifying… |
| refused auth | Turned a message away: it needs sign-in |
| refused rate | Turned a message away: too many, too fast |
| refused pow | Turned a message away: it wants extra proof of work |
| refused blocked | Turned a message away: not taken from this device or for this kind of message |
| refused invalid | Turned a message away as not valid |
| refused other | Turned a message away |
| read refused | Wouldn't let this device read |
| read sign-in | Needs sign-in before it lets this device read |
| history ok | Returned earlier messages |
| unreturned chat | Doesn't keep chat: took a message, then didn't return it |
| unreturned other | Took a message, then didn't return it |

These replace `READ_LABELS` and the `writeRefusal` strings shown in the
dialog. `writeRefusal` keeps its wire-prefix logic. The display mapping
moves to one `relayStatusText()` per platform, so health stays fixed text
and never echoes a relay's own words.

### This room scope

| Key | String |
|---|---|
| fixed heading | Fixed for this room |
| fixed note | Everyone in this room reads and sends through these, whatever relays they use themselves. They were set when the room started and can't be removed. |
| tag c | Set when the room started |
| tag o | Added for everyone by the room's maker |
| tag legacy (on a row under Also used by you in this room) | Added by the app for rooms made before October 2026 |
| dead authority | This relay isn't answering. Add a working relay so everyone in the room can still reach each other. |
| dead member | This relay isn't answering. Only the room's maker can add a relay for everyone. You can add one for yourself below. |
| add for everyone | Add a relay for everyone |
| picker heading | Add for everyone |
| picker note | Pick relays that answered when checked. |
| picker empty | No relay has answered a check yet. Press Check relays first. |
| confirm | Everyone in this room will also use {hosts}. Whoever runs each one carries this room's encrypted messages and can see when people are active. Nobody loses a relay they already use. |
| confirm yes | Add for everyone |
| confirm no | Cancel |
| confirm done | Added. Everyone's app will start using it the next time it hears from this room. |
| op full | This room already has 8 relays added for everyone, the most it can carry. |
| op denied | Only the person who made this room can add relays for everyone. |
| own heading (room) | Also used by you in this room |
| own note (room) | Only on this device. Other people keep their own. |
| add for you | Add a relay for yourself |
| use for new | Use these for new rooms |
| use for new done | New rooms will start on these relays. |
| sheet subtitle | {n} of {total} isn't answering / {n} of {total} aren't answering |
| room notice partial | This room's own relays aren't answering. People who use only those won't get your messages. |
| room notice none | None of this room's relays are answering. New messages may not reach anyone. |
| room notice action | See relays |
| member learnt op (existing, reworded) | This room now also uses {hosts}, as its maker asked. |
| arrival note (beside **Try the link again**, shown when the link's relays didn't have the invitation) | Trying again also asks the public relays KithMoot suggests. Each one sees your internet address. |

### New-room form

| Key | String |
|---|---|
| summary | Relays: {first}, {second} and {n} more / Relays: {first} and {second} / Relays: {first} |
| summary (accessible name) | Relays for this room: {n} chosen |
| note | Fixed when the room starts: everyone in it will use them. KithMoot checks them first and keeps only the ones that answer. |
| public extra | Also add a public relay: {host} (recommended) |
| public extra hint | So people who can't reach your relays can still find the room. |
| none ticked | Choose at least one relay. |
| busy | Checking relays… |
| progress | {n} of {total} relays answered |
| start now | Start now with {n} relays / Start now with 1 relay |
| started partial | Started on {n} relay(s), using "relay" for 1. Then: {host} didn't answer, so this room isn't fixed to it. / {count} relays didn't answer, so this room isn't fixed to them. Example: "Started on 1 relay. nostr.mom didn't answer, so this room isn't fixed to it." |
| started sign-in | {host} asks for sign-in, so it isn't fixed to this room. You still use it yourself. |
| started paid | {host} asks for payment, so it isn't fixed to this room. You still use it yourself. |
| none answered | None of your relays answered, so the room wasn't started. Check your internet connection, or choose relays that answer. |
| try again | Try again |
| choose | Choose relays |
| offline | You're offline. Connect to the internet to start a room. |

### Settings rows

| Key | String |
|---|---|
| web row title | Relays (was "Nostr relays") |
| row subtitle | Where your rooms' messages travel / {n} relay isn't answering / {n} relays aren't answering |
| Android row | Relays, with the same subtitles (replaces `relaysNeedAttention`) |

### docs/run-your-own.md, Relays section, first paragraph

"Rooms start on three public relays run by other people unless you change
them: relay.primal.net, nostr.oxtr.dev and relay.nostr.net. The app lists
these and a few more under **Settings**, **Connections**, **Relays**, with
who runs each one and the date it was last checked. Add your own there too.
A room you start is fixed to the relays that answer when you start it, and
every member uses them for that room, whatever else they have set."

Add a table like the file-server one (Relay, Run by, Quiet rooms, Checked).
Update the same names in `site/check/index.html` (line 43),
`site/privacy/index.html` (line 79, profile relays) and `README.md:589`.

## 10. Platform notes

### Web (PWA, and the desktop app's renderer)

- `<dialog>` with `showModal()`. Options is `<details>`. The scope switch
  is native buttons. The inline confirm replaces `confirmRoomAction` for the
  op, so there is no dialog on top of a dialog.
- Inputs are 16 px or larger. The `type`, `inputmode` and `enterkeyhint` are
  set as above.
- Height query for the landscape phone (5.2). `dvh` units.
- Desktop (Electron): nothing shell-specific. The guide link already opens in
  the system browser (`target="_blank"`). Check that the desktop shell's
  window-open handler still sends it outside.
- Checks use the page's own `WebSocket` through a short-lived
  `NostrRelayPool` per check (or `pool.ensureRelay`, as
  `granted-contacts-panel.ts` does). A relay already connected in any scope
  within the last 60 s counts as answered without a new dial. NIP-11 is
  fetched only for relays not on the curated list (one `GET` with
  `Accept: application/nostr+json`). A CORS failure leaves operator and
  limits unknown and is not counted as a failure.

### Android (native Compose)

- Material 3 page in Settings. `ModalBottomSheet` for Options. `Snackbar`
  with Undo. `SingleChoiceSegmentedButtonRow` for the scope. Predictive back
  closes the sheet first, then leaves the page. With the draft model gone,
  `DiscardRelayChangesDialog` is deleted.
- Edge to edge: the page already sits in the Settings scaffold. Keep its
  inner padding, and use `imePadding()` on the address field so it stays
  above the keyboard in landscape.
- The check uses `OkHttpRelaySockets` (or `TorOnlyRelaySockets` for
  anonymous rooms) and `RelayPool`, with a 10 s timeout per relay to match
  the web.
- Text in `sp` via `typography`. Rows have no fixed heights (`heightIn`).

### Never, on any platform

1. Never change a room's fixed relays (`c`) or its added relays (`o`)
   without the authority pressing **Add for everyone**. There is no
   automatic switching, substituting or pruning, even when a relay is dead.
2. Never remove a relay from a person's own list on their behalf. A relay
   that didn't answer stays, marked as such, until they remove it.
3. Never suggest a relay run by ForgeSworn or its maintainers.
   `relay2.forgesworn.dev` is blocked by the domain test, and
   `relay.trotters.cc` is excluded by review (Q5).
4. Never call a relay "private", "safe" or "secure". A relay that only your
   circle uses is "run by my circle", and only by the person's own mark or a
   verified box.
5. Never connect to a relay the person hasn't asked about. Checks run only
   on **Check relays**, on adding an address, at **Start a room** (for the
   relays being fixed), and on **Try the link again** after an arrival
   failure. Opening the dialog does not check.
6. Never show a score, rank number or percentage. Only facts and dated
   observations.
7. Never fix a relay that needs sign-in or payment into a new room.

## 11. Implementation notes

### Every place the dead defaults live (PR W1 and A1)

| Place | Change |
|---|---|
| `src/public-relays.ts` (new) | The list (8.3), `PUBLIC_RELAYS`, `DEFAULT_PUBLIC_RELAYS`, and an `isForgeSwornRelay(url)` that reuses the domain list from `app/src/file-storage.ts`. Move `FORGESWORN_DOMAINS` and `isForgeSwornHost` into `src/` so both the library and the app import one copy. |
| `data/public-relays.json` (new) | Export of the above. |
| `src/public-relays.test.ts` (new) | Byte-identical JSON. No ForgeSworn host. `wss://` only, canonical form, no duplicates. At most 6 entries, exactly 3 defaults, at least 2 `quietRooms` with at least 1 default among them. `checked` is a valid ISO date. |
| `src/agent.ts:51` | `DEFAULT_RELAYS = DEFAULT_PUBLIC_RELAYS.map(r => r.url)`. This is what the keepers use. |
| `app/src/main.ts:640-652` | Same, and rewrite the comment above it to point at `src/public-relays.ts`. |
| `app/src/main.ts:2715` `PROFILE_RELAYS` | Drop `wss://nos.lol`. Keep purplepag.es, relay.damus.io and relay.primal.net. |
| `app/src/main.ts:2412` `widerInvitationRelays(..., DEFAULT_RELAYS, ...)` | Correction found in W1: this wider lookup runs on the first attempt, as soon as the link's relays lack the invitation, not only on **Try the link again**. W1 therefore keeps it on the three defaults and ships no arrival note. A later PR may move the wider lookup behind **Try the link again**, then pass every curated relay and show the note (section 9). |
| `app/src/relay-settings.ts:21` `PUBLIC_FALLBACK_RELAY` | `wss://nostr.oxtr.dev/` (Q4). Keep `LEGACY_PUBLIC_RELAYS` as it is: it identifies old rooms. |
| `server/forwarder.mjs`, `deploy/keeper-install.sh`, `deploy/forwarder-install.sh`, `deploy/l402/announce.sh` | Replace nos.lol and nostr.mom with the new defaults. |
| `docs/run-your-own.md`, `site/check/index.html`, `site/privacy/index.html`, `README.md` | Copy (section 9). |
| `docs/decisions.md` | New entry: "The default relays move to the curated list, 21 October 2026". Give the measurement, the criteria and what was left out. |
| Android `ui/RoomViewModel.kt:832` `DEFAULT_RELAYS`, `:843` `PROFILE_RELAYS` | Same as the web, from `relay/PublicRelays.kt`. |
| Android `relay/RoomRelays.kt` `PUBLIC_FALLBACK` | `wss://nostr.oxtr.dev`. |
| Android `relay/PublicRelays.kt` (new), `app/src/test/resources/public-relays.json` (copy), `relay/PublicRelaysTest.kt` (new) | List, copy and equality test. |

Saved choices are untouched: a person who saved nos.lol keeps it, and it
shows "Didn't answer" after a check. Only the fallback for people who never
saved a list changes. `test/*.spec.ts` files that name nos.lol run against
the offline relay. Change them only where they assert the default list.

**Not part of this design, but it must not be lost:** the keepers'
crash-loop is nostr-tools 2.25.2 under Node 22 recursing without limit on a
relay that times out. Changing the defaults stops the trigger for new rooms,
but rooms fixed to nos.lol keep dialling it. The recursion needs its own fix
in the pool's Node path (compare `docs/node-relay-recovery.md`) and its own
PR. This is flagged for the host.

### Web files (later PRs)

| File | What |
|---|---|
| `app/src/relay-check.ts` (new) | `checkRelays(urls, { timeoutMs, signal })` gives, per relay, `{ url, at, answered, ms?, holds: number[], giftWraps: 'open' \| 'sign-in' \| 'none-seen' \| 'unknown', signIn, paid, operator? }`. Two `REQ`s per relay: three filters `{kinds:[k], limit:1}` for 1460, 1462 and 1463, then `{kinds:[1059], limit:1}` on its own, because a sign-in refusal of 1059 must not hide the rest. Classification uses `closedReadEvidence`. `relayStatusText()` is the display mapping. |
| `app/src/relay-check-store.ts` (new) | `kithmoot.relay-checks.v1`: by URL, the last result, pruned after 7 days. Also `lastAnsweredAt` per relay, learnt from pool health, for "Hasn't answered since". It holds no room ids. |
| `app/src/relay-settings.ts` | `RelaySettingsPanel` rewritten for the sections, immediate apply, Undo, focus rules and the single status region. `RelayConnections` is unchanged except for a `roomRelayParts(roomId)` that returns `{ c, o }` so fixed rows can be tagged. The legacy fallback row is recognised in the personal list (`LEGACY_PUBLIC_RELAYS` pair in the hints, plus `PUBLIC_FALLBACK_RELAY`). Keep `save`'s validation, and call it on every change. |
| `app/index.html` `#relaySettings` (around line 1792) | New markup: header with scope group, three sections, footer. Delete `#relayScope`, `#relaySave`, `#relayReconnect`, `#relayShareRow` and the two intro notes. Keep `#relaySettingsStatus` and `#relayList` ids for the e2e specs that use them, or update those specs in the same PR. |
| `app/index.html` `#createRoomForm` (around line 1007) | Relays `<details>` (5.5). |
| `app/src/main.ts` `startNewRoom` (around 4500) | Check the ticked candidates (`checkRelays`), build `roomRelays` from those that answered, in order, without sign-in or payment, plus the ticked public extra. Pass it to `setRoomRelays` and `publishGroupInvitation`. Handle none, partial, start now and offline. Today `inheritDefaults` snapshots the whole default list: keep that for personal relays. Only `c` is filtered. |
| `app/src/main.ts` `shareRoomRelays` (8083) | Build the op from `canonicalRoomRelays([...currentO, ...chosen])`, not from this device's personal list. Remove `confirmRoomAction` here in favour of the inline confirm. Keep the republish of the group invitation. |
| `app/src/main.ts` room sheet | `#roomRelaySettings` subtitle and the room notice, from pool health plus the check store. |
| `app/src/style.css:3808-3823` | New row styles (tokens only). Delete the hard-coded colours. Add the landscape height query and the expanded two-column grid. |
| `test/relay-picker.spec.ts` (new) | e2e against `test/ws-relay.mjs` with three local relays: one healthy, one that never answers the upgrade, one that answers `CLOSED auth-required:`. |

### Android files

| File | What |
|---|---|
| `relay/RelayCheck.kt` (new) | The same check and classification as the web, with JVM tests against a fake socket. |
| `relay/RelaySelection.kt` | `RelayHealth` gains structured fields (state, last-taken time, refusal kind) in place of preformatted strings, plus `relayStatusText()`. |
| `ui/settings/RelaysPage.kt` | Rewritten as in 5.6: sections, suggestions, immediate save, Undo, Options sheet, check button, room scope. Delete `RelayEditorState`'s draft model and `DiscardRelayChangesDialog`. |
| `ui/settings/ConnectionsPage.kt`, `SettingsSummaries.kt`, `ui/start/AccountMenu.kt` | Subtitles (section 9). |
| `ui/start/NewRoomForm.kt` | Relays disclosure (an expandable row with checkboxes), progress and errors. |
| `ui/RoomViewModel.kt` `startRoom` (3774) | Creation check and `roomRelays` filtering, as on the web. Anonymous rooms check over Tor; the check only gates the start, and `c` stays empty as today. |
| `session/RoomWork.kt`, `ui/RoomViewModel.kt` | Authority authoring of a new `relays` op: sign with the room authority key (`canonicalRoomRelays`, `encodeRoomRelaysOp`, signing as the web does with `signRoomRelays`), post on the control channel, store with `withRoomRelaysRecord`, republish the group invitation. `RoomRelaysVectorsTest` already pins the signature. |
| `ui/settings/RelaysPage.kt` (room scope) | Editable own relays in a room (Q7), and the fixed section with tags and dead-relay callouts. |

### Must not change

- The wire format: invitation `relays`, the `relays` op, its signature
  message and `MAX_RELAY_HINTS` (8), `MAX_POOL_RELAYS` (16).
- That room relays are forced to read and send, put first, never cut and
  never written into a saved list.
- The Tor-only and sheltered guards.
- NIP-42 consent semantics and copy meaning (`docs/relay-authentication.md`).
- `enablePing` stays off. The nostr-tools pin and its guard test stay.
- Circle mark semantics (`isCircle`, `markCircle`).
- `kithmoot.relays.v1` and `kithmoot.room-relays-fixed.v1` storage shapes.

### PRs, in order

Each ships on its own and leaves both apps working.

| PR | Repo | Title | Contents | Model, effort |
|---|---|---|---|---|
| W1 | kithmoot | `fix: move the default relays to a checked public list` | Section 11 table, web half; tests; docs and site copy; decisions entry. | Sonnet, medium |
| A1 | kithmoot-android | `fix: move the default relays to the checked public list` | Android half of the table; JSON copy; equality test. | Sonnet, low |
| W2 | kithmoot | `feat: release check for the public relay list` | `scripts/check-public-relays.mjs`, read-only by default, `--write` gated with a printed warning and a required `--i-have-agreement` flag; evidence JSON; release checklist line. | Sonnet, medium |
| W3 | kithmoot | `feat: check relays from this device` | `relay-check.ts`, `relay-check-store.ts`, `relayStatusText()`, unit tests against the offline relay. No UI. | Sonnet, medium |
| W4 | kithmoot | `feat: relay settings show suggested relays and apply at once` | Dialog rewrite, both scopes, CSS, e2e, screenshots. | Sonnet, high |
| W5 | kithmoot | `feat: a new room is fixed only to relays that answer` | New-room disclosure, creation check, all creation states, e2e. | Sonnet, medium |
| W6 | kithmoot | `feat: show a room's dead relays and let its maker add one for everyone` | Room sheet subtitle, room notice, dead-relay callouts, inline confirm, op built from O and the chosen relays. | Sonnet, medium |
| A2 | kithmoot-android | `feat: Relays page shows suggested relays and saves at once` | `RelayCheck.kt`, structured `RelayHealth`, RelaysPage rewrite (New rooms scope), subtitles. | Sonnet, high |
| A3 | kithmoot-android | `feat: rooms fix only answering relays, and their maker can add one for everyone` | NewRoomForm, `startRoom` check, room scope editable, op authoring. Review the signing path with Opus. | Sonnet, high, plus an Opus review |

W1 and A1 stop the harm and can ship today on read evidence (Q1). Run W2's
read-only check first, and update the list's `checked` dates in W1 if W2
lands first.

## 12. Acceptance checks

The builder works through these in order. Web e2e runs use
`npx playwright test test/relay-picker.spec.ts` against the offline relay
(`test/ws-relay.mjs`), with relays A (healthy), B (accepts TCP, never
completes the WebSocket upgrade) and C (answers every `REQ` with
`CLOSED auth-required:`). Screenshots go to a scratch directory, never
committed.

### PR W1 and A1

1. `npx vitest run src/public-relays.test.ts`: passes. Changing one byte in
   `data/public-relays.json` makes it fail.
2. Adding `{ url: 'wss://relay2.forgesworn.dev/' }` to the list makes the
   test fail with a message naming the host.
3. `grep -rn "nos.lol\|nostr.mom" src app/src server deploy docs/run-your-own.md site README.md`
   finds only `LEGACY_PUBLIC_RELAYS` (nos.lol, deliberately) and
   historical text in `docs/decisions.md` and dated design docs.
4. `npm run typecheck && npm test`: green.
5. Fresh browser profile, `npm run demo`: open Settings, Connections,
   Relays. The list shows relay.primal.net, nostr.oxtr.dev and
   relay.nostr.net.
6. A room link naming only `wss://nos.lol` and `wss://relay.primal.net`
   opens with `wss://nostr.oxtr.dev/` in the room's pool
   (`relayConnections.configuration('room:<id>')`, unit test in
   `relay-settings.test.ts`).
7. Android: `./gradlew :app:testDebugUnitTest --tests '*PublicRelays*' --tests '*RoomRelays*'`:
   green. `cmp app/src/test/resources/public-relays.json ../kithmoot/data/public-relays.json`
   exits 0.
8. `node bin/kithmoot-agent.mjs --help` (or the agent's own default print)
   names the new defaults.

### PR W2

9. `node scripts/check-public-relays.mjs` with no flags makes no `EVENT`
   sends (assert by a `--dry-log` or by reading the script). It writes
   `docs/evidence/public-relays-<date>.json` with, per relay: NIP-11 contact
   present, NIPs, payment and sign-in flags, connect and EOSE ms, kinds held,
   1059 outcome, retention band and resolved addresses.
10. `--write` without `--i-have-agreement` exits non-zero and sends nothing.
11. The script fails if two defaults resolve to a shared address (unit test
    with a stubbed resolver).

### PR W3

12. `npx vitest run app/src/relay-check.test.ts`: A gives `answered: true`
    with `ms` set. B gives `answered: false` after 10 s (fake timers). C
    gives `signIn: true`. A relay that holds 1460 gives `holds` containing
    1460. A relay that answers 1059 with `CLOSED auth-required:` and the
    room kinds with EOSE gives `giftWraps: 'sign-in'` with `holds`
    unaffected.
13. The check store prunes entries older than 7 days and holds no room ids
    (assert the stored JSON keys are URLs only).

### PR W4: relay dialog

14. With no room open, opening Relays makes no WebSocket connection to any
    relay not already connected (Playwright `page.on('websocket')` count is
    unchanged across the open).
15. **Check relays** with A, B and C as the person's relays: A reads
    "Answered quickly at …", B "Didn't answer when checked at …", C "Needs
    sign-in: it asks which Nostr account you are". The status region
    announces "Checked 3 relays at …: 2 answered, 1 didn't." (C answered).
16. **Add** on a suggestion puts it in Your relays at once. Reloading the
    page keeps it. No Apply button exists. Focus is on the next suggestion's
    Add.
17. **Remove** then **Undo** restores the row in the same position. Focus is
    on its Remove.
18. With one relay left, its Remove is disabled and its description is
    "Keep at least one relay for reading and one for sending."
19. Typing `wss://relay.primal.net` when it is listed shows "relay.primal.net
    is already in your list." beside the field with `aria-invalid="true"`.
20. In a room: **Fixed for this room** lists `c` with "Set when the room
    started", and an authority-added relay with "Added for everyone by the
    room's maker". Neither has a Remove button.
21. No element inside `#relaySettings` except `#relaySettingsStatus` has
    `aria-live` (DOM query in the spec).
22. Axe (inject `axe.min.js`, run on `#relaySettings`, rules wcag2a, wcag2aa,
    wcag21aa, wcag22aa): no violations, with rows in the connected,
    didn't-answer and sign-in states, in light, dark and forced colours.
23. Status text colours computed on the panel are at least 4.5:1 in light
    and dark (spec reads `getComputedStyle` colour and background and
    computes the ratio).
24. Screenshots at 390 x 844 (touch), 844 x 390 (touch), 1280 x 800, light
    and dark, and 320 x 640 with `html { font-size: 200% }`: no horizontal
    scroll, no text cut short, header sticky, Close visible after scrolling
    to the end. At 844 x 390 the sticky header is 64 px or less.
25. Every button and link in the dialog is at least 44 x 44 px at 390 x 844
    with touch emulation (including "How to run your own relay").
26. At 1280 x 800 the New rooms scope shows two columns. At 844 x 390 it
    shows one.

### PR W5: creation

27. Candidates A and B ticked: **Start a room** shows "Checking relays…".
    After 3 s it offers "Start now with 1 relay". Waiting instead, the room
    starts after B's 10 s timeout. `relayConnections.roomRelays(id).c`
    equals `['<A>']`, and the status reads "Started on 1 relay. <B> didn't
    answer, so this room isn't fixed to it." (singular form).
28. Candidates A and C: C is not in `c`, and the status names it with the
    sign-in line.
29. Only B ticked: no room is started, no invitation is published
    (`page.on('websocket')` frames contain no kind 1463 `EVENT`), and the
    inline error and **Try again** and **Choose relays** buttons show. The
    same with **Ask me before anyone joins** ticked.
30. The person's own relay A, and no curated relay ticked: the "Also add a
    public relay" box is shown and ticked. Unticking it gives `c = [A]`.
31. Offline (`context.setOffline(true)`): "You're offline. Connect to the
    internet to start a room." Nothing published.

### PR W6: dead fixed relays

32. A room whose `c` is `[A, B]`, with B dead, after 10 minutes of fake
    time: the room sheet row reads "1 of 2 isn't answering". The authority
    sees **Add a relay for everyone** under B. A member sees the member
    text and no such button.
33. The authority adds D: the posted op's `relays` equal
    `canonicalRoomRelays([...previousO, D])`. No browser `confirm` and no
    second `<dialog>` opens. A second member's pool gains D.
34. `c` is unchanged after 33 (B is still listed and still dialled).
35. With A and B both dead and an own relay connected: the room notice
    shows the "partial" text and **See relays** opens the dialog in This
    room scope.

### PR A2 and A3: Android

36. `./gradlew :app:testDebugUnitTest`: green, including new `RelayCheckTest`
    and `RelaysPage` state tests.
37. `~/.claude/design/verify/android-emu.sh boot`, install the debug APK,
    open Settings, Connections, Relays. Screenshots in portrait and
    landscape, light and dark, with `android-emu.sh font 2.0`: no clipped
    text, Remove and Add reachable, Options sheet scrolls in landscape.
38. `android-emu.sh a11y <out>`: no unlabelled controls, no target under
    48 dp on the Relays page or the new-room form.
39. `android-emu.sh tablet on`: two panes at expanded width.
40. Rotating with the Options sheet open and text typed in the address
    field keeps both.
41. Start a room on the emulator with one relay pointing at an unreachable
    local port: the same outcome as checks 27 and 29.
42. A room made on Android: its maker adds a relay for everyone. A web
    member's pool gains it (manual run against the offline relay, or the
    existing cross-client harness if present). `RoomRelaysVectorsTest`
    still passes.
43. Run `android-emu.sh reset` and `android-emu.sh shutdown` when done.

### Both

44. The guide link opens `docs/run-your-own.md#relays`, and that section
    names the new defaults and has the table.
45. No string in the UI says "socket", "AUTH", "NIP-" without a gloss,
    "Read / write" or "private" (`grep` over `index.html`,
    `relay-settings.ts` and the Android `ui/settings` and `ui/start`
    sources).

## 13. Trade-offs

- **Apply at once, not Apply changes.** One tap is what was asked for, and
  Undo covers mistakes. The cost: every change reconnects pools in that
  scope. `save()` already does that cheaply, and a burst of taps produces a
  burst of `setRelays`. If that proves noisy, debounce the pool update by
  300 ms, not the save.
- **No checks on opening.** The dialog can't show a live verdict for
  relays nobody is using. Honest beats eager: each check tells a third party
  the device's address, so it happens only when the person asks or is about
  to rely on the result.
- **Quick or slow, not milliseconds.** The measured ms are kept in the store
  and the evidence JSON, but the UI shows two words. A home line's jitter
  makes 539 ms against 721 ms meaningless as a ranking.
- **Fixed relays can't be removed.** A dead relay stays in `c` for good.
  Members keep dialling it (with the pool's backoff), which is the cost of
  never breaking a room whose other members still reach it. The fix is
  additive: the maker adds a working relay.
- **A public relay is added by default beside your own.** It honours "use
  all my infra" (everything ticked is fixed) and the guide's advice, and
  the box keeps the choice visible. Someone who wants only their own
  relays unticks it once per room.
- **Defaults include relay.nostr.net, which needs sign-in for gift wraps.**
  Picking three relays that all carry quiet rooms would mean offchain.pub,
  which refused gift wraps from strangers a month ago. Primal and oxtr
  cover quiet rooms. Nostr.net is fast and well run for ordinary rooms.
- **Kotlin constants plus an equality test, not reading a JSON asset at
  runtime.** `DEFAULT_RELAYS` is a top-level value used without a
  `Context`. The test makes drift impossible to miss without threading
  assets through the start state.
- **Two columns only when the dialog is tall enough as well as wide.** A
  landscape phone is 844 px wide, but two short columns at 390 px tall read
  worse than one.

## 14. Verification

| Platform | What was checked | How | Result | Evidence |
|---|---|---|---|---|
| Web | Relay dialog (defaults scope), phone portrait, phone landscape, desktop, light and dark | Built `app/dist` (main checkout at 2865775) served on 127.0.0.1:5491; Chromium headless shell 1243 via CDP; dialog opened by script | Findings 3 to 6, 11, 15 | `scratchpad/shots-1/relays-*.png`, `report.json` (`sh` 1934 px on phone) |
| Web | New-room form, same devices | Same | No relay information in the form | `scratchpad/shots-1/newroom-*.png` |
| Web | Axe inside `#relaySettings` | axe-core from `verify/vendor`, wcag2a/aa, 21aa, 22aa and best practice | No violations. Rows were in "Not in use here" only, so the status colours were not exercised | `scratchpad/shots-2/report.json` |
| Web | Target sizes inside the dialog | Bounding boxes in the same run | Guide link 188 x 18 px. Checkboxes are wrapped in labels (acceptable) | `scratchpad/shots-2/report.json` |
| Web | Status colour contrast | Computed from `style.css` hex values against `--surface` | `#168368` 4.32:1 and 3.77:1, `#b95040` 4.52:1 and 3.60:1. The proposed tokens are 5.72 to 11.72:1 | computed in session, not rendered |
| Web | `verify/web-shots.mjs` | Tried | Not run: system Chrome 155 headless hung on navigation on this machine. The checks were done with the script above | not verified |
| Web | WebKit (Safari, iOS shell), Firefox | | not verified | |
| Desktop | Electron renderer | | not verified (same renderer code, Chromium) | |
| Android | Relays page, new-room form, room relays | Source read at origin/main ae9f6645 (`RelaysPage.kt`, `RelaySelection.kt`, `RoomRelays.kt`, `RoomViewModel.kt`, `RoomWork.kt`, `NewRoomForm.kt`) | Findings 7, 10. In-room page read-only | not built: the checkout holds another session's uncommitted work, and only one heavy job may run on this machine |
| Android | TalkBack, font scale 2.0, rotation, tablet | | not verified | |
| Relays | Reachability and kinds held | The brief's measurement on 21 Oct 2026, about 00:30 UTC (not repeated here) | Basis for 8.3 | brief |
| Relays | Retention (primal under a day, nos.lol under three days) | `docs/2026-10-01-group-admission-sync.md`, `docs/decisions.md` | Basis for `keeps` | repo docs |
