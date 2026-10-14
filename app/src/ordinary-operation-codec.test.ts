import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { describe, expect, it, vi } from 'vitest'
import { OrdinaryStateHold, type OrdinaryImage, type OrdinaryFrame } from './ordinary-state-codec.js'
import { decodeOrdinaryOperationJournal, encodeOrdinaryOperationJournal, ordinaryFrameDigest, ordinaryOperationSemanticDigest, ordinaryOperationMarker,
  ordinaryOperationNames, ordinaryOperationControlDigest, ordinaryOperationCommitment, decodeOrdinaryOperationClassification, openOrdinaryOperationClassification, openOrdinaryOperationControl, sealOrdinaryOperationControl, validateOrdinaryOperationMarker,
  type OrdinaryOperationBinding, type OrdinaryOperationJournal } from './ordinary-operation-codec.js'
const tab = ('tab:' + '3'.repeat(64)) as `tab:${string}`
const expiry = 43_200_000
const binding = (purpose: 'browser' | `tab:${string}`): OrdinaryOperationBinding => ({ purpose, keyId: '1'.repeat(64), generation: '2'.repeat(64), expiresAt: purpose === 'browser' ? 0 : expiry })
const digest = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s)))
const journal = (): OrdinaryOperationJournal => ({ version: 1, id: '4'.repeat(64), tab, sequence: 1, phase: 'prepared',
  source: ['5'.repeat(64), '6'.repeat(64)], enrolled: ['a'.repeat(64), 'b'.repeat(64)], target: null, sourceRevisions: [7, 3], enrolledRevisions: [8, 4], targetRevisions: null,
  requestDigest: digest('{"kind":"member-renewal"}'), resultDigest: null,
  scopes: [['browser', 'invitation', '2'.repeat(64), 0], [tab, 'invitation', '2'.repeat(64), 0]],
  ceilings: [expiry, 9000], request: '{"kind":"member-renewal"}', result: null, secrets: [], nonces: null })
