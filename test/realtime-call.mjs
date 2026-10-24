#!/usr/bin/env node
// Standalone, finite qualification: actual suite WASM, NIP-44, WebRTC,
// native independent operator and browser VP8/Opus encode/decode.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { getPublicKey } from 'nostr-tools/pure';
import { strict as assert } from 'node:assert';
import { buildRealtimeOperator } from '../scripts/build-realtime-operator.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.REALTIME_RESULTS_DIR ?? join(root, 'test-results/realtime'));
const prepared = process.env.REALTIME_PREBUILT ? resolve(process.env.REALTIME_PREPARED_DIR ?? join(root, 'test-results/realtime')) : output;
const profiles = process.env.REALTIME_PROFILES_DIR;
const meshBaseline = process.env.REALTIME_TOPOLOGY === 'mesh';
// Native close is capped at 500 ms per ICE agent. Eight serial blackholed
// closes measured 4.254 s; allow that finite cleanup plus process overhead.
const shutdownGraceMs = 6000;
assert(!profiles || !meshBaseline, 'The mesh baseline uses explicit direct loopback ICE');
const counts = (process.env.REALTIME_PARTICIPANTS ?? '2,4,8').split(',').map(Number);
assert(counts.every(n => [2, 4, 8].includes(n)));
if (profiles) assert(((await stat(profiles)).mode & 0o077) === 0, 'Private profiles directory required');
const scratch = await mkdtemp(join(tmpdir(), 'kithmoot-realtime-'));
const children = new Set();
let browser, server;
const contexts = [];
const results = { format: 1, suite: 'Spry/RelaySwarm/Sapflow realtime adapter', generatedMediaOnly: true,
  physicalDevice: false, certificateBypass: false, clientNetwork: 'one host', publicSpry: !!profiles,
  shutdownGraceMs, topology: meshBaseline ? 'mesh' : 'forwarded', groups: [] };
