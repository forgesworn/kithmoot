import { EmojiPicker } from './emoji-picker.js'
import { composerModels, modelCompletions, prepareModelMessage, type ComposerModel } from './composer-models.js'
import { REACTION_EMOJIS, reactionsFor, toggleReaction, reactionText } from '../../src/reactions.js'
import './style.css'
import { installUpdates } from './updates.js'
import { Outbox } from './outbox.js'
import { confirmAction, type ConfirmActionOptions } from './confirm-action.js'
import { ChatScroll } from './chat-scroll.js'
import { installReactionHold } from './reaction-hold.js'
import { showReactionFeedback } from './reaction-feedback.js'
import { installKeyboardNavigation } from './keyboard-navigation.js'
import { MessageActions, type MessageAction } from './message-actions.js'
import { ConversationSearch } from './conversation-search.js'
import { ShareViewer, type ShareSource } from './share-viewer.js'
import { ConversationDrafts, draftHasWork, type ConversationDraft } from './drafts.js'
import {
  browserDeviceStore,
  deviceKeyFor,
  forgetCredentialFor,
  forgetLegacyStorage,
  forgetKeptAdmission,
  isPairedSecondary,
  loadCredentialFor,
  loadKeptAdmission,
  storeCredentialFor,
  storeKeptAdmission,
  type SavedRoomAdmission,
} from './device-store.js'
import { INVITATION_OWNER_PREFIX, forgetRoomAccess, loadInvitationOwner as readInvitationOwner, storeInvitationOwner as writeInvitationOwner } from './invitation-store.js'
import { forgetRoom, knownRoom, knownRooms, markRead, rememberRoom, roomLabel, setKeepRoom, type KnownRoom } from './rooms-store.js'
import { roomProject, setRoomProject } from './room-projects.js'
import { RoomWatch } from './room-watch.js'
import { RoomBookmarks } from './room-bookmarks.js'
import { SpeakingMonitor } from './speaking-monitor.js'
import { participantVerification, rememberVerified } from './verified-store.js'
import { Notifier, notifySettings, setNotifySettings, titleWithCount, type Arrival, type NotificationContent } from './notify.js'
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
  requestPersistentRoomAdmission,
  encodePersistentInvitation,
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
  DEFAULT_APPROVAL_OPTIONS,
  encodeControl,
  decodeControl,
  verifyAdmins,
  verifyChannels,
  CHANNEL_NAME,
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
  encodeRoomLink,
  type RoomLink,
  type RelayConfig,
  type EncryptedEnvelope,
  DonationLedger,
  ringTier,
  resolveConversation,
  mentionedBy,
  mentionsOf,
  ROOM_MENTION_PATTERN,
  sameRef,
  refKey,
  retractionText,
  inviteText,
  MAX_MENTIONS,
  dmPolicy,
  dmPeer,
  preferredDm,
  sealInvite,
  openInvite,
  localPeerCrypt,
  signerSelfCrypt,
  type ResolvedMessage,
  type SendOptions,
  type PeerCrypt,
} from '../../src/index.js'
import type { InvitationRequest } from '../../src/invitation.js'
import { ReadPositionSync } from './read-positions.js'
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
import { LANE_GLYPH, LANE_LABEL, LANE_MEANING, type Lane } from '../../src/lane.js'
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
import { RelayConnections, RelaySettingsPanel, profilePreference } from './relay-settings.js'
import { renderQr } from './qr.js'
import { login, logout, restoreSession, type SignetSession } from 'signet-login'
import { ContextPanel } from './context-panel.js'
import { AssignmentPanel } from './assignment-panel.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode, decode as nip19Decode } from 'nostr-tools/nip19'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'

const outbox = new Outbox(document.getElementById('outbox')!, refreshRoomNavigation)
const chatScroll = new ChatScroll(document.getElementById('chatLog')!, document.getElementById('newMessages') as HTMLButtonElement)
const conversationSearch = new ConversationSearch(document, selectChannel)
const messageActions = new MessageActions()
installReactionHold($('chatLog'))
for (const target of [$('chatLog'), window]) target.addEventListener('scroll', () => {
  document.querySelectorAll<HTMLElement>('.reactionDetails:popover-open').forEach(details => details.hidePopover())
}, { passive: true })
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  document.querySelectorAll<HTMLElement>('.reactionDetails:popover-open').forEach(details => details.hidePopover())
  if (!$('callBay').hidden && !callIsLive() && !document.querySelector('dialog[open]')) setCallOpen(false)
})

const shareViewer = new ShareViewer({
  onAnnotation: annotation => session?.publishAnnotation(annotation),
})
const emojiPicker = new EmojiPicker()
window.addEventListener('pagehide', () => shareViewer.close())
let drafts = new ConversationDrafts()
// Only this tab holds draft text and file keys. Switching rooms retains the
// originating collection; closing the tab still discards it.
const roomDrafts = new Map<string, ConversationDrafts>()
const roomReadSets = new Map<string, Map<string, Set<string>>>()
let switchingRoom = false
let roomGeneration = 0
let roomOperation = 0

function draftRoomKey(): string {
  return `${nostrSession?.pubkey ?? 'visitor'}:${currentRoomId()}`
}

function selectRoomDrafts(): void {
  const key = draftRoomKey()
  drafts = roomDrafts.get(key) ?? new ConversationDrafts()
  roomDrafts.set(key, drafts)
  conversationRead = roomReadSets.get(key) ?? new Map()
  roomReadSets.set(key, conversationRead)
  restoreDraft()
}

function closeAllDrafts(): void {
  drafts.close()
  for (const collection of roomDrafts.values()) collection.close()
  roomDrafts.clear()
  roomReadSets.clear()
}

function switchingBlocked(): boolean {
  return joining || roomOperation > 0 || startingDm || assignmentPanel.busy || outbox.pending || drafts.pending().some(draft => draft.job)
}

function refreshRoomNavigation(): void {
  renderWorkspace()
  if (($('roomSwitcher') as HTMLDialogElement).open) renderRoomSwitcher()
}
let navigationApproved = false
function approvedReload(): void {
  navigationApproved = true
  location.reload()
}
installUpdates(() => {
  if (hasUnsentWork()) return 'Send or discard your unfinished messages, files and Shared Work drafts before updating. Your work stays here until then.'
  if (micTrack?.enabled || cameraTrack?.enabled || screenTrack?.enabled) return 'Turn off your microphone, camera and screen share before updating. You can keep using this version.'
  if (remoteAudios.size > 0 || remoteVideos.size > 0) return 'Your call is still receiving audio or video. Leave the room or wait for the call to finish before updating.'
  if (pendingMedia.size > 0) return 'Finish setting up your microphone, camera or screen share before updating.'
  if (switchingBlocked()) return 'Finish the current action before updating. You can keep using this version.'
  return undefined
}, () => {
  if (session) {
    // Only navigation intent enters storage, never private drafts or files.
    // The normal arrival checks admission and the restored account again.
    try {
      sessionStorage.setItem(ROOM_SWITCH_KEY, JSON.stringify({ hash: location.hash, account: nostrSession?.pubkey ?? null, at: Date.now() }))
    } catch { /* Without tab storage, the normal room door remains available. */ }
  }
  approvedReload()
})

function hasUnsentWork(): boolean {
  captureDraft()
  return outbox.pending || assignmentPanel.busy || assignmentPanel.hasDrafts || drafts.pending().length > 0 || [...roomDrafts.values()].some(collection => collection.pending().length > 0)
}

// Relays confirmed live for this room kind. relay.trotters.cc is the
// project's own relay, so it goes first; nos.lol and relay.primal.net are
// third-party fallbacks. relay.damus.io returned 503 during the stage 2
// acceptance run and was dropped from the default list for that reason -
// "no relay is load-bearing" already covers a room carrying a dead relay
// in its hints, but there is no reason to default new rooms to one that is
// currently flaky. Change this list, not code elsewhere, if a relay in it
// goes down again.
const DEFAULT_RELAYS = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net']
const relayStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
}
const relayConnections = new RelayConnections(relayStorage, DEFAULT_RELAYS)
let RELAYS = relayConnections.configuration('default').map(relay => relay.url)
let roomRelayScope = 'default'
function configuredPool(urls: string[]): NostrRelayPool {
  return relayConnections.pool(urls === RELAYS ? 'default' : roomRelayScope, urls === RELAYS ? [] : urls === relays ? roomRelayConfig : urls)
}

// The room names its own STUN/TURN, carried in the join URL like the relay
// hints already are - hardcoding an operator's server here is exactly the
// kind of central dependency this project exists to avoid. This is only a
// sensible default for a room that never set its own.
const DEFAULT_ICE_URLS = ['stun:stun.l.google.com:19302']

/**
 * Whether the last ICE resolution produced a relay (a `turn:` server with a
 * credential). The route ladder's last rung is called TURN whatever this
 * says, so a tile on that rung read "connecting via TURN…" on a device that
 * had no relay to connect through - the credential endpoint had failed or
 * the room's link named its own servers - and the person waited on a
 * promise nobody had made. Read by `connectingWord`.
 */
let turnRelayConfigured = false
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
// told otherwise in the Attach panel. The app's own origin: the box that
// serves it runs a Blossom server of its own behind /upload and /blossom/
// (deploy/README.md, "Running a Blossom server"), on the same terms as its
// TURN server, a default and not a dependency. A Blossom server sees an
// encrypted blob and the device key that signed the upload, nothing else,
// but which server sees that is still the person's choice, made once in
// the Attach panel and remembered on this device. An operator hosting this
// app for a community names their own here, or sets it to '' and the panel
// asks, which is what Wildbloom itself does.
const BLOSSOM_ENDPOINT = 'https://kithmoot.forgesworn.dev'

// The donor ring: a coloured ring on a profile picture showing what somebody
// has put into the project, summed in this browser from public zap receipts.
// Nothing is gated by it and nobody is asked for anything. See
// `src/donations.ts` for the three checks that make the number real, and
// `deploy/README.md`, "Turning the donor ring on", for switching it on.
//
// TWO SETTINGS, AND BOTH ARE REQUIRED. Leave either empty and the feature is
// entirely dark: no rings, no endpoint lookup, no relay traffic, nothing on
// the console. That is the default and a fork that wants no such thing does
// nothing to keep it.
//
// The address is where the money goes, and its own endpoint is asked at
// runtime which key signs its receipts - never hardcoded here, so a wallet
// that changes provider or drops zap support takes the ring dark rather than
// leaving it accepting whatever turns up.
//
// This is the project's own address, and it is also the funding address of
// the `spoken-token` dependency - which is not a coincidence and is not a
// mistake: both are forgesworn's. It was briefly emptied on 4 September 2026
// by somebody who found it in package-lock.json, matched it to a dependency,
// and concluded it belonged to that dependency's author. It did. The
// dependency's author is us.
//
// The check that would have settled it in one step is the package's own
// `author` field, not the lockfile entry that carries the address. A
// repository is allowed to contain the same true fact twice.
const DONATION_ADDRESS = 'profusemeat89@walletofsatoshi.com'
// The Nostr pubkey a donation has to be addressed to, in hex. This is NOT the
// same thing as the address, and it is not optional: the address above is at
// a custodial wallet whose signing key is shared with every other customer of
// that wallet, so a receipt bearing that signature proves the money reached
// the provider and not that it reached us. The recipient named inside the
// donor's own signed request is what says who was paid. Empty until the
// project settles which of its identities zaps should be addressed to.
const DONATION_RECIPIENT = ''

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The one line the page uses to say something went wrong, or that something
 * is happening.
 *
 * It is painted in the danger colour, which is right for a failure and
 * wrong for "hold on". A person following a link met "Opening the private
 * room…" in red before they had done anything, and red on a first screen
 * says you have broken it. So a message can say which of the two it is.
 *
 * And a third: finished. "Getting you in…" is a promise, and a promise
 * needs an ending. Left in the progress style it sat under a working way in
 * for as long as the person looked at it, so the page said it was still
 * working while the button beside it said go. A reader cannot be asked to
 * decide which of those to believe.
 */
