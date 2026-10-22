// Optional extension of the existing real claimed-Bothy room journey.
// Uses only visible built-app controls and the declared disposable signers.
import assert from 'node:assert/strict'
import { expect } from '@playwright/test'
import { enterRoom } from './browser-room-entry.mjs'

const caption = 'Private file through the selected Bothy'
const plaintext = 'This private file survives app, box and relay restart without public storage.'
async function panel(page) {
  if (!await page.locator('#attachPanel').isVisible()) await page.locator('#attachToggle').click()
  await expect(page.locator('#privateFileStorage')).toBeVisible()
  await expect(page.locator('#attachOptions')).toBeHidden()
}
async function show(page) {
  const message = page.locator('#chatLog .msg').filter({hasText:caption}).first()
  await expect(message).toBeVisible({timeout:45000})
  await message.getByRole('button',{name:'Show',exact:true}).click()
  await expect(message.locator('.attachmentText')).toHaveText(plaintext,{timeout:45000})
}
export async function privateFileStart(owner, guest) {
  const page = owner.page
  await panel(page)
  await page.locator('#attachFile').setInputFiles({name:'private-route.txt',mimeType:'text/plain',buffer:Buffer.from(plaintext)})
  await expect(page.locator('#attachStatus')).toContainText('Private file access is off')
  await expect(page.locator('#attachStaged .attachChip')).toHaveCount(0)
  await page.locator('#allowPrivateFiles').click()
  await panel(page)
  await expect(page.locator('#uploadPendingFiles')).toBeEnabled()
  await page.locator('#uploadPendingFiles').click()
  await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1,{timeout:90000})
  await page.locator('#chatInput').fill(caption); await page.locator('#chatInput').press('Enter')
  await panel(guest.page)
  await guest.page.locator('#allowPrivateFiles').click()
  await show(guest.page)
  return {consentBeforeUpload:true,realBudUpload:true,secondProfileDecryption:true,restarts:[]}
}
export async function privateFileReadAfterRestart(guest, label, proof) {
  // The enclosing journey reloads the guest before the Bothy restart.
  // Reload again for later cuts, so an already-open Blob is never the oracle.
  if (label !== 'bothy') {
    await guest.page.reload(); await enterRoom(guest.page)
  }
  await show(guest.page); proof.restarts.push(label)
}
export async function privateFileOwnerCleanup(owner, app, proof) {
  const page = owner.page
  await page.goto(app)
  await expect(page.locator('#roomArea')).toBeHidden()
  await page.locator('#openAppSettings').click()
  if (!await page.locator('#bothySettingsOpen').isVisible()) await page.locator('#settingsRowconnections').click()
  await page.locator('#bothySettingsOpen').click()
  await page.getByRole('button',{name:'Connect or resume',exact:true}).click()
  await expect(page.locator('#bothyStatus')).toContainText('Connection resumed.',{timeout:60000})
  await page.locator('#bothyClose').click()
  await page.locator('#settingsBack').click()
  await page.locator('#settingsRowaccount').click()
  await page.locator('#forgetBrowser').click()
  const blockedForget = page.getByRole('alertdialog',{name:'Forget this browser?',exact:true})
  await blockedForget.getByRole('button',{name:'Forget this browser',exact:true}).click()
  await expect(page.locator('#forgetBrowserStatus')).toBeVisible()
  await expect(page.locator('#forgetBrowserStatus')).toContainText('Private upload records are retained.')
  await expect(page.locator('#homeSignIn')).toBeHidden()
  proof.unresolvedUploadBlocksForget = true
  await page.locator('#privateFileUploadsOpen').click()
  await expect(page.locator('#privateFileUploads')).toContainText('stored')
  await page.locator('#privateFileUploads').getByRole('button',{name:'Delete this upload',exact:true}).click()
  await expect(page.locator('#privateFileUploads')).toContainText('The box confirmed deletion of your upload.',{timeout:60000})
  await page.locator('#privateFileUploads').getByRole('button',{name:'Close',exact:true}).click()
  await page.locator('#privateFileUploadsOpen').click()
  await expect(page.locator('#privateFileUploads')).toContainText('No private uploads are recorded for this account.')
  await page.locator('#privateFileUploads').getByRole('button',{name:'Close',exact:true}).click()
  await page.locator('#forgetBrowser').click()
  const forget = page.getByRole('alertdialog',{name:'Forget this browser?',exact:true})
  await forget.getByRole('button',{name:'Forget this browser',exact:true}).click()
  await expect(page.locator('#homeSignIn')).toBeVisible({timeout:30000})
  const erased = await page.evaluate(async () => {
    const db = await new Promise((resolve,reject) => { const request=indexedDB.open('kithmoot-private-file-journal-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error) })
    try {
      const counts = await Promise.all(['keys','records'].map(name => new Promise((resolve,reject) => {
        const request=db.transaction(name,'readonly').objectStore(name).count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
      })))
      return {counts,revision:localStorage.getItem('kithmoot-private-file-journal-v1:revision')}
    } finally { db.close() }
  })
  assert.deepEqual(erased,{counts:[0,0],revision:null})
  proof.realIndexedDbForgotten = true
  proof.ownerCleanupWithoutRoom = true
  assert.equal(proof.restarts.join(','),'bothy,link-relay')
}
