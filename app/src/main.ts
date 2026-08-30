import './style.css'
import { registerSW } from 'virtual:pwa-register'
import {
  browserDeviceStore,
  deviceKeyFor,
  forgetCredentialFor,
  forgetLegacyStorage,
  isPairedSecondary,
  loadCredentialFor,
  storeCredentialFor,
} from './device-store.js'
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
import type { PeerContext, PeerFactory, RTCPeerConnectionLike } from '../../src/peer.js'
import { ReachabilityProbe } from '../../src/reachability.js'
import { PeerRelay, detectRelayCapability } from '../../src/peer-relay.js'
import {
  ASSIST_STREAMS_PER_PAIR,
  MAX_ASSISTED_PAIRS,
  assistDecision,
  buildAssistOffer,
} from '../../src/peer-assist.js'
import type { AssistBlock, AssistEnvironment } from '../../src/peer-assist.js'
import { UplinkProbe } from '../../src/uplink.js'
import type { StatLike } from '../../src/uplink.js'
import type { AssistOffer } from '../../src/types.js'
import {
  BLUR_ON_BY_DEFAULT,
  DEFAULT_BLUR_STRENGTH,
  type EffectMode,
  type VideoEffectState,
} from '../../src/video-effects.js'
import { DEFAULT_VOICE_PRESET, type VoicePreset } from '../../src/voice-effects.js'
import { BACKGROUNDS, CameraPipeline, type BackgroundChoice } from './video-pipeline.js'
import { MicPipeline, type MicState } from './voice-pipeline.js'
import { ProfileBook, type Profile } from './profiles.js'
import { renderQr } from './qr.js'
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
// a stream falling back to its origin does - it just fails.
//
// The default TURN server's URLs are deliberately NOT listed in
// DEFAULT_ICE_URLS above. They arrive from the minting endpoint below,
// already carrying the credential they need, and resolveIceServers appends
// them. This is not a stylistic choice: a turn: entry with no username and
// credential makes the RTCPeerConnection constructor throw
// InvalidAccessError outright, so a bare turn: URL in that list would not
// degrade to STUN, it would stop the app dead before a single candidate
// was gathered. A turn: URL and its credential are one thing and travel
// together.
//
// Never hardcode TURN credentials here either: they are time-limited,
// minted per-viewer server-side (src/turn.ts, deploy/turn-credentials.md),
// not a static secret baked into this bundle.

// The minting endpoint for this app's own default TURN server - see
// server/turn-credentials.mjs and deploy/turn-credentials.md. A same-origin
// path, reverse-proxied to the service by the vhost in
// deploy/Caddyfile.kithmoot, so it needs no CORS preflight in the normal
// case and no second hostname.
//
// Only ever consulted for a room still on the defaults (see
// isDefaultIceUrls): a room that named its own ICE servers gets those and
// nothing else, because attaching this operator's credential to a server
// the room never asked for would be handing it out to somebody else's
// infrastructure. And if this endpoint is down, joining still works - see
// resolveIceServers, which falls back to plain STUN rather than failing.
const TURN_CREDENTIAL_ENDPOINT: string | undefined = '/turn'

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
const NAME_STORAGE_KEY = 'kithmoot.name'

// Device keys and device credentials are kept PER ROOM - see
// `device-store.ts` for why a relay must never see one device key across
// two rooms. The single shared key this replaces is forgotten on load.
const deviceStore = browserDeviceStore(localStorage)
forgetLegacyStorage(deviceStore)

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** The room this page is in, once a link has been read. Everything a device
 *  keeps is keyed on it; before a room is known there is nothing to keep. */
function currentRoomId(): string | undefined {
  return (roomSecret as Uint8Array | undefined) ? deriveRoom(roomSecret).roomId : undefined
}

function loadParticipantKey(): Uint8Array | undefined {
  const stored = localStorage.getItem(PARTICIPANT_STORAGE_KEY)
  return stored ? hexToBytes(stored) : undefined
}

function loadCredential(): DeviceCredential | undefined {
  const roomId = currentRoomId()
  return roomId ? loadCredentialFor(deviceStore, roomId) : undefined
}

function storeCredential(credential: DeviceCredential): void {
  const roomId = currentRoomId()
  if (!roomId) throw new Error('no room to keep a credential for')
  storeCredentialFor(deviceStore, roomId, credential)
}

function forgetCredential(): void {
  const roomId = currentRoomId()
  if (roomId) forgetCredentialFor(deviceStore, roomId)
}

/** This device's own key for the current room, kept across loads so a
 *  credential issued for it still names us next time the page opens - and
 *  different for every room, so a relay cannot follow one browser from room
 *  to room by the key that signs its roster entries. */
function deviceKey(): Uint8Array {
  const roomId = currentRoomId()
  if (!roomId) throw new Error('no room to hold a device key for')
  return deviceKeyFor(deviceStore, roomId, nowSeconds(), generateSecretKey)
}

/** The participant key, minting one on first use - but never on a device
 *  that has been paired as somebody's secondary, which would silently turn
 *  it back into a separate person. */
