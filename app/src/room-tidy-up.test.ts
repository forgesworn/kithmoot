import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { deletionTemplate, runTidyUp, tidyUpSteps, type TidyUpDeps } from './room-tidy-up.js'
import type { PublicDeletionRelayOutcome } from './public-deletion-relay-writer.js'

const NOW = 1_800_000_000
const ROOM_RELAYS = ['wss://a.example', 'wss://b.example']
const ACCOUNT_RELAYS = ['wss://b.example', 'wss://c.example']

/** Relays that store everything and honour NIP-09 from the same author. */
function relays(refuse: (relay: string, event: Event) => boolean = () => false) {
  const stores = new Map<string, Event[]>()
  const published: Array<{ relays: readonly string[]; event: Event }> = []
  const put = (relay: string, event: Event) => {
    const list = stores.get(relay) ?? []
    list.push(event)
    stores.set(relay, list)
  }
  const deps = {
    read: async (relay: string, filter: Filter) => ({ terminal: 'complete' as const, events: (stores.get(relay) ?? []).filter(e => matchFilters([filter], e)) }),
    publish: async (to: readonly string[], event: Event): Promise<PublicDeletionRelayOutcome[]> => {
      published.push({ relays: to, event })
      return to.map(relay => {
        if (refuse(relay, event)) return { relay, status: 'refused' as const, detail: 'blocked' }
        const ids = new Set(event.tags.filter(t => t[0] === 'e').map(t => t[1]))
        const addresses = new Set(event.tags.filter(t => t[0] === 'a').map(t => t[1]))
        stores.set(relay, (stores.get(relay) ?? []).filter(e => e.pubkey !== event.pubkey
          || !(ids.has(e.id) || addresses.has(`${e.kind}:${e.pubkey}:${e.tags.find(t => t[0] === 'd')?.[1]}`))))
        put(relay, event)
        return { relay, status: 'accepted' as const }
      })
    },
  }
  return { stores, published, put, deps }
}

function signed(sk: Uint8Array, kind: number, tags: string[][] = [], at = NOW - 100): Event {
  return finalizeEvent({ kind, created_at: at, tags, content: 'x' }, sk)
}

function setup(refuse?: (relay: string, event: Event) => boolean) {
  const r = relays(refuse)
  const inviterSk = generateSecretKey(), deviceSk = generateSecretKey(), accountSk = generateSecretKey(), otherSk = generateSecretKey()
  const invitationId = 'f'.repeat(64)
  for (const relay of ROOM_RELAYS) {
    r.put(relay, signed(inviterSk, 1463, [['d', invitationId]]))
    r.put(relay, signed(inviterSk, 1461, [['d', invitationId]]))
    r.put(relay, signed(deviceSk, 1460, [['d', 'room']]))
    r.put(relay, signed(deviceSk, 20461, [['d', 'room']]))
    r.put(relay, signed(otherSk, 1460, [['d', 'room']]))
  }
  for (const relay of ACCOUNT_RELAYS) {
    r.put(relay, signed(accountSk, 30078, [['d', 'read-d']]))
    r.put(relay, signed(accountSk, 30078, [['d', 'kithmoot.rooms.v1.tomb']]))
  }
  const order: string[] = []
  const deps: TidyUpDeps = {
    now: () => NOW,
    roomRelays: ROOM_RELAYS,
    accountRelays: ACCOUNT_RELAYS,
    read: r.deps.read,
    publish: r.deps.publish,
    inviter: { sk: inviterSk, invitationId },
    device: { sk: deviceSk },
    account: {
      pubkey: getPublicKey(accountSk),
      sign: async (template: EventTemplate) => finalizeEvent(template, accountSk),
      readPositionD: 'read-d',
      forgetBookmark: async () => { order.push('bookmark'); return 'kithmoot.rooms.v1.tomb' },
      deleteTombstone: true,
    },
    otherTabsAnswer: async () => true,
    leaveOtherTabs: async () => { order.push('tabs'); return true },
    leaveHere: async () => { order.push('here') },
    clearLocal: () => { order.push('local') },
  }
  return { r, deps, order, inviterSk, deviceSk, accountSk, otherSk }
}

const kindsOf = (event: Event) => event.tags.filter(t => t[0] === 'k').map(t => Number(t[1]))

