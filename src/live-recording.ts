import { decodeControl, type ControlMessage } from './control.js'
import { verifyRecordingNotice, verifyRecordingCaptureNotice } from './meeting.js'

type Recording = Extract<ControlMessage, { op: 'recording' }>
type Capture = Extract<ControlMessage, { op: 'recording-capture' }>

/** Profile 3 carries the authority's warning in presence. Profile 4 also
 * lets a credentialled call device announce its own recording. The outer
 * roster signature binds the call and publisher; no room powers are granted. */
export interface LiveRecordingState {
  recording: Recording
  capture?: Capture
  call?: string
  recorder?: string
  device?: string
}

/** A complete warning is adopted atomically, never one half at a time. */
export function readLiveRecordingState(value: unknown): LiveRecordingState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['recording', 'capture', 'call', 'recorder', 'device'].includes(key))) return undefined
  const recording = decodeControl(JSON.stringify(raw.recording))
  const capture = raw.capture === undefined ? undefined : decodeControl(JSON.stringify(raw.capture))
  if (recording?.op !== 'recording' || (capture && capture.op !== 'recording-capture')) return undefined
  if (recording.on ? !capture || capture.op !== 'recording-capture' || capture.id !== recording.id || capture.version !== recording.version : raw.capture !== undefined) return undefined
  const member = raw.call !== undefined || raw.recorder !== undefined || raw.device !== undefined
  if (member && (typeof raw.call !== 'string' || !/^[0-9a-f]{32}$/.test(raw.call) ||
      typeof raw.recorder !== 'string' || !/^[0-9a-f]{64}$/.test(raw.recorder) ||
      typeof raw.device !== 'string' || !/^[0-9a-f]{64}$/.test(raw.device))) return undefined
  if (member && capture?.op === 'recording-capture' && (capture.recorder !== raw.recorder || capture.device !== raw.device)) return undefined
  return { recording, ...(capture?.op === 'recording-capture' ? { capture } : {}),
    ...(member ? { call: raw.call as string, recorder: raw.recorder as string, device: raw.device as string } : {}) }
}

/** Called only after roster authentication and admission. A member cannot
 * name another recorder, take down another device's notice or transplant a
 * warning to another call. Legacy root-signed warnings remain readable. */
export function verifyLiveRecordingState(opts: {
  roomId: string; state: LiveRecordingState; authority?: string
  participant: string; device: string; call?: string; profile?: number
}): boolean {
  const state = readLiveRecordingState(opts.state)
  if (!state) return false
  const member = state.call !== undefined
  if (member && (opts.profile !== 4 || (state.recording.on && state.call !== opts.call) || state.recorder !== opts.participant || state.device !== opts.device)) return false
  const valid = (key: string) => verifyRecordingNotice({ roomId: opts.roomId, notice: state.recording, sig: state.recording.sig, authority: key }) &&
    (!state.capture || verifyRecordingCaptureNotice({ roomId: opts.roomId, notice: state.capture, sig: state.capture.sig, authority: key }))
  return (member && valid(opts.device)) || (!!opts.authority && valid(opts.authority))
}

export function recordingProfile(value: unknown): 2 | 3 | 4 | undefined {
  return value === 2 || value === 3 || value === 4 ? value : undefined
}
