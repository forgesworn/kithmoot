import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const receiptPath = resolve(root, 'artwork/derivatives-v1.json')
const STATIC_OPTIONS = ['-lossless', '-q', '100', '-m', '6', '-alpha_q', '100', '-metadata', 'none', '-quiet']
const ANIMATED_OPTIONS = ['-q', '75', '-m', '4', '-mt', '-metadata', 'none', '-loop_compatibility', '-quiet']
const THUMBNAIL_SOURCES = ['600-cult-cutout', '600-facepalm', '600-moon', '600-laser']
const THUMBNAIL_SIZES = [64, 128, 256, 384]
const ANIMATION_EXPECTATIONS = new Map([
  ['coffee', { width: 512, height: 512, frameCount: 144, durationMs: 6000, loopCount: 0 }],
  ['donkey-laugh', { width: 512, height: 512, frameCount: 120, durationMs: 5000, loopCount: 0 }],
  ['donkey-facepalm', { width: 512, height: 512, frameCount: 120, durationMs: 5000, loopCount: 0 }],
  ['donkey-bitcoin', { width: 512, height: 512, frameCount: 120, durationMs: 5000, loopCount: 0 }],
])
const EXPECTED_COUNTS = { chatArtStatic: 28, chatArtAnimated: 4, emojiStatic: 163, thumbnails: 16, total: 211 }

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pathFromRoot(file) {
  return relative(root, file).split(sep).join('/')
}

function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function detail(file) {
  const bytes = readFileSync(file)
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function verifyDetail(file, expected, label) {
  const actual = detail(file)
  assert(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, `${label} does not match its pinned bytes and SHA-256.`)
}

function sameJSON(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message)
}

