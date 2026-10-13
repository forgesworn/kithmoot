import {test, expect} from '@playwright/test'
import {encodeRoomLink} from '../src/link.js'
import {generateRoomSecret} from '../src/room.js'
import {newDeviceContext, open, openCall, turnOnMedia} from './browser.js'
import {testRelaysFor} from './relays.js'

// Exercise Chromium's actual audio activation policy. The normal media suite
// disables that policy, which can hide a recorder started after relay awaits.
test.use({launchOptions: {args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output']}})

for (const [layout, simultaneous] of [['audio', false], ['gallery', false], ['gallery', true]] as const) test(`saved ${layout} recording contains the remote voice with the recorder microphone muted${simultaneous ? ' after simultaneous call starts' : ''}`,  async ({browser, baseURL}, info) => {
  test.skip(!['chromium', 'chromium-desktop'].includes(info.project.name), 'Synthetic microphones require Chromium')
  const contexts = await Promise.all([0, 1].map(() => newDeviceContext(browser, baseURL!, {viewport: {width: 1440, height: 900}})))
  let holding = false
  const held: Array<() => void> = []
  if (simultaneous) for (const context of contexts) await context.routeWebSocket(url => url.href === new URL('/__test-relay', baseURL!).href.replace('https:', 'wss:'), socket => {
    const upstream = socket.connectToServer()
    socket.onMessage(message => upstream.send(message))
    upstream.onMessage(message => {const frame = JSON.parse(String(message)); if (holding && frame[0] === 'EVENT' && frame[2]?.kind === 20461) held.push(() => socket.send(message)); else socket.send(message)})
  })
  try {
    const a = await contexts[0]!.newPage(), b = await contexts[1]!.newPage()
    const url = encodeRoomLink(baseURL!, {secret: generateRoomSecret(), name: 'Recording audio', relays: testRelaysFor(baseURL!) ?? [], iceUrls: []})
    for (const [page, name] of [[a, 'Ada'], [b, 'Bob']] as const) {await open(page, url, name); await page.locator('#join').click()}
    if (simultaneous) {holding = true; await Promise.all([turnOnMedia(a), turnOnMedia(b)]); holding = false; held.splice(0).forEach(send => send())}
    else {await turnOnMedia(a); await expect(b.locator('#callToggle')).toHaveText('Join call'); await turnOnMedia(b)}
    await openCall(a)
    await a.locator('#toggleMic').click()
    await expect(a.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'false')
    // Prove remote audio reached this device before testing the export.
    await expect.poll(() => a.evaluate(async () => {
      const element = Array.from(document.querySelectorAll<HTMLAudioElement>('audio')).find(el => el.srcObject instanceof MediaStream && (el.srcObject as MediaStream).getAudioTracks().length)
      if (!element) return 0
      const context = new AudioContext(), analyser = context.createAnalyser(), source = context.createMediaStreamSource(element.srcObject as MediaStream)
      const silent = context.createGain(); silent.gain.value = 0; source.connect(analyser); analyser.connect(silent); silent.connect(context.destination)
      try {await context.resume(); await new Promise(resolve => setTimeout(resolve, 100)); const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)}
      finally {await context.close()}
    })).toBeGreaterThan(0.001)
    await a.locator('#recordToggle').click()
    await a.locator(`input[name="recording-layout"][value="${layout}"]`).check()
    await a.locator('#actionConfirm').click()
    await expect(a.locator('#recordingElapsed')).toBeVisible()
    await a.waitForTimeout(2200)
    await a.locator('#recordingStop').click()
    await expect(a.locator('#recordingReady')).toBeVisible()
    const result = await a.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement) => {
      const bytes = await (await fetch(link.href)).arrayBuffer(), context = new AudioContext()
      try {const audio = await context.decodeAudioData(bytes), samples = audio.getChannelData(0); return {duration: audio.duration, rms: Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)}}
      finally {await context.close()}
    })
    await info.attach('remote-only-recording-audio.json', {body: JSON.stringify(result), contentType: 'application/json'})
    expect(result.duration).toBeGreaterThan(1)
    expect(result.rms).toBeGreaterThan(0.001)
  } finally {await Promise.all(contexts.map(context => context.close()))}
})
