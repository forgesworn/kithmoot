// Explicit operator check: separate private you.json and friend.json accounts.
// Sends synthetic media only. Never prints credentials or records browser traces.
import { readFileSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { chromium } from '@playwright/test'

const directory = process.argv[2]
if (!directory || !isAbsolute(directory)) throw new Error('Supply an absolute private credentials directory')
const accounts = ['you', 'friend'].map(name => JSON.parse(readFileSync(resolve(directory, `${name}.json`), 'utf8')))
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const deadline = setTimeout(() => { void browser.close() }, 120000)
const result = {}
let phase = 'browser startup'
try {
  const page = await browser.newPage()
  for (const transport of process.argv.includes('--udp-only') ? ['udp'] : ['udp', 'tcp']) {
    phase = `${transport} media`
    result[transport] = await page.evaluate(async ({ accounts, transport }) => {
      const pcs = accounts.map(account => new RTCPeerConnection({ iceTransportPolicy: 'relay', iceServers: [{
        ...account, urls: account.urls.filter(url => url.startsWith('turn:')).map(url => `${url.split('?')[0]}?transport=${transport}`).slice(0, 1),
      }] }))
      const audio = new AudioContext()
      await audio.resume()
      const oscillator = audio.createOscillator()
      const destination = audio.createMediaStreamDestination()
      oscillator.connect(destination)
      // Pull the graph even without a physical output device. Keep it silent
      // at the speaker while the MediaStream branch carries the sine wave.
      const silent = audio.createGain()
      silent.gain.value = 0
      oscillator.connect(silent); silent.connect(audio.destination)
      oscillator.start()
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 240
      const context = canvas.getContext('2d')
      let frame = 0
      const draw = setInterval(() => {
        context.fillStyle = ++frame % 2 ? '#19aab5' : '#7744cc'
        context.fillRect(0, 0, 320, 240)
      }, 33)
      const video = canvas.captureStream(15)
      const streams = [new MediaStream(), new MediaStream()]
      const candidateErrors = []
      let step = 'gather offer'
      let lastMedia = []
      const elements = pcs.map((pc, index) => {
        pc.onicecandidateerror = event => candidateErrors.push({ peer: index, code: event.errorCode })
        pc.ontrack = event => streams[index].addTrack(event.track)
        const element = document.createElement('video')
        // A live audio sink makes the browser decode the received Opus track.
        // Playwright's headless browser mutes the physical output globally.
        element.autoplay = true; element.srcObject = streams[index]
        document.body.append(element)
        for (const track of [...video.getTracks(), ...destination.stream.getTracks()]) pc.addTrack(track)
        return element
      })
      const gather = async pc => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('ICE gathering timed out')), 20000)
          const check = () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve() }
          }
          pc.addEventListener('icegatheringstatechange', check); check()
        })
      }
      try {
        await pcs[0].setLocalDescription(await pcs[0].createOffer()); await gather(pcs[0])
        step = 'gather answer'
        await pcs[1].setRemoteDescription(pcs[0].localDescription)
        await pcs[1].setLocalDescription(await pcs[1].createAnswer()); await gather(pcs[1])
        await pcs[0].setRemoteDescription(pcs[1].localDescription)
        step = 'receive media'
        const deadline = Date.now() + 30000
        while (Date.now() < deadline) {
          const results = await Promise.all(pcs.map(async (pc, index) => {
            const report = await pc.getStats()
            const stats = [...report.values()]
            const pair = stats.find(item => item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded')
            const local = pair && report.get(pair.localCandidateId)
            const remote = pair && report.get(pair.remoteCandidateId)
            return {
              relayPair: local?.candidateType === 'relay' && remote?.candidateType === 'relay',
              transport: local?.relayProtocol,
              receivedBytes: pair?.bytesReceived ?? 0,
              decodedVideoFrames: stats.filter(item => item.type === 'inbound-rtp' && item.kind === 'video').reduce((sum, item) => sum + (item.framesDecoded ?? 0), 0),
              audioEnergy: stats.filter(item => item.type === 'inbound-rtp' && item.kind === 'audio').reduce((sum, item) => sum + (item.totalAudioEnergy ?? 0), 0),
              receivedAudioBytes: stats.filter(item => item.type === 'inbound-rtp' && item.kind === 'audio').reduce((sum, item) => sum + (item.bytesReceived ?? 0), 0),
              displayedVideo: elements[index].videoWidth > 0,
              relayCandidates: stats.filter(item => item.type === 'local-candidate' && item.candidateType === 'relay')
                .map(item => ({ address: item.address, port: item.port, protocol: item.protocol, relayProtocol: item.relayProtocol })),
            }
          }))
          lastMedia = results
          if (results.every(item => item.relayPair && item.transport === transport && item.receivedBytes > 0 && item.decodedVideoFrames > 0 && item.audioEnergy > 0 && item.displayedVideo)) return results
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        throw new Error('Two-way relay media did not arrive')
      } catch {
        return { passed: false, step, candidateErrors, lastMedia,
          states: pcs.map(pc => ({ connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState })) }
      } finally {
        pcs.forEach(pc => pc.close()); clearInterval(draw)
        video.getTracks().forEach(track => track.stop()); destination.stream.getTracks().forEach(track => track.stop())
        oscillator.stop(); await audio.close(); elements.forEach(element => element.remove())
      }
    }, { accounts, transport })
    if (!Array.isArray(result[transport])) throw new Error('Relay media failed')
  }
  phase = 'wrong password'
  result.wrongPasswordRejected = await page.evaluate(async account => {
    const pc = new RTCPeerConnection({ iceTransportPolicy: 'relay', iceServers: [{ ...account, credential: 'deliberately-invalid-operator-check' }] })
    let candidates = 0
    const done = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 20000)
      pc.onicecandidate = event => {
        if (event.candidate?.type === 'relay') candidates++
        if (!event.candidate) { clearTimeout(timer); resolve(true) }
      }
    })
    try {
      pc.createDataChannel('authentication-check')
      await pc.setLocalDescription(await pc.createOffer())
      return await done && candidates === 0
    } finally { pc.close() }
  }, accounts[0])
  if (!result.wrongPasswordRejected) throw new Error('Invalid account was not refused')
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2))
} catch {
  // Browser exception messages can contain input values. Keep private values out of logs.
  console.error('Private relay validation failed: media or authentication check did not pass.')
  console.error(JSON.stringify({ phase, result }))
  process.exitCode = 1
} finally { clearTimeout(deadline); await browser.close() }