describe('leave and tidy up', () => {
  it('lists every step before running, creator and account steps only when they apply', () => {
    expect(tidyUpSteps({ creator: true, account: true, deleteTombstone: true }).map(s => s.id))
      .toEqual(['invitations', 'retirement', 'tabs', 'device', 'bookmark', 'account', 'local', 'check'])
    expect(tidyUpSteps({ creator: false, account: false, deleteTombstone: false }).map(s => s.id))
      .toEqual(['tabs', 'device', 'local', 'check'])
  })

  it('deletes in order while the keys exist, names addressable records by e and a, and finds nothing of theirs afterwards', async () => {
    const { r, deps, order, inviterSk, deviceSk, accountSk, otherSk } = setup()
    const report = await runTidyUp(deps)

    expect(report.refused).toBeUndefined()
    const requests = r.published.map(p => ({ by: p.event.pubkey, kinds: kindsOf(p.event), a: p.event.tags.filter(t => t[0] === 'a').map(t => t[1]) }))
    expect(requests).toEqual([
      { by: getPublicKey(inviterSk), kinds: [1463], a: [] },
      { by: getPublicKey(inviterSk), kinds: [1461], a: [] },
      { by: getPublicKey(deviceSk), kinds: [1460, 20461], a: [] },
      { by: getPublicKey(accountSk), kinds: [30078], a: [`30078:${getPublicKey(accountSk)}:read-d`, `30078:${getPublicKey(accountSk)}:kithmoot.rooms.v1.tomb`] },
    ])
    expect(r.published[3]!.event.tags.filter(t => t[0] === 'e')).toHaveLength(2)
    expect(order).toEqual(['tabs', 'here', 'bookmark', 'local'])
    expect(report.remaining).toEqual([])
    expect(report.steps.map(s => s.id)).toEqual(['invitations', 'retirement', 'tabs', 'device', 'bookmark', 'account', 'local', 'check'])
    // Somebody else's message is theirs.
    for (const relay of ROOM_RELAYS) expect(r.stores.get(relay)!.some(e => e.pubkey === getPublicKey(otherSk))).toBe(true)
  })

  it('keeps the retirement notice when a relay refused to delete the group invitation', async () => {
    const { r, deps } = setup((relay, event) => relay === 'wss://b.example' && kindsOf(event).includes(1463))
    const report = await runTidyUp(deps)
    const retirement = report.steps.find(s => s.id === 'retirement')!
    expect(retirement.skipped).toMatch(/old link would open the room again/)
    expect(r.published.some(p => kindsOf(p.event).includes(1461))).toBe(false)
    expect(report.steps.find(s => s.id === 'invitations')!.answers).toContainEqual({ relay: 'wss://b.example', status: 'refused', detail: 'blocked' })
    expect(report.remaining).toContainEqual({ what: 'Link-key records', relay: 'wss://b.example', count: 2 })
  })

  it('ends the room first when asked, so the ended retirement is among what is tidied', async () => {
    const { r, deps, order } = setup()
    const report = await runTidyUp({ ...deps, endRoom: async () => { order.push('end') } })
    expect(order[0]).toBe('end')
    expect(report.steps.map(s => s.id).slice(0, 3)).toEqual(['end', 'invitations', 'retirement'])
    expect(r.published.map(p => kindsOf(p.event))[1]).toEqual([1461])
    expect(tidyUpSteps({ creator: true, account: false, deleteTombstone: false, end: true })[0]!.id).toBe('end')
  })

  it('refuses before deleting anything while another tab in the room does not answer', async () => {
    const { r, deps, order } = setup()
    const report = await runTidyUp({ ...deps, otherTabsAnswer: async () => false })
    expect(report.refused).toMatch(/Another tab/)
    expect(r.published).toEqual([])
    expect(order).toEqual([])
  })

  it('a visitor with no account and no link keys tidies only the device, in bounded requests', async () => {
    const { r, deps, deviceSk } = setup()
    for (let i = 0; i < 650; i++) r.put(ROOM_RELAYS[0]!, signed(deviceSk, 1460, [['d', 'room']], NOW - 1000 - i))
    const { inviter: _i, account: _a, ...visitor } = deps
    const report = await runTidyUp(visitor)
    const device = r.published.filter(p => p.event.pubkey === getPublicKey(deviceSk))
    expect(device).toHaveLength(3)
    expect(device.every(p => p.event.tags.filter(t => t[0] === 'e').length <= 300)).toBe(true)
    expect(report.remaining).toEqual([])
    expect(report.steps.map(s => s.id)).toEqual(['tabs', 'device', 'local', 'check'])
  })

  it('never asks to delete a deletion request', () => {
    const sk = generateSecretKey()
    const template = deletionTemplate([signed(sk, 1460), signed(sk, 20461)], NOW)
    expect(template.kind).toBe(5)
    expect(template.tags.filter(t => t[0] === 'k')).toEqual([['k', '1460'], ['k', '20461']])
  })
})