function participantKey(): Uint8Array {
  const existing = loadParticipantKey()
  if (existing) return existing
  if (isPairedSecondary(deviceStore)) throw new Error('this device is paired to another device and has no participant key')
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

// The published tracks. Neither the microphone nor the camera track is the
// device: both are the far end of an effect pipeline, so turning blur or
// masking on and off never replaces a track the mesh has already published
// and never renegotiates. See app/src/video-pipeline.ts for why that
// matters more than it sounds like it does.
let micTrack: MediaStreamTrack | undefined
let cameraTrack: MediaStreamTrack | undefined
let screenTrack: MediaStreamTrack | undefined

let camera: CameraPipeline | undefined
let mic: MicPipeline | undefined
let backgroundId = BACKGROUNDS[0]?.id ?? ''
let videoInputs: MediaDeviceInfo[] = []

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

/** An RTCIceServer's `urls` is a string or a list of them. */
function toUrlList(urls: string | string[]): string[] {
  return typeof urls === 'string' ? [urls] : urls
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

// ---------------------------------------------------------------------------
// Peer assist: the room's spare uplink comes from the people in it.
//
// Opt in, never on by default, and never quietly. Relaying spends this
// person's bandwidth and battery on somebody else's call, so the only thing
// that turns it on is them deciding to, and the only defaults here are about
// whether to put the question in front of them at all.
// ---------------------------------------------------------------------------

/** The person's own choice. Opt in, always - see `assistDecision`. */
let assistEnabled = false

/** What this device is carrying for other people, if anything. */
const peerRelay = new PeerRelay()

/** Reachability, measured from the candidates this device actually gathers,
 *  never guessed from a user agent. Fed by every connection the mesh opens. */
const reachability = new ReachabilityProbe()

/** What this device has spare, measured from its own connections - see
 *  `UplinkProbe`. Nothing else in this file invents a bandwidth figure, and
 *  before this has two samples of something the honest answer is "we have not
 *  measured", which `assistDecision` reads as a refusal. */
const uplink = new UplinkProbe()

/** Every connection currently open, so the probe above has something to
 *  sample. Keyed by rung and remote device, because the mesh opens a fresh
 *  connection per rung and the old one lingers until it is closed. */
const openConnections = new Map<string, RTCPeerConnection>()

/** Makes each connection's key its own, so a connection closing can only ever
 *  forget its own measurement. */
let connectionSeq = 0

/** Whether this browser can forward encoded frames without decoding them.
 *  Measured against the objects, not the user agent - see
 *  `detectRelayCapability`. Chromium can; Safari and Firefox expose only
 *  `RTCRtpScriptTransform` and have not been measured carrying a frame
 *  through it, so they are read as unable until somebody has. */
const relayCapability = detectRelayCapability()

/** True when the platform says this is a phone. `navigator.userAgentData` is
 *  a proper API rather than a user-agent string parse, and where it is absent
 *  the honest answer is "we could not tell" - which `assistDecision` reads as
 *  "do not volunteer this by default". */
function formFactor(): AssistEnvironment['formFactor'] {
  const data = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (typeof data?.mobile !== 'boolean') return undefined
  return data.mobile ? 'mobile' : 'desktop'
}

/** True when the connection is metered or the person has asked for data
 *  saving. Undefined where the platform will not say. */
function metered(): boolean | undefined {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; type?: string }
  }).connection
  if (!connection) return undefined
  if (connection.saveData === true) return true
  if (connection.type === 'cellular') return true
  return undefined
}

/** Set from the Battery Status API where it exists. Left undefined where it
 *  does not, which several browsers have removed on privacy grounds. */
let onBattery: boolean | undefined
void (async () => {
  const getBattery = (navigator as Navigator & {
    getBattery?: () => Promise<{ charging: boolean; addEventListener(type: string, cb: () => void): void }>
  }).getBattery
  if (!getBattery) return
  try {
    const battery = await getBattery.call(navigator)
    const read = (): void => {
      onBattery = !battery.charging
      renderAssist()
    }
    read()
    battery.addEventListener('chargingchange', read)
  } catch {
    // No answer is a perfectly good answer here - see `assistDecision`.
  }
})()

function assistEnvironment(): AssistEnvironment {
  return {
    reachability: reachability.reachability,
    canRelay: relayCapability.canForwardFrames,
    capacity: uplink.capacity(),
    formFactor: formFactor(),
    onBattery,
    metered: metered(),
  }
}

function currentAssistOffer(): AssistOffer | null {
  return buildAssistOffer(assistEnvironment(), peerRelay.relaying, assistEnabled)
}

/**
 * Whether to put the question in front of this person at all.
 *
 * A phone on mobile data is the one case where the control is not shown, only
 * explained. `assistDecision` would still permit it - it is their allowance to
 * spend, and the library does not get to refuse on their behalf - but offering
 * somebody a button that bills them by the byte for a stranger's video is not
 * a question worth asking, and a phone that answers it by accident pays for it.
 *
 * Everywhere else the control appears, always off, with whatever is standing
 * against it written underneath. Where a platform will not say whether it is
 * metered or on battery, that is a thing to tell somebody rather than a thing
 * to assume either way.
 */
