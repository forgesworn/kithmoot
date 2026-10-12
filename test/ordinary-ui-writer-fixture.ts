import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export type WriterProvenance = { file: string; fileSha256: string; snippet: string; snippetSha256: string; substitution: string }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export function primaryModuleProvenance(file: string, substitution: string): WriterProvenance {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  return {file,fileSha256:sha(source),snippet:source,snippetSha256:sha(source),substitution}
}
function primary(file: string) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  return { source, tree: ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS) }
}
function literal(tree: ts.SourceFile, name: string): string {
  const found: ts.VariableDeclaration[] = []
  for (const s of tree.statements) if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations)
    if (ts.isIdentifier(d.name) && d.name.text === name) found.push(d)
  if (found.length !== 1 || !found[0]!.initializer || !ts.isStringLiteral(found[0]!.initializer)) throw Error('Not one primary literal: ' + name)
  return 'const ' + found[0]!.getText(tree) + ';'
}
function compile(file: string, source: string, snippet: string, globals: Record<string, unknown>, substitution: string) {
  const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const write = new Function(...Object.keys(globals), js)(...Object.values(globals)) as (...args: unknown[]) => void
  return { write, provenance: { file, fileSha256: sha(source), snippet, snippetSha256: sha(snippet), substitution } }
}

/** Exact primary set/setItem expression only. The surrounding control,
 * admission, clock, DOM, transport and error paths are deliberately not run. */
export function capturedStorageExpression(options: { file?: string; within?: string; receiver: string; key: string;
  value?: string; constants?: string[]; globals: Record<string, unknown> }) {
  const file = options.file ?? 'app/src/main.ts', { source, tree } = primary(file)
  let root: ts.Node = tree
  if (options.within) {
    const f = tree.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === options.within)
    if (f.length !== 1) throw Error('Not one primary function: ' + options.within)
    root = f[0]!
  }
  const calls: ts.CallExpression[] = []
  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ['set','setItem'].includes(n.expression.name.text) && n.expression.expression.getText(tree) === options.receiver
      && n.arguments.length === 2 && n.arguments[0]!.getText(tree) === options.key
      && (!options.value || n.arguments[1]!.getText(tree) === options.value)) calls.push(n)
    ts.forEachChild(n, visit)
  }
  visit(root)
  if (calls.length !== 1) throw Error('Not one primary storage expression: ' + options.key + ' / ' + calls.length)
  const snippet = (options.constants ?? []).map(k => literal(tree, k)).join('\n')
    + '\nreturn function capturedExpression(){' + calls[0]!.getText(tree) + ';}'
  return compile(file, source, snippet, options.globals, 'Only storage expression; surrounding controls/permission/effect paths omitted, globals explicitly injected')
}

/** Exact primary private recents read/write methods, with a synthetic known-
 * choice callback instead of the evolving real catalogue or picker DOM. */
export function capturedRecentWriter(storage: Pick<Storage, 'getItem' | 'setItem'>, known: (s: string) => { emoji: string } | undefined) {
  const file = 'app/src/chat-art-picker.ts', { source, tree } = primary(file)
  const classes = tree.statements.filter((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'ChatArtPicker')
  if (classes.length !== 1) throw Error('Not one primary picker')
  const methods = ['#recents', '#remember'].map(name => {
    const found = classes[0]!.members.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText(tree) === name)
    if (found.length !== 1) throw Error('Not one primary picker method: ' + name)
    return found[0]!.getText(tree)
  })
  const snippet = literal(tree, 'recentKey') + '\nclass CapturedPicker {\n#knownChoice(emoji: string){return known(emoji)}\n'
    + methods.join('\n') + '\nwrite(emoji: string){this.#remember(emoji)}}\nconst instance=new CapturedPicker();return instance.write.bind(instance)'
  return compile(file, source, snippet, { localStorage:storage, known }, 'Exact private recents read/write methods; synthetic known-choice callback, no picker DOM or catalogue acceptance')
}