function setStatus(message: string, tone: 'problem' | 'progress' | 'done' = 'problem'): void {
  const el = $('status')
  el.textContent = message
  el.classList.toggle('progress', tone === 'progress')
  el.classList.toggle('done', tone === 'done')
  if (message && tone === 'problem') console.error(message)
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
// The picker's Advanced group also takes a pasted key - an nsec, or a
// NIP-49 ncryptsec that is decrypted here with its password. That key lives
// in memory for this page only and is gone on reload; signet-login never
// writes it anywhere. It is the dangerous option and is labelled as such.
//
// Both satisfy `ParticipantIdentity` (src/identity.ts): a pubkey and an
// async signEvent. Nothing else in the app has to know which one it has,
// because the participant key signs exactly one thing - the device
// credential - and does it once per room.
// ---------------------------------------------------------------------------

const PARTICIPANT_STORAGE_KEY = 'kithmoot.participant'
const NAME_STORAGE_KEY = 'kithmoot.name'
const ACCOUNT_STORAGE_KEY = 'kithmoot.last-nostr-account'
// Read only the SDK's public identity hint before restore can clear it.
// This is a reminder to reconnect, never proof of identity or permission.
let expectedAccount: string | undefined
try {
  const saved = localStorage.getItem(ACCOUNT_STORAGE_KEY) ?? localStorage.getItem('signet:login.pubkey')
  if (saved && /^[0-9a-f]{64}$/.test(saved)) expectedAccount = saved
} catch { /* The active session still identifies this visit. */ }
function rememberAccount(pubkey: string): void {
  expectedAccount = pubkey
  try { localStorage.setItem(ACCOUNT_STORAGE_KEY, pubkey) } catch { /* Optional persistence. */ }
}
function needsAccountReconnect(): boolean {
  return !!expectedAccount && !nostrSession && !loadCredential()
}


// Device keys and device credentials are kept PER ROOM - see
// `device-store.ts` for why a relay must never see one device key across
// two rooms. The single shared key this replaces is forgotten on load.
const deviceStore = browserDeviceStore(localStorage)
forgetLegacyStorage(deviceStore)

const nowSeconds = () => Math.floor(Date.now() / 1000)
let identityRestoring = true
let rememberAfterRestore = false
let identityGeneration = 0
let loginBusy = false

/** The room this page is in, once a link has been read. Everything a device
 *  keeps is keyed on it; before a room is known there is nothing to keep. */
function currentRoomId(): string | undefined {
  return (roomSecret as Uint8Array | undefined) ? deriveRoom(roomSecret).roomId : undefined
}

/** Write the room this page is in down as one this device has been in -
 *  see `app/src/rooms-store.ts`. The link kept is the one this app would
 *  hand on, which never carries a pairing code. */
function rememberCurrentRoom(): void {
  // Admission need not wait for a signer, but storing its bookmark must
  // wait until we know whether this is the visitor or the account's visit.
  if (identityRestoring) { rememberAfterRestore = true; return }
  const roomId = currentRoomId()
  if (!roomId) return
  try {
    const room = rememberRoom(roomStore(), {
      roomId,
      name: roomName,
      link: encodeRoomUrl(joinLinkBase(), relays, iceUrls),
      openedAt: nowSeconds(),
    })
    bookmarks?.save(room)
    refreshKeptAdmission()
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
  const credential = roomId ? loadCredentialFor(deviceStore, roomId) : undefined
  // Signing in chooses an identity. A paired credential belongs to its
  // issuer and must never silently put that account in as somebody else.
  return credential && (!nostrSession || credential.pubkey === nostrSession.pubkey) ? credential : undefined
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
/** Whether a NIP-07 signer is injected into this page: an extension such as
 *  nos2x, Alby or Bark, or the Android signer's page-side shim. */
function extensionSignerPresent(): boolean {
  return typeof window !== 'undefined' && 'nostr' in window && window.nostr !== undefined && window.nostr !== null
}

function currentParticipant(): string | undefined {
  if (nostrSession) return nostrSession.pubkey
  const existing = loadParticipantKey()
  if (existing) return getPublicKey(existing)
  return undefined
}

async function signInWithNostr(): Promise<void> {
  contextPanel.close()
  if (loginBusy) return
  if (session || joining) throw new Error('Leave the room before changing your Nostr account.')
  loginBusy = true
  identityGeneration++
  let account: SignetSession | null
  try {
    account = await login({ appName: 'KithMoot', relayUrls: RELAYS,
      // 'nsec' is the dangerous route, kept behind Advanced by the picker:
      // a pasted nsec, or a NIP-49 ncryptsec plus its password, held in
      // memory for this page only. It exists for dogfooding and for people
      // with no signer yet; the copy in the picker says what it costs.
      methods: ['nip07', 'amber', 'remote-signet', 'local-signet', 'bunker', 'nostrconnect', 'nsec'] })
  } finally { loginBusy = false; tryPendingJoin() }
  if (!account) return // cancelled or timed out - leave the page as it was

  // An auth-only account proves who somebody is and then cannot sign
  // anything else. That is fine for a site that just wants a login; it is
  // useless here, because the one thing this app needs a participant key
  // for is signing a device credential per room.
  if (!account.signer.capabilities.canSignEvents) {
    await logout(account)
    throw new Error(
      'That sign-in can prove who you are but cannot sign anything afterwards, ' +
        'and a room needs one signature per join. Try an extension or a bunker.',
    )
  }

  // Not the account this app knew. An extension holds several accounts and
  // signs in with whichever is selected, so "reconnect" can quietly come
  // back as somebody else, with none of the rooms saved under the first.
  // Say so, once, rather than leaving a person to work out why their rooms
  // are gone.
  const previous = expectedAccount
  nostrSession = account
  rememberAccount(account.pubkey)
  startRoomBookmarks(account)
  profiles.want([account.pubkey])
  renderIdentity()
  if (previous && previous !== account.pubkey) {
    const now = shownAs(account.pubkey), before = shownAs(previous)
    setStatus(`Signed in as ${now.name ?? now.npub}. Last time this was ${before.name ?? before.npub}, and the rooms saved under that account are not here. To get them back, select that account in your extension and sign in again.`)
  }
}

async function signOutOfNostr(): Promise<void> {
  contextPanel.close()
  if (session || joining) throw new Error('Leave the room before signing out.')
  identityGeneration++
  const account = nostrSession
  bookmarks?.close()
  bookmarks = undefined
  readSync?.close()
  readSync = undefined
  nostrSession = undefined
  sessionStorage.removeItem(WAY_BACK_KEY)
  $('roomSyncStatus').textContent = ''
  refreshAccountRooms()
  renderIdentity()
  if (account) await logout(account)
}

let bookmarks: RoomBookmarks | undefined
function roomStore() { return bookmarks?.rooms ?? deviceStore }

/**
 * Read positions, kept the same on every device that holds this identity.
 * Gated exactly as bookmarks are: a signer with NIP-44. A visitor's key
 * lives in one browser, so there is nothing to keep in step and no reason
 * to tell a relay what that key has read. See app/src/read-positions.ts.
 */
let readSync: ReadPositionSync | undefined

function followReadPositions(roomId: string, roomKey: Uint8Array): void {
  readSync?.follow(roomId, roomKey, { '': { at: knownRoom(roomStore(), roomId)?.readAt ?? 0 } })
}

function refreshAccountRooms(): void {
  for (const roomId of [...roomWatches.keys()]) stopWatching(roomId)
  if (roomsListShown) showRoomsList()
}

function startRoomBookmarks(account: SignetSession): void {
  bookmarks?.close()
  bookmarks = new RoomBookmarks(deviceStore, account.signer, relayConnections.pool('default'), () => {
    if (roomsListShown) {
      const rooms = knownRooms(roomStore())
      const ids = new Set(rooms.map(room => room.roomId))
      for (const roomId of roomWatches.keys()) if (!ids.has(roomId)) stopWatching(roomId)
      for (const room of rooms) watchKnownRoom(room)
      if (rooms.length && roomsTimer === undefined) roomsTimer = setInterval(renderRooms, 5000)
      renderRooms()
    }
    renderWorkspace()
    if (($('roomSwitcher') as HTMLDialogElement).open) renderRoomSwitcher()
  }, message => {
    $('roomSyncStatus').textContent = message
    if (message.includes('not confirmed') || message.includes('not synced') || message.includes('browser only')) {
      const details = $('roomSyncStatus').closest('details')
      if (details) details.open = true
      if (!roomsListShown) setStatus(message)
    }
  })
  refreshAccountRooms()
  bookmarks.start()
  readSync?.close()
  readSync = account.signer.nip44
    ? new ReadPositionSync(account.signer, signerSelfCrypt({ pubkey: account.signer.pubkey, nip44: account.signer.nip44 }), relayConnections.pool('default'), (roomId, positions) => {
        const at = positions['']?.at
        if (at === undefined) return
        markRead(roomStore(), roomId, at)
        if (roomsListShown) renderRooms()
      })
    : undefined
  // The room this page is in, and every room the list is watching, from
  // wherever this identity had read to on another device.
  const current = currentRoomId()
  if (current && (roomSecret as Uint8Array | undefined)) followReadPositions(current, deriveRoom(roomSecret).roomKey)
  for (const [roomId, watched] of roomWatches) followReadPositions(roomId, watched.watch.roomKey)
  // A sign-in at the door saves this room, not the visitor's past rooms.
  rememberCurrentRoom()
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
  v?: 2 | 3
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
        v: roomInvitationCapability.persistent ? 3 : 2,
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
let roomRelayConfig: RelayConfig[] = relayConnections.configuration('default')
function useRoomRelays(hints: string[] = []): void {
  roomRelayConfig = relayConnections.configuration(roomRelayScope, hints)
  relays = roomRelayConfig.map(relay => relay.url)
}
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

const ADMISSION_CACHE_PREFIX = 'kithmoot.admission.v1.'
let admittedRoom: SavedRoomAdmission | undefined

function ownerStorageKey(invitation: RoomInvitation): string {
  return INVITATION_OWNER_PREFIX + deriveInvitationId(invitation)
}

function storeInvitationOwner(invitation: RoomInvitation, room: Uint8Array, hostSk: Uint8Array): void {
  try { writeInvitationOwner(deviceStore, invitation, room, hostSk, nowSeconds()) }
  catch (error) {
    // A temporary meeting can still run entirely in this tab. A group must
    // retain its creator authority before offering durable access to others.
    if (invitation.persistent) throw error
  }
}

function loadInvitationOwner(invitation: RoomInvitation): { roomSecret: Uint8Array; inviterSk: Uint8Array } | undefined {
  try { return readInvitationOwner(deviceStore, invitation, nowSeconds()) } catch { return undefined }
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
  delegateSk?: string
  delegation?: InvitationDelegation[]
  persistent?: true
  /** What the responder said the room's epoch was. See `RoomAdmission.epoch`. */
  epoch?: number
}

function cacheAdmission(invitation: RoomInvitation, admission: SavedRoomAdmission): void {
  try {
    const value: StoredAdmission = {
      roomSecret: bytesToHex(admission.secret),
      ...('delegate' in admission
        ? { delegateSk: bytesToHex(admission.delegate.delegateSk), delegation: admission.delegate.chain }
        : { persistent: true as const }),
      ...(admission.epoch !== undefined ? { epoch: admission.epoch } : {}),
    }
    sessionStorage.setItem(ADMISSION_CACHE_PREFIX + deriveInvitationId(invitation), JSON.stringify(value))
  } catch {
    // A reload will simply repeat the one-tap admission exchange.
  }
}

function loadCachedAdmission(invitation: RoomInvitation): SavedRoomAdmission | undefined {
  try {
    const raw = sessionStorage.getItem(ADMISSION_CACHE_PREFIX + deriveInvitationId(invitation))
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<StoredAdmission>
    if (
      typeof value.roomSecret !== 'string'
    ) return undefined
    const secret = hexToBytes(value.roomSecret)
    if (secret.length !== 32) return undefined
    if (value.persistent === true && invitation.persistent && value.epoch === 0) return { secret, persistent: true, epoch: 0 }
    if (typeof value.delegateSk !== 'string' || !Array.isArray(value.delegation)) return undefined
    const delegateSk = hexToBytes(value.delegateSk)
    if (secret.length !== 32 || delegateSk.length !== 32) return undefined
    const admission: RoomAdmission = { secret, delegate: { delegateSk, chain: value.delegation } }
    if (Number.isSafeInteger(value.epoch) && (value.epoch as number) >= 0) admission.epoch = value.epoch
    return admission
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Keeping a room on this device
//
// Temporary meetings default to tab storage, with an optional twelve-hour
// local admission. Groups retain membership by default until forgotten, with
// a per-room opt-out. In both cases the tab cache supports ordinary reloads.
// ---------------------------------------------------------------------------

/** Membership held by a joiner, separate from any expiring permission to
 * answer temporary invitations. A group member needs no responder key. */
function currentJoinerAdmission(): SavedRoomAdmission | undefined {
  return admittedRoom
}

/** Refresh locally remembered membership. Only temporary admissions expire. */
function refreshKeptAdmission(): void {
  const roomId = currentRoomId()
  const invitation = roomInvitationCapability
  if (!roomId || !invitation) return
  if (!knownRoom(roomStore(), roomId)?.keep) return
  const admission = currentJoinerAdmission()
  if (!admission) return
  try {
    storeKeptAdmission(deviceStore, deriveInvitationId(invitation), admission, nowSeconds())
  } catch {
    // Storage may be unavailable. The room still opens; only the way to
    // read it later goes unwritten.
  }
}

function setKeepRoomChoice(on: boolean): void {
  const roomId = currentRoomId()
  if (!roomId || !roomInvitationCapability) return
  if (!setKeepRoom(roomStore(), roomId, on)) {
    rememberCurrentRoom()
    setKeepRoom(roomStore(), roomId, on)
  }
  if (on) refreshKeptAdmission()
  else forgetKeptAdmission(deviceStore, deriveInvitationId(roomInvitationCapability))
  renderKeepChoice()
}

// ---------------------------------------------------------------------------
// Asking before letting people in.
//
// A temporary room's link makes a newcomer ask, and any device in the room
// holding the invitation answers. With this switch on, that device asks its
// owner first: a card names who is asking, with Let in and Decline. There is
// no refusal on the wire; a declined person sees the room not answer, and
// the door tells them somebody has to accept them. Remembered per room on
// this device, because it is this device's owner who is asked.
// ---------------------------------------------------------------------------

const KNOCK_KEY_PREFIX = 'kithmoot.knock.v1.'
/** How long a newcomer waits to be let in, and how long the card stays.
 *  Long enough for a person to notice and press a button. */
const KNOCK_WAIT_MS = 120_000

function knockOn(roomId: string): boolean {
  return deviceStore.get(KNOCK_KEY_PREFIX + roomId) === 'true'
}

function setKnock(roomId: string, on: boolean): void {
  if (on) deviceStore.set(KNOCK_KEY_PREFIX + roomId, 'true')
  else deviceStore.remove(KNOCK_KEY_PREFIX + roomId)
}

interface Knock extends InvitationRequest { at: number; resolve: (yes: boolean) => void }
const knocks = new Map<string, Knock>()

function knockLabel(knock: InvitationRequest): string {
  if (knock.participant) return shownAs(knock.participant, knock.name).name ?? shortKey(knock.participant)
  return knock.name ?? `Somebody (${shortKey(knock.device)})`
}

function askToLetIn(request: InvitationRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const knock: Knock = { ...request, at: nowSeconds(), resolve }
    knocks.set(knock.request, knock)
    setStatus(`${knockLabel(knock)} wants to join. Let them in from the card above the conversation.`)
    renderApprovals()
    setTimeout(() => {
      if (!knocks.delete(knock.request)) return
      resolve(false)
      renderApprovals()
    }, KNOCK_WAIT_MS)
  })
}

function answerKnock(knock: Knock, yes: boolean): void {
  if (!knocks.delete(knock.request)) return
  knock.resolve(yes)
  addSystemLine(yes ? `You let ${knockLabel(knock)} in.` : `You declined ${knockLabel(knock)}.`)
  renderApprovals()
}

function forgetKnocks(): void {
  for (const knock of knocks.values()) knock.resolve(false)
  knocks.clear()
}

/** The switch in Room details, for a device that answers this room's link
 *  and could ask first. A self-service room has nobody to ask. */
function renderKnockChoice(): void {
  const row = $('knockRow')
  const roomId = currentRoomId()
  const answers = roomId !== undefined && roomInvitationCapability !== undefined && !roomInvitationCapability.persistent && invitationAuthoritySk !== undefined
  row.hidden = !answers
  if (!answers) return
  const on = knockOn(roomId)
  setToggle('toggleKnock', on)
  $('knockNote').textContent = on
    ? 'Somebody who opens the link waits until you let them in.'
    : 'Anyone who opens the link comes straight in while you are here.'
}

/** The switch, shown to a joiner holding an admission, or to one who kept
 *  one earlier and may want to stop. The creator's own record is already
 *  on these terms, so the creator is not asked. */
function renderKeepChoice(): void {
  renderKnockChoice()
  const row = $('keepRow')
  const roomId = currentRoomId()
  const on = roomId !== undefined && knownRoom(roomStore(), roomId)?.keep === true
  const creator = invitationAuthoritySk !== undefined && invitationDelegation.length === 0
  row.hidden = creator || !roomId || !roomInvitationCapability || (!currentJoinerAdmission() && !on)
  setToggle('toggleKeep', on)
  $('toggleKeep').setAttribute('aria-pressed', String(on))
  $('keepNote').textContent = roomInvitationCapability?.persistent
    ? on
      ? 'This device remembers your membership until you forget the room. You can return when everyone else is offline.'
      : 'Membership is kept only for this tab. You can use the group invitation to return later.'
    : on
    ? 'On: this device keeps the room\u2019s key for twelve hours after each visit, so your rooms list can check for new messages and tell you about them with no tab open. Forgetting the room throws the key away.'
    : 'Off: this device only holds the room\u2019s key while a tab is open on it. Until you switch this on, your rooms list cannot check this room and nothing will tell you about it.'
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
  if (!invitation || !invitationAuthoritySk || invitation.persistent) return
  invitationTransport = configuredPool(relays)
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
      ...(knockOn(deriveRoom(roomSecret).roomId) ? { admit: askToLetIn } : {}),
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
        setStatus('Whoever made this link has replaced it, so it no longer lets anybody new in. The room itself carries on as it was.')
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
  setStatus('This link was replaced in another tab, so it no longer lets anybody new in. The room itself carries on as it was.')
})

let session: RoomSession | undefined
let joining = false
let iceRefreshTimer: ReturnType<typeof setInterval> | undefined
/** The relay pool the session publishes through, for a file dropped into
 *  the chat to announce itself on. Set and cleared with `session`. */
let sessionTransport: NostrRelayPool | undefined
let meParticipant = ''
let myDeviceId = ''

// ---------------------------------------------------------------------------
// How a person is shown
//
// Three rules, and they are the whole of it:
//
//   1. A name NEVER stands alone. A short pubkey renders beside it, always,
//      so two people who both typed "Robin" are visibly two people and an
//      impersonation is visible rather than convincing.
//   2. A name is text, never markup. Everything below goes in through
//      `textContent`; nothing here ever touches innerHTML except to empty a
//      container. See src/display-name.ts.
//   3. A published Nostr identity is marked as such, and a typed name is
//      not marked as anything. The anonymous path is the default and the
//      normal way to use this - it is not a lesser one.
// ---------------------------------------------------------------------------

/**
 * Where a kind-0 profile is looked for, beyond the room's own relays.
 *
 * A room on somebody's own box, or a keeper's, holds the room's events and
 * nothing else; a member's profile lives wherever they published it, which
 * for almost everybody is the public relays. Asked only on the room's
 * relays, a person who signed in with a real Nostr account still showed as
 * a short code beside their name. purplepag.es exists to aggregate exactly
 * this kind; the rest are the big general relays. Only ever read from, and
 * only while the "show public profiles" switch is on: that switch is what
 * decides whether participant keys leave the room's relays at all.
 */
const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

const profiles = new ProfileBook({
  relays: () => [...new Set([...relays, ...PROFILE_RELAYS])],
  // Its own scope. Under the room's scope this pool's wider list counted
  // towards the room's relay health, and the door waited on public relays
  // the room never chose before it would show Join.
  transport: (urls) => relayConnections.pool('profiles', urls),
  onChange: () => {
    renderIdentity()
    if (session) {
      render(session.participants(), meParticipant)
      // The conversation on screen, not the main chat regardless - a
      // profile landing while somebody reads the Agents tab must not swap
      // what is under the tab they picked. See `repaintActiveChat`.
      repaintActiveChat()
    }
    renderRooms()
  },
})

let profilesEnabled = profilePreference(relayStorage)
profiles.setEnabled(profilesEnabled)
;($('lookupProfiles') as HTMLInputElement).checked = profilesEnabled
$('roomProfileSettings').textContent = `Profile pictures: ${profilesEnabled ? 'on' : 'off'}`
$('lookupProfiles').addEventListener('change', () => {
  const enabled = ($('lookupProfiles') as HTMLInputElement).checked
  profilesEnabled = enabled
  try { localStorage.setItem('kithmoot.profiles.enabled', String(enabled)) } catch { /* The switch still applies to this visit. */ }
  profiles.setEnabled(enabled)
  $('roomProfileSettings').textContent = `Profile pictures: ${enabled ? 'on' : 'off'}`
  if (session) {
    render(session.participants(), meParticipant)
    repaintActiveChat()
  }
  renderIdentity()
})

/**
 * What each person has put into the project, if that has been switched on.
 *
 * Given the same relays as the profile book, because a lookup should follow
 * the room. It asks those relays for receipts addressed to the PROJECT and
 * nothing else - no participant pubkey is ever in its filter - so it inherits
 * the relay correlation `profiles.ts` documents without adding to it.
 */
const donations = new DonationLedger({
  address: DONATION_ADDRESS,
  recipient: DONATION_RECIPIENT,
  relays: () => relays,
  transport: (urls) => configuredPool(urls),
  fetch: (...args) => fetch(...args),
  onChange: () => {
    if (session) render(session.participants(), meParticipant)
  },
})

/** Twelve hex characters is enough to read aloud and to tell two ROOM ids
 *  apart at a glance. Room ids are not keys and are never shown as npubs. */
function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 12)}\u2026`
}

/** The start of the npub: what a person would recognise from their own
 *  profile, and never raw hex, which reads as a bug to anybody who is not a
 *  developer. */
function shortNpub(pubkey: string): string {
  return `${npubOf(pubkey).slice(0, 13)}\u2026`
}

/**
 * Every name that has been drawn for every key, so that "two people are
 * called Robin" is known wherever either of them is drawn next - on a tile,
 * a chat line or a chip - and not only when both are on the roster.
 * Names compare case-insensitively and trimmed, because "robin" and
 * "Robin " are the same claim to a reader.
 */
const namesSeen = new Map<string, Set<string>>()
let collisionsChanged = false
function noteName(pubkey: string, name: string | undefined): void {
  if (name === undefined) return
  const key = name.trim().toLocaleLowerCase()
  if (!key) return
  let keys = namesSeen.get(key)
  if (!keys) namesSeen.set(key, keys = new Set())
  if (keys.has(pubkey)) return
  keys.add(pubkey)
  // A second key behind a name that was drawn alone until now: everything
  // already on screen under that name needs its code.
  if (keys.size === 2) collisionsChanged = true
}
function nameCollides(pubkey: string, name: string | undefined): boolean {
  if (name === undefined) return true
  const keys = namesSeen.get(name.trim().toLocaleLowerCase())
  return keys !== undefined && (keys.size > 1 || !keys.has(pubkey))
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
  pubkey: string
  /** What to call them, or undefined when nobody typed anything. */
  name?: string
  /** Always present: the short npub. */
  short: string
  npub: string
  picture?: string
  nip05?: string
  /** True when this key has a kind-0 profile on a relay - which makes it a
   *  published Nostr identity, NOT a verified name. See profiles.ts. */
  nostr: boolean
  /** Verified sats into the project, or undefined when unknown or when the
   *  donor ring is switched off. See `src/donations.ts`. */
  sats?: number
}

/** Resolve everything a tile or a chat line needs to show one person. */
function shownAs(pubkey: string, asserted?: string): Shown {
  const profile: Profile | undefined = profiles.get(pubkey)
  // Only a published identity is asked about, so a per-device key is never
  // even looked up: there is nothing to attribute a payment to. Cheap on
  // every render by design - it does nothing for a total that is still
  // fresh, and nothing at all when the feature is off.
  if (profile !== undefined) donations.want([pubkey])
  const name = profile?.name ?? asserted
  noteName(pubkey, name)
  return {
    pubkey,
    name,
    short: shortNpub(pubkey),
    npub: npubOf(pubkey),
    picture: profile?.picture,
    nip05: profile?.nip05,
    nostr: profile !== undefined,
    sats: donations.sats(pubkey),
  }
}

/** How a figure reads in a tooltip: 1500 sats, not 1500. */
const SATS = new Intl.NumberFormat(undefined, { useGrouping: true })

/**
 * The profile picture, ringed by what this person has put in.
 *
 * The ring is drawn nowhere else, so a tile, a roster chip and a chat line
 * cannot disagree about somebody. Below the lowest band there is no ring at
 * all rather than a grey one, so having given nothing is quiet; a per-device
 * key gets no ring and no placeholder either, because it has no identity a
 * payment could be attributed to.
 */
function pictureOf(shown: Shown, withFallback = false): HTMLElement | undefined {
  const fallback = document.createElement('span')
  fallback.className = 'avatar initials'
  fallback.setAttribute('aria-hidden', 'true')
  fallback.textContent = [...(shown.name?.trim() || shown.short)][0]?.toLocaleUpperCase() ?? '?'
  if (shown.picture === undefined) return withFallback ? fallback : undefined
  const avatar = document.createElement('img')
  avatar.className = 'avatar'
  avatar.src = shown.picture
  avatar.alt = ''
  avatar.loading = 'lazy'
  avatar.referrerPolicy = 'no-referrer'
  // A picture that will not load must not leave a broken icon sitting where
  // a person's face was supposed to be, nor an empty ring around nothing.
  avatar.addEventListener('error', () => {
    const picture = avatar.closest('.donorRing') ?? avatar
    if (withFallback) picture.replaceWith(fallback)
    else picture.remove()
  })

  const tier = ringTier(shown)
  if (tier === undefined) return avatar

  const ring = document.createElement('span')
  ring.className = `donorRing ${tier.ring}`
  // Says the figure, says what it is computed against, and says who is
  // vouching for it, which is nobody. The arithmetic happened in this
  // browser out of receipts anybody can read.
  ring.title = `${SATS.format(shown.sats ?? 0)} sats zapped to ${donations.address} (${shortKey(donations.recipient)}). Worked out in this browser from public zap receipts, and asserted by nobody.`
  ring.append(avatar)
  return ring
}

/** Build the name-and-key run that identifies one person. Deliberately the
 *  only place that decides what a person looks like, so a tile and a chat
 *  line can never drift apart on it. */
function identityRun(shown: Shown, isSelf: boolean, withAvatarFallback = false, withKey = false): DocumentFragment {
  const run = document.createDocumentFragment()

  // The picture, and the donor ring around it, live here rather than in one
  // caller, so that "wherever this person is drawn" is a single decision and
  // the ring reads as part of the same system as the badges below it.
  const picture = pictureOf(shown, withAvatarFallback)
  if (picture) run.append(picture)

  if (shown.name !== undefined) {
    const name = document.createElement('span')
    name.className = 'name'
    // textContent, never innerHTML: this is somebody else's text.
    name.textContent = shown.name
    run.append(name)
  }

  // The code, only when it is doing work: no name at all, two people in
  // view making the same claim, or a line whose whole point is "which key
  // is this" - who you are about to go in as, and your own account line.
  if (withKey || nameCollides(shown.pubkey, shown.name)) {
    const key = document.createElement('span')
    key.className = 'pubkey'
    key.textContent = shown.short
    key.title = shown.npub
    run.append(key)
  }

  if (shown.nip05) {
    const address = document.createElement('span')
    address.className = 'nip05'
    address.textContent = shown.nip05.startsWith('_@') ? shown.nip05.slice(2) : shown.nip05
    address.title = 'This domain maps the Nostr address to this public key.'
    run.append(address)
  }

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
 * "agent of <principal>", for an agent whose principal has said so. Only
 * ever built from `ParticipantView.owner` or `ChatMessage.owner`, both of
 * which exist only when the library verified the proof itself: an agent
 * that merely says it is somebody's gets the plain badge and nothing more.
 */
function ownerRun(owner: { principal: string; label?: string }): DocumentFragment {
  const run = document.createDocumentFragment()
  const of = document.createElement('span')
  of.className = 'ownerOf'
  of.textContent = ' works for '
  of.title = owner.label ? `The person it works for calls it ${owner.label}, and signed to say so.` : 'The person it works for signed to say so.'
  run.append(of)
  const principalName = session?.participants().find((v) => v.participant === owner.principal)?.name
  run.append(identityRun(shownAs(owner.principal, principalName), owner.principal === meParticipant))
  return run
}

/**
 * Which way in this device is on, and what that means.
 *
 * It used to sit on the identity line, where it ran to three lines of prose
 * directly above the button somebody was looking for - and on a 375 by 540
 * phone, which is a real iPhone SE once Safari has taken its chrome, those
 * three lines were the difference between seeing the way forward and seeing
 * a form with nothing under it. It is a sentence about names and codes, so
 * it sits with the other one, a line in.
 */
function renderHowIn(): void {
  const how = $('nameHow')
  const participant = currentParticipant()
  if (loadCredential()) {
    how.textContent = 'This device is paired with another one of yours, so it goes in as the same person.'
  } else if (nostrSession) {
    how.textContent = 'Signed in with Nostr. Your key stays where it is kept; this page never holds it.'
  } else if (participant) {
    how.textContent = 'A name only, with a key of its own. Agents that know you by your Nostr account will not recognise it.'
  } else {
    how.textContent = 'A name only. A key of its own is made the first time you go in.'
  }
  $('sheetHow').textContent = how.textContent
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
  $('retryRoomSync').hidden = nostrSession === undefined
  $('accountHeading').textContent = nostrSession ? 'Your Nostr account' : 'Keep your rooms with you'
  $('accountLead').textContent = nostrSession
    ? (nostrSession.signer.nip44 ? 'Your room links follow this key.' : 'Rooms are saved in this browser only with this signer.')
    : 'Sign in as yourself, with your Nostr profile and the public key your agents recognise. Your rooms can follow you across devices.'
  $('accountHelp').textContent = nostrSession
    ? 'Rooms you open while signed in are saved to this account. Your signer encrypts their names and links; relays can see your public key and that you use KithMoot. Visitor history is not uploaded.'
    : 'Sign in to find your rooms across devices. Your signer keeps your key and encrypts your room bookmarks. Visiting someone else? Open their invitation link; no sign-in is needed.'
  const accountProfile = $('accountProfile')
  accountProfile.replaceChildren()
  accountProfile.hidden = !nostrSession
  if (nostrSession) {
    profiles.want([nostrSession.pubkey])
    accountProfile.append(identityRun(shownAs(nostrSession.pubkey), true, true, true))
  }
  $('joinNostr').hidden = !!nostrSession || !!loadCredential()
  // A signer extension in this browser, and no account signed in here: the
  // door used to show a visitor with the typed name and a small link, and
  // a person whose extension was connected read that as the app about to
  // invent an account for them. The extension is the identity they mean,
  // so it is the filled button, and the visitor path says what it is. An
  // installed PWA has its own storage, which is how a sign-in done in a
  // tab is not there in the app; the extension is.
  const extensionHere = extensionSignerPresent()
  $('joinNostr').textContent = needsAccountReconnect() ? (extensionHere ? 'Reconnect with your Nostr extension' : 'Reconnect Nostr account')
    : extensionHere ? 'Join with your Nostr extension' : 'Already on Nostr? Sign in'
  $('joinNostr').classList.toggle('primary', extensionHere)
  $('joinNostr').classList.toggle('linkish', !extensionHere)
  $('joinVisitor').hidden = !needsAccountReconnect()
  if (!joining) $('join').textContent = needsAccountReconnect() ? 'Reconnect to join' : extensionHere ? 'Join with just a name' : 'Join'
  $('join').classList.toggle('primary', !extensionHere)
  $('join').classList.toggle('quiet', extensionHere)
  // The filled button comes first. With the extension the order is: the
  // name, join with the extension, then the visitor way in and its line.
  const joinNostr = $('joinNostr'), join = $('join')
  if (extensionHere && joinNostr.nextElementSibling !== join) join.before(joinNostr)
  else if (!extensionHere && join.nextElementSibling !== $('whoami')) $('joinIdentityHelp').before(joinNostr)
  $('previousAccount').hidden = !needsAccountReconnect()
  $('previousAccount').textContent = needsAccountReconnect()
    ? `Your previous Nostr account is disconnected (${npubEncode(expectedAccount!)}). Reconnect it to speak as yourself.` : ''
  const sending = $('sendingIdentity')
  sending.replaceChildren()
  sending.hidden = !session
  if (session) {
    const visitor = !nostrSession && !loadCredential()
    const shown = shownAs(meParticipant, joiningName())
    const label = visitor ? 'Name only' : 'Nostr'
    const description = `Sending as ${visitor ? 'visitor' : 'Nostr account'}: ${shown.name ?? label}. ${shown.npub}${shown.nip05 ? `. ${shown.nip05}` : ''}`
    sending.title = description
    sending.setAttribute('aria-label', description)
    const choice = document.createElement(visitor ? 'button' : 'span')
    choice.className = visitor ? 'visitorIdentity quiet' : 'sendingAccount'
    const kind = document.createElement('span')
    kind.textContent = label
    choice.append(kind)
    if (shown.name) {
      const name = document.createElement('span')
      name.className = 'sendingName'
      name.textContent = ` · ${shown.name}`
      choice.append(name)
    }
    if (visitor) {
      ;(choice as HTMLButtonElement).type = 'button'
      choice.addEventListener('click', async () => {
        if (await confirmRoomAction({ title: 'Sending with just a name', message: `${description}. This is a separate identity, not your Nostr account. Agents may not recognise you. Leave the room to sign in with your usual Nostr account.`, confirmLabel: 'Leave to sign in', cancelLabel: 'Keep chatting' })) ($('leave') as HTMLButtonElement).click()
      })
    }
    sending.append(choice)
  }
  // Said once you are in, in Room details, where "how am I in here" is a
  // question somebody actually asks. At the door it was three lines between
  // the person and the name field.
  $('joinIdentityHelp').textContent = ''
  $('joinIdentityHelp').hidden = true
  renderRooms()

  const line = $('whoami')
  line.textContent = ''

  const name = joiningName()
  const participant = session ? meParticipant : loadCredential()?.pubkey ?? currentParticipant()
  if (participant) profiles.want([participant])

  // Nothing to say until there is a name or a key to say it about. An
  // identity line that reads "nobody in particular yet" is two lines of the
  // entry screen spent telling somebody what they already know.
  line.hidden = name === undefined && participant === undefined
  if (line.hidden) {
    renderHowIn()
    renderNudgeChoice()
    return
  }

  line.append(session ? 'In this room as ' : 'Going in as ')

  if (participant) {
    line.append(identityRun(shownAs(participant, name), false, false, true))
    if (!session && !nostrSession && extensionSignerPresent() && !needsAccountReconnect()) {
      const aside = document.createElement('span')
      aside.className = 'whoamiAside'
      aside.textContent = ' with just a name. Your Nostr extension is here and not in use yet.'
      line.append(aside)
    }
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

  renderHowIn()
  renderNudgeChoice()
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
const pendingMedia = new Set<CameraPipeline | MicPipeline>()
let backgroundId = BACKGROUNDS[0]?.id ?? ''
let videoInputs: MediaDeviceInfo[] = []

const localPreviewEls = new Map<'camera' | 'screen', HTMLVideoElement>()
/** The marks overlay on each preview of a screen share, own or received -
 *  see `ShareViewer.overlay`. Swept when the preview leaves the page. */
const shareMarkOverlays = new Map<HTMLVideoElement, () => void>()
/** Drop the overlay of any preview that has left the page. Deferred, because
 *  a render builds tiles before it attaches them, and a preview mid-move
 *  reads as disconnected for a moment it will not stay disconnected. */
function sweepShareMarkOverlays(): void {
  setTimeout(() => {
    for (const [video, dispose] of shareMarkOverlays) if (!video.isConnected) { dispose(); shareMarkOverlays.delete(video) }
  }, 0)
}
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

/**
 * One tile per participant, kept between renders.
 *
 * `render()` used to empty the grid and build every tile again, on every
 * roster change - which, with heartbeats every twenty seconds from every
 * device, is several times a minute in a small call. Each rebuild took
 * every <video> out of the document and put it back in the same pass,
 * which Chromium survives without pausing the picture but not without
 * dropping its compositing layer: a black flash on every face, on a
 * regular beat, for the whole call. Now the box stays, and only the words
 * around the picture are rebuilt.
 */
const tileBoxes = new Map<string, HTMLDivElement>()
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
  return parseRoomLink(url).invitation
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
  // One parser for every link the app opens, so the bounds it enforces -
  // fragment size, how many relays and ICE servers a link may name, and
  // that a public relay is wss - hold here as they do in the library.
  const parsedLink = parseRoomLink(location.href)

  // The room's name, when the link says. Text a stranger wrote, so it gets
  // the display-name treatment before it lands anywhere.
  roomName = parsedLink.name

  const invitation = parsedLink.invitation
  const knownSecret = secretForKnownRoom(parsedLink)
  roomRelayScope = `room:${knownSecret ? deriveRoom(knownSecret).roomId : deriveInvitationId(invitation!)}`
  if (invitation) {
    roomInvitationCapability = invitation
    useRoomRelays(parsedLink.relays)
    roomPolicy = parsedLink.policy

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
      // This tab's session first, then what the person chose to keep on
      // this device, then the live rendezvous.
      const saved = loadCachedAdmission(invitation) ?? loadKeptAdmission(deviceStore, deriveInvitationId(invitation), nowSeconds())
      // An updated group link must load its signed durable invitation once,
      // so an earlier temporary grant cannot keep the twelve-hour storage rule.
      const cached = invitation.persistent && saved && 'delegate' in saved ? undefined : saved
      if (cached) {
        roomSecret = cached.secret
        admittedRoom = cached
        invitationAuthoritySk = 'delegate' in cached ? cached.delegate.delegateSk : undefined
        invitationDelegation = 'delegate' in cached ? cached.delegate.chain : []
        expectedEpoch = cached.epoch
        cacheAdmission(invitation, cached)
        serveCurrentInvitation()
      } else {
        setStatus(invitation.persistent ? 'Getting you in…' : 'Asking to be let in…', 'progress')
        const transport = configuredPool(relays)
        try {
          // A temporary room's link is answered by a person, who may have
          // been asked first: the request says who is asking, and the wait
          // is long enough for somebody to read a card and press a button.
          const askedAs = joiningName()
          const askedFrom = currentParticipant()
          const admission = invitation.persistent
            ? await requestPersistentRoomAdmission({ transport, invitation })
            : await requestRoomAdmissionCapability({
              transport, invitation, timeoutMs: KNOCK_WAIT_MS,
              ...(askedAs !== undefined ? { name: askedAs } : {}),
              ...(askedFrom !== undefined ? { participant: askedFrom } : {}),
            })
          roomSecret = admission.secret
          roomRelayScope = `room:${deriveRoom(roomSecret).roomId}`
          useRoomRelays(parsedLink.relays)
          admittedRoom = admission
          invitationAuthoritySk = 'delegate' in admission ? admission.delegate.delegateSk : undefined
          invitationDelegation = 'delegate' in admission ? admission.delegate.chain : []
          expectedEpoch = admission.epoch
          cacheAdmission(invitation, admission)
          // The ending to "Getting you in…". It says the waiting is over
          // and that the next move is the reader's, which is the thing they
          // could not tell while a line saying "in progress" sat under a
          // button that was ready to be pressed.
          setStatus('You are on the list. Go in when you are ready.', 'done')
        } finally {
          transport.close()
        }
        serveCurrentInvitation()
      }
    }
  } else {
    const { secret, relays: hinted, policy } = parsedLink
    if (!secret) throw new Error('join URL carries neither an invitation nor a secret')
    roomSecret = secret
    useRoomRelays(hinted)
    roomPolicy = policy
    roomInvitationCapability = undefined
    invitationAuthoritySk = undefined
    invitationDelegation = []
  }

  profiles.setEnabled(false); profiles.setEnabled(profilesEnabled)
  iceUrls = parsedLink.iceUrls.length ? parsedLink.iceUrls : DEFAULT_ICE_URLS

  if (parsedLink.pairingCode) {
    // Drop the code out of the address bar first: it is single-use and there
    // is no reason for it to sit somewhere it could be forwarded by accident.
    const code = parsedLink.pairingCode
    history.replaceState(null, '', encodeRoomUrl(joinLinkBase(), relays, iceUrls))
    pairWithPrimary(code).catch((err) => setStatus(describeError(err)))
  }

  // Admitted, one way or another: this is now a room this device has been
  // in, and the list on the front page will offer it again - and, if the
  // person chose to keep it here, readable from there.
  rememberCurrentRoom()
  refreshKeptAdmission()
  return true
}

/**
 * Ask the primary device for a credential and remember it.
 *
 * The participant key is not transferred and never has been: what arrives is
 * a credential for this room that expires, signed by the other device.
 */
async function pairWithPrimary(code: Uint8Array): Promise<void> {
  const generation = roomGeneration
  ++roomOperation
  // Joining before the credential lands would mint a fresh participant key
  // and put this device in the room as a stranger - the exact thing pairing
  // exists to avoid. So the button is held until the exchange settles.
  const joinBtn = $('join') as HTMLButtonElement
  joinBtn.disabled = true
  setStatus('Asking your other device to add this one\u2026')

  const { roomId, roomKey } = deriveRoom(roomSecret)
  const transport = configuredPool(relays)
  try {
    const credential = await requestPairing({
      transport,
      roomId,
      roomKey,
      code,
      deviceSk: deviceKey(),
    })
    if (generation !== roomGeneration) return
    storeCredential(credential)
    setStatus('This device is now part of that person. Join when ready.')
  } finally {
    transport.close()
    --roomOperation
    if (generation === roomGeneration) joinBtn.disabled = false
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
  if (!TURN_CREDENTIAL_ENDPOINT || !isDefaultIceUrls(urls)) {
    turnRelayConfigured = urls.some((iceUrl) => iceUrl.toLowerCase().startsWith('turn'))
    return base
  }

  const turnServer = await fetchTurnCredential(TURN_CREDENTIAL_ENDPOINT)
  turnRelayConfigured = turnServer !== undefined
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
    return 'Nothing has been measured yet. Once there is video or sound moving, this will say what helping one pair really costs, instead of guessing.'
  }
  return (
    `About ${bitrate(perPair)} of what you send, for each pair you help, and the same again coming in. ` +
    `Three pairs at full stretch is about ${bitrate(perPair * MAX_ASSISTED_PAIRS)} going out.`
  )
}

/** Why this device is not being recommended, or cannot help at all, in the
 *  order somebody would want to hear it. */
function blockSentence(block: AssistBlock): string {
  switch (block) {
    case 'no-relay-support':
      return 'This browser cannot pass video on without unpacking it first, so it cannot help anybody. Chrome and Edge can. Safari and Firefox look like they can but have never actually managed it.'
    case 'not-publicly-reachable':
      return 'Other people cannot reach this device directly through your router, going by the addresses it found. Offering to help would point them at a way in that is not there.'
    case 'no-spare-uplink':
      return uplink.measured()
        ? 'Your connection has nothing left over once your own call is paid for.'
        : 'Your connection has not been measured yet. Join a room, give it a few seconds, and this fills in.'
    case 'mobile':
      return formFactor() === undefined
        ? 'This browser will not say whether it is a phone. If it is, leave this off.'
        : 'This is a phone. Helping somebody uses its battery and its signal for as long as they need it.'
    case 'on-battery':
      return 'Running on battery. Helping somebody means sending steadily and working hard, and you will notice.'
    case 'metered':
      return 'This connection is one you pay for by the amount used, or you have asked to save data. Somebody is paying for every byte.'
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
      'Not offered on a phone using mobile data. Helping somebody would spend your data and your battery on their call.'
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
      : `Your connection has room to spare, so it could help other people get through. ${costSentence()}`
    indicator.classList.remove('mine')
    return
  }

  const pairs = peerRelay.pairs
  if (pairs.length === 0) {
    indicator.textContent = soft.length
      ? `Offering to help. Nobody has needed it yet. ${soft.map(blockSentence).join(' ')}`
      : 'Offering to help. Nobody has needed it yet.'
    indicator.classList.remove('mine')
    return
  }

  // Named rather than counted: "carrying Priya and Sam" is a thing somebody
  // can check against the room in front of them, and a number is not.
  const carried = pairs.map((pair) => `${nameOfDevice(pair.a)} and ${nameOfDevice(pair.b)}`).join(', ')
  const stats = peerRelay.stats
  indicator.textContent =
    `Helping ${pairs.length} of ${peerRelay.max}: ${carried}. ` +
    `About ${bitrate(costPerPairBps() * pairs.length)} going out, ${quantity(stats.bytesOut)} passed on so far.`
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
  const generation = roomGeneration
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
      if (generation !== roomGeneration) return
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

/** Whether this browser is the one that opened this room, as opposed to
 *  one that followed a link into it. A joiner is handed a delegated key of
 *  its own, so the presence of a key says nothing about which of the two
 *  you are; only having been here when the room was made does. */
let startedHere = false

async function startNewRoom(): Promise<void> {
  // "People ask, and somebody lets them in" is a temporary-style room: the
  // link makes a person ask, and a device in the room answers - after
  // asking its owner, see `askToLetIn`. It cannot be self-service from the
  // relay, which is exactly the point, and it is why such a room needs
  // somebody online to let people in.
  const ask = (document.querySelector('input[name="roomAccess"]:checked') as HTMLInputElement | null)?.value === 'ask'
  const persistent = !ask
  const secret = generateRoomSecret()
  const created = createRoomInvitation(persistent)
  setKnock(deriveRoom(secret).roomId, ask)
  const relayScope = `room:${deriveRoom(secret).roomId}`
  // Snapshot access modes too: an invitation carries URLs, so reconstructing
  // this room from its link must not turn a read-only default into a writer.
  relayConnections.inheritDefaults(relayScope)
  // Persist the owner's recovery before publishing. Failure leaves the form
  // usable and never offers a link whose asynchronous admission was not saved.
  storeInvitationOwner(created.invitation, secret, created.inviterSk)
  if (persistent) await publishGroupInvitation(created.invitation, secret, created.inviterSk, RELAYS)
  startedHere = true
  admittedRoom = undefined
  expectedEpoch = 0
  roomPolicy = undefined
  roomSecret = secret
  roomInvitationCapability = created.invitation
  invitationAuthoritySk = created.inviterSk
  invitationDelegation = []
  roomRelayScope = relayScope
  useRoomRelays()
  iceUrls = parseIceInput()
  roomName = sanitiseDisplayName(($('roomName') as HTMLInputElement).value)
  profiles.setEnabled(false); profiles.setEnabled(profilesEnabled)
  serveCurrentInvitation()
  history.replaceState(null, '', encodeRoomUrl(joinLinkBase(), relays, iceUrls))
  rememberCurrentRoom()
}

/**
 * The door, and only the door.
 *
 * A person handed a link came to read what was said and to say something
 * back. Everything used to set a room UP - the camera, the share link, the
 * pairing pass, the notification switch - waits behind `showRoomTools()`
 * until they are actually inside, because until then none of it has
 * anything to be about. What is left is a name and a way in.
 */
function showRoomUi(): void {
  $('home').hidden = true
  $('identity').hidden = false
  $('identityMore').hidden = false
  $('joinRoomForm').hidden = false
  $('arrivalActions').hidden = true
  $('arrivalActions').before($('status'))
  $('nostrOption').hidden = nostrSession === undefined
  $('nostrOption').append($('accountHome'))
  $('accountHome').hidden = false
  $('setup').hidden = true
  $('notify').hidden = true
  hideRoomsList()
  // At the door of a room the way back to the list is here, because the
  // room's own bar does not exist until you are inside. The way back INTO a
  // room has been taken.
  $('roomNav').hidden = false
  $('doorToRooms').hidden = false
  $('backToRoom').hidden = true
  forgetWayBack()
  renderRoomTitle()
  // The tagline has just gone and the way back has just appeared, so where
  // the room starts is not where it started a moment ago.
  renderKeepChoice()
  renderArrival()
  $('join').hidden = false
  tryPendingJoin()
  ;($('shareUrl') as HTMLInputElement).value = encodeRoomUrl(joinLinkBase(), relays, iceUrls)
  ;($('shareRoom') as HTMLButtonElement).hidden = navigator.share === undefined
  ;($('rotateShare') as HTMLButtonElement).hidden =
    roomInvitationCapability === undefined || invitationAuthoritySk === undefined || invitationDelegation.length !== 0
  // The sentence about a new link goes with the button that makes one.
  // Only the browser that opened the room has that button, so everybody
  // else was reading about a control that was not on their page.
  $('rotateNote').hidden = ($('rotateShare') as HTMLButtonElement).hidden
  $('makePersistent').hidden = Boolean(roomInvitationCapability?.persistent) || $('rotateNote').hidden
  $('invitationAvailability').textContent = roomInvitationCapability?.persistent
    ? 'This group stays available when everyone closes the app. Anyone with this invitation can join and read its shared history.'
    : 'Keep a member’s tab open to admit newcomers. Temporary invitation permissions last up to twelve hours.'
}

/** Everything that is not the conversation, revealed once there is a
 *  conversation for it to be about - which now means putting it in the
 *  room's details rather than on the screen. */
function showRoomTools(): void {
  // In the room now, and the room's own bar carries the way out of it.
  $('roomNav').hidden = true
  $('doorToRooms').hidden = true
  $('workspaceNav').hidden = false
  $('invitePeople').hidden = Boolean(roomPolicy?.members?.length)
  renderWorkspace()
  // Notifications are a front-page control as well as a room one, so the
  // markup lives in `main` for the rooms list. In a room it belongs in the
  // details with everything else, and it is moved rather than duplicated:
  // one element, one set of listeners, one truth about its state. Leaving
  // a room reloads the page, so it never needs moving back.
  $('notify').hidden = false
  $('notifySlot').append($('notify'))
  // The one line the page uses to say something went wrong belongs where
  // the person is looking. It is written in `main` for the join screen and
  // the rooms list; in a room it moves under the box to write in, because
  // the room takes the whole screen and anything after it is below the
  // fold. Moved rather than duplicated, and leaving a room reloads.
  $('roomArea').append($('status'))
}

/**
 * The call.
 *
 * Camera, microphone and screen share were three buttons on the message
 * screen at all times, in a room where most of the time nobody is on a
 * call. A phone shows call controls during a call and a call button the
 * rest of the time; so does this. Anything of yours that is live keeps the
 * controls open, because a control that hides while it is doing something
 * is how a camera ends up on with nobody watching.
 */
function setCallOpen(open: boolean): void {
  const bay = $('callBay')
  bay.hidden = !open
  // The controls themselves start hidden in the markup, because until the
  // room is on screen there is nothing for them to be about.
  $('deviceControls').hidden = !open
  $('callToggle').setAttribute('aria-expanded', String(open))
  $('callToggle').dataset.on = String(open)
}

function callIsLive(): boolean {
  return Boolean(micTrack ?? cameraTrack ?? screenTrack)
}

// ---------------------------------------------------------------------------
// The call, as a thing.
//
// Until September 2026 "a call" meant "this device has a track": nobody could
// start one for other people to join, and a person with everything switched
// off looked exactly like one who had never joined. Now a call is a
// membership carried on presence - see `RosterEntry.call` - so Start, Join,
// Leave and "Rowan started a call, 2 on it" are all things the room can say.
// ---------------------------------------------------------------------------

/** On the call, whatever is or is not switched on. */
function onCall(): boolean {
  return session?.call !== undefined
}

/**
 * Pressed Leave, and not Join since.
 *
 * Not the same as "not on the call". Somebody who has just walked into a
 * room where a call is on sees and hears it before pressing anything - the
 * media acceptance test pins that, and it is right: a person is not a
 * spectator for having brought nothing. Somebody who has pressed Leave has
 * said the opposite, and for them the pictures park and the sound stops
 * until they press Join.
 */
let leftCall = false

function newCallId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** Start a call, or join the one that is on. The same act: say which call
 *  this device is on. Nothing is switched on by joining; the controls are. */
async function joinCall(): Promise<void> {
  const s = session
  if (!s || s.call) return
  const existing = s.calls()[0]
  leftCall = false
  await s.setCall({ id: existing?.id ?? newCallId(), since: nowSeconds() })
  setCallOpen(true)
  updateUi()
}

/** Everything of this device's that was live, off, and the previews with it.
 *  Shared by leaving a call and closing the room. */
function stopLocalMedia(): void {
  micTrack?.removeEventListener('ended', onMicEnded)
  for (const track of activeTracks()) track.stop()
  mic?.stop()
  camera?.stop()
  for (const pipeline of pendingMedia) pipeline.stop()
  pendingMedia.clear()
  mic = camera = undefined
  micTrack = cameraTrack = screenTrack = undefined
  micClaimedAt = monitorClaimedAt = undefined
  besideAnotherDevice = false
  for (const video of localPreviewEls.values()) { video.srcObject = null; video.remove() }
  localPreviewEls.clear()
}

/** Off the call. The room, and everybody else's call, carry on. */
async function leaveCall(): Promise<void> {
  const s = session
  stopLocalMedia()
  speakingMonitor.retain([...remoteAudios.keys()])
  publishActiveTracks()
  leftCall = true
  if (s) await s.setCall(null)
  setCallOpen(false)
  updateUi()
  if (session) render(session.participants(), meParticipant)
}

/**
 * The call button, the banner, and who is on it. Called from `render`, so
 * it follows presence: a call somebody else started shows up the moment
 * their heartbeat says so, and ends when the last of them stops saying so.
 */
function renderCallState(views: ParticipantView[]): void {
  const calls = session?.calls() ?? []
  const mineOn = onCall()
  const button = $('callToggle')
  const current = calls[0]
  button.textContent = mineOn ? 'On call' : current ? 'Join call' : 'Call'
  button.dataset.live = String(mineOn)
  button.title = mineOn ? 'Your call controls' : current ? 'A call is on in this room' : 'Start a call in this room'

  const banner = $('callBanner')
  banner.hidden = mineOn || !current
  if (current && !mineOn) {
    const on = views.filter(view => view.call?.id === current.id).sort((a, b) => (a.call?.since ?? 0) - (b.call?.since ?? 0))
    const starter = on[0]
    const who = starter ? (shownAs(starter.participant, starter.name).name ?? 'Somebody') : 'Somebody'
    const others = current.participants.length - 1
    $('callBannerText').textContent = others > 0 ? `${who} started a call · ${current.participants.length} on it` : `${who} started a call`
  }

  if (mineOn && current) {
    const names = views.filter(view => view.call?.id === current.id && view.participant !== meParticipant)
      .map(view => shownAs(view.participant, view.name).name ?? 'somebody')
    $('callWho').textContent = names.length === 0 ? 'On the call. Nobody else yet.' : `On the call with ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}.`
  }
}

// ---------------------------------------------------------------------------
// Room details
//
// A modal dialog rather than a panel on the page: it traps focus, Escape
// closes it, and the browser draws the backdrop. Everything that used to
// compete with the conversation is in here, one tap from the bar.
// ---------------------------------------------------------------------------

function openRoomSheet(): void {
  const sheet = $('roomSheet') as HTMLDialogElement
  if (sheet.open) return
  if (session) renderSheetRoster(session.participants(), meParticipant)
  renderSheetRoom()
  renderChannels()
  sheet.showModal()
  sheet.scrollTop = 0
}

function closeRoomSheet(): void {
  const sheet = $('roomSheet') as HTMLDialogElement
  if (sheet.open) sheet.close()
}

/** Who invited you, and to what, in the one sentence somebody needs before
 *  they type their name in. A room you started yourself says so instead:
 *  "you have been invited" is not true of your own room. */
function renderArrival(): void {
  const lead = $('arrivalLead')
  const roomId = currentRoomId()
  if (!roomId) {
    lead.hidden = true
    return
  }
  $('arrivalTitle').textContent = roomName ?? (startedHere ? 'Your new room' : 'Join the room')
  lead.textContent = startedHere
    ? 'Your room is ready. Pick a name and go in, then use Invite people to bring others in.'
    : roomInvitationCapability?.persistent
      ? 'Pick a name to go in. This device will remember the room.'
      : 'Pick a name to go in.'
  lead.hidden = false
}

/**
 * What this room is called, at the head of the conversation.
 *
 * The NAME, and nothing else. It used to be the name with a short id beside
 * it, which for a room somebody had named read as a name plus a code, and
 * for a room nobody had named read as `Room 353ff833  353ff83…` - the same
 * identifier twice, once inside a title manufactured out of it and once
 * again beside that. Every messaging app puts a human name in this slot.
 *
 * The identifier has not gone anywhere: two rooms can be called the same
 * thing and the code is what tells them apart, so it is in the room's
 * details with the other technical facts, and on the rooms list where you
 * are actually choosing between rooms.
 */
function renderRoomTitle(): void {
  const title = $('roomTitle')
  const roomId = currentRoomId()
  title.textContent = ''
  title.hidden = roomId === undefined
  if (!roomId) return
  const me = meParticipant || currentParticipant()
  const peer = me ? dmPeer(roomPolicy, me) : undefined
  title.textContent = peer ? currentRoomLabel() : roomName ?? 'Room'
  title.title = peer ? currentRoomLabel() : roomName ?? `Room ${shortKey(roomId)}`
  renderSheetRoom()
}

/** The name and the code together, in the room's details. */
function renderSheetRoom(): void {
  const line = $('sheetRoomId')
  line.textContent = ''
  const roomId = currentRoomId()
  if (!roomId) return
  if (roomName) {
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = roomName
    line.append(name, ' ')
  }
  const id = document.createElement('span')
  id.className = 'pubkey'
  id.textContent = shortKey(roomId)
  id.title = roomId
  line.append(id)
}

async function copyInput(id: string): Promise<void> {
  const input = $(id) as HTMLInputElement
  input.hidden = false
  input.select()
  let copied = false
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(input.value)
      copied = true
    }
  } catch { /* Try the browser's selection-based copy below. */ }
  if (!copied && input.getClientRects().length) {
    input.focus(); input.select()
    if (document.activeElement === input) {
      try { copied = document.execCommand('copy') } catch { /* Manual copying remains available. */ }
    }
  }
  if (id === 'shareUrl') {
    $('inviteStatus').textContent = copied ? 'Link copied. Share it with the people you want to invite.' : 'Automatic copy was unavailable. Select the link and copy it with your keyboard or touch menu.'
  }
}

async function shareRoomLink(): Promise<void> {
  const url = ($('shareUrl') as HTMLInputElement).value
  if (!navigator.share) {
    await copyInput('shareUrl')
    return
  }
  try {
    await navigator.share({
      title: 'KithMoot',
      text: 'Join this private KithMoot room. Anyone forwarded this link can enter while it is current.',
      url,
    })
    $('inviteStatus').textContent = 'Link shared.'
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
  const created = createRoomInvitation(retired.persistent === true)
  storeInvitationOwner(created.invitation, roomSecret, created.inviterSk)
  if (created.invitation.persistent) await publishGroupInvitation(created.invitation, roomSecret, created.inviterSk, relays)

  // Tell every cooperative delegated responder before replacing local
  // state. The event is durable, so an offline member learns the retirement
  // when it reconnects instead of resurrecting an old group link.
  const retirementTransport = configuredPool(relays)
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

async function publishGroupInvitation(invitation: RoomInvitation, secret: Uint8Array, inviterSk: Uint8Array, relayUrls: string[]): Promise<void> {
  const pool = configuredPool(relayUrls)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pool.publish(encodePersistentInvitation({ invitation, roomSecret: secret, inviterSk, now: nowSeconds() })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the relays did not save the group invitation')), 15_000) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    pool.close()
  }
}

async function makeRoomPersistent(): Promise<void> {
  if (!roomInvitationCapability || roomInvitationCapability.persistent || !invitationAuthoritySk || invitationDelegation.length) return
  // A fresh bearer prevents an old, never-used meeting link from silently
  // becoming durable access. Keep the room's authority and conversation.
  const invitation: RoomInvitation = {
    ...createRoomInvitation(true).invitation,
    inviter: roomInvitationCapability.inviter,
  }
  await publishGroupInvitation(invitation, roomSecret, invitationAuthoritySk, relays)
  storeInvitationOwner(invitation, roomSecret, invitationAuthoritySk)
  stopInvitationHost()
  roomInvitationCapability = invitation
  const url = encodeRoomUrl(joinLinkBase(), relays, iceUrls)
  history.replaceState(null, '', url)
  ;($('shareUrl') as HTMLInputElement).value = url
  $('makePersistent').hidden = true
  $('invitationAvailability').textContent = 'This room stays open when everyone closes the app. Share the updated invite link so people can join later.'
  rememberCurrentRoom()
  if (($('shareQrDetails') as HTMLDetailsElement).open) await renderQr($('shareQr') as HTMLCanvasElement, url)
  setStatus('This room now stays open. Share the updated invite link; the old temporary link still needs somebody online.')
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
  speakingMonitor.unwatch(LOCAL_SPEAKING_KEY)
  paintSpeaking()
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
  // The tap follows the published track, not the raw microphone: what the
  // indicator should report is what the room can actually hear, and those
  // differ whenever the masking graph is in the path.
  speakingMonitor.watch(LOCAL_SPEAKING_KEY, micTrack)
  publishActiveTracks()
  updateUi()
}

async function toggleMic(): Promise<void> {
  const generation = roomGeneration
  if (switchingRoom) return
  if ([...pendingMedia].some(pipeline => pipeline instanceof MicPipeline)) return
  if (!micTrack) {
    const pipeline = new MicPipeline({
      onStateChange: (state) => {
        if (generation !== roomGeneration) return
        renderVoiceState(state)
        adoptMicTrack()
      },
    })
    pendingMedia.add(pipeline)
    try {
      const track = await pipeline.start()
      if (generation !== roomGeneration) { pipeline.stop(); return }
      micTrack = track
    } catch (err) {
      pipeline.stop()
      if (generation !== roomGeneration) return
      throw err
    } finally {
      pendingMedia.delete(pipeline)
    }
    mic = pipeline
    micTrack.addEventListener('ended', onMicEnded)
    // Choosing the microphone is an explicit choice to use this device for
    // the conversation, even if it was previously in camera-only mode. It
    // is NOT a claim on the speaker: a phone brought in beside a laptop is
    // a microphone, and its owner is listening on the laptop. The speaker
    // is claimed weakly, so it is this device's only when nothing else of
    // theirs is playing sound - see `WEAK_MONITOR_CLAIM`.
    besideAnotherDevice = false
    micClaimedAt = nowSeconds()
    monitorClaimedAt ??= WEAK_MONITOR_CLAIM
    // Our own tile lights up too, so a person can see they are being picked
    // up rather than guessing. Muting sets `track.enabled = false`, which
    // feeds the analyser silence, so a muted mic goes dark on its own.
    speakingMonitor.watch(LOCAL_SPEAKING_KEY, micTrack)
    publishActiveTracks()
    renderVoiceState(pipeline.state)
  } else {
    micTrack.enabled = !micTrack.enabled
    if (micTrack.enabled) {
      // An explicit unmute is how this device takes the mic back from
      // another paired device. The speaker stays where it was.
      besideAnotherDevice = false
      micClaimedAt = nowSeconds()
      monitorClaimedAt ??= WEAK_MONITOR_CLAIM
      publishActiveTracks()
    }
  }
  updateUi()
}

async function toggleCamera(): Promise<void> {
  const generation = roomGeneration
  if (switchingRoom) return
  if ([...pendingMedia].some(pipeline => pipeline instanceof CameraPipeline)) return
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
      onStateChange: state => { if (generation === roomGeneration) renderEffectState(state) },
      onSourceEnded: () => {
        if (generation !== roomGeneration) return
        camera?.stop()
        camera = undefined
        cameraTrack = undefined
        localPreviewEls.get('camera')?.remove()
        localPreviewEls.delete('camera')
        publishActiveTracks()
        updateUi()
      },
    })
    pendingMedia.add(pipeline)
    try {
      const track = await pipeline.start()
      if (generation !== roomGeneration) { pipeline.stop(); return }
      cameraTrack = track
    } catch (err) {
      pipeline.stop()
      if (generation !== roomGeneration) return
      throw err
    } finally {
      pendingMedia.delete(pipeline)
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
  const pipeline = camera
  if (!pipeline) return
  if (videoInputs.length < 2) await listVideoInputs()
  if (camera !== pipeline) return
  const current = videoInputs.findIndex((d) => d.deviceId === camera?.deviceId)
  const next = videoInputs[(current + 1) % videoInputs.length]
  if (!next) return
  try { await pipeline.useCamera({ deviceId: next.deviceId }) }
  finally { if (camera !== pipeline) pipeline.stop() }
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
  const pipeline = camera
  if (!pipeline) return
  if (mode === 'replace') {
    const choice = BACKGROUNDS.find((b) => b.id === backgroundId) ?? BACKGROUNDS[0]
    // Loaded before the mode changes, so there is no frame where replace is
    // selected with nothing to replace with. If it fails the effect stays on
    // blur, which shows the room to nobody either way.
    if (choice) await pipeline.setBackground(choice)
  }
  if (camera !== pipeline) return
  pipeline.setMode(mode)
  renderEffectState(pipeline.status)
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
  const generation = roomGeneration
  if (switchingRoom) return
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
    if (generation !== roomGeneration) { for (const track of stream.getTracks()) track.stop(); return }
    screenTrack = stream.getVideoTracks()[0]
    if (screenTrack) {
      // Fires when the user stops sharing from the browser's own UI, not
      // ours - the toggle has to notice either way.
      screenTrack.addEventListener('ended', () => {
        if (generation !== roomGeneration) return
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
    ? 'On: agents get your camera and microphone like anybody else does, and one that is listening writes what you say into the transcript.'
    : 'Off: nothing that says it is an agent is sent your camera or microphone. It never leaves this device for them.'
  publishActiveTracks()
}

/** When this device last took the microphone, for the singular-role claim.
 *  Stamped when the mic comes on, so a device that has held it since the
 *  start is not outranked by its owner's other device toggling later. */
let micClaimedAt: number | undefined
/** The linked device that most recently brought call media becomes the one
 * speaker. One open speaker per person breaks the nearby-device echo loop. */
let monitorClaimedAt: number | undefined
/** Explicit escape hatch when a phone entered through the ordinary room link.
 * There is no safe way to infer physical proximity from room or network data,
 * so the person can silence this device while retaining its camera/share. */
let besideAnotherDevice = false
/** A speaker claim that loses to any real one. A device with only a
 *  microphone on claims the speaker this weakly, so two devices of one
 *  person never both play sound unless the person asks. */
const WEAK_MONITOR_CLAIM = 1

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
  const claims: Partial<Record<SingularRole, number>> = {}
  if (!besideAnotherDevice && micTrack) {
    micClaimedAt ??= nowSeconds()
    claims.mic = micClaimedAt
  }
  if (!besideAnotherDevice && (micTrack || cameraTrack || screenTrack)) {
    monitorClaimedAt ??= nowSeconds()
    claims.monitor = monitorClaimedAt
  }
  return claims
}

function toggleCompanionMode(): void {
  besideAnotherDevice = !besideAnotherDevice
  if (besideAnotherDevice) {
    if (micTrack) micTrack.enabled = false
    micClaimedAt = monitorClaimedAt = undefined
  } else {
    if (micTrack) micClaimedAt = nowSeconds()
    if (micTrack || cameraTrack || screenTrack) monitorClaimedAt = nowSeconds()
  }
  publishActiveTracks()
  updateUi()
}

/** Send the live tracks to every peer, and tell the roster what they are.
 *  Both, every time: the peers carry the media, and the roster is what
 *  everybody else's tile reads to say "camera" or "connecting". */
function publishActiveTracks(): void {
  if (!micTrack) micClaimedAt = undefined
  if (!micTrack && !cameraTrack && !screenTrack) monitorClaimedAt = undefined
  session?.publishTracks(activeTracks(), { audience })
  session?.advertise(currentAdverts(), currentClaims()).catch(() => {})
  const s = session
  if (s && !s.call && activeTracks().length > 0) {
    leftCall = false
    s.setCall({ id: s.calls()[0]?.id ?? newCallId(), since: nowSeconds() }).catch(() => {})
  }
}

function setToggle(id: string, on: boolean): void {
  $(id).dataset.on = String(on)
  $(id).setAttribute('aria-pressed', String(on))
}

function updateUi(): void {
  if (callIsLive() || onCall()) setCallOpen(true)
  setToggle('toggleMic', !!micTrack?.enabled)
  setToggle('toggleCamera', !!cameraTrack)
  setToggle('toggleScreen', !!screenTrack)
  setToggle('toggleCompanion', besideAnotherDevice)
  $('companionNote').hidden = !besideAnotherDevice
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

/**
 * Which participants have said they are agents.
 *
 * Remembered rather than looked up live, because chat is durable and the
 * roster is not: a message from an agent that has since left the room would
 * otherwise lose its tag at exactly the moment there is nobody to ask. A key
 * this room's roster has never carried is not marked, which is honest - the
 * claim comes from the roster and from nowhere else.
 */
const agentParticipants = new Set<string>()

function participantIsAgent(participant: string): boolean {
  return agentParticipants.has(participant)
}

function render(views: ParticipantView[], me: string): void {
  // A private conversation is titled for the other person, whose name
  // arrives with their presence, not with the link.
  if (dmPeer(roomPolicy, me) && $('roomTitle').textContent !== currentRoomLabel()) renderRoomTitle()
  // A catalogue can arrive before its participant's roster entry. Refresh
  // an open completion when presence catches up, or the ^ menu stays empty
  // until the person types again.
  if (document.activeElement === $('chatInput')) renderMentionPicker()
  for (const view of views) if (view.agent) agentParticipants.add(view.participant)
  const mine = views.find((v) => v.participant === me)

  // A paired phone and laptop are one participant. Whichever device most
  // recently claimed the mic and monitor wins; the others must enforce that
  // answer locally or the role markers are only decoration and two nearby
  // speakers feed two nearby microphones.
  if (mine?.mic && mine.mic !== myDeviceId && micTrack?.enabled) micTrack.enabled = false
  const monitorHere = !besideAnotherDevice && (!mine?.monitor || mine.monitor === myDeviceId)
  // Never my own voice. A second device of mine on the call sends its
  // microphone to this one like anybody else's, and playing it is how a
  // person on a phone and a laptop heard themselves back, twice, a beat
  // late. Somebody who has pressed Leave hears none of it either: the
  // tracks still arrive, because the room's mesh outlives the call, but
  // Leave has to mean quiet. See `leftCall`.
  const ownDevices = new Set(mine?.devices ?? [])
  for (const [key, audio] of remoteAudios) {
    const device = key.slice(0, key.indexOf('|'))
    audio.el.muted = !monitorHere || leftCall || ownDevices.has(device)
  }

  {
    const twoDevices = (mine?.devices.length ?? 0) > 1
    const monEl = $('monitorIndicator')
    monEl.hidden = !twoDevices
    monEl.textContent = !twoDevices ? '' : monitorHere ? 'Sound plays on this device.' : 'Sound plays on your other device, so this one stays quiet.'
    ;($('listenHere') as HTMLButtonElement).hidden = !twoDevices || monitorHere
  }
  const micEl = $('micIndicator')
  if (mine?.mic) {
    micEl.textContent = mine.mic === myDeviceId
      ? (micTrack?.enabled ? 'Mic: this device' : 'Mic: this device (muted)')
      : 'Mic: your other device'
    micEl.classList.toggle('mine', mine.mic === myDeviceId)
  } else {
    micEl.textContent = micTrack ? 'Mic: on, not yet claimed' : 'Mic: off'
    micEl.classList.remove('mine')
  }

  renderAssist()

  // After Leave, no pictures either. The mesh still delivers them - it is
  // the room's, not the call's - but a person who has pressed Leave is
  // shown the names and the banner, not the faces, until they press Join.
  // The poll puts them back the moment they do.
  if (leftCall) for (const entry of remoteVideos.values()) if (onScreen(entry)) parkPicture(entry.el)

  const root = $('room')
  const kept = new Set<string>()
  let slot = 0
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
      badge.title = 'An agent, not a person'
      chip.append(badge)
      if (view.owner) chip.append(ownerRun(view.owner))
      agentsRow.append(chip)
      continue
    }
    let box = tileBoxes.get(view.participant)
    if (!box) {
      box = document.createElement('div')
      tileBoxes.set(view.participant, box)
    }
    kept.add(view.participant)
    // Everything but the media holders is rebuilt from the roster; the
    // holders stay exactly where they are unless they have emptied.
    for (const child of [...box.children]) {
      if (!child.classList.contains('media') || child.childElementCount === 0) child.remove()
    }
    box.className = 'participant'
    if (view.call) box.classList.add('onCall')
    // The claim this app exists to prove: two devices, one tile. Anything
    // else in the styling is decoration.
    if (view.devices.length > 1) box.classList.add('linked')

    // Which devices this tile speaks for. `render()` rebuilds the room from
    // scratch, so a tile rebuilt in the middle of a word has to come back
    // already lit rather than waiting for the next poll to notice.
    const tileDevices = view.participant === me ? [LOCAL_SPEAKING_KEY] : view.devices
    box.dataset.devices = tileDevices.join(' ')
    if (tileDevices.some((d) => speakingMonitor.isSpeaking(d))) box.classList.add('speaking')

    const shown = shownAs(view.participant, view.name)

    const heading = document.createElement('h3')
    // The picture comes with the identity run now, ringed by what this
    // person has put in - see `pictureOf`.
    heading.append(identityRun(shown, view.participant === me))
    // In its own element so a tile with no picture in it can drop the
    // device count and stay one line wide. See `#room .participant` in
    // style.css for why that matters more than it sounds like it does.
    const devices = document.createElement('span')
    devices.className = 'devices'
    devices.textContent = ` · ${view.devices.length} device${view.devices.length === 1 ? '' : 's'}`
    heading.append(devices)
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
      if (view.owner) heading.append(ownerRun(view.owner))
    }
    if (view.participant !== me) heading.append(verifyChip(view, shown.name ?? ''))
    box.prepend(heading)
    const place = (mediaEl: HTMLDivElement | undefined): void => {
      if (!mediaEl || mediaEl.childElementCount === 0) { if (mediaEl?.parentElement === box) mediaEl.remove(); return }
      if (mediaEl.parentElement !== box) box.append(mediaEl)
    }

    if (view.participant === me) {
      // Our own live media, in our own tile: the same elements that were the
      // preview before joining, moved here rather than duplicated (see
      // localMediaEl). A chip only for what has no picture - the mic - and
      // for a track advertised but not currently previewed.
      place(localMediaEl)
      // My other devices' pictures, in the same tile. A phone's camera is
      // a picture of me, and the laptop I am also on is the natural place
      // to check what it is showing; leaving it out meant a person on two
      // devices never saw their own phone's camera on their desktop and
      // concluded the desktop was broken. Their sound stays muted, see the
      // rule at the top of `render`.
      for (const device of view.devices) if (device !== myDeviceId) place(deviceMediaEls.get(device))
      box.append(
        trackChips(view, (track) => {
          const kind = previewKindOf(track.role)
          if (track.device !== myDeviceId) {
            const mediaEl = deviceMediaEls.get(track.device)
            const tag = track.role === 'mic' || track.role === 'screen-audio' ? 'audio' : 'video'
            return mediaEl?.querySelector(tag) ? 'live' : 'waiting'
          }
          return kind !== undefined && localPreviewEls.has(kind) ? 'live' : 'own'
        }),
      )
    } else {
      // Remote media: real video/audio wherever we have it, a waiting chip
      // wherever we do not (still negotiating, or never advertised).
      for (const device of view.devices) place(deviceMediaEls.get(device))
      box.append(
        trackChips(view, (track) => {
          const mediaEl = deviceMediaEls.get(track.device)
          const kind = track.role === 'mic' || track.role === 'screen-audio' ? 'audio' : 'video'
          return mediaEl?.querySelector(kind) ? 'live' : 'waiting'
        }),
      )
    }

    const sharedDevices = new Set(view.tracks.filter(track => track.role === 'screen').map(track => track.device))
    if (view.participant === me && screenTrack) sharedDevices.add(myDeviceId)
    for (const device of sharedDevices) {
      const source = () => screenSource(view.participant, device)
      const available = source()
      // The button is there from the moment the roster says a screen is
      // being shared, and only becomes pressable when the picture has
      // arrived. Missing entirely until then, it looked to the person
      // waiting as if there was nothing to expand, and on a phone the
      // double-tap that also opened the viewer is not a gesture anybody
      // finds. One tap on the preview opens it too.
      const expand = document.createElement('button')
      expand.type = 'button'; expand.className = 'shareExpand'
      expand.textContent = available ? 'Expand screen share' : 'Screen share arriving…'
      expand.disabled = !available
      expand.setAttribute('aria-label', `Expand screen share from ${shown.name ?? shown.short}`)
      expand.addEventListener('click', () => shareViewer.open(source, expand))
      box.append(expand)
      if (!available) continue
      const preview = device === myDeviceId ? localPreviewEls.get('screen') : remoteVideos.get(`${device}|${available.id}`)?.el
        ?? [...remoteVideos.values()].find(entry => entry.track === available.track)?.el
      if (preview) {
        preview.classList.add('screenPreview')
        if (device === myDeviceId) preview.ondblclick = () => shareViewer.open(source, expand)
        else preview.onclick = () => shareViewer.open(source, expand)
        // Marks drawn on this share show over its preview, so the person
        // sharing sees what is being pointed at without opening anything.
        if (!shareMarkOverlays.has(preview)) shareMarkOverlays.set(preview, shareViewer.overlay(preview, () => source()?.id))
      }
    }
    sweepShareMarkOverlays()
    // Into its place in the roster's order, moved only if it is not
    // already there.
    const at = root.children[slot] ?? null
    if (at !== box) root.insertBefore(box, at)
    slot++
  }
  for (const [participant, box] of tileBoxes) {
    if (kept.has(participant)) continue
    box.remove()
    tileBoxes.delete(participant)
  }
  // The stage lays itself out by how many faces are on it, and gives a
  // shared screen the whole width. See `#room[data-tiles]` in style.css.
  let tiles = 0, sharing = false
  for (const box of tileBoxes.values()) {
    if (box.querySelector('video')) tiles++
    if (box.querySelector('video.screenPreview')) sharing = true
  }
  root.dataset.tiles = String(tiles)
  root.classList.toggle('sharing', sharing)

  agentsRow.hidden = agentsRow.childElementCount === 0
  // Faces and voices, and only when there are some.
  //
  // Not "only when a picture has arrived": a tile that is still connecting
  // says which rung of the route ladder it is on, and that is exactly the
  // moment somebody wants to know. So the strip appears as soon as anybody
  // in the room is offering anything, and a room where nobody has turned
  // anything on shows nothing at all - which is most rooms, most of the
  // time, and is why this is not on the screen permanently.
  $('whoIsHere').hidden = !views.some((view) => view.tracks.length > 0) && localMediaEl.childElementCount === 0
  renderAgentsExplain(views)
  renderRoomWho()
  if (($('roomSheet') as HTMLDialogElement).open) renderSheetRoster(views, me)

  // Emptying the grid above detached our own holder if it was in a tile. If
  // no tile of ours was built this time - our entry has not come back from
  // the relay yet, or lapsed - it goes back to the preview strip in this same
  // synchronous pass, so it is never out of the document long enough for
  // the browser to pause the picture in it.
  if (!localMediaEl.isConnected) $('local').append(localMediaEl)

  renderCallState(views)
  // Which tabs are worth showing depends on who is here (Agents appears
  // when an agent does), so a roster change can change the row.
  const tabKey = navTabs().map(([name]) => name ?? '').join('\n')
  if (tabKey !== renderedTabKey) { renderedTabKey = tabKey; renderConversationNav() }
  if (collisionsChanged) {
    collisionsChanged = false
    repaintActiveChat()
  }
}

