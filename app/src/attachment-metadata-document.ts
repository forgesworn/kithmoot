import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate'
import { PDFDocument, PDFDict, PDFName, PDFRef, PDFRawStream, PDFString, PDFHexString, PDFSignature } from 'pdf-lib'
import { cleanAttachment } from './attachment-metadata.js'

const fail = () => new Error('This document could not be cleaned safely. Nothing was uploaded. Export a fresh PDF or plain-text copy and try again.')
const MAX_EXPANDED = 64 * 1024 * 1024

export async function cleanPdf(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const original = await PDFDocument.load(bytes, { updateMetadata: false })
  if (original.getForm().getFields().some(field => field instanceof PDFSignature)) throw fail()
  // Flatten filled fields into page content before rebuilding. Copying only
  // current pages also omits old incremental revisions and orphaned info.
  if (original.getForm().getFields().length) original.getForm().flatten()
  const document = await PDFDocument.create({ updateMetadata: false })
  for (const page of await document.copyPages(original, original.getPageIndices())) document.addPage(page)
  const context = document.context
  for (const [ref, entry] of context.enumerateIndirectObjects()) {
    const object = entry instanceof PDFRawStream ? entry.dict : entry
    if (!(object instanceof PDFDict)) continue
    // Attachments, scripts and external-file streams are not page content.
    // Hold these PDFs rather than silently distributing an embedded original.
    const subtype = object.get(PDFName.of('Subtype'))?.toString()
    const external = object.get(PDFName.of('F'))
    if (object.get(PDFName.of('Type'))?.toString() === '/Filespec' || subtype === '/FileAttachment' || object.has(PDFName.of('EF')) || object.has(PDFName.of('JS')) || external instanceof PDFString || external instanceof PDFHexString) throw fail()
    for (const key of ['Metadata', 'PieceInfo']) {
      const value = object.get(PDFName.of(key)); object.delete(PDFName.of(key))
      if (value instanceof PDFRef) context.delete(value)
    }
    // Comments and form annotations can carry their own author and dates.
    if (object.has(PDFName.of('Subtype'))) for (const key of ['T', 'M', 'CreationDate', 'NM']) object.delete(PDFName.of(key))
    if (entry instanceof PDFRawStream && subtype === '/Image') {
      const filter = object.get(PDFName.of('Filter'))?.toString()
      if (filter === '/DCTDecode') context.assign(ref, PDFRawStream.of(object, cleanPdfJpeg(entry.contents)))
      // Opaque image codestreams can have their own metadata. JPEG and raw
      // pixel/Flate streams are covered; other image encodings stay unsent.
      else if (filter && filter !== '/FlateDecode' && filter !== '/CCITTFaxDecode') throw fail()
    }
    for (const key of ['Author', 'Creator', 'Producer', 'CreationDate', 'ModDate']) object.delete(PDFName.of(key))
  }
  delete context.trailerInfo.Info
  delete context.trailerInfo.ID
  // Removing a dictionary entry can leave an indirect string or nested
  // metadata object orphaned. Copy the reachable pages again so the writer
  // cannot include those no-longer-referenced objects in the output.
  const reachable = await PDFDocument.create({ updateMetadata: false })
  for (const page of await reachable.copyPages(document, document.getPageIndices())) reachable.addPage(page)
  return new Uint8Array(await reachable.save({ addDefaultPage: false, useObjectStreams: true }))
}

/** PDF image matrices already specify orientation. Strip JPEG application
 * and comment segments without recompressing embedded page pictures. */
function cleanPdfJpeg(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fail()
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]
  for (let offset = 2; offset < bytes.length;) {
    const start = offset
    if (bytes[offset++] !== 0xff) throw fail()
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]!
    if (marker === 0xd9) { parts.push(bytes.subarray(start, offset)); break }
    if (offset + 2 > bytes.length) throw fail()
    const size = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (size < 2 || offset + size > bytes.length) throw fail()
    offset += size
    if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) parts.push(bytes.subarray(start, offset))
    if (marker === 0xda) {
      const pixels = offset
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue }
        const next = bytes[offset + 1]
        if (next === 0 || next !== undefined && next >= 0xd0 && next <= 0xd7) { offset += 2; continue }
        break
      }
      parts.push(bytes.subarray(pixels, offset))
    }
  }
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

