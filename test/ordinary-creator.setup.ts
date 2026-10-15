export const creatorSetup=`async (options={})=>{
 window.now=Math.floor(Date.now()/1000);window.live=true;window.guard=()=>live
 window.secret=new Uint8Array(32).fill(31);window.roomId=Ordinary.deriveRoom(secret).roomId
 window.inviterSk=new Uint8Array(32);inviterSk[31]=7;window.participantSk=new Uint8Array(32);participantSk[31]=13
 window.participant=Ordinary.getPublicKey(participantSk);window.account=options.account?participant:null
 window.invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(17),Ordinary.getPublicKey(inviterSk),true)
 window.id=Ordinary.deriveInvitationId(invitation);window.prefix=Ordinary.accountPrefix(participant)
 window.destinations=['wss://second.example/','wss://first.example/'];window.roomRelays=options.noRelays?undefined:['wss://fixed.example/']
 window.link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:['wss://hint.example/'],iceUrls:[],name:'New group'})
 window.current={account,participant,invitationId:id,roomId,link,keep:true,destinations,profile:'direct',sourceKind:options.kind??'new-room',
   endsAt:options.noEnds?undefined:now+3600,destruct:!options.noEnds,roomRelays}
 window.migration={phase:'complete',sources:new Map(),names:[]};window.tabPurpose='tab:'+'a'.repeat(64);window.tabExpiry=Date.now()+3600_000
 window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
 await browserOwner.prepare(guard,new Map([['kithmoot.participant',Ordinary.bytesToHex(participantSk)]]),migration)
 await tabOwner.prepare(guard,new Map(),migration)
 window.ack=async retained=>{const scope=await browserOwner.capture('invitation:'+retained.proof.binding.invitationId,guard)
 await browserOwner.mutateMigrated(scope,guard,store=>store.set(Ordinary.creatorIntentName(retained.proof.binding),
 JSON.stringify(Ordinary.creatorIntent(retained.proof,retained.proof.destinations))))}
 window.open=()=>Ordinary.OrdinaryInvitationCreator.open({...current,browser:browserOwner,tab:tabOwner,invitation,
   expectedRoomSecret:secret,inviterSk,live:guard,current:()=>current})
 window.creator=await open();window.proofName=prefix+Ordinary.CREATOR_PROOF_PREFIX+id;window.intentName=prefix+Ordinary.CREATOR_INTENT_PREFIX+id
 window.rawBoth=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error)
 r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose)
 tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}})
 window.images=async()=>Promise.all((await rawBoth()).map(row=>Ordinary.openOrdinaryFrame(row.frame,row.key)))
 window.records=async()=>(await images()).map(image=>[...image.records])
 window.outcome=async work=>{try{await work();return 'ok'}catch(e){return e.name}}
 window.preflight=async()=>{const bScope=await browserOwner.capture('invitation:'+id,guard),tScope=await tabOwner.capture('invitation:'+id,guard)
 return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:bScope},tab:{owner:tabOwner,scope:tScope},live:guard,
 work:(b,t,_bn,_tn,custody)=>{const browser=new Map(b.keys().map(n=>[n,b.get(n)])),tab=new Map(t.keys().map(n=>[n,t.get(n)]))
 return Ordinary.validateOrdinarySnapshot(browser,tab,{browser:true,tab:true},Ordinary.captureOrdinarySnapshotContext(browser,tab,custody))}})}
}`
