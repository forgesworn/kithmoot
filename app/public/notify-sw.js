// Imported into the generated service worker (see app/vite.config.ts).
//
// A notification shown through the registration outlives the tab that asked
// for it, which is what makes it work on a phone; the price is that a click
// on it lands here, with no page to handle it. So: bring an open KithMoot
// window to the front and tell it which room, or open the room afresh.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data
  const url = data && typeof data.url === 'string' ? data.url : undefined
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (typeof client.focus !== 'function') continue
        await client.focus()
        if (url) client.postMessage({ type: 'kithmoot:open', url })
        return
      }
      if (url && self.clients.openWindow) await self.clients.openWindow(url)
    })(),
  )
})

// An old or frozen tab must never be omitted from a private-room transition.
// No account, room identifier or route is passed through these messages.
self.addEventListener('message', event => {
  if (event.data !== 'kithmoot:check-room-route-tabs-v1' || !event.ports[0]) return
  event.waitUntil((async () => {
    try {
      const scope = new URL(self.registration.scope)
      const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
        .filter(client => { const url = new URL(client.url); return url.origin === scope.origin && url.pathname.startsWith(scope.pathname) })
      const results = await Promise.all(clients.map(client => new Promise(resolve => {
        const channel = new MessageChannel()
        const timer = setTimeout(() => { channel.port1.close(); resolve(false) }, 8000)
        channel.port1.onmessage = reply => { clearTimeout(timer); channel.port1.close(); resolve(reply.data === 'ready') }
        client.postMessage('kithmoot:room-route-ready-v1', [channel.port2])
      })))
      event.ports[0].postMessage(clients.length > 0 && results.every(Boolean))
    } catch { event.ports[0].postMessage(false) }
  })())
})
