import type { ControlMessage, ModelShortcut } from '../../src/control.js'

type Catalogue = Extract<ControlMessage, { op: 'catalogue' }>
interface Participant { participant: string; name?: string; agent?: boolean }
export interface ComposerModel extends ModelShortcut { agent: string; participant: string }

/** A menu belongs to a present host and a present, uniquely named agent.
 * Names are what text messages address, so ambiguous names cannot select a model. */
export function composerModels(catalogues: Iterable<Catalogue>, participants: Participant[]): ComposerModel[] {
  const present = new Map(participants.map(p => [p.participant, p]))
  const choices = new Map<string, ComposerModel>()
  for (const catalogue of catalogues) {
    if (!present.has(catalogue.host)) continue
    for (const entry of catalogue.agents) {
      const running = catalogue.running.find(r => r.id === entry.id)
      const participant = running?.participant ? present.get(running.participant) : undefined
      if (!participant?.agent || participant.name !== entry.name) continue
      // A self-announced clerk is the source of its own menu. A separate
      // agent host cannot claim another live participant's model settings.
      if (participant.participant !== catalogue.host) continue
      if (participants.filter(p => p.name?.toLowerCase() === entry.name.toLowerCase()).length !== 1) continue
      for (const model of entry.models ?? []) {
        choices.set(`${participant.participant}:${model.id}`, { ...model, agent: entry.name, participant: participant.participant })
      }
    }
  }
  return [...choices.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.label.localeCompare(b.label))
}

/** Only a leading selector, optionally after the addressed agent's name.
 * Carets in code, quotations, a URL or the task body are ordinary text. */
export function modelPrefix(text: string, names: string[]): { id: string; agent?: string; end: number } | undefined {
  const match = /^\s*(.*?)\^([a-z0-9_-]*)(?=\s|$)/i.exec(text)
  if (!match) return undefined
  const prefix = match[1]!.trim().replace(/^@/, '').replace(/[,:]$/, '').trim()
  const agent = names.find(n => n.toLowerCase() === prefix.toLowerCase())
  if (prefix && !agent) return undefined
  return { id: match[2]!.toLowerCase(), ...(agent ? { agent } : {}), end: match[0].length }
}

export function modelCompletions(textBeforeCaret: string, models: ComposerModel[], names: string[]): ComposerModel[] | undefined {
  const prefix = modelPrefix(textBeforeCaret, names)
  if (!prefix || prefix.end !== textBeforeCaret.length) return undefined
  return models.filter(m => (!prefix.agent || m.agent === prefix.agent) &&
    (m.id.startsWith(prefix.id) || m.label.toLowerCase().startsWith(prefix.id)))
}

/** Resolve before sending so a stale/ambiguous shortcut cannot quietly use
 * a default model. The wire remains readable plain text for older clients. */
export function prepareModelMessage(text: string, models: ComposerModel[], names: string[]): string {
  const prefix = modelPrefix(text, names)
  if (!prefix) return text
  const matches = models.filter(m => m.id === prefix.id && (!prefix.agent || m.agent === prefix.agent))
  if (matches.length === 0) throw new Error(`^${prefix.id || '…'} is not available here. Choose a model from the ^ menu.`)
  if (matches.length !== 1) throw new Error(`Choose the clerk for ^${prefix.id} from the ^ menu.`)
  const task = text.slice(prefix.end).trim()
  if (!task) throw new Error('Add the task after the model shortcut.')
  return `@${matches[0]!.agent} ^${matches[0]!.id} ${task}`
}
