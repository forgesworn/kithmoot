// Synthetic media only. Browser processes are endpoints; Python bridges carry
// opaque ICE/DTLS/SRTP via pinned FIPS. This is not a zero-install web client.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.FIPS_PLAYWRIGHT_MODULE || '@playwright/test')
const binary = process.argv[2]
if (!binary) throw new Error('Supply the pinned FIPS daemon binary path')
const mtu = process.argv[3] || '1280'
const fixture = spawn('python3', [fileURLToPath(new URL('./mesh.py', import.meta.url)), binary, mtu], { stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]()
async function read() {
  const timer = setTimeout(() => fixture.kill('SIGTERM'), 30000)
  try {
    const line = await lines.next()
    if (line.done) throw new Error('Mesh fixture exited')
    return JSON.parse(line.value)
  } finally { clearTimeout(timer) }
}
async function rpc(request) {
  fixture.stdin.write(JSON.stringify(request) + '\n')
  return read()
}
let browser
let stage = 'start fixture'
const watchdog = setTimeout(() => { fixture.kill('SIGTERM'); void browser?.close() }, 180000)
try {
  const ready = await read()
  assert.equal(ready.ready, true)
  browser = await chromium.launch({ headless: true, args: [
    '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns',
  ] })
  const page = await browser.newPage()
  await page.evaluate(() => {
    window.fixture = { pairs: [], sources: [], elements: [] }
    window.gather = async pc => {
      if (pc.iceGatheringState === 'complete') return
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ICE gathering timeout')), 10000)
        pc.addEventListener('icegatheringstatechange', function check() {
          if (pc.iceGatheringState === 'complete') { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve() }
        })
      })
    }
    // No camera/microphone permissions. Four independent synthetic sources.
    for (let i = 0; i < 4; i++) {
      const audio = new AudioContext()
      const tone = audio.createOscillator()
      tone.frequency.value = 300 + i * 100
      const destination = audio.createMediaStreamDestination()
      const silent = audio.createGain(); silent.gain.value = 0
      tone.connect(destination); tone.connect(silent); silent.connect(audio.destination)
      tone.start(); void audio.resume()
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120
      const context = canvas.getContext('2d')
      let frame = 0
      const timer = setInterval(() => {
        context.fillStyle = ++frame % 2 ? '#19aab5' : '#7744cc'
        context.fillRect(0, 0, 160, 120)
        context.fillStyle = 'white'; context.fillText(`${i}:${frame}`, 10, 40)
      }, 66)
      const video = canvas.captureStream(10)
      window.fixture.sources.push({ audio, tone, timer, video, destination,
        tracks: [...video.getTracks(), ...destination.stream.getTracks()] })
    }
    window.rewrite = (sdp, port) => {
      // Each bundled m-section gets the same sole synthetic candidate. There
      // are no original/direct candidates or ICE servers left for fallback.
      return sdp.split('\r\n').filter(line => !line.startsWith('a=candidate:'))
        .map(line => line.startsWith('a=mid:') ? `${line}\r\na=candidate:1 1 udp 2130706431 127.0.0.1 ${port} typ host` : line).join('\r\n')
    }
    window.target = sdp => {
      const line = sdp.split('\r\n').find(line => /^a=candidate:.* udp .* typ host/i.test(line) && /^\d+\.\d+\.\d+\.\d+$/.test(line.split(' ')[4]))
      if (!line) throw new Error('No numeric IPv4 UDP host candidate; fixture cannot proceed')
      const fields = line.split(' ')
      // The helper is on this same host. Chromium's socket uses loopback
      // source addresses for the sole loopback candidate supplied above.
      return ['127.0.0.1', Number(fields[5])]
    }
    window.media = async () => Promise.all(window.fixture.pairs.flatMap(pair => pair.pcs).map(async pc => {
      const report = [...(await pc.getStats()).values()]
      const inbound = report.filter(s => s.type === 'inbound-rtp')
      const pair = report.find(s => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
      return { frames: inbound.reduce((sum, s) => sum + (s.framesDecoded || 0), 0),
        energy: inbound.reduce((sum, s) => sum + (s.totalAudioEnergy || 0), 0),
        lost: inbound.reduce((sum, s) => sum + (s.packetsLost || 0), 0),
        jitter: Math.max(0, ...inbound.map(s => s.jitter || 0)), rtt: pair?.currentRoundTripTime ?? null,
        connected: pc.connectionState === 'connected' }
    }))
  })
  const phases = []
  for (const edges of [[[0, 1]], [[0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]]) {
    stage = phases.length ? 'four-participant media' : 'two-participant media'
    const started = Date.now()
    for (const ends of edges) {
      const ports = await rpc({ op: 'pair', ends })
      const pair = await page.evaluate(async ({ ends, ports }) => {
        const pcs = ends.map(() => new RTCPeerConnection({ iceServers: [] }))
        pcs.forEach((pc, i) => {
          const stream = new MediaStream()
          pc.ontrack = event => stream.addTrack(event.track)
          const element = document.createElement('video'); element.autoplay = true; element.srcObject = stream
          document.body.append(element); window.fixture.elements.push(element)
          window.fixture.sources[ends[i]].tracks.forEach(track => pc.addTrack(track))
        })
        await pcs[0].setLocalDescription(await pcs[0].createOffer()); await window.gather(pcs[0])
        const offer = pcs[0].localDescription.sdp
        await pcs[1].setRemoteDescription({ type: 'offer', sdp: window.rewrite(offer, ports[1]) })
        await pcs[1].setLocalDescription(await pcs[1].createAnswer()); await window.gather(pcs[1])
        const answer = pcs[1].localDescription.sdp
        await pcs[0].setRemoteDescription({ type: 'answer', sdp: window.rewrite(answer, ports[0]) })
        const index = window.fixture.pairs.push({ pcs }) - 1
        return { index, targets: [window.target(offer), window.target(answer)] }
      }, { ends, ports })
      await rpc({ op: 'targets', pair: pair.index, targets: pair.targets })
    }
    const baseline = await page.evaluate(() => window.media())
    const deadline = Date.now() + 30000
    let media
    do {
      await new Promise(resolve => setTimeout(resolve, 500))
      media = await page.evaluate(() => window.media())
      if (media.every((m, i) => m.connected && m.frames > baseline[i].frames + 5 && m.energy > baseline[i].energy)) break
    } while (Date.now() < deadline)
    assert(media.every((m, i) => m.connected && m.frames > baseline[i].frames + 5 && m.energy > baseline[i].energy), JSON.stringify({ media, bridges: await rpc({ op: 'stats' }) }))
    const sample = media
    await new Promise(resolve => setTimeout(resolve, 4000))
    media = await page.evaluate(() => window.media())
    assert(media.every((m, i) => m.connected && m.frames >= sample[i].frames + 15 && m.energy > sample[i].energy), 'Media did not continue across the observation window')
    phases.push({ participants: phases.length ? 4 : 2, elapsedMs: Date.now() - started,
      observationMs: 4000, decodedFrameDeltas: media.map((m, i) => m.frames - sample[i].frames), media })
  }
  const beforeCut = await rpc({ op: 'stats' })
  assert(beforeCut.flat().every(s => s.sent > 0 && s.received > 0 && s.oversize === 0))
  stage = 'peer flow identity'
  const identityProbe = await rpc({ op: 'identity-probe' })
  assert.deepEqual(identityProbe, { expected: 1, wrong: 0 }, 'Native flow identity isolation failed')
  stage = 'transit cut'
  await rpc({ op: 'cut' })
  await new Promise(resolve => setTimeout(resolve, 2000))
  const stopped = await rpc({ op: 'stats' })
  await new Promise(resolve => setTimeout(resolve, 2000))
  const afterCut = await rpc({ op: 'stats' })
  assert.deepEqual(afterCut.map(p => p.map(s => s.received)), stopped.map(p => p.map(s => s.received)), 'Traffic bypassed the stopped FIPS transit')
  console.log(JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), ...ready,
    chromiumVersion: browser.version(), nodeVersion: process.version,
    scope: 'single-host synthetic helper-assisted browser mesh',
    phases, bridges: beforeCut, identityProbe, transitCutStoppedDelivery: true,
    unproven: ['separate networks and NAT', 'Android and physical GrapheneOS', 'browser without helper', 'battery', 'production admission and abuse limits'] }, null, 2))
} catch (error) {
  console.log(JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), stage, transportMtu: Number(mtu), error: error.message }, null, 2))
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await browser?.close()
  const exited = fixture.exitCode !== null || fixture.signalCode !== null ? Promise.resolve() : once(fixture, 'exit')
  fixture.stdin.end()
  const timer = setTimeout(() => fixture.kill('SIGTERM'), 15000)
  await exited
  clearTimeout(timer)
}
