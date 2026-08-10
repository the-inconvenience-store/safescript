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

import { type IrProgram } from './ir.js';
import { compileStructuredProgram } from './structured-compiler.js';

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

/**
 * Restricted compiler success with verified IR, or one bounded source failure.
 * @internal
 */
export type CompileProgramResult =
  | Readonly<{
      ok: true;
      program: IrProgram;
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function validateImports(sourceFile: ts.SourceFile, registered = new Set<string>()): CompileFailure | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const source = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
    if (source !== 'safescript:prelude' && source !== 'host:api' && !registered.has(source))
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

/** Compiles a complete registered 1.1 module map without consulting ambient resolution. */
export function compileProgramModules(
  modules: readonly Readonly<{ id: ModuleId; source: string }>[],
  entry: ModuleId,
  registry: ContractRegistry,
  slot: SlotDefinition,
): CompileProgramResult {
  const registered = new Set(modules.map((module) => String(module.id)));
  const parsed = modules.map((module) => ({
    ...module,
    file: ts.createSourceFile(String(module.id), module.source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS),
  }));
  for (const module of parsed) {
    const invalid = validateImports(module.file, registered);
    if (invalid) return { ok: false, failure: invalid, syntaxNodes: 0, syntaxDepth: 0, imports: 0, declarations: 0 };
  }
  const defaultNames = new Map<string, string>();
  for (const module of parsed) {
    const declaration = module.file.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword) && !!statement.name,
    );
    if (declaration?.name) defaultNames.set(String(module.id), declaration.name.text);
  }
  let imports = 0;
  const parts: string[] = [];
  for (const module of parsed) {
    const aliases = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of module.file.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      imports++;
      const source = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
      if (statement.importClause?.name) {
        const target = defaultNames.get(source);
        if (target) aliases.set(statement.importClause.name.text, target);
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          aliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
    for (const statement of module.file.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) continue;
      let text = statement.getText(module.file);
      if (module.id !== entry) text = text.replace(/^export\s+(?:default\s+)?/, '');
      for (const namespace of namespaces)
        text = text.replace(new RegExp(`\\b${namespace.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\.`, 'g'), '');
      for (const [local, imported] of aliases)
        if (local !== imported)
          text = text.replace(new RegExp(`\\b${local.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'g'), imported);
      parts.push(text);
    }
  }
  const result = compileProgram(parts.join('\n\n'), entry, registry, slot);
  return result.ok ? { ...result, imports } : { ...result, imports };
}

/**
 * Parses one module, rejects syntax outside the current allow-list, and lowers the accepted handler to verified IR.
 *
 * @remarks TypeScript supplies syntax trees and source spans only. SafeScript-owned checks define accepted source,
 * host-operation resolution, type behavior, effects, capabilities, and execution semantics.
 * @internal
 */
export function compileProgram(
  source: string,
  moduleId: ModuleId,
  registry: ContractRegistry,
  slot: SlotDefinition,
): CompileProgramResult {
  const sourceFile = ts.createSourceFile(String(moduleId), source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
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
      failure: {
        code: 'SS_SYNTAX',
        message: ts.flattenDiagnosticMessageText(parseFailure.messageText, '\n'),
        start: parseFailure.start,
        end: parseFailure.start + parseFailure.length,
      },
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
      failure: importFailure,
      syntaxNodes: syntax.nodes,
      syntaxDepth: syntax.depth,
      imports,
      declarations,
    };
  {
    const structured = compileStructuredProgram(sourceFile, moduleId, registry, slot);
    if (!structured.ok)
      return {
        ok: false,
        failure: structured.failure,
        syntaxNodes: syntax.nodes,
        syntaxDepth: syntax.depth,
        imports,
        declarations,
      };
    const inputType = { kind: 'ref' as const, type: slot.input };
    const resultType = { kind: 'ref' as const, type: slot.output };
    const input = 'r0:input';
    return {
      ok: true,
      handler: structured.handler,
      syntaxNodes: syntax.nodes,
      syntaxDepth: syntax.depth,
      imports,
      declarations,
      program: Object.freeze({
        version: Object.freeze([1, 1] as const),
        entry: 'b0:entry',
        input: Object.freeze({ register: input, type: inputType }),
        resultType,
        blocks: Object.freeze([
          Object.freeze({
            id: 'b0:entry',
            parameters: Object.freeze([]),
            instructions: Object.freeze([]),
            terminator: Object.freeze({
              tag: 'structured',
              input,
              program: structured.program,
              source: Object.freeze({ module: moduleId, start: 0, end: sourceFile.getEnd() }),
            }),
          }),
        ]),
        summary: structured.program.summary,
      }),
    };
  }
}
