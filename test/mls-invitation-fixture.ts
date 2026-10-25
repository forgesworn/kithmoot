/** Real browser invitation ceremony fixture. Only root provision replies and
 * authenticated witness/node transport are synthetic. No room, session, vault,
 * coordinator, custody or engine operation is replaced. Disposable fixture keys
 * remain in this module's closure and are never returned or logged. */
import { BrowserMlsPersonaStore, LockedPersonaStore } from '../app/src/mls-persona-store.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'
import { CoordinatedMlsVault } from '../app/src/mls-coordinated-vault.js'
import { BrowserMlsRoomOperations, type MlsRoomContext } from '../app/src/mls-room-operations.js'
import { BrowserMlsBoxClient } from '../app/src/mls-box-client.js'
import { RendezvousVault, BrowserRendezvousVaultStorage, type RendezvousReceipt } from '../app/src/rendezvous-vault.js'
import { withMlsRendezvous, type MlsRendezvousCustody } from '../app/src/mls-rendezvous-custody.js'
import { readInvitationRegistrationRequest } from '../app/src/mls-invitation-package.js'
import { BrowserBarkRendezvous, captureBarkRendezvous, barkRendezvousFor, publicRendezvousDeviceCurrent } from '../app/src/mls-bark-rendezvous.js'
import { BrowserMlsRoomForeground } from '../app/src/mls-room-foreground.js'
import { BrowserMlsRoomCreateCustody } from '../app/src/mls-room-create-rendezvous.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import { readMlsRoom } from '../app/src/mls-room-store.js'
import { personaWriter, pairedWitnessIdentity } from '../app/src/mls-writer-identity.js'
import type { WitnessAnswer } from '../app/src/mls-witness-link.js'
import type { LinkRequest } from '../app/src/browser-link-types.js'
import { pairingFixture } from './mls-pairing-fixture.js'
import { getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { base32, base64urlnopad } from '@scure/base'

export type InvitationActorName = 'alice' | 'bob' | 'carol'
type Outbound = { recordId: Uint8Array; mailbox: Uint8Array; envelope: Uint8Array; destination: { type: string; attempt?: number; [key: string]: unknown } }
type WitnessState = { sequence: bigint; digest: Uint8Array; offline: boolean; loseAdvance: boolean; advances: number; reads: number }
interface Actor {
  name: InvitationActorName; persona: string; device: string; rendezvous: string; receipt: RendezvousReceipt;
  session: string; generation: number; active: boolean; database: string; rzDatabase: string;
  store: BrowserMlsPersonaStore; host: BrowserPersonaCoordinator; vault: CoordinatedMlsVault;
  rooms: BrowserMlsRoomOperations; rzVault: RendezvousVault; witness: WitnessState;
}
const encoder = new TextEncoder()
const utf8 = (s: string) => encoder.encode(s)

/** Read the actual canonical witness request instead of assuming one-byte
 * sequence numbers or fixed offsets once a journey passes sequence 23. */
function witnessRequest(bytes: Uint8Array): Map<bigint, bigint | Uint8Array> {
  let at = 0
  const head = (major: number): bigint => {
    const first = bytes[at++]; if (first === undefined || first >>> 5 !== major) throw new Error('Unexpected fixture witness request')
    const small = first & 31
    if (small < 24) return BigInt(small)
    const width = ({ 24: 1, 25: 2, 26: 4, 27: 8 } as Record<number, number>)[small]
    if (!width || at + width > bytes.length) throw new Error('Truncated fixture witness request')
    let value = 0n; for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(bytes[at++])
    return value
  }
  const count = Number(head(5)), fields = new Map<bigint, bigint | Uint8Array>()
  if (count !== 3 && count !== 6) throw new Error('Unexpected fixture witness shape')
  for (let i = 0; i < count; i++) {
    const key = head(0), major = bytes[at] >>> 5
    if (major === 0) fields.set(key, head(0))
    else if (major === 2) {
      const size = Number(head(2)); if (size !== 32 || at + size > bytes.length) throw new Error('Invalid fixture witness field')
      fields.set(key, bytes.slice(at, at + size)); at += size
    } else throw new Error('Unexpected fixture witness value')
  }
  if (at !== bytes.length || fields.get(1n) !== 1n) throw new Error('Invalid fixture witness request version')
  return fields
}

export async function invitationFixture() {
  const instance = crypto.randomUUID(), names: InvitationActorName[] = ['alice', 'bob', 'carol']
  const actors = new Map<InvitationActorName, Actor>()
  let clock = Math.floor(Date.now() / 1000), messageOperation = 0
  const nodeKey = new Uint8Array(32).fill(76), witnessKey = new Uint8Array(32).fill(91)
  const box = bytesToHex(ed25519.getPublicKey(nodeKey)), installation = bytesToHex(sha256(utf8('invitation fixture installation')))
  const nodeRoute = pairingFixture(nodeKey).route, witnessRoute = pairingFixture(witnessKey).route
  const counters = { packages: 0, ordinaryDeposits: 0, invitationConsents: 0, leafConsents: 0, boxConsents: 0, packagesBy: [] as InvitationActorName[] }
  const actor = (name: InvitationActorName): Actor => { const value = actors.get(name); if (!value) throw new Error('Unknown fixture actor'); return value }
  const context = (a: Actor, current: () => boolean = () => a.active): MlsRoomContext => ({
    vault: a.vault.context('https://invitation-journey.kithmoot.test', a.persona), rendezvousKey: a.rendezvous,
    current, experimentalInvitation: true,
  })
  const consent = async (scope: { method?: string }) => { if (scope.method === 'signBoxRequestV1/1') counters.boxConsents++; else counters.leafConsents++; return 'approve' as const }
  const exchange = async (a: Actor, method: 'read' | 'advance', request: Uint8Array): Promise<WitnessAnswer> => {
    const state = a.witness
    if (state.offline) return { type: 'unavailable' }
    const fields = witnessRequest(request), subject = fields.get(2n) as Uint8Array
    let status = 0
    if (method === 'advance') {
      state.advances++
      const expected = fields.get(3n), previous = fields.get(4n) as Uint8Array
      if (expected === state.sequence && bytesToHex(previous) === bytesToHex(state.digest)) { state.sequence++; state.digest = (fields.get(5n) as Uint8Array).slice() }
      else status = 1
      if (state.loseAdvance) { state.loseAdvance = false; return { type: 'unavailable' } }
    } else state.reads++
    const signed = new Uint8Array(106), challenge = fields.get(method === 'read' ? 3n : 6n) as Uint8Array
    signed[0] = 1; signed[1] = status; signed.set(subject, 2)
    new DataView(signed.buffer).setBigUint64(34, state.sequence)
    signed.set(state.digest, 42); signed.set(challenge, 74)
    return { type: 'receipt', bytes: concatBytes(signed, ed25519.sign(sha256(concatBytes(utf8('VMLS/1 witness receipt'), signed)), witnessKey)) }
  }
  const reopen = (a: Actor) => {
    a.rooms?.invalidate(); a.host?.invalidate(a.persona)
    a.store = new BrowserMlsPersonaStore(a.database)
    a.host = new BrowserPersonaCoordinator(a.store, async () => ({ read: r => exchange(a, 'read', r), advance: r => exchange(a, 'advance', r), close: async () => {} }))
    a.vault = new CoordinatedMlsVault(a.host, { now: () => clock, generation: () => a.generation })
    a.rooms = new BrowserMlsRoomOperations(a.host, a.vault, () => clock)
    a.rzVault = new RendezvousVault(new BrowserRendezvousVaultStorage(a.rzDatabase))
  }
  const custody = <T>(a: Actor, work: (held: MlsRendezvousCustody) => Promise<T>): Promise<T> =>
    withMlsRendezvous(a.rzVault, a.receipt, () => clock, () => a.active, work)

  for (const [index, name] of names.entries()) {
    const identityKey = new Uint8Array(32).fill(42 + index), childKey = new Uint8Array(32).fill(52 + index), clientKey = new Uint8Array(32).fill(62 + index)
    const persona = getPublicKey(identityKey), rendezvous = getPublicKey(childKey), clientDevice = getPublicKey(clientKey)
    const a = { name, persona, rendezvous, device: '', session: '', generation: 0, active: true,
      database: `mls-invitation-${instance}-${name}`, rzDatabase: `mls-invitation-child-${instance}-${name}`,
      store: new BrowserMlsPersonaStore(`mls-invitation-${instance}-${name}`), witness: { sequence: 0n, digest: new Uint8Array(32), offline: false, loseAdvance: false, advances: 0, reads: 0 },
    } as Actor
    actors.set(name, a); reopen(a)
    const wasm = await loadMlsEngine(), subject = sha256(utf8(`invitation-journey:${instance}:${name}`))
    await a.store.withPersona(persona, async s => {
      const initial = await s.create(), witness = pairedWitnessIdentity(witnessRoute)
      const genesis = wasm.coordinatorGenesis(subject, hexToBytes(initial.data.installation), hexToBytes(witness), [])
      initial.data.coordinator = bytesToHex(genesis.state); initial.data.witnessRoute = witnessRoute
      initial.data.enrolment = { subject: bytesToHex(subject), writer: personaWriter(initial.data.writerSeed), witness, digest: bytesToHex(genesis.digest) }
      initial.marker = { ...initial.marker, state: 'genesis', subject: bytesToHex(subject), writer: initial.data.enrolment.writer, digest: bytesToHex(genesis.digest) }
      await s.write(initial.revision, initial.data, initial.marker); a.witness.digest = genesis.digest.slice()
    })
    const enrolled = await a.vault.enrol(context(a).vault, { pubkey: persona, signEvent: async e => finalizeEvent(e, identityKey) }, clock + 20 * 86400)
    if (!enrolled.ok) throw new Error(`Fixture enrolment refused: ${enrolled.refusal}`)
    a.device = enrolled.value.device
    const nonce = crypto.getRandomValues(new Uint8Array(16)), expires = clock + 600
    const fields = { v: 1, p: persona, d: clientDevice, rz: rendezvous, u: 'rendezvous', i: 1, n: base64urlnopad.encode(nonce), e: expires }
    const plain = JSON.stringify({ ...fields, k: base64urlnopad.encode(childKey) })
    const provision = JSON.stringify({ ...fields, c: encrypt(plain, getConversationKey(childKey, clientDevice)) })
    const installed = await a.rzVault.accept(provision, { identity: persona, device: clientDevice, nonce, now: clock }, { decrypt: async (peer, ciphertext) => decrypt(ciphertext, getConversationKey(clientKey, peer)) })
    if (!installed.ok) throw new Error(`Fixture child provision refused: ${installed.reason}`)
    a.receipt = installed.receipt
  }

  const registeredPackages = new Map<string, { mailbox: string; expires: number }>()
  let nodeReturnsRegistrationReceipt = true
  const packageClient = (a: Actor) => new BrowserMlsBoxClient({ request: async (request: LinkRequest) => {
    if (!request.path.startsWith('/vmls/v1/packages/')) { counters.ordinaryDeposits++; throw new Error('Unexpected ordinary mailbox transport') }
    const event = JSON.parse(atob(request.authorization.slice(6)))
    if (!verifyEvent(event) || event.pubkey !== a.device || a.name !== 'alice' || event.kind !== 27235 || request.method !== 'PUT' || !request.path.startsWith('/vmls/v1/packages/') ||
      JSON.stringify(event.tags) !== JSON.stringify([
        ['u', `http://${base32.encode(hexToBytes(box)).replace(/=+$/, '').toLowerCase()}${request.path}`],
        ['method', 'PUT'], ['payload', bytesToHex(sha256(request.body))],
      ])) throw new Error('Unauthenticated fixture package registration')
    const body = JSON.parse(new TextDecoder().decode(request.body)), packageId = request.path.split('/').at(-1)!
    if (body.v !== 1 || !/^[0-9a-f]{64}$/.test(packageId) || !/^[0-9a-f]{64}$/.test(body.welcome_mailbox) || !Number.isSafeInteger(body.expires_at) || body.expires_at <= clock || body.expires_at > clock + 7 * 86400 ||
        body.registration_receipt !== undefined && body.registration_receipt !== true || Object.keys(body).sort().join(',') !== ['ciphertext', 'expires_at', ...(body.registration_receipt === true ? ['registration_receipt'] : []), 'v', 'welcome_mailbox'].sort().join(',')) throw new Error('Invalid synthetic node package request')
    const previous = registeredPackages.get(packageId)
    if (previous && (previous.mailbox !== body.welcome_mailbox || previous.expires !== body.expires_at)) throw new Error('Conflicting retained synthetic package')
    registeredPackages.set(packageId, { mailbox: body.welcome_mailbox, expires: body.expires_at })
    counters.packages++; counters.packagesBy.push(a.name)
    const signed = new Uint8Array(137); signed[0] = 1; signed.set(hexToBytes(box), 1); signed.set(hexToBytes(installation), 33); signed.set(hexToBytes(packageId), 65); signed.set(hexToBytes(body.welcome_mailbox), 97)
    new DataView(signed.buffer).setBigUint64(129, BigInt(body.expires_at))
    const receipt = concatBytes(signed, ed25519.sign(sha256(concatBytes(utf8('Vennel/invitation/1 package registration\0'), signed)), nodeKey))
    return { status: previous ? 200 : 201, body: utf8(JSON.stringify({ v: 1, code: previous ? 'unchanged' : 'registered', server_time: clock,
      ...(body.registration_receipt === true && nodeReturnsRegistrationReceipt ? { registrationReceipt: bytesToHex(receipt) } : {}) })), witnessRefused: false,
      path: { status: 'up' as const, relay: null, direct: null, cause: '' } }
  } }, { routeId: nodeRoute.routeId, card: hexToBytes(nodeRoute.card), pairedRouteSecret: hexToBytes(nodeRoute.pairedRouteSecret),
    cardSerial: BigInt(nodeRoute.cardSerial), cardVerifiedAt: BigInt(nodeRoute.cardVerifiedAt) }, box, a.vault, context(a).vault, consent, () => a.active)
  const slotReceipt = (out: Outbound) => {
    if (out.destination.type !== 'CommitSlot' || typeof out.destination.attempt !== 'number') return undefined
    const attempt = new Uint8Array(4); new DataView(attempt.buffer).setUint32(0, out.destination.attempt)
    const hash = sha256(out.envelope), pin = hexToBytes(installation)
    const digest = sha256(concatBytes(utf8('VMLS/1 slot receipt'), pin, out.mailbox, attempt, hash))
    return concatBytes(Uint8Array.of(1), hexToBytes(box), pin, out.mailbox, attempt, hash, ed25519.sign(digest, nodeKey))
  }
  const process = (name: InvitationActorName, out: Outbound) => {
    const a = actor(name)
    return a.rooms.process(context(a), a.session, { homeBox: box, installation, mailbox: out.mailbox, envelope: out.envelope, receipt: slotReceipt(out) })
  }
  const responseAction = (name: InvitationActorName, authorization: Uint8Array, envelope: Uint8Array, action: { type: 'record' } | { type: 'registration-request' } | { type: 'add'; receipt: Uint8Array }) => {
    const a = actor(name)
    return custody(a, held => a.rooms.invitationResponseAction(context(a, held.current), a.session, authorization, envelope, held,
      action.type === 'record' ? { type: 'record' } : action.type === 'registration-request' ? { type: 'registration-request' } : { type: 'add', receipt: action.receipt }))
  }
  const keeperRegister = async (request: Uint8Array) => {
    const parsed = readInvitationRegistrationRequest(request, clock)
    if (parsed.node !== box || parsed.installation !== installation) throw new Error('Fixture keeper independently selected a different paired node/installation')
    const keeper = actor('alice')
    // The member's rendezvous-custody confirmation has ended. Establish a
    // fresh actual keeper witness/device confirmation in its own scope before
    // asking the typed box signer; no child or member authority is borrowed.
    const credential = await keeper.vault.credential(context(keeper).vault)
    if (!credential.ok) throw new Error(`Independent keeper device confirmation refused: ${credential.refusal}`)
    const client = packageClient(keeper)
    try { return await client.registerInvitationPackageSettled(request, clock) }
    finally { client.invalidate(); await client.settled() }
  }
  const action = async (name: InvitationActorName, authorization: Uint8Array, envelope: Uint8Array, add: boolean) => {
    if (!add) return responseAction(name, authorization, envelope, { type: 'record' })
    const exported = await responseAction(name, authorization, envelope, { type: 'registration-request' })
    if (exported.state !== 'active') return exported
    const request = exported.value.registrationRequest
    if (!request) throw new Error('No actual private registration request exported')
    try {
      const registered = await keeperRegister(request)
      if (registered.state !== 'ok') return { state: 'refused' as const, reason: `node-registration-receipt-required:${registered.state}:${'reason' in registered ? registered.reason : 'code' in registered ? registered.code : ''}` }
      try { return await responseAction(name, authorization, envelope, { type: 'add', receipt: registered.value.registrationReceipt }) }
      finally { registered.value.registrationReceipt.fill(0) }
    } finally { request.fill(0) }
  }

  return {
    box, installation,
    /** Typed extension transport is synthetic; its child ciphertext is real
     * NIP44 from the CHILD scalar to the actual witnessed app-owned target.
     * Neither the target secret nor any fixture secret leaves this closure. */
    async barkProvision(mode = 'success') {
      const a = actor('bob'), previous = (window as any).nostr
      const source = new RendezvousVault(new BrowserRendezvousVaultStorage())
      const child = new Uint8Array(32).fill(72), rz = getPublicKey(child)
      let calls = 0, requestKeys = '', target = '', approvedIndex = 0
      const provider = { heartwood: { provisionRendezvousV1: async (request: any) => {
        calls++; target = request.targetDevice; approvedIndex = request.index
        requestKeys = Object.keys(request).sort().join(',')
        if (mode === 'provider-change') (window as any).nostr = { ...provider }
        if (mode === 'callable-change') provider.heartwood.provisionRendezvousV1 = async () => ''
        if (mode === 'account-change') a.active = false
        if (mode === 'expiry') clock += 481
        const fields = { v: 1, p: request.expectedPersona, d: request.targetDevice, rz,
          u: 'rendezvous', i: request.index, n: request.nonce, e: request.expiresAt }
        const inner = { ...fields, ...(mode === 'inner-index' ? { i: request.index + 1 } : {}), k: base64urlnopad.encode(child) }
        const outer = { ...fields, ...(mode === 'nonce' ? { n: base64urlnopad.encode(new Uint8Array(16)) } : {}),
          c: encrypt(JSON.stringify(inner), getConversationKey(child, request.targetDevice)) }
        return JSON.stringify(outer)
      } } }
      ;(window as any).nostr = provider
      const signer = { method: 'nip07', pubkey: a.persona }
      captureBarkRendezvous(signer, a.persona, provider)
      const binding = barkRendezvousFor(signer)!
      const ctx = { persona: a.persona, provider: binding, current: () => a.active }
      let bark = new BrowserBarkRendezvous(a.host, source, () => clock)
      let error = '', publicKeys = '', forgedCurrent = false, installed = false, restartSame = false, roomState = '', custodyCurrent = false
      try {
        if (mode === 'offline') a.witness.offline = true
        if (mode === 'lost-target-ack') a.witness.loseAdvance = true
        let device
        try { device = await bark.publicDevice(ctx) } catch (e) { error = String(e) }
        if (mode === 'lost-target-ack') {
          if (device || calls) throw new Error('Target exposed before its witness acknowledgement')
          reopen(a); bark = new BrowserBarkRendezvous(a.host, source, () => clock)
          device = await bark.publicDevice(ctx)
        }
        if (device) {
          publicKeys = Object.keys(device).sort().join(',')
          forgedCurrent = publicRendezvousDeviceCurrent({ ...device }, a.persona)
          try {
            const receipt = await bark.provision(ctx, 7, clock + 480)
            const saved = await source.active(a.persona, device.device)
            try { installed = !!saved && saved.receipt.rendezvousPubkey === rz && receipt.rendezvousPubkey === rz }
            finally { saved?.wipe() }
            reopen(a); bark = new BrowserBarkRendezvous(a.host, source, () => clock)
            const again = await bark.publicDevice(ctx); restartSame = again.device === device.device
            const foreground = new BrowserMlsRoomForeground()
            const custody = new BrowserMlsRoomCreateCustody(foreground, () => undefined, () => bark.publicDevice(ctx))
            const result = await foreground.run(a.persona, () => a.active, scope => custody.withInvitation(scope, async held => {
              custodyCurrent = held.current() && held.receipt.rendezvousPubkey === rz
              return a.rooms.create({ ...context(a, held.current), rendezvousKey: rz },
                { name: 'Bark protected handoff', homeBox: box, installation, expiresAt: clock + 86400, experimentalInvitation: true }, consent)
            }))
            roomState = result.state === 'done' ? result.value.state : result.state
          } catch (e) { error = String(e) }
          const saved = await source.active(a.persona, device.device)
          try { installed = !!saved && saved.receipt.rendezvousPubkey === rz } finally { saved?.wipe() }
        }
        return { calls, requestKeys, publicKeys, forgedCurrent, installed, restartSame, roomState, custodyCurrent, targetBound: !!target && target.length === 64, approvedIndex, error }
      } finally { (window as any).nostr = previous; child.fill(0); await source.clear(a.persona) }
    },
    metadata(name: InvitationActorName) { const a = actor(name); return { persona: a.persona, device: a.device, rendezvous: a.rendezvous, session: a.session } },
    async create(name: InvitationActorName, experimental = true) {
      const a = actor(name)
      const result = await custody(a, held => a.rooms.create(context(a, held.current), { name: `${name} invitation room`, homeBox: box, installation, expiresAt: clock + 86400, experimentalInvitation: experimental }, consent))
      if (result.state === 'active') a.session = result.value.session
      return result
    },
    issue(from: InvitationActorName, to: InvitationActorName, overrides: Record<string, unknown> = {}) {
      const a = actor(from), b = actor(to)
      return custody(a, held => a.rooms.issueInvitation(context(a, held.current), a.session,
        { persona: b.persona, device: b.device, rendezvous: b.rendezvous, leafHome: box, expiresAt: clock + 86400, ...overrides }, async () => { counters.invitationConsents++; return 'approve' }))
    },
    async accept(to: InvitationActorName, from: InvitationActorName, authorization: Uint8Array, overrides: Record<string, unknown> = {}) {
      const a = actor(to), b = actor(from)
      const result = await custody(a, held => a.rooms.acceptInvitation(context(a, held.current),
        { name: `${to} accepted invitation`, homeBox: box, expectedInviterPersona: b.persona, authorization, ...overrides }, held, consent))
      if (result.state === 'active') a.session = result.value.session
      return result
    },
    /** Lose the witness reply for the actual initial session-adoption
     * candidate, after its outer seal is durable. Earlier leaf-sign journal
     * writes contain no new staged session and cannot trigger this hook. */
    async loseAdoptionReply(to: InvitationActorName, from: InvitationActorName, authorization: Uint8Array) {
      const a = actor(to), b = actor(from)
      if (a.witness.loseAdvance) throw new Error('The fixture already has a pending witness reply loss')
      const before = await a.store.withPersona(a.persona, async store => {
        const file = await store.read()
        if (!file || file.data.staged) throw new Error('Adoption injection requires an unstaged protected installation')
        return { installation: file.data.installation, sessions: new Set(file.data.active.sessions.map(row => row.id)) }
      })
      const original = LockedPersonaStore.prototype.write
      let injected = false, candidateSessionId: string | null = null, candidateGeneration: string | null = null, witnessBefore: string | null = null
      const hooked: typeof original = async function (this: LockedPersonaStore, ...args: Parameters<typeof original>) {
        const written = await original.apply(this, args)
        if (!injected && written.data.persona === a.persona && written.data.installation === before.installation && written.data.staged) {
          const added = written.data.staged.sessions.filter(row => !before.sessions.has(row.id))
          if (added.length) {
            if (added.length !== 1 || written.data.active.sessions.some(row => row.id === added[0].id)) throw new Error('Ambiguous initial adoption candidate')
            injected = true; candidateSessionId = added[0].id; candidateGeneration = added[0].generation
            witnessBefore = String(a.witness.sequence)
            a.witness.loseAdvance = true
          }
        }
        return written
      }
      LockedPersonaStore.prototype.write = hooked
      try {
        const result = await custody(a, held => a.rooms.acceptInvitation(context(a, held.current),
          { name: `${to} accepted invitation`, homeBox: box, expectedInviterPersona: b.persona, authorization }, held, consent))
        if (result.state === 'active') a.session = result.value.session
        return { result, injected, candidateSessionId, candidateGeneration, witnessBefore, witnessAfter: String(a.witness.sequence),
          witnessAdvanced: witnessBefore !== null && a.witness.sequence > BigInt(witnessBefore) }
      } finally {
        LockedPersonaStore.prototype.write = original
        a.witness.loseAdvance = false
      }
    },
    response(name: InvitationActorName) { const a = actor(name); return a.rooms.invitationResponse(context(a), a.session) },
    record(name: InvitationActorName, authorization: Uint8Array, envelope: Uint8Array) { return action(name, authorization, envelope, false) },
    add(name: InvitationActorName, authorization: Uint8Array, envelope: Uint8Array) { return action(name, authorization, envelope, true) },
    registrationRequest(name: InvitationActorName, authorization: Uint8Array, envelope: Uint8Array) { return responseAction(name, authorization, envelope, { type: 'registration-request' }) },
    keeperRegister,
    addReceipt(name: InvitationActorName, authorization: Uint8Array, envelope: Uint8Array, receipt: Uint8Array) { return responseAction(name, authorization, envelope, { type: 'add', receipt }) },
    setNodeRegistrationReceipt(enabled: boolean) { nodeReturnsRegistrationReceipt = enabled },
    process,
    async commit(owner: InvitationActorName, effect: { outbound: Outbound[] }, observers: InvitationActorName[] = []) {
      const slot = effect.outbound.find(out => out.destination.type === 'CommitSlot')
      if (!slot) throw new Error('No actual commit slot in operation result')
      const applied = await process(owner, slot)
      const others = await Promise.all(observers.map(name => process(name, slot)))
      return { owner: applied, observers: others, welcomes: applied.state === 'active' ? applied.value.outbound.filter((out: Outbound) => out.destination.type === 'Welcome') : [] }
    },
    update(name: InvitationActorName) { const a = actor(name); return a.rooms.update(context(a), a.session, clock + 86400, consent) },
    send(name: InvitationActorName, text: string) { const a = actor(name); return a.rooms.send(context(a), a.session, (++messageOperation).toString(16).padStart(64, '0'), utf8(text)) },
    read(name: InvitationActorName) { const a = actor(name); return a.rooms.read(context(a), a.session) },
    members(name: InvitationActorName) { const a = actor(name); return a.rooms.members(context(a), a.session) },
    restart(name: InvitationActorName) { reopen(actor(name)) },
    remove(name: InvitationActorName, leafId: string) { const a = actor(name); return a.rooms.removeInvitationMember(context(a), a.session, leafId) },
    saved(name: InvitationActorName) { const a = actor(name); return a.host.transact(a.persona, tx => readMlsRoom(tx, a.session), () => a.active) },
    async summary(name: InvitationActorName) {
      const a = actor(name)
      // Enumerate protected manifest candidates, including a durable staged
      // adoption whose reply was lost. The reconciled reader below decides
      // which ids actually have authoritative session marks; room-index absence
      // must never hide an orphan session from this test assertion.
      const candidates = await a.store.withPersona(a.persona, async store => {
        const file = await store.read()
        return [...new Set([...(file?.data.active.sessions ?? []), ...(file?.data.staged?.sessions ?? [])].map(row => row.id))]
      })
      return a.host.transact(a.persona, async tx => {
        const sessions = []
        for (const id of candidates) {
          const entry = await tx.readSession(id)
          try { if (entry) sessions.push({ id, generation: String(entry.generation) }) }
          finally { entry?.plaintext.fill(0) }
        }
        const saved = a.session ? await tx.readSession(a.session) : undefined
        const magic = utf8('VMLS/1 snapshot')
        try { return { session: a.session, sessionCount: sessions.length, sessions, generation: saved ? String(saved.generation) : null,
          snapshotVersion: saved && saved.plaintext.length > magic.length && magic.every((byte, i) => saved.plaintext[i] === byte) ? saved.plaintext[magic.length] : null } }
        finally { saved?.plaintext.fill(0) }
      }, () => a.active)
    },
    advance(seconds: number) { if (!Number.isSafeInteger(seconds)) throw new Error('Invalid fixture clock'); clock += seconds },
    setWitness(name: InvitationActorName, mode: Partial<Pick<WitnessState, 'offline' | 'loseAdvance'>>) { Object.assign(actor(name).witness, mode) },
    witness(name: InvitationActorName) { const w = actor(name).witness; return { sequence: String(w.sequence), advances: w.advances, reads: w.reads, offline: w.offline } },
    stats() { return { ...counters, packagesBy: [...counters.packagesBy] } },
    invalidate(name: InvitationActorName) { const a = actor(name); a.active = false; a.generation++; a.rooms.invalidate(); a.host.invalidate(a.persona) },
    clearRendezvous(name: InvitationActorName) { const a = actor(name); return a.rzVault.clear(a.persona) },
  }
}
