import './style.css'
import { registerSW } from 'virtual:pwa-register'
import {
  RoomSession,
  NostrRelayPool,
  generateRoomSecret,
  encodeJoinUrl,
  decodeJoinUrl,
  type ParticipantView,
  type TrackAdvert,
  type ChatMessage,
} from '../../src/index.js'
import type { PeerFactory, RTCPeerConnectionLike } from '../../src/peer.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'

// autoUpdate: a new build replaces the cached shell in the background and
// takes over on next load - no "a new version is available" prompt to wire
// up, no stale room UI stuck behind a service worker.
registerSW({ immediate: true })

// Relays confirmed live for this room kind during stage 1's verification run.
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

// The room names its own STUN/TURN, carried in the join URL like the relay
// hints already are - hardcoding an operator's server here is exactly the
// kind of central dependency this project exists to avoid. This is only a
// sensible default for a room that never set its own.
const DEFAULT_ICE_URLS = ['stun:stun.l.google.com:19302']

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function setStatus(message: string): void {
  $('status').textContent = message
  if (message) console.error(message)
}

// ---------------------------------------------------------------------------
// Identity
//
// The participant key is the person, not the device. It lives in
// localStorage, hex-encoded via @noble/hashes - never through
// atob/btoa/String.fromCharCode, which is a known source of silent binary
// corruption in browsers. A pairing link (below) is the only thing that ever
// carries this key to a second device.
// ---------------------------------------------------------------------------

const PARTICIPANT_STORAGE_KEY = 'kithmoot.participant'

function loadParticipantKey(): Uint8Array | undefined {
  const stored = localStorage.getItem(PARTICIPANT_STORAGE_KEY)
  return stored ? hexToBytes(stored) : undefined
}

function storeParticipantKey(sk: Uint8Array): void {
  localStorage.setItem(PARTICIPANT_STORAGE_KEY, bytesToHex(sk))
}

function participantKey(): Uint8Array {
  const existing = loadParticipantKey()
  if (existing) return existing
  const sk = generateSecretKey()
  storeParticipantKey(sk)
  return sk
}

// ---------------------------------------------------------------------------
// Room and pairing links
//
// A plain join link carries the room secret, the relay hints and the ICE
// server hints - anyone holding it can join as a new person. A pairing link
// additionally carries the participant secret, hex-encoded, under a field a
// plain join link never sets. Opening it makes the opening device the same
// participant as whoever made the link.
//
// The room secret and relay hints are also handled by the library's own
// encodeJoinUrl/decodeJoinUrl (src/room.ts), which we still use for those
// two fields - this only adds the ICE and pairing extras on top, in the same
// fragment, under extra JSON keys the library's decoder simply ignores. This
// is deliberately an app-only extension of the join URL shape, not a
// library concern: the library's contract is "carry a room secret", not
// "carry a STUN list or an identity".
// ---------------------------------------------------------------------------

interface RoomUrlPayload {
  s: string
  r: string[]
  i: string[]
  p?: string
}

function encodePayload(
  secret: Uint8Array,
  relays: string[],
  iceUrls: string[],
  participantSk?: Uint8Array,
): string {
  const payload: RoomUrlPayload = {
    s: base64urlnopad.encode(secret),
    r: relays,
    i: iceUrls,
  }
  if (participantSk) payload.p = bytesToHex(participantSk)
  return base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
}

function encodeRoomUrl(base: string, secret: Uint8Array, relays: string[], iceUrls: string[]): string {
  return `${base}#${encodePayload(secret, relays, iceUrls)}`
}

function encodePairingUrl(
  base: string,
  secret: Uint8Array,
  relays: string[],
  iceUrls: string[],
  participantSk: Uint8Array,
): string {
  return `${base}#${encodePayload(secret, relays, iceUrls, participantSk)}`
}

/** Reads the ICE hints and, if present, the paired identity out of a URL
 *  fragment. Tolerant of a fragment with neither field, or none at all. */
function decodeExtras(url: string): { iceUrls: string[]; pairedSk?: Uint8Array } {
  const hash = new URL(url).hash.slice(1)
  if (!hash) return { iceUrls: DEFAULT_ICE_URLS }
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlnopad.decode(hash)),
    ) as Partial<RoomUrlPayload>
    return {
      iceUrls: payload.i?.length ? payload.i : DEFAULT_ICE_URLS,
      pairedSk: payload.p ? hexToBytes(payload.p) : undefined,
    }
  } catch {
    return { iceUrls: DEFAULT_ICE_URLS }
  }
}

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------

let roomSecret: Uint8Array
let relays: string[] = RELAYS
let iceUrls: string[] = DEFAULT_ICE_URLS

let session: RoomSession | undefined
let meParticipant = ''
let myDeviceId = ''

