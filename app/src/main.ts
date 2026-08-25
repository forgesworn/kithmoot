import './style.css'
import { registerSW } from 'virtual:pwa-register'
import {
  RoomSession,
  NostrRelayPool,
  generateRoomSecret,
  deriveRoom,
  encodeJoinUrl,
  decodeJoinUrl,
  createPairingCode,
  hostPairing,
  requestPairing,
  localIdentity,
  sanitiseDisplayName,
  type ParticipantIdentity,
  type DeviceCredential,
  type RoomPolicy,
  type ParticipantView,
  type TrackAdvert,
  type ChatMessage,
} from '../../src/index.js'
import type { PeerFactory, RTCPeerConnectionLike } from '../../src/peer.js'
import { ProfileBook, type Profile } from './profiles.js'
import { login, logout, restoreSession, type SignetSession } from 'signet-login'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'

// autoUpdate: a new build replaces the cached shell in the background and
// takes over on next load - no "a new version is available" prompt to wire
// up, no stale room UI stuck behind a service worker.
registerSW({ immediate: true })

// Relays confirmed live for this room kind. relay.trotters.cc is the
// project's own relay, so it goes first; nos.lol and relay.primal.net are
// third-party fallbacks. relay.damus.io returned 503 during the stage 2
// acceptance run and was dropped from the default list for that reason -
// "no relay is load-bearing" already covers a room carrying a dead relay
// in its hints, but there is no reason to default new rooms to one that is
// currently flaky. Change this list, not code elsewhere, if a relay in it
// goes down again.
const RELAYS = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net']

// The room names its own STUN/TURN, carried in the join URL like the relay
// hints already are - hardcoding an operator's server here is exactly the
// kind of central dependency this project exists to avoid. This is only a
// sensible default for a room that never set its own.
const DEFAULT_ICE_URLS = ['stun:stun.l.google.com:19302']

// A default TURN server is a convenience, never a requirement - the design
// this app follows is that no operator is protocol-mandated. STUN alone
// fails for roughly 20% of real connections (symmetric NAT, CGNAT on
// mobile networks, corporate firewalls, even two devices on the same
// Wi-Fi when the router won't hairpin), and a call has no fallback the way
// a stream falling back to its origin does - it just fails. Once the
// deploy/coturn server (see deploy/README.md) is running, add its
// turn: URL here - e.g. add DEFAULT_TURN_URL to DEFAULT_ICE_URLS above -
// and that becomes the new default for a room that never set its own.
// Never hardcode TURN credentials here: they are time-limited, minted
// per-viewer server-side (src/turn.ts, deploy/turn-credentials.md), not a
// static secret baked into this bundle.
// const DEFAULT_TURN_URL = 'turn:turn.kithmoot.CHANGE_ME.example:3478'

// The minting endpoint for the default TURN server above - see
// server/turn-credentials.mjs and deploy/turn-credentials.md. Unset for
// the same reason DEFAULT_TURN_URL is commented out: this repo ships no
// live default TURN deployment. The two are switched on together, never
// one without the other - a bare DEFAULT_TURN_URL with no endpoint here
// has no way to hand a browser a working credential, and this endpoint
// alone is pointless without a TURN URL to attach the credential to.
// const TURN_CREDENTIAL_ENDPOINT = '/turn' // same-origin path Caddy proxies to the service, per deploy/Caddyfile.kithmoot
const TURN_CREDENTIAL_ENDPOINT: string | undefined = undefined

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
// Two kinds of device, and the difference is the whole security model.
//
// A PRIMARY device holds the participant key - the person, not the endpoint.
// It is generated here and never leaves this browser: no link, no clipboard,
// no relay.
//
// A SECONDARY device holds only its own device key plus a device credential
// the primary issued for it: scoped to one room, with an expiry. It has no
// way to sign for the participant outside that room, and no way at all once
// the credential lapses. Losing a secondary device costs one room for a few
// hours; losing the participant key would cost the whole Nostr identity for
// ever, which is why it is never copied anywhere.
//
// Both are stored hex-encoded via @noble/hashes - never through
// atob/btoa/String.fromCharCode, a known source of silent binary corruption
// in browsers.
//
// TWO WAYS TO BE A PARTICIPANT, and they differ in where the key lives.
//
// A NAME ONLY (the default): the participant key is generated here and kept
// in localStorage, as above. Zero friction - type a name and go - and the
// name is self-asserted, so it is always rendered beside a short pubkey.
//
// SIGN IN WITH NOSTR: the participant key is a real Nostr identity held in
// an external signer - a browser extension, a bunker over NIP-46, Amber on
// Android - reached through signet-login. This is a security improvement,
// not only a feature: on this path there is NO participant secret in
// localStorage at all, so a stolen browser profile yields nothing that can
// sign for the person.
//
// Both satisfy `ParticipantIdentity` (src/identity.ts): a pubkey and an
// async signEvent. Nothing else in the app has to know which one it has,
// because the participant key signs exactly one thing - the device
// credential - and does it once per room.
// ---------------------------------------------------------------------------

