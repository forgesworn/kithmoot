#!/usr/bin/env node
// Explicit local suite build. No network source fetch or operator defaults.
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { readRealtimePins, reviewRealtimeSource, assertRealtimeSourceStable } from './realtime-reviewed-sources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function prepareRealtime({ projectRoot = root, relayswarmRoot = join(projectRoot, '../relayswarm'),
  sapflowRoot = join(projectRoot, '../sapflow'), output = join(projectRoot, 'dist/realtime-runtime'), allowWorkingTree = false } = {}) {
  const swarm = resolve(relayswarmRoot), sapflow = resolve(sapflowRoot);
  const manifest = { format: 1, sources: [] };
  const pins = await readRealtimePins(join(projectRoot, 'realtime-sources.json'));
  const selections = [{ directory: swarm, repository: 'relayswarm', revision: pins.relayswarm },
    { directory: sapflow, repository: 'sapflow', revision: pins.sapflow }];
  // Both closures pass before executing Cargo or any companion build script.
  for (const selection of selections) manifest.sources.push(await reviewRealtimeSource({ ...selection, allowWorkingTree }));
  execFileSync('bash', ['scripts/build-realtime-wasm.sh'], { cwd: sapflow, stdio: 'inherit' });
  await mkdir(output, { recursive: true });
  await build({ stdin: { contents: `export {RelayPool,RelaySwarmSession} from ${JSON.stringify(join(swarm, 'src/relay-session.mjs'))};export {RealtimePeer} from ${JSON.stringify(join(swarm, 'src/browser/realtime-peer.mjs'))};`, resolveDir: projectRoot }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: join(output, 'transport.mjs') });
  await build({ entryPoints: [join(sapflow, 'target/realtime-browser/browser.mjs')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: join(output, 'sapflow.mjs') });
  await copyFile(join(sapflow, 'target/realtime-browser/sapflow_realtime_bg.wasm'), join(output, 'sapflow_realtime_bg.wasm'));
  await copyFile(join(sapflow, 'target/realtime-browser/LICENSE'), join(output, 'SAPFLOW_LICENSE'));
  await copyFile(join(sapflow, 'target/realtime-browser/THIRD_PARTY_LICENSES.txt'), join(output, 'SAPFLOW_THIRD_PARTY_LICENSES.txt'));
  await copyFile(join(swarm, 'LICENSE'), join(output, 'RELAYSWARM_LICENSE'));
  manifest.assets = {};
  for (const name of ['transport.mjs', 'sapflow.mjs', 'sapflow_realtime_bg.wasm']) manifest.assets[name] = createHash('sha256').update(await readFile(join(output, name))).digest('hex');
  const before = manifest.sources;
  manifest.sources = [];
  for (const [index, selection] of selections.entries()) {
    const after = await reviewRealtimeSource({ ...selection, allowWorkingTree });
    assertRealtimeSourceStable(before[index], after); manifest.sources.push(after);
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write('Prepared explicit RelaySwarm and Sapflow realtime assets\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  function argument(name, fallback) {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Realtime build option requires a value');
    return resolve(args[i + 1]);
  }
  await prepareRealtime({ relayswarmRoot: argument('--relayswarm-root', join(root, '../relayswarm')),
    sapflowRoot: argument('--sapflow-root', join(root, '../sapflow')),
    output: argument('--output', join(root, 'dist/realtime-runtime')), allowWorkingTree: args.includes('--allow-working-tree') });
}
