import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

const CALL = 'kithmoot.call'
const PROFILE = 'kithmoot.callProfile'
const modes = ['off', 'blur', 'replace']
const voices = ['off', 'lower', 'higher', 'neutral', 'deep', 'bright']
function hold(): never { throw new OrdinaryStateHold() }
function reserved(name: string): boolean {
  return name === CALL || name.startsWith(CALL + '.') || name === PROFILE || name.startsWith(PROFILE + '.')
}

/** Count-only custody of the current call writers. These raw choices are
 * not permission to open media, identify hardware or enable negotiation.
 * Unknown formats hold intact for recovery; no defaults, repair,
 * live loaders, URL interpretation or effects run here. A complete source
 * composite and real browser/tab owners are still required before startup. */
export function validateOrdinaryMediaSnapshot(records: ReadonlyMap<string, string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): Readonly<{ effectModes: number; backgrounds: number; blurStrengths: number;
    voicePresets: number; cameraChoices: number; microphoneChoices: number; callProfiles: number }> {
  if (!['browser', 'tab'].includes(options.kind)) hold()
  const counts = { effectModes: 0, backgrounds: 0, blurStrengths: 0, voicePresets: 0,
    cameraChoices: 0, microphoneChoices: 0, callProfiles: 0 }
  for (const [name, raw] of records) {
    if (name.startsWith('kithmoot.account.') && (name.includes('.' + CALL + '.') || name.endsWith('.' + CALL)
      || name.includes('.' + PROFILE + '.') || name.endsWith('.' + PROFILE))) hold()
    if (!reserved(name)) continue
    if (name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string') hold()
    ordinaryUtf8Length(raw)
    if (name === PROFILE) {
      // The archived 76ee9bc writer also stored durable 2. Retain it as
      // inert custody; the current loader ignores durable 2. This count
      // must never enable negotiation or move a durable choice into a tab.
      if (raw !== '1' && raw !== '2') hold()
      counts.callProfiles++; continue
    }
    if (options.kind !== 'browser') hold()
    switch (name) {
      case CALL + '.effectMode':
        if (!modes.includes(raw)) hold(); counts.effectModes++; break
      case CALL + '.background':
        // The writer accepts even empty/obsolete/URL-looking text. It is
        // an opaque candidate id, never an image or network destination.
        counts.backgrounds++; break
      case CALL + '.blurStrength': {
        const value = Number(raw)
        if (!Number.isFinite(value) || value < 0 || value > 1 || String(value) !== raw) hold()
        counts.blurStrengths++; break
      }
      case CALL + '.voicePreset':
        if (!voices.includes(raw)) hold(); counts.voicePresets++; break
      case CALL + '.cameraDeviceId':
        if (!raw) hold(); counts.cameraChoices++; break
      case CALL + '.micDeviceId':
        if (!raw) hold(); counts.microphoneChoices++; break
      default: hold()
    }
  }
  return Object.freeze(counts)
}
