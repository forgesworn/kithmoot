import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { unwrapEvent } from 'nostr-tools/nip17'
import { RoomAgent } from '../agent.js'
import { CONTROL_CHANNEL, encodeControl } from '../control.js'
import { localIdentity } from '../identity.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { NUDGE_COOLDOWN_SECONDS, Nudger, memoryNudgeStore, nip17Sender, nudgeText } from './nudge.js'

const BASE = 'https://example.test/j/'

/** Lets scheduled re-announces, admission grants and farewells run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

function transportFor(relay: SimRelay) {
  return () => new SimTransport(relay)
}

/** A keeper with a nudger on a fake clock, Ada as a signed-in person, and
 *  Bob who talks. The clock only drives the cooldown; the room runs on the
 *  real one, so presence is what the roster says. */
async function room(opts: { roomName?: string; optedIn?: string[] } = {}) {
  const relay = new SimRelay()
  const transport = transportFor(relay)
  const keeper = await RoomAgent.create({ base: BASE, roomName: opts.roomName, name: 'Keeper', relays: ['wss://sim'], transport, announceJitterMs: 0 })
  const adaSk = generateSecretKey()
  const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', identity: localIdentity(adaSk), transport, announceJitterMs: 0, agent: false })
  const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport, announceJitterMs: 0, agent: false })
  await settle()
  let clock = Math.floor(Date.now() / 1000)
  const sent: { to: string; text: string }[] = []
  const store = memoryNudgeStore(opts.optedIn)
  const nudger = new Nudger({
    agent: keeper,
    send: async (to, text) => void sent.push({ to, text }),
    store,
    now: () => clock,
  })
  await nudger.start()
  const rejoinAda = async () => {
    const again = await RoomAgent.join({ link: keeper.url, name: 'Ada', identity: localIdentity(adaSk), transport, announceJitterMs: 0, agent: false })
    await settle()
    return again
  }
  return { relay, keeper, ada, adaSk, bob, sent, store, nudger, transport, rejoinAda, advance: (s: number) => void (clock += s) }
}

describe('the keeper nudges members who asked', () => {
  it('opts a member in on their signed word, records it, and nudges them once they are away', async () => {
    const { keeper, ada, bob, sent, store, nudger } = await room({ roomName: 'Town hall' })
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'nudge', on: true }))
    await settle()
    expect(nudger.optedIn()).toEqual([ada.participant])
    expect(await store.load()).toEqual([ada.participant])

    // Present: a message is something she can see for herself.
    await bob.chat.send('anyone about?')
    await settle()
    expect(sent).toEqual([])

    await ada.leave()
    await settle()
    expect(keeper.roster().map((v) => v.participant)).not.toContain(ada.participant)
    await bob.chat.send('going ahead without you then')
    await settle()
    expect(sent).toEqual([{ to: ada.participant, text: nudgeText('Town hall', keeper.url) }])
    expect(sent[0]!.text).toContain(keeper.url)
    nudger.stop()
    bob.leave()
    keeper.leave()
  })

  it('sends one an hour at most, and not again until they have been back since', async () => {
    const { keeper, ada, bob, sent, nudger, rejoinAda, advance } = await room()
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'nudge', on: true }))
    await ada.leave()
    await settle()
    await bob.chat.send('one')
    await bob.chat.send('two')
    await settle()
    expect(sent).toHaveLength(1)

    // Back, then gone again inside the hour: too soon.
    const again = await rejoinAda()
    await again.leave()
    await settle()
    await bob.chat.send('three')
    await settle()
    expect(sent).toHaveLength(1)

    // The hour is up and they have been back since: nudged again.
    advance(NUDGE_COOLDOWN_SECONDS)
    await bob.chat.send('four')
    await settle()
    expect(sent).toHaveLength(2)

    // Another hour, still away: they were told, and have not looked.
    advance(NUDGE_COOLDOWN_SECONDS)
    await bob.chat.send('five')
    await settle()
    expect(sent).toHaveLength(2)
    expect(sent.every((s) => s.to === ada.participant)).toBe(true)
    nudger.stop()
    bob.leave()
    keeper.leave()
  })

  it('stops on the member’s word, the newest word winning, and never nudges the person who spoke', async () => {
    const { keeper, ada, bob, sent, nudger, store } = await room()
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'nudge', on: true }))
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'nudge', on: false }))
    await settle()
    expect(nudger.optedIn()).toEqual([])
    expect(await store.load()).toEqual([])
    await ada.leave()
    await settle()
    await bob.chat.send('hello?')
    await settle()
    expect(sent).toEqual([])

    // Bob asks, then speaks while he is the only one here: his own
    // message is not news to him.
    await bob.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'nudge', on: true }))
    await settle()
    await bob.chat.send('talking to myself')
    await settle()
    expect(sent).toEqual([])
    nudger.stop()
    bob.leave()
    keeper.leave()
  })

  it('starts from the list it kept, and treats what was said before it started as history', async () => {
    const relay = new SimRelay()
    const transport = transportFor(relay)
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport, announceJitterMs: 0 })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0, agent: false })
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport, announceJitterMs: 0, agent: false })
    await settle()
    await ada.leave()
    await settle()
    await bob.chat.send('said before the keeper was watching')
    const sent: { to: string; text: string }[] = []
    // Restarted two minutes later, by its own clock, with Ada on its list.
    const nudger = new Nudger({
      agent: keeper,
      send: async (to, text) => void sent.push({ to, text }),
      store: memoryNudgeStore([ada.participant]),
      now: () => Math.floor(Date.now() / 1000) + 120,
    })
    await nudger.start()
    await settle()
    expect(nudger.optedIn()).toEqual([ada.participant])
    expect(sent).toEqual([])
    nudger.stop()
    bob.leave()
    keeper.leave()
  })

  it('a keeper keeps who asked in its own state, through the same hand that saves an epoch', async () => {
    const relay = new SimRelay()
    const saved: string[][] = []
    const keeper = await RoomAgent.create({
      base: BASE,
      name: 'Keeper',
      relays: ['wss://sim'],
      transport: transportFor(relay),
      announceJitterMs: 0,
      onState: (state) => void saved.push(state.nudge ?? []),
    })
    const ada = 'ad'.repeat(32)
    await keeper.amendKeeperState({ nudge: [ada, ada] })
    expect(keeper.keeperState?.nudge).toEqual([ada])
    await keeper.amendKeeperState({ nudge: [] })
    expect(keeper.keeperState?.nudge).toBeUndefined()
    expect(saved).toEqual([[ada], []])
    keeper.leave()
  })

  it('the real sender wraps the text as a NIP-17 DM only the member can open, from the keeper’s key', async () => {
    const relay = new SimRelay()
    const keeperSk = generateSecretKey()
    const adaSk = generateSecretKey()
    const ada = getPublicKey(adaSk)
    const send = nip17Sender(keeperSk, new SimTransport(relay))
    await send(ada, nudgeText('Bench', 'https://example.test/j/#x'))
    expect(relay.published).toHaveLength(1)
    const wrap = relay.published[0]!
    expect(wrap.kind).toBe(1059)
    expect(wrap.tags).toEqual([['p', ada]])
    // The wrap is signed by a throwaway key, not the keeper's.
    expect(wrap.pubkey).not.toBe(getPublicKey(keeperSk))
    const rumor = unwrapEvent(wrap, adaSk)
    expect(rumor.kind).toBe(14)
    expect(rumor.pubkey).toBe(getPublicKey(keeperSk))
    expect(rumor.content).toBe(nudgeText('Bench', 'https://example.test/j/#x'))
  })
})
