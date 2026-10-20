// Diagnostic producer only. Never run against a user's account or device.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, createWriteStream, existsSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'

const source = '17023aa3e8cd9170f50a2fb0c536bbddf5e5cb13'
const sourceTree = 'eac5f98a77de535e2dd0e31a7b55125373290f6b'
const producerPaths = ['.github/workflows/protocol-upstream.yml', 'playwright.legacy-qualification.config.ts', 'scripts/legacy-receive-qualification.mjs']
const units = ['app/src/legacy-message-inbox.test.ts', 'app/src/legacy-message-lifetime.test.ts', 'app/src/legacy-message-relays.test.ts']
const engines = ['firefox', 'webkit', 'chromium', 'chromium-desktop']
// Leave twenty minutes of the 120-minute job for final evidence/upload.
const deadline = Date.now() + 100 * 60_000
const out = resolve('release/legacy-qualification')
mkdirSync(out, { recursive: true })
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const json = (path, value) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }
const manifest = {
  schema: 'vennel.legacy-receive-initial-qualification.v1', source, sourceTree,
  producer: process.env.GITHUB_SHA, workflow: process.env.GITHUB_WORKFLOW_REF,
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  startedAt: new Date().toISOString(), producerDeadlineAt: new Date(deadline).toISOString(), uploadReserveMinutes: 20, stages: [],
  scope: 'Initial clean locked-dependency/typecheck/build and implemented cases only; no full-clause, main, release, physical or external human acceptance.',
}
const save = () => json(join(out, 'manifest.json'), manifest)
save()
function files(root) {
  return readdirSync(root).sort().flatMap(name => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? files(path) : [{ path: relative(resolve('.'), path), bytes: statSync(path).size, sha256: sha256(path) }]
  })
}
function check(condition, message) { if (!condition) throw Error(message) }
async function stage(name, command, args, minutes = 5, extra = {}) {
  const remaining = deadline - Date.now() - 10_000
  if (remaining <= 0) { skipped(name, 'Overall producer deadline; reserved finalisation/upload time'); return false }
  const budgetMs = Math.min(minutes * 60_000, remaining)
  const record = { name, command: [command, ...args], budgetMs, startedAt: new Date().toISOString(), status: 'running' }
  manifest.stages.push(record); save()
  const log = createWriteStream(join(out, `${name}.log`))
  try {
    const result = await new Promise((accept, reject) => {
      const child = spawn(command, args, { env: { ...process.env, ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let timedOut = false, killTimer
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log.write(data); process.stdout.write(data) })
      const timer = setTimeout(() => {
        timedOut = true
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* The group may have just exited. */ }
        killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already gone. */ } }, 5_000)
      }, budgetMs)
      child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error) })
      child.on('close', (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); accept({ code, signal, timedOut }) })
    })
    Object.assign(record, result, { status: result.code === 0 && !result.timedOut ? 'passed' : 'failed', endedAt: new Date().toISOString() })
  } catch (error) { Object.assign(record, { status: 'failed', error: String(error), endedAt: new Date().toISOString() }) }
  // Persist the primary exit before log closure or any inventory/diagnostic work.
  save()
  await new Promise(resolve => log.end(resolve))
  return record.status === 'passed'
}
function skipped(name, reason) { manifest.stages.push({ name, status: 'unexecuted', reason }); save() }
async function inspect(name, work) {
  const record = { name, startedAt: new Date().toISOString() }
  manifest.stages.push(record)
  try { await work(); record.status = 'passed' } catch (error) { record.status = 'failed'; record.error = String(error); console.error(error) }
  record.endedAt = new Date().toISOString(); save()
  return record.status === 'passed'
}
function browserCases(report) {
  const cases = []
  function walk(suites) {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) cases.push({ file: spec.file, title: spec.title, project: test.projectName, expectedStatus: test.expectedStatus, results: test.results })
      walk(suite.suites)
    }
  }
  walk(report.suites)
  return cases
}
try {
  check(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true', 'Remote GitHub producer only')
  check(process.env.GITHUB_REF === 'refs/heads/diagnostic/legacy-receive-qualification', 'Unexpected producer ref')
  check(process.env.GITHUB_RUN_ATTEMPT === '1', 'No automatic or unchanged attempt rerun')
  check(git('rev-parse', 'HEAD') === process.env.GITHUB_SHA, 'Checkout differs from dispatched producer')
  check(git('rev-parse', `${source}^{tree}`) === sourceTree, 'Candidate tree identity changed')
  check(git('diff', '--name-only', source, 'HEAD').split('\n').sort().join('\n') === producerPaths.sort().join('\n'), 'Producer overlay changes candidate source')
  check(git('status', '--porcelain', '--untracked-files=no') === '', 'Tracked checkout is dirty')
  for (const key of ['E2E_BASE_URL', 'E2E_DESKTOP_BASE_URL', 'E2E_GROUP', 'VITE_DESKTOP', 'VITE_TEST_DIAGNOSTICS', 'VITE_QUIET_SLOT_SECONDS', 'VITE_TEST_ROOM_END_SECONDS']) check(!process.env[key], `Unexpected build/fixture override: ${key}`)
  manifest.sourceFiles = git('ls-files', '--stage').split('\n').map(line => {
    const [entry, path] = line.split('\t'), [mode, object] = entry.split(' ')
    return mode === '160000' ? { path, mode, object } : { path, mode, object, sha256: sha256(path) }
  })
  manifest.node = process.version
  manifest.packageLockSha256 = sha256('package-lock.json')
  json(join(out, 'source-files.json'), manifest.sourceFiles); save()
  // Public Git dependency only: HTTPS transport, no stored config or credentials.
  const installed = await stage('install', 'npm', ['ci', '--no-audit', '--no-fund'], 10, {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'ssh://git@github.com/',
  })
  let dependencies = false
  if (installed) dependencies = await inspect('dependency-identity', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
    const expected = { 'signet-login': '0.19.1', '@forgesworn/signet-contacts': '0.1.0', '@playwright/test': '1.62.1', vitest: '4.1.11', typescript: '5.9.3' }
    const records = []
    for (const [name, version] of Object.entries(expected)) {
      const root = resolve('node_modules', name), path = join(root, 'package.json')
      const actual = JSON.parse(readFileSync(path, 'utf8'))
      const locked = lock.packages[`node_modules/${name}`]
      check(actual.version === version && locked.version === version, `Wrong installed/locked ${name}`)
      records.push({ name, version, locked, installedPackageSha256: sha256(path), files: files(root) })
    }
    const contacts = records.find(p => p.name === '@forgesworn/signet-contacts')
    check(contacts.locked.resolved.endsWith('#fbb13cdeefb3e07421228ab3245b7e17e403ecab'), 'Contacts Git identity changed')
    check(sha256('package-lock.json') === manifest.packageLockSha256, 'Install changed the lockfile')
    json(join(out, 'dependency-identity.json'), { records, note: 'npm ci verifies locked integrity; installed bytes retained as hashes. No source-to-published-build equivalence inferred from package version.' })
  })
  if (dependencies) {
    await stage('typecheck', 'npm', ['run', 'typecheck'])
    const lib = await stage('build-lib', 'npm', ['run', 'build:lib'])
    if (await stage('unit-inventory', './node_modules/.bin/vitest', ['list', ...units, `--json=${join(out, 'unit-inventory.json')}`])) {
      const countOk = await inspect('unit-inventory-check', () => {
        const inventory = JSON.parse(readFileSync(join(out, 'unit-inventory.json'), 'utf8'))
        check(Array.isArray(inventory) && inventory.length === 26, 'Expected 26 expanded unit cases')
        check(units.every(path => inventory.some(test => test.file.endsWith(path))), 'Missing unit file')
      })
      if (countOk && lib) {
        const passed = await stage('unit-cases', './node_modules/.bin/vitest', ['run', ...units, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${join(out, 'unit-results.json')}`])
        await inspect('unit-results-check', () => {
          const report = JSON.parse(readFileSync(join(out, 'unit-results.json'), 'utf8'))
          check(passed && report.numTotalTests === 26 && report.numPassedTests === 26 && report.numPendingTests === 0 && report.numTodoTests === 0, 'Not all 26 unit cases passed')
        })
      } else skipped('unit-cases', 'Library build or unit inventory failed')
    } else skipped('unit-cases', 'Unit collection failed')
    const pwa = await stage('build-pwa', 'npm', ['run', 'build'])
    const desktop = await stage('build-desktop', 'npm', ['run', 'build'], 5, { VITE_DESKTOP: 'true' })
    for (const [name, directory, built] of [['pwa', 'app/dist', pwa], ['desktop', 'desktop/web', desktop]]) {
      if (built) await inspect(`freeze-${name}`, async () => {
        json(join(out, `${name}-files.json`), files(resolve(directory)))
        check(await stage(`archive-${name}`, 'tar', ['-czf', join(out, `${name}.tgz`), '-C', directory, '.']), `Could not retain ${name} bytes`)
      })
    }
    let browserInventory = false
    if (await stage('browser-inventory', './node_modules/.bin/playwright', ['test', '--config=playwright.legacy-qualification.config.ts', '--list'])) {
      browserInventory = await inspect('browser-inventory-check', () => {
        const cases = browserCases(JSON.parse(readFileSync(join(out, 'browser/inventory/report.json'), 'utf8')))
        check(cases.length === 48, 'Expected 12 browser cases across four declared projects')
        for (const engine of engines) check(cases.filter(c => c.project === engine).length === 12, `Missing ${engine} cases`)
        check(cases.every(c => c.file.endsWith('legacy-messages.spec.ts')), 'Unexpected browser file')
        json(join(out, 'browser-inventory.json'), cases)
      })
    }
    let browsers = false
    if (browserInventory && (pwa || desktop)) browsers = await stage('install-browsers', './node_modules/.bin/playwright', ['install', '--with-deps', 'chromium', 'firefox', 'webkit'], 10)
    for (const engine of engines) {
      if (browsers && (engine === 'chromium-desktop' ? desktop : pwa)) {
        const passed = await stage(`browser-${engine}`, './node_modules/.bin/playwright', ['test', '--config=playwright.legacy-qualification.config.ts', `--project=${engine}`], 17, { LEGACY_QUAL_ENGINE: engine })
        await inspect(`browser-${engine}-results-check`, () => {
          const report = JSON.parse(readFileSync(join(out, `browser/${engine}/report.json`), 'utf8'))
          const cases = browserCases(report)
          check(passed && !(report.errors?.length) && cases.length === 12 && cases.every(c => c.project === engine && c.expectedStatus === 'passed' && c.results?.length === 1 && c.results[0].status === 'passed'), `Not all 12 ${engine} cases passed once`)
        })
      } else skipped(`browser-${engine}`, 'Required production build/browser installation/inventory unavailable')
    }
  } else skipped('qualification', 'Clean dependency installation/identity failed')
} catch (error) { manifest.fatal = String(error); console.error(error) }
finally {
  await inspect('tracked-source-unchanged', () => {
    manifest.finalTrackedDiff = git('diff', '--stat')
    check(git('diff', '--name-only') === '', 'Qualification changed tracked source')
  })
  manifest.finishedAt = new Date().toISOString()
  manifest.passed = !manifest.fatal && manifest.stages.every(stage => stage.status === 'passed')
  save()
  process.exitCode = manifest.passed ? 0 : 1
}