/** Small numbers read better as words in a sentence a stranger has to take
 *  in at a glance. Above ten the digits are clearer than the word. */
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
function inWords(n: number): string {
  return COUNT_WORDS[n] ?? String(n)
}

/**
 * What the `agent` tag means, in one sentence with the tag set into it.
 *
 * This used to be a strip pinned above the conversation, permanently, in
 * every room. It was put there because a cold reader took five names for
 * five people and nothing on the screen said otherwise - and it worked, and
 * it was also one more thing competing with the conversation for ever after
 * the reader had understood it.
 *
 * So it is said where Signal says "messages are end-to-end encrypted": as
 * the first note at the head of the thread, in the conversation the person
 * came to read. After that the purple bubbles and the tags carry it. It
 * also lives permanently in the room's details, for anybody who comes back
 * looking for it.
 *
 * Returns a fragment rather than writing to one element, because it is now
 * said in two places and neither of them may be allowed to drift.
 */
function agentsSentence(count: number): DocumentFragment | undefined {
  if (count === 0) return undefined
  const run = document.createDocumentFragment()
  run.append(count === 1 ? 'One of these names is marked ' : `${inWords(count)} of these names are marked `)
  // The tag exactly as it appears on a name and on a bubble, so the
  // sentence and the thing it is about cannot be told apart.
  const badge = document.createElement('span')
  badge.className = 'badge agent'
  badge.textContent = 'agent'
  run.append(badge)
  run.append(
    count === 1 ? ': a computer program, not a person. ' : ': computer programs, not people. ',
    'Somebody here started ',
    count === 1 ? 'it' : 'them',
    ', and everything ',
    count === 1 ? 'it says' : 'they say',
    ' is in the open for everybody to read.',
  )
  return run
}

function renderAgentsExplain(views: ParticipantView[]): void {
  const line = $('agentsExplain')
  line.textContent = ''
  const run = agentsSentence(views.filter((v) => v.agent).length)
  line.hidden = run === undefined
  if (run) line.append(run)
}

/**
 * Who is here, in words, for the one line under the room's name.
 *
 * The strip of chips this replaces said the same thing in a great deal more
 * space. The chips are not gone: they are in the room's details, one tap
 * away behind this very line, which is what it is for.
 */
function renderRoomWho(): void {
  const line = $('roomWho')
  const views = session?.participants() ?? []
  const where = conversationLabel(currentChannel)
  renderAgentActivity()
  if (views.length === 0) {
    line.textContent = where
    return
  }
  const agents = views.filter((v) => v.agent).length
  const here = `${views.length} here`
  line.textContent = agents === 0 ? `${where} · ${here}` : `${where} · ${views.length - agents} ${views.length - agents === 1 ? 'person' : 'people'}, ${agents} agent${agents === 1 ? '' : 's'}`
}

/**
 * The full roster, in the room's details.
 *
 * The same run of name, short key and tags that a tile and a line of chat
 * use, so a person looks the same wherever they are drawn, and the same
 * "is this really them" control, which would otherwise have been lost with
 * the chips it used to sit on.
 */
function renderSheetRoster(views: ParticipantView[], me: string): void {
  const list = $('sheetRoster')
  list.innerHTML = ''
  for (const view of views) {
    const row = document.createElement('div')
    row.className = 'rosterRow'
    const shown = shownAs(view.participant, view.name)
    row.append(identityRun(shown, view.participant === me))
    if (view.agent) {
      const badge = document.createElement('span')
      badge.className = 'badge agent'
      badge.textContent = 'agent'
      badge.title = 'An agent, not a person'
      row.append(badge)
      if (view.owner) row.append(ownerRun(view.owner))
    }
    if (view.devices.length > 1) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = 'one person'
      row.append(badge)
    }
    if (view.participant !== me) row.append(verifyChip(view, shown.name ?? ''))
    // A word in private, from the room you are both in. A DM is a room of
    // two; see docs/messages.md. Not offered on a room that already is one.
    // An agent takes one too, from its owner or a room admin: those are
    // the people it answers to, and the agent's runner applies the same
    // rule at its end (`--dm` in kithmoot-agent), so the button is only
    // shown where it can work.
    const mayDmAgent = view.agent === true && (view.owner?.principal === me || admins.has(me))
    if (view.participant !== me && (!view.agent || mayDmAgent) && !dmPeer(roomPolicy, me)) {
      const dm = document.createElement('button')
      dm.type = 'button'
      dm.className = 'dmButton quiet'
      dm.textContent = 'Message privately'
      dm.setAttribute('aria-label', `Message ${shown.name ?? shown.short} privately`)
      dm.addEventListener('click', () => { void startDirectMessage(view.participant, shown.name) })
      row.append(dm)
    }
    list.append(row)
  }
}

// ---------------------------------------------------------------------------
// Direct messages
//
// A DM is a room: a persistent group whose link admits two people and
// nobody else. Starting one makes that room and sends its link, sealed to
// the other person, as a message in the room you are both already in. The
// person's other devices, and the recipient's, open it from there. See
// docs/messages.md and src/dm.ts.
// ---------------------------------------------------------------------------

/** NIP-44 between this participant and another: the signer's, or the local
 *  key's. Undefined on a paired secondary, which holds no participant key,
 *  and on a signer with no NIP-44. */
function peerCrypt(): PeerCrypt | undefined {
  if (nostrSession) {
    const nip44 = nostrSession.signer.nip44
    if (!nip44) return undefined
    return { encrypt: (peer, text) => nip44.encrypt(peer, text), decrypt: (peer, text) => nip44.decrypt(peer, text) }
  }
  try {
    return localPeerCrypt(participantKey())
  } catch {
    return undefined
  }
}

let startingDm = false
async function startDirectMessage(peer: string, peerName: string | undefined): Promise<void> {
  const s = session
  const me = meParticipant
  if (!s || !me || startingDm) return
  const who = peerName ?? shortKey(peer)
  // One conversation per pair. Started twice, or from both ends, it is the
  // room that already exists - the earliest of them, the same choice every
  // device makes (see `preferredDm`).
  const existing = preferredDm(knownRooms(roomStore())
    .filter((room) => dmPeerOf(room) === peer)
    .map((room) => ({ room: room.roomId, sentAt: room.openedAt, known: room })))
  if (existing) {
    setStatus(`Opening your private conversation with ${who}…`, 'progress')
    switchRoom(existing.known)
    return
  }
  const crypt = peerCrypt()
  if (!crypt) {
    setStatus(nostrSession
      ? 'This signer cannot encrypt, so it cannot send a private invitation. Sign in with a signer that supports NIP-44.'
      : 'A paired device cannot start a private conversation. Use the device that holds your identity.')
    return
  }
  startingDm = true
  try {
    setStatus(`Starting a private conversation with ${who}…`, 'progress')
    const secret = generateRoomSecret()
    const created = createRoomInvitation(true)
    const { roomId } = deriveRoom(secret)
    storeInvitationOwner(created.invitation, secret, created.inviterSk)
    await publishGroupInvitation(created.invitation, secret, created.inviterSk, relays)
    const link = encodeRoomLink(joinLinkBase(), { invitation: created.invitation, relays, iceUrls, policy: dmPolicy(me, peer) })
    const invite = await sealInvite(link, { to: peer, room: roomId, crypt })
    const text = inviteText()
    outbox.send(text, 'Chat', s.chat.prepareSend(text, { invite }))
    const room = rememberRoom(roomStore(), { roomId, link, openedAt: nowSeconds(), ...(peerName ? { name: peerName } : {}) })
    bookmarks?.save(room)
    addSystemLine(`You started a private conversation with ${who}.`, nowSeconds(), room)
    setStatus(`Private conversation with ${who} started. It is in your rooms; ${who} will find it in theirs.`, 'done')
  } catch (err) {
    setStatus(describeError(err))
  } finally {
    startingDm = false
  }
}

/** Invitations this page has already acted on, by message id. */
const handledInvites = new Set<string>()

/**
 * Open every invitation in the main chat that is for this identity: one
 * addressed to it, or one it sent from another device. The room goes on
 * the list and, when signed in, into the bookmarks, and the chat says so
 * where the invitation sits.
 */
async function handleInvites(messages: ChatMessage[]): Promise<void> {
  const generation = roomGeneration
  const me = meParticipant
  if (!me) return
  for (const m of messages) {
    if (!m.invite || handledInvites.has(m.id)) continue
    if (m.invite.to !== me && m.participant !== me) continue
    if (knownRoom(roomStore(), m.invite.room)) { handledInvites.add(m.id); continue }
    // No key to open it with yet - a signer still restoring - is not a
    // decision, so the invitation is left for the next repaint.
    const crypt = peerCrypt()
    if (!crypt) continue
    handledInvites.add(m.id)
    const link = await openInvite(m.invite, { self: me, sender: m.participant, crypt })
    if (generation !== roomGeneration) return
    if (!link) continue
    try {
      parseRoomLink(link)
    } catch {
      continue
    }
    // Named for the other person: the sender's name on the message when it
    // was sent to us, and the addressee's roster name when we sent it from
    // another device.
    const peerName = m.participant === me
      ? session?.participants().find((v) => v.participant === m.invite!.to)?.name
      : m.name ?? shownAs(m.participant).name
    const room = rememberRoom(roomStore(), { roomId: m.invite.room, link, openedAt: m.sentAt, ...(peerName ? { name: peerName } : {}) })
    bookmarks?.save(room)
    addSystemLine(m.participant === me
      ? 'You started a private conversation from another device. It is in your rooms.'
      : `${senderLabel(m)} started a private conversation with you. It is in your rooms.`, m.sentAt, room)
    if (roomsListShown) renderRooms()
  }
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
      return turnRelayConfigured ? 'connecting via relay…' : 'no relay server, still trying…'
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
/** The room's named channels, as the keeper last announced them and this
 *  client verified against the pinned authority. */
let channels: string[] = []
let channelsAt = 0
/** Which conversation the chat box is showing. `undefined` is the main
 *  chat, which is the room itself and has no name. */
let currentChannel: string | undefined
/** Channels this client has already opened a log for, so switching back to
 *  one does not resubscribe. */
const channelLogs = new Map<string, ReturnType<NonNullable<typeof session>['channel']>>()
/** How much has been said in each one, so a tab can show that there is
 *  something behind it without being opened first. */
const channelCounts = new Map<string, number>()
let conversationRead = new Map<string, Set<string>>()
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
  /** A room the line is about, offered as the way to it. */
  room?: KnownRoom
}
const systemLines: SystemLine[] = []