function assistOfferable(): boolean {
  return !(formFactor() === 'mobile' && metered() === true)
}

// ---------------------------------------------------------------------------
// Saying what it costs, in numbers that were measured
// ---------------------------------------------------------------------------

function bitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return 'nothing'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(bps / 1000)} kbps`
}

function quantity(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  return `${Math.round(bytes / 1000)} kB`
}

/** What one pair costs this device: the pair's media in, and the same back
 *  out again to the far end. */
function costPerPairBps(): number {
  return uplink.capacity().perPeerBps * ASSIST_STREAMS_PER_PAIR
}

/** Whoever is in the room, by device, so a carried pair can be named rather
 *  than shown as two truncated keys. */
function nameOfDevice(device: string): string {
  const target = device.toLowerCase()
  for (const view of session?.participants() ?? []) {
    if (!view.devices.some((d) => d.toLowerCase() === target)) continue
    return shownAs(view.participant, view.name).name ?? shortKey(device)
  }
  return shortKey(device)
}

/** The one sentence that has to be true: what this costs, per person, right
 *  now, from measurements rather than from a table of typical bitrates. */
function costSentence(): string {
  const perPair = costPerPairBps()
  if (perPair <= 0) {
    return 'Nothing has been measured yet. Once there is media moving, this says what a pair would cost in real numbers rather than in typical ones.'
  }
  return (
    `About ${bitrate(perPair)} of your upload for each pair you carry, and the same again coming in. ` +
    `Three pairs at full stretch is about ${bitrate(perPair * MAX_ASSISTED_PAIRS)} up.`
  )
}

/** Why this device is not being recommended, or cannot help at all, in the
 *  order somebody would want to hear it. */
function blockSentence(block: AssistBlock): string {
  switch (block) {
    case 'no-relay-support':
      return 'This browser cannot pass on encoded video without decoding it first, so it cannot carry anybody. Chrome and Edge can. Safari and Firefox have the API but have not been shown to move a frame through it.'
    case 'not-publicly-reachable':
      return 'Nobody behind a home router could reach this device directly, measured from the addresses it gathered. An offer would point at a path that does not exist.'
    case 'no-spare-uplink':
      return uplink.measured()
        ? 'Your connection has nothing left over once your own call is paid for.'
        : 'Your connection has not been measured yet. Join a room, give it a few seconds, and this fills in.'
    case 'mobile':
      return formFactor() === undefined
        ? 'This browser will not say whether it is a phone. If it is, leave this off.'
        : 'This is a phone. Carrying somebody costs it battery and radio for as long as they need it.'
    case 'on-battery':
      return 'Running on battery. Carrying somebody is sustained upload and CPU, and it will show.'
    case 'metered':
      return 'This connection is metered, or you have asked for data saving. Somebody is paying by the byte.'
  }
}

/**
 * The control and the indicator.
 *
 * Called on every render and on every poll tick, so "you are carrying two
 * people" is on screen within a second or two of becoming true rather than
 * whenever something else happened to redraw.
 */
function renderAssist(): void {
  const section = $('assist')
  const button = $('toggleAssist') as HTMLButtonElement
  const indicator = $('assistIndicator')
  const costNote = $('assistCostNote')

  section.hidden = session === undefined
  costNote.textContent = costSentence()

  if (!assistOfferable()) {
    // Not a disabled button: a control that cannot be used is still a control
    // somebody has to work out, and this one is never going to be usable here.
    button.hidden = true
    $('assistCost').hidden = true
    indicator.textContent =
      'Not offered on a phone on mobile data. Carrying somebody would spend your allowance and your battery on their call.'
    indicator.classList.remove('mine')
    return
  }

  button.hidden = false
  $('assistCost').hidden = false

  const decision = assistDecision(assistEnvironment(), assistEnabled)
  const hard = decision.blocks.filter((block) => HARD_ASSIST_BLOCKS.includes(block))
  const soft = decision.blocks.filter((block) => !HARD_ASSIST_BLOCKS.includes(block))

  button.disabled = hard.length > 0 && !assistEnabled
  setToggle('toggleAssist', assistEnabled)
  button.setAttribute('aria-pressed', String(assistEnabled))

  if (hard.length > 0) {
    indicator.textContent = hard.map(blockSentence).join(' ')
    indicator.classList.remove('mine')
    return
  }

  if (!assistEnabled) {
    indicator.textContent = soft.length
      ? soft.map(blockSentence).join(' ')
      : `Your connection has room to carry other people through it. ${costSentence()}`
    indicator.classList.remove('mine')
    return
  }

  const pairs = peerRelay.pairs
  if (pairs.length === 0) {
    indicator.textContent = soft.length
      ? `Offering to carry. Nobody has needed it yet. ${soft.map(blockSentence).join(' ')}`
      : 'Offering to carry. Nobody has needed it yet.'
    indicator.classList.remove('mine')
    return
  }

  // Named rather than counted: "carrying Priya and Sam" is a thing somebody
  // can check against the room in front of them, and a number is not.
  const carried = pairs.map((pair) => `${nameOfDevice(pair.a)} and ${nameOfDevice(pair.b)}`).join(', ')
  const stats = peerRelay.stats
  indicator.textContent =
    `Carrying ${pairs.length} of ${peerRelay.max}: ${carried}. ` +
    `About ${bitrate(costPerPairBps() * pairs.length)} up, ${quantity(stats.bytesOut)} passed on so far.`
  indicator.classList.add('mine')
}

/** Which blocks no amount of willingness can get past. Mirrors the split
 *  `assistDecision` makes, which is not exported as a list. */
const HARD_ASSIST_BLOCKS: readonly AssistBlock[] = ['no-relay-support', 'not-publicly-reachable', 'no-spare-uplink']

/**
 * Sample every open connection, then say what changed.
 *
 * One `getStats()` per connection per tick and nothing else: no probe
 * traffic, no extra sockets. Two seconds is fast enough that the indicator
 * tracks a call somebody is watching, and slow enough to be free.
 */
async function pollAssist(): Promise<void> {
  const now = Date.now()
  for (const [key, pc] of [...openConnections]) {
    if (pc.connectionState === 'closed') {
      openConnections.delete(key)
      uplink.forget(key)
      continue
    }
    try {
      const stats: StatLike[] = []
      ;(await pc.getStats()).forEach((stat) => stats.push(stat as StatLike))
      uplink.update(key, stats, now)
    } catch {
      // A connection that will not answer for its own statistics tells us
      // nothing, which is exactly what it contributes until it does.
    }
  }

  // An offer that has gone stale in either direction is the failure this
  // whole module argues against: advertising a capability that is no longer
  // there, or sitting on one that is. Either way the roster is republished
  // and the relay's own gate is brought back into step with it.
  const offering = currentAssistOffer() !== null
  if (session && offering !== lastOffering) {
    lastOffering = offering
    void session.setAssist(currentAssistOffer).catch(() => {})
  }
  renderAssist()
}

let lastOffering = false
let assistTimer: ReturnType<typeof setInterval> | undefined

function startAssistPolling(): void {
  if (assistTimer !== undefined) return
  assistTimer = setInterval(() => void pollAssist(), 2000)
}

/**
 * Turn carrying on or off.
 *
 * Off is the case that has to work properly. It stops carrying everybody
 * before it stops advertising, so there is no window where the room believes
 * an offer already withdrawn, and the pairs that were being carried fall to
 * the next rung of their own ladder. Nothing about this device's own call
 * changes either way.
 */
async function toggleAssist(): Promise<void> {
  if (!assistOfferable()) return
  assistEnabled = !assistEnabled
  renderAssist()
  try {
    await session?.setAssist(assistEnabled ? currentAssistOffer : null)
    lastOffering = currentAssistOffer() !== null
  } catch (err) {
    setStatus(describeError(err))
  }
  renderAssist()
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
    const pipeline = new MicPipeline({ onStateChange: renderVoiceState })
    try {
      micTrack = await pipeline.start()
    } catch (err) {
      pipeline.stop()
      throw err
    }
    mic = pipeline
    micTrack.addEventListener('ended', () => {
      mic?.stop()
      mic = undefined
      micTrack = undefined
      publishActiveTracks()
      updateUi()
    })
    publishActiveTracks()
    renderVoiceState(pipeline.state)
  } else {
    micTrack.enabled = !micTrack.enabled
  }
  updateUi()
}

async function toggleCamera(): Promise<void> {
  if (camera) {
    camera.stop()
    camera = undefined
    cameraTrack = undefined
    localPreviewEls.get('camera')?.remove()
    localPreviewEls.delete('camera')
    // Turning something off has to be published exactly as loudly as turning
    // it on. Stopping the track locally is invisible to everybody else: a
    // sender left in place sends nothing and says nothing, so the far end
    // holds the last frame it decoded and shows it for the rest of the call.
    // Somebody who turned their camera off was still sitting on the other
    // people's screens, frozen. See Peer#start.
    publishActiveTracks()
  } else {
    const pipeline = new CameraPipeline({
      onStateChange: renderEffectState,
      onSourceEnded: () => {
        camera?.stop()
        camera = undefined
        cameraTrack = undefined
        localPreviewEls.get('camera')?.remove()
        localPreviewEls.delete('camera')
        publishActiveTracks()
        updateUi()
      },
    })
    try {
      cameraTrack = await pipeline.start()
    } catch (err) {
      pipeline.stop()
      throw err
    }
    camera = pipeline
    // The preview shows the CANVAS, not the camera, so what you see is what
    // the room gets - including whatever the effect is or is not managing to
    // do about the wall behind you.
    addLocalPreview('camera', cameraTrack)
    publishActiveTracks()
    renderEffectState(pipeline.status)
    listVideoInputs().catch(() => {
      // A browser that will not enumerate devices without a prior grant just
      // means no switch button. Not worth a status line.
    })
  }
  updateUi()
}

// ---------------------------------------------------------------------------
// Effect controls
//
// Both of these features are easy to mistake for a promise. The camera one
// is a guess that leaks at the edges; the voice one defeats casual
// recognition and nothing more. So the controls report what is actually
// happening rather than what was selected - above all when an effect the
// user believes is on has failed, which is the one state where somebody
// could be publishing a room they think is hidden.
// ---------------------------------------------------------------------------

function revealEffects(id: string, show: boolean): void {
  const details = $(id) as HTMLDetailsElement
  if (show && details.hidden) details.open = true
  details.hidden = !show
}

function markSegmented(containerId: string, attribute: string, value: string): void {
  for (const button of $(containerId).querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-checked', String(button.dataset[attribute] === value))
  }
}

function renderEffectState(state: VideoEffectState): void {
  $('effectMode').textContent = state.mode
  markSegmented('effectModes', 'mode', state.mode)
  // Strength is a blur radius, so it belongs to blur and to nothing else.
  $('strengthRow').hidden = state.mode !== 'blur'
  $('backgroundChoices').hidden = state.mode !== 'replace'

  const line = $('effectStatus')
  line.classList.remove('broken', 'working')
  if (state.mode === 'off') {
    line.textContent = 'The room behind you is going out as it is.'
    line.classList.add('working')
  } else if (state.status === 'degraded') {
    line.textContent = `Background effects are off: ${state.error ?? 'the model would not load'}. Your camera is showing the room.`
    line.classList.add('broken')
  } else if (state.status === 'loading' || state.status === 'idle') {
    line.textContent = 'Loading the background model. Everything is blurred until it arrives.'
    line.classList.add('working')
  } else {
    line.textContent = 'Running.'
    line.classList.add('working')
  }
}

function renderVoiceState(state: MicState): void {
  $('voiceMode').textContent = state.preset
  markSegmented('voicePresets', 'preset', state.preset)
  const line = $('voiceStatus')
  line.classList.remove('broken', 'working')
  if (state.status === 'degraded') {
    line.textContent = `Voice masking is off: ${state.error ?? 'the audio worklet would not load'}. Your own voice is going out.`
    line.classList.add('broken')
    return
  }
  line.classList.add('working')
  line.textContent =
    state.preset === 'off'
      ? 'Your own voice, with nothing added to it.'
      : `Adds ${state.addedLatencyMs.toFixed(0)}ms of delay on top of the ${state.baseLatencyMs.toFixed(0)}ms this browser already costs.`
}

async function listVideoInputs(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  videoInputs = devices.filter((d) => d.kind === 'videoinput')
  // One camera is not a choice. A phone reports its front and back as two
  // devices, so this covers the flip case without a separate control, and a
  // laptop with one webcam simply never sees the button.
  $('switchCamera').hidden = videoInputs.length < 2
}

async function switchCamera(): Promise<void> {
  if (!camera) return
  if (videoInputs.length < 2) await listVideoInputs()
  const current = videoInputs.findIndex((d) => d.deviceId === camera?.deviceId)
  const next = videoInputs[(current + 1) % videoInputs.length]
  if (!next) return
  await camera.useCamera({ deviceId: next.deviceId })
}

function renderBackgroundChoices(): void {
  const box = $('backgroundChoices')
  if (box.childElementCount > 0) return
  for (const choice of BACKGROUNDS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'seg'
    button.dataset.background = choice.id
    button.textContent = choice.label
    button.addEventListener('click', () => {
      chooseBackground(choice).catch((err) => setStatus(describeError(err)))
    })
    box.append(button)
  }
  markSegmented('backgroundChoices', 'background', backgroundId)
}

async function chooseBackground(choice: BackgroundChoice): Promise<void> {
  backgroundId = choice.id
  markSegmented('backgroundChoices', 'background', backgroundId)
  await camera?.setBackground(choice)
}

async function setEffectMode(mode: EffectMode): Promise<void> {
  if (!camera) return
  if (mode === 'replace') {
    const choice = BACKGROUNDS.find((b) => b.id === backgroundId) ?? BACKGROUNDS[0]
    // Loaded before the mode changes, so there is no frame where replace is
    // selected with nothing to replace with. If it fails the effect stays on
    // blur, which shows the room to nobody either way.
    if (choice) await camera.setBackground(choice)
  }
  camera.setMode(mode)
  renderEffectState(camera.status)
}

/** Frame counters and rate, published on the effects panel as data
 *  attributes. A `data-passthrough` above zero while the mode is not `off`
 *  means an unmodified camera frame was published, which is the failure this
 *  whole feature exists to prevent - so it is measured and readable rather
 *  than argued about. */
function publishEffectStats(): void {
  const panel = $('effects')
  if (!camera) {
    panel.removeAttribute('data-fps')
    return
  }
  const totals = camera.totals
  const stats = camera.stats
  panel.dataset.fps = String(stats.fps)
  panel.dataset.frameCostMs = stats.frameCostMs.toFixed(2)
  panel.dataset.passthrough = String(totals.passthrough)
  panel.dataset.blurAll = String(totals['blur-all'])
  panel.dataset.composite = String(totals.composite)
}

setInterval(publishEffectStats, 500)

async function toggleScreen(): Promise<void> {
  if (screenTrack) {
    screenTrack.stop()
    screenTrack = undefined
    localPreviewEls.get('screen')?.remove()
    localPreviewEls.delete('screen')
    // Same as the camera, and worse if it is missed: a screen share nobody
    // was told had stopped stays frozen on everybody else's display.
    publishActiveTracks()
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
        publishActiveTracks()
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
  // A background control with no camera running is a control for nothing.
  // Both open themselves the first time they appear rather than hiding
  // behind a disclosure: blur is on by default, so the control that turns it
  // off has to be visible without hunting for it, and the paragraph saying
  // what neither effect can do is worth as much as the buttons above it.
  revealEffects('cameraEffects', !!camera)
  revealEffects('voiceEffects', !!mic)
  if (camera) renderBackgroundChoices()
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

  renderAssist()

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

/**
 * Every remote video element, live or not, with what it takes to decide
 * which of those it currently is.
 *
 * Kept here rather than looked up in the DOM because a renegotiation hands
 * the same track over again and `ontrack` fires afresh: a DOM lookup finds
 * nothing for an element that has been taken off screen, so it builds a new
 * one and puts the stale picture back.
 */
interface RemoteVideo {
  el: HTMLVideoElement
  container: HTMLDivElement
  track: MediaStreamTrack
  /** `currentTime` at the last check - a picture that is moving is live. */
  last: number
  /** Consecutive checks with no new frame. */
  stalled: number
  /**
   * Whether this picture has ever moved.
   *
   * A picture that has not started is not a picture that has stopped, and
   * the two must not be treated alike. `ontrack` fires when the answer is
   * applied, which is seconds before the first frame is decoded on any real
   * link - DTLS, SRTP and a keyframe all still to come. Judging a
   * just-arrived element by the stall rule gave it about three seconds to
   * produce a frame or be taken off screen, and taking it off screen was
   * what stopped its clock for good (see `parkPicture`). On a slow link, or a
   * machine busy encoding its own blurred camera, that is how a room where
   * everything negotiated perfectly ended up with nobody visible in it.
   */
  played: boolean
}

const remoteVideos = new Map<string, RemoteVideo>()
const remoteAudios = new Map<string, HTMLAudioElement>()

/** How many checks a picture may go without a new frame before it comes off
 *  screen. Two at a one-second interval: long enough not to flicker on a
 *  dropped frame or a slow moment, short enough that "off" looks off. */
const STALLED_CHECKS = 2

/**
 * Where a picture waits while it is off screen.
 *
 * Off everybody's screen, and never out of the document - which are not the
 * same thing, though the code this replaces assumed they were. Chromium runs
 * the internal pause steps on a media element the moment it leaves the
 * document, and a paused element's `currentTime` never advances again: not
 * while it is out, and not when it is put back. So "take it off screen and
 * put it back when it starts moving again" could never fire. Taking it off
 * screen was what stopped the clock it was being judged by, and a picture
 * that went off once was off for the rest of the call.
 *
 * Parked here it keeps decoding and keeps advancing, so "is it moving again"
 * remains a question with an answer. The holder is `display:none`, which
 * pauses nothing: it is out of the room's layout and - the part that
 * matters - out of `#room .participant`, which is what "off everybody else's
 * screen" has to mean.
 */
