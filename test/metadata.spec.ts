import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import notes from '../app/src/release-notes.json'

let api: string
test.beforeAll(async () => { api = (await build({ entryPoints: ['test/fixtures/metadata-api.ts'], bundle: true, write: false, format: 'iife', globalName: 'MetadataTest', target: 'es2022' })).outputFiles![0]!.text })

test('Metadata navigation explains disclosures without making an IP lookup', async ({ page, context, baseURL }, testInfo) => {
  let lookups = 0
  await context.route('https://ipwho.is/**', route => { lookups++; return route.fulfill({ json: { success: true, ip: '203.0.113.7', city: '<script>bad()</script>', country: 'Test', connection: { isp: 'Example provider' } } }) })
  await page.goto(baseURL!)
  await expect(page.locator('#releaseSummary')).toBeHidden()
  await page.locator('#railMetadata').click()
  await expect(page.locator('#metadataPane')).toBeVisible()
  await expect(page.locator('#metadataPane [data-meta-status]')).toContainText('Read at')
  await expect(page.locator('#metadataPane')).toContainText('Timing, volume, reused keys')
  expect(lookups).toBe(0)
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 850 })
    expect(await page.locator('#metadataPane').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
    if (width === 1440 || width === 390) await page.screenshot({ path: testInfo.outputPath(`metadata-${width}.png`) })
  }
  await page.getByRole('button', { name: 'Look up my IP and approximate location' }).click()
  await expect(page.locator('[data-meta-location]')).toContainText('203.0.113.7')
  await expect(page.locator('[data-meta-location]')).toContainText('<script>bad()</script>')
  expect(await page.locator('[data-meta-location] script').count()).toBe(0)
  expect(lookups).toBe(1)
  await page.locator('[data-meta-back]').click()
  await expect(page.locator('#metadataPane')).toBeHidden()
})

for (const profile of [
  { name: 'existing pre-notes', key: 'kithmoot.participant', value: 'a'.repeat(64) },
  { name: 'previously updated', key: 'kithmoot.release-notes-seen', value: 'older-version' },
]) test(`${profile.name} profiles can read changes again without activating an update`, async ({ page, baseURL }) => {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), profile)
  await page.goto(baseURL!)
  await expect(page.locator('#releaseSummary')).toBeVisible()
  await page.getByRole('button', { name: 'See what changed' }).click()
  const dialog = page.locator('#releaseNotes')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: notes.title, exact: true })).toBeVisible()
  await expect(dialog.getByRole('listitem')).toHaveText(notes.changes)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('#openAppSettings').click()
  await page.locator('#appWhatsNew').click()
  await expect(dialog).toBeVisible()
  await expect(page.locator('#updateNotice')).toBeHidden()
})

