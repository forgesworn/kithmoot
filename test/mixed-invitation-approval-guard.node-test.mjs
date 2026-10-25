import { test } from 'node:test'
import assert from 'node:assert/strict'
import { permittedApprovalDto, publicOrdinaryContextDto } from './mixed-invitation-approval-guard.mjs'

const origin='http://localhost:28445'
const pubkey='ab'.repeat(32)
const now=1_000_000
const base={origin,pubkey,expiresAt:now+60_000,event:null,provision:null}
const login={kind:21236,content:'',tags:[['challenge','cd'.repeat(32)],['origin',origin],['app','KithMoot']]}

test('private handoff returns the complete typed login template and exact digest', () => {
  const dto=permittedApprovalDto({...base,method:'signEvent',event:login},origin,now)
  assert.equal(dto.method,'signEvent')
  assert.deepEqual(dto.event,login)
  assert.match(dto.sha256,/^[0-9a-f]{64}$/)
  assert.equal(dto.provision,null)
})

test('private getter returns no DTO for generic Encrypt or Decrypt methods', () => {
  for(const method of ['nip44.encrypt','nip44.decrypt','nip04.encrypt','nip04.decrypt'])
    assert.equal(permittedApprovalDto({...base,method},origin,now),undefined)
})

test('wrong signing kind, changed login binding and expired request return no DTO', () => {
  assert.equal(permittedApprovalDto({...base,method:'signEvent',event:{...login,kind:1}},origin,now),undefined)
  assert.equal(permittedApprovalDto({...base,method:'signEvent',event:{...login,tags:[...login.tags.slice(0,2),['app','Other']]}},origin,now),undefined)
  assert.equal(permittedApprovalDto({...base,method:'signEvent',event:{...login,tags:[['challenge','cd'.repeat(32),'extra'],...login.tags.slice(1)]}},origin,now),undefined)
  assert.equal(permittedApprovalDto({...base,method:'signEvent',event:login,expiresAt:now},origin,now),undefined)
  assert.equal(permittedApprovalDto({...base,method:'signEvent',event:login,origin:'http://other.invalid'},origin,now),undefined)
})

test('only typed empty-content MLS signing and exact v1 provision schemas pass', () => {
  const event={kind:20460,created_at:123,content:'',tags:[['device','ef'.repeat(32)]]}
  assert.deepEqual(permittedApprovalDto({...base,method:'signEvent',event},origin,now).event,event)
  const provision={v:1,expectedPersona:pubkey,targetDevice:'ef'.repeat(32),index:0,nonce:'A'.repeat(22),expiresAt:12345}
  assert.deepEqual(permittedApprovalDto({...base,method:'heartwood_provision_rendezvous',provision},origin,now).provision,provision)
  assert.equal(permittedApprovalDto({...base,method:'heartwood_provision_rendezvous',provision:{...provision,extra:'private'}},origin,now),undefined)
  assert.equal(permittedApprovalDto({...base,method:'getPublicKey',event},origin,now),undefined)
})

test('ordinary public context admits exact live room and account binding only', () => {
  const roomId='11'.repeat(32), device='22'.repeat(32)
  const live={sessionAssigned:true,roomId,participant:pubkey,device,arrivalRoomId:roomId,accountPubkey:pubkey,
    accountMethod:'nip07',signerMethod:'nip07',canSignEvents:true,roomGeneration:2,identityGeneration:3,joining:true,
    sessionMatchesArrivalRoom:true,accountMatchesParticipant:true}
  const dto=publicOrdinaryContextDto(live)
  assert.deepEqual(dto,live)
  assert.equal(Object.isFrozen(dto),true)
  assert.equal(publicOrdinaryContextDto({...live,secretKey:'private'}),undefined)
  assert.equal(publicOrdinaryContextDto({...live,device:'short'}),undefined)
  assert.equal(publicOrdinaryContextDto({...live,sessionMatchesArrivalRoom:false}),undefined)
  assert.equal(publicOrdinaryContextDto({...live,accountMatchesParticipant:false}),undefined)
  assert.equal(publicOrdinaryContextDto({...live,sessionAssigned:false}),undefined)
  assert.equal(publicOrdinaryContextDto({...live,signerMethod:'visitor'}),undefined)
})

test('ordinary context can report a room link before any session exists', () => {
  const waiting={sessionAssigned:false,roomId:null,participant:null,device:null,arrivalRoomId:'11'.repeat(32),
    accountPubkey:pubkey,accountMethod:'nip07',signerMethod:'nip07',canSignEvents:true,roomGeneration:1,identityGeneration:1,
    joining:false,sessionMatchesArrivalRoom:false,accountMatchesParticipant:false}
  assert.deepEqual(publicOrdinaryContextDto(waiting),waiting)
  assert.equal(publicOrdinaryContextDto({...waiting,device:'22'.repeat(32)}),undefined)
})