const PARTICIPANT_STORAGE_KEY = 'kithmoot.participant'
const DEVICE_STORAGE_KEY = 'kithmoot.device'
const CREDENTIAL_STORAGE_KEY = 'kithmoot.credential'
const NAME_STORAGE_KEY = 'kithmoot.name'

function loadParticipantKey(): Uint8Array | undefined {
  const stored = localStorage.getItem(PARTICIPANT_STORAGE_KEY)
  return stored ? hexToBytes(stored) : undefined
}

function loadCredential(): DeviceCredential | undefined {
  const stored = localStorage.getItem(CREDENTIAL_STORAGE_KEY)
  if (!stored) return undefined
  try {
    return JSON.parse(stored) as DeviceCredential
  } catch {
    return undefined
  }
}

function storeCredential(credential: DeviceCredential): void {
  localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential))
}

function forgetCredential(): void {
  localStorage.removeItem(CREDENTIAL_STORAGE_KEY)
}

/** This device's own key, kept across loads so a credential issued for it
 *  still names us next time the page opens. */
function deviceKey(): Uint8Array {
  const stored = localStorage.getItem(DEVICE_STORAGE_KEY)
  if (stored) return hexToBytes(stored)
  const sk = generateSecretKey()
  localStorage.setItem(DEVICE_STORAGE_KEY, bytesToHex(sk))
  return sk
}

/** The participant key, minting one on first use - but never on a device
 *  that has been paired as somebody's secondary, which would silently turn
 *  it back into a separate person. */
function participantKey(): Uint8Array {
  const existing = loadParticipantKey()
  if (existing) return existing
  if (loadCredential()) throw new Error('this device is paired to another device and has no participant key')
  const sk = generateSecretKey()
  localStorage.setItem(PARTICIPANT_STORAGE_KEY, bytesToHex(sk))
  return sk
}

/** The signed-in Nostr session, when there is one. Held only in memory -
 *  signet-login persists whatever it needs to reconnect (a bunker URI, a
 *  client key), and deliberately never an nsec. */
let nostrSession: SignetSession | undefined

/** What this participant types for themselves. Sanitised on the way in and
 *  again by every reader - see src/display-name.ts. */
let typedName = sanitiseDisplayName(localStorage.getItem(NAME_STORAGE_KEY)) ?? ''

function storeName(name: string): void {
  typedName = sanitiseDisplayName(name) ?? ''
  if (typedName) localStorage.setItem(NAME_STORAGE_KEY, typedName)
  else localStorage.removeItem(NAME_STORAGE_KEY)
}

/**
 * The name this device joins under.
 *
 * A signed-in participant's kind-0 profile name wins when they have one,
 * because it is the name their whole Nostr identity already goes by; the
 * typed name is the fallback, including for somebody signed in with no
 * profile published. Both are self-asserted either way - see
 * `app/src/profiles.ts`.
 */
