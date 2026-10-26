import { accountNetworkState } from './mixed-invitation-account-network.mjs'

/** Explicit product Connect signer button only. Never navigates or changes policy. */
export async function openPrivateSignerPicker(page) {
  if ((await accountNetworkState(page)).mode !== 'private-invitations') throw new Error('Rendered private invitation mode required')
  const picker = page.locator('#signet-login-dialog')
  if (await picker.isVisible()) return { opened: false, existingPicker: true }
  const opener = await page.locator('#homeSignIn').isVisible() ? '#homeSignIn'
    : await page.locator('#signIn').isVisible() ? '#signIn' : undefined
  if (!opener) throw new Error('Visible product Connect signer button required')
  await page.locator(opener).click()
  await picker.waitFor({ state: 'visible' })
  return { opened: true, existingPicker: false }
}
