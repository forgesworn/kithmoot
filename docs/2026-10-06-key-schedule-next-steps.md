# Key schedule: next steps after phase 2a

Status: written 2026-10-06, once phase 2a was in the field. 2a's readers are
in desktop 0.1.55, Android 0.6.60 and the web. The keeper's cadence is
built (#250) and on for KithMoot's own keepers, `founders` and `moot`, every
seven days (#251). The plan this follows is
`docs/2026-10-04-key-schedule-parity.md`. The erasure audit
(`docs/2026-10-05-erasure-audit.md`) sets 2b's order.

## 1. Watch the first scheduled rekeys

Both rooms started their clocks at 2026-10-06 10:52:23 UTC. Each rekeys
between 13 Oct 10:52 and 16:52 UTC (the jitter comes from a hash of the
epoch), and only if somebody other than the keeper has spoken since. A
quiet room waits until somebody speaks, then rekeys at the next hourly
check.

Check on the day:

- **The keeper.** The journal for `kithmoot-keeper@<room>` shows the rekey
  and no error. In `room.json`, `epoch` goes up by one, `epochAt` moves to
  the rekey, and `past` gains an entry. Read only those fields: the file
  holds the room's secret.
- **Current apps say nothing.** Desktop 0.1.55 and the web post no "moved
  to epoch" line. Android 0.6.60 shows no "Secure room update" notice.
- **Rooms nobody has open still work.** This is what option (a) was chosen
  for, and the only part not yet seen in production. Before the rekey,
  close the room on one desktop and on the Pixel (leave each on the rooms
  list or in the background). After it, send a message from another
  device. The desktop's rooms list should mark it unread, and the Pixel
  should notify and ring as before.
- **Older apps.** Anyone still on an older release gets one line or a
  notice per rekey. That is expected and harmless. If somebody reports it,
  the fix is to update.

If something goes wrong, take `KITHMOOT_REKEY_EVERY=7` out of
`/etc/kithmoot/keeper-<room>.env` and restart that keeper. The rekey
already made stays: every current app follows it.

## 2. Decisions still open

Each has a recommendation. Nothing in 2b starts until decision 7 is taken.

- **Decision 7: the room archive against forward secrecy.** It gates 2b.
  The archive keeps chat with no age limit. Erasing keys at 30 days makes
  archived chat older than that unreadable, unless the archive re-seals
  what it keeps to a device archive key. *Recommended:* prune at the
  window. It keeps the archive's "nothing decrypted is stored" promise and
  makes the forward-secrecy claim simple. Deep history is then as long as
  the window, which matches what a newcomer reads. Re-sealing (Signal's
  answer) can follow later as an opt-in "keep history on this device".
- **Decisions 4, 5 and 6.** Device-key participants, phase 3 timing, and
  phase 4. Recommendations are in the parity doc and the work follows
  them. They need confirming, not new analysis.
- **New: should `--rekey-every` default to seven days?** The 2a plan's step
  7 said a keeper should default to 7. Today it defaults to 0 and our own
  keepers set it in their env files. *Recommended:* make 7 the default in
  the next release that changes the keeper anyway, once 13 Oct's rekeys
  have gone cleanly. Anybody else running a keeper gets healing without
  knowing to ask, and `--rekey-every 0` still turns it off.
- **New: should a Remove sent while the keeper is away wait for it?** The
  keeper drops a control request sent more than ten seconds before it
  started (`#handleControl`, `src/agent.ts`). So a Remove pressed while it
  is down does nothing, and the app has already said "Asked the keeper to
  remove…". *Recommended:* yes, and keep it narrow. On start, act on
  `remove` requests from the last 24 hours that an admin signed and that
  no later rekey has already covered. Also make the app say when the
  keeper is not in the room, so the request is not silently lost. `close`
  and `channel` stay live-only.

## 3. Phase 2b: forward secrecy

In the audit's order. Every wire change is reader-first: readers ship on
all three platforms before any writer. Circle-layer changes land in
`forgesworn/fold-kit` first, then here.

1. **A one-time sender key for 1462 and 20469.** Today rekeys and grants
   are sealed from the authority's long-lived key, so whoever later takes
   that key opens every past rekey. A fresh key per event, discarded after
   sealing, fixes that. Work: fold-kit format, vectors and readers, then
   readers here and on Android, then the keeper writes. *fold-kit, web,
   Android.*
2. **Seal keys on Android and on paired secondaries.** Android and
   secondaries are sealed to under their long-lived keys, so they are not
   healed and cannot be forward secret. This picks up phase 1's open
   follow-ups: pairing carries a seal key that the secondary mints, and
   Android mints seal keys from the same vectors. *Web (pairing), Android.*
3. **Retire seal keys older than the window.** The web's store of its
   window's secrets shipped in 2a (`kithmoot.room-epoch.v2`). What is left
   is dropping seal keys older than the oldest epoch in the window. *Web.*
4. **The archive prunes outside the window**, by age as well as count, as
   decision 7 settles it. *Web.*
5. **Android's history gets the same window** (30 days, at most 16), and
   its journal forgets a removed or closed room's last secret. That also
   caps member grants at 16 epochs instead of `MAX_MEMBER_EPOCH_CHAIN`
   (32). *Android, then the web's member desk.*
6. **Zero what is dropped**: `Uint8Array.fill` on the web and in Node,
   `ByteArray.fill` on Android. *Web, Node, Android.*

Only after all six does any copy, doc or comparison claim forward secrecy.
Its window is the history window.

## 4. Phases 3 and 4

- **Phase 3:** chat signed by a one-time outer key, with the device's
  signature inside, so relays stop seeing who wrote what. Independent of
  2b, and the smallest gain of the four. Readers first, Android included.
- **Phase 4 (optional):** hybrid ML-KEM seals. First design how a rekey
  splits for rooms over about 40 devices, since weekly rekeys make the size
  limit routine. Build it once a pure-JS and Kotlin pair of implementations
  has passed review.

## 5. Operational

- **Zapstore 0.6.60** needs the owner at the signer.
- **Moving a room between boxes** with `--state-from` puts its state in two
  files, which the lock cannot see. With the cadence on, stop the old
  keeper before starting the new one, or each turns the key its own way
  (`deploy/README.md`).
- **A flaky WebKit test.** `test/workspace.spec.ts:688` (the rail's unread
  counts) failed once on #251, a docs-only change, and passed on a re-run.
  Watch for it again before chasing it.