/**
 * "Rowan came in." and "Rowan left.", as lines in the conversation.
 *
 * Who is here is on the roster and in Room details, but a person reading
 * the chat wants to know when it changed, the way a channel says so. Read
 * off the roster, with a settle window: the roster is rebuilt from relay
 * replay for the first heartbeat after joining, and everybody already in
 * the room would otherwise "come in" one by one as their entries arrive.
 * Nothing here is on the wire; two devices may see the same person's
 * comings a heartbeat apart, and that is fine.
 */
const ROSTER_SETTLE_MS = 25_000
let rosterSeen: Map<string, string | undefined> | undefined
let rosterJoinedAt = 0
function announceComings(views: ParticipantView[], me: string): void {
  const now = Date.now()
  const present = new Map(views.filter(view => view.participant !== me).map(view => [view.participant, view.name] as const))
  if (!rosterSeen) {
    rosterSeen = new Map(present)
    rosterJoinedAt = now
    return
  }
  const settled = now - rosterJoinedAt > ROSTER_SETTLE_MS
  const label = (participant: string, name: string | undefined, agent: boolean) =>
    `${shownAs(participant, name).name ?? shortKey(participant)}${agent ? ' (agent)' : ''}`
  for (const [participant, name] of present) {
    if (rosterSeen.has(participant)) continue
    if (settled) addSystemLine(`${label(participant, name, views.find(v => v.participant === participant)?.agent === true)} came in.`)
  }
  for (const [participant, name] of rosterSeen) {
    if (present.has(participant)) continue
    if (settled) addSystemLine(`${label(participant, name, agentParticipants.has(participant))} left.`)
  }
  rosterSeen = new Map(present)
}

function addSystemLine(text: string, at = nowSeconds(), room?: KnownRoom): void {
  systemLines.push(room ? { at, text, room } : { at, text })
  systemLines.sort((a, b) => a.at - b.at)
  // Keep local status lines until the chat exists and can render them.
  // Only the conversation on screen is repainted - the line belongs to the
  // main chat and waits there for somebody standing on another tab.
  try {
    repaintActiveChat()
  } catch {
    // Not joined yet.
  }
}

function renderRoomLockState(): void {
  const epoch = session?.epoch ?? 0
  const state = $('roomLockState')
  state.hidden = epoch === 0
  state.textContent = epoch > 0
    ? `The room lock has changed ${epoch === 1 ? 'once' : `${epoch} times`}. Removed members cannot read new messages.`
    : ''
}

function onEpochChange(notice: RekeyNotice): void {
  renderRoomLockState()
  renderHost()
  // Joining replays old rekeys; a state grant includes everyone ever
  // removed. Neither is a new event to announce in this visit's chat.
  if ($('roomArea').hidden || notice.catchUp) return
  const by = notice.by ? ` by ${personLabel(notice.by)}` : ''
  for (const p of notice.removed) addSystemLine(`${personLabel(p)} was removed${by}.`, notice.at)
  addSystemLine(
    `The room moved to epoch ${notice.epoch}.${notice.removed.length ? ' Nothing from here on reaches who was removed; what they already read stays theirs.' : ''}`,
    notice.at,
  )
}

const NOTICE_STORAGE_KEY = 'kithmoot.notice'

/**
 * Leave because the room said so, and say why on the page that comes back.
 * Media and the session are stopped first. The reason rides across the
 * reload into this room's door in session storage, so the person can read
 * it after the conversation has closed.
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

// ---------------------------------------------------------------------------
// Approvals: an agent asks, in the room, and the right person answers
//
// The card is shown only to somebody the agent will listen to - a
// participant on the keeper's announced admin list, or the agent's verified
// principal - because an answer from anybody else is ignored by the agent
// and would be a button that does nothing. Everybody sees the outcome as a
// system line, judged by the same rule, so it is not a line anybody could
// put in the chat by answering a question that was not theirs.
// ---------------------------------------------------------------------------

interface OpenApproval {
  id: string
  from: string
  text: string
  options: string[]
  expiresAt?: number
  at: number
  answered?: { by: string; verdict: string }
}
const approvals = new Map<string, OpenApproval>()
let approvalTimer: ReturnType<typeof setTimeout> | undefined

/** Whether `participant` is somebody the agent `requester` will listen to. */
function canApprove(participant: string, requester: string): boolean {
  if (admins.has(participant)) return true
  const owner = session?.participants().find((v) => v.participant === requester)?.owner
  return owner !== undefined && owner.principal === participant
}

function verdictSentence(by: string, verdict: string, request: OpenApproval): string {
  const what = request.text.length > 80 ? `${request.text.slice(0, 77)}…` : request.text
  const said = verdict === 'approve' ? 'approved' : verdict === 'decline' ? 'declined' : `answered “${verdict}” to`
  return `${personLabel(by)} ${said} ${personLabel(request.from)}’s request: ${what}`
}

function renderApprovals(): void {
  const box = $('approvals')
  box.innerHTML = ''
  const now = nowSeconds()
  let soonest: number | undefined
  for (const request of approvals.values()) {
    if (request.answered) continue
    if (request.expiresAt !== undefined && request.expiresAt <= now) continue
    if (!session || !canApprove(meParticipant, request.from)) continue
    if (request.expiresAt !== undefined && (soonest === undefined || request.expiresAt < soonest)) soonest = request.expiresAt
    const card = document.createElement('div')
    card.className = 'approvalCard'
    const who = document.createElement('span')
    who.className = 'who'
    const view = session.participants().find((v) => v.participant === request.from)
    who.append(identityRun(shownAs(request.from, view?.name), false))
    if (view?.owner) who.append(ownerRun(view.owner))
    who.append(' asks:')
    const text = document.createElement('span')
    text.className = 'text'
    text.textContent = request.text
    const options = document.createElement('div')
    options.className = 'options'
    for (const option of request.options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = option
      button.addEventListener('click', () => {
        for (const b of options.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true
        sendHostControl({ op: 'approval', id: request.id, verdict: option }, `Answered ${option}.`)
      })
      options.append(button)
    }
    card.append(who, text, options)
    box.append(card)
  }
  for (const knock of knocks.values()) {
    const card = document.createElement('div')
    card.className = 'approvalCard knock'
    const who = document.createElement('span')
    who.className = 'who'
    if (knock.participant) who.append(identityRun(shownAs(knock.participant, knock.name), false))
    else who.append(knock.name ?? 'Somebody')
    who.append(' wants to join.')
    const options = document.createElement('div')
    options.className = 'options'
    for (const [label, yes] of [['Let in', true], ['Decline', false]] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      if (yes) button.classList.add('primary')
      button.addEventListener('click', () => answerKnock(knock, yes))
      options.append(button)
    }
    card.append(who, options)
    box.append(card)
  }
  // A card leaves on its own when its question expires.
  if (approvalTimer !== undefined) clearTimeout(approvalTimer)
  approvalTimer = undefined
  if (soonest !== undefined) approvalTimer = setTimeout(renderApprovals, Math.max(0, (soonest - now) * 1000 + 50))
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
    if (view.owner) who.append(ownerRun(view.owner))
    row.append(who)
    const label = personLabel(view.participant)
    if (view.participant === keeperParticipant) {
      const note = document.createElement('span')
      note.className = 'note'
      note.textContent = 'looks after this room'
      row.append(note)
      list.append(row)
      continue
    }
    const mute = document.createElement('button')
    mute.type = 'button'
    mute.textContent = 'Mute'
    mute.title = 'Ask their app to switch their camera and microphone off. It is a request, and nothing here can make them.'
    mute.addEventListener('click', () => sendHostControl({ op: 'mute', participant: view.participant }, `Asked ${label} to mute.`))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'danger'
    remove.textContent = 'Remove'
    remove.title = 'Move the room to a new key this person is not given.'
    remove.addEventListener('click', async () => {
      if (!await confirmRoomAction({ title: `Remove ${label}?`, message: 'The room will move to a new key that this person is not given. What they already read stays theirs.', confirmLabel: 'Remove from room', danger: true })) return
      sendHostControl({ op: 'remove', participant: view.participant }, `Asked the keeper to remove ${label}.`)
    })
    row.append(mute, remove)
    list.append(row)
  }
}

$('closeRoom').addEventListener('click', async () => {
  if (!await confirmRoomAction({ title: 'Close this room for everybody?', message: 'The invite link will stop working and the agent keeping the room open will leave.', confirmLabel: 'Close room', danger: true })) return
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
        assignmentPanel.refreshPeople()
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
      case 'channels': {
        // Only a list the room's authority signed, and only the newest. An
        // unsigned one is exactly what a member holding the room key would
        // forge, which is the whole reason the list is signed at all.
        const authority = roomAuthority()
        if (!authority || !session || control.host !== m.participant) break
        if (!verifyChannels({ roomId: session.roomId, epoch: control.epoch, channels: control.channels, sig: control.sig, authority })) break
        if (m.sentAt < channelsAt) break
        channels = control.channels
        channelsAt = m.sentAt
        for (const name of channels) followNamedConversation(name)
        if (!$('roomArea').hidden) restoreConversation()
        // Keep unfinished work reachable when its conversation closes.
        // An empty conversation can return straight to the main chat.
        if (currentChannel !== undefined && !channelAvailable(currentChannel) && !draftHasWork(captureDraft())) selectChannel(undefined)
        else renderChannels()
        break
      }
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
        renderApprovals()
        renderChannels()
        break
      }
      case 'mute':
        // For this device, from somebody on the announced list, and recent:
        // a request replayed from last week is not one.
        if (control.participant !== meParticipant || !admins.has(m.participant)) break
        if (m.sentAt < nowSeconds() - 30) break
        muteRequested(m.participant)
        break
      case 'approval-request': {
        // Kept whoever asked: the card decides who sees it, and the answer
        // decides whose answer counts. An expired one is history.
        if (control.expiresAt !== undefined && control.expiresAt <= nowSeconds()) break
        if (approvals.has(control.id)) break
        approvals.set(control.id, {
          id: control.id,
          from: m.participant,
          text: control.text,
          options: control.options ?? [...DEFAULT_APPROVAL_OPTIONS],
          ...(control.expiresAt !== undefined ? { expiresAt: control.expiresAt } : {}),
          at: m.sentAt,
        })
        renderApprovals()
        break
      }
      case 'approval': {
        const request = approvals.get(control.id)
        if (!request || request.answered) break
        if (!canApprove(m.participant, request.from)) break
        if (request.expiresAt !== undefined && m.sentAt > request.expiresAt) break
        if (!request.options.includes(control.verdict)) break
        request.answered = { by: m.participant, verdict: control.verdict }
        addSystemLine(verdictSentence(m.participant, control.verdict, request))
        renderApprovals()
        break
      }
      default:
        break
    }
  }
  if (changed) {
    renderInvites()
    if (document.activeElement === $('chatInput')) renderMentionPicker()
  }
}

/** Which hosts are actually here. A catalogue from a host that has left is
 *  a menu for a kitchen that has closed. */
/**
 * How an agent gets into a room.
 *
 * This used to be hidden entirely whenever no computer in the room was
 * offering one, so somebody looking for "how do I invite an agent" found an
 * empty space and concluded the feature did not exist. An empty list with a
 * sentence saying why it is empty answers the question; no list at all
 * answers nothing. It lives on the Agents tab, which is where somebody
 * thinking about agents already is.
 */
function renderInvites(): void {
  const box = $('inviteAgents')
  const list = $('inviteList')
  const focused = document.activeElement as HTMLElement | null
  const focusKey = focused && list.contains(focused) ? focused.dataset.inviteAction : undefined
  list.innerHTML = ''
  // Shown whenever there is a room, now that it is in the room's details
  // rather than on the message screen. It used to appear only while the
  // agents' conversation was open, which after the move would have meant
  // switching to that conversation - closing the sheet - and opening the
  // sheet again to find this.
  if (!session) {
    box.hidden = true
    return
  }
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
      button.dataset.inviteAction = JSON.stringify([host, entry.id, 'membership'])
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
        const owner = running.participant
        const tag = document.createElement('span')
        tag.className = 'running'
        tag.textContent = owner && present.has(owner) ? 'in the room' : 'host reports it running'
        row.append(tag)
        if (owner && present.has(owner)) for (const action of entry.actions ?? []) {
          const capability = document.createElement('div')
          capability.className = 'inviteCapability'
          const choose = document.createElement('button')
          choose.type = 'button'
          choose.textContent = `Assign work: ${action.label}`
          choose.dataset.inviteAction = JSON.stringify([host, entry.id, action.id])
          choose.addEventListener('click', () => {
            const current = session
            const open = () => { if (current && session === current) assignmentPanel.offerTo(owner, action.id) }
            const sheet = $('roomSheet') as HTMLDialogElement
            if (sheet.open) { sheet.addEventListener('close', open, { once: true }); sheet.close() }
            else open()
          })
          const description = document.createElement('span')
          description.className = 'desc'
          description.textContent = action.description
          capability.append(choose, description)
          row.append(capability)
        }
      }
      list.append(row)
      rows++
    }
  }
  if (rows === 0) {
    const none = document.createElement('p')
    none.className = 'note'
    none.textContent =
      'Nobody here is offering one at the moment. An agent runs on somebody’s own computer, ' +
      'so one can only be asked in while that person has their agent host running and is in this room.'
    const guide = document.createElement('a')
    guide.href = 'https://github.com/ForgeSworn/kithmoot/blob/main/docs/agents.md'
    guide.target = '_blank'
    guide.rel = 'noopener noreferrer'
    guide.textContent = 'Agent setup guide ↗'
    list.append(none, guide)
  }
  box.hidden = false
  if (focusKey) (Array.from(list.querySelectorAll<HTMLElement>('[data-invite-action]')).find(button => button.dataset.inviteAction === focusKey) ?? box.querySelector<HTMLElement>('summary'))?.focus({ preventScroll: true })
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
  const generation = roomGeneration
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
      save.dataset.focusKey = `attachment-${index}`
      save.href = opened.url
      save.download = opened.name
      save.textContent = `Save ${opened.name} (${formatBytes(opened.size)})`
      card.append(save)
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = opened ? 'Try again' : 'Show'
    button.dataset.focusKey = `attachment-${index}`
    button.title = 'Fetch the encrypted file from where it is stored, check it, and open it here'
    button.addEventListener('click', async () => {
      button.disabled = true
      button.textContent = 'Fetching\u2026'
      try {
        const file = await fetchAttachment(a)
        if (generation !== roomGeneration) return
        const blob = new Blob([file.source.slice().buffer as ArrayBuffer], { type: file.type })
        openedAttachments.set(key, { url: URL.createObjectURL(blob), name: file.name, type: file.type, size: file.size })
      } catch (err) {
        // The reason and nothing else: an error here never carries the key.
        if (generation !== roomGeneration) return
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

/** The lane indicator: a glyph and a word, the meaning as its title. */
function laneChip(lane: Lane): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = `chip lane ${lane}`
  span.textContent = `${LANE_GLYPH[lane]} ${LANE_LABEL[lane]}`
  span.title = LANE_MEANING[lane]
  span.setAttribute('aria-label', `${LANE_LABEL[lane]} lane. ${LANE_MEANING[lane]}`)
  return span
}

/**
 * What lane the next message would take, beside the box people type into,
 * so the answer is there before they send rather than after. Read off the
 * relays the conversation writes to; nothing to show when it cannot say.
 */
function renderLaneNote(): void {
  const note = $('laneNote')
  const lane = activeChat()?.sendLane()
  note.replaceChildren()
  if (!lane) { note.hidden = true; return }
  note.hidden = false
  note.append(laneChip(lane))
  note.title = LANE_MEANING[lane]
}

function renderChat(messages: ChatMessage[]): void {
  renderLaneNote()
  // Minutes are written in paragraphs with their line breaks doing the
  // structural work, so the one log has to know which conversation it is
  // showing. See `#chatLog.minutes` in style.css.
  $('chatLog').classList.toggle('minutes', currentChannel === MINUTES_CHANNEL)
  renderLog('chatLog', undefined, messages, currentChannel === undefined ? systemLines : [])
  if (currentChannel === undefined) void handleInvites(messages)
  updateConversationSearch()
  if (currentChannel === undefined) noteChatRead(messages)
  markConversationRead()
}

function updateConversationSearch(): void {
  conversationSearch.update(conversationTabs().map(([channel, label]) => ({ channel, label, messages: conversationMessages(channel) })), currentChannel, message => {
    if (message.participant === meParticipant) return message.name ? `${message.name} (you)` : 'You'
    return shownAs(message.participant, message.name).name ?? message.participant.slice(0, 8)
  })
}

/**
 * Repaint whichever conversation is actually on screen.
 *
 * There is one log element and several conversations behind it, so anything
 * that repaints "the chat" has to say WHICH. Three callers did not: a new
 * message in the main chat, a profile arriving, and a system line all
 * redrew the log with the main chat whatever tab was selected. The tab
 * stayed lit, the words underneath it changed, and the box below carried on
 * writing to the conversation the person could no longer see. That is the
 * worst shape a bug can take in a room: you type into somewhere you are not
 * looking.
 *
 * Reads the already-open log rather than `activeChat`, which would open a
 * subscription as a side effect of a repaint.
 */
function repaintActiveChat(): void {
  const s = session
  if (!s) return
  const log = currentChannel === undefined ? s.chat : channelLogs.get(currentChannel)
  renderChat(log ? log.messages() : [])
}

// ---------------------------------------------------------------------------
// Channels
//
// Several conversations in one long-lived room. The mechanism was already
// here - a named channel takes its id and key from the room key by HKDF -
// and what was missing was discovery and a gate. The keeper publishes the
// list signed by the room's authority; this client believes that signature
// and nothing else, so typing a channel name into the chat creates nothing.
//
// The main chat is not in the list and never will be: it is the room, it
// has no name, and `deriveChannel` already spells that `undefined`.
// ---------------------------------------------------------------------------

/** The log currently shown by the composer. Named logs are followed when
 * the room announces them, so unread activity is visible before a click. */
function activeChat(): NonNullable<typeof session>['chat'] | undefined {
  const s = session
  if (!s) return undefined
  if (currentChannel === undefined) return s.chat
  return followNamedConversation(currentChannel)
}

function followNamedConversation(name: string): ReturnType<RoomSession['channel']> | undefined {
  if (!session) return undefined
  const owner = session
  let log = channelLogs.get(name)
  if (!log) {
    log = session.channel(name)
    channelLogs.set(name, log)
    channelCounts.set(name, log.messages().length)
    log.onChange(() => coalesceChatPaint(name, () => {
      if (session !== owner) return
      const messages = log!.messages()
      channelCounts.set(name, messages.length)
      if (currentChannel === name) renderChat(messages)
      renderChannels()
    }))
  }
  return log
}

/**
 * One repaint per burst, not one per message.
 *
 * A relay replays a room's history as a run of events, each in its own
 * websocket message, and each used to repaint the whole log: the log
 * cleared, every message rebuilt, the thread structure resolved, the
 * search index refreshed, notifications considered. Five hundred messages
 * of history was five hundred full repaints, which is the "ages loading
 * the chat" a person sees on opening a busy room or an agent's channel.
 * Now the listener records that a paint is owed and the last one in a
 * short window does it, reading the log's current messages when it runs.
 * A message typed live still lands inside the same window, which is under
 * a frame at 60 Hz.
 */
const CHAT_PAINT_COALESCE_MS = 40
const chatPaintTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; paint: () => void }>()
function coalesceChatPaint(key: string, paint: () => void): void {
  const owed = chatPaintTimers.get(key)
  // The newest closure wins: a room switched inside the window hands in a
  // paint for the new log, and the old one's guard would have done nothing.
  if (owed) { owed.paint = paint; return }
  const entry = {
    paint,
    timer: setTimeout(() => {
      chatPaintTimers.delete(key)
      entry.paint()
    }, CHAT_PAINT_COALESCE_MS),
  }
  chatPaintTimers.set(key, entry)
}

function conversationStorageKey(): string {
  return `kithmoot.conversation.v1.${nostrSession?.pubkey ?? 'visitor'}.${currentRoomId()}`
}

function restoreConversation(): void {
  if (currentChannel !== undefined) return
  try {
    const name = sessionStorage.getItem(conversationStorageKey())
    if (name && (channelAvailable(name) || draftHasWork(drafts.get(name)))) selectChannel(name)
  } catch {
    // Storage may be unavailable; Chat remains a usable starting point.
  }
}

function selectChannel(name: string | undefined): void {
  messageActions.close(false)
  chatScroll.remember()
  captureDraft()
  try { sessionStorage.setItem(conversationStorageKey(), name ?? '') } catch { /* Optional tab preference. */ }
  currentChannel = name
  $('conversationHeading').textContent = conversationLabel(name)
  restoreDraft()
  delete $('channelClose').dataset.arm
  renderChannels()
  const log = activeChat()
  renderChat(log ? log.messages() : [])
  const input = $('chatInput')
  if (input instanceof HTMLTextAreaElement) {
    input.placeholder = name === undefined ? 'Say something' : `Say something in ${name}`
    growComposer(input)
  }
  // Asking an agent in belongs with the agents' conversation, and nowhere else.
  renderInvites()
  renderRoomWho()
  // You picked it: you are done with the sheet you picked it in.
  closeRoomSheet()
  markConversationRead()
  renderConversationNav()
  const nav = $('conversationNav')
  const selected = nav.querySelector<HTMLElement>('[aria-pressed="true"]')
  if (selected) {
    const tab = selected.getBoundingClientRect()
    const bounds = nav.getBoundingClientRect()
    if (tab.left < bounds.left) nav.scrollLeft -= bounds.left - tab.left
    else if (tab.right > bounds.right) nav.scrollLeft += tab.right - bounds.right
  }
  // Chromium resets a revealed textarea's selection after this click has
  // finished. Restore it on the next frame, unless the reader moved on.
  if (input instanceof HTMLTextAreaElement && !$('chatForm').hidden) {
    const draft = drafts.get(currentChannel)
    const { text, selectionStart, selectionEnd, selectionDirection } = draft
    requestAnimationFrame(() => {
      if (currentChannel !== name || input.value !== text || document.activeElement === input) return
      const focused = document.activeElement
      input.setSelectionRange(selectionStart, selectionEnd, selectionDirection)
      // WebKit focuses a textarea when restoring its selection. A catch-up
      // action has already put focus in the log; keep that deliberate choice.
      if (focused instanceof HTMLElement && document.activeElement === input) focused.focus({ preventScroll: true })
    })
  }
}

function channelAvailable(name: string | undefined): boolean {
  return name === undefined || [AGENT_CHANNEL, TRANSCRIPT_CHANNEL, MINUTES_CHANNEL].includes(name) || channels.includes(name)
}

function captureDraft(): ConversationDraft {
  const draft = drafts.get(currentChannel)
  const input = $('chatInput') as HTMLTextAreaElement
  draft.text = input.value
  draft.selectionStart = input.selectionStart
  draft.selectionEnd = input.selectionEnd
  draft.selectionDirection = input.selectionDirection
  draft.event = ($('attachEvent') as HTMLInputElement).value
  draft.key = ($('attachKey') as HTMLInputElement).value
  return draft
}

function restoreDraft(): void {
  const draft = drafts.get(currentChannel)
  const input = $('chatInput') as HTMLTextAreaElement
  closeMentionPicker()
  input.value = draft.text
  input.setSelectionRange(draft.selectionStart, draft.selectionEnd, draft.selectionDirection)
  growComposer(input)
  ;($('attachEvent') as HTMLInputElement).value = draft.event
  ;($('attachKey') as HTMLInputElement).value = draft.key
  renderStaged()
  $('attachStatus').textContent = draft.status
  renderComposerContext()
}

function renderDraftBadges(): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('#channelBar button[data-channel], #conversationNav button[data-channel]')) {
    const name = tab.dataset.channel || undefined
    const draft = drafts.get(name)
    const badge = tab.querySelector<HTMLElement>('.draftBadge')!
    badge.textContent = !channelAvailable(name) ? 'Closed · Draft' : draft.job ? 'Adding files' : 'Draft'
    badge.hidden = !draftHasWork(draft)
  }
}

/** Async work may finish while another draft is on screen. Update its badge
 * without changing the current editor, attachment panel or keyboard focus. */
function draftChanged(draft: ConversationDraft): void {
  if (draft === drafts.get(currentChannel)) {
    renderStaged()
    $('attachStatus').textContent = draft.status
    renderComposer()
  }
  renderDraftBadges()
  if (($('roomSwitcher') as HTMLDialogElement).open) renderRoomSwitcher()
  renderWorkspace()
}

/**
 * What each tab is for, in words that do not assume you already know.
 *
 * Every one of these used to be a paragraph inside a collapsed panel below
 * the chat, which is to say nobody read them. One sentence, on the tab it
 * is about, is worth four paragraphs nobody opens.
 */
function channelPurpose(name: string | undefined): string {
  if (name === undefined) {
    const me = meParticipant || currentParticipant()
    const peer = me ? dmPeer(roomPolicy, me) : undefined
    if (peer) return `Only you and ${dmPeerName(peer)} can read this.`
    return 'Everybody in this room can read this, and can write here too.'
  }
  if (name === AGENT_CHANNEL) {
    return (
      'The agents’ shared conversation. Messages appear here as they arrive. ' +
      'Everybody in this room can read and reply.'
    )
  }
  if (name === TRANSCRIPT_CHANNEL) {
    return (
      'If an agent was allowed to listen, what people said out loud is written down here. ' +
      'Nothing appears from anybody who has “Let agents hear me” switched off, and who said what is ' +
      'what the agent reckons, not proof.'
    )
  }
  if (name === MINUTES_CHANNEL) {
    const base = 'A short write-up of what a call came to: who was there, what was decided, who is doing what. '
    // The instruction is only true while something in the room answers it,
    // and it is printed only then. Typing !minutes into a room with no
    // scribe posted a plain message and produced nothing at all - no
    // minutes, no refusal, no error - and a person who follows a written
    // instruction and gets silence concludes they did it wrong.
    return minuteTakerHere()
      ? base + 'Type !minutes in the chat to ask for one now. Like the transcript it is one agent’s account, not proof.'
      : base +
          'Nothing in this room is writing them at the moment, so there is nobody to ask and nothing to type. ' +
          'Minutes are written by an agent somebody brings in; the Agents tab says who is here and how one is asked in. ' +
          'When one is, they would be that agent’s account, not proof.'
  }
  return `A separate conversation in this room called ${name}. Everybody here can read it.`
}

/**
 * Whether anything in this room writes the minutes.
 *
 * The browser cannot ask, so it goes on what it can actually see, and both
 * halves are evidence rather than a guess. Minutes already on the channel
 * mean something here has written them. Otherwise: an agent that listens,
 * running now, offered by a host that is still in the room - which is the
 * only kind of member that writes them.
 *
 * When this is false the Minutes tab says so instead of printing an
 * instruction, and a typed !minutes is answered on the spot.
 */
function minuteTakerHere(): boolean {
  if ((channelCounts.get(MINUTES_CHANNEL) ?? 0) > 0) return true
  const present = new Set(session?.participants().map((v) => v.participant) ?? [])
  for (const [host, catalogue] of catalogues) {
    if (!present.has(host)) continue
    for (const running of catalogue.running) {
      if (catalogue.agents.some((entry) => entry.id === running.id && entry.listens)) return true
    }
  }
  return false
}

/**
 * Whether a line of chat asks for the minutes.
 *
 * The same rule the scribe applies - `isMinutesRequest` in
 * src/node/scribe.ts - written again rather than imported, because that
 * module is a Node agent and has no business in a browser bundle. Kept
 * deliberately narrow: this only decides whether to answer a request that
 * nothing will pick up, so a miss costs the old silence and never a wrong
 * word about a request that was heard.
 */
function asksForMinutes(text: string): boolean {
  return (text.trim().split(/\s+/)[0] ?? '').toLowerCase() === '!minutes'
}

function conversationLabel(name: string | undefined): string {
  if (name === undefined) return 'Chat'
  if (name === AGENT_CHANNEL) return 'Agents'
  if (name === TRANSCRIPT_CHANNEL) return 'Transcript'
  if (name === MINUTES_CHANNEL) return 'Minutes'
  return name
}

function conversationTabs(): Array<[string | undefined, string]> {
  const names = new Set([AGENT_CHANNEL, TRANSCRIPT_CHANNEL, MINUTES_CHANNEL, ...channels])
  for (const draft of drafts.pending()) if (draft.channel !== undefined) names.add(draft.channel)
  return [[undefined, 'Chat'], ...Array.from(names, name => [name, conversationLabel(name)] as [string, string])]
}

function conversationMessages(name: string | undefined): ChatMessage[] {
  return (name === undefined ? session?.chat : channelLogs.get(name))?.messages() ?? []
}

function unreadMessageIds(name: string | undefined): Set<string> {
  const read = conversationRead.get(name ?? '')
  return new Set(Array.from(resolveConversation(conversationMessages(name)).byKey.values())
    .filter(message => !message.retracted && message.original.participant !== meParticipant && !read?.has(message.original.id))
    .map(message => message.original.id))
}

function conversationUnread(name: string | undefined): number {
  return unreadMessageIds(name).size
}

function nextUnreadConversation(): [string | undefined, string] | undefined {
  const tabs = conversationTabs()
  const index = tabs.findIndex(([name]) => name === currentChannel)
  return [...tabs.slice(index + 1), ...tabs.slice(0, index)].find(([name]) => conversationUnread(name) > 0)
}

function markConversationRead(): boolean {
  if (chatScroll.restoring) return false
  const log = $('chatLog')
  if ($('roomArea').hidden || document.visibilityState !== 'visible' || document.querySelector('dialog[open], #messageActionPanel:popover-open') || log.scrollHeight - log.scrollTop - log.clientHeight > 48) return false
  const key = currentChannel ?? ''
  const messages = conversationMessages(currentChannel)
  const previous = conversationRead.get(key)
  if (previous?.size === messages.length && messages.every(message => previous.has(message.id))) return false
  conversationRead.set(key, new Set(messages.map(message => message.id)))
  return true
}

/**
 * The tabs a room shows above its conversation: Chat, and the others only
 * once there is something in them. A room with no agent and no call was
 * showing Chat, Agents, Transcript and Minutes, three of them empty, to
 * everybody who walked in. Room details still lists every conversation.
 */
function navTabs(): Array<[string | undefined, string]> {
  const agentsHere = (session?.participants() ?? []).some(view => view.agent)
  const pending = new Set(Array.from(drafts.pending(), draft => draft.channel))
  return conversationTabs().filter(([name]) => {
    if (name === undefined || name === currentChannel || pending.has(name)) return true
    if ((channelCounts.get(name) ?? 0) > 0) return true
    // Agents: when one is here, or a host has said which could be asked in.
    if (name === AGENT_CHANNEL) return agentsHere || [...catalogues.values()].some(catalogue => catalogue.agents.length > 0)
    // A conversation somebody opened on purpose is shown even while empty.
    return name !== TRANSCRIPT_CHANNEL && name !== MINUTES_CHANNEL
  })
}

let renderedTabKey = ''
function renderConversationNav(): void {
  renderedTabKey = navTabs().map(([name]) => name ?? '').join('\n')
  const next = nextUnreadConversation()
  $('nextUnread').hidden = !next
  $('nextUnread').textContent = next ? `Next unread: ${next[1]} (${conversationUnread(next[0])})` : ''
  $('nextUnread').title = $('nextUnread').textContent ?? ''
  const nav = $('conversationNav')
  const focused = document.activeElement as HTMLElement | null
  const focusedChannel = focused && nav.contains(focused) ? focused.closest<HTMLElement>('[data-channel]')?.dataset.channel : undefined
  const scroll = nav.scrollLeft
  nav.replaceChildren()
  const tabs = navTabs()
  nav.hidden = tabs.length < 2
  for (const [name, label] of tabs) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.channel = name ?? ''
    button.title = channelSummary(name)
    button.setAttribute('aria-pressed', String(name === currentChannel))
    button.append(label)
    const count = conversationUnread(name)
    if (count > 0) {
      const badge = document.createElement('span')
      badge.className = 'conversationUnread'
      badge.textContent = count > 99 ? '99+' : String(count)
      badge.setAttribute('aria-label', `${count} unread messages`)
      button.append(badge)
    }
    const draft = document.createElement('span')
    draft.className = 'draftBadge'
    button.append(draft)
    button.addEventListener('click', () => selectChannel(name))
    nav.append(button)
  }
  renderDraftBadges()
  nav.scrollLeft = scroll
  if (focusedChannel !== undefined) {
    Array.from(nav.querySelectorAll<HTMLButtonElement>('button')).find(button => button.dataset.channel === focusedChannel)?.focus({ preventScroll: true })
  }
}

function renderAgentActivity(): void {
  const agents = (session?.participants() ?? []).filter(view => view.agent)
  const watching = currentChannel === AGENT_CHANNEL
  const activity = $('agentActivity')
  activity.hidden = !watching && agents.length === 0
  $('agentActivityTitle').textContent = agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'} in this room` : 'No agents here yet'
  const names = agents.slice(0, 3).map(view => shownAs(view.participant, view.name).name ?? shortKey(view.participant)).join(', ')
  $('agentActivityNote').textContent = watching
    ? agents.length ? `${names}${agents.length > 3 ? ` +${agents.length - 3} more` : ''}` : 'Invite an agent, or read earlier messages here.'
    : `${names}${agents.length > 3 ? ` +${agents.length - 3} more` : ''} · Read what they say to each other.`
  $('watchAgents').hidden = watching
  $('manageAgents').hidden = !watching
}

