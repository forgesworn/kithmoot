(() => {
  const runtimeCacheName = 'kithmoot-original-artwork-v1'
  self.addEventListener('install', event => {
    event.waitUntil((async () => {
      const scope = new URL(self.registration.scope)
      const copied = new Set()
      let runtime
      for (const cacheName of await self.caches.keys()) {
        if (!cacheName.startsWith('workbox-precache-')) continue
        const cache = await self.caches.open(cacheName)
        for (const request of await cache.keys()) {
          const url = new URL(request.url)
          const inArtworkDirectory = url.pathname.startsWith(`${scope.pathname}chat-art/`) || url.pathname.startsWith(`${scope.pathname}emoji/`)
          if (url.origin !== scope.origin || !inArtworkDirectory || !/\.(?:png|gif)$/.test(url.pathname)) continue
          url.searchParams.delete('__WB_REVISION__')
          if (copied.has(url.href)) continue
          const response = await cache.match(request)
          if (!response) throw new Error(`Original artwork disappeared during migration: ${request.url}`)
          runtime ??= await self.caches.open(runtimeCacheName)
          await runtime.put(url.href, response)
          copied.add(url.href)
        }
      }
    })())
  })
})()
