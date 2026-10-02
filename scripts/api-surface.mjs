// Shared by `src/api-surface.test.ts` and by hand when the committed
// snapshot needs a deliberate update (`node scripts/api-surface.mjs`).
//
// Resolves a module's export list SEMANTICALLY, via the TypeScript type
// checker's `getExportsOfModule` - not by walking the file's own AST for
// `export` keywords. The two disagree on exactly the case this snapshot
// exists to catch: `export * from './x.js'` has no names of its own to
// record syntactically, so an AST walk can only note that the re-export
// statement exists (as `*:<module>`, the previous approach here) - which
// means a module extracted into a shared kit and re-exported through a thin
// `export * from '@forgesworn/circle-kit'` shim records a DIFFERENT
// snapshot than the original file did, even though every name a consumer
// can import is identical. `getExportsOfModule` resolves the wildcard
// re-export through to the real, underlying names, so the kit's shim and
// the file it replaces snapshot identically - which is the whole point of
// a snapshot meant to survive that extraction (see
// @forgesworn/fold-kit's EXTRACTION.md).
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))

/** One TypeScript `Program` for the whole project, built once and reused
 *  across every `moduleExports` call in a process - rebuilding it per file
 *  would mean re-parsing and re-binding every file in `src/` and `test/`
 *  on every single lookup. */
let cachedProgram

function getProgram() {
  if (cachedProgram) return cachedProgram
  const configPath = join(here, '..', 'tsconfig.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    throw new Error(`api-surface.mjs: could not read ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`)
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath))
  cachedProgram = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  return cachedProgram
}

/** @param {string} filePath @returns {string[]} sorted, deduplicated export names, resolved through any `export *` re-export. */
export function moduleExports(filePath) {
  const program = getProgram()
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(filePath)
  if (!sourceFile) {
    throw new Error(`api-surface.mjs: ${filePath} is not part of the tsconfig's program (check its include/exclude)`)
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  // A file with no `export` statement at all (impossible for anything in
  // MODULES today, but not for a hypothetical future entry) has no module
  // symbol, and so exports nothing.
  if (!moduleSymbol) return []
  const exports = checker.getExportsOfModule(moduleSymbol)
  return [...new Set(exports.map((symbol) => symbol.name))].sort()
}

/** Snapshot name -> file the plan's §1.1 table names it from. Shared with
 *  `src/api-surface.test.ts`, which imports this rather than keeping its own
 *  copy, so the tracked module list can never drift between the check and
 *  the thing that (deliberately) updates it. */
export const MODULES = {
  index: 'index.ts',
  hex: 'hex.ts',
  verify: 'verify.ts',
  identity: 'identity.ts',
  kinds: 'kinds.ts',
  types: 'types.ts',
  credential: 'credential.ts',
  room: 'room.ts',
  'network-hints': 'network-hints.ts',
  'display-name': 'display-name.ts',
  access: 'access.ts',
  invitation: 'invitation.ts',
  'persistent-invitation': 'persistent-invitation.ts',
  link: 'link.ts',
  epoch: 'epoch.ts',
  chat: 'chat.ts',
  lane: 'lane.ts',
}

// Run directly (`node scripts/api-surface.mjs`) to deliberately regenerate
// the committed snapshot from the CURRENT export lists - never done as a
// side effect of running the test suite, only by hand, the same way
// `vectors/generate.mjs` is only ever run by hand or by `npm run vectors`.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import('node:fs')
  const snapshotPath = join(here, '..', 'src', 'api-surface.snapshot.json')
  /** @type {Record<string, string[]>} */
  const snapshot = {}
  for (const [name, file] of Object.entries(MODULES)) snapshot[name] = moduleExports(join(here, '..', 'src', file))
  const ordered = Object.fromEntries(Object.keys(MODULES).sort().map((name) => [name, snapshot[name]]))
  writeFileSync(snapshotPath, JSON.stringify(ordered, null, 2) + '\n')
  console.log(`wrote ${snapshotPath}`)
  for (const [name, names] of Object.entries(ordered)) console.log(`  ${name}: ${names.length} export(s)`)
}
