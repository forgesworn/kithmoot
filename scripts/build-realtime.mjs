#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildRealtimeOperator } from './build-realtime-operator.mjs';
import { copyRealtimeBrowserAssets } from './realtime-browser-assets.mjs';
const root = resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['scripts/prepare-realtime.mjs', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
const i = process.argv.indexOf('--relayswarm-root');
await buildRealtimeOperator({ ...(i >= 0 ? { relayswarmRoot: resolve(process.argv[i+1]) } : {}), allowWorkingTree: process.argv.includes('--allow-working-tree') });
await copyRealtimeBrowserAssets(resolve(root, 'dist/realtime-runtime'), resolve(root, 'app/public/realtime'));
process.stdout.write('Built independent realtime operator and browser assets\n');
