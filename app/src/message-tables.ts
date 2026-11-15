/**
 * Tables in a message, found when it is drawn.
 *
 * Somebody pastes a table: one drawn with box characters (a terminal's, or
 * an assistant's), a Markdown pipe table, or a database client's `+---+`
 * grid. It travels and is kept as exactly the text it is; each device finds
 * the table in that text and draws it as a real one. Nothing here touches
 * the DOM or rewrites what was sent, and every character of a drawn table
 * that does not line up is still shown, as it was typed, in a fixed-width
 * font (a `grid` block).
 */

export type CellAlign = 'start' | 'center' | 'end'

export interface TableCell {
  text: string
  align: CellAlign
}

export interface MessageTable {
  /** The first row, when the table sets it apart: a rule under it in a
   *  drawn table, or a Markdown delimiter row. */
  header?: TableCell[]
  rows: TableCell[][]
  columns: number
}

export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; table: MessageTable }
  /** Looked like a drawn table but did not line up: shown as typed. */
  | { kind: 'grid'; text: string }

/** Past these a table is shown as typed rather than parsed. */
export const TABLE_LIMITS = { scan: 20_000, rows: 200, columns: 24 } as const

const BOX = /[─-╿]/
const BOX_ONLY = /^[─-╿\s]+$/
const BOX_HORIZONTAL = /[─━═╌╍┄┅┈┉╴╶╸╺]/
const BOX_VERTICAL = /[│┃║╎╏┆┇┊┋]/
const BOX_VERTICAL_SPLIT = /[│┃║╎╏┆┇┊┋]/g
const ASCII_RULE = /^\+[-=+:]*[-=][-=+:]*\+$/
const PIPE = /(?<!\\)\|/

type Flavour = 'box' | 'ascii'

/** Split a message into its text and the tables in it. A message with no
 *  table comes back as one text block holding the whole of it. */
export function messageBlocks(text: string): MessageBlock[] {
  if (text.length > TABLE_LIMITS.scan || !(BOX.test(text) || text.includes('|') || text.includes('+-'))) {
    return [{ kind: 'text', text }]
  }
  const lines = text.split('\n')
  const blocks: MessageBlock[] = []
  let prose: string[] = []
  const flush = () => {
    if (prose.length) blocks.push({ kind: 'text', text: prose.join('\n') })
    prose = []
  }
  const place = (block: MessageBlock) => {
    // A table stands apart on its own; the blank lines around it in the
    // typed text would only add to its margin.
    while (prose.length && !prose.at(-1)!.trim()) prose.pop()
    flush()
    blocks.push(block)
  }
  let i = 0
  while (i < lines.length) {
    const drawn = drawnRun(lines, i)
    if (drawn) {
      place(drawnBlock(lines.slice(i, drawn.end), drawn.flavour))
      i = drawn.end
      while (i < lines.length && !lines[i]!.trim()) i++
      continue
    }
    const markdown = markdownTable(lines, i)
    if (markdown) {
      place(markdown.block)
      i = markdown.end
      while (i < lines.length && !lines[i]!.trim()) i++
      continue
    }
    prose.push(lines[i]!)
    i++
  }
  flush()
  return blocks.length ? blocks : [{ kind: 'text', text }]
}

/** Whether a message holds a table, drawn or Markdown. */
export function hasTable(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(block => block.kind !== 'text')
}

/**
 * The words of a message for a one-line place: a reply's quote, the rooms
 * list, a notification, a screen reader's arrival line. A table's rows read
 * as their cells, ` · ` between them, a line each; a grid that would not
 * parse loses its box characters. Anything else is untouched.
 */
export function plainMessageText(text: string): string {
  const blocks = messageBlocks(text)
  if (!hasTable(blocks)) return text
  return blocks.map(block => {
    if (block.kind === 'text') return block.text
    if (block.kind === 'grid') return block.text.replace(/[─-╿]+/g, ' ').replace(/[ \t]+/g, ' ')
    const { header, rows } = block.table
    return [...(header ? [header] : []), ...rows]
      .map(row => row.map(cell => cell.text).filter(Boolean).join(' · '))
      .join('\n')
  }).join('\n')
}

/**
 * Whether a message is long enough to fold behind "Read more", and what it
 * shows folded. Text keeps the rule it always had (more than 700 characters
 * or 12 lines; the first 600 characters folded). A table counts a line a
 * row, so a short table is never folded for the rules drawn round it, and
 * a long one folds between rows rather than through one.
 */
