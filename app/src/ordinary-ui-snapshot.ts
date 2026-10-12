import { sanitiseDisplayName } from '../../src/display-name.js'
import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

const booleanKeys = ['kithmoot.mirror-self', 'kithmoot.fish.enabled', 'kithmoot.camera.framing', 'kithmoot.agents-hear',
  'kithmoot.zen-bell', 'kithmoot.desktop-bell', 'kithmoot.profiles.enabled']
const families = [...booleanKeys, 'kithmoot.name', 'kithmoot.last-nostr-account', 'kithmoot.last-nostr-method',
  'kithmoot.profiles.lastKnownName', 'kithmoot.room-name', 'kithmoot.home.fold', 'kithmoot.send-delay',
  'kithmoot.nudge', 'kithmoot.destruct-heads-up', 'kithmoot.destructed', 'kithmoot:emoji:skinTone',
  'kithmoot:emoji:recents', 'kithmoot.way-back', 'kithmoot.room-switch', 'kithmoot.notice']
const tabKeys = ['kithmoot.way-back', 'kithmoot.room-switch.v1', 'kithmoot.notice']
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
function hold(): never { throw new OrdinaryStateHold() }
function object(v: unknown, required: string[], extensions = false): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k => !Object.hasOwn(v, k))
    || !extensions && Object.keys(v).some(k => !required.includes(k))) hold()
}
function json(raw: string): unknown {
  const v: unknown = JSON.parse(raw)
  if (JSON.stringify(v) !== raw) hold()
  return v
}
function integer(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) >= 0 }
function clockString(raw: string): void { const v = Number(raw); if (!integer(v) || String(v) !== raw) hold() }

/** Offline count-only custody. Display caches, media choices, deletion rows,
 * old links and navigation intents carry no identity, admission, permission,
 * freshness or deletion authority. No loader, catalogue lookup, clock,
 * pruning, dial or random operation runs; the complete composite and protected
 * runtime consumers must supply those separate gates before using any value. */
export function validateOrdinaryUiSnapshot(records: ReadonlyMap<string, string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): Readonly<{ booleans: number; names: number; accountHints: number;
    methodHints: number; profileCaches: number; profileNames: number; roomNames: number; folds: number;
    sendDelays: number; nudges: number; headsUps: number; tombstoneLists: number; tombstones: number;
    skinTones: number; recentLists: number; recents: number; wayBacks: number; roomSwitches: number; notices: number }> {
  if (!['browser', 'tab'].includes(options.kind)) hold()
  const c = { booleans:0,names:0,accountHints:0,methodHints:0,profileCaches:0,profileNames:0,roomNames:0,folds:0,
    sendDelays:0,nudges:0,headsUps:0,tombstoneLists:0,tombstones:0,skinTones:0,recentLists:0,recents:0,wayBacks:0,roomSwitches:0,notices:0 }
  try {
    for (const [name, raw] of records) {
      if (name.startsWith('kithmoot.account.') && families.some(f => name.includes('.' + f))) hold()
      if (!families.some(f => name === f || name.startsWith(f + '.'))) continue
      if (name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string') hold()
      ordinaryUtf8Length(raw)
      if (tabKeys.includes(name) ? options.kind !== 'tab' : options.kind !== 'browser') hold()
      if (booleanKeys.includes(name)) {
        if (raw !== 'true' && raw !== 'false') hold(); c.booleans++
      } else if (name === 'kithmoot.name') {
        if (!raw || sanitiseDisplayName(raw) !== raw) hold(); c.names++
      } else if (name === 'kithmoot.last-nostr-account') {
        if (!hex(raw)) hold(); c.accountHints++
      } else if (name === 'kithmoot.last-nostr-method') {
        if (!raw) hold(); c.methodHints++
      } else if (name === 'kithmoot.profiles.lastKnownName.v1') {
        const v = json(raw); object(v, [], true)
        const values = Object.values(v)
        // Main loads any string-valued entries and LastKnownNames preserves
        // them on a later remember/save. No profile signature is stored here.
        if (values.length > 500 || values.some(n => typeof n !== 'string')) hold()
        c.profileCaches++; c.profileNames += values.length
      } else if (name.startsWith('kithmoot.room-name.v1.') && hex(name.slice('kithmoot.room-name.v1.'.length))) {
        const v = json(raw); object(v, ['name', 'id', 'at'])
        if (typeof v.name !== 'string' || !v.name || sanitiseDisplayName(v.name) !== v.name
          || typeof v.id !== 'string' || !/^[0-9a-f]{32}$/.test(v.id) || !integer(v.at) || v.at === 0) hold()
        c.roomNames++
      } else if (name.startsWith('kithmoot.home.fold.') && ['pinned','unread','recent','older','other','ended'].includes(name.slice('kithmoot.home.fold.'.length))) {
        if (raw !== 'open' && raw !== 'closed') hold(); c.folds++
      } else if (name === 'kithmoot.send-delay') {
        if (!['0','5','10'].includes(raw)) hold(); c.sendDelays++
      } else if (name.startsWith('kithmoot.nudge.') && hex(name.slice('kithmoot.nudge.'.length))) {
        if (raw !== 'true') hold(); c.nudges++
      } else if (name.startsWith('kithmoot.destruct-heads-up.') && hex(name.slice('kithmoot.destruct-heads-up.'.length))) {
        clockString(raw); c.headsUps++
      } else if (name === 'kithmoot.destructed.v1') {
        const v = json(raw)
        if (!Array.isArray(v) || v.length > 50) hold()
        for (const row of v) {
          // Current read/writeTombstones carries extra JSON and duplicate ids.
          // Retain even expired/fractional finite times, never prune on custody.
          object(row, ['id', 'at'], true)
          if (typeof row.id !== 'string' || !/^[0-9a-f]{16,64}$/.test(row.id)
            || typeof row.at !== 'number' || !Number.isFinite(row.at)) hold()
        }
        c.tombstoneLists++; c.tombstones += v.length
      } else if (name === 'kithmoot:emoji:skinTone') {
        if (!['0','1','2','3','4','5'].includes(raw)) hold(); c.skinTones++
      } else if (name === 'kithmoot:emoji:recents') {
        const v = json(raw)
        // The writer removes only the selected emoji from the previous list;
        // duplicates of other entries can survive, as can obsolete choices.
        if (!Array.isArray(v) || v.length > 36 || v.some(e => typeof e !== 'string' || !e)) hold()
        c.recentLists++; c.recents += v.length
      } else if (name === 'kithmoot.way-back') {
        const v = json(raw); object(v, ['link', 'name'])
        if (typeof v.link !== 'string' || !v.link || typeof v.name !== 'string') hold()
        c.wayBacks++ // Exact link/name are retained as opaque candidates, never opened.
      } else if (name === 'kithmoot.room-switch.v1') {
        const v = json(raw); object(v, ['hash', 'account', 'at'])
        if (typeof v.hash !== 'string' || v.hash !== '' && !v.hash.startsWith('#')
          || v.account !== null && !hex(v.account) || !integer(v.at)) hold()
        c.roomSwitches++ // Authenticated current account and real-clock age checks remain owed.
      } else if (name === 'kithmoot.notice') c.notices++ // The writer accepts arbitrary display text.
      else hold()
    }
    return Object.freeze(c)
  } catch { return hold() }
}
