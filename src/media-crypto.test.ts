import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { deriveRoom } from './room.js'
import {
  IV_LENGTH,
  SALT_LENGTH,
  TAG_LENGTH,
  TRAILER_LENGTH,
  createFrameDecryptor,
  createFrameEncryptor,
  decryptFrame,
  deriveMediaKey,
  encryptFrame,
  frameIv,
  installTransforms,
  randomFrameSalt,
  resolveFrameSender,
  unencryptedPrefixLength,
  type EncodedFrameLike,
  type FrameSink,
} from './media-crypto.js'

const ROOM_SECRET = new Uint8Array(32).fill(5)
const { roomId, roomKey } = deriveRoom(ROOM_SECRET)
const KEY = deriveMediaKey(roomKey)
const SALT = new Uint8Array(SALT_LENGTH).fill(1)

describe('deriveMediaKey', () => {
  it('derives a 32-byte key deterministically', () => {
    expect(deriveMediaKey(roomKey)).toHaveLength(32)
    expect(deriveMediaKey(roomKey)).toEqual(deriveMediaKey(roomKey))
  })

  it('is not the room key, nor anything else already derived from the secret', () => {
    // A media key that doubled as the room key would mean handing a
    // forwarder the ability to decrypt media implies handing it the roster
    // too - and the whole design turns on those being separable.
    const media = bytesToHex(deriveMediaKey(roomKey))
    expect(media).not.toBe(bytesToHex(roomKey))
    expect(media).not.toBe(bytesToHex(ROOM_SECRET))
    expect(media).not.toBe(roomId)
    // And derived from the room key under an info string of its own, so it
    // is not simply the room id in another dress either.
    expect(media).not.toBe(bytesToHex(deriveRoom(roomKey).roomKey))
  })

  it('separates two rooms', () => {
    const other = deriveRoom(new Uint8Array(32).fill(6))
    expect(deriveMediaKey(other.roomKey)).not.toEqual(deriveMediaKey(roomKey))
  })

  it('refuses a room key that is not 32 bytes', () => {
    expect(() => deriveMediaKey(new Uint8Array(16))).toThrow()
  })
})

describe('deriveMediaKey, bound to a sender', () => {
  const ALICE = 'a'.repeat(64)
  const CAROL = 'c'.repeat(64)

  it('gives each sender a different key from the same room key', () => {
    expect(deriveMediaKey(roomKey, ALICE)).not.toEqual(deriveMediaKey(roomKey, CAROL))
    expect(deriveMediaKey(roomKey, ALICE)).not.toEqual(deriveMediaKey(roomKey))
  })

  it('is deterministic, and case-insensitive in the device pubkey', () => {
    expect(deriveMediaKey(roomKey, ALICE)).toEqual(deriveMediaKey(roomKey, ALICE.toUpperCase()))
  })

  it('is derivable by every member, because it needs only the room key', () => {
    // Not a secret between two devices: everybody in the room holds the room
    // key, so everybody can open everybody's media. The binding is about
    // *which* sender a frame came from, not about who may read it.
    const asAlice = deriveMediaKey(roomKey, ALICE)
    const asAnybodyElse = deriveMediaKey(deriveRoom(ROOM_SECRET).roomKey, ALICE)
    expect(asAlice).toEqual(asAnybodyElse)
  })

  it('refuses a device that is not a 32-byte pubkey', () => {
    // A typo would otherwise derive a perfectly good key that nothing can
    // ever decrypt with, which presents as a black tile and no error.
    for (const bad of ['', 'deadbeef', `${ALICE}ff`, 'z'.repeat(64)]) {
      expect(() => deriveMediaKey(roomKey, bad), bad).toThrow()
    }
  })

  // This is what stops a forwarder relabelling one member's stream as
  // another's. It cannot produce media, but without this it could take
  // Alice's real ciphertext and present it on the track the roster says is
  // Carol's - and every frame would decrypt perfectly.
  it("means one sender's frames do not open under another sender's key", () => {
    const frame = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1])
    const sealed = encryptFrame(frame, deriveMediaKey(roomKey, ALICE), frameIv(SALT, 0), 1)
    expect(decryptFrame(sealed, deriveMediaKey(roomKey, ALICE))).toEqual(frame)
    expect(decryptFrame(sealed, deriveMediaKey(roomKey, CAROL))).toBeNull()
    expect(decryptFrame(sealed, deriveMediaKey(roomKey))).toBeNull()
  })
})