function renderChannels(): void {
  updateConversationSearch()
  const bar = $('channelBar')
  const focused = document.activeElement as HTMLElement | null
  const focusedChannel = focused && bar.contains(focused) ? focused.closest<HTMLButtonElement>('button[data-channel]')?.dataset.channel : undefined
  const s = session
  const tabs = conversationTabs()

  bar.hidden = !s
  bar.innerHTML = ''
  if (!bar.hidden) {
    for (const [name, label] of tabs) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.dataset.channel = name ?? ''
      const on = currentChannel === name
      tab.setAttribute('aria-pressed', String(on))
      const heading = document.createElement('span')
      heading.className = 'channelName'
      heading.append(label)
      const draftBadge = document.createElement('span')
      draftBadge.className = 'draftBadge'
      heading.append(draftBadge)
      // A dot beside a conversation that has something in it. Nothing beside
      // one that does not, so an eye running down this list for the first
      // time goes to the places where somebody has actually said something.
      const said = name === undefined ? (session?.chat.messages().length ?? 0) : (channelCounts.get(name) ?? 0)
      if (said > 0) {
        const dot = document.createElement('span')
        dot.className = 'tabDot'
        dot.setAttribute('aria-label', 'has messages')
        heading.append(dot)
      }
      const desc = document.createElement('span')
      desc.className = 'channelDesc'
      desc.textContent = channelSummary(name)
      tab.append(heading, desc)
      tab.addEventListener('click', () => selectChannel(name))
      bar.append(tab)
    }
  }
  renderDraftBadges()
  if (focusedChannel !== undefined) {
    const replacement = Array.from(bar.querySelectorAll<HTMLButtonElement>('button[data-channel]')).find(button => button.dataset.channel === focusedChannel)
    ;(replacement ?? $('roomSheetClose')).focus({ preventScroll: true })
  }
  renderComposer()
  renderRoomWho()
  renderConversationNav()

  // Creating and closing a channel is structure, so it is an admin's to do
  // and the controls are absent rather than disabled for everybody else.
  //
  // And absent without a keeper, because there would be nobody to ask. The
  // list is signed by the room's authority, and the only process that holds
  // the authority key and stays in the room is its keeper - the browser that
  // opened the room holds that key too, but a second announcer would mean
  // two signed lists disagreeing, which is worse than not offering it. So
  // channels are a thing a room WITH a keeper has, which is the long-lived
  // room this is for; an ad-hoc call between two people has one
  // conversation and needs no tabs above it.
  const isAdmin = s !== undefined && admins.has(meParticipant) && keeperParticipant !== undefined
  $('channelNew').hidden = !isAdmin
  const close = $('channelClose')
  close.hidden = !isAdmin || currentChannel === undefined || !channelAvailable(currentChannel)
  if (!close.hidden && close.dataset.arm !== currentChannel) close.textContent = `Close ${currentChannel}`
}

/** A few words for the list of conversations. The careful version is
 *  `channelPurpose`, said at the head of the conversation itself, where
 *  there is room for it and where somebody is actually reading. */
function channelSummary(name: string | undefined): string {
  if (name === undefined) return 'Everybody here can read and write.'
  if (name === AGENT_CHANNEL) return 'What the agents say to each other.'
  if (name === TRANSCRIPT_CHANNEL) return 'What was said out loud, written down.'
  if (name === MINUTES_CHANNEL) return 'A write-up of what a call came to.'
  return 'Another conversation in this room.'
}

/**
 * The note at the head of a conversation: what this one is for, and whether
 * anything has been said in it.
 *
 * "Nothing here yet" is the sentence that makes an always-listed
 * conversation honest. Without it an empty Agents channel looks like
 * something that failed to load, and a person who has never used the app has
 * no way to tell the difference between "quiet" and "broken".
 */
function introLines(): DocumentFragment {
  const run = document.createDocumentFragment()
  const name = currentChannel

  // The room's own note first, and only in the room's own conversation: it
  // is about who is here, not about this channel.
  const agents = agentsSentence(name === undefined ? (session?.participants() ?? []).filter((v) => v.agent).length : 0)
  if (agents) {
    const p = document.createElement('p')
    p.className = 'system intro'
    p.append(agents)
    run.append(p)
  }

  const said = name === undefined ? (session?.chat.messages().length ?? 0) : (channelCounts.get(name) ?? 0)
  const empty =
    name === undefined
      ? roomPolicy?.members?.length ? ' Write a message below to start the conversation.' : ' Use Invite people to bring others in, or write a message below.'
      : ' Nothing has been said here yet.'
  const p = document.createElement('p')
  p.className = 'system intro'
  p.textContent = channelPurpose(name) + (said === 0 ? empty : '')
  run.append(p)
  return run
}

/** The two conversations nobody types into. Both are an agent writing
 *  something down, and a box under them said otherwise. */
const WRITTEN_BY_AGENTS: readonly string[] = [TRANSCRIPT_CHANNEL, MINUTES_CHANNEL]

/**
 * The box to write in, and whether this conversation has one.
 *
 * A record of what was said aloud, with a box under it offering to let you
 * type into the record, undermines the one claim the tab makes about
 * itself. So on those two the box goes and a line says where to write
 * instead - which is also the answer to "I typed in here and nothing
 * happened".
 */
function renderComposer(): void {
  const readOnly = currentChannel !== undefined && WRITTEN_BY_AGENTS.includes(currentChannel)
  const closed = !channelAvailable(currentChannel)
  const draft = drafts.get(currentChannel)
  $('chatForm').hidden = readOnly
  ;($('chatInput') as HTMLTextAreaElement).readOnly = closed
  ;($('emojiToggle') as HTMLButtonElement).disabled = readOnly || closed
  if (readOnly || closed) emojiPicker.close()
  ;($('attachToggle') as HTMLButtonElement).disabled = closed
  ;($('chatForm').querySelector('button[type=submit]') as HTMLButtonElement).disabled = readOnly || closed || Boolean(draft.job)
  $('attachStaged').hidden = readOnly
  $('attachPanel').hidden = readOnly || !draft.panelOpen
  for (const id of ['attachFile', 'attachAdd', 'attachEvent', 'attachKey']) {
    ;($(id) as HTMLInputElement | HTMLButtonElement).disabled = closed || Boolean(draft.job)
  }
  $('cancelFileWork').hidden = !draft.job
  const discard = $('discardDraft') as HTMLButtonElement
  discard.hidden = !draftHasWork(draft)
  $('draftHelp').hidden = drafts.pending().length === 0
  const note = $('readOnlyNote')
  note.hidden = !readOnly && !closed
  if (closed) {
    note.textContent = 'This conversation is closed. Your draft stays here for you to copy. You can discard it from Room details.'
    return
  }
  if (!readOnly) return
  note.textContent =
    currentChannel === MINUTES_CHANNEL
      ? 'Nothing is typed here. Minutes are written by an agent; the Chat tab is where you say something to the room.'
      : 'Nothing is typed here. This is written down by an agent as people speak; the Chat tab is where you say something to the room.'
}

/** Ask the keeper to open or close one. A request, not an announcement:
 *  what the room believes is the signed list that comes back. */
async function requestChannel(name: string, open: boolean): Promise<void> {
  const s = session
  if (!s) return
  try {
    await s.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'channel', name, open }))
  } catch (err) {
    setStatus(describeError(err))
  }
}

// ---------------------------------------------------------------------------
// When something was said
//
// There was no time on anything. A person reading a room they had just been
// let into could not tell a conversation from ten minutes ago from one from
// three weeks ago, which is the first thing anybody wants to know and the
// thing that decides whether to expect an answer.
//
// The form changes with the age, because the question does. Inside the hour
// what matters is how long ago; today, the clock; this week, which day;
// older than that, the date. The exact moment is always on the element's
// title for anybody who wants it.
// ---------------------------------------------------------------------------

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const DATE_SHORT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const DATE_YEAR = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const DATE_FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })

const DAY_MS = 86_400_000

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** `sentAt` is the sender's own clock in seconds, so a message can arrive
 *  dated slightly ahead of ours. Anything not yet past reads as just now
 *  rather than as a negative age. */
function whenWords(at: number, now: number = Date.now()): string {
  const then = new Date(at * 1000)
  const seconds = Math.round((now - then.getTime()) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60))
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  }
  const today = new Date(now)
  if (sameDay(then, today)) return CLOCK.format(then)
  if (sameDay(then, new Date(now - DAY_MS))) return `yesterday ${CLOCK.format(then)}`
  if (now - then.getTime() < 7 * DAY_MS) return `${WEEKDAY.format(then)} ${CLOCK.format(then)}`
  return then.getFullYear() === today.getFullYear() ? DATE_SHORT.format(then) : DATE_YEAR.format(then)
}

function messageWhen(at: number, now: number = Date.now()): string {
  const moment = new Date(at * 1000)
  const today = new Date(now)
  if (sameDay(moment, today)) return CLOCK.format(moment)
  const date = moment.getFullYear() === today.getFullYear() ? DATE_SHORT : DATE_YEAR
  return `${date.format(moment)} · ${CLOCK.format(moment)}`
}

function timeChip(at: number, exact = false): HTMLTimeElement {
  const el = document.createElement('time')
  el.className = 'when'
  const moment = new Date(at * 1000)
  el.dateTime = moment.toISOString()
  // Kept on the element so the once-a-minute pass can rewrite the words
  // without the log being rebuilt.
  el.dataset.at = String(at)
  el.dataset.exact = String(exact)
  el.textContent = exact ? messageWhen(at) : whenWords(at)
  el.title = DATE_FULL.format(moment)
  el.setAttribute('aria-label', DATE_FULL.format(moment))
  return el
}

/** "3 minutes ago" stops being true three minutes later. Only the words in
 *  the time elements already on screen are rewritten; nothing else moves. */
setInterval(() => {
  const now = Date.now()
  for (const el of document.querySelectorAll<HTMLTimeElement>('time.when[data-at]')) {
    const at = Number(el.dataset.at)
    if (Number.isFinite(at)) el.textContent = el.dataset.exact === 'true' ? messageWhen(at, now) : whenWords(at, now)
  }
}, 60_000)

// ---------------------------------------------------------------------------
// Mentions
//
// Saying somebody's name is how you address them, and for an agent it is
// what decides whether it answers at all. Who a message addresses is now on
// the wire (`ChatMessage.mentions`, see docs/messages.md), and one function,
// `mentionedBy` in src/messages.ts, reads it for the room and for every
// agent, so what the room SHOWS as addressed is exactly what an agent
// ANSWERS to. A message from before the field existed is read by name: an
// `@` before the name, or the name on its own as a whole word, without
// regard to case. What follows marks the names in the text either way, so a
// name still reads as a name in a room full of them.
//
// Bare names count deliberately: people were typing names here long before
// there was an @ to type, and the picker is there to make the good path
// easy rather than to make the old one fail.
// ---------------------------------------------------------------------------

/** The names this room knows: everybody on the roster right now. */
function rosterNames(): string[] {
  return (session?.participants() ?? []).map((v) => v.name?.trim() ?? '').filter((n) => n.length > 0)
}

/** What a message calls ME, so a mention of the reader can be marked as
 *  such. Both the name I typed and the one my profile carries. */
function myNames(): Set<string> {
  const mine = new Set<string>()
  const typed = joiningName()
  if (typed) mine.add(typed.toLowerCase())
  if (meParticipant) {
    const shown = shownAs(meParticipant).name
    if (shown) mine.add(shown.toLowerCase())
  }
  return mine
}

/** One pattern for every name in the room, longest first so "The moot"
 *  wins over a shorter name inside it. Word boundaries by letter-or-digit
 *  rather than \b, exactly as the agent side does them, so a name that is
 *  not ASCII still gets the boundary it needs and a name with a space in it
 *  still works. */
function mentionPattern(names: string[]): RegExp | undefined {
  const wanted = [...new Set(names)].sort((a, b) => b.length - a.length)
  const alternatives = wanted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  try {
    const named = alternatives ? `|(?<![\\p{L}\\p{N}_])@?(?:${alternatives})(?![\\p{L}\\p{N}_])` : ''
    return new RegExp(`${ROOM_MENTION_PATTERN.source}${named}`, 'giu')
  } catch {
    // A name that will not compile is a name nobody gets highlighted for,
    // which is better than a log that fails to draw.
    return undefined
  }
}

/**
 * A message's words, with the names in it marked.
 *
 * A mention is set apart from ordinary words, and a mention of the reader
 * is set apart again - that is the one thing a person scans a busy room
 * for. Everything goes in through `textContent`; nothing here builds
 * markup out of somebody else's text.
 */
function appendWithMentions(into: HTMLElement, text: string, pattern: RegExp | undefined, mine: Set<string>): void {
  if (!pattern) {
    into.append(text)
    return
  }
  let at = 0
  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > at) into.append(text.slice(at, start))
    const span = document.createElement('span')
    span.className = 'mention'
    if (ROOM_MENTION_PATTERN.test(token) || mine.has(token.replace(/^@/, '').toLowerCase())) span.classList.add('me')
    span.textContent = token
    into.append(span)
    at = start + token.length
  }
  if (at < text.length) into.append(text.slice(at))
}

/**
 * One conversation into one element: the chat, the agents' channel, the
 * transcript. A transcript line names the speaker the transcriber claims,
 * beside a key exactly as a name is, and says who wrote it down.
 */
