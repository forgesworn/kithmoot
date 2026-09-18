import { describe, expect, it } from 'vitest'
import type { TrackAdvert } from '../../src/types.js'
import {
  bindRoles,
  isReceiving,
  ORPHAN_CHECKS,
  RTP_GRACE_MS,
  FROZEN_REBIND_MS,
  judgePicture,
  STALLED_CHECKS,
  TileLiveness,
  tileDevice,
  tileKey,
  tileRole,
  type PictureAction,
  type PictureLook,
  type PictureState,
  type ReceiverFacts,
  type TrackLike,
} from './remote-tiles.js'

const DEVICE = 'a'.repeat(64)

function track(id: string, kind: 'audio' | 'video', readyState = 'live'): TrackLike {
  return { id, kind, readyState }
}

function receiving(t: TrackLike, progressing = false): ReceiverFacts {
  return { track: t, direction: 'recvonly', progressing }
}

function advert(role: TrackAdvert['role'], trackId: string): TrackAdvert {
  return { role, trackId }
}

describe('tile keys', () => {
  it('names a tile by device and role, and reads both back', () => {
    const key = tileKey(DEVICE, 'screen')
    expect(key).toBe(`${DEVICE}|screen`)
    expect(tileDevice(key)).toBe(DEVICE)
    expect(tileRole(key)).toBe('screen')
  })

  it('has no role for a key that is not one of ours', () => {
    expect(tileRole(`${DEVICE}|7f3c-not-a-role`)).toBeUndefined()
  })
})

describe('isReceiving', () => {
  it('is true only for a direction that carries media towards us', () => {
    expect(isReceiving('sendrecv')).toBe(true)
    expect(isReceiving('recvonly')).toBe(true)
  })

  it('is false for the stale receiver of a sender the far end removed', () => {
    expect(isReceiving('sendonly')).toBe(false)
    expect(isReceiving('inactive')).toBe(false)
    expect(isReceiving('stopped')).toBe(false)
    expect(isReceiving(null)).toBe(false)
    expect(isReceiving(undefined)).toBe(false)
  })
})

