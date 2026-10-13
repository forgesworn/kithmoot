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
  discuss?(boardId: string, card: { id: string; title: string; description?: string }): void
}
export type GirnelWindow = Window & { girnelEmbed?: { start(host: GirnelHost): Promise<void>; prepareMove(): Promise<void>; hasPendingEdits(): boolean } }

/** Borrow only methods from the authenticated host session. Never pass through
 * SDK internals such as a bunker client key, and never close the host signer. */
export function girnelAccess(session: SignetSession, current: () => boolean, logout: () => void): GirnelHost['access'] {
  const check = () => {
    if (!current() || session.pubkey !== session.signer.pubkey ||
        !/^[0-9a-f]{64}$/.test(session.pubkey) ||
        session.expiresAt !== undefined && (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now())) {
      throw new Error('Your KithMoot account changed or expired. Reopen Boards.')
    }
    if (!session.signer.capabilities.canSignEvents || !session.signer.capabilities.hasNip44 || !session.signer.nip44) {
      throw new Error('Boards needs your matching signer to sign and encrypt with NIP-44.')
    }
    return session.signer
  }
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => { check(); const value = await work(); check(); return value }
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
  const borrowed: SignetSession = {pubkey: session.pubkey, method: session.method, authEvent: session.authEvent, signer,
    ...(session.expiresAt === undefined ? {} : {expiresAt: session.expiresAt}),
    ...(session.displayName === undefined ? {} : {displayName: session.displayName})}
  const obtain = async () => {check(); return {state: 'session' as const, session: borrowed,
    readiness: {ready: true as const, signer, person: session.pubkey}}}
  return {restore: obtain, login: obtain, logout: async () => {logout()}}
}
