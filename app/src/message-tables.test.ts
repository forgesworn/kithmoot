import { describe, expect, it } from 'vitest'
import { foldMessage, messageBlocks, plainMessageText, TABLE_LIMITS, type MessageBlock, type MessageTable } from './message-tables.js'

// As pasted into a room: a decoder comparison drawn by a terminal.
const DECODERS = [
  '┌──────────────────────┬──────┬───────────┬──────────────┬──────┐',
  '│         Set          │ Ours │ zxing-cpp │ ZXing (Java) │ jsQR │',
  '├──────────────────────┼──────┼───────────┼──────────────┼──────┤',
  '│ 185 photographs      │ 166  │ 170       │ 159          │ 155  │',
  '├──────────────────────┼──────┼───────────┼──────────────┼──────┤',
  '│ 62 bug-report images │ 47   │ 51        │ 40           │ 26   │',
  '├──────────────────────┼──────┼───────────┼──────────────┼──────┤',
  '│ 560 synthetic frames │ 518  │ 503       │ 143          │ 185  │',
  '└──────────────────────┴──────┴───────────┴──────────────┴──────┘',
].join('\n')

const texts = (row: MessageTable['rows'][number] | undefined) => row?.map(cell => cell.text)
const aligns = (row: MessageTable['rows'][number] | undefined) => row?.map(cell => cell.align)
function onlyTable(text: string): MessageTable {
  const blocks = messageBlocks(text)
  expect(blocks.map(block => block.kind)).toEqual(['table'])
  return (blocks[0] as Extract<MessageBlock, { kind: 'table' }>).table
}

describe('a table drawn with box characters', () => {
  it('reads the pasted decoder comparison cell for cell', () => {
    const table = onlyTable(DECODERS)
    expect(table.columns).toBe(5)
    expect(texts(table.header)).toEqual(['Set', 'Ours', 'zxing-cpp', 'ZXing (Java)', 'jsQR'])
    expect(table.rows.map(texts)).toEqual([
      ['185 photographs', '166', '170', '159', '155'],
      ['62 bug-report images', '47', '51', '40', '26'],
      ['560 synthetic frames', '518', '503', '143', '185'],
    ])
  })

  it('keeps where the padding put things: a centred heading over left-set cells', () => {
    const table = onlyTable(DECODERS)
    expect(table.header![0]!.align).toBe('center')
    expect(aligns(table.rows[0])).toEqual(['start', 'start', 'start', 'start', 'start'])
    const right = onlyTable(['┌─────┬───────┐', '│ Set │ Count │', '├─────┼───────┤', '│ a   │     7 │', '│ b   │  1024 │', '└─────┴───────┘'].join('\n'))
    expect(aligns(right.rows[0])).toEqual(['start', 'end'])
  })

  it('finds it among the words around it, and leaves those words as typed', () => {
    const blocks = messageBlocks(`Decoded per set:\n\n${DECODERS}\n\nOurs wins on synthetic frames.\nzxing-cpp on photographs.`)
    expect(blocks.map(block => block.kind)).toEqual(['text', 'table', 'text'])
    expect(blocks[0]).toEqual({ kind: 'text', text: 'Decoded per set:' })
    expect(blocks[2]).toEqual({ kind: 'text', text: 'Ours wins on synthetic frames.\nzxing-cpp on photographs.' })
  })

  it('reads an indented table and trailing spaces', () => {
    const table = onlyTable(DECODERS.split('\n').map(line => `  ${line}  `).join('\n'))
    expect(table.rows).toHaveLength(3)
  })

  it('takes a rule under the first row only as a header over a row a line', () => {
    const table = onlyTable(['┌──────┬─────┐', '│ Name │ Age │', '├──────┼─────┤', '│ Ada  │ 36  │', '│ Bob  │ 41  │', '│ Cara │ 29  │', '└──────┴─────┘'].join('\n'))
    expect(texts(table.header)).toEqual(['Name', 'Age'])
    expect(table.rows.map(texts)).toEqual([['Ada', '36'], ['Bob', '41'], ['Cara', '29']])
  })

  it('takes no rule inside as no header', () => {
    const table = onlyTable(['┌─────┬───┐', '│ Ada │ 1 │', '│ Bob │ 2 │', '└─────┴───┘'].join('\n'))
    expect(table.header).toBeUndefined()
    expect(table.rows.map(texts)).toEqual([['Ada', '1'], ['Bob', '2']])
  })

  it('joins a cell wrapped over several lines back into one', () => {
    const table = onlyTable([
      '┌────────┬──────────────────┐',
      '│ Step   │ What happens     │',
      '├────────┼──────────────────┤',
      '│ Knock  │ The guest asks   │',
      '│        │ to come in       │',
      '├────────┼──────────────────┤',
      '│ Let in │ The owner admits │',
      '│        │ them             │',
      '└────────┴──────────────────┘',
    ].join('\n'))
    expect(table.rows.map(texts)).toEqual([['Knock', 'The guest asks to come in'], ['Let in', 'The owner admits them']])
  })

  it('reads heavy, double and rounded boxes', () => {
    for (const drawn of [
      ['┏━━━┳━━━┓', '┃ a ┃ b ┃', '┣━━━╋━━━┫', '┃ 1 ┃ 2 ┃', '┗━━━┻━━━┛'],
      ['╔═══╦═══╗', '║ a ║ b ║', '╠═══╬═══╣', '║ 1 ║ 2 ║', '╚═══╩═══╝'],
      ['╭───┬───╮', '│ a │ b │', '├───┼───┤', '│ 1 │ 2 │', '╰───┴───╯'],
      ['╒═══╤═══╕', '│ a │ b │', '╞═══╪═══╡', '│ 1 │ 2 │', '╘═══╧═══╛'],
    ]) {
      const table = onlyTable(drawn.join('\n'))
      expect(texts(table.header)).toEqual(['a', 'b'])
      expect(table.rows.map(texts)).toEqual([['1', '2']])
    }
  })

  it('keeps empty cells', () => {
    const table = onlyTable(['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│   │ 2 │', '└───┴───┘'].join('\n'))
    expect(texts(table.rows[0])).toEqual(['', '2'])
  })
})

