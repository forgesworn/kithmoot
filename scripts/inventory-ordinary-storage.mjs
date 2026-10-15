#!/usr/bin/env node
// Audit source storage consumers, including dynamically constructed keys.
// This does not establish runtime completeness or authorise migration.
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = process.argv[2]
if (!output || process.argv.length !== 3) throw new Error('Usage: node scripts/inventory-ordinary-storage.mjs <output.json>')
const configPath = resolve(root, 'app/tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
if (parsed.errors.length) throw new Error('Cannot read application TypeScript configuration')
const program = ts.createProgram(parsed.fileNames, parsed.options)
const checker = program.getTypeChecker()
const sites = [], files = {}
const storageMethods = new Set(['getItem', 'setItem', 'removeItem', 'clear', 'key'])
const deviceMethods = new Set(['get', 'set', 'remove', 'keys'])
const namespace = /^(?:kithmoot[.:-]|signet:login\.)/

for (const source of program.getSourceFiles()) {
  const path = relative(root, resolve(source.fileName)).replaceAll('\\', '/')
  if (!path.startsWith('app/src/') || source.isDeclarationFile || path.endsWith('.test.ts')) continue
  const literals = new Set(), calls = []
  const visit = node => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && namespace.test(node.text)) literals.add(node.text)
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const access = node.expression
      const method = ts.isPropertyAccessExpression(access) ? access.name.text
        : access.argumentExpression && ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : '[dynamic]'
      const type = checker.getTypeAtLocation(access.expression)
      const types = type.isUnion() ? type.types : [type]
      const shapes = types.map(value => new Set(value.getProperties().map(property => property.name)))
      const storage = shapes.some(props => props.has('getItem') || props.has('setItem') || props.has('removeItem'))
      const device = shapes.some(props => ['get', 'set', 'remove', 'keys'].every(name => props.has(name)))
      // Report these separately, rather than treating unresolved typing as
      // proof that a syntactically apparent Storage call cannot retain data.
      const apparent = ['getItem', 'setItem', 'removeItem'].includes(method)
      if ((storage && (storageMethods.has(method) || method === '[dynamic]')) ||
          (device && (deviceMethods.has(method) || method === '[dynamic]')) || apparent) {
        calls.push({ file: path, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          receiver: access.expression.getText(source), receiverType: checker.typeToString(type), method,
          keyExpression: node.arguments[0]?.getText(source) ?? null,
          classification: storage ? 'Storage-shaped' : device ? 'DeviceStore-shaped' : 'unresolved-storage-call' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (calls.length || literals.size) {
    files[path] = { sha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
      namespaceLiterals: [...literals].sort() }
    sites.push(...calls)
  }
}
// These independently loaded/raw roots must not disappear because of path
// normalisation, alias inference or an incomplete TypeScript input graph.
for (const path of ['app/src/main.ts', 'app/src/text-size.ts', 'app/src/channel-checks.ts']) {
  if (!sites.some(site => site.file === path)) throw new Error(`Missing known storage consumer: ${path}`)
}
sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
const report = { checkedAt: new Date().toISOString(), root,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  kind: 'Typed and syntactically apparent application storage call sites; source audit only',
  limitations: ['Key expressions still require producer/namespace classification',
    'Detached/bound methods, arbitrary runtime aliases, external SDK internals and browser/desktop clients require separate audit',
    'A complete source list does not establish protected runtime custody or migration acceptance'],
  files, sites, productionWired: false, runtimeInventoryComplete: false, goalComplete: false }
writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n')
console.log(`${sites.length} storage call sites in ${Object.keys(files).length} source files; report: ${resolve(output)}`)
