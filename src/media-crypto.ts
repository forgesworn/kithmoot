/**
 * End-to-end encryption for media that passes through a forwarder.
 *
 * ## Why this exists
 *
 * Past roughly eight people a mesh cannot carry a room: upload is
 * `(N-1) x bitrate` and upload is the scarce half of a domestic connection.
 * Somebody has to forward. Every other conferencing system answers that by
 * putting a server in the media path that can see the media - Jitsi's
 * videobridge does, by default. KithMoot's forwarder is given the room *id*
 * and never the room *key*, and media is encrypted here under a key derived
 * from the room key, so the forwarder routes ciphertext it can neither read
 * nor forge attribution for.
 *
 * ## The honest caveat
 *
 * This is not free, and it is not always wanted:
 *
 * - It costs an extra pass over every frame at both ends, on top of the
 *   codec's own work. On a phone that is battery and heat.
 * - It fights hardware codec paths. Some platforms hand out encoded frames
 *   the transform can see and some do not, and where the pipeline is fully
 *   offloaded there is nothing for `installTransforms` to attach to.
 * - It is codec-restricted. VP8, VP9 and Opus work; H.264 and AV1 are
 *   refused outright (see `unencryptedPrefixLength`).
 *
 * **And it is only needed once a forwarder is in the path.** A pure mesh is
 * already end-to-end encrypted by DTLS-SRTP, hop by hop, with no hop in
 * between - adding this to a five-person mesh buys nothing and costs the
 * whole list above. So it ships coupled to forwarding, and is measured
 * rather than promised.
 *
 * ## The trap
 *
 * The codec header must stay in the clear, and only the payload be
 * encrypted. Encrypt the whole frame and the RTP packetiser can no longer
 * find the frame type, the forwarder can no longer route, and the decoder is
 * handed something it cannot parse. None of that raises an error: it
 * presents as a black screen. `unencryptedPrefixLength` is where the
 * per-codec answer lives, and it is the part of this module most worth
 * reading twice.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { randomBytes } from '@noble/hashes/utils'

/**
 * HKDF info string for the media key.
 *
 * Deliberately distinct from `kithmoot/v1/room-id` and
 * `kithmoot/v1/room-key`. A media key that was the room key would mean that
 * anything able to decrypt media could also read the roster - the
 * participant pubkeys, the credentials, the kindred proofs - and the design
 * turns on those being separable. Separate info strings make them
 * independent by construction, not by policy.
 */
export const MEDIA_KEY_INFO = 'kithmoot/v1/media-key'

/** ChaCha20-Poly1305's nonce width. */
export const IV_LENGTH = 12
/**
 * Bytes of per-sender salt inside the IV.
 *
 * Every member of the room derives the SAME media key from the same room
 * key - that is what lets everyone decrypt everyone. So an IV that repeats
 * is not a local mistake, it is keystream reuse across the whole room, and
 * two senders both counting from zero would collide on their first frame.
 * Eight random bytes per sender makes a collision in a twenty-person room a
 * one-in-ten-quintillion event; four would have made it one in twenty
 * million, which is not a number to bet a room's confidentiality on.
 */
export const SALT_LENGTH = 8
/** Poly1305's authentication tag. */
export const TAG_LENGTH = 16
/** The IV and the header length, carried after the ciphertext. */
export const TRAILER_LENGTH = IV_LENGTH + 1

/** Counter width, in bits, given the remaining IV bytes. */
const COUNTER_MAX = 2 ** ((IV_LENGTH - SALT_LENGTH) * 8)

/**
 * Derive the media key for a room.
 *
 * Taken from the room key rather than the room secret so that anything
 * already holding the room key - a joined client - can derive it without
 * keeping the original capability around.
 */
export function deriveMediaKey(roomKey: Uint8Array): Uint8Array {
  if (roomKey.length !== 32) throw new Error('room key must be 32 bytes')
  return hkdf(sha256, roomKey, undefined, MEDIA_KEY_INFO, 32)
}

/** A fresh per-sender salt. One per sender, per session. */
export function randomFrameSalt(): Uint8Array {
  return randomBytes(SALT_LENGTH)
}

/**
 * Build the IV for one frame: `salt || counter`, big-endian.
 *
 * Refuses to wrap. A wrapped counter reuses an IV under a key the whole room
 * shares, which for a stream cipher means an attacker can recover the XOR of
 * two frames without any key at all. At 60 frames a second the counter lasts
 * a bit over two years of continuous sending, so hitting the limit means
 * something is wrong, and the right answer is a new key rather than a
 * silently reused nonce.
 */
