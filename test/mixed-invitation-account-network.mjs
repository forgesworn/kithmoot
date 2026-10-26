import { createHash } from 'node:crypto'

const modes = new Map([
  ['private-invitations', { label: 'Account network: private invitations', button: '#choosePrivateInvitations' }],
  ['nostr', { label: 'Account network: Nostr', button: '#enableNostrNetwork' }],
])
const openers = ['#homeAccountNetwork', '#accountNetworkOpen']

export function accountNetworkDto(labels, status, dialogVisible) {
  const mode = [...modes].find(([, value]) => labels.length === openers.length && labels.every(label => label === value.label))?.[0]
  if (!mode || typeof status !== 'string' || !status.length) throw new Error('Rendered account network state unavailable')
  return { mode, dialogVisible, statusLength: status.length,
    statusSha256: createHash('sha256').update(status).digest('hex') }
}

export async function accountNetworkState(page) {
  return accountNetworkDto(await Promise.all(openers.map(id => page.locator(id).textContent())),
    await page.locator('#accountNetworkStatus').textContent(), await page.locator('#accountNetworkDialog').isVisible())
}

export async function chooseAccountNetwork(page, mode) {
  if (!modes.has(mode)) throw new Error('Exact supported account network mode required')
  for (const [panel, close] of [['#mlsWitnessSettings', '#mlsWitnessClose'], ['#mlsRoomDevelopment', '#mlsRoomDevelopment [data-close]'], ['#mlsGrantDevelopment', '#mlsGrantDevelopment [data-close]']]) {
    if (await page.locator(panel).isVisible()) await page.locator(close).click()
  }
  if (!await page.locator('#accountNetworkDialog').isVisible()) {
    const opener = await page.locator(openers[0]).isVisible() ? openers[0]
      : await page.locator(openers[1]).isVisible() ? openers[1] : undefined
    if (!opener) throw new Error('Visible account network opener required')
    await page.locator(opener).click()
    await page.locator('#accountNetworkDialog').waitFor({ state: 'visible' })
  }
  await page.locator(modes.get(mode).button).click()
  const actual = await accountNetworkState(page)
  if (actual.mode !== mode) throw new Error('Rendered account network choice did not apply')
  await page.locator('#accountNetworkClose').click()
  return { ...actual, dialogVisible: false, chosenThroughUi: true }
}