describe('bindRoles', () => {
  it('keys by role, not by track id: a receiver whose id matches nothing still takes the advertised slot', () => {
    // Firefox mints its own receiver ids, so no advert will ever name one.
    const fox = track('firefox-minted-id', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [advert('camera', 'senders-own-id')],
      receivers: [receiving(fox, true)],
    })
    expect(binding.get('camera')).toBe(fox)
    expect(binding.has('screen')).toBe(false)
  })

  it('puts a camera and a screen from one device in their own slots by advertised id', () => {
    const cam = track('cam', 'video'), screen = track('screen', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [advert('screen', 'screen'), advert('camera', 'cam')],
      receivers: [receiving(screen), receiving(cam)],
    })
    expect(binding.get('camera')).toBe(cam)
    expect(binding.get('screen')).toBe(screen)
  })

  it('never binds a receiver whose direction is not receiving and whose packets have stopped', () => {
    const stale = track('stale', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [advert('camera', 'stale')],
      receivers: [{ track: stale, direction: 'sendonly' }],
    })
    expect(binding.size).toBe(0)
  })

  /**
   * BUG: the one-way audio of 18 September 2026 - see `src/peer.test.ts`,
   * which has the negotiation that gets a pair into this state.
   *
   * The two ends settled on different directions: the far end went on
   * sending its microphone, this end's transceiver said `sendonly`. The
   * packets kept arriving and were counted, and this rule gave them no slot
   * - so no `<audio>` element was ever made for them, and a track with no
   * sink is never decoded. The person could be seen and not heard, with no
   * way back for the rest of the call.
   */
  it('binds a receiver whose packets are arriving however its direction reads', () => {
    const sounding = track('sounding', 'audio')
    const binding = bindRoles({
      kind: 'audio',
      adverts: [advert('mic', 'sounding')],
      receivers: [{ track: sounding, direction: 'sendonly', progressing: true }],
    })
    expect(binding.get('mic')).toBe(sounding)
  })

  /**
   * BUG: two video elements on one person's tile, both showing nothing -
   * `Firefox receiver keeps seeing and hearing through camera and mic
   * toggles`, deterministic on that browser.
   *
   * A camera toggle leaves the old receiver behind, and for the grace window
   * after it the stale receiver still reports RTP moving. Admitted beside
   * the live one it took the second video slot of the device - and in
   * Firefox, where a receiver's id matches no advert ever, nothing outranked
   * it. So the rule is not a ranking: a receiver whose direction does not
   * say it is receiving is not admitted at all while one of its kind says it
   * is.
   */
  it('rejects a receiver that says it is not receiving while one of its kind says it is', () => {
    const stale = track('stale-after-toggle', 'video'), live = track('firefox-minted', 'video')
    const binding = bindRoles({
      kind: 'video',
      // Firefox: the advert names the sender's id, which matches neither.
      adverts: [advert('camera', 'the-senders-own-id')],
      receivers: [
        { track: stale, direction: 'inactive', progressing: true },
        { track: live, direction: 'recvonly', progressing: true },
      ],
      bound: new Map([['camera', stale]]),
    })
    expect(binding.get('camera'), 'the stale receiver kept the slot').toBe(live)
    expect([...binding.values()], 'the stale receiver opened a second tile').toEqual([live])
  })

  it('admits one whose packets are arriving only when nothing of its kind is receiving', () => {
    const lying = track('lying', 'audio')
    const alone = bindRoles({
      kind: 'audio',
      adverts: [advert('mic', 'mic-id')],
      receivers: [{ track: lying, direction: 'sendonly', progressing: true }],
    })
    expect(alone.get('mic'), 'the only receiver there is was refused its slot').toBe(lying)

    const live = track('live', 'audio')
    const beside = bindRoles({
      kind: 'audio',
      adverts: [advert('mic', 'mic-id')],
      receivers: [{ track: lying, direction: 'sendonly', progressing: true }, { track: live, direction: 'recvonly' }],
    })
    expect([...beside.values()]).toEqual([live])
  })

  it('ignores a stopped, inactive or null transceiver even when it is the only one', () => {
    for (const direction of ['inactive', 'stopped', null, undefined] as const) {
      const binding = bindRoles({
        kind: 'audio',
        adverts: [advert('mic', 'mic')],
        receivers: [{ track: track('mic', 'audio'), direction }],
      })
      expect(binding.size, `direction ${String(direction)}`).toBe(0)
    }
  })

  it('leaves the slot to the live receiver when a stale muted one is still around', () => {
    // H5 exactly: the far end renegotiated, the old receiver stays `live`
    // and muted for ever, and its id is the one the advert happens to name.
    const stale = track('old-camera', 'video')
    const live = track('browser-minted', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [advert('camera', 'old-camera')],
      receivers: [{ track: stale, direction: 'inactive' }, receiving(live, true)],
      bound: new Map([['camera', stale]]),
    })
    expect(binding.get('camera')).toBe(live)
  })

  it('prefers a receiver whose packets are moving over one whose are not', () => {
    const quiet = track('quiet', 'video'), moving = track('moving', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [advert('camera', 'gone-with-the-old-connection')],
      receivers: [receiving(quiet), receiving(moving, true)],
    })
    expect(binding.get('camera')).toBe(moving)
  })

  it('an advert naming a receiver outranks packets moving on another one', () => {
    const named = track('named', 'video'), other = track('other', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [advert('camera', 'named')],
      receivers: [receiving(other, true), receiving(named)],
    })
    expect(binding.get('camera')).toBe(named)
    expect(binding.get('screen')).toBe(other)
  })

  it('keeps a playing picture where it is when the advert says nothing useful', () => {
    const playing = track('playing', 'video'), fresh = track('fresh', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [advert('camera', 'neither')],
      receivers: [receiving(fresh), receiving(playing)],
      bound: new Map([['camera', playing]]),
    })
    expect(binding.get('camera')).toBe(playing)
  })

  it('guesses the everyday role for a track that arrived ahead of its advert', () => {
    const early = track('early', 'video')
    expect(bindRoles({ kind: 'video', adverts: [], receivers: [receiving(early)] }).get('camera')).toBe(early)
    const sound = track('sound', 'audio')
    expect(bindRoles({ kind: 'audio', adverts: [], receivers: [receiving(sound)] }).get('mic')).toBe(sound)
  })

  it('gives an arriving track a slot even though its transceiver cannot be found yet', () => {
    // `ontrack` is proof the far end is sending; the app may not be able to
    // read a direction for it until the connection settles.
    const arriving = track('arriving', 'audio')
    const binding = bindRoles({
      kind: 'audio',
      adverts: [advert('mic', 'mic-id')],
      receivers: [],
      prefer: arriving,
    })
    expect(binding.get('mic')).toBe(arriving)
  })

  it('never lists an arriving track twice when its receiver is also known', () => {
    const arriving = track('arriving', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [],
      receivers: [receiving(arriving)],
      prefer: arriving,
    })
    expect([...binding.values()].filter(t => t === arriving)).toHaveLength(1)
  })

  it('takes at most one advert per role, so a duplicate cannot open a second slot', () => {
    const first = track('first', 'video'), second = track('second', 'video')
    const binding = bindRoles({
      kind: 'video',
      adverts: [advert('camera', 'first'), advert('camera', 'second')],
      receivers: [receiving(first), receiving(second)],
    })
    expect(binding.get('camera')).toBe(first)
    expect(binding.get('screen')).toBe(second)
  })

  it('does not mix the kinds up', () => {
    const cam = track('cam', 'video'), mic = track('mic', 'audio')
    const video = bindRoles({ kind: 'video', adverts: [advert('camera', 'cam'), advert('mic', 'mic')], receivers: [receiving(cam), receiving(mic)] })
    expect([...video.values()]).toEqual([cam])
    const audio = bindRoles({ kind: 'audio', adverts: [advert('camera', 'cam'), advert('mic', 'mic')], receivers: [receiving(cam), receiving(mic)] })
    expect([...audio.values()]).toEqual([mic])
  })

  it('drops a receiver whose track has ended', () => {
    const over = track('over', 'audio', 'ended')
    expect(bindRoles({ kind: 'audio', adverts: [advert('mic', 'over')], receivers: [receiving(over)] }).size).toBe(0)
  })
})

