import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { deriveRoom } from './room.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import {
  encodeChatEvent,
  decodeChatEvent,
  ChatLog,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_MESSAGES_PER_MINUTE,
  MAX_CHAT_TEXT_LENGTH,
  MAX_CHANNEL_NAME_LENGTH,
  deriveChannel,
} from './chat.js'
import { issueKindredProof } from './access.js'
import type { ChatMessage } from './chat.js'
import { KINDS } from './kinds.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const NOW = 1_800_000_000

async function fixture() {
  const secret = new Uint8Array(32).fill(7)
  const { roomId, roomKey } = deriveRoom(secret)
  const deviceSk = generateSecretKey()
  const device = getPublicKey(deviceSk)
  const participantSk = generateSecretKey()
  const participant = getPublicKey(participantSk)
  const credential = await createDeviceCredential({
    identity: localIdentity(participantSk),
    devicePubkey: device,
    roomId,
    expiresAt: NOW + 3600,
  })
  const msg: ChatMessage = {
    id: 'msg-1',
    participant,
    device,
    credential,
    text: 'hello room',
    sentAt: NOW,
  }
  return { roomId, roomKey, deviceSk, identity: localIdentity(participantSk), credential, msg }
}

/** A credential for `deviceSk`, minted by a freshly generated participant. */
async function credentialFor(deviceSk: Uint8Array, roomId: string) {
  const participantSk = generateSecretKey()
  return createDeviceCredential({
    identity: localIdentity(participantSk),
    devicePubkey: getPublicKey(deviceSk),
    roomId,
    expiresAt: NOW + 3600,
  })
}