async function profile(name) {
  if (!profiles) return { iceServers: [], iceTransportPolicy: 'all' };
  const path = join(profiles, name + '.json'), info = await stat(path);
  assert((info.mode & 0o077) === 0 && info.size <= 16384);
  const p = JSON.parse(await readFile(path, 'utf8'));
  const urls = p.urls.filter(url => url.startsWith('turn:') && url.endsWith('?transport=udp'));
  assert.equal(urls.length, 1);
  return { iceServers: [{ urls, username: p.username, credential: p.credential }], iceTransportPolicy: 'relay' };
}
function start(file, args = [], env = {}) {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, DEBUG: '', NODE_DEBUG: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.outputCounts = { stdoutBytes: 0, stderrBytes: 0 };
  child.stdout.on('data', data => { child.outputCounts.stdoutBytes += data.length; });
  child.stderr.on('data', data => { child.outputCounts.stderrBytes += data.length; });
  children.add(child); child.once('exit', () => children.delete(child)); return child;
}
async function stop(child) {
  if (!child) return { forced: false, code: 0, signal: null, stdoutBytes: 0, stderrBytes: 0, absent: true };
  if (child.exitCode !== null || child.signalCode) return { forced: false, code: child.exitCode, signal: child.signalCode, ...child.outputCounts };
  let forced = false;
  const began = performance.now();
  await new Promise(resolve => { const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, shutdownGraceMs); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
  return { forced, code: child.exitCode, signal: child.signalCode, durationMs: performance.now() - began, ...child.outputCounts };
}
async function until(fn, timeout = 45000, message = 'Realtime qualification timed out') {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(message);
}
async function operator(secretKey, clients, namespace, relay, name) {
  const config = join(scratch, name + '.json');
  await writeFile(config, JSON.stringify({ secretKey: secretKey.toString('hex'), allowedClients: clients, namespace, relays: [relay], ...await profile(name) }), { mode: 0o600 });
  const child = start('dist/realtime-forwarder.mjs', [config]);
  let ready = false, failed = false;
  child.stdout.on('data', data => { if (data.toString().includes('Realtime operator ready')) ready = true; });
  child.once('exit', () => { failed = true; });
  await until(() => { if (failed) throw new Error('Independent operator failed to start'); return ready; }, 15000);
  return child;
}
const call = (page, method, arg) => page.evaluate(({ method, arg }) => window.realtimeFixture[method](arg), { method, arg });
async function healthy(pages, expected, timeout = 60000) {
  return until(async () => {
    const rows = await Promise.all(pages.map(page => call(page, 'metrics')));
    if (rows.some((row, i) => row.errors.length || row.media.length !== expected[i] || row.adapter.closed || row.transport.closed || !row.transport.ready)) {
      if (rows.some(row => row.errors.length || row.adapter.closed || row.transport.closed || !row.transport.ready)) throw new Error('A realtime endpoint failed closed');
      return false;
    }
    if (rows.every(row => row.media.every(v => v.width > 0 && v.rms > .003 && v.videoTime > .2 && v.audioTime > .2 && v.audible)
      && row.adapter.decoders.every(d => d.videoFrames > 2 && d.audioFrames > 2))) return rows;
    return false;
  }, timeout);
}
async function freshSince(pages, before, expected) {
  await healthy(pages, expected);
  return until(async () => {
    const rows = await Promise.all(pages.map(page => call(page, 'metrics')));
    return rows.every((row,i) => row.adapter.decoders.every((d,j) => d.videoFrames > before[i].adapter.decoders[j].videoFrames + 2
      && d.audioFrames > before[i].adapter.decoders[j].audioFrames + 2)
      && row.media.every((m,j) => m.videoTime > before[i].media[j].videoTime + .2 && m.audioTime > before[i].media[j].audioTime + .2
        && m.rms > .003 && m.audible)) ? rows : false;
  }, 30000, 'Every source must deliver fresh video and audio after recovery');
}
try {
  await mkdir(output, { recursive: true });
  if (!process.env.REALTIME_PREBUILT) {
    execFileSync(process.execPath, ['scripts/prepare-realtime.mjs'], { cwd: root, stdio: 'pipe' });
    await buildRealtimeOperator();
    await build({ entryPoints: [join(root, 'test/realtime.browser.ts')], bundle: true, platform: 'browser', format: 'esm', outfile: join(output, 'fixture.mjs') });
    await build({ entryPoints: [join(root, 'test/browser-protected-share-fixture.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(output, 'protected-source.mjs') });
  }
  const manifest = JSON.parse(await readFile(join(root, 'dist/realtime-runtime/manifest.json'), 'utf8'));
  const backend = JSON.parse(await readFile(join(root, 'dist/realtime-runtime/operator-backend.json'), 'utf8'));
  const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  for (const [name, hash] of Object.entries(manifest.assets)) assert.equal(await digest(join(root, 'dist/realtime-runtime', name)), hash);
  for (const [name, hash] of Object.entries(manifest.nativeAssets ?? {})) assert.equal(await digest(join(root, 'dist/realtime-runtime', name)), hash);
  const operatorSha256 = await digest(join(root, 'dist/realtime-forwarder.mjs'));
  assert.equal(operatorSha256, backend.bundleSha256, 'The operator must match its guarded backend receipt');
  results.artifacts = { sources: manifest.sources, assets: manifest.assets, backend,
    fixtureSha256: await digest(join(prepared, 'fixture.mjs')), operatorSha256 };
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><button id="share">Prepare protected share</button><script type="module" src="/fixture.mjs"></script>'); return; }
      const files = { '/fixture.mjs': join(prepared, 'fixture.mjs') };
      for (const name of ['transport.mjs', 'sapflow.mjs', 'sapflow_realtime_bg.wasm']) files['/runtime/' + name] = join(root, 'dist/realtime-runtime', name);
      if (!files[pathname]) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', extname(pathname) === '.wasm' ? 'application/wasm' : 'text/javascript'); res.end(await readFile(files[pathname]));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const relayPort = Number(process.env.REALTIME_RELAY_PORT ?? 62974);
  const relay = start('test/ws-relay.mjs', [], { RELAY_PORT: String(relayPort) });
  await until(async () => { if (relay.exitCode !== null) throw new Error('Local relay did not start'); try { return (await fetch(`http://127.0.0.1:${relayPort}`)).ok; } catch { return false; } }, 10000);
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
  results.runtime = { node: process.version, chromium: browser.version(), platform: process.platform, arch: process.arch };
  for (const count of counts) {
    const namespace = randomBytes(16).toString('hex'), key = randomBytes(32).toString('hex'), pages = [], descriptions = [];
    let first, second, protectedPopup;
    const group = { participants: count, protectedShare: count === 4, forwarderReplacement: false };
    try {
      for (let i = 0; i < count; i++) {
        const context = await browser.newContext({ ignoreHTTPSErrors: false }); contexts.push(context);
        const page = await context.newPage(); pages.push(page);
        page.on('pageerror', () => { group.browserError = true; });
        await page.goto(base); await page.waitForFunction(() => !!window.realtimeFixture);
        descriptions.push(await call(page, 'boot', { base: base + '/runtime/', relay: `ws://127.0.0.1:${relayPort}`, namespace, index: i, ice: await profile('browser-' + i) }));
      }
      if (count === 4) {
        const popupEvent = pages[0].waitForEvent('popup'); await pages[0].locator('#share').click(); const popup = await popupEvent; protectedPopup = popup;
        // The exact generated input used by the product protected-share gate.
        const { syntheticSource } = await import(pathToFileURL(join(prepared, 'protected-source.mjs')).href);
        await syntheticSource(popup);
        await popup.getByRole('button', { name: 'Choose a window or tab' }).click();
        await popup.getByRole('button', { name: 'Hide a region', exact: true }).click();
        await popup.getByRole('button', { name: 'Resize shared area', exact: true }).press('ArrowLeft');
        await popup.getByRole('button', { name: 'Start protected sharing' }).click();
        await until(async () => (await call(pages[0], 'describe')).length === 2);
        descriptions[0] = await call(pages[0], 'describe');
      }
      const clients = descriptions.map(d => d[0].sender), a = randomBytes(32), b = randomBytes(32);
      if (!meshBaseline) first = await operator(a, clients, namespace, `ws://127.0.0.1:${relayPort}`, 'operator-a');
      await Promise.all(pages.map((page, i) => call(page, 'begin', { roomKey: key, ...(meshBaseline ? {} : { operator: getPublicKey(a) }), remote: descriptions.flatMap((d, j) => i === j ? [] : d) })));
      if (meshBaseline) await Promise.all(pages.map(page => call(page, 'startMesh')));
      const expected = pages.map((_, i) => descriptions.flatMap((d, j) => i === j ? [] : d).length);
      group.initial = await healthy(pages, expected);
      assert(group.initial.every(row => row.transport.delivery === 'finite-lifetime' && row.transport.maxPacketLifeTimeMs === 250), 'The negotiated finite lifetime must be exactly250ms');
      await new Promise(resolve => setTimeout(resolve, 1500));
      group.continued = await healthy(pages, expected);
      assert(group.continued.every((row, i) => row.adapter.receivedFrames > group.initial[i].adapter.receivedFrames));
      const startedMeasurement = performance.now();
      const baseline = await Promise.all(pages.map(page => call(page, 'metrics'))), samples = [];
      for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        samples.push(await Promise.all(pages.map(page => call(page, 'metrics'))));
      }
      const final = samples.at(-1), markers = samples.flatMap(rows => rows.flatMap(r => r.media.filter(m => m.role === 'camera')));
      const latency = markers.filter(m => m.markerValid && Number.isFinite(m.latencyMs)).map(m => m.latencyMs).sort((a,b) => a-b);
      group.measurement = { durationMs: performance.now() - startedMeasurement, requestedDurationMs: 4000,
        uploadBytes: final.map((r,i) => r.transport.sentBytes - baseline[i].transport.sentBytes),
        publishedFrames: final.map((r,i) => r.adapter.sentFrames - baseline[i].adapter.sentFrames),
        receivedFrames: final.map((r,i) => r.adapter.receivedFrames - baseline[i].adapter.receivedFrames),
        decodedVideoFrames: final.map((r,i) => r.adapter.decoders.map((d,j) => d.videoFrames - baseline[i].adapter.decoders[j].videoFrames)),
        decodedAudioFrames: final.map((r,i) => r.adapter.decoders.map((d,j) => d.audioFrames - baseline[i].adapter.decoders[j].audioFrames)),
        connectionCopies: meshBaseline ? count-1 : 1, latencySamples: latency.length, invalidMarkerSamples: markers.length - latency.length,
        syntheticFrameAgeMs: { median: latency[Math.floor(latency.length*.5)] ?? null, p95: latency[Math.floor(latency.length*.95)] ?? null },
        sameHostClocks: true, timestampQuantisationMs: 10 };
      assert(group.measurement.receivedFrames.every(n => n > 0));
      assert(final.every((row,i) => row.adapter.decoders.every((d,j) => d.videoFrames > baseline[i].adapter.decoders[j].videoFrames + 2
        && d.audioFrames > baseline[i].adapter.decoders[j].audioFrames + 2)), 'Every remote source must keep decoding fresh media');
      assert(final.every((row,i) => row.media.every((m,j) => m.videoTime > baseline[i].media[j].videoTime + 1
        && m.audioTime > baseline[i].media[j].audioTime + 1)), 'Every remote playback clock must keep advancing');
      group.measurement.freshPlaybackEverySource = true;
      if (profiles) group.relayEvidence = await until(async () => {
        const rows = await Promise.all(pages.map(page => call(page, 'metrics')));
        return rows.every(row => row.candidate.local === 'relay' && row.candidate.remote === 'relay' && row.candidate.relayProtocol === 'udp') ? rows : false;
      }, 10000, 'Every selected candidate pair must prove relay/relay over UDP');
      if (count === 4 && !meshBaseline) {
        for (const row of group.continued.slice(1)) {
          const screen = row.media.find(m => m.role === 'screen'); assert(screen.pixels[0] < 80 && screen.pixels[5] > 130, 'Protected pixels did not survive forwarding');
        }
        const screenState = async (covered, silent = false) => until(async () => {
          const rows = await Promise.all(pages.slice(1).map(page => call(page, 'metrics')));
          return rows.every(row => { const screen = row.media.find(m => m.role === 'screen');
            return screen && (covered ? screen.pixels[5] < 80 : screen.pixels[5] > 130) && (!silent || screen.rms < .003); });
        }, 15000, 'Protected share state did not reach every receiver');
        await protectedPopup.getByRole('button', { name: 'Hide my share', exact: true }).click(); await screenState(true, true);
        await protectedPopup.getByRole('button', { name: 'Show my share', exact: true }).click(); await screenState(false);
        await protectedPopup.evaluate(() => { window.sourceCanvas.width = 800; });
        await protectedPopup.locator('#status').filter({ hasText: 'source changed' }).waitFor(); await screenState(true);
        await protectedPopup.getByRole('button', { name: 'Show my share', exact: true }).click(); await screenState(true);
        await protectedPopup.getByRole('button', { name: 'Confirm changed source', exact: true }).click(); await screenState(false);
        group.protectedHideResume = true; group.changedSourceCoveredUntilConfirmed = true;
        const beforeLoss = await Promise.all(pages.map(page => call(page, 'metrics')));
        await Promise.all(pages.map(page => call(page, 'setLoss', 37)));
        await new Promise(resolve => setTimeout(resolve, 2500));
        group.withLoss = await freshSince(pages, beforeLoss, expected);
        assert(group.withLoss.every(row => row.injectedDrops > 0));
        await Promise.all(pages.map(page => call(page, 'setLoss', 0)));
        second = await operator(b, clients, namespace, `ws://127.0.0.1:${relayPort}`, 'operator-b');
        const beforeReplacement = await Promise.all(pages.map(page => call(page, 'metrics')));
        group.replacedOperatorShutdown = await stop(first); first = undefined;
        assert(!group.replacedOperatorShutdown.forced && group.replacedOperatorShutdown.code === 0 && group.replacedOperatorShutdown.stderrBytes === 0,
          'The replaced operator must release resources and exit cleanly without a forced kill');
        await Promise.all(pages.map(page => call(page, 'replace', getPublicKey(b))));
        group.afterReplacement = await freshSince(pages, beforeReplacement, expected);
        assert(group.afterReplacement.every((row, i) => row.adapter.receivedFrames > group.continued[i].adapter.receivedFrames));
        group.forwarderReplacement = true;
      }
      group.cleanup = await Promise.all(pages.map(page => call(page, 'shutdown')));
      assert(group.cleanup.every(row => row.callerTracksPreserved));
      group.operatorShutdown = [await stop(first), await stop(second)]; first = second = undefined;
      assert(group.operatorShutdown.every(r => !r.forced && r.code === 0 && r.stderrBytes === 0), 'Operators must shut down cleanly and quietly without a forced kill');
      assert(group.operatorShutdown.every(r => r.absent || r.stdoutBytes === Buffer.byteLength('Realtime operator ready\n')),
        'The operator must emit its readiness line only, without call logs');
      assert(!group.browserError);
      group.passed = true;
      process.stdout.write(`Realtime ${count}-participant group passed\n`);
    } catch (error) {
      group.passed = false; group.failure = error.message;
      group.final = await Promise.all(pages.map(page => call(page, 'metrics').catch(() => ({ unavailable: true }))));
      throw error;
    } finally {
      results.groups.push(group); await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
      for (const page of pages) await call(page, 'shutdown').catch(() => {});
      await Promise.all(contexts.splice(0).map(c => c.close())); await stop(first); await stop(second);
    }
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  await Promise.all([...children].map(stop));
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
