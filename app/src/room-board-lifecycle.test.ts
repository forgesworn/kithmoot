import {describe,it,expect,vi} from 'vitest'
import type {SignetSession} from 'signet-login'
import {closeCataloguesBeforeAccountAdoption,closeFailedRoomWithCatalogues} from './room-board-lifecycle.js'
describe('root catalogue ownership boundaries',()=>{
 it('synchronous catalogue-close failure still revokes selectors',async()=>{
  const leave=vi.fn(async()=>{}),close=vi.fn(),revoke=vi.fn()
  await expect(closeFailedRoomWithCatalogues({leave},{close},()=>{throw Error('sync hold')},revoke)).rejects.toThrow('sync hold')
  expect(revoke).toHaveBeenCalledTimes(1);expect(close).not.toHaveBeenCalled();expect(leave).not.toHaveBeenCalled()
 })
 it.each(['restore','picker'] as const)('%s adoption refusal joins the unadopted signer',async()=>{
  let release=()=>{},entered=()=>{};const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve)
  const close=vi.fn(async()=>{entered();await gate}),account={signer:{close}} as unknown as SignetSession;let receipt='pending'
  const pending=closeCataloguesBeforeAccountAdoption(account,async()=>{throw Error('catalogue hold')},()=>undefined).then(()=>receipt='adopted',e=>receipt=e.message)
  await ready;expect(receipt).toBe('pending');release();await pending;expect(receipt).toBe('catalogue hold');expect(close).toHaveBeenCalledTimes(1)
 })
 it('does not close the identical current account on catalogue refusal',async()=>{
  const close=vi.fn(async()=>{}),account={signer:{close}} as unknown as SignetSession
  await expect(closeCataloguesBeforeAccountAdoption(account,async()=>{throw Error('held')},()=>account)).rejects.toThrow('held');expect(close).not.toHaveBeenCalled()
 })
 it('preserves both catalogue and signer-close failure evidence',async()=>{
  const account={signer:{close:async()=>{throw Error('close failed')}}} as unknown as SignetSession
  await expect(closeCataloguesBeforeAccountAdoption(account,async()=>{throw Error('held')},()=>undefined)).rejects.toBeInstanceOf(AggregateError)
 })
 it('refused catalogue join cannot authorise leaving or closing the captured transport',async()=>{
  const leave=vi.fn(async()=>{}),close=vi.fn(),revoke=vi.fn()
  await expect(closeFailedRoomWithCatalogues({leave},{close},async()=>{throw Error('held')},revoke)).rejects.toThrow('held')
  expect(revoke).toHaveBeenCalledTimes(1);expect(leave).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
 })
})
