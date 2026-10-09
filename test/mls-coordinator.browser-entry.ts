import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, bytesToHex } from '@noble/hashes/utils.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import { MlsWitnessLink } from '../app/src/mls-witness-link.js'

/** Adapter acceptance only: a disposable signing witness, not a real box. */
export async function run() {
  const wasm=await loadMlsEngine(), key=new Uint8Array(32).fill(71)
  const platform=new wasm.Platform(new Uint8Array(32),new Uint8Array(32),{fill:n=>crypto.getRandomValues(new Uint8Array(n))})
  const vault={type:'vault',record:new Uint8Array([1]),sealedHash:wasm.coordinatorObjectHash(new Uint8Array([7]))}
  const session=(generation:bigint)=>({type:'session',session:new Uint8Array(32).fill(5),generation,snapshotHash:wasm.coordinatorObjectHash(new Uint8Array([5,Number(generation)]))})
  const active=[vault,session(1n)], candidate=[vault,session(2n)]
  const genesis=wasm.coordinatorGenesis(new Uint8Array(32).fill(3),new Uint8Array(32).fill(4),ed25519.getPublicKey(key),active)
  let sequence=0n, digest:Uint8Array=genesis.digest, lost=false
  const channel=new MlsWitnessLink({request:async request=>{
    if(request.routeId!=='fixture-witness' || request.authorization!=='' || request.method!=='POST')throw new Error('Unexpected witness route')
    const bytes=request.body, advance=request.path.endsWith('/advance')
    if(bytes.length!==(advance?145:73))throw new Error('Unexpected fixture request layout')
    let status=0
    if(advance){
      if(sequence===BigInt(bytes[39]) && bytesToHex(digest)===bytesToHex(bytes.subarray(43,75))){sequence++;digest=bytes.slice(78,110)}
      else status=1
    }
    const signed=new Uint8Array(106)
    signed[0]=1;signed[1]=status;signed.set(bytes.subarray(6,38),2)
    new DataView(signed.buffer).setBigUint64(34,sequence)
    signed.set(digest,42);signed.set(bytes.subarray(bytes.length-32),74)
    if(advance && !lost){lost=true;throw new Error('Lost response after fixture commit')}
    const hash=sha256(concatBytes(new TextEncoder().encode('VMLS/1 witness receipt'),signed))
    return {status:status===0?200:409,body:concatBytes(signed,ed25519.sign(hash,key)),witnessRefused:false,path:{status:'Ready',relay:null,direct:null,cause:''}}
  }},'fixture-witness')
  const c=wasm.openCoordinator(platform,genesis.state,active,undefined)
  const initial=c.onRead(await channel.read(c.read())).type
  const staged=c.stage(candidate), persisted=staged.state()
  const unavailable=await channel.advance(c.staged(staged))
  const held=c.onAdvance(unavailable).type
  c.free();staged.free()
  const reopened=wasm.openCoordinator(platform,persisted,active,candidate)
  const decision=reopened.onRead(await channel.read(reopened.read())).type
  const promotion=reopened.promote(), promotedState=promotion.state()
  const marks=reopened.promoted(promotion)
  const restored=wasm.openCoordinator(platform,genesis.state,active,undefined)
  const fenced=restored.onRead(await channel.read(restored.read()))
  const current=wasm.openCoordinator(platform,promotedState,candidate,undefined)
  current.read()
  const offline=current.onRead({type:'unavailable'}).type
  const result={initial,held,decision,generation:String(marks[0].generation),fenced,offline,confirmed:current.confirmed()}
  current.free();restored.free();promotion.free();reopened.free();platform.free();key.fill(0)
  return result
}
