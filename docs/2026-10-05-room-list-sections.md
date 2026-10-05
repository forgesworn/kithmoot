# Room list: sections, pins, tighter rows

5 October 2026. The home screen's room list for web, desktop and Android.
Both apps follow this document exactly. Where it fixes a string or a number,
use that string or number.

## Why

With 25 or more rooms the list is one flat column of identical rows:
- On desktop it sits in a 500px strip in the middle of a wide window.
- "No messages yet" repeats under every quiet room.
- "Open an invite link" and "Sign in" are below the last room.

Nothing marks a room you go back to every day as different from a room you
were in once in September.

## 1. Sections

The order and labels are fixed:

| Section | Label | Holds | Folded by default |
|---|---|---|---|
| Pinned | `Pinned` | Rooms the person pinned on this device | No |
| Unread | `Unread` | Unpinned rooms with at least one unread message from a person (agents don't count) | No |
| Recent | `Recent` | Unpinned, read rooms with activity in the last 7 days | No |
| Older | `Older` | Unpinned, read rooms with no activity in 7 days | **Yes** |
| Ended | `Ended` | Unpinned rooms that have ended, including conference rooms past their end | **Yes** |

Rules:
- **A room is in exactly one section.**
  - A pinned room stays in Pinned even when it is unread or has ended.
  - An ended room goes to Ended even when it is unread.
- **Within a section the order is the same activity order the list uses today.**
- **Activity:** use what the list already sorts by (web `activityAt`, Android the row's time). Seven days is `7 * 24 * 60 * 60` seconds before now.
- **Section heading:**
  - A small heading row showing the label, plus ` · N` when the section is folded, e.g. `Older · 14`.
  - Web: `labelMedium`/`.8rem`, `--muted` colour, letter-spacing `.04em`, not uppercase.
- **Folding:**
  - Older and Ended are fold buttons (`aria-expanded`). The other headings are plain headings.
  - Each fold's open or closed state is remembered on this device:
    - web: `localStorage` key `kithmoot.home.fold.<section>`, value `open` or `closed`;
    - Android: the app's preferences, two booleans.
  - A section with no rooms is not shown at all.
- **Small lists:** with **8 or fewer rooms** in the list, after the project filter:
  - show no headings and fold nothing;
  - pinned rooms sort first, then everything else in today's order.

  (This is the same threshold that shows Find a room.)
- **Searching:** while the search query is not empty:
  - no headings and no folding: one flat list of matches;
  - pinned matches first, then today's activity order.

  A search must never hide a match in a closed fold.
- **Project filter:** applies before sectioning. A filtered list of 8 or fewer has no headings.
- **No reshuffling under the pointer:** a room moving between Unread and Recent counts as a reorder. While the pointer or focus is in the list, the web list already freezes the order (`held` and `lastRoomOrder`); sections must respect that freeze. Keep the section each room was in while held, and recompute when the hold ends.

## 2. Rows

- **Avatar:**
  - A 40×40 circle, left of the name: the room's first letter or digit (uppercase), centred, in semibold.
  - If the label has no letter or digit, use `#`.
  - Ended rooms use the muted surface colour with muted text.
- **Avatar colour:**
  - Chosen by `parseInt(roomId.slice(0, 2), 16) % 8` from this palette.
  - Text is white in both themes. Each pair below passes 4.5:1 against white.

  | # | Light | Dark |
  |---|---|---|
  | 0 | `#0b6b8a` | `#0e7fa3` |
  | 1 | `#6a4fb3` | `#7a5fc4` |
  | 2 | `#a2431f` | `#b54c25` |
  | 3 | `#2f6f3e` | `#357d46` |
  | 4 | `#8a3a6b` | `#9c4479` |
  | 5 | `#5b5f1c` | `#6b7020` |
  | 6 | `#1f5f9e` | `#2a6db0` |
  | 7 | `#7a4a12` | `#8c5616` |

- **Line 1:** the name, plus the time on the right.
  - A pinned room shows a pin glyph before the time: 14px, muted. On the web it is `aria-hidden`, and "Pinned" is added to the row's description.
- **Line 2:** the preview, on one line with an ellipsis, and the unread pill on the right.
  - When the preview would be **"No messages yet"**, there is no second line and the row is one line, vertically centred against the avatar.
  - The row's screen-reader description still says "No messages yet".
  - Every other preview stays as it is: ended, quiet room, "Open it to catch up.".
- **Unread:** the name and the time are bold, and the pill uses the accent colour (as today).
- **Spacing:**
  - The row's minimum height is 56px. Vertical padding is 8px (web `.5rem`), and the avatar has 12px between it and the text.
  - Rows have no divider lines. The hover or focus background is the existing hover surface, with 8px radius.
- **Menu:** the ⋯ menu gains **Pin** / **Unpin** as its first item.
  - Pinning never moves keyboard focus. The row moves, and focus goes with that row's ⋯ button.

## 3. Toolbar and width (web and desktop)

- **The top of the list is one row:**
  - the `Rooms` heading;
  - the search field, which grows to fill the space. Its placeholder is `Find a room`, its label is visually hidden, and the existing shortcut hint stays.
  - `Projects` (when shown today);
  - `Open invite link`, a quiet button that shows the existing invite field;
  - `New room` (primary).

  Below 560px wide it wraps: heading and buttons on the first line, search on the second.
- **The search field** is shown under the same rule as today (8 or more rooms). With fewer, the row has no search.
- **`Already on Nostr? Sign in`** moves out of the bottom of the list into the header, beside Settings, as `Sign in`. It is shown under the same condition as today.
- **Wider list:** on the home screen only, the list column is `min(760px, 100%)` wide, up from the current width.
  - Desktop app: widen it in the existing `html[data-desktop] body:has(#home[data-state='returning'])` rule.
  - Web: use an equivalent home-only rule.

  Never widen it on `body`, or every room view moves.

## 4. Top of the list (Android)

- **Top row:**
  - the `Rooms` title;
  - a search icon button that opens the search field in place (shown when there are 8 or more rooms);
  - `Projects` (as today);
  - an overflow menu holding `Open invite link`.

  `Open invite link` opens the existing invite field in a bottom sheet, and the field leaves the bottom of the list.
- **`Already on Nostr? Sign in`** moves into the overflow menu as `Sign in`.
- **The New room button** stays as it is. The wide layout keeps its New room pane.

## 5. Pins are device-local and erased with the room

- **Storage:**
  - Web: `kithmoot.pinned.<roomId>` = `1` in the device store. Never in the account bookmark record and never on a relay.
  - Android: a `pinned` field on the saved-room record, in the same encrypted storage as the room. Check that the field is not serialised into anything sent to relays (account room bookmarks); if it would be, keep it out.
- **Erasure:** forgetting a room removes its pin.
  - Web: `forgetLocally` removes the key explicitly. `clearRoomLocally` and Forget this browser already sweep `kithmoot.` keys that name the room; check that they do.
  - Android: the pin lives on the saved record, so `forgetRoom`, `resetSavedRooms` and the sweep take it with the room. Assert that in a test.
- **Tests:**
  - pin, unpin, and the pin surviving a reload;
  - pin erased on forget;
  - 8 or fewer rooms show no headings;
  - a search ignores folds;
  - folds remember their state.
