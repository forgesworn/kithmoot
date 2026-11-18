const CACHE_NAME = 'kithmoot-people-pictures-v1'
const MAX_PICTURES = 64
const MAX_BYTES = 1024 * 1024
const MAX_AGE_MS = 7 * 86_400_000
const RASTER_IMAGE = /^image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon|vnd\.microsoft\.icon)$/i

const pending = new Map<string, Promise<Blob | undefined>>()
let requests = new AbortController()
let clearing = Promise.resolve()

export function forgetPeoplePictures(): Promise<void> {
  requests.abort()
  requests = new AbortController()
  pending.clear()
  visible?.disconnect()
  waiting.clear()
  clearing = clearing.then(async () => {
    try { await globalThis.caches?.delete(CACHE_NAME) } catch { /* The browser may disable storage. */ }
  })
  return clearing
}

function cacheUntil(headers: Headers): number {
  const control = headers.get('Cache-Control') ?? ''
  if (/(?:^|,)\s*no-(?:cache|store)\b/i.test(control) || headers.get('Vary') === '*') return 0
  const now = Date.now()
  const maxAge = control.match(/(?:^|,)\s*max-age="?([0-9]+)/i)?.[1]
  const age = Math.max(0, Number(headers.get('Age')) || 0)
  const expires = maxAge === undefined
    ? Date.parse(headers.get('Expires') ?? '')
    : now + (Number(maxAge) - age) * 1000
  return Math.min(now + MAX_AGE_MS, Number.isNaN(expires) ? Infinity : expires)
}

async function readPicture(response: Response): Promise<Blob | undefined> {
  const type = response.headers.get('Content-Type')?.split(';')[0]?.trim()
  if (!response.ok || !type || !RASTER_IMAGE.test(type) || !response.body ||
      Number(response.headers.get('Content-Length')) > MAX_BYTES) {
    await response.body?.cancel()
    return
  }
  const reader = response.body.getReader()
  const bytes = new Uint8Array(MAX_BYTES)
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.length > MAX_BYTES) return
      bytes.set(value, length)
      length += value.length
    }
    if (length) return new Blob([bytes.subarray(0, length)], { type })
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function pictureFrom(url: string, signal: AbortSignal): Promise<Blob | undefined> {
  let cache: Cache | undefined
  try {
    await clearing
    if (signal.aborted) return
    cache = await globalThis.caches?.open(CACHE_NAME)
    const saved = await cache?.match(url)
    if (saved && Number(saved.headers.get('X-KithMoot-Expires')) > Date.now()) return await saved.blob()
  } catch { /* A storage failure leaves the direct image available. */ }
  if (!cache || signal.aborted) return
  const response = await fetch(url, {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'image/*' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  })
  const expires = cacheUntil(response.headers)
  const picture = await readPicture(response)
  if (picture && expires > Date.now() && !signal.aborted) {
    try {
      await cache.put(url, new Response(picture, { headers: {
        'Content-Type': picture.type, 'X-KithMoot-Expires': String(expires),
      } }))
      const keys = await cache.keys()
      await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_PICTURES)).map(key => cache.delete(key)))
    } catch { /* Display the image even if the cache is full. */ }
  }
  return picture
}

function loadPicture(image: HTMLImageElement, url: string): void {
  const signal = requests.signal
  let work = pending.get(url)
  if (!work) {
    work = pictureFrom(url, signal).catch(() => undefined)
    pending.set(url, work)
    void work.then(() => { if (pending.get(url) === work) pending.delete(url) })
  }
  void work.then(picture => {
    if (signal.aborted || !image.isConnected) return
    // Hosts that don't allow CORS still use the browser's ordinary image loader.
    if (!picture) { image.src = url; return }
    const objectUrl = URL.createObjectURL(picture)
    const release = (event: Event) => {
      URL.revokeObjectURL(objectUrl)
      image.removeEventListener('load', release)
      image.removeEventListener('error', release)
      if (event.type === 'error' && !signal.aborted) {
        void globalThis.caches?.open(CACHE_NAME).then(cache => cache.delete(url)).catch(() => {})
      }
    }
    image.addEventListener('load', release)
    image.addEventListener('error', release)
    image.src = objectUrl
  })
}

const visible = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
  for (const entry of entries) {
    const image = entry.target as HTMLImageElement
    if (image.isConnected && !entry.isIntersecting) continue
    visible?.unobserve(image)
    const url = waiting.get(image)
    waiting.delete(image)
    if (url && image.isConnected) loadPicture(image, url)
  }
})
const waiting = new Map<HTMLImageElement, string>()
let pruneScheduled = false

export function setPeoplePicture(image: HTMLImageElement, picture: string): void {
  let url: URL
  try { url = new URL(picture) } catch { return }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
  if (url.protocol !== 'https:' || !visible) { image.src = url.href; return }
  waiting.set(image, url.href)
  visible.observe(image)
  if (pruneScheduled) return
  pruneScheduled = true
  queueMicrotask(() => {
    pruneScheduled = false
    for (const oldImage of waiting.keys()) {
      if (oldImage.isConnected) continue
      visible.unobserve(oldImage)
      waiting.delete(oldImage)
    }
  })
}
