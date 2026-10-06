import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { normaliseHex } from './hex.js'
import { isRoomEnds } from './expiration.js'
import { canonicalChannels, MAX_HISTORY_EPOCHS } from './epoch.js'
import type { LeftEpoch } from './epoch.js'
import type { KeeperState, KeptDevice } from './agent.js'

/**
 * The keeper's state file, as written and read.
 *
 * Version 1 held the room: secret, inviter key, bearer. Version 2 adds the
 * epoch the room is in, that epoch's secret, the participants removed so
 * far, and whether the room was closed. A version 1 file is read as epoch
 * 0 with nobody removed, so a keeper upgraded in place reopens the same
 * room on the same link without anybody having done anything.
 *
 * Phase 2a adds, still under version 2, when the current epoch began
 * (`epochAt`), the epochs the room left within the history window with
 * their secrets (`past`), and the newest credential of every device seen
 * within that window (`devices`), which a scheduled rekey is sealed to.
 * All three are additive: a reader from before them builds its state from
 * the fields it names and never looks at these, so going back to an older
 * keeper is safe. They are read leniently: a malformed one is dropped, the
 * rest of the file is kept, and the keeper rebuilds what it lost as the
 * room goes on.
 */
export const KEEPER_STATE_VERSION = 2

export interface StoredKeeperState {
  persistent?: true
  v: 1 | 2
  secret: string
  inviterSk: string
  bearer: string
  epoch?: number
  epochSecret?: string
  removed?: string[]
  closed?: boolean
  /** Who asked to be nudged. Written only when somebody has. */
  nudge?: string[]
  /** Who the room knows (#207). Written only when anybody is. */
  members?: string[]
  /** A conference room's end, unix seconds. Written only for one. */
  ends?: number
  /** The room's named channels. Written only when there are any; without
   *  them a restarted keeper announced an empty list and every client took
   *  the room's channels off screen. */
  channels?: string[]
  /** When the current epoch began, unix seconds. Phase 2a. */
  epochAt?: number
  /** The epochs the room has left within the history window, newest
   *  first. Epoch 0's is the room secret, so it is written without one. */
  past?: { epoch: number; secret?: string; left: number }[]
  /** The newest credential of each device seen within the history window,
   *  and when it was last seen, unix seconds. */
  devices?: { device: string; credential: unknown; seen: number }[]
}

/** As many devices as a session keeps credentials for. */
const MAX_KEPT_DEVICES = 1_024

const HEX64 = /^[0-9a-f]{64}$/i
const HEX128 = /^[0-9a-f]{128}$/i

function isTime(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
}

/** The left epochs, or undefined when there is nothing usable. Entries at or
 *  above the current epoch, repeated, or malformed are dropped one by one. */
function parsePast(raw: unknown, epoch: number, roomSecret: Uint8Array): LeftEpoch[] | undefined {
  if (!Array.isArray(raw) || epoch === 0) return undefined
  const byEpoch = new Map<number, LeftEpoch>()
  for (const e of raw as unknown[]) {
    if (typeof e !== 'object' || e === null) continue
    const { epoch: n, secret, left } = e as { epoch?: unknown; secret?: unknown; left?: unknown }
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n >= epoch || byEpoch.has(n) || !isTime(left)) continue
    if (n === 0) {
      byEpoch.set(0, { epoch: 0, secret: roomSecret.slice(), leftAt: left })
      continue
    }
    if (typeof secret !== 'string' || !HEX64.test(secret)) continue
    byEpoch.set(n, { epoch: n, secret: hexToBytes(secret), leftAt: left })
  }
  const past = [...byEpoch.values()].sort((a, b) => b.epoch - a.epoch).slice(0, MAX_HISTORY_EPOCHS)
  return past.length ? past : undefined
}

/** Shaped like a signed event: what a credential has to be before the
 *  session checks its signature (`RoomSession.rememberCredentials`). */
function isEventShape(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const e = raw as Record<string, unknown>
  return typeof e.id === 'string' && HEX64.test(e.id)
    && typeof e.pubkey === 'string' && HEX64.test(e.pubkey)
    && typeof e.sig === 'string' && HEX128.test(e.sig)
    && typeof e.kind === 'number' && Number.isSafeInteger(e.kind)
    && typeof e.created_at === 'number' && Number.isSafeInteger(e.created_at)
    && typeof e.content === 'string'
    && Array.isArray(e.tags) && e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
}

/** The kept devices, or undefined when there is nothing usable. A malformed
 *  entry is dropped on its own. */
function parseDevices(raw: unknown): KeptDevice[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const byDevice = new Map<string, KeptDevice>()
  for (const d of raw as unknown[]) {
    if (typeof d !== 'object' || d === null) continue
    const { device, credential, seen } = d as { device?: unknown; credential?: unknown; seen?: unknown }
    if (typeof device !== 'string' || !HEX64.test(device) || !isTime(seen) || !isEventShape(credential)) continue
    const key = normaliseHex(device)
    if (byDevice.has(key)) continue
    byDevice.set(key, { device: key, credential: credential as KeptDevice['credential'], seen })
  }
  const devices = [...byDevice.values()].sort((a, b) => b.seen - a.seen).slice(0, MAX_KEPT_DEVICES)
  return devices.length ? devices : undefined
}

