import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { BOARD_CONTEXT_MODES, BOARD_CONTEXT_FAULTS } from './ordinary-board-context-fixture.js'

// Actual writer, native migration, IDB/locks/AES and complete paired composer.
// Personal labels remain inert; this is not a mounted board/signer session.
const ORIGIN = 'https://ordinary-board-context.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-board-context.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
const setup = `()=>{
 window.live=true;window.guard=()=>live;window.browserOwner=new Ordinary.OrdinaryStateOwner()
 window.tabPurpose='tab:'+'a'.repeat(64);window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,Date.now()+3600_000)
 window.seed=(mode='both')=>{window.fixture=Ordinary.boardContextFixture(mode);for(const[n,v]of fixture.records)localStorage.setItem(n,v)}
 window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner:browserOwner,storage:localStorage,selected:Ordinary.ordinaryPrivateStorageName,
   validate:(records,migrated)=>{Ordinary.validateOrdinaryPhysicalSnapshot(records,{kind:'browser'});Ordinary.validateOrdinaryMetadataSnapshot(records,migrated,{kind:'browser'})},
   checkClients:async()=>{},live:guard})
 window.preparePair=async()=>{await migrate();await tabOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
   window.bScope=await browserOwner.capture('@board-context',guard);window.tScope=await tabOwner.capture('@board-context',guard)}
 window.rawBoth=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);
   r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose);
     tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}})
 window.preflight=()=>Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:bScope},tab:{owner:tabOwner,scope:tScope},live:guard,
   work:(b,t,_bn,_tn,custody)=>{const bm=new Map(b.keys().map(n=>[n,b.get(n)])),tm=new Map(t.keys().map(n=>[n,t.get(n)]));
     return Ordinary.validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},Ordinary.captureOrdinarySnapshotContext(bm,tm,custody))}})
 window.countCrypto=()=>{window.entropy=0;window.generated=0;window.encryptions=0;
   const random=crypto.getRandomValues.bind(crypto),generate=crypto.subtle.generateKey.bind(crypto.subtle),encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
   crypto.getRandomValues=(...a)=>{entropy++;return random(...a)};crypto.subtle.generateKey=(...a)=>{generated++;return generate(...a)};
   crypto.subtle.encrypt=(...a)=>{encryptions++;return encrypt(...a)};
   window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.generateKey=generate;crypto.subtle.encrypt=encrypt}}
}`
async function open(context: BrowserContext) {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate('(' + setup + ')()'); return page
}
for (const mode of BOARD_CONTEXT_MODES) test(`${mode} actual writer migrates into a byte-exact native pair with no room authority`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
   seed('${mode}');localStorage.setItem('unrelated','leave alone');await preparePair();const before=await rawBoth();countCrypto();
   try{const c=await preflight(),after=await rawBoth(),image=await Ordinary.openOrdinaryFrame(after[0].frame,after[0].key);
     return[c.rooms,c.identities,c.families.metadata,image.records.get(fixture.name)===fixture.raw,image.records.size,
       entropy,generated,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),
       Object.entries(localStorage),Object.keys(sessionStorage),after.every(row=>!row.key.extractable)];
   }finally{restoreCrypto()}
  })()`)).toEqual([0, 0, 1, true, 1, 0, 0, 0, true, [['unrelated', 'leave alone']], [], true])
  await context.close()
})
for (const fault of BOARD_CONTEXT_FAULTS) {
  test(`raw ${fault} holds before key creation or plaintext deletion`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
     seed();const rows=new Map(fixture.records);Ordinary.damageBoardContextFixture(fixture,rows,'${fault}');localStorage.clear();
     for(const[n,v]of rows)localStorage.setItem(n,v);const before=JSON.stringify(Object.entries(localStorage).sort());countCrypto();
     try{let held=false;try{await migrate()}catch(e){held=e.name==='OrdinaryStateHold'};
       return[held,entropy,generated,encryptions,before===JSON.stringify(Object.entries(localStorage).sort()),!(await rawBoth())[0]];
     }finally{restoreCrypto()}
    })()`)).toEqual([true, 0, 0, 0, true, true]); await context.close()
  })
  test(`retained ${fault} holds the complete native pair without rewriting either frame`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
     seed();await preparePair();const rows=new Map(fixture.records);Ordinary.damageBoardContextFixture(fixture,rows,'${fault}');
     await browserOwner.mutateMigrated(bScope,guard,b=>{b.remove(fixture.name);for(const[n,v]of rows)b.set(n,v)});
     const before=await rawBoth();countCrypto();try{let held=false;try{await preflight()}catch(e){held=e.name==='OrdinaryStateHold'};
       const after=await rawBoth();return[held,entropy,generated,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),Object.keys(localStorage)];
     }finally{restoreCrypto()}
    })()`)).toEqual([true, 0, 0, 0, true, []]); await context.close()
  })
}
for (const fault of ['tab', 'changed-image', 'added-image', 'deleted-image', 'revoked-scope', 'live-fence'] as const) {
  test(`${fault} cannot substitute a board context or escape native custody`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
     seed();await preparePair();const fault='${fault}';
     if(fault==='tab')await Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:browserOwner,scope:bScope},tab:{owner:tabOwner,scope:tScope},live:guard,
       work:(b,t)=>{t.set(fixture.name,b.get(fixture.name));b.remove(fixture.name)}});
     if(fault==='revoked-scope')await browserOwner.forget(bScope,guard,()=>false);
     const before=await rawBoth();if(fault==='live-fence')live=false;countCrypto();
     try{let held=false,burned=false;
       if(fault.endsWith('-image'))await Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:bScope},tab:{owner:tabOwner,scope:tScope},live:guard,
         work:(b,t,_bn,_tn,custody)=>{const bm=new Map(b.keys().map(n=>[n,b.get(n)])),tm=new Map(t.keys().map(n=>[n,t.get(n)])),original=new Map(bm),token=Ordinary.captureOrdinarySnapshotContext(bm,tm,custody);
           if(fault==='changed-image')bm.set(fixture.name,fixture.raw+' ');if(fault==='added-image')bm.set('kithmoot.board-context.v1.'+fixture.account+'.another',fixture.raw);if(fault==='deleted-image')bm.delete(fixture.name);
           try{Ordinary.validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},token)}catch(e){held=e.name==='OrdinaryStateHold'}
           try{Ordinary.validateOrdinarySnapshot(original,tm,{browser:true,tab:true},token)}catch(e){burned=e.name==='OrdinaryStateHold'}}});
       else{try{await preflight()}catch(e){held=e.name==='OrdinaryStateHold'}}
       const after=await rawBoth();return[held,fault.endsWith('-image')?burned:true,entropy,generated,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];
     }finally{restoreCrypto()}
    })()`)).toEqual([true, true, 0, 0, 0, true]); await context.close()
  })
}
