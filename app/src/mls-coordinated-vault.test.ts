import { describe, expect, it } from 'vitest'
import { boxRequest } from './mls-coordinated-vault.js'
const id = '12'.repeat(32), empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const request = (method: string, path: string, payload = id) => ({ v: 1 as const, box: id, method, path, payload })
describe('typed box request boundary (§6.2.1)', () => {
  it.each([
    ['PUT', `/vmls/v1/mailboxes/${id}/records`], ['POST', '/vmls/v1/fetch'], ['POST', '/vmls/v1/ack'],
    ['PUT', `/vmls/v1/packages/${id}`], ['PUT', `/vmls/v1/slots/${id}/0`],
    ['PUT', `/vmls/v1/slots/${id}/4294967295`], ['POST', `/vmls/v1/slots/${id}/7/status`],
  ])('admits exactly %s %s', (method, path) => expect(boxRequest(request(method!, path!))).toEqual(request(method!, path!)))
  it.each([['GET', '/vmls/v1/capabilities'], ['DELETE', `/vmls/v1/packages/${id}`]])('requires an empty body for %s %s', (method, path) => {
    expect(boxRequest(request(method!, path!))).toBeUndefined()
    expect(boxRequest(request(method!, path!, empty))).toEqual(request(method!, path!, empty))
  })
  it.each([
    ['POST', '/vmls-witness/v1/read'], ['GET', '/vmls/v1/fetch'], ['POST', '/vmls/v1/fetch?x=1'],
    ['POST', '/vmls/v1/fetch\n'], ['POST', '/vmls/v1/%66etch'], ['post', '/vmls/v1/fetch'],
    ['PUT', `/vmls/v1/slots/${id}/01`], ['PUT', `/vmls/v1/slots/${id}/-1`],
    ['PUT', `/vmls/v1/slots/${id}/4294967296`], ['PUT', `/vmls/v1/slots/${id}/+1`],
    ['PUT', `/vmls/v1/slots/${id}/1.0`], ['PUT', `/vmls/v1/packages/${'AB'.repeat(32)}`],
    ['POST', '/vmls/v1/fetch/'], ['POST', '//vmls/v1/fetch'],
  ])('refuses %s %s', (method, path) => expect(boxRequest(request(method!, path!))).toBeUndefined())
  it('refuses caller time, arbitrary event fields, malformed keys and another version', () => {
    const r = request('POST', '/vmls/v1/fetch')
    for (const changed of [{ ...r, created_at: 1 }, { ...r, tags: [] }, { ...r, v: 2 }, { ...r, box: id + '\n' }, { ...r, payload: 'ff' }, { ...r, method: null }, null, []]) expect(boxRequest(changed)).toBeUndefined()
  })
})
