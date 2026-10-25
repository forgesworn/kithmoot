/** Read-only runtime status supplies endpoints, never one-time pairing codes. */
export function readRuntimeConfig(status) {
  if (!status || status.ready !== true) throw new Error('Recovered runtime must be ready')
  const websocket = value => {
    if (typeof value !== 'string') throw new Error('Selected runtime endpoint required')
    const url = new URL(value)
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error('Explicit TLS runtime endpoint required')
    return value
  }
  const linkUrl = websocket(status.linkUrl), relayUrl = websocket(status.signerRelay)
  return { linkUrl, relayUrl, publicRelay: relayUrl }
}

/** Two explicit disposable browser controllers; the listener stays loopback. */
export function readControllerPort(value = '28446') {
  if (value !== '28446' && value !== '28447') throw new Error('Choose disposable controller port 28446 or 28447')
  return Number(value)
}
