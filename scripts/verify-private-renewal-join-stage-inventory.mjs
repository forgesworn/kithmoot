import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

assert.equal(process.env.VENNEL_PRIVATE_JOIN_STAGE_OBSERVER, '1')
assert.equal(process.argv.length, 3)
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const title = 'trusted renewal Prepare reads fresh membership without durable or provider effects, keep=false, pointer'
function cases(suite) {
  return [...(suite.specs ?? []).flatMap(spec => spec.tests.map(test => ({
    title: spec.title, project: test.projectName, repeat: test.repeatEachIndex,
  }))), ...(suite.suites ?? []).flatMap(cases)]
}
assert.deepEqual(report.errors, [])
assert.deepEqual(cases(report), [{ title, project: 'firefox-sdk020', repeat: 0 }])
assert.equal(report.config.workers, 1)
assert.equal(report.config.forbidOnly, true)
assert.equal(report.config.maxFailures, 1)
assert.equal(report.config.fullyParallel, false)
assert.equal(report.config.projects.length, 1)
const [project] = report.config.projects
assert.equal(project.name, 'firefox-sdk020')
assert.equal(project.timeout, 30_000)
assert.equal(project.retries, 0)
assert.equal(project.repeatEach, 1)
console.log(JSON.stringify({ title, project: project.name, cases: 1, workers: 1,
  retries: 0, repeatEach: 1, testTimeoutMs: 30_000, observerEnabled: true }))