const owners = async () => ({
  browser: { binding: binding('browser'), key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) },
  tab: { binding: binding(tab), key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) },
})
describe('native operation journal custody format', () => {
  it('round-trips canonical phases and keeps identical names in distinct physical scopes', () => {
    const input = journal(), encoded = encodeOrdinaryOperationJournal(input)
    expect(decodeOrdinaryOperationJournal(encoded)).toEqual(input)
    for (const phase of ['provider-started', 'provider-returned', 'candidate-committed', 'settled'] as const) {
      const value: OrdinaryOperationJournal = { ...input, phase, secrets: phase === 'provider-started' || phase === 'provider-returned' ? [new Uint8Array(32).fill(7)] : [], nonces: phase === 'provider-started' || phase === 'provider-returned' ? ['8'.repeat(24), '9'.repeat(24)] : null }
      const returned = phase === 'provider-returned' || phase === 'candidate-committed'
      const next = returned ? { ...value, result: 'exact signed bytes', resultDigest: digest('exact signed bytes'), target: ['c'.repeat(64), 'd'.repeat(64)] as const, targetRevisions: [9, 5] as const }
        : phase === 'settled' ? { ...value, target: ['c'.repeat(64), 'd'.repeat(64)] as const, targetRevisions: [9, 5] as const, resultDigest: digest('exact signed bytes'), request: '', result: null, secrets: [], nonces: null } : value
      expect(decodeOrdinaryOperationJournal(encodeOrdinaryOperationJournal(next))).toEqual(next)
    }
  })
  it.each(['extra-field', 'unknown-phase', 'wrong-version', 'zero-sequence', 'duplicate-scope', 'foreign-scope', 'provider-without-seal', 'premature-result', 'settled-with-secret', 'prepared-with-secret', 'prepared-with-nonces', 'candidate-with-secret', 'candidate-with-nonces', 'same-stage-digest', 'skipped-enrollment-revision', 'request-digest'])(
    'rejects %s without entropy or inferred empty state', fault => {
      const value: any = journal()
      if (fault === 'extra-field') value.extra = true
      if (fault === 'unknown-phase') value.phase = 'aborted-by-timeout'
      if (fault === 'wrong-version') value.version = 2
      if (fault === 'zero-sequence') value.sequence = 0
      if (fault === 'duplicate-scope') value.scopes.push(value.scopes[0])
      if (fault === 'foreign-scope') value.scopes[1][0] = 'tab:' + 'a'.repeat(64)
      if (fault === 'provider-without-seal') value.phase = 'provider-started'
      if (fault === 'premature-result') value.result = 'not returned'
      if (fault === 'prepared-with-secret') value.secrets = [new Uint8Array(32)]
      if (fault === 'prepared-with-nonces') value.nonces = ['8'.repeat(24), '9'.repeat(24)]
      if (fault.startsWith('candidate-with-')) Object.assign(value, { phase: 'candidate-committed', target: ['c'.repeat(64), 'd'.repeat(64)], targetRevisions: [9,5], result: 'signed', resultDigest: digest('signed'), secrets: fault.endsWith('secret') ? [new Uint8Array(32)] : [], nonces: fault.endsWith('nonces') ? ['8'.repeat(24),'9'.repeat(24)] : null })
      if (fault === 'same-stage-digest') value.enrolled = value.source
      if (fault === 'skipped-enrollment-revision') value.enrolledRevisions[0]++
      if (fault === 'request-digest') value.requestDigest = 'f'.repeat(64)
      if (fault === 'settled-with-secret') Object.assign(value, { phase: 'settled', target: value.source, request: '', secrets: ['a'.repeat(64)] })
      const random = vi.spyOn(crypto, 'getRandomValues')
      try { expect(() => encodeOrdinaryOperationJournal(value)).toThrow(OrdinaryStateHold); expect(random).not.toHaveBeenCalled() }
      finally { random.mockRestore() }
    })
  it('rejects accessors without invoking them and rejects noncanonical bytes', () => {
    const value = journal(), getter = vi.fn(() => 'prepared')
    Object.defineProperty(value, 'phase', { enumerable: true, get: getter })
    expect(() => encodeOrdinaryOperationJournal(value)).toThrow(OrdinaryStateHold)
    expect(getter).not.toHaveBeenCalled()
    const encoded = encodeOrdinaryOperationJournal(journal()), size = new DataView(encoded.buffer).getUint32(0)
    const text = new TextDecoder().decode(encoded.subarray(4, 4 + size))
    for (const raw of [' ' + text, text + '\n', text.replace('[1,', '[1.0,'), '[2' + text.slice(2)]) {
      const head = new TextEncoder().encode(raw), bytes = new Uint8Array(4 + head.length + encoded.length - 4 - size)
      new DataView(bytes.buffer).setUint32(0, head.length); bytes.set(head,4); bytes.set(encoded.subarray(4+size),4+head.length)
      expect(() => decodeOrdinaryOperationJournal(bytes)).toThrow(OrdinaryStateHold)
    }
  })
  it('bounds UTF-8 producer data before any crypto or owner action', () => {
    const value = { ...journal(), request: 'é'.repeat(524_289) }, random = vi.spyOn(crypto, 'getRandomValues')
    try { expect(() => encodeOrdinaryOperationJournal(value)).toThrow(OrdinaryStateHold); expect(random).not.toHaveBeenCalled() }
    finally { random.mockRestore() }
  })
  it('uses exact opaque key grammar and canonical required markers', () => {
    const value = journal(), picked = { id: value.id, tab: value.tab, sequence: value.sequence, commitment: null }
    const marker = ordinaryOperationMarker(picked), names = ordinaryOperationNames(tab)
    expect(names).toEqual({ control: 'journal:tab:' + '3'.repeat(64), marker: 'kithmoot.operation-journal.v1.' + '3'.repeat(64) })
    expect(validateOrdinaryOperationMarker(marker)).toEqual(picked)
    expect(() => validateOrdinaryOperationMarker(marker + ' ')).toThrow(OrdinaryStateHold)
    expect(() => ordinaryOperationNames('browser')).toThrow(OrdinaryStateHold)
  })
  it('authenticates both native key domains and byte-identical inner payloads', async () => {
    const keys = await owners(), value = journal(), control = await sealOrdinaryOperationControl(value, keys)
    expect(await openOrdinaryOperationControl(control, keys)).toEqual(value)
    const other = await sealOrdinaryOperationControl({ ...value, request: 'different exact request', requestDigest: digest('different exact request') }, keys)
    await expect(openOrdinaryOperationControl({ ...control, tab: other.tab }, keys)).rejects.toThrow(OrdinaryStateHold)
    await expect(openOrdinaryOperationControl(control, { ...keys, tab: { ...keys.tab, key: (await owners()).tab.key } })).rejects.toThrow(OrdinaryStateHold)
    await expect(openOrdinaryOperationControl(control, { ...keys, tab: { ...keys.tab, binding: { ...keys.tab.binding, expiresAt: expiry + 1 } } })).rejects.toThrow(OrdinaryStateHold)
    const before = control.browser.ciphertext.slice(0)
    await openOrdinaryOperationControl(control, keys)
    expect(control.browser.ciphertext).toEqual(before)
  })
  it('captures plaintext before awaits and refuses an inconsistent lease before nonce entropy', async () => {
    const keys = await owners(), value: any = journal(), pending = sealOrdinaryOperationControl(value, keys)
    value.request = 'mutated after capture'; value.source[0] = 'a'.repeat(64)
    expect((await openOrdinaryOperationControl(await pending, keys)).request).toBe(journal().request)
    const random = vi.spyOn(crypto, 'getRandomValues')
    try {
      await expect(sealOrdinaryOperationControl({ ...journal(), ceilings: [expiry + 1] }, keys)).rejects.toThrow(OrdinaryStateHold)
      expect(random).not.toHaveBeenCalled()
    } finally { random.mockRestore() }
  })
  it('digests every binary frame field with a fixed independently computed vector', () => {
    const frame: OrdinaryFrame = { version: 1, purpose: 'browser', keyId: '11'.repeat(32), generation: '22'.repeat(32), revision: 7,
      expiresAt: 0, nonce: Uint8Array.from({ length: 12 }, (_, i) => i).buffer, ciphertext: Uint8Array.from({ length: 16 }, (_, i) => i).buffer }
    // Expected SHA256 generated independently with Python struct >I / >QQ.
    expect(ordinaryFrameDigest(frame)).toBe('6cc47cd7c2891137ef7eb9f2e9cb22409ac171d161db488b057ec2fb1fd57029')
    const before = structuredClone(frame)
    const changed = structuredClone(frame); new Uint8Array(changed.ciphertext)[15] ^= 1
    expect(ordinaryFrameDigest(changed)).not.toBe(ordinaryFrameDigest(frame))
    expect(frame).toEqual(before)
    expect(ordinaryFrameDigest({ ...frame, revision: 8 })).not.toBe(ordinaryFrameDigest(frame))
  })
})

