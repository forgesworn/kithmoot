import type { MessageBlock, MessageTable, TableCell } from './message-tables.js'

/** A cell longer than this wraps between words; shorter ones keep a line. */
const ONE_LINE_CELL = 40

/**
 * Draw a message's blocks into its text element. Words go through
 * `inline`, the same path every message's words take (links and names
 * marked, through `textContent`); a table becomes a real `table`, each
 * cell's words through `inline` too; a drawing that did not parse is
 * shown as typed in a fixed-width font. Nothing here builds markup out of
 * somebody else's text.
 */
export function appendMessageBlocks(into: HTMLElement, blocks: readonly MessageBlock[], inline: (into: HTMLElement, text: string) => void): void {
  for (const block of blocks) {
    if (block.kind === 'text') inline(into, block.text)
    else if (block.kind === 'grid') {
      const pre = document.createElement('pre')
      pre.className = 'messageGrid'
      pre.textContent = block.text
      into.append(pre)
    } else into.append(tableElement(block.table, inline))
  }
  requestAnimationFrame(() => markScrollingTables(into))
}

function tableElement(table: MessageTable, inline: (into: HTMLElement, text: string) => void): HTMLElement {
  const frame = document.createElement('div')
  frame.className = 'messageTable'
  const element = document.createElement('table')
  const cell = (tag: 'th' | 'td', value: TableCell) => {
    const td = document.createElement(tag)
    if (tag === 'th') td.scope = 'col'
    if (value.align !== 'start') td.classList.add(value.align)
    if (value.text.length > ONE_LINE_CELL) td.classList.add('wraps')
    inline(td, value.text)
    return td
  }
  if (table.header) {
    const head = element.createTHead().insertRow()
    for (const value of table.header) head.append(cell('th', value))
  }
  const body = element.createTBody()
  for (const row of table.rows) {
    const tr = body.insertRow()
    for (const value of row) tr.append(cell('td', value))
  }
  frame.append(element)
  return frame
}

/**
 * A table wider than its bubble scrolls sideways; one that does can be
 * reached with Tab and scrolled with the arrow keys, and says what it is.
 * One that fits is no extra stop on the way through a conversation.
 */
export function markScrollingTables(root: ParentNode): void {
  for (const frame of root.querySelectorAll<HTMLElement>('.messageTable, .messageGrid')) {
    if (!frame.isConnected) continue
    if (frame.scrollWidth > frame.clientWidth + 1) {
      if (frame.tabIndex !== 0) frame.tabIndex = 0
      frame.setAttribute('role', 'group')
      frame.setAttribute('aria-label', frame.classList.contains('messageGrid') ? 'Drawing, scrolls sideways' : 'Table, scrolls sideways')
    } else if (frame.hasAttribute('tabindex')) {
      frame.removeAttribute('tabindex')
      frame.removeAttribute('role')
      frame.removeAttribute('aria-label')
    }
  }
}

/** Keep that true as the conversation's width changes: a panel opening
 *  beside it, a window resized. One observer on the log, so nothing holds
 *  on to a message after it is painted over. */
export function watchScrollingTables(log: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return
  let queued = false
  new ResizeObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; markScrollingTables(log) })
  }).observe(log)
}