export function frameIv(salt: Uint8Array, counter: number): Uint8Array {
  if (salt.length !== SALT_LENGTH) throw new Error(`frame salt must be ${SALT_LENGTH} bytes`)
  if (!Number.isInteger(counter) || counter < 0) throw new Error('frame counter must be a non-negative integer')
  if (counter >= COUNTER_MAX) throw new Error('frame counter exhausted; rekey rather than wrap')

  const iv = new Uint8Array(IV_LENGTH)
  iv.set(salt, 0)
  for (let i = IV_LENGTH - 1; i >= SALT_LENGTH; i -= 1) {
    iv[i] = counter & 0xff
    counter = Math.floor(counter / 256)
  }
  return iv
}

export type FrameType = 'key' | 'delta'

/**
 * How many bytes at the front of a frame must NOT be encrypted, per codec.
 *
 * These are not padding or paranoia: they are the bytes the RTP packetiser
 * and the forwarder read to do their jobs. Encrypt them and neither can, and
 * the failure is silent.
 *
 * - **VP8** (RFC 6386 s9.1): the uncompressed data chunk is 3 bytes on an
 *   interframe - frame tag carrying the key-frame flag, version, show_frame
 *   and the first partition's size - and 10 on a key frame, which adds the
 *   3-byte start code and four bytes of dimensions.
 * - **VP9**: the uncompressed header is bit-packed with no byte boundary to
 *   stop at, but its first byte carries the frame marker, the profile bits
 *   and the frame type, which is everything a forwarder reads.
 * - **Opus** (RFC 6716 s3.1): the TOC byte, carrying config, stereo flag and
 *   frame count. Audio has no key/delta distinction, so the answer is the
 *   same either way.
 *
 * `null` means "this codec cannot be encrypted safely by this scheme", and
 * the caller must drop the frame rather than send it in the clear:
 *
 * - **H.264** is Annex-B. The packetiser locates NAL units by scanning for
 *   `00 00 01` start codes, and ciphertext contains that sequence by chance
 *   roughly once every 16 MB - inventing boundaries that are not there and
 *   destroying real ones. Emulation prevention would have to be re-applied
 *   over the ciphertext, which is a different design, not a longer prefix.
 * - **AV1** frames are a sequence of OBUs each carrying its own LEB128
 *   length, so a single front prefix cannot leave the structure intact
 *   either.
 *
 * Refusing is deliberate. The alternative - guess a prefix and hope - fails
 * intermittently, only on some hardware, and always as a black screen.
 */
export function unencryptedPrefixLength(codec: string, frameType: FrameType = 'delta'): number | null {
  const name = codec.toLowerCase().split('/').pop() ?? ''
  switch (name) {
    case 'vp8':
      return frameType === 'key' ? 10 : 3
    case 'vp9':
      return 1
    case 'opus':
      return 1
    default:
      return null
  }
}

/**
 * Seal one frame.
 *
 * Layout on the wire:
 *
 * ```
 * [ clear header (P bytes) ][ ciphertext || tag ][ IV (12) ][ P (1) ]
 * ```
 *
 * The header is left in the clear but passed as associated data, so it is
 * authenticated even though it is readable: a forwarder can see that a frame
 * is a key frame - which it needs, to route - and cannot change that without
 * breaking the tag. That is the "cannot forge attribution" half of the
 * claim, and it costs nothing.
 *
 * The IV rides in a trailer rather than a header because RTP payloads are
 * read from the front: anything prepended shifts the codec header a
 * packetiser expects at offset zero, while trailing bytes are simply carried.
 */
export function encryptFrame(
  frame: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  prefixLength = 0,
): Uint8Array {
  if (key.length !== 32) throw new Error('media key must be 32 bytes')
  if (iv.length !== IV_LENGTH) throw new Error(`frame IV must be ${IV_LENGTH} bytes`)
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 255) {
    throw new Error('unencrypted prefix must be a byte-sized length')
  }
  if (prefixLength > frame.length) throw new Error('unencrypted prefix is longer than the frame')

  const header = frame.subarray(0, prefixLength)
  const sealed = chacha20poly1305(key, iv, header).encrypt(frame.subarray(prefixLength))

  const out = new Uint8Array(prefixLength + sealed.length + TRAILER_LENGTH)
  out.set(header, 0)
  out.set(sealed, prefixLength)
  out.set(iv, prefixLength + sealed.length)
  out[out.length - 1] = prefixLength
  return out
}

