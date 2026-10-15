export const leaseFixture = `async options=>{
  await bootstrap.close()
  if(options.foregroundMs!==undefined){
    await identity.close()
    const sdkScope=await browserOwner.capture('@ordinary-signet',guard)
    await browserOwner.mutateMigrated(sdkScope,guard,b=>b.set('signet:login.expiresAt',String(now*1000+options.foregroundMs)))
    sourceSession={...sourceSession,expiresAt:now*1000+options.foregroundMs}
    identity=await Ordinary.OrdinaryForegroundSigner.open({browser:browserOwner,tab:tabOwner,session:sourceSession,currentSession:()=>sourceSession,
      generation:0,currentGeneration:()=>0,live:guard,checkClients:async()=>{},stop:()=>{}})
    current={...current,identity}
  }
  bootstrap=await open();const material=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(material);await bootstrap.close()
  window.readPair=async work=>{const s=await scopes();return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:s.b},
    tab:{owner:tabOwner,scope:s.t},live:guard,work})}
  window.proofFrom=(b,t)=>keep?JSON.parse(b.get(proofName)):JSON.parse(t.get(tabProofName)).privateProof
  window.stored=store=>new Map(store.keys().map(n=>[n,store.get(n)]))
  window.storeView=map=>({get:n=>map.get(n)??null,keys:()=>[...map.keys()],set:(n,v)=>map.set(n,v),remove:n=>map.delete(n)})
  window.steps=0
  // Candidate signing and installation below are explicit fixtures. They do
  // not implement the production pre-entropy/signing/ACK/adoption producer.
  window.candidate=async(extra={})=>{
    const old=await readPair((b,t)=>proofFrom(b,t)),[b,t]=await images(),device=keep?b:t
    const sk=Ordinary.hexToBytes(JSON.parse(device.records.get(prefix+Ordinary.DEVICE_PREFIX+roomId)).sk)
    const newSeal=Ordinary.generateSecretKey(),issued=now+(steps+1)*10,expiry=extra.expiry??now+1800+(steps+1)*300
    let credential
    try{credential=await Ordinary.createDeviceCredential({identity:Ordinary.localIdentity(participantSk),
      devicePubkey:Ordinary.getPublicKey(sk),roomId,expiresAt:expiry,now:()=>issued,seal:Ordinary.getPublicKey(newSeal)})}finally{sk.fill(0)}
    const bm=new Map(b.records),tm=new Map(t.records),owner=keep?bm:tm,seals=JSON.parse(owner.get(prefix+Ordinary.OWN_SEAL_PREFIX+roomId))
    owner.set(prefix+Ordinary.OWN_CREDENTIAL_PREFIX+roomId,JSON.stringify(credential));owner.set(prefix+Ordinary.OWN_SEAL_PREFIX+roomId,JSON.stringify([...seals,Ordinary.bytesToHex(newSeal)]))
    newSeal.fill(0)
    const verified=Ordinary.makePersistentAdmissionProof({invitation,evidence:old.evidence,account,participant,browser:old.binding.browser,
      tab:old.binding.tab,deviceCustody:old.binding.deviceCustody,device:Ordinary.persistentAdmissionDeviceInPair(storeView(bm),storeView(tm),roomId,participant,account,keep?'browser':'tab'),
      keep,now:old.kept.at,expectedRoomSecret:secret})
    const next=verified.proof;verified.admission.secret.fill(0)
    return{old,next,bm,tm,credential,lease:undefined}
  }
  window.prepare=async(c,extra={})=>readPair((b,t,_bn,_tn,token)=>{
    const input={predecessorProof:JSON.stringify(c.old),currentProof:JSON.stringify(c.next),...(account===null?{}:{identity}),...extra}
    c.lease=Ordinary.makeOrdinaryMemberLease(b,t,token,input);c.source=Ordinary.ordinaryMemberLeaseSource(b,t,token)
    c.before=[JSON.stringify([...stored(b)].sort()),JSON.stringify([...stored(t)].sort())]
    return c.lease
  })
  window.commit=async c=>pair((b,t,_bn,_tn,token)=>{
    const actual=[JSON.stringify([...stored(b)].sort()),JSON.stringify([...stored(t)].sort())]
    const headers=Ordinary.ordinaryPairCustodyFor(token,stored(b),stored(t))
    if(JSON.stringify(actual)!==JSON.stringify(c.before)||headers.browser.revision!==c.source.browserRevision||headers.tab.revision!==c.source.tabRevision)throw new Ordinary.OrdinaryStateHold()
    const owner=keep?b:t,proposed=keep?c.bm:c.tm
    for(const key of [Ordinary.OWN_CREDENTIAL_PREFIX,Ordinary.OWN_SEAL_PREFIX])owner.set(prefix+key+roomId,proposed.get(prefix+key+roomId))
    if(keep)b.set(proofName,JSON.stringify(c.next));t.set(tabProofName,Ordinary.tabProofBytes(c.next))
    const name=Ordinary.ordinaryMemberLeaseName(c.next.binding);t.set(name,c.lease);if(keep)b.set(name,c.lease)
    const bm=stored(b),tm=stored(t);Ordinary.validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},Ordinary.captureOrdinarySnapshotContext(bm,tm,token));steps++
  })
  window.renew=async()=>{const c=await candidate();await prepare(c);await commit(c);return c}
  window.headerHash=value=>{const{operation,...body}=value;return Ordinary.memberLeaseDigest(['kithmoot/member-lease/v1',body])}
}`
