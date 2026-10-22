/**
 * What to do with a file somebody else sent, decided from the file itself.
 *
 * A message names a file and declares its type, and both are the sender's
 * word. Once the file has been fetched, checked against its hash and
 * decrypted, this module reads what is actually there (its name inside the
 * envelope and its first bytes) and decides whether the card may preview it,
 * must warn before it is saved, or must refuse it. It is pure: no DOM, no
 * network, no storage. The browser, the desktop app and a headless agent
 * share it, and `vectors/attachment-safety-v1.json` pins its answers so a
 * second implementation (Android) decides the same way.
 *
 * It runs on the decrypted file, whichever fetch produced it, so a later
 * authenticated fetch path needs no second copy of the policy.
 */

/** Longest cleaned file name, in UTF-16 units. */
const MAX_CLEAN_NAME = 180
/** How much of a file the sniff reads. */
export const SNIFF_BYTES = 1024

export interface CleanedFileName {
  /** The name to show and save under. Never empty. */
  name: string
  /** The real extension: after the last dot, lower-case, 1 to 10 of [a-z0-9-], else ''. */
  ext: string
  /** True when the raw name held bidirectional control characters. */
  hadDirectionControls: boolean
}

const DIRECTION_CONTROLS = /[‪-‮⁦-⁩]/u
const BLANK_FILLERS = /[ᅟᅠㅤﾠ]/gu
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  const ext = name.slice(dot + 1).toLowerCase()
  return /^[a-z0-9-]{1,10}$/.test(ext) ? ext : ''
}

