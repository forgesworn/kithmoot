/**
 * Call choices remembered per device: whether the background effect is on
 * and which one, its blur strength, the voice preset, and which camera and
 * microphone this browser last used.
 *
 * Same shape as `text-size.ts` and the mirror self-view setting in
 * `main.ts` - one plain key per choice in `localStorage` via `DeviceStore`,
 * applied when the camera or microphone next start rather than kept live
 * against whatever call happens to be running. A background *image* choice
 * is stored as its id only, never the picture itself.
 *
 * No speaker/output choice lives here: nothing in this app picks a speaker
 * yet - there is no `setSinkId` call anywhere - so there is nothing to
 * remember.
 *
 * Every read and write is wrapped in its own try/catch, like
 * `volume-store.ts`: a browser that refuses storage (private mode, a full
 * quota) must lose only the memory of the choice, never the choice itself
 * for the rest of the visit.
 */
import type { EffectMode } from '../../src/video-effects.js'
import type { VoicePreset } from '../../src/voice-effects.js'
import type { DeviceStore } from './device-store.js'

const EFFECT_MODE_KEY = 'kithmoot.call.effectMode'
const BACKGROUND_KEY = 'kithmoot.call.background'
const BLUR_STRENGTH_KEY = 'kithmoot.call.blurStrength'
const VOICE_PRESET_KEY = 'kithmoot.call.voicePreset'
const CAMERA_DEVICE_KEY = 'kithmoot.call.cameraDeviceId'
const MIC_DEVICE_KEY = 'kithmoot.call.micDeviceId'

const EFFECT_MODES: readonly EffectMode[] = ['off', 'blur', 'replace']
const VOICE_PRESETS: readonly VoicePreset[] = ['off', 'lower', 'higher', 'neutral', 'deep', 'bright']

function readString(store: DeviceStore, key: string): string | undefined {
  try {
    return store.get(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeString(store: DeviceStore, key: string, value: string): void {
  try {
    store.set(key, value)
  } catch {
    // Private mode or a full quota: the choice still applies to this call,
    // only its memory is lost.
  }
}

export function loadEffectMode(store: DeviceStore): EffectMode | undefined {
  const value = readString(store, EFFECT_MODE_KEY)
  return (EFFECT_MODES as readonly string[]).includes(value ?? '') ? (value as EffectMode) : undefined
}

export function storeEffectMode(store: DeviceStore, mode: EffectMode): void {
  writeString(store, EFFECT_MODE_KEY, mode)
}

/** A background choice's id - validated only as a non-empty string here;
 *  whether it still names a real choice is for the caller, which knows
 *  today's `BACKGROUNDS` list. */
export function loadBackgroundId(store: DeviceStore): string | undefined {
  return readString(store, BACKGROUND_KEY)
}

export function storeBackgroundId(store: DeviceStore, id: string): void {
  writeString(store, BACKGROUND_KEY, id)
}

export function loadBlurStrength(store: DeviceStore): number | undefined {
  const raw = readString(store, BLUR_STRENGTH_KEY)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

export function storeBlurStrength(store: DeviceStore, strength: number): void {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) return
  writeString(store, BLUR_STRENGTH_KEY, String(strength))
}

export function loadVoicePreset(store: DeviceStore): VoicePreset | undefined {
  const value = readString(store, VOICE_PRESET_KEY)
  return (VOICE_PRESETS as readonly string[]).includes(value ?? '') ? (value as VoicePreset) : undefined
}

export function storeVoicePreset(store: DeviceStore, preset: VoicePreset): void {
  writeString(store, VOICE_PRESET_KEY, preset)
}

/** The camera this device used last, or undefined for "never chosen" and
 *  for a stored id that turned out empty. A stored id that no longer names
 *  a plugged-in camera is not distinguished here - `CameraPipeline.start`
 *  falls back to the default camera when the exact device cannot open. */
export function loadCameraDeviceId(store: DeviceStore): string | undefined {
  return readString(store, CAMERA_DEVICE_KEY) || undefined
}

export function storeCameraDeviceId(store: DeviceStore, id: string): void {
  if (!id) return
  writeString(store, CAMERA_DEVICE_KEY, id)
}

export function loadMicDeviceId(store: DeviceStore): string | undefined {
  return readString(store, MIC_DEVICE_KEY) || undefined
}

export function storeMicDeviceId(store: DeviceStore, id: string): void {
  if (!id) return
  writeString(store, MIC_DEVICE_KEY, id)
}