it('classifies private binary body without decoding producer strings or allocating keys', async () => {
  const keys = await owners(), value: OrdinaryOperationJournal = { ...journal(), phase: 'provider-started',
    secrets: [new Uint8Array(32).fill(0xff)], nonces: ['8'.repeat(24),'9'.repeat(24)] }
  const control = await sealOrdinaryOperationControl(value, keys)
  const header = await openOrdinaryOperationClassification(control, keys)
  expect(header).not.toHaveProperty('secrets'); expect(header).not.toHaveProperty('request'); expect(header).not.toHaveProperty('result')
  expect(header.secretCount).toBe(1)
  const bytes = encodeOrdinaryOperationJournal(value), size = new DataView(bytes.buffer).getUint32(0)
  const decode = vi.spyOn(TextDecoder.prototype, 'decode')
  try { decodeOrdinaryOperationClassification(bytes); expect(decode).toHaveBeenCalledTimes(1); expect((decode.mock.calls[0]![0] as Uint8Array).byteLength).toBe(size) }
  finally { decode.mockRestore(); bytes.fill(0) }
})
it('rejects truncated, oversized, extra and inconsistent packet lengths', () => {
  const bytes = encodeOrdinaryOperationJournal(journal())
  for (const bad of [bytes.subarray(0,3), bytes.subarray(0,bytes.length-1), Uint8Array.from([...bytes,0])])
    expect(() => decodeOrdinaryOperationClassification(bad)).toThrow(OrdinaryStateHold)
  const bad = bytes.slice(); new DataView(bad.buffer).setUint32(0,0xffffffff)
  expect(() => decodeOrdinaryOperationClassification(bad)).toThrow(OrdinaryStateHold)
})
it('binds settled stage history and immutable operation commitments', () => {
  const base = journal(), settled: OrdinaryOperationJournal = { ...base, phase: 'settled', target: ['c'.repeat(64),'d'.repeat(64)],
    targetRevisions: [9,5], request: '', resultDigest: digest('signed') }
  const header = decodeOrdinaryOperationClassification(encodeOrdinaryOperationJournal(settled)), commitment = ordinaryOperationCommitment(header)
  // Independently computed with Python SHA-256 and big-endian >I/>Q fields.
  expect(commitment).toBe('72b02dbb73e8af3af1ec83314dd600c3c25da6a971d156bf15dbdc2f5295b684')
  expect(ordinaryOperationCommitment({ ...header, target: ['e'.repeat(64),'d'.repeat(64)] })).not.toBe(commitment)
  expect(ordinaryOperationCommitment({ ...header, requestDigest: 'e'.repeat(64) })).not.toBe(commitment)
})

