// Client IDs are opaque strings. Compare arrays injectively, never with a
// delimiter that might itself occur inside an ID.
function ordinaryClientIdsSame(left, right) {
  if (left.length !== right.length || !left.every(id => typeof id === 'string') || !right.every(id => typeof id === 'string')) return false
  const a = [...left].sort(), b = [...right].sort()
  return a.every((id, index) => id === b[index])
}
// Imported into the generated worker. Only compatibility and fresh opaque
// correlation bytes cross this channel; room/account/storage names do not.
self.addEventListener('message', event => {
  const value = event.data, reply = event.ports[0]
  const protocol = 'kithmoot:ordinary-state-clients-v1'
  if (!value || value.protocol !== protocol || value.phase !== 'check' ||
      typeof value.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(value.nonce) || !reply) return
  event.waitUntil((async () => {
    let ok = false
    const scope = new URL(self.registration.scope)
    const enumerate = async () => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter(client => { const url = new URL(client.url); return url.origin === scope.origin && url.pathname.startsWith(scope.pathname) })
    try {
      const clients = await enumerate()
      if (!clients.length || clients.length > 64 || !clients.some(client => client.id === event.source?.id)) throw new Error('unverified client inventory')
      const results = await Promise.all(clients.map(client => new Promise(resolve => {
        const channel = new MessageChannel()
        let finished = false
        const finish = result => { if (finished) return; finished = true; clearTimeout(timer); channel.port1.close(); resolve(result) }
        const timer = setTimeout(() => finish(false), 3_000)
        channel.port1.onmessage = message => {
          const answer = message.data
          finish(!!answer && answer.protocol === protocol && answer.phase === 'ready' && answer.nonce === value.nonce)
        }
        channel.port1.onmessageerror = () => finish(false)
        try { client.postMessage({ protocol, phase: 'probe', nonce: value.nonce }, [channel.port2]) }
        catch { finish(false) }
      })))
      const after = await enumerate()
      ok = results.every(Boolean) && ordinaryClientIdsSame(clients.map(c => c.id), after.map(c => c.id))
    } catch { ok = false }
    reply.postMessage({ protocol, phase: 'result', nonce: value.nonce, ok })
    reply.close()
  })())
})