describe('encodeChatEvent / decodeChatEvent', () => {
  it('round-trips a message through encryption', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    const decoded = decodeChatEvent(event, { roomId, roomKey, now: NOW })
    // Against the wire shape, not the fixture object: the ciphertext is
    // JSON, so the verifiedSymbol finalizeEvent stamps on a freshly minted
    // credential never crosses it.
    expect(decoded).toEqual(JSON.parse(JSON.stringify(msg)))
  })

  it('leaves the message text unreadable on the wire', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    const wire = JSON.stringify(event)
    expect(wire).not.toContain(msg.text)
    expect(wire).not.toContain(msg.participant)
  })

  it('tags the event with the room id so it is subscribable', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    expect(event.tags).toContainEqual(['d', roomId])
  })

  it('is a durable kind, not an ephemeral one', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    expect(event.kind).toBeGreaterThanOrEqual(1000)
    expect(event.kind).toBeLessThan(10000)
  })

  it('returns null when the room key is wrong', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    const wrongKey = new Uint8Array(32).fill(1)
    expect(decodeChatEvent(event, { roomId, roomKey: wrongKey, now: NOW })).toBeNull()
  })

  it('returns null when the room id does not match', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    expect(decodeChatEvent(event, { roomId: 'a-different-room', roomKey, now: NOW })).toBeNull()
  })

  it('returns null for malformed ciphertext rather than throwing', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = { ...encodeChatEvent(msg, { roomId, roomKey, deviceSk }), content: 'rubbish' }
    expect(() => decodeChatEvent(event, { roomId, roomKey, now: NOW })).not.toThrow()
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('returns null for a payload that decrypts but is not a chat message', async () => {
    const { roomId, roomKey, deviceSk } = await fixture()
    // Built by hand rather than via encodeChatEvent, which requires a
    // well-formed ChatMessage to construct a valid event in the first
    // place - this proves decodeChatEvent is defensive at runtime, not
    // merely type-safe at compile time.
    const content = nip44.v2.encrypt(JSON.stringify({ id: 'x', text: 'no participant, device, or sentAt' }), roomKey)
    const notAMessage = finalizeEvent({ kind: KINDS.CHAT, created_at: NOW, tags: [['d', roomId]], content }, deviceSk)
    expect(decodeChatEvent(notAMessage, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('re-verifies the signature even when the event arrives pre-marked verified', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const genuine = encodeChatEvent(msg, { roomId, roomKey, deviceSk })

    // The attacker holds the room key, so they can mint ciphertext the room
    // decodes - what they cannot do is sign it. They swap the ciphertext of a
    // genuinely signed event and set nostr-tools' own verification cache on
    // the object, which short-circuits verifyEvent for anything that reads it
    // off the raw inbound event rather than a stripped copy.
    const forgedText = 'I never said this'
    const forged: Event = {
      ...genuine,
      content: nip44.v2.encrypt(JSON.stringify({ ...msg, text: forgedText }), roomKey),
    }
    forged[verifiedSymbol] = true

    expect(decodeChatEvent(forged, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('refuses a message attributing itself to a participant the signer cannot speak for', async () => {
    const { roomId, roomKey } = await fixture()
    // The whole attack: a genuine room member signs with their own device
    // key - so the device check passes - and simply names the victim in the
    // participant field. Nothing binds the two, so the message renders under
    // the victim's pubkey, which on the victim's own screen reads as "you".
    const victim = getPublicKey(generateSecretKey())
    const attackerDeviceSk = generateSecretKey()
    const attackerParticipantSk = generateSecretKey()
    const forged: ChatMessage = {
      id: 'forged',
      participant: victim,
      device: getPublicKey(attackerDeviceSk),
      credential: await createDeviceCredential({
        identity: localIdentity(attackerParticipantSk),
        devicePubkey: getPublicKey(attackerDeviceSk),
        roomId,
        expiresAt: NOW + 3600,
      }),
      text: 'the victim never said this',
      sentAt: NOW,
    }
    const event = encodeChatEvent(forged, { roomId, roomKey, deviceSk: attackerDeviceSk })

    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('still verifies a message whose credential has expired since it was sent', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    // Chat is durable and credentials expire in hours, so a late joiner
    // reading history is always reading messages signed under credentials
    // that are dead by now. Checking against the reader's clock would make
    // all history unverifiable; checking as at sentAt keeps it honest.
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW + 999_999 })).toEqual(
      JSON.parse(JSON.stringify(msg)),
    )
  })

  it('refuses a message dated far into the future', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    // Otherwise the window in which the credential is checked could be
    // pushed forward indefinitely.
    const future = { ...msg, sentAt: NOW + 86_400 }
    const event = encodeChatEvent(future, { roomId, roomKey, deviceSk })
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('refuses a message whose credential names a different device', async () => {
    const { roomId, roomKey, msg } = await fixture()
    // The credential is genuine and the participant is genuine - but it
    // authorises somebody else's device, and this event was signed by ours.
    const otherDeviceSk = generateSecretKey()
    const stolen = { ...msg, device: getPublicKey(otherDeviceSk) }
    const event = encodeChatEvent(stolen, { roomId, roomKey, deviceSk: otherDeviceSk })
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('refuses a credential minted for a different room', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const elsewhere = await createDeviceCredential({
      identity: localIdentity(generateSecretKey()),
      devicePubkey: getPublicKey(deviceSk),
      roomId: 'some-other-room',
      expiresAt: NOW + 3600,
    })
    const event = encodeChatEvent(
      { ...msg, participant: elsewhere.pubkey, credential: elsewhere },
      { roomId, roomKey, deviceSk },
    )
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('returns null when the event claims a device that did not sign it', async () => {
    const { roomId, roomKey, msg } = await fixture()
    const impostorSk = generateSecretKey()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk: impostorSk })
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('enforces the room gate on durable chat, independently of the roster', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const hostSk = generateSecretKey()
    const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }
    const unproved = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    expect(decodeChatEvent(unproved, { roomId, roomKey, now: NOW, policy })).toBeNull()

    const proof = issueKindredProof({
      hostSk,
      participant: msg.participant,
      tier: 'kith',
      roomId,
      expiresAt: NOW + 3600,
    })
    const proved = encodeChatEvent({ ...msg, proof }, { roomId, roomKey, deviceSk })
    expect(decodeChatEvent(proved, { roomId, roomKey, now: NOW, policy })).toMatchObject({
      participant: msg.participant,
      text: msg.text,
      proof,
    })
  })

  it('refuses an oversized message at the encrypted protocol boundary', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(
      { ...msg, text: 'x'.repeat(MAX_CHAT_TEXT_LENGTH + 1) },
      { roomId, roomKey, deviceSk },
    )
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })
})

describe('ChatLog', () => {
  it('send() publishes a message that shows up in messages()', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const credential = await credentialFor(deviceSk, roomId)
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW })

    await log.send('hello')

    expect(log.messages()).toHaveLength(1)
    expect(log.messages()[0]).toMatchObject({
      participant: credential.pubkey,
      device: getPublicKey(deviceSk),
      text: 'hello',
      sentAt: NOW,
    })
  })

  it('notifies onChange listeners when a message arrives', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const credential = await credentialFor(deviceSk, roomId)
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW })
    const snapshots: number[] = []
    log.onChange((messages) => snapshots.push(messages.length))

    await log.send('hello')

    expect(snapshots.at(-1)).toBe(1)
  })

  it('orders messages by sentAt, with a deterministic id tiebreak', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const credential = await credentialFor(deviceSk, roomId)
    const participant = credential.pubkey
    const device = getPublicKey(deviceSk)

    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW })

    // Published out of order, and with a tie on sentAt, straight onto the
    // relay - ChatLog has to do the ordering itself, not just replay
    // arrival order.
    const late: ChatMessage = { id: 'b', participant, device, credential, text: 'later', sentAt: NOW + 10 }
    const tieHigh: ChatMessage = { id: 'z-tie', participant, device, credential, text: 'tie-high', sentAt: NOW }
    const tieLow: ChatMessage = { id: 'a-tie', participant, device, credential, text: 'tie-low', sentAt: NOW }

    relay.publish(encodeChatEvent(late, { roomId, roomKey, deviceSk }))
    relay.publish(encodeChatEvent(tieHigh, { roomId, roomKey, deviceSk }))
    relay.publish(encodeChatEvent(tieLow, { roomId, roomKey, deviceSk }))

    expect(log.messages().map((m) => m.text)).toEqual(['tie-low', 'tie-high', 'later'])
  })

  it('never admits a forged attribution into the log', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const credential = await credentialFor(deviceSk, roomId)
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW })

    const attackerDeviceSk = generateSecretKey()
    const forged: ChatMessage = {
      id: 'forged',
      participant: credential.pubkey, // the victim, whose log this is
      device: getPublicKey(attackerDeviceSk),
      credential: await credentialFor(attackerDeviceSk, roomId),
      text: 'rendered on the victim\u2019s own screen as \u201cyou\u201d',
      sentAt: NOW,
    }
    relay.publish(encodeChatEvent(forged, { roomId, roomKey, deviceSk: attackerDeviceSk }))

    expect(log.messages()).toHaveLength(0)
  })

  it('survives a listener that throws', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const credential = await credentialFor(deviceSk, roomId)
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW })
    log.onChange(() => {
      throw new Error('a caller render() blew up')
    })
    const seen: number[] = []
    log.onChange((messages) => seen.push(messages.length))

    await expect(log.send('hello')).resolves.toBeUndefined()
    expect(seen).toEqual([1])
  })

  it('bounds one device to thirty messages per minute', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const credential = await credentialFor(deviceSk, roomId)
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW })
    const base = {
      participant: credential.pubkey,
      device: getPublicKey(deviceSk),
      credential,
      text: 'bounded',
      sentAt: NOW,
    }
    for (let i = 0; i < MAX_CHAT_MESSAGES_PER_MINUTE + 1; i += 1) {
      relay.publish(encodeChatEvent({ ...base, id: `rate-${i}` }, { roomId, roomKey, deviceSk }))
    }
    expect(log.messages()).toHaveLength(MAX_CHAT_MESSAGES_PER_MINUTE)
  })

  it('rejects oversized sends before publishing and caps retained history', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const credential = await createDeviceCredential({
      identity: localIdentity(generateSecretKey()),
      devicePubkey: getPublicKey(deviceSk),
      roomId,
      expiresAt: NOW + 100_000,
    })
    const clock = NOW + 40_000
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => clock })
    await expect(log.send('x'.repeat(MAX_CHAT_TEXT_LENGTH + 1))).rejects.toThrow(/exceeds/)
    expect(relay.published).toHaveLength(0)

    const base = {
      participant: credential.pubkey,
      device: getPublicKey(deviceSk),
      credential,
      text: 'bounded history',
    }
    for (let i = 0; i < MAX_CHAT_MESSAGES + 1; i += 1) {
      relay.publish(encodeChatEvent(
        { ...base, id: `history-${i}`, sentAt: NOW + i * 61 },
        { roomId, roomKey, deviceSk },
      ))
    }
    expect(log.messages()).toHaveLength(MAX_CHAT_MESSAGES)
    expect(log.messages()[0]?.id).toBe('history-1')
  }, 15_000)
})

