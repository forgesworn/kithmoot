import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, platform, arch } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--base' || !/^[a-f0-9]{40}$/.test(args[1]))) {
  throw new Error('Usage: node test/bench-camera-mask.mjs [--base COMMIT_SHA]')
}
const baselineRevision = args[1] ?? '40a79b2e37ba7029e86b0cc813bce2ec88355ee7'
const candidatePath = fileURLToPath(new URL('../src/video-effects.ts', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'kithmoot-mask-bench-'))
let browser
try {
  const baselinePath = join(scratch, 'baseline.ts')
  writeFileSync(baselinePath, execFileSync('git', ['show', `${baselineRevision}:src/video-effects.ts`], { cwd: fileURLToPath(new URL('..', import.meta.url)) }))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  for (const [source, name] of [[baselinePath, 'maskBaseline'], [candidatePath, 'maskCandidate']]) {
    const result = await build({ entryPoints: [source], bundle: true, write: false, format: 'iife', globalName: name, target: 'es2022' })
    await page.addScriptTag({ content: result.outputFiles[0].text })
  }
  const reports = await page.evaluate(() => {
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    const reports = []
    for (const [width, height] of [[256, 256], [640, 480]]) {
      for (const shape of ['background', 'silhouette', 'enclosed-points', 'checkerboard']) {
        const pixels = width * height
        const input = new Float32Array(pixels)
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const dx = (x - width / 2) / (width * .23), dy = (y - height * .52) / (height * .42)
          input[y * width + x] = shape === 'background' ? .1
            : shape === 'silhouette' ? (dx * dx + dy * dy < 1 ? .95 : .1)
              : shape === 'checkerboard' ? ((x + y) % 2 ? .95 : .1) : .95
        }
        if (shape === 'enclosed-points' || shape === 'silhouette') {
          for (let i = 0; i < 60; i++) {
            const x = Math.floor(width * .4) + i % Math.floor(width * .15)
            const y = Math.floor(height * .35) + (i * 7) % Math.floor(height * .3)
            input[y * width + x] = .1
          }
        }
        const make = run => ({ run, data: input.slice(), visited: new Uint8Array(pixels), stack: new Int32Array(pixels) })
        const a = make(window.maskBaseline.fillMaskHoles), b = make(window.maskCandidate.fillMaskHoles)
        const step = state => { state.data.set(input); state.run(state.data, width, height, state.visited, state.stack, .55, .9, .12) }
        step(a); step(b)
        if (!new Uint8Array(a.data.buffer).every((v, i) => v === new Uint8Array(b.data.buffer)[i])) throw new Error(`Mask mismatch ${shape} ${width}x${height}`)
        for (let i = 0; i < 80; i++) { step(a); step(b) }
        const iterations = pixels > 100_000 ? 60 : 160
        const samples = { baseline: [], candidate: [] }
        for (let round = 0; round < 7; round++) {
          for (const name of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
            const state = name === 'baseline' ? a : b
            const started = performance.now()
            for (let i = 0; i < iterations; i++) step(state)
            samples[name].push((performance.now() - started) / iterations)
          }
        }
        const before = median(samples.baseline), after = median(samples.candidate)
        reports.push({ width, height, shape, byteIdentical: true, iterations, rounds: 7, baselineMedianMs: before, candidateMedianMs: after, improvementPercent: (1 - after / before) * 100, samples })
      }
    }
    return reports
  })
  const report = {
    measuredAt: new Date().toISOString(), browser: browser.version(), headless: true,
    runtime: process.version, platform: platform(), architecture: arch(), baselineRevision,
    candidateSha256: createHash('sha256').update(readFileSync(candidatePath)).digest('hex'),
    evidence: 'Isolated mask algorithm in Chromium on this Mac; synthetic masks; alternating execution order; reset-copy cost included',
    qualified: false, physicalBatteryAcceptance: false, callPipelineAcceptance: false,
    targets: { backgroundImprovementPercent: 20, worstAllowedRegressionPercent: 10 }, reports,
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}