test('photos and office documents lose hidden metadata while keeping readable content', async ({ page, baseURL }) => {
  await page.goto(baseURL!)
  await page.route('**/metadata-test.js', route => route.fulfill({ contentType: 'text/javascript', body: api }))
  await page.addScriptTag({ url: new URL('metadata-test.js', baseURL!).href })
  const gif = [...await readFile('test/fixtures/animated-colours.gif')]
  const result = await page.evaluate(async gif => {
    const { cleanAttachment, zipSync, unzipSync, strToU8, strFromU8 } = (window as any).MetadataTest
    const canvas = document.createElement('canvas'); canvas.width = 13; canvas.height = 7
    canvas.getContext('2d')!.fillRect(0, 0, 13, 7)
    const image = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/jpeg'))
    const raw = new Uint8Array(await image.arrayBuffer()), marker = new TextEncoder().encode('PRIVATE_METADATA_SENTINEL'), exif = new Uint8Array(marker.length + 4)
    exif.set([255,225,0,marker.length+2]); exif.set(marker,4)
    const tagged = new Uint8Array(raw.length+exif.length); tagged.set(raw.subarray(0,2)); tagged.set(exif,2); tagged.set(raw.subarray(2),2+exif.length)
    const cleaned = await cleanAttachment(new File([tagged], 'photo.jpeg', {type:'image/jpeg'}))
    const bitmap = await createImageBitmap(cleaned)
    const bytes = new Uint8Array(await cleaned.arrayBuffer())
    const office = zipSync({
      '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/docProps/core.xml" ContentType="application/xml"/></Types>'),
      'docProps/core.xml': strToU8('<coreProperties>PRIVATE_METADATA_SENTINEL</coreProperties>'),
      'word/comments.xml': strToU8('<comments>PRIVATE_METADATA_SENTINEL</comments>'),
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p w:rsidR="PRIVATE_METADATA_SENTINEL"><w:ins w:author="PRIVATE_METADATA_SENTINEL"><w:r><w:t>Visible words</w:t></w:r></w:ins><w:del w:author="PRIVATE_METADATA_SENTINEL"><w:r><w:delText>Deleted private words</w:delText></w:r></w:del></w:p></w:body></w:document>'),
      'word/media/picture.jpeg': tagged,
    })
    const doc = await cleanAttachment(new File([office], 'notes.docx'))
    const entries = unzipSync(new Uint8Array(await doc.arrayBuffer()))
    const joined = Object.values(entries).map(value => strFromU8(value)).join('\n')
    const animated = await cleanAttachment(new File([Uint8Array.from(gif)], 'colours.gif', {type:'image/gif'}))
    return { width:bitmap.width,height:bitmap.height,name:cleaned.name,photoText:new TextDecoder('latin1').decode(bytes),entries:Object.keys(entries),xml:strFromU8(entries['word/document.xml']),joined,animation:[...new Uint8Array(await animated.arrayBuffer())] }
  }, gif)
  expect(result).toMatchObject({ width:13,height:7,name:'photo.jpeg',animation:gif })
  expect(result.photoText).not.toContain('PRIVATE_METADATA_SENTINEL')
  expect(result.joined).not.toContain('PRIVATE_METADATA_SENTINEL')
  expect(result.xml).toContain('Visible words')
  expect(result.xml).not.toContain('Deleted private words')
  expect(result.entries).toContain('word/media/picture.jpeg')
  expect(result.entries).not.toContain('docProps/core.xml')
})

test('OpenDocument settings are removed and embedded programs stay unsent', async ({ page, baseURL }) => {
  await page.goto(baseURL!)
  await page.route('**/metadata-test.js', route => route.fulfill({ contentType: 'text/javascript', body: api }))
  await page.addScriptTag({ url: new URL('metadata-test.js', baseURL!).href })
  const result = await page.evaluate(async () => {
    const { cleanAttachment, zipSync, unzipSync, strToU8, strFromU8 } = (window as any).MetadataTest
    const parts = {
      mimetype: strToU8('application/vnd.oasis.opendocument.text'),
      'meta.xml': strToU8('<metadata>PRIVATE_METADATA_SENTINEL</metadata>'),
      'settings.xml': strToU8('<settings>PRIVATE_METADATA_SENTINEL</settings>'),
      'content.xml': strToU8('<document><p>Readable text</p><annotation>PRIVATE_METADATA_SENTINEL</annotation></document>'),
    }
    const cleaned = await cleanAttachment(new File([zipSync(parts)], 'notes.odt'))
    const entries = unzipSync(new Uint8Array(await cleaned.arrayBuffer()))
    const held: boolean[] = []
    for (const name of ['Basic/script.xml', 'Scripts/python/private.py', 'word/vbaProject.bin', 'word/embeddings/original.docx']) {
      try { await cleanAttachment(new File([zipSync({ ...parts, [name]: strToU8('PRIVATE_METADATA_SENTINEL') })], 'embedded.odt')); held.push(false) }
      catch { held.push(true) }
    }
    return { entries: Object.keys(entries), text: Object.values(entries).map(value => strFromU8(value)).join('\n'), held }
  })
  expect(result.entries).not.toContain('settings.xml')
  expect(result.text).toContain('Readable text')
  expect(result.text).not.toContain('PRIVATE_METADATA_SENTINEL')
  expect(result.held).toEqual([true, true, true, true])
})