describe('resolveFrameSender', () => {
  const ALICE = 'a'.repeat(64)
  const BOB = 'b'.repeat(64)
  const CAROL = 'c'.repeat(64)
  const frame = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

  it('names the device whose key actually opens the frame', () => {
    const sealed = encryptFrame(frame, deriveMediaKey(roomKey, BOB), frameIv(SALT, 0), 1)
    expect(resolveFrameSender(sealed, roomKey, [ALICE, BOB, CAROL])).toBe(BOB)
  })

  it('returns null when no candidate opens it, rather than guessing', () => {
    const sealed = encryptFrame(frame, deriveMediaKey(roomKey, BOB), frameIv(SALT, 0), 1)
    expect(resolveFrameSender(sealed, roomKey, [ALICE, CAROL])).toBeNull()
  })

  it('ignores a malformed candidate rather than throwing on it', () => {
    const sealed = encryptFrame(frame, deriveMediaKey(roomKey, BOB), frameIv(SALT, 0), 1)
    expect(resolveFrameSender(sealed, roomKey, ['not-a-pubkey', BOB])).toBe(BOB)
  })

  it('answers from the ciphertext alone, so a claimed sender carries no weight', () => {
    // The forwarder's word about who sent a track is a hint at best. This is
    // the check that makes it only a hint: it is a function of the bytes and
    // the room key, and nothing a forwarder controls is an input to it.
    const sealed = encryptFrame(frame, deriveMediaKey(roomKey, ALICE), frameIv(SALT, 0), 1)
    expect(resolveFrameSender(sealed, roomKey, [CAROL, ALICE])).toBe(ALICE)
    expect(resolveFrameSender(sealed, roomKey, [CAROL])).toBeNull()
  })
})

describe('frameIv', () => {
  it('is a salt followed by a big-endian counter', () => {
    const iv = frameIv(SALT, 1)
    expect(iv).toHaveLength(IV_LENGTH)
    expect(iv.slice(0, SALT_LENGTH)).toEqual(SALT)
    expect([...iv.slice(SALT_LENGTH)]).toEqual([0, 0, 0, 1])
  })

  it('never repeats for one salt', () => {
    // Every sender derives the SAME media key from the room key, so a
    // repeated IV is not a local problem - it is keystream reuse across the
    // whole room.
    const seen = new Set<string>()
    for (let i = 0; i < 20_000; i += 1) seen.add(bytesToHex(frameIv(SALT, i)))
    expect(seen.size).toBe(20_000)
  })

  it('separates two senders at the same counter', () => {
    const other = new Uint8Array(SALT_LENGTH).fill(2)
    expect(frameIv(SALT, 7)).not.toEqual(frameIv(other, 7))
  })

  it('gives each sender a salt wide enough that two are not expected to collide', () => {
    expect(randomFrameSalt()).toHaveLength(SALT_LENGTH)
    expect(SALT_LENGTH).toBeGreaterThanOrEqual(8)
    expect(bytesToHex(randomFrameSalt())).not.toBe(bytesToHex(randomFrameSalt()))
  })

  it('refuses to wrap the counter, because wrapping is keystream reuse', () => {
    expect(() => frameIv(SALT, 2 ** 32)).toThrow()
    expect(() => frameIv(SALT, -1)).toThrow()
    expect(() => frameIv(SALT, 1.5)).toThrow()
  })

  it('refuses a salt of the wrong width', () => {
    expect(() => frameIv(new Uint8Array(4), 0)).toThrow()
  })
})

