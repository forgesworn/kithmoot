export const setup = `async (options={}) => {
  window.live=true;window.guard=()=>live;window.now=Math.floor(Date.now()/1000)
  window.secret=new Uint8Array(32).fill(31);window.roomId=Ordinary.deriveRoom(secret).roomId
  window.inviterSk=new Uint8Array(32);inviterSk[31]=7
  window.participantSk=options.participantSk?Uint8Array.from(options.participantSk):Ordinary.generateSecretKey()
  window.identity=Ordinary.localIdentity(participantSk);window.participant=identity.pubkey
  window.account=options.visitor?null:participant;window.keep=options.keep!==false
  window.invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(17),Ordinary.getPublicKey(inviterSk),true)
  window.id=Ordinary.deriveInvitationId(invitation);window.invScopeName='invitation:'+participant+':'+id;window.prefix=Ordinary.accountPrefix(participant)
  window.url=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:['wss://hint.example/'],iceUrls:[],name:'Fresh group'})
  window.tabPurpose=options.tabPurpose??'tab:'+'a'.repeat(64);window.tabExpiry=Date.now()+3600_000
  window.credentialExpiresAt=now+1800;window.signCalls=0;window.unsigned=undefined
  window.signer=identity.signEvent;identity.signEvent=function(event){if(this!==identity)throw Error('lost provider this');signCalls++;unsigned=structuredClone(event)
    return window.signHook?signHook(event):signer.call(this,event)}
  window.current={account,participant,invitationId:id,link:url,keep,credentialExpiresAt,identity}
  window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
  const migration={phase:'complete',sources:new Map(),names:[]}
  await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration)
  if(account===null){const scope=await browserOwner.capture('@ordinary-participant',guard);await browserOwner.mutateMigrated(scope,guard,b=>b.set('kithmoot.participant',Ordinary.bytesToHex(participantSk)))}
  window.event=Ordinary.encodePersistentInvitation({invitation,inviterSk,roomSecret:secret,now,
    ...(options.noEnds?{}:{endsAt:now+3600,destruct:true}),...(options.noRelays?{}:{relays:['wss://signed.example/']})})
  const relay=new Ordinary.SimRelay({replay:true});relay.publish(event)
  const query=await Ordinary.requestPersistentRoomAdmissionEvidence({transport:new Ordinary.SimTransport(relay),invitation})
  window.evidence=query.evidence;query.outcome.admission.secret.fill(0)
  window.open=()=>Ordinary.OrdinaryPersistentBootstrap.open({browser:browserOwner,tab:tabOwner,invitation,account,identity,link:url,keep,
    credentialExpiresAt,current:()=>window.current,live:guard})
  window.bootstrap=await open();window.start=()=>bootstrap.bootstrap(evidence)
  window.rawBoth=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose)
      tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}})
  window.images=async()=>Promise.all((await rawBoth()).map(row=>Ordinary.openOrdinaryFrame(row.frame,row.key)))
  window.records=async()=>(await images()).map(image=>[...image.records])
  window.outcome=async work=>{try{const result=await work();Ordinary.wipeOrdinaryPersistentBootstrapResult(result);return 'ok'}catch(e){return e.name}}
  window.scopes=async()=>({b:await browserOwner.capture('invitation:'+participant+':'+id,guard),t:await tabOwner.capture('invitation:'+participant+':'+id,guard)})
  window.pair=async work=>{const s=await scopes();return Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard,work})}
  window.preflight=async()=>{const s=await scopes();return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard,
    work:(b,t,_bn,_tn,custody)=>{const bm=new Map(b.keys().map(n=>[n,b.get(n)])),tm=new Map(t.keys().map(n=>[n,t.get(n)]))
      return Ordinary.validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},Ordinary.captureOrdinarySnapshotContext(bm,tm,custody))}})}
  window.countCrypto=()=>{window.entropy=0;window.encryptions=0;const random=crypto.getRandomValues.bind(crypto),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.getRandomValues=(...args)=>{entropy++;return random(...args)};crypto.subtle.encrypt=(...args)=>{encryptions++;return encrypt(...args)}
    window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.encrypt=encrypt}}
  window.gateSigner=()=>{window.releaseSigner=undefined;window.signing=false;window.signHook=event=>{signing=true;return new Promise(resolve=>{
    window.releaseSigner=()=>resolve(signer.call(identity,event))})}}
  window.proofName=prefix+Ordinary.PERSISTENT_PROOF_V2_PREFIX+id+'.'+tabPurpose.slice(4)
  window.tabProofName=prefix+Ordinary.PERSISTENT_TAB_PROOF_V2_PREFIX+id
}`

