import { expect, it } from 'vitest'
import { Peer } from './peer.js'
import type { SignalBody } from './signal.js'
import { createFakeFactory, fakeTrack } from '../test/fake-rtc.js'

async function settle(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

it('keeps a replacement camera offer pending when an old accepted answer is replayed', async () => {
  const browserSignals: SignalBody[] = [], nativeSignals: SignalBody[] = []
  const browserFactory = createFakeFactory({ structuredSdp: true })
  const nativeFactory = createFakeFactory({ structuredSdp: true })
  const browser = new Peer({ factory: browserFactory, localDevice: '22'.repeat(32),
    remoteDevice: '11'.repeat(32), onSignal: body => browserSignals.push(body), onTrack: () => {} })
  const native = new Peer({ factory: nativeFactory, localDevice: '11'.repeat(32),
    remoteDevice: '22'.repeat(32), onSignal: body => nativeSignals.push(body), onTrack: () => {} })
  const latest = (signals: SignalBody[], type: string) => {
    const signal = signals.filter(body => body.type === type).at(-1)
    if (!signal) throw new Error(`Missing ${type}`)
    return signal
  }
  const camera = fakeTrack('video'), audio = fakeTrack('audio')
  try {
    await browser.start([camera, audio]); await settle()
    await native.handleSignal(latest(browserSignals, 'offer')); await settle()
    await browser.handleSignal(latest(nativeSignals, 'answer')); await settle()
    await browser.start([audio]); await settle()
    await native.handleSignal(latest(browserSignals, 'offer')); await settle()
    const cameraOffAnswer = latest(nativeSignals, 'answer')
    await browser.handleSignal(cameraOffAnswer); await settle()

    const replacement = fakeTrack('video')
    await browser.start([replacement, audio]); await settle()
    const pc = browserFactory.instances[0]!
    const cameraOffer = latest(browserSignals, 'offer')
    expect(cameraOffer.sdp?.match(/^m=/gm)).toHaveLength(3)
    expect(cameraOffAnswer.sdp?.match(/^m=/gm)).toHaveLength(2)
    const before = pc.calls.filter(call => call.method === 'setRemoteDescription').length
    await expect(browser.handleSignal(cameraOffAnswer)).resolves.toBeUndefined()
    expect(pc.calls.filter(call => call.method === 'setRemoteDescription')).toHaveLength(before)
    expect(pc.signalingState).toBe('have-local-offer')
    expect(pc.localDescription?.sdp).toBe(cameraOffer.sdp)

    // An unknown malformed answer must still reach the stack and fail.
    const unknown = { ...cameraOffAnswer, sdp: cameraOffAnswer.sdp!.replace('a=recvonly', 'a=inactive') }
    expect(unknown.sdp).not.toBe(cameraOffAnswer.sdp)
    await expect(browser.handleSignal(unknown)).rejects.toThrow('order of m-lines')
    expect(pc.signalingState).toBe('have-local-offer')

    await native.handleSignal(cameraOffer); await settle()
    await browser.handleSignal(latest(nativeSignals, 'answer')); await settle()
    expect(pc.signalingState).toBe('stable')
    expect(pc.getTransceivers().find(t => t.sender.track === replacement)?.currentDirection).toBe('sendonly')
  } finally { browser.close(); native.close() }
})
