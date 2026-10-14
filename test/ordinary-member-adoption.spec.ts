import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'

const ORIGIN = 'https://ordinary-member-adoption.kithmoot.test'
const points = new Map([
  ['before-swap', 'this.#ownedOperation=operation;'],
  ['factory-guards', 'protocol!.adoptImage(successor!);'],
  ['protocol-guard', 'OrdinaryRelayCarrier.applySuccessor(carrier!,carrierPlan!,c)'],
  ['carrier-guard', 'nativeView!.apply(plan!);'],
  ['session-views', 'material=nextMaterial;'],
  ['root-material', 'oldMaterial.sealKey.fill(0);'],
])
let bundle = ''
test.beforeAll(async () => {
  // Fault injection belongs only to this test bundle. Production source has
  // no hook, option or callback between guard/view assignments. Each marker
  // must match exactly once, so source drift cannot silently weaken a case.
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-bootstrap.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022',
    plugins: [{ name: 'native-adoption-failure-fixture', setup(builder) {
      builder.onLoad({ filter: /ordinary-persistent-bootstrap\.ts$/ }, async input => {
        let source = await readFile(input.path, 'utf8')
        for (const [point, marker] of points) {
          if (source.split(marker).length !== 2) throw Error('adoption fixture marker drift: ' + point)
          source = source.replace(marker, `if ((globalThis as any).adoptionFault === '${point}') { (globalThis as any).faultReached = true; throw Error('injected adoption failure'); }\n${marker}`)
        }
        return { contents: source, loader: 'ts' }
      })
    } }] })).outputFiles[0]!.text
})
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html', body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN)
  await page.clock.install()
  await page.evaluate('window.memberEpochTimeoutMs=10000')
})
for (const point of points.keys()) {
  test(`committed successor survives terminal ${point} failure and cold reopen`, async ({ page }) => {
    await page.evaluate(`(${setup})({visitor:false,noRelays:true})`)
    await page.evaluate(`(${controls})()`)
    await page.evaluate('join()')
    await page.evaluate(`window.adoptionFault='${point}';window.faultReached=false;window.priorFrames=frames.length`)
    await page.clock.fastForward(901_000)
    await page.waitForFunction('faultReached&&sockets.every(s=>s.readyState===3)')
    expect(await page.evaluate('[signCalls,frames.length===priorFrames]')).toEqual([2, true])
    expect(await page.evaluate('member.send("partial adoption must stay private").then(()=>false,()=>true)')).toBe(true)
    await page.evaluate(`(async()=>{await member.close();await bootstrap.close();window.adoptionFault=undefined;
      bootstrap=await open();const current=await bootstrap.load();window.sealCount=current.sealKeys.length;
      ownCredential=current.credential;Ordinary.wipeOrdinaryPersistentBootstrapResult(current);
      member=await bootstrap.openMemberSession(sessionOptions);await member.join();await member.send('cold committed successor')})()`)
    expect(await page.evaluate('(async()=>[sealCount,signCalls,(await member.messages()).some(m=>m.text==="cold committed successor"),frames.every(r=>r[1])])()'))
      .toEqual([2, 2, true, true])
    await page.evaluate('member.close()')
  })
}
