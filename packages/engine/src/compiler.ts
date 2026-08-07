/**
 * Restricted TypeScript parsing, validation, and lowering for the SafeScript subset.
 * @packageDocumentation
 */
import * as ts from 'typescript';

import {
  derivedActionSiteId,
  resultSchema,
  type ContractRegistry,
  type ModuleId,
  type OperationDefinition,
  type Schema,
  type SlotDefinition,
  type SourceLocation,
} from '@safescript/contracts';

import {
  fieldType,
  resolveSchema,
  sameType,
  variantType,
  type BlockId,
  type IrBlock,
  type IrInstruction,
  type IrProgram,
  type IrTerminator,
  type RegisterId,
} from './ir.js';

/**
 * Stable private failure lowered to a public machine-readable diagnostic by the bridge.
 * @internal
 */
export interface CompileFailure {
  readonly code: string;
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

interface MutableBlock {
  readonly id: BlockId;
  readonly parameters: { register: RegisterId; type: Schema }[];
  readonly instructions: IrInstruction[];
  terminator?: IrTerminator;
}

interface Binding {
  readonly register: RegisterId;
  readonly type: Schema;
  readonly payload?: RegisterId;
  readonly payloadType?: Schema;
}

class CompilerFailure extends Error {
  constructor(readonly failure: CompileFailure) {
    super(failure.message);
  }
}

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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function operationPath(expression: ts.Expression, contextName: string): string | undefined {
  const parts: string[] = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === contextName && parts.length > 0 ? parts.join('.') : undefined;
}

class Lowerer {
  private readonly blocks: MutableBlock[] = [];
  private readonly effects = new Set<OperationDefinition['effect']>();
  private readonly capabilities = new Set<OperationDefinition['capability']>();
  private nextBlock = 0;
  private nextRegister = 0;
  private current: MutableBlock;

  constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly moduleId: ModuleId,
    private readonly registry: ContractRegistry,
    private readonly slot: SlotDefinition,
    private readonly eventName: string,
    private readonly contextName: string,
  ) {
    this.current = this.block('entry');
  }

  compile(body: ts.Block): IrProgram {
    const inputType = { kind: 'ref' as const, type: this.slot.input };
    const resultType = { kind: 'ref' as const, type: this.slot.output };
    const input = this.register('input');
    const environment = new Map<string, Binding>([[this.eventName, { register: input, type: inputType }]]);
    this.compileStatements(body.statements, environment);
    if (!this.current.terminator) this.fail(body, 'SS_MISSING_RETURN', 'handler does not return on every path');
    const blocks = this.blocks.map((block): IrBlock =>
      Object.freeze({
        id: block.id,
        parameters: Object.freeze(block.parameters.map((parameter) => Object.freeze({ ...parameter }))),
        instructions: Object.freeze([...block.instructions]),
        terminator: block.terminator as IrTerminator,
      }),
    );
    return Object.freeze({
      version: Object.freeze([1, 0] as const),
      entry: blocks[0]?.id as BlockId,
      input: Object.freeze({ register: input, type: inputType }),
      resultType,
      blocks: Object.freeze(blocks),
      summary: Object.freeze({
        effects: Object.freeze([...this.effects].sort()),
        capabilities: Object.freeze([...this.capabilities].sort()),
      }),
    });
  }

  private location(node: ts.Node): SourceLocation {
    return Object.freeze({ module: this.moduleId, start: node.getStart(this.sourceFile), end: node.getEnd() });
  }

  private fail(node: ts.Node, code: string, message: string): never {
    const location = this.location(node);
    throw new CompilerFailure({ code, message, start: location.start, end: location.end });
  }

  private register(hint: string): RegisterId {
    return `r${this.nextRegister++}:${hint}`;
  }

  private block(hint: string, parameterTypes: readonly Schema[] = []): MutableBlock {
    const block: MutableBlock = {
      id: `b${this.nextBlock++}:${hint}`,
      parameters: parameterTypes.map((type, index) => ({ register: this.register(`parameter${index}`), type })),
      instructions: [],
    };
    this.blocks.push(block);
    return block;
  }

  private emit(instruction: IrInstruction): Binding {
    this.current.instructions.push(instruction);
    return { register: instruction.destination, type: instruction.type };
  }