describe('chat display names', () => {
  it('carries the sender’s name with the message, so history reads after they leave', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const named = { ...msg, name: 'Darren' }
    const event = encodeChatEvent(named, { roomId, roomKey, deviceSk })
    // The roster is ephemeral and chat is durable: a message read out of
    // history was sent by somebody who may be in nobody's roster now, so
    // the name has to travel with the message rather than be looked up.
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })!.name).toBe('Darren')
  })

  it('leaves no name on the wire', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent({ ...msg, name: 'Darren' }, { roomId, roomKey, deviceSk })
    expect(JSON.stringify(event)).not.toContain('Darren')
  })

  it('neutralises a hostile name on a message', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent(
      { ...msg, name: '‮nerrad\nyou' } as ChatMessage,
      { roomId, roomKey, deviceSk },
    )
    const decoded = decodeChatEvent(event, { roomId, roomKey, now: NOW })!
    expect(decoded.name).toBe('nerrad you')
    expect(decoded.name).not.toMatch(/\p{C}/u)
  })

  it('drops a name that is not a string', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const event = encodeChatEvent({ ...msg, name: 7 } as unknown as ChatMessage, { roomId, roomKey, deviceSk })
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).not.toHaveProperty('name')
  })

  it('sends under the name the log was given, and never lets it stand for the credential', async () => {
    const { roomId, roomKey, deviceSk, identity, credential } = await fixture()
    const relay = new SimRelay()
    const log = new ChatLog({
      transport: new SimTransport(relay),
      roomId,
      roomKey,
      credential,
      deviceSk,
      name: '  Darren  ',
      now: () => NOW,
    })
    await log.send('hello room')

    const sent = log.messages()[0]
    expect(sent.name).toBe('Darren')
    // The credential is still what says who sent this.
    expect(sent.participant).toBe(identity.pubkey)
    log.close()
  })
})