let micTrack: MediaStreamTrack | undefined
let cameraTrack: MediaStreamTrack | undefined
let screenTrack: MediaStreamTrack | undefined

// Tracks already handed to session.publishTracks(), so a later toggle never
// re-sends one. Mesh.publish() calls addTrack() on every peer connection for
// everything it is given, and a real RTCPeerConnection throws if the same
// track is added twice - so every call after the first must carry only what
// is genuinely new. The one thing this does not cover: a device that joins
// the mesh after a later toggle only receives what that toggle sent, not
// everything sent before it (Mesh remembers only the most recent call's
// list for late joiners). Acceptable for now - the acceptance case decides
// mic and camera at join time - but worth fixing in Mesh with idempotent,
// per-peer track bookkeeping before toggles are relied on mid-call.
const publishedTracks = new Set<MediaStreamTrack>()

const localPreviewEls = new Map<'camera' | 'screen', HTMLVideoElement>()
// One persistent <div class="media"> per remote device, holding at most one
// <video> and one <audio>. Kept outside the room grid's own lifecycle and
// re-appended into whichever tile render() builds next, so a live video
// element is never torn down and restarted just because the roster changed.
const deviceMediaEls = new Map<string, HTMLDivElement>()

function joinLinkBase(): string {
  return location.origin + location.pathname
}

function activeTracks(): MediaStreamTrack[] {
  return [micTrack, cameraTrack, screenTrack].filter((t): t is MediaStreamTrack => t !== undefined)
}

/** Reads the room (and, if present, its ICE hints and a paired identity)
 *  out of the current URL. */
function roomFromLocation(): boolean {
  if (location.hash.length <= 1) return false

  const { secret, relays: hinted } = decodeJoinUrl(location.href)
  roomSecret = secret
  relays = hinted.length ? hinted : RELAYS

  const extras = decodeExtras(location.href)
  iceUrls = extras.iceUrls

  if (extras.pairedSk) {
    // Adopt the identity, then immediately drop the address bar back to a
    // plain join link so the participant secret does not sit somewhere it
    // could be copied and sent on by accident.
    storeParticipantKey(extras.pairedSk)
    history.replaceState(null, '', encodeRoomUrl(joinLinkBase(), roomSecret, relays, iceUrls))
  }

  return true
}

function parseIceInput(): string[] {
  const raw = ($('iceServers') as HTMLInputElement).value
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return parsed.length ? parsed : DEFAULT_ICE_URLS
}

function startNewRoom(): void {
  roomSecret = generateRoomSecret()
  relays = RELAYS
  iceUrls = parseIceInput()
  history.replaceState(null, '', encodeRoomUrl(joinLinkBase(), roomSecret, relays, iceUrls))
}

function showRoomUi(): void {
  $('setup').hidden = true
  $('deviceControls').hidden = false
  $('join').hidden = false
  $('links').hidden = false
  ;($('shareUrl') as HTMLInputElement).value = encodeRoomUrl(joinLinkBase(), roomSecret, relays, iceUrls)
}

function copyInput(id: string): void {
  const input = $(id) as HTMLInputElement
  input.hidden = false
  input.select()
  navigator.clipboard?.writeText(input.value).catch(() => {
    document.execCommand('copy')
  })
}

// ---------------------------------------------------------------------------
// Local media - the mic, camera and screen-share toggles
//
// Mic mutes in place (track.enabled), which is instant and asks for no
// fresh permission. Camera and screen stop the underlying track outright:
// that is what actually turns off a laptop's camera light and ends an OS
// screen-share, rather than merely lying about it locally.
// ---------------------------------------------------------------------------

async function toggleMic(): Promise<void> {
  if (!micTrack) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    micTrack = stream.getAudioTracks()[0]
    micTrack?.addEventListener('ended', () => {
      micTrack = undefined
      updateUi()
    })
    if (micTrack) publishNewTracks([micTrack])
  } else {
    micTrack.enabled = !micTrack.enabled
  }
  updateUi()
}

async function toggleCamera(): Promise<void> {
  if (cameraTrack) {
    cameraTrack.stop()
    cameraTrack = undefined
    localPreviewEls.get('camera')?.remove()
    localPreviewEls.delete('camera')
  } else {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    cameraTrack = stream.getVideoTracks()[0]
    if (cameraTrack) {
      cameraTrack.addEventListener('ended', () => {
        cameraTrack = undefined
        localPreviewEls.get('camera')?.remove()
        localPreviewEls.delete('camera')
        updateUi()
      })
      addLocalPreview('camera', cameraTrack)
      publishNewTracks([cameraTrack])
    }
  }
  updateUi()
}

