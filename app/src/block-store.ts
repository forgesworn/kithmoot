/**
 * Who this account has blocked on this device.
 *
 * A block here is the account's own, kept per browser and per account and
 * never published: not to the Nostr mute list, which anybody can read, and
 * not to the person blocked, who is never told. It refuses what a Signet
 * block refuses (`contactIsBlocked` in main.ts takes either): their private
 * invitations, their knocks and requests to join, and starting a private
 * chat with them. A private chat already open with them stays until it is
 * left.
 *
 * One key per blocked person, so blocking and unblocking never rewrite a
 * shared list. A record that cannot be read is dropped from the list rather
 * than guessed at; it holds nobody's secret.
 *
 * Pure functions over the injected `DeviceStore`, like the other stores.
 */
import type { DeviceStore } from './device-store.js'

export const BLOCK_PREFIX = 'kithmoot.blocks.v1.'

/** A generous cap, refused rather than evicted: dropping the oldest block
 *  would quietly let somebody back in. */
export const MAX_BLOCKS = 2000

const HEX64 = /^[0-9a-f]{64}$/

export interface Block {
  participant: string
  /** Milliseconds. */
  blockedAt: number
}

function prefixFor(account: string): string {
  if (!HEX64.test(account)) throw new Error('An account key is 64 hex characters.')
  return `${BLOCK_PREFIX}${account}.`
}

/** Everybody this account has blocked here, newest first. */
export function blocksFor(store: DeviceStore, account: string): Block[] {
  const prefix = prefixFor(account)
  const out: Block[] = []
  for (const key of store.keys()) {
    if (!key.startsWith(prefix)) continue
    try {
      const parsed = JSON.parse(store.get(key) ?? '') as Partial<Block>
      if (typeof parsed.participant !== 'string' || !HEX64.test(parsed.participant) || key !== prefix + parsed.participant) continue
      if (typeof parsed.blockedAt !== 'number' || !Number.isFinite(parsed.blockedAt)) continue
      out.push({ participant: parsed.participant, blockedAt: parsed.blockedAt })
    } catch {
      // Unreadable: not a block this device can vouch for.
    }
  }
  return out.sort((a, b) => b.blockedAt - a.blockedAt)
}

export function blockParticipant(store: DeviceStore, account: string, participant: string, now: number): void {
  const prefix = prefixFor(account)
  const key = participant.toLowerCase()
  if (!HEX64.test(key)) throw new Error('A participant key is 64 hex characters.')
  if (key === account) throw new Error('You cannot block yourself.')
  if (store.get(prefix + key) === null && blocksFor(store, account).length >= MAX_BLOCKS) {
    throw new Error('This device already holds as many blocks as it can. Unblock somebody first.')
  }
  store.set(prefix + key, JSON.stringify({ participant: key, blockedAt: now }))
}

export function unblockParticipant(store: DeviceStore, account: string, participant: string): void {
  store.remove(prefixFor(account) + participant.toLowerCase())
}
