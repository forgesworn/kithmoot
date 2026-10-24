import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Build inputs only. Companion README, qualification notes, mobile work and
// unrelated protocol crates are deliberately outside these source closures.
const inputs = {
  relayswarm: {
    files: ['package.json', 'package-lock.json', '.gitattributes', 'LICENSE', 'src/relay-session.mjs',
      'src/browser/realtime-peer.mjs', 'src/node/native-realtime.mjs', 'scripts/build-native-realtime.mjs'],
    directories: ['native-patches', 'scripts/native-patches'],
  },
  sapflow: {
    files: ['Cargo.toml', 'Cargo.lock', '.cargo/config.toml', '.cargo/config',
      'rust-toolchain.toml', 'rust-toolchain', 'LICENSE',
      'crates/sapflow-core/Cargo.toml', 'crates/sapflow-core/build.rs',
      'crates/sapflow-realtime-wasm/Cargo.toml', 'crates/sapflow-realtime-wasm/build.rs',
      'crates/sapflow-realtime-wasm/browser.mjs',
      'scripts/build-realtime-wasm.sh', 'scripts/third-party-licences.py'],
    directories: ['crates/sapflow-core/src', 'crates/sapflow-realtime-wasm/src'],
  },
};
const git = (directory, args) => execFileSync('git', args, { cwd: directory, maxBuffer: 8 * 1024 * 1024 });

export async function readRealtimePins(path) {
  const pins = JSON.parse(await readFile(path, 'utf8'));
  if (pins.format !== 1 || !['relayswarm', 'sapflow'].every(name => /^[0-9a-f]{40}$/.test(pins[name]))) {
    throw new Error('Unsupported realtime source manifest');
  }
  return pins;
}

/** Verify names and bytes, including ignored/untracked automatic build inputs.
 * A previous manifest never substitutes for checking current source. */
export async function reviewRealtimeSource({ directory, repository, revision, allowWorkingTree = false }) {
  const spec = inputs[repository];
  if (!spec || !/^[0-9a-f]{40}$/.test(revision)) throw new Error('Unsupported realtime source revision');
  directory = await realpath(resolve(directory));
  if (await realpath(git(directory, ['rev-parse', '--show-toplevel']).toString().trim()) !== directory) {
    throw new Error('Realtime source must name a checkout root');
  }
  const head = git(directory, ['rev-parse', 'HEAD']).toString().trim();
  // Cargo resolves the existing workspace/path manifests even when building
  // only the realtime crate. Protocol source in those other crates is unused.
  const workspaceManifests = repository === 'sapflow'
    ? git(directory, ['ls-tree', '-rz', '--name-only', revision]).toString().split('\0')
      .filter(path => /^(?:crates|vendor)\/.*\/Cargo\.toml$/.test(path)) : [];
  const paths = [...new Set([...spec.files, ...spec.directories, ...workspaceManifests])];
  const tracked = git(directory, ['ls-tree', '-rz', '--name-only', revision, '--', ...paths])
    .toString().split('\0').filter(Boolean).sort();
  if (tracked.length === 0 || repository === 'relayswarm' && !tracked.includes('src/node/native-realtime.mjs')) {
    throw new Error('Pinned realtime source lacks required build inputs');
  }
  const actual = new Set();
  let visited = 0;
  async function walk(path) {
    if (++visited > 8192) throw new Error('Realtime source closure exceeds its bound');
    let info;
    try { info = await lstat(join(directory, path)); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error('Realtime build inputs must be regular files and directories');
    if (info.isDirectory()) {
      for (const name of await readdir(join(directory, path))) await walk(`${path}/${name}`);
    } else if (info.isFile()) {
      if (info.size > 8 * 1024 * 1024 || actual.size >= 4096) throw new Error('Realtime source closure exceeds its bound');
      actual.add(path);
    } else throw new Error('Realtime build input is not a regular file');
  }
  for (const path of paths) await walk(path);
  const expected = new Set(tracked), files = {}, changedFiles = [];
  const extraFiles = [...actual].filter(path => !expected.has(path)).sort();
  const missingFiles = tracked.filter(path => !actual.has(path));
  for (const path of [...new Set([...tracked, ...actual])].sort()) {
    if (!actual.has(path)) { files[path] = null; continue; }
    const data = await readFile(join(directory, path));
    if (data.length > 8 * 1024 * 1024) throw new Error('Realtime source closure exceeds its bound');
    files[path] = createHash('sha256').update(data).digest('hex');
    if (expected.has(path) && !data.equals(git(directory, ['show', `${revision}:${path}`]))) changedFiles.push(path);
  }
  const matches = extraFiles.length === 0 && missingFiles.length === 0 && changedFiles.length === 0;
  if (!matches && !allowWorkingTree) throw new Error('Relevant realtime source differs from the reviewed revision; explicit --allow-working-tree is only for local qualification');
  return { repository, head, reviewedRevision: revision, reviewedSourceMatch: matches, workingTree: !matches,
    files, symlinks: {}, extraFiles, missingFiles, changedFiles };
}

export function assertRealtimeSourceStable(before, after) {
  if (before.repository !== after.repository || before.reviewedRevision !== after.reviewedRevision
    || JSON.stringify(before.files) !== JSON.stringify(after.files)) {
    throw new Error('Realtime build input changed while the build was running');
  }
}
