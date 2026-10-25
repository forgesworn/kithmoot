import type * as Binding from '../public/vmls-wasm-admin-invitation/vmls_wasm.js'
/** An independent development-only Admin2 asset pin. No legacy fallback. */
export const adminInvitationPreviewEnabled = () => import.meta.env?.DEV === true && import.meta.env?.VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW === 'true'
// Exact reviewed local qualification build; production assets retain their own pin.
export const ADMIN_INVITATION_ASSET_PIN = { sourceCommit: '5b3eb5fe28255b5c0cc09d959a3010a3d48f9562', js: '2c07c8c3f0a883440ee9a3c4c2a300bdb20b5e8c9e6d3ff0b65c7b904786c099', wasm: '8c593171bafa5d205e570f58ab1171894b70e5f05d5361b95254228702621560' } as const
let binding: Promise<typeof Binding> | undefined
export function loadAdminInvitationEngine(): Promise<typeof Binding> {
  if (!adminInvitationPreviewEnabled() || import.meta.env?.VITE_BROWSER_MLS_INVITATION_PREVIEW === 'true') return Promise.reject(new Error('Choose only the explicit Admin2 development preview.'))
  return binding ??= (async () => {
    const base = `${import.meta.env.BASE_URL}vmls-wasm-admin-invitation/`
    const response = await fetch(`${base}manifest.json`, { cache: 'no-store' })
    if (!response.ok) throw new Error('Missing Admin2 development manifest.')
    const m = await response.json(), pin = ADMIN_INVITATION_ASSET_PIN
    if (!/^[0-9a-f]{40}$/.test(pin.sourceCommit) || !/^[0-9a-f]{64}$/.test(pin.js) || !/^[0-9a-f]{64}$/.test(pin.wasm) ||
        m.sourceCommit !== pin.sourceCommit || m.target !== 'web' || m.files?.['vmls_wasm.js'] !== pin.js || m.files?.['vmls_wasm_bg.wasm'] !== pin.wasm ||
        m.qualificationOnly !== true || m.experimental !== true || m.snapshotVersion !== 5 || m.profile !== 'Vennel/invitation-admins/2' || m.policy !== 'designated-leaf-admins/1') throw new Error('Missing exact Admin2 artifact provenance.')
    const verified = new Map<string, ArrayBuffer>()
    for (const file of ['vmls_wasm.js', 'vmls_wasm_bg.wasm']) {
      const response = await fetch(`${base}${file}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Missing Admin2 asset.')
      const bytes = await response.arrayBuffer()
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
      if (hash !== m.files[file]) throw new Error('Admin2 engine bytes differ from the pinned manifest.')
      verified.set(file, bytes)
    }
    const url = URL.createObjectURL(new Blob([verified.get('vmls_wasm.js')!], { type: 'text/javascript' }))
    try {
      const module = await import(/* @vite-ignore */ url) as typeof Binding
      await module.default({ module_or_path: verified.get('vmls_wasm_bg.wasm')! })
      if (typeof module.inspectAdminInvitation !== 'function' || typeof module.Session?.openAdminInvitationSession !== 'function' || typeof module.Session?.prototype.getCurrentAdminRolesV1 !== 'function') throw new Error('Engine does not implement Admin2.')
      return module
    } finally { URL.revokeObjectURL(url) }
  })().catch(error => { binding = undefined; throw error })
}
