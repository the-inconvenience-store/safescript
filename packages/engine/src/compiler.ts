/**
 * Restricted TypeScript parsing, validation, and lowering for the SafeScript subset.
 * @packageDocumentation
 */
import * as ts from 'typescript';

import {
  type ContractRegistry,
  type CompilerDiagnosticCode,
  type ModuleId,
  type SlotDefinition,
} from '@safescript/contracts';

import { compileStructuredProgram } from './structured-compiler.js';
import type { StructuredProgram } from './structured-ir.js';
import { Utf8SourceIndex } from './source-offsets.js';

/**
 * Stable private failure lowered to a public machine-readable diagnostic by the bridge.
 * @internal
 */
export interface CompileFailure {
  readonly code: CompilerDiagnosticCode;
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

function utf8Failure(failure: CompileFailure, offsets: Utf8SourceIndex): CompileFailure {
  return Object.freeze({ ...failure, ...offsets.span(failure.start, failure.end) });
}

/**
 * Restricted compiler success with verified IR, or one bounded source failure.
 * @internal
 */
export type CompileProgramResult =
  | Readonly<{
      ok: true;
      program: StructuredProgram;
      handler: string;
      syntaxNodes: number;
      syntaxDepth: number;
      imports: number;
      declarations: number;
    }>
  | Readonly<{
      ok: false;
      failure: CompileFailure;
      syntaxNodes: number;
      syntaxDepth: number;
      imports: number;
      declarations: number;
    }>;

function countSyntax(sourceFile: ts.SourceFile): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const visit = (node: ts.Node, currentDepth: number): void => {
    nodes++;
    depth = Math.max(depth, currentDepth);
    ts.forEachChild(node, (child) => visit(child, currentDepth + 1));
  };
  visit(sourceFile, 1);
  return { nodes, depth };
}

/** Measures source-only compiler ceilings before type analysis or lowering. @internal */
export function measureCompilerSource(source: string): Readonly<{ typeDepth: number; derivedTemplateBytes: number }> {
  const sourceFile = ts.createSourceFile('limits.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let typeDepth = 0;
  let derivedTemplateBytes = 0;
  const encoder = new TextEncoder();
  const visit = (node: ts.Node, currentTypeDepth: number): void => {
    const nextTypeDepth = ts.isTypeNode(node) ? currentTypeDepth + 1 : currentTypeDepth;
    typeDepth = Math.max(typeDepth, nextTypeDepth);
    if (ts.isNoSubstitutionTemplateLiteral(node))
      derivedTemplateBytes = Math.max(derivedTemplateBytes, encoder.encode(node.text).length);
    else if (ts.isTemplateExpression(node)) {
      const literalBytes =
        encoder.encode(node.head.text).length +
        node.templateSpans.reduce((total, span) => total + encoder.encode(span.literal.text).length, 0);
      derivedTemplateBytes = Math.max(derivedTemplateBytes, literalBytes);
    }
    ts.forEachChild(node, (child) => visit(child, nextTypeDepth));
  };
  visit(sourceFile, 0);
  return { typeDepth, derivedTemplateBytes };
}

function validateImports(sourceFile: ts.SourceFile): CompileFailure | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const source = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
    if (source !== 'safescript:prelude' && source !== 'host:api')
      return {
        code: 'SS_AMBIENT_AUTHORITY',
        message: `unregistered import ${source}`,
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
      };
    const bindings = statement.importClause?.namedBindings;
    if (!statement.importClause)
      return {
        code: 'SS_IMPORT_FORM',
        message: 'only static named imports are accepted',
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
      };
    if (
      source === 'safescript:prelude' &&
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((item) => !['Err', 'Ok', 'Result'].includes(item.propertyName?.text ?? item.name.text))
    )
      return {
        code: 'SS_IMPORT_NAME',
        message: 'unknown SafeScript prelude import',
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
      };
  }
  return undefined;
}

/**
 * Parses one module, rejects syntax outside the current allow-list, and lowers the accepted handler to verified IR.
 *
 * @remarks TypeScript supplies syntax trees and source spans only. SafeScript-owned checks define accepted source,
 * host-operation resolution, type behavior, operation permissions, and execution semantics.
 * @internal
 */
export function compileProgram(
  source: string,
  moduleId: ModuleId,
  registry: ContractRegistry,
  slot: SlotDefinition,
): CompileProgramResult {
  const sourceFile = ts.createSourceFile(String(moduleId), source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const offsets = new Utf8SourceIndex(source);
  const syntax = countSyntax(sourceFile);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration).length;
  const declarations = sourceFile.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) ||
      ts.isVariableStatement(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement),
  ).length;
  const parseDiagnostics =
    (sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
      .parseDiagnostics ?? [];
  const parseFailure = parseDiagnostics[0];
  if (parseFailure)
    return {
      ok: false,
      failure: utf8Failure(
        {
          code: 'SS_SYNTAX',
          message: ts.flattenDiagnosticMessageText(parseFailure.messageText, '\n'),
          start: parseFailure.start,
          end: parseFailure.start + parseFailure.length,
        },
        offsets,
      ),
      syntaxNodes: syntax.nodes,
      syntaxDepth: syntax.depth,
      imports,
      declarations,
    };
  // Imports are syntax declarations only; no module loader or package resolver is ever invoked.
  const importFailure = validateImports(sourceFile);
  if (importFailure)
    return {
      ok: false,
      failure: utf8Failure(importFailure, offsets),
      syntaxNodes: syntax.nodes,
      syntaxDepth: syntax.depth,
      imports,
      declarations,
    };
  {
    const structured = compileStructuredProgram(sourceFile, moduleId, registry, slot, offsets);
    if (!structured.ok)
      return {
        ok: false,
        failure: structured.failure,
        syntaxNodes: syntax.nodes,
        syntaxDepth: syntax.depth,
        imports,
        declarations,
      };
    return {
      ok: true,
      handler: structured.handler,
      syntaxNodes: syntax.nodes,
      syntaxDepth: syntax.depth,
      imports,
      declarations,
      program: structured.program,
    };
  }
}