function parkPicture(el: HTMLVideoElement): void {
  $('parked').append(el)
}

/** Whether this picture is currently on screen, in its own device's tile. */
function onScreen(entry: RemoteVideo): boolean {
  return entry.el.parentElement === entry.container
}

/**
 * Take a picture off screen when it stops moving, and put it back when it
 * starts again.
 *
 * The obvious signal - the track's own `muted` flag - is not trustworthy
 * enough to hang this on. Measured in Chromium: a remote track can arrive
 * `muted`, decode and paint frames perfectly well, and never fire `unmute`
 * at all; gate the picture on that flag and a live participant is invisible.
 * The reverse happens too - a camera switched off before its first frame
 * leaves a track that was muted on arrival and never unmuted, so no `mute`
 * ever fires either and a frozen frame sits on everybody else's screen for
 * the rest of the call.
 *
 * Whether the picture is actually moving has neither problem, and it is also
 * the thing a person in the room is really asking. It only answers honestly
 * for an element that is still in the document, though - see `parkPicture`,
 * which is why one that goes off screen is parked rather than removed - and
 * only for one that has started at all, which is why `played` gates the
 * stall count rather than the clock doing it alone.
 */
function syncRemoteVideos(): void {
  let changed = false
  for (const [key, entry] of remoteVideos) {
    if (entry.track.readyState === 'ended') {
      if (onScreen(entry)) changed = true
      entry.el.remove()
      remoteVideos.delete(key)
      continue
    }
    const now = entry.el.currentTime
    const moving = now > entry.last + 0.001
    entry.last = now
    if (moving) {
      entry.stalled = 0
      entry.played = true
      if (!onScreen(entry)) {
        entry.container.append(entry.el)
        changed = true
      }
      continue
    }
    // Not moving yet is not the same as no longer moving. A picture that has
    // never had a frame is still arriving, and it is given as long as it
    // needs: the tile says so meanwhile, and nothing about it is a lie. Only
    // a picture that ran and stopped is taken off screen.
    if (!entry.played) continue
    if (++entry.stalled >= STALLED_CHECKS && onScreen(entry)) {
      parkPicture(entry.el)
      changed = true
    }
  }
  if (changed && session) render(session.participants(), meParticipant)
}

