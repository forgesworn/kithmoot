import {build} from 'esbuild'
import {expect,test,type BrowserContext} from '@playwright/test'
import {fileURLToPath} from 'node:url'
import {roomBoardNativeSetup} from './ordinary-room-board-native-fixture.js'
const ORIGIN='https://ordinary-room-board-catalogue.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-room-board-storage.browser-entry.ts',import.meta.url))],bundle:true,
 format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text})
const consumerSetup=`()=>{
 window.channelMessages=[];window.listener=undefined;window.channels=0;window.sent=[];window.chatSent=[];window.changes=0;window.reports=[];window.transportMode='normal';window.channelRelease=undefined;window.channelEntered=undefined;
 window.room={roomId,participant:account,channel:()=>{channels++;return{messages:()=>channelMessages,onChange:fn=>{listener=fn;return()=>{listener=undefined}},
  send:async text=>{sent.push(text);if(transportMode==='channel-fail'&&text.includes('"op":"share"'))throw Error('channel refused');
   if(transportMode==='channel-hold'&&text.includes('"op":"share"')){channelEntered();await new Promise(r=>channelRelease=r)}}}},
  chat:{send:async text=>{chatSent.push(text);if(transportMode==='chat-fail')throw Error('chat refused')}}};
 window.makeCatalogue=()=>new Ordinary.RoomBoards(room,{custody:store,current:()=>live&&currentRoom===roomId&&selectedSession===options.session&&generation===0,
  changed:()=>changes++,report:error=>reports.push(error.name)});window.catalogue=makeCatalogue();
 window.receiveBoard=()=>{const value={id:String(channelMessages.length),text:Ordinary.encodeRoomBoard(board),sentAt:Date.now()/1000};channelMessages.push(value);listener?.();return value};
 window.beginShare=()=>{window.receipt='pending';window.started=new Promise(r=>entered=r);window.pending=catalogue.share(board).then(()=>receipt='success',error=>receipt=error.name)};
}`
async function open(context:BrowserContext){await context.route(ORIGIN+'/**',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>'}));const p=await context.newPage();await p.goto(ORIGIN);await p.evaluate('('+roomBoardNativeSetup+')()');await p.evaluate('('+consumerSetup+')()');return p}
test('actual native custody commits a selected catalogue before synthetic channel/chat delivery and exposes detached rows',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{await catalogue.open();await catalogue.share(board);const loaded=await store.load(),raw=await cached(),visible=catalogue.boards;visible[0].name='alias';
  const result=[loaded,catalogue.boards,sent.length,chatSent.length,raw.includes(board.invitation),walletEncrypt,walletDecrypt,startsUnderLock.every(Boolean)];await catalogue.close();await login.close();return result})()`))
 .toEqual([[{...{boardId:'native-board',name:'Board'},invitation:'https://girnel.test/app/#'+'c'.repeat(100)}],[{boardId:'native-board',name:'Board',invitation:'https://girnel.test/app/#'+'c'.repeat(100)}],2,1,false,1,2,true]);await c.close()
})
for(const fault of ['legacy','wrong-room','bad-mac'] as const)test(`${fault} load cannot install a listener or emit a catalogue request`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{await store.close();live=true;let plaintext='${fault}'==='legacy'?JSON.stringify([board]):Ordinary.encodeOrdinaryRoomBoardChunks([board],account,'d'.repeat(64))[0];
  let cipher=Ordinary.encrypt(plaintext,Ordinary.getConversationKey(key,account));if('${fault}'==='bad-mac')cipher=cipher.slice(0,20)+(cipher[20]==='A'?'B':'A')+cipher.slice(21);
  await seed(browserOwner,{[name]:JSON.stringify({chunks:[cipher]})});store=await openStore();catalogue=makeCatalogue();const before=await rawRows();let error;try{await catalogue.open()}catch(e){error=e.name};
  const after=await rawRows();const result=[error,channels,sent.length,changes,catalogue.boards,listener===undefined,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];await catalogue.close();await login.close();return result})()`))
 .toEqual([fault==='bad-mac'?'Error':'OrdinaryStateHold',0,0,0,[],true,true]);await c.close()
})
for(const fault of ['generation','room','session','sdk','browser-forget','tab-forget','unknown'] as const)test(`${fault} before share refuses disclosure and preserves native bytes`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{await catalogue.open();sent=[];if('${fault}'==='generation')generation++;if('${fault}'==='room')currentRoom='d'.repeat(64);if('${fault}'==='session')selectedSession={...selectedSession};
  if('${fault}'==='sdk')await seed(browserOwner,{[k.clientSk]:'01'.repeat(32)});if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner);if('${fault}'==='unknown')await seed(browserOwner,{'kithmoot.unknown-private':'keep'});
  const before=await rawRows();countCrypto();let error;try{await catalogue.share(board)}catch(e){error=e.name};const after=await rawRows();restoreCrypto();const result=[typeof error==='string',sent.length,chatSent.length,catalogue.boards,walletEncrypt,walletDecrypt,entropy,encryptions,
   after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];await catalogue.close();await login.close();return result})()`))
 .toEqual([true,0,0,[],0,0,0,0,true]);await c.close()
})
for(const fault of ['catalogue-close','store-close','browser-close','tab-close','generation','room','sdk','browser-forget','tab-forget'] as const)
test(`${fault} during wallet save joins the whole consumer and prevents channel/chat disclosure`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate("(async()=>{await catalogue.open();sent=[];behaviour='encrypt-hold';beginShare()})()");await p.evaluate('started')
 await p.evaluate(`(async()=>{window.closeDone=false;if('${fault}'==='catalogue-close')void(window.closing=catalogue.close().then(()=>closeDone=true));if('${fault}'==='store-close')void(window.closing=store.close().then(()=>closeDone=true));
  if('${fault}'==='browser-close')void(window.closing=browserOwner.close().then(()=>closeDone=true));if('${fault}'==='tab-close')void(window.closing=tabOwner.close().then(()=>closeDone=true));if('${fault}'==='generation')generation++;if('${fault}'==='room')currentRoom='d'.repeat(64);
  if('${fault}'==='sdk')await seed(browserOwner,{[k.clientSk]:'01'.repeat(32)});if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner)})()`)
 expect(await p.evaluate('[receipt,closeDone,nativeHeld,sent.length,chatSent.length,catalogue.boards]')).toEqual(['pending',false,0,0,0,[]])
 await p.evaluate('release();pending');if(fault.endsWith('close'))await p.evaluate('closing');await p.evaluate('catalogue.close()')
 expect(await p.evaluate(`(async()=>[receipt!=='success',sent.length,chatSent.length,await cached(),walletEncrypt,walletDecrypt])()`)).toEqual([true,0,0,null,1,0]);await c.close()
})
for(const fault of ['channel-fail','chat-fail'] as const)test(`${fault} after ACK leaves a durable exact grant for explicit retry`,async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{await catalogue.open();transportMode='${fault}';let error;try{await catalogue.share(board)}catch(e){error=e.message};const retained=await cached(),visible=catalogue.boards;
  transportMode='normal';await catalogue.share(board);const loaded=await store.load();const result=[!!error,retained!==null,visible[0].name,loaded[0].invitation,chatSent.length];await catalogue.close();await login.close();return result})()`))
 .toEqual([true,true,'Board','https://girnel.test/app/#'+'c'.repeat(100),fault==='chat-fail'?2:1]);await c.close()
})
test('owner close during an unabortable synthetic channel send joins it and suppresses announcement',async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate("(async()=>{await catalogue.open();sent=[];transportMode='channel-hold';window.channelStarted=new Promise(r=>channelEntered=r);beginShare()})()");await p.evaluate('channelStarted')
 await p.evaluate('window.closeDone=false;void(window.closing=tabOwner.close().then(()=>closeDone=true))')
 expect(await p.evaluate('[receipt,closeDone,chatSent.length,nativeHeld]')).toEqual(['pending',false,0,0]);await p.evaluate('channelRelease();pending');await p.evaluate('closing');await p.evaluate('catalogue.close()')
 expect(await p.evaluate('[receipt!=="success",chatSent.length]')).toEqual([true,0]);await c.close()
})
test('incoming catalogue stays invisible until native ACK and mutable message data is detached',async({browser})=>{
 const c=await browser.newContext(),p=await open(c);await p.evaluate("(async()=>{await catalogue.open();behaviour='encrypt-hold';window.started=new Promise(r=>entered=r);window.message=receiveBoard()})()");await p.evaluate('started')
 expect(await p.evaluate('[catalogue.boards,changes]')).toEqual([[],1]);await p.evaluate("message.text=Ordinary.encodeRoomBoard({...board,name:'Changed'});release()")
 await p.waitForFunction('catalogue.boards.length===1')
 expect(await p.evaluate(`(async()=>{const loaded=await store.load();await catalogue.close();await login.close();return[loaded[0].name,loaded[0].invitation]})()`)).toEqual(['Board','https://girnel.test/app/#'+'c'.repeat(100)]);await c.close()
})
test('open drains preloaded and newly arriving history through ACK before exposing readiness',async({browser})=>{
 const c=await browser.newContext(),p=await open(c)
 await p.evaluate(`(()=>{channelMessages.push({id:'old',text:Ordinary.encodeRoomBoard(board),sentAt:Date.now()/1000});behaviour='encrypt-hold';window.started=new Promise(r=>entered=r);
  window.receipt='pending';window.pending=catalogue.open().then(()=>receipt='ready',e=>receipt=e.name)})()`);await p.evaluate('started')
 expect(await p.evaluate('[receipt,catalogue.boards,changes,sent.length]')).toEqual(['pending',[],0,0])
 await p.evaluate(`channelMessages.push({id:'new',text:Ordinary.encodeRoomBoard({...board,boardId:'second'}),sentAt:Date.now()/1000});listener();behaviour='normal';release();pending`)
 expect(await p.evaluate(`(async()=>{const visible=catalogue.boards,loaded=await store.load();await catalogue.close();await login.close();return[receipt,visible.length,loaded.length,sent.length]})()`))
 .toEqual(['ready',2,2,1]);await c.close()
})
test('initial history capacity refusal rejects open with no request, UI, entropy or rewritten source',async({browser})=>{
 test.setTimeout(90000);const c=await browser.newContext(),p=await open(c)
 expect(await p.evaluate(`(async()=>{const[b]=await images(),scope=await browserOwner.capture('@capacity',()=>true);await browserOwner.mutateMigrated(scope,()=>true,s=>{for(let i=0;i<Ordinary.ORDINARY_RECORDS-b.records.size;i++)s.set('kithmoot.nudge.'+i.toString(16).padStart(64,'0'),'true')});
  channelMessages.push({id:'old',text:Ordinary.encodeRoomBoard(board),sentAt:Date.now()/1000});const before=await rawRows();countCrypto();let error;try{await catalogue.open()}catch(e){error=e.name};
  const after=await rawRows();restoreCrypto();const result=[error,catalogue.boards,changes,sent.length,listener===undefined,walletEncrypt,walletDecrypt,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];await catalogue.close();await login.close();return result})()`))
 .toEqual(['OrdinaryStateHold',[],0,0,true,0,0,0,0,true]);await c.close()
})
