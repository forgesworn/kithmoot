import { describe, it, expect } from 'vitest'
import { SpeakingDetector, SpeakingSet, SPEAKING } from './speaking.js'
import { rms, rmsFromByteTimeDomain } from './audio-level.js'

/** Comfortably over `on`. */
const LOUD = 0.1
/** Between `off` and `on`: too quiet to start, loud enough not to stop. */
const BETWEEN = 0.015
/** Under `off`. */
const QUIET = 0.001

describe('SpeakingDetector', () => {
  it('starts silent', () => {
    expect(new SpeakingDetector().speaking).toBe(false)
  })

  it('starts speaking the instant the level clears `on`', () => {
    // No delay on the way in: a delay here is a delay before the room can
    // see who is talking, which is the whole feature.
    const d = new SpeakingDetector()
    expect(d.update(LOUD, 0)).toBe(true)
  })

  it('does not start on a level between `off` and `on`', () => {
    // Room noise lives here. One threshold would light every tile up.
    const d = new SpeakingDetector()
    expect(d.update(BETWEEN, 0)).toBe(false)
    expect(d.update(BETWEEN, 10_000)).toBe(false)
  })

  it('keeps speaking through a level that fell between the thresholds', () => {
    // The hysteresis case: once started, `off` is the bar, not `on`.
    const d = new SpeakingDetector()
    d.update(LOUD, 0)
    expect(d.update(BETWEEN, 100)).toBe(true)
    expect(d.update(BETWEEN, 100_000)).toBe(true)
  })

  it('does not stop until the hangover has fully elapsed', () => {
    const d = new SpeakingDetector()
    d.update(LOUD, 0)
    expect(d.update(QUIET, 100)).toBe(true) // hangover starts
    expect(d.update(QUIET, 100 + SPEAKING.hangoverMs - 1)).toBe(true)
    expect(d.update(QUIET, 100 + SPEAKING.hangoverMs)).toBe(false)
  })

  it('rides out the gaps between words without strobing', () => {
    // A sentence: bursts of speech separated by 150ms of nothing, which is
    // an ordinary gap between words. The indicator must stay on throughout.
    const d = new SpeakingDetector()
    let now = 0
    d.update(LOUD, now)
    for (let word = 0; word < 6; word++) {
      for (let t = 0; t < 150; t += 50) expect(d.update(QUIET, (now += 50))).toBe(true)
      expect(d.update(LOUD, (now += 50))).toBe(true)
    }
  })

  it('stops after a real pause', () => {
    const d = new SpeakingDetector()
    d.update(LOUD, 0)
    d.update(QUIET, 50)
    expect(d.update(QUIET, 50 + SPEAKING.hangoverMs + 1)).toBe(false)
  })

  it('restarts the hangover when the voice comes back inside it', () => {
    const d = new SpeakingDetector()
    d.update(LOUD, 0)
    d.update(QUIET, 100) // hangover starts at 100
    d.update(LOUD, 300) // back before it expired, so that hangover is cancelled
    // Had the first hangover stood, 100 + 400 = 500 would have stopped it.
    // Instead the level going quiet again at 500 starts a fresh one, and the
    // stop is 400ms after *that* - the hangover measures how long it has been
    // quiet, not how long since the last word.
    expect(d.update(QUIET, 500)).toBe(true)
    expect(d.update(QUIET, 500 + SPEAKING.hangoverMs - 1)).toBe(true)
    expect(d.update(QUIET, 500 + SPEAKING.hangoverMs)).toBe(false)
  })

  it('can be started again after stopping', () => {
    const d = new SpeakingDetector()
    d.update(LOUD, 0)
    d.update(QUIET, 0)
    d.update(QUIET, SPEAKING.hangoverMs)
    expect(d.speaking).toBe(false)
    expect(d.update(LOUD, SPEAKING.hangoverMs + 1)).toBe(true)
  })

  it('treats a level exactly at `on` as speaking, and exactly at `off` as not stopping', () => {
    const d = new SpeakingDetector()
    expect(d.update(SPEAKING.on, 0)).toBe(true)
    expect(d.update(SPEAKING.off, 1)).toBe(true)
  })

  it('reset clears a lit detector at once', () => {
    // A track replaced mid-call must not leave the old one's tile lit until
    // the new track produces enough audio to move it.
    const d = new SpeakingDetector()
    d.update(LOUD, 0)
    expect(d.speaking).toBe(true)
    d.reset()
    expect(d.speaking).toBe(false)
  })

  it('honours custom thresholds', () => {
    const d = new SpeakingDetector({ on: 0.5, off: 0.4, hangoverMs: 10 })
    expect(d.update(0.45, 0)).toBe(false)
    expect(d.update(0.5, 1)).toBe(true)
    expect(d.update(0.45, 2)).toBe(true)
  })

  it('never reports speaking on a silent stream, however long it runs', () => {
    const d = new SpeakingDetector()
    for (let now = 0; now < 60_000; now += 50) expect(d.update(0, now)).toBe(false)
  })
})

