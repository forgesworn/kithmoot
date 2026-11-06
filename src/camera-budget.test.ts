import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { capCameraSender, cameraRungFor, CAMERA_RUNG_MEDIUM, CAMERA_RUNG_SMALL } from './camera-budget.js'
import { Mesh } from './mesh.js'
import type { MeshSession } from './mesh.js'
import { Peer } from './peer.js'
import type { ParticipantView } from './session.js'
import { createFakeFactory, fakeTrack, type FakeRTCPeerConnection, type FakeRtpSender } from '../test/fake-rtc.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const LOW = 'a'.repeat(64)
const HIGH = 'b'.repeat(64)

const share = (): MediaStreamTrack => Object.assign(fakeTrack('video'), { contentHint: 'detail' }) as MediaStreamTrack

function sender(track: MediaStreamTrack | null, encodings: Record<string, unknown>[] = [{}]) {
  let parameters = { encodings }
  const calls: { encodings: Record<string, unknown>[] }[] = []
  return {
    track,
    calls,
    getParameters: () => ({ encodings: parameters.encodings.map((e) => ({ ...e })) }),
    setParameters: (next: { encodings: Record<string, unknown>[] }) => { parameters = next; calls.push(next); return Promise.resolve() },
  }
}

describe('cameraRungFor', () => {
  it('leaves a one-to-one call, and a call with nobody to send to, on the browser defaults', () => {
    for (const recipients of [0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(cameraRungFor(recipients)).toBeUndefined()
  })

  it('steps down on the Android rungs: two or three recipients, then four or more', () => {
    expect(cameraRungFor(2)).toBe(CAMERA_RUNG_MEDIUM)
    expect(cameraRungFor(3)).toBe(CAMERA_RUNG_MEDIUM)
    expect(cameraRungFor(4)).toBe(CAMERA_RUNG_SMALL)
    expect(cameraRungFor(40)).toBe(CAMERA_RUNG_SMALL)
    expect(CAMERA_RUNG_MEDIUM).toEqual({ maxBitrate: 800_000, maxFramerate: 24, maxHeight: 540 })
    expect(CAMERA_RUNG_SMALL).toEqual({ maxBitrate: 500_000, maxFramerate: 15, maxHeight: 360 })
  })
})

describe('capCameraSender', () => {
  const sized = (width: number, height: number) => Object.assign(fakeTrack('video'), { getSettings: () => ({ width, height }) }) as MediaStreamTrack

  it('applies the rung to a camera sender, keeping its other encoding fields', () => {
    const s = sender(sized(640, 480), [{ active: true, scaleResolutionDownBy: 1 }])
    expect(capCameraSender(s, CAMERA_RUNG_SMALL)).toBe(true)
    expect(s.calls).toEqual([{ encodings: [{ active: true, maxBitrate: 500_000, maxFramerate: 15, scaleResolutionDownBy: 480 / 360 }] }])
  })

  it('scales down to the rung height and never up, judging a portrait camera by its short side', () => {
    const scale = (track: MediaStreamTrack) => { const s = sender(track); capCameraSender(s, CAMERA_RUNG_MEDIUM); return s.calls[0]!.encodings[0]!.scaleResolutionDownBy }
    expect(scale(sized(1280, 720))).toBe(720 / 540)
    expect(scale(sized(720, 1280))).toBe(720 / 540)
    expect(scale(sized(640, 480))).toBe(1)
    expect(scale(fakeTrack('video'))).toBe(1)
  })

  it('lifts the rung again, and asks nothing when there is nothing to change', () => {
    const s = sender(sized(640, 480))
    expect(capCameraSender(s, undefined)).toBe(false)
    capCameraSender(s, CAMERA_RUNG_SMALL)
    expect(capCameraSender(s, CAMERA_RUNG_SMALL)).toBe(false)
    expect(capCameraSender(s, undefined)).toBe(true)
    expect(s.calls.at(-1)).toEqual({ encodings: [{ scaleResolutionDownBy: 1 }] })
    expect(s.calls).toHaveLength(2)
  })

  it('never touches a screen share, audio, an empty sender or one with no encodings yet', () => {
    for (const s of [sender(share()), sender(fakeTrack('audio')), sender(null), sender(fakeTrack('video'), [])]) {
      expect(capCameraSender(s, CAMERA_RUNG_SMALL)).toBe(false)
      expect(s.calls).toEqual([])
    }
  })

  it('falls back to the bitrate ceiling alone when an engine refuses the frame-rate or size ceiling', async () => {
    const s = sender(fakeTrack('video'))
    const set = s.setParameters
    s.setParameters = (next) => ('maxFramerate' in next.encodings[0]! ? Promise.reject(new Error('unsupported')) : set(next))
    expect(capCameraSender(s, CAMERA_RUNG_SMALL)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.calls).toEqual([{ encodings: [{ maxBitrate: CAMERA_RUNG_SMALL.maxBitrate }] }])
  })

  it('skips an engine without setParameters, and survives one that throws', () => {
    expect(capCameraSender({ track: fakeTrack('video') }, CAMERA_RUNG_SMALL)).toBe(false)
    const throwing = { track: fakeTrack('video'), getParameters: () => { throw new Error('closed') }, setParameters: () => Promise.resolve() }
    expect(capCameraSender(throwing, CAMERA_RUNG_SMALL)).toBe(false)
  })
})

describe('Peer.setCameraRung', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const sendersOf = (pc: FakeRTCPeerConnection) => pc.getSenders() as unknown as FakeRtpSender[]

  it('caps the camera already being sent, without renegotiating, and lifts the cap again', async () => {
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    const camera = fakeTrack('video'), mic = fakeTrack('audio')
    await peer.start([camera, mic]); await settle()
    const pc = factory.instances[0]!
    const callsBefore = pc.calls.length
    peer.setCameraRung(CAMERA_RUNG_SMALL)
    const [cam, audio] = [sendersOf(pc).find((s) => s.track === camera)!, sendersOf(pc).find((s) => s.track === mic)!]
    expect(cam.parameters.encodings[0]!.maxBitrate).toBe(CAMERA_RUNG_SMALL.maxBitrate)
    expect(audio.parameterCalls).toEqual([])
    peer.setCameraRung(undefined)
    expect(cam.parameters.encodings[0]!.maxBitrate).toBeUndefined()
    // setParameters is not a negotiation: no offer, no new m-line.
    expect(pc.calls.slice(callsBefore).filter((c) => c.method !== 'getStats')).toEqual([])
    peer.close()
  })

  it('caps a camera added after the cap was set, and leaves a share alone', async () => {
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    peer.setCameraRung(CAMERA_RUNG_MEDIUM)
    const camera = fakeTrack('video'), screen = share()
    await peer.start([camera, screen]); await settle()
    const pc = factory.instances[0]!
    expect(sendersOf(pc).find((s) => s.track === camera)!.parameters.encodings[0]!.maxBitrate).toBe(CAMERA_RUNG_MEDIUM.maxBitrate)
    // The share keeps its own budget from tuneShareSender, never the camera's.
    expect(sendersOf(pc).find((s) => s.track === screen)!.parameters.encodings[0]!.maxBitrate).not.toBe(CAMERA_RUNG_MEDIUM.maxBitrate)
    peer.close()
  })

  it('reapplies the cap once the connection is up, for engines with no encodings before negotiation', async () => {
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    const camera = fakeTrack('video')
    await peer.start([camera]); await settle()
    const pc = factory.instances[0]!
    const cam = sendersOf(pc).find((s) => s.track === camera)!
    cam.parameters = { encodings: [] }
    peer.setCameraRung(CAMERA_RUNG_MEDIUM)
    expect(cam.parameterCalls).toEqual([])
    cam.parameters = { encodings: [{}] }
    pc.setConnectionState('connected')
    expect(cam.parameters.encodings[0]!.maxBitrate).toBe(CAMERA_RUNG_MEDIUM.maxBitrate)
    peer.close()
  })
})

class FakeSession implements MeshSession {
  #views: ParticipantView[] = []
  #listeners = new Set<(views: ParticipantView[]) => void>()
  participants(): ParticipantView[] { return this.#views }
  onChange(cb: (views: ParticipantView[]) => void): () => void { this.#listeners.add(cb); return () => this.#listeners.delete(cb) }
  setViews(views: ParticipantView[]): void { this.#views = views; for (const listener of this.#listeners) listener(views) }
}

describe('Mesh camera rungs', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const device = () => { const sk = generateSecretKey(); return { sk, pub: getPublicKey(sk) } }
  const cameraCap = (pc: FakeRTCPeerConnection, camera: MediaStreamTrack) =>
    (pc.getSenders() as unknown as FakeRtpSender[]).find((s) => s.track === camera)?.parameters.encodings[0]?.maxBitrate

  function room(count: number) {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const local = device()
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(new SimRelay()), roomId: 'room-1' })
    const others = Array.from({ length: count }, () => ({ participant: device().pub, device: device().pub }))
    const views = (n: number) => others.slice(0, n).map((o) => ({ participant: o.participant, devices: [o.device], tracks: [] }))
    return { session, factory, mesh, views }
  }

  it('leaves a one-to-one call uncapped', async () => {
    const { session, factory, mesh, views } = room(1)
    const camera = fakeTrack('video')
    mesh.publish([camera])
    session.setViews(views(1)); await settle()
    expect(cameraCap(factory.instances[0]!, camera)).toBeUndefined()
    expect((factory.instances[0]!.getSenders() as unknown as FakeRtpSender[])[0]!.parameterCalls).toEqual([])
    mesh.close()
  })

  it('steps the camera down for a big call, and back up as people leave', async () => {
    const { session, factory, mesh, views } = room(5)
    const camera = fakeTrack('video')
    mesh.publish([camera, fakeTrack('audio')])
    session.setViews(views(5)); await settle()
    expect(factory.instances).toHaveLength(5)
    for (const pc of factory.instances) expect(cameraCap(pc, camera)).toBe(CAMERA_RUNG_SMALL.maxBitrate)

    // Two leave: the three left step back up.
    session.setViews(views(3)); await settle()
    const open = factory.instances.filter((pc) => !pc.closed)
    expect(open).toHaveLength(3)
    for (const pc of open) expect(cameraCap(pc, camera)).toBe(CAMERA_RUNG_MEDIUM.maxBitrate)

    // Down to one other person: back to the browser's own ceiling.
    session.setViews(views(1)); await settle()
    const last = factory.instances.filter((pc) => !pc.closed)
    expect(last).toHaveLength(1)
    expect(cameraCap(last[0]!, camera)).toBeUndefined()
    mesh.close()
  })

  it('counts only connections that carry the camera', async () => {
    const { session, factory, mesh, views } = room(3)
    const camera = fakeTrack('video')
    session.setViews(views(3)); await settle()
    // Microphone only: nothing to cap.
    mesh.publish([fakeTrack('audio')]); await settle()
    // A screen share alone is not the camera either.
    const screen = share()
    mesh.publish([screen]); await settle()
    for (const pc of factory.instances) expect(cameraCap(pc, screen)).not.toBe(CAMERA_RUNG_MEDIUM.maxBitrate)
    mesh.publish([camera]); await settle()
    for (const pc of factory.instances) expect(cameraCap(pc, camera)).toBe(CAMERA_RUNG_MEDIUM.maxBitrate)
    mesh.close()
  })
})
