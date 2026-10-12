import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { preflightProbe, noPreflightEffects } from './ordinary-preflight-probe.js'

// Real writers/grants/signatures; explicit offline fixtures and synthetic
// startup barrier. No complete production root or account restoration claim.
const ORIGIN = 'https://ordinary-access-composition.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-access-composition.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
async function open(context: BrowserContext) {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); return page
}
const probe = preflightProbe + `
  const compositionSavedRandomUUID=crypto.randomUUID,compositionSavedMathRandom=Math.random;
  crypto.randomUUID=blocked('entropy');Math.random=blocked('entropy');
  const restoreAll=()=>{restore();crypto.randomUUID=compositionSavedRandomUUID;Math.random=compositionSavedMathRandom};
`
for (const mode of ['both-owner', 'bookmark', 'startup', 'tab-navigation', 'opaque-inert', 'missing-startup', 'delegate-reuse', 'cross-role', 'signature'] as const) {
  test(`${mode} composes real retained access evidence across both owners without preflight effects`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
      const mode='${mode}',owner=Ordinary.roomAccessFixture({owner:mode!=='delegate-reuse',persistent:mode==='bookmark'}),
        guest=Ordinary.roomAccessFixture({tab:true,persistent:mode==='bookmark',
          ...(mode==='delegate-reuse'||mode==='cross-role'?{rootSeed:6,inviterSeed:3,requesterSeed:mode==='cross-role'?1:2,bearerSeed:8}:{})});
      const browserRows=new Map(owner.records),tabRows=new Map(guest.records);
      if(['both-owner','bookmark','startup','missing-startup'].includes(mode))for(const n of [...tabRows.keys()])if(!n.startsWith('kithmoot.admission.'))tabRows.delete(n);
      if(mode==='bookmark'){browserRows.delete(owner.roomName);const cached=await Ordinary.bookmarkFixture();browserRows.set(cached.name,cached.records.get(cached.name))}
      if(mode==='startup'||mode==='missing-startup')browserRows.delete(owner.roomName);
      if(mode==='startup')history.replaceState(null,'',new URL(owner.url).hash);
      if(mode==='tab-navigation')browserRows.clear();
      if(mode==='opaque-inert'){tabRows.clear();tabRows.set('kithmoot.way-back',JSON.stringify({link:'opaque',name:''}))}
      if(mode==='signature'){const n='kithmoot.admission.v1.'+guest.id,v=JSON.parse(tabRows.get(n));v.delegation[0].sig='0'.repeat(128);tabRows.set(n,JSON.stringify(v))}
      for(const[n,v]of browserRows)localStorage.setItem(n,v);for(const[n,v]of tabRows)sessionStorage.setItem(n,v);
      const before=JSON.stringify([[...browserRows],[...tabRows]]),stored=JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]);
      ${probe}
      try{const token=Ordinary.captureOrdinaryStartupContext(browserRows,tabRows);let held=false,result;
        try{result=Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(browserRows,tabRows,{browser:false,tab:false},token)}catch(e){held=e.name==='OrdinaryStateHold'}
        let reused=false;try{Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(browserRows,tabRows,{browser:false,tab:false},token)}catch(e){reused=e.name==='OrdinaryStateHold'}
        return[held,result?.access.invitations.length??0,reused,before===JSON.stringify([[...browserRows],[...tabRows]]),
          stored===JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]),Object.isFrozen(token),effects];
      }finally{restoreAll()}
    })()`)).toEqual([
      ['missing-startup', 'delegate-reuse', 'cross-role', 'signature'].includes(mode),
      ['missing-startup', 'delegate-reuse', 'cross-role', 'signature'].includes(mode) ? 0 : ['tab-navigation', 'opaque-inert'].includes(mode) ? 1 : 2,
      true, true, true, true, noPreflightEffects,
    ]); await context.close()
  })
}
for (const partition of ['browser-access', 'bookmarks', 'tab-access', 'navigation'] as const) {
  for (const fault of ['changed', 'missing', 'substituted'] as const) test(`${fault} ${partition} snapshot holds and burns the private capability`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
      const cached=await Ordinary.bookmarkFixture(),owner=Ordinary.roomAccessFixture({owner:true,persistent:true}),guest=Ordinary.roomAccessFixture({tab:true,persistent:true});
      const browserRows=new Map([...owner.records,...cached.records]),tabRows=new Map(guest.records),originalBrowser=new Map(browserRows),originalTab=new Map(tabRows);
      ${probe}
      try{const token=Ordinary.captureOrdinaryStartupContext(browserRows,tabRows),partition='${partition}',fault='${fault}',target=partition==='browser-access'||partition==='bookmarks'?browserRows:tabRows;
        const prefix=partition==='browser-access'?'kithmoot.invitation-owner.':partition==='bookmarks'?'kithmoot.bookmarks.':partition==='tab-access'?'kithmoot.admission.':'kithmoot.way-back';
        const[n,v]=[...target].find(([n])=>n.startsWith(prefix));
        if(fault==='changed')target.set(n,v+' ');else{target.delete(n);if(fault==='substituted')target.set(n==='kithmoot.way-back'?'kithmoot.room-switch.v1':n.slice(0,-64)+'a'.repeat(64),v)}
        const before=JSON.stringify([[...browserRows],[...tabRows]]);let held=false,burned=false;
        try{Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(browserRows,tabRows,{browser:false,tab:false},token)}catch(e){held=e.name==='OrdinaryStateHold'}
        try{Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(originalBrowser,originalTab,{browser:false,tab:false},token)}catch(e){burned=e.name==='OrdinaryStateHold'}
        return[held,burned,before===JSON.stringify([[...browserRows],[...tabRows]]),effects];
      }finally{restoreAll()}
    })()`)).toEqual([true, true, true, noPreflightEffects]); await context.close()
  })
}
test('original native location survives actual history scrubbing without a public URL handoff', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(()=>{
    const owner=Ordinary.roomAccessFixture({owner:true});owner.records.delete(owner.roomName);history.replaceState(null,'',new URL(owner.url).hash);
    ${probe}
    try{const tab=new Map(),token=Ordinary.captureOrdinaryStartupContext(owner.records,tab);history.replaceState(null,'','/j/');
      const result=Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(owner.records,tab,{browser:false,tab:false},token);
      return[location.hash,result.access.invitations.length,token.links,JSON.stringify(token).includes('https://'),effects];
    }finally{restoreAll()}
  })()`)).toEqual(['', 1, 1, false, noPreflightEffects]); await context.close()
})
test('copied and released capabilities cannot bypass the private evidence closure', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(()=>{
    const owner=Ordinary.roomAccessFixture({owner:true}),tab=new Map();${probe}
    try{const token=Ordinary.captureOrdinaryStartupContext(owner.records,tab);let forged=false,released=false;
      try{Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(owner.records,tab,{browser:false,tab:false},{...token})}catch(e){forged=e.name==='OrdinaryStateHold'}
      const result=Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(owner.records,tab,{browser:false,tab:false},token),abandoned=Ordinary.captureOrdinaryStartupContext(owner.records,tab);
      Ordinary.releaseOrdinaryStartupContext(abandoned);
      try{Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(owner.records,tab,{browser:false,tab:false},abandoned)}catch(e){released=e.name==='OrdinaryStateHold'}
      return[forged,result.access.invitations.length,released,effects];
    }finally{restoreAll()}
  })()`)).toEqual([true, 1, true, noPreflightEffects]); await context.close()
})

