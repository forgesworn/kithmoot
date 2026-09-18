import { test, expect, chromium, firefox, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRoom, joinWithMedia, newDeviceContext, open, openCall } from './browser.js'

/**
 * Does a call that came up STAY up, in every direction, while people do the
 * ordinary things people do on a call?
 *
 * Written from a real call on 17 September 2026: three or four people in a
 * temporary browser room, microphones that worked and then stopped, one
 * person who could hear another who could not hear them back, and a joiner
 * who heard nobody. media.spec.ts asks "can I see and hear you" once, per
 * page. That cannot catch any of this: a page that hears two of three people
 * passes "is anything arriving", and a direction that dies after a toggle is
 * never asked about again.
 *
 * So every assertion here is per DIRECTED pair - X sees Y, X hears Y - made
 * from X's screen, and a failure prints the whole matrix plus the app's own
 * bug report for the dead direction. These are reproductions, not
 * regression guards: a case that fails here is the bug, and the evidence
 * printed with it is what a fix has to change.
 *
 *   see  - an element in Y's tile on X's screen, with a non-flat picture
 *          that changed between two samples.
 *   hear - an `<audio>` in Y's tile that is playing, unmuted, bound to a live
 *          receiver track, and whose receiver's `totalAudioEnergy` rose by
 *          more than silence does between the two samples.
 */

const FAULT_PORT = 7781
const SIGNAL_WRAP = 21059
const PAUSE = (page: Page, ms: number) => page.waitForTimeout(ms)

// ---------------------------------------------------------------------------
// Measuring one screen
// ---------------------------------------------------------------------------

interface VideoSample { i: number; w: number; spread: number; hash: number; time: number; paused: boolean; track: string }
interface SoundSample { i: number; paused: boolean; muted: boolean; time: number; track: string; energy: number | null; packets: number | null; receiver: 'found' | 'closed-pc' | 'missing' | 'none' }
interface TileSample { title: string; videos: VideoSample[]; sounds: SoundSample[] }
interface ScreenSample { tiles: TileSample[]; activation: boolean | null; prompts: string[] }

/** Runs in the page. Plain JS on purpose: it is also sent over raw CDP. */
const SNAPSHOT = async (): Promise<ScreenSample> => {
  const pcs: RTCPeerConnection[] = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []
  const statsFor = async (track: MediaStreamTrack | undefined) => {
    if (!track) return { receiver: 'none' as const, energy: null, packets: null }
    for (const pc of pcs) {
      let receivers: RTCRtpReceiver[]
      try { receivers = pc.getReceivers() } catch { continue }
      const receiver = receivers.find(r => r.track === track)
      if (!receiver) continue
      if (pc.connectionState === 'closed') return { receiver: 'closed-pc' as const, energy: null, packets: null }
      try {
        const report = await receiver.getStats()
        let energy: number | null = null
        let packets: number | null = null
        report.forEach((s: Record<string, unknown>) => {
          if (s.type !== 'inbound-rtp') return
          energy = typeof s.totalAudioEnergy === 'number' ? s.totalAudioEnergy : energy
          packets = typeof s.packetsReceived === 'number' ? s.packetsReceived : packets
        })
        return { receiver: 'found' as const, energy, packets }
      } catch {
        return { receiver: 'closed-pc' as const, energy: null, packets: null }
      }
    }
    return { receiver: 'missing' as const, energy: null, packets: null }
  }
  const trackState = (t: MediaStreamTrack | undefined) => (t ? `${t.readyState}${t.muted ? ':muted' : ''}${t.enabled ? '' : ':disabled'}` : 'none')
  const tiles: TileSample[] = []
  for (const tile of Array.from(document.querySelectorAll('#room .participant'))) {
    const title = tile.querySelector('h3')?.textContent ?? ''
    if (title.includes('(you)')) continue
    const videos: VideoSample[] = []
    Array.from(tile.querySelectorAll('video')).forEach((video, i) => {
      const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0]
      let spread = 0
      let hash = 0
      if (video.videoWidth && video.videoHeight) {
        const canvas = document.createElement('canvas')
        canvas.width = 64; canvas.height = 48
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(video, 0, 0, 64, 48)
        const data = ctx.getImageData(0, 0, 64, 48).data
        let sum = 0, squares = 0, n = 0
        for (let p = 0; p < data.length; p += 4) {
          const l = data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114
          sum += l; squares += l * l; n++
          hash = (hash * 31 + (l | 0)) >>> 0
        }
        const mean = sum / n
        spread = Math.sqrt(Math.max(0, squares / n - mean * mean))
      }
      videos.push({ i, w: video.videoWidth, spread, hash, time: video.currentTime, paused: video.paused, track: trackState(track) })
    })
    const sounds: SoundSample[] = []
    const audios = Array.from(tile.querySelectorAll('audio'))
    for (let i = 0; i < audios.length; i++) {
      const audio = audios[i]!
      const track = (audio.srcObject as MediaStream | null)?.getAudioTracks()[0]
      const stats = await statsFor(track)
      sounds.push({ i, paused: audio.paused, muted: audio.muted, time: audio.currentTime, track: trackState(track), ...stats })
    }
    tiles.push({ title, videos, sounds })
  }
  // Anything on screen that reads like a way to turn sound on.
  const prompts = Array.from(document.querySelectorAll('button, [role="button"], [role="alert"], [role="status"], .notice, a'))
    .filter(el => (el as HTMLElement).checkVisibility?.() ?? true)
    .map(el => (el.textContent ?? '').trim().replace(/\s+/g, ' '))
    .filter(text => /\b(sound|audio|speaker|unmute|tap to (hear|listen)|enable (sound|audio))\b/i.test(text) && text.length < 120)
  return { tiles, activation: (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? null, prompts }
}

interface Person {
  name: string
  page: Page
  /** Present for a page that must never be handed a user gesture by the
   *  harness. Playwright's own `evaluate` runs with `userGesture: true`,
   *  which grants the page sticky activation and lifts the autoplay policy
   *  the measurement is about. Raw CDP does not. */
  cdp?: CDPSession
  /** Firefox, for reporting. */
  browser?: string
}

