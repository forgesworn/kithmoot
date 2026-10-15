export const controls = `async (options={})=>{
 window.nativeHeld=0;window.dials=[];window.frames=[];window.sockets=[];window.delivered=[];window.eoses=0;window.handoffs=[];
 window.allowed=true;window.authSigns??=0;window.autoOpen=options.autoOpen!==false;window.autoEose=options.autoEose!==false;window.autoAck=options.autoAck!==false;
 window.serverEvents=options.history===false?[]:[event];window.challenge=options.auth===true;
 const request=navigator.locks.request.bind(navigator.locks);
 navigator.locks.request=(name,...args)=>{const callback=args.pop();return request(name,...args,async lock=>{
  if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld++;try{return await callback(lock)}finally{if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld--}})};
 class Socket {
  readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null;
  constructor(url){this.url=url;dials.push([url,nativeHeld>0]);sockets.push(this);if(autoOpen)queueMicrotask(()=>this.open())}
  open(){if(this.readyState!==0)return;this.readyState=1;this.onopen?.({type:'open'});if(challenge)this.message(['AUTH','shared-relay-challenge'])}
  message(frame){if(this.readyState!==3)this.onmessage?.({data:JSON.stringify(frame)})}
  send(data){frames.push([data,nativeHeld>0]);const frame=JSON.parse(data);if(frame[0]==='REQ')this.requestId=frame[1];queueMicrotask(()=>{
   if(frame[0]==='AUTH')this.message(['OK',frame[1].id,true,'accepted']);
   if(frame[0]==='EVENT'&&autoAck)this.message(['OK',frame[1].id,true,'accepted']);
   if(frame[0]==='REQ'){for(const value of serverEvents)this.message(['EVENT',frame[1],value]);if(autoEose)this.message(['EOSE',frame[1]])}})}
  close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.({type:'close'})}
 }
 window.Socket=Socket;window.destinations=['wss://first.example/','wss://second.example/'];
 window.carrierOptions={browser:browserOwner,tab:tabOwner,scope:invScopeName,relays:destinations,profile:'direct',websocketImplementation:Socket,
  account,participant,authentication:challenge?destinations.map(url=>({url,identity})):[],live:()=>live&&allowed,
  validate:()=>{if(!allowed)throw new Ordinary.OrdinaryStateHold()}};
 if(options.relays)carrierOptions.relays=options.relays;
 if(window.workGraph)Object.assign(carrierOptions,{work:workGraph,validate:validateGraphPair,onClose:()=>workGraph.close()});
 window.carrier=await Ordinary.OrdinaryRelayCarrier.open(carrierOptions);
 window.listen=()=>{window.stop=carrier.subscribe([{kinds:[event.kind],authors:[event.pubkey]}],(value,via)=>{
  delivered.push([value.id,via]);handoffs.push(nativeHeld>0)},()=>{eoses++;handoffs.push(nativeHeld>0)})};
 window.publish=()=>{window.publication='pending';window.publishing=carrier.publish(event).then(()=>{publication='ok'},error=>{publication=error.name});return publishing};
 window.takeLock=async()=>{let ready;const taken=new Promise(resolve=>ready=resolve);window.lockWork=navigator.locks.request(Ordinary.ORDINARY_DATABASE+':write',async()=>{
  ready();await new Promise(resolve=>window.releaseLock=resolve)});await taken};
 window.shutdown=async()=>{carrier.close();await carrier.joinLifetime()};
}`