describe('unencryptedPrefixLength', () => {
  it('leaves VP8 its uncompressed data chunk: 10 bytes on a key frame, 3 on a delta', () => {
    expect(unencryptedPrefixLength('vp8', 'key')).toBe(10)
    expect(unencryptedPrefixLength('vp8', 'delta')).toBe(3)
  })

  it('leaves VP9 and Opus their first byte', () => {
    expect(unencryptedPrefixLength('vp9', 'key')).toBe(1)
    expect(unencryptedPrefixLength('vp9', 'delta')).toBe(1)
    expect(unencryptedPrefixLength('opus')).toBe(1)
  })

  it('accepts a mime type, in whatever case the browser reports it', () => {
    expect(unencryptedPrefixLength('video/VP8', 'key')).toBe(10)
    expect(unencryptedPrefixLength('audio/opus')).toBe(1)
  })

  it('refuses H.264 and AV1 rather than producing a black screen', () => {
    // H.264 is Annex-B: the packetiser finds NAL units by scanning for
    // start codes, and ciphertext contains 00 00 01 by chance roughly once
    // every 16 MB - inventing boundaries that are not there. There is no
    // prefix length that fixes that, so this scheme refuses the codec
    // rather than shipping something that fails intermittently and silently.
    expect(unencryptedPrefixLength('h264', 'key')).toBeNull()
    expect(unencryptedPrefixLength('video/H264', 'delta')).toBeNull()
    expect(unencryptedPrefixLength('av1', 'key')).toBeNull()
  })

  it('refuses a codec it has never heard of', () => {
    expect(unencryptedPrefixLength('video/vp10', 'key')).toBeNull()
    expect(unencryptedPrefixLength('')).toBeNull()
  })
})

const frameBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff)

describe('encryptFrame / decryptFrame', () => {
  it('round-trips a whole frame byte-exactly', () => {
    const frame = frameBytes(200)
    const sealed = encryptFrame(frame, KEY, frameIv(SALT, 0))
    expect(decryptFrame(sealed, KEY)).toEqual(frame)
  })

  it('round-trips byte-exactly with a codec header left in the clear', () => {
    const frame = frameBytes(200)
    const sealed = encryptFrame(frame, KEY, frameIv(SALT, 1), 10)
    expect(decryptFrame(sealed, KEY)).toEqual(frame)
  })

  it('leaves the codec header readable and encrypts everything after it', () => {
    // Get this wrong - encrypt the header too - and the packetiser cannot
    // mark key frames and the forwarder cannot route. The symptom is a black
    // screen, not an error, which is why it is pinned here.
    const frame = frameBytes(200)
    const sealed = encryptFrame(frame, KEY, frameIv(SALT, 2), 10)
    expect(sealed.slice(0, 10)).toEqual(frame.slice(0, 10))
    expect(sealed.slice(10, 200)).not.toEqual(frame.slice(10, 200))
  })

  it('costs a tag and a trailer, and nothing else', () => {
    const sealed = encryptFrame(frameBytes(200), KEY, frameIv(SALT, 3), 3)
    expect(sealed.length).toBe(200 + TAG_LENGTH + TRAILER_LENGTH)
  })

  it('yields nothing decodable under the wrong key', () => {
    const sealed = encryptFrame(frameBytes(200), KEY, frameIv(SALT, 4), 3)
    const wrong = deriveMediaKey(deriveRoom(new Uint8Array(32).fill(9)).roomKey)
    expect(decryptFrame(sealed, wrong)).toBeNull()
  })

  it('binds the clear header to the payload, so a forwarder cannot relabel a frame', () => {
    // The header is authenticated even though it is not encrypted. A
    // forwarder that flips the key-frame bit to make a delta frame look like
    // a key frame breaks the tag rather than being believed.
    const sealed = encryptFrame(frameBytes(200), KEY, frameIv(SALT, 5), 3)
    const relabelled = Uint8Array.from(sealed)
    relabelled[0] ^= 0x01
    expect(decryptFrame(relabelled, KEY)).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const sealed = encryptFrame(frameBytes(200), KEY, frameIv(SALT, 6), 3)
    const tampered = Uint8Array.from(sealed)
    tampered[100] ^= 0xff
    expect(decryptFrame(tampered, KEY)).toBeNull()
  })

  it('rejects a truncated frame without throwing', () => {
    const sealed = encryptFrame(frameBytes(200), KEY, frameIv(SALT, 7), 3)
    expect(decryptFrame(sealed.slice(0, 10), KEY)).toBeNull()
    expect(decryptFrame(new Uint8Array(0), KEY)).toBeNull()
  })

  it('rejects a frame claiming a header longer than itself', () => {
    const sealed = encryptFrame(frameBytes(60), KEY, frameIv(SALT, 8), 3)
    const lying = Uint8Array.from(sealed)
    lying[lying.length - 1] = 255
    expect(decryptFrame(lying, KEY)).toBeNull()
  })

  it('produces different ciphertext for the same frame under different IVs', () => {
    const frame = frameBytes(200)
    const a = encryptFrame(frame, KEY, frameIv(SALT, 9), 3)
    const b = encryptFrame(frame, KEY, frameIv(SALT, 10), 3)
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
  })

  it('refuses a key, IV or prefix it cannot use', () => {
    const frame = frameBytes(60)
    expect(() => encryptFrame(frame, new Uint8Array(16), frameIv(SALT, 11))).toThrow()
    expect(() => encryptFrame(frame, KEY, new Uint8Array(8))).toThrow()
    expect(() => encryptFrame(frame, KEY, frameIv(SALT, 12), 61)).toThrow()
    expect(() => encryptFrame(frame, KEY, frameIv(SALT, 13), 300)).toThrow()
  })
})