  private terminate(terminator: IrTerminator): void {
    if (this.current.terminator) throw new Error('compiler attempted to terminate a block twice');
    this.current.terminator = terminator;
  }

  private compileStatements(
    statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
    environment: Map<string, Binding>,
  ): void {
    for (const statement of statements) {
      if (this.current.terminator) this.fail(statement, 'SS_UNREACHABLE_CODE', 'unreachable statement');
      if (ts.isReturnStatement(statement)) {
        if (!statement.expression) this.fail(statement, 'SS_RETURN_TYPE', 'return requires a checked result value');
        const value = this.expression(statement.expression, { kind: 'ref', type: this.slot.output }, environment);
        this.terminate({ tag: 'return', value: value.register, source: this.location(statement) });
      } else if (ts.isIfStatement(statement)) {
        this.ifStatement(statement, environment);
      } else if (ts.isVariableStatement(statement)) {
        this.variableStatement(statement, environment);
      } else if (ts.isSwitchStatement(statement)) {
        this.switchStatement(statement, environment);
      } else if (ts.isBlock(statement)) {
        this.compileStatements(statement.statements, environment);
      } else if (ts.isEmptyStatement(statement)) {
        continue;
      } else {
        this.fail(statement, 'SS_UNSUPPORTED_SYNTAX', `unsupported statement ${ts.SyntaxKind[statement.kind]}`);
      }
    }
  }

  private statementList(statement: ts.Statement): readonly ts.Statement[] {
    return ts.isBlock(statement) ? statement.statements : [statement];
  }

  private ifStatement(statement: ts.IfStatement, environment: Map<string, Binding>): void {
    const whenTrue = this.block('if-true');
    const whenFalse = this.block(statement.elseStatement ? 'if-false' : 'if-after');
    const after = statement.elseStatement ? this.block('if-after') : whenFalse;
    const origin = this.current;
    this.current = origin;
    this.condition(statement.expression, whenTrue.id, whenFalse.id, environment);

    this.current = whenTrue;
    this.compileStatements(this.statementList(statement.thenStatement), new Map(environment));
    const trueFallsThrough = !this.current.terminator;
    if (trueFallsThrough)
      this.terminate({ tag: 'jump', target: after.id, arguments: [], source: this.location(statement.thenStatement) });

    let falseFallsThrough = true;
    if (statement.elseStatement) {
      this.current = whenFalse;
      this.compileStatements(this.statementList(statement.elseStatement), new Map(environment));
      falseFallsThrough = !this.current.terminator;
      if (falseFallsThrough)
        this.terminate({
          tag: 'jump',
          target: after.id,
          arguments: [],
          source: this.location(statement.elseStatement),
        });
    }
    if (!trueFallsThrough && !falseFallsThrough) {
      this.blocks.splice(this.blocks.indexOf(after), 1);
    } else {
      this.current = after;
    }
  }

  private variableStatement(statement: ts.VariableStatement, environment: Map<string, Binding>): void {
    if (
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
      statement.declarationList.declarations.length !== 1
    )
      this.fail(statement, 'SS_MUTABLE_BINDING', 'only one lexical const declaration is accepted');
    const declaration = statement.declarationList.declarations[0] as ts.VariableDeclaration;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
      this.fail(declaration, 'SS_UNSUPPORTED_BINDING', 'const bindings require one identifier and initializer');
    if (environment.has(declaration.name.text))
      this.fail(declaration.name, 'SS_DUPLICATE_BINDING', 'duplicate local binding');
    const awaited = ts.isAwaitExpression(declaration.initializer) ? declaration.initializer.expression : undefined;
    if (awaited) {
      if (!ts.isCallExpression(awaited) || awaited.arguments.length !== 1)
        this.fail(awaited, 'SS_INVALID_ACTION', 'await is permitted only on one registered host operation');
      const path = operationPath(awaited.expression, this.contextName);
      const operation = path
        ? this.registry.operations.find((candidate) => String(candidate.id) === `operation:${path}`)
        : undefined;
      if (
        !operation ||
        !this.slot.effects.includes(operation.effect) ||
        !this.slot.capabilities.includes(operation.capability)
      )
        this.fail(awaited, 'SS_INVALID_ACTION', 'host operation is not registered for this slot');
      const inputType = { kind: 'ref' as const, type: operation.input };
      const resultType = resultSchema({ kind: 'ref', type: operation.output }, { kind: 'ref', type: operation.error });
      const input = this.expression(awaited.arguments[0] as ts.Expression, inputType, environment);
      const resume = this.block('action-resume', [resultType]);
      const source = this.location(awaited);
      const actionSiteId = derivedActionSiteId(
        new TextEncoder().encode(`${this.moduleId}\0${operation.id}\0${awaited.getText(this.sourceFile)}`),
      );
      this.terminate({
        tag: 'action',
        operationId: operation.id,
        effectId: operation.effect,
        capabilityId: operation.capability,
        actionSiteId,
        input: input.register,
        inputType,
        resultType,
        resume: resume.id,
        source,
      });
      this.effects.add(operation.effect);
      this.capabilities.add(operation.capability);
      this.current = resume;
      environment.set(declaration.name.text, {
        register: resume.parameters[0]?.register as RegisterId,
        type: resultType,
      });
      return;
    }
    environment.set(declaration.name.text, this.expression(declaration.initializer, undefined, environment));
  }