function renderLog(logId: string, countId: string | undefined, messages: ChatMessage[], system: SystemLine[] = []): void {
  const log = $(logId)
  const unread = unreadMessageIds(currentChannel)
  const restoreScroll = chatScroll.before(currentChannel ?? '', unread)
  log.innerHTML = ''
  // What this conversation is, at the top of it, the way a messaging app
  // puts the thing you should know once at the head of the thread.
  if (session) log.append(introLines())
  pruneOpenedAttachments(logId, messages)
  profiles.want(messages.flatMap((m) => (m.speaker ? [m.participant, m.speaker] : [m.participant])))

  // Built once for the whole log rather than once per message: it is one
  // pattern over the whole roster and rebuilding it per line is the sort of
  // thing that only shows up in a room with a thousand messages in it.
  const mentions = mentionPattern(rosterNames())
  const namesOfMine = myNames()
  const roster = session?.participants() ?? []
  // The log as a person reads it rather than as the relay holds it: the
  // latest edit's words on each message, a retracted one shown as such,
  // replies under the message they answer. See `resolveConversation` and
  // docs/messages.md.
  const conversation = resolveConversation(messages)
  const writable = channelAvailable(currentChannel) && !(currentChannel && WRITTEN_BY_AGENTS.includes(currentChannel))

  // System lines sit in the log where they happened, and look like nothing
  // anybody sent: no name, no key, because nobody did.
  let nextSystem = 0
  const systemUpTo = (at: number): void => {
    // Strictly earlier, not "at or before". A line the page writes about a
    // message - the answer to a typed !minutes - is stamped in the same
    // second as the message itself, and `<=` put the answer above the
    // question.
    while (nextSystem < system.length && system[nextSystem]!.at < at) {
      const line = system[nextSystem]!
      const p = document.createElement('p')
      p.className = 'system'
      p.append(timeChip(line.at), line.text)
      if (line.room) {
        // "It is in your rooms" is an answer; the way there is a button.
        const room = line.room
        const open = document.createElement('button')
        open.type = 'button'
        open.className = 'quiet openRoom'
        open.textContent = 'Open it'
        open.setAttribute('aria-label', `Open ${knownRoomLabel(room)}`)
        open.addEventListener('click', () => switchRoom(room))
        p.append(' ', open)
      }
      log.append(p)
      nextSystem++
    }
  }

  const chip = (text: string, title: string, kind: string): HTMLSpanElement => {
    const span = document.createElement('span')
    span.className = `chip ${kind}`
    span.textContent = text
    span.title = title
    return span
  }

  const paint = (r: ResolvedMessage, into: HTMLElement, nested: boolean): void => {
    const m = r.shown
    const original = r.original
    if (!nested) systemUpTo(original.sentAt)

    // A transcript line is not a message somebody sent: it is a note of
    // what a microphone heard, written down by a third party. It keeps the
    // flat, italic form, because putting it in a speech bubble would claim
    // the speaker typed it.
    if (m.kind === 'transcript') {
      const p = document.createElement('p')
      p.className = 'transcript'
      p.dataset.messageId = original.id
      p.dataset.messageAuthor = original.participant
      const who = document.createElement('span')
      who.className = 'who'
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
      p.append(timeChip(original.sentAt, true), who)
      appendWithMentions(p, m.text, mentions, namesOfMine)
      p.append(by)
      for (const [i, a] of (m.attachments ?? []).entries()) p.append(attachmentCard(logId, m, i, a))
      into.append(p)
      return
    }

    const mine = original.participant === meParticipant
    const fromAgent = participantIsAgent(original.participant)
    const row = document.createElement('div')
    row.className = `msg ${mine ? 'mine' : 'theirs'}${fromAgent ? ' fromAgent' : ''}${r.retracted ? ' retracted' : ''}`
    row.dataset.messageId = original.id
    row.dataset.messageAuthor = original.participant
    row.dataset.sentAt = String(original.sentAt)
    row.dataset.senderGroup = JSON.stringify([original.participant, original.name, original.owner, fromAgent, original.kind])
    const previous = into.lastElementChild as HTMLElement | null
    const previousAt = Number(previous?.dataset.sentAt)
    if (!r.retracted && previous?.classList.contains('msg') && !previous.classList.contains('retracted') &&
      previous.dataset.senderGroup === row.dataset.senderGroup && original.sentAt - previousAt >= 0 &&
      original.sentAt - previousAt < 5 * 60 && new Date(original.sentAt * 1000).toDateString() === new Date(previousAt * 1000).toDateString()) row.classList.add('continuation')
    // Addressed to the reader, by the field on the wire or by name on a
    // message from before the field existed: the one thing a person scans
    // a busy room for, and exactly what an agent would answer to. Your own
    // message is not addressed to you, whatever names it says.
    if (!mine && !r.retracted && meParticipant && mentionedBy(m, meParticipant, roster)) row.classList.add('mentionsMe')

    // Who said it, above the bubble, the way every group chat does it.
    // Left-alignment says "not you"; in a room of six it does not say WHO,
    // and this is the same name-and-key run the tiles use - a line of chat
    // is exactly where a name alone would be most convincing and least
    // checkable, so the short pubkey comes with it. The name on the message
    // is the sender's own claim, carried with it (see ChatMessage.name).
    const header = document.createElement('div')
    header.className = 'messageHeader'
    {
      const sender = document.createElement('div')
      sender.className = 'sender'
      sender.append(identityRun(shownAs(original.participant, original.name), mine, true))
      // The tag, in the same place and the same colour as on the roster, so
      // a bubble from a program is recognisable without reading a word.
      if (fromAgent) {
        const badge = document.createElement('span')
        badge.className = 'badge agent'
        badge.textContent = 'agent'
        badge.title = 'An agent, not a person'
        sender.append(badge)
      }
      // Whose agent wrote this, from the proof carried on the message and
      // verified as at its send time - see ChatMessage.owner.
      if (original.owner) sender.append(ownerRun(original.owner))
      header.append(sender)
    }
    // The time it was first said. An edit does not move a message.
    header.append(timeChip(original.sentAt, true))
    // The lane it travelled, from where the bytes went and never from what
    // the message says about itself. Glyph and word, so it reads without
    // colour; the meaning is in the title and is the same everywhere.
    if (original.lane) header.append(laneChip(original.lane))
    if (r.edited && !r.retracted) {
      header.append(chip('edited', `Edited${r.edits.length > 1 ? ` ${r.edits.length} times` : ''}. Earlier versions are kept on every device that received them.`, 'edited'))
    }
    if (r.orphan) header.append(chip('in a thread', 'Part of a thread whose first message is not loaded here.', 'orphan'))
    if (nested && r.reply && r.thread && !sameRef(r.reply, r.thread)) {
      const target = conversation.byKey.get(refKey(r.reply))
      header.append(chip(`replying to ${target ? senderLabel(target.original) : personLabel(r.reply.participant)}`, 'Answers a message further up this thread.', 'replyTo'))
    }
    row.append(header)

    const body = document.createElement('div')
    body.className = 'messageBody'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const text = document.createElement('span')
    text.className = 'text'
    if (r.retracted) {
      // A placeholder rather than nothing: something was said here, and a
      // gap where a message was is a thing people argue about. Cooperative,
      // and the title says so.
      text.textContent = 'Message retracted'
      bubble.title = 'Retracted by its author. Every device that already received it still holds it, and the relays hold it encrypted; it is marked, not erased.'
      bubble.append(text)
      row.append(bubble)
      into.append(row)
      if (!nested && r.replies.length) paintThread(r, into)
      return
    }
    // textContent, never innerHTML: this is somebody else's text. The line
    // breaks in it are kept - the box people type into makes them now - and
    // the names in it are marked. Yours too, except in your own message:
    // saying your own name is not being addressed.
    appendWithMentions(text, m.text, mentions, mine ? new Set<string>() : namesOfMine)
    bubble.append(text)
    for (const [i, a] of (m.attachments ?? []).entries()) bubble.append(attachmentCard(logId, m, i, a))
    body.append(bubble)
    row.append(body)
    const reactions = reactionsFor(messages, original)
    const react = (emoji: string): boolean => {
      const chat = activeChat() ?? session?.chat
      if (!chat || !meParticipant) return false
      try {
        const reaction = toggleReaction(chat.messages(), original, meParticipant, emoji)
        const text = reactionText(reaction)
        outbox.send(text, currentChannel ?? 'Chat', chat.prepareSend(text, { reaction }))
        if (reaction.active) {
          const current = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
            .find(row => row.dataset.messageId === original.id && row.dataset.messageAuthor === original.participant)
          const anchor = current?.querySelector<HTMLElement>('.bubble')
          if (anchor) showReactionFeedback(anchor, emoji)
        }
        return true
      } catch (error) { setStatus(describeError(error)); return false }
    }
    if (writable) {
      bubble.classList.add('reactableBubble')
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'messageMore'
      more.textContent = '⋯'
      more.title = 'Reply, react and more'
      more.dataset.focusKey = 'message-actions'
      more.setAttribute('aria-label', `Actions for message from ${senderLabel(original)}`)
      more.setAttribute('aria-haspopup', 'dialog')
      more.setAttribute('aria-controls', 'messageActionPanel')
      more.setAttribute('aria-expanded', 'false')
      const openActions = (anchor: HTMLElement, reactionsOnly = false): void => {
        const actions: MessageAction[] = [{ label: `Reply to ${senderLabel(original)}`, text: 'Reply', run: () => setComposing({ replyTo: original }) }]
        if (mine && !original.kind) actions.push(
          { label: 'Edit this message', text: 'Edit message', run: () => setComposing({ editing: original }, resolveConversation(activeChat()?.messages() ?? []).byKey.get(refKey({ messageId: original.id, participant: original.participant }))?.shown ?? m) },
          { label: 'Retract this message', text: 'Retract message', danger: true, run: () => { void retractMessage(original) } },
        )
        messageActions.open(anchor, reactionsOnly ? [] : actions, REACTION_EMOJIS.map(emoji => {
          const mineToo = reactions.get(emoji)!.some(entry => entry.reaction!.active && entry.participant === meParticipant)
          return { label: `${mineToo ? 'Remove' : 'Add'} ${emoji} reaction`, text: emoji, pressed: mineToo, run: () => react(emoji) }
        }))
      }
      more.addEventListener('click', () => openActions(more))
      const addReaction = document.createElement('button')
      addReaction.type = 'button'
      addReaction.className = 'messageReact'
      addReaction.textContent = '☺+'
      addReaction.title = 'Add a reaction'
      addReaction.dataset.focusKey = 'add-reaction'
      addReaction.setAttribute('aria-label', `React to message from ${senderLabel(original)}`)
      addReaction.setAttribute('aria-haspopup', 'dialog')
      addReaction.setAttribute('aria-controls', 'messageActionPanel')
      addReaction.setAttribute('aria-expanded', 'false')
      addReaction.addEventListener('click', () => openActions(addReaction, true))
      const controls = document.createElement('div')
      controls.className = 'messageControls'
      controls.append(addReaction, more)
      body.append(controls)
    }
    const reactionBar = document.createElement('div'); reactionBar.className = 'messageReactions'
    reactionBar.setAttribute('aria-label', 'Message reactions')
    for (const emoji of REACTION_EMOJIS) {
      const entries = reactions.get(emoji)!.filter(entry => entry.reaction!.active)
      if (!entries.length) continue
      const button = document.createElement('button'); button.type = 'button'
      const mineToo = entries.some(entry => entry.participant === meParticipant)
      button.textContent = `${emoji} ${entries.length}`
      button.dataset.focusKey = `reaction-${emoji}`
      button.setAttribute('aria-pressed', String(mineToo))
      button.setAttribute('aria-label', `${mineToo ? 'Remove' : 'Add'} ${emoji} reaction, ${entries.length}`)
      button.setAttribute('aria-disabled', String(!writable))
      button.addEventListener('click', () => {
        if (!writable || button.getAttribute('aria-disabled') === 'true') return
        button.setAttribute('aria-disabled', 'true')
        if (!react(emoji)) button.setAttribute('aria-disabled', 'false')
      })
      const chip = document.createElement('span')
      chip.className = 'reactionChip'
      const details = document.createElement('span')
      details.className = 'reactionDetails'
      details.popover = 'manual'
      details.id = `reaction-details-${original.participant}-${original.id}-${REACTION_EMOJIS.indexOf(emoji)}`
      details.setAttribute('role', 'tooltip')
      const heading = document.createElement('strong')
      heading.textContent = `${emoji} Reactions`
      details.append(heading)
      for (const entry of entries) {
        const shown = shownAs(entry.participant, entry.name)
        const person = document.createElement('span')
        person.className = 'reactionPerson'
        person.append(pictureOf(shown, true)!)
        const info = document.createElement('span')
        info.className = 'reactionPersonInfo'
        const name = document.createElement('strong')
        name.textContent = `${shown.name ?? 'No name'}${entry.participant === meParticipant ? ' (you)' : ''}`
        info.append(name)
        if (shown.nip05) {
          const address = document.createElement('span')
          address.className = 'nip05'
          address.textContent = shown.nip05.startsWith('_@') ? shown.nip05.slice(2) : shown.nip05
          address.title = 'This domain maps the Nostr address to this public key.'
          info.append(address)
        }
        const key = document.createElement('span')
        key.className = 'reactionNpub'
        key.textContent = shown.npub
        const timestamp = document.createElement('time')
        timestamp.dateTime = new Date(entry.sentAt * 1000).toISOString()
        const received = entry.reaction?.receipt === 'received'
        timestamp.textContent = `${received ? 'Received' : 'Reacted'} ${new Date(entry.sentAt * 1000).toLocaleString()}`
        info.append(key, timestamp)
        if (received) {
          const receipt = document.createElement('span')
          receipt.className = 'reactionReceipt'
          receipt.textContent = 'Room connection; reply may still be pending.'
          info.append(receipt)
        }
        person.append(info)
        details.append(person)
      }
      button.setAttribute('aria-describedby', details.id)
      let hideTimer: ReturnType<typeof setTimeout> | undefined
      const keepDetails = (): void => { clearTimeout(hideTimer) }
      const hideDetails = (): void => { keepDetails(); if (details.matches(':popover-open')) details.hidePopover() }
      const queueHideDetails = (): void => { keepDetails(); hideTimer = setTimeout(hideDetails, 150) }
      const showDetails = (): void => {
        keepDetails()
        // Top layer: a long list of names must not be clipped by the chat log.
        document.querySelectorAll<HTMLElement>('.reactionDetails:popover-open').forEach(other => { if (other !== details) other.hidePopover() })
        details.showPopover()
        const anchor = button.getBoundingClientRect()
        const bounds = details.getBoundingClientRect()
        details.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8))}px`
        const above = anchor.top - bounds.height - 4
        details.style.top = `${Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 4, innerHeight - bounds.height - 8))}px`
      }
      button.addEventListener('pointerenter', showDetails)
      button.addEventListener('pointerleave', queueHideDetails)
      details.addEventListener('pointerenter', keepDetails)
      details.addEventListener('pointerleave', queueHideDetails)
      button.addEventListener('focus', showDetails)
      button.addEventListener('blur', hideDetails)
      chip.append(button, details)
      reactionBar.append(chip)
    }
    if (reactionBar.childElementCount) row.append(reactionBar)
    into.append(row)
    if (!nested && r.replies.length) paintThread(r, into)
  }

  // Replies sit under their root, indented and ruled, in time order. One
  // level: a reply to a reply still sits in the same thread and says which
  // message it answers in a chip, which is how Slack shows the same thing.
  const paintThread = (root: ResolvedMessage, into: HTMLElement): void => {
    const thread = document.createElement('div')
    thread.className = 'thread'
    thread.setAttribute('role', 'group')
    thread.setAttribute('aria-label', `${root.replies.length} ${root.replies.length === 1 ? 'reply' : 'replies'}`)
    for (const reply of root.replies) paint(reply, thread, true)
    into.append(thread)
  }

  for (const r of conversation.stream) paint(r, log, false)
  systemUpTo(Number.POSITIVE_INFINITY)
  if (countId) $(countId).textContent = conversation.byKey.size ? `(${conversation.byKey.size})` : ''
  restoreScroll()
  messageActions.refresh()
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

/** Follow the advertised screen role across a track replacement or reconnect. */
function screenSource(participant: string, device: string): ShareSource | undefined {
  const person = session?.participants().find(view => view.participant === participant)
  if (!person) return undefined
  const advert = person.tracks.find(track => track.device === device && track.role === 'screen')
  let track = participant === meParticipant && device === myDeviceId
    ? screenTrack : advert ? remoteVideos.get(`${device}|${advert.trackId}`)?.track : undefined
  // The advert says a screen is on and a picture from that device is
  // playing under some other name: a receiver id the browser minted on a
  // rebuilt connection, before the slot logic caught up. Any live video
  // from the device that is not its camera is the share, and "Expand"
  // must not be missing while the picture is plainly there.
  if (!track && advert && device !== myDeviceId) {
    const cameraId = person.tracks.find(t => t.device === device && t.role === 'camera')?.trackId
    for (const [key, entry] of remoteVideos) {
      if (!key.startsWith(`${device}|`) || entry.track.readyState !== 'live') continue
      if (cameraId !== undefined && key === `${device}|${cameraId}`) continue
      track = entry.track
      break
    }
  }
  if (!track || track.readyState !== 'live') return undefined
  const name = participant === meParticipant ? 'Your screen' : `${shownAs(participant, person.name).name ?? shortKey(participant)}’s screen`
  return { id: advert?.trackId ?? track.id, track, title: name }
}
const remoteAudios = new Map<string, { el: HTMLAudioElement; track: MediaStreamTrack }>()

/**
 * The key our own microphone is tapped under.
 *
 * NOT `myDeviceId`. The mic can be switched on before joining - that is the
 * ordinary path, and the one the acceptance test drives - and `myDeviceId`
 * is empty until the join builds the device key. Keying the local tap on it
 * registered every pre-join microphone under `''`, so a person's own tile
 * never lit while everybody else's did. A constant cannot be too early, and
 * cannot collide with a device id, which is 64 hex characters.
 */
/**
 * The trust chip on somebody else's tile.
 *
 * Three states, and only one of them is an accusation:
 *
 *   new       never verified. Not a warning - most people are new, and
 *             colouring that as a problem teaches people to ignore it.
 *   verified  this exact key was verified on this device before.
 *   changed   a key you verified uses this name, and this is not it. This
 *             is the one that matters, and it is the shape the September
 *             incident took.
 *
 * Clicking it shows the words to say. See `src/verification.ts` for what
 * they do and do not prove - the panel says so too, because a verification
 * story that overclaims is worse than none.
 */
function verifyChip(view: ParticipantView, name: string): HTMLElement {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'verifyChip'
  const seen = participantVerification(deviceStore, view.participant, name)
  chip.classList.add(seen.status)

  if (seen.status === 'verified') {
    chip.textContent = 'checked'
    chip.title = `You checked this was really them on ${new Date((seen.verifiedAt ?? 0) * 1000).toLocaleDateString()}`
  } else if (seen.status === 'key-changed') {
    chip.textContent = 'code changed'
    chip.title =
      `Last time, this name had a DIFFERENT code (${short(seen.expected ?? '')}). ` +
      'Either they have a new device, or this is somebody else. Check before you trust it.'
  } else {
    chip.textContent = 'not checked'
    chip.title = 'You have not checked yet that this is really them. Tap to see the words to say out loud.'
  }

  chip.addEventListener('click', () => showVerification(view, name, seen.status))
  return chip
}

/**
 * The words, and the one button that means "yes, that is them".
 *
 * A real dialog rather than `confirm()`: the words have to be read carefully
 * and said out loud, and a browser alert with newlines in it is the wrong
 * furniture for the one security ritual this app has. `showModal` brings the
 * focus trap and Escape with it.
 */
function showVerification(view: ParticipantView, name: string, status: string): void {
  if (!session) return
  let words: { mine: string; theirs: string }
  try {
    words = session.verificationWords(view.participant)
  } catch {
    // A participant with no words - ourselves, or a malformed key - has
    // nothing honest to show, and a plausible-looking panel would be worse
    // than none.
    return
  }

  const shownName = name || short(view.participant)
  const dialog = $('verifyDialog') as HTMLDialogElement
  $('verifyTitle').textContent = `Is this really ${shownName}?`
  $('verifyMine').textContent = words.mine
  $('verifyTheirs').textContent = words.theirs

  const warning = $('verifyWarning')
  if (status === 'key-changed') {
    warning.textContent =
      `You have verified a different key under the name "${shownName}" before. ` +
      'Either they are on a new key, or this is not them. Do not mark this verified ' +
      'unless the words match and you know the voice.'
    warning.hidden = false
  } else {
    warning.textContent = ''
    warning.hidden = true
  }

  const onClose = () => {
    dialog.removeEventListener('close', onClose)
    if (dialog.returnValue !== 'verify') return
    rememberVerified(deviceStore, view.participant, name, Date.now())
    if (session) render(session.participants(), meParticipant)
  }
  dialog.addEventListener('close', onClose)
  dialog.returnValue = ''
  dialog.showModal()
}

const LOCAL_SPEAKING_KEY = 'self'

/**
 * Who is talking. Keyed by device, because that is what carries a track -
 * a person with two devices lights up when either of them speaks, which is
 * the same grouping rule the tiles already use.
 *
 * Repaints only the class on the affected tiles, never the room: `render()`
 * rebuilds every element it touches, and doing that twenty times a second
 * would throw away every `<video>` in the grid mid-frame.
 */
const speakingMonitor = new SpeakingMonitor({
  onChange: () => paintSpeaking(),
})

/** Applies the current speaking state to whichever tiles are on screen.
 *  Cheap enough to call on every change and on every render. */
function paintSpeaking(): void {
  const speaking = speakingMonitor.speaking()
  for (const box of document.querySelectorAll<HTMLElement>('.participant[data-devices]')) {
    const devices = (box.dataset.devices ?? '').split(' ').filter(Boolean)
    box.classList.toggle('speaking', devices.some((d) => speaking.has(d)))
  }
}

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
/**
 * Checks a picture or a sound may go without the roster naming its track
 * before it is taken down. Three, at the one-second poll: a track that
 * lands ahead of its own advert is given a slow relay's worth of time for
 * the advert to arrive, and one whose advert has gone is off inside three
 * seconds.
 */
const ORPHAN_CHECKS = 3
const orphanChecks = new Map<string, number>()

/**
 * Whether the roster still says this remote track exists.
 *
 * The far end stopping a share or a camera removes the sender, and a
 * removed sender does NOT end the receiver's track in any browser - it
 * mutes it, which the stall rule cannot tell from a still picture, and a
 * muted screen share decodes nothing, so the element sat on everybody's
 * screen as a black box for the rest of the call. What the far end does
 * say, and says promptly, is its roster advert: `publishActiveTracks`
 * republishes the full set on every toggle. So the advert is the truth
 * about whether a track is on, and a track the roster has stopped
 * naming is over. Undefined while the roster has nothing to say about
 * the device at all: a device between heartbeats is not a device that
 * has turned everything off.
 */
function advertised(key: string): boolean | undefined {
  const bar = key.indexOf('|')
  const device = key.slice(0, bar), id = key.slice(bar + 1)
  const person = session?.participants().find(view => view.devices.includes(device))
  if (!person) return undefined
  return person.tracks.some(track => track.device === device && track.trackId === id)
}

/** Count a check against an unadvertised track; true once it has had its
 *  grace. Any check that finds it advertised again forgives it. */
function orphanedFor(key: string): boolean {
  const named = advertised(key)
  if (named !== false) { orphanChecks.delete(key); return false }
  const checks = (orphanChecks.get(key) ?? 0) + 1
  orphanChecks.set(key, checks)
  if (checks < ORPHAN_CHECKS) return false
  orphanChecks.delete(key)
  return true
}

function syncRemoteVideos(): void {
  let changed = false
  for (const [key, entry] of remoteVideos) {
    if (entry.track.readyState === 'ended' || orphanedFor(key)) {
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
      if (!onScreen(entry) && !leftCall) {
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
  // Sound, by the same roster rule. A screen share's audio, or a
  // microphone switched off, leaves a silent element behind otherwise,
  // and the tile keeps a "mic" chip for a mic that is off.
  for (const [key, entry] of remoteAudios) {
    if (entry.track.readyState !== 'ended' && !orphanedFor(key)) continue
    entry.el.remove()
    remoteAudios.delete(key)
    const device = key.slice(0, key.indexOf('|'))
    const remaining = [...remoteAudios].find(([other]) => other.startsWith(`${device}|`))
    if (remaining) speakingMonitor.watch(device, remaining[1].track)
    else speakingMonitor.unwatch(device)
    changed = true
  }
  for (const key of orphanChecks.keys()) if (!remoteVideos.has(key) && !remoteAudios.has(key)) orphanChecks.delete(key)
  if (changed && session) render(session.participants(), meParticipant)
}

setInterval(syncRemoteVideos, 1000)

/**
 * The roster's track id is the stable name of a camera, microphone or share.
 * Chromium normally preserves it on the receiver, but may mint a different
 * receiver id when the peer connection is rebuilt on another route. Keep the
 * received object in the advertised slot so screen expansion and annotations
 * survive a move to TURN.
 */
function advertisedTrackId(device: string, track: MediaStreamTrack): string {
  const person = session?.participants().find(view => view.devices.includes(device))
  const compatible = person?.tracks.filter(advert =>
    advert.device === device &&
    (track.kind === 'audio' ? advert.role === 'mic' || advert.role === 'screen-audio' : advert.role === 'camera' || advert.role === 'screen'),
  ) ?? []
  if (compatible.some(advert => advert.trackId === track.id)) return track.id
  const collection = track.kind === 'audio' ? remoteAudios : remoteVideos
  const available = compatible.find(advert => {
    const current = collection.get(`${device}|${advert.trackId}`)
    return current === undefined || current.track.readyState === 'ended'
  })
  return available?.trackId ?? track.id
}

function attachRemoteTrack(device: string, track: MediaStreamTrack): void {
  let mediaEl = deviceMediaEls.get(device)
  if (!mediaEl) {
    mediaEl = document.createElement('div')
    mediaEl.className = 'media'
    deviceMediaEls.set(device, mediaEl)
  }
  const container = mediaEl
  const key = `${device}|${advertisedTrackId(device, track)}`

  // A track can arrive before its roster advert and initially be stored by
  // the browser's receiver id. Once the advert arrives, move the existing
  // element into its stable slot rather than displaying the same receiver
  // twice under two names.
  if (track.kind === 'video' && !remoteVideos.has(key)) {
    const alias = [...remoteVideos].find(([, entry]) => entry.track === track)
    if (alias) { remoteVideos.delete(alias[0]); remoteVideos.set(key, alias[1]) }
  }
  if (track.kind === 'audio' && !remoteAudios.has(key)) {
    const alias = [...remoteAudios].find(([, entry]) => entry.track === track)
    if (alias) { remoteAudios.delete(alias[0]); remoteAudios.set(key, alias[1]) }
  }

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
    // Tap it for the speaking indicator. Keyed by device rather than by
    // track, so a device sending both a microphone and its screen's audio
    // lights its tile from whichever is making noise - which is what a
    // person watching the grid means by "they are talking".
    speakingMonitor.watch(device, track)
    track.addEventListener('ended', () => {
      if (remoteAudios.get(key)?.track !== track) return
      el.remove()
      remoteAudios.delete(key)
      speakingMonitor.unwatch(device)
      paintSpeaking()
      if (session) render(session.participants(), meParticipant)
    })
  }

  if (session) render(session.participants(), meParticipant)
}

/**
 * Chromium can decode a receiver while omitting the `track` event during a
 * rapid peer rebuild. The RTP counters then climb but the app has no media
 * element, which is the exact blank-tile failure a person sees. Connections
 * are already retained for diagnostics, so reconcile their live receivers
 * with the UI as a recovery path. Re-attaching the same object is skipped.
 */
function recoverRemoteTracks(): void {
  if (!session) return
  for (const [key, pc] of openConnections) {
    if (pc.connectionState !== 'connected') continue
    const match = /^[^:]+:([0-9a-f]{64}):\d+$/.exec(key)
    const device = match?.[1]
    if (!device || !session.participants().some(view => view.devices.includes(device))) continue
    for (const receiver of pc.getReceivers()) {
      const track = receiver.track
      if (!track || track.readyState !== 'live') continue
      const stableKey = `${device}|${advertisedTrackId(device, track)}`
      // A sender the far end removed leaves a receiver whose track is
      // still `live` and forever muted. `syncRemoteVideos` took its
      // element down on the roster's word; putting it back here every two
      // seconds would be the black box again, on a timer.
      if (advertised(stableKey) === false) continue
      const entry = track.kind === 'video' ? remoteVideos.get(stableKey) : remoteAudios.get(stableKey)
      if (entry?.track !== track || !entry.el.isConnected) attachRemoteTrack(device, track)
    }
  }
}

setInterval(recoverRemoteTracks, 2000)

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

async function startSession(asVisitor = false): Promise<void> {
  const generation = roomGeneration
  if (joining || session || loginBusy) return
  joining = true
  setStatus('Joining the room…', 'progress')
  const joinBtn = $('join') as HTMLButtonElement
  joinBtn.disabled = true
  joinBtn.textContent = 'Joining…'
  $('joinRoomForm').setAttribute('aria-busy', 'true')

  try {
    // A restored signer can arrive after the invitation. Joining first
    // would mint a visitor identity that a known-contact clerk rejects,
    // even though the account UI subsequently says we are signed in.
    if (identityRestoring) {
      setStatus('Reconnecting your sign-in…', 'progress')
      await identityReady
      if (generation !== roomGeneration) return
      setStatus('Joining the room…', 'progress')
    }
    if (needsAccountReconnect() && !asVisitor) {
      setStatus('Your Nostr account is disconnected. Reconnect it, or choose to go in with just a name.')
      ;($('joinNostr') as HTMLButtonElement).focus()
      return
    }
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
    if (generation !== roomGeneration) return

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
    const refreshIce = (): void => {
      resolveIceServers(iceUrls)
        .then((fresh) => {
          resolvedIceServers = fresh
          stunOnly = withoutTurn(fresh)
        })
        .catch(() => {})
    }
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
    const transport = configuredPool(relays)
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
          onEpoch: notice => { if (generation === roomGeneration) onEpochChange(notice) },
          onRemoved: (notice) => { if (generation === roomGeneration) leaveWithNotice(`You were removed from this room${notice.by ? ` by ${personLabel(notice.by)}` : ''}.`) },
          onClosed: (notice) => { if (generation === roomGeneration) leaveWithNotice(`This room was closed${notice.by ? ` by ${personLabel(notice.by)}` : ''}.`) },
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
          onEpoch: notice => { if (generation === roomGeneration) onEpochChange(notice) },
          onRemoved: (notice) => { if (generation === roomGeneration) leaveWithNotice(`You were removed from this room${notice.by ? ` by ${personLabel(notice.by)}` : ''}.`) },
          onClosed: (notice) => { if (generation === roomGeneration) leaveWithNotice(`This room was closed${notice.by ? ` by ${personLabel(notice.by)}` : ''}.`) },
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
      if (session !== s) return
      announceComings(views, meParticipant)
      assignmentPanel.refreshPeople()
      render(views, meParticipant)
      renderInvites()
      renderHost()
      // The owner of an agent that asked may only now be known.
      renderApprovals()
    })
    s.onRemoteTrack(({ device, track }) => { if (session === s) attachRemoteTrack(device, track); else track.stop() })
    s.onAnnotation(({ annotation }) => { if (session === s) shareViewer.receive(annotation) })

    await s.join(currentAdverts(), currentClaims())
    if (session !== s) return
    // A reply draft reads its original message from the new session. Its
    // logs must exist before restoring that context.
    selectRoomDrafts()
    void assignmentPanel.attach(s)
    iceRefreshTimer = setInterval(refreshIce, ICE_REFRESH_MS)
    s.publishTracks(activeTracks(), { audience })

    // What lands while this tab is in the background is worth a
    // notification, if the person asked for them. Followed from now, so
    // the history the log replays on open is never news.
    const joinedRoomId = currentRoomId() ?? s.roomId
    const roomLabelNow = () => currentRoomLabel()
    followReadPositions(joinedRoomId, deriveRoom(roomSecret).roomKey)
    const notifyChat = notifier.follow({ roomId: joinedRoomId, channel: 'chat', room: roomLabelNow, sender: senderLabel })
    s.chat.onChange(() => coalesceChatPaint('chat', () => {
      if (session !== s) return
      const messages = s.chat.messages()
      // Only when the main chat is the conversation on screen. Repainting
      // regardless put the main chat under whichever tab was selected and
      // left the tab lit, so the page said one thing and showed another.
      if (currentChannel === undefined) renderChat(messages)
      // The dot on the Chat tab is how somebody standing elsewhere learns
      // there is something to come back to.
      renderChannels()
      noteChatRead(messages)
      notifyChat(messages)
    }))
    renderChat(s.chat.messages())
    noteChatRead(s.chat.messages())
    notifyChat(s.chat.messages())
    // The side conversations: what the agents say to each other, what a
    // listening agent heard, and what a scribe made of it. Subscribed now
    // rather than when somebody opens the tab, because a relay replays a
    // durable kind to a new subscriber and an hour's backlog arriving after
    // a click reads as a broken tab.
    //
    // They used to be three panels stacked under the chat AS WELL AS three
    // tabs above it, so the same words were on the page twice and neither
    // copy said it was the same conversation. Now the tab is the only
    // place, and this only has to keep the tab's count and repaint the log
    // when the tab somebody is looking at is the one that changed.
    const followChannel = (name: string, notify?: (messages: ChatMessage[]) => void): void => {
      const log = s.channel(name)
      channelLogs.set(name, log)
      const arrived = (messages: ChatMessage[]): void => {
        if (session !== s) return
        channelCounts.set(name, messages.length)
        notify?.(messages)
        if (currentChannel === name) renderChat(messages)
        renderChannels()
      }
      log.onChange(arrived)
      arrived(log.messages())
    }
    followChannel(AGENT_CHANNEL, notifier.follow({ roomId: joinedRoomId, channel: 'agents', room: roomLabelNow, sender: senderLabel }))
    followChannel(TRANSCRIPT_CHANNEL)
    followChannel(MINUTES_CHANNEL, notifier.follow({ roomId: joinedRoomId, channel: 'minutes', room: roomLabelNow, sender: senderLabel }))
    // Agent hosts say what they can run on the control channel; a person
    // asks on it. Asked once on arrival, so a host that has been quiet for
    // an hour says again.
    const control = s.channel(CONTROL_CHANNEL)
    control.onChange((messages) => { if (session === s) ingestControl(messages) })
    ingestControl(control.messages())
    control.send(encodeControl({ op: 'catalogue?' })).catch(() => {})
    renderRoomLockState()
    renderHost()
    // Empty until the keeper answers the `catalogue?` above with its signed
    // list, which is the only thing this client will believe.
    renderChannels()

    joinBtn.hidden = true
    $('identity').hidden = true
    // What sits under the way in goes with it. These are the entry screen's
    // own explanations, and a message screen carries a header, the
    // conversation and the box to type in.
    $('identityMore').hidden = true
    $('roomArea').hidden = false
    // "Invitation accepted. Go in when you are ready." has been acted on.
    // A line about getting in is stale the moment you are in.
    setStatus('')
    showRoomTools()
    // The join screen has gone and the room is on: the last chance for the
    // masthead to have changed height.
      renderNudgeChoice()
    // The offer starts at whatever the person has already chosen, which is
    // off unless they turned it on before joining.
    lastOffering = currentAssistOffer() !== null
    startAssistPolling()
    render(s.participants(), meParticipant)
    // History may have arrived while the join screen still hid the log.
    // Restore this room's reading place only once it can be measured.
    chatScroll.resume(draftRoomKey())
    restoreConversation()
    repaintActiveChat()
  } catch (err) {
    const failed = session
    if (generation !== roomGeneration) return
    const failedTransport = sessionTransport
    session = undefined
    sessionTransport = undefined
    void failed?.leave()
    failedTransport?.close()
    if (iceRefreshTimer !== undefined) clearInterval(iceRefreshTimer)
    iceRefreshTimer = undefined
    const message = describeError(err)
    if (message.includes('expired')) {
      forgetCredential()
      setStatus('This device\u2019s pass for this room has run out. Ask your other device for a new one.')
    } else {
      setStatus(`Could not join the room. ${message}. Check your connection or sign-in, then try again.`)
    }
  } finally {
    joining = false
    joinBtn.disabled = false
    $('joinRoomForm').removeAttribute('aria-busy')
    renderIdentity()
  }
}

/**
 * The newest message on screen is the newest read, once it has actually
 * been on screen: a tab in the background is not being read, whatever its
 * log holds, so it catches up when it comes back. This is what the unread
 * count on the rooms list is measured against.
 */
function noteChatRead(messages: ChatMessage[]): void {
  if (document.visibilityState !== 'visible' || currentChannel !== undefined || $('roomArea').hidden) return
  const log = $('chatLog')
  if (log.scrollHeight - log.clientHeight - log.scrollTop >= 48) return
  const roomId = currentRoomId()
  if (!roomId) return
  let newest = 0
  let newestId: string | undefined
  for (const m of messages) {
    if (m.sentAt > newest || (m.sentAt === newest && newestId !== undefined && m.id > newestId)) {
      newest = m.sentAt
      newestId = m.id
    }
  }
  if (newest > 0) {
    markRead(roomStore(), roomId, newest)
    readSync?.note(roomId, { '': newestId ? { at: newest, id: newestId } : { at: newest } })
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  notifier.seen()
  if (!session) return
  try {
    noteChatRead(session.chat.messages())
  } catch {
    // Not joined yet: there is no chat to have read.
  }
})
window.addEventListener('focus', () => notifier.seen())
$('chatLog').addEventListener('scroll', () => {
  if (session && currentChannel === undefined) noteChatRead(session.chat.messages())
})

// ---------------------------------------------------------------------------
// Your rooms
//
// The rooms this device has been in, shown when the app opens with no link
// on it. Each is watched from outside while the list is on screen - see
// app/src/room-watch.ts - which needs the room key, and this list holds no
// keys of its own: it uses whatever the app already keeps. A room this
// device created or joined as a group retains its key until forgotten;
// temporary rooms retain their shorter local lifetimes. A room whose
// key this device does not hold right now says so, and opening it is what
// gets the key back.
// ---------------------------------------------------------------------------

const roomWatches = new Map<string, { pool: NostrRelayPool; watch: RoomWatch }>()
let roomsTimer: ReturnType<typeof setInterval> | undefined
/** Whether the list is what is on screen. Nothing below draws, or keeps a
 *  relay open, when it is not. */
let roomsListShown = false

/** The room secret behind a known room, when this device holds it: the
 *  creator's record, this tab's admission, or one the person chose to
 *  keep. */
function secretForKnownRoom(link: RoomLink): Uint8Array | undefined {
  if (link.secret) return link.secret
  if (!link.invitation) return undefined
  return (
    loadInvitationOwner(link.invitation)?.roomSecret ??
    loadCachedAdmission(link.invitation)?.secret ??
    loadKeptAdmission(deviceStore, deriveInvitationId(link.invitation), nowSeconds())?.secret
  )
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
  const pool = relayConnections.pool(`room:${room.roomId}`, link.relays)
  // A message in a room on the list is a message in a room not on screen,
  // and the list is what this device reads other rooms with.
  const notify = notifier.follow({
    roomId,
    channel: 'chat',
    room: () => knownRoomLabel(knownRoom(roomStore(), roomId) ?? room),
    sender: senderLabel,
  })
  const watch = new RoomWatch({
    transport: pool,
    roomId,
    roomKey,
    policy: link.policy,
    onChange: () => {
      renderRooms()
      notify(watch.messages())
    },
  })
  notify(watch.messages())
  roomWatches.set(room.roomId, { pool, watch })
  followReadPositions(roomId, roomKey)
}

function stopWatching(roomId: string): void {
  const watched = roomWatches.get(roomId)
  if (!watched) return
  watched.watch.close()
  watched.pool.close()
  roomWatches.delete(roomId)
}

function showRoomsList(): void {
  pendingJoin = false
  $('nostrOption').hidden = true
  $('home').hidden = false
  $('identity').hidden = true
  $('identityMore').hidden = true
  $('homeRooms').append($('rooms'))
  $('homeActions').append($('setup'))
  $('homeAccount').append($('accountHome'))
  $('homeStatus').append($('status'))
  $('accountHome').hidden = false
  roomsListShown = true
  // renderRooms offers notifications when there are saved rooms to follow.
  renderWayBack()
  const rooms = knownRooms(roomStore())
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
  if (($('roomSwitcher') as HTMLDialogElement).open) renderRoomSwitcher()
  renderWorkspace()
  if (!roomsListShown) return
  const importable = browserRoomsToImport()
  $('importBrowserRooms').hidden = !nostrSession || importable.length === 0
  $('importBrowserRooms').textContent = `Add the ${importable.length === 1 ? 'room' : `${importable.length} rooms`} already here`
  const rooms = knownRooms(roomStore())
  const query = ($('homeRoomQuery') as HTMLInputElement).value.trim().toLocaleLowerCase()
  fillProjectFilter('homeProject', rooms)
  const project = ($('homeProject') as HTMLSelectElement).value
  const filtered = rooms.filter(room => matchesRoom(room, query, project))
  $('homeProjectFilter').hidden = !rooms.some(room => projectOf(room))
  $('rooms').hidden = rooms.length === 0 && !nostrSession
  $('notify').hidden = rooms.length === 0
  $('homeHeading').textContent = rooms.length ? 'Pick up the conversation.' : 'Make room for a conversation.'
  $('roomsHeading').textContent = 'Your rooms'
  $('roomsEmpty').hidden = rooms.length !== 0
  $('homeRoomSearch').hidden = rooms.length === 0
  $('clearHomeRoomQuery').hidden = !query
  $('homeRoomResults').hidden = !query && project === '*'
  $('homeRoomResults').textContent = filtered.length
    ? `${filtered.length} ${filtered.length === 1 ? 'room' : 'rooms'} found`
    : 'No rooms match this search.'
  $('roomsNote').textContent = nostrSession
    ? 'These bookmarks belong to your Nostr account. An invitation can expire or be retired; a bookmark does not grant permanent access. Unread counts use only keys held by this device.'
    : 'Saved on this browser only. You can also bookmark the invitation link. No account is needed.'
  const list = $('roomList')
  const focused = document.activeElement as HTMLElement | null
  const focusedRoom = focused && list.contains(focused) ? focused.closest<HTMLElement>('[data-room]')?.dataset.room : undefined
  const action = focused?.dataset.action
  list.innerHTML = ''
  for (const room of filtered) list.append(roomRow(room))
  if (focusedRoom && action) {
    const row = Array.from(list.children).find(row => (row as HTMLElement).dataset.room === focusedRoom)
    const replacement = row?.querySelector<HTMLElement>(`[data-action="${action}"]`)
    ;(replacement ?? $('homeRoomQuery')).focus({ preventScroll: true })
  }
}

function browserRoomsToImport(): KnownRoom[] {
  return nostrSession ? knownRooms(deviceStore).filter(room => !knownRoom(roomStore(), room.roomId)) : []
}

function confirmRoomAction(options: ConfirmActionOptions): Promise<boolean> {
  const room = session
  const account = nostrSession?.pubkey
  const generation = roomGeneration
  return confirmAction({ ...options, isCurrent: () => room === session && account === nostrSession?.pubkey && generation === roomGeneration })
}

function confirmDiscardAndLeave(): Promise<boolean> {
  return confirmRoomAction({ title: 'Leave and discard your draft?', message: 'Unsent messages and files in every room visited in this tab will be discarded.', confirmLabel: 'Discard and leave', cancelLabel: 'Keep working', danger: true })
}

async function importBrowserRooms(): Promise<void> {
  const rooms = browserRoomsToImport()
  if (!bookmarks || !rooms.length) return
  const destination = nostrSession?.signer.nip44
    ? 'Their names and invitation links will be encrypted to your Nostr key and sent to relays.'
    : 'This signer cannot encrypt, so these bookmarks will stay in this browser only.'
  if (!await confirmRoomAction({ title: 'Add these rooms to your account?', message: `${rooms.map(knownRoomLabel).join('\n')}\n\n${destination}`, confirmLabel: 'Add rooms' })) return
  for (const room of rooms) bookmarks.save(room)
  renderRooms()
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
  const name = document.createElement('button')
  name.type = 'button'
  name.className = 'roomName open'
  name.dataset.action = 'open'
  name.setAttribute('aria-label', `Open ${knownRoomLabel(room)}`)
  name.textContent = knownRoomLabel(room)
  name.addEventListener('click', () => openKnownRoom(room))
  name.title = shortKey(room.roomId)
  heading.append(name)
  main.append(heading)
  const project = projectOf(room)
  if (project) { const label = document.createElement('span'); label.className = 'roomProject'; label.textContent = project; main.append(label) }
  main.append(roomMeta(room))

  const actions = document.createElement('div')
  actions.className = 'roomActions'
  const forget = document.createElement('button')
  forget.type = 'button'
  forget.className = 'forget quiet'
  forget.dataset.action = 'forget'
  forget.setAttribute('aria-label', `Forget ${knownRoomLabel(room)}`)
  forget.textContent = 'Forget'
  forget.addEventListener('click', () => forgetKnownRoom(room))
  if (organising()) actions.append(projectButton(room))
  actions.append(forget)

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
    here.textContent = watched.watch.settled ? 'nobody here' : ''
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
/** The other member of a direct message this identity is in, off the
 *  room's link, or undefined for any other room. Cached by link, because
 *  the rooms list asks on every repaint. */
const dmPeerCache = new Map<string, string | undefined>()
function dmPeerOf(room: Pick<KnownRoom, 'link'>): string | undefined {
  const me = meParticipant || currentParticipant()
  if (!me) return undefined
  const key = `${me}:${room.link}`
  if (!dmPeerCache.has(key)) {
    let peer: string | undefined
    try { peer = dmPeer(parseRoomLink(room.link).policy, me) } catch { peer = undefined }
    dmPeerCache.set(key, peer)
  }
  return dmPeerCache.get(key)
}

/** What to call a room on the list: a direct message is named for the
 *  person on the other end, everything else by `roomLabel`. */
function knownRoomLabel(room: KnownRoom): string {
  const peer = dmPeerOf(room)
  if (!peer) return roomLabel(room)
  // The name remembered when the conversation was started or received, then
  // whatever a profile says, then the key. A DM link carries no room name.
  return `Private: ${room.name ?? shownAs(peer).name ?? shortKey(peer)}`
}

/** The room this page is in, named the same way. */
/** What to call the person on the other end of the room this page is in:
 *  what the roster says, then the name remembered when the conversation
 *  was started or received, then the key. */
function dmPeerName(peer: string): string {
  const onRoster = session?.participants().find((v) => v.participant === peer)?.name
  const remembered = knownRooms(roomStore()).find((room) => room.roomId === currentRoomId())?.name
  return shownAs(peer, onRoster ?? remembered).name ?? shortKey(peer)
}

function currentRoomLabel(): string {
  const me = meParticipant || currentParticipant()
  const peer = me ? dmPeer(roomPolicy, me) : undefined
  if (peer) return `Private: ${dmPeerName(peer)}`
  return roomLabel({ roomId: currentRoomId() ?? '', name: roomName })
}

function openKnownRoom(room: KnownRoom): void {
  // A fragment-only change is a same-document navigation, which never
  // re-runs this module; the reload is what reads the link.
  // A synced bookmark is data, not a redirect to a different website.
  const parsed = new URL(room.link, location.href)
  history.replaceState(null, '', joinLinkBase() + parsed.hash)
  location.reload()
}

function projectOf(room: Pick<KnownRoom, 'roomId'>): string | undefined {
  return roomProject(deviceStore, nostrSession?.pubkey, room.roomId)
}

function navigationRooms(): KnownRoom[] {
  const rooms = knownRooms(roomStore())
  const current = currentRoomId()
  if (current && !rooms.some(room => room.roomId === current)) {
    rooms.unshift({ roomId: current, name: roomName, link: encodeRoomUrl(joinLinkBase(), relays, iceUrls), openedAt: nowSeconds(), readAt: 0 })
  }
  return rooms
}

function matchesRoom(room: KnownRoom, query: string, project = '*'): boolean {
  return (project === '*' || (projectOf(room) ? `project:${projectOf(room)}` : '') === project)
    && `${knownRoomLabel(room)} ${room.roomId} ${projectOf(room) ?? ''}`.toLocaleLowerCase().includes(query)
}

function projectNames(rooms: KnownRoom[]): string[] {
  return [...new Set(rooms.map(projectOf).filter((name): name is string => Boolean(name)))].sort((a, b) => a.localeCompare(b))
}

function fillProjectFilter(id: string, rooms: KnownRoom[]): void {
  const select = $(id) as HTMLSelectElement
  const value = select.value
  const options: Array<[string, string]> = [['*', 'All projects'], ...projectNames(rooms).map(name => [`project:${name}`, name] as [string, string]), ['', 'No project']]
  // Do not replace a native select while the person is choosing from it.
  if (Array.from(select.options).map(option => option.value).join('\n') === options.map(([value]) => value).join('\n')) return
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)))
  select.value = options.some(([key]) => key === value) ? value : '*'
  const filter = select.closest<HTMLElement>('.projectFilter')
  if (filter) filter.hidden = projectNames(rooms).length === 0
}

/** Whether projects are worth a control at all: somebody has made one, or
 *  there are enough rooms that grouping them would help. */
function organising(): boolean {
  const rooms = knownRooms(roomStore())
  return rooms.length >= 3 || projectNames(rooms).length > 0
}

function projectButton(room: KnownRoom): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'quiet organiseRoom'
  button.dataset.action = 'project'
  button.textContent = 'Project'
  button.setAttribute('aria-label', `Set project for ${knownRoomLabel(room)}`)
  button.addEventListener('click', () => openProjectEditor(room, button))
  return button
}

let projectRoom: KnownRoom | undefined
let projectReturn: HTMLElement | undefined
let projectReturnList: HTMLElement | undefined
function openProjectEditor(room: KnownRoom, opener: HTMLElement): void {
  projectRoom = room
  projectReturn = opener
  projectReturnList = opener.closest<HTMLElement>('#workspaceRooms, #roomSwitcherList, #roomList') ?? undefined
  $('projectRoomName').textContent = knownRoomLabel(room)
  ;($('projectName') as HTMLInputElement).value = projectOf(room) ?? ''
  $('projectSuggestions').replaceChildren(...projectNames(navigationRooms()).map(name => new Option(name, name)))
  $('projectError').hidden = true
  ;($('projectEditor') as HTMLDialogElement).showModal()
  $('projectName').focus()
}

function renderWorkspace(): void {
  if ($('workspaceNav').hidden) return
  const list = $('workspaceRooms')
  const focused = document.activeElement as HTMLElement | null
  const focusedRoom = focused && list.contains(focused) ? focused.closest<HTMLElement>('[data-room]')?.dataset.room : undefined
  const action = focused?.dataset.action
  const query = ($('workspaceQuery') as HTMLInputElement).value.trim().toLocaleLowerCase()
  const rooms = navigationRooms().filter(room => matchesRoom(room, query))
  const current = currentRoomId()
  const busy = switchingBlocked()
  const groups = [...projectNames(rooms), ...(rooms.some(room => !projectOf(room)) ? [''] : [])]
  list.replaceChildren()
  for (const project of groups) {
    const group = document.createElement('section')
    const heading = document.createElement('h3')
    heading.textContent = project || 'No project'
    heading.hidden = groups.length === 1 && !project
    group.append(heading)
    for (const room of rooms.filter(room => (projectOf(room) ?? '') === project)) {
      const row = document.createElement('div')
      row.className = 'workspaceRoom'
      row.dataset.room = room.roomId
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'workspaceRoomLink'
      button.dataset.action = 'switch'
      button.textContent = knownRoomLabel(room)
      button.title = `${knownRoomLabel(room)} · ${shortKey(room.roomId)}`
      if (room.roomId === current) button.setAttribute('aria-current', 'true')
      // Switching retains each room's draft collection in this tab.
      button.addEventListener('click', () => {
        void switchRoom(room)
      })
      row.append(button)
      if (organising()) {
        const organise = projectButton(room)
        organise.textContent = '⋯'
        row.append(organise)
      }
      group.append(row)
    }
    list.append(group)
  }
  $('workspaceEmpty').hidden = rooms.length > 0
  $('workspaceNote').textContent = busy ? 'Finish sending or stop adding files before switching rooms.' : organising() ? 'Use ⋯ to organise rooms into projects.' : ''
  if (focusedRoom && action) {
    const row = Array.from(list.querySelectorAll<HTMLElement>('[data-room]')).find(row => row.dataset.room === focusedRoom)
    ;(row?.querySelector<HTMLElement>(`[data-action="${action}"]`) ?? $('workspaceQuery')).focus({ preventScroll: true })
  }
}

const ROOM_SWITCH_KEY = 'kithmoot.room-switch.v1'
let roomSwitcherReturn: HTMLElement | undefined
let previousRoom: KnownRoom | undefined
let switchDestination: KnownRoom | undefined

function openRoomSwitcher(event?: Event): void {
  const dialog = $('roomSwitcher') as HTMLDialogElement
  if (dialog.open) return
  roomSwitcherReturn = event?.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  ;($('roomSearch') as HTMLInputElement).value = ''
  renderRoomSwitcher()
  dialog.showModal()
  $('roomSearch').focus()
}

function renderRoomSwitcher(): void {
  const current = currentRoomId()
  const rooms = navigationRooms()
  const query = ($('roomSearch') as HTMLInputElement).value.trim().toLocaleLowerCase()
  fillProjectFilter('switcherProject', rooms)
  const project = ($('switcherProject') as HTMLSelectElement).value
  const filtered = rooms.filter(room => matchesRoom(room, query, project))
  const busy = switchingBlocked()
  $('roomSwitcherNote').textContent = busy
    ? 'Finish sending or stop adding files before switching. You can also open the other room in a new tab.'
    : callIsLive() || onCall()
      ? 'Your call stays connected while you browse. Switching will ask before leaving it; a new tab keeps this call here.'
      : hasUnsentWork()
        ? 'Your drafts stay here while you switch.'
        : ''
  const list = $('roomSwitcherList')
  const focused = document.activeElement as HTMLElement | null
  const focusedRoom = focused && list.contains(focused) ? focused.closest<HTMLElement>('[data-room]')?.dataset.room : undefined
  const focusedAction = focused?.dataset.action
  list.replaceChildren()
  for (const room of filtered) {
    const row = document.createElement('li')
    row.className = 'roomRow'
    row.dataset.room = room.roomId
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'switchRoom'
    button.dataset.action = 'switch'
    button.setAttribute('aria-label', `Switch to ${knownRoomLabel(room)}`)
    const name = document.createElement('span')
    name.textContent = knownRoomLabel(room)
    const detail = document.createElement('span')
    detail.className = 'switchRoomCode'
    detail.textContent = [organising() ? projectOf(room) ?? 'No project' : '', room.roomId === current ? 'Current room' : ''].filter(Boolean).join(' · ')
    button.append(name, detail)
    if (room.roomId === current) button.setAttribute('aria-current', 'true')
    button.disabled = busy && room.roomId !== current
    button.addEventListener('click', () => switchRoom(room))
    row.append(button)
    if (room.roomId !== current) {
      const link = document.createElement('a')
      link.className = 'switchRoomNewTab'
      link.dataset.action = 'new-tab'
      link.href = joinLinkBase() + new URL(room.link, location.href).hash
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = 'New tab'
      link.setAttribute('aria-label', `Open ${knownRoomLabel(room)} in a new tab`)
      row.append(link)
    }
    if (organising()) row.append(projectButton(room))
    list.append(row)
  }
  if (focusedRoom && focusedAction) {
    const row = Array.from(list.children).find(row => (row as HTMLElement).dataset.room === focusedRoom)
    ;(row?.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`) ?? $('roomSearch')).focus({ preventScroll: true })
  }
  $('roomSwitcherEmpty').hidden = filtered.length > 0
  // A trip to the dashboard must not silently discard unfinished work.
  ;($('roomSwitcherHome') as HTMLButtonElement).disabled = hasUnsentWork()
}