describe('TileLiveness', () => {
  const key = tileKey(DEVICE, 'camera')

  it('keeps a tile the roster still advertises, however long it has been quiet', () => {
    const live = new TileLiveness()
    for (let at = 0; at < 60_000; at += 1000) expect(live.gone(key, true, at)).toBe(false)
  })

  it('keeps a tile while the roster has nothing to say about the device', () => {
    const live = new TileLiveness()
    for (let at = 0; at < 60_000; at += 1000) expect(live.gone(key, undefined, at)).toBe(false)
  })

  it('takes a tile down once the advert has gone for its grace and nothing is arriving', () => {
    const live = new TileLiveness()
    for (let i = 1; i < ORPHAN_CHECKS; i++) expect(live.gone(key, false, i * 1000)).toBe(false)
    expect(live.gone(key, false, ORPHAN_CHECKS * 1000)).toBe(true)
  })

  it('forgives a tile whose advert comes back', () => {
    const live = new TileLiveness()
    expect(live.gone(key, false, 1000)).toBe(false)
    expect(live.gone(key, false, 2000)).toBe(false)
    expect(live.gone(key, true, 3000)).toBe(false)
    expect(live.gone(key, false, 4000)).toBe(false)
    expect(live.gone(key, false, 5000)).toBe(false)
    expect(live.gone(key, false, 6000)).toBe(true)
  })

  it('packets arriving override an advert that has gone', () => {
    // The second-tab case: the roster entry was overwritten by a tab with no
    // tracks, and the pictures are still coming.
    const live = new TileLiveness()
    for (let at = 1000; at <= 30_000; at += 1000) {
      live.progressed(key, at)
      expect(live.gone(key, false, at)).toBe(false)
    }
  })

  it('takes the tile down once the packets stop as well', () => {
    const live = new TileLiveness()
    live.progressed(key, 1000)
    for (let at = 1000; at < 1000 + RTP_GRACE_MS; at += 1000) expect(live.gone(key, false, at)).toBe(false)
    expect(live.gone(key, false, 1000 + RTP_GRACE_MS)).toBe(true)
  })

  it('needs the advert half of the rule too: packets alone do not take a tile down', () => {
    const live = new TileLiveness()
    expect(live.progressing(key, 0)).toBe(false)
    live.progressed(key, 1000)
    expect(live.progressing(key, 1000 + RTP_GRACE_MS - 1)).toBe(true)
    expect(live.progressing(key, 1000 + RTP_GRACE_MS)).toBe(false)
  })

  it('forgets a tile that has gone, so it starts afresh if it comes back', () => {
    const live = new TileLiveness()
    for (let i = 1; i <= ORPHAN_CHECKS; i++) live.gone(key, false, i * 1000)
    expect(live.gone(key, false, 10_000)).toBe(false)
  })

  it('retain drops what it remembers about tiles that have gone', () => {
    const live = new TileLiveness()
    const other = tileKey(DEVICE, 'screen')
    live.progressed(other, 1000)
    live.gone(other, false, 1000)
    live.retain([key])
    expect(live.progressing(other, 1001)).toBe(false)
    expect(live.gone(other, false, 2000)).toBe(false)
  })
})