export function foldMessage(blocks: readonly MessageBlock[]): { long: boolean; folded: MessageBlock[] } {
  if (!hasTable(blocks)) {
    const text = blocks.map(block => block.kind === 'text' ? block.text : '').join('')
    const long = text.length > 700 || text.split('\n').length > 12
    return { long, folded: long ? [{ kind: 'text', text: cutText(text, 600) + '…' }] : [...blocks] }
  }
  const cellCharacters = (row: readonly TableCell[]) => row.reduce((sum, cell) => sum + cell.text.length, 0)
  let characters = 0, lines = 0
  for (const block of blocks) {
    if (block.kind !== 'table') { characters += block.text.length; lines += block.text.split('\n').length; continue }
    const { header, rows } = block.table
    for (const row of header ? [header, ...rows] : rows) { characters += cellCharacters(row); lines++ }
  }
  const long = characters > 700 || lines > 12
  if (!long) return { long, folded: [...blocks] }
  const folded: MessageBlock[] = []
  let roomForCharacters = 600, roomForLines = 10
  for (const block of blocks) {
    if (roomForCharacters <= 0 || roomForLines <= 0) break
    if (block.kind === 'table') {
      const { header, rows } = block.table
      if (header) { roomForCharacters -= cellCharacters(header); roomForLines-- }
      // Whole rows only, and always the first, so a folded table still
      // shows what it is.
      let keep = 0
      while (keep < rows.length && (keep === 0 || (roomForLines > 0 && roomForCharacters >= cellCharacters(rows[keep]!)))) {
        roomForCharacters -= cellCharacters(rows[keep]!); roomForLines--; keep++
      }
      folded.push({ kind: 'table', table: { ...block.table, rows: rows.slice(0, keep) } })
      if (keep < rows.length) break
      continue
    }
    const blockLines = block.text.split('\n')
    if (block.text.length <= roomForCharacters && blockLines.length <= roomForLines) {
      folded.push(block)
      roomForCharacters -= block.text.length
      roomForLines -= blockLines.length
      continue
    }
    const kept = cutText(blockLines.slice(0, roomForLines).join('\n'), roomForCharacters)
    if (kept) folded.push({ ...block, text: kept })
    break
  }
  folded.push({ kind: 'text', text: '…' })
  return { long, folded }
}

function cutText(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '')
}

// --- Drawn tables: box characters, or +---+ ---------------------------------

function boxRule(line: string): boolean {
  return BOX_ONLY.test(line) && BOX_HORIZONTAL.test(line)
}

function boxRow(line: string): boolean {
  return BOX_VERTICAL.test(line[0] ?? '') && BOX_VERTICAL.test(line.at(-1) ?? '')
}

function asciiRow(line: string): boolean {
  return line.length > 1 && line.startsWith('|') && line.endsWith('|')
}

/** Where a drawn table starts at `start`, the lines it runs to. A box run
 *  is every line that begins with a box character; a `+---+` run is rules
 *  and `| … |` rows, with a rule in it. Either needs a row with a cell in
 *  it and three lines, so a line drawn under a heading stays a line. */
function drawnRun(lines: readonly string[], start: number): { end: number; flavour: Flavour } | undefined {
  const first = lines[start]!.trim()
  if (BOX.test(first[0] ?? '')) {
    let end = start
    while (end < lines.length && BOX.test(lines[end]!.trim()[0] ?? '')) end++
    const run = lines.slice(start, end).map(line => line.trim())
    if (run.length >= 3 && run.some(line => boxRow(line) && !boxRule(line))) return { end, flavour: 'box' }
    return undefined
  }
  if (ASCII_RULE.test(first) || asciiRow(first)) {
    let end = start
    while (end < lines.length && (ASCII_RULE.test(lines[end]!.trim()) || asciiRow(lines[end]!.trim()))) end++
    const run = lines.slice(start, end).map(line => line.trim())
    if (run.length >= 3 && run.some(line => ASCII_RULE.test(line)) && run.some(asciiRow)) return { end, flavour: 'ascii' }
  }
  return undefined
}

interface RawCell { text: string; left: number; right: number }

