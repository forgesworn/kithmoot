import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { deletionTemplate, runTidyUp, tidyUpSteps, type TidyUpDeps } from './room-tidy-up.js'
import type { PublicDeletionRelayOutcome } from './public-deletion-relay-writer.js'
import { deriveRoom } from '../../src/room.js'
import { chatStreamsOf, encodeChatEvent, type ChatMessage } from '../../src/chat.js'

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
  it('does not report local cleanup done when archive deletion rejects', async () => {
    const { deps, order } = setup()
    const completed: string[] = []
    deps.progress = step => completed.push(step.id)
    deps.clearLocal = async () => { throw new Error('archive deletion refused') }
    await expect(runTidyUp(deps)).rejects.toThrow('archive deletion refused')
    expect(completed).not.toContain('local')
    expect(order).not.toContain('local')
  })

  it('does not report local cleanup complete before archive deletion settles', async () => {
    const { deps, order } = setup()
    let release!: () => void
    let started!: () => void
    const clearing = new Promise<void>(resolve => { started = resolve })
    const cleared = new Promise<void>(resolve => { release = resolve })
    deps.clearLocal = async () => { started(); await cleared; order.push('local') }
    let finished = false
    const running = runTidyUp(deps).then(report => { finished = true; return report })
    await clearing
    expect(finished).toBe(false)
    expect(order).not.toContain('local')
    release()
    const report = await running
    expect(report.steps.at(-1)?.id).toBe('local')
    expect(order).toContain('local')
  })

  it('asks for this device\'s chat envelope 2 messages under their own keys, and counts what is left', async () => {
    const { r, deps, deviceSk, otherSk } = setup()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(3))
    const msg = (sk: Uint8Array, id: string): ChatMessage => ({ id, participant: 'cd'.repeat(32), device: getPublicKey(sk), credential: {} as ChatMessage['credential'], text: 'hi', sentAt: NOW - 50 })
    const mine = encodeChatEvent(msg(deviceSk, 'mine-1'), { roomId, roomKey, deviceSk, envelope: 2 })
    const theirs = encodeChatEvent(msg(otherSk, 'theirs-1'), { roomId, roomKey, deviceSk: otherSk, envelope: 2 })
    for (const relay of ROOM_RELAYS) { r.put(relay, mine); r.put(relay, theirs) }
    deps.chatStreams = chatStreamsOf([{ id: roomId, key: roomKey }], [undefined])
    const report = await runTidyUp(deps)
    const asked = r.published.filter(p => p.event.kind === 5 && p.event.pubkey === mine.pubkey)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.event.tags).toContainEqual(['e', mine.id])
    expect(r.published.some(p => p.event.kind === 5 && p.event.tags.some(t => t[0] === 'e' && t[1] === theirs.id))).toBe(false)
    for (const relay of ROOM_RELAYS) {
      expect(r.stores.get(relay)!.some(e => e.id === mine.id)).toBe(false)
      expect(r.stores.get(relay)!.some(e => e.id === theirs.id)).toBe(true)
    }
    expect(report.steps.find(s => s.id === 'device')!.found).toBe(3)
    expect(report.remaining.filter(x => x.what === 'This device’s chat')).toEqual([])
  })

  it.each([false, true])('checks capped chat history without losing older own messages (same-second page: %s)', async tied => {
    const { r, deps, deviceSk, otherSk, order } = setup()
    const relay = ROOM_RELAYS[0]!
    deps.roomRelays = [relay]
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(4))
    const msg = (sk: Uint8Array, id: string, sentAt: number): ChatMessage => ({ id, participant: 'cd'.repeat(32), device: getPublicKey(sk), credential: {} as ChatMessage['credential'], text: 'history', sentAt })
    const mine = encodeChatEvent(msg(deviceSk, 'older-mine', NOW - 2000), { roomId, roomKey, deviceSk, envelope: 2 })
    r.put(relay, mine)
    for (let i = 0; i < 1000; i++) r.put(relay, encodeChatEvent(msg(otherSk, `foreign-${i}`, tied ? NOW - 100 : NOW - 1000 + i), { roomId, roomKey, deviceSk: otherSk, envelope: 2 }))
    deps.chatStreams = chatStreamsOf([{ id: roomId, key: roomKey }], [undefined])
    const reads: Filter[] = []
    // A real capped relay returns newest-first, with an inclusive until.
    deps.read = async (url, filter) => {
      reads.push(filter)
      return { terminal: 'complete', events: (r.stores.get(url) ?? []).filter(e => matchFilters([filter], e)).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, filter.limit) }
    }
    const report = await runTidyUp(deps)
    if (tied) {
      expect(report.localRetained).toContain('Local room keys and upload records were retained')
      expect(order).not.toContain('local')
      expect(order).not.toContain('bookmark')
      expect(report.steps.find(s => s.id === 'device')!.unread).toContain(relay)
      expect(report.remaining.some(r => r.count === -1)).toBe(true)
      expect(r.stores.get(relay)!.some(e => e.id === mine.id)).toBe(true)
    } else {
      expect(r.published.some(p => p.event.pubkey === mine.pubkey && p.event.tags.some(t => t[0] === 'e' && t[1] === mine.id))).toBe(true)
      expect(r.stores.get(relay)!.some(e => e.id === mine.id)).toBe(false)
      expect(report.localRetained).toBeUndefined()
      expect(order).toContain('local')
      expect(report.remaining).toEqual([])
    }
    expect(reads.some(filter => filter.until !== undefined)).toBe(true)
  }, 30_000)

  it('retains custody when new traffic saturates the final chat check', async () => {
    const { r, deps, deviceSk, otherSk, order } = setup()
    const relay = ROOM_RELAYS[0]!
    deps.roomRelays = [relay]
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(5))
    deps.chatStreams = chatStreamsOf([{ id: roomId, key: roomKey }], [undefined])
    deps.read = async (url, filter) => ({ terminal: 'complete', events: (r.stores.get(url) ?? []).filter(e => matchFilters([filter], e)).sort((a, b) => b.created_at - a.created_at).slice(0, filter.limit) })
    deps.files = async () => {
      for (let i = 0; i < 1000; i++) {
        const msg: ChatMessage = { id: `new-${i}`, participant: 'cd'.repeat(32), device: getPublicKey(otherSk), credential: {} as ChatMessage['credential'], text: 'new traffic', sentAt: NOW }
        r.put(relay, encodeChatEvent(msg, { roomId, roomKey, deviceSk: otherSk, envelope: 2 }))
      }
      return { found: 0, deleted: 0, refused: 0, pending: 0, details: [] }
    }
    const report = await runTidyUp(deps)
    expect(report.localRetained).toContain('final chat history check was incomplete')
    expect(report.remaining.some(r => r.count === -1)).toBe(true)
    expect(order).not.toContain('local')
    expect(report.steps.some(s => s.id === 'check')).toBe(true)
    expect(report.steps.some(s => s.id === 'local')).toBe(false)
  }, 30_000)

  it('lists every step before running, creator and account steps only when they apply', () => {
    expect(tidyUpSteps({ creator: true, account: true, deleteTombstone: true }).map(s => s.id))
      .toEqual(['invitations', 'retirement', 'tabs', 'device', 'bookmark', 'account', 'check', 'local'])
    expect(tidyUpSteps({ creator: false, account: false, deleteTombstone: false }).map(s => s.id))
      .toEqual(['tabs', 'device', 'check', 'local'])
  })

  it('asks the file server after the device’s deletions and before the wipe, with the device’s events', async () => {
    expect(tidyUpSteps({ creator: false, account: true, deleteTombstone: false, files: true }).map(s => s.id))
      .toEqual(['tabs', 'device', 'files', 'bookmark', 'account', 'check', 'local'])
    const { r, deps, order, deviceSk } = setup()
    const announced = signed(deviceSk, 1063, [['url', `https://files.example/${'ab'.repeat(32)}`], ['x', 'ab'.repeat(32)]])
    for (const relay of ROOM_RELAYS) r.put(relay, announced)
    let given: readonly Event[] = []
    deps.files = async events => {
      order.push('files')
      // The device's NIP-09 request has already gone.
      expect(r.published.some(p => p.event.pubkey === getPublicKey(deviceSk) && p.event.kind === 5)).toBe(true)
      given = events
      return { found: 1, deleted: 1, refused: 0, pending: 0, details: [] }
    }
    const report = await runTidyUp(deps)
    expect(order).toEqual(['tabs', 'here', 'files', 'bookmark', 'local'])
    expect(given.map(e => e.id)).toContain(announced.id)
    const files = report.steps.find(s => s.id === 'files')!
    expect(files.found).toBe(1)
    expect(files.files?.deleted).toBe(1)
    expect(files.label).toBe('Ask the file server to delete the files this device shared in the room')
  })

  it('retains local custody and pauses account cleanup when the file step throws', async () => {
    const { deps, order } = setup()
    deps.files = async () => { throw new Error('no device key') }
    const report = await runTidyUp(deps)
    expect(order).not.toContain('local')
    expect(order).not.toContain('bookmark')
    expect(report.localRetained).toContain('Local room keys and upload records were retained')
    expect(report.refused).toBeUndefined()
    expect(report.steps.find(s => s.id === 'files')?.skipped).toBe('File cleanup paused: no device key')
  })

  it('retains keys and upload records when a historical file target was refused', async () => {
    const { deps, order } = setup()
    deps.files = async () => ({found: 1, deleted: 0, refused: 1, pending: 0, details: []})
    const report = await runTidyUp(deps)
    expect(order).not.toContain('local'); expect(order).not.toContain('bookmark')
    expect(report.localRetained).toContain('Some file targets could not be verified')
    expect(report.steps.find(s => s.id === 'files')?.files?.refused).toBe(1)
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
    expect(report.steps.map(s => s.id)).toEqual(['invitations', 'retirement', 'tabs', 'device', 'bookmark', 'account', 'check', 'local'])
    // Somebody else's message is theirs.
    for (const relay of ROOM_RELAYS) expect(r.stores.get(relay)!.some(e => e.pubkey === getPublicKey(otherSk))).toBe(true)
  })

  it('stops this browser’s read positions before deleting them, and covers a marker that lands during the request', async () => {
    const { r, deps, order, accountSk } = setup()
    // The read position published on a delay while the tidy-up ran: it is
    // newer than the deletion, so the request that was already in flight
    // cannot reach it. This is the CI race, forced.
    let raced = false
    const late = signed(accountSk, 30078, [['d', 'read-d'], ['l', 'kithmoot.read.v1']], NOW + 1)
    const publish: TidyUpDeps['publish'] = async (to, event) => {
      const answers = await r.deps.publish(to, event)
      if (!raced && event.pubkey === getPublicKey(accountSk)) {
        raced = true
        for (const relay of ACCOUNT_RELAYS) r.put(relay, late)
      }
      return answers
    }
    const report = await runTidyUp({ ...deps, publish, stopReadPositions: async () => { order.push('reads') } })

    // Nothing of the account's is left for the room, whatever the timing.
    expect(report.remaining).toEqual([])
    for (const relay of ACCOUNT_RELAYS) expect(r.stores.get(relay)!.filter(e => e.kind === 30078)).toEqual([])
    const account = r.published.filter(p => p.event.pubkey === getPublicKey(accountSk))
    expect(account).toHaveLength(2)
    expect(account[1]!.event.tags.filter(t => t[0] === 'e').map(t => t[1])).toEqual([late.id])
    expect(report.steps.find(s => s.id === 'account')!.found).toBe(3)
    // Stopped once every tab is out of the room, before anything of the
    // account's is looked for or deleted.
    expect(order).toEqual(['tabs', 'here', 'reads', 'bookmark', 'local'])
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
    expect(report.steps.map(s => s.id)).toEqual(['tabs', 'device', 'check', 'local'])
  })

  it('never asks to delete a deletion request', () => {
    const sk = generateSecretKey()
    const template = deletionTemplate([signed(sk, 1460), signed(sk, 20461)], NOW)
    expect(template.kind).toBe(5)
    expect(template.tags.filter(t => t[0] === 'k')).toEqual([['k', '1460'], ['k', '20461']])
  })
})
