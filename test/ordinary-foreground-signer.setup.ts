export const foregroundSignerSetup = `async()=>{
 window.live=true;window.generation=0;window.stops=0;window.signs=0;window.crypts=0;window.rawCloses=0;window.nativeHeld=0;window.startsUnderLock=[];
 window.guard=()=>live;window.key=new Uint8Array(32);key[31]=1;window.account=Ordinary.getPublicKey(key);window.k=Ordinary.ORDINARY_SIGNET_KEYS;
 const request=navigator.locks.request.bind(navigator.locks);
 navigator.locks.request=(name,...args)=>{const callback=args.pop();return request(name,...args,async lock=>{
   if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld++;
   try{return await callback(lock)}finally{if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld--}})};
 window.behaviour='normal';window.entered=null;window.release=null;window.accessors=0;
 window.sign=async event=>{
   signs++;startsUnderLock.push(nativeHeld>0);
   if(behaviour==='retry'&&signs===1)throw Error('Request failed');
   if(behaviour==='hold'){entered();await new Promise(resolve=>release=resolve)}
   const result=Ordinary.finalizeEvent(event,key);
   if(behaviour==='accessor-result'){const sig=result.sig;Object.defineProperty(result,'sig',{get(){accessors++;return sig}});return result};
   if(behaviour==='wrong-event')return Ordinary.finalizeEvent({...event,content:'substituted'},key);
   if(behaviour==='bad-signature')return {...result,sig:'0'.repeat(128)};
   if(behaviour==='wrong-account'){const other=new Uint8Array(32);other[31]=2;return Ordinary.finalizeEvent(event,other)};
   return result
 };
 window.cryptoProvider={encrypt:async function(peer,text){crypts++;startsUnderLock.push(nativeHeld>0);if(this!==cryptoProvider)throw Error('lost receiver');
   if(behaviour==='hold'){entered();await new Promise(resolve=>release=resolve)}return 'encrypted:'+text},
   decrypt:async function(peer,text){crypts++;startsUnderLock.push(nativeHeld>0);if(this!==cryptoProvider)throw Error('lost receiver');
   if(behaviour==='hold'){entered();await new Promise(resolve=>release=resolve)}return text.slice('encrypted:'.length)}};
 window.nostr={getPublicKey:async()=>account,signEvent:event=>sign(event),nip04:cryptoProvider,nip44:cryptoProvider};
 window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabPurpose='tab:'+'a'.repeat(64);
 window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,Date.now()+3600_000);
 await browserOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
 await tabOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
 window.storage=await Ordinary.OrdinarySignetState.open({owner:browserOwner,generation:0,currentGeneration:()=>generation,live:guard,
   origin:location.origin,appName:'KithMoot',checkClients:async()=>{},stop:()=>{stops++;live=false}});
 window.rawSession=await Ordinary.login({preferredMethod:'nip07',appName:'KithMoot',storage});signs=0;startsUnderLock=[];
 window.selected=rawSession;window.clientChecks=0;window.clientFailure=false;window.clientHook=()=>{};
 window.selectionHook=()=>{};
 window.options={browser:browserOwner,tab:tabOwner,session:rawSession,currentSession:()=>{selectionHook();return selected},generation:0,currentGeneration:()=>generation,
   live:guard,checkClients:async()=>{clientChecks++;await clientHook();if(clientFailure)throw Error('old client')},stop:()=>{stops++;live=false}};
 window.adapter=await Ordinary.OrdinaryForegroundSigner.open(options);
 window.event=()=>({kind:1,created_at:Math.floor(Date.now()/1000),tags:[['t','original']],content:'native message'});
 window.seed=async changes=>{const scope=await browserOwner.capture('@test-seed',()=>true);await browserOwner.mutateMigrated(scope,()=>true,store=>{
   for(const[name,value]of Object.entries(changes)){if(value===null)store.remove(name);else store.set(name,value)}})};
 window.forget=async owner=>{const scope=await owner.capture('@ordinary-signet',()=>true);await owner.forget(scope,()=>true,()=>false)};
 window.rawRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
   const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose);
   tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}});
 window.begin=()=>{window.receipt='pending';window.result=null;window.started=new Promise(resolve=>entered=resolve);
   window.pending=adapter.signEvent(event()).then(value=>{result=value;receipt='success'},error=>receipt=error.name)};
 window.makeDeferred=async(kind='deferred',captureCopies=false)=>{
   await adapter.close();live=true;stops=0;window.upgradeReady=new Promise(resolve=>window.upgrade=resolve);
   const authEvent=rawSession.authEvent,uri='bunker://'+'b'.repeat(64)+'?relay=wss%3A%2F%2Frelay.test';
   window.backend={signEvent:event=>sign(event),nip04Encrypt:async()=>'',nip04Decrypt:async()=>'',nip44Encrypt:async()=>'',nip44Decrypt:async()=>'',
     getPublicKey:async()=>account,provisionRendezvous:async()=>'',ping:async()=>{},switchRelays:async()=>true,logout:async()=>{},close:async()=>{rawCloses++}};
   window.bunker=new Ordinary.BunkerSignerImpl(account,backend,uri,key);
   window.deferred=new Ordinary.DeferredBunkerSigner(account,authEvent,upgradeReady,uri,key);
   window.deferredCalled=false;const original=deferred.signEvent;deferred.signEvent=function(...args){deferredCalled=true;return original.apply(this,args)};
   for(const family of ['nip04','nip44'])for(const method of ['encrypt','decrypt']){const original=deferred[family][method];deferred[family][method]=function(...args){deferredCalled=true;return original.apply(this,args)}};
   rawSession={pubkey:account,method:'bunker',signer:kind==='live'?bunker:deferred,authEvent};selected=rawSession;
   await seed({[k.method]:'bunker',[k.bunkerUri]:uri,[k.bunkerClientSk]:Array.from(key,b=>b.toString(16).padStart(2,'0')).join('')});
   options={...options,session:rawSession};
   const slice=Uint8Array.prototype.slice;window.ownedCopies=[];
   if(captureCopies)Uint8Array.prototype.slice=function(...args){const copy=slice.apply(this,args);if(this===key)ownedCopies.push(copy);return copy};
   try{adapter=await Ordinary.OrdinaryForegroundSigner.open(options)}finally{Uint8Array.prototype.slice=slice};
 };
}`
