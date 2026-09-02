import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { parseKeeperState, serialiseKeeperState } from './keeper-state.js'

const secret = new Uint8Array(32).fill(1)
const inviterSk = new Uint8Array(32).fill(2)
const bearer = new Uint8Array(32).fill(3)
const epochSecret = new Uint8Array(32).fill(4)

describe('keeper state', () => {
  it('reads a version 1 file as epoch 0 with nobody removed', () => {
    const v1 = JSON.stringify({ v: 1, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer) })
    expect(parseKeeperState(v1)).toEqual({ secret, inviterSk, bearer, epoch: 0, removed: [] })
  })

  it('round-trips an epoch, its secret, the removed set and a closed room', () => {
    const removed = ['CD'.repeat(32), 'ab'.repeat(32), 'ab'.repeat(32)]
    const json = serialiseKeeperState({ secret, inviterSk, bearer, epoch: 3, epochSecret, removed, closed: true })
    const parsed = JSON.parse(json)
    expect(parsed.v).toBe(2)
    expect(parseKeeperState(json)).toEqual({
      secret,
      inviterSk,
      bearer,
      epoch: 3,
      epochSecret,
      removed: ['ab'.repeat(32), 'cd'.repeat(32)],
      closed: true,
    })
  })

  it('writes epoch 0 without a secret and refuses a later epoch without one', () => {
    const json = serialiseKeeperState({ secret, inviterSk, bearer })
    expect(JSON.parse(json)).toEqual({ v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer), epoch: 0, removed: [] })
    expect(() => serialiseKeeperState({ secret, inviterSk, bearer, epoch: 1 })).toThrow(/secret/)
    expect(() => parseKeeperState(JSON.stringify({ v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer), epoch: 1 }))).toThrow(/epochSecret/)
  })

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => parseKeeperState('{"v":3}')).toThrow(/version/)
    expect(() => parseKeeperState(JSON.stringify({ v: 1, secret: 'short', inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer) }))).toThrow(/secret/)
    expect(() => parseKeeperState(JSON.stringify({ v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer), removed: ['x'] }))).toThrow(/removed/)
  })
})
