import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'

const ORIGIN = 'https://ordinary-member-authority.kithmoot.test'
const points = new Map([
  ['prewrite-next-check', '                nativeView!.check(plan!)\n              })'],
  ['prewrite-postcheck', '            }})\n            if(answer.status===\'definite-abort\'){'],
  ['adoption-next-check', '              }finally{checked.close()}\n              protocol!.enterLifecycle(root,b,t,c,()=>{'],
  ['abort-postcheck', '              if (!memberLive()) hold()\n              protocol!.work.resume(root);resumeGeneration(false);return'],
])
let bundle = ''
test.beforeAll(async () => {
  // Test-only instrumentation arms a real external selector to revoke Fore.
  // It does not throw or replace an authority check. Production has no hook.
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-bootstrap.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022',
    plugins: [{ name: 'foreground-reentrant-selector-fixture', setup(builder) {
      builder.onLoad({ filter: /ordinary-persistent-bootstrap\.ts$/ }, async input => {
        let source = await readFile(input.path, 'utf8')
        for (const [point, marker] of points) {
          if (source.split(marker).length !== 2) throw Error('Fore fixture marker drift: ' + point)
          const arm = `if ((globalThis as any).reentrantPhase === '${point}') (globalThis as any).foreArmed = true;\n`
          if (point === 'prewrite-postcheck') source = source.replace(marker, arm + marker)
          else if (point === 'adoption-next-check') source = source.replace(marker, marker.replace('              protocol!', arm + '              protocol!'))
          else source = source.replace(marker, arm + marker)
        }
        return { contents: source, loader: 'ts' }
      })
    } }] })).outputFiles[0]!.text
})
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html', body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN); await page.clock.install()
  await page.evaluate('window.memberEpochTimeoutMs=10000')
})
for (const point of points.keys()) {
  test(`reentrant Fore revocation at ${point} prevents later native effects`, async ({ page }) => {
    await page.evaluate(`(${setup})({visitor:false,noRelays:true})`)
    await page.evaluate(`(${controls})()`)
    await page.evaluate('join()')
    await page.evaluate(`(async()=>{
      window.reentrantPhase='${point}';window.foreArmed=false;window.reentrantHit=false;window.puts=0;window.prior=await rawBoth();window.priorFrames=frames.length;
      guard=()=>{if(foreArmed){foreArmed=false;reentrantHit=true;identity.revoke()}return live};
      const put=IDBObjectStore.prototype.put;let once=false;
      IDBObjectStore.prototype.put=function(...args){if('${point}'==='abort-postcheck'&&!once){once=true;throw new DOMException('quota','QuotaExceededError')}
        puts++;return put.apply(this,args)};window.restorePut=()=>{IDBObjectStore.prototype.put=put}
    })()`)
    await page.clock.fastForward(901_000)
    await page.waitForFunction('reentrantHit&&sockets.every(s=>s.readyState===3)')
    await page.evaluate('member.close()')
    expect(await page.evaluate('[signCalls,puts,frames.length===priorFrames]')).toEqual([2, point === 'adoption-next-check' ? 2 : 0, true])
    expect(await page.evaluate('member.send("revoked must stay private").then(()=>false,()=>true)')).toBe(true)
    if (point === 'adoption-next-check') {
      await page.evaluate(`(async()=>{
        restorePut();await bootstrap.close();identity=await Ordinary.OrdinaryForegroundSigner.open({browser:browserOwner,tab:tabOwner,
          session:sourceSession,currentSession:()=>sourceSession,generation:0,currentGeneration:()=>0,live:guard,checkClients:async()=>{},stop:()=>{}});
        current={...current,identity};bootstrap=await open();const material=await bootstrap.load();window.sealCount=material.sealKeys.length;
        ownCredential=material.credential;Ordinary.wipeOrdinaryPersistentBootstrapResult(material);
        member=await bootstrap.openMemberSession(sessionOptions);await member.join();await member.send('fresh Fore cold successor')
      })()`)
      expect(await page.evaluate('(async()=>[sealCount,signCalls,(await member.messages()).some(m=>m.text==="fresh Fore cold successor")])()'))
        .toEqual([2, 2, true])
    } else {
      expect(await page.evaluate('(async()=>{const after=await rawBoth();return after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,prior[i].frame))})()')).toBe(true)
    }
    await page.evaluate('restorePut();member.close()')
  })
}