it('refuses shadow byte accessors without invoking them and captures owned keys before await', async () => {
  const keys = await owners(), secret = new Uint8Array(32).fill(7), value: OrdinaryOperationJournal = { ...journal(), phase: 'provider-started', secrets: [secret], nonces: ['8'.repeat(24),'9'.repeat(24)] }
  const pending = sealOrdinaryOperationControl(value, keys); secret.fill(9)
  const opened = await openOrdinaryOperationControl(await pending, keys)
  expect(opened.secrets[0]).toEqual(new Uint8Array(32).fill(7)); opened.secrets[0]!.fill(0)
  const getter = vi.fn(() => new ArrayBuffer(32)); Object.defineProperty(secret,'buffer',{get:getter})
  expect(() => encodeOrdinaryOperationJournal(value)).toThrow(OrdinaryStateHold); expect(getter).not.toHaveBeenCalled()
})

it('binds encrypted control equality without decoding or mutating its payload', async () => {
  const keys = await owners(), control = await sealOrdinaryOperationControl(journal(),keys), original = structuredClone(control)
  const digest = ordinaryOperationControlDigest(control)
  expect(ordinaryOperationControlDigest(structuredClone(control))).toBe(digest); expect(control).toEqual(original)
  for (const role of ['browser','tab'] as const) {
    const changed = structuredClone(control); new Uint8Array(changed[role].ciphertext)[0] ^= 1
    expect(ordinaryOperationControlDigest(changed)).not.toBe(digest)
  }
  expect(ordinaryOperationControlDigest({ ...control,browser:control.tab,tab:control.browser })).not.toBe(digest)
})


const semanticPair = (): [OrdinaryImage,OrdinaryImage] => [{purpose:'browser',keyId:'1'.repeat(64),generation:'2'.repeat(64),revision:7,expiresAt:0,
  records:new Map([['z','value😀'],['a','public\0private']]),migration:{phase:'complete',sources:new Map(),names:['retained source']},
  fences:new Map([['room:fixture',7],['missing-is-not-zero',0]])},
  {purpose:tab,keyId:'4'.repeat(64),generation:'5'.repeat(64),revision:3,expiresAt:expiry,
    records:new Map([['kithmoot.way-back','{"link":"#fixture"}']]),migration:{phase:'complete',sources:new Map(),names:[]},fences:new Map()}]
