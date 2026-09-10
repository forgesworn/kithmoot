// Signed interoperability cases. Test keys are deterministic and never used outside fixtures.
// Run with Node 24 after npm run build:lib. Not a Bothy daemon conformance certificate.
import { writeFileSync } from 'node:fs'
import { finalizeEvent } from 'nostr-tools/pure'
import { base64 } from '@scure/base'
import { boxFixture } from '../test/box-status-fixture.ts'
import { readBoxStatus, readBoxClaim } from '../dist/src/box-status.js'
const f = boxFixture(), cases = [], claims = []
function add(name, event, ok, changes = {}) {
  const pin = changes.pin ?? f.pin, claim = changes.claim ?? f.claim, now = changes.now ?? f.now
  const got = readBoxStatus(event, claim, pin, now)
  if (got.ok !== ok) throw Error(`${name}: unexpected ${JSON.stringify(got)}`)
  cases.push({ name, status: event, claim, pin, now, expect: { ok, ...(got.ok ? { drops: got.status.drops, dropsUrl: got.status.dropsUrl ?? null, validUntil: got.status.validUntil } : {}) } })
}
add('signed-endpoint', f.status(), true)
add('drops-off', f.status(f.withTag('drops', ['off'])), true)
add('legacy-no-endpoint', f.status(f.tags.filter(t => !['drops', 'carriers', 'software', 'relaying', 'retention'].includes(t[0]))), true)
add('same-card-reannouncement', f.status(), true, {pin:{...f.pin,highestSerial:8,card:base64.encode(f.card)}})
add('same-serial-without-bytes', f.status(), false, {pin:{...f.pin,highestSerial:8}})
add('stale-serial', f.status(), false, {pin:{...f.pin,highestSerial:9}})
add('node-substitution', f.status(), false, {pin:{...f.pin,nodeId:'0'.repeat(64)}})
add('older-status-replay', f.status(f.tags, f.now - 1), false, {pin:{...f.pin,statusCreatedAt:f.now,statusId:f.status().id}})
add('same-time-status-conflict', f.status(f.withTag('drops',['off'])), false, {pin:{...f.pin,statusCreatedAt:f.now,statusId:f.status().id}})
add('stale-status',f.status(f.tags,f.now-10800),false)
add('future-status',f.status(f.tags,f.now+301),false)
add('signature-substitution',{...f.status(),tags:f.withTag('drops',['on','wss://attacker.example'])},false)
for (const [name,tag,values] of [
 ['cleartext','drops',['on','ws://wrong.example']], ['userinfo','drops',['on','wss://user:pass@wrong.example']],
 ['fragment','drops',['on','wss://wrong.example/#x']], ['empty-host','drops',['on','wss://:']],
 ['off-endpoint','drops',['off','wss://wrong.example']], ['card-exp','card-exp',[String(f.now+200)]],
 ['capacity-rounding','free',['1']], ['capacity-over-pool','free',['3221225472']],
 ['u64-overflow','max-blob',['18446744073709551616']], ['u64-leading-zero','max-blob',['01']],
 ['u64-maximum','max-blob',['18446744073709551615']], ['duplicate-classes','classes',['working','working']],
 ['duplicate-carriers','carriers',['tor','tor']], ['software-commit','software',['bothy/0.1','bad']],
 ['base32-padding','node',[f.tags[2][1].slice(0,-1)+'b']], ['oversized-card','card',['A'.repeat(5500)]],
 ['default-port','drops',['on','wss://OWNED.example:443/drops']], ['unicode-host','drops',['on','wss://böx.example/drops']],
]) add(name,f.status(f.withTag(tag,values)),['u64-maximum','default-port','unicode-host'].includes(name))
add('duplicate-status-tag',f.status([...f.tags,['drops','off']]),false)
add('expired-event',f.status([...f.tags,['expiration',String(f.now)]]),false)
add('unknown-status-hint',f.status([...f.tags,['future-hint','x']]),true)
const retiredTags=f.claim.tags.filter(t=>!(t[0]==='p'&&t[3]==='stash')).map(t=>t[0]==='status'?['status','retired']:t)
const retired=finalizeEvent({...f.claim,tags:retiredTags},f.masterKey)
add('retired-claim',f.status(f.withTag('claim',[retired.id])),false,{claim:retired,pin:{...f.pin,claim:retired.id}})
function claimCase(name,tags,ok,at=f.claim.created_at){
 const event=finalizeEvent({...f.claim,tags,created_at:at},f.masterKey)
 if(readBoxClaim(event,f.now).ok!==ok)throw Error(name)
 claims.push({name,event,now:f.now,expect:{ok}})
}
claimCase('active',f.claim.tags,true)
claimCase('retired',retiredTags,true)
claimCase('retired-with-stash',f.claim.tags.map(t=>t[0]==='status'?['status','retired']:t),false)
claimCase('unknown-authority',[...f.claim.tags,['authority','everyone']],false)
claimCase('duplicate-master',[...f.claim.tags,f.claim.tags.find(t=>t[0]==='p'&&t[3]==='master')],false)
claimCase('missing-stash',f.claim.tags.filter(t=>!(t[0]==='p'&&t[3]==='stash')),false)
claimCase('future',f.claim.tags,false,f.now+301)
claimCase('unbound-node',f.claim.tags.map(t=>t[0]==='d'?['d','0'.repeat(64)]:t),false)
writeFileSync(new URL('./box-discovery.json',import.meta.url),JSON.stringify({version:1,source:'KithMoot signed Bothy V1/V2 client interoperability fixtures; not daemon-issued proof',cases,claims},null,2)+'\n')
console.log(`${cases.length} status and ${claims.length} claim cases`)
