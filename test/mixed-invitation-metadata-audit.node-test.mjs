import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frameSummary, httpSummary, matchesNeedleNow, sha256, withinBudget, assertProspectiveNeedles, windowTransition } from './mixed-invitation-metadata-audit.mjs'

test('REQ and COUNT disclose filter shape and digests without selector values', () => {
  const author='ab'.repeat(32), recipient='cd'.repeat(32)
  for(const command of ['REQ','COUNT']) {
    const summary=frameSummary(JSON.stringify([command,'subscription-private',{kinds:[1,4],authors:[author],'#p':[recipient],limit:3}]))
    assert.equal(summary.type,command)
    assert.equal(summary.subscriptionSha256,sha256('subscription-private'))
    assert.deepEqual(summary.filters[0].kinds,[1,4])
    assert.deepEqual(summary.filters[0].keys,['#p','authors','kinds','limit'])
    assert.equal(summary.filters[0].selectors.find(s=>s.keyClass==='authors').valueSha256[0],sha256(JSON.stringify(author)))
    assert.equal(summary.filters[0].selectors.find(s=>s.keyClass==='#p').valueSha256[0],sha256(JSON.stringify(recipient)))
    assert.equal(JSON.stringify(summary).includes(author),false)
    assert.equal(JSON.stringify(summary).includes(recipient),false)
  }
})

test('EVENT and AUTH expose kind, author and tag digests without event values', () => {
  const author='ef'.repeat(32), tag='12'.repeat(32)
  for(const command of ['EVENT','AUTH']) {
    const summary=frameSummary(JSON.stringify([command,{kind:22242,pubkey:author,content:'sealed',tags:[['p',tag],['unexpected-secret-key','secret-value']]}]))
    assert.equal(summary.event.kind,22242)
    assert.equal(summary.event.authorSha256,sha256(author))
    assert.deepEqual(summary.event.tags[0],{keyClass:'p',valueCount:1,valueSha256:[sha256(JSON.stringify(tag))]})
    assert.equal(summary.event.tags[1].keyClass,'other')
    assert.equal(JSON.stringify(summary).includes(tag),false)
    assert.equal(JSON.stringify(summary).includes('secret-value'),false)
  }
})

test('public control only labels the exact synthetic subscription', () => {
  const id='metadata-control-exact'
  assert.equal(frameSummary(JSON.stringify(['REQ',id,{kinds:[1]}]),id).control,'REQ')
  assert.equal(frameSummary(JSON.stringify(['CLOSE',id]),id).control,'CLOSE')
  assert.equal(frameSummary(JSON.stringify(['REQ','other',{kinds:[1]}]),id).control,undefined)
  assert.equal(frameSummary(JSON.stringify(['REQ',id,{kinds:[1]}]),'other').control,undefined)
})

test('HTTP URL, headers and body are checked immediately and summarised without secrets', () => {
  const secret='private-capability-value'
  const url=`https://unknown.example/private?token=${secret}`
  const headers={Authorization:`Bearer ${secret}`,'Content-Type':'application/json','X-Secret':secret}
  const body=Buffer.from(`{"secret":"${secret}"}`)
  assert.equal(matchesNeedleNow([secret],[url,...Object.entries(headers).flat(),body]),4)
  const summary=httpSummary(url,'POST',headers,body,true,'bark-worker-http',{'https://known.example':'known'})
  assert.equal(summary.originAlias,'other')
  assert.equal(summary.originSha256,sha256('https://unknown.example'))
  assert.equal(summary.query[0].valueSha256,sha256(secret))
  assert.equal(summary.headers[0].nameClass,'authorization')
  assert.equal(summary.headers[2].nameClass,'other')
  assert.equal(summary.bodyAudit,'observed')
  assert.equal(summary.headerCoverage,'reported-by-CDP')
  assert.equal(JSON.stringify(summary).includes(secret),false)
  const unavailable=httpSummary(url,'POST',headers,null,true,'app-http')
  assert.equal(unavailable.bodyAudit,'unavailable')
  assert.deepEqual(unavailable.unavailableFields,['browser-excluded-headers','request-body'])
})

test('the collector matches binary identifiers from hex and base64url needles before discarding payloads', () => {
  const bytes=Buffer.from('77'.repeat(32),'hex')
  const wire=Buffer.concat([Buffer.from([0xff,0x00]),bytes])
  assert.equal(matchesNeedleNow([bytes.toString('hex'),bytes.toString('base64url')],[wire]),2)
  assert.equal(matchesNeedleNow([bytes.toString('hex')],[Buffer.from('absent')]),0)
})

test('overflow and closed window boundaries cannot silently become complete capture', () => {
  assert.deepEqual(withinBudget(15,2,16),{bytes:15,overflow:true})
  assert.deepEqual(withinBudget(15,1,16),{bytes:16,overflow:false})
  const summary={name:'ordinary',observedBytes:16,observerOverflow:true,publicControl:{outboundObserved:true}}
  const transition=windowTransition(summary,'private',['private-id'],new Set(['ordinary','private']))
  summary.observedBytes=0
  assert.equal(transition.closed.observedBytes,16)
  assert.equal(transition.name,'private')
  assert.deepEqual(transition.needles,['private-id'])
  assert.throws(()=>windowTransition(summary,'unknown',[],new Set(['ordinary','private'])),/Named window/)
  assert.throws(()=>windowTransition(summary,'private',[''],new Set(['private'])),/Named window/)
})

test('retrospective needles are refused after prospective arming', () => {
  assert.doesNotThrow(()=>assertProspectiveNeedles(['armed'],['armed']))
  assert.throws(()=>assertProspectiveNeedles(['later'],['armed']),/Retrospective needles/)
  assert.throws(()=>assertProspectiveNeedles('later',['armed']),/Retrospective needles/)
})