describe('SpeakingSet', () => {
  it('keeps sources apart', () => {
    const set = new SpeakingSet()
    set.update('ada', LOUD, 0)
    set.update('bob', QUIET, 0)
    expect(set.speaking('ada')).toBe(true)
    expect(set.speaking('bob')).toBe(false)
  })

  it('reports an unknown key as not speaking rather than throwing', () => {
    expect(new SpeakingSet().speaking('nobody')).toBe(false)
  })

  it('lists everyone currently speaking', () => {
    const set = new SpeakingSet()
    set.update('ada', LOUD, 0)
    set.update('bob', LOUD, 0)
    set.update('cai', QUIET, 0)
    expect(set.active().sort()).toEqual(['ada', 'bob'])
  })

  it('forgets a source on request', () => {
    const set = new SpeakingSet()
    set.update('ada', LOUD, 0)
    set.forget('ada')
    expect(set.speaking('ada')).toBe(false)
    expect(set.active()).toEqual([])
  })

  it('retain drops everyone not named, so the map tracks the room', () => {
    // A room that ran for an afternoon would otherwise hold a detector per
    // device that ever joined.
    const set = new SpeakingSet()
    set.update('ada', LOUD, 0)
    set.update('bob', LOUD, 0)
    set.update('cai', LOUD, 0)
    set.retain(['ada', 'cai'])
    expect(set.active().sort()).toEqual(['ada', 'cai'])
    expect(set.speaking('bob')).toBe(false)
  })

  it('retain with nothing to keep empties it', () => {
    const set = new SpeakingSet()
    set.update('ada', LOUD, 0)
    set.retain([])
    expect(set.active()).toEqual([])
  })
})

describe('audio levels feeding the detector', () => {
  it('reads a byte time-domain block centred on 128 as silence', () => {
    // The bug this prevents: taking the RMS of the raw bytes reports
    // near-maximum energy for a silent room, so every tile lights up.
    const silent = new Uint8Array(128).fill(128)
    expect(rmsFromByteTimeDomain(silent)).toBe(0)
    expect(new SpeakingDetector().update(rmsFromByteTimeDomain(silent), 0)).toBe(false)
  })

  it('reads a full-scale square wave as loud enough to speak', () => {
    const loud = new Uint8Array(128)
    for (let i = 0; i < loud.length; i++) loud[i] = i % 2 === 0 ? 255 : 1
    expect(rmsFromByteTimeDomain(loud)).toBeGreaterThan(SPEAKING.on)
    expect(new SpeakingDetector().update(rmsFromByteTimeDomain(loud), 0)).toBe(true)
  })

  it('agrees with the float rms on the same signal', () => {
    // Same wave, both encodings. They should land within a byte's worth of
    // quantisation of each other, which is what keeps `SPEAKING.off` and the
    // utterance splitter's silence threshold comparable.
    const floats = new Float32Array(256)
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      const v = Math.sin((i / 256) * Math.PI * 8) * 0.5
      floats[i] = v
      bytes[i] = Math.round(v * 128 + 128)
    }
    expect(rmsFromByteTimeDomain(bytes)).toBeCloseTo(rms(floats), 2)
  })

  it('reports zero for an empty block rather than NaN', () => {
    expect(rmsFromByteTimeDomain(new Uint8Array(0))).toBe(0)
    expect(rms(new Float32Array(0))).toBe(0)
  })
})
