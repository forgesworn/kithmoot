import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Event } from 'nostr-tools/pure'
import { EncryptedLiveKeeperStore } from './live-keeper-store.js'
import { LiveKeeperJournal } from '../live-keeper.js'

const dirs: string[] = [], children: ChildProcess[] = []
const key = new Uint8Array(32).fill(7), NOW = 1_800_000_000
function path() { const dir = mkdtempSync(join(tmpdir(), 'live-keeper-')); dirs.push(dir); return join(dir, 'room.enc') }
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise<void>(r => child.once('exit', () => r())) }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Real packaged JS in another process, with synthetic keys only. No socket or radio. */
async function start(file: string, action: 'hold' | 'retire' | 'rekey' | 'answer' | 'agent'): Promise<{ child: ChildProcess; evidence: { id?: string; hash?: string; request?: Event } }> {
  const module = (name: string) => pathToFileURL(join(process.cwd(), 'dist/src', name)).href
  const script = `
    import { LiveKeeperJournal } from ${JSON.stringify(module('live-keeper.js'))};
    import { EncryptedLiveKeeperStore } from ${JSON.stringify(module('node/live-keeper-store.js'))};
    import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
    import { deriveRoom, deriveEpoch, encodeRekeyEvent, encodeLivePersistentRequest } from '@forgesworn/fold-kit';
    import { createHash } from 'node:crypto';
    import { RoomAgent } from ${JSON.stringify(module('agent.js'))};
    const j=LiveKeeperJournal.create(new EncryptedLiveKeeperStore(${JSON.stringify(file)},new Uint8Array(32).fill(7)),{relays:['wss://relay.example/'],now:()=>${NOW}});
    // Keep the idle authority reachable and prove the lease survives GC.
    process.on('message', message=>{
      if(message==='gc-status'){global.gc();setImmediate(()=>process.send({status:j.status}));}
    });
    const state=j.snapshot();
    let evidence={};
    if (${JSON.stringify(action)}==='retire') { await j.retire(); evidence.id=j.pendingEvents()[0].id; }
    if (${JSON.stringify(action)}==='rekey') {
      const secret=generateSecretKey();
      const event=encodeRekeyEvent({roomId:deriveRoom(state.secret).roomId,authoritySk:state.inviterSk,current:deriveEpoch({epoch:0,secret:state.secret}),next:{epoch:1,secret},recipients:[],removed:[],members:[],now:${NOW},commit:true});
      await j.prepareRekey(event,{...state,epoch:1,epochSecret:secret,epochAt:${NOW},members:[]});
      evidence={id:event.id,hash:createHash('sha256').update(secret).digest('hex')};
    }
    if (${JSON.stringify(action)}==='agent') {
      const transport=()=>({subscribe:()=>()=>{},close:()=>{},publish:async event=>{
        if(event.kind===1462){process.send({id:event.id});await new Promise(()=>{});}
      }});
      const agent=await RoomAgent.create({name:'Killed keeper',base:'https://room.example/j/',liveKeeper:j,transport,now:()=>${NOW}});
      await agent.session.rekey({authoritySk:state.inviterSk});
    } else if (${JSON.stringify(action)}==='answer') {
      const request=encodeLivePersistentRequest({invitation:{bearer:state.bearer,inviter:getPublicKey(state.inviterSk),persistent:true},roomId:deriveRoom(state.secret).roomId,requesterSk:generateSecretKey(),now:${NOW}});
      await j.answer(request,event=>{process.send({id:event.id,request});return new Promise(()=>{});});
    } else process.send(evidence);
    setInterval(()=>{},60000);
  `
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  let errors = ''
  child.stderr!.on('data', b => { errors = (errors + String(b)).slice(-2048) })
  const evidence = await new Promise<{ id?: string; hash?: string; request?: Event }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fixture did not become ready: ${errors}`)) }, 15_000)
    child.once('message', m => { clearTimeout(timer); resolve(m as { id?: string; hash?: string; request?: Event }) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${errors}`)) })
  })
  return { child, evidence }
}
async function kill(child: ChildProcess) { const exit = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGKILL'); await exit }

describe('encrypted live keeper storage', () => {
  it('keeps private ciphertext, authenticates it, and refuses insecure aliases', () => {
    const file = path(), store = new EncryptedLiveKeeperStore(file, key)
    store.save('a private state')
    expect(store.load()).toBe('a private state')
    expect(readFileSync(file).includes(Buffer.from('a private state'))).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(() => new EncryptedLiveKeeperStore(file, key)).toThrow()
    // A failed competing open must not release the first owner's lease.
    expect(() => new EncryptedLiveKeeperStore(file, key)).toThrow()
    store.save('still owned')
    store.close()
    const wrong = new EncryptedLiveKeeperStore(file, new Uint8Array(32).fill(8))
    expect(() => wrong.load()).toThrow(); wrong.close()
    const corrupt = readFileSync(file); corrupt[corrupt.length - 1] ^= 1; writeFileSync(file, corrupt)
    const changed = new EncryptedLiveKeeperStore(file, key)
    expect(() => changed.load()).toThrow(); changed.close()
    const alias = join(dirs[0]!, 'alias.enc'); symlinkSync(file, alias)
    const linked = new EncryptedLiveKeeperStore(alias, key)
    expect(() => linked.load()).toThrow(/private/); linked.close()
  })

  it('refuses a competing process and automatically releases ownership after SIGKILL', async () => {
    const file = path(), { child } = await start(file, 'hold')
    const alive = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owner stopped answering')), 5_000)
      child.once('message', value => { clearTimeout(timer); resolve(value) })
    })
    child.send('gc-status')
    expect(await alive).toEqual({ status: 'active' })
    expect(() => new EncryptedLiveKeeperStore(file, key)).toThrow()
    await kill(child)
    const j = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => NOW)
    expect(j.status).toBe('active')
    await j.close()
  }, 20_000)

  it('does not revive a link after SIGKILL between durable retirement and handoff', async () => {
    const file = path(), { child, evidence } = await start(file, 'retire')
    await kill(child)
    const j = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => NOW)
    expect(j.status).toBe('pending')
    expect(j.pendingEvents()[0]!.id).toBe(evidence.id)
    await j.offerPending(async event => { expect(event.id).toBe(evidence.id) })
    expect(j.status).toBe('retired')
    await j.close()
    const again = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => NOW)
    expect(again.status).toBe('retired'); await again.close()
  }, 20_000)

  it('recovers the exact pending rekey and next secret after SIGKILL', async () => {
    const file = path(), { child, evidence } = await start(file, 'rekey')
    await kill(child)
    const j = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => NOW)
    expect(j.status).toBe('pending')
    await j.offerPending(async event => { expect(event.id).toBe(evidence.id) })
    expect(j.snapshot().epoch).toBe(1)
    expect(createHash('sha256').update(j.snapshot().epochSecret!).digest('hex')).toBe(evidence.hash)
    await j.close()
    const again = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => NOW)
    expect(again.snapshot().epoch).toBe(1); await again.close()
  }, 20_000)

  it('reoffers the original signed answer after SIGKILL during an uncertain handoff', async () => {
    const file = path(), { child, evidence } = await start(file, 'answer')
    await kill(child)
    const j = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => NOW)
    const offered: string[] = []
    expect(await j.answer(evidence.request!, async event => { offered.push(event.id) })).toBe(true)
    expect(offered).toEqual([evidence.id])
    await j.close()
  }, 20_000)
  it('recovers an actual root session killed inside its durable rekey handoff', async () => {
    const file = path(), { child, evidence } = await start(file, 'agent')
    await kill(child)
    const j = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => NOW)
    expect(j.status).toBe('pending')
    const pending = j.pendingEvents()[0]!
    expect(pending.id).toBe(evidence.id)
    const { RoomAgent } = await import('../agent.js')
    const offered: Event[] = []
    const a = await RoomAgent.create({ name: 'Recovered keeper', base: 'https://room.example/j/', liveKeeper: j, now: () => NOW,
      transport: () => ({ subscribe: () => () => {}, close: () => {}, publish: async event => { offered.push(event) } }) })
    try {
      expect(offered[0]!.id).toBe(evidence.id)
      expect(a.session.epoch).toBe(1)
      expect(j.snapshot().epoch).toBe(1)
      expect(Buffer.from(j.snapshot().epochSecret!).equals(Buffer.from(a.session.currentEpoch().secret))).toBe(true)
      expect(offered.filter(e => e.kind === 1462).map(e => e.id)).toEqual([evidence.id])
    } finally { await a.leave() }
  }, 20_000)

})
