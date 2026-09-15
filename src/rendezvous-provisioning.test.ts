import { hexToBytes } from '@noble/hashes/utils'
import { describe, expect, it } from 'vitest'
import { readRendezvousProvision } from './rendezvous-provisioning.js'

const NOW = 1_793_577_600
const IDENTITY = '3e0b147852ddd35607a06b4bb56ffc102e4d7b3ece162042c3f32f96a49c4613'
const DEVICE = 'd6bd3b313d2cbc4f0b2355179911bd45747e6bd1024b9fead9a72e914a28e827'
const RECORD = `{"v":1,"p":"${IDENTITY}","d":"${DEVICE}","rz":"5f7117a78150fe2ef97db7cfc83bd57b2e2c0d0dd25eaf467a4a1c2a45ce1486","u":"rendezvous","i":7,"n":"AAECAwQFBgcICQoLDA0ODw","e":1793577900,"k":"Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA"}`
const expectRecord = { identity: IDENTITY, device: DEVICE, nonce: hexToBytes('000102030405060708090a0b0c0d0e0f'), now: NOW }

describe('rendezvous provisioning', () => {
  it('reads the canonical Vennel provision vector and allows prompt zeroisation', () => {
    const result = readRendezvousProvision(RECORD, expectRecord)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.provision.index).toBe(7)
    expect(result.provision.expiresAt).toBe(NOW + 300)
    expect(Buffer.from(result.provision.scalar).toString('hex')).toBe('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100')
    result.provision.wipe()
    expect(result.provision.scalar.every(byte => byte === 0)).toBe(true)
  })

  it('refuses altered issuer device purpose nonce expiry scalar and shape', () => {
    const reason = (record: string) => {
      const result = readRendezvousProvision(record, expectRecord)
      return result.ok ? 'accepted' : result.reason
    }
    expect(reason(RECORD.replace(IDENTITY, 'aa'.repeat(32)))).toBe('identity')
    expect(reason(RECORD.replace(DEVICE, 'bb'.repeat(32)))).toBe('device')
    expect(reason(RECORD.replace('"u":"rendezvous"', '"u":"persona"'))).toBe('purpose')
    expect(reason(RECORD.replace('AAECAwQFBgcICQoLDA0ODw', 'AQEBAQEBAQEBAQEBAQEBAQ'))).toBe('nonce')
    expect(reason(RECORD.replace('1793577900', String(NOW)))).toBe('expired')
    expect(reason(RECORD.replace('5f7117a78150fe2ef97db7cfc83bd57b2e2c0d0dd25eaf467a4a1c2a45ce1486', IDENTITY))).toBe('rendezvous key')
    expect(reason(RECORD.replace(`{"v":1,"p":"${IDENTITY}","d":`, `{"p":"${IDENTITY}","v":1,"d":`))).toBe('fields')
    expect(reason(RECORD.replace('"k":"Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA"', '"k":"Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA="'))).toBe('scalar')
  })
})
