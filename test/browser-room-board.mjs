// The room's board in the real claimed-Bothy room journey: cards and their
// files cross between two members through the selected Bothy, never through
// a public relay or file server. The enclosing journey counts every public
// frame for the board's stream; this module drives only visible controls.
import { expect } from '@playwright/test'
import { resolve } from 'node:path'
import { enterRoom } from './browser-room-entry.mjs'

const board = page => page.frameLocator('#roomBoardPanel iframe')
const card = (page, title) => board(page).getByRole('link', { name: title, exact: true })
const composer = page => board(page).getByRole('textbox', { name: 'Add a card to To do', exact: true })
const files = page => board(page).locator('.card-files')
const ownerCard = { title: 'Written by the keeper over Bothy', file: 'keeper-card.txt', text: 'The keeper’s card file, kept on the room’s Bothy.' }
const guestCard = { title: 'Written by the member over Bothy' }
// Where each board moment is photographed, for a person to look at afterwards.
let shots
const shoot = (page, name) => shots ? page.screenshot({ path: resolve(shots, `vennel-room-board-${name}.png`) }) : undefined

async function openBoard(page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  // The chat header's Board opens the board of the room that is open.
  await page.locator('#roomBoardButton').click()
  await expect(page.locator('#roomBoardPanel')).toBeVisible()
  await expect(composer(page)).toBeVisible({ timeout: 45000 })
  await expect(page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
}
async function closeBoard(page) {
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click()
  await expect(page.locator('#roomBoardPanel')).toBeHidden()
  // Back at the journey's phone size, which shows the list of chats: open the room from it.
  await page.setViewportSize({ width: 390, height: 844 })
  if (!await page.locator('#chatInput').isVisible()) await page.getByRole('button', { name: 'Open Untitled room', exact: true }).click()
  await expect(page.locator('#chatInput')).toBeVisible()
}
// Back from a card to the whole board.
async function toBoard(page) {
  await page.keyboard.press('Escape')
  if (!await composer(page).isVisible().catch(() => false)) await page.locator('#roomBoardButton').click().catch(() => {})
  await expect(composer(page)).toBeVisible()
}
async function write(page, { title, file, text }, withFile) {
  await composer(page).fill(title)
  await composer(page).press('Enter')
  await expect(card(page, title)).toBeVisible()
  if (!withFile) return
  await card(page, title).click()
  const choosing = page.waitForEvent('filechooser')
  await files(page).getByRole('button', { name: 'Add file', exact: true }).click()
  await (await choosing).setFiles({ name: file, mimeType: 'text/plain', buffer: Buffer.from(text) })
  // Private files were allowed beside the chat's file panel; a card asks for nothing more.
  await expect(page.locator('#actionDialog')).toBeHidden()
  await expect(files(page).getByRole('button', { name: `Download ${file}`, exact: true })).toBeVisible({ timeout: 90000 })
  await expect(board(page).getByText(new RegExp(`attached ${file.replace('.', '\\.')}\\.$`))).toBeVisible()
  await expect(page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.', { timeout: 60000 })
  await toBoard(page)
}
// Somebody else's card and its file, fetched and decrypted through this device's own route.
async function read(page, { title, file, text }, withFile, shot) {
  await expect(card(page, title)).toBeVisible({ timeout: 90000 })
  if (!withFile) { await shoot(page, shot); return }
  await card(page, title).click()
  await files(page).getByRole('button', { name: `Download ${file}`, exact: true }).click({ timeout: 45000 })
  const dialog = page.locator('#boardFileDialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /^Show/ }).click()
  await expect(dialog).toContainText(text, { timeout: 60000 })
  await shoot(page, shot)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
  await toBoard(page)
}

/** Both members write a card; each reads the other's. With `withFiles`, the keeper's card
 *  carries a file that the member opens: run that after both allowed private files. Only
 *  the box's keeper may upload to it (a member would need a blob grant, which Bothy does
 *  not issue yet), so the member's card carries none, exactly as the member's chat would. */
export async function roomBoardStart(owner, guest, withFiles, shotDir) {
  shots = shotDir
  await openBoard(owner.page)
  await write(owner.page, ownerCard, withFiles)
  await closeBoard(owner.page)
  await openBoard(guest.page)
  await read(guest.page, ownerCard, withFiles, 'member-reads-keeper-file')
  await write(guest.page, guestCard, false)
  await closeBoard(guest.page)
  await openBoard(owner.page)
  await read(owner.page, guestCard, false, 'keeper-sees-member-card')
  await closeBoard(owner.page)
  return { cardsBothWays: true, keeperFileReadByMember: withFiles, ownerUploads: withFiles ? 1 : 0, afterRestart: [] }
}

/** The box keeps the board for whoever comes later: the member is away while the keeper writes, the
 *  keeper is gone before the member comes back, and the card can then only have come from the box. */
export async function roomBoardLateReader(owner, guest, url, app, proof) {
  const away = 'Written while the member was away'
  await guest.page.goto('about:blank')
  await openBoard(owner.page)
  await write(owner.page, { title: away }, false)
  await expect(owner.page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.', { timeout: 60000 })
  await closeBoard(owner.page)
  await owner.page.goto('about:blank'); await owner.other?.goto('about:blank')
  await guest.page.goto(url); await enterRoom(guest.page)
  await openBoard(guest.page)
  await read(guest.page, { title: away }, false, 'member-returns-after-keeper-left')
  await closeBoard(guest.page)
  await owner.page.goto(url); await enterRoom(owner.page); await owner.other?.goto(app)
  proof.lateReader = true
}

/** After a cut, from a reloaded page: both cards are on the board and the keeper's file still opens. */
export async function roomBoardReadAfterRestart(guest, label, proof) {
  await guest.page.reload(); await enterRoom(guest.page)
  await openBoard(guest.page)
  await expect(card(guest.page, guestCard.title)).toBeVisible({ timeout: 90000 })
  await read(guest.page, ownerCard, proof.keeperFileReadByMember, `member-after-${label}-restart`)
  await closeBoard(guest.page)
  proof.afterRestart.push(label)
}
