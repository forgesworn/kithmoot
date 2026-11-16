import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PDFDocument, PDFName, PDFString, PDFRawStream } from 'pdf-lib'
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny'
import { cleanAttachment, cleanGif, cleanAnimatedPng, cleanWebp } from './attachment-metadata.js'
import { cleanPdf } from './attachment-metadata-document.js'

const sentinel = 'PRIVATE_METADATA_SENTINEL'
const ascii = (s: string) => new TextEncoder().encode(s)
const concat = (...arrays: Uint8Array[]) => Uint8Array.from(arrays.flatMap(a => [...a]))
const content = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('local attachment metadata cleaning', () => {
  it('preserves text, caches a cleaned retry and never mutates the original', async () => {
    const original = new File(['hello'], 'notes.txt', { lastModified: 123 })
    const clean = await cleanAttachment(original)
    expect(clean).not.toBe(original)
    expect(await clean.text()).toBe('hello')
    expect(clean.lastModified).toBe(0)
    expect(await cleanAttachment(original)).toBe(clean)
    expect(await cleanAttachment(clean)).toBe(clean)
    expect(original.lastModified).toBe(123)
  })
  it('holds unknown containers, malformed supported files and cancelled sends without network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    try {
      for (const f of [new File(['MZbinary'], 'photo.jpg'), new File(['<html>private</html>'], 'page.html'), new File(['%PDF-broken'], 'broken.pdf'), new File([new Uint8Array(0)], 'empty.txt')]) await expect(cleanAttachment(f)).rejects.toThrow()
      const controller = new AbortController(); controller.abort()
      expect(() => cleanAttachment(new File(['hi'], 'a.txt'), controller.signal)).toThrow()
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })
  it('removes GIF comments while retaining frames and loop timing', async () => {
    const source = new Uint8Array(await readFile('test/fixtures/animated-colours.gif'))
    const comment = concat(Uint8Array.of(0x21, 0xfe, sentinel.length), ascii(sentinel), Uint8Array.of(0))
    const tagged = concat(source.subarray(0, source.length - 1), comment, Uint8Array.of(0x3b), ascii(sentinel))
    expect(cleanGif(tagged)).toEqual(source)
    expect(() => cleanGif(tagged.subarray(0, 15))).toThrow()
  })
  it('removes PNG ancillary metadata and rejects truncated chunks', () => {
    const chunk = (name: string, data: Uint8Array) => { const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, data.length); return concat(size, ascii(name), data, new Uint8Array(4)) }
    const image = concat(Uint8Array.of(137,80,78,71,13,10,26,10), chunk('IHDR', new Uint8Array(13)), chunk('acTL', new Uint8Array(8)), chunk('IDAT', Uint8Array.of(1)), chunk('IEND', new Uint8Array()))
    const tagged = concat(image.subarray(0, image.length - 12), chunk('tEXt', ascii(sentinel)), chunk('eXIf', ascii(sentinel)), image.subarray(image.length - 12), ascii(sentinel))
    expect(cleanAnimatedPng(tagged)).toEqual(image)
    expect(() => cleanAnimatedPng(tagged.subarray(0, 22))).toThrow()
  })
  it('removes WebP EXIF/XMP and clears the metadata flags', () => {
    const chunk = (kind: string, bytes: Uint8Array) => { const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, bytes.length, true); return concat(ascii(kind), size, bytes, new Uint8Array(bytes.length % 2)) }
    const bytes = concat(ascii('RIFF'), new Uint8Array(4), ascii('WEBP'), chunk('VP8X', Uint8Array.of(0x2c,0,0,0,0,0,0,0,0,0)), chunk('EXIF',ascii(sentinel)), chunk('XMP ',ascii(sentinel)),chunk('VP8 ',Uint8Array.of(1,2)))
    new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
    const clean = cleanWebp(bytes)
    expect(content(clean)).not.toContain(sentinel)
    expect(clean[20]).toBe(0)
    expect(content(clean)).toContain('VP8 ')
    expect(new DataView(clean.buffer).getUint32(4,true)).toBe(clean.length - 8)
  })
  it('rebuilds PDF pages without author, dates, XMP or orphaned editing data', async () => {
    const doc = await PDFDocument.create(); const page = doc.addPage([100, 120]); page.drawText('Visible words')
    doc.setAuthor(sentinel); doc.setTitle(sentinel); doc.setCreationDate(new Date('2001-01-01'))
    const meta = doc.context.register(doc.context.stream(ascii(sentinel), { Type: 'Metadata', Subtype: 'XML' }))
    page.node.set(PDFName.of('Metadata'), meta)
    const author = doc.context.register(PDFString.of(sentinel))
    const annotation = doc.context.register(doc.context.obj({ Type:'Annot', Subtype:'Text', T:author, Rect:[0,0,10,10], Contents:PDFString.of('Visible comment') }))
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotation]))
    const bytes = await doc.save({ useObjectStreams: false })
    expect(content(bytes)).toContain(sentinel)
    const cleaned = await cleanPdf(bytes), opened = await PDFDocument.load(cleaned, { updateMetadata: false })
    expect(content(cleaned)).not.toContain(sentinel)
    expect(opened.getAuthor()).toBeUndefined(); expect(opened.getTitle()).toBeUndefined(); expect(opened.getCreationDate()).toBeUndefined()
    expect(opened.getPageCount()).toBe(1); expect(opened.getPage(0).getSize()).toEqual({ width: 100, height: 120 })
  })
  it('strips EXIF from a JPEG embedded in a PDF without changing the compressed picture', async () => {
    const jpeg = new Uint8Array(await readFile('test/fixtures/metadata/plain.jpg'))
    const marker = concat(Uint8Array.of(255,225,0,sentinel.length + 2),ascii(sentinel))
    const tagged = concat(jpeg.subarray(0,2),marker,jpeg.subarray(2))
    const doc = await PDFDocument.create(), image = await doc.embedJpg(tagged)
    doc.addPage([100,120]).drawImage(image,{x:0,y:0,width:100,height:120})
    const cleaned = await cleanPdf(await doc.save()), opened = await PDFDocument.load(cleaned,{updateMetadata:false})
    const pictures = opened.context.enumerateIndirectObjects().map(([,o])=>o).filter(o=>o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString()==='/Image') as PDFRawStream[]
    expect(pictures).toHaveLength(1)
    expect(content(pictures[0]!.contents)).not.toContain(sentinel)
    expect(pictures[0]!.contents.length).toBeGreaterThan(100)
  })
  it('holds PDF embedded originals instead of distributing their metadata', async () => {
    const doc = await PDFDocument.create(); doc.addPage(); await doc.attach(ascii(sentinel), 'private.txt')
    // copyPages intentionally drops document-level embedded attachments.
    const cleaned = await cleanPdf(await doc.save())
    expect(content(cleaned)).not.toContain(sentinel)
  })
  it.each(['wav','mp3','flac','ogg','mp4','webm'])('cleans %s tags and track names while retaining every audio/video packet', async ext => {
    const original = new File([new Uint8Array(await readFile(`test/fixtures/metadata/tagged.${ext}`))], `sample.${ext}`)
    const inspect = async (blob: Blob) => {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
      try {
        const tags = await input.getMetadataTags(), tracks = await input.getTracks()
        const packets = []
        for (const track of tracks) {
          const data = []
          for await (const packet of new EncodedPacketSink(track).packets()) data.push(Buffer.from(packet.data).toString('hex'))
          packets.push({ data, name: track.name, language: track.languageCode })
        }
        return { tags, packets }
      } finally { input.dispose() }
    }
    const before = await inspect(original), cleaned = await cleanAttachment(original), after = await inspect(cleaned)
    expect(Object.keys(before.tags).length).toBeGreaterThan(0)
    expect(JSON.stringify(after.tags)).not.toContain(sentinel)
    expect(JSON.stringify(after.packets.map(p => [p.name, p.language]))).not.toContain(sentinel)
    expect(after.packets.map(p => p.data)).toEqual(before.packets.map(p => p.data))
    expect(cleaned.size).toBeGreaterThan(0)
  })
})
