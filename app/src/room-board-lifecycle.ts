import type {SignetSession} from 'signet-login'
import type {RoomSession} from '../../src/session.js'
import type {RelayTransport} from '../../src/relay-pool.js'

/** A returned signer is privately owned until adoption. Join its close on
 * adoption failure, without clearing a newer account's global SDK state. */
export async function closeCataloguesBeforeAccountAdoption(account:SignetSession,closeCatalogues:()=>Promise<void>,current:()=>SignetSession|undefined):Promise<void> {
  try{await closeCatalogues()}catch(error){
    if(current()!==account){try{await account.signer.close()}catch(closing){throw new AggregateError([error,closing],'The account could not finish closing.')}}
    throw error
  }
}
/** Revoke selectors synchronously, preserving the captured original resources
 * until catalogue join succeeds. Failed join never authorises their teardown. */
export async function closeFailedRoomWithCatalogues(room:Pick<RoomSession,'leave'>|undefined,transport:Pick<RelayTransport,'close'>|undefined,
  closeCatalogues:()=>Promise<void>,revokeSelection:()=>void):Promise<void> {
  let joined:Promise<void>
  try{joined=closeCatalogues()}catch(error){revokeSelection();throw error}
  revokeSelection();await joined
  try{await room?.leave()}finally{transport?.close()}
}