/** Cut `text` to at most `limit` UTF-16 units without splitting a surrogate pair. */
function cutUnits(text: string, limit: number): string {
  if (text.length <= limit) return text
  let end = limit
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * The one rule for a file name, applied to anything that is displayed,
 * spoken or saved. Does not change the envelope, only what is made of it.
 * `fallbackExt` is used when nothing is left and the sniffed kind has a
 * usual extension.
 */
export function cleanFileName(raw: string, fallbackExt = ''): CleanedFileName {
  let s = raw.normalize('NFC')
  const hadDirectionControls = DIRECTION_CONTROLS.test(s)
  s = s.replace(/[\u2028\u2029]/gu, ' ').replace(/\s+/gu, ' ')
  s = s.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(BLANK_FILLERS, '')
  s = s.replace(/[\/\\<>:"|?*]/gu, '_')
  s = s.trim().replace(/^\.+/u, '').replace(/[. ]+$/u, '')
  if (s) {
    const firstDot = s.indexOf('.')
    const stem = firstDot === -1 ? s : s.slice(0, firstDot)
    if (WINDOWS_DEVICE.test(stem)) s = `_${s}`
  }
  if (!s) s = fallbackExt ? `file.${fallbackExt}` : 'file'
  if (s.length > MAX_CLEAN_NAME) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 11 ? s.slice(dot) : ''
    s = cutUnits(s.slice(0, s.length - ext.length), MAX_CLEAN_NAME - ext.length) + ext
  }
  return { name: s, ext: extensionOf(s), hadDirectionControls }
}

export type SniffKind =
  | 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'heic' | 'bmp' | 'ico' | 'svg' | 'pdf'
  | 'mp4' | 'webm' | 'ogg' | 'mp3' | 'wav' | 'flac'
  | 'zip' | 'ole' | 'exe-windows' | 'exe-elf' | 'exe-mac' | 'script' | 'shortcut-windows'
  | 'text' | 'unknown'

const startsWith = (b: Uint8Array, at: number, ...bytes: number[]): boolean =>
  bytes.every((v, i) => b[at + i] === v)
const ascii = (b: Uint8Array, at: number, s: string): boolean =>
  [...s].every((c, i) => b[at + i] === c.charCodeAt(0))

function decodesAsUtf8(head: Uint8Array): boolean {
  try {
    // `stream` lets a multi-byte character cut by the 1,024 byte window pass.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
    return true
  } catch {
    return false
  }
}

/** Whether the text opens with an `<svg` element, after an XML declaration, comments and white space. */
function opensWithSvg(head: Uint8Array): boolean {
  let s: string
  try { s = new TextDecoder('utf-8').decode(head) } catch { return false }
  s = s.replace(/^﻿/u, '')
  for (;;) {
    s = s.trimStart()
    if (s.startsWith('<?')) { const end = s.indexOf('?>'); if (end < 0) return false; s = s.slice(end + 2); continue }
    if (s.startsWith('<!--')) { const end = s.indexOf('-->'); if (end < 0) return false; s = s.slice(end + 3); continue }
    if (/^<!doctype[^>]*>/iu.test(s)) { s = s.replace(/^<!doctype[^>]*>/iu, ''); continue }
    break
  }
  return /^<svg[\s>/]/iu.test(s)
}

/** What the first bytes say the file is. The in-house table: no dependency. */
export function sniffKind(bytes: Uint8Array): SniffKind {
  const b = bytes.subarray(0, SNIFF_BYTES)
  if (startsWith(b, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (startsWith(b, 0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif'
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp'
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'wav'
  if (ascii(b, 4, 'ftyp')) {
    const brand = String.fromCharCode(...b.subarray(8, 12))
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (['heic', 'heix', 'mif1'].includes(brand)) return 'heic'
    return 'mp4'
  }
  if (ascii(b, 0, 'BM')) return 'bmp'
  if (startsWith(b, 0, 0x00, 0x00, 0x01, 0x00)) return 'ico'
  if (startsWith(b, 0, 0x1a, 0x45, 0xdf, 0xa3)) return 'webm'
  if (ascii(b, 0, 'OggS')) return 'ogg'
  if (ascii(b, 0, 'fLaC')) return 'flac'
  if (ascii(b, 0, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3'
  if (startsWith(b, 0, 0x50, 0x4b, 0x03, 0x04) || startsWith(b, 0, 0x50, 0x4b, 0x05, 0x06) || startsWith(b, 0, 0x50, 0x4b, 0x07, 0x08)) return 'zip'
  if (startsWith(b, 0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'ole'
  if (ascii(b, 0, 'MZ')) return 'exe-windows'
  if (startsWith(b, 0, 0x7f, 0x45, 0x4c, 0x46)) return 'exe-elf'
  if (startsWith(b, 0, 0xfe, 0xed, 0xfa, 0xce) || startsWith(b, 0, 0xfe, 0xed, 0xfa, 0xcf)
    || startsWith(b, 0, 0xce, 0xfa, 0xed, 0xfe) || startsWith(b, 0, 0xcf, 0xfa, 0xed, 0xfe)
    || startsWith(b, 0, 0xca, 0xfe, 0xba, 0xbe)) return 'exe-mac'
  if (ascii(b, 0, '#!')) return 'script'
  if (startsWith(b, 0, 0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00)) return 'shortcut-windows'
  if (indexOfAscii(b, '%PDF-') >= 0) return 'pdf'
  if (!b.includes(0) && decodesAsUtf8(b)) return opensWithSvg(b) ? 'svg' : 'text'
  return 'unknown'
}

function indexOfAscii(b: Uint8Array, s: string): number {
  outer: for (let i = 0; i + s.length <= b.length; i++) {
    for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer
    return i
  }
  return -1
}

export type SniffFamily = 'image' | 'svg' | 'pdf' | 'media' | 'archive' | 'ole' | 'program' | 'shortcut' | 'text' | 'unknown'

export function sniffFamily(kind: SniffKind): SniffFamily {
  switch (kind) {
    case 'png': case 'jpeg': case 'gif': case 'webp': case 'avif': case 'heic': case 'bmp': case 'ico': return 'image'
    case 'svg': return 'svg'
    case 'pdf': return 'pdf'
    case 'mp4': case 'webm': case 'ogg': case 'mp3': case 'wav': case 'flac': return 'media'
    case 'zip': return 'archive'
    case 'ole': return 'ole'
    case 'exe-windows': case 'exe-elf': case 'exe-mac': case 'script': return 'program'
    case 'shortcut-windows': return 'shortcut'
    case 'text': return 'text'
    default: return 'unknown'
  }
}

export type DeclaredFamily = 'image' | 'svg' | 'pdf' | 'video' | 'audio' | 'text' | 'other'

/** The family a declared media type claims. */
export function declaredFamily(type: string): DeclaredFamily {
  const t = type.split(';')[0]!.trim().toLowerCase()
  if (t === 'image/svg+xml') return 'svg'
  if (t.startsWith('image/')) return 'image'
  if (t === 'application/pdf') return 'pdf'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  if (t.startsWith('text/') || t === 'application/json' || t === 'application/xml') return 'text'
  return 'other'
}

const list = (s: string): ReadonlySet<string> => new Set(s.split(' '))

export const PROGRAM_EXTENSIONS = list('exe com scr pif msi msix msixbundle appx appxbundle msp mst cpl dll sys drv ocx gadget application xbap hta jar app pkg mpkg deb rpm apk aab xapk apks ipa appimage flatpakref flatpakrepo snap run bin elf so dylib kext prefpane mobileconfig xpi crx vsix')
export const SCRIPT_EXTENSIONS = list('bat cmd ps1 psm1 psd1 ps1xml vbs vbe js jse mjs wsf wsh wsc sct msc reg inf sh bash zsh csh ksh fish command tool py pyw pyc rb pl php lua applescript scpt scptd workflow action')
export const SHORTCUT_EXTENSIONS = list('lnk url website webloc inetloc fileloc desktop scf library-ms searchconnector-ms settingcontent-ms appref-ms glk terminal')
export const DISK_IMAGE_EXTENSIONS = list('iso img dmg vhd vhdx vmdk sparseimage sparsebundle')
export const MACRO_EXTENSIONS = list('docm dotm xlsm xltm xlsb xlam xla xll pptm potm ppam ppsm sldm one iqy slk')
export const ARCHIVE_EXTENSIONS = list('zip 7z rar tar gz tgz bz2 tbz2 xz txz zst cab arj lzh lha ace')
export const WEB_EXTENSIONS = list('html htm xhtml shtml mht mhtml svg svgz xsl chm swf')

export type FamilyLabel =
  | 'Image' | 'Video' | 'Audio' | 'PDF' | 'Text' | 'Document' | 'Spreadsheet' | 'Presentation'
  | 'Windows program' | 'Mac app' | 'Linux program' | 'Android app' | 'Script' | 'Shortcut'
  | 'Disk image' | 'Archive' | 'Office file with macros' | 'Web page' | 'File'

const LABEL_PHRASE: Record<FamilyLabel, string> = {
  Image: 'a picture', Video: 'a video', Audio: 'an audio file', PDF: 'a PDF', Text: 'a text file',
  Document: 'a document', Spreadsheet: 'a spreadsheet', Presentation: 'a presentation',
  'Windows program': 'a Windows program', 'Mac app': 'a Mac app', 'Linux program': 'a Linux program',
  'Android app': 'an Android app', Script: 'a script', Shortcut: 'a shortcut', 'Disk image': 'a disk image',
  Archive: 'an archive', 'Office file with macros': 'an Office file with macros', 'Web page': 'a web page', File: 'a file',
}

/** "a picture", "an archive": a label with its article, for running text. */
export function labelPhrase(label: FamilyLabel): string {
  return LABEL_PHRASE[label]
}

const WINDOWS_EXT = list('exe com scr pif msi msix msixbundle appx appxbundle msp mst cpl dll sys drv ocx gadget application xbap hta')
const MAC_EXT = list('app pkg mpkg ipa dylib kext prefpane mobileconfig')
const LINUX_EXT = list('deb rpm appimage flatpakref flatpakrepo snap run bin elf so')
const ANDROID_EXT = list('apk aab xapk apks')
const DOCUMENT_EXT = list('doc docx odt rtf pages epub')
const SPREADSHEET_EXT = list('xls xlsx ods csv numbers')
const PRESENTATION_EXT = list('ppt pptx odp key')

/**
 * The family word a card shows. Reads the sniffed kind first when there is
 * one (the bytes win), then the name's extension, then the declared type.
 */
export function familyLabel(input: { ext: string; kind?: SniffKind; declaredType?: string }): FamilyLabel {
  const { ext, kind } = input
  if (kind === 'exe-windows') return 'Windows program'
  if (kind === 'exe-elf') return 'Linux program'
  if (kind === 'exe-mac') return 'Mac app'
  if (kind === 'script') return 'Script'
  if (kind === 'shortcut-windows') return 'Shortcut'
  if (kind && sniffFamily(kind) === 'image') return 'Image'
  if (kind === 'svg') return 'Image'
  if (kind === 'pdf') return 'PDF'
  if (ANDROID_EXT.has(ext)) return 'Android app'
  if (LINUX_EXT.has(ext)) return 'Linux program'
  if (MAC_EXT.has(ext)) return 'Mac app'
  if (WINDOWS_EXT.has(ext) || ext === 'jar') return 'Windows program'
  if (SCRIPT_EXTENSIONS.has(ext)) return 'Script'
  if (SHORTCUT_EXTENSIONS.has(ext)) return 'Shortcut'
  if (DISK_IMAGE_EXTENSIONS.has(ext)) return 'Disk image'
  if (MACRO_EXTENSIONS.has(ext)) return 'Office file with macros'
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'Archive'
  if (WEB_EXTENSIONS.has(ext) && ext !== 'svg' && ext !== 'svgz') return 'Web page'
  if (kind === 'mp4' || kind === 'webm' || kind === 'ogg') return input.declaredType?.toLowerCase().startsWith('audio/') ? 'Audio' : 'Video'
  if (kind === 'mp3' || kind === 'wav' || kind === 'flac') return 'Audio'
  if (kind === 'zip' && !DOCUMENT_EXT.has(ext) && !SPREADSHEET_EXT.has(ext) && !PRESENTATION_EXT.has(ext)) return 'Archive'
  if (DOCUMENT_EXT.has(ext)) return 'Document'
  if (SPREADSHEET_EXT.has(ext)) return 'Spreadsheet'
  if (PRESENTATION_EXT.has(ext)) return 'Presentation'
  const declared = declaredFamily(input.declaredType ?? '')
  if (declared === 'image' || declared === 'svg') return 'Image'
  if (declared === 'video') return 'Video'
  if (declared === 'audio') return 'Audio'
  if (declared === 'pdf') return 'PDF'
  if (declared === 'text' || kind === 'text') return 'Text'
  if (ext === 'svg' || ext === 'svgz') return 'Image'
  return 'File'
}

/** The usual extension of a sniffed kind, for a name that was nothing but invisibles. */
function usualExtension(kind: SniffKind): string {
  switch (kind) {
    case 'jpeg': return 'jpg'
    case 'png': case 'gif': case 'webp': case 'avif': case 'heic': case 'bmp': case 'ico': case 'svg': case 'pdf':
    case 'mp4': case 'webm': case 'ogg': case 'mp3': case 'wav': case 'flac': case 'zip': return kind
    case 'text': return 'txt'
    default: return ''
  }
}

export type SaveTier = 'quiet' | 'warn' | 'block'
export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none'
export type SafetyReason =
  | 'disguised-program' | 'shortcut'
  | 'direction-controls' | 'name-changed' | 'mismatch'
  | 'program' | 'script' | 'disk-image' | 'macros' | 'archive' | 'web-page'
  | 'inline' | 'save'

export interface AttachmentInput {
  /** The decrypted bytes, or at least their first 1,024. */
  bytes: Uint8Array
  /** The name inside the envelope. */
  envelopeName: string
  /** The type the message declared. */
  declaredType: string
  /** The name the message carried, if any. */
  messageName?: string
  /** Who sent it, for the words. */
  sender?: string
}

export interface AttachmentDecision {
  /** The cleaned envelope name: the only name used after opening. */
  name: string
  ext: string
  kind: SniffKind
  /** The family word for the card's meta line. */
  family: FamilyLabel
  /** 'inline' previews quietly, 'save' is quiet and Save-only, 'warn' and 'block' as 8.4. */
  tier: 'inline' | 'save' | 'warn' | 'block'
  reason: SafetyReason
  /** Whether Save is quiet, needs a confirmation, or is refused. */
  save: SaveTier
  /** What the card may render from the bytes. 'none' for every blocked or warned file bar the exceptions in 8.4. */
  preview: PreviewKind
  /** The type to re-wrap the bytes as: the sniffed type for a preview, otherwise opaque. */
  mime: string
  /** The warning or the block message, or undefined for a quiet file. */
  message?: string
  /** The body of the Save confirmation, after its question. Only for a warned file. */
  confirmation?: string
}

const OPAQUE = 'application/octet-stream'

const SNIFFED_MIME: Partial<Record<SniffKind, string>> = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
}

function mediaMime(kind: SniffKind, declared: string): string {
  const base = declared.split(';')[0]!.trim().toLowerCase()
  if (base.startsWith('video/') || base.startsWith('audio/')) return base
  return kind === 'webm' ? 'video/webm' : kind === 'ogg' ? 'audio/ogg' : 'video/mp4'
}

function ownLine(reason: SafetyReason, sender: string, confirming: boolean): string {
  const it = confirming ? 'it' : 'this'
  switch (reason) {
    case 'program': return `Programs can take over your computer. Only save ${it} if you asked ${sender} for it.`
    case 'script': return `Scripts can change or take over your computer. Only save ${it} if you asked ${sender} for it.`
    case 'disk-image': return `A disk image can hold programs. Only save ${it} if you asked ${sender} for it.`
    case 'macros': return `Macros are programs inside a document. Only save ${it} if you asked ${sender} for it, and don’t turn macros on.`
    case 'archive': return `An archive can hold programs. Only save ${it} if you were expecting it.`
    case 'web-page': return `Opened from your computer, a web page can run code. Only save ${it} if you were expecting it.`
    default: return ''
  }
}

function ownReason(ext: string, kind: SniffKind, mismatch: boolean): SafetyReason | undefined {
  if (PROGRAM_EXTENSIONS.has(ext)) return 'program'
  if (SCRIPT_EXTENSIONS.has(ext)) return 'script'
  if (DISK_IMAGE_EXTENSIONS.has(ext)) return 'disk-image'
  if (MACRO_EXTENSIONS.has(ext)) return 'macros'
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive'
  if (WEB_EXTENSIONS.has(ext)) return 'web-page'
  if (kind === 'exe-windows' || kind === 'exe-elf' || kind === 'exe-mac') return 'program'
  if (kind === 'script') return 'script'
  if (mismatch && kind === 'zip') return 'archive'
  return undefined
}

/**
 * The decision for one decrypted file. First match wins, in the order of
 * the design (8.4): block, then warn, then quiet inline, then quiet save.
 */
export function assessAttachment(input: AttachmentInput): AttachmentDecision {
  const head = input.bytes.subarray(0, SNIFF_BYTES)
  const kind = sniffKind(head)
  const cleaned = cleanFileName(input.envelopeName, usualExtension(kind))
  const { name, ext, hadDirectionControls } = cleaned
  const sender = input.sender?.trim() || 'the sender'
  const sniffed = sniffFamily(kind)
  const declared = declaredFamily(input.declaredType)
  const label = familyLabel({ ext, kind, declaredType: input.declaredType })
  const declaredLabel = familyLabel({ ext: '', declaredType: input.declaredType })
  const base = { name, ext, kind, family: label }

  // Block: a program dressed as something else, or a shortcut.
  if (sniffed === 'program' && !PROGRAM_EXTENSIONS.has(ext) && !SCRIPT_EXTENSIONS.has(ext)) {
    const namedLike = declared === 'other' ? familyLabel({ ext }) : declaredLabel
    return {
      ...base, tier: 'block', reason: 'disguised-program', save: 'block', preview: 'none', mime: OPAQUE,
      message: `KithMoot won’t open or save this. It’s named like ${labelPhrase(namedLike)}, but it’s really ${labelPhrase(label)}. That’s a common way to hide an attack.`,
    }
  }
  if (SHORTCUT_EXTENSIONS.has(ext) || kind === 'shortcut-windows') {
    return {
      ...base, tier: 'block', reason: 'shortcut', save: 'block', preview: 'none', mime: OPAQUE,
      message: 'KithMoot won’t save shortcuts. A shortcut runs something on your computer, and there’s nothing in it to read.',
    }
  }

  // Warn.
  const own = ownReason(ext, kind, false)
  const mismatchOf = (): boolean => {
    switch (declared) {
      case 'image': return sniffed !== 'image'
      case 'svg': return sniffed !== 'svg'
      case 'pdf': return sniffed !== 'pdf'
      case 'text': return sniffed !== 'text' && sniffed !== 'svg'
      case 'video': case 'audio': return sniffed !== 'media' && sniffed !== 'unknown'
      default: return false
    }
  }
  const mismatch = mismatchOf()
  const messageExt = input.messageName === undefined ? undefined : cleanFileName(input.messageName).ext
  const nameChanged = messageExt !== undefined && messageExt !== ext
  const warned = own !== undefined || mismatch || hadDirectionControls || nameChanged
  if (warned) {
    const ownFinal = ownReason(ext, kind, mismatch)
    const sniffedPhrase = labelPhrase(label)
    let reason: SafetyReason
    let message: string
    if (hadDirectionControls) {
      reason = 'direction-controls'
      const tail = declared !== 'other' && sniffed !== 'unknown' && familyLabel({ ext: '', declaredType: input.declaredType }) !== label
        ? ` It’s ${sniffedPhrase}, not ${labelPhrase(declaredLabel)}.` : ''
      message = `This file’s name had hidden characters that make it read differently. KithMoot removed them.${tail}`
    } else if (nameChanged) {
      reason = 'name-changed'
      message = `This file was sent as ${cleanFileName(input.messageName!).name}, but the file inside is ${name}.`
    } else if (mismatch) {
      reason = 'mismatch'
      message = `This file says it’s ${labelPhrase(declaredLabel)}, but it’s really ${sniffedPhrase}.`
    } else {
      reason = ownFinal!
      message = ownLine(reason, sender, false)
    }
    const parts: string[] = []
    if (reason === ownFinal) parts.push(`It’s ${sniffedPhrase}.`, ownLine(reason, sender, true))
    else parts.push(message, ...(ownFinal ? [ownLine(ownFinal, sender, true)] : []))
    // Text and SVG still preview when only the extension (a web page) is the
    // cause: the preview is through textContent or <img>, never a document.
    let preview: PreviewKind = 'none'
    let mime = OPAQUE
    if (reason === 'web-page' && !mismatch) {
      if (sniffed === 'text' && declared === 'text') { preview = 'text'; mime = 'text/plain' }
      else if (sniffed === 'svg' && (declared === 'svg' || declared === 'image')) { preview = 'image'; mime = 'image/svg+xml' }
      else if (sniffed === 'svg' && declared === 'text') { preview = 'text'; mime = 'text/plain' }
    }
    return { ...base, tier: 'warn', reason, save: 'warn', preview, mime, message, confirmation: parts.join(' ') }
  }

  // Quiet inline: the declared family is one we preview and the bytes agree.
  const inlineOf = (): { preview: PreviewKind; mime: string } | undefined => {
    switch (declared) {
      case 'image': return { preview: 'image', mime: SNIFFED_MIME[kind]! }
      case 'svg': return { preview: 'image', mime: 'image/svg+xml' }
      case 'pdf': return { preview: 'pdf', mime: 'application/pdf' }
      case 'text': return { preview: 'text', mime: 'text/plain' }
      case 'video': case 'audio': {
        const mime = sniffed === 'media' ? mediaMime(kind, input.declaredType) : input.declaredType.split(';')[0]!.trim().toLowerCase()
        return { preview: mime.startsWith('audio/') ? 'audio' : 'video', mime }
      }
      default: return undefined
    }
  }
  const inline = inlineOf()
  if (inline && inline.mime) return { ...base, tier: 'inline', reason: 'inline', save: 'quiet', ...inline }
  return { ...base, tier: 'save', reason: 'save', save: 'quiet', preview: 'none', mime: OPAQUE }
}

/** The same decision under the name the design's acceptance checks use. */
export const classifyAttachment = assessAttachment
