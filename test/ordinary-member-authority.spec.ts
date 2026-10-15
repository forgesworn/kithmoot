import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'

const ORIGIN = 'https://ordinary-member-authority.kithmoot.test'
const cuts = new Map([
  ['enrollment-final-write', { phase: null, puts: 0, signs: 1 }],
  ['provider-start', { phase: 'provider-started', puts: 4, signs: 1 }],
  ['settlement-precrypto', { phase: 'candidate-committed', puts: 9, signs: 2 }],
  ['successor-before-resume', { phase: 'settled', puts: 12, signs: 2 }],
])
let bundle = ''
test.beforeAll(async () => {
  // Observers only arm the real external selector. The next genuine native
  // check revokes Fore; no fixture throws or substitutes an authority check.
  const inject = (source: string, marker: string, cut: string) => {
    if (source.split(marker).length !== 2) throw Error('Fore fixture marker drift: ' + cut)
    return source.replace(marker, `;(globalThis as any).authorityCut?.('${cut}');\n` + marker)
  }
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-renewal-enrollment.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022',
    plugins: [{ name: 'foreground-reentrant-selector-fixture', setup(builder) {
      builder.onLoad({ filter: /ordinary-state-owner\.ts$/ }, async input => {
        let source = await readFile(input.path, 'utf8')
        source = inject(source, "            check();attempted=true\n            context!.store.put(candidateRows![0],'browser')", 'enrollment-final-write')
        source = inject(source, '                  try{await withP(()=>{completionArmed=true', 'provider-start')
        const settle = source.indexOf('static settleMemberRenewalCandidate(')
        if (settle < 0) throw Error('settlement source marker drift')
        const prefix = source.slice(0, settle), body = source.slice(settle)
        const marker = '          const guardedCrypto={subtle:crypto.subtle,getRandomValues:'
        source = prefix + inject(body, marker, 'settlement-precrypto')
        return { contents: source, loader: 'ts' }
      })
      builder.onLoad({ filter: /ordinary-persistent-bootstrap\.ts$/ }, async input => {
        const source = await readFile(input.path, 'utf8')
        const marker = '            if (!memberLive()) hold()\n            protocol!.work.resume(root)\n            // A new generation owns restatement; it cannot sit below the'
        return { contents: inject(source, marker, 'successor-before-resume'), loader: 'ts' }
      })
    } }] })).outputFiles[0]!.text
})
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html', body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN); await page.clock.install()
  await page.evaluate('window.memberEpochTimeoutMs=10000')
})
for (const [cut, expected] of cuts) {
  test(`reentrant Fore revocation at ${cut} prevents later native effects`, async ({ page }) => {
    const guardedSetup = setup.replace('window.guard=()=>live',
      'window.guard=()=>{if(window.foreArmed){window.foreArmed=false;window.reentrantHit=true;window.identity.revoke()}return live}')
    await page.evaluate(`(${guardedSetup})({visitor:false,noRelays:true})`)
    await page.evaluate(`(${controls})()`); await page.evaluate('join()')
    await page.evaluate(`(async()=>{
      window.reentrantPhase='${cut}';window.foreArmed=false;window.reentrantHit=false;window.puts=0;window.randomness=[];
      window.prior=await rawBoth();window.priorFrames=frames.length;
      window.authorityCut=point=>{if(point===reentrantPhase){foreArmed=true;window.cutValues=[puts,randomness.length,signCalls,frames.length]}};
      const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)};
      window.restorePut=()=>{IDBObjectStore.prototype.put=put};
      window.authorityState=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);
        r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),store=tx.objectStore('owners'),keys=store.getAllKeys(),values=store.getAll();
          tx.onabort=()=>{db.close();reject(tx.error)};tx.oncomplete=async()=>{db.close();try{
            const rows=new Map(keys.result.map((key,i)=>[key,values.result[i]])),names=Ordinary.ordinaryOperationNames(tabPurpose);
            if(!rows.has(names.control)){resolve({phase:null});return}
            const br=rows.get('browser'),tr=rows.get(tabPurpose),b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key);
            const binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
            const j=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),{browser:{key:br.key,binding:binding(b)},tab:{key:tr.key,binding:binding(t)}});
            try{resolve({phase:j.phase,result:j.result,secretCount:j.secrets.length,nonces:j.nonces,target:j.target})}
            finally{j.secrets.forEach(key=>key.fill(0));b.records.clear();t.records.clear()}
          }catch(error){reject(error)}}}})
    })()`)
    await page.clock.fastForward(901_000)
    await page.waitForFunction('reentrantHit&&sockets.every(s=>s.readyState===3)')
    await page.evaluate('member.close()')
    expect(await page.evaluate('[puts,signCalls,frames.length===priorFrames]'))
      .toEqual([expected.puts, expected.signs, true])
    expect(await page.evaluate('[puts,randomness.length,signCalls,frames.length]')).toEqual(await page.evaluate('cutValues'))
    expect(await page.evaluate('authorityState().then(value=>value.phase)')).toBe(expected.phase)
    expect(await page.evaluate('member.send("revoked must stay private").then(()=>false,()=>true)')).toBe(true)
    if (cut === 'enrollment-final-write') {
      expect(await page.evaluate('(async()=>{const after=await rawBoth();return after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,prior[i].frame))})()')).toBe(true)
    } else if (cut === 'provider-start') {
      expect(await page.evaluate('authorityState().then(j=>[j.result,j.secretCount,j.nonces!==null,j.target])')).toEqual([null,1,true,null])
      expect(await page.evaluate('outcome(()=>open())')).toBe('OrdinaryStateHold')
      expect(await page.evaluate('outcome(()=>bootstrap.load())')).toBe('OrdinaryStateHold')
    } else if (cut === 'settlement-precrypto') {
      expect(await page.evaluate('authorityState().then(j=>[j.result!==null,j.secretCount,j.nonces,j.target!==null])')).toEqual([true,0,null,true])
      expect(await page.evaluate('outcome(()=>open())')).toBe('OrdinaryStateHold')
      expect(await page.evaluate('outcome(()=>bootstrap.load())')).toBe('OrdinaryStateHold')
    } else {
      expect(await page.evaluate('authorityState().then(j=>[j.result,j.secretCount,j.nonces,j.target!==null])')).toEqual([null,0,null,true])
      await page.evaluate(`(async()=>{
        authorityCut=()=>{};restorePut();await bootstrap.close();identity=await Ordinary.OrdinaryForegroundSigner.open({browser:browserOwner,tab:tabOwner,
          session:sourceSession,currentSession:()=>sourceSession,generation:0,currentGeneration:()=>0,live:guard,checkClients:async()=>{},stop:()=>{}});
        current={...current,identity};bootstrap=await open();const material=await bootstrap.load();window.sealCount=material.sealKeys.length;
        ownCredential=material.credential;Ordinary.wipeOrdinaryPersistentBootstrapResult(material);
        member=await bootstrap.openMemberSession(sessionOptions);await member.join();await member.send('fresh Fore cold successor')
      })()`)
      expect(await page.evaluate('(async()=>[sealCount,signCalls,(await member.messages()).some(m=>m.text==="fresh Fore cold successor")])()'))
        .toEqual([2, 2, true])
    }
    await page.evaluate('restorePut();member.close()')
  })
}