function parsePNG(bytes, label) {
  assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label} is not a PNG.`)
  assert(bytes.toString('ascii', 12, 16) === 'IHDR', `${label} has no leading IHDR.`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function skipSubBlocks(bytes, start, label) {
  let offset = start
  for (;;) {
    assert(offset < bytes.length, `${label} has a truncated data sub-block.`)
    const length = bytes[offset++]
    if (length === 0) return offset
    offset += length
    assert(offset <= bytes.length, `${label} has a truncated data sub-block.`)
  }
}

function parseGIF(bytes, label) {
  assert(bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')), `${label} is not a GIF.`)
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8)
  let offset = 13
  if (bytes[10] & 0x80) offset += 3 * 2 ** ((bytes[10] & 7) + 1)
  const frameDurationsMs = []
  let delayMs = 0, loopCount = null
  for (;;) {
    assert(offset < bytes.length, `${label} has no GIF trailer.`)
    const marker = bytes[offset++]
    if (marker === 0x3b) break
    if (marker === 0x2c) {
      assert(offset + 9 <= bytes.length, `${label} has a truncated image descriptor.`)
      const packed = bytes[offset + 8]
      offset += 9
      if (packed & 0x80) offset += 3 * 2 ** ((packed & 7) + 1)
      assert(offset < bytes.length, `${label} has truncated image data.`)
      offset = skipSubBlocks(bytes, offset + 1, label)
      frameDurationsMs.push(delayMs)
      delayMs = 0
      continue
    }
    assert(marker === 0x21, `${label} contains an unknown GIF block.`)
    assert(offset < bytes.length, `${label} has a truncated extension.`)
    const extension = bytes[offset++]
    if (extension === 0xf9) {
      assert(offset + 6 <= bytes.length && bytes[offset] === 4 && bytes[offset + 5] === 0, `${label} has an invalid graphics control extension.`)
      delayMs = bytes.readUInt16LE(offset + 2) * 10
      offset += 6
      continue
    }
    assert(offset < bytes.length, `${label} has a truncated extension header.`)
    const headerLength = bytes[offset++]
    assert(offset + headerLength <= bytes.length, `${label} has a truncated extension header.`)
    const application = bytes.toString('ascii', offset, offset + headerLength)
    offset += headerLength
    if ((application === 'NETSCAPE2.0' || application === 'ANIMEXTS1.0') && bytes[offset] >= 3 && bytes[offset + 1] === 1) {
      loopCount = bytes.readUInt16LE(offset + 2)
    }
    offset = skipSubBlocks(bytes, offset, label)
  }
  return {
    width, height, frameCount: frameDurationsMs.length,
    durationMs: frameDurationsMs.reduce((sum, value) => sum + value, 0),
    loopCount, frameDurationsMs,
  }
}

function uint24(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16
}

function parseWebP(bytes, label) {
  assert(bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP', `${label} is not RIFF/WebP.`)
  assert(bytes.readUInt32LE(4) + 8 === bytes.length, `${label} has an inconsistent RIFF length.`)
  const chunks = []
  let offset = 12, width, height, vp8xAnimation = false, loopCount
  const frameDurationsMs = []
  while (offset < bytes.length) {
    assert(offset + 8 <= bytes.length, `${label} has a truncated chunk header.`)
    const fourCC = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8, end = start + length
    assert(end <= bytes.length, `${label} has a truncated ${fourCC} chunk.`)
    chunks.push(fourCC)
    if (fourCC === 'VP8X') {
      assert(length === 10, `${label} has an invalid VP8X chunk.`)
      vp8xAnimation = Boolean(bytes[start] & 0x02)
      width = uint24(bytes, start + 4) + 1
      height = uint24(bytes, start + 7) + 1
    } else if (fourCC === 'VP8L') {
      assert(length >= 5 && bytes[start] === 0x2f, `${label} has an invalid VP8L chunk.`)
      const bits = bytes.readUInt32LE(start + 1)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    } else if (fourCC === 'VP8 ') {
      assert(length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a, `${label} has an invalid VP8 chunk.`)
      width = bytes.readUInt16LE(start + 6) & 0x3fff
      height = bytes.readUInt16LE(start + 8) & 0x3fff
    } else if (fourCC === 'ANIM') {
      assert(length === 6, `${label} has an invalid ANIM chunk.`)
      loopCount = bytes.readUInt16LE(start + 4)
    } else if (fourCC === 'ANMF') {
      assert(length >= 16, `${label} has an invalid ANMF chunk.`)
      frameDurationsMs.push(uint24(bytes, start + 12))
    }
    offset = end + (length % 2)
  }
  assert(offset === bytes.length, `${label} has invalid chunk padding.`)
  assert(Number.isInteger(width) && Number.isInteger(height), `${label} has no canvas dimensions.`)
  const animated = chunks.includes('ANIM') || chunks.includes('ANMF') || vp8xAnimation
  const images = chunks.filter(chunk => chunk === 'VP8 ' || chunk === 'VP8L').length
  if (animated) {
    assert(vp8xAnimation && chunks.filter(chunk => chunk === 'ANIM').length === 1 && frameDurationsMs.length > 0 && images === 0, `${label} has inconsistent animation chunks.`)
  } else {
    assert(images === 1 && !chunks.includes('ANMF'), `${label} has inconsistent static chunks.`)
  }
  return {
    width, height, animated, loopCount, chunks,
    frameCount: frameDurationsMs.length,
    durationMs: frameDurationsMs.reduce((sum, value) => sum + value, 0),
    frameDurationsMs,
  }
}

function animationDetails(info) {
  return {
    frameCount: info.frameCount,
    durationMs: info.durationMs,
    loopCount: info.loopCount,
    frameDurationsMs: info.frameDurationsMs,
  }
}

function loadModel() {
  const chat = readJSON(resolve(root, 'app/public/chat-art/catalogue.json'))
  const emoji = readJSON(resolve(root, 'app/public/emoji/manifest.json'))
  const tasks = [], originalPublic = []
  const add = (category, collection, source, output, extra = {}) => {
    tasks.push({ category, collection, source, output, encoder: category === 'animated' ? 'gif2webp' : 'cwebp', ...extra })
  }
  for (const art of chat) {
    const source = resolve(root, `app/public/chat-art/${art.slug}.png`)
    add('static', 'chat-art', source, resolve(root, `app/public/chat-art/${art.slug}.webp`))
    originalPublic.push(source, resolve(root, `app/public/chat-art/${art.slug}.gif`))
    if (art.slug === 'coffee') {
      const preview = resolve(root, `app/public/chat-art/${art.animationPreview}`)
      add('static', 'chat-art', preview, resolve(root, 'app/public/chat-art/coffee-animation.webp'))
      originalPublic.push(preview)
    }
    if (art.animated) {
      add('animated', 'chat-art', resolve(root, `app/public/chat-art/${art.slug}.gif`), resolve(root, `app/public/chat-art/${art.slug}.animated.webp`), {
        slug: art.slug,
        expectedAnimation: ANIMATION_EXPECTATIONS.get(art.slug),
      })
    }
  }
  for (const artwork of emoji.artwork) {
    const name = basename(artwork.file, '.png')
    const source = resolve(root, `app/public/emoji/${name}.png`)
    add('static', 'emoji', source, resolve(root, `app/public/emoji/${name}.webp`), { manifest: artwork })
    originalPublic.push(source)
  }
  for (const name of THUMBNAIL_SOURCES) for (const size of THUMBNAIL_SIZES) {
    add('thumbnail', '600', resolve(root, `app/src/assets/600-original/${name}.png`), resolve(root, `app/src/assets/600-original/${name}-${size}.webp`), { size })
  }
  const counts = {
    chatArtStatic: tasks.filter(task => task.category === 'static' && task.collection === 'chat-art').length,
    chatArtAnimated: tasks.filter(task => task.category === 'animated').length,
    emojiStatic: tasks.filter(task => task.category === 'static' && task.collection === 'emoji').length,
    thumbnails: tasks.filter(task => task.category === 'thumbnail').length,
    total: tasks.length,
  }
  sameJSON(counts, EXPECTED_COUNTS, 'The active artwork derivative set has changed without a reviewed generator update.')
  return { chat, emoji, tasks, originalPublic, counts }
}

function validateOriginals(model) {
  for (const art of model.chat) for (const kind of ['png', 'gif']) {
    verifyDetail(resolve(root, `app/public/chat-art/${art.slug}.${kind}`), art[kind], `chat-art/${art.slug}.${kind}`)
  }
  for (const task of model.tasks) if (task.collection === 'emoji') verifyDetail(task.source, task.manifest, pathFromRoot(task.source))
}

function sourceInfo(task) {
  const bytes = readFileSync(task.source)
  if (task.category === 'animated') return parseGIF(bytes, pathFromRoot(task.source))
  return parsePNG(bytes, pathFromRoot(task.source))
}

function expectedDimensions(task, source) {
  if (task.category === 'thumbnail') return { width: task.size, height: task.size }
  return { width: source.width, height: source.height }
}

function taskOptions(task) {
  if (task.category === 'animated') return ANIMATED_OPTIONS
  if (task.category === 'thumbnail') return [...STATIC_OPTIONS.slice(0, -1), '-resize', String(task.size), String(task.size), '-quiet']
  return STATIC_OPTIONS
}

function validateAnimation(task, source, output, label) {
  const expected = task.expectedAnimation
  assert(expected, `${label} is not a reviewed picker-active animation.`)
  for (const key of ['width', 'height', 'frameCount', 'durationMs', 'loopCount']) {
    assert(source[key] === expected[key], `${label} source ${key} is ${source[key]}, expected ${expected[key]}.`)
    assert(output[key] === expected[key], `${label} output ${key} is ${output[key]}, expected ${expected[key]}.`)
  }
  sameJSON(output.frameDurationsMs, source.frameDurationsMs, `${label} changed animation frame timing.`)
}

function validateDerivative(task, source, outputBytes, label) {
  const output = parseWebP(outputBytes, label)
  const dimensions = expectedDimensions(task, source)
  assert(output.width === dimensions.width && output.height === dimensions.height, `${label} dimensions do not match its source or thumbnail size.`)
  assert(output.animated === (task.category === 'animated'), `${label} has the wrong static/animated WebP form.`)
  if (task.category === 'animated') validateAnimation(task, source, output, label)
  return output
}

function calculateTotals(entries) {
  const empty = () => ({ files: 0, sourceBytes: 0, derivativeBytes: 0 })
  const totals = { static: empty(), animated: empty(), thumbnail: empty(), overall: empty() }
  for (const entry of entries) for (const key of [entry.category, 'overall']) {
    totals[key].files++
    totals[key].sourceBytes += entry.source.bytes
    totals[key].derivativeBytes += entry.output.bytes
  }
  return totals
}

function checkUnexpectedFiles(tasks) {
  for (const directory of ['app/public/chat-art', 'app/public/emoji', 'app/src/assets/600-original']) {
    const absolute = resolve(root, directory)
    const expected = new Set(tasks.map(task => pathFromRoot(task.output)).filter(path => path.startsWith(`${directory}/`)).map(path => basename(path)))
    const actual = readdirSync(absolute, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.webp')).map(entry => entry.name)
    for (const name of actual) assert(expected.has(name), `Unexpected artwork derivative: ${directory}/${name}`)
    for (const name of expected) assert(actual.includes(name), `Missing artwork derivative: ${directory}/${name}`)
  }
}

function validateProbe(probe, source, label) {
  const stream = probe?.streams?.[0]
  assert(stream && Number(stream.width) === source.width && Number(stream.height) === source.height, `${label} FFprobe dimensions do not match the source.`)
  assert(Number(stream.nb_read_frames) === source.frameCount, `${label} FFprobe frame count does not match the source.`)
  assert(Math.round(Number(probe.format?.duration) * 1000) === source.durationMs, `${label} FFprobe duration does not match the source.`)
}

function checkSource(quiet = false) {
  const model = loadModel()
  validateOriginals(model)
  const receipt = readJSON(receiptPath)
  assert(receipt.version === 1, 'Unsupported artwork derivative receipt version.')
  sameJSON(receipt.counts, EXPECTED_COUNTS, 'Artwork derivative receipt counts are stale.')
  assert(receipt.tools?.cwebp?.version && receipt.tools?.gif2webp?.version && receipt.tools?.ffprobe?.version, 'Artwork derivative receipt does not record tool versions.')
  assert(Array.isArray(receipt.outputs) && receipt.outputs.length === model.tasks.length, 'Artwork derivative receipt has the wrong output count.')
  const expectedByOutput = new Map(model.tasks.map(task => [pathFromRoot(task.output), task]))
  const receiptByOutput = new Map()
  for (const entry of receipt.outputs) {
    assert(entry?.output?.path && !receiptByOutput.has(entry.output.path), `Duplicate receipt output: ${entry?.output?.path}`)
    receiptByOutput.set(entry.output.path, entry)
    assert(expectedByOutput.has(entry.output.path), `Unexpected receipt output: ${entry.output.path}`)
  }
  checkUnexpectedFiles(model.tasks)
  for (const task of model.tasks) {
    const outputPath = pathFromRoot(task.output)
    const entry = receiptByOutput.get(outputPath)
    assert(entry, `Receipt is missing ${outputPath}.`)
    assert(entry.category === task.category && entry.source?.path === pathFromRoot(task.source), `Receipt source or category is stale for ${outputPath}.`)
    assert(entry.encoder?.name === task.encoder, `Receipt encoder is stale for ${outputPath}.`)
    sameJSON(entry.encoder.options, taskOptions(task), `Receipt encoder options are stale for ${outputPath}.`)
    verifyDetail(task.source, entry.source, entry.source.path)
    verifyDetail(task.output, entry.output, outputPath)
    assert(entry.output.bytes < entry.source.bytes, `${outputPath} is not smaller than its source; regenerate or record a reviewed exception.`)
    const source = sourceInfo(task)
    const output = validateDerivative(task, source, readFileSync(task.output), outputPath)
    assert(entry.width === output.width && entry.height === output.height, `Receipt dimensions are stale for ${outputPath}.`)
    if (task.category === 'animated') {
      sameJSON(entry.animation?.source, animationDetails(source), `Receipt source animation metadata is stale for ${outputPath}.`)
      const outputAnimation = animationDetails(output)
      const { source: _source, ffprobe, ...recordedAnimation } = entry.animation
      sameJSON(recordedAnimation, outputAnimation, `Receipt output animation metadata is stale for ${outputPath}.`)
      validateProbe(ffprobe?.source, source, outputPath)
      assert(ffprobe?.output && typeof ffprobe.output === 'object', `Receipt has no output FFprobe result for ${outputPath}.`)
    } else {
      assert(entry.animation === undefined, `Static receipt entry has animation metadata: ${outputPath}.`)
    }
  }
  sameJSON(receipt.totals, calculateTotals(receipt.outputs), 'Artwork derivative receipt totals are stale.')
  assert(receipt.totals.overall.derivativeBytes < receipt.totals.overall.sourceBytes, 'Derivatives are not smaller overall than their sources.')
  if (!quiet) {
    const totals = receipt.totals.overall
    console.log(`Verified ${model.counts.total} derivatives: ${model.counts.chatArtStatic} chat-art stills, ${model.counts.chatArtAnimated} animations, ${model.counts.emojiStatic} emoji, ${model.counts.thumbnails} thumbnails.`)
    console.log(`Derivative bytes: ${totals.derivativeBytes} (${(totals.derivativeBytes / 1048576).toFixed(3)} MiB), down from ${totals.sourceBytes} corresponding source bytes (${(totals.sourceBytes / 1048576).toFixed(3)} MiB).`)
  }
  return { model, receipt }
}

function toolVersion(tool) {
  const result = spawnSync(tool, ['-version'], { encoding: 'utf8' })
  assert(result.status === 0, `${tool} is required to regenerate artwork derivatives: ${result.error?.message ?? result.stderr}`)
  const output = `${result.stdout}${result.stderr}`.trim()
  return tool === 'ffprobe' ? output.split('\n')[0] : output
}

function probe(file) {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,r_frame_rate,avg_frame_rate,duration:format=duration,size', '-of', 'json', file]
  const result = spawnSync('ffprobe', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  assert(result.status === 0, `FFprobe could not qualify ${pathFromRoot(file)}: ${result.error?.message ?? result.stderr}`)
  return JSON.parse(result.stdout)
}

function encode(task) {
  const temporary = `${task.output}.${process.pid}.tmp.webp`
  rmSync(temporary, { force: true })
  mkdirSync(dirname(task.output), { recursive: true })
  try {
    const options = taskOptions(task)
    const result = spawnSync(task.encoder, [...options, task.source, '-o', temporary], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    assert(result.status === 0, `${task.encoder} failed for ${pathFromRoot(task.source)}: ${result.error?.message ?? result.stderr}`)
    const source = sourceInfo(task)
    const outputBytes = readFileSync(temporary)
    const output = validateDerivative(task, source, outputBytes, pathFromRoot(task.output))
    assert(outputBytes.length < readFileSync(task.source).length, `${pathFromRoot(task.output)} is not smaller than its source.`)
    const sourceDetail = detail(task.source), outputDetail = detail(temporary)
    const entry = {
      category: task.category,
      source: { path: pathFromRoot(task.source), ...sourceDetail },
      output: { path: pathFromRoot(task.output), ...outputDetail },
      encoder: { name: task.encoder, options },
      width: output.width,
      height: output.height,
    }
    if (task.category === 'animated') {
      entry.animation = {
        ...animationDetails(output),
        source: animationDetails(source),
        ffprobe: { source: probe(task.source), output: probe(temporary) },
      }
      validateProbe(entry.animation.ffprobe.source, source, entry.output.path)
    }
    renameSync(temporary, task.output)
    return entry
  } finally {
    rmSync(temporary, { force: true })
  }
}

function generate() {
  const model = loadModel()
  validateOriginals(model)
  const tools = {
    cwebp: { version: toolVersion('cwebp') },
    gif2webp: { version: toolVersion('gif2webp') },
    ffprobe: { version: toolVersion('ffprobe'), qualification: 'generation only; routine checks parse PNG, GIF and RIFF/WebP directly' },
  }
  const outputs = []
  for (const [index, task] of model.tasks.entries()) {
    outputs.push(encode(task))
    if ((index + 1) % 20 === 0 || index + 1 === model.tasks.length) console.log(`Generated ${index + 1}/${model.tasks.length} derivatives.`)
  }
  const receipt = {
    version: 1,
    generator: 'scripts/build-artwork-derivatives.mjs',
    counts: model.counts,
    tools,
    encoding: {
      static: 'lossless RGBA-capable WebP; no metadata',
      animated: 'gif2webp standard lossless compression; source frame timing and infinite looping preserved; no lossy, mixed or optional key-frame search mode',
      thumbnail: 'one libwebp resizer pass from the 1024px source, then lossless WebP; no lossy chroma conversion',
    },
    outputs,
    totals: calculateTotals(outputs),
  }
  mkdirSync(dirname(receiptPath), { recursive: true })
  const temporary = `${receiptPath}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`)
  renameSync(temporary, receiptPath)
  checkSource()
}

function allFiles(directory, base = directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...allFiles(file, base))
    else if (entry.isFile()) files.push(file)
  }
  return files
}

function builtRelative(file, builtRoot) {
  return relative(builtRoot, file).split(sep).join('/')
}

function findHashedAsset(files, builtRoot, sourceName, extension, expected) {
  const prefix = `assets/${sourceName}-`
  const matches = files.filter(file => {
    const path = builtRelative(file, builtRoot)
    return path.startsWith(prefix) && path.endsWith(`.${extension}`) && !path.slice(prefix.length, -extension.length - 1).includes('/')
  })
  assert(matches.length === 1, `Expected one hashed built asset for ${sourceName}.${extension}; found ${matches.length}.`)
  verifyDetail(matches[0], expected, builtRelative(matches[0], builtRoot))
  return builtRelative(matches[0], builtRoot)
}

function precacheManifest(sw) {
  const call = sw.indexOf('.precacheAndRoute(')
  assert(call >= 0, 'The PWA service worker has no readable precache manifest.')
  let start = -1, end = -1, depth = 0, quote = false, escape = false
  for (let index = call; index < sw.length; index += 1) {
    const char = sw[index]
    if (quote) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') quote = false
      continue
    }
    if (char === '"') { quote = true; continue }
    if (char === '[') { if (depth === 0) start = index; depth += 1; continue }
    if (char === ']' && --depth === 0) { end = index + 1; break }
  }
  assert(start >= 0 && end > start, 'The PWA service worker has no readable precache manifest.')
  const urls = [...sw.slice(start, end).matchAll(/\{url:"([^"]+)",revision:/g)].map(match => match[1])
  assert(urls.length > 0, 'The PWA precache manifest has no entries.')
  return urls.map(entry => {
    const url = new URL(entry, 'https://built.invalid/j/')
    assert(url.origin === 'https://built.invalid' && url.pathname.startsWith('/j/'), `Unexpected precache URL: ${entry}`)
    return decodeURIComponent(url.pathname.slice(3))
  })
}

function checkBuilt() {
  const desktop = process.env.VITE_DESKTOP === 'true'
  const builtRoot = resolve(root, desktop ? 'desktop/web' : 'app/dist')
  const { model, receipt } = checkSource(true)
  const files = allFiles(builtRoot)
  const builtByPath = new Map(files.map(file => [builtRelative(file, builtRoot), file]))
  for (const source of model.originalPublic) {
    const deployed = resolve(builtRoot, relative(resolve(root, 'app/public'), source))
    verifyDetail(deployed, detail(source), `deployed ${pathFromRoot(source)}`)
  }
  const requiredPrecache = new Set()
  let deployedDerivativeBytes = 0
  for (const entry of receipt.outputs) {
    let deployedPath
    if (entry.output.path.startsWith('app/public/')) {
      deployedPath = entry.output.path.slice('app/public/'.length)
      const deployed = resolve(builtRoot, deployedPath)
      verifyDetail(deployed, entry.output, `deployed ${entry.output.path}`)
    } else {
      const sourceName = basename(entry.output.path, '.webp')
      deployedPath = findHashedAsset(files, builtRoot, sourceName, 'webp', entry.output)
    }
    deployedDerivativeBytes += entry.output.bytes
    requiredPrecache.add(deployedPath)
  }
  let original600Bytes = 0
  for (const name of THUMBNAIL_SOURCES) {
    const source = resolve(root, `app/src/assets/600-original/${name}.png`)
    findHashedAsset(files, builtRoot, name, 'png', detail(source))
    original600Bytes += statSync(source).size
  }
  const deployedOriginalBytes = model.originalPublic.reduce((sum, file) => sum + statSync(file).size, 0) + original600Bytes
  const deployedArtworkBytes = deployedOriginalBytes + deployedDerivativeBytes
  const deployedArtifactBytes = files.reduce((sum, file) => sum + statSync(file).size, 0)
  console.log(`Verified ${desktop ? 'desktop/web' : 'app/dist'}: all originals and ${receipt.outputs.length} derivatives are deployed byte-for-byte.`)
  console.log(`Deployed artwork: ${deployedArtworkBytes} bytes (${(deployedArtworkBytes / 1048576).toFixed(3)} MiB): ${deployedOriginalBytes} original + ${deployedDerivativeBytes} derivative. Deployed artifact total: ${deployedArtifactBytes} bytes (${(deployedArtifactBytes / 1048576).toFixed(3)} MiB).`)
  if (desktop) {
    console.log('Desktop audit complete; no PWA precache manifest is required.')
    return
  }
  const swPath = resolve(builtRoot, 'sw.js')
  const sw = readFileSync(swPath, 'utf8')
  verifyDetail(resolve(builtRoot, 'original-artwork-sw.js'), detail(resolve(root, 'app/public/original-artwork-sw.js')), 'deployed original-artwork-sw.js')
  assert(sw.includes('"original-artwork-sw.js"') || sw.includes("'original-artwork-sw.js'"), 'The service worker does not import original-artwork-sw.js.')
  assert(sw.includes('kithmoot-original-artwork-v1'), 'The service worker has no original-artwork runtime route.')
  const manifest = precacheManifest(sw)
  assert(new Set(manifest).size === manifest.length, 'The PWA precache contains duplicate URLs.')
  for (const path of manifest) {
    assert(!/^(?:chat-art|emoji)\/[^/]+\.(?:png|gif)$/.test(path), `Original artwork is incorrectly in the fresh precache: ${path}`)
    assert(path !== 'original-artwork-sw.js', 'The migration script must be imported, not precached.')
  }
  for (const path of requiredPrecache) assert(manifest.includes(path), `Required derivative is not precached: ${path}`)
  let precacheBytes = 0, artworkPrecacheBytes = 0
  for (const path of manifest) {
    const file = builtByPath.get(path)
    assert(file, `Precached file is missing from the build: ${path}`)
    const bytes = statSync(file).size
    precacheBytes += bytes
    if (requiredPrecache.has(path)) artworkPrecacheBytes += bytes
  }
  assert(artworkPrecacheBytes === deployedDerivativeBytes, 'Precache artwork bytes do not include every derivative exactly once.')
  console.log(`Fresh precache: ${precacheBytes} bytes (${(precacheBytes / 1048576).toFixed(3)} MiB) across ${manifest.length} entries; artwork derivatives: ${artworkPrecacheBytes} bytes (${(artworkPrecacheBytes / 1048576).toFixed(3)} MiB).`)
}

const args = process.argv.slice(2)
if (args.length === 0) generate()
else if (args.length === 1 && args[0] === '--check') checkSource()
else if (args.length === 1 && args[0] === '--check-built') checkBuilt()
else throw new Error('Usage: node scripts/build-artwork-derivatives.mjs [--check|--check-built]')
