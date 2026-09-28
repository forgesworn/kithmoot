// Shared by `src/api-surface.test.ts` and by hand when the committed
// snapshot needs a deliberate update (`node scripts/api-surface.mjs`).
//
// Walks a TypeScript source file's top-level statements with the real
// TypeScript compiler (not a regex) and returns every name it exports:
// function/const/class/interface/type/enum declarations carrying an
// `export` modifier, named exports from an `export { a, b }` or
// `export type { a, b }` statement, and `export * from '<module>'`
// statements (recorded as `*:<module>`, since a wildcard re-export has no
// names of its own to list - see docs/plans/2026-09-28-circle-kit-extraction.md
// T0.2 in the girnel repository).
import { readFileSync } from 'node:fs'
import ts from 'typescript'

/** @param {string} filePath @returns {string[]} sorted, deduplicated export names */
export function moduleExports(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true)
  const names = new Set()

  const hasExportModifier = (node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const spec of statement.exportClause.elements) names.add(spec.name.text)
      } else if (!statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        // `export * from './x.js'` - no individual names to record.
        names.add(`*:${statement.moduleSpecifier.text}`)
      }
      continue
    }
    if (!hasExportModifier(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name) names.add(statement.name.text)
    else if (ts.isClassDeclaration(statement) && statement.name) names.add(statement.name.text)
    else if (ts.isInterfaceDeclaration(statement)) names.add(statement.name.text)
    else if (ts.isTypeAliasDeclaration(statement)) names.add(statement.name.text)
    else if (ts.isEnumDeclaration(statement)) names.add(statement.name.text)
    else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text)
      }
    }
  }
  return [...names].sort()
}
