import { ContextFileStore as PortableContextFileStore } from '@forgesworn/context-tools/store'
import { kithmootContextOptions, type ContextVaultOptions } from '../context.js'

export class ContextFileStore extends PortableContextFileStore {
  constructor(path: string, options: ContextVaultOptions) { super(path, kithmootContextOptions(options)) }
}
