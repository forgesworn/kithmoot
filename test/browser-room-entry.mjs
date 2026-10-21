import { expect } from '@playwright/test'

// Saved rooms may reopen automatically. Click only a genuine entry control;
// either path must still reach the visible room before the journey continues.
export async function enterRoom(page) {
  await expect(page.locator('#roomArea:visible, #join:visible').first()).toBeVisible({timeout:60000})
  if (!await page.locator('#roomArea').isVisible()) await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible({timeout:45000})
}