describe('channels', () => {
  it('derives a channel id and key from the room key, and never from the room id', async () => {
    const { roomId, roomKey } = await fixture()
    const agents = deriveChannel(roomId, roomKey, 'agents')
    expect(agents.id).toMatch(/^[0-9a-f]{64}$/)
    expect(agents.id).not.toBe(roomId)
    expect(agents.key).not.toEqual(roomKey)
    expect(agents.key.length).toBe(32)
    // The same room, a different key: a different channel, so a party that
    // holds the room id alone can find neither.
    const other = deriveChannel(roomId, new Uint8Array(32).fill(8), 'agents')
    expect(other.id).not.toBe(agents.id)
    // Unnamed is the main chat, byte for byte.
    expect(deriveChannel(roomId, roomKey)).toEqual({ id: roomId, key: roomKey })
    // Two names, two channels.
    expect(deriveChannel(roomId, roomKey, 'transcript').id).not.toBe(agents.id)
  })

  it('keeps a channel message out of the main chat, and the main chat out of a channel', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const onChannel = encodeChatEvent(msg, { roomId, roomKey, deviceSk, channel: 'agents' })
    expect(onChannel.tags.find((t) => t[0] === 'd')?.[1]).toBe(deriveChannel(roomId, roomKey, 'agents').id)
    expect(decodeChatEvent(onChannel, { roomId, roomKey, now: NOW })).toBeNull()
    expect(decodeChatEvent(onChannel, { roomId, roomKey, now: NOW, channel: 'agents' })).toMatchObject({ text: 'hello room' })
    expect(decodeChatEvent(onChannel, { roomId, roomKey, now: NOW, channel: 'transcript' })).toBeNull()

    const onMain = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    expect(decodeChatEvent(onMain, { roomId, roomKey, now: NOW, channel: 'agents' })).toBeNull()
  })

  it('still checks the credential against the ROOM on a channel - a channel is a place in a room, not a room', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const otherRoom = deriveRoom(new Uint8Array(32).fill(8))
    // Encrypted under this room's channel, but carrying a credential for
    // another room entirely.
    const foreign = await credentialFor(deviceSk, otherRoom.roomId)
    const event = encodeChatEvent({ ...msg, credential: foreign, participant: foreign.pubkey }, { roomId, roomKey, deviceSk, channel: 'agents' })
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW, channel: 'agents' })).toBeNull()
  })

  it('two logs on different channels of one room do not hear each other', async () => {
    const { roomId, roomKey, deviceSk, credential } = await fixture()
    const relay = new SimRelay()
    const main = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW })
    const agents = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW, channel: 'agents' })
    await agents.send('plan: split the work')
    await main.send('hello everybody')
    expect(agents.messages().map((m) => m.text)).toEqual(['plan: split the work'])
    expect(main.messages().map((m) => m.text)).toEqual(['hello everybody'])
    expect(agents.channel).toBe('agents')
    expect(main.channel).toBeUndefined()
    main.close()
    agents.close()
  })

  it('refuses a channel name that is empty or absurdly long', async () => {
    const { roomId, roomKey } = await fixture()
    expect(() => deriveChannel(roomId, roomKey, '')).toThrow()
    expect(() => deriveChannel(roomId, roomKey, 'x'.repeat(MAX_CHANNEL_NAME_LENGTH + 1))).toThrow()
  })
})