function drawnBlock(run: readonly string[], flavour: Flavour): MessageBlock {
  const asTyped = (): MessageBlock => ({ kind: 'grid', text: dedent(run) })
  const trimmed = run.map(line => line.trim())
  const isRule = flavour === 'box' ? boxRule : (line: string) => ASCII_RULE.test(line)
  const isRow = flavour === 'box' ? boxRow : asciiRow
  // The content lines between one rule and the next.
  const groups: string[][] = [[]]
  for (const line of trimmed) {
    if (isRule(line)) {
      if (groups.at(-1)!.length) groups.push([])
      continue
    }
    if (!isRow(line)) return asTyped()
    groups.at(-1)!.push(line)
  }
  if (!groups.at(-1)!.length) groups.pop()
  if (!groups.length) return asTyped()
  const split = (line: string): RawCell[] => {
    const parts = flavour === 'box' ? line.split(BOX_VERTICAL_SPLIT) : line.split('|')
    return parts.slice(1, -1).map(part => {
      const text = part.trim()
      return { text, left: text ? part.length - part.trimStart().length : 0, right: text ? part.length - part.trimEnd().length : 0 }
    })
  }
  const lines = groups.map(group => group.map(split))
  const columns = lines[0]![0]!.length
  if (!columns || columns > TABLE_LIMITS.columns) return asTyped()
  if (lines.some(group => group.some(cells => cells.length !== columns))) return asTyped()
  // Rules between every row: each group is one row, and a row of several
  // lines is cells wrapped to fit. One rule only: the header above it and
  // a row a line below it. No rule inside: a row a line.
  let headerRows: RawCell[][] | undefined
  let bodyRows: RawCell[][][]
  if (groups.length >= 3) {
    headerRows = lines[0]
    bodyRows = lines.slice(1)
  } else if (groups.length === 2) {
    headerRows = lines[0]
    bodyRows = lines[1]!.map(cells => [cells])
  } else {
    bodyRows = lines[0]!.map(cells => [cells])
  }
  if (bodyRows.length > TABLE_LIMITS.rows) return asTyped()
  const join = (group: RawCell[][]): RawCell[] => Array.from({ length: columns }, (_, column) => {
    const pieces = group.map(cells => cells[column]!).filter(cell => cell.text)
    return { text: pieces.map(cell => cell.text).join(' '), left: pieces[0]?.left ?? 0, right: pieces[0]?.right ?? 0 }
  })
  const header = headerRows ? join(headerRows) : undefined
  const body = bodyRows.map(join)
  const align = Array.from({ length: columns }, (_, column) => columnAlign(body.map(row => row[column]!)))
  return {
    kind: 'table',
    table: {
      ...(header ? { header: header.map((cell, column) => ({ text: cell.text, align: paddingAlign(cell) ?? align[column]! })) } : {}),
      rows: body.map(row => row.map((cell, column) => ({ text: cell.text, align: align[column]! }))),
      columns,
    },
  }
}

/** How padding places a cell: hard against the left, the right, or in the
 *  middle. A cell that fills its column says nothing. */
function paddingAlign(cell: RawCell): CellAlign | undefined {
  if (!cell.text) return undefined
  const { left, right } = cell
  if (left <= 1 && right <= 1) return undefined
  if (left <= 1) return 'start'
  if (right <= 1) return 'end'
  if (Math.abs(left - right) <= 1) return 'center'
  return left < right ? 'start' : 'end'
}

function columnAlign(cells: readonly RawCell[]): CellAlign {
  const counts = new Map<CellAlign, number>()
  for (const cell of cells) {
    const align = paddingAlign(cell)
    if (align) counts.set(align, (counts.get(align) ?? 0) + 1)
  }
  let best: CellAlign = 'start', most = 0
  for (const align of ['start', 'end', 'center'] as const) {
    const count = counts.get(align) ?? 0
    if (count > most) { best = align; most = count }
  }
  return best
}

function dedent(lines: readonly string[]): string {
  const indents = lines.filter(line => line.trim()).map(line => line.length - line.trimStart().length)
  const common = indents.length ? Math.min(...indents) : 0
  return lines.map(line => line.slice(common).trimEnd()).join('\n')
}

// --- Markdown pipe tables ---------------------------------------------------

const DELIMITER_CELL = /^:?-+:?$/

/** Split a pipe row into its cells: one outer pipe each side is the
 *  table's edge, and `\|` is a pipe inside a cell. */
function pipeCells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

/** A delimiter row's cells, or nothing. `|---|:--:|`, and a database
 *  client's `----+----` too. */
function delimiterCells(line: string): CellAlign[] | undefined {
  const trimmed = line.trim()
  if (!trimmed.includes('-') || !/[|+]/.test(trimmed)) return undefined
  let body = trimmed
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  const cells = body.split(/[|+]/).map(cell => cell.trim())
  if (!cells.length || !cells.every(cell => DELIMITER_CELL.test(cell))) return undefined
  return cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'end' : 'start')
}

function markdownTable(lines: readonly string[], start: number): { end: number; block: MessageBlock } | undefined {
  const head = lines[start]!
  const delimiter = lines[start + 1]
  if (delimiter === undefined || !PIPE.test(head)) return undefined
  const aligns = delimiterCells(delimiter)
  if (!aligns) return undefined
  const headCells = pipeCells(head)
  if (headCells.length !== aligns.length) return undefined
  if (aligns.length === 1 && !head.trim().startsWith('|')) return undefined
  const columns = aligns.length
  if (columns > TABLE_LIMITS.columns) return undefined
  let end = start + 2
  const rows: TableCell[][] = []
  while (end < lines.length && lines[end]!.trim() && PIPE.test(lines[end]!)) {
    const cells = pipeCells(lines[end]!)
    // More cells than columns: the rest goes in the last one rather than
    // being dropped, so nothing anybody typed goes missing.
    const fitted = cells.length > columns
      ? [...cells.slice(0, columns - 1), cells.slice(columns - 1).join(' | ')]
      : [...cells, ...Array<string>(columns - cells.length).fill('')]
    rows.push(fitted.map((text, column) => ({ text, align: aligns[column]! })))
    end++
    if (rows.length > TABLE_LIMITS.rows) return undefined
  }
  return {
    end,
    block: {
      kind: 'table',
      table: { header: headCells.map((text, column) => ({ text, align: aligns[column]! })), rows, columns },
    },
  }
}
