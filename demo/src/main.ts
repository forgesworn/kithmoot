import {
  RoomSession,
  NostrRelayPool,
  generateRoomSecret,
  encodeJoinUrl,
  decodeJoinUrl,
  type ParticipantView,
  type TrackAdvert,
} from '../../src/index.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'

// Relays confirmed live for this room kind during Task 10's verification run.
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
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
// Pairing links
//
// A plain join link (encodeJoinUrl/decodeJoinUrl, from the library) carries
// only the room secret - anyone holding it can join as a new person. A
// pairing link additionally carries the participant secret, hex-encoded,
// under a field the plain join link never sets. Opening it makes the
// opening device the same participant as whoever made the link. This is
// deliberately a demo-only extension of the join URL shape, not a library
// concern: the library's contract is "carry a room secret", not "carry an
// identity".
// ---------------------------------------------------------------------------

interface PairingPayload {
  s: string
  r: string[]
  p: string
}

function encodePairingUrl(
  base: string,
  roomSecret: Uint8Array,
  participantSk: Uint8Array,
  relays: string[],
): string {
  const payload: PairingPayload = {
    s: base64urlnopad.encode(roomSecret),
    r: relays,
    p: bytesToHex(participantSk),
  }
  const encoded = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
  return `${base}#${encoded}`
}

/** Reads the participant secret out of a URL fragment, if it carries one. */
function decodePairingSecret(url: string): Uint8Array | undefined {
  const hash = new URL(url).hash.slice(1)
  if (!hash) return undefined
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlnopad.decode(hash)),
    ) as Partial<PairingPayload>
    return payload.p ? hexToBytes(payload.p) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------

let roomSecret: Uint8Array
let relays: string[] = RELAYS

function joinLinkBase(): string {
  return location.origin + location.pathname
}

/** Reads the room (and, if present, a paired identity) out of the current URL. */
function roomFromLocation(): boolean {
  if (location.hash.length <= 1) return false

  const { secret, relays: hinted } = decodeJoinUrl(location.href)
  roomSecret = secret
  relays = hinted.length ? hinted : RELAYS

  const pairedSk = decodePairingSecret(location.href)
  if (pairedSk) {
    // Adopt the identity, then immediately drop the address bar back to a
    // plain join link so the participant secret does not sit somewhere it
    // could be copied and sent on by accident.
    storeParticipantKey(pairedSk)
    history.replaceState(null, '', encodeJoinUrl(joinLinkBase(), roomSecret, relays))
  }

  return true
}

function startNewRoom(): void {
  roomSecret = generateRoomSecret()
  relays = RELAYS
  history.replaceState(null, '', encodeJoinUrl(joinLinkBase(), roomSecret, relays))
}

function setStatus(message: string): void {
  $('status').textContent = message
}

function showRoomUi(): void {
  $('setup').hidden = true
  $('joinRoles').hidden = false
  $('links').hidden = false
  ;($('shareUrl') as HTMLInputElement).value = encodeJoinUrl(joinLinkBase(), roomSecret, relays)
}

// ---------------------------------------------------------------------------
// Media capture
// ---------------------------------------------------------------------------

async function captureFor(role: string): Promise<{ stream?: MediaStream; tracks: TrackAdvert[] }> {
  if (role === 'camera') {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    return {
      stream,
      tracks: [
        { trackId: 'cam', role: 'camera' },
        { trackId: 'mic', role: 'mic' },
      ],
    }
  }
  if (role === 'screen') {
    // Absent on iOS Safari and unreliable on Android Chrome - which is
    // exactly why the mobile app is native rather than a browser tab.
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error('This browser cannot share a screen. Use a desktop browser instead.')
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    return { stream, tracks: [{ trackId: 'scr', role: 'screen' }] }
  }
  return { tracks: [] }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(views: ParticipantView[], me: string): void {
  const root = $('room')
  root.innerHTML = ''
  for (const view of views) {
    const box = document.createElement('div')
    box.className = 'participant'
    // The claim this demo exists to show: two devices, one border. Anything
    // else in the styling is decoration.
    if (view.devices.length > 1) box.classList.add('linked')

    const heading = document.createElement('h3')
    const short = `${view.participant.slice(0, 12)}…`
    heading.textContent = view.participant === me ? `${short} (you)` : short
    heading.append(` — ${view.devices.length} device${view.devices.length === 1 ? '' : 's'}`)
    if (view.devices.length > 1) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = 'one person'
      heading.append(badge)
    }
    box.append(heading)

    const tracks = document.createElement('div')
    tracks.className = 'tracks'
    for (const track of view.tracks) {
      const chip = document.createElement('span')
      chip.className = 'track'
      const isMic = view.mic === track.device && track.role === 'mic'
      chip.textContent = `${track.role} · ${track.device.slice(0, 8)}…${isMic ? ' · live mic' : ''}`
      tracks.append(chip)
    }
    box.append(tracks)
    root.append(box)
  }
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

async function start(role: string): Promise<void> {
  setStatus('')
  const participantSk = participantKey()
  const me = getPublicKey(participantSk)

  let capture: { stream?: MediaStream; tracks: TrackAdvert[] }
  try {
    capture = await captureFor(role)
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err))
    return
  }

  if (capture.stream) {
    const video = document.createElement('video')
    video.srcObject = capture.stream
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    $('local').append(video)
  }

  const session = new RoomSession({
    transport: new NostrRelayPool(relays),
    secret: roomSecret,
    participantSk,
    deviceSk: generateSecretKey(), // a fresh key per device, per session
  })

  session.onChange((views) => render(views, me))

  const claims = role === 'camera' ? { mic: Math.floor(Date.now() / 1000) } : {}
  try {
    await session.join(capture.tracks, claims)
  } catch (err) {
    // The demo may log; the library never does.
    console.error(err)
    setStatus(err instanceof Error ? err.message : String(err))
    return
  }

  $('joinRoles').hidden = true
  render(session.participants(), me)
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
  pairUrl.value = encodePairingUrl(joinLinkBase(), roomSecret, sk, relays)
  pairUrl.hidden = false
  pairUrl.select()
})

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-role]')) {
  button.addEventListener('click', () => {
    start(button.dataset.role!).catch((err) => {
      console.error(err)
      setStatus(err instanceof Error ? err.message : String(err))
    })
  })
}

if (roomFromLocation()) showRoomUi()
