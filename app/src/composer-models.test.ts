import { describe, expect, it } from 'vitest'
import { composerModels, modelCompletions, prepareModelMessage } from './composer-models.js'
import { decodeControl, encodeControl, type ControlMessage } from '../../src/control.js'

const tally = { participant: 'a'.repeat(64), name: 'Tally', agent: true }
const quill = { participant: 'b'.repeat(64), name: 'Quill', agent: true }
const catalogue = (participant = tally): Extract<ControlMessage, { op: 'catalogue' }> => ({
  op: 'catalogue', host: participant.participant, name: participant.name,
  agents: [{ id: 'clerk', name: participant.name, models: [{ id: 'astra', label: 'Astra' }, { id: 'opus5', label: 'Opus 5' }] }],
  running: [{ id: 'clerk', name: participant.name, participant: participant.participant, since: 1 }],
})

describe('model shortcuts in the composer', () => {
  it('round trips the host menu and ignores model claims for absent or other agents', () => {
    const announced = catalogue()
    expect(decodeControl(encodeControl(announced))).toEqual(announced)
    expect(composerModels([announced], [tally])).toHaveLength(2)
    expect(composerModels([announced], [])).toEqual([])
    expect(composerModels([{ ...announced, host: quill.participant }], [tally, quill])).toEqual([])
    expect(composerModels([announced], [tally, { ...quill, name: 'Tally' }])).toEqual([])
  })

  it('drops an invalid model menu rather than offering a partial or duplicate choice', () => {
    for (const models of [[{ id: '../bad', label: 'Bad' }], Array(9).fill({ id: 'a', label: 'A' }),
      [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }]]) {
      const decoded = decodeControl(JSON.stringify({ ...catalogue(), agents: [{ id: 'clerk', name: 'Tally', models }] }))
      expect(decoded?.op === 'catalogue' && decoded.agents).toEqual([])
    }
  })

  it('filters by model and addressed clerk without guessing unadvertised models', () => {
    const models = composerModels([catalogue(tally), catalogue(quill)], [tally, quill])
    expect(modelCompletions('^as', models, ['Tally', 'Quill'])).toHaveLength(2)
    expect(modelCompletions('@Tally ^op', models, ['Tally', 'Quill'])?.map(m => [m.agent, m.id])).toEqual([['Tally', 'opus5']])
    expect(modelCompletions('@Tally ^missing', models, ['Tally'])).toEqual([])
    for (const text of ['calculate 2^3', '`^astra`', '> @Tally ^astra', '@Tally review x ^as']) {
      expect(modelCompletions(text, models, ['Tally'])).toBeUndefined()
      expect(prepareModelMessage(text, models, ['Tally'])).toBe(text)
    }
  })

  it('addresses an unambiguous shortcut, preserves the task and refuses stale or ambiguous choices', () => {
    const models = composerModels([catalogue()], [tally])
    expect(prepareModelMessage('^astra review\nthese changes', models, ['Tally'])).toBe('@Tally ^astra review\nthese changes')
    expect(prepareModelMessage('Tally, ^OPUS5 draft this', models, ['Tally'])).toBe('@Tally ^opus5 draft this')
    expect(() => prepareModelMessage('@Tally ^missing review', models, ['Tally'])).toThrow(/not available/)
    expect(() => prepareModelMessage('@Tally ^astra review', [], ['Tally'])).toThrow(/not available/)
    expect(() => prepareModelMessage('@Tally ^astra', models, ['Tally'])).toThrow(/Add the task/)
    const both = composerModels([catalogue(tally), catalogue(quill)], [tally, quill])
    expect(() => prepareModelMessage('^astra review', both, ['Tally', 'Quill'])).toThrow(/Choose the clerk/)
  })
})
