import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { deriveRoom, encodeLivePersistentRequest } from '@forgesworn/fold-kit'
import { LiveAdmissionBudget } from '../live-admission-responder.js'
import { LiveKeeperJournal } from '../live-keeper.js'
import { EncryptedLiveKeeperStore } from './live-keeper-store.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'

const dirs: string[] = [], children: ChildProcess[] = []
const NOW = 1_800_000_000, key = new Uint8Array(32).fill(7), budgetKey = new Uint8Array(32).fill(8)
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGKILL'); await exit
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('preserves the aggregate ceiling and original answer after SIGKILL inside handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-budget-kill-')); dirs.push(dir)
  const file = join(dir, 'room.enc'), budgetFile = join(dir, 'budget.enc')
  const module = (name: string) => pathToFileURL(join(process.cwd(), 'dist/src', name)).href
  const script = `
    import {LiveAdmissionBudget} from ${JSON.stringify(module('live-admission-responder.js'))};
    import {LiveKeeperJournal} from ${JSON.stringify(module('live-keeper.js'))};
    import {EncryptedLiveKeeperStore} from ${JSON.stringify(module('node/live-keeper-store.js'))};
    import {generateSecretKey,getPublicKey} from 'nostr-tools/pure';
    import {deriveRoom,encodeLivePersistentRequest} from '@forgesworn/fold-kit';
    const now=()=>${NOW};
    const b=LiveAdmissionBudget.create(new EncryptedLiveKeeperStore(${JSON.stringify(budgetFile)},new Uint8Array(32).fill(8)),now);
    const j=LiveKeeperJournal.create(new EncryptedLiveKeeperStore(${JSON.stringify(file)},new Uint8Array(32).fill(7)),{now});
    const state=j.snapshot(),ctx={invitation:{bearer:state.bearer,inviter:getPublicKey(state.inviterSk),persistent:true},roomId:deriveRoom(state.secret).roomId};
    let handler,done,count=0,last;
    const host=b.host(j,{subscribe:(_,h)=>{handler=h;return()=>{}},close:()=>{},publish:async e=>{
      count++; if(count===16){process.send({id:e.id,request:last});await new Promise(()=>{});} else done();
    }},e=>{throw e});
    // Keep ownership reachable while awaiting kill, including under GC.
    process.on('message',()=>process.send({alive:!!host&&!!b&&j.status==='active'}));
    for(let i=0;i<16;i++){
      last=encodeLivePersistentRequest({...ctx,requesterSk:generateSecretKey(),now:now()});
      const offered=new Promise(r=>{done=r});handler(last);await offered;
    }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child)
  let errors = ''
  child.stderr!.on('data', b => { errors = (errors + String(b)).slice(-2048) })
  const evidence = await new Promise<{ id: string; request: Event }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`budget fixture timed out: ${errors}`)) }, 15_000)
    child.once('message', m => { clearTimeout(timer); resolve(m as { id: string; request: Event }) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`budget fixture exited ${code}: ${errors}`)) })
  })
  expect(() => new EncryptedLiveKeeperStore(budgetFile, budgetKey)).toThrow()
  const exit = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGKILL'); await exit
  const budget = LiveAdmissionBudget.open(new EncryptedLiveKeeperStore(budgetFile, budgetKey), () => NOW)
  const journal = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => NOW)
  const relay = new SimRelay(), faults: unknown[] = []
  const host = budget.host(journal, new SimTransport(relay), e => faults.push(e))
  try {
    relay.publish(evidence.request)
    await journal.checkpoint(journal.snapshot())
    expect(relay.published.filter(e => e.kind === 20467).map(e => e.id)).toEqual([evidence.id])
    const state = journal.snapshot()
    const fresh = encodeLivePersistentRequest({ invitation: { bearer: state.bearer, inviter: getPublicKey(state.inviterSk), persistent: true },
      roomId: deriveRoom(state.secret).roomId, requesterSk: generateSecretKey(), now: NOW })
    relay.publish(fresh); await journal.checkpoint(journal.snapshot())
    expect(relay.published.filter(e => e.kind === 20467)).toHaveLength(1)
    expect(faults).toEqual([])
  } finally { host.close(); await journal.close(); await new Promise(r => setTimeout(r, 0)); budget.close() }
}, 20_000)
