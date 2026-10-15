export const controls = `async()=>{
 const material=await bootstrap.bootstrap(evidence);window.ownCredential=material.credential;Ordinary.wipeOrdinaryPersistentBootstrapResult(material);
 window.nativeHeld=0;window.dials=[];window.frames=[];window.sockets=[];window.randomness=[];window.grants=true;
 const request=navigator.locks.request.bind(navigator.locks);navigator.locks.request=(name,...args)=>{const callback=args.pop();return request(name,...args,async lock=>{
  if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld++;try{return await callback(lock)}finally{if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld--}})};
 const random=crypto.getRandomValues.bind(crypto);crypto.getRandomValues=(...args)=>{randomness.push(nativeHeld>0);return random(...args)};
 class Socket {
  readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null;requests=new Map();
  constructor(url){this.url=url;sockets.push(this);dials.push(nativeHeld>0);queueMicrotask(()=>{if(this.readyState===3)return;this.readyState=1;this.onopen?.({type:'open'});
    if(window.challenge)this.message(['AUTH','member-auth'])})}
  message(frame){if(this.readyState!==3)this.onmessage?.({data:JSON.stringify(frame)})}
  send(raw){frames.push([JSON.parse(raw),nativeHeld>0]);const frame=JSON.parse(raw);if(frame[0]==='REQ')this.requests.set(frame[1],frame.slice(2));
   queueMicrotask(()=>{if(frame[0]==='REQ')this.message(['EOSE',frame[1]]);
    if(frame[0]==='AUTH')this.message(['OK',frame[1].id,true,'accepted']);
    if(frame[0]==='EVENT'){this.message(['OK',frame[1].id,true,'accepted']);
     if(frame[1].kind===20468&&grants){const grant=Ordinary.encodeEpochGrant({roomId,authoritySk:inviterSk,device:frame[1].pubkey,request:frame[1].id,
      epoch:{epoch:0,secret},credential:ownCredential,removed:[],now:Math.floor(Date.now()/1000)});
      for(const socket of sockets)for(const[id,filters]of socket.requests)if(filters.some(f=>f.kinds?.includes(grant.kind)))socket.message(['EVENT',id,grant])}
     else for(const socket of sockets)for(const[id,filters]of socket.requests)if(filters.some(f=>f.kinds?.includes(frame[1].kind)))socket.message(['EVENT',id,frame[1]])}})
  }
  close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.({type:'close'})}
 }
 window.sessionSelected=true;
 window.sessionOptions={relays:window.memberRelayList??['wss://first.example/','wss://second.example/'],profile:'direct',websocketImplementation:Socket,live:()=>guard()&&sessionSelected,epochRequestTimeoutMs:window.memberEpochTimeoutMs??1000};
 if(!window.deferMemberCreation)window.member=await bootstrap.openMemberSession(sessionOptions);
 window.join=()=>{window.joinState='pending';window.joining=member.join().then(()=>joinState='ok',error=>joinState=error.name);return joining};
}`
