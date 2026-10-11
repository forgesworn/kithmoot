import { readLogoImage, type LogoImage } from './logo-image.js'

export interface RoomLogoOp { op: 'logo'; id: string; at: number; sha256: string | null; carried?: true }

export function readRoomLogoOp(value: unknown): RoomLogoOp | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['op', 'id', 'at', 'sha256', 'carried'].includes(key)) || raw.op !== 'logo' ||
      typeof raw.id !== 'string' || !/^[0-9a-f]{32}$/.test(raw.id) || !Number.isSafeInteger(raw.at) || (raw.at as number) <= 0 ||
      raw.sha256 !== null && (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) ||
      raw.carried !== undefined && raw.carried !== true) return
  return { op: 'logo', id: raw.id, at: raw.at as number, sha256: raw.sha256 as string | null, ...(raw.carried ? { carried: true } : {}) }
}

/** Inline image bytes are accepted only beside the matching control operation,
 * inside the room's existing credential-bound encrypted chat envelope. */
export function roomLogoPayload(text: string, value: unknown, channel: string | undefined): LogoImage | null | undefined {
  try {
    if (channel !== 'control') return
    const op = readRoomLogoOp(JSON.parse(text))
    if (!op) return
    if (value === null) return op.sha256 === null ? null : undefined
    const image = readLogoImage(value)
    return image && op.sha256 === image.sha256 ? image : undefined
  } catch { return }
}
