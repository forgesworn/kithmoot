import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { normaliseHex } from './hex.js'
import type { KeeperState } from './agent.js'

/**
 * The keeper's state file, as written and read.
 *
 * Version 1 held the room: secret, inviter key, bearer. Version 2 adds the
 * epoch the room is in, that epoch's secret, the participants removed so
 * far, and whether the room was closed. A version 1 file is read as epoch
 * 0 with nobody removed, so a keeper upgraded in place reopens the same
 * room on the same link without anybody having done anything.
 */
export const KEEPER_STATE_VERSION = 2

export interface StoredKeeperState {
  v: 1 | 2
  secret: string
  inviterSk: string
  bearer: string
  epoch?: number
  epochSecret?: string
  removed?: string[]
  closed?: boolean
}

const HEX64 = /^[0-9a-f]{64}$/i

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
  if (state.closed) stored.closed = true
  return JSON.stringify(stored, null, 2) + '\n'
}
