import type { SignetSession } from 'signet-login'

export interface GirnelBoard { boardId: string; name: string; cardId?: string }
export interface GirnelHost {
  access: {
    restore(): Promise<{ state: 'session'; session: SignetSession; readiness: { ready: true; signer: SignetSession['signer']; person: string } }>
    login(): Promise<{ state: 'session'; session: SignetSession; readiness: { ready: true; signer: SignetSession['signer']; person: string } }>
    logout(): Promise<void>
  }
  signal: AbortSignal
  onBoard(board: GirnelBoard | null): void
  onBoards(boards: Array<{ boardId: string; name: string; ended: boolean }>): void
  roomInvitation?(): string | undefined
  roomShare?(): {name: string; publish(board: {boardId: string; name: string}, invitation: string): Promise<void>} | undefined
  onRoomShareReady?(share: (() => void) | null): void
  discuss?(boardId: string, card: { id: string; title: string; description?: string }): void
}
export type GirnelWindow = Window & { girnelEmbed?: { start(host: GirnelHost): Promise<void>; prepareMove(): Promise<void>; hasPendingEdits(): boolean } }
export type GirnelBorrowedAccess = GirnelHost['access'] & { revoke(): void; close(): Promise<void> }
function detachedAuth<T>(value: T): T {
  let nodes = 0
  const clone = (v: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 32) throw new Error('Invalid host authentication data')
    if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v
    if (!v || typeof v !== 'object' || ![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v))) throw new Error('Invalid host authentication data')
    const keys = Reflect.ownKeys(v), array = Array.isArray(v), fields: [string,unknown][] = []
    for (const key of keys) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(v,key)!
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor,'value')) throw new Error('Invalid host authentication data')
      fields.push([key,clone(descriptor.value,depth+1)])
    }
    if (array && (fields.length !== v.length || fields.some(([key],i) => key !== String(i)))) throw new Error('Invalid host authentication data')
    return Object.freeze(array ? fields.map(([,v])=>v) : Object.fromEntries(fields))
  }
  return clone(value,0) as T
}

/** Borrow only methods from the authenticated host session. Never pass through
 * SDK internals such as a bunker client key, and never close the host signer. */
export function girnelAccess(session: SignetSession, current: () => boolean, logout: () => void): GirnelBorrowedAccess {
  const original = session.signer, person = session.pubkey, method = session.method, expiry = session.expiresAt
  const nip44 = original.nip44
  const signEvent = original.signEvent, encrypt = nip44?.encrypt, decrypt = nip44?.decrypt, signerMethod = original.method
  const work = new Set<Promise<unknown>>()
  let closed = false
  const check = () => {
    const valid = !closed && current()
    if (closed || !valid || session.signer !== original || session.pubkey !== person || session.method !== method ||
        session.expiresAt !== expiry || original.nip44 !== nip44 || original.signEvent !== signEvent || original.method !== signerMethod ||
        nip44?.encrypt !== encrypt || nip44?.decrypt !== decrypt || session.pubkey !== session.signer.pubkey ||
        !/^[0-9a-f]{64}$/.test(session.pubkey) ||
        session.expiresAt !== undefined && (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now())) {
      throw new Error('Your KithMoot account changed or expired. Reopen Boards.')
    }
    if (!session.signer.capabilities.canSignEvents || !session.signer.capabilities.hasNip44 || !session.signer.nip44) {
      throw new Error('Boards needs your matching signer to sign and encrypt with NIP-44.')
    }
    return session.signer
  }
  const guarded = <T>(action: () => Promise<T>): Promise<T> => {
    // Register before invoking an unabortable provider, including reentrant
    // revoke/close from that provider. Closing joins its late settlement.
    const pending = Promise.resolve().then(async () => { check(); const value = await action(); check(); return value })
    work.add(pending); void pending.finally(() => work.delete(pending)).catch(() => {})
    return pending
  }
  const signer: SignetSession['signer'] = {
    pubkey: session.pubkey, method: session.method, capabilities: {...session.signer.capabilities},
    signEvent: event => guarded(async () => {
      const signed = await check().signEvent(event)
      if (signed.pubkey !== session.pubkey) throw new Error('The board signer returned another account')
      return signed
    }),
    nip44: {
      encrypt: (peer, text) => guarded(() => check().nip44!.encrypt(peer, text)),
      decrypt: (peer, text) => guarded(() => check().nip44!.decrypt(peer, text)),
    },
    close: async () => {},
  }
  const borrowed: SignetSession = {pubkey: session.pubkey, method: session.method, authEvent: detachedAuth(session.authEvent), signer,
    ...(session.expiresAt === undefined ? {} : {expiresAt: session.expiresAt}),
    ...(session.displayName === undefined ? {} : {displayName: session.displayName})}
  const obtain = () => guarded(async () => ({state: 'session' as const, session: borrowed,
    readiness: {ready: true as const, signer, person: session.pubkey}}))
  const revoke = () => {closed = true}
  const close = async () => {revoke(); await Promise.allSettled([...work])}
  return {restore: obtain, login: obtain, logout: async () => {revoke(); try {logout()} finally {await close()}}, revoke, close}
}
