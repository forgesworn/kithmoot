export const setup = `async (options={}) => {
  window.now=Math.floor(Date.now()/1000);window.live=true;window.guard=()=>live
  window.secret=new Uint8Array(32).fill(31);window.roomId=Ordinary.deriveRoom(secret).roomId
  window.inviterSk=new Uint8Array(32);inviterSk[31]=7
  window.participantSk=Ordinary.generateSecretKey();window.identity=Ordinary.localIdentity(participantSk);window.participant=identity.pubkey
  window.account=options.visitor?null:participant;window.keep=options.keep!==false
  window.invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(17),Ordinary.getPublicKey(inviterSk),true)
  window.id=Ordinary.deriveInvitationId(invitation);window.prefix=Ordinary.accountPrefix(participant)
  window.current={account,participant,invitationId:id,roomId,keep}
  window.tabPurpose='tab:'+'a'.repeat(64);window.tabExpiry=Date.now()+(options.leaseMs??3600_000)
  const migration={phase:'complete',sources:new Map(),names:[]}
  window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
  await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration)
  window.devices=await Ordinary.OrdinaryRoomDeviceState.open({owner:browserOwner,account:participant,roomId,
    current:()=>({account:participant,roomId}),live:guard})
  window.deviceSk=await devices.deviceKey(now);window.seal=new Uint8Array(32);seal[31]=23
  window.credential=await Ordinary.createDeviceCredential({identity,devicePubkey:Ordinary.getPublicKey(deviceSk),roomId,
    expiresAt:now+7200,now:()=>now,seal:Ordinary.getPublicKey(seal)})
  await devices.retainOwnCredential(credential,seal)
  window.roomScope=await browserOwner.capture('room:'+roomId,guard)
  window.url=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:['wss://hint.example/'],iceUrls:[],name:'Prepared group'})
  await browserOwner.mutateMigrated(roomScope,guard,store=>{
    if(account===null)store.set('kithmoot.participant',Ordinary.bytesToHex(participantSk))
    const scoped={get:n=>store.get(prefix+n),set:(n,v)=>store.set(prefix+n,v),remove:n=>store.remove(prefix+n),
      keys:()=>store.keys().filter(n=>n.startsWith(prefix)).map(n=>n.slice(prefix.length))}
    Ordinary.rememberRoom(scoped,{roomId,link:url,openedAt:now});Ordinary.setKeepRoom(scoped,roomId,keep)
  })
  window.event=Ordinary.encodePersistentInvitation({invitation,inviterSk,roomSecret:secret,now,
    ...(options.noRelays?{}:{relays:['wss://signed.example/']}),...(options.noEnds?{}:{endsAt:now+3600,destruct:true})})
  window.replay=(events=[event],eose=true)=>{const relay=new Ordinary.SimRelay({replay:true});for(const e of events)relay.publish(e)
    const transport=new Ordinary.SimTransport(relay)
    if(!eose){const sub=transport.subscribe.bind(transport);transport.subscribe=(filters,onEvent)=>sub(filters,onEvent)}
    return transport}
  window.rawBoth=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose)
      tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}})
  window.images=async()=>Promise.all((await rawBoth()).map(row=>Ordinary.openOrdinaryFrame(row.frame,row.key)))
  window.records=async()=> (await images()).map(image=>[...image.records])
  window.outcome=async work=>{try{await work();return 'ok'}catch(e){return e.name}}
  window.open=()=>Ordinary.OrdinaryPersistentAdmission.open({browser:browserOwner,tab:tabOwner,invitation,account,participant,roomId,
    expectedRoomSecret:secret,keep,live:guard,current:()=>current})
  window.member=await open()
  window.proofName=prefix+Ordinary.PERSISTENT_PROOF_PREFIX+id+'.'+tabPurpose.slice(4)
  window.tabProofName=prefix+Ordinary.PERSISTENT_TAB_PROOF_PREFIX+id
  window.request=()=>member.request(replay(),now)
  window.preflight=async()=>{const bScope=await browserOwner.capture('invitation:'+id,guard),tScope=await tabOwner.capture('invitation:'+id,guard)
    return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:bScope},tab:{owner:tabOwner,scope:tScope},live:guard,
      work:(b,t,_bn,_tn,custody)=>{const browser=new Map(b.keys().map(n=>[n,b.get(n)])),tab=new Map(t.keys().map(n=>[n,t.get(n)]))
        const context=Ordinary.captureOrdinarySnapshotContext(browser,tab,custody)
        return Ordinary.validateOrdinarySnapshot(browser,tab,{browser:true,tab:true},context)}})}
}`