async function switchRoom(room: KnownRoom): Promise<void> {
  if (switchingRoom) return
  if (session && room.roomId === currentRoomId()) {
    ;($('roomSwitcher') as HTMLDialogElement).close()
    return
  }
  if (switchingBlocked()) { openRoomSwitcher(); renderRoomSwitcher(); return }
  if ((callIsLive() || onCall()) && !await confirmRoomAction({ title: `Switch to ${knownRoomLabel(room)}?`, message: 'This leaves your current call. Your microphone and camera will be off in the other room.', confirmLabel: 'Leave call and switch' })) return
  if (switchingRoom || switchingBlocked()) { renderRoomSwitcher(); return }
  const account = nostrSession?.pubkey
  const identity = identityGeneration
  if (session) previousRoom = navigationRooms().find(room => room.roomId === currentRoomId())
  switchDestination = room
  captureDraft()
  switchingRoom = true
  $('roomArea').inert = $('workspaceNav').inert = true
  $('joinRoomForm').inert = $('accountHome').inert = true
  ;($('workspaceQuery') as HTMLInputElement).disabled = true
  try {
    await closeRoomSession()
    resetRoomState()
    const hash = new URL(room.link, location.href).hash
    // Bookmarks provide an invitation fragment, never an external redirect.
    history.replaceState(null, '', joinLinkBase() + hash)
    $('identity').hidden = false
    $('arrivalTitle').textContent = `Opening ${knownRoomLabel(room)}`
    $('arrivalLead').textContent = 'Connecting to the room…'
    $('arrivalLead').hidden = false
    $('joinRoomForm').hidden = true
    $('identityMore').hidden = true
    $('arrivalActions').hidden = true
    setStatus('')
    if (!await roomFromLocation()) throw new Error('The room has no invitation link.')
    showRoomUi()
    renderIdentity()
    if (($('join') as HTMLButtonElement).disabled) return
    if (account !== nostrSession?.pubkey || identity !== identityGeneration) {
      setStatus('Check your sign-in before entering: the account used to switch rooms is not available.')
      return
    }
    await startSession()
  } catch (error) {
    showArrivalFailure(error)
    // Keep the room list within reach when admission fails. Drafts in the
    // previous room remain in memory and return with its next successful join.
    $('workspaceNav').hidden = false
  } finally {
    switchingRoom = false
    $('roomArea').inert = $('workspaceNav').inert = false
    $('joinRoomForm').inert = $('accountHome').inert = false
    ;($('workspaceQuery') as HTMLInputElement).disabled = false
    renderWorkspace()
    if (session) previousRoom = switchDestination = undefined
    const back = $('returnToPreviousRoom')
    back.hidden = !previousRoom
    if (previousRoom) back.textContent = `Back to ${knownRoomLabel(previousRoom)}`
    const conversation = $('chatForm').hidden ? $('chatLog') : $('chatInput')
    ;(session ? conversation : previousRoom ? back : $('join')).focus({ preventScroll: true })
  }
}

/** Stop the room completely before any other room can own the controls. */
async function closeRoomSession(): Promise<void> {
  chatScroll.suspend()
  ++roomGeneration
  const old = session
  const transport = sessionTransport
  session = undefined
  sessionTransport = undefined
  assignmentPanel.detach()
  contextPanel.close()
  messageActions.close(false)
  conversationSearch.reset()
  emojiPicker.close()
  shareViewer.close()
  closeMentionPicker()
  closeRoomSheet()
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close()
  stopInvitationHost()
  pairingHost?.close()
  pairingTransport?.close()
  pairingHost = pairingTransport = undefined
  if (iceRefreshTimer !== undefined) clearInterval(iceRefreshTimer)
  if (assistTimer !== undefined) clearInterval(assistTimer)
  if (approvalTimer !== undefined) clearTimeout(approvalTimer)
  iceRefreshTimer = assistTimer = approvalTimer = undefined
  stopLocalMedia()
  speakingMonitor.retain([])
  for (const entry of [...remoteVideos.values(), ...remoteAudios.values()]) {
    entry.track.stop()
    entry.el.pause()
    entry.el.srcObject = null
    entry.el.remove()
  }
  remoteVideos.clear()
  remoteAudios.clear()
  for (const el of deviceMediaEls.values()) el.remove()
  deviceMediaEls.clear()
  for (const box of tileBoxes.values()) box.remove()
  tileBoxes.clear()
  leftCall = false
  rosterSeen = undefined
  forgetKnocks()
  orphanChecks.clear()
  $('agentsRow').replaceChildren()
  const preview = $('voicePreviewAudio') as HTMLAudioElement
  preview.pause()
  if (preview.src) URL.revokeObjectURL(preview.src)
  preview.removeAttribute('src')
  preview.hidden = true
  peerRelay.close()
  setCallOpen(false)
  updateUi()
  $('roomArea').hidden = true
  try { await old?.leave() } finally {
    transport?.close()
    for (const [key, pc] of openConnections) { pc.close(); uplink.forget(key) }
    openConnections.clear()
  }
}

function resetRoomState(): void {
  for (const opened of openedAttachments.values()) if ('url' in opened) URL.revokeObjectURL(opened.url)
  openedAttachments.clear()
  catalogues.clear()
  controlSeen.clear()
  admins.clear()
  adminsAt = channelsAt = 0
  channels = []
  channelLogs.clear()
  channelCounts.clear()
  conversationRead = new Map()
  currentChannel = undefined
  keeperParticipant = undefined
  agentParticipants.clear()
  handledInvites.clear()
  approvals.clear()
  systemLines.length = 0
  roomSecret = undefined!
  roomPolicy = undefined
  roomName = undefined
  roomInvitationCapability = undefined
  invitationAuthoritySk = undefined
  invitationDelegation = []
  expectedEpoch = undefined
  admittedRoom = undefined
  startedHere = false
  meParticipant = myDeviceId = ''
  roomRelayScope = 'default'
  relays = RELAYS
  roomRelayConfig = relayConnections.configuration('default')
  iceUrls = DEFAULT_ICE_URLS
  assistEnabled = false
  lastOffering = false
  peerRelay.reopen()
  drafts = new ConversationDrafts()
  restoreDraft()
  chatScroll.suspend()
  $('chatLog').replaceChildren()
  $('conversationHeading').textContent = 'Chat'
  ;($('chatInput') as HTMLTextAreaElement).placeholder = 'Say something'
  for (const id of ['pairUrl', 'copyPair', 'stopPairing', 'pairQrWrap', 'diagnosticsOut']) $(id).hidden = true
  ;($('pairUrl') as HTMLInputElement).value = ''
  ;($('shareQrDetails') as HTMLDetailsElement).open = false
  $('inviteStatus').textContent = ''
  render([], '')
  renderHost()
  renderApprovals()
}

async function forgetKnownRoom(room: KnownRoom): Promise<void> {
  if (!await confirmRoomAction({ title: `Forget ${knownRoomLabel(room)}?`, message: `Remove it ${nostrSession ? 'from your Nostr room bookmarks on all devices' : 'on this device'}. You will need its invitation link to come back. This does not revoke access or erase relay history.`, confirmLabel: 'Forget room', danger: true })) return
  stopWatching(room.roomId)
  forgetRoomAccess(deviceStore, room.roomId)
  forgetRoomAccess(browserDeviceStore(sessionStorage), room.roomId)
  if (bookmarks) bookmarks.remove(room.roomId)
  else forgetRoom(deviceStore, room.roomId)
  renderRooms()
}

// ---------------------------------------------------------------------------
// The way back
//
// "Your rooms" leaves the room AND takes the invitation off the address
// bar, and the list it lands on has no link on it anywhere. For a browser
// that made the room that is survivable; for one that was admitted on a
// link it was the end of the session, because on that path the link IS the
// key and there was no second copy of it on the page, in the list, or in
// the history. One press, no warning, no way back.
//
// So the link is written down before it is taken off the address bar, and
// offered on the list as a button. Session storage: it is about this visit,
// and it must not outlive the tab that held the room.
// ---------------------------------------------------------------------------

const WAY_BACK_KEY = 'kithmoot.way-back'

/** The link that opens the room this page is in, and what to call it. */
let wayBackLink: string | undefined

function rememberWayBack(): void {
  const roomId = currentRoomId()
  if (!roomId) return
  try {
    sessionStorage.setItem(
      WAY_BACK_KEY,
      JSON.stringify({ link: encodeRoomUrl(joinLinkBase(), relays, iceUrls), name: currentRoomLabel() }),
    )
  } catch {
    // No storage. The room may still be on the list below; there is just no
    // button at the top of it.
  }
}

function forgetWayBack(): void {
  wayBackLink = undefined
  try {
    sessionStorage.removeItem(WAY_BACK_KEY)
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/** The button at the top of the list, when this tab left a room to get
 *  here. Named after the room, so it reads as where you came from rather
 *  than as another way in. */
function renderWayBack(): void {
  const button = $('backToRoom')
  let kept: { link?: unknown; name?: unknown } | undefined
  try {
    const raw = sessionStorage.getItem(WAY_BACK_KEY)
    kept = raw ? (JSON.parse(raw) as { link?: unknown; name?: unknown }) : undefined
  } catch {
    kept = undefined
  }
  wayBackLink = typeof kept?.link === 'string' ? kept.link : undefined
  button.hidden = wayBackLink === undefined
  if (wayBackLink === undefined) return
  const name = typeof kept?.name === 'string' && kept.name ? kept.name : 'the room you were in'
  button.textContent = `Back to ${name}`
  // Already on the list, so the way to it is not the thing to offer.
  $('doorToRooms').hidden = true
  $('roomNav').hidden = false
}

/** Back to the list: leave the room if in it, and open the app with no
 *  link on it. A reload for the same reason `leaveRoom` reloads. */
async function backToRooms(): Promise<void> {
  if (hasUnsentWork() && !await confirmDiscardAndLeave()) return
  const s = session
  session = undefined
  sessionTransport = undefined
  // Written down BEFORE the link comes off the address bar, because after
  // that this page no longer knows it.
  rememberWayBack()
  s?.leave()
  history.replaceState(null, '', joinLinkBase())
  approvedReload()
}

// ---------------------------------------------------------------------------
// Notifications
//
// From this open app, and from nowhere else: there is no server to push
// from. The rule for when a message is worth one is in app/src/notify.ts;
// this is the browser around it - permission, the system notification, and
// what a click on one does.
// ---------------------------------------------------------------------------

const APP_TITLE = document.title

/** How a sender is named in a notification: as everywhere else, the name
 *  they claim beside a short key, or the key alone. */
function senderLabel(m: ChatMessage): string {
  const shown = shownAs(m.participant, m.name)
  return shown.name !== undefined ? `${shown.name} (${shown.short})` : shown.short
}

const notifier = new Notifier({
  settings: () => notifySettings(deviceStore),
  hidden: () => document.hidden,
  shownRoomId: () => (session ? currentRoomId() : undefined),
  self: () => meParticipant || currentParticipant(),
  deliver: (content, arrival) => deliverNotification(content, arrival),
  onPending: (count) => {
    document.title = titleWithCount(APP_TITLE, count)
  },
})

/**
 * One notification, through the service worker's registration when there
 * is one - that is what survives the tab being put in the background on a
 * phone - and through the page otherwise. The room's link rides in the
 * notification's data, for the click: it is the same link this device
 * already keeps for the room, held by the same browser.
 */
async function deliverNotification(content: NotificationContent, arrival: Arrival): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const url = knownRoom(roomStore(), arrival.roomId)?.link
  const options: NotificationOptions = { body: content.body, tag: content.tag, data: { url } }
  let registration: ServiceWorkerRegistration | undefined
  try {
    registration = await navigator.serviceWorker?.getRegistration()
  } catch {
    registration = undefined
  }
  if (registration?.showNotification) {
    await registration.showNotification(content.title, options)
    return
  }
  const shown = new Notification(content.title, options)
  shown.onclick = () => {
    window.focus()
    shown.close()
    if (url) openLink(url)
  }
}

/** Whether a link opens the room this page is already on. */
function alreadyHere(url: string): boolean {
  try {
    const link = parseRoomLink(url)
    if (link.invitation) {
      return roomInvitationCapability !== undefined && deriveInvitationId(link.invitation) === deriveInvitationId(roomInvitationCapability)
    }
    if (link.secret) return currentRoomId() === deriveRoom(link.secret).roomId
  } catch {
    // Not a room link.
  }
  return false
}

/** Open a room link from a notification: this app's own links only, and
 *  a reload for the reason `openKnownRoom` reloads. */
async function openLink(url: string): Promise<void> {
  let target: URL
  try {
    target = new URL(url, location.href)
  } catch {
    return
  }
  if (target.origin !== location.origin || !target.href.startsWith(joinLinkBase())) return
  if (alreadyHere(target.href)) return
  if ((hasUnsentWork() || callIsLive() || onCall()) && !await confirmRoomAction({ title: 'Open the other room?', message: 'This leaves your call and discards unfinished messages and files in this tab.', confirmLabel: 'Leave and open room', danger: true })) return
  history.replaceState(null, '', target.href)
  approvedReload()
}

navigator.serviceWorker?.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown; url?: unknown } | null
  if (data && data.type === 'kithmoot:open' && typeof data.url === 'string') openLink(data.url)
})

function renderNotifyChoice(): void {
  const settings = notifySettings(deviceStore)
  const supported = typeof Notification !== 'undefined'
  const granted = supported && Notification.permission === 'granted'
  const on = settings.enabled && granted
  setToggle('toggleNotify', on)
  $('toggleNotify').setAttribute('aria-pressed', String(on))
  ;($('toggleNotify') as HTMLButtonElement).disabled = !supported
  const textToggle = $('toggleNotifyText') as HTMLButtonElement
  textToggle.hidden = !on
  setToggle('toggleNotifyText', settings.showText)
  textToggle.setAttribute('aria-pressed', String(settings.showText))
  const note = $('notifyNote')
  if (!supported) {
    note.textContent = 'This browser cannot show notifications.'
  } else if (Notification.permission === 'denied') {
    note.textContent = 'Your browser is blocking notifications for this site. You will have to allow them in the browser\u2019s own settings first.'
  } else if (on) {
    note.textContent = settings.showText
      ? 'On: when somebody writes in a room you are not looking at, your device shows you the room, who wrote, and what they said.'
      : 'On: when somebody writes in a room you are not looking at, your device shows you the room and who wrote. What they actually said stays in here unless you ask for it.'
  } else {
    note.textContent =
      'Off. Switched on, this page tells you when somebody writes in a room you are not looking at, whether that is a tab behind this one or a room on your list. It is this page that tells you and nothing else, so if you close it you hear nothing.'
  }
}

async function setNotify(on: boolean): Promise<void> {
  if (on && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
    // Asked from the click, which is the only place a browser will grant it.
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      setNotifySettings(deviceStore, { enabled: false })
      renderNotifyChoice()
      return
    }
  }
  setNotifySettings(deviceStore, { enabled: on })
  renderNotifyChoice()
}

// ---------------------------------------------------------------------------
// Being nudged by the keeper
//
// The keeper is the one party always in the room, and a Nostr key is an
// address a DM can reach. A member signed in with one can ask the keeper,
// on the control channel, to say when there are new messages and they are
// away. A name-only identity has no inbox to read a DM from, so it is not
// offered the switch. What was last asked for is remembered per room on
// this device; the keeper holds the truth of it.
// ---------------------------------------------------------------------------

const NUDGE_PREFIX = 'kithmoot.nudge.'

function nudgeWanted(roomId: string): boolean {
  try {
    return localStorage.getItem(NUDGE_PREFIX + roomId) === 'true'
  } catch {
    return false
  }
}

function renderNudgeChoice(): void {
  const row = $('nudgeRow')
  const roomId = currentRoomId()
  row.hidden = !session || !nostrSession || !roomId
  const on = roomId !== undefined && nudgeWanted(roomId)
  setToggle('toggleNudge', on)
  $('toggleNudge').setAttribute('aria-pressed', String(on))
}

async function setNudge(on: boolean): Promise<void> {
  const roomId = currentRoomId()
  if (!session || !nostrSession || !roomId) return
  await session.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'nudge', on }))
  try {
    if (on) localStorage.setItem(NUDGE_PREFIX + roomId, 'true')
    else localStorage.removeItem(NUDGE_PREFIX + roomId)
  } catch {
    // Storage may be unavailable; the keeper still heard.
  }
  renderNudgeChoice()
  setStatus(on ? 'Asked the computer that looks after this room to nudge you when you miss messages.' : 'Asked it to stop nudging you.')
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// The bar: back, who and where, the call, and everything else.
installKeyboardNavigation(document)
$('backToRooms').addEventListener('click', openRoomSwitcher)
$('doorToRooms').addEventListener('click', openRoomSwitcher)
$('watchAgents').addEventListener('click', () => selectChannel(AGENT_CHANNEL))
$('nextUnread').addEventListener('click', () => {
  const next = nextUnreadConversation()
  if (!next) return
  selectChannel(next[0])
  $('chatLog').focus({ preventScroll: true })
})
$('manageAgents').addEventListener('click', () => {
  openRoomSheet()
  ;($('inviteAgents') as HTMLDetailsElement).open = true
  $('inviteAgents').scrollIntoView({ block: 'start' })
  $('inviteAgents').querySelector('summary')?.focus()
})
$('chatLog').addEventListener('scroll', () => { if (markConversationRead()) renderConversationNav() }, { passive: true })
document.addEventListener('visibilitychange', () => { if (markConversationRead()) renderConversationNav() })
document.addEventListener('kithmoot:confirmation-closed', () => { if (markConversationRead()) renderConversationNav() })
$('messageActionPanel').addEventListener('toggle', () => { if (markConversationRead()) renderConversationNav() })
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => { if (markConversationRead()) renderConversationNav() })
}
$('conversationNav').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const buttons = Array.from($('conversationNav').querySelectorAll<HTMLButtonElement>('button'))
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
})
$('workspaceSwitch').addEventListener('click', openRoomSwitcher)
$('workspaceQuery').addEventListener('input', renderWorkspace)
$('workspaceHome').addEventListener('click', () => {
  if (hasUnsentWork()) { openRoomSwitcher(); return }
  $('roomSwitcherHome').click()
})
$('homeProject').addEventListener('change', renderRooms)
$('switcherProject').addEventListener('change', renderRoomSwitcher)
$('projectCancel').addEventListener('click', () => ($('projectEditor') as HTMLDialogElement).close())
$('projectEditor').addEventListener('close', () => {
  if (projectReturn?.isConnected) { projectReturn.focus({ preventScroll: true }); return }
  const row = Array.from(projectReturnList?.querySelectorAll<HTMLElement>('[data-room]') ?? []).find(row => row.dataset.room === projectRoom?.roomId)
  const target = row?.querySelector<HTMLElement>('[data-action=project]')
  ;(target ?? (($('roomSwitcher') as HTMLDialogElement).open ? $('roomSearch') : !$('workspaceNav').hidden && $('workspaceNav').offsetWidth ? $('workspaceQuery') : $('homeRoomQuery'))).focus({ preventScroll: true })
})
$('projectForm').addEventListener('submit', event => {
  event.preventDefault()
  if (!projectRoom) return
  try {
    setRoomProject(deviceStore, nostrSession?.pubkey, projectRoom.roomId, ($('projectName') as HTMLInputElement).value)
    ;($('projectEditor') as HTMLDialogElement).close()
    renderRooms()
  } catch {
    $('projectError').textContent = 'The project could not be saved. Try again after allowing storage for this site.'
    $('projectError').hidden = false
  }
})
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'k') return
  if (document.querySelector('dialog[open]') || (!session && !currentRoomId())) return
  event.preventDefault()
  openRoomSwitcher()
})
window.addEventListener('storage', event => {
  if (event.key?.startsWith('kithmoot.project.v1.')) renderRooms()
})
$('roomSwitcher').addEventListener('close', () => {
  if (roomSwitcherReturn?.isConnected) roomSwitcherReturn.focus({ preventScroll: true })
})
$('roomSwitcherClose').addEventListener('click', () => ($('roomSwitcher') as HTMLDialogElement).close())
$('roomSearch').addEventListener('input', renderRoomSwitcher)
$('roomSwitcherHome').addEventListener('click', async () => {
  if (hasUnsentWork()) { renderRoomSwitcher(); return }
  if ((callIsLive() || onCall()) && !await confirmRoomAction({ title: 'Leave this call?', message: 'You will return to all rooms. Your microphone and camera will turn off.', confirmLabel: 'Leave call' })) return
  backToRooms()
})
$('roomSwitcher').addEventListener('click', event => {
  if (event.target === $('roomSwitcher')) ($('roomSwitcher') as HTMLDialogElement).close()
})
$('roomIdentity').addEventListener('click', openRoomSheet)
$('roomMenu').addEventListener('click', openRoomSheet)
$('roomSheetClose').addEventListener('click', closeRoomSheet)
$('searchConversation').addEventListener('click', () => {
  const sheet = $('roomSheet') as HTMLDialogElement
  if (sheet.open) {
    sheet.addEventListener('close', () => conversationSearch.open(undefined, 'conversation'), { once: true })
    sheet.close()
  } else conversationSearch.open(undefined, 'conversation')
})
const inviteDialog = $('inviteDialog') as HTMLDialogElement
$('invitePeople').addEventListener('click', () => {
  if (!session || roomPolicy?.members?.length || inviteDialog.open) return
  $('inviteStatus').textContent = ''
  $('inviteSlot').append($('inviteContent'))
  ;($('copyShare') as HTMLButtonElement).autofocus = true
  inviteDialog.showModal()
  $('copyShare').focus({ preventScroll: true })
})
$('inviteClose').addEventListener('click', () => inviteDialog.close())
inviteDialog.addEventListener('close', () => {
  ;($('copyShare') as HTMLButtonElement).autofocus = false
  $('inviteHome').append($('inviteContent'))
  $('invitePeople').focus({ preventScroll: true })
})
inviteDialog.addEventListener('click', event => {
  if (event.target !== inviteDialog) return
  const bounds = inviteDialog.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) inviteDialog.close()
})

const assignmentPanel = new AssignmentPanel(document, () => {
  return (session?.participants() ?? []).map(p => {
    const actions = [...catalogues.values()].flatMap(c => c.agents.filter(a => c.running.some(r => r.id === a.id && r.participant === p.participant)).flatMap(a => a.actions ?? []))
    return { pubkey: p.participant, label: personLabel(p.participant), agent: p.agent === true, actions,
      ...(p.agent && p.devices.length ? { ownerDevice: [...p.devices].sort()[0] } : {}) }
  })
}, refreshRoomNavigation)

const contextPanel = new ContextPanel(document, {
  identity: () => { const crypt = peerCrypt(); if (!crypt) return undefined; const identity = currentIdentity(); return { pubkey: identity.pubkey, signEvent: event => identity.signEvent(event), ...crypt } },
  room: currentRoomId,
  server: blossomServer,
  members: () => (session?.participants() ?? []).map(p => ({ pubkey: p.participant, name: p.name ?? shortKey(p.participant), agent: p.agent === true, proof: session?.agentOwnership(p.participant) })),
})
$('openContext').addEventListener('click', () => { closeRoomSheet(); void contextPanel.open() })
$('chatSearch').addEventListener('click', () => conversationSearch.open($('chatSearch')))
let profileReturnFocus: HTMLElement = $('roomMenu')
function openProfileSettings(from: HTMLElement): void {
  profileReturnFocus = from
  closeRoomSheet()
  ;($('profileSettings') as HTMLDialogElement).showModal()
  $('lookupProfiles').focus()
}
$('roomProfileSettings').addEventListener('click', () => openProfileSettings($('roomMenu')))
const relaySettings = new RelaySettingsPanel(document, relayConnections, {
  room: () => roomRelayScope === 'default' ? undefined : { scope: roomRelayScope, hints: roomRelayConfig },
  applied: (scope, entries) => {
    if (scope === 'default') RELAYS = relayConnections.configuration('default').map(relay => relay.url)
    if (scope === roomRelayScope) {
      roomRelayConfig = entries
      relays = entries.map(relay => relay.url)
      profiles.setEnabled(false); profiles.setEnabled(profilesEnabled)
      if (session) { render(session.participants(), meParticipant); repaintActiveChat() }
      renderIdentity()
      if (currentRoomId()) {
        ;($('shareUrl') as HTMLInputElement).value = encodeRoomUrl(joinLinkBase(), relays, iceUrls)
        rememberCurrentRoom()
      }
    }
  },
})
$('roomRelaySettings').addEventListener('click', () => { closeRoomSheet(); relaySettings.open($('roomMenu')) })
$('defaultRelaySettings').addEventListener('click', () => relaySettings.open($('defaultRelaySettings')))
$('profileSettingsClose').addEventListener('click', () => ($('profileSettings') as HTMLDialogElement).close())
$('profileSettings').addEventListener('close', () => profileReturnFocus.focus({ preventScroll: true }))
// A tap on the backdrop, which is the gesture people expect of a sheet. The
// dialog element itself fills the screen, so a click that lands ON the
// dialog and not on anything inside it is a click on the backdrop.
$('roomSheet').addEventListener('click', (event) => {
  if (event.target === $('roomSheet')) closeRoomSheet()
})
$('callToggle').addEventListener('click', () => {
  if (!onCall()) {
    joinCall().catch((err) => setStatus(describeError(err)))
    return
  }
  // On a call the controls stay up. Pressing "On call" used to fold them
  // away, so the one button a person had just pressed to get the mic and
  // camera hid the mic and camera; now it brings them back into view if
  // the page has scrolled past them, and that is all.
  setCallOpen(true)
  $('deviceControls').scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})
$('joinCall').addEventListener('click', () => {
  joinCall().catch((err) => setStatus(describeError(err)))
})
$('leaveCall').addEventListener('click', () => {
  leaveCall().catch((err) => setStatus(describeError(err)))
})
$('listenHere').addEventListener('click', () => {
  besideAnotherDevice = false
  monitorClaimedAt = nowSeconds()
  publishActiveTracks()
  updateUi()
})

// The way back into the room this tab just left. A fragment-only change is
// a same-document navigation and never re-runs this module, so the reload
// is what reads the link - the same two lines `openKnownRoom` uses.
$('backToRoom').addEventListener('click', () => {
  const link = wayBackLink
  if (!link) return
  try {
    history.replaceState(null, '', link)
  } catch {
    location.href = link
  }
  location.reload()
})

renderNotifyChoice()
$('toggleNotify').addEventListener('click', () => {
  setNotify($('toggleNotify').dataset.on !== 'true').catch((err) => setStatus(describeError(err)))
})
$('toggleNotifyText').addEventListener('click', () => {
  setNotifySettings(deviceStore, { showText: $('toggleNotifyText').dataset.on !== 'true' })
  renderNotifyChoice()
})
$('toggleKeep').addEventListener('click', () => setKeepRoomChoice($('toggleKeep').dataset.on !== 'true'))
$('toggleKnock').addEventListener('click', () => {
  const roomId = currentRoomId()
  if (!roomId) return
  setKnock(roomId, $('toggleKnock').dataset.on !== 'true')
  renderKnockChoice()
  // The host loop reads the switch when it starts, so start it again.
  serveCurrentInvitation()
})
$('toggleNudge').addEventListener('click', () => {
  const button = $('toggleNudge') as HTMLButtonElement
  button.disabled = true
  setNudge(button.dataset.on !== 'true')
    .catch((err) => setStatus(describeError(err)))
    .finally(() => {
      button.disabled = false
    })
})

$('displayName').addEventListener('input', (event) => {
  // Stored as typed, sanitised on the way in. The identity line below the
  // field re-renders as you go, so what other people will see is on screen
  // before you commit to anything.
  storeName((event.target as HTMLInputElement).value)
  renderIdentity()
})

$('joinNostr').addEventListener('click', () => {
  signInWithNostr().catch((err) => setStatus(describeError(err)))
})

$('signIn').addEventListener('click', () => {
  signInWithNostr().catch((err) => setStatus(describeError(err)))
})

$('signOut').addEventListener('click', () => {
  signOutOfNostr().catch((err) => setStatus(describeError(err)))
})
$('retryRoomSync').addEventListener('click', () => { void bookmarks?.retry() })
$('importBrowserRooms').addEventListener('click', () => {
  try { importBrowserRooms() } catch (error) { setStatus(describeError(error)) }
})

