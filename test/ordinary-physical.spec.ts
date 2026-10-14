import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { preflightProbe, noPreflightEffects } from './ordinary-preflight-probe.js'
import { uiFixture } from './ordinary-ui-fixture.js'

// Writer preparation precedes the synchronous probe. These checks establish
// physical routing and navigation partition custody, not a production root.
const ORIGIN = 'https://ordinary-physical.kithmoot.test'
let bundle = '', textSize = ''
test.beforeAll(async () => {
  const outputs = await Promise.all([
    build({ entryPoints: [fileURLToPath(new URL('./ordinary-physical.browser-entry.ts', import.meta.url))], bundle: true,
      format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' }),
    build({ entryPoints: [fileURLToPath(new URL('../app/src/text-size.ts', import.meta.url))], bundle: true,
      format: 'iife', platform: 'browser', write: false, target: 'es2022' }),
  ])
  bundle = outputs[0]!.outputFiles[0]!.text; textSize = outputs[1]!.outputFiles[0]!.text
})
async function open(context: BrowserContext) {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html', body:
    '<!doctype html><meta charset="utf-8"><div data-text-size>' + ['standard', 'large', 'huge'].map(size =>
      `<input type="radio" name="size" value="${size}">`).join('') + '</div><script>' +
    textSize.replace(/<\/script/gi, '<\\/script') + '</script><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); return page
}
const probe = preflightProbe + `
  const physicalSavedRandomUUID=crypto.randomUUID,physicalSavedMathRandom=Math.random;
  crypto.randomUUID=blocked('entropy');Math.random=blocked('entropy');
  const restoreAll=()=>{restore();crypto.randomUUID=physicalSavedRandomUUID;Math.random=physicalSavedMathRandom};
`
for (const writer of ['mls', 'coordinated', 'rendezvous'] as const) test(`${writer} actual UUID signal stays outside protected image without preflight effects`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(()=>{
    const writer='${writer}', storage=writer==='mls'?new Ordinary.BrowserMlsVaultStorage():writer==='coordinated'?new Ordinary.BrowserCoordinatedVaultSignals():new Ordinary.BrowserRendezvousVaultStorage();
    storage.invalidate();const records=new Map(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),before=JSON.stringify([...records]);
    ${probe}
    try{const counts=Ordinary.validateOrdinaryPhysicalSnapshot(records,{kind:'browser'});return[counts.protectedRecords,counts.signals,before===JSON.stringify([...records]),effects]}
    finally{restoreAll()}
  })()`)).toEqual([0, 1, true, noPreflightEffects]); await context.close()
})
for (const size of ['standard', 'large', 'huge'] as const) test(`${size} primary text-size control writes protected exact value`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(()=>{
    const input=document.querySelector('input[value="${size}"]');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));
    const raw=localStorage.getItem('kithmoot.textSize'),records=new Map([['kithmoot.textSize',raw]]);${probe}
    try{return[raw,Ordinary.validateOrdinaryPhysicalSnapshot(records,{kind:'browser'}).protectedRecords,effects]}finally{restoreAll()}
  })()`)).toEqual([size, 1, noPreflightEffects]); await context.close()
})
for (const t of ['claim', 'release', 'probe'] as const) test(`${t} primary storage fallback keeps call coordination inert and protected`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    const channel=window.BroadcastChannel;window.BroadcastChannel=undefined;
    const lock=new Ordinary.CallTabLock({onPreempted(){throw Error('effect')},onHeldElsewhere(){throw Error('effect')},onFreed(){throw Error('effect')},onProbeAnswered(){throw Error('effect')}});
    try{const key='${t}'==='claim'?'':'opaque'.repeat(100);if('${t}'==='probe')await lock.askHeldElsewhere(key,0);else{lock.claim(key);if('${t}'==='release')lock.release(key)}
      const raw=localStorage.getItem('kithmoot.call-tab-lock.msg'),records=new Map([['kithmoot.call-tab-lock.msg',raw]]);${probe}
      try{return[JSON.parse(raw).message.t,Ordinary.validateOrdinaryPhysicalSnapshot(records,{kind:'browser'}).protectedRecords,effects]}finally{restoreAll()}
    }finally{lock.close();window.BroadcastChannel=channel}
  })()`)).toEqual([t, 1, noPreflightEffects]); await context.close()
})
for (const fault of ['unknown', 'wrong-owner', 'bad-signal', 'new-signal', 'wrapped', 'bad-marker', 'bad-size'] as const) test(`${fault} physical state holds before allocation or effects`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(()=>{
    const uuid='12345678-1234-4234-8234-123456789abc',h='a'.repeat(64),pairs={unknown:['kithmoot:future','opaque'],
      'wrong-owner':['kithmoot.way-back','{}'],'bad-signal':['kithmoot-mls-vault-v1.revision',h],
      'new-signal':['kithmoot-browser-link-v1:revision',uuid],wrapped:['kithmoot.account.'+h+'.kithmoot.textSize','large'],
      'bad-marker':['kithmoot.ordinary-tab.v1',uuid],'bad-size':['kithmoot.textSize','giant']};
    const records=new Map([pairs['${fault}']]),before=JSON.stringify([...records]);${probe}
    try{let held=false;try{Ordinary.validateOrdinaryPhysicalSnapshot(records,{kind:'${fault}'==='bad-marker'?'tab':'browser'})}catch(e){held=e.name==='OrdinaryStateHold'}
      return[held,before===JSON.stringify([...records]),effects]}finally{restoreAll()}
  })()`)).toEqual([true, true, noPreflightEffects]); await context.close()
})
for (const fault of ['none', 'missing-context', 'forged-context', 'wrong-partition', 'double-dispatch', 'opaque', 'empty-switch', 'mutated-source'] as const) test(`${fault} explicit navigation handoff preserves real verified grant without effects`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(()=>{
    const fixture=Ordinary.roomAccessFixture({tab:true}),rows=new Map(),nav=new Map();
    for(const[n,v]of fixture.records){if(Ordinary.classifyOrdinaryPhysicalName(n,'tab').family==='navigation')nav.set(n,v);else rows.set(n,v)}
    if('${fault}'==='opaque'){nav.clear();nav.set('kithmoot.way-back',JSON.stringify({link:'opaque',name:''}))}
    if('${fault}'==='empty-switch'){nav.clear();nav.set('kithmoot.room-switch.v1',JSON.stringify({hash:'',account:null,at:0}))}
    const captured=Ordinary.captureOrdinaryNavigationContext('${fault}'==='wrong-partition'?nav:new Map([...rows,...nav]),{kind:'tab'});
    if('${fault}'==='mutated-source'){nav.clear();rows.clear()}
    const input='${fault}'==='double-dispatch'?fixture.records:'${fault}'==='mutated-source'?new Map([...fixture.records].filter(([n])=>Ordinary.classifyOrdinaryPhysicalName(n,'tab').family==='access')):rows;
    const supplied='${fault}'==='missing-context'?undefined:'${fault}'==='forged-context'?{...captured}:captured;${probe}
    try{let held=false,id;try{id=Ordinary.validateOrdinaryRoomAccessSnapshot(input,false,{kind:'tab',navigation:supplied}).invitations[0].roomId}catch(e){held=e.name==='OrdinaryStateHold'}
      return[held,id===fixture.roomId,effects]}finally{restoreAll()}
  })()`)).toEqual([!['none', 'mutated-source'].includes(fault), ['none', 'mutated-source'].includes(fault), noPreflightEffects]); await context.close()
})
test('primary main navigation cuts remain opaque custody without granting room authority', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context), records = [...uiFixture('tab-all').records]
  expect(await page.evaluate(`(()=>{
    const records=new Map(${JSON.stringify(records)});${probe}
    try{const captured=Ordinary.captureOrdinaryNavigationContext(records,{kind:'tab'}),summary=Ordinary.validateOrdinaryRoomAccessSnapshot(new Map(),false,{kind:'tab',navigation:captured});
      return[captured.wayBacks,captured.roomSwitches,summary.invitations.length,effects]}finally{restoreAll()}
  })()`)).toEqual([1, 1, 0, noPreflightEffects]); await context.close()
})
