export const roomBoardNativeSetup=`async()=>{
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
