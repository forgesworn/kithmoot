import { afterEach, expect, test, vi } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error Node-only preparation verifier has no browser declarations.
import { candidateDirectory, candidatePin, repositoryRoot, verifyCandidateDirectory } from '../scripts/admin2-product-candidate.mjs'
import { verifyAdmin2CandidateFile } from '../app/src/mls-admin2-candidate-assets.js'
const scratch: string[] = []
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })
function copied() {
  const parent = resolve(repositoryRoot, '.local'); mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(resolve(parent, 'admin2-verifier-test-')); scratch.push(directory)
  for (const name of ['manifest.json', ...Object.keys(candidatePin.files)]) copyFileSync(resolve(candidateDirectory, name), resolve(directory, name))
  return directory
}
function buffer(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer }
test('exact tracked candidate verifies without relabelling native qualification provenance', async () => {
  const files = verifyCandidateDirectory()
  const manifest = JSON.parse(files.get('manifest.json').toString())
  expect(manifest.qualificationOnly).toBe(true); expect(manifest.experimental).toBe(true)
  for (const file of ['manifest.json', 'vmls_wasm.js', 'vmls_wasm_bg.wasm'] as const) await verifyAdmin2CandidateFile(file, buffer(files.get(file)))
})
test.each(['manifest.json', 'vmls_wasm.js', 'vmls_wasm_bg.wasm', 'vmls_wasm.d.ts'])('build verifier refuses tampered exact input %s', file => {
  const directory = copied(), bytes = readFileSync(resolve(directory, file)); bytes[bytes.length - 1] ^= 1
  writeFileSync(resolve(directory, file), bytes)
  expect(() => verifyCandidateDirectory(directory)).toThrow(file)
})
test.each(['manifest.json', 'vmls_wasm.js', 'vmls_wasm_bg.wasm'] as const)('runtime verifier refuses tampered bytes %s', async file => {
  const bytes = readFileSync(resolve(candidateDirectory, file)); bytes[bytes.length - 1] ^= 1
  await expect(verifyAdmin2CandidateFile(file, buffer(bytes))).rejects.toThrow(file)
})
test('selected non-DEV loader rejects a provenance rewrite before importing executable assets', async () => {
  vi.stubEnv('DEV', false); vi.stubEnv('VITE_MLS_INVITATION_PROFILE', 'admin2'); vi.stubEnv('VITE_ACCOUNT_NETWORK_DEFAULT', 'private-invitations')
  for (const flag of ['VITE_BROWSER_MLS_PREVIEW', 'VITE_BROWSER_MLS_INVITATION_PREVIEW', 'VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW', 'VITE_MIXED_INVITATION_LAB']) vi.stubEnv(flag, '')
  const manifest = JSON.parse(readFileSync(resolve(candidateDirectory, 'manifest.json'), 'utf8')); manifest.qualificationOnly = false
  const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest)))
  vi.stubGlobal('fetch', fetcher)
  const { loadAdminInvitationEngine } = await import('../app/src/mls-admin-invitation-engine.js')
  await expect(loadAdminInvitationEngine()).rejects.toThrow('manifest.json')
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]).toBeDefined()
})