setInterval(syncRemoteVideos, 1000)

function attachRemoteTrack(device: string, track: MediaStreamTrack): void {
  let mediaEl = deviceMediaEls.get(device)
  if (!mediaEl) {
    mediaEl = document.createElement('div')
    mediaEl.className = 'media'
    deviceMediaEls.set(device, mediaEl)
  }
  const container = mediaEl
  const key = `${device}|${track.id}`

  // One element PER TRACK, not per kind. A device sharing its screen while
  // its camera is on sends two video tracks, and a room where the second one
  // lands on top of the first is a room where turning on a screen share
  // makes your face disappear - which is exactly what it used to do, since
  // the lookup was by tag and the second `srcObject` assignment simply
  // replaced the first. Same for audio: a screen share with sound is a
  // second audio track alongside the mic.
  if (track.kind === 'video') {
    const existing = remoteVideos.get(key)
    const el = existing?.el ?? document.createElement('video')
    el.srcObject = new MediaStream([track])
    if (!existing) {
      el.autoplay = true
      el.playsInline = true
      el.muted = true
      el.dataset.track = track.id
      remoteVideos.set(key, { el, container, track, last: -1, stalled: 0, played: false })
      container.append(el)
      track.addEventListener('ended', () => {
        el.remove()
        remoteVideos.delete(key)
        if (session) render(session.participants(), meParticipant)
      })
    } else if (!onScreen(existing)) {
      // Parked, and the far end is publishing this track again - a
      // renegotiation hands the same track over and `ontrack` fires afresh.
      // Back on screen, with the stall count reset: if it really is still
      // frozen, the next two checks say so and park it again.
      container.append(el)
      existing.stalled = 0
    }
  } else {
    // Audio is never taken off screen for going quiet. A picture that
    // outlives its media is a lie about what the room can see; an `<audio>`
    // element that outlives its media is simply silent - and removing one
    // costs real sound, because a track with no sink is never decoded and
    // reports exactly zero energy, which is how a room with no audio
    // elements at all looked in the first place.
    let el = remoteAudios.get(key)
    if (!el) {
      el = document.createElement('audio')
      el.autoplay = true
      el.dataset.track = track.id
      remoteAudios.set(key, el)
      container.append(el)
      track.addEventListener('ended', () => {
        el?.remove()
        remoteAudios.delete(key)
        if (session) render(session.participants(), meParticipant)
      })
    } else if (!el.isConnected) {
      container.append(el)
    }
    el.srcObject = new MediaStream([track])
  }

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
    //
    // The ICE list is split by rung, which is what actually inverts the
    // selection order. ICE will relay through any TURN server it is given,
    // happily and immediately, so a connection handed the TURN credentials on
    // the first attempt has not "tried direct first" in any sense that costs
    // less - it has simply tried everything at once and taken whatever
    // connected. Keeping TURN out of the list until the mesh asks for the
    // TURN rung is the only way the earlier rungs mean anything.
    const stunOnly = resolvedIceServers.filter(
      (server) => !toUrlList(server.urls).some((url) => url.toLowerCase().startsWith('turn')),
    )
    const factory: PeerFactory = (context?: PeerContext) => {
      const iceServers = context?.tier === 'turn' ? resolvedIceServers : stunOnly
      const pc = new RTCPeerConnection({ iceServers })
      // Every connection contributes to the reachability measurement. It
      // costs nothing - these candidates were gathered anyway - and it is the
      // only honest source for whether this device could carry anybody.
      pc.addEventListener('icecandidate', (event) => {
        if (event.candidate) reachability.add({ candidate: event.candidate.candidate })
      })
      // Registered so the uplink probe has something to sample, under a key
      // unique to this connection rather than to its rung: the mesh opens a
      // fresh connection when it escalates, and the one being replaced lives
      // on until it closes itself.
      const key = `${context?.tier ?? 'direct'}:${context?.remoteDevice ?? 'unknown'}:${++connectionSeq}`
      openConnections.set(key, pc)
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState !== 'closed' && pc.connectionState !== 'failed') return
        openConnections.delete(key)
        uplink.forget(key)
      })
      return pc as unknown as RTCPeerConnectionLike
    }

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
          assist: currentAssistOffer,
          relay: peerRelay,
          // The indicator has to move the moment this device starts or stops
          // carrying somebody, not on the next poll tick.
          onRelayStart: () => renderAssist(),
          onRelayStop: () => renderAssist(),
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
          assist: currentAssistOffer,
          relay: peerRelay,
          // The indicator has to move the moment this device starts or stops
          // carrying somebody, not on the next poll tick.
          onRelayStart: () => renderAssist(),
          onRelayStop: () => renderAssist(),
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
    // The offer starts at whatever the person has already chosen, which is
    // off unless they turned it on before joining.
    lastOffering = currentAssistOffer() !== null
    startAssistPolling()
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
    // Shown immediately, not behind a further click - pairing exists to
    // walk this link over to the other device, and a QR photographed off
    // this screen is the whole point of that trip.
    $('pairQrWrap').hidden = false
    renderQr($('pairQr') as HTMLCanvasElement, pairUrl.value).catch((err) => setStatus(describeError(err)))
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
  $('pairQrWrap').hidden = true
  setStatus('Pairing link retired.')
})

