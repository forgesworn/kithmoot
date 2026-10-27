import type { BoxAnswer } from './mls-box-client.js'
import type { VaultRefusal } from './mls-vault.js'

export type MlsNodeAuthentication = { state: 'unavailable' | 'malformed' } |
  { state: 'not-signed'; refusal: VaultRefusal } | { state: 'refused'; status: number; code: string | null }
/** Node availability and local signing refusal are separate from enrolment.
 * Only fixed advice and validated client status fields enter the UI result. */
export function nodeAuthenticationHeld(answer: Exclude<BoxAnswer<{ installation: string }>, { state: 'ok' }>):
  { state: 'held'; reason: string; nodeAuthentication: MlsNodeAuthentication } {
  switch (answer.state) {
    case 'unavailable': return { state: 'held', reason: 'The selected Bothy could not be reached or its authentication did not finish. Check its connection and retry after the current operation has settled.', nodeAuthentication: { state: answer.state } }
    case 'malformed': return { state: 'held', reason: 'The selected Bothy returned an unsupported MLS capability reply. Check its supported version before creating a room.', nodeAuthentication: { state: answer.state } }
    case 'refused': return { state: 'held', reason: 'The selected Bothy refused authenticated MLS access. Review the node permission with its keeper before creating a room.', nodeAuthentication: { state: answer.state, status: answer.status, code: answer.code } }
    case 'not-signed': return { state: 'held', reason: answer.reason === 'denied'
      ? 'The selected Bothy authentication permission was not approved. Review the exact node and device permission before creating a room.'
      : 'The protected signing state could not authorise this Bothy authentication request. Reopen witness settings and check its current state before creating a room.', nodeAuthentication: { state: answer.state, refusal: answer.reason } }
  }
}