function parseXml(bytes: Uint8Array): XMLDocument {
  const value = strFromU8(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw fail()
  const document = new DOMParser().parseFromString(value, 'application/xml')
  if (document.querySelector('parsererror')) throw fail()
  return document
}

/** Office/OpenDocument archives are rebuilt with fixed ZIP timestamps and
 * no extra fields or comments. Macro/embedded-file containers are held. */
export async function cleanOffice(file: File, bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (!/\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(file.name)) throw fail()
  let total = 0, count = 0
  const entries = unzipSync(bytes, { filter: entry => {
    total += entry.originalSize
    if (++count > 10000 || total > MAX_EXPANDED || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) throw fail()
    if (entry.name.includes('..') || entry.name.startsWith('/') || /vbaProject|embeddings\/|_xmlsignatures\/|(?:^|\/)(?:Basic|Scripts)\//i.test(entry.name)) throw fail()
    return true
  } })
  if (!entries['[Content_Types].xml'] && !entries.mimetype) throw fail()
  const removed = new Set(Object.keys(entries).filter(name => /^docProps\//i.test(name) || /(?:^|\/)(?:comments[^/]*|commentAuthors|people|person[^/]*)\.xml$/i.test(name) || /^customXml\/|^Configurations2\/|^settings\.xml$|\/printerSettings\//i.test(name) || /(?:^|\/)thumbnail\.[^/]+$/i.test(name)))
  const result: Zippable = {}
  if (entries.mimetype) result.mimetype = [entries.mimetype, { mtime: new Date(1980, 0, 1), level: 0 }]
  for (const [name, value] of Object.entries(entries)) {
    if (removed.has(name) || name.endsWith('/') || name === 'mimetype') continue
    let cleaned: Uint8Array = value
    if (name === 'meta.xml') cleaned = strToU8('<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:meta/></office:document-meta>')
    else if (/\.(xml|rels)$/i.test(name)) {
      const document = parseXml(value)
      for (const element of [...document.getElementsByTagName('*')]) {
        if (['annotation', 'annotation-end', 'attachedTemplate', 'printerSettings'].includes(element.localName) || /^comment(?:RangeStart|RangeEnd|Reference)?$/.test(element.localName) || ['del', 'moveFrom'].includes(element.localName)) { element.remove(); continue }
        if (['ins', 'moveTo'].includes(element.localName)) { element.replaceWith(...element.childNodes); continue }
        for (const attribute of [...element.attributes]) if (/^(author|initials|date|created|modified|lastModifiedBy|rsid.*|paraId|textId)$/i.test(attribute.localName)) element.removeAttributeNode(attribute)
        if (element.localName === 'Relationship') {
          const type = element.getAttribute('Type') ?? ''
          if (/metadata\/(core-properties|extended-properties|custom-properties)|comments|person|people|customXml|thumbnail|printerSettings|attachedTemplate/i.test(type)) element.remove()
          const target = element.getAttribute('Target') ?? ''
          if (element.getAttribute('TargetMode') === 'External' && !/^(?:https?:|mailto:)/i.test(target)) throw fail()
        }
        if (element.localName === 'pageSetup') for (const attribute of [...element.attributes]) if (attribute.localName === 'id') element.removeAttributeNode(attribute)
        if (element.localName === 'Override' && removed.has((element.getAttribute('PartName') ?? '').replace(/^\//, ''))) element.remove()
        if (element.localName === 'file-entry' && removed.has(element.getAttribute('manifest:full-path') ?? '')) element.remove()
      }
      cleaned = strToU8(new XMLSerializer().serializeToString(document))
    } else if (/\/(?:media|Pictures)\//i.test('/' + name)) {
      const image = await cleanAttachment(new File([new Uint8Array(value)], name.split('/').pop()!))
      // Embedded documents point to exact paths/types: conversion would
      // invalidate those links, so refuse rather than silently break them.
      if (image.name !== name.split('/').pop()) throw fail()
      cleaned = new Uint8Array(await image.arrayBuffer())
    }
    result[name] = [cleaned, { mtime: new Date(1980, 0, 1), level: 6 }]
  }
  return new Uint8Array(zipSync(result))
}

export async function cleanDocument(file: File, bytes: Uint8Array, kind: string): Promise<Blob> {
  try {
    if (kind === 'pdf') return new Blob([await cleanPdf(bytes)], { type: 'application/pdf' })
    return new Blob([await cleanOffice(file, bytes)], { type: file.type || 'application/octet-stream' })
  } catch { throw fail() }
}