$('copyShare').addEventListener('click', () => copyInput('shareUrl'))
$('copyPair').addEventListener('click', () => copyInput('pairUrl'))

// The join link's QR is rendered lazily, on the first open of its
// disclosure - there is no earlier point at which shareUrl already holds
// its final value and a render would not go to waste.
$('shareQrDetails').addEventListener('toggle', () => {
  if (!($('shareQrDetails') as HTMLDetailsElement).open) return
  const url = ($('shareUrl') as HTMLInputElement).value
  renderQr($('shareQr') as HTMLCanvasElement, url).catch((err) => setStatus(describeError(err)))
})

$('toggleMic').addEventListener('click', () => {
  toggleMic().catch((err) => setStatus(describeError(err)))
})
$('toggleCamera').addEventListener('click', () => {
  toggleCamera().catch((err) => setStatus(describeError(err)))
})
$('toggleScreen').addEventListener('click', () => {
  toggleScreen().catch((err) => setStatus(describeError(err)))
})
$('toggleAssist').addEventListener('click', () => {
  toggleAssist().catch((err) => setStatus(describeError(err)))
})

$('effectModes').addEventListener('click', (event) => {
  const mode = (event.target as HTMLElement).closest('button')?.dataset.mode as EffectMode | undefined
  if (!mode) return
  setEffectMode(mode).catch((err) => setStatus(describeError(err)))
})