describe('a drawing that is not a clean table', () => {
  it('is shown as typed when its rows do not line up, every character kept', () => {
    const ragged = ['  ┌───┬───┐', '  │ a │ b │', '  ├───┼───┤', '  │ 1 │ 2 │ 3 │', '  └───┴───┘']
    expect(messageBlocks(ragged.join('\n'))).toEqual([{ kind: 'grid', text: ragged.map(line => line.slice(2)).join('\n') }])
  })

  it('is shown as typed when a line in it is neither a rule nor a row', () => {
    const odd = ['┌───┬───┐', '│ a │ b │', '├── note', '│ 1 │ 2 │', '└───┴───┘'].join('\n')
    expect(messageBlocks(odd)).toEqual([{ kind: 'grid', text: odd }])
  })

  it('leaves a file tree and a rule under a heading as words', () => {
    for (const text of [
      'src/\n├── app.ts\n│   └── main.ts\n└── index.ts',
      'Release notes\n─────────────\nFaster calls.',
      '│ a quoted line │',
    ]) expect(messageBlocks(text)).toEqual([{ kind: 'text', text }])
  })

  it('shows a table past the limits as typed', () => {
    const wide = TABLE_LIMITS.columns + 1
    const rule = (l: string, m: string, r: string) => l + Array(wide).fill('───').join(m) + r
    const tooWide = [rule('┌', '┬', '┐'), '│' + Array(wide).fill(' a ').join('│') + '│', rule('└', '┴', '┘')].join('\n')
    expect(messageBlocks(tooWide).map(block => block.kind)).toEqual(['grid'])
    const tall = ['┌───┐', ...Array(TABLE_LIMITS.rows + 1).fill('│ a │'), '└───┘'].join('\n')
    expect(messageBlocks(tall).map(block => block.kind)).toEqual(['grid'])
  })

  it('does not look past a very long message', () => {
    const text = `${DECODERS}\n${'x'.repeat(TABLE_LIMITS.scan)}`
    expect(messageBlocks(text)).toEqual([{ kind: 'text', text }])
  })
})

describe('a +---+ grid from a database client', () => {
  it('reads as a table with its header', () => {
    const table = onlyTable(['+----+-------+', '| id | name  |', '+----+-------+', '|  1 | Ada   |', '|  2 | Bob   |', '+----+-------+'].join('\n'))
    expect(texts(table.header)).toEqual(['id', 'name'])
    expect(table.rows.map(texts)).toEqual([['1', 'Ada'], ['2', 'Bob']])
    expect(table.rows[0]![0]!.align).toBe('end')
  })

  it('needs a rule, so pipes alone stay words', () => {
    const text = '| this is |\n| not |\n| a grid |'
    expect(messageBlocks(text)).toEqual([{ kind: 'text', text }])
  })
})