function joiningName(): string | undefined {
  if (nostrSession) {
    const profile = profiles.get(nostrSession.pubkey)
    if (profile?.name) return profile.name
  }
  return typedName || undefined
}

/**
 * Who this device signs for.
 *
 * The external signer when signed in, otherwise the key in localStorage.
 * Throws on a paired secondary device, which has neither and does not need
 * one - it joins on the credential it was issued.
 */
function currentIdentity(): ParticipantIdentity {
  if (nostrSession) return nostrSession.signer
  return localIdentity(participantKey())
}

/** The pubkey this device would join as, without minting a key to find out -
 *  so the identity line can be shown before anything is committed to. */
function currentParticipant(): string | undefined {
  if (nostrSession) return nostrSession.pubkey
  const existing = loadParticipantKey()
  if (existing) return getPublicKey(existing)
  return undefined
}

async function signInWithNostr(): Promise<void> {
  const session = await login({ appName: 'KithMoot', relayUrls: RELAYS })
  if (!session) return // cancelled or timed out - leave the page as it was

  // An auth-only session proves who somebody is and then cannot sign
  // anything else. That is fine for a site that just wants a login; it is
  // useless here, because the one thing this app needs a participant key
  // for is signing a device credential per room.
  if (!session.signer.capabilities.canSignEvents) {
    await logout(session)
    throw new Error(
      'That sign-in can prove who you are but cannot sign anything afterwards, ' +
        'and a room needs one signature per join. Try an extension or a bunker.',
    )
  }

  nostrSession = session
  profiles.want([session.pubkey])
  renderIdentity()
}

async function signOutOfNostr(): Promise<void> {
  const session = nostrSession
  nostrSession = undefined
  renderIdentity()
  if (session) await logout(session)
}

// ---------------------------------------------------------------------------
// Room and pairing links
//
// A join link carries the room secret, the relay hints and the ICE server
// hints - anyone holding it can join, as a new person.
//
// A pairing link is a join link plus a one-off PAIRING CODE. It does not
// carry an identity and never has anything secret to the person in it. The
// device that opens it generates its own keypair, proves it holds the code
// over the room-key channel, and is issued a room-scoped credential that
// expires. See `src/pairing.ts` for the exchange and why the code is sent as
// a hash rather than in the clear.
//
// The room secret and relay hints are also handled by the library's own
// encodeJoinUrl/decodeJoinUrl (src/room.ts), which we still use for those
// two fields - this only adds the ICE and pairing extras on top, in the same
// fragment, under extra JSON keys the library's decoder simply ignores. This
// is deliberately an app-only extension of the join URL shape, not a
// library concern: the library's contract is "carry a room secret", not
// "carry a STUN list or a pairing code".
// ---------------------------------------------------------------------------

interface RoomUrlPayload {
  s: string
  r: string[]
  i: string[]
  /** The room's admission rule, in the library's own join-URL field. Carried
   *  through every time this app rebuilds a fragment, so opening a gated
   *  link never quietly rewrites the address bar into an ungated one. */
  a?: RoomPolicy
  /** A one-off pairing code. Never a key. */
  c?: string
}

// Only these schemes reach RTCPeerConnection. The room author is already
// trusted with the room key so this is a small hole, but a join link should
// not be able to name anything else at all.
const ICE_SCHEMES = ['stun:', 'stuns:', 'turn:', 'turns:']

// The room's admission rule, read off the join link. Everyone holding the
// link holds the same rule, so members cannot disagree about who belongs -
// see docs/decisions.md. This app has no UI for CREATING a gated room yet;
// it honours, and passes on, one it is handed.
let roomPolicy: RoomPolicy | undefined

function safeIceUrls(urls: string[]): string[] {
  return urls.filter((u) => ICE_SCHEMES.some((scheme) => u.toLowerCase().startsWith(scheme)))
}