$('blurStrength').addEventListener('input', (event) => {
  camera?.setStrength(Number((event.target as HTMLInputElement).value) / 100)
})

$('switchCamera').addEventListener('click', () => {
  switchCamera().catch((err) => setStatus(describeError(err)))
})

$('voicePresets').addEventListener('click', (event) => {
  const preset = (event.target as HTMLElement).closest('button')?.dataset.preset as
    | VoicePreset
    | undefined
  if (!preset || !mic) return
  mic.setPreset(preset)
})

$('voicePreview').addEventListener('click', () => {
  const button = $('voicePreview') as HTMLButtonElement
  const player = $('voicePreviewAudio') as HTMLAudioElement
  if (!mic) return
  button.disabled = true
  button.textContent = 'Listening…'
  mic
    .preview()
    .then((blob) => {
      if (player.src) URL.revokeObjectURL(player.src)
      player.src = URL.createObjectURL(blob)
      player.hidden = false
      return player.play()
    })
    .catch((err) => setStatus(describeError(err)))
    .finally(() => {
      button.disabled = false
      button.textContent = 'Hear yourself'
    })
})

$('join').addEventListener('click', () => {
  startSession().catch((err) => setStatus(describeError(err)))
})

/**
 * Hang up.
 *
 * The session says goodbye - one roster entry marked `left`, which takes
 * this device off everybody else's screen now rather than when its presence
 * lapses - and then the page reloads into the same room link, which is the
 * join screen. A reload rather than a hand-rolled teardown: the camera,
 * microphone, screen, effects, assist poll and every tile all go with it,
 * and a partial teardown that missed one pipeline would leave a camera
 * light on with nobody watching, which is worse than a flicker.
 */
