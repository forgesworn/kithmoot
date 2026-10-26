import { accountNetworkState } from './mixed-invitation-account-network.mjs'

/** Explicit product Connect signer button only. Never navigates or changes policy. */
export async function openPrivateSignerPicker(page) {
  if ((await accountNetworkState(page)).mode !== 'private-invitations') throw new Error('Rendered private invitation mode required')
  const picker = page.locator('#signet-login-dialog')
  if (await picker.isVisible()) return { opened: false, existingPicker: true }
  const candidates = ['#homeSignIn', '#headerSignIn', '#signIn']
  let opener
  for (const id of candidates) if (await page.locator(id).isVisible()) { opener = id; break }
  if (!opener) {
    await page.locator('#openAppSettings').click()
    if (await page.locator('#settingsPane').getAttribute('data-page') !== 'main') await page.locator('#settingsBack').click()
    await page.locator('#settingsRowaccount').click()
    await page.locator('#signIn').waitFor({ state: 'visible' })
    opener = '#signIn'
  }
  await page.locator(opener).click()
  await picker.waitFor({ state: 'visible' })
  return { opened: true, existingPicker: false }
}
