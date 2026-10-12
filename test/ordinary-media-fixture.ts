import { memoryDeviceStore } from '../app/src/device-store.js'
import { storeBackgroundId, storeBlurStrength, storeCameraDeviceId, storeEffectMode, storeMicDeviceId,
  storeVoicePreset } from '../app/src/call-prefs.js'
import { readCallProfile, CALL_PROFILE_KEY } from '../app/src/call-profile.js'

export const MEDIA_MODES = ['all', 'effect-off', 'effect-blur', 'effect-replace', 'voice-off', 'voice-lower',
  'voice-higher', 'voice-neutral', 'voice-deep', 'voice-bright', 'blur-zero', 'blur-one', 'blur-fraction',
  'blur-exponent', 'background-empty', 'background-opaque', 'camera-opaque', 'microphone-opaque',
  'profile-browser-off', 'profile-tab-off', 'profile-tab-on'] as const
export type MediaMode = typeof MEDIA_MODES[number]
export const MEDIA_FAULTS = ['wrapped', 'family-root', 'version', 'unknown-key', 'effect', 'voice',
  'blur-empty', 'blur-space', 'blur-alternate', 'blur-negative-zero', 'blur-negative', 'blur-large',
  'blur-nan', 'blur-infinity', 'camera-empty', 'microphone-empty', 'profile-browser-on', 'profile-format',
  'profile-version'] as const
export type MediaFault = typeof MEDIA_FAULTS[number]

/** Actual primary current writers over injected in-memory storage. No app
 * controls, media, navigator hardware or historical-format claim. */
export function mediaFixture(mode: MediaMode = 'all'): { kind: 'browser' | 'tab'; records: Map<string, string> } {
  const store = memoryDeviceStore(), tab = memoryDeviceStore()
  const storage = (s: typeof store) => ({ getItem: s.get, setItem: s.set })
  let kind: 'browser' | 'tab' = 'browser'
  if (mode === 'all') {
    storeEffectMode(store, 'replace'); storeBackgroundId(store, 'old-background')
    storeBlurStrength(store, 0.35); storeVoicePreset(store, 'deep')
    storeCameraDeviceId(store, 'opaque-camera'); storeMicDeviceId(store, 'opaque-microphone')
    readCallProfile('?callProfile=1', storage(store), storage(tab))
  } else if (mode.startsWith('effect-')) storeEffectMode(store, mode.slice(7) as 'off' | 'blur' | 'replace')
  else if (mode.startsWith('voice-')) storeVoicePreset(store, mode.slice(6) as 'off' | 'lower' | 'higher' | 'neutral' | 'deep' | 'bright')
  else if (mode.startsWith('blur-')) storeBlurStrength(store, ({ 'blur-zero': 0, 'blur-one': 1, 'blur-fraction': 0.35, 'blur-exponent': 1e-7 } as Record<string, number>)[mode]!)
  else if (mode.startsWith('background-')) storeBackgroundId(store, mode === 'background-empty' ? '' : 'https://untrusted.invalid/background?old=1')
  else if (mode === 'camera-opaque') storeCameraDeviceId(store, ' old/device\u0000opaque ')
  else if (mode === 'microphone-opaque') storeMicDeviceId(store, ' old/device\u0000opaque ')
  else {
    kind = mode.startsWith('profile-tab-') ? 'tab' : 'browser'
    readCallProfile(mode === 'profile-tab-on' ? '?callProfile=2' : '?callProfile=1', storage(store), storage(tab))
  }
  const selected = kind === 'tab' ? tab : store
  return { kind, records: new Map(selected.keys().map(k => [k, selected.get(k)!])) }
}

export function damageMediaFixture(records: Map<string, string>, fault: MediaFault): void {
  const effect = 'kithmoot.call.effectMode', blur = 'kithmoot.call.blurStrength'
  switch (fault) {
    case 'wrapped': records.set('kithmoot.account.' + 'a'.repeat(64) + '.' + effect, records.get(effect)!); records.delete(effect); break
    case 'family-root': records.set('kithmoot.call', 'opaque'); break
    case 'version': records.set('kithmoot.call.v2.effectMode', 'off'); break
    case 'unknown-key': records.set('kithmoot.call.speakerDeviceId', 'opaque'); break
    case 'effect': records.set(effect, 'sepia'); break
    case 'voice': records.set('kithmoot.call.voicePreset', 'robot'); break
    case 'camera-empty': records.set('kithmoot.call.cameraDeviceId', ''); break
    case 'microphone-empty': records.set('kithmoot.call.micDeviceId', ''); break
    case 'profile-browser-on': records.set(CALL_PROFILE_KEY, '2'); break
    case 'profile-format': records.set(CALL_PROFILE_KEY, '1.0'); break
    case 'profile-version': records.set(CALL_PROFILE_KEY + '.v2', '1'); break
    default: records.set(blur, ({'blur-empty':'','blur-space':' 0.5','blur-alternate':'0.50','blur-negative-zero':'-0',
      'blur-negative':'-0.1','blur-large':'1.1','blur-nan':'NaN','blur-infinity':'Infinity'} as Record<string,string>)[fault]! )
  }
}