describe('transcripts', () => {
  it('carries a transcript as `kind: transcript` with a speaker, and an ordinary message carries neither', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    const speakerSk = generateSecretKey()
    const speaker = getPublicKey(speakerSk)
    const event = encodeChatEvent({ ...msg, kind: 'transcript', speaker: speaker.toUpperCase() }, { roomId, roomKey, deviceSk })
    const decoded = decodeChatEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded).toMatchObject({ kind: 'transcript', speaker, text: 'hello room' })
    const plain = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    const wire = JSON.parse(nip44.v2.decrypt(plain.content, roomKey))
    expect(wire).not.toHaveProperty('kind')
    expect(wire).not.toHaveProperty('speaker')
  })

  it('reads anything that is not exactly a transcript as an ordinary message, with no speaker', async () => {
    const { roomId, roomKey, deviceSk, msg } = await fixture()
    for (const hostile of ['shout', 1, true, {}]) {
      const event = encodeChatEvent({ ...msg, kind: hostile, speaker: 'abc' } as unknown as ChatMessage, { roomId, roomKey, deviceSk })
      const decoded = decodeChatEvent(event, { roomId, roomKey, now: NOW })
      expect(decoded, `kind=${JSON.stringify(hostile)}`).not.toBeNull()
      expect(decoded).not.toHaveProperty('kind')
      expect(decoded).not.toHaveProperty('speaker')
    }
    // A transcript whose speaker is not a pubkey keeps the kind and loses
    // the speaker, which a renderer shows as "somebody said".
    const event = encodeChatEvent({ ...msg, kind: 'transcript', speaker: 'not-a-key' }, { roomId, roomKey, deviceSk })
    const decoded = decodeChatEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded?.kind).toBe('transcript')
    expect(decoded).not.toHaveProperty('speaker')
  })

  it('sends a transcript through the log with the speaker named', async () => {
    const { roomId, roomKey, deviceSk, credential } = await fixture()
    const relay = new SimRelay()
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, credential, deviceSk, now: () => NOW, channel: 'transcript' })
    const speaker = getPublicKey(generateSecretKey())
    await log.send('we should ship on friday', { transcriptOf: speaker })
    expect(log.messages()[0]).toMatchObject({ kind: 'transcript', speaker, text: 'we should ship on friday' })
    log.close()
  })
})
