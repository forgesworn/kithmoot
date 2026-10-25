import type * as Binding from '../public/vmls-wasm-invitation/vmls_wasm.js'
/** Separate development input. The production bundle and its verifier retain
 * their original immutable pin. No network fallback or production activation. */
let binding: Promise<typeof Binding & Record<string, any>> | undefined
export const invitationPreviewEnabled = () => import.meta.env?.DEV === true && import.meta.env?.VITE_BROWSER_MLS_INVITATION_PREVIEW === 'true'
export function loadInvitationEngine(): Promise<typeof Binding & Record<string, any>> {
  if (!invitationPreviewEnabled()) return Promise.reject(new Error('The experimental invitation profile requires an explicit development preview.'))
  return binding ??= (async () => {
    const base = `${import.meta.env.BASE_URL}vmls-wasm-invitation/`
    const manifest = await (await fetch(`${base}manifest.json`, { cache: 'no-store' })).json()
    if (manifest.sourceCommit !== 'fa366b49adcb5ff9b541209fe9ccda31f5d0d15f' || manifest.files?.['vmls_wasm_bg.wasm'] !== '9963d5c5ee6e744a15ac0ebb303bdd71645d65683d003300ed4459e80ffef134' || manifest.files?.['vmls_wasm.js'] !== '9b01589eddd99a6c2cc6823c4f4a6be151011746d1cdf45a224162e8675f2fcc' || manifest.experimental !== true || !/^[0-9a-f]{64}$/.test(manifest.files?.['vmls_wasm_bg.wasm']) || !/^[0-9a-f]{64}$/.test(manifest.files?.['vmls_wasm.js'])) throw new Error('Missing exact experimental artifact provenance.')
    const verified = new Map<string, ArrayBuffer>()
    for (const file of ['vmls_wasm.js', 'vmls_wasm_bg.wasm']) {
      const bytes = await (await fetch(`${base}${file}`, { cache: 'no-store' })).arrayBuffer()
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
      if (hash !== manifest.files[file]) throw new Error('Experimental engine bytes differ from the development manifest.')
      verified.set(file, bytes)
    }
    const url = URL.createObjectURL(new Blob([verified.get('vmls_wasm.js')!], { type: 'text/javascript' }))
    try {
      const module = await import(/* @vite-ignore */ url)
      await module.default({ module_or_path: verified.get('vmls_wasm_bg.wasm')! })
      return module
    } finally { URL.revokeObjectURL(url) }
  })().catch(error => { binding = undefined; throw error })
}