describe('complete predecessor semantic commitment',()=>{
  it('matches an independently generated Python hashlib/JSON vector',()=>{
    expect(ordinaryOperationSemanticDigest(...semanticPair())).toBe('10bdd6b3701181efcbac26ad8d29c05a700c6531f165a89e25b3f067c9c2d5c1')
    const [b,t]=semanticPair(),first=ordinaryOperationSemanticDigest(b,t)
    b.records=new Map([...b.records].reverse());b.fences=new Map([...b.fences].reverse())
    expect(ordinaryOperationSemanticDigest(b,t)).toBe(first)
  })
  it.each(['record','unrelated-record','fence','missing-fence','migration-names','migration-sources','migration-presence','key-id','generation','revision','expiry','tab-purpose'])(
    'commits complete %s semantics beyond selected room refs',field=>{
      const [b,t]=semanticPair(),before=ordinaryOperationSemanticDigest(b,t)
      if(field==='record')(b.records as Map<string,string>).set('a','changed')
      if(field==='unrelated-record')(t.records as Map<string,string>).set('unrelated-private-value','retained')
      if(field==='fence')(b.fences as Map<string,number>).set('room:fixture',6)
      if(field==='missing-fence')(b.fences as Map<string,number>).delete('missing-is-not-zero')
      if(field==='migration-names')b.migration={...b.migration!,names:[...b.migration!.names,'another retained source']}
      if(field==='migration-sources')b.migration={phase:'sealed',sources:new Map([['retained source','exact source']]),names:['retained source']}
      if(field==='migration-presence')delete t.migration
      if(field==='key-id')b.keyId='6'.repeat(64)
      if(field==='generation')t.generation='7'.repeat(64)
      if(field==='revision')t.revision++
      if(field==='expiry')t.expiresAt++
      if(field==='tab-purpose')t.purpose=('tab:'+'8'.repeat(64)) as `tab:${string}`
      expect(ordinaryOperationSemanticDigest(b,t)).not.toBe(before)
    })
  it('requires labelled owner roles and wipes every encoded plaintext buffer',()=>{
    const [b,t]=semanticPair(),encode=TextEncoder.prototype.encode,buffers:Uint8Array[]=[]
    const spy=vi.spyOn(TextEncoder.prototype,'encode').mockImplementation(function(this:TextEncoder,text){const bytes=encode.call(this,text);buffers.push(bytes);return bytes})
    try { ordinaryOperationSemanticDigest(b,t);expect(buffers.length).toBeGreaterThanOrEqual(3);expect(buffers.every(b=>b.every(v=>v===0))).toBe(true) }
    finally { spy.mockRestore() }
    expect(()=>ordinaryOperationSemanticDigest(t,b)).toThrow(OrdinaryStateHold)
    t.revision=Number.MAX_SAFE_INTEGER+1;expect(()=>ordinaryOperationSemanticDigest(b,t)).toThrow(OrdinaryStateHold)
  })
  it('distinguishes E from P and verifies only the exact inverse marker/fence/revision delta',()=>{
    const [b,t]=semanticPair(),before=ordinaryOperationSemanticDigest(b,t),marker=ordinaryOperationNames(tab).marker
    for(const image of [b,t]){image.revision++;(image.records as Map<string,string>).set(marker,ordinaryOperationMarker({id:'9'.repeat(64),tab,sequence:1,commitment:null}));(image.fences as Map<string,number>).set('previously-absent',0)}
    expect(ordinaryOperationSemanticDigest(b,t)).not.toBe(before)
    for(const image of [b,t]){image.revision--; (image.records as Map<string,string>).delete(marker);(image.fences as Map<string,number>).delete('previously-absent')}
    expect(ordinaryOperationSemanticDigest(b,t)).toBe(before)
    ;(t.fences as Map<string,number>).set('previously-absent',0);expect(ordinaryOperationSemanticDigest(b,t)).not.toBe(before)
  })
})
