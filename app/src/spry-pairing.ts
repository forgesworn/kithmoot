import { claimSpryPairing, parseSpryPairingLink, parseSpryOffer, spryEndpoint, type SpryPairing, type SpryOffer } from '../../src/spry.js'

const KEY = 'kithmoot.spry-pairing.v1'
/** Accept a pasted app/web pairing link without navigating or contacting it. */
export function parseSpryPairingInput(text: string): string {
  const value = text.trim()
  if (value.length > 4096) throw new Error('This Spry pairing link could not be read.')
  const url = new URL(value)
  const app = url.protocol === 'kithmoot:' && url.host === 'join' && ['', '/'].includes(url.pathname)
  const web = url.protocol === 'https:' && url.host && ['/j', '/j/'].includes(url.pathname)
  if ((!app && !web) || url.username || url.password || url.search) throw new Error('This Spry pairing link could not be read.')
  parseSpryPairingLink(url.hash)
  return url.hash
}
export function parseAccountSpryPairing(value: unknown): SpryPairing {
  if (!value || typeof value !== 'object') throw new Error('Invalid Spry pairing')
  const raw = value as Partial<SpryPairing>
  if (raw.v !== 1 || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.id) ||
      typeof raw.secretKey !== 'string' || !/^[a-f0-9]{64}$/.test(raw.secretKey)) throw new Error('Invalid Spry pairing')
  return { v: 1, endpoint: spryEndpoint(raw.endpoint), id: raw.id, secretKey: raw.secretKey }
}
export function saveSpryPairing(store: Pick<Storage, 'setItem'>, pair: SpryPairing, participant: string): void {
  store.setItem(KEY, JSON.stringify({ ...parseAccountSpryPairing(pair), participant }))
}
export function loadSpryPairing(store: Pick<Storage, 'getItem'>, participant: string): SpryPairing | undefined {
  const text = store.getItem(KEY)
  if (!text) return undefined
  try {
    if (text.length > 4096) throw new Error()
    const raw = JSON.parse(text)
    if (raw.participant !== participant) return undefined
    if (raw.v !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(raw.id) || !/^[a-f0-9]{64}$/.test(raw.secretKey)) throw new Error()
    return { v: 1, endpoint: spryEndpoint(raw.endpoint), id: raw.id, secretKey: raw.secretKey }
  } catch { throw new Error('The Spry pairing could not be read. Remove it in Connections and pair again.') }
}
export function removeSpryPairing(store: Pick<Storage, 'removeItem'>): void { store.removeItem(KEY) }

const ROOMS_KEY = 'kithmoot.spry-rooms.v1'
function savedOffers(store: Pick<Storage, 'getItem'>): Record<string, SpryOffer> {
  try {
    const value = store.getItem(ROOMS_KEY)
    if (!value || value.length > 262144) return {}
    const entries = Object.entries(JSON.parse(value)).slice(0, 64).flatMap(([key, value]) => {
      const offer = parseSpryOffer(value)
      return offer && offer.expiresAt > Date.now() / 1000 ? [[key, offer]] : []
    })
    return Object.fromEntries(entries)
  } catch { return {} }
}
export function loadSpryOffer(store: Pick<Storage, 'getItem'>, participant: string, room: string): SpryOffer | undefined {
  return savedOffers(store)[`${participant}:${room}`]
}
export function saveSpryOffer(store: Pick<Storage, 'getItem' | 'setItem'>, participant: string, room: string, offer: SpryOffer): void {
  const offers = savedOffers(store)
  offers[`${participant}:${room}`] = offer
  const entries = Object.entries(offers).sort((a, b) => b[1].expiresAt - a[1].expiresAt).slice(0, 64)
  store.setItem(ROOMS_KEY, JSON.stringify(Object.fromEntries(entries)))
}

export async function completeSpryPairing(hash: string, store: Pick<Storage, 'setItem'>, participant: string,
  confirm: (host: string) => Promise<boolean>, fetcher: typeof fetch = fetch, isCurrent: () => boolean = () => true): Promise<boolean> {
  const link = parseSpryPairingLink(hash)
  if (!await confirm(link.endpoint.startsWith('spry:') ? 'Your Spry node' : new URL(link.endpoint).hostname)) return false
  if (!isCurrent()) return false
  const pair = await claimSpryPairing(link, fetcher)
  if (!isCurrent()) return false
  saveSpryPairing(store, pair, participant)
  return true
}
