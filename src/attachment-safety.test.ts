import { describe, expect, it } from 'vitest'
import { assessAttachment, cleanFileName, familyLabel, sniffKind, type SniffKind } from './attachment-safety.js'

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v)
const ascii = (s: string): number[] => [...s].map(c => c.charCodeAt(0))
const pad = (v: number[], n = 64): Uint8Array => Uint8Array.from([...v, ...new Array(Math.max(0, n - v.length)).fill(0x20)])
const PE = pad([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const ZIP = pad([0x50, 0x4b, 0x03, 0x04, 20, 0])
const PDF = pad(ascii('%PDF-1.7\n'))
const TEXT = pad(ascii('Meet at the car park at 9.'))
const RLO = '‮'

describe('cleanFileName', () => {
  it('removes a right-to-left override and says so', () => {
    expect(cleanFileName(`invoice${RLO}fdp.exe`)).toEqual({ name: 'invoicefdp.exe', ext: 'exe', hadDirectionControls: true })
  })
  it('removes zero-width characters so the real extension shows', () => {
    expect(cleanFileName('photo.jpg​.exe')).toMatchObject({ name: 'photo.jpg.exe', ext: 'exe' })
  })
  it('drops trailing dots and spaces, which Windows would drop on disk', () => {
    expect(cleanFileName('report.pdf.').name).toBe('report.pdf')
    expect(cleanFileName('report.exe . ').name).toBe('report.exe')
  })
  it('prefixes Windows device names', () => {
    expect(cleanFileName('CON.txt').name).toBe('_CON.txt')
    expect(cleanFileName('com1').name).toBe('_com1')
    expect(cleanFileName('LPT9.log').name).toBe('_LPT9.log')
    expect(cleanFileName('console.txt').name).toBe('console.txt')
  })
  it('collapses white space and replaces path characters', () => {
    expect(cleanFileName('a   b.txt').name).toBe('a b.txt')
    expect(cleanFileName('..\\..\\etc/passwd').name).toBe('_.._etc_passwd')
    expect(cleanFileName('a<b>:"c|d?e*.txt').name).toBe('a_b___c_d_e_.txt')
  })
  it('strips leading dots', () => { expect(cleanFileName('...hidden.txt').name).toBe('hidden.txt') })
  it('caps at 180 units, keeping the extension and never splitting a pair', () => {
    const long = cleanFileName(`${'a'.repeat(300)}.exe`)
    expect(long.name.length).toBe(180)
    expect(long.name.endsWith('.exe')).toBe(true)
    const emoji = cleanFileName(`${'\u{1f600}'.repeat(200)}.png`)
    expect(emoji.name.length).toBeLessThanOrEqual(180)
    expect(emoji.name.endsWith('.png')).toBe(true)
    expect(() => encodeURIComponent(emoji.name)).not.toThrow()
  })
  it('gives file when nothing is left, with the sniffed extension when known', () => {
    expect(cleanFileName('​‮⁦')).toEqual({ name: 'file', ext: '', hadDirectionControls: true })
    expect(cleanFileName('​', 'png').name).toBe('file.png')
  })
  it('reads no extension from odd tails', () => {
    expect(cleanFileName('notes').ext).toBe('')
    expect(cleanFileName('a.thisistoolongext').ext).toBe('')
    expect(cleanFileName('A.TXT').ext).toBe('txt')
  })
})

describe('sniffKind', () => {
  const samples: Array<[SniffKind, Uint8Array]> = [
    ['png', PNG],
    ['jpeg', pad([0xff, 0xd8, 0xff, 0xe0])],
    ['gif', pad(ascii('GIF89a'))],
    ['webp', pad([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')])],
    ['avif', pad([0, 0, 0, 0x1c, ...ascii('ftypavif')])],
    ['heic', pad([0, 0, 0, 0x18, ...ascii('ftypheic')])],
    ['bmp', pad(ascii('BM'))],
    ['ico', pad([0, 0, 1, 0, 1, 0])],
    ['svg', pad(ascii('<?xml version="1.0"?><!-- c --> <svg xmlns="http://www.w3.org/2000/svg"></svg>'), 100)],
    ['pdf', PDF],
    ['mp4', pad([0, 0, 0, 0x20, ...ascii('ftypisom')])],
    ['webm', pad([0x1a, 0x45, 0xdf, 0xa3])],
    ['ogg', pad(ascii('OggS'))],
    ['mp3', pad(ascii('ID3'))],
    ['wav', pad([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])],
    ['flac', pad(ascii('fLaC'))],
    ['zip', ZIP],
    ['ole', pad([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ['exe-windows', PE],
    ['exe-elf', pad([0x7f, 0x45, 0x4c, 0x46])],
    ['exe-mac', pad([0xcf, 0xfa, 0xed, 0xfe])],
    ['script', pad(ascii('#!/bin/sh\n'))],
    ['shortcut-windows', pad([0x4c, 0, 0, 0, 1, 0x14, 2, 0])],
    ['text', TEXT],
    ['unknown', bytes(0x01, 0x02, 0x00, 0xff, 0x13, 0x37, 0x00, 0x99)],
  ]
  for (const [kind, sample] of samples) it(`reads ${kind}`, () => expect(sniffKind(sample)).toBe(kind))

  it('finds %PDF- later in the first kilobyte but not after it', () => {
    expect(sniffKind(Uint8Array.from([...ascii('junk'.repeat(50)), ...ascii('%PDF-1.4')]))).toBe('pdf')
    const far = new Uint8Array(1100).fill(0x41)
    far.set(ascii('%PDF-'), 1050)
    expect(sniffKind(far)).toBe('text')
  })
  it('lets a multi-byte character cut by the window pass as text', () => {
    const b = new Uint8Array(1024).fill(0x61)
    b.set([0xe2, 0x82], 1022)
    expect(sniffKind(b)).toBe('text')
  })
  it('does not call text with a NUL or bad UTF-8 text', () => {
    expect(sniffKind(pad([...ascii('hello'), 0]))).toBe('unknown')
    expect(sniffKind(pad([0xc3, 0x28]))).toBe('unknown')
  })
})

const assess = (envelopeName: string, declaredType: string, head: Uint8Array, messageName = envelopeName) =>
  assessAttachment({ bytes: head, envelopeName, declaredType, messageName, sender: 'Rowan' })

describe('assessAttachment', () => {
  it('blocks a program declared and named as a picture', () => {
    const d = assess('cat.png', 'image/png', PE)
    expect(d).toMatchObject({ tier: 'block', save: 'block', preview: 'none', reason: 'disguised-program', family: 'Windows program' })
    expect(d.message).toBe('KithMoot won’t open or save this. It’s named like a picture, but it’s really a Windows program. That’s a common way to hide an attack.')
  })
  it('blocks ELF and Mach-O bytes under a document name', () => {
    expect(assess('minutes.pdf', 'application/pdf', pad([0x7f, 0x45, 0x4c, 0x46])).tier).toBe('block')
    expect(assess('minutes.pdf', 'application/pdf', pad([0xca, 0xfe, 0xba, 0xbe])).tier).toBe('block')
  })
  it('blocks any shortcut, by name or by bytes', () => {
    expect(assess('Holiday.lnk', 'application/octet-stream', TEXT).tier).toBe('block')
    expect(assess('Holiday.pdf', 'application/pdf', pad([0x4c, 0, 0, 0, 1, 0x14, 2, 0])).reason).toBe('shortcut')
    expect(assess('a.URL', 'text/plain', TEXT).tier).toBe('block')
  })
  it('warns on an honest program and words it', () => {
    const d = assess('MapSetup.exe', 'application/octet-stream', PE)
    expect(d).toMatchObject({ tier: 'warn', save: 'warn', preview: 'none', reason: 'program', family: 'Windows program' })
    expect(d.message).toBe('Programs can take over your computer. Only save this if you asked Rowan for it.')
    expect(d.confirmation).toBe('It’s a Windows program. Programs can take over your computer. Only save it if you asked Rowan for it.')
  })
  it('warns on an invoice with hidden characters, naming what it is and what it said', () => {
    const d = assess(`invoice${RLO}fdp.exe`, 'application/pdf', PE, 'invoicefdp.exe')
    expect(d.name).toBe('invoicefdp.exe')
    expect(d.reason).toBe('direction-controls')
    expect(d.message).toBe('This file’s name had hidden characters that make it read differently. KithMoot removed them. It’s a Windows program, not a PDF.')
  })
  it('drops the last hidden-characters sentence when the families agree', () => {
    const d = assess(`holiday${RLO}gnp.png`, 'image/png', PNG)
    expect(d.message).toBe('This file’s name had hidden characters that make it read differently. KithMoot removed them.')
  })
  it('warns on macro workbooks, archives, web pages and scripts', () => {
    expect(assess('budget.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12', ZIP)).toMatchObject({ tier: 'warn', reason: 'macros', family: 'Office file with macros' })
    expect(assess('album.zip', 'application/zip', ZIP)).toMatchObject({ tier: 'warn', reason: 'archive', family: 'Archive' })
    expect(assess('run.sh', 'application/x-sh', pad(ascii('#!/bin/sh\n')))).toMatchObject({ tier: 'warn', reason: 'script' })
    expect(assess('disk.dmg', 'application/octet-stream', TEXT)).toMatchObject({ tier: 'warn', reason: 'disk-image' })
  })
  it('warns on a declared picture whose bytes are an archive', () => {
    const d = assess('holiday.png', 'image/png', ZIP)
    expect(d).toMatchObject({ tier: 'warn', reason: 'mismatch', preview: 'none' })
    expect(d.message).toBe('This file says it’s a picture, but it’s really an archive.')
    expect(d.confirmation).toContain('An archive can hold programs. Only save it if you were expecting it.')
  })
  it('warns when the message name and envelope name end differently', () => {
    const d = assess('photo.exe', 'application/octet-stream', PE, 'photo.jpg')
    expect(d.reason).toBe('name-changed')
    expect(d.message).toBe('This file was sent as photo.jpg, but the file inside is photo.exe.')
  })
  it('keeps the text preview of a web page, with a warning on Save', () => {
    const d = assess('page.html', 'text/html', pad(ascii('<h1>hi</h1>')))
    expect(d).toMatchObject({ tier: 'warn', reason: 'web-page', preview: 'text' })
  })
  it('previews an SVG through an image, with a warning on Save', () => {
    const d = assess('logo.svg', 'image/svg+xml', pad(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')))
    expect(d).toMatchObject({ tier: 'warn', preview: 'image', mime: 'image/svg+xml' })
  })
  it('previews honest files quietly, as the type the bytes are', () => {
    expect(assess('hilltop.png', 'image/png', PNG)).toMatchObject({ tier: 'inline', save: 'quiet', preview: 'image', mime: 'image/png', family: 'Image' })
    expect(assess('hilltop.png', 'image/jpeg', PNG)).toMatchObject({ tier: 'inline', mime: 'image/png' })
    expect(assess('minutes.pdf', 'application/pdf', PDF)).toMatchObject({ tier: 'inline', preview: 'pdf', mime: 'application/pdf' })
    expect(assess('route-notes.txt', 'text/plain', TEXT)).toMatchObject({ tier: 'inline', preview: 'text' })
    expect(assess('clip.mp4', 'video/mp4', pad([0, 0, 0, 0x20, ...ascii('ftypisom')]))).toMatchObject({ tier: 'inline', preview: 'video', mime: 'video/mp4' })
    expect(assess('song.mp3', 'audio/mpeg', pad(ascii('ID3')))).toMatchObject({ tier: 'inline', preview: 'audio', mime: 'audio/mpeg' })
  })
  it('does not call a declared video with unknown bytes a mismatch', () => {
    expect(assess('clip.bin2', 'video/x-weird', bytes(1, 2, 0, 3)).tier).toBe('inline')
    expect(assess('clip.mp4', 'video/mp4', ZIP).tier).toBe('warn')
  })
  it('offers a quiet save for the rest', () => {
    expect(assess('budget.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP)).toMatchObject({ tier: 'save', save: 'quiet', preview: 'none', family: 'Document' })
    expect(assess('data.csv', 'text/csv', TEXT).tier).toBe('inline')
    expect(assess('mystery', 'application/octet-stream', bytes(1, 0, 2)).tier).toBe('save')
  })
  it('treats declared text with binary bytes as a mismatch', () => {
    expect(assess('notes.txt', 'text/plain', bytes(0x01, 0, 2, 3)).reason).toBe('mismatch')
  })
  it('keeps the same family word for a closed card from its name', () => {
    expect(familyLabel({ ext: 'exe', declaredType: 'application/pdf' })).toBe('Windows program')
    expect(familyLabel({ ext: 'png', declaredType: 'image/png' })).toBe('Image')
    expect(familyLabel({ ext: '' })).toBe('File')
  })
})
