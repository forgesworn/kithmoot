import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { createRoom, join, newDeviceContext, open, openRoomBoard } from './browser.js'

// A deployed site, after a deploy: `npm run test:live-site` with
// SITE_E2E_BASE_URL set (playwright.live-site.config.ts). Three visitors with
// a name and a room's link, on the site's own public relays. The board is
// read by the last to arrive, after the two who wrote it have gone, and the
// site must refuse nothing its own pages ask for. Public relays are weather:
// a red run here is worth one more before it is believed.

const board = (page: Page) => page.frameLocator('#roomBoardPanel iframe')
const card = (page: Page, title: string) => board(page).getByRole('link', { name: title, exact: true })

async function addCard(page: Page, title: string): Promise<void> {
  const composer = board(page).getByRole('textbox', { name: 'Add a card to To do', exact: true })
  await composer.click()
  await composer.fill(title)
  await composer.press('Enter')
  await expect(card(page, title)).toBeVisible({ timeout: 60_000 })
}

async function enter(page: Page, url: string, name: string): Promise<void> {
  await open(page, url, name)
  await join(page)
  await expect(page.locator('#roomArea')).toBeVisible({ timeout: 90_000 })
}

test('a room made on the deployed site has a board its last arrival can read', async ({ browser, baseURL }) => {
  const origin = new URL(baseURL!).origin
  const refusals: string[] = [], errors: string[] = [], failed: string[] = []
  const watched = async (who: string): Promise<BrowserContext> => {
    const context = await newDeviceContext(browser, baseURL!)
    await context.exposeBinding('liveSiteRefusal', (_source, text: string) => { refusals.push(`${who}: ${text}`) })
    // In every frame, the board's included: a policy refusal is the thing a
    // local build cannot show, because only the deployed site sends the headers.
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', event => {
        void (window as unknown as { liveSiteRefusal: (text: string) => Promise<void> }).liveSiteRefusal(`${event.violatedDirective} ${event.blockedURI} on ${location.pathname}`)
      })
    })
    context.on('page', page => {
      page.on('pageerror', error => errors.push(`${who}: ${error.message}`))
      page.on('response', response => {
        const url = new URL(response.url())
        if (response.status() >= 400 && url.origin === origin) failed.push(`${who}: ${response.status()} ${url.pathname}`)
      })
    })
    return context
  }
  const stamp = new Date().toISOString().slice(11, 19)
  const first = `Live check ${stamp}`, second = `Seen by the second ${stamp}`

  const adaContext = await watched('Ada')
  const ada = await adaContext.newPage()
  const url = await createRoom(ada, baseURL!, undefined, 'Ada')
  expect(new URL(url).origin).toBe(origin)
  await openRoomBoard(ada)
  for (const column of ['To do', 'Doing', 'Done']) await expect(board(ada).getByRole('heading', { name: column, exact: true })).toBeVisible({ timeout: 60_000 })
  await addCard(ada, first)
  await expect(ada.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.', { timeout: 60_000 })

  const boContext = await watched('Bo')
  const bo = await boContext.newPage()
  await enter(bo, url, 'Bo')
  await openRoomBoard(bo)
  await expect(card(bo, first)).toBeVisible({ timeout: 120_000 })
  await addCard(bo, second)
  await expect(card(ada, second)).toBeVisible({ timeout: 120_000 })
  await expect(bo.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.', { timeout: 60_000 })

  // Both writers go. Nobody is left to hand the board over.
  await adaContext.close()
  await boContext.close()

  const cyContext = await watched('Cy')
  const cy = await cyContext.newPage()
  await enter(cy, url, 'Cy')
  await openRoomBoard(cy)
  for (const title of [first, second]) await expect(card(cy, title)).toBeVisible({ timeout: 120_000 })
  await expect(board(cy).getByRole('heading', { name: 'To do', exact: true })).toHaveCount(1)
  await cy.screenshot({ path: test.info().outputPath('last-arrival-board.png') })
  await cyContext.close()

  // Reported rather than failed: a site that serves no /turn answers 404 by
  // design, and the test helpers' own media stand-ins can throw on a page
  // that has no camera. Read them; only a refusal fails the run.
  await test.info().attach('errors and failed requests', {
    body: JSON.stringify({ failed: [...new Set(failed)], errors: [...new Set(errors)] }, null, 2), contentType: 'application/json' })
  expect(refusals, 'the site refused something its own pages asked for').toEqual([])
})
