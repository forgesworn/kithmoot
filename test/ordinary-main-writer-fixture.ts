import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const path = new URL('../app/src/main.ts', import.meta.url)
const source = readFileSync(path, 'utf8')
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)

/** Execute an exact primary main function with explicitly injected globals.
 * No surrounding main/bootstrap, controls or runtime authority is exercised.
 * Dependencies are synthetic and the extracted source/hash is inspectable. */
export function capturedMainWriter(name: string, constants: string[], globals: Record<string, unknown>): {
  write: (...args: unknown[]) => void; provenance: { fileSha256: string; snippet: string; snippetSha256: string }
} {
  const functions = tree.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
  if (functions.length !== 1) throw Error('Ambiguous primary function: ' + name)
  const declarations = constants.map(key => {
    const found: ts.VariableDeclaration[] = []
    for (const s of tree.statements) if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === key) found.push(d)
    }
    if (found.length !== 1 || !found[0]!.initializer || !ts.isStringLiteral(found[0]!.initializer)) throw Error('Not one literal primary constant: ' + key)
    return 'const ' + found[0]!.getText(tree) + ';'
  })
  const snippet = declarations.join('\n') + '\n' + functions[0]!.getText(tree)
  const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const write = new Function(...Object.keys(globals), js + '\nreturn ' + name)(...Object.values(globals)) as (...args: unknown[]) => void
  return { write, provenance: { fileSha256: createHash('sha256').update(source).digest('hex'), snippet,
    snippetSha256: createHash('sha256').update(snippet).digest('hex') } }
}