async function sample(person: Person): Promise<ScreenSample> {
  if (!person.cdp) return person.page.evaluate(SNAPSHOT)
  const { result, exceptionDetails } = await person.cdp.send('Runtime.evaluate', {
    expression: `(${SNAPSHOT.toString()})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  })
  if (exceptionDetails) throw new Error(`snapshot failed: ${JSON.stringify(exceptionDetails)}`)
  return result.value as ScreenSample
}

interface Cell { see: boolean; hear: boolean; why: string }
type Matrix = Map<string, Cell>
const cellKey = (observer: string, subject: string) => `${observer}<-${subject}`

function judge(before: TileSample | undefined, after: TileSample | undefined): Cell {
  if (!after) return { see: false, hear: false, why: 'no tile' }
  const see = after.videos.some(v => {
    const prev = before?.videos.find(p => p.i === v.i)
    // No spread floor: Firefox's fake camera is a flat colour that changes.
    // A frozen or black frame does not change its hash, which is the test.
    return v.w > 0 && !!prev && prev.hash !== v.hash && v.time > prev.time
  })
  const hear = after.sounds.some(s => {
    const prev = before?.sounds.find(p => p.i === s.i)
    if (!prev || s.paused || s.muted || !s.track.startsWith('live') || s.receiver !== 'found') return false
    // Both Chromium and Firefox report `totalAudioEnergy`. A muted or
    // disabled sender still delivers packets, at ~1e-6 energy a sample gap;
    // a speaking one is 1e-2 and up.
    return s.energy !== null && prev.energy !== null && s.energy - prev.energy > 1e-3
  })
  const v = after.videos.map(x => `v${x.i}[w${x.w} sp${x.spread.toFixed(0)} ${x.paused ? 'paused ' : ''}${x.track}]`).join(' ') || 'no-video'
  const a = after.sounds.map(x => {
    const prev = before?.sounds.find(p => p.i === x.i)
    const dE = x.energy !== null && prev?.energy != null ? (x.energy - prev.energy).toExponential(1) : 'n/a'
    const dP = x.packets !== null && prev?.packets != null ? x.packets - prev.packets : 'n/a'
    return `a${x.i}[${x.paused ? 'paused ' : ''}${x.muted ? 'muted ' : ''}${x.track} rcv:${x.receiver} dE:${dE} dPk:${dP}]`
  }).join(' ') || 'no-audio'
  return { see, hear, why: `${v} ${a}` }
}

async function measure(people: Person[], gapMs = 2500): Promise<{ matrix: Matrix; samples: Map<string, ScreenSample> }> {
  const first = await Promise.all(people.map(p => sample(p).catch(() => undefined)))
  await new Promise(r => setTimeout(r, gapMs))
  const second = await Promise.all(people.map(p => sample(p).catch(() => undefined)))
  const matrix: Matrix = new Map()
  const samples = new Map<string, ScreenSample>()
  people.forEach((observer, index) => {
    if (second[index]) samples.set(observer.name, second[index]!)
    for (const subject of people) {
      if (subject.name === observer.name) continue
      const find = (s: ScreenSample | undefined) => s?.tiles.find(t => t.title.includes(subject.name))
      matrix.set(cellKey(observer.name, subject.name), judge(find(first[index]), find(second[index])))
    }
  })
  return { matrix, samples }
}

function render(people: Person[], matrix: Matrix, want?: Want): string {
  const names = people.map(p => p.name)
  const pad = (s: string) => s.padEnd(6)
  const lines = [`${pad('X \\ Y')}${names.map(pad).join('')}   (cell = X sees Y / X hears Y; lower case = expected but missing)`]
  for (const observer of names) {
    let row = pad(observer)
    for (const subject of names) {
      if (observer === subject) { row += pad('.'); continue }
      const cell = matrix.get(cellKey(observer, subject))!
      const w = want?.(observer, subject) ?? { see: true, hear: true }
      const s = cell.see ? 'S' : w.see ? 's' : '-'
      const h = cell.hear ? 'H' : w.hear ? 'h' : '-'
      row += pad(s + h)
    }
    lines.push(row)
  }
  return lines.join('\n')
}

type Want = (observer: string, subject: string) => { see: boolean; hear: boolean }
const ALL: Want = () => ({ see: true, hear: true })

function dead(people: Person[], matrix: Matrix, want: Want): string[] {
  const out: string[] = []
  for (const o of people) for (const s of people) {
    if (o.name === s.name) continue
    const w = want(o.name, s.name)
    const c = matrix.get(cellKey(o.name, s.name))!
    if ((w.see && !c.see) || (w.hear && !c.hear)) out.push(`${o.name} <- ${s.name}: ${!c.see && w.see ? 'cannot see ' : ''}${!c.hear && w.hear ? 'cannot hear ' : ''}| ${c.why}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// The app's own bug report
// ---------------------------------------------------------------------------

/**
 * The whole report, exactly as the button puts it on somebody's clipboard.
 *
 * Not JSON: it is a JSON object, then the redacted call timeline, then one
 * line per pair. The tail is the part a person actually reads, so a helper
 * that only returned the JSON would be throwing away the half of the report
 * that names the fault.
 */
async function diagnosticsText(person: Person): Promise<string | undefined> {
  if (person.cdp) {
    // Nothing the harness does may hand this page a gesture; the page's
    // report is read off its box only if a person already produced it.
    return undefined
  }
  const page = person.page
  await page.locator('#diagnosticsOut').evaluate(el => { (el as HTMLTextAreaElement).value = '' })
  await page.locator('#diagnostics').dispatchEvent('click')
  await expect.poll(() => page.locator('#diagnosticsOut').inputValue(), { timeout: 10_000 }).not.toBe('')
  return page.locator('#diagnosticsOut').inputValue()
}

/** The report's JSON head. Everything from the timeline marker on is prose
 *  and would make `JSON.parse` throw - which it did, silently, turning every
 *  printed bug report into "report failed". */
function reportJson(text: string): Record<string, unknown> {
  const end = text.indexOf('\n\nCall timeline')
  return JSON.parse(end === -1 ? text : text.slice(0, end)) as Record<string, unknown>
}

async function diagnostics(person: Person): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await diagnosticsText(person)
    return text === undefined ? undefined : reportJson(text)
  } catch (err) {
    return { error: String(err) }
  }
}

/** The part of a report that says why a direction is dead. */
function condense(name: string, report: Record<string, unknown> | undefined): string {
  if (!report) return `${name}: no report`
  if ('error' in report) return `${name}: report failed ${report.error}`
  const me = report.me as { device?: string; publishing?: string[] }
  const conns = (report.connections as { key: string; connectionState: string; iceConnectionState: string; signalingState: string; senders: string[]; receivers: string[]; stats: Record<string, unknown>[] }[])
    .filter(c => c.connectionState !== 'closed')
    .map(c => {
      const inbound = c.stats.filter(s => s.type === 'inbound-rtp').map(s => `${s.kind}:pk${s.packetsReceived ?? 0}`).join(',')
      const outbound = c.stats.filter(s => s.type === 'outbound-rtp').map(s => `${s.kind}:pk${s.packetsSent ?? 0}`).join(',')
      return `    ${c.key} conn=${c.connectionState} ice=${c.iceConnectionState} sig=${c.signalingState} send=[${c.senders.join(' ')}] recv=[${c.receivers.join(' ')}] in=[${inbound}] out=[${outbound}]`
    })
  const closed = (report.connections as { connectionState: string }[]).filter(c => c.connectionState === 'closed').length
  const routes = (report.routes as { device: string; tier: string; connected: boolean; exhausted: boolean }[]).map(r => `${r.device}:${r.tier}${r.connected ? '' : ':unconnected'}${r.exhausted ? ':exhausted' : ''}`).join(' ')
  const participants = (report.participants as { name: string; devices: string[]; tracks: string[]; mic?: string }[]).map(p => `${p.name}{dev ${p.devices.join('/')} tracks ${p.tracks.join(',')} mic ${p.mic ?? '-'}}`).join(' ')
  const sounds = (report.sounds as { device: string; inDocument: boolean; paused: boolean; track: string }[]).map(s => `${s.device}:${s.inDocument ? '' : 'detached:'}${s.paused ? 'paused:' : ''}${s.track}`).join(' ')
  const pictures = (report.pictures as { device: string; onScreen: boolean; paused: boolean; track: string; size: string }[]).map(s => `${s.device}:${s.onScreen ? '' : 'parked:'}${s.paused ? 'paused:' : ''}${s.size}:${s.track}`).join(' ')
  return [
    `  ${name} (device ${me.device}, publishing ${me.publishing?.join(',')})`,
    `    routes: ${routes}`,
    `    roster: ${participants}`,
    `    sounds: ${sounds || 'none'}`,
    `    pictures: ${pictures || 'none'}`,
    `    ${closed} closed connection(s) retained`,
    ...conns,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Waiting for a room to be whole again
// ---------------------------------------------------------------------------

interface Checkpoint { label: string; ok: boolean; ms: number; matrix: string; dead: string[] }

async function waitForMatrix(
  people: Person[],
  label: string,
  timeoutMs: number,
  want: Want = ALL,
  extra?: () => Promise<string>,
): Promise<Checkpoint> {
  const started = Date.now()
  let last: Matrix | undefined
  for (;;) {
    const { matrix } = await measure(people)
    last = matrix
    const missing = dead(people, matrix, want)
    if (missing.length === 0) {
      const cp = { label, ok: true, ms: Date.now() - started, matrix: render(people, matrix, want), dead: [] }
      console.log(`[${label}] whole after ${cp.ms}ms\n${cp.matrix}`)
      if (process.env.CALL_DEBUG) for (const [k, c] of matrix) console.log(`  ${k}: ${c.why}`)
      return cp
    }
    if (Date.now() - started > timeoutMs) break
    await new Promise(r => setTimeout(r, 1000))
  }
  const missing = dead(people, last, want)
  const involved = new Set<string>()
  for (const line of missing) {
    const [o, s] = line.split(':')[0]!.split(' <- ')
    involved.add(o!); involved.add(s!)
  }
  const reports = await Promise.all(people.filter(p => involved.has(p.name)).map(async p => {
    const report = await diagnostics(p)
    if (report) await test.info().attach(`diagnostics-${label}-${p.name}.json`, { body: JSON.stringify(report, null, 1), contentType: 'application/json' })
    const voice = p.cdp ? null : await p.page.locator('#voiceStatus').textContent({ timeout: 2000 }).catch(() => null)
    return `${condense(p.name, report)}\n    voice: ${voice}`
  }))
  const text = [
    `[${label}] NOT whole after ${timeoutMs}ms`,
    render(people, last, want),
    'dead directions:',
    ...missing.map(m => `  ${m}`),
    'bug reports:',
    ...reports,
    extra ? await extra() : '',
  ].join('\n')
  console.log(text)
  await test.info().attach(`matrix-${label}.txt`, { body: text, contentType: 'text/plain' })
  return { label, ok: false, ms: Date.now() - started, matrix: render(people, last, want), dead: missing }
}

function verdict(checkpoints: Checkpoint[]): void {
  const failed = checkpoints.filter(c => !c.ok)
  const summary = checkpoints.map(c => `${c.ok ? 'OK  ' : 'DEAD'} ${c.label} (${c.ms}ms)${c.ok ? '' : `\n${c.matrix}\n${c.dead.map(d => `  ${d}`).join('\n')}`}`).join('\n')
  expect(failed.length, `some directions did not recover:\n${summary}`).toBe(0)
}

// ---------------------------------------------------------------------------
// Driving a person
// ---------------------------------------------------------------------------

/** Effects stay off: every camera start resets to the blur default. */
async function effectsOff(page: Page): Promise<void> {
  await page.locator('#effectModes button[data-mode="off"]').dispatchEvent('click')
}

async function setCamera(page: Page, on: boolean): Promise<void> {
  await openCall(page)
  if ((await page.locator('#toggleCamera').getAttribute('data-on')) !== String(on)) await page.locator('#toggleCamera').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', String(on))
  if (on) await effectsOff(page)
}

async function setMic(page: Page, on: boolean): Promise<void> {
  await openCall(page)
  if ((await page.locator('#toggleMic').getAttribute('data-on')) !== String(on)) await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', String(on))
}

async function setScreen(page: Page, on: boolean): Promise<void> {
  await openCall(page)
  if ((await page.locator('#toggleScreen').getAttribute('data-on')) !== String(on)) await page.locator('#toggleScreen').click()
  await expect(page.locator('#toggleScreen')).toHaveAttribute('data-on', String(on))
}

async function joinAll(browser: Browser, baseURL: string, names: string[], relays?: string[]): Promise<{ people: Person[]; contexts: BrowserContext[]; url: string }> {
  const contexts: BrowserContext[] = []
  const people: Person[] = []
  let url = ''
  for (const name of names) {
    const context = await newDeviceContext(browser, baseURL)
    contexts.push(context)
    const page = await context.newPage()
    if (!url) url = await createRoom(page, baseURL, relays)
    await joinWithMedia(page, url, name)
    await effectsOff(page)
    people.push({ name, page })
  }
  for (const p of people) {
    await expect(p.page.locator('#room .participant'), `${p.name} never saw the whole room`).toHaveCount(names.length, { timeout: 60_000 })
  }
  return { people, contexts, url }
}

// ---------------------------------------------------------------------------
// A relay that loses signalling on command
// ---------------------------------------------------------------------------

interface RelaySocket { socket: number; devices: string[]; subs: number; mode: string; connectedAt: number; closedAt?: number; events: number; oksWithheld: number; ignored: number }

interface FaultRelay {
  url: string
  fault(body: unknown): Promise<void>
  log(): Promise<{ sockets: RelaySocket[]; signals: { ms: number; at: number; socket: number; from: string[]; to: string; size: number; dropped?: string }[] }>
  stop(): Promise<void>
}

async function startFaultRelay(port = FAULT_PORT): Promise<FaultRelay> {
  const script = fileURLToPath(new URL('./fault-relay.mjs', import.meta.url))
  const child = spawn(process.execPath, [script], { env: { ...process.env, RELAY_PORT: String(port) }, stdio: 'ignore' })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const base = `http://127.0.0.1:${port}`
  const started = Date.now()
  for (;;) {
    try { if ((await fetch(`${base}/`)).ok) break } catch { /* not up yet */ }
    if (Date.now() - started > 15_000) { child.kill(); throw new Error('fault relay did not start') }
    await new Promise(r => setTimeout(r, 100))
  }
  return {
    url: `ws://127.0.0.1:${port}`,
    fault: async body => { await fetch(`${base}/fault`, { method: 'POST', body: JSON.stringify(body) }) },
    log: async () => (await fetch(`${base}/log`)).json(),
    stop: () => { child.kill(); return exited },
  }
}

/**
 * A room link that also turns the call signalling profile on or off.
 *
 * The switch is a query parameter and a localStorage key (see
 * `app/src/call-profile.ts`), and it is off by default - so a spec that wants
 * profile 2 has to ask for it, in the link every person in the room opens.
 */
function withCallProfile(url: string, profile: 1 | 2): string {
  const parsed = new URL(url)
  parsed.searchParams.set('callProfile', String(profile))
  return parsed.href
}

/** The device key the newest joiner subscribed for signals as. */
async function newDevice(relay: FaultRelay, known: Set<string>): Promise<string> {
  let found: string | undefined
  await expect.poll(async () => {
    const { sockets } = await relay.log()
    found = sockets.flatMap(s => s.devices).find(d => !known.has(d))
    return found
  }, { timeout: 30_000, message: 'the joiner never subscribed for signals on the fault relay' }).toBeTruthy()
  known.add(found!)
  return found!
}

function signalSummary(signals: Awaited<ReturnType<FaultRelay['log']>>['signals'], devices: Map<string, string>, sinceAt: number): string {
  const nameOf = (short: string) => [...devices].find(([, d]) => d.startsWith(short))?.[0] ?? short
  return signals.filter(s => s.at >= sinceAt).map(s =>
    `  +${s.at - sinceAt}ms ${s.from.map(nameOf).join('/') || '?'} -> ${nameOf(s.to)} ${s.size > 1500 ? 'SDP' : 'ice/small'}(${s.size})${s.dropped ? ` DROPPED(${s.dropped})` : ''}`,
  ).join('\n')
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const FOUR = ['Ada', 'Bob', 'Cara', 'Dan']

// Tracing off for the whole file: Playwright's trace snapshotter evaluates in
// every page with `userGesture: true`, which hands the page sticky activation
// and makes a blocked autoplay impossible to observe. (`use({ trace })` cannot
// be scoped to one describe.) The evidence these cases need is printed.
test.use({ trace: 'off' })

test.describe('call stability', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'drives Chromium fake media; launches Firefox itself where needed')

  test('baseline: four people, all twelve directions see and hear', async ({ browser, baseURL }) => {
    test.setTimeout(300_000)
    const { people, contexts } = await joinAll(browser, baseURL!, FOUR)
    try {
      verdict([await waitForMatrix(people, 'baseline', 90_000)])
    } finally {
      for (const c of contexts) await c.close()
    }
  })

  test('mid-call toggles: every direction recovers after camera, mic and share changes', async ({ browser, baseURL }) => {
    test.setTimeout(600_000)
    const BOUND = 20_000
    const { people, contexts } = await joinAll(browser, baseURL!, FOUR)
    const [A, B, C] = people as [Person, Person, Person, Person]
    const checkpoints: Checkpoint[] = []
    try {
      const base = await waitForMatrix(people, 'baseline', 90_000)
      expect(base.ok, 'the room never came up whole, so nothing after it means anything').toBe(true)

      await setCamera(A.page, false)
      checkpoints.push(await waitForMatrix(people, 'A camera off', BOUND, (o, s) => ({ see: s !== 'Ada', hear: true })))
      await setCamera(A.page, true)
      checkpoints.push(await waitForMatrix(people, 'A camera on again', BOUND))

      await setMic(A.page, false)
      checkpoints.push(await waitForMatrix(people, 'A mic off', BOUND, (o, s) => ({ see: true, hear: s !== 'Ada' })))
      await setMic(A.page, true)
      checkpoints.push(await waitForMatrix(people, 'A mic on again', BOUND))

      await setScreen(B.page, true)
      checkpoints.push(await waitForMatrix(people, 'B sharing', BOUND))
      await setScreen(B.page, false)
      checkpoints.push(await waitForMatrix(people, 'B stopped sharing', BOUND))

      await setCamera(C.page, false)
      checkpoints.push(await waitForMatrix(people, 'C camera off', BOUND, (o, s) => ({ see: s !== 'Cara', hear: true })))
      await setCamera(C.page, true)
      checkpoints.push(await waitForMatrix(people, 'C camera on again', BOUND))

      verdict(checkpoints)
    } finally {
      for (const c of contexts) await c.close()
    }
  })

  /**
   * Signalling is lost for twelve seconds while one person toggles their
   * camera and microphone, and then comes back.
   *
   * The reproduction that started all of this. On profile 1 the offer and its
   * two re-sends all fall inside the window, and nothing re-sends after it:
   * the others never see Ada again for the rest of the call. Run on both
   * profiles deliberately - the legacy path has its own hardening and must
   * keep passing, and the new one must not merely pass differently.
   */
  async function signallingLostFor(
    browser: Browser,
    baseURL: string,
    callProfile: 1 | 2,
  ): Promise<void> {
    const relay = await startFaultRelay()
    const devices = new Map<string, string>()
    const known = new Set<string>()
    const contexts: BrowserContext[] = []
    const people: Person[] = []
    try {
      let url = ''
      for (const name of FOUR) {
        const context = await newDeviceContext(browser, baseURL)
        contexts.push(context)
        const page = await context.newPage()
        if (!url) url = withCallProfile(await createRoom(page, baseURL, [relay.url]), callProfile)
        await joinWithMedia(page, url, name)
        await effectsOff(page)
        devices.set(name, await newDevice(relay, known))
        people.push({ name, page })
      }
      const [A] = people as [Person]
      const base = await waitForMatrix(people, `baseline (profile ${callProfile})`, 90_000)
      expect(base.ok, 'the room never came up whole, so nothing after it means anything').toBe(true)

      // A test that quietly ran on profile 1 either way would prove nothing
      // about the profile it is named after.
      const report = await diagnosticsText(A)
      expect(reportJson(report!).me, `Ada is not on call profile ${callProfile}`).toMatchObject({ callProfile })
      if (callProfile === 2) {
        expect(report, 'no pair reached profile 2, so the far ends never agreed to it').toContain('profile2(')
      }

      const since = Date.now()
      await relay.fault({ dropKinds: [SIGNAL_WRAP] })
      await setCamera(A.page, false)
      await PAUSE(A.page, 3000)
      await setCamera(A.page, true)
      await setMic(A.page, false)
      await setMic(A.page, true)
      // Longer than an offer and both of its re-sends (3 s apart).
      await PAUSE(A.page, 12_000 - (Date.now() - since))
      await relay.fault({ dropKinds: [] })
      const restored = Date.now()

      const cp = await waitForMatrix(people, `after signalling window (profile ${callProfile})`, 30_000, ALL, async () =>
        `relay signal log (from start of window; restored at +${restored - since}ms):\n${signalSummary((await relay.log()).signals, devices, since)}`)

      // The report for the reproduced case, whichever way it went: it is the
      // evidence a fix has to change, and on a green run it is what proves
      // the pair lines say something worth reading.
      const after = await diagnosticsText(A)
      if (after) await test.info().attach(`report-profile${callProfile}-after-window.txt`, { body: after, contentType: 'text/plain' })
      console.log(`[profile ${callProfile}] Ada's per-pair summary after the window:\n${after?.slice(after.indexOf('Per-pair summary:')) ?? 'none'}`)

      verdict([cp])
    } finally {
      for (const c of contexts) await c.close()
      await relay.stop()
    }
  }

  test('signalling lost for a window after connect: every direction recovers once it is back', async ({ browser, baseURL }) => {
    test.setTimeout(600_000)
    await signallingLostFor(browser, baseURL!, 1)
  })

  test('signalling lost for a window after connect: every direction recovers once it is back, on call profile 2', async ({ browser, baseURL }) => {
    test.setTimeout(600_000)
    await signallingLostFor(browser, baseURL!, 2)
  })

  test('signalling: exactly one answer lost after a camera toggle', async ({ browser, baseURL }) => {
    test.setTimeout(600_000)
    const relay = await startFaultRelay()
    const devices = new Map<string, string>()
    const known = new Set<string>()
    const contexts: BrowserContext[] = []
    const people: Person[] = []
    const checkpoints: Checkpoint[] = []
    try {
      let url = ''
      for (const name of FOUR) {
        const context = await newDeviceContext(browser, baseURL!)
        contexts.push(context)
        const page = await context.newPage()
        if (!url) url = await createRoom(page, baseURL!, [relay.url])
        await joinWithMedia(page, url, name)
        await effectsOff(page)
        devices.set(name, await newDevice(relay, known))
        people.push({ name, page })
      }
      const [A] = people as [Person]
      const base = await waitForMatrix(people, 'baseline', 90_000)
      expect(base.ok, 'the room never came up whole, so nothing after it means anything').toBe(true)

      const log = async (since: number) => `relay signal log:\n${signalSummary((await relay.log()).signals, devices, since)}`

      // A turns the camera off: A offers to everybody; Bob's answer is lost.
      let since = Date.now()
      await relay.fault({ dropNext: { to: devices.get('Ada'), from: devices.get('Bob'), count: 1 } })
      await setCamera(A.page, false)
      checkpoints.push(await waitForMatrix(people, 'one answer lost on A camera off', 30_000, (o, s) => ({ see: s !== 'Ada', hear: true }), () => log(since)))

      since = Date.now()
      await relay.fault({ dropNext: { to: devices.get('Ada'), from: devices.get('Bob'), count: 1 } })
      await setCamera(A.page, true)
      checkpoints.push(await waitForMatrix(people, 'one answer lost on A camera on', 30_000, ALL, () => log(since)))

      // And the offer's two re-sends as well: three answers in a row.
      since = Date.now()
      await relay.fault({ dropNext: { to: devices.get('Ada'), from: devices.get('Bob'), count: 3 } })
      await setCamera(A.page, false)
      await PAUSE(A.page, 8000)
      await setCamera(A.page, true)
      checkpoints.push(await waitForMatrix(people, 'three answers lost across A camera off/on', 30_000, ALL, () => log(since)))

      verdict(checkpoints)
    } finally {
      for (const c of contexts) await c.close()
      await relay.stop()
    }
  })

  test.describe('autoplay', () => {

    test('autoplay: a joiner in a browser that enforces autoplay hears the room, or is told how to', async ({ browser, baseURL }) => {
      test.setTimeout(600_000)
      // Everything from the suite's launch flags except the one that hides the
      // question: `--autoplay-policy=no-user-gesture-required`.
      const strict = await chromium.launch({
        args: ['--use-fake-device-for-media-stream', '--disable-audio-output', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture', '--auto-select-desktop-capture-source=Entire screen'],
      })
      const contexts: BrowserContext[] = []
      const checkpoints: Checkpoint[] = []
      try {
        const { people, contexts: hosts, url } = await joinAll(browser, baseURL!, ['Ada', 'Bob'])
        contexts.push(...hosts)
        const joinerContext = await newDeviceContext(strict, baseURL!)
        contexts.push(joinerContext)
        const page = await joinerContext.newPage()
        const cdp = await joinerContext.newCDPSession(page)
        const joiner: Person = { name: 'Win', page, cdp }
        const room = [...people, joiner]

        // (a) Clicking in, as a person does, then turning media on.
        await open(page, url, 'Win')
        await page.locator('#join').click()
        await expect(page.locator('#roomArea')).toBeVisible()
        await openCall(page)
        await page.locator('#toggleCamera').click()
        await page.locator('#toggleMic').click()
        await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
        await effectsOff(page)
        const a = await waitForMatrix(room, 'strict autoplay joiner clicked in', 60_000)
        checkpoints.push(a)
        if (!a.ok) {
          const s = await sample(joiner)
          console.log(`joiner prompts visible: ${JSON.stringify(s.prompts)}; activation ${s.activation}`)
        }

        // (b) The update-and-rejoin path: leave the call, store the room
        // intent, reload from inside a click handler (as main.ts does), and let
        // the app join on arrival with no further click. The reload is driven
        // by a button injected over raw CDP, then clicked for real, because
        // that is exactly the gesture the app's own "Leave call and update"
        // click provides - no more, no less.
        await page.locator('#toggleMic').click()
        await page.locator('#toggleCamera').click()
        await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const b = document.createElement('button'); b.id = '__testUpdate'; b.textContent = 'update'
            b.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647'
            b.onclick = () => { sessionStorage.setItem('kithmoot.room-switch.v1', JSON.stringify({ hash: location.hash, account: null, at: Date.now() })); location.reload() }
            document.body.append(b)
          })()`,
          userGesture: false,
        })
        await Promise.all([page.waitForEvent('load'), page.locator('#__testUpdate').click()])
        // From here the joiner's page is measured over raw CDP only.
        await expect.poll(async () => (await cdp.send('Runtime.evaluate', {
          expression: `!document.getElementById('roomArea')?.hidden && document.getElementById('roomArea')?.checkVisibility()`,
          returnByValue: true,
        })).result.value, { timeout: 60_000, message: 'the update path did not rejoin the room without a click' }).toBe(true)
        const noMedia: Want = (_o, s) => (s === 'Win' ? { see: false, hear: false } : { see: true, hear: true })
        const b = await waitForMatrix(room, 'strict autoplay joiner after update-rejoin (no click)', 45_000, noMedia)
        const after = await sample(joiner)
        console.log(`after rejoin: activation=${after.activation} prompts=${JSON.stringify(after.prompts)}`)
        await test.info().attach('rejoin-joiner-sample.json', { body: JSON.stringify(after, null, 1), contentType: 'application/json' })
        const winHears = ['Ada', 'Bob'].every(n => !b.dead.some(d => d.startsWith(`Win <- ${n}`) && d.includes('cannot hear')))
        checkpoints.push({ ...b, ok: b.ok || (!winHears && after.prompts.length > 0), label: `${b.label}${!winHears && after.prompts.length > 0 ? ' (prompt shown)' : ''}` })

        // (c) Control: the same auto-join, in a tab whose documents never had a
        // gesture at all. Chromium carries sticky activation across a
        // same-origin reload, so (b) cannot see a blocked play(); this can,
        // and it is the state of any arrival that joins without a click.
        const controlContext = await newDeviceContext(strict, baseURL!)
        contexts.push(controlContext)
        const cpage = await controlContext.newPage()
        const ccdp = await controlContext.newCDPSession(cpage)
        const evalNoGesture = async (expression: string) => (await ccdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false })).result.value
        const activation = async (step: string) => console.log(`control activation ${step}: ${await evalNoGesture('navigator.userActivation.hasBeenActive').catch(() => 'n/a')}`)
        await cpage.goto(url)
        await activation('after goto')
        await cpage.reload()
        await activation('after reload')
        await expect.poll(() => evalNoGesture(`!!document.getElementById('join') && !document.getElementById('join').disabled && document.getElementById('join').checkVisibility()`), { timeout: 60_000 }).toBe(true)
        await evalNoGesture(`(() => { document.getElementById('displayName').value = 'Wyn'; document.getElementById('displayName').dispatchEvent(new Event('input', { bubbles: true })); sessionStorage.setItem('kithmoot.room-switch.v1', JSON.stringify({ hash: location.hash, account: null, at: Date.now() })) })()`)
        await activation('before auto-join reload')
        await ccdp.send('Page.reload', {})
        await activation('right after auto-join reload')
        await expect.poll(() => evalNoGesture(`!!document.getElementById('roomArea')?.checkVisibility()`), { timeout: 60_000, message: 'the control tab did not auto-join' }).toBe(true)
        await activation('once in the room')
        const control: Person = { name: 'Wyn', page: cpage, cdp: ccdp }
        const c = await waitForMatrix([...people, control], 'strict autoplay control, never a gesture', 45_000, (_o, s) => (s === 'Wyn' ? { see: false, hear: false } : { see: true, hear: true }))
        const cs = await sample(control)
        console.log(`control: activation=${cs.activation} prompts=${JSON.stringify(cs.prompts)} sounds=${JSON.stringify(cs.tiles.map(t => [t.title, t.sounds.map(x => ({ paused: x.paused, muted: x.muted, receiver: x.receiver }))]))}`)
        const wynHears = !c.dead.some(d => d.startsWith('Wyn <-') && d.includes('cannot hear'))
        checkpoints.push({ ...c, ok: c.ok || (!wynHears && cs.prompts.length > 0), label: `${c.label}${!wynHears && cs.prompts.length > 0 ? ' (prompt shown)' : ''}` })

        verdict(checkpoints)
      } finally {
        for (const c of contexts) await c.close()
        await strict.close()
      }
    })
  })

  test('same device key in a second tab: the others still hear that person', async ({ browser, baseURL }) => {
    test.setTimeout(600_000)
    const { people, contexts, url } = await joinAll(browser, baseURL!, ['Ada', 'Bob', 'Cara'])
    const checkpoints: Checkpoint[] = []
    try {
      const base = await waitForMatrix(people, 'baseline', 90_000)
      expect(base.ok, 'the room never came up whole').toBe(true)
      const [A, B, C] = people as [Person, Person, Person]

      // Ada opens the same room link in another tab of the same browser.
      const tab2 = await contexts[0]!.newPage()
      await open(tab2, url, 'Ada')
      await tab2.locator('#join').click()
      await expect(tab2.locator('#roomArea')).toBeVisible()
      console.log(`tab 2 status: ${await tab2.locator('#status').textContent()}`)
      checkpoints.push(await waitForMatrix([A, B, C], 'second tab joined (Ada media in tab 1)', 30_000,
        (o, s) => (o === 'Ada' ? { see: false, hear: false } : { see: true, hear: true })))

      // Ada talks from the tab she is now looking at.
      const tab2Person: Person = { name: 'Ada', page: tab2 }
      await setMic(tab2, true)
      checkpoints.push(await waitForMatrix([tab2Person, B, C], 'Ada mic on in tab 2', 30_000,
        (o, s) => (s === 'Ada' ? { see: false, hear: true } : o === 'Ada' ? { see: false, hear: false } : { see: true, hear: true })))
      verdict(checkpoints)
    } finally {
      for (const c of contexts) await c.close()
    }
  })

  test('Firefox receiver keeps seeing and hearing through camera and mic toggles', async ({ browser, baseURL }) => {
    test.setTimeout(600_000)
    // This case launches Firefox itself whatever project runs it. A machine
    // without Firefox installed skips it by name rather than failing in the
    // first millisecond and reading as a call bug.
    test.skip(!existsSync(firefox.executablePath()), 'Firefox is not installed: npx playwright install firefox')
    const fx = await firefox.launch({
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'permissions.default.camera': 1,
        'permissions.default.microphone': 1,
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
      },
    })
    const contexts: BrowserContext[] = []
    const checkpoints: Checkpoint[] = []
    try {
      const { people, contexts: hosts, url } = await joinAll(browser, baseURL!, ['Ada', 'Bob'])
      contexts.push(...hosts)
      const fxContext = await newDeviceContext(fx, baseURL!)
      contexts.push(fxContext)
      const page = await fxContext.newPage()
      await joinWithMedia(page, url, 'Fox')
      await effectsOff(page)
      const fox: Person = { name: 'Fox', page, browser: 'firefox' }
      const room = [...people, fox]
      const [A] = people as [Person]
      const base = await waitForMatrix(room, 'baseline with Firefox', 90_000)
      checkpoints.push(base)
      expect(base.ok, `Firefox media never came up in this harness:\n${base.matrix}\n${base.dead.join('\n')}`).toBe(true)

      await setCamera(A.page, false)
      checkpoints.push(await waitForMatrix(room, 'A camera off (1)', 20_000, (o, s) => ({ see: s !== 'Ada', hear: true })))
      await setCamera(A.page, true)
      checkpoints.push(await waitForMatrix(room, 'A camera on (1)', 20_000))
      await setCamera(A.page, false)
      checkpoints.push(await waitForMatrix(room, 'A camera off (2)', 20_000, (o, s) => ({ see: s !== 'Ada', hear: true })))
      await setCamera(A.page, true)
      checkpoints.push(await waitForMatrix(room, 'A camera on (2)', 20_000))
      await setMic(A.page, false)
      checkpoints.push(await waitForMatrix(room, 'A mic off', 20_000, (o, s) => ({ see: true, hear: s !== 'Ada' })))
      await setMic(A.page, true)
      checkpoints.push(await waitForMatrix(room, 'A mic on', 20_000))
      verdict(checkpoints)
    } finally {
      for (const c of contexts) await c.close()
      await fx.close()
    }
  })
  // -------------------------------------------------------------------------
  // Case 7: a relay socket that stops answering
  //
  // From the same call: an iPhone joiner (WebKit) saw "every relay rejected
  // the event (... publish timed out ...)" at the door and had to press Join
  // again. Suspected: sockets opened while the door showed went half-open
  // while the person was in another app; `send()` goes into the void, no OK,
  // no reconnect (nostr-tools pinned without enablePing).
  //
  // The relay simulates this per socket without closing TCP: "half-open"
  // reads nothing and writes nothing; "no-ok" processes and forwards but
  // never acknowledges; "no-ok-no-forward" swallows events silently.
  // -------------------------------------------------------------------------

  const socketsSummary = (sockets: RelaySocket[], since: number, names: Map<number, string>) => sockets
    .filter(s => s.connectedAt >= since || (s.closedAt ?? Infinity) >= since)
    .map(s => `  socket ${s.socket} ${names.get(s.socket) ?? '?'} +${s.connectedAt - since}ms${s.closedAt ? ` closed +${s.closedAt - since}ms` : ''} mode=${s.mode} subs=${s.subs} events=${s.events} oksWithheld=${s.oksWithheld} ignored=${s.ignored} devices=${s.devices.map(d => d.slice(0, 8)).join(',')}`)
    .join('\n')

  async function roomAreaVisible(page: Page, timeout: number): Promise<boolean> {
    try { await expect(page.locator('#roomArea')).toBeVisible({ timeout }); return true } catch { return false }
  }

  for (const variant of [
    { mode: 'half-open', target: 'door', restoreAfterMs: undefined },
    { mode: 'no-ok', target: 'door', restoreAfterMs: 10_000 },
    { mode: 'half-open', target: 'join', restoreAfterMs: 10_000 },
    { mode: 'no-ok', target: 'join', restoreAfterMs: 10_000 },
  ] as const) {
    test(`case 7a: relay socket ${variant.mode} at ${variant.target === 'door' ? 'the door (sockets opened before Join)' : 'join (sockets opened after Join)'}${variant.restoreAfterMs ? `, healthy after ${variant.restoreAfterMs / 1000}s` : ', never recovers'}: the joiner gets in without pressing Join again`, async ({ browser, baseURL }) => {
      test.setTimeout(300_000)
      const relay = await startFaultRelay()
      const contexts: BrowserContext[] = []
      const names = new Map<number, string>()
      try {
        const hostContext = await newDeviceContext(browser, baseURL!)
        contexts.push(hostContext)
        const host = await hostContext.newPage()
        const url = await createRoom(host, baseURL!, [relay.url])
        await joinWithMedia(host, url, 'Ada')
        await effectsOff(host)
        for (const s of (await relay.log()).sockets) names.set(s.socket, 'Ada')

        const t0 = Date.now()
        const joinerContext = await newDeviceContext(browser, baseURL!)
        contexts.push(joinerContext)
        const joiner = await joinerContext.newPage()
        // As in production, where a temporary room's relays ARE the default
        // relays: every pool the door opens (rooms list, profiles, bookmarks)
        // goes to the same relay the join will publish to.
        await joiner.addInitScript(u => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: u, read: true, write: true }] })), relay.url)
        await open(joiner, url, 'Jo')
        await PAUSE(joiner, 3000)
        const door = (await relay.log()).sockets.filter(s => !names.has(s.socket))
        for (const s of door) names.set(s.socket, 'Jo(door)')
        console.log(`door opened ${door.length} socket(s) to the room relay before Join was pressed: ${door.map(s => `#${s.socket} subs=${s.subs}`).join(' ')}`)
        test.info().annotations.push({ type: 'door sockets before Join', description: String(door.length) })

        if (variant.target === 'door') {
          await relay.fault({ sockets: door.map(s => s.socket), mode: variant.mode })
        } else {
          await relay.fault({ newSocketMode: variant.mode })
        }
        const pressed = Date.now()
        await joiner.locator('#join').click()
        let restored: number | undefined
        if (variant.restoreAfterMs) {
          const inEarly = await roomAreaVisible(joiner, variant.restoreAfterMs)
          if (variant.target === 'door') await relay.fault({ sockets: door.map(s => s.socket), mode: 'healthy' })
          const affected = (await relay.log()).sockets.filter(s => s.mode !== 'healthy').map(s => s.socket)
          await relay.fault({ newSocketMode: null, sockets: affected, mode: 'healthy' })
          restored = Date.now()
          console.log(`restored at +${restored - pressed}ms after Join; joiner already in: ${inEarly}`)
        }
        const inside = await roomAreaVisible(joiner, 30_000)
        const status = await joiner.locator('#status').textContent()
        const log = await relay.log()
        for (const s of log.sockets) if (!names.has(s.socket)) names.set(s.socket, 'Jo(after Join)')
        const text = [
          `joined without a second press: ${inside} (${Date.now() - pressed}ms after pressing Join${restored ? `, ${Date.now() - restored}ms after restore` : ''})`,
          `status line: ${JSON.stringify(status)}`,
          `join button: visible=${await joiner.locator('#join').isVisible()} enabled=${await joiner.locator('#join').isEnabled().catch(() => false)}`,
          'sockets:',
          socketsSummary(log.sockets, t0, names),
        ].join('\n')
        console.log(text)
        await test.info().attach('case7a.txt', { body: text, contentType: 'text/plain' })
        expect(inside, `the joiner was left at the door:\n${text}`).toBe(true)
        const cp = await waitForMatrix([{ name: 'Ada', page: host }, { name: 'Jo', page: joiner }], 'joiner sees and hears host', 30_000,
          (o) => (o === 'Jo' ? { see: true, hear: true } : { see: false, hear: false }))
        verdict([cp])
      } finally {
        for (const c of contexts) await c.close()
        await relay.stop()
      }
    })
  }

  for (const variant of [
    { mode: 'half-open', windowMs: 15_000 },
    { mode: 'no-ok', windowMs: 15_000 },
    { mode: 'no-ok-no-forward', windowMs: 15_000 },
    { mode: 'half-open', windowMs: undefined },
  ] as const) {
    test(`case 7b: mid-call, one person's relay sockets ${variant.mode}${variant.windowMs ? ` for ${variant.windowMs / 1000}s` : ' for good'} while they toggle camera: every direction recovers`, async ({ browser, baseURL }) => {
      test.setTimeout(420_000)
      const relay = await startFaultRelay()
      const contexts: BrowserContext[] = []
      const people: Person[] = []
      const names = new Map<number, string>()
      const devices = new Map<string, string>()
      const known = new Set<string>()
      try {
        let url = ''
        for (const name of ['Ada', 'Bob', 'Cara']) {
          const context = await newDeviceContext(browser, baseURL!)
          contexts.push(context)
          const page = await context.newPage()
          if (!url) url = await createRoom(page, baseURL!, [relay.url])
          await joinWithMedia(page, url, name)
          await effectsOff(page)
          devices.set(name, await newDevice(relay, known))
          for (const s of (await relay.log()).sockets) if (!names.has(s.socket)) names.set(s.socket, name)
          people.push({ name, page })
        }
        const [A] = people as [Person]
        const base = await waitForMatrix(people, 'baseline', 90_000)
        expect(base.ok, 'the room never came up whole').toBe(true)

        const since = Date.now()
        const adaSockets = (await relay.log()).sockets.filter(s => names.get(s.socket) === 'Ada' && !s.closedAt).map(s => s.socket)
        await relay.fault({ sockets: adaSockets, mode: variant.mode })
        await setCamera(A.page, false)
        await PAUSE(A.page, 3000)
        await setCamera(A.page, true)
        let bound = 60_000
        if (variant.windowMs) {
          await PAUSE(A.page, Math.max(0, variant.windowMs - (Date.now() - since)))
          await relay.fault({ sockets: adaSockets, mode: 'healthy' })
          bound = 30_000
        }
        const cp = await waitForMatrix(people, `after Ada's sockets ${variant.mode}`, bound, ALL, async () => {
          const log = await relay.log()
          for (const s of log.sockets) if (!names.has(s.socket)) names.set(s.socket, 'new')
          return `Ada's faulted sockets: ${adaSockets.join(',')}\nsockets:\n${socketsSummary(log.sockets, since, names)}\nrelay signal log:\n${signalSummary(log.signals, devices, since)}`
        })
        verdict([cp])
      } finally {
        for (const c of contexts) await c.close()
        await relay.stop()
      }
    })
  }
})
