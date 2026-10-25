import { sha256 } from './mixed-invitation-metadata-audit.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const SIGN_KINDS = new Set([21236, 20460, 22242, 24242])
const EVENT_KEYS = new Set(['kind', 'created_at', 'content', 'tags', 'pubkey', 'id', 'sig'])
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const exactKeys = (value, keys) => Object.keys(value).sort().join(',') === keys.slice().sort().join(',')
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

function eventRequest(value, origin) {
  if (!plain(value) || Object.keys(value).some(key => !EVENT_KEYS.has(key)) || !SIGN_KINDS.has(value.kind) ||
      (value.created_at !== undefined && (!Number.isSafeInteger(value.created_at) || value.created_at <= 0)) || value.content !== '' ||
      !Array.isArray(value.tags) || value.tags.length > 64 ||
      value.tags.some(tag => !Array.isArray(tag) || tag.length < 2 || tag.length > 8 || tag.some(item => typeof item !== 'string' || item.length > 4096))) return
  if (value.kind === 21236 && (value.content !== '' ||
      !(exactKeys(value, ['kind', 'created_at', 'content', 'tags']) || exactKeys(value, ['kind', 'content', 'tags'])) ||
      value.tags.length !== 3 || value.tags.some(tag => tag.length !== 2) ||
      value.tags[0][0] !== 'challenge' || !HEX64.test(value.tags[0][1]) ||
      value.tags[1][0] !== 'origin' || value.tags[1][1] !== origin ||
      value.tags[2][0] !== 'app' || value.tags[2][1] !== 'KithMoot')) return
  const json = JSON.stringify(value)
  if (!json || Buffer.byteLength(json) > 256 * 1024) return
  return JSON.parse(json)
}

function provisionRequest(value) {
  if (!plain(value) || !exactKeys(value, ['v', 'expectedPersona', 'targetDevice', 'index', 'nonce', 'expiresAt']) ||
      value.v !== 1 || !HEX64.test(value.expectedPersona) || !HEX64.test(value.targetDevice) ||
      !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 0xffffffff ||
      typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.nonce) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return
  return { v:1, expectedPersona:value.expectedPersona, targetDevice:value.targetDevice,
    index:value.index, nonce:value.nonce, expiresAt:value.expiresAt }
}

// For the private loopback handoff only. This never makes an approval decision.
export function permittedApprovalDto(details, appOrigin, now = Date.now()) {
  if (!plain(details) || details.origin !== appOrigin || !HEX64.test(details.pubkey) ||
      !Number.isFinite(details.expiresAt) || details.expiresAt <= now) return
  let event = null, provision = null
  if (details.method === 'signEvent') {
    event = eventRequest(details.event, appOrigin)
    if (!event || details.provision) return
  } else if (details.method === 'heartwood_provision_rendezvous') {
    provision = provisionRequest(details.provision)
    if (!provision || details.event) return
  } else if (details.method === 'getPublicKey' || details.method === 'getRelays') {
    if (details.event || details.provision) return
  } else return
  const exact = { method:details.method, origin:details.origin, pubkey:details.pubkey, event, provision }
  return { ...exact, expiresAt:details.expiresAt, sha256:sha256(JSON.stringify(stable(exact))) }
}
