// Fixed native names only. This module must remain free of runtime imports
// and initialisation effects so the first page-entry decision can use it.
export const ORDINARY_DATABASE = 'kithmoot-ordinary-state-v1'
export const ORDINARY_MIGRATION_LOCK = ORDINARY_DATABASE + ':migration'
export const ORDINARY_WRITE_LOCK = ORDINARY_DATABASE + ':write'