$('createRoomForm').addEventListener('submit', async event => {
  event.preventDefault()
  const button = $('create') as HTMLButtonElement
  if (button.disabled) return
  button.disabled = true
  button.textContent = 'Creating…'
  $('createError').hidden = true
  try {
    await startNewRoom()
    setStatus('')
    showRoomUi()
    $('identity').scrollIntoView({ block: 'start' })
    ;(typedName ? $('join') : $('displayName')).focus({ preventScroll: true })
  } catch (error) {
    $('createError').textContent = `Could not create the room. ${describeError(error)}. Try again when connected.`
    $('createError').hidden = false
  } finally { button.disabled = false; button.textContent = 'Start a room' }
})
$('openRoomForm').addEventListener('submit', event => {
  event.preventDefault()
  const value = ($('url') as HTMLInputElement).value.trim()
  const error = $('linkError')
  try {
    if (!value) throw new Error('Paste the invitation link you were sent.')
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported scheme')
    parseRoomLink(url.href)
    // Open its room in this app. A valid invitation from another host
    // carries its relay and admission settings in the same fragment.
    history.replaceState(null, '', joinLinkBase() + url.hash)
    location.reload()
  } catch {
    error.textContent = value
      ? 'This is not a complete KithMoot invitation. Copy the whole link, including everything after #, and try again.'
      : 'Paste the invitation link you were sent.'
    error.hidden = false
    $('url').setAttribute('aria-invalid', 'true')
    $('url').focus()
  }
})
$('url').addEventListener('input', () => {
  $('linkError').hidden = true
  $('linkError').textContent = ''
  $('url').removeAttribute('aria-invalid')
})
$('homeRoomQuery').addEventListener('input', renderRooms)
$('clearHomeRoomQuery').addEventListener('click', () => {
  ;($('homeRoomQuery') as HTMLInputElement).value = ''
  renderRooms()
  $('homeRoomQuery').focus()
})
$('returnToPreviousRoom').addEventListener('click', () => {
  if (previousRoom) void switchRoom(previousRoom)
})
$('retryArrival').addEventListener('click', () => {
  if (switchDestination) void switchRoom(switchDestination)
  else location.reload()
})
$('arrivalHome').addEventListener('click', async () => {
  if (hasUnsentWork() && !await confirmDiscardAndLeave()) return
  history.replaceState(null, '', joinLinkBase())
  approvedReload()
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
    pairingTransport = configuredPool(relays)
    pairingHost = hostPairing({
      transport: pairingTransport,
      roomId,
      roomKey,
      code,
      identity,
      deviceSk: deviceKey(),
      approve: (device) => confirmRoomAction({ title: 'Add this device?', message: `Device ${device.slice(0, 12)}… will join this room as you for the next 12 hours. Only approve a device you are pairing.`, confirmLabel: 'Add device' }),
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
  shareRoomLink().catch((err) => { $('inviteStatus').textContent = describeError(err) })
})
$('rotateShare').addEventListener('click', async () => {
  if (!await confirmRoomAction({ title: 'Replace the room link?', message: 'The old link will stop admitting new people in current KithMoot clients. Existing members stay in the room.', confirmLabel: 'Replace link', danger: true })) return
  ++roomOperation
  try { await rotateRoomInvitation() } catch (err) { setStatus(describeError(err)) }
  finally { --roomOperation; refreshRoomNavigation() }
})
$('makePersistent').addEventListener('click', async () => {
  const button = $('makePersistent') as HTMLButtonElement
  button.disabled = true
  ++roomOperation
  try { await makeRoomPersistent() } catch (error) { setStatus(describeError(error)) }
  finally { button.disabled = false; --roomOperation; refreshRoomNavigation() }
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
$('toggleCompanion').addEventListener('click', toggleCompanionMode)
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
  const generation = roomGeneration
  const button = $('voicePreview') as HTMLButtonElement
  const player = $('voicePreviewAudio') as HTMLAudioElement
  if (!mic) return
  button.disabled = true
  button.textContent = 'Listening…'
  mic
    .preview()
    .then((blob) => {
      if (generation !== roomGeneration) return
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

$('joinVisitor').addEventListener('click', async () => {
  const generation = identityGeneration
  const room = roomGeneration
  if (!await confirmAction({
    title: 'Join with just a name?',
    message: 'This is not your Nostr account, even with the same name. Agents that know your account may ignore these messages.',
    confirmLabel: 'Join with just a name',
    cancelLabel: 'Back to sign-in',
    isCurrent: () => generation === identityGeneration && room === roomGeneration && needsAccountReconnect() && !session && !joining,
  })) return
  await startSession(true)
})

/** Enter pressed while the door was still being built, or while a sign-in
 *  was being restored. It used to be dropped on the floor: the person saw
 *  "Going in as Kit" and nothing else happened. Now it is kept and acted on
 *  the moment the door is ready. */
let pendingJoin = false
function tryPendingJoin(): void {
  if (!pendingJoin) return
  const join = $('join') as HTMLButtonElement
  if (join.hidden || join.disabled || loginBusy || session || joining) return
  pendingJoin = false
  startSession().catch((err) => setStatus(describeError(err)))
}
$('joinRoomForm').addEventListener('submit', event => {
  event.preventDefault()
  const join = $('join') as HTMLButtonElement
  if (session || joining) return
  if (join.hidden || join.disabled || loginBusy) {
    pendingJoin = true
    setStatus('One moment…', 'progress')
    return
  }
  startSession().catch((err) => setStatus(describeError(err)))
})

/** Leave every local media source before returning to this room's door. */
async function leaveRoom(): Promise<void> {
  closeAllDrafts()
  ;($('leave') as HTMLButtonElement).disabled = true
  await closeRoomSession()
  approvedReload()
}

$('leave').addEventListener('click', async () => {
  if (hasUnsentWork() && !await confirmDiscardAndLeave()) return
  void leaveRoom()
})

// A closed tab, a navigation away, or a phone putting the browser to sleep
// is a departure too, and a silent one costs everybody else the whole
// presence timeout. Best effort: the farewell is one small publish over
// sockets that are already open, and the page is gone whatever happens.
window.addEventListener('beforeunload', event => {
  if (navigationApproved || !hasUnsentWork()) return
  event.preventDefault()
  event.returnValue = ''
})
window.addEventListener('pagehide', () => {
  closeAllDrafts()
  session?.leave()
  stopInvitationHost()
  for (const roomId of [...roomWatches.keys()]) stopWatching(roomId)
})

setToggle('toggleAgentsHear', agentsMayHear)
$('toggleAgentsHear').addEventListener('click', () => setAgentsMayHear(!agentsMayHear))

// The agents' conversation had its own box to type in, under the chat's
// own box, on the same screen. Two writing boxes on one page is a question
// nobody should have to answer. There is one now, and the tab above it says
// which conversation it is writing to - see `activeChat`.

/**
 * The box grows with what is written in it.
 *
 * It was one line that scrolled sideways, so a message longer than the box
 * could not be read back before it was sent - and somebody who cannot
 * re-read what they wrote sends it anyway and finds the typo afterwards.
 * Six lines is enough for a paragraph; past that it scrolls, because a box
 * that grows without limit eats the conversation above it.
 */
const COMPOSER_MAX_LINES = 6

function growComposer(box: HTMLTextAreaElement): void {
  // A hidden box measures as nothing, and writing that measurement back
  // would leave it nothing once it is shown again.
  if (!box.isConnected || box.offsetParent === null) return
  box.style.height = 'auto'
  const style = getComputedStyle(box)
  const line = Number.parseFloat(style.lineHeight) || 20
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  const borders = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0)
  const most = line * COMPOSER_MAX_LINES + padding + borders
  // A long conversation name in the placeholder is not a multi-line draft.
  box.style.height = `${box.value ? Math.min(box.scrollHeight + borders, most) : line + padding + borders}px`
}

// ---------------------------------------------------------------------------
// Typing somebody's name
//
// An `@` opens the room. It filters as you keep typing, a tap or Enter puts
// the name in, Escape closes it. What goes into the box is the display name
// EXACTLY as the roster spells it - not slugified, not stripped of spaces,
// not lowercased - because the agent side matches on that string and a
// transformed one silently never matches. "The moot" is a real name in a
// real room and `@The moot` has to work.
//
// The list opens UPWARDS, above the box. Below the box on a phone is where
// the keyboard is, and a picker behind a keyboard does not exist.
// ---------------------------------------------------------------------------

interface MentionChoice {
  name: string
  agent: boolean
  room?: boolean
  model?: ComposerModel
}

/** Where the `@` being completed sits in the box, or -1 for closed. */
let mentionAt = -1
let mentionChoices: MentionChoice[] = []
let mentionCursor = 0
let dismissedMention: { session: typeof session; channel: typeof currentChannel; value: string; start: number; end: number } | undefined

/** How much text after an `@` is still plausibly a name being typed. Names
 *  can carry spaces, so this cannot stop at the first one; it stops when
 *  what has been typed is longer than any name could reasonably be. */
const MENTION_QUERY_LIMIT = 48

function closeMentionPicker(): void {
  if (mentionAt === -1) return
  mentionAt = -1
  mentionChoices = []
  mentionCursor = 0
  const box = $('mentions')
  box.hidden = true
  box.innerHTML = ''
  $('chatInput').setAttribute('aria-expanded', 'false')
  $('chatInput').removeAttribute('aria-activedescendant')
}

function availableComposerModels(): ComposerModel[] {
  return composerModels(catalogues.values(), session?.participants() ?? [])
}

function modelClerkNames(): string[] {
  // Remember the addressed clerk after it leaves so a draft's selector is
  // still validated, rather than becoming ordinary text when the roster shrinks.
  const names = new Set(rosterNames())
  for (const catalogue of catalogues.values()) {
    for (const entry of catalogue.agents) {
      if (entry.models && catalogue.running.some(r => r.id === entry.id && r.participant === catalogue.host)) names.add(entry.name)
    }
  }
  return [...names]
}

/** Everybody in the room bar yourself, people and agents alike, ordered so
 *  that what you have typed so far leads the list. */
function mentionCandidates(query: string): MentionChoice[] {
  // A trailing space completes a mention; trimming it reopened the picker
  // after selection and made Enter select the same name instead of sending.
  const wanted = query.toLowerCase()
  const seen = new Set<string>(['all', 'everyone'])
  const all: MentionChoice[] = []
  for (const view of session?.participants() ?? []) {
    const name = view.name?.trim()
    if (!name || view.participant === meParticipant) continue
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    all.push({ name, agent: view.agent === true })
  }
  // The whole room, last, so a name still leads when one matches.
  all.push({ name: 'all', agent: false, room: true })
  if (wanted && 'everyone'.startsWith(wanted)) all.push({ name: 'everyone', agent: false, room: true })
  if (!wanted) return all
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(wanted))
  const contains = all.filter((c) => !c.name.toLowerCase().startsWith(wanted) && c.name.toLowerCase().includes(wanted))
  return [...starts, ...contains]
}

/**
 * Decide whether an `@` is being completed right now, and draw the list.
 *
 * Run on every keystroke and every move of the caret. The `@` counts only
 * at the start of a word, so an email address in the middle of a sentence
 * does not open a picker.
 */
function renderMentionPicker(): void {
  const box = $('chatInput')
  if (!(box instanceof HTMLTextAreaElement) || !session) {
    dismissedMention = undefined
    closeMentionPicker()
    return
  }
  const caret = box.selectionStart ?? 0
  // Escape dismisses this completion until the draft or caret changes.
  // Queued selection events and catalogue updates must not reopen it.
  if (dismissedMention?.session === session && dismissedMention.channel === currentChannel &&
    dismissedMention.value === box.value && dismissedMention.start === caret && dismissedMention.end === box.selectionEnd) {
    closeMentionPicker()
    return
  }
  dismissedMention = undefined
  if (box.selectionEnd !== caret) { closeMentionPicker(); return }
  const before = box.value.slice(0, caret)
  const models = modelCompletions(before, availableComposerModels(), modelClerkNames())
  const at = models === undefined ? before.lastIndexOf('@') : 0
  const priorChar = at > 0 ? before[at - 1] ?? '' : ''
  const startsWord = at === 0 || /[^\p{L}\p{N}_]/u.test(priorChar)
  const query = at === -1 ? '' : before.slice(at + 1)
  if (models === undefined && (at === -1 || !startsWord || query.includes('\n') || query.length > MENTION_QUERY_LIMIT)) {
    closeMentionPicker()
    return
  }
  const choices: MentionChoice[] = models === undefined ? mentionCandidates(query) :
    models.map(model => ({ name: `^${model.id}`, agent: true, model }))
  if (choices.length === 0) {
    closeMentionPicker()
    return
  }
  const reopened = mentionAt !== at
  mentionAt = at
  mentionChoices = choices
  mentionCursor = reopened ? 0 : Math.min(mentionCursor, choices.length - 1)

  const list = $('mentions')
  list.setAttribute('aria-label', models === undefined ? 'People and agents in this room' : 'Models available for this task')
  list.innerHTML = ''
  choices.forEach((choice, i) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.id = `composer-choice-${i}`
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(i === mentionCursor))
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = choice.name
    option.append(name)
    if (choice.room) {
      const detail = document.createElement('span')
      detail.className = 'model-label'
      detail.textContent = 'Everyone in this room, including agents'
      option.append(detail)
    }
    if (choice.model) {
      option.className = 'model-choice'
      const detail = document.createElement('span')
      detail.className = 'model-label'
      detail.textContent = `${choice.model.label} · ${choice.model.agent}`
      option.append(detail)
    }
    // The same tag in the same colour as on the roster and on the bubbles,
    // so "this one is a program" is one idea told one way everywhere.
    if (choice.agent && !choice.model) {
      const badge = document.createElement('span')
      badge.className = 'badge agent'
      badge.textContent = 'agent'
      option.append(badge)
    }
    // Pointer down rather than click: a tap takes focus off the box, and a
    // box that has lost focus has no caret to insert at.
    option.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      chooseMention(i)
    })
    list.append(option)
  })
  list.hidden = false
  box.setAttribute('aria-expanded', 'true')
  box.setAttribute('aria-activedescendant', `composer-choice-${mentionCursor}`)
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
}

/** Put the chosen name in, spelled exactly as the roster spells it, with a
 *  space after it so the next word is not stuck to the name. */
function chooseMention(index: number): void {
  const box = $('chatInput')
  const choice = mentionChoices[index]
  if (!(box instanceof HTMLTextAreaElement) || !choice || mentionAt === -1) return
  const caret = box.selectionStart ?? 0
  const suffix = box.value.slice(caret)
  const separator = /^\s/.test(suffix) ? '' : ' '
  const inserted = (choice.model ? `@${choice.model.agent} ^${choice.model.id}` : `@${choice.name}`) + separator
  box.value = box.value.slice(0, mentionAt) + inserted + suffix
  const after = mentionAt + inserted.length
  closeMentionPicker()
  box.focus()
  box.setSelectionRange(after, after)
  dismissedMention = { session, channel: currentChannel, value: box.value, start: after, end: after }
  growComposer(box)
  captureDraft()
}

function moveMentionCursor(by: number): void {
  if (mentionChoices.length === 0) return
  mentionCursor = (mentionCursor + by + mentionChoices.length) % mentionChoices.length
  const options = $('mentions').querySelectorAll('[role="option"]')
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === mentionCursor)))
  $('chatInput').setAttribute('aria-activedescendant', `composer-choice-${mentionCursor}`)
  options[mentionCursor]?.scrollIntoView({ block: 'nearest' })
}

/**
 * Say what will come of a typed `!minutes`, either way.
 *
 * The Minutes tab printed that instruction unconditionally, and in a room
 * with no scribe in it typing the words posted a plain message and produced
 * nothing: no minutes, no refusal, no error. Silence after following a
 * written instruction reads as "I did it wrong", which is the worst answer
 * a first-time reader can be given. The tab no longer prints the
 * instruction when nothing can answer it, and this answers anybody who
 * types it anyway - or who was told the words by somebody else.
 */
function acknowledgeMinutesRequest(): void {
  addSystemLine(
    minuteTakerHere()
      ? 'You asked for the minutes. They appear on the Minutes tab once the agent has written them.'
      : 'Nothing in this room writes minutes at the moment, so nobody is going to answer that. ' +
          'Minutes are written by an agent somebody brings in, and the Agents tab says who is here.',
  )
}

$('emojiToggle').addEventListener('click', () => {
  const input = $('chatInput') as HTMLTextAreaElement
  if (input.readOnly) return
  const channel = currentChannel
  const start = input.selectionStart, end = input.selectionEnd
  emojiPicker.open(input, emoji => {
    if (currentChannel !== channel || input.readOnly) return
    if (input.value.length - (end - start) + emoji.length > MAX_CHAT_TEXT_LENGTH) {
      setStatus('There is no room for that emoji. Shorten your message first.')
      return
    }
    input.setRangeText(emoji, start, end, 'end')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
})

// ---------------------------------------------------------------------------
// What the box is doing besides saying something new
//
// Answering a message puts the reply in its thread; editing replaces one of
// ours. Either is shown above the box with a way out, and cleared when the
// message goes. Reply and edit targets stay with their draft in this tab;
// they never carry over to a different room or conversation.
// ---------------------------------------------------------------------------

function setComposing(next: { replyTo?: ChatMessage; editing?: ChatMessage }, shown?: ChatMessage): void {
  const current = drafts.get(currentChannel)
  current.replyTo = next.replyTo
  current.editing = next.editing
  const box = $('chatInput') as HTMLTextAreaElement
  if (next.editing && shown) {
    // The message as it reads now, to correct, with its files staged so
    // an edit that says nothing about them keeps them. An edit is the
    // whole new message; see docs/messages.md.
    const draft = captureDraft()
    box.value = shown.text
    draft.text = shown.text
    draft.attachments = [...(shown.attachments ?? [])]
    draftChanged(draft)
    growComposer(box)
  }
  renderComposerContext()
  box.focus()
}

function renderComposerContext(): void {
  const composing = drafts.get(currentChannel)
  const bar = $('composerContext')
  bar.innerHTML = ''
  const target = composing.editing ?? composing.replyTo
  if (!target) {
    bar.hidden = true
    return
  }
  const label = document.createElement('span')
  label.className = 'contextLabel'
  label.textContent = composing.editing ? 'Editing your message' : `Replying to ${senderLabel(target)}`
  const excerpt = document.createElement('span')
  excerpt.className = 'contextExcerpt'
  excerpt.textContent = resolveConversation(activeChat()?.messages() ?? []).byKey.get(refKey({ messageId: target.id, participant: target.participant }))?.shown.text ?? target.text
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'quiet'
  cancel.textContent = 'Cancel'
  cancel.setAttribute('aria-label', composing.editing ? 'Stop editing' : 'Stop replying')
  cancel.addEventListener('click', () => {
    if (composing.editing) {
      const box = $('chatInput') as HTMLTextAreaElement
      const draft = captureDraft()
      box.value = ''
      draft.text = ''
      draft.attachments = []
      draftChanged(draft)
      growComposer(box)
    }
    setComposing({})
  })
  bar.append(label, excerpt, cancel)
  bar.hidden = false
}

/**
 * Who the typed text addresses, declared on the wire: everybody on the
 * roster it names as a whole word, with or without the @, which is the
 * rule readers have always applied. Explicit @all and @everyone calls
 * include the entire room. The broadcast comes first so it survives the cap.
 */
function mentionsInDraft(text: string): string[] {
  return mentionsOf({ text }, (session?.participants() ?? []).filter(view => view.participant !== meParticipant))
    .slice(0, MAX_MENTIONS)
}

async function retractMessage(original: ChatMessage): Promise<void> {
  const chat = activeChat() ?? session?.chat
  const channel = currentChannel
  if (!chat) return
  if (!await confirmRoomAction({ title: 'Retract this message?', message: 'It will be marked retracted. People who already received it may still have a copy.', confirmLabel: 'Retract message', danger: true })) return
  try {
    const text = retractionText()
    outbox.send(text, channel ?? 'Chat', chat.prepareSend(text, { retracts: original.id }))
  } catch (err) {
    setStatus(describeError(err))
  }
}

$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const draft = captureDraft()
  if (draft.job || !channelAvailable(currentChannel) || (currentChannel !== undefined && WRITTEN_BY_AGENTS.includes(currentChannel))) return
  const input = $('chatInput') as HTMLTextAreaElement
  let typed = input.value.trim()
  try {
    typed = prepareModelMessage(typed, availableComposerModels(), modelClerkNames())
  } catch (err) {
    setStatus(describeError(err))
    return
  }
  const attachments = draft.attachments
  if ((!typed && attachments.length === 0) || !session) return
  // A file with nothing said about it still gets a caption, because the
  // caption is all a client that has never heard of attachments will show.
  const text =
    typed ||
    (attachments.length === 1
      ? `Shared a file${attachments[0]?.name ? `: ${attachments[0].name}` : ''}`
      : `Shared ${attachments.length} files`)
  const log = activeChat() ?? session.chat
  const sendOpts: SendOptions = attachments.length ? { attachments } : {}
  const mentions = mentionsInDraft(typed)
  if (mentions.length) sendOpts.mentions = mentions
  if (draft.editing) sendOpts.replaces = draft.editing.id
  else if (draft.replyTo) sendOpts.replyTo = draft.replyTo
  let publish: () => Promise<void>
  try {
    publish = log.prepareSend(text, sendOpts)
  } catch (err) {
    setStatus(describeError(err))
    return
  }
  input.value = ''
  draft.text = ''
  draft.selectionStart = draft.selectionEnd = 0
  growComposer(input)
  closeMentionPicker()
  draft.attachments = []
  draftChanged(draft)
  setComposing({})
  // Into whichever conversation is on screen, which is the main chat until
  // somebody picks another.
  outbox.send(text, currentChannel ?? 'Chat', publish, attachments.map(a => a.name ?? 'Encrypted file'))
  chatScroll.latest()
  if (currentChannel === undefined && asksForMinutes(typed)) acknowledgeMinutesRequest()
})

// The box grows as it is typed into, and Enter sends. Shift and Enter start
// a new line, which is the pair of habits every chat box has and the reason
// a multi-line box costs nothing to use.
$('chatInput').addEventListener('input', () => {
  dismissedMention = undefined
  const draft = captureDraft()
  growComposer($('chatInput') as HTMLTextAreaElement)
  renderMentionPicker()
  renderDraftBadges()
  renderWorkspace()
  ;($('discardDraft') as HTMLButtonElement).hidden = !draftHasWork(draft)
  $('draftHelp').hidden = drafts.pending().length === 0
})
// The caret can move without a keystroke - a tap, a drag, an arrow key -
// and whether an `@` is being completed depends on where it is.
for (const kind of ['click', 'keyup', 'select'] as const) {
  $('chatInput').addEventListener(kind, event => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') return
    renderMentionPicker()
  })
}
$('chatInput').addEventListener('blur', () => closeMentionPicker())

$('chatInput').addEventListener('keydown', (event) => {
  if (!(event instanceof KeyboardEvent)) return
  // Mid-composition in an IME, these keys belong to the IME.
  if (event.isComposing) return

  // While the picker is open it has the keys it needs, and Enter picks a
  // name rather than sending a half-typed one.
  if (mentionAt !== -1) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveMentionCursor(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveMentionCursor(-1)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      chooseMention(mentionCursor)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      const box = $('chatInput') as HTMLTextAreaElement
      dismissedMention = { session, channel: currentChannel, value: box.value, start: box.selectionStart, end: box.selectionEnd }
      closeMentionPicker()
      return
    }
  }

  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  event.preventDefault()
  ;($('chatForm') as HTMLFormElement).requestSubmit()
})

$('channelNew').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('channelName')
  if (!(input instanceof HTMLInputElement)) return
  const name = input.value.trim().toLowerCase()
  // Checked here as well as in the protocol, so a typo is answered on the
  // spot rather than by a request that quietly does nothing.
  if (!CHANNEL_NAME.test(name)) {
    setStatus('A channel name is lower case letters, digits and hyphens, starting with a letter or digit.')
    return
  }
  input.value = ''
  void requestChannel(name, true)
})

// Two clicks rather than a `confirm()`. A browser modal blocks the page and
// reads as an error, and this is not one: closing a channel takes it off the
// room's list and deletes nothing, because everybody admitted still holds
// the key that opens what was said there. So the button says so and asks
// again, in the page.
$('channelClose').addEventListener('click', () => {
  const name = currentChannel
  if (name === undefined) return
  const button = $('channelClose')
  if (button.dataset.arm !== name) {
    button.dataset.arm = name
    button.textContent = `Really close ${name}? Nothing is deleted`
    return
  }
  delete button.dataset.arm
  void requestChannel(name, false)
})

// ---------------------------------------------------------------------------
// Attaching a Wildbloom share to a message
// ---------------------------------------------------------------------------

function renderStaged(): void {
  const draft = drafts.get(currentChannel)
  const box = $('attachStaged')
  box.innerHTML = ''
  draft.attachments.forEach((a, i) => {
    const chip = document.createElement('span')
    chip.className = 'attachChip'
    chip.textContent = `${a.name ?? 'Encrypted file'}${a.size !== undefined ? ` \u00b7 ${formatBytes(a.size)}` : ''} `
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'remove'
    remove.addEventListener('click', () => {
      draft.attachments.splice(i, 1)
      draftChanged(draft)
    })
    chip.append(remove)
    box.append(chip)
  })
  // One name, whatever the state. The button used to be "Add a file" in the
  // markup and "Attach" the moment anything re-rendered it, so a control a
  // person had already found went and a different one appeared in its
  // place. Only the count changes, and it has a span of its own so that
  // neither the label nor the accessible name is touched.
  $('attachCount').textContent = draft.attachments.length ? ` (${draft.attachments.length})` : ''
}

/**
 * The kind-1063 event behind what was pasted: the signed JSON itself, or an
 * id (hex, note1 or nevent1) looked up on the room's relays. Wildbloom shows
 * its uploader the id, so that is the common case; the JSON is for when the
 * event was published somewhere these relays never saw.
 */
async function resolveFileEvent(text: string, signal?: AbortSignal): Promise<NostrEvent> {
  signal?.throwIfAborted()
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
  const transport = configuredPool(relays)
  try {
    return await new Promise<NostrEvent>((resolve, reject) => {
      let off = (): void => {}
      const stop = (): void => {
        clearTimeout(timer)
        off()
        signal?.removeEventListener('abort', cancel)
      }
      const cancel = (): void => { stop(); reject(new Error('Stopped adding the file.')) }
      const timer = setTimeout(() => {
        stop()
        reject(new Error('The room\'s relays do not have that event. Paste the event JSON instead.'))
      }, 8_000)
      signal?.addEventListener('abort', cancel, { once: true })
      off = transport.subscribe([{ ids: [id] }], (event) => {
        if (event.id !== id || !verifyEventUncached(event)) return
        stop()
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
function dropProgress(draft: ConversationDraft, stage: string, file: File): void {
  draft.status = `${stage} ${file.name} (${formatBytes(file.size)})…`
  draftChanged(draft)
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
async function shareDroppedFile(file: File, draft: ConversationDraft, signal: AbortSignal, server: string): Promise<void> {
  signal.throwIfAborted()
  const transport = sessionTransport
  if (!session || !transport) throw new Error('Join the room first.')
  if (file.size > MAX_UPLOAD_SOURCE_BYTES) {
    throw new Error(`${file.name} is ${formatBytes(file.size)}; a room sends up to ${formatBytes(MAX_UPLOAD_SOURCE_BYTES)}.`)
  }
  if (file.size === 0) throw new Error(`${file.name} is empty.`)
  if (!server) {
    throw new Error('Name a Blossom server to put files on, then drop the file again.')
  }
  const origin = normaliseBlossomServer(server)
  const deviceSk = deviceKey()

  dropProgress(draft, 'Encrypting', file)
  // Let the line above paint before the main thread is busy sealing.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const source = new Uint8Array(await file.arrayBuffer())
  let sealed: EncryptedEnvelope
  try {
    signal.throwIfAborted()
    sealed = encryptEnvelope(source, { name: file.name, type: file.type })
  } finally {
    source.fill(0)
  }

  signal.throwIfAborted()
  dropProgress(draft, `Uploading to ${new URL(origin).hostname}:`, file)
  const descriptor = await uploadEnvelope(origin, sealed.envelope, { sign: (t) => finalizeEvent(t, deviceSk), signal })

  signal.throwIfAborted()
  dropProgress(draft, 'Announcing', file)
  const event = finalizeEvent(buildFileEvent(descriptor), deviceSk)
  await transport.publish(event)

  signal.throwIfAborted()
  draft.attachments.push({
    event: event.id,
    url: descriptor.url,
    sha256: descriptor.sha256,
    key: sealed.key,
    name: sealed.name,
    type: sealed.type,
    size: sealed.envelope.length,
  })
  draft.status = ''
  draftChanged(draft)
}

/** A conversation has one file operation at a time, covering its whole
 * batch. Switching conversations does not change that operation's owner. */
async function fileWork(draft: ConversationDraft, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (draft.job || !channelAvailable(draft.channel) || (draft.channel !== undefined && WRITTEN_BY_AGENTS.includes(draft.channel))) return
  const job = new AbortController()
  draft.job = job
  draft.panelOpen = true
  draftChanged(draft)
  // A relay publish has no abort API. Release the editor immediately while
  // the operation's signal checks keep any late result out of this draft.
  let onAbort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(job.signal.reason)
    job.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([work(job.signal), cancelled])
    if (draft.job !== job) return
    draft.status = ''
    draft.panelOpen = false
  } catch (error) {
    if (draft.job !== job) return
    draft.status = job.signal.aborted
      ? 'Stopped adding files. Completed files stay in this draft. The store may already hold encrypted bytes; nothing was sent to the conversation.'
      : describeError(error)
  } finally {
    job.signal.removeEventListener('abort', onAbort)
    if (draft.job === job) {
      draft.job = undefined
      draftChanged(draft)
    }
  }
}

/** Files from a drop or the file input, one after another, stopping at the
 *  first that fails so the reason is the last thing on the line. */
async function shareDroppedFiles(files: FileList | File[] | null): Promise<void> {
  const draft = captureDraft()
  const list = Array.from(files ?? [])
  if (!list.length) return
  const server = blossomServer()
  await fileWork(draft, async signal => {
    for (const file of list) {
      signal.throwIfAborted()
      if (draft.attachments.length >= MAX_CHAT_ATTACHMENTS) {
        throw new Error(`A message carries at most ${MAX_CHAT_ATTACHMENTS} files.`)
      }
      await shareDroppedFile(file, draft, signal, server)
    }
  })
}

;($('attachServer') as HTMLInputElement).value = blossomServer()
$('attachServer').addEventListener('change', () => {
  const input = $('attachServer') as HTMLInputElement
  const draft = captureDraft()
  try {
    storeBlossomServer(input.value)
    input.value = blossomServer()
    draft.status = ''
  } catch (err) {
    draft.status = describeError(err)
  }
  draftChanged(draft)
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
  const draft = captureDraft()
  draft.panelOpen = !draft.panelOpen
  draftChanged(draft)
  // The picker is the first thing in the panel and takes focus. Not
  // opened programmatically: a native chooser opened from script blocks
  // the page in some browsers, and cannot be dismissed by the app.
  if (draft.panelOpen) $('attachFile').focus()
})
$('attachCancel').addEventListener('click', () => {
  const draft = captureDraft()
  draft.panelOpen = false
  draftChanged(draft)
  $('attachToggle').focus()
})
$('attachAdd').addEventListener('click', async () => {
  const draft = captureDraft()
  const key = draft.key
  const sourceEvent = draft.event
  await fileWork(draft, async signal => {
    if (draft.attachments.length >= MAX_CHAT_ATTACHMENTS) throw new Error(`A message carries at most ${MAX_CHAT_ATTACHMENTS} files.`)
    draft.status = 'Checking…'
    draftChanged(draft)
    const keyHex = parseRecoveryKey(key)
    const event = await resolveFileEvent(sourceEvent, signal)
    signal.throwIfAborted()
    draft.attachments.push(shareFromEvent(event, keyHex))
    draft.key = draft.event = ''
    if (draft === drafts.get(currentChannel)) {
      ;($('attachKey') as HTMLInputElement).value = ''
      ;($('attachEvent') as HTMLInputElement).value = ''
    }
  })
})

for (const id of ['attachEvent', 'attachKey']) {
  $(id).addEventListener('input', () => {
    captureDraft()
    renderDraftBadges()
  })
}
$('cancelFileWork').addEventListener('click', () => drafts.get(currentChannel).job?.abort())
$('discardDraft').addEventListener('click', async () => {
  const draft = captureDraft()
  if (!draftHasWork(draft) || !await confirmRoomAction({ title: 'Discard this draft?', message: 'Your unsent text and files will be removed from this conversation. Files still being added will stop. Uploaded encrypted files are not deleted from their store.', confirmLabel: 'Discard draft', danger: true })) return
  drafts.discard(draft)
  restoreDraft()
  if (!channelAvailable(currentChannel)) selectChannel(undefined)
  else renderChannels()
})

;($('chatInput') as HTMLTextAreaElement).maxLength = MAX_CHAT_TEXT_LENGTH

// The effect controls start where the constants say they start, rather than
// where index.html happens to say they do: BLUR_ON_BY_DEFAULT is a product
// decision and it is meant to be one line to change.
;($('blurStrength') as HTMLInputElement).value = String(Math.round(DEFAULT_BLUR_STRENGTH * 100))
markSegmented('effectModes', 'mode', BLUR_ON_BY_DEFAULT ? 'blur' : 'off')
markSegmented('voicePresets', 'preset', DEFAULT_VOICE_PRESET)
$('effectMode').textContent = BLUR_ON_BY_DEFAULT ? 'blur' : 'off'
$('voiceMode').textContent = DEFAULT_VOICE_PRESET

// What kind of visit this is, said before the relays are asked.
//
// The page used to paint the setup furniture first - a name box, "Start a
// room", a place to paste a link - because that is what index.html said,
// and only replace it with the invitation screen once the admission had
// come back over a relay. On a cold arrival that is seconds of being shown
// a console for making a room you have never heard of, followed by the page
// changing under you.
//
// Once the app loads, select its door before waiting for admission. The
// dashboard stays hidden for an invitation, including one that cannot open.
if (location.hash.length > 1) {
  $('identity').hidden = false
  $('arrivalTitle').textContent = 'Opening your invite link'
  const lead = $('arrivalLead')
  lead.textContent = 'Opening the link somebody sent you.'
  lead.hidden = false
}

const pendingRoomSwitch = (() => {
  try {
    const raw = sessionStorage.getItem(ROOM_SWITCH_KEY)
    sessionStorage.removeItem(ROOM_SWITCH_KEY)
    return raw
  } catch { return null }
})()
const roomArrival = roomFromLocation()
roomArrival
  .then((found) => {
    if (!found) {
      // No link: the front page, with the rooms this device has been in.
      $('setup').hidden = false
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
  .catch(showArrivalFailure)

function showArrivalFailure(err: unknown): void {
  const reason = describeError(err)
  let valid = false
  try { parseRoomLink(location.href); valid = true } catch { /* Incomplete or malformed invitation. */ }
  const retired = reason.includes('retired')
  const persistent = valid && parseRoomLink(location.href).invitation?.persistent
  $('arrivalTitle').textContent = retired ? 'This invite link is no longer valid' : valid ? persistent ? 'The invite link could not be loaded' : 'The room has not answered' : 'This invite link is incomplete'
  $('arrivalLead').textContent = retired
    ? 'Ask somebody in the room for its current invite link.'
    : valid
      ? persistent
        ? 'Check your connection and try again. If it still cannot be found, ask for a current invite link.'
        : 'Nobody let you in. Somebody in the room has to be online and accept you: ask them, or try again when they are around. A room can also be kept open for anyone with the link (Room details, Keep this room open).'
      : 'Copy the whole invite link, including everything after #, then open it again.'
  $('arrivalLead').hidden = false
  $('joinRoomForm').hidden = true
  $('identityMore').hidden = true
  $('arrivalActions').hidden = false
  $('retryArrival').hidden = !valid || retired
  setStatus('')
}


// Rewrite what is in storage with what a reader would actually see, so a
// name that arrived there by some other route does not sit in raw form.
storeName(typedName)
renderIdentity()

// A signer paired on an earlier visit reconnects itself. Deliberately not
// awaited before the page is usable: a bunker over a relay can take seconds.
// Joining waits for it so the room uses the same identity the account UI
// shows. renderIdentity() runs again when it lands.
/**
 * `restoreSession`, with a moment's grace for an extension.
 *
 * An extension's content script lands after this module runs, so a sign-in
 * stored as "extension" was restored while `window.nostr` did not exist
 * yet, which signet-login reads as the extension having been uninstalled:
 * it hands back an identity that can prove who you are and sign nothing,
 * and the door said "Reconnect Nostr account" to a person whose extension
 * was right there. Wait for it, briefly, and restore again.
 */
async function restoreSessionWithExtensionGrace(): Promise<SignetSession | null> {
  const session = await restoreSession()
  if (session?.signer.capabilities.canSignEvents) return session
  let storedMethod: string | null = null
  try { storedMethod = localStorage.getItem('signet:login.method') } catch { /* no storage, nothing stored */ }
  if (storedMethod !== 'nip07') return session
  for (let waited = 0; waited < 3000 && !extensionSignerPresent(); waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!extensionSignerPresent()) return session
  return restoreSession()
}

const identityReady = restoreSessionWithExtensionGrace()
  .then((session) => {
    if (identityGeneration !== 0) return
    if (!session?.signer.capabilities.canSignEvents) {
      if (!location.hash && new URL(location.href).searchParams.get('signin') === 'nostr') {
        history.replaceState(null, '', joinLinkBase())
        return signInWithNostr()
      }
      return
    }
    nostrSession = session
    rememberAccount(session.pubkey)
    startRoomBookmarks(session)
    profiles.want([session.pubkey])
    renderIdentity()
    renderNudgeChoice()
  })
  .catch(() => {
    // No stored session, or a signer that is not answering today. Either
    // way this page still works: type a name and join.
  })
  .finally(() => {
    identityRestoring = false
    renderIdentity()
    if (rememberAfterRestore) rememberCurrentRoom()
  })

// Only an explicit switch or safe update in this tab skips the door. A normal invitation
// never auto-joins, and a failed/different Nostr restore never joins as a guest.
Promise.all([roomArrival, identityReady]).then(([found]) => {
  const raw = pendingRoomSwitch
  if (!raw || !found || session || ($('join') as HTMLButtonElement).disabled) return
  const intent = JSON.parse(raw) as { hash?: string; account?: string | null; at?: number }
  const age = Date.now() - (intent.at ?? 0)
  if (intent.hash !== location.hash || age < 0 || age > 120_000) return
  if (intent.account !== (nostrSession?.pubkey ?? null)) {
    setStatus('Check your sign-in before entering: the previous account is not available.')
    return
  }
  return startSession()
}).catch(() => { /* Admission/sign-in failures leave the normal door available. */ })

// The pubkey we would join as, so the identity line is right before the
// first room is ever opened.
const known = currentParticipant()
if (known) profiles.want([known])
