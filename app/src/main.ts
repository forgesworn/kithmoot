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
import { forgetRoom, knownRooms, markRead, rememberRoom, roomLabel, type KnownRoom } from './rooms-store.js'
import { RoomWatch } from './room-watch.js'
import {
  RoomSession,
  NostrRelayPool,
  generateRoomSecret,
  deriveRoom,
  decodeJoinUrl,
  createRoomInvitation,
  roomInvitation,
  deriveInvitationId,
  hostRoomInvitation,
  requestRoomAdmissionCapability,
  encodeInvitationRetirement,
  createPairingCode,
  hostPairing,
  requestPairing,
  localIdentity,
  sanitiseDisplayName,
  MAX_CHAT_TEXT_LENGTH,
  type ParticipantIdentity,
  type DeviceCredential,
  type RoomPolicy,
  type RoomInvitation,
  type InvitationDelegation,
  type RoomAdmission,
  type ParticipantView,
  type SingularRole,
  type TrackAdvert,
  AGENT_CHANNEL,
  TRANSCRIPT_CHANNEL,
  MINUTES_CHANNEL,
  CONTROL_CHANNEL,
  encodeControl,
  decodeControl,
  verifyAdmins,
  type RekeyNotice,
  type ControlMessage,
  type ChatMessage,
  type ChatAttachment,
  MAX_CHAT_ATTACHMENTS,
  MAX_UPLOAD_SOURCE_BYTES,
  fetchAttachment,
  parseRecoveryKey,
  encryptEnvelope,
  uploadEnvelope,
  buildFileEvent,
  normaliseBlossomServer,
  parseRoomLink,
  type RoomLink,
  type RelayTransport,
  type EncryptedEnvelope,
} from '../../src/index.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { Event as NostrEvent } from 'nostr-tools/pure'
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
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode, decode as nip19Decode } from 'nostr-tools/nip19'
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
/** How often a joined page re-fetches its TURN credential. The credential
 *  service mints for an hour; forty minutes keeps a fresh one in hand. */
const ICE_REFRESH_MS = 40 * 60 * 1000

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

// Where a file dropped into the chat is put, unless this device has been
// told otherwise in the Attach panel. Empty on purpose: the same rule as
// TURN, no operator is protocol-mandated, and Wildbloom itself ships with
// no default server either - it asks. A Blossom server sees an encrypted
// blob and the device key that signed the upload, nothing else, but which
// server sees that is still the person's choice, made once and remembered
// on this device. An operator hosting this app for a community can name
// their own here.
const BLOSSOM_ENDPOINT = ''

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

/** Write the room this page is in down as one this device has been in -
 *  see `app/src/rooms-store.ts`. The link kept is the one this app would
 *  hand on, which never carries a pairing code. */
