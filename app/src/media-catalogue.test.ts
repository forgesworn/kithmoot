import { it, expect } from 'vitest'
import { catalogueResults, commonsImageURL } from './media-catalogue.js'
const info = { url: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/cat.gif?utm_source=example', mime: 'image/gif', size: 4000, width: 120, height: 120,
  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cat.gif', extmetadata: { Artist: { value: '<b>Artist</b>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } } }
const data = (over: Record<string, unknown> = {}) => ({ query: { pages: { '1': { title: 'File:Cat.gif', imageinfo: [{ ...info, ...over }] } } } })
it('offers bounded eligible files with licence attribution and strips catalogue tracking parameters', () => {
  expect(catalogueResults(data())).toEqual([{ name: 'Cat.gif', url: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/cat.gif', type: 'image/gif', bytes: 4000,
    source: info.descriptionurl, credit: 'Artist · CC BY-SA 4.0' }])
  for (const over of [{ size: 9 * 1024 * 1024 }, { width: 100_000 }, { mime: 'image/svg+xml' }, { url: 'https://evil.example/cat.gif' },
    { descriptionurl: 'https://evil.example/source' }, { extmetadata: {} }]) expect(catalogueResults(data(over))).toEqual([])
})
it('refuses arbitrary hosts and embedded credentials for previews and downloads', () => {
  for (const url of ['http://upload.wikimedia.org/wikipedia/commons/x.gif', 'https://upload.wikimedia.org.evil.example/wikipedia/commons/x.gif',
    'https://user:password@upload.wikimedia.org/wikipedia/commons/x.gif', 'javascript:alert(1)', 'https://upload.wikimedia.org/other/x.gif']) expect(commonsImageURL(url)).toBeUndefined()
})
