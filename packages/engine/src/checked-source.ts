/** Private construction of the TypeScript context shared by lowering and semantic authoring projections. */
import * as ts from 'typescript';

export interface CheckedSource {
  readonly file: ts.SourceFile;
  readonly checker: ts.TypeChecker;
}

/**
 * Creates the no-ambient TypeScript program used to resolve source-local symbols and materialize checked types.
 *
 * SafeScript performs its own closed language and host-contract validation. This TypeScript program deliberately has
 * no library or module resolution authority; it supplies syntax ownership, symbols, and type relationships only.
 *
 * @internal
 */
export function createCheckedSource(source: string): CheckedSource {
  const fileName = '/safescript-entry.ts';
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === fileName,
    readFile: (candidate) => (candidate === fileName ? source : undefined),
    getSourceFile: (candidate) =>
      candidate === fileName
        ? ts.createSourceFile(candidate, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
        : undefined,
    getDefaultLibFileName: () => 'safescript:no-ambient-lib',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    getCanonicalFileName: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true, strict: true, noEmit: true }, host);
  const file = program.getSourceFile(fileName);
  if (!file) throw new Error('SafeScript checker did not retain its in-memory entry source');
  const checker = program.getTypeChecker();
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) || ts.isTypeNode(node)) checker.getTypeAtLocation(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return Object.freeze({ file, checker });
}
