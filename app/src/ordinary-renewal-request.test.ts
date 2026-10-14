import { describe,it,expect,vi } from 'vitest'
import { OrdinaryStateHold,type OrdinaryImage } from './ordinary-state-codec.js'
import { ordinaryOperationMarker,ordinaryOperationNames,ordinaryOperationSemanticDigest,ordinaryOperationCommitment,
  decodeOrdinaryOperationClassification,encodeOrdinaryOperationJournal,type OrdinaryOperationJournal } from './ordinary-operation-codec.js'
import { encodeOrdinaryRenewalRequest,readOrdinaryRenewalRequest,restoreOrdinaryRenewalPredecessor,type OrdinaryRenewalRequest } from './ordinary-renewal-request.js'
const tab=('tab:'+'3'.repeat(64)) as `tab:${string}`,participant='4'.repeat(64),invitationId='5'.repeat(64),name='invitation:'+participant+':'+invitationId
function fixture(old=false){
  const b:OrdinaryImage={purpose:'browser',keyId:'1'.repeat(64),generation:'2'.repeat(64),revision:7,expiresAt:0,records:new Map([['unrelated','private source']]),fences:new Map([[name,0]]),migration:{phase:'complete',sources:new Map(),names:['retained original']}}
  const t:OrdinaryImage={purpose:tab,keyId:'6'.repeat(64),generation:'7'.repeat(64),revision:3,expiresAt:600000,records:new Map(),fences:new Map(),migration:{phase:'complete',sources:new Map(),names:[]}}
  let previous:OrdinaryRenewalRequest['previous']=null,marker:string|null=null
  if(old){
    const j:OrdinaryOperationJournal={version:1,id:'8'.repeat(64),tab,sequence:3,phase:'settled',source:['9'.repeat(64),'a'.repeat(64)],sourceRevisions:[4,0],
      enrolled:['b'.repeat(64),'c'.repeat(64)],enrolledRevisions:[5,1],target:['d'.repeat(64),'e'.repeat(64)],targetRevisions:[6,2],
      requestDigest:'f'.repeat(64),resultDigest:'0'.repeat(64),scopes:[['browser',name,b.generation,0],[tab,name,t.generation,0]],ceilings:[t.expiresAt],request:'',result:null,secrets:[],nonces:null}
    const header=decodeOrdinaryOperationClassification(encodeOrdinaryOperationJournal(j));previous={digest:'a'.repeat(64),header}
    marker=ordinaryOperationMarker({id:j.id,tab,sequence:j.sequence,commitment:ordinaryOperationCommitment(header)})
    ;(b.records as Map<string,string>).set(ordinaryOperationNames(tab).marker,marker);(t.records as Map<string,string>).set(ordinaryOperationNames(tab).marker,marker)
  }
  const request:OrdinaryRenewalRequest={version:1,domain:'kithmoot/member-renewal/request/v1',credentialFormat:1,intent:{account:null,participant,invitationId,
    roomId:'8'.repeat(64),keep:true,device:'9'.repeat(64),credential:'a'.repeat(64),proof:'b'.repeat(64),bootstrap:'c'.repeat(64),predecessor:'d'.repeat(64),leaseSequence:0,
    epoch:0,epochId:'e'.repeat(64),linkDigest:'f'.repeat(64),issuedAt:100,expiresAt:200,authority:{tabExpiresAt:t.expiresAt,admissionEndsAt:400,foregroundExpiresAt:null,membershipEndsAt:null},
    semanticDigest:ordinaryOperationSemanticDigest(b,t),sourceRevisions:[b.revision,t.revision],sourceFrames:['1'.repeat(64),'2'.repeat(64)],
    previousControlDigest:previous?.digest??null,previousMarkers:[marker,marker]},
    sources:[b,t].map(({purpose,keyId,generation,revision,expiresAt})=>({purpose,keyId,generation,revision,expiresAt})) as unknown as OrdinaryRenewalRequest['sources'],
    scopes:[['browser',name,b.generation,0],[tab,name,t.generation,0]],fences:[['browser',name,true,0,0],[tab,name,false,null,0]],previous}
  const enroll=()=>{const id='0'.repeat(64),sequence=old?4:1,next=ordinaryOperationMarker({id,tab,sequence,commitment:null});
    for(const image of [b,t]){image.revision++;(image.records as Map<string,string>).set(ordinaryOperationNames(tab).marker,next);(image.fences as Map<string,number>).set(name,0)}return{id,sequence}}
  return{b,t,request,enroll}
}
describe('fixed renewal request data, not native authority',()=>{
  it.each([false,true])('round trips bounded request and exact inverse, prior settled=%s',old=>{
    const f=fixture(old),raw=encodeOrdinaryRenewalRequest(f.request),before=ordinaryOperationSemanticDigest(f.b,f.t),operation=f.enroll()
    expect(readOrdinaryRenewalRequest(raw)).toEqual(f.request);expect(ordinaryOperationSemanticDigest(f.b,f.t)).not.toBe(before)
    restoreOrdinaryRenewalPredecessor(f.b,f.t,raw,operation);expect(ordinaryOperationSemanticDigest(f.b,f.t)).toBe(before)
    expect(f.b.fences.has(name)).toBe(true);expect(f.t.fences.has(name)).toBe(false)
  })
  it.each(['version','domain','format','extra','revision-overflow','sequence-overflow','source-revision','scope-generation','foreign-scope','fence-presence','fence-value','previous-marker','previous-digest','tab-purpose','authority','account'])(
    'rejects malformed %s without entropy',field=>{
      const f=fixture(),value=JSON.parse(encodeOrdinaryRenewalRequest(f.request))
      if(field==='version')value.version=2;if(field==='domain')value.domain='other';if(field==='format')value.credentialFormat=2;if(field==='extra')value.extra=true
      if(field==='revision-overflow')value.intent.sourceRevisions[0]=Number.MAX_SAFE_INTEGER
      if(field==='sequence-overflow')value.intent.leaseSequence=Number.MAX_SAFE_INTEGER
      if(field==='source-revision')value.sources[0].revision++
      if(field==='scope-generation')value.scopes[0][2]='0'.repeat(64)
      if(field==='foreign-scope')value.scopes[1][1]='other'
      if(field==='fence-presence')value.fences[1][2]=true
      if(field==='fence-value')value.fences[1][4]=1
      if(field==='previous-marker')value.intent.previousMarkers[1]='unproven marker'
      if(field==='previous-digest')value.intent.previousControlDigest='0'.repeat(64)
      if(field==='tab-purpose')value.sources[1].purpose+='\n'
      if(field==='authority')value.intent.authority.membershipEndsAt=300
      if(field==='account')value.intent.account='0'.repeat(64)
      const random=vi.spyOn(crypto,'getRandomValues');try{expect(()=>readOrdinaryRenewalRequest(JSON.stringify(value))).toThrow(OrdinaryStateHold);expect(random).not.toHaveBeenCalled()}finally{random.mockRestore()}
    })
  it('rejects accessors and noncanonical JSON without running a supplied getter',()=>{
    const f=fixture(),getter=vi.fn(()=>1);Object.defineProperty(f.request,'version',{enumerable:true,get:getter})
    expect(()=>encodeOrdinaryRenewalRequest(f.request)).toThrow(OrdinaryStateHold);expect(getter).not.toHaveBeenCalled()
    const raw=encodeOrdinaryRenewalRequest(fixture().request)
    for(const changed of [' '+raw,raw.replace('"version":1','"version":1.0'),raw.replace('"version":1','"version":1,"version":1')])expect(()=>readOrdinaryRenewalRequest(changed)).toThrow(OrdinaryStateHold)
  })
  it.each(['record','unrelated-fence','migration','key','generation','revision','marker','sequence'])('inverse detects retained E %s alteration',field=>{
    const f=fixture(),raw=encodeOrdinaryRenewalRequest(f.request),operation=f.enroll()
    if(field==='record')(f.b.records as Map<string,string>).set('unrelated','changed')
    if(field==='unrelated-fence')(f.t.fences as Map<string,number>).set('unrelated',0)
    if(field==='migration')f.b.migration={...f.b.migration!,names:['different original']}
    if(field==='key')f.t.keyId='0'.repeat(64)
    if(field==='generation')f.b.generation='0'.repeat(64)
    if(field==='revision')f.t.revision++
    if(field==='marker')(f.b.records as Map<string,string>).delete(ordinaryOperationNames(tab).marker)
    if(field==='sequence')operation.sequence++
    expect(()=>restoreOrdinaryRenewalPredecessor(f.b,f.t,raw,operation)).toThrow(OrdinaryStateHold)
  })
})