describe('a Markdown pipe table', () => {
  it('reads cells and the alignment its delimiter row sets', () => {
    const table = onlyTable('| Set | Ours | jsQR |\n|:---|:---:|---:|\n| 185 photographs | 166 | 155 |\n| 62 bug-report images | 47 | 26 |')
    expect(texts(table.header)).toEqual(['Set', 'Ours', 'jsQR'])
    expect(aligns(table.header)).toEqual(['start', 'center', 'end'])
    expect(table.rows.map(texts)).toEqual([['185 photographs', '166', '155'], ['62 bug-report images', '47', '26']])
  })

  it('reads one without outer pipes, and stops at the first line without one', () => {
    const blocks = messageBlocks('Set | Ours\n--- | ---\nphotos | 166\nThat is all.')
    expect(blocks.map(block => block.kind)).toEqual(['table', 'text'])
    expect((blocks[1] as { text: string }).text).toBe('That is all.')
  })

  it('reads a database client\'s ---+--- rule and leaves its row count as words', () => {
    const blocks = messageBlocks(' name | n\n------+---\n Ada  | 1\n(1 row)')
    expect(blocks.map(block => block.kind)).toEqual(['table', 'text'])
    expect(texts((blocks[0] as Extract<MessageBlock, { kind: 'table' }>).table.rows[0])).toEqual(['Ada', '1'])
  })

  it('keeps an escaped pipe in its cell, pads a short row and drops nothing from a long one', () => {
    const table = onlyTable('| a | b |\n|---|---|\n| x \\| y | z |\n| only |\n| 1 | 2 | 3 |')
    expect(table.rows.map(texts)).toEqual([['x | y', 'z'], ['only', ''], ['1', '2 | 3']])
  })

  it('is not found in words that merely have pipes or dashes in them', () => {
    for (const text of [
      'use a || b here',
      'yes | no\n---\nmaybe',
      'a | b | c\n---|---\n1 | 2',
      'score: 1 + -2\n+-+ is not a grid',
      'one | two',
    ]) expect(messageBlocks(text)).toEqual([{ kind: 'text', text }])
  })
})

describe('the plain form for one line', () => {
  it('reads a table row by row, its cells set apart', () => {
    expect(plainMessageText(`Results:\n${DECODERS}`)).toBe([
      'Results:',
      'Set · Ours · zxing-cpp · ZXing (Java) · jsQR',
      '185 photographs · 166 · 170 · 159 · 155',
      '62 bug-report images · 47 · 51 · 40 · 26',
      '560 synthetic frames · 518 · 503 · 143 · 185',
    ].join('\n'))
  })

  it('leaves a message with no table untouched', () => {
    for (const text of ['hello', 'a | b', '  spaced  \n\n out ']) expect(plainMessageText(text)).toBe(text)
  })
})

describe('folding a long message behind Read more', () => {
  it('folds plain text exactly as before', () => {
    const text = 'x'.repeat(701)
    expect(foldMessage(messageBlocks(text))).toEqual({ long: true, folded: [{ kind: 'text', text: `${'x'.repeat(600)}…` }] })
    expect(foldMessage(messageBlocks(Array(13).fill('line').join('\n'))).long).toBe(true)
    expect(foldMessage(messageBlocks(Array(12).fill('line').join('\n'))).long).toBe(false)
  })

  it('never folds the pasted comparison, whatever its rules add up to', () => {
    expect(foldMessage(messageBlocks(`Decoded per set:\n${DECODERS}\nOurs wins on synthetic frames.`)).long).toBe(false)
  })

  it('folds a long table between rows, keeping its header', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| row ${i} | ${i * 7} |`)
    const { long, folded } = foldMessage(messageBlocks(['| Row | Value |', '|---|---:|', ...rows].join('\n')))
    expect(long).toBe(true)
    expect(folded.map(block => block.kind)).toEqual(['table', 'text'])
    const table = (folded[0] as Extract<MessageBlock, { kind: 'table' }>).table
    expect(texts(table.header)).toEqual(['Row', 'Value'])
    expect(table.rows.length).toBe(9)
    expect(texts(table.rows.at(-1))).toEqual(['row 8', '56'])
    expect(folded[1]).toEqual({ kind: 'text', text: '…' })
  })

  it('keeps at least one row of a table with very long cells', () => {
    const long = 'w'.repeat(500)
    const { folded } = foldMessage(messageBlocks(`| a | b |\n|---|---|\n| ${long} | 1 |\n| ${long} | 2 |`))
    expect((folded[0] as Extract<MessageBlock, { kind: 'table' }>).table.rows).toHaveLength(1)
  })
})