const frameOf = (bytes: Uint8Array, mimeType: string, type?: 'key' | 'delta'): EncodedFrameLike => ({
  data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  type,
  getMetadata: () => ({ mimeType }),
})

const collector = (): { sink: FrameSink; out: EncodedFrameLike[] } => {
  const out: EncodedFrameLike[] = []
  return { sink: { enqueue: (f) => out.push(f) }, out }
}

describe('frame transformers', () => {
  it('round-trips a frame through encrypt and decrypt byte-exactly', () => {
    const encrypt = createFrameEncryptor(KEY, { salt: SALT })
    const decrypt = createFrameDecryptor(KEY)
    const original = frameBytes(400)

    const sealed = collector()
    encrypt(frameOf(original, 'video/VP8', 'key'), sealed.sink)
    const opened = collector()
    decrypt(sealed.out[0], opened.sink)

    expect(new Uint8Array(opened.out[0].data)).toEqual(original)
  })

  it('emits the codec header in the clear and never the payload', () => {
    const encrypt = createFrameEncryptor(KEY, { salt: SALT })
    const original = frameBytes(400)
    const sealed = collector()
    encrypt(frameOf(original, 'video/VP8', 'delta'), sealed.sink)

    const wire = new Uint8Array(sealed.out[0].data)
    expect(wire.slice(0, 3)).toEqual(original.slice(0, 3))
    expect(bytesToHex(wire)).not.toContain(bytesToHex(original.slice(3, 60)))
  })

  it('gives every frame its own IV', () => {
    const encrypt = createFrameEncryptor(KEY, { salt: SALT })
    const original = frameBytes(400)
    const sealed = collector()
    for (let i = 0; i < 500; i += 1) encrypt(frameOf(original, 'video/VP8', 'delta'), sealed.sink)

    const ivs = new Set(
      sealed.out.map((f) => {
        const wire = new Uint8Array(f.data)
        return bytesToHex(wire.slice(wire.length - TRAILER_LENGTH, wire.length - 1))
      }),
    )
    expect(ivs.size).toBe(500)
  })

  it('drops a frame it cannot encrypt safely, and says so once', () => {
    // Fail closed: a codec this scheme cannot handle must never be forwarded
    // in the clear just because the alternative is a dropped frame.
    const seen: string[] = []
    const encrypt = createFrameEncryptor(KEY, { salt: SALT, onUnsupported: (m) => seen.push(m) })
    const sealed = collector()
    encrypt(frameOf(frameBytes(400), 'video/H264', 'key'), sealed.sink)
    encrypt(frameOf(frameBytes(400), 'video/H264', 'delta'), sealed.sink)

    expect(sealed.out).toHaveLength(0)
    expect(seen).toEqual(['video/H264'])
  })

  it('drops an undecryptable frame rather than passing ciphertext to the decoder', () => {
    const decrypt = createFrameDecryptor(KEY)
    const opened = collector()
    decrypt(frameOf(frameBytes(400), 'video/VP8', 'key'), opened.sink)
    expect(opened.out).toHaveLength(0)
  })
})