function encodePayload(
  secret: Uint8Array,
  relays: string[],
  urls: string[],
  pairingCode?: Uint8Array,
): string {
  const payload: RoomUrlPayload = {
    s: base64urlnopad.encode(secret),
    r: relays,
    i: urls,
  }
  if (roomPolicy) payload.a = roomPolicy
  if (pairingCode) payload.c = bytesToHex(pairingCode)
  return base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
}

function encodeRoomUrl(base: string, secret: Uint8Array, relays: string[], urls: string[]): string {
  return `${base}#${encodePayload(secret, relays, urls)}`
}

function encodePairingUrl(
  base: string,
  secret: Uint8Array,
  relays: string[],
  urls: string[],
  pairingCode: Uint8Array,
): string {
  return `${base}#${encodePayload(secret, relays, urls, pairingCode)}`
}

/** Reads the ICE hints and, if present, the pairing code out of a URL
 *  fragment. Tolerant of a fragment with neither field, or none at all. */
function decodeExtras(url: string): { iceUrls: string[]; pairingCode?: Uint8Array } {
  const hash = new URL(url).hash.slice(1)
  if (!hash) return { iceUrls: DEFAULT_ICE_URLS }
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlnopad.decode(hash)),
    ) as Partial<RoomUrlPayload>
    const hinted = safeIceUrls(payload.i ?? [])
    return {
      iceUrls: hinted.length ? hinted : DEFAULT_ICE_URLS,
      pairingCode: payload.c ? hexToBytes(payload.c) : undefined,
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

// ---------------------------------------------------------------------------
// How a person is shown
//
// Three rules, and they are the whole of it:
//
//   1. A name NEVER stands alone. A short pubkey renders beside it, always,
//      so two people who both typed "Darren" are visibly two people and an
//      impersonation is visible rather than convincing.
//   2. A name is text, never markup. Everything below goes in through
//      `textContent`; nothing here ever touches innerHTML except to empty a
//      container. See src/display-name.ts.
//   3. A published Nostr identity is marked as such, and a typed name is
//      not marked as anything. The anonymous path is the default and the
//      normal way to use this - it is not a lesser one.
// ---------------------------------------------------------------------------

const profiles = new ProfileBook({
  relays: () => relays,
  onChange: () => {
    renderIdentity()
    if (session) {
      render(session.participants(), meParticipant)
      renderChat(session.chat.messages())
    }
  },
})

/** Twelve hex characters is enough to read aloud and to tell two keys apart
 *  at a glance, and short enough to sit on a tile beside a name. */
function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 12)}\u2026`
}

/** The full npub, for a title attribute - somewhere the whole key is
 *  available without it taking a row of its own. */
function npubOf(pubkey: string): string {
  try {
    return npubEncode(pubkey)
  } catch {
    return pubkey
  }
}

interface Shown {
  /** What to call them, or undefined when nobody typed anything. */
  name?: string
  /** Always present. */
  short: string
  npub: string
  picture?: string
  /** True when this key has a kind-0 profile on a relay - which makes it a
   *  published Nostr identity, NOT a verified name. See profiles.ts. */
  nostr: boolean
}

/** Resolve everything a tile or a chat line needs to show one person. */
function shownAs(pubkey: string, asserted?: string): Shown {
  const profile: Profile | undefined = profiles.get(pubkey)
  return {
    name: profile?.name ?? asserted,
    short: shortKey(pubkey),
    npub: npubOf(pubkey),
    picture: profile?.picture,
    nostr: profile !== undefined,
  }
}

/** Build the name-and-key run that identifies one person. Deliberately the
 *  only place that decides what a person looks like, so a tile and a chat
 *  line can never drift apart on it. */
function identityRun(shown: Shown, isSelf: boolean): DocumentFragment {
  const run = document.createDocumentFragment()

  if (shown.name !== undefined) {
    const name = document.createElement('span')
    name.className = 'name'
    // textContent, never innerHTML: this is somebody else's text.
    name.textContent = shown.name
    run.append(name)
  }

  const key = document.createElement('span')
  key.className = 'pubkey'
  key.textContent = shown.short
  key.title = shown.npub
  run.append(key)

  if (shown.nostr) {
    const chip = document.createElement('span')
    chip.className = 'idkind'
    chip.textContent = 'nostr'
    chip.title = 'This key has a Nostr profile. The name comes from it - which is still a name they chose, not a checked one.'
    run.append(chip)
  }

  if (isSelf) run.append(' (you)')
  return run
}

/**
 * The identity line above the room: who this device would join as, shown
 * before anything is committed to.
 */
function renderIdentity(): void {
  const input = $('displayName') as HTMLInputElement
  if (document.activeElement !== input) input.value = typedName

  ;($('signIn') as HTMLButtonElement).hidden = nostrSession !== undefined
  ;($('signOut') as HTMLButtonElement).hidden = nostrSession === undefined

  const line = $('whoami')
  line.textContent = ''

  const name = joiningName()
  const participant = currentParticipant()

  line.append('Joining as ')

  if (participant) {
    line.append(identityRun(shownAs(participant, name), false))
  } else if (name !== undefined) {
    // No key yet, and deliberately so: minting one here would write a
    // secret before the person has done anything, and would be the wrong
    // thing entirely for somebody about to sign in with Nostr instead. The
    // name is still shown, because it is what they just typed.
    const el = document.createElement('span')
    el.className = 'name'
    el.textContent = name
    line.append(el)
  } else {
    line.append('nobody in particular yet')
  }

  const how = document.createElement('span')
  how.className = 'note inline'
  if (loadCredential()) {
    how.textContent = 'This device is paired to another of yours, so it joins as that person.'
  } else if (nostrSession) {
    how.textContent = 'Signed in with Nostr. Your key stays in your signer; this page never holds it.'
  } else if (participant) {
    how.textContent = 'A name only. Anyone can type any name, so the key beside it is what identifies you.'
  } else {
    how.textContent =
      'A name only. You get a key of your own the first time you join, and it shows here beside the name.'
  }
  line.append(how)
}

let micTrack: MediaStreamTrack | undefined
let cameraTrack: MediaStreamTrack | undefined
let screenTrack: MediaStreamTrack | undefined

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

/** Reads the room and its ICE hints out of the current URL, and kicks off
 *  the pairing exchange if the link carried a pairing code. */
function roomFromLocation(): boolean {
  if (location.hash.length <= 1) return false

  const { secret, relays: hinted, policy } = decodeJoinUrl(location.href)
  roomSecret = secret
  relays = hinted.length ? hinted : RELAYS
  roomPolicy = policy

  const extras = decodeExtras(location.href)
  iceUrls = extras.iceUrls

  if (extras.pairingCode) {
    // Drop the code out of the address bar first: it is single-use and there
    // is no reason for it to sit somewhere it could be forwarded by accident.
    const code = extras.pairingCode
    history.replaceState(null, '', encodeRoomUrl(joinLinkBase(), roomSecret, relays, iceUrls))
    pairWithPrimary(code).catch((err) => setStatus(describeError(err)))
  }

  return true
}

/**
 * Ask the primary device for a credential and remember it.
 *
 * The participant key is not transferred and never has been: what arrives is
 * a credential for this room that expires, signed by the other device.
 */
async function pairWithPrimary(code: Uint8Array): Promise<void> {
  // Joining before the credential lands would mint a fresh participant key
  // and put this device in the room as a stranger - the exact thing pairing
  // exists to avoid. So the button is held until the exchange settles.
  const joinBtn = $('join') as HTMLButtonElement
  joinBtn.disabled = true
  setStatus('Asking your other device to add this one\u2026')

  const { roomId, roomKey } = deriveRoom(roomSecret)
  const transport = new NostrRelayPool(relays)
  try {
    const credential = await requestPairing({
      transport,
      roomId,
      roomKey,
      code,
      deviceSk: deviceKey(),
    })
    storeCredential(credential)
    setStatus('This device is now part of that person. Join when ready.')
  } finally {
    transport.close()
    joinBtn.disabled = false
  }
}

/** True when `urls` is exactly the built-in default ICE list, rather than
 *  one a room's URL or the room-settings field supplied. Compared by
 *  content, not by reference, so this stays correct even if a future
 *  change stops returning the DEFAULT_ICE_URLS array itself in the
 *  "nothing custom was set" case. This is the gate for whether it is this
 *  app's own default TURN server (and so this app's own credential
 *  endpoint) that is in play, versus a room naming its own ICE servers -
 *  see the design principle at the top of deploy/README.md: the room
 *  names its own STUN/TURN, and an operator's minted credential must
 *  never be attached to a server the room never asked for. */
function isDefaultIceUrls(urls: string[]): boolean {
  return urls.length === DEFAULT_ICE_URLS.length && urls.every((u, i) => u === DEFAULT_ICE_URLS[i])
}

/** Fetches one TURN credential from the configured minting endpoint. A
 *  malformed or slow response is treated the same as no endpoint at all -
 *  callers decide the fallback, this only ever resolves to a usable
 *  RTCIceServer or undefined, never throws past its own timeout. */
async function fetchTurnCredential(endpoint: string): Promise<RTCIceServer | undefined> {
  const controller = new AbortController()
  // A credential endpoint that's down should fail fast, not hold up
  // joining until the browser's own connect timeout - see the "never
  // block joining" note on resolveIceServers below.
  const timeout = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(endpoint, { signal: controller.signal })
    if (!res.ok) return undefined
    const body = (await res.json()) as Partial<{
      urls: string[]
      username: string
      credential: string
    }>
    if (!Array.isArray(body.urls) || body.urls.length === 0 || !body.username || !body.credential) {
      return undefined
    }
    return { urls: body.urls, username: body.username, credential: body.credential }
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Turns the room's ICE URL list into the RTCIceServer list a real
 * RTCPeerConnection gets, fetching a minted TURN credential to attach to
 * the operator's own default TURN server when one is configured and this
 * room is actually using that default (see isDefaultIceUrls).
 *
 * A failed or unreachable credential endpoint must never block joining: a
 * room that only has STUN still works for roughly 80% of real connections
 * (see deploy/README.md), and a call that refuses to start because an
 * optional convenience server had a bad day is a strictly worse outcome
 * than one that just falls back to what already worked before this
 * endpoint existed.
 */
async function resolveIceServers(urls: string[]): Promise<RTCIceServer[]> {
  const base: RTCIceServer[] = urls.map((iceUrl) => ({ urls: iceUrl }))
  if (!TURN_CREDENTIAL_ENDPOINT || !isDefaultIceUrls(urls)) return base

  const turnServer = await fetchTurnCredential(TURN_CREDENTIAL_ENDPOINT)
  return turnServer ? [...base, turnServer] : base
}

function parseIceInput(): string[] {
  const raw = ($('iceServers') as HTMLInputElement).value
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const safe = safeIceUrls(parsed)
  return safe.length ? safe : DEFAULT_ICE_URLS
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
    if (micTrack) publishActiveTracks()
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
      publishActiveTracks()
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
      throw new Error(
        'This browser cannot share a screen. iOS has no way to do it from any browser - ' +
          'use a desktop browser, or the Android app.',
      )
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
      publishActiveTracks()
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

/** Publish this device's whole current set of active tracks. Always the full
 *  set, never just what changed: `Mesh`/`Peer` keep their own per-peer record
 *  of what has already been added to which connection, so re-sending a track
 *  that is already there is a safe no-op, and a device that joins the mesh
 *  after a later toggle still gets everything published before it arrived. */
function publishActiveTracks(): void {
  session?.publishTracks(activeTracks())
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

  // Ask about every key in the room, so anyone with a published Nostr
  // profile is shown as having one. Cheap to repeat - the book only looks
  // up a key it has not seen.
  profiles.want(views.map((v) => v.participant))

  for (const view of views) {
    const box = document.createElement('div')
    box.className = 'participant'
    // The claim this app exists to prove: two devices, one tile. Anything
    // else in the styling is decoration.
    if (view.devices.length > 1) box.classList.add('linked')

    const shown = shownAs(view.participant, view.name)

    const heading = document.createElement('h3')
    if (shown.picture) {
      const avatar = document.createElement('img')
      avatar.className = 'avatar'
      avatar.src = shown.picture
      avatar.alt = ''
      avatar.loading = 'lazy'
      // A picture that will not load must not leave a broken icon sitting
      // where a person's face was supposed to be.
      avatar.addEventListener('error', () => avatar.remove())
      heading.append(avatar)
    }
    heading.append(identityRun(shown, view.participant === me))
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
  profiles.want(messages.map((m) => m.participant))

  for (const m of messages) {
    const p = document.createElement('p')
    const who = document.createElement('span')
    who.className = 'who'
    // The same name-and-key run the tiles use. A line of chat is exactly
    // where a name alone would be most convincing and least checkable, so
    // the short pubkey is here too - and the name on the message is the
    // sender's own claim, carried with it (see ChatMessage.name).
    who.append(identityRun(shownAs(m.participant, m.name), m.participant === meParticipant))
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
    const deviceSk = deviceKey()
    myDeviceId = getPublicKey(deviceSk)
    const credential = loadCredential()

    // The design says the room names its own STUN and TURN - never an
    // operator's default baked into the app - so the ICE list comes from
    // the room's own URL (or the room-settings field when creating one),
    // never a constant here. resolveIceServers only ever adds to that list
    // (a minted credential for this app's own default TURN, if configured
    // and actually in play - see isDefaultIceUrls) and never blocks
    // joining if the credential endpoint is absent or unreachable.
    const resolvedIceServers = await resolveIceServers(iceUrls)

    // A real RTCPeerConnection genuinely has everything RTCPeerConnectionLike
    // needs - its on* handlers just carry the full, specific DOM event type
    // rather than the narrow shape Peer actually reads, which is a sound
    // narrowing at runtime but not something TS's structural checker allows
    // for property-typed callbacks without a cast.
    const factory: PeerFactory = () =>
      new RTCPeerConnection({ iceServers: resolvedIceServers }) as unknown as RTCPeerConnectionLike

    // A paired device joins on its credential alone. Only a device that
    // actually holds the participant key passes one.
    const name = joiningName()
    const s = credential
      ? new RoomSession({
          transport: new NostrRelayPool(relays),
          secret: roomSecret,
          credential,
          deviceSk,
          factory,
          policy: roomPolicy,
          name,
        })
      : new RoomSession({
          transport: new NostrRelayPool(relays),
          secret: roomSecret,
          // A local key or an external signer - the session cannot tell,
          // and does not need to. See src/identity.ts.
          identity: currentIdentity(),
          deviceSk,
          factory,
          policy: roomPolicy,
          name,
        })
    session = s
    meParticipant = s.participant

    s.onChange((views) => render(views, meParticipant))
    s.onRemoteTrack(({ device, track }) => attachRemoteTrack(device, track))

    const tracks: TrackAdvert[] = []
    if (cameraTrack) tracks.push({ trackId: 'cam', role: 'camera' })
    if (micTrack) tracks.push({ trackId: 'mic', role: 'mic' })
    if (screenTrack) tracks.push({ trackId: 'scr', role: 'screen' })
    const claims = micTrack ? { mic: Math.floor(Date.now() / 1000) } : {}

    await s.join(tracks, claims)
    publishActiveTracks()

    s.chat.onChange((messages) => renderChat(messages))
    renderChat(s.chat.messages())

    joinBtn.hidden = true
    $('identity').hidden = true
    $('roomArea').hidden = false
    render(s.participants(), meParticipant)
  } catch (err) {
    session = undefined
    const message = describeError(err)
    if (message.includes('expired')) {
      forgetCredential()
      setStatus('This device\u2019s credential has expired. Ask your other device for a new pairing link.')
    } else {
      setStatus(message)
    }
  } finally {
    joinBtn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('displayName').addEventListener('input', (event) => {
  // Stored as typed, sanitised on the way in. The identity line below the
  // field re-renders as you go, so what other people will see is on screen
  // before you commit to anything.
  storeName((event.target as HTMLInputElement).value)
  renderIdentity()
})

$('signIn').addEventListener('click', () => {
  signInWithNostr().catch((err) => setStatus(describeError(err)))
})

$('signOut').addEventListener('click', () => {
  signOutOfNostr().catch((err) => setStatus(describeError(err)))
})

$('create').addEventListener('click', () => {
  startNewRoom()
  showRoomUi()
})

$('openUrl').addEventListener('click', () => {
  const value = ($('url') as HTMLInputElement).value.trim()
  if (!value) return
  // A join-link box is exactly where somebody pastes a link a stranger sent
  // them, and `location.href = value` would run a javascript: URL in this
  // app's own origin - where the participant key lives.
  let url: URL
  try {
    url = new URL(value, location.href)
  } catch {
    setStatus('That does not look like a join link.')
    return
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    setStatus('A join link must be an http or https address.')
    return
  }
  location.href = url.href
  location.reload()
})

// One pairing host at a time. Open while the link is on screen; closing it
// retires the code, which is the only thing that link is good for.
let pairingHost: { close(): void } | undefined
let pairingTransport: NostrRelayPool | undefined

$('addDevice').addEventListener('click', () => {
  try {
    const identity = currentIdentity()
    pairingHost?.close()
    pairingTransport?.close()

    const code = createPairingCode()
    const { roomId, roomKey } = deriveRoom(roomSecret)
    pairingTransport = new NostrRelayPool(relays)
    pairingHost = hostPairing({
      transport: pairingTransport,
      roomId,
      roomKey,
      code,
      identity,
      deviceSk: deviceKey(),
      approve: (device) =>
        confirm(`Add the device ${device.slice(0, 12)}… to this room as you, for the next 12 hours?`),
      onPaired: (device) => setStatus(`Added ${device.slice(0, 12)}… to this room.`),
    })

    const pairUrl = $('pairUrl') as HTMLInputElement
    pairUrl.value = encodePairingUrl(joinLinkBase(), roomSecret, relays, iceUrls, code)
    pairUrl.hidden = false
    $('copyPair').hidden = false
    $('stopPairing').hidden = false
    pairUrl.select()
    setStatus('Waiting for your other device. Keep this page open.')
  } catch (err) {
    setStatus(describeError(err))
  }
})

$('stopPairing').addEventListener('click', () => {
  pairingHost?.close()
  pairingTransport?.close()
  pairingHost = undefined
  pairingTransport = undefined
  const pairUrl = $('pairUrl') as HTMLInputElement
  pairUrl.value = ''
  pairUrl.hidden = true
  $('copyPair').hidden = true
  $('stopPairing').hidden = true
  setStatus('Pairing link retired.')
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

// Rewrite what is in storage with what a reader would actually see, so a
// name that arrived there by some other route does not sit in raw form.
storeName(typedName)
renderIdentity()

// A signer paired on an earlier visit reconnects itself. Deliberately not
// awaited before the page is usable: a bunker over a relay can take seconds,
// and a name-only join must never wait on it. renderIdentity() runs again
// when it lands.
restoreSession()
  .then((session) => {
    if (!session?.signer.capabilities.canSignEvents) return
    nostrSession = session
    profiles.want([session.pubkey])
    renderIdentity()
  })
  .catch(() => {
    // No stored session, or a signer that is not answering today. Either
    // way this page still works: type a name and join.
  })

// The pubkey we would join as, so the identity line is right before the
// first room is ever opened.
const known = currentParticipant()
if (known) profiles.want([known])
