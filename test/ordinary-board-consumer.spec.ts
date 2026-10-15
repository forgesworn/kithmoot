import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-board-consumer.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({entryPoints:[fileURLToPath(new URL('./ordinary-board-consumer.browser-entry.ts',import.meta.url))],
    bundle:true,format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022',
    loader:{'.css':'text'},define:{'import.meta.env.BASE_URL':'"/"'}})).outputFiles[0]!.text
})
const setup = `async()=>{
 window.fixture=Ordinary.boardContextFixture();window.live=true;window.account=fixture.account;window.generation=1;window.stops=0;
 window.guard=()=>live;window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabPurpose='tab:'+'a'.repeat(64);
 window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,Date.now()+3600_000);
 const migration={phase:'complete',sources:new Map(),names:[]};await browserOwner.prepare(guard,fixture.records,migration);await tabOwner.prepare(guard,new Map(),migration);
 window.clients=async()=>{if(window.clientHook)await clientHook()};
 window.options=()=>({browser:browserOwner,tab:tabOwner,account:fixture.account,generation:1,currentGeneration:()=>generation,currentAccount:()=>account,
   live:()=>live&&(!window.popup||!popup.closed),checkClients:clients,stop:()=>{stops++}});
 window.state=await Ordinary.OrdinaryBoardContextState.open(options());
 window.rawBoth=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);
   r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose);
     tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}});
 window.rows=async()=>Promise.all((await rawBoth()).map(row=>Ordinary.openOrdinaryFrame(row.frame,row.key)));
 window.edit=async work=>{const b=await browserOwner.capture('@fixture',guard),t=await tabOwner.capture('@fixture',guard);
   return Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:browserOwner,scope:b},tab:{owner:tabOwner,scope:t},live:guard,work})};
 window.result=async pending=>{try{await pending;return'ok'}catch(e){return e.name}};
 window.countCrypto=()=>{window.entropy=0;window.encryptions=0;const r=crypto.getRandomValues.bind(crypto),e=crypto.subtle.encrypt.bind(crypto.subtle);
   crypto.getRandomValues=(...a)=>{entropy++;return r(...a)};crypto.subtle.encrypt=(...a)=>{encryptions++;return e(...a)};
   window.restoreCrypto=()=>{crypto.getRandomValues=r;crypto.subtle.encrypt=e}};
}`
async function open(context: BrowserContext) {
  await context.route(ORIGIN+'/**',r=>r.fulfill({status:200,contentType:'text/html',body:r.request().url().includes('/girnel/')?
    '<!doctype html><script>window.girnelEmbed={start:async host=>{window.host=host},prepareMove:async()=>{},hasPendingEdits:()=>false}</script>':
    '<!doctype html><button id="homeWork">Boards</button><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>'}))
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate('('+setup+')()');return page
}
test('actual protected consumer saves only captured canonical writer bytes and retains other accounts',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{
   const other=fixture.name.replace(fixture.account,'4'.repeat(64));await edit((b,t)=>b.set(other,fixture.raw));
   const value=await state.read(fixture.boardId);value.boardName=' New board ';value.cardId='never persist';
   let release;window.clientHook=()=>new Promise(r=>{release=r});const pending=state.save(value);value.boardName='caller changed';value.project.name='caller changed';
   await Promise.resolve();release();delete window.clientHook;await pending;
   const [b,t]=await rows(),row=JSON.parse(b.records.get(fixture.name));await state.close();
   return[row.boardName,row.project.name,row.cardId??null,b.records.get(other)===fixture.raw,b.records.size,t.records.size,Object.keys(localStorage),Object.keys(sessionStorage)];
 })()`)).toEqual(['New board','Project',null,true,2,0,[],[]]);await c.close()
})
const panelSetup = `async()=>{
 await state.close();window.session={pubkey:fixture.account,method:'nip07',signer:{pubkey:fixture.account,method:'nip07',capabilities:{canSignEvents:true,hasNip44:true},
   nip44:{encrypt:async()=>{throw Error('unexpected signer')},decrypt:async()=>{throw Error('unexpected signer')}},signEvent:async()=>{throw Error('unexpected signer')},close:async()=>{throw Error('host close')}}};
 window.panel=new Ordinary.BoardsPanel(document,{session:()=>session,contexts:async(who,current,stop)=>Ordinary.OrdinaryBoardContextState.open({...options(),live:()=>live&&current(),stop}),
   projects:()=>[{id:'personal-project',name:'Project'}],rooms:()=>[{id:'personal-room',name:'Chat'}],currentRoom:()=>({id:'personal-room',name:'Chat'}),currentProject:()=>({id:'personal-project',name:'Project'}),
   signIn:()=>{},roomTasks:()=>{},newRoomTask:async()=>{},roomInvitation:()=>{throw Error('unexpected room capability')},discuss:async()=>{throw Error('unexpected discussion')},showChat:()=>{},roomBoards:()=>[],shareBoard:async()=>{throw Error('unexpected sharing')}});
 panel.open(document.getElementById('homeWork'));
 window.child=()=>document.querySelector('iframe').contentWindow;
}`
for (const mode of ['automatic','association'] as const) test(`${mode} panel save cannot commit after a board switch during its client fence`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate('('+panelSetup+')()');await p.waitForFunction('window.child()?.host');await p.waitForFunction('!panel.hasPendingEdits')
 if(mode==='association'){
   await p.evaluate(`child().host.onBoard({boardId:fixture.boardId,name:JSON.parse(fixture.raw).boardName})`)
   await expect(p.locator('#boardsContext')).toContainText('Board')
   await p.waitForFunction('!panel.hasPendingEdits')
 }
 await p.evaluate(`(()=>{window.beforeSelection=undefined;window.selectionCalls=0;let started;window.selectionBegan=new Promise(r=>{started=r});
   window.clientHook=async()=>{selectionCalls++;if(selectionCalls===('${mode}'==='automatic'?2:1)){started();await new Promise(r=>{window.releaseSelection=r})}}})()`)
 await p.evaluate(`(async()=>{window.beforeSelection=await rawBoth();countCrypto()})()`)
 if(mode==='automatic')await p.evaluate(`child().host.onBoard({boardId:fixture.boardId,name:'Pending automatic'})`)
 else{await p.locator('#boardsProject').selectOption('');await p.locator('#boardsRoom').selectOption('');await p.locator('#boardsAssociate').click()}
 await p.evaluate('selectionBegan')
 expect(await p.evaluate(`(async()=>{const host=child().host;host.onBoard({boardId:'new-selection',name:'New selection'});releaseSelection();delete window.clientHook;await panel.reset();
   const after=await rawBoth();restoreCrypto();return[after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,beforeSelection[i].frame)),entropy,encryptions,host.signal.aborted,Object.keys(localStorage)]})()`))
   .toEqual([true,0,0,true,[]]);await c.close()
})
test('actual panel awaits the native provider before adopting and saving personal labels',async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate('('+panelSetup+')()')
 await p.waitForFunction('window.child()?.host');await p.waitForFunction('!panel.hasPendingEdits')
 await p.evaluate(`child().host.onBoard({boardId:'panel-board',name:'Native Board',cardId:'private-card'})`)
 await expect(p.locator('#boardsContext')).toHaveText('KithMoot · Project · Chat · Native Board')
 await p.locator('#boardsProject').selectOption('');await p.locator('#boardsRoom').selectOption('');await p.locator('#boardsAssociate').click()
 await expect(p.locator('#boardsStatus')).toHaveText('Labels saved on this browser. Board membership is unchanged.')
 expect(await p.evaluate(`(async()=>{const [b]=await rows(),name='kithmoot.board-context.v1.'+fixture.account+'.panel-board',raw=b.records.get(name);await panel.reset();
   return[JSON.parse(raw),b.records.get(fixture.name)===fixture.raw,Object.keys(localStorage),Object.keys(sessionStorage)]})()`))
   .toEqual([{boardId:'panel-board',boardName:'Native Board'},true,[],[]]);await c.close()
})
test('actual panel reset joins a blocked native read and cannot revive a changed account',async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate('('+panelSetup+')()');await p.waitForFunction('window.child()?.host');await p.waitForFunction('!panel.hasPendingEdits')
 expect(await p.evaluate(`(async()=>{
   const host=child().host,before=await rawBoth();let release,started;const began=new Promise(r=>{started=r});window.clientHook=()=>{started();return new Promise(r=>{release=r})};
   host.onBoard({boardId:'late-board',name:'Late'});await began;session={...session};let ended=false;const closing=panel.reset().then(()=>{ended=true});
   await Promise.resolve();const waited=!ended;release();delete window.clientHook;await closing;const after=await rawBoth();
   return[waited,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),document.querySelectorAll('iframe').length,Object.keys(localStorage)];
 })()`)).toEqual([true,true,0,[]]);await c.close()
})
test('actual popup uses native context custody and closing it refuses a late label save',async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate('('+panelSetup+')()');await p.waitForFunction('window.child()?.host');await p.waitForFunction('!panel.hasPendingEdits')
 await p.evaluate(`child().host.onBoard({boardId:'popup-board',name:'Popup'})`)
 await expect(p.locator('#boardsContext')).toContainText('Popup')
 const opened=p.waitForEvent('popup');await p.locator('#boardsPopOut').click();const popup=await opened
 await popup.waitForFunction('document.querySelector("iframe")?.contentWindow?.host')
 await p.waitForFunction('!panel.hasPendingEdits')
 expect(await p.evaluate(`(async()=>{
   const win=window.frames.length;const before=await rawBoth();let release,started;const began=new Promise(r=>{started=r});window.clientHook=()=>{started();return new Promise(r=>{release=r})};
   window.pendingNative=began;window.releaseNative=()=>{release();delete window.clientHook};window.beforePopup=before;return[win,Object.keys(localStorage)];
 })()`)).toEqual([0,[]])
 await popup.evaluate(`document.querySelector('iframe').contentWindow.host.onBoard({boardId:'popup-board',name:'Late popup'})`)
 await p.evaluate('pendingNative');await popup.close()
 expect(await p.evaluate(`(async()=>{panel.sync();let ended=false;const closing=panel.reset().then(()=>{ended=true});await Promise.resolve();const waited=!ended;
   releaseNative();await closing;const after=await rawBoth();return[waited,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,beforePopup[i].frame))]})()`)).toEqual([true,true]);await c.close()
})
for(const fault of ['account','generation','live','closed','scope','malformed','tab','successor','missing-read','getter','overlap'] as const)
test(`${fault} refuses native context access before encryption and preserves both frames`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{
   const fault='${fault}',value=JSON.parse(fixture.raw);
   if(fault!=='missing-read')await state.read(fixture.boardId);
   if(fault==='account')account='4'.repeat(64);if(fault==='generation')generation=2;if(fault==='live')live=false;if(fault==='closed')state.revoke();
   if(fault==='scope'){const scope=await browserOwner.capture('board-context:'+fixture.account,guard);await browserOwner.forget(scope,guard,()=>false)}
   if(fault==='malformed')await edit((b,t)=>b.set(fixture.name,fixture.raw+' '));
   if(fault==='tab')await edit((b,t)=>{t.set(fixture.name,b.get(fixture.name));b.remove(fixture.name)});
   if(fault==='successor')await edit((b,t)=>{const row=JSON.parse(fixture.raw);row.boardName='Other view';b.set(fixture.name,JSON.stringify(row))});
   let reads=0;if(fault==='getter')Object.defineProperty(value,'boardName',{enumerable:true,get(){reads++;return'Getter'}});
   let release,first;if(fault==='overlap'){window.clientHook=()=>new Promise(r=>{release=r});first=result(state.read(fixture.boardId))}
   const before=await rawBoth();countCrypto();try{const outcome=await result(state.save(value));if(first){release();delete window.clientHook;await first}
     const after=await rawBoth();return[outcome,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),reads,stops];
   }finally{restoreCrypto();await state.close()}
 })()`)).toEqual(['OrdinaryStateHold',0,0,true,0,1]);await c.close()
})
for(const cut of ['account','generation','close','popup','reentrant-close'] as const)
test(`${cut} during an awaited client fence revokes pending writes and joins close`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{
   const value=await state.read(fixture.boardId);value.boardName='Pending';const before=await rawBoth();let release,started;
   let reentrantEnded=false,reentrantClose;
   const began=new Promise(r=>{started=r});window.clientHook=()=>{if('${cut}'==='reentrant-close'){state.revoke();reentrantClose=state.close().then(()=>{reentrantEnded=true})};started();return new Promise(r=>{release=r})};
   if('${cut}'==='popup')window.popup=window.open('/popup','_blank');
   countCrypto();try{const pending=result(state.save(value));await began;
     if('${cut}'==='account')account='4'.repeat(64);if('${cut}'==='generation')generation=2;if('${cut}'==='close')state.revoke();if('${cut}'==='popup')popup.close();
     let ended=false;const closing=state.close().then(()=>{ended=true});await Promise.resolve();const waited=!ended&&!reentrantEnded;release();delete window.clientHook;
     const outcome=await pending;await closing;await reentrantClose;const after=await rawBoth();return[outcome,waited,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];
   }finally{restoreCrypto()}
 })()`)).toEqual(['OrdinaryStateHold',true,0,0,true]);await c.close()
})
test('a changed raw tab image blocks opening before any consumer reads or writes',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{
   await state.close();await edit((b,t)=>t.set('kithmoot.future','private'));const before=await rawBoth();countCrypto();
   try{const outcome=await result(Ordinary.OrdinaryBoardContextState.open(options())),after=await rawBoth();
     return[outcome,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]}
   finally{restoreCrypto()}
 })()`)).toEqual(['OrdinaryStateHold',0,0,true]);await c.close()
})
test('awaited native catalogue listing excludes other accounts and preserves the frames',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{await edit(b=>b.set(fixture.name.replace(fixture.account,'4'.repeat(64)),fixture.raw));const before=await rawBoth();countCrypto();const values=await state.list();
  values[0].boardName='Caller mutation';const after=await rawBoth();restoreCrypto();await state.close();return[values.length,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),entropy,encryptions]})()`))
  .toEqual([1,true,0,0]);await c.close()
})
test('new onBoards catalogue callback captures names before native awaits and renders native saved navigation',async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate('('+panelSetup+')()');await p.waitForFunction('window.child()?.host');await p.waitForFunction('!panel.hasPendingEdits')
 await p.evaluate(`(()=>{let started;window.catalogueStarted=new Promise(r=>started=r);let release;const gate=new Promise(r=>release=r);window.releaseCatalogue=()=>{release();delete window.clientHook};
  window.clientHook=()=>{started();return gate};window.chosen=[{boardId:'catalogue-one',name:'Captured one',ended:false},{boardId:'catalogue-two',name:'Captured two',ended:true}];
  child().host.onBoards(chosen)})()`);await p.evaluate('catalogueStarted');await p.evaluate(`chosen[0].name='Late caller mutation';releaseCatalogue()`)
 await p.waitForFunction('!panel.hasPendingEdits');await expect(p.locator('#boardsSaved')).toContainText('Captured one')
 expect(await p.evaluate(`(async()=>{const[b]=await rows();const one=JSON.parse(b.records.get('kithmoot.board-context.v1.'+fixture.account+'.catalogue-one'));await panel.reset();return[one,Object.keys(localStorage)]})()`))
  .toEqual([{boardId:'catalogue-one',boardName:'Captured one'},[]]);await c.close()
})
test('account supersession joins catalogue and navigation reads without publishing late labels',async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate('('+panelSetup+')()');await p.waitForFunction('window.child()?.host');await p.waitForFunction('!panel.hasPendingEdits')
 expect(await p.evaluate(`(async()=>{const before=await rawBoth();let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);window.clientHook=()=>{started();return gate};
  child().host.onBoards([{boardId:'late-catalogue',name:'Late',ended:false}]);await began;generation++;account='4'.repeat(64);session={...session};let done=false;const closing=panel.reset().then(()=>done=true);
  await Promise.resolve();const waited=!done;release();delete window.clientHook;await closing;const after=await rawBoth();return[waited,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),document.querySelector('#boardsSaved').children.length]})()`))
  .toEqual([true,true,0]);await c.close()
})
for(const fault of ['caller-mutation','board-switch'] as const)test(`${fault} across the share boundary preserves the selected board or refuses its publication`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate('('+panelSetup+')()');await p.waitForFunction('window.child()?.host');await p.waitForFunction('!panel.hasPendingEdits')
 await p.evaluate(`child().host.onBoard({boardId:'shared-selected',name:'Selected'})`);await expect(p.locator('#boardsContext')).toContainText('Selected');await p.waitForFunction('!panel.hasPendingEdits')
 expect(await p.evaluate(`(async()=>{window.publications=[];panel.options.shareBoard=async(room,board)=>publications.push({room,board});let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  window.clientHook=()=>{started();return gate};const chosen={boardId:'shared-selected',name:'Selected'},share=child().host.roomShare();const pending=share.publish(chosen,'https://girnel.test/app/#'+'a'.repeat(100)).then(()=> 'ok',e=>e.name);
  await began;if('${fault}'==='caller-mutation')chosen.boardId='substituted';else child().host.onBoard({boardId:'different',name:'Different'});
  release();delete window.clientHook;const result=await pending;await panel.reset();return[result,publications.map(p=>p.board.boardId)]})()`))
  .toEqual(fault==='caller-mutation'?['ok',['shared-selected']]:['Error',[]]);await c.close()
})
for(const owner of ['browserOwner','tabOwner'] as const)test(`${owner} close joins account enumeration before its first native read`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{const before=await rawBoth();let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);window.clientHook=()=>{started();return gate};
  const pending=state.list().then(()=> 'ok',e=>e.name);await began;let ended=false;const closing=${owner}.close().then(()=>ended=true);await Promise.resolve();await new Promise(r=>setTimeout(r,30));
  const waited=!ended;release();delete window.clientHook;const error=await pending;await closing;await state.close();const after=await rawBoth();return[waited,error,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
  .toEqual([true,'OrdinaryStateHold',true]);await c.close()
})
for(const phase of ['destination-before-create','same-board-refresh'] as const)test(`${phase} keeps a current board share while fencing actual board switches`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate('('+panelSetup+')()');await p.waitForFunction('window.child()?.host');await p.waitForFunction('!panel.hasPendingEdits')
 expect(await p.evaluate(`(async()=>{window.publications=[];panel.options.shareBoard=async(room,board)=>publications.push(board.boardId);let destination;
  if('${phase}'==='destination-before-create')destination=child().host.roomShare();child().host.onBoard({boardId:'created-board',name:'Created'});
  while(panel.hasPendingEdits)await new Promise(r=>setTimeout(r,10));destination??=child().host.roomShare();let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  window.clientHook=()=>{started();return gate};const pending=destination.publish({boardId:'created-board',name:'Created'},'https://girnel.test/app/#'+'a'.repeat(100)).then(()=> 'ok',e=>e.name);
  await began;if('${phase}'==='same-board-refresh')child().host.onBoard({boardId:'created-board',name:'Refreshed'});release();delete window.clientHook;const result=await pending;await panel.reset();return[result,publications]})()`))
  .toEqual(['ok',['created-board']]);await c.close()
})
