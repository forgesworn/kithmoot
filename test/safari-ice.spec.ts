import { test, expect } from '@playwright/test'
import { stunFromTurnUrl } from '../src/ice-defaults.js'

test('the browser accepts the production ICE protocols after default resolution', async ({ page }) => {
  const turnServer: RTCIceServer = {
    urls: [
      'turn:kithmoot.example:3478',
      'turn:kithmoot.example:3478?transport=tcp',
      'turns:kithmoot.example:5349',
    ],
    username: 'test-user',
    credential: 'test-password',
  }
  const stunUrls = (turnServer.urls as string[])
    .map(stunFromTurnUrl)
    .filter((url): url is string => url !== undefined)
  const iceServers: RTCIceServer[] = [
    ...stunUrls.map(url => ({ urls: url })),
    turnServer,
  ]

  const configuredUrls = await page.evaluate((servers) => {
    const pc = new RTCPeerConnection({ iceServers: servers })
    const urls = (pc.getConfiguration().iceServers ?? []).flatMap(server =>
      Array.isArray(server.urls) ? server.urls : [server.urls],
    )
    pc.close()
    return urls
  }, iceServers)

  expect(configuredUrls).toContain('stun:kithmoot.example:3478')
  expect(configuredUrls).toContain('turns:kithmoot.example:5349')
  expect(configuredUrls.filter(url => url.toLowerCase().startsWith('stuns:'))).toEqual([])
})
