import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.argv[2] ?? resolve(root, 'dist/den-client.mjs'))
const result = await build({ absWorkingDir: root, entryPoints: ['src/den-client.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof', metafile: true, write: false })
const bytes = result.outputFiles[0].contents
const hash = value => createHash('sha256').update(value).digest('hex')
const sources = {}
for (const path of Object.keys(result.metafile.inputs).sort()) sources[path] = hash(await readFile(resolve(root, path)))
await mkdir(dirname(output), { recursive: true })
await writeFile(output, bytes)
await writeFile(output.replace(/\.mjs$/, '.d.mts'), `/** Generated public JSON boundary. Canonical implementation: KithMoot. */
export interface DenWorkStore { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
export declare class DenAssignmentClient {
  constructor(options: { secret: string; device: string; store: DenWorkStore; changed: () => void });
  open(): Promise<void>;
  connect(link: string, name: string): Promise<unknown>;
  room(id: string): unknown;
  snapshot(): unknown;
  prepare(room: string, operation: unknown, request: string): unknown;
  submit(room: string, assignment: string | undefined, operation: never, request: string): Promise<unknown>;
  retry(room: string): Promise<void>;
  close(): void;
}
`)
await writeFile(output.replace(/\.mjs$/, '.json'), JSON.stringify({ protocol: 'kithmoot/assignment/v1', bundle: hash(bytes), sources }, null, 2) + '\n')
console.log(`Bundled ${relative(root, output)} (${bytes.length} bytes; sha256 ${hash(bytes)})`)