async function toggleScreen(): Promise<void> {
  if (screenTrack) {
    screenTrack.stop()
    screenTrack = undefined
    localPreviewEls.get('screen')?.remove()
    localPreviewEls.delete('screen')
  } else {
    // Absent on iOS Safari and unreliable on Android Chrome - which is
    // exactly why the mobile app is native rather than a browser tab.
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error('This browser cannot share a screen. Use a desktop browser instead.')
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    screenTrack = stream.getVideoTracks()[0]
    if (screenTrack) {
      // Fires when the user stops sharing from the browser's own UI, not
      // ours - the toggle has to notice either way.
      screenTrack.addEventListener('ended', () => {
        screenTrack = undefined
        localPreviewEls.get('screen')?.remove()
        localPreviewEls.delete('screen')
        updateUi()
      })
      addLocalPreview('screen', screenTrack)
      publishNewTracks([screenTrack])
    }
  }
  updateUi()
}

function addLocalPreview(kind: 'camera' | 'screen', track: MediaStreamTrack): void {
  const video = document.createElement('video')
  video.srcObject = new MediaStream([track])
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  $('local').append(video)
  localPreviewEls.set(kind, video)
}

function publishNewTracks(tracks: MediaStreamTrack[]): void {
  if (!session) return
  const fresh = tracks.filter((t) => !publishedTracks.has(t))
  if (fresh.length === 0) return
  for (const t of fresh) publishedTracks.add(t)
  session.publishTracks(fresh)
}

function setToggle(id: string, on: boolean): void {
  $(id).dataset.on = String(on)
}

