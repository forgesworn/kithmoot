import { invitationPreviewEnabled, loadInvitationEngine } from './mls-invitation-engine.js'
import type * as Binding from '../public/vmls-wasm/vmls_wasm.js'

const version = '6df0803012ad194f033ecbad27ad2858df26477e'
let binding: Promise<typeof Binding> | undefined

/** Self-hosted shared Rust engine, loaded only for explicit MLS use. Its
 * trapped-instance guard remains authoritative; callers must never recover
 * an engine failure by dropping witnessed state or creating a fresh group. */
export function loadMlsEngine(): Promise<typeof Binding> {
  if (invitationPreviewEnabled()) return loadInvitationEngine() as unknown as Promise<typeof Binding>
  return binding ??= (async () => {
    const base = `${import.meta.env.BASE_URL}vmls-wasm/`
    const module = await import(/* @vite-ignore */ `${base}vmls_wasm.js?v=${version}`) as typeof Binding
    await module.default({ module_or_path: `${base}vmls_wasm_bg.wasm?v=${version}` })
    return module
  })().catch(error => { binding = undefined; throw error })
}
