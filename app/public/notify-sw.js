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
