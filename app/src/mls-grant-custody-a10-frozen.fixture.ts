import { mlsGrantCustodyRecords, type MlsGrantCustody } from './mls-grant-custody.js'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(',') === keys
const hex = /^[0-9a-f]{64}(?![\s\S])/
const invalid = () => new Error('The VMLS grant custody could not be verified.')
export function mlsGrantCustody(value: unknown): MlsGrantCustody {
  if (!object(value) || !exact(value, 'fence,phase,records,version') || value.version !== 2 ||
      value.phase !== 'fenced' && value.phase !== 'ready' || typeof value.fence !== 'string' || !hex.test(value.fence)) throw invalid()
  return { version: 2, phase: value.phase, fence: value.fence, records: mlsGrantCustodyRecords(value.records) }
}

