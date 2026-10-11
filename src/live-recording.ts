import { decodeControl, type ControlMessage } from './control.js'
import { verifyRecordingNotice, verifyRecordingCaptureNotice } from './meeting.js'

/** Profile 3 carries the authority's complete warning in live presence. */
export interface LiveRecordingState {
  recording: Extract<ControlMessage, { op: 'recording' }>
  capture?: Extract<ControlMessage, { op: 'recording-capture' }>
}

export function sanitiseLiveRecordingState(value: unknown): LiveRecordingState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => key !== 'recording' && key !== 'capture')) return undefined
  const parse = (value: unknown): ControlMessage | null => {
    try { return decodeControl(JSON.stringify(value) ?? '') } catch { return null }
  }
  const recording = parse(object.recording)
  if (recording?.op !== 'recording') return undefined
  if (!recording.on) return object.capture === undefined ? { recording } : undefined
  const capture = parse(object.capture)
  if (capture?.op !== 'recording-capture' || capture.id !== recording.id || capture.version !== recording.version) return undefined
  return { recording, capture }
}

/** A device presence signature never substitutes for the room authority. */
export function verifyLiveRecordingState(roomId: string, state: LiveRecordingState, authority: string): boolean {
  const parsed = sanitiseLiveRecordingState(state)
  return !!parsed && verifyRecordingNotice({ roomId, notice: parsed.recording, sig: parsed.recording.sig, authority }) &&
    (!parsed.capture || verifyRecordingCaptureNotice({ roomId, notice: parsed.capture, sig: parsed.capture.sig, authority }))
}