function rememberCurrentRoom(): void {
  const roomId = currentRoomId()
  if (!roomId) return
  try {
    rememberRoom(deviceStore, {
      roomId,
      name: roomName,
      link: encodeRoomUrl(joinLinkBase(), relays, iceUrls),
      openedAt: nowSeconds(),
    })
  } catch {
    // Storage may be unavailable. The room still opens; it is only the way
    // back to it that goes unwritten.
  }
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
// A v2 join link carries an invitation bearer, a pinned root inviter pubkey,
// and the relay/ICE hints. It deliberately does NOT carry the room traffic
// secret. A holder asks any online delegated member for that secret over the
// encrypted rendezvous in src/invitation.ts, with no account or prompt.
//
// A pairing link is an invitation plus a one-off PAIRING CODE. The device
// first enters through the ordinary invitation rendezvous, then proves it
// holds the pairing code over the room-key channel and receives a
// room-scoped credential. See `src/pairing.ts`.
//
// Legacy v1 links are still accepted during migration. They contain `s`, the
// traffic secret, and decode through src/room.ts. New links are `v: 2` and
// contain `j` (bearer) plus `h` (inviter pubkey) instead. The format stays in
// the fragment, so neither form is sent to this site's HTTP server or a link
// preview fetcher.
// ---------------------------------------------------------------------------

interface RoomUrlPayload {
  /** Version 2 is an invitation. Absence means a legacy room-secret link. */
  v?: 2
  /** Legacy v1 room traffic secret. Never emitted for a new room. */
  s?: string
  /** Version 2 invitation bearer. */
  j?: string
  /** Version 2 inviter pubkey. */
  h?: string
  r: string[]
  i: string[]
  /** The room's admission rule, in the library's own join-URL field. Carried
   *  through every time this app rebuilds a fragment, so opening a gated
   *  link never quietly rewrites the address bar into an ungated one. */
  a?: RoomPolicy
  /** A one-off pairing code. Never a key. */
  c?: string
  /** What the room is called, when whoever made the link named it. A label
   *  for people, sanitised like a display name - see `RoomLink.name`. */
  n?: string
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

// What the room is called, off its link. Carried through every fragment this
// app rebuilds, like the policy, so a rotated or re-shared link keeps it.
let roomName: string | undefined

function safeIceUrls(urls: string[]): string[] {
  return urls.filter((u) => ICE_SCHEMES.some((scheme) => u.toLowerCase().startsWith(scheme)))
}

function encodePayload(relays: string[], urls: string[], pairingCode?: Uint8Array): string {
  const payload: RoomUrlPayload = roomInvitationCapability
    ? {
        v: 2,
        j: base64urlnopad.encode(roomInvitationCapability.bearer),
        h: roomInvitationCapability.inviter,
        r: relays,
        i: urls,
      }
    : { s: base64urlnopad.encode(roomSecret), r: relays, i: urls }
  if (roomPolicy) payload.a = roomPolicy
  if (roomName) payload.n = roomName
  if (pairingCode) payload.c = bytesToHex(pairingCode)
  return base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
}

function encodeRoomUrl(base: string, relays: string[], urls: string[]): string {
  return `${base}#${encodePayload(relays, urls)}`
}

function encodePairingUrl(
  base: string,
  relays: string[],
  urls: string[],
  pairingCode: Uint8Array,
): string {
  return `${base}#${encodePayload(relays, urls, pairingCode)}`
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
    const hinted = safeIceUrls(
      Array.isArray(payload.i) ? payload.i.filter((value): value is string => typeof value === 'string') : [],
    )
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
/** Present for every newly created room. Undefined only for a legacy v1
 * link whose fragment still directly contains the room traffic secret. */
let roomInvitationCapability: RoomInvitation | undefined
let relays: string[] = RELAYS
let iceUrls: string[] = DEFAULT_ICE_URLS

/** The root inviter key on the creator, or this member's delegated responder
 * key after admission. Only an empty delegation chain may rotate the link. */
let invitationAuthoritySk: Uint8Array | undefined
let invitationDelegation: InvitationDelegation[] = []
let invitationHost: { close(): void } | undefined
let invitationTransport: NostrRelayPool | undefined
/**
 * The epoch the responder that admitted this browser said the room is at.
 * A hint for the session, which asks the room's authority before it says
 * anything if the room is ahead of the secret it was handed - see
 * `RoomAdmission.epoch`. Undefined when nobody said.
 */
let expectedEpoch: number | undefined

/** The room's authority: the root inviter pinned in a v2 link. A rekey
 *  signed by it moves this browser to the new epoch; a legacy secret link
 *  has none, and stays where it joined. */
function roomAuthority(): string | undefined {
  return roomInvitationCapability?.inviter
}

const INVITATION_OWNER_PREFIX = 'kithmoot.invitation-owner.v1.'
const ADMISSION_CACHE_PREFIX = 'kithmoot.admission.v1.'
const INVITATION_OWNER_TTL_SECONDS = 12 * 60 * 60

interface StoredInvitationOwner {
  roomSecret: string
  inviterSk: string
  createdAt: number
}

function ownerStorageKey(invitation: RoomInvitation): string {
  return INVITATION_OWNER_PREFIX + deriveInvitationId(invitation)
}

/**
 * Keep the creator able to answer the link after a reload or reopened tab.
 *
 * This is deliberately localStorage rather than putting either secret back
 * in the URL. It expires after the same twelve-hour horizon as a device
 * credential, and rotating the link removes it immediately.
 */
function storeInvitationOwner(invitation: RoomInvitation, room: Uint8Array, hostSk: Uint8Array): void {
  try {
    const value: StoredInvitationOwner = {
      roomSecret: bytesToHex(room),
      inviterSk: bytesToHex(hostSk),
      createdAt: nowSeconds(),
    }
    localStorage.setItem(ownerStorageKey(invitation), JSON.stringify(value))
  } catch {
    // Storage may be unavailable in a locked-down browser. The invitation
    // still works for as long as this page stays open; only reload recovery
    // is lost.
  }
}

function loadInvitationOwner(invitation: RoomInvitation): { roomSecret: Uint8Array; inviterSk: Uint8Array } | undefined {
  const key = ownerStorageKey(invitation)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<StoredInvitationOwner>
    if (
      typeof value.roomSecret !== 'string' ||
      typeof value.inviterSk !== 'string' ||
      typeof value.createdAt !== 'number' ||
      value.createdAt + INVITATION_OWNER_TTL_SECONDS <= nowSeconds()
    ) {
      localStorage.removeItem(key)
      return undefined
    }
    const storedRoomSecret = hexToBytes(value.roomSecret)
    const storedInviterSk = hexToBytes(value.inviterSk)
    if (
      storedRoomSecret.length !== 32 ||
      storedInviterSk.length !== 32 ||
      getPublicKey(storedInviterSk) !== invitation.inviter
    ) {
      localStorage.removeItem(key)
      return undefined
    }
    return { roomSecret: storedRoomSecret, inviterSk: storedInviterSk }
  } catch {
    try {
      localStorage.removeItem(key)
    } catch {
      // Nothing else to recover.
    }
    return undefined
  }
}

function forgetInvitationOwner(invitation: RoomInvitation): void {
  try {
    localStorage.removeItem(ownerStorageKey(invitation))
  } catch {
    // An in-memory host can still be retired even when storage is blocked.
  }
}

interface StoredAdmission {
  roomSecret: string
  delegateSk: string
  delegation: InvitationDelegation[]
  /** What the responder said the room's epoch was. See `RoomAdmission.epoch`. */
  epoch?: number
}

function cacheAdmission(invitation: RoomInvitation, admission: RoomAdmission): void {
  try {
    const value: StoredAdmission = {
      roomSecret: bytesToHex(admission.secret),
      delegateSk: bytesToHex(admission.delegate.delegateSk),
      delegation: admission.delegate.chain,
      ...(admission.epoch !== undefined ? { epoch: admission.epoch } : {}),
    }
    sessionStorage.setItem(ADMISSION_CACHE_PREFIX + deriveInvitationId(invitation), JSON.stringify(value))
  } catch {
    // A reload will simply repeat the one-tap admission exchange.
  }
}

function loadCachedAdmission(invitation: RoomInvitation): RoomAdmission | undefined {
  try {
    const raw = sessionStorage.getItem(ADMISSION_CACHE_PREFIX + deriveInvitationId(invitation))
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<StoredAdmission>
    if (
      typeof value.roomSecret !== 'string' ||
      typeof value.delegateSk !== 'string' ||
      !Array.isArray(value.delegation)
    ) return undefined
    const secret = hexToBytes(value.roomSecret)
    const delegateSk = hexToBytes(value.delegateSk)
    if (secret.length !== 32 || delegateSk.length !== 32) return undefined
    const admission: RoomAdmission = { secret, delegate: { delegateSk, chain: value.delegation } }
    if (Number.isSafeInteger(value.epoch) && (value.epoch as number) >= 0) admission.epoch = value.epoch
    return admission
  } catch {
    return undefined
  }
}

function stopInvitationHost(): void {
  invitationHost?.close()
  invitationTransport?.close()
  invitationHost = undefined
  invitationTransport = undefined
}

function serveCurrentInvitation(): void {
  stopInvitationHost()
  const invitation = roomInvitationCapability
  if (!invitation || !invitationAuthoritySk) return
  invitationTransport = new NostrRelayPool(relays)
  try {
    invitationHost = hostRoomInvitation({
      transport: invitationTransport,
      invitation,
      inviterSk: invitationAuthoritySk,
      delegation: invitationDelegation,
      roomSecret,
      // Which epoch a grant from this browser opens. The session knows once
      // joined; before that, what this browser was itself told, or 0 for a
      // room this browser made.
      epoch: () => session?.epoch ?? expectedEpoch ?? 0,
      // A delegated responder may receive recent requests replayed by a
      // lenient relay, including requests for people already admitted on a
      // different delegation branch. Serving those again is harmless, but it
      // must not overwrite this member's own "Invitation accepted" state.
      ...(invitationDelegation.length === 0
        ? { onAdmitted: () => setStatus('Someone used the current room link.') }
        : {}),
      onRetired: () => {
        if (roomInvitationCapability !== invitation) return
        stopInvitationHost()
        invitationAuthoritySk = undefined
        invitationDelegation = []
        const rotate = document.getElementById('rotateShare') as HTMLButtonElement | null
        if (rotate) rotate.hidden = true
        setStatus('This invitation was retired by its creator. The live room is unchanged.')
      },
    })
  } catch {
    // An expired/corrupt cached delegation removes only this browser's
    // ability to answer newcomers. It still holds a valid room secret and
    // must be allowed to open the live room it already belongs to.
    invitationTransport.close()
    invitationTransport = undefined
    invitationAuthoritySk = undefined
    invitationDelegation = []
  }
}

// The creator can have the same room open in two tabs. Both restore the
// inviter key and would otherwise answer the old link after one of them had
// rotated it. Removing the owner record is broadcast by the browser's
// `storage` event; every other tab retires that inviter in memory at once.
window.addEventListener('storage', (event) => {
  if (event.newValue !== null || !event.key?.startsWith(INVITATION_OWNER_PREFIX)) return
  const invitation = roomInvitationCapability
  if (!invitation || event.key !== ownerStorageKey(invitation) || invitationDelegation.length !== 0) return
  stopInvitationHost()
  invitationAuthoritySk = undefined
  const rotate = document.getElementById('rotateShare') as HTMLButtonElement | null
  if (rotate) rotate.hidden = true
  setStatus('This copy of the invitation was retired in another tab. The live room is unchanged.')
})

let session: RoomSession | undefined
/** The relay pool the session publishes through, for a file dropped into
 *  the chat to announce itself on. Set and cleared with `session`. */
let sessionTransport: RelayTransport | undefined
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
    renderRooms()
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
// Where this device's own pictures live: one persistent holder, so the
// element showing your camera is the same element wherever it is shown. It
// sits in the preview strip under the toggles until you join, and in your
// own tile in the room from then on - you are in the room with everybody
// else, so that is where you are shown. Moved, never rebuilt: a fresh
// <video> would restart the picture, and one taken out of the document is
// paused by Chromium and stays paused (see parkPicture), so render() only
// ever reparents this holder within a single synchronous pass.
const localMediaEl = document.createElement('div')
localMediaEl.className = 'media mine'
$('local').append(localMediaEl)
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

function fragmentPayload(url: string): Partial<RoomUrlPayload> {
  const hash = new URL(url).hash.slice(1)
  if (!hash) throw new Error('join URL has no fragment')
  try {
    return JSON.parse(
      new TextDecoder().decode(base64urlnopad.decode(hash)),
    ) as Partial<RoomUrlPayload>
  } catch {
    throw new Error('join URL fragment is not valid')
  }
}

function invitationFromLocation(url: string): RoomInvitation | undefined {
  const payload = fragmentPayload(url)
  if (payload.v !== 2) return undefined
  if (typeof payload.j !== 'string' || typeof payload.h !== 'string') {
    throw new Error('join URL carries a malformed invitation')
  }
  let bearer: Uint8Array
  try {
    bearer = base64urlnopad.decode(payload.j)
  } catch {
    throw new Error('join URL carries a malformed invitation')
  }
  return roomInvitation(bearer, payload.h)
}

/**
 * Resolve the room behind the current fragment.
 *
 * V2 first checks local creator state, then this tab's admission cache, then
 * performs the live one-tap rendezvous. Legacy v1 links still decode through
 * src/room.ts so old links do not break during rollout.
 */
async function roomFromLocation(): Promise<boolean> {
  if (location.hash.length <= 1) return false

  // The room's name, when the link says. Text a stranger wrote, so it gets
  // the display-name treatment before it lands anywhere.
  roomName = sanitiseDisplayName(fragmentPayload(location.href).n)

  const invitation = invitationFromLocation(location.href)
  if (invitation) {
    const payload = fragmentPayload(location.href)
    roomInvitationCapability = invitation
    relays = Array.isArray(payload.r) && payload.r.every((relay) => typeof relay === 'string') && payload.r.length
      ? payload.r
      : RELAYS
    // Reuse the library's strict policy parser by presenting it a temporary
    // legacy-shaped fragment. A malformed gate must never silently become an
    // open room merely because this is a v2 link.
    if (payload.a !== undefined) {
      const policyPayload = base64urlnopad.encode(
        new TextEncoder().encode(JSON.stringify({ s: base64urlnopad.encode(new Uint8Array(32)), r: [], a: payload.a })),
      )
      roomPolicy = decodeJoinUrl(`${joinLinkBase()}#${policyPayload}`).policy
    } else {
      roomPolicy = undefined
    }

    const owner = loadInvitationOwner(invitation)
    if (owner) {
      roomSecret = owner.roomSecret
      invitationAuthoritySk = owner.inviterSk
      invitationDelegation = []
      // A room this browser made is at epoch 0: only its authority could
      // have moved it, and that is this browser, which has not.
      expectedEpoch = 0
      serveCurrentInvitation()
    } else {
      const cached = loadCachedAdmission(invitation)
      if (cached) {
        roomSecret = cached.secret
        invitationAuthoritySk = cached.delegate.delegateSk
        invitationDelegation = cached.delegate.chain
        expectedEpoch = cached.epoch
        serveCurrentInvitation()
      } else {
        setStatus('Opening the private room…')
        const transport = new NostrRelayPool(relays)
        try {
          const admission = await requestRoomAdmissionCapability({ transport, invitation })
          roomSecret = admission.secret
          invitationAuthoritySk = admission.delegate.delegateSk
          invitationDelegation = admission.delegate.chain
          expectedEpoch = admission.epoch
          cacheAdmission(invitation, admission)
          setStatus('Invitation accepted. No account was needed.')
        } finally {
          transport.close()
        }
        serveCurrentInvitation()
      }
    }
  } else {
    const { secret, relays: hinted, policy } = decodeJoinUrl(location.href)
    roomSecret = secret
    relays = hinted.length ? hinted : RELAYS
    roomPolicy = policy
    roomInvitationCapability = undefined
    invitationAuthoritySk = undefined
    invitationDelegation = []
  }

  const extras = decodeExtras(location.href)
  iceUrls = extras.iceUrls

  if (extras.pairingCode) {
    // Drop the code out of the address bar first: it is single-use and there
    // is no reason for it to sit somewhere it could be forwarded by accident.
    const code = extras.pairingCode
    history.replaceState(null, '', encodeRoomUrl(joinLinkBase(), relays, iceUrls))
    pairWithPrimary(code).catch((err) => setStatus(describeError(err)))
  }

  // Admitted, one way or another: this is now a room this device has been
  // in, and the list on the front page will offer it again.
  rememberCurrentRoom()
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
  const created = createRoomInvitation()
  roomInvitationCapability = created.invitation
  invitationAuthoritySk = created.inviterSk
  invitationDelegation = []
  relays = RELAYS
  iceUrls = parseIceInput()
  roomName = sanitiseDisplayName(($('roomName') as HTMLInputElement).value)
  storeInvitationOwner(created.invitation, roomSecret, created.inviterSk)
  serveCurrentInvitation()
  history.replaceState(null, '', encodeRoomUrl(joinLinkBase(), relays, iceUrls))
  rememberCurrentRoom()
}

function showRoomUi(): void {
  $('setup').hidden = true
  hideRoomsList()
  $('roomNav').hidden = false
  renderRoomTitle()
  $('deviceControls').hidden = false
  $('join').hidden = false
  $('links').hidden = false
  ;($('shareUrl') as HTMLInputElement).value = encodeRoomUrl(joinLinkBase(), relays, iceUrls)
  ;($('shareRoom') as HTMLButtonElement).hidden = navigator.share === undefined
  ;($('rotateShare') as HTMLButtonElement).hidden =
    roomInvitationCapability === undefined || invitationAuthoritySk === undefined || invitationDelegation.length !== 0
}

/** What this room is called, and enough of its id to tell it from another
 *  called the same thing, above the link that opens it. */
function renderRoomTitle(): void {
  const title = $('roomTitle')
  const roomId = currentRoomId()
  title.textContent = ''
  title.hidden = roomId === undefined
  if (!roomId) return
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = roomLabel({ roomId, name: roomName })
  const id = document.createElement('span')
  id.className = 'pubkey'
  id.textContent = shortKey(roomId)
  id.title = roomId
  title.append(name, ' ', id)
}

function copyInput(id: string): void {
  const input = $(id) as HTMLInputElement
  input.hidden = false
  input.select()
  navigator.clipboard?.writeText(input.value).catch(() => {
    document.execCommand('copy')
  })
  if (id === 'shareUrl') {
    setStatus('Room link copied. Anyone it is forwarded to can enter until you rotate it.')
  }
}

async function shareRoomLink(): Promise<void> {
  const url = ($('shareUrl') as HTMLInputElement).value
  if (!navigator.share) {
    copyInput('shareUrl')
    return
  }
  try {
    await navigator.share({
      title: 'KithMoot',
      text: 'Join this private KithMoot room. Anyone forwarded this link can enter while it is current.',
      url,
    })
    setStatus('Room invitation shared.')
  } catch (err) {
    // Closing the platform share sheet is a choice, not an error.
    if (!(err instanceof DOMException && err.name === 'AbortError')) throw err
  }
}

async function rotateRoomInvitation(): Promise<void> {
  if (!roomInvitationCapability || !invitationAuthoritySk || invitationDelegation.length !== 0) {
    throw new Error('Only the browser that opened this room can rotate its invitation.')
  }
  const retired = roomInvitationCapability
  const retiringSk = invitationAuthoritySk
  const created = createRoomInvitation()

  // Tell every cooperative delegated responder before replacing local
  // state. The event is durable, so an offline member learns the retirement
  // when it reconnects instead of resurrecting an old group link.
  const retirementTransport = new NostrRelayPool(relays)
  try {
    await retirementTransport.publish(encodeInvitationRetirement({
      invitation: retired,
      inviterSk: retiringSk,
      now: nowSeconds(),
    }))
  } finally {
    retirementTransport.close()
  }
  stopInvitationHost()
  forgetInvitationOwner(retired)
  roomInvitationCapability = created.invitation
  invitationAuthoritySk = created.inviterSk
  invitationDelegation = []
  storeInvitationOwner(created.invitation, roomSecret, created.inviterSk)
  serveCurrentInvitation()

  const url = encodeRoomUrl(joinLinkBase(), relays, iceUrls)
  history.replaceState(null, '', url)
  ;($('shareUrl') as HTMLInputElement).value = url
  // The old link is retired; the one kept for the list is the one that opens the room now.
  rememberCurrentRoom()
  if (($('shareQrDetails') as HTMLDetailsElement).open) {
    renderQr($('shareQr') as HTMLCanvasElement, url).catch((err) => setStatus(describeError(err)))
  }
  setStatus('A fresh link is ready. Current clients will no longer answer the old link. Existing members stay.')
}

// ---------------------------------------------------------------------------
// Local media - the mic, camera and screen-share toggles
//
// Mic mutes in place (track.enabled), which is instant and asks for no
// fresh permission. Camera and screen stop the underlying track outright:
// that is what actually turns off a laptop's camera light and ends an OS
// screen-share, rather than merely lying about it locally.
// ---------------------------------------------------------------------------

function onMicEnded(): void {
  mic?.stop()
  mic = undefined
  micTrack = undefined
  publishActiveTracks()
  updateUi()
}

/**
 * Publish whatever the pipeline now says the microphone is.
 *
 * The pipeline hands over a different track when its masking graph has
 * stopped rendering - see `MicPipeline` - and everybody has to be sent the
 * new one: `publishActiveTracks` removes the old sender and adds the new,
 * and the roster restates the advert under the new id.
 */
function adoptMicTrack(): void {
  const next = mic?.track
  if (!next || !micTrack || next === micTrack) return
  micTrack.removeEventListener('ended', onMicEnded)
  micTrack = next
  micTrack.addEventListener('ended', onMicEnded)
  publishActiveTracks()
  updateUi()
}

async function toggleMic(): Promise<void> {
  if (!micTrack) {
    const pipeline = new MicPipeline({
      onStateChange: (state) => {
        renderVoiceState(state)
        adoptMicTrack()
      },
    })
    try {
      micTrack = await pipeline.start()
    } catch (err) {
      pipeline.stop()
      throw err
    }
    mic = pipeline
    micTrack.addEventListener('ended', onMicEnded)
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
  localMediaEl.append(video)
  localPreviewEls.set(kind, video)
}

/** Which of our own preview elements a track advert corresponds to, if any.
 *  Audio has no picture, so a mic is always a chip and never a preview. */
function previewKindOf(role: TrackAdvert['role']): 'camera' | 'screen' | undefined {
  if (role === 'camera') return 'camera'
  if (role === 'screen') return 'screen'
  return undefined
}

/** Publish this device's whole current set of active tracks. Always the full
 *  set, never just what changed: `Mesh`/`Peer` keep their own per-peer record
 *  of what has already been added to which connection, so re-sending a track
 *  that is already there is a safe no-op, and a device that joins the mesh
 *  after a later toggle still gets everything published before it arrived. */
const AGENTS_HEAR_STORAGE_KEY = 'kithmoot.agents-hear'

/**
 * Whether anything in this room that says it is an agent is sent this
 * device's media.
 *
 * Off by default, and remembered. Off means the tracks are never handed to
 * the connection to an agent - see `RoomSession.publishTracks` - so a
 * conversation people want to have among themselves is one no agent in the
 * room can hear, whatever it claims to be for. On is the case a person
 * chooses when they want an agent following along, and a listening agent
 * then writes what they say into the transcript channel. Per device, per
 * person: it is my media, so it is my switch.
 */
let agentsMayHear = localStorage.getItem(AGENTS_HEAR_STORAGE_KEY) === 'true'

/** Who this device's media goes to: everybody, unless they say they are an
 *  agent and the switch above is off. */
function audience(view: ParticipantView): boolean {
  return view.agent !== true || agentsMayHear
}

function setAgentsMayHear(on: boolean): void {
  agentsMayHear = on
  try {
    localStorage.setItem(AGENTS_HEAR_STORAGE_KEY, String(on))
  } catch {
    // Storage may be unavailable; the switch still works for this page.
  }
  setToggle('toggleAgentsHear', on)
  $('agentsHearNote').textContent = on
    ? 'On: agents receive your camera and microphone like anybody else, and a listening one writes what you say into the transcript.'
    : 'Off: nothing that says it is an agent is sent your camera or microphone. It never leaves this device for them.'
  publishActiveTracks()
}

/** When this device last took the microphone, for the singular-role claim.
 *  Stamped when the mic comes on, so a device that has held it since the
 *  start is not outranked by its owner's other device toggling later. */
let micClaimedAt: number | undefined

/**
 * What this device is publishing, as the roster should advertise it: the
 * real track ids, which are what a volunteer carrying this device's media
 * has to match a forwarded track against - see `Mesh.#trackOwner`.
 */
function currentAdverts(): TrackAdvert[] {
  const adverts: TrackAdvert[] = []
  if (cameraTrack) adverts.push({ trackId: cameraTrack.id, role: 'camera' })
  if (micTrack) adverts.push({ trackId: micTrack.id, role: 'mic' })
  if (screenTrack) adverts.push({ trackId: screenTrack.id, role: 'screen' })
  return adverts
}

function currentClaims(): Partial<Record<SingularRole, number>> {
  if (!micTrack) return {}
  micClaimedAt ??= nowSeconds()
  return { mic: micClaimedAt }
}

/** Send the live tracks to every peer, and tell the roster what they are.
 *  Both, every time: the peers carry the media, and the roster is what
 *  everybody else's tile reads to say "camera" or "connecting". */
function publishActiveTracks(): void {
  if (!micTrack) micClaimedAt = undefined
  session?.publishTracks(activeTracks(), { audience })
  session?.advertise(currentAdverts(), currentClaims()).catch(() => {})
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
  const agentsRow = $('agentsRow')
  agentsRow.innerHTML = ''

  // Ask about every key in the room, so anyone with a published Nostr
  // profile is shown as having one. Cheap to repeat - the book only looks
  // up a key it has not seen.
  profiles.want(views.map((v) => v.participant))

  for (const view of views) {
    // An agent with nothing on screen - a keeper, a host, one that only
    // reads and writes - is a name in a row, not an empty tile taking a
    // person's space in the grid. One that publishes media is a tile like
    // anybody else.
    const showsMedia =
      view.participant === me
        ? localMediaEl.childElementCount > 0
        : view.devices.some((device) => (deviceMediaEls.get(device)?.childElementCount ?? 0) > 0)
    if (view.agent && !showsMedia) {
      const chip = document.createElement('span')
      chip.className = 'agentChip'
      const shown = shownAs(view.participant, view.name)
      chip.append(identityRun(shown, view.participant === me))
      const badge = document.createElement('span')
      badge.className = 'badge agent'
      badge.textContent = 'agent'
      badge.title = 'This participant says it is an automated agent'
      chip.append(badge)
      agentsRow.append(chip)
      continue
    }
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
    if (view.agent) {
      // Self-declared, like a name: it says what this participant claims to
      // be, and it is what the "agents can hear me" switch acts on.
      const badge = document.createElement('span')
      badge.className = 'badge agent'
      badge.textContent = 'agent'
      badge.title = 'This participant says it is an automated agent'
      heading.append(badge)
    }
    box.append(heading)

    if (view.participant === me) {
      // Our own live media, in our own tile: the same elements that were the
      // preview before joining, moved here rather than duplicated (see
      // localMediaEl). A chip only for what has no picture - the mic - and
      // for a track advertised but not currently previewed.
      if (localMediaEl.childElementCount > 0) box.append(localMediaEl)
      box.append(
        trackChips(view, (track) => {
          const kind = previewKindOf(track.role)
          return kind !== undefined && localPreviewEls.has(kind) ? 'live' : 'own'
        }),
      )
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

  agentsRow.hidden = agentsRow.childElementCount === 0

  // Emptying the grid above detached our own holder if it was in a tile. If
  // no tile of ours was built this time - our entry has not come back from
  // the relay yet, or lapsed - it goes back to the preview strip in this same
  // synchronous pass, so it is never out of the document long enough for
  // the browser to pause the picture in it.
  if (!localMediaEl.isConnected) $('local').append(localMediaEl)
}

/**
 * What a chip says while a device's media has not arrived: which rung of
 * the route ladder the connection to it is on, and whether the ladder has
 * run out. "connecting…" alone told a person nothing about why, and told
 * anybody trying to help even less.
 */
function connectingWord(device: string): string {
  const route = session?.routes.get(device)
  if (!route) return 'connecting…'
  if (route.exhausted) return 'could not connect, trying again'
  switch (route.tier) {
    case 'turn':
      return 'connecting via TURN…'
    case 'assist':
      return `connecting via ${nameOfDevice(route.endpoint)}…`
    case 'forwarder':
      return 'connecting via forwarder…'
    default:
      return 'connecting…'
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
      state === 'waiting' ? `${track.role} · ${connectingWord(track.device)}` : `${track.role}${isLiveMic ? ' · live mic' : ''}`
    chips.append(chip)
  }
  return chips
}

/** The newest catalogue from every host, by host participant. */
const catalogues = new Map<string, Extract<ControlMessage, { op: 'catalogue' }> & { at: number }>()
const controlSeen = new Set<string>()

// ---------------------------------------------------------------------------
// Host controls
//
// A keeper announces who may act on the room, signed by the authority key
// pinned in the link, because the control channel is one every member can
// write to and "I am the admin" is exactly what somebody would forge. What
// an admin can do: ask the keeper to remove somebody (a new epoch that
// person is not given), ask it to close the room, and ask a person to mute.
// The first two are enforced by the key; the third is manners, and says so.
// ---------------------------------------------------------------------------

/** Who may act on this room, as the keeper last announced it. */
let admins = new Set<string>()
let adminsAt = 0
/** The keeper's own participant, from its announcement. Not somebody an
 *  admin can remove: removing the keeper is closing the room. */
let keeperParticipant: string | undefined

/** A name and a short key for one person, for a status line. */
function personLabel(pubkey: string): string {
  const shown = shownAs(pubkey, session?.participants().find((v) => v.participant === pubkey)?.name)
  return shown.name !== undefined ? `${shown.name} (${shown.short})` : shown.short
}

/** Lines the room shows in the chat that nobody sent: an epoch change, a
 *  removal. Rendered locally, never published, and never mistaken for a
 *  message because they carry no sender. */
interface SystemLine {
  at: number
  text: string
}
const systemLines: SystemLine[] = []

function addSystemLine(text: string): void {
  systemLines.push({ at: nowSeconds(), text })
  // An epoch can move while the session is still joining, before its chat
  // exists; the line is kept, and the first render after join shows it.
  try {
    if (session) renderChat(session.chat.messages())
  } catch {
    // Not joined yet.
  }
}

function onEpochChange(notice: RekeyNotice): void {
  const by = notice.by ? ` by ${personLabel(notice.by)}` : ''
  for (const p of notice.removed) addSystemLine(`${personLabel(p)} was removed${by}.`)
  addSystemLine(
    `The room moved to epoch ${notice.epoch}.${notice.removed.length ? ' Nothing from here on reaches who was removed; what they already read stays theirs.' : ''}`,
  )
  renderHost()
}

const NOTICE_STORAGE_KEY = 'kithmoot.notice'

/**
 * Leave because the room said so, and say why on the page that comes back.
 * The reload is the same one `leaveRoom` does, for the same reason - it is
 * the only teardown that cannot miss a camera - so the reason rides across
 * it in session storage rather than in a status line the reload would wipe.
 */
function leaveWithNotice(message: string): void {
  try {
    sessionStorage.setItem(NOTICE_STORAGE_KEY, message)
  } catch {
    // Storage may be unavailable. The room is still left.
  }
  leaveRoom()
}

/** An admin asked this device to stop sending. Honoured, and said so. */
function muteRequested(by: string): void {
  const stopped: string[] = []
  if (micTrack) {
    micTrack.removeEventListener('ended', onMicEnded)
    micTrack.stop()
    mic?.stop()
    mic = undefined
    micTrack = undefined
    stopped.push('microphone')
  }
  if (camera) {
    camera.stop()
    camera = undefined
    cameraTrack = undefined
    localPreviewEls.get('camera')?.remove()
    localPreviewEls.delete('camera')
    stopped.push('camera')
  }
  if (screenTrack) {
    screenTrack.stop()
    screenTrack = undefined
    localPreviewEls.get('screen')?.remove()
    localPreviewEls.delete('screen')
    stopped.push('screen share')
  }
  publishActiveTracks()
  updateUi()
  const what = stopped.length ? `Your ${stopped.join(', ')} ${stopped.length > 1 ? 'were' : 'was'} turned off.` : 'You were sending nothing.'
  setStatus(`${personLabel(by)} asked you to mute. ${what}`)
  addSystemLine(`${personLabel(by)} asked you to mute. ${what}`)
}

function sendHostControl(message: ControlMessage, said: string): void {
  session
    ?.channel(CONTROL_CHANNEL)
    .send(encodeControl(message))
    .then(() => setStatus(said))
    .catch((err) => setStatus(describeError(err)))
}

/** The Host panel: shown only to a participant on the announced list. */
function renderHost(): void {
  const panel = $('hostPanel') as HTMLDetailsElement
  const isAdmin = session !== undefined && admins.has(meParticipant)
  panel.hidden = !isAdmin
  if (!isAdmin) return
  const list = $('hostList')
  list.innerHTML = ''
  for (const view of session!.participants()) {
    if (view.participant === meParticipant) continue
    const row = document.createElement('div')
    row.className = 'hostRow'
    const who = document.createElement('span')
    who.className = 'who'
    who.append(identityRun(shownAs(view.participant, view.name), false))
    if (view.agent) who.append(' (agent)')
    row.append(who)
    const label = personLabel(view.participant)
    if (view.participant === keeperParticipant) {
      const note = document.createElement('span')
      note.className = 'note'
      note.textContent = 'the keeper'
      row.append(note)
      list.append(row)
      continue
    }
    const mute = document.createElement('button')
    mute.type = 'button'
    mute.textContent = 'Mute'
    mute.title = 'Ask their client to turn its camera and microphone off. A request; nothing can force it.'
    mute.addEventListener('click', () => sendHostControl({ op: 'mute', participant: view.participant }, `Asked ${label} to mute.`))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'danger'
    remove.textContent = 'Remove'
    remove.title = 'Move the room to a new key this person is not given.'
    remove.addEventListener('click', () => {
      if (!confirm(`Remove ${label} from the room? They will read nothing from here on. What they already read stays theirs.`)) return
      sendHostControl({ op: 'remove', participant: view.participant }, `Asked the keeper to remove ${label}.`)
    })
    row.append(mute, remove)
    list.append(row)
  }
}

$('closeRoom').addEventListener('click', () => {
  if (!confirm('Close this room for everybody? The link stops answering and the keeper leaves.')) return
  sendHostControl({ op: 'close' }, 'Asked the keeper to close the room.')
})

function ingestControl(messages: ChatMessage[]): void {
  let changed = false
  for (const m of messages) {
    if (controlSeen.has(m.id)) continue
    controlSeen.add(m.id)
    const control = decodeControl(m.text)
    if (!control) continue
    switch (control.op) {
      case 'catalogue': {
        // Sent by the host it names, or it is somebody else's claim.
        if (control.host !== m.participant) break
        const have = catalogues.get(control.host)
        if (have && have.at > m.sentAt) break
        catalogues.set(control.host, { ...control, at: m.sentAt })
        changed = true
        break
      }
      case 'invited':
        if (control.host === m.participant && m.sentAt >= nowSeconds() - 30) setStatus(`${control.name} is joining.`)
        break
      case 'dismissed':
        if (control.host === m.participant && m.sentAt >= nowSeconds() - 30) setStatus(`${control.name} has left${control.reason ? ` (${control.reason})` : ''}.`)
        break
      case 'error':
        if (control.host === m.participant && m.sentAt >= nowSeconds() - 30) setStatus(`Agent host: ${control.message}`)
        break
      case 'admins': {
        // Only a list the room's authority signed, and only the newest.
        const authority = roomAuthority()
        if (!authority || !session || control.host !== m.participant) break
        if (!verifyAdmins({ roomId: session.roomId, epoch: control.epoch, admins: control.admins, sig: control.sig, authority })) break
        if (m.sentAt < adminsAt) break
        admins = new Set(control.admins)
        adminsAt = m.sentAt
        keeperParticipant = control.host
        renderHost()
        break
      }
      case 'mute':
        // For this device, from somebody on the announced list, and recent:
        // a request replayed from last week is not one.
        if (control.participant !== meParticipant || !admins.has(m.participant)) break
        if (m.sentAt < nowSeconds() - 30) break
        muteRequested(m.participant)
        break
      default:
        break
    }
  }
  if (changed) renderInvites()
}

/** Which hosts are actually here. A catalogue from a host that has left is
 *  a menu for a kitchen that has closed. */
function renderInvites(): void {
  const box = $('inviteAgents')
  const list = $('inviteList')
  list.innerHTML = ''
  const present = new Set(session?.participants().map((v) => v.participant) ?? [])
  let rows = 0
  for (const [host, catalogue] of catalogues) {
    if (!present.has(host)) continue
    for (const entry of catalogue.agents) {
      const row = document.createElement('div')
      row.className = 'inviteRow'
      const running = catalogue.running.find((r) => r.id === entry.id)
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = running ? `Dismiss ${entry.name}` : `Invite ${entry.name}`
      button.addEventListener('click', () => {
        button.disabled = true
        session
          ?.channel(CONTROL_CHANNEL)
          .send(encodeControl({ op: running ? 'dismiss' : 'invite', host, agent: entry.id }))
          .then(() => setStatus(running ? `Asked ${catalogue.name} to stop ${entry.name}.` : `Asked ${catalogue.name} to start ${entry.name}.`))
          .catch((err) => setStatus(describeError(err)))
          .finally(() => {
            button.disabled = false
          })
      })
      row.append(button)
      const desc = document.createElement('span')
      desc.className = 'desc'
      desc.textContent = `${entry.description ?? ''}${entry.listens ? ' Listens, when allowed.' : ''} · via ${catalogue.name}`
      row.append(desc)
      if (running) {
        const tag = document.createElement('span')
        tag.className = 'running'
        tag.textContent = 'in the room'
        row.append(tag)
      }
      list.append(row)
      rows++
    }
  }
  box.hidden = rows === 0
}

// ---------------------------------------------------------------------------
// Attachments: files shared through Wildbloom
// ---------------------------------------------------------------------------

type OpenedAttachment = { url: string; name: string; type: string; size: number } | { error: string }

/** What has been fetched and opened, per log, per message, per attachment.
 *  An object URL is revoked when its message leaves the log and never
 *  before, so a re-render costs nothing and never fetches twice. */
const openedAttachments = new Map<string, OpenedAttachment>()

function attachmentKey(logId: string, messageId: string, index: number): string {
  return `${logId}/${messageId}/${index}`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Drop what was opened for messages no longer in this log. */
function pruneOpenedAttachments(logId: string, messages: ChatMessage[]): void {
  const live = new Set<string>()
  for (const m of messages) (m.attachments ?? []).forEach((_, i) => live.add(attachmentKey(logId, m.id, i)))
  for (const [key, opened] of openedAttachments) {
    if (!key.startsWith(`${logId}/`) || live.has(key)) continue
    if ('url' in opened) URL.revokeObjectURL(opened.url)
    openedAttachments.delete(key)
  }
}

/**
 * One attachment under a message. Nothing is fetched until the person
 * clicks: a fetch reaches the Blossom server, and that is a fact about
 * this device that a message from somebody else must not create on its
 * own. Once fetched, the envelope is checked against the hash the message
 * named before the key touches it, then opened here and shown inline if it
 * is a picture, or offered to save if it is anything else.
 */
function attachmentCard(logId: string, m: ChatMessage, index: number, a: ChatAttachment): HTMLElement {
  const card = document.createElement('span')
  card.className = 'attachment'
  const key = attachmentKey(logId, m.id, index)
  const render = (): void => {
    card.innerHTML = ''
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = `${a.name ?? 'Encrypted file'}${a.size !== undefined ? ` \u00b7 ${formatBytes(a.size)}` : ''}`
    card.append(label)
    const opened = openedAttachments.get(key)
    if (opened && 'url' in opened) {
      if (opened.type.startsWith('image/')) {
        const img = document.createElement('img')
        img.src = opened.url
        img.alt = opened.name
        card.append(img)
      }
      const save = document.createElement('a')
      save.href = opened.url
      save.download = opened.name
      save.textContent = `Save ${opened.name} (${formatBytes(opened.size)})`
      card.append(save)
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = opened ? 'Try again' : 'Show'
    button.title = 'Fetch the encrypted file from where it is stored, check it, and open it here'
    button.addEventListener('click', async () => {
      button.disabled = true
      button.textContent = 'Fetching\u2026'
      try {
        const file = await fetchAttachment(a)
        const blob = new Blob([file.source.slice().buffer as ArrayBuffer], { type: file.type })
        openedAttachments.set(key, { url: URL.createObjectURL(blob), name: file.name, type: file.type, size: file.size })
      } catch (err) {
        // The reason and nothing else: an error here never carries the key.
        openedAttachments.set(key, { error: describeError(err) })
      }
      render()
    })
    card.append(button)
    if (opened && 'error' in opened) {
      const why = document.createElement('span')
      why.className = 'why'
      why.textContent = opened.error
      card.append(why)
    }
  }
  render()
  return card
}

function renderChat(messages: ChatMessage[]): void {
  renderLog('chatLog', undefined, messages, systemLines)
}

/**
 * One conversation into one element: the chat, the agents' channel, the
 * transcript. A transcript line names the speaker the transcriber claims,
 * beside a key exactly as a name is, and says who wrote it down.
 */
function renderLog(logId: string, countId: string | undefined, messages: ChatMessage[], system: SystemLine[] = []): void {
  const log = $(logId)
  log.innerHTML = ''
  pruneOpenedAttachments(logId, messages)
  profiles.want(messages.flatMap((m) => (m.speaker ? [m.participant, m.speaker] : [m.participant])))

  // System lines sit in the log where they happened, and look like nothing
  // anybody sent: no name, no key, because nobody did.
  let nextSystem = 0
  const systemUpTo = (at: number): void => {
    while (nextSystem < system.length && system[nextSystem]!.at <= at) {
      const p = document.createElement('p')
      p.className = 'system'
      p.textContent = system[nextSystem]!.text
      log.append(p)
      nextSystem++
    }
  }

  for (const m of messages) {
    systemUpTo(m.sentAt)
    const p = document.createElement('p')
    const who = document.createElement('span')
    who.className = 'who'
    if (m.kind === 'transcript') {
      p.className = 'transcript'
      if (m.speaker) {
        const speakerName = session?.participants().find((v) => v.participant === m.speaker)?.name
        who.append(identityRun(shownAs(m.speaker, speakerName), m.speaker === meParticipant))
        who.append(' said: ')
      } else {
        who.append('somebody said: ')
      }
      const by = document.createElement('span')
      by.className = 'who'
      by.append(' · heard by ')
      by.append(identityRun(shownAs(m.participant, m.name), false))
      p.append(who, m.text, by)
    } else {
      // The same name-and-key run the tiles use. A line of chat is exactly
      // where a name alone would be most convincing and least checkable, so
      // the short pubkey is here too - and the name on the message is the
      // sender's own claim, carried with it (see ChatMessage.name).
      who.append(identityRun(shownAs(m.participant, m.name), m.participant === meParticipant))
      p.append(who, m.text)
    }
    for (const [i, a] of (m.attachments ?? []).entries()) p.append(attachmentCard(logId, m, i, a))
    log.append(p)
  }
  systemUpTo(Number.POSITIVE_INFINITY)
  if (countId) $(countId).textContent = messages.length ? `(${messages.length})` : ''
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
const remoteAudios = new Map<string, { el: HTMLAudioElement; track: MediaStreamTrack }>()

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
    // The same key, a different track object: the mesh rebuilt the
    // connection to this device - a rung down the ladder, or a fresh one
    // after a rest - and the far end's track arrived again on it. The
    // element is kept, so the picture never blinks, but everything that
    // judges it has to follow the new track: the stall poller reads
    // `entry.track.readyState`, and the old track ends the moment the old
    // connection closes. Left pointing at the old one, the poller and the
    // old track's `ended` both took the element off the screen while it
    // was showing live frames from the new one, and nothing put it back -
    // `ontrack` for that track had already fired. That was a picture gone
    // for the rest of the call, on a connection that was working.
    const replaced = existing !== undefined && existing.track !== track
    if (!existing || replaced) el.srcObject = new MediaStream([track])
    if (existing) existing.track = track
    if (!existing) {
      el.autoplay = true
      el.playsInline = true
      el.muted = true
      el.dataset.track = track.id
      remoteVideos.set(key, { el, container, track, last: -1, stalled: 0, played: false })
      container.append(el)
    } else if (!onScreen(existing)) {
      // Parked, and the far end is publishing this track again - a
      // renegotiation hands the same track over and `ontrack` fires afresh.
      // Back on screen, with the stall count reset: if it really is still
      // frozen, the next two checks say so and park it again.
      container.append(el)
      existing.stalled = 0
    }
    if (replaced) {
      // A new track has never played, whatever the old one did, and the
      // clock it is judged by starts again.
      existing!.last = -1
      existing!.stalled = 0
      existing!.played = false
    }
    track.addEventListener('ended', () => {
      // Only the track currently on this element may take it down. The
      // one this listener was registered for may have been replaced since,
      // in which case its ending is old news about a closed connection.
      if (remoteVideos.get(key)?.track !== track) return
      el.remove()
      remoteVideos.delete(key)
      if (session) render(session.participants(), meParticipant)
    })
  } else {
    // Audio is never taken off screen for going quiet. A picture that
    // outlives its media is a lie about what the room can see; an `<audio>`
    // element that outlives its media is simply silent - and removing one
    // costs real sound, because a track with no sink is never decoded and
    // reports exactly zero energy, which is how a room with no audio
    // elements at all looked in the first place.
    const existing = remoteAudios.get(key)
    const el = existing?.el ?? document.createElement('audio')
    if (!existing) {
      el.autoplay = true
      el.dataset.track = track.id
      remoteAudios.set(key, { el, track })
      container.append(el)
    } else if (!el.isConnected) {
      container.append(el)
    }
    // Same rule as the picture: a rebuilt connection hands the same track id
    // over as a new object, and only the track on the element now may end
    // it. Reassigned only when it changed, so a renegotiation that hands the
    // same track back does not restart the element mid-word.
    if (!existing || existing.track !== track) {
      el.srcObject = new MediaStream([track])
      if (existing) existing.track = track
    }
    track.addEventListener('ended', () => {
      if (remoteAudios.get(key)?.track !== track) return
      el.remove()
      remoteAudios.delete(key)
      if (session) render(session.participants(), meParticipant)
    })
  }

  if (session) render(session.participants(), meParticipant)
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const short = (hex: string | undefined) => (hex ? hex.slice(0, 8) : hex)

/**
 * What this page knows about its own connections, as text to paste into a
 * bug report: the browser, who is here and what they advertise, every
 * route and its rung, every peer connection with its states, its tracks and
 * the counters that say whether media is moving, and every remote element
 * with whether it is on screen and advancing.
 *
 * Deliberately no addresses: candidate TYPES say whether a pair went
 * direct or through TURN, which is what a report needs, and a person's IP
 * is not something a "copy" button should put on their clipboard.
 */
async function collectDiagnostics(): Promise<string> {
  const s = session
  const pick = (r: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
  const connections = await Promise.all(
    [...openConnections].map(async ([key, pc]) => {
      const stats: Record<string, unknown>[] = []
      try {
        const report = await pc.getStats()
        report.forEach((raw) => {
          const r = raw as unknown as Record<string, unknown>
          switch (r.type) {
            case 'inbound-rtp':
            case 'outbound-rtp':
              stats.push(pick(r, ['type', 'kind', 'bytesReceived', 'bytesSent', 'packetsReceived', 'packetsSent', 'packetsLost', 'framesDecoded', 'framesEncoded', 'framesReceived', 'framesSent', 'frameWidth', 'frameHeight', 'codecId', 'pliCount', 'nackCount', 'jitterBufferDelay']))
              break
            case 'candidate-pair':
              if (r.nominated === true || r.selected === true) stats.push(pick(r, ['type', 'state', 'localCandidateId', 'remoteCandidateId', 'bytesSent', 'bytesReceived', 'currentRoundTripTime', 'availableOutgoingBitrate']))
              break
            case 'local-candidate':
            case 'remote-candidate':
              stats.push(pick(r, ['type', 'id', 'candidateType', 'protocol', 'relayProtocol', 'networkType']))
              break
            case 'codec':
              stats.push(pick(r, ['type', 'id', 'mimeType', 'clockRate']))
              break
          }
        })
      } catch {
        stats.push({ error: 'getStats failed' })
      }
      return {
        key: key.replace(/:([0-9a-f]{64}):/, (_m, k: string) => `:${k.slice(0, 8)}:`),
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState,
        senders: pc.getSenders().map((sn) => (sn.track ? `${sn.track.kind}:${sn.track.readyState}${sn.track.muted ? ':muted' : ''}${sn.track.enabled ? '' : ':disabled'}` : 'none')),
        receivers: pc.getReceivers().map((rc) => `${rc.track.kind}:${rc.track.readyState}${rc.track.muted ? ':muted' : ''}`),
        stats,
      }
    }),
  )
  const out = {
    at: new Date().toISOString(),
    build: document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') ?? 'dev',
    ua: navigator.userAgent,
    visibility: document.visibilityState,
    me: {
      participant: short(meParticipant),
      device: short(myDeviceId),
      publishing: currentAdverts().map((a) => a.role),
      agentsMayHear,
      effect: $('effectMode').textContent,
    },
    participants: s?.participants().map((v) => ({
      name: v.name,
      participant: short(v.participant),
      agent: v.agent === true,
      devices: v.devices.map(short),
      tracks: v.tracks.map((t) => `${t.role}@${short(t.device)}`),
      mic: short(v.mic),
    })),
    routes: s ? [...s.routes].map(([d, r]) => ({ device: short(d), tier: r.tier, endpoint: short(r.endpoint), connected: r.connected, exhausted: r.exhausted })) : [],
    connections,
    pictures: [...remoteVideos].map(([key, v]) => ({
      device: short(key.split('|')[0]),
      onScreen: onScreen(v),
      played: v.played,
      stalled: v.stalled,
      currentTime: Number(v.el.currentTime.toFixed(2)),
      paused: v.el.paused,
      size: `${v.el.videoWidth}x${v.el.videoHeight}`,
      track: `${v.track.readyState}${v.track.muted ? ':muted' : ''}`,
    })),
    sounds: [...remoteAudios].map(([key, a]) => ({
      device: short(key.split('|')[0]),
      inDocument: a.el.isConnected,
      paused: a.el.paused,
      currentTime: Number(a.el.currentTime.toFixed(2)),
      track: `${a.track.readyState}${a.track.muted ? ':muted' : ''}`,
    })),
  }
  return JSON.stringify(out, null, 1)
}

$('diagnostics').addEventListener('click', () => {
  collectDiagnostics()
    .then(async (text) => {
      const box = $('diagnosticsOut') as HTMLTextAreaElement
      box.value = text
      box.hidden = false
      box.select()
      try {
        await navigator.clipboard.writeText(text)
        setStatus('Diagnostics copied to the clipboard, and shown below.')
      } catch {
        setStatus('Diagnostics shown below; copy them from the box.')
      }
    })
    .catch((err) => setStatus(describeError(err)))
})

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
    let resolvedIceServers = await resolveIceServers(iceUrls)

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
    const withoutTurn = (servers: RTCIceServer[]) =>
      servers.filter((server) => !toUrlList(server.urls).some((url) => url.toLowerCase().startsWith('turn')))
    let stunOnly = withoutTurn(resolvedIceServers)
    // A minted TURN credential lasts an hour. A standing room lasts longer,
    // and the TURN rung is built from whatever these hold at the moment a
    // pair needs it - which, two hours in, was an expired credential, and a
    // person whose Wi-Fi had just changed could not be reached again.
    // Refreshed well inside the credential's life, and never blocking: a
    // refresh that fails leaves the last good list in place.
    setInterval(() => {
      resolveIceServers(iceUrls)
        .then((fresh) => {
          resolvedIceServers = fresh
          stunOnly = withoutTurn(fresh)
        })
        .catch(() => {})
    }, ICE_REFRESH_MS)
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
    // Held here as well as inside the session, because a file dropped into
    // the chat announces itself with a kind-1063 event on the room's own
    // relays, through the sockets the room already has open.
    const transport = new NostrRelayPool(relays)
    sessionTransport = transport
    const s = credential
      ? new RoomSession({
          transport,
          secret: roomSecret,
          credential,
          deviceSk,
          factory,
          policy: roomPolicy,
          name,
          assist: currentAssistOffer,
          relay: peerRelay,
          // Epochs: follow a rekey signed by the room's authority, and ask it
          // first if the responder said the room is ahead of the secret we
          // were handed. See src/epoch.ts and docs/decisions.md.
          authority: roomAuthority(),
          expectedEpoch,
          onEpoch: onEpochChange,
          onRemoved: (notice) => leaveWithNotice(`You were removed from this room${notice.by ? ` by ${personLabel(notice.by)}` : ''}.`),
          onClosed: (notice) => leaveWithNotice(`This room was closed${notice.by ? ` by ${personLabel(notice.by)}` : ''}.`),
          // The indicator has to move the moment this device starts or stops
          // carrying somebody, not on the next poll tick.
          onRelayStart: () => renderAssist(),
          onRelayStop: () => renderAssist(),
          // The chips say which rung a connection is on, so they move when it does.
          onRoute: () => {
            if (session) render(session.participants(), meParticipant)
          },
        })
      : new RoomSession({
          transport,
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
          // Epochs: follow a rekey signed by the room's authority, and ask it
          // first if the responder said the room is ahead of the secret we
          // were handed. See src/epoch.ts and docs/decisions.md.
          authority: roomAuthority(),
          expectedEpoch,
          onEpoch: onEpochChange,
          onRemoved: (notice) => leaveWithNotice(`You were removed from this room${notice.by ? ` by ${personLabel(notice.by)}` : ''}.`),
          onClosed: (notice) => leaveWithNotice(`This room was closed${notice.by ? ` by ${personLabel(notice.by)}` : ''}.`),
          // The indicator has to move the moment this device starts or stops
          // carrying somebody, not on the next poll tick.
          onRelayStart: () => renderAssist(),
          onRelayStop: () => renderAssist(),
          // The chips say which rung a connection is on, so they move when it does.
          onRoute: () => {
            if (session) render(session.participants(), meParticipant)
          },
        })
    session = s
    meParticipant = s.participant

    s.onChange((views) => {
      render(views, meParticipant)
      renderInvites()
      renderHost()
    })
    s.onRemoteTrack(({ device, track }) => attachRemoteTrack(device, track))

    await s.join(currentAdverts(), currentClaims())
    s.publishTracks(activeTracks(), { audience })

    s.chat.onChange((messages) => {
      renderChat(messages)
      noteChatRead(messages)
    })
    renderChat(s.chat.messages())
    noteChatRead(s.chat.messages())
    // The side channels: what the agents say to each other, and what a
    // listening agent heard. Opened now rather than on demand, because a
    // relay replays a durable kind to a subscriber but a person opening
    // the panel an hour in should not have to wait for that.
    const agents = s.channel(AGENT_CHANNEL)
    agents.onChange((messages) => renderLog('agentLog', 'agentsCount', messages))
    renderLog('agentLog', 'agentsCount', agents.messages())
    const transcript = s.channel(TRANSCRIPT_CHANNEL)
    transcript.onChange((messages) => renderLog('transcriptLog', 'transcriptCount', messages))
    renderLog('transcriptLog', 'transcriptCount', transcript.messages())
    // And what a scribe made of the transcript. Asked for with !minutes in
    // the chat, which goes out as an ordinary message, so any scribe that
    // is listening sees it.
    const minutes = s.channel(MINUTES_CHANNEL)
    minutes.onChange((messages) => renderLog('minutesLog', 'minutesCount', messages))
    renderLog('minutesLog', 'minutesCount', minutes.messages())
    // Agent hosts say what they can run on the control channel; a person
    // asks on it. Asked once on arrival, so a host that has been quiet for
    // an hour says again.
    const control = s.channel(CONTROL_CHANNEL)
    control.onChange((messages) => ingestControl(messages))
    ingestControl(control.messages())
    control.send(encodeControl({ op: 'catalogue?' })).catch(() => {})
    if (s.epoch > 0) addSystemLine(`This room is in epoch ${s.epoch}.`)
    renderHost()

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
    sessionTransport = undefined
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

/**
 * The newest message on screen is the newest read, once it has actually
 * been on screen: a tab in the background is not being read, whatever its
 * log holds, so it catches up when it comes back. This is what the unread
 * count on the rooms list is measured against.
 */
function noteChatRead(messages: ChatMessage[]): void {
  if (document.visibilityState !== 'visible') return
  const roomId = currentRoomId()
  if (!roomId) return
  let newest = 0
  for (const m of messages) if (m.sentAt > newest) newest = m.sentAt
  if (newest > 0) markRead(deviceStore, roomId, newest)
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !session) return
  try {
    noteChatRead(session.chat.messages())
  } catch {
    // Not joined yet: there is no chat to have read.
  }
})

// ---------------------------------------------------------------------------
// Your rooms
//
// The rooms this device has been in, shown when the app opens with no link
// on it. Each is watched from outside while the list is on screen - see
// app/src/room-watch.ts - which needs the room key, and this list holds no
// keys of its own: it uses whatever the app already keeps. A room this
// device created has its key here for twelve hours; a room it was admitted
// to has it for the tab's session; a legacy link carries it. A room whose
// key this device does not hold right now says so, and opening it is what
// gets the key back.
// ---------------------------------------------------------------------------

const roomWatches = new Map<string, { pool: NostrRelayPool; watch: RoomWatch }>()
let roomsTimer: ReturnType<typeof setInterval> | undefined
/** Whether the list is what is on screen. Nothing below draws, or keeps a
 *  relay open, when it is not. */
let roomsListShown = false

/** The room secret behind a known room, when this device holds it. */
function secretForKnownRoom(link: RoomLink): Uint8Array | undefined {
  if (link.secret) return link.secret
  if (!link.invitation) return undefined
  return loadInvitationOwner(link.invitation)?.roomSecret ?? loadCachedAdmission(link.invitation)?.secret
}

function watchKnownRoom(room: KnownRoom): void {
  if (roomWatches.has(room.roomId)) return
  let link: RoomLink
  try {
    link = parseRoomLink(room.link)
  } catch {
    return
  }
  const secret = secretForKnownRoom(link)
  if (!secret) return
  const { roomId, roomKey } = deriveRoom(secret)
  // A key that does not open this room is not this room's key.
  if (roomId !== room.roomId) return
  const pool = new NostrRelayPool(link.relays.length ? link.relays : RELAYS)
  const watch = new RoomWatch({ transport: pool, roomId, roomKey, policy: link.policy, onChange: renderRooms })
  roomWatches.set(room.roomId, { pool, watch })
}

function stopWatching(roomId: string): void {
  const watched = roomWatches.get(roomId)
  if (!watched) return
  watched.watch.close()
  watched.pool.close()
  roomWatches.delete(roomId)
}

function showRoomsList(): void {
  roomsListShown = true
  const rooms = knownRooms(deviceStore)
  for (const room of rooms) watchKnownRoom(room)
  renderRooms()
  // Presence lapses by the clock, not by an event, so the list is redrawn
  // on a timer as well as on every change.
  if (rooms.length && roomsTimer === undefined) roomsTimer = setInterval(renderRooms, 5000)
}

/** The list goes away when a room comes on screen, and takes its relay
 *  connections with it: a page in a room watches nothing else. */
function hideRoomsList(): void {
  roomsListShown = false
  $('rooms').hidden = true
  if (roomsTimer !== undefined) {
    clearInterval(roomsTimer)
    roomsTimer = undefined
  }
  for (const roomId of [...roomWatches.keys()]) stopWatching(roomId)
}

function renderRooms(): void {
  if (!roomsListShown) return
  const rooms = knownRooms(deviceStore)
  $('rooms').hidden = rooms.length === 0
  const list = $('roomList')
  list.innerHTML = ''
  for (const room of rooms) list.append(roomRow(room))
}

function roomRow(room: KnownRoom): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'roomRow'
  row.dataset.room = room.roomId

  const main = document.createElement('div')
  main.className = 'roomMain'
  const heading = document.createElement('div')
  heading.className = 'roomTitleRow'
  // A name and the id beside it, for the reason a person's name has a key
  // beside it: two rooms can be called the same thing.
  const name = document.createElement('span')
  name.className = 'roomName'
  name.textContent = roomLabel(room)
  const id = document.createElement('span')
  id.className = 'pubkey'
  id.textContent = shortKey(room.roomId)
  id.title = room.roomId
  heading.append(name, id)
  main.append(heading, roomMeta(room))

  const actions = document.createElement('div')
  actions.className = 'roomActions'
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'open'
  open.textContent = 'Open'
  open.addEventListener('click', () => openKnownRoom(room))
  const forget = document.createElement('button')
  forget.type = 'button'
  forget.className = 'forget quiet'
  forget.textContent = 'Forget'
  forget.addEventListener('click', () => forgetKnownRoom(room))
  actions.append(open, forget)

  row.append(main, actions)
  return row
}

/** What is new and who is here, or why that cannot be said. */
function roomMeta(room: KnownRoom): HTMLDivElement {
  const meta = document.createElement('div')
  meta.className = 'roomMeta'
  const watched = roomWatches.get(room.roomId)
  if (!watched) {
    const note = document.createElement('span')
    note.className = 'unknown'
    note.textContent = 'Open it to catch up: this device does not hold its key right now.'
    meta.append(note)
    return meta
  }

  const unread = watched.watch.unread(room.readAt)
  const count = document.createElement('span')
  count.className = 'unread'
  count.dataset.count = String(unread)
  count.textContent = unread === 0 ? 'nothing new' : `${unread} unread`
  meta.append(count)

  const present = watched.watch.present()
  const here = document.createElement('span')
  here.className = 'here'
  here.dataset.count = String(present.length)
  if (present.length === 0) {
    // Presence is only what devices say of their own accord, once a
    // heartbeat: until one has had the chance to, an empty room is not yet
    // an empty room.
    here.textContent = watched.watch.settled ? 'nobody here' : 'listening for who is here\u2026'
    meta.append(here)
    return meta
  }
  const agents = present.filter((p) => p.agent).length
  const people = present.length - agents
  here.textContent =
    [people ? `${people} ${people === 1 ? 'person' : 'people'}` : '', agents ? `${agents} agent${agents === 1 ? '' : 's'}` : '']
      .filter(Boolean)
      .join(', ') + ' here:'
  meta.append(here)
  profiles.want(present.map((p) => p.participant))
  for (const p of present) {
    const chip = document.createElement('span')
    chip.className = 'hereChip'
    chip.append(identityRun(shownAs(p.participant, p.name), false))
    if (p.agent) {
      const badge = document.createElement('span')
      badge.className = 'badge agent'
      badge.textContent = 'agent'
      badge.title = 'This participant says it is an automated agent'
      chip.append(badge)
    }
    meta.append(chip)
  }
  return meta
}

/** Opening a room from the list is opening its link. */
function openKnownRoom(room: KnownRoom): void {
  // A fragment-only change is a same-document navigation, which never
  // re-runs this module; the reload is what reads the link.
  try {
    history.replaceState(null, '', room.link)
  } catch {
    location.href = room.link
  }
  location.reload()
}

function forgetKnownRoom(room: KnownRoom): void {
  if (!confirm(`Forget ${roomLabel(room)} on this device? Its link goes with it; you would need to be sent it again to come back.`)) return
  stopWatching(room.roomId)
  forgetRoom(deviceStore, room.roomId)
  renderRooms()
}

/** Back to the list: leave the room if in it, and open the app with no
 *  link on it. A reload for the same reason `leaveRoom` reloads. */
function backToRooms(): void {
  const s = session
  session = undefined
  sessionTransport = undefined
  s?.leave()
  history.replaceState(null, '', joinLinkBase())
  location.reload()
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('backToRooms').addEventListener('click', backToRooms)

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
    pairUrl.value = encodePairingUrl(joinLinkBase(), relays, iceUrls, code)
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
$('shareRoom').addEventListener('click', () => {
  shareRoomLink().catch((err) => setStatus(describeError(err)))
})
$('rotateShare').addEventListener('click', () => {
  if (!confirm('Replace the room link? This retires it in current KithMoot clients; existing members stay.')) return
  rotateRoomInvitation().catch((err) => setStatus(describeError(err)))
})

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
  sessionTransport = undefined
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
  stopInvitationHost()
  for (const roomId of [...roomWatches.keys()]) stopWatching(roomId)
})

setToggle('toggleAgentsHear', agentsMayHear)
$('toggleAgentsHear').addEventListener('click', () => setAgentsMayHear(!agentsMayHear))

$('agentForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('agentInput') as HTMLInputElement
  const text = input.value.trim()
  if (!text || !session) return
  input.value = ''
  session
    .channel(AGENT_CHANNEL)
    .send(text)
    .catch((err) => setStatus(describeError(err)))
})
;($('agentInput') as HTMLInputElement).maxLength = MAX_CHAT_TEXT_LENGTH

$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('chatInput') as HTMLInputElement
  const typed = input.value.trim()
  const attachments = stagedAttachments
  if ((!typed && attachments.length === 0) || !session) return
  // A file with nothing said about it still gets a caption, because the
  // caption is all a client that has never heard of attachments will show.
  const text =
    typed ||
    (attachments.length === 1
      ? `Shared a file${attachments[0]?.name ? `: ${attachments[0].name}` : ''}`
      : `Shared ${attachments.length} files`)
  input.value = ''
  stagedAttachments = []
  renderStaged()
  session.chat.send(text, attachments.length ? { attachments } : {}).catch((err) => setStatus(describeError(err)))
})

// ---------------------------------------------------------------------------
// Attaching a Wildbloom share to a message
// ---------------------------------------------------------------------------

/** What the next message will carry. Held here, not in the form, so the
 *  key is in one place until it is in the message and then nowhere. */
let stagedAttachments: ChatAttachment[] = []

function renderStaged(): void {
  const box = $('attachStaged')
  box.innerHTML = ''
  stagedAttachments.forEach((a, i) => {
    const chip = document.createElement('span')
    chip.className = 'attachChip'
    chip.textContent = `${a.name ?? 'Encrypted file'}${a.size !== undefined ? ` \u00b7 ${formatBytes(a.size)}` : ''} `
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'remove'
    remove.addEventListener('click', () => {
      stagedAttachments.splice(i, 1)
      renderStaged()
    })
    chip.append(remove)
    box.append(chip)
  })
  $('attachToggle').textContent = stagedAttachments.length ? `Attach (${stagedAttachments.length})` : 'Attach'
}

/**
 * The kind-1063 event behind what was pasted: the signed JSON itself, or an
 * id (hex, note1 or nevent1) looked up on the room's relays. Wildbloom shows
 * its uploader the id, so that is the common case; the JSON is for when the
 * event was published somewhere these relays never saw.
 */
async function resolveFileEvent(text: string): Promise<NostrEvent> {
  const value = text.trim()
  if (value.startsWith('{')) {
    let event: NostrEvent
    try {
      event = JSON.parse(value) as NostrEvent
    } catch {
      throw new Error('That is not event JSON.')
    }
    if (!verifyEventUncached(event)) throw new Error('That event JSON does not verify.')
    return event
  }
  let id = value.toLowerCase()
  if (/^(note1|nevent1)/.test(id)) {
    try {
      const decoded = nip19Decode(value)
      id = decoded.type === 'note' ? decoded.data : decoded.type === 'nevent' ? decoded.data.id : ''
    } catch {
      id = ''
    }
  }
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Paste the file event id (64 hex characters) or the event JSON.')
  const transport = new NostrRelayPool(relays)
  try {
    return await new Promise<NostrEvent>((resolve, reject) => {
      let off = (): void => {}
      const timer = setTimeout(() => {
        off()
        reject(new Error('The room\'s relays do not have that event. Paste the event JSON instead.'))
      }, 8_000)
      off = transport.subscribe([{ ids: [id] }], (event) => {
        if (event.id !== id || !verifyEventUncached(event)) return
        clearTimeout(timer)
        off()
        resolve(event)
      })
    })
  } finally {
    transport.close()
  }
}

/** What the chat carries for a file event, once the key is known. The
 *  event tells where the envelope is and what its bytes hash to; the source
 *  name and type are inside the envelope and stay there until it is opened. */
function shareFromEvent(event: NostrEvent, keyHex: string): ChatAttachment {
  if (event.kind !== 1063) throw new Error('That is not a file event (kind 1063).')
  const tag = (name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1]
  const url = tag('url')
  const sha256 = tag('x')
  const size = Number(tag('size'))
  if (!url || !/^https:\/\//i.test(url)) throw new Error('The file event has no https URL.')
  if (!sha256 || !/^[0-9a-fA-F]{64}$/.test(sha256)) throw new Error('The file event has no hash.')
  const share: ChatAttachment = { event: event.id, url, sha256: sha256.toLowerCase(), key: keyHex }
  if (Number.isSafeInteger(size) && size > 0) share.size = size
  return share
}

// ---------------------------------------------------------------------------
// Dropping a file straight into the chat
// ---------------------------------------------------------------------------

const BLOSSOM_SERVER_STORAGE_KEY = 'kithmoot.blossom-server'

/** The Blossom server this device sends dropped files to: what the person
 *  set in the Attach panel, else the app's default, else nothing. */
function blossomServer(): string {
  return localStorage.getItem(BLOSSOM_SERVER_STORAGE_KEY) ?? BLOSSOM_ENDPOINT
}

function storeBlossomServer(value: string): void {
  const trimmed = value.trim()
  if (!trimmed) {
    localStorage.removeItem(BLOSSOM_SERVER_STORAGE_KEY)
    return
  }
  // Refused here, before a byte is sealed: a mistyped server is found out
  // when it is typed, not when a file has been encrypted for nothing.
  localStorage.setItem(BLOSSOM_SERVER_STORAGE_KEY, normaliseBlossomServer(trimmed))
}

/** Something to look at while a file is sealed and sent. Stage by stage
 *  rather than byte by byte: fetch gives no upload progress, and a stage
 *  line with the file's name and size says what is being waited for. */
function dropProgress(stage: string, file: File): void {
  $('attachStatus').textContent = `${stage} ${file.name} (${formatBytes(file.size)})…`
}

/**
 * One dropped file, from bytes on this device to a staged attachment:
 * sealed here under a fresh key, put on the Blossom server as an opaque
 * blob, announced with a kind-1063 event on the room's relays, and then
 * staged exactly as a pasted Wildbloom share is. The device key signs the
 * upload and the announcement, so a hardware signer is never asked and a
 * relay learns only that this device shared some encrypted bytes. The key
 * goes into the staged attachment and nowhere else.
 */
async function shareDroppedFile(file: File): Promise<void> {
  const status = $('attachStatus')
  const transport = sessionTransport
  if (!session || !transport) throw new Error('Join the room first.')
  if (file.size > MAX_UPLOAD_SOURCE_BYTES) {
    throw new Error(`${file.name} is ${formatBytes(file.size)}; a room sends up to ${formatBytes(MAX_UPLOAD_SOURCE_BYTES)}.`)
  }
  if (file.size === 0) throw new Error(`${file.name} is empty.`)
  const server = blossomServer()
  if (!server) {
    $('attachPanel').hidden = false
    ;($('attachServer') as HTMLInputElement).focus()
    throw new Error('Name a Blossom server to put files on, then drop the file again.')
  }
  const origin = normaliseBlossomServer(server)
  const deviceSk = deviceKey()

  dropProgress('Encrypting', file)
  // Let the line above paint before the main thread is busy sealing.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const source = new Uint8Array(await file.arrayBuffer())
  let sealed: EncryptedEnvelope
  try {
    sealed = encryptEnvelope(source, { name: file.name, type: file.type })
  } finally {
    source.fill(0)
  }

  dropProgress(`Uploading to ${new URL(origin).hostname}:`, file)
  const descriptor = await uploadEnvelope(origin, sealed.envelope, { sign: (t) => finalizeEvent(t, deviceSk) })

  dropProgress('Announcing', file)
  const event = finalizeEvent(buildFileEvent(descriptor), deviceSk)
  await transport.publish(event)

  stagedAttachments.push({
    event: event.id,
    url: descriptor.url,
    sha256: descriptor.sha256,
    key: sealed.key,
    name: sealed.name,
    type: sealed.type,
    size: sealed.envelope.length,
  })
  renderStaged()
  status.textContent = ''
}

/** Files from a drop or the file input, one after another, stopping at the
 *  first that fails so the reason is the last thing on the line. */
async function shareDroppedFiles(files: FileList | File[] | null): Promise<void> {
  const status = $('attachStatus')
  const list = Array.from(files ?? [])
  if (!list.length) return
  $('attachPanel').hidden = false
  for (const file of list) {
    if (stagedAttachments.length >= MAX_CHAT_ATTACHMENTS) {
      status.textContent = `A message carries at most ${MAX_CHAT_ATTACHMENTS} files.`
      return
    }
    try {
      await shareDroppedFile(file)
    } catch (err) {
      // Shown here, not through setStatus, which also writes to the console.
      status.textContent = describeError(err)
      return
    }
  }
  $('attachPanel').hidden = true
  ;($('chatInput') as HTMLInputElement).focus()
}

;($('attachServer') as HTMLInputElement).value = blossomServer()
$('attachServer').addEventListener('change', () => {
  const input = $('attachServer') as HTMLInputElement
  try {
    storeBlossomServer(input.value)
    input.value = blossomServer()
    $('attachStatus').textContent = ''
  } catch (err) {
    $('attachStatus').textContent = describeError(err)
  }
})
$('attachFile').addEventListener('change', () => {
  const input = $('attachFile') as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  void shareDroppedFiles(files)
})

// Drag a file onto the chat form and it goes the same way. The class is
// only a visual cue that the drop will be taken.
const chatForm = $('chatForm')
for (const type of ['dragenter', 'dragover'] as const) {
  chatForm.addEventListener(type, (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    chatForm.classList.add('dropping')
  })
}
chatForm.addEventListener('dragleave', (event) => {
  if (event.relatedTarget instanceof Node && chatForm.contains(event.relatedTarget)) return
  chatForm.classList.remove('dropping')
})
chatForm.addEventListener('drop', (event) => {
  chatForm.classList.remove('dropping')
  if (!event.dataTransfer?.files.length) return
  event.preventDefault()
  void shareDroppedFiles(event.dataTransfer.files)
})

$('attachToggle').addEventListener('click', () => {
  const panel = $('attachPanel')
  panel.hidden = !panel.hidden
  if (!panel.hidden) $('attachFile').focus()
})
$('attachCancel').addEventListener('click', () => {
  $('attachPanel').hidden = true
})
$('attachAdd').addEventListener('click', async () => {
  const status = $('attachStatus')
  const eventInput = $('attachEvent') as HTMLInputElement
  const keyInput = $('attachKey') as HTMLInputElement
  if (stagedAttachments.length >= MAX_CHAT_ATTACHMENTS) {
    status.textContent = `A message carries at most ${MAX_CHAT_ATTACHMENTS} files.`
    return
  }
  status.textContent = 'Checking\u2026'
  try {
    const keyHex = parseRecoveryKey(keyInput.value)
    const event = await resolveFileEvent(eventInput.value)
    stagedAttachments.push(shareFromEvent(event, keyHex))
    // The key is in the staged message now and nowhere else on the page.
    keyInput.value = ''
    eventInput.value = ''
    status.textContent = ''
    renderStaged()
    $('attachPanel').hidden = true
    ;($('chatInput') as HTMLInputElement).focus()
  } catch (err) {
    // Shown here, not through setStatus, which also writes to the console.
    status.textContent = describeError(err)
  }
})

;($('chatInput') as HTMLInputElement).maxLength = MAX_CHAT_TEXT_LENGTH

// The effect controls start where the constants say they start, rather than
// where index.html happens to say they do: BLUR_ON_BY_DEFAULT is a product
// decision and it is meant to be one line to change.
;($('blurStrength') as HTMLInputElement).value = String(Math.round(DEFAULT_BLUR_STRENGTH * 100))
markSegmented('effectModes', 'mode', BLUR_ON_BY_DEFAULT ? 'blur' : 'off')
markSegmented('voicePresets', 'preset', DEFAULT_VOICE_PRESET)
$('effectMode').textContent = BLUR_ON_BY_DEFAULT ? 'blur' : 'off'
$('voiceMode').textContent = DEFAULT_VOICE_PRESET

roomFromLocation()
  .then((found) => {
    if (!found) {
      // No link: the front page, with the rooms this device has been in.
      showRoomsList()
      return
    }
    showRoomUi()
    renderIdentity()
    // Why the last page left, if the room told it to.
    try {
      const notice = sessionStorage.getItem(NOTICE_STORAGE_KEY)
      if (notice) {
        sessionStorage.removeItem(NOTICE_STORAGE_KEY)
        setStatus(notice)
      }
    } catch {
      // No storage, no notice.
    }
  })
  .catch((err) => {
    setStatus(describeError(err))
    showRoomsList()
  })

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
