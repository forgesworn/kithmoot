import { describe, expect, it } from 'vitest'
import vectors from './attachment-safety-v1.json'
import { assessAttachment, cleanFileName, sniffKind } from '../src/attachment-safety.js'

const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16))

describe('attachment-safety vectors', () => {
  it.each(vectors.names)('cleans $raw', v => {
    expect(cleanFileName(v.raw)).toEqual({ name: v.name, ext: v.ext, hadDirectionControls: v.hadDirectionControls })
  })
  it.each(vectors.sniff)('sniffs $kind', v => { expect(sniffKind(fromHex(v.head))).toBe(v.kind) })
  it.each(vectors.decisions)('decides $envelopeName as $tier', v => {
    const d = assessAttachment({
      bytes: fromHex(v.head), envelopeName: v.envelopeName, declaredType: v.declaredType, sender: 'Rowan',
      ...('messageName' in v ? { messageName: v.messageName as string } : { messageName: v.envelopeName }),
    })
    expect({ tier: d.tier, reason: d.reason }).toEqual({ tier: v.tier, reason: v.reason })
  })
})
