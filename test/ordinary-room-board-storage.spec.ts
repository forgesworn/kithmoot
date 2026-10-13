import {build} from 'esbuild'
import {expect,test,type BrowserContext} from '@playwright/test'
import {fileURLToPath} from 'node:url'
const ORIGIN='https://ordinary-room-board-storage.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-room-board-storage.browser-entry.ts',import.meta.url))],bundle:true,
 format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text})
const setup=`async()=>{
 window.live=true;window.generation=0;window.roomId='b'.repeat(64);window.currentRoom=roomId;window.stops=0;window.walletEncrypt=0;window.walletDecrypt=0;window.nativeHeld=0;window.startsUnderLock=[];
 window.key=new Uint8Array(32);key[31]=1;window.account=Ordinary.getPublicKey(key);window.k=Ordinary.ORDINARY_SIGNET_KEYS;window.behaviour='normal';window.entered=null;window.release=null;
 const locks=navigator.locks.request.bind(navigator.locks);navigator.locks.request=(name,...args)=>{const callback=args.pop();return locks(name,...args,async lock=>{
  if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld++;try{return await callback(lock)}finally{if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld--}})};
 window.nostr={getPublicKey:async()=>account,signEvent:async event=>Ordinary.finalizeEvent(event,key),nip44:{
  encrypt:async(peer,text)=>{walletEncrypt++;startsUnderLock.push(nativeHeld>0);if(behaviour==='encrypt-hold'){entered();await new Promise(r=>release=r)}
   if(behaviour==='wrong-round-trip')text=text+' ';return Ordinary.encrypt(text,Ordinary.getConversationKey(key,peer))},
  decrypt:async(peer,text)=>{walletDecrypt++;startsUnderLock.push(nativeHeld>0);if(behaviour==='decrypt-hold'){entered();await new Promise(r=>release=r)}
   if(behaviour==='oversized-decrypt')return 'x'.repeat(20001);if(behaviour==='wrong-decrypt')return '[]';return Ordinary.decrypt(text,Ordinary.getConversationKey(key,peer))}}};
 window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabPurpose='tab:'+'a'.repeat(64);window.tabExpiry=Date.now()+3600_000;window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);
 const migration={phase:'complete',sources:new Map(),names:[]};await browserOwner.prepare(()=>live,new Map(),migration);await tabOwner.prepare(()=>live,new Map(),migration);
 window.clientFailure=false;window.clientHook=async()=>{};window.rootOptions={browser:browserOwner,tab:tabOwner,generation:0,currentGeneration:()=>generation,live:()=>live,
  checkClients:async()=>{await clientHook();if(clientFailure)throw Error('old client')},stop:()=>{live=false}};
 window.login=await Ordinary.OrdinaryInitialLogin.open(rootOptions);window.selectedSession=await login.loginExtension();
 window.currentHook=()=>{};window.options={...rootOptions,session:selectedSession,roomId,current:()=>{currentHook();return{session:selectedSession,roomId:currentRoom}},stop:()=>{stops++;live=false}};
 window.openStore=()=>Ordinary.OrdinaryRoomBoardStorage.open(options);window.store=await openStore();await store.load();
 window.board={boardId:'native-board',name:' Board ',invitation:'https://girnel.test/app/#'+'c'.repeat(100)};
 window.name='kithmoot.room-boards.v1.'+account+'.'+roomId;
 window.rawRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
  const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose);tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}});
 window.images=async()=>Promise.all((await rawRows()).map(row=>Ordinary.openOrdinaryFrame(row.frame,row.key)));
 window.seed=async(owner,changes)=>{const scope=await owner.capture('@test-seed',()=>true);await owner.mutateMigrated(scope,()=>true,s=>{for(const[n,v]of Object.entries(changes)){if(v===null)s.remove(n);else s.set(n,v)}})};
 window.forget=async owner=>{const scope=await owner.capture('room:'+roomId,()=>true);await owner.forget(scope,()=>true,()=>false)};
 window.cached=async()=>{const[b]=await images();return b.records.get(name)??null};
 window.begin=()=>{window.receipt='pending';window.result=null;window.started=new Promise(r=>entered=r);window.pending=store.save([board]).then(value=>{result=value;receipt='success'},error=>receipt=error.name)};
 window.countCrypto=()=>{window.entropy=0;window.encryptions=0;const r=crypto.getRandomValues.bind(crypto),e=crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.getRandomValues=(...a)=>{entropy++;return r(...a)};crypto.subtle.encrypt=(...a)=>{encryptions++;return e(...a)};window.restoreCrypto=()=>{crypto.getRandomValues=r;crypto.subtle.encrypt=e}};
}`
async function open(context:BrowserContext){await context.route(ORIGIN+'/**',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>'}));const p=await context.newPage();await p.goto(ORIGIN);await p.evaluate('('+setup+')()');return p}
test('native store round-trips account/room-bound real NIP44 chunks and acknowledges exact opaque custody',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{await store.save([board]);const raw=await cached(),loaded=await store.load(),[b,t]=await images();
  const answer=[loaded,raw.includes(board.invitation),raw.includes('native-board'),walletEncrypt,walletDecrypt,startsUnderLock.every(Boolean),Object.isFrozen(loaded),Object.isFrozen(loaded[0]),
   b.fences.has('room:'+roomId),t.fences.has('room:'+roomId),Object.keys(localStorage),Object.keys(sessionStorage)];await store.close();await login.close();return answer})()`))
 .toEqual([[{boardId:'native-board',name:'Board',invitation:'https://girnel.test/app/#'+'c'.repeat(100)}],false,false,1,2,true,true,true,true,true,[],[]]);await c.close()
})
for(const fault of ['generation','room','session','client','sdk','browser-forget','tab-forget','unknown'] as const)test(`${fault} prevents save before wallet or native control entropy`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{if('${fault}'==='generation')generation++;if('${fault}'==='room')currentRoom='d'.repeat(64);if('${fault}'==='session')selectedSession={...selectedSession};if('${fault}'==='client')clientFailure=true;
  if('${fault}'==='sdk')await seed(browserOwner,{[k.clientSk]:'01'.repeat(32)});if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner);
  if('${fault}'==='unknown')await seed(browserOwner,{'kithmoot.unclassified-private':'keep'});const before=await rawRows();countCrypto();let error;try{await store.save([board])}catch(e){error=e.name};
  const after=await rawRows();restoreCrypto();await store.close();await login.close();return[error,walletEncrypt,walletDecrypt,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
 .toEqual([fault==='client'?'Error':'OrdinaryStateHold',0,0,0,0,true]);await c.close()
})
for(const stage of ['encrypt','decrypt'] as const)for(const fault of ['close','browser-close','tab-close','generation','room','row-change','sdk','browser-forget','tab-forget','client'] as const)
test(`${fault} during ${stage} joins its provider and preserves the original catalogue`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 await p.evaluate(`behaviour='${stage}-hold';begin()`);await p.evaluate('started')
 await p.evaluate(`(async()=>{window.closeDone=false;window.beforeCache=await cached();if('${fault}'==='close')void(window.closing=store.close().then(()=>closeDone=true));
  if('${fault}'==='browser-close')void(window.closing=browserOwner.close().then(()=>closeDone=true));if('${fault}'==='tab-close')void(window.closing=tabOwner.close().then(()=>closeDone=true));
  if('${fault}'==='generation')generation++;if('${fault}'==='room')currentRoom='d'.repeat(64);if('${fault}'==='row-change'){const chunks=Ordinary.encodeOrdinaryRoomBoardChunks([board],account,roomId).map(t=>Ordinary.encrypt(t,Ordinary.getConversationKey(key,account)));await seed(browserOwner,{[name]:JSON.stringify({chunks})});beforeCache=await cached()}
  if('${fault}'==='sdk')await seed(browserOwner,{[k.clientSk]:'01'.repeat(32)});if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner);if('${fault}'==='client')clientFailure=true})()`)
 expect(await p.evaluate('[receipt,closeDone,nativeHeld]')).toEqual(['pending',false,0])
 await p.evaluate('release();pending');await p.evaluate('store.close()');if(fault.endsWith('close'))await p.evaluate('closing')
 expect(await p.evaluate(`(async()=>[receipt,result,(await cached())===beforeCache,walletEncrypt,walletDecrypt])()`))
 .toEqual([fault==='client'?'Error':'OrdinaryStateHold',null,true,1,stage==='decrypt'?1:0]);await c.close()
})
for(const fault of ['legacy','wrong-room','wrong-account','mixed-set','bad-mac'] as const)test(`${fault} restoration holds without rewriting or returning a grant`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{await store.close();live=true;stops=0;const other='d'.repeat(64);let values=Ordinary.encodeOrdinaryRoomBoardChunks([board],account,roomId);
  if('${fault}'==='legacy')values=[JSON.stringify([board])];if('${fault}'==='wrong-room')values=Ordinary.encodeOrdinaryRoomBoardChunks([board],account,other);
  if('${fault}'==='wrong-account')values=Ordinary.encodeOrdinaryRoomBoardChunks([board],other,roomId);if('${fault}'==='mixed-set'){const row=JSON.parse(values[0]);row.count=2;values=[JSON.stringify(row),JSON.stringify({...row,index:1,catalogue:'f'.repeat(64)})]};
  const chunks=values.map(t=>Ordinary.encrypt(t,Ordinary.getConversationKey(key,account)));if('${fault}'==='bad-mac'){const s=chunks[0];chunks[0]=s.slice(0,20)+(s[20]==='A'?'B':'A')+s.slice(21)};
  await seed(browserOwner,{[name]:JSON.stringify({chunks})});const before=await rawRows();store=await openStore();let error,value;try{value=await store.load()}catch(e){error=e.name};const after=await rawRows();await store.close();await login.close();return[error,value??null,walletEncrypt,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
 .toEqual([fault==='bad-mac'?'Error':'OrdinaryStateHold',null,0,true]);await c.close()
})
test('wallet round-trip mismatch cannot retain the candidate',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{behaviour='wrong-round-trip';let error;try{await store.save([board])}catch(e){error=e.name};const raw=await cached();await store.close();await login.close();return[error,raw,walletEncrypt,walletDecrypt]})()`))
 .toEqual(['OrdinaryStateHold',null,1,1]);await c.close()
})
test('full native capacity holds before new fences or any wallet request',async({browser})=>{
 test.setTimeout(90000);const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{const[b]=await images(),scope=await browserOwner.capture('@capacity',()=>true);await browserOwner.mutateMigrated(scope,()=>true,s=>{for(let i=0;i<Ordinary.ORDINARY_RECORDS-b.records.size;i++)s.set('kithmoot.nudge.'+i.toString(16).padStart(64,'0'),'true')});
  const before=await rawRows();countCrypto();let error;try{await store.save([board])}catch(e){error=e.name};const after=await rawRows();restoreCrypto();await store.close();await login.close();return[error,walletEncrypt,walletDecrypt,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
 .toEqual(['OrdinaryStateHold',0,0,0,0,true]);await c.close()
})
for(const fault of ['row-change','browser-forget','tab-forget','capacity','sdk','unknown'] as const)
test(`${fault} between initial SDK read and actual provider start refuses wallet entropy`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{let calls=0,changed=false;window.beforeCache=null;clientHook=async()=>{if(++calls===4){changed=true;
  // Store preflight/control reservation and the SDK's initial narrowed read
  // have finished. This hook is the actual SDK boundary's client check.
  const[b,t]=await images();if(!b.fences.has('room:'+roomId)||!t.fences.has('room:'+roomId))throw Error('wrong phase');
  if('${fault}'==='row-change'){const chunks=Ordinary.encodeOrdinaryRoomBoardChunks([board],account,roomId).map(t=>Ordinary.encrypt(t,Ordinary.getConversationKey(key,account)));await seed(browserOwner,{[name]:JSON.stringify({chunks})})};
  if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner);
  if('${fault}'==='sdk')await seed(browserOwner,{[k.clientSk]:'01'.repeat(32)});if('${fault}'==='unknown')await seed(browserOwner,{'kithmoot.unclassified-private':'keep'});
  if('${fault}'==='capacity'){const[b]=await images(),scope=await browserOwner.capture('@capacity',()=>true);await browserOwner.mutateMigrated(scope,()=>true,s=>{for(let i=0;i<Ordinary.ORDINARY_RECORDS-b.records.size;i++)s.set('kithmoot.nudge.'+i.toString(16).padStart(64,'0'),'true')})};beforeCache=await cached()}};
  let error;try{await store.save([board])}catch(e){error=e.name};const preserved=(await cached())===beforeCache;await store.close();await login.close();return[error,walletEncrypt,walletDecrypt,changed,calls,preserved]})()`))
 .toEqual(['OrdinaryStateHold',0,0,true,4,true]);await c.close()
})
test('multi-chunk native catalogue saves and restores through the actual SDK',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{const boards=Array.from({length:50},(_,i)=>({...board,boardId:String(i).padStart(2,'0'),invitation:'https://girnel.test/app/#'+'c'.repeat(1700)}));
  await store.save(boards);const raw=await cached(),count=JSON.parse(raw).chunks.length,loaded=await store.load();await store.close();await login.close();
  return[count>1,JSON.stringify(loaded)===JSON.stringify(Ordinary.captureOrdinaryRoomBoards(boards)),walletEncrypt===count,walletDecrypt===2*count,startsUnderLock.every(Boolean),raw.includes(boards[0].invitation)]})()`))
 .toEqual([true,true,true,true,true,false]);await c.close()
})
test('descriptor-backed board fields refuse before their accessors, control or wallet entropy',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{let calls=0;Object.defineProperty(board,'name',{get(){calls++;return 'changed'}});const before=await rawRows();countCrypto();let error;
  try{await store.save([board])}catch(e){error=e.name};const after=await rawRows();restoreCrypto();await store.close();await login.close();
  return[error,calls,walletEncrypt,walletDecrypt,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
 .toEqual(['OrdinaryStateHold',0,0,0,0,0,true]);await c.close()
})
test('concurrent save holds the catalogue and joins the already started provider',async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate("behaviour='encrypt-hold';begin()");await p.evaluate('started')
 expect(await p.evaluate(`(async()=>{let error;try{await store.save([board])}catch(e){error=e.name};return[error,receipt,walletEncrypt,walletDecrypt]})()`))
 .toEqual(['OrdinaryStateHold','pending',1,0]);await p.evaluate('release();pending')
 expect(await p.evaluate(`(async()=>[receipt,await cached()])()`)).toEqual(['OrdinaryStateHold',null]);await c.close()
})
for(const fault of ['session-copy','not-loaded'] as const)test(`${fault} cannot borrow native room catalogue authority`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{await store.close();live=true;const before=await rawRows();let error;try{
  if('${fault}'==='session-copy')await Ordinary.OrdinaryRoomBoardStorage.open({...options,session:{...selectedSession}});
  else{store=await openStore();await store.save([board])}}catch(e){error=e.name};const after=await rawRows();await store.close();await login.close();
  return[error,walletEncrypt,walletDecrypt,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
 .toEqual(['OrdinaryStateHold',0,0,true]);await c.close()
})
test('oversized wallet plaintext stops at the first chunk without rewriting the retained catalogue',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{const boards=Array.from({length:50},(_,i)=>({...board,boardId:String(i).padStart(2,'0'),invitation:'https://girnel.test/app/#'+'c'.repeat(1700)}));
  await store.save(boards);const before=await rawRows(),raw=await cached();walletDecrypt=0;behaviour='oversized-decrypt';let error,value;
  try{value=await store.load()}catch(e){error=e.name};const after=await rawRows();await store.close();await login.close();
  return[error,value??null,walletDecrypt,(await cached())===raw,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
 .toEqual(['OrdinaryStateHold',null,1,true,true]);await c.close()
})
test('first multi-chunk round-trip mismatch stops further decrypts and cannot retain',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{const boards=Array.from({length:50},(_,i)=>({...board,boardId:String(i).padStart(2,'0'),invitation:'https://girnel.test/app/#'+'c'.repeat(1700)}));
  behaviour='wrong-decrypt';let error;try{await store.save(boards)}catch(e){error=e.name};const raw=await cached();await store.close();await login.close();return[error,raw,walletEncrypt>1,walletDecrypt]})()`))
 .toEqual(['OrdinaryStateHold',null,true,1]);await c.close()
})
test('the first selection callback cannot change pre-captured board fields',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{let once=false;currentHook=()=>{if(!once){once=true;board.name='Changed';board.invitation='https://girnel.test/app/#'+'d'.repeat(100)}};
  await store.save([board]);const loaded=await store.load();await store.close();await login.close();return[once,loaded,walletEncrypt,walletDecrypt]})()`))
 .toEqual([true,[{boardId:'native-board',name:'Board',invitation:'https://girnel.test/app/#'+'c'.repeat(100)}],1,2]);await c.close()
})
test('a selector reentering save holds both calls before native or wallet entropy',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{let once=false,nested,nestedError;const before=await rawRows();countCrypto();currentHook=()=>{if(!once){once=true;nested=store.save([board]).catch(e=>nestedError=e.name)}};
  let error;try{await store.save([board])}catch(e){error=e.name};await nested;const after=await rawRows();restoreCrypto();await store.close();await login.close();
  return[error,nestedError,walletEncrypt,walletDecrypt,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
 .toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,0,0,0,true]);await c.close()
})
