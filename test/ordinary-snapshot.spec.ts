import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { preflightProbe, noPreflightEffects } from './ordinary-preflight-probe.js'

// Actual cryptographic/storage writers precede a synthetic no-effect barrier.
// No mounted production root, live authority, replay or peer delivery claim.
const ORIGIN = 'https://ordinary-snapshot.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-snapshot.browser-entry.ts', import.meta.url))], bundle: true,
    format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
async function open(context: BrowserContext) {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); return page
}
const probe = preflightProbe + `
  const savedUUID=crypto.randomUUID,savedMath=Math.random;crypto.randomUUID=blocked('entropy');Math.random=blocked('entropy');
  const restoreAll=()=>{restore();crypto.randomUUID=savedUUID;Math.random=savedMath};
`
for (const mode of ['ordinary', 'named', 'past-zero', 'past-two', 'current', 'v1-ahead', 'quiet', 'quiet-epoch', 'quiet-overlap', 'quiet-named', 'quiet-control', 'quiet-logo', 'quiet-assignment', 'quiet-assignment-epoch', 'expired', 'reply', 'edit', 'reaction', 'retraction']) {
  test(`${mode} actual whole-image writers bind without native preflight effects`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
      const f=await Ordinary.snapshotFixture('${mode}');
      for(const[n,v]of f.browser)localStorage.setItem(n,v);for(const[n,v]of f.tab)sessionStorage.setItem(n,v);
      const before=JSON.stringify([[...f.browser],[...f.tab]]),stored=JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]);
      ${probe}
      try{const token=Ordinary.captureOrdinarySnapshotContext(f.browser,f.tab),c=Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},token);
        let burned=false;try{Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},token)}catch(e){burned=e.name==='OrdinaryStateHold'}
        return[c.rooms,c.identities,c.pendingRecords,c.quietRooms,burned,Object.isFrozen(c)&&Object.isFrozen(c.families),
          before===JSON.stringify([[...f.browser],[...f.tab]]),stored===JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]),f.published.length,effects];
      }finally{restoreAll();f.release()}
    })()`)).toEqual([1, 1, ['quiet-control', 'quiet-logo', 'quiet-assignment', 'quiet-assignment-epoch'].includes(mode) ? 0 : 1, mode.startsWith('quiet') ? 1 : 0, true, true, true, true, 0, noPreflightEffects])
    await context.close()
  })
}
for (const fault of ['root', 'device', 'channel', 'labels', 'name-repair', 'time-repair', 'unknown-plaintext', 'duplicate-json', 'credential-extra', 'tag-duplicate', 'durability', 'quiet-overlap-missing', 'quiet-overlap-changed', 'quiet-epoch', 'missing-expiration', 'orphan-epoch', 'quiet-counter-member', 'signed-nonhex-id', 'signed-short-id']) {
  test(`${fault} preserves native custody on whole-image hold`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
      const fault='${fault}',f=await Ordinary.snapshotFixture(fault==='missing-expiration'?'expired':fault==='orphan-epoch'?'current':fault.startsWith('quiet-')?'quiet-overlap':'ordinary');
      if(fault==='root')f.browser.delete(f.roomName);
      else if(fault==='device'){for(const n of [...f.browser.keys()])if(n.startsWith('kithmoot.device.')||n.startsWith('kithmoot.own-credential.'))f.browser.delete(n)}
      else if(fault==='durability'){f.tab.set(f.pendingName,f.browser.get(f.pendingName));f.browser.delete(f.pendingName)}
      else if(fault==='quiet-overlap-missing')f.browser.delete(f.quietName);
      else if(fault==='quiet-overlap-changed'||fault==='quiet-epoch'){const q=JSON.parse(f.browser.get(f.quietName));if(fault==='quiet-epoch')q.epoch=1;else q.queued[0]=f.resign(q.queued[0],v=>{v.text='Changed'});f.browser.set(f.quietName,JSON.stringify(q))}
      else if(fault==='orphan-epoch'){f.browser.delete(f.pendingName);for(const n of [...f.browser.keys()])if(n.startsWith('kithmoot.device.')||n.startsWith('kithmoot.own-credential.'))f.browser.delete(n)}
      else if(fault==='quiet-counter-member'){f.includeMember(f.device);f.tab.delete(f.pendingName);const q=JSON.parse(f.browser.get(f.quietName));q.queued=[];q.used={[f.device]:{epoch:500000,counters:[1]}};f.browser.set(f.quietName,JSON.stringify(q))}
      else{const rows=JSON.parse(f.browser.get(f.pendingName)),r=rows[0];
        if(fault==='channel')r.channel='tasks';if(fault==='labels')delete r.artwork;
        if(fault==='name-repair')r.event=f.resign(r.event,v=>{v.name='\\u0000Hidden'});
        if(fault==='time-repair')r.event=f.resign(r.event,v=>{v.sentAtMs=1});
        if(fault==='unknown-plaintext')r.event=f.resign(r.event,v=>{v.extra=true});
        if(fault==='credential-extra')r.event=f.resign(r.event,v=>{v.credential.extra=true});
        if(fault==='duplicate-json')r.event=f.resign(r.event,()=>{},s=>'{'+'"id":"shadow",'+s.slice(1));
        if(fault==='tag-duplicate'){r.event.tags.push(['d',f.roomId]);r.event=f.sign(r.event)}
        if(fault==='missing-expiration'){r.event.tags=r.event.tags.filter(t=>t[0]!=='expiration');r.event=f.sign(r.event)}
        if(fault==='signed-nonhex-id'||fault==='signed-short-id'){r.id=fault==='signed-nonhex-id'?'not-hex':'a'.repeat(31);r.event=f.resign(r.event,v=>{v.id=r.id})}
        f.browser.set(f.pendingName,JSON.stringify(rows))}
      for(const[n,v]of f.browser)localStorage.setItem(n,v);for(const[n,v]of f.tab)sessionStorage.setItem(n,v);
      const before=JSON.stringify([[...f.browser],[...f.tab]]),stored=JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]);
      ${probe}
      try{const token=Ordinary.captureOrdinarySnapshotContext(f.browser,f.tab);let held=false,burned=false;
        try{Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},token)}catch(e){held=e.name==='OrdinaryStateHold'}
        try{Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},token)}catch(e){burned=e.name==='OrdinaryStateHold'}
        return[held,burned,before===JSON.stringify([[...f.browser],[...f.tab]]),stored===JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]),effects];
      }finally{restoreAll();f.release()}
    })()`)).toEqual([true, true, true, true, noPreflightEffects]); await context.close()
  })
}
test('native startup root survives history scrub only when captured first', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    const f=await Ordinary.snapshotFixture();f.browser.delete(f.roomName);history.replaceState(null,'',new URL(f.url).hash);${probe}
    try{const token=Ordinary.captureOrdinarySnapshotContext(f.browser,f.tab);history.replaceState(null,'','/j/');
      const c=Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},token);let late=false;
      try{Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},Ordinary.captureOrdinarySnapshotContext(f.browser,f.tab))}catch(e){late=e.name==='OrdinaryStateHold'}
      return[c.pendingRecords,location.hash,late,effects];
    }finally{restoreAll();f.release()}
  })()`)).toEqual([1, '', true, noPreflightEffects]); await context.close()
})
for (const fault of ['changed', 'added', 'deleted', 'signal']) test(`${fault} reserved native image burns the capture`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    const f=await Ordinary.snapshotFixture(),fault='${fault}';if(fault==='signal')f.browser.set('kithmoot-mls-vault-v1.revision','11111111-1111-4111-8111-111111111111');
    ${probe}
    try{const original=new Map(f.browser),token=Ordinary.captureOrdinarySnapshotContext(f.browser,f.tab);
      if(fault==='changed')f.browser.set(f.pendingName,f.browser.get(f.pendingName)+' ');if(fault==='added')f.browser.set('kithmoot.textSize','large');
      if(fault==='deleted')f.browser.delete(f.roomName);if(fault==='signal')f.browser.set('kithmoot-mls-vault-v1.revision','22222222-2222-4222-8222-222222222222');
      let held=false,burned=false;try{Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},token)}catch(e){held=e.name==='OrdinaryStateHold'}
      try{Ordinary.validateOrdinarySnapshot(original,f.tab,{browser:false,tab:false},token)}catch(e){burned=e.name==='OrdinaryStateHold'}return[held,burned,effects];
    }finally{restoreAll();f.release()}
  })()`)).toEqual([true, true, noPreflightEffects]); await context.close()
})
for (const fault of ['assignment-main', 'assignment-control', 'assignment-malformed', 'assignment-label', 'logo-main', 'logo-missing', 'control-text', 'control-repair', 'unknown-channel', 'assignment-text']) {
  test(`${fault} holds independently queued native protocol custody`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
      const fault='${fault}',mode=fault.startsWith('logo-')?'quiet-logo':fault.startsWith('control-')?'quiet-control':fault==='unknown-channel'?'quiet-unknown':fault==='assignment-text'?'quiet-assignment-text':'quiet-assignment';
      const f=await Ordinary.snapshotFixture(mode),q=JSON.parse(f.browser.get(f.quietName));
      if(fault==='assignment-main'||fault==='logo-main')q.queued[0]=f.rechannel(q.queued[0],undefined);
      if(fault==='assignment-control')q.queued[0]=f.rechannel(q.queued[0],'control');
      if(fault==='assignment-malformed')q.queued[0]=f.resign(q.queued[0],v=>{v.assignment={}});
      if(fault==='assignment-label')q.queued[0]=f.resign(q.queued[0],v=>{v.text='Assignment stop'});
      if(fault==='logo-missing')q.queued[0]=f.resign(q.queued[0],v=>{delete v.roomLogo});
      if(fault==='control-text')q.queued[0]=f.resign(q.queued[0],v=>{v.text='Ordinary text'});
      if(fault==='control-repair')q.queued[0]=f.resign(q.queued[0],v=>{v.text=JSON.stringify({op:'hand',up:true,extra:true})});
      f.browser.set(f.quietName,JSON.stringify(q));for(const[n,v]of f.browser)localStorage.setItem(n,v);
      const stored=JSON.stringify(Object.entries(localStorage));${probe}
      try{const token=Ordinary.captureOrdinarySnapshotContext(f.browser,f.tab);let held=false;
        try{Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},token)}catch(e){held=e.name==='OrdinaryStateHold'}
        return[held,stored===JSON.stringify(Object.entries(localStorage)),effects];
      }finally{restoreAll();f.release()}
    })()`)).toEqual([true, true, noPreflightEffects]); await context.close()
  })
}
for (const cut of ['outbox-only', 'history-overlap', 'history-only']) test(`${cut} assignment native custody preserves producer ordering`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    const f=await Ordinary.snapshotFixture('quiet-assignment-epoch'),cut='${cut}';
    if(cut!=='history-overlap')f.browser.delete(f.quietName);
    if(cut!=='outbox-only')f.mutateAssignmentJournal(j=>{j.events.push(j.outbox[0].inner);if(cut==='history-only')j.outbox=[]});
    ${probe}
    try{const c=Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},Ordinary.captureOrdinarySnapshotContext(f.browser,f.tab));return[c.quietRooms,c.pendingRecords,effects]}
    finally{restoreAll();f.release()}
  })()`)).toEqual([cut === 'history-overlap' ? 1 : 0, 0, noPreflightEffects]); await context.close()
})
for (const fault of ['queue-only', 'substituted-outer', 'wrong-account', 'wrong-room', 'duplicate-match', 'duplicate-history', 'mismatched-inner', 'inner-extra', 'outer-extra']) {
  test(`${fault} native assignment linkage holds exact source bytes`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
      const f=await Ordinary.snapshotFixture('quiet-assignment'),fault='${fault}';
      if(fault==='queue-only')f.browser.delete(f.assignmentName);
      else if(fault==='wrong-account'||fault==='wrong-room'){const value=f.browser.get(f.assignmentName);f.browser.delete(f.assignmentName);f.browser.set(fault==='wrong-account'?f.assignmentName.replace(f.participant,'a'.repeat(64)):f.assignmentName.slice(0,-64)+'a'.repeat(64),value)}
      else f.mutateAssignmentJournal(j=>{
        if(fault==='substituted-outer')j.outbox[0].outer=f.resign(j.outbox[0].outer,v=>{v.id='f'.repeat(32)});
        if(fault==='duplicate-match')j.outbox.push(j.outbox[0]);if(fault==='duplicate-history')j.events.push(j.outbox[0].inner,j.outbox[0].inner);
        if(fault==='mismatched-inner')j.outbox[0].inner={...j.outbox[0].inner,content:'{}'};
        if(fault==='inner-extra')j.outbox[0].inner.extra=true;if(fault==='outer-extra')j.outbox[0].outer.extra=true;
      });
      for(const[n,v]of f.browser)localStorage.setItem(n,v);const before=JSON.stringify([[...f.browser],[...f.tab]]),stored=JSON.stringify(Object.entries(localStorage));${probe}
      try{let held=false;try{Ordinary.validateOrdinarySnapshot(f.browser,f.tab,{browser:false,tab:false},Ordinary.captureOrdinarySnapshotContext(f.browser,f.tab))}catch(e){held=e.name==='OrdinaryStateHold'}
        return[held,before===JSON.stringify([[...f.browser],[...f.tab]]),stored===JSON.stringify(Object.entries(localStorage)),effects];
      }finally{restoreAll();f.release()}
    })()`)).toEqual([true, true, true, noPreflightEffects]); await context.close()
  })
}