/**
 * Open one frame, or return null.
 *
 * Never throws. This runs inside a media transform on every single frame; a
 * throw there tears down the whole stream, and a corrupt frame - or one from
 * a member who has not yet got the key - is an ordinary event, not an
 * exceptional one. The caller drops the frame and the decoder concedes a
 * glitch.
 *
 * Returning null on a wrong key is also the safe answer rather than the
 * obvious one: handing the decoder plausible-looking garbage is how a stream
 * ends up rendering noise instead of stopping.
 */
export function decryptFrame(frame: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (key.length !== 32) return null
  if (frame.length < TRAILER_LENGTH + TAG_LENGTH) return null

  const prefixLength = frame[frame.length - 1]
  const bodyEnd = frame.length - TRAILER_LENGTH
  if (prefixLength > bodyEnd - TAG_LENGTH) return null

  const header = frame.subarray(0, prefixLength)
  const iv = frame.subarray(bodyEnd, frame.length - 1)

  let opened: Uint8Array
  try {
    opened = chacha20poly1305(key, iv, header).decrypt(frame.subarray(prefixLength, bodyEnd))
  } catch {
    return null
  }

  const out = new Uint8Array(prefixLength + opened.length)
  out.set(header, 0)
  out.set(opened, prefixLength)
  return out
}

// ---------------------------------------------------------------------------
// The browser seam.
//
// Everything above is pure: bytes in, bytes out, no globals, testable in
// Node. Everything below is the thin wiring that carries frames into it,
// shaped so the wiring can be handed a double in a test - the same split
// `peer.ts` makes with its `PeerFactory`.
// ---------------------------------------------------------------------------

/** The slice of a WebRTC encoded frame this module touches. */
export interface EncodedFrameLike {
  data: ArrayBuffer
  type?: FrameType
  getMetadata?(): { mimeType?: string }
}

/** Where a transformed frame goes. A `TransformStreamDefaultController`
 *  satisfies this structurally, so no adapter is needed in a browser. */
export interface FrameSink {
  enqueue(frame: EncodedFrameLike): void
}

export type FrameTransformer = (frame: EncodedFrameLike, sink: FrameSink) => void

export interface FrameCryptoOptions {
  /** This sender's salt. Defaults to a fresh random one. */
  salt?: Uint8Array
  /** Override the per-codec header length. Returning null drops the frame. */
  prefixFor?: (frame: EncodedFrameLike) => number | null
  /** Called once per mime type this scheme cannot encrypt safely. The app
   *  should tell the person their browser negotiated a codec that cannot be
   *  end-to-end encrypted, rather than leaving them with a black tile. */
  onUnsupported?: (mimeType: string) => void
  /** Called for every frame that fails to decrypt. Expect a few at the start
   *  of a call and none afterwards; a steady stream means a key mismatch. */
  onUndecryptable?: () => void
}

function defaultPrefixFor(frame: EncodedFrameLike): number | null {
  const mimeType = frame.getMetadata?.().mimeType ?? ''
  return unencryptedPrefixLength(mimeType, frame.type ?? 'delta')
}

function frameBytes(frame: EncodedFrameLike): Uint8Array {
  return new Uint8Array(frame.data)
}