describe('judgePicture', () => {
  const look = (over: Partial<PictureLook> = {}): PictureLook => ({ moving: false, arriving: false, visible: true, at: 0, ...over })
  const state = (over: Partial<PictureState> = {}): PictureState => ({ stalled: 0, played: true, onScreen: true, ...over })

  it('parks a picture that ran and stopped, once nothing is arriving either', () => {
    let s = state()
    let action: PictureAction = 'none'
    for (let check = 0; check < STALLED_CHECKS; check++) ({ action, state: s } = judgePicture(s, look({ at: check * 1000 })))
    expect(action).toBe('park')
    expect(s.onScreen).toBe(false)
  })

  /**
   * BUG: a picture parked for two quiet seconds under load never came back,
   * because a parked element's clock stops and the clock was the only way
   * back. Packets are what says the far end is still there.
   */
  it('does not park one whose packets are arriving, and restores a parked one when they return', () => {
    let s = state()
    for (let check = 0; check < 6; check++) ({ state: s } = judgePicture(s, look({ arriving: true, at: check * 1000 })))
    expect(s.onScreen, 'a picture with packets arriving was taken off screen').toBe(true)

    const parked = judgePicture(state({ onScreen: false }), look({ arriving: true, at: 9000 }))
    expect(parked.action).toBe('restore')
    expect(parked.state.onScreen).toBe(true)
  })

  /**
   * BUG: `arriving` used to be read off the store a painted frame also
   * writes to, so a picture that had just stopped answered "packets are
   * arriving" for the whole grace window and could not be parked inside it.
   * This asks the question the poller now asks: packets, separately.
   */
  it('parks on the stall count alone when the packets have stopped, however lately it painted', () => {
    const { action } = judgePicture(state({ stalled: STALLED_CHECKS - 1 }), look({ arriving: false, at: 1000 }))
    expect(action).toBe('park')
  })

  it('starts the stall count again when a picture comes back on screen', () => {
    const { action, state: s } = judgePicture(state({ onScreen: false, stalled: 5 }), look({ arriving: true, at: 1000 }))
    expect(action).toBe('restore')
    expect(s.stalled, 'a still picture will be parked and restored for ever').toBe(1)
  })

  /**
   * BUG: a decoder wedged on a missed keyframe stays wedged, and nothing
   * here can ask for another one. Left alone it is a frozen frame for the
   * rest of the call, because the packets arriving keep it on screen.
   */
  it('rebinds a picture frozen with its packets still arriving, and not before', () => {
    let s = state()
    const actions: PictureAction[] = []
    for (let at = 0; at <= FROZEN_REBIND_MS + 2000; at += 1000) {
      const judged = judgePicture(s, look({ arriving: true, at }))
      actions.push(judged.action)
      s = judged.state
    }
    expect(actions.filter(a => a === 'rebind'), 'a frozen picture was rebound early, or never').toHaveLength(1)
    expect(actions.indexOf('rebind'), 'the rebind did not wait out the whole window').toBe(FROZEN_REBIND_MS / 1000)
    expect(actions).not.toContain('park')
  })

  it('forgets the frozen clock as soon as a frame is painted', () => {
    let s = state({ frozenSince: 0 })
    ;({ state: s } = judgePicture(s, look({ moving: true, arriving: true, at: 5000 })))
    expect(s.frozenSince).toBeUndefined()
    const actions: PictureAction[] = []
    for (let at = 6000; at <= 6000 + FROZEN_REBIND_MS; at += 1000) {
      const judged = judgePicture(s, look({ arriving: true, at }))
      actions.push(judged.action)
      s = judged.state
    }
    expect(actions.filter(a => a === 'rebind'), 'the frozen window was not measured from the last frame').toHaveLength(1)
  })

  it('leaves a picture that has never had a frame alone, however long it takes', () => {
    let s = state({ played: false })
    const actions: PictureAction[] = []
    for (let at = 0; at < 30_000; at += 1000) {
      const judged = judgePicture(s, look({ at }))
      actions.push(judged.action)
      s = judged.state
    }
    expect(new Set(actions)).toEqual(new Set(['none']))
  })
})