function leaveRoom(): void {
  const s = session
  session = undefined
  s?.leave()
  location.reload()
}

$('leave').addEventListener('click', () => {
  leaveRoom()
})

// A closed tab, a navigation away, or a phone putting the browser to sleep
// is a departure too, and a silent one costs everybody else the whole
// presence timeout. Best effort: the farewell is one small publish over
// sockets that are already open, and the page is gone whatever happens.
window.addEventListener('pagehide', () => {
  session?.leave()
})

$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('chatInput') as HTMLInputElement
  const text = input.value.trim()
  if (!text || !session) return
  input.value = ''
  session.chat.send(text).catch((err) => setStatus(describeError(err)))
})

// The effect controls start where the constants say they start, rather than
// where index.html happens to say they do: BLUR_ON_BY_DEFAULT is a product
// decision and it is meant to be one line to change.
;($('blurStrength') as HTMLInputElement).value = String(Math.round(DEFAULT_BLUR_STRENGTH * 100))
markSegmented('effectModes', 'mode', BLUR_ON_BY_DEFAULT ? 'blur' : 'off')
markSegmented('voicePresets', 'preset', DEFAULT_VOICE_PRESET)
$('effectMode').textContent = BLUR_ON_BY_DEFAULT ? 'blur' : 'off'
$('voiceMode').textContent = DEFAULT_VOICE_PRESET

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