// Additional native custody is installed only as an explicit test fixture.
// Every credential and source event is actually signed and independently
// verified; no fixture claims production bootstrap/signing authorisation.
export const actorFixture = `async (actorBytes, bearerBytes=Array.from(invitation.bearer)) => {
  const actorSk=Uint8Array.from(actorBytes),actor=Ordinary.getPublicKey(actorSk),actorPrefix=Ordinary.accountPrefix(actor)
  const cap=Ordinary.roomInvitation(Uint8Array.from(bearerBytes),Ordinary.getPublicKey(inviterSk),true),capId=Ordinary.deriveInvitationId(cap)
  const name='invitation:'+actor+':'+capId,bScope=await browserOwner.capture(name,guard),tScope=await tabOwner.capture(name,guard)
  const roomScope=await browserOwner.capture('room:'+roomId,guard)
  const device=Ordinary.generateSecretKey(),seal=Ordinary.generateSecretKey()
  const credential=await Ordinary.createDeviceCredential({identity:Ordinary.localIdentity(actorSk),devicePubkey:Ordinary.getPublicKey(device),roomId,
    expiresAt:credentialExpiresAt,now:()=>now,seal:Ordinary.getPublicKey(seal)})
  const source=Ordinary.encodePersistentInvitation({invitation:cap,inviterSk,roomSecret:secret,now,endsAt:now+3600,destruct:true,relays:['wss://signed.example/']})
  const relay=new Ordinary.SimRelay({replay:true});relay.publish(source)
  const query=await Ordinary.requestPersistentRoomAdmissionEvidence({transport:new Ordinary.SimTransport(relay),invitation:cap})
  const admission=query.outcome.admission,link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation:cap,relays:['wss://hint.example/'],iceUrls:[]})
  try {
    await Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:browserOwner,scope:bScope},tab:{owner:tabOwner,scope:tScope},live:guard,
      work:(b,t,_bn,_tn,custody)=>{
        const map=store=>({get:n=>store.get(actorPrefix+n),set:(n,v)=>store.set(actorPrefix+n,v),remove:n=>store.remove(actorPrefix+n),keys:()=>store.keys().filter(n=>n.startsWith(actorPrefix)).map(n=>n.slice(actorPrefix.length))})
        b.set(actorPrefix+Ordinary.DEVICE_PREFIX+roomId,JSON.stringify({sk:Ordinary.bytesToHex(device),at:now}))
        b.set(actorPrefix+'kithmoot.device-owner.'+roomId,JSON.stringify({account:actor,roomId}))
        Ordinary.storeOwnCredentialFor(map(b),roomId,credential,seal)
        Ordinary.rememberRoom(map(b),{roomId,link,openedAt:now,endsAt:now+3600,destruct:true});Ordinary.setKeepRoom(map(b),roomId,true)
        Ordinary.storeKeptAdmission(map(b),capId,admission,now);Ordinary.storeTabAdmission(map(t),cap,admission)
        b.set(Ordinary.FIXED_INVITATION_RELAYS,JSON.stringify({[roomId]:{c:['wss://signed.example/'],signed:true}}))
        const verified=Ordinary.makePersistentAdmissionProof({invitation:cap,evidence:query.evidence,account:actor,participant:actor,browser:bScope,
          tab:{...tScope,purpose:tabPurpose,expiresAt:tabExpiry},deviceCustody:{owner:'browser',scope:roomScope},
          device:Ordinary.persistentAdmissionDeviceInPair(b,t,roomId,actor,actor,'browser'),keep:true,now,expectedRoomSecret:secret})
        try {b.set(Ordinary.persistentProofName(verified.proof.binding),JSON.stringify(verified.proof));t.set(Ordinary.persistentTabProofName(verified.proof.binding),Ordinary.tabProofBytes(verified.proof))}
        finally{verified.admission.secret.fill(0)}
      }})
    return {actor,prefix:actorPrefix,invitationId:capId,scopeName:name,link}
  } finally { actorSk.fill(0);device.fill(0);seal.fill(0);admission.secret.fill(0);cap.bearer.fill(0) }
}`