function updateUi(): void {
  setToggle('toggleMic', !!micTrack?.enabled)
  setToggle('toggleCamera', !!cameraTrack)
  setToggle('toggleScreen', !!screenTrack)
  if (session) {
    render(session.participants(), meParticipant)
  } else {
    $('micIndicator').textContent = micTrack?.enabled ? 'Mic is ready - not in a room yet' : ''
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(views: ParticipantView[], me: string): void {
  const mine = views.find((v) => v.participant === me)

  const micEl = $('micIndicator')
  if (mine?.mic) {
    micEl.textContent = mine.mic === myDeviceId ? 'Mic: this device' : 'Mic: your other device'
    micEl.classList.toggle('mine', mine.mic === myDeviceId)
  } else {
    micEl.textContent = micTrack ? 'Mic: on, not yet claimed' : 'Mic: off'
    micEl.classList.remove('mine')
  }

  const root = $('room')
  root.innerHTML = ''

  for (const view of views) {
    const box = document.createElement('div')
    box.className = 'participant'
    // The claim this app exists to prove: two devices, one tile. Anything
    // else in the styling is decoration.
    if (view.devices.length > 1) box.classList.add('linked')

    const heading = document.createElement('h3')
    const short = `${view.participant.slice(0, 12)}…`
    heading.append(view.participant === me ? `${short} (you)` : short)
    heading.append(` · ${view.devices.length} device${view.devices.length === 1 ? '' : 's'}`)
    if (view.devices.length > 1) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = 'one person'
      heading.append(badge)
    }
    box.append(heading)

    if (view.participant === me) {
      // Our own live media is already in the preview strip above; this
      // tile stays to labels, so the two views of it never disagree.
      box.append(trackChips(view, () => 'own'))
    } else {
      // Remote media: real video/audio wherever we have it, a waiting chip
      // wherever we do not (still negotiating, or never advertised).
      for (const device of view.devices) {
        const mediaEl = deviceMediaEls.get(device)
        if (mediaEl && mediaEl.childElementCount > 0) box.append(mediaEl)
      }
      box.append(
        trackChips(view, (track) => {
          const mediaEl = deviceMediaEls.get(track.device)
          const kind = track.role === 'mic' || track.role === 'screen-audio' ? 'audio' : 'video'
          return mediaEl?.querySelector(kind) ? 'live' : 'waiting'
        }),
      )
    }

    root.append(box)
  }
}

/** Builds the chip row for a tile. `status` decides whether a track gets a
 *  chip at all - 'live' tracks already have a real <video>/<audio> element
 *  in the tile, so a chip would just repeat it. */
function trackChips(
  view: ParticipantView,
  status: (track: ParticipantView['tracks'][number]) => 'own' | 'live' | 'waiting',
): HTMLDivElement {
  const chips = document.createElement('div')
  chips.className = 'tracks'
  for (const track of view.tracks) {
    const state = status(track)
    if (state === 'live') continue
    const chip = document.createElement('span')
    chip.className = 'track'
    const isLiveMic = view.mic === track.device && track.role === 'mic'
    chip.textContent =
      state === 'waiting' ? `${track.role} · connecting…` : `${track.role}${isLiveMic ? ' · live mic' : ''}`
    chips.append(chip)
  }
  return chips
}

function renderChat(messages: ChatMessage[]): void {
  const log = $('chatLog')
  log.innerHTML = ''
  for (const m of messages) {
    const p = document.createElement('p')
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = m.participant === meParticipant ? 'you' : `${m.participant.slice(0, 8)}…`
    p.append(who, m.text)
    log.append(p)
  }
  log.scrollTop = log.scrollHeight
}

function attachRemoteTrack(device: string, track: MediaStreamTrack): void {
  let mediaEl = deviceMediaEls.get(device)
  if (!mediaEl) {
    mediaEl = document.createElement('div')
    mediaEl.className = 'media'
    deviceMediaEls.set(device, mediaEl)
  }

  const tag = track.kind === 'video' ? 'video' : 'audio'
  let el = mediaEl.querySelector<HTMLMediaElement>(tag)
  if (!el) {
    el = document.createElement(tag) as HTMLMediaElement
    el.autoplay = true
    if (el instanceof HTMLVideoElement) el.playsInline = true
    mediaEl.append(el)
  }
  el.srcObject = new MediaStream([track])

  track.addEventListener('ended', () => {
    el?.remove()
  })

  if (session) render(session.participants(), meParticipant)
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

async function startSession(): Promise<void> {
  setStatus('')
  const joinBtn = $('join') as HTMLButtonElement
  joinBtn.disabled = true

  try {
    const participantSk = participantKey()
    meParticipant = getPublicKey(participantSk)
    const deviceSk = generateSecretKey()
    myDeviceId = getPublicKey(deviceSk)

    // The design says the room names its own STUN and TURN - never an
    // operator's default baked into the app - so the ICE list comes from
    // the room's own URL (or the room-settings field when creating one),
    // never a constant here.
    // A real RTCPeerConnection genuinely has everything RTCPeerConnectionLike
    // needs - its on* handlers just carry the full, specific DOM event type
    // rather than the narrow shape Peer actually reads, which is a sound
    // narrowing at runtime but not something TS's structural checker allows
    // for property-typed callbacks without a cast.
    const factory: PeerFactory = () =>
      new RTCPeerConnection({ iceServers: iceUrls.map((urls) => ({ urls })) }) as unknown as RTCPeerConnectionLike

    const s = new RoomSession({
      transport: new NostrRelayPool(relays),
      secret: roomSecret,
      participantSk,
      deviceSk,
      factory,
    })
    session = s

    s.onChange((views) => render(views, meParticipant))
    s.onRemoteTrack(({ device, track }) => attachRemoteTrack(device, track))

    const tracks: TrackAdvert[] = []
    if (cameraTrack) tracks.push({ trackId: 'cam', role: 'camera' })
    if (micTrack) tracks.push({ trackId: 'mic', role: 'mic' })
    if (screenTrack) tracks.push({ trackId: 'scr', role: 'screen' })
    const claims = micTrack ? { mic: Math.floor(Date.now() / 1000) } : {}

    await s.join(tracks, claims)
    publishNewTracks(activeTracks())

    s.chat.onChange((messages) => renderChat(messages))
    renderChat(s.chat.messages())

    joinBtn.hidden = true
    $('roomArea').hidden = false
    render(s.participants(), meParticipant)
  } catch (err) {
    session = undefined
    setStatus(describeError(err))
  } finally {
    joinBtn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('create').addEventListener('click', () => {
  startNewRoom()
  showRoomUi()
})

$('openUrl').addEventListener('click', () => {
  const value = ($('url') as HTMLInputElement).value.trim()
  if (!value) return
  location.href = value
  location.reload()
})

$('addDevice').addEventListener('click', () => {
  const sk = participantKey()
  const pairUrl = $('pairUrl') as HTMLInputElement
  pairUrl.value = encodePairingUrl(joinLinkBase(), roomSecret, relays, iceUrls, sk)
  pairUrl.hidden = false
  $('copyPair').hidden = false
  pairUrl.select()
})

$('copyShare').addEventListener('click', () => copyInput('shareUrl'))
$('copyPair').addEventListener('click', () => copyInput('pairUrl'))

$('toggleMic').addEventListener('click', () => {
  toggleMic().catch((err) => setStatus(describeError(err)))
})
$('toggleCamera').addEventListener('click', () => {
  toggleCamera().catch((err) => setStatus(describeError(err)))
})
$('toggleScreen').addEventListener('click', () => {
  toggleScreen().catch((err) => setStatus(describeError(err)))
})

$('join').addEventListener('click', () => {
  startSession().catch((err) => setStatus(describeError(err)))
})

$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('chatInput') as HTMLInputElement
  const text = input.value.trim()
  if (!text || !session) return
  input.value = ''
  session.chat.send(text).catch((err) => setStatus(describeError(err)))
})

if (roomFromLocation()) showRoomUi()