  private switchStatement(statement: ts.SwitchStatement, environment: Map<string, Binding>): void {
    if (
      !ts.isPropertyAccessExpression(statement.expression) ||
      statement.expression.name.text !== 'tag' ||
      !ts.isIdentifier(statement.expression.expression)
    )
      this.fail(statement.expression, 'SS_SWITCH_TYPE', 'switch must exhaust a checked tagged union');
    const name = statement.expression.expression.text;
    const binding = environment.get(name);
    const union = binding && resolveSchema(binding.type, this.registry);
    if (!binding || union?.kind !== 'variant')
      this.fail(statement.expression, 'SS_SWITCH_TYPE', 'switch value is not a checked tagged union');
    const cases: { variant: string; target: BlockId }[] = [];
    const caseBlocks: { clause: ts.CaseClause; block: MutableBlock; payload: Schema }[] = [];
    for (const clause of statement.caseBlock.clauses) {
      if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression))
        this.fail(clause, 'SS_SWITCH_EXHAUSTIVE', 'switch accepts only explicit string variant cases');
      const variant = clause.expression.text;
      const payload = union.variants.find((candidate) => candidate.tag === variant)?.schema;
      if (!payload || cases.some((item) => item.variant === variant))
        this.fail(clause, 'SS_SWITCH_EXHAUSTIVE', 'unknown or duplicate variant case');
      const block = this.block(`case-${variant}`, [payload]);
      cases.push({ variant, target: block.id });
      caseBlocks.push({ clause, block, payload });
    }
    if (
      cases.length !== union.variants.length ||
      union.variants.some((variant) => !cases.some((item) => item.variant === variant.tag))
    )
      this.fail(statement, 'SS_SWITCH_EXHAUSTIVE', 'switch must cover every variant exactly once');
    this.terminate({
      tag: 'switch',
      value: binding.register,
      cases: Object.freeze(cases),
      source: this.location(statement.expression),
    });
    const after = this.block('switch-after');
    let fallsThrough = false;
    for (const item of caseBlocks) {
      this.current = item.block;
      const narrowed = new Map(environment);
      narrowed.set(name, {
        ...binding,
        payload: (item.block.parameters[0] as { register: RegisterId }).register,
        payloadType: item.payload,
      });
      this.compileStatements(item.clause.statements, narrowed);
      if (!this.current.terminator) {
        fallsThrough = true;
        this.terminate({ tag: 'jump', target: after.id, arguments: [], source: this.location(item.clause) });
      }
    }
    if (fallsThrough) {
      this.current = after;
    } else {
      this.blocks.splice(this.blocks.indexOf(after), 1);
    }
  }

  private condition(
    expression: ts.Expression,
    whenTrue: BlockId,
    whenFalse: BlockId,
    environment: Map<string, Binding>,
  ): void {
    const value = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const right = this.block('or-right');
      this.condition(value.left, whenTrue, right.id, environment);
      this.current = right;
      this.condition(value.right, whenTrue, whenFalse, environment);
      return;
    }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const right = this.block('and-right');
      this.condition(value.left, right.id, whenFalse, environment);
      this.current = right;
      this.condition(value.right, whenTrue, whenFalse, environment);
      return;
    }
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
      this.condition(value.operand, whenFalse, whenTrue, environment);
      return;
    }
    const comparison = ts.isBinaryExpression(value)
      ? this.comparison(value, environment)
      : this.expression(value, { kind: 'boolean' }, environment);
    this.terminate({
      tag: 'branch',
      condition: comparison.register,
      whenTrue,
      whenFalse,
      source: this.location(value),
    });
  }

  private comparison(expression: ts.BinaryExpression, environment: Map<string, Binding>): Binding {
    const operators = new Map<ts.SyntaxKind, Extract<IrInstruction, { tag: 'compare' }>['operator']>([
      [ts.SyntaxKind.EqualsEqualsEqualsToken, 'equal'],
      [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'not-equal'],
      [ts.SyntaxKind.LessThanToken, 'less'],
      [ts.SyntaxKind.LessThanEqualsToken, 'less-equal'],
      [ts.SyntaxKind.GreaterThanToken, 'greater'],
      [ts.SyntaxKind.GreaterThanEqualsToken, 'greater-equal'],
    ]);
    const operator = operators.get(expression.operatorToken.kind);
    if (!operator)
      this.fail(expression.operatorToken, 'SS_UNSUPPORTED_OPERATOR', 'operator is outside the SafeScript allow-list');
    const left = this.expression(expression.left, undefined, environment);
    const right = this.expression(expression.right, left.type, environment);
    if (!sameType(left.type, right.type))
      this.fail(expression, 'SS_TYPE_MISMATCH', 'comparison operands must have the same checked type');
    const resolved = resolveSchema(left.type, this.registry);
    if (
      !resolved ||
      (!['equal', 'not-equal'].includes(operator) && resolved.kind !== 'int64' && resolved.kind !== 'float64')
    )
      this.fail(expression, 'SS_TYPE_MISMATCH', 'ordered comparison requires compatible numeric values');
    const destination = this.register('comparison');
    return this.emit({
      tag: 'compare',
      destination,
      type: { kind: 'boolean' },
      operator,
      left: left.register,
      right: right.register,
      source: this.location(expression),
    });
  }

  private expression(
    expression: ts.Expression,
    expected: Schema | undefined,
    environment: Map<string, Binding>,
  ): Binding {
    if (ts.isParenthesizedExpression(expression)) return this.expression(expression.expression, expected, environment);
    if (ts.isIdentifier(expression)) {
      const binding = environment.get(expression.text);
      if (!binding) this.fail(expression, 'SS_UNKNOWN_IDENTIFIER', `unknown identifier ${expression.text}`);
      if (expected && !sameType(binding.type, expected))
        this.fail(expression, 'SS_TYPE_MISMATCH', 'expression does not match its checked context');
      return binding;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (expression.name.text === 'value' && ts.isIdentifier(expression.expression)) {
        const narrowed = environment.get(expression.expression.text);
        if (narrowed?.payload && narrowed.payloadType)
          return { register: narrowed.payload, type: narrowed.payloadType };
      }
      const base = this.expression(expression.expression, undefined, environment);
      const type = fieldType(base.type, expression.name.text, this.registry);
      if (!type)
        this.fail(expression, 'SS_UNKNOWN_FIELD', `field ${expression.name.text} is not present on the checked record`);
      if (expected && !sameType(type, expected))
        this.fail(expression, 'SS_TYPE_MISMATCH', 'projected field does not match its checked context');
      return this.emit({
        tag: 'project-field',
        destination: this.register(expression.name.text),
        type,
        from: base.register,
        field: expression.name.text,
        source: this.location(expression),
      });
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      const type =
        expected && ['string', 'brand'].includes(resolveSchema(expected, this.registry)?.kind ?? '')
          ? expected
          : { kind: 'string' as const, maxBytes: new TextEncoder().encode(expression.text).length };
      return this.emit({
        tag: 'constant',
        destination: this.register('string'),
        type,
        value: expression.text,
        source: this.location(expression),
      });
    }
    if (ts.isBigIntLiteral(expression) || ts.isNumericLiteral(expression)) {
      const resolved = expected && resolveSchema(expected, this.registry);
      const type =
        resolved?.kind === 'float64'
          ? (expected as Schema)
          : resolved?.kind === 'int64' || resolved?.kind === 'brand'
            ? (expected as Schema)
            : ts.isBigIntLiteral(expression) || !expression.text.includes('.')
              ? ({ kind: 'int64' } as const)
              : ({ kind: 'float64' } as const);
      const value =
        resolveSchema(type, this.registry)?.kind === 'int64'
          ? expression.text.replaceAll('_', '').replace(/n$/, '')
          : Number(expression.text.replaceAll('_', ''));
      return this.emit({
        tag: 'constant',
        destination: this.register('number'),
        type,
        value,
        source: this.location(expression),
      });
    }
    if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
      return this.emit({
        tag: 'constant',
        destination: this.register('boolean'),
        type: { kind: 'boolean' },
        value: expression.kind === ts.SyntaxKind.TrueKeyword,
        source: this.location(expression),
      });
    }
    if (
      ts.isPrefixUnaryExpression(expression) &&
      expression.operator === ts.SyntaxKind.MinusToken &&
      (ts.isNumericLiteral(expression.operand) || ts.isBigIntLiteral(expression.operand))
    ) {
      const operand = this.expression(expression.operand, expected, environment);
      const instruction = this.current.instructions.pop();
      if (instruction?.tag !== 'constant')
        this.fail(expression, 'SS_NUMERIC_LITERAL', 'invalid negative numeric literal');
      const value = typeof instruction.value === 'number' ? -instruction.value : `-${instruction.value}`;
      return this.emit({ ...instruction, destination: operand.register, value, source: this.location(expression) });
    }
    if (ts.isObjectLiteralExpression(expression)) {
      if (!expected) this.fail(expression, 'SS_CONTEXT_REQUIRED', 'record literal requires a registered expected type');
      const record = resolveSchema(expected, this.registry);
      if (record?.kind !== 'record')
        this.fail(expression, 'SS_TYPE_MISMATCH', 'object literal is not a registered record');
      if (
        expression.properties.length !== record.fields.length ||
        expression.properties.some((property) => !ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name))
      )
        this.fail(expression, 'SS_RECORD_SHAPE', 'record literal requires every field exactly once');
      const fields: (readonly [string, RegisterId])[] = [];
      for (const field of record.fields) {
        const property = expression.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === field.name,
        );
        if (!property) this.fail(expression, 'SS_RECORD_SHAPE', `missing record field ${field.name}`);
        fields.push([field.name, this.expression(property.initializer, field.schema, environment).register]);
      }
      return this.emit({
        tag: 'construct-record',
        destination: this.register('record'),
        type: expected,
        fields: Object.freeze(fields),
        source: this.location(expression),
      });
    }
    if (ts.isTemplateExpression(expression)) {
      const parts: (string | Readonly<{ register: RegisterId }>)[] = [expression.head.text];
      for (const span of expression.templateSpans) {
        const value = this.expression(span.expression, undefined, environment);
        const resolved = resolveSchema(value.type, this.registry);
        if (!resolved || !['string', 'int64', 'float64', 'boolean', 'brand'].includes(resolved.kind))
          this.fail(
            span.expression,
            'SS_TEMPLATE_TYPE',
            'template interpolation has no deterministic bounded conversion',
          );
        parts.push({ register: value.register }, span.literal.text);
      }
      const type =
        expected && resolveSchema(expected, this.registry)?.kind === 'string' ? expected : { kind: 'string' as const };
      return this.emit({
        tag: 'build-template',
        destination: this.register('template'),
        type,
        parts: Object.freeze(parts),
        source: this.location(expression),
      });
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      (expression.expression.text === 'Ok' || expression.expression.text === 'Err')
    ) {
      const resultType = expected ?? { kind: 'ref' as const, type: this.slot.output };
      const tag = expression.expression.text === 'Ok' ? 'ok' : 'error';
      const payloadType = variantType(resultType, tag, this.registry);
      if (!payloadType || expression.arguments.length > 1 || (tag === 'error' && expression.arguments.length !== 1))
        this.fail(expression, 'SS_RESULT_CONSTRUCTION', 'invalid checked result construction');
      let payload: Binding;
      if (expression.arguments.length === 0) {
        if (resolveSchema(payloadType, this.registry)?.kind !== 'unit')
          this.fail(expression, 'SS_RESULT_CONSTRUCTION', 'Ok() requires a unit result');
        payload = this.emit({
          tag: 'constant',
          destination: this.register('unit'),
          type: payloadType,
          value: null,
          source: this.location(expression),
        });
      } else {
        payload = this.expression(expression.arguments[0] as ts.Expression, payloadType, environment);
      }
      return this.emit({
        tag: 'construct-variant',
        destination: this.register(tag),
        type: resultType,
        variant: tag,
        payload: payload.register,
        source: this.location(expression),
      });
    }
    if (ts.isBinaryExpression(expression)) return this.comparison(expression, environment);
    this.fail(expression, 'SS_UNSUPPORTED_EXPRESSION', `unsupported expression ${ts.SyntaxKind[expression.kind]}`);
  }
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
    if (!statement.importClause || statement.importClause.name || !bindings || !ts.isNamedImports(bindings))
      return {
        code: 'SS_IMPORT_FORM',
        message: 'only static named imports are accepted',
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
      };
    if (
      source === 'safescript:prelude' &&
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

function typeReference(
  node: ts.TypeNode | undefined,
  name: string,
  argumentsCount?: number,
): node is ts.TypeReferenceNode {
  return (
    !!node &&
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === name &&
    (argumentsCount === undefined || node.typeArguments?.length === argumentsCount)
  );
}

function handlerTypesValid(handler: ts.FunctionDeclaration): boolean {
  if (
    !handler.parameters.every((parameter) =>
      typeReference(
        parameter.type,
        parameter.type && ts.isTypeReferenceNode(parameter.type) && ts.isIdentifier(parameter.type.typeName)
          ? parameter.type.typeName.text
          : '',
      ),
    )
  )
    return false;
  if (!typeReference(handler.type, 'Promise', 1)) return false;
  const result = handler.type.typeArguments?.[0];
  return typeReference(result, 'Result', 2) && result.typeArguments?.[0]?.kind === ts.SyntaxKind.VoidKeyword;
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
  const functions = sourceFile.statements.filter(ts.isFunctionDeclaration);
  const invalidTopLevel = sourceFile.statements.find(
    (statement) => !ts.isImportDeclaration(statement) && !ts.isFunctionDeclaration(statement),
  );
  if (invalidTopLevel || functions.length !== 1) {
    const node = invalidTopLevel ?? sourceFile;
    return {
      ok: false,
      failure: {
        code: 'SS_MODULE_SHAPE',
        message: 'module must contain imports and exactly one exported handler',
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      },
      syntaxNodes: syntax.nodes,
      syntaxDepth: syntax.depth,
      imports,
      declarations,
    };
  }
  const handler = functions[0] as ts.FunctionDeclaration;
  if (
    !handler.name ||
    !handler.body ||
    handler.parameters.length !== 2 ||
    !handler.parameters.every((parameter) => ts.isIdentifier(parameter.name) && !!parameter.type) ||
    !handler.type ||
    !handlerTypesValid(handler) ||
    !hasModifier(handler, ts.SyntaxKind.ExportKeyword) ||
    !hasModifier(handler, ts.SyntaxKind.AsyncKeyword) ||
    handler.asteriskToken
  ) {
    return {
      ok: false,
      failure: {
        code: 'SS_HANDLER_SHAPE',
        message:
          'handler must be one named exported async function with typed event and context parameters and Promise<Result<void, E>> return',
        start: handler.getStart(sourceFile),
        end: handler.getEnd(),
      },
      syntaxNodes: syntax.nodes,
      syntaxDepth: syntax.depth,
      imports,
      declarations,
    };
  }
  try {
    const lowerer = new Lowerer(
      sourceFile,
      moduleId,
      registry,
      slot,
      (handler.parameters[0]?.name as ts.Identifier).text,
      (handler.parameters[1]?.name as ts.Identifier).text,
    );
    return {
      ok: true,
      program: lowerer.compile(handler.body),
      handler: handler.name.text,
      syntaxNodes: syntax.nodes,
      syntaxDepth: syntax.depth,
      imports,
      declarations,
    };
  } catch (error) {
    if (error instanceof CompilerFailure)
      return {
        ok: false,
        failure: error.failure,
        syntaxNodes: syntax.nodes,
        syntaxDepth: syntax.depth,
        imports,
        declarations,
      };
    throw error;
  }
}
