import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { ROUTING_CUSTODY_MODES, ROUTING_CUSTODY_FAULTS, routingCustodyFixture } from './ordinary-routing-custody-fixture.js'
import { preflightProbe, noPreflightEffects } from './ordinary-preflight-probe.js'

// Actual writer bytes and signatures, prepared offline before native Storage
// capture. Synthetic startup barrier; no mounted app or current routing claim.
const ORIGIN = 'https://ordinary-snapshot.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-snapshot.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
async function open(context: BrowserContext, f: Awaited<ReturnType<typeof routingCustodyFixture>>) {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN)
  await page.evaluate(({ browser, tab, url }) => {
    for (const [name, raw] of browser) localStorage.setItem(name, raw)
    for (const [name, raw] of tab) sessionStorage.setItem(name, raw)
    history.replaceState(null, '', url)
  }, { browser: [...f.browser], tab: [...f.tab], url: f.startupUrl })
  return page
}
const inspect = `
  const browser=new Map(Object.entries(localStorage)),tab=new Map(Object.entries(sessionStorage));
  const before=JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]);
  ${preflightProbe}
  const uuid=crypto.randomUUID,math=Math.random;crypto.randomUUID=blocked('entropy');Math.random=blocked('entropy');
  const restoreAll=()=>{restore();crypto.randomUUID=uuid;Math.random=math};
`
for (const mode of ROUTING_CUSTODY_MODES) test(`${mode} native signed relay custody stays historical and has no effects`, async ({ browser }) => {
  const f = await routingCustodyFixture(mode), context = await browser.newContext()
  try {
    const page = await open(context, f)
    expect(await page.evaluate(`(()=>{
      ${inspect}
      try{const token=Ordinary.captureOrdinarySnapshotContext(browser,tab);history.replaceState(null,'','/j/');
        const result=Ordinary.validateOrdinarySnapshot(browser,tab,{browser:false,tab:false},token);
        let burned=false;try{Ordinary.validateOrdinarySnapshot(browser,tab,{browser:false,tab:false},token)}catch(e){burned=e.name==='OrdinaryStateHold'}
        return[result.historicalRoomRelayRecords,result.invitations,burned,Object.isFrozen(result),
          Object.values(result).filter(v=>typeof v==='string'),before===JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]),effects];
      }finally{restoreAll()}
    })()`)).toEqual([1, mode.startsWith('rotated-') ? 2 : mode === 'metadata-only' ? 0 : 1, true, true, [], true, noPreflightEffects])
  } finally { f.release(); await context.close() }
})
for (const fault of ROUTING_CUSTODY_FAULTS) test(`${fault} native routing HOLD retains exact bytes and burns the capture`, async ({ browser }) => {
  const f = await routingCustodyFixture(fault === 'missing-old-pin' ? 'rotated-old' : 'owner'), context = await browser.newContext()
  try {
    f.damage(fault); const page = await open(context, f)
    expect(await page.evaluate(`(()=>{
      ${inspect}
      try{const token=Ordinary.captureOrdinarySnapshotContext(browser,tab);let held=false,burned=false;
        try{Ordinary.validateOrdinarySnapshot(browser,tab,{browser:false,tab:false},token)}catch(e){held=e.name==='OrdinaryStateHold'}
        try{Ordinary.validateOrdinarySnapshot(browser,tab,{browser:false,tab:false},token)}catch(e){burned=e.name==='OrdinaryStateHold'}
        return[held,burned,before===JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]),effects];
      }finally{restoreAll()}
    })()`)).toEqual([true, true, true, noPreflightEffects])
  } finally { f.release(); await context.close() }
})
test('native cross-room swap refuses otherwise valid same-inviter records', async ({ browser }) => {
  const a = await routingCustodyFixture(), b = await routingCustodyFixture('member-kept', { rootSeed: 6, bearerSeed: 9 }), context = await browser.newContext()
  try {
    for (const [name, raw] of b.browser) if (name === b.roomName || name === b.name || name.startsWith('kithmoot.admission-kept.')) a.browser.set(name, raw)
    const page = await open(context, a)
    expect(await page.evaluate(`(()=>{${inspect}
      try{return[Ordinary.validateOrdinarySnapshot(browser,tab,{browser:false,tab:false},Ordinary.captureOrdinarySnapshotContext(browser,tab)).historicalRoomRelayRecords,effects]}
      finally{restoreAll()}})()`)).toEqual([2, noPreflightEffects])
    await page.evaluate(({ first, second }) => {
      const a = localStorage.getItem(first)!, b = localStorage.getItem(second)!
      localStorage.setItem(first, b); localStorage.setItem(second, a)
    }, { first: a.name, second: b.name })
    expect(await page.evaluate(`(()=>{${inspect}
      try{let held=false;try{Ordinary.validateOrdinarySnapshot(browser,tab,{browser:false,tab:false},Ordinary.captureOrdinarySnapshotContext(browser,tab))}catch(e){held=e.name==='OrdinaryStateHold'}
        return[held,before===JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]),effects]}
      finally{restoreAll()}})()`)).toEqual([true, true, noPreflightEffects])
  } finally { a.release(); b.release(); await context.close() }
})
