import { main as runContextCli } from '@forgesworn/context-tools/cli'
import { kithmootContextOptions } from '../context.js'

/** Keep existing NanoClaw commands, key paths and encrypted caches working. */
export async function main(): Promise<void> {
  await runContextCli({ name: 'kithmoot-context', configureVault: kithmootContextOptions })
}
