import { OpusDecoder } from 'opus-decoder'
import { UtteranceSplitter, downmix } from './utterances.js'
import type { Utterance, UtteranceSplitterOptions } from './utterances.js'

/**
 * The slice of a werift inbound track this needs: RTP packets as they
 * arrive, each carrying one Opus frame. Typed structurally so a test can
 * feed packets without werift, and so this file does not drag werift's
 * types into `dist/` for a caller that only wants the splitter.
 */
export interface RtpTrackLike {
  kind: string
  onReceiveRtp: { subscribe(cb: (rtp: { payload: Uint8Array }) => void): { unSubscribe(): void } }
}

export interface ListenOptions extends UtteranceSplitterOptions {
  /** Milliseconds, for stamping utterances. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Decode an inbound Opus track into utterances.
 *
 * WebRTC audio is Opus at 48 kHz, one frame per RTP packet, and werift
 * hands the packets over without decoding them. `opus-decoder` is libopus
 * in WebAssembly: no native module, so an agent installs like any other
 * npm package. What comes out is fed to the splitter, and what the splitter
 * releases is handed to `onUtterance` - one person's turn, at 16 kHz mono,
 * ready for a transcriber.
 *
 * Packet loss is simply lost: a missing frame is a gap, not a crash, and
 * a transcriber copes with a gap far better than an agent copes with a
 * pipeline that stopped. Returns a stop function.
 */
export async function listenToTrack(
  track: RtpTrackLike,
  onUtterance: (utterance: Utterance) => void,
  opts: ListenOptions = {},
): Promise<() => void> {
  if (track.kind !== 'audio') throw new Error('only an audio track can be listened to')
  const now = opts.now ?? (() => Date.now())
  const decoder = new OpusDecoder({ sampleRate: 48_000, channels: 2 })
  await decoder.ready
  const splitter = new UtteranceSplitter({ sampleRate: 48_000, ...opts })
  let stopped = false

  const subscription = track.onReceiveRtp.subscribe((rtp) => {
    if (stopped) return
    let decoded: { channelData: Float32Array[]; samplesDecoded: number }
    try {
      decoded = decoder.decodeFrame(rtp.payload)
    } catch {
      return
    }
    if (decoded.samplesDecoded === 0) return
    const mono = downmix(decoded.channelData.map((c) => c.subarray(0, decoded.samplesDecoded)))
    for (const utterance of splitter.push(mono, now())) {
      try {
        onUtterance(utterance)
      } catch {
        // The listener's problem. The next utterance still has to arrive.
      }
    }
  })

  return () => {
    if (stopped) return
    stopped = true
    subscription.unSubscribe()
    const last = splitter.flush(now())
    if (last) {
      try {
        onUtterance(last)
      } catch {
        // As above.
      }
    }
    decoder.free()
  }
}