for (const mode of ['opaque', 'contact-card', 'incomplete', 'oversized-startup', 'oversized-navigation', 'policy-conflict', 'policy-malformed'] as const) {
  for (const reverse of [false, true]) test(`${mode} startup classification preserves restrictions in navigation order reverse=${reverse}`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(()=>{
      const owner=Ordinary.roomAccessFixture({owner:true});owner.records.delete(owner.roomName);
      const payload=JSON.parse(new TextDecoder().decode(Ordinary.base64urlnopad.decode(new URL(owner.url).hash.slice(1))));
      payload.a='${mode}'==='policy-malformed'?{tier:'open',hiddenRule:true}:{tier:'kith',members:['a'.repeat(64)]};
      const encoded=Ordinary.base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)));
      const fragment='${mode}'==='contact-card'?Ordinary.startupCardFragment():'${mode}'==='incomplete'?'eyJ2Ijoy':'${mode}'==='oversized-startup'?'x'.repeat(16385):'${mode}'==='policy-malformed'?encoded:'opaque';
      history.replaceState(null,'','#'+fragment);
      const pairs=[['kithmoot.way-back',JSON.stringify({link:owner.url,name:''})],['kithmoot.room-switch.v1',JSON.stringify({hash:'${mode}'==='policy-conflict'?'#'+encoded:'${mode}'==='oversized-navigation'?'#'+'x'.repeat(16385):new URL(owner.url).hash,account:null,at:100})]];
      const tab=new Map(${reverse}?pairs.reverse():pairs);${probe}
      try{const token=Ordinary.captureOrdinaryStartupContext(owner.records,tab);let held=false,result;
        try{result=Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(owner.records,tab,{browser:false,tab:false},token)}catch(e){held=e.name==='OrdinaryStateHold'}
        return[held,result?.access.invitations.length??0,effects];
      }finally{restoreAll()}
    })()`)).toEqual([mode.startsWith('policy-'), mode.startsWith('policy-') ? 0 : 1, noPreflightEffects]); await context.close()
  })
}
