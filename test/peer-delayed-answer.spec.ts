import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

test.beforeEach(async ({ page }) => {
  const bundle = await build({ stdin: {
    contents: `import { Peer } from ${JSON.stringify(resolve('src/peer.ts'))}; globalThis.TestPeer = Peer;`,
    resolveDir: process.cwd(), loader: 'ts',
  }, bundle: true, platform: 'browser', format: 'iife', write: false })
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
})

test('a delayed camera-off answer leaves the replacement camera offer pending', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const Peer = (window as unknown as { TestPeer: typeof import('../src/peer.js').Peer }).TestPeer
    type Signal = import('../src/signal.js').SignalBody
    const browserSignals: Signal[] = [], nativeSignals: Signal[] = []
    const browserPc = new RTCPeerConnection(), nativePc = new RTCPeerConnection()
    const options = { onTrack: () => {}, offerRetry: { intervalMs: 30_000, wedgeMs: 60_000 } }
    type Connection = import('../src/peer.js').RTCPeerConnectionLike
    const browser = new Peer({ ...options, factory: () => browserPc as unknown as Connection, localDevice: '22'.repeat(32),
      remoteDevice: '11'.repeat(32), onSignal: body => browserSignals.push(body) })
    const native = new Peer({ ...options, factory: () => nativePc as unknown as Connection, localDevice: '11'.repeat(32),
      remoteDevice: '22'.repeat(32), onSignal: body => nativeSignals.push(body) })
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240
    canvas.getContext('2d')!.fillRect(0, 0, 320, 240)
    const camera = canvas.captureStream(10).getVideoTracks()[0]!
    const sound = new AudioContext(), destination = sound.createMediaStreamDestination()
    const audio = destination.stream.getAudioTracks()[0]!
    let replacement: MediaStreamTrack | undefined
    const waitOffer = async (previousCount: number) => {
      const end = Date.now() + 5000
      while (browserSignals.filter(body => body.type === 'offer').length <= previousCount) {
        if (Date.now() >= end) throw new Error('No replacement offer')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return browserSignals.filter(body => body.type === 'offer').at(-1)!
    }
    const answer = () => nativeSignals.filter(body => body.type === 'answer').at(-1)!
    try {
      await browser.start([camera, audio])
      await native.handleSignal(await waitOffer(0)); await browser.handleSignal(answer())
      await browser.start([audio])
      await native.handleSignal(await waitOffer(1))
      const oldAnswer = answer(); await browser.handleSignal(oldAnswer)
      camera.stop(); replacement = canvas.captureStream(10).getVideoTracks()[0]!
      await browser.start([replacement, audio])
      const offer = await waitOffer(2)
      const before = browserPc.localDescription!.sdp
      await browser.handleSignal(oldAnswer)
      const pendingState = browserPc.signalingState
      const pendingUnchanged = browserPc.localDescription!.sdp === before
      await native.handleSignal(offer); await browser.handleSignal(answer())
      return { oldSections: oldAnswer.sdp!.match(/^m=/gm)!.length,
        newSections: offer.sdp!.match(/^m=/gm)!.length, pendingState, pendingUnchanged,
        finalState: browserPc.signalingState,
        replacementDirection: browserPc.getTransceivers().find(t => t.sender.track === replacement)!.currentDirection }
    } finally {
      browser.close(); native.close(); camera.stop(); audio.stop(); replacement?.stop(); await sound.close()
    }
  })
  expect(result).toEqual({ oldSections: 2, newSections: 3, pendingState: 'have-local-offer',
    pendingUnchanged: true, finalState: 'stable', replacementDirection: 'sendonly' })
})

test('a screen from a conflicting first offer is still negotiated when the browser gives no new event', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const Peer = (window as unknown as { TestPeer: typeof import('../src/peer.js').Peer }).TestPeer
    type Signal = import('../src/signal.js').SignalBody
    type Connection = import('../src/peer.js').RTCPeerConnectionLike
    const screenSignals: Signal[] = [], micSignals: Signal[] = []
    let screenPc = new RTCPeerConnection()
    const micPc = new RTCPeerConnection()
    const options = { onTrack: () => {}, candidateGatherMs: 0, offerRetry: { intervalMs: 30_000, wedgeMs: 60_000 } }
    let replacement: Promise<void> | undefined
    let screenSequence = 0
    const createScreenPeer = (): InstanceType<typeof Peer> => new Peer({
      ...options,
      factory: () => screenPc as unknown as Connection, localDevice: '11'.repeat(32), remoteDevice: '22'.repeat(32),
      nextOfferSequence: () => ++screenSequence,
      onSignal: body => screenSignals.push(body),
      onRemoteRestart: (offer, candidates, _retired, answerFirst) => {
        if (!answerFirst) throw new Error('Expected the first offer to be answered on the fresh connection')
        screenPeer.close()
        screenPc = new RTCPeerConnection()
        screenPeer = createScreenPeer()
        replacement = (async () => {
          await screenPeer.handleSignal(offer)
          for (const candidate of candidates) await screenPeer.handleSignal(candidate)
          await screenPeer.start([screen])
        })()
      },
    })
    let screenPeer = createScreenPeer()
    const micPeer = new Peer({
      ...options,
      factory: () => micPc as unknown as Connection, localDevice: '22'.repeat(32), remoteDevice: '11'.repeat(32),
      onSignal: body => micSignals.push(body),
    })
    const canvas = document.createElement('canvas')
    const screen = canvas.captureStream(10).getVideoTracks()[0]!
    const sound = new AudioContext()
    const mic = sound.createMediaStreamDestination().stream.getAudioTracks()[0]!
    const nextOffer = async (signals: Signal[], after = 0) => {
      const end = Date.now() + 5000
      while (Date.now() < end) {
        const offer = signals.filter(body => body.type === 'offer')[after]
        if (offer) return offer
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('Expected an offer for the published track')
    }
    try {
      await Promise.all([screenPeer.start([screen]), micPeer.start([mic])])
      const [screenOffer, micOffer] = await Promise.all([nextOffer(screenSignals), nextOffer(micSignals)])
      // Reproduce Chromium's missing event after answering the competing, audio-only offer.
      screenPc.onnegotiationneeded = null
      await micPeer.handleSignal(screenOffer)
      await screenPeer.handleSignal(micOffer)
      await replacement
      const followUp = await nextOffer(screenSignals, 1)
      const descriptionOrder = screenSignals.filter(body => body.type !== 'ice').map(body => body.type)
      await micPeer.handleSignal(screenSignals.find(body => body.type === 'answer')!)
      await micPeer.handleSignal(followUp)
      await screenPeer.handleSignal(micSignals.find(body => body.type === 'answer')!)
      return {
        descriptionOrder,
        screenDirection: screenPc.getTransceivers().find(t => t.sender.track === screen)?.currentDirection,
      }
    } finally {
      screenPeer.close(); micPeer.close(); screen.stop(); mic.stop(); await sound.close()
    }
  })
  expect(result).toEqual({
    descriptionOrder: ['offer', 'answer', 'offer'],
    screenDirection: 'sendonly',
  })
})
