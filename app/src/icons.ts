/**
 * The in-house icon set, on a 24 grid with a 1.75 stroke and round caps and
 * joins, drawn in `currentColor` so an icon takes the ink of the button it
 * sits in. One sprite, written into the page once at boot, and used by
 * reference. No icon font and nothing fetched.
 *
 * An icon is never the only thing that names a control: the button that
 * holds it carries the accessible name and a tooltip, so the symbol is
 * `aria-hidden`.
 */
export const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  moreVert: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  phone: '<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10l6-3v10l-6-3"/>',
  videoOff: '<path d="M10 6h3.5a2 2 0 0 1 2 2v4m0 4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2M15.5 10l6-3v10l-6-3M3 3l18 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.01"/>',
  personAdd: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M18.5 8v6M15.5 11h6"/>',
  agent: '<rect x="4.5" y="7.5" width="15" height="11" rx="3"/><path d="M12 7.5V4.5M12 4.5h.01"/><circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M8.5 5.6A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17M10 20.5a2 2 0 0 0 4 0M3 3l18 18"/>',
  pin: '<path d="M9 3.5h6l-1 6 3 3.5H7l3-3.5z"/><path d="M12 13v7.5"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16M5.5 8h1.5M11 8h2M17 8h1.5"/>',
  chats: '<path d="M4 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M17 9h3a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1v2.5L16 19h-3"/>',
  chat: '<path d="M5 4.5h14a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-8l-5 3.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2c2.1.7 3.5 2.6 3.5 5.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8l1.6 2.3 2.7-.7.5 2.8 2.5 1.3-1.2 2.5 1.2 2.5-2.5 1.3-.5 2.8-2.7-.7L12 21.2l-1.6-2.3-2.7.7-.5-2.8-2.5-1.3L5.9 13 4.7 10.5l2.5-1.3.5-2.8 2.7.7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><circle cx="9" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r=".9" fill="currentColor" stroke="none"/>',
  send: '<path d="M4.5 12.5L20 4.5l-5 15.5-3-6.5z"/><path d="M12 13.5l8-9"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5 2.2M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/>',
  screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4M12 13V8M9.5 10.5L12 8l2.5 2.5"/>',
  hangup: '<path d="M3 15.5c5-4.6 13-4.6 18 0l-2.4 2.4-3.4-1.6v-2.6a12 12 0 0 0-6.4 0v2.6l-3.4 1.6z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  qr: '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><path d="M14.5 14.5h2v2h-2zM18.5 18.5h2v2h-2zM14.5 20.5v-2M20.5 14.5h-2"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  compose: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  signin: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M14 8l4 4-4 4M18 12H8"/>',
  leave: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l-4 4 4 4M6 12h10"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>',
  record: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2.5-4.5a1.5 1.5 0 0 1 2.6-1.5L8 14"/>',
  ear: '<path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 3.2-3 4.2-3 7.3a3 3 0 0 1-5.6 1.5M9.5 9.5a2.5 2.5 0 0 1 5 0"/>',
  devices: '<rect x="2" y="5" width="14" height="10" rx="1.5"/><path d="M1 18.5h15"/><rect x="17.5" y="8" width="5" height="11" rx="1.5"/>',
  folder: '<path d="M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  flag: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
  reply: '<path d="M9 7l-5 5 5 5M4 12h10a6 6 0 0 1 6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  mention: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.5 7.4C4 9.1 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.3-.5 4.6-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
} as const

export type IconName = keyof typeof ICONS

/** The `<symbol>` sheet, hidden, for `<use href="#i-name">` to point at. */
export function iconSprite(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute">' +
    Object.entries(ICONS).map(([name, shapes]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${shapes}</symbol>`).join('') + '</svg>'
}

/** Writes the sprite into the document once. Safe to call again. */
export function installIcons(doc: Document = document): void {
  if (doc.getElementById('iconSprite')) return
  const holder = doc.createElement('div')
  holder.id = 'iconSprite'
  holder.hidden = true
  holder.innerHTML = iconSprite()
  doc.body.prepend(holder)
}

/** An icon, as an element to put inside a button. */
export function icon(name: IconName, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'i')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}