function bytes32(hex: unknown, what: string): Uint8Array {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new Error(`keeper state: ${what} is not 32-byte hex`)
  return hexToBytes(hex)
}

/** Read a state file's JSON. Throws on anything that is not one. */
export function parseKeeperState(json: string): KeeperState {
  const stored = JSON.parse(json) as Partial<StoredKeeperState>
  if (stored.v !== 1 && stored.v !== 2) throw new Error('keeper state: unknown version')
  const state: KeeperState = {
    secret: bytes32(stored.secret, 'secret'),
    inviterSk: bytes32(stored.inviterSk, 'inviterSk'),
    bearer: bytes32(stored.bearer, 'bearer'),
    epoch: 0,
    removed: [],
  }
  if (stored.persistent === true) state.persistent = true
  if (stored.v === 1) return state
  let epoch = 0
  if (stored.epoch !== undefined) {
    if (!Number.isSafeInteger(stored.epoch) || stored.epoch < 0) throw new Error('keeper state: epoch is not a number')
    epoch = stored.epoch
  }
  state.epoch = epoch
  if (epoch > 0) state.epochSecret = bytes32(stored.epochSecret, 'epochSecret')
  if (stored.removed !== undefined) {
    if (!Array.isArray(stored.removed) || !stored.removed.every((p) => typeof p === 'string' && HEX64.test(p))) {
      throw new Error('keeper state: removed is not a list of pubkeys')
    }
    state.removed = [...new Set(stored.removed.map(normaliseHex))].sort()
  }
  if (stored.closed === true) state.closed = true
  if (stored.ends !== undefined) {
    if (!isRoomEnds(stored.ends)) throw new Error('keeper state: ends is not a time')
    state.endsAt = stored.ends
  }
  if (stored.nudge !== undefined) {
    if (!Array.isArray(stored.nudge) || !stored.nudge.every((p) => typeof p === 'string' && HEX64.test(p))) {
      throw new Error('keeper state: nudge is not a list of pubkeys')
    }
    const nudge = [...new Set(stored.nudge.map(normaliseHex))].sort()
    if (nudge.length) state.nudge = nudge
  }
  if (stored.members !== undefined) {
    if (!Array.isArray(stored.members) || !stored.members.every((p) => typeof p === 'string' && HEX64.test(p))) {
      throw new Error('keeper state: members is not a list of pubkeys')
    }
    const members = [...new Set(stored.members.map(normaliseHex))].sort()
    if (members.length) state.members = members
  }
  if (stored.channels !== undefined) {
    if (!Array.isArray(stored.channels)) throw new Error('keeper state: channels is not a list')
    let channels: string[]
    try { channels = canonicalChannels(stored.channels) } catch { throw new Error('keeper state: channels holds a name no room may use') }
    if (channels.length) state.channels = channels
  }
  // Phase 2a's fields: lenient, so a bad one costs only itself.
  if (isTime(stored.epochAt)) state.epochAt = stored.epochAt
  const past = parsePast(stored.past, epoch, state.secret)
  if (past) state.past = past
  const devices = parseDevices(stored.devices)
  if (devices) state.devices = devices
  return state
}

/** Write the current version. */
export function serialiseKeeperState(state: KeeperState): string {
  const stored: StoredKeeperState = {
    v: 2,
    secret: bytesToHex(state.secret),
    inviterSk: bytesToHex(state.inviterSk),
    bearer: bytesToHex(state.bearer),
    epoch: state.epoch ?? 0,
    removed: [...new Set((state.removed ?? []).map(normaliseHex))].sort(),
  }
  if ((state.epoch ?? 0) > 0) {
    if (!state.epochSecret) throw new Error('keeper state: an epoch above 0 needs its secret')
    stored.epochSecret = bytesToHex(state.epochSecret)
  }
  if (state.persistent) stored.persistent = true
  if (state.closed) stored.closed = true
  if (state.endsAt !== undefined) stored.ends = state.endsAt
  if (state.nudge?.length) stored.nudge = [...new Set(state.nudge.map(normaliseHex))].sort()
  if (state.members?.length) stored.members = [...new Set(state.members.map(normaliseHex))].sort()
  if (state.channels?.length) stored.channels = canonicalChannels(state.channels)
  if (state.epochAt !== undefined) stored.epochAt = state.epochAt
  const past = (state.past ?? []).filter((e) => e.epoch < (state.epoch ?? 0))
  if (past.length) {
    stored.past = [...past]
      .sort((a, b) => b.epoch - a.epoch)
      .map((e) => (e.epoch === 0 ? { epoch: 0, left: e.leftAt } : { epoch: e.epoch, secret: bytesToHex(e.secret), left: e.leftAt }))
  }
  if (state.devices?.length) {
    stored.devices = [...state.devices]
      .sort((a, b) => b.seen - a.seen)
      .slice(0, MAX_KEPT_DEVICES)
      .map((d) => ({ device: normaliseHex(d.device), credential: d.credential, seen: d.seen }))
  }
  return JSON.stringify(stored, null, 2) + '\n'
}