interface FakeEndpoint {
  transform?: unknown
  createEncodedStreams?(): { readable: ReadableStream<EncodedFrameLike>; writable: WritableStream<EncodedFrameLike> }
}

function fakeEndpoint(received: EncodedFrameLike[]): FakeEndpoint & { push(frame: EncodedFrameLike): void; done(): Promise<void> } {
  let controller: ReadableStreamDefaultController<EncodedFrameLike>
  const readable = new ReadableStream<EncodedFrameLike>({ start: (c) => { controller = c } })
  const writable = new WritableStream<EncodedFrameLike>({ write: (f) => { received.push(f) } })
  return {
    createEncodedStreams: () => ({ readable, writable }),
    push: (frame) => controller.enqueue(frame),
    done: async () => { controller.close(); await new Promise((r) => setTimeout(r, 10)) },
  }
}

describe('installTransforms', () => {
  it('pipes a sender through insertable streams, and the result decrypts', async () => {
    const onWire: EncodedFrameLike[] = []
    const sender = fakeEndpoint(onWire)
    const installed = installTransforms(
      { getSenders: () => [sender], getReceivers: () => [] },
      KEY,
      { salt: SALT },
    )
    expect(installed).toEqual({ mode: 'insertable-streams', senders: 1, receivers: 0 })

    const original = frameBytes(400)
    sender.push(frameOf(original, 'video/VP8', 'key'))
    await sender.done()

    expect(onWire).toHaveLength(1)
    const wire = new Uint8Array(onWire[0].data)
    expect(wire.slice(0, 10)).toEqual(original.slice(0, 10))
    expect(decryptFrame(wire, KEY)).toEqual(original)
  })

  it('pipes a receiver back to plaintext', async () => {
    const decoded: EncodedFrameLike[] = []
    const receiver = fakeEndpoint(decoded)
    installTransforms({ getSenders: () => [], getReceivers: () => [receiver] }, KEY)

    const original = frameBytes(400)
    const sealed = encryptFrame(original, KEY, frameIv(SALT, 42), 10)
    receiver.push(frameOf(sealed, 'video/VP8', 'key'))
    await receiver.done()

    expect(decoded).toHaveLength(1)
    expect(new Uint8Array(decoded[0].data)).toEqual(original)
  })

  it('prefers the browser own script transform when the app supplies one', () => {
    // Safari and Firefox expose RTCRtpScriptTransform and no insertable
    // streams; it needs a Worker, which only the app can build, so it is
    // injected rather than constructed here.
    const built: string[] = []
    const sender: FakeEndpoint = { transform: null, createEncodedStreams: () => { throw new Error('must not be used') } }
    const receiver: FakeEndpoint = { transform: null, createEncodedStreams: () => { throw new Error('must not be used') } }
    const installed = installTransforms(
      { getSenders: () => [sender], getReceivers: () => [receiver] },
      KEY,
      { scriptTransform: (side) => { built.push(side); return { side } } },
    )
    expect(built).toEqual(['encrypt', 'decrypt'])
    expect(sender.transform).toEqual({ side: 'encrypt' })
    expect(installed.mode).toBe('script-transform')
  })

  it('reports plainly when a connection can do neither, rather than pretending', () => {
    const installed = installTransforms({ getSenders: () => [{}], getReceivers: () => [{}] }, KEY)
    expect(installed).toEqual({ mode: 'none', senders: 0, receivers: 0 })
  })
})