function setFrameBytes(frame: EncodedFrameLike, bytes: Uint8Array): void {
  frame.data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * Build the sender-side transformer.
 *
 * Fails closed. A frame whose codec this scheme cannot handle is dropped,
 * never forwarded in the clear: the caller asked for end-to-end encryption,
 * and quietly downgrading to none because the alternative was a dropped
 * frame is the failure mode this whole module exists to avoid.
 */
export function createFrameEncryptor(key: Uint8Array, opts: FrameCryptoOptions = {}): FrameTransformer {
  const salt = opts.salt ?? randomFrameSalt()
  const prefixFor = opts.prefixFor ?? defaultPrefixFor
  const reported = new Set<string>()
  let counter = 0

  return (frame, sink) => {
    const prefixLength = prefixFor(frame)
    if (prefixLength === null) {
      const mimeType = frame.getMetadata?.().mimeType ?? 'unknown'
      if (!reported.has(mimeType)) {
        reported.add(mimeType)
        opts.onUnsupported?.(mimeType)
      }
      return
    }

    const bytes = frameBytes(frame)
    // A frame shorter than its own codec header is malformed; there is
    // nothing to leave in the clear and nothing to encrypt.
    if (bytes.length < prefixLength) return

    setFrameBytes(frame, encryptFrame(bytes, key, frameIv(salt, counter), prefixLength))
    counter += 1
    sink.enqueue(frame)
  }
}

/** Build the receiver-side transformer. Drops what it cannot open. */
export function createFrameDecryptor(key: Uint8Array, opts: FrameCryptoOptions = {}): FrameTransformer {
  return (frame, sink) => {
    const opened = decryptFrame(frameBytes(frame), key)
    if (opened === null) {
      opts.onUndecryptable?.()
      return
    }
    setFrameBytes(frame, opened)
    sink.enqueue(frame)
  }
}

/**
 * The two shapes a browser offers for reaching encoded frames.
 *
 * `transform` is the standard `RTCRtpScriptTransform`, in Safari and Firefox;
 * `createEncodedStreams` is Chrome's older insertable streams. A real
 * `RTCRtpSender` or `RTCRtpReceiver` satisfies this structurally.
 */
export interface FrameEndpointLike {
  transform?: unknown
  createEncodedStreams?(): {
    readable: ReadableStream<EncodedFrameLike>
    writable: WritableStream<EncodedFrameLike>
  }
}

export interface TransformablePeerConnection {
  getSenders(): FrameEndpointLike[]
  getReceivers(): FrameEndpointLike[]
}

export interface InstallTransformsOptions extends FrameCryptoOptions {
  /**
   * Builds an `RTCRtpScriptTransform` for one side.
   *
   * Injected rather than constructed here because it needs a `Worker`, and a
   * worker needs a URL the bundler produced - which a protocol library has no
   * business knowing. The app supplies it; this module decides when to use it.
   */
  scriptTransform?: (side: 'encrypt' | 'decrypt') => unknown
}

export interface InstalledTransforms {
  /** Which mechanism was used, or `none` if the connection offered neither. */
  mode: 'script-transform' | 'insertable-streams' | 'none'
  senders: number
  receivers: number
}

function pipe(endpoint: FrameEndpointLike, transformer: FrameTransformer): boolean {
  const streams = endpoint.createEncodedStreams?.()
  if (!streams) return false
  void streams.readable
    .pipeThrough(
      new TransformStream<EncodedFrameLike, EncodedFrameLike>({
        transform: (frame, controller) => transformer(frame, controller),
      }),
    )
    .pipeTo(streams.writable)
    // A closed connection rejects the pipe. That is an ordinary end, not a
    // fault, and there is no console in this library to complain to.
    .catch(() => {})
  return true
}

/**
 * Wire every sender and receiver on a connection through this room's media
 * encryption.
 *
 * Prefers `RTCRtpScriptTransform` when the app has supplied a builder for
 * one, because it is the standard and it runs off the main thread. Falls
 * back to Chrome's insertable streams. Reports `none` when the connection
 * offers neither, plainly, rather than returning as though it had worked -
 * a caller that believes media is encrypted when it is not is worse off than
 * one that knows it is not.
 *
 * Call it after tracks are added: senders and receivers that do not exist yet
 * cannot be wired, and a track added later needs another call.
 */
export function installTransforms(
  pc: TransformablePeerConnection,
  key: Uint8Array,
  opts: InstallTransformsOptions = {},
): InstalledTransforms {
  const senders = pc.getSenders()
  const receivers = pc.getReceivers()

  if (opts.scriptTransform) {
    for (const sender of senders) sender.transform = opts.scriptTransform('encrypt')
    for (const receiver of receivers) receiver.transform = opts.scriptTransform('decrypt')
    return { mode: 'script-transform', senders: senders.length, receivers: receivers.length }
  }

  const encrypt = createFrameEncryptor(key, opts)
  const decrypt = createFrameDecryptor(key, opts)
  let wiredSenders = 0
  let wiredReceivers = 0
  for (const sender of senders) if (pipe(sender, encrypt)) wiredSenders += 1
  for (const receiver of receivers) if (pipe(receiver, decrypt)) wiredReceivers += 1

  return {
    mode: wiredSenders + wiredReceivers > 0 ? 'insertable-streams' : 'none',
    senders: wiredSenders,
    receivers: wiredReceivers,
  }
}
