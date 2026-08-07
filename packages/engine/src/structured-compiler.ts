/** SafeScript-owned checking and lowering for additive language 1.1 constructs. */
import * as ts from 'typescript';
import {
  derivedActionSiteId,
  resultSchema,
  type CompilerDiagnosticCode,
  type ContractRegistry,
  type ModuleId,
  type OperationDefinition,
  type SlotDefinition,
  type SourceLocation,
} from '@safescript/contracts';
import type {
  StructuredExpression,
  StructuredFunction,
  StructuredPattern,
  StructuredProgram,
  StructuredStatement,
} from './structured-ir.js';

export interface StructuredCompileFailure {
  readonly code: CompilerDiagnosticCode;
  readonly message: string;
  readonly start: number;
  readonly end: number;
}
class Failure extends Error {
  constructor(readonly failure: StructuredCompileFailure) {
    super(failure.message);
  }
}

function checkedSource(sourceFile: ts.SourceFile): ts.SourceFile {
  const fileName = '/safescript-entry.ts';
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === fileName,
    readFile: (candidate) => (candidate === fileName ? sourceFile.text : undefined),
    getSourceFile: (candidate) =>
      candidate === fileName
        ? ts.createSourceFile(candidate, sourceFile.text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
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
  const checked = program.getSourceFile(fileName);
  if (!checked) throw new Error('SafeScript checker did not retain its in-memory entry source');
  const checker = program.getTypeChecker();
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) || ts.isTypeNode(node)) checker.getTypeAtLocation(node);
    ts.forEachChild(node, visit);
  };
  visit(checked);
  return checked;
}

const binaryOperators = new Map<ts.SyntaxKind, Extract<StructuredExpression, { tag: 'binary' }>['operator']>([
  [ts.SyntaxKind.PlusToken, 'add'],
  [ts.SyntaxKind.MinusToken, 'subtract'],
  [ts.SyntaxKind.AsteriskToken, 'multiply'],
  [ts.SyntaxKind.SlashToken, 'divide'],
  [ts.SyntaxKind.PercentToken, 'remainder'],
  [ts.SyntaxKind.AmpersandToken, 'bit-and'],
  [ts.SyntaxKind.BarToken, 'bit-or'],
  [ts.SyntaxKind.CaretToken, 'bit-xor'],
  [ts.SyntaxKind.LessThanLessThanToken, 'shift-left'],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, 'shift-right'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, 'equal'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'not-equal'],
  [ts.SyntaxKind.LessThanToken, 'less'],
  [ts.SyntaxKind.LessThanEqualsToken, 'less-equal'],
  [ts.SyntaxKind.GreaterThanToken, 'greater'],
  [ts.SyntaxKind.GreaterThanEqualsToken, 'greater-equal'],
  [ts.SyntaxKind.AmpersandAmpersandToken, 'and'],
  [ts.SyntaxKind.BarBarToken, 'or'],
  [ts.SyntaxKind.QuestionQuestionToken, 'nullish'],
  [ts.SyntaxKind.InKeyword, 'in'],
]);
const assignmentOperators = new Map<ts.SyntaxKind, Extract<StructuredStatement, { tag: 'assign' }>['operator']>([
  [ts.SyntaxKind.EqualsToken, 'set'],
  [ts.SyntaxKind.PlusEqualsToken, 'add'],
  [ts.SyntaxKind.MinusEqualsToken, 'subtract'],
  [ts.SyntaxKind.AsteriskEqualsToken, 'multiply'],
  [ts.SyntaxKind.SlashEqualsToken, 'divide'],
  [ts.SyntaxKind.PercentEqualsToken, 'remainder'],
  [ts.SyntaxKind.AmpersandEqualsToken, 'bit-and'],
  [ts.SyntaxKind.BarEqualsToken, 'bit-or'],
  [ts.SyntaxKind.CaretEqualsToken, 'bit-xor'],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, 'shift-left'],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, 'shift-right'],
]);

class Lowerer {
  readonly effects = new Set<OperationDefinition['effect']>();
  readonly capabilities = new Set<OperationDefinition['capability']>();
  readonly mutable = new Set<string>();
  private actionOrdinal = 0;
  constructor(
    readonly file: ts.SourceFile,
    readonly moduleId: ModuleId,
    readonly registry: ContractRegistry,
    readonly slot: SlotDefinition,
    readonly contextName: string,
  ) {}
  location(node: ts.Node): SourceLocation {
    return Object.freeze({ module: this.moduleId, start: node.getStart(this.file), end: node.getEnd() });
  }
  fail(node: ts.Node, code: CompilerDiagnosticCode, message: string): never {
    const source = this.location(node);
    throw new Failure({ code, message, start: source.start, end: source.end });
  }

  expression(node: ts.Expression): StructuredExpression {
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return this.expression(node.expression);
    if ((ts.isAsExpression(node) && ts.isConstTypeReference(node.type)) || ts.isSatisfiesExpression(node))
      return this.expression(node.expression);
    if (ts.isIdentifier(node)) return { tag: 'name', name: node.text, source: this.location(node) };
    if (ts.isStringLiteralLike(node))
      return { tag: 'literal', kind: 'string', value: node.text, source: this.location(node) };
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      const text = node.text.replaceAll('_', '').replace(/n$/, '');
      return text.includes('.') || /e/i.test(text)
        ? { tag: 'literal', kind: 'float64', value: Number(text), source: this.location(node) }
        : { tag: 'literal', kind: 'int64', value: text, source: this.location(node) };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
      return {
        tag: 'literal',
        kind: 'boolean',
        value: node.kind === ts.SyntaxKind.TrueKeyword,
        source: this.location(node),
      };
    if (ts.isPropertyAccessExpression(node))
      return {
        tag: 'member',
        value: this.expression(node.expression),
        name: node.name.text,
        optional: !!node.questionDotToken,
        source: this.location(node),
      };
    if (ts.isElementAccessExpression(node) && node.argumentExpression)
      return {
        tag: 'index',
        value: this.expression(node.expression),
        index: this.expression(node.argumentExpression),
        optional: !!node.questionDotToken,
        source: this.location(node),
      };
    if (ts.isArrayLiteralExpression(node))
      return {
        tag: 'array',
        items: node.elements.map((item) =>
          ts.isSpreadElement(item) ? { spread: this.expression(item.expression) } : this.expression(item),
        ),
        source: this.location(node),
      };
    if (ts.isObjectLiteralExpression(node))
      return {
        tag: 'object',
        fields: node.properties.map((property) => {
          if (ts.isSpreadAssignment(property)) return { spread: this.expression(property.expression) };
          if (
            !ts.isPropertyAssignment(property) ||
            (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
          )
            this.fail(property, 'SS_RECORD_SHAPE', 'object fields must be statically named');
          return { name: property.name.text, value: this.expression(property.initializer) };
        }),
        source: this.location(node),
      };
    if (ts.isTemplateExpression(node))
      return {
        tag: 'template',
        parts: [
          node.head.text,
          ...node.templateSpans.flatMap((span) => [this.expression(span.expression), span.literal.text]),
        ],
        source: this.location(node),
      };
    if (ts.isPrefixUnaryExpression(node)) {
      const operator =
        node.operator === ts.SyntaxKind.ExclamationToken
          ? 'not'
          : node.operator === ts.SyntaxKind.MinusToken
            ? 'negate'
            : node.operator === ts.SyntaxKind.TildeToken
              ? 'bit-not'
              : undefined;
      if (!operator) this.fail(node, 'SS_UNSUPPORTED_OPERATOR', 'unary operator is rejected');
      return { tag: 'unary', operator, value: this.expression(node.operand), source: this.location(node) };
    }
    if (ts.isBinaryExpression(node)) {
      if (
        [
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        ].includes(node.operatorToken.kind)
      )
        this.fail(node.operatorToken, 'SS_UNSUPPORTED_OPERATOR', 'coercion and unsigned shift are rejected');
      const operator = binaryOperators.get(node.operatorToken.kind);
      if (!operator)
        this.fail(node.operatorToken, 'SS_UNSUPPORTED_OPERATOR', 'operator is outside the SafeScript allow-list');
      return {
        tag: 'binary',
        operator,
        left: this.expression(node.left),
        right: this.expression(node.right),
        source: this.location(node),
      };
    }
    if (ts.isConditionalExpression(node))
      return {
        tag: 'conditional',
        condition: this.expression(node.condition),
        whenTrue: this.expression(node.whenTrue),
        whenFalse: this.expression(node.whenFalse),
        source: this.location(node),
      };
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (node.asteriskToken) this.fail(node, 'SS_UNSUPPORTED_FUNCTION', 'generators are rejected');
      const parameters = node.parameters.map((parameter) => {
        if (!ts.isIdentifier(parameter.name))
          this.fail(parameter.name, 'SS_UNSUPPORTED_BINDING', 'closure parameters require identifiers');
        return (parameter.name as ts.Identifier).text;
      });
      const body = ts.isBlock(node.body)
        ? this.statements(node.body.statements)
        : [{ tag: 'return' as const, value: this.expression(node.body), source: this.location(node.body) }];
      return { tag: 'function', parameters, body, source: this.location(node) };
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && (node.expression.text === 'Ok' || node.expression.text === 'Err'))
        return {
          tag: 'result',
          variant: node.expression.text === 'Ok' ? 'ok' : 'error',
          value: node.arguments[0]
            ? this.expression(node.arguments[0])
            : { tag: 'literal', kind: 'unit', value: null, source: this.location(node) },
          source: this.location(node),
        };
      const action = this.action(node);
      if (action) return action;
      return {
        tag: 'call',
        callee: this.expression(node.expression),
        arguments: node.arguments.map((argument) => {
          if (ts.isSpreadElement(argument)) this.fail(argument, 'SS_UNSUPPORTED_EXPRESSION', 'call spread is rejected');
          return this.expression(argument as ts.Expression);
        }),
        source: this.location(node),
      };
    }
    this.fail(node, 'SS_UNSUPPORTED_EXPRESSION', `unsupported expression ${ts.SyntaxKind[node.kind]}`);
  }

  action(node: ts.CallExpression): Extract<StructuredExpression, { tag: 'action' }> | undefined {
    const parts: string[] = [];
    let current: ts.Expression = node.expression;
    while (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
    }
    if (!ts.isIdentifier(current) || current.text !== this.contextName) return undefined;
    const operation = this.registry.operations.find(
      (candidate) => String(candidate.id) === `operation:${parts.join('.')}`,
    );
    if (
      !operation ||
      !this.slot.effects.includes(operation.effect) ||
      !this.slot.capabilities.includes(operation.capability) ||
      node.arguments.length !== 1
    )
      this.fail(node, 'SS_INVALID_ACTION', 'host operation is not registered for this slot');
    this.effects.add(operation.effect);
    this.capabilities.add(operation.capability);
    return {
      tag: 'action',
      operationId: operation.id,
      effectId: operation.effect,
      capabilityId: operation.capability,
      actionSiteId: derivedActionSiteId(
        new TextEncoder().encode(
          `${this.moduleId}\0${operation.id}\0${this.actionOrdinal++}\0${node.getText(this.file)}`,
        ),
      ),
      inputType: { kind: 'ref', type: operation.input },
      resultType: resultSchema({ kind: 'ref', type: operation.output }, { kind: 'ref', type: operation.error }),
      input: this.expression(node.arguments[0] as ts.Expression),
      source: this.location(node),
    };
  }

  body(statement: ts.Statement): readonly StructuredStatement[] {
    return ts.isBlock(statement) ? this.statements(statement.statements) : this.statements([statement]);
  }
  pattern(name: ts.BindingName): StructuredPattern {
    if (ts.isIdentifier(name)) return { tag: 'name', name: name.text };
    if (ts.isArrayBindingPattern(name))
      return {
        tag: 'array',
        items: name.elements.map((element) => (ts.isOmittedExpression(element) ? null : this.pattern(element.name))),
      };
    return {
      tag: 'object',
      fields: name.elements.map((element) => {
        if (element.dotDotDotToken) this.fail(element, 'SS_UNSUPPORTED_BINDING', 'rest destructuring is rejected');
        const property = element.propertyName ?? element.name;
        if (!ts.isIdentifier(property) && !ts.isStringLiteral(property))
          this.fail(property, 'SS_UNSUPPORTED_BINDING', 'computed destructuring keys are rejected');
        return { name: property.text, pattern: this.pattern(element.name) };
      }),
    };
  }
  statements(nodes: readonly ts.Statement[]): readonly StructuredStatement[] {
    return nodes.map((node): StructuredStatement => {
      if (ts.isVariableStatement(node)) {
        if (
          (node.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0 ||
          node.declarationList.declarations.length !== 1
        )
          this.fail(node, 'SS_MUTABLE_BINDING', 'var and multi-declarations are rejected');
        const declaration = node.declarationList.declarations[0] as ts.VariableDeclaration;
        if (!declaration.initializer)
          this.fail(declaration, 'SS_UNSUPPORTED_BINDING', 'binding requires an initializer');
        const mutable = (node.declarationList.flags & ts.NodeFlags.Let) !== 0;
        if (!ts.isIdentifier(declaration.name))
          return {
            tag: 'destructure',
            pattern: this.pattern(declaration.name),
            mutable,
            value: this.expression(declaration.initializer),
            source: this.location(node),
          };
        if (mutable) this.mutable.add(declaration.name.text);
        return {
          tag: 'variable',
          name: declaration.name.text,
          mutable,
          value: this.expression(declaration.initializer),
          source: this.location(node),
        };
      }
      if (
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        ts.isIdentifier(node.expression.left)
      ) {
        const operator = assignmentOperators.get(node.expression.operatorToken.kind);
        if (!operator || !this.mutable.has(node.expression.left.text))
          this.fail(node, 'SS_IMMUTABLE_ASSIGNMENT', 'assignment requires a local let binding');
        return {
          tag: 'assign',
          name: node.expression.left.text,
          operator,
          value: this.expression(node.expression.right),
          source: this.location(node),
        };
      }
      if (
        ts.isExpressionStatement(node) &&
        (ts.isPostfixUnaryExpression(node.expression) || ts.isPrefixUnaryExpression(node.expression)) &&
        ts.isIdentifier(node.expression.operand) &&
        (node.expression.operator === ts.SyntaxKind.PlusPlusToken ||
          node.expression.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        if (!this.mutable.has(node.expression.operand.text))
          this.fail(node, 'SS_IMMUTABLE_ASSIGNMENT', 'update requires a local let binding');
        return {
          tag: 'assign',
          name: node.expression.operand.text,
          operator: node.expression.operator === ts.SyntaxKind.PlusPlusToken ? 'add' : 'subtract',
          value: { tag: 'literal', kind: 'int64', value: '1', source: this.location(node.expression) },
          source: this.location(node),
        };
      }
      if (ts.isExpressionStatement(node))
        return { tag: 'expression', expression: this.expression(node.expression), source: this.location(node) };
      if (ts.isIfStatement(node))
        return {
          tag: 'if',
          condition: this.expression(node.expression),
          whenTrue: this.body(node.thenStatement),
          whenFalse: node.elseStatement ? this.body(node.elseStatement) : [],
          source: this.location(node),
        };
      if (ts.isForOfStatement(node)) {
        if (!ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1)
          this.fail(node.initializer, 'SS_UNSUPPORTED_BINDING', 'for-of requires one local binding');
        const declaration = node.initializer.declarations[0] as ts.VariableDeclaration;
        if (!ts.isIdentifier(declaration.name))
          this.fail(declaration.name, 'SS_UNSUPPORTED_BINDING', 'for-of requires one identifier');
        const mutable = (node.initializer.flags & ts.NodeFlags.Let) !== 0;
        if (mutable) this.mutable.add(declaration.name.text);
        return {
          tag: 'for-of',
          name: declaration.name.text,
          mutable,
          values: this.expression(node.expression),
          body: this.body(node.statement),
          source: this.location(node),
        };
      }
      if (ts.isForInStatement(node)) {
        if (!ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1)
          this.fail(node.initializer, 'SS_UNSUPPORTED_BINDING', 'for-in requires one local binding');
        const declaration = node.initializer.declarations[0] as ts.VariableDeclaration;
        if (!ts.isIdentifier(declaration.name))
          this.fail(declaration.name, 'SS_UNSUPPORTED_BINDING', 'for-in requires one identifier');
        const mutable = (node.initializer.flags & ts.NodeFlags.Let) !== 0;
        if (mutable) this.mutable.add(declaration.name.text);
        return {
          tag: 'for-in',
          name: declaration.name.text,
          mutable,
          value: this.expression(node.expression),
          body: this.body(node.statement),
          source: this.location(node),
        };
      }
      if (ts.isWhileStatement(node) || ts.isDoStatement(node))
        return {
          tag: 'loop',
          initializer: [],
          condition: this.expression(node.expression),
          increment: [],
          body: this.body(node.statement),
          checkAfter: ts.isDoStatement(node),
          source: this.location(node),
        };
      if (ts.isForStatement(node)) {
        let initializer: readonly StructuredStatement[] = [];
        if (node.initializer) {
          if (!ts.isVariableDeclarationList(node.initializer))
            this.fail(node.initializer, 'SS_UNSUPPORTED_BINDING', 'for initializer must declare a local');
          const synthetic = ts.factory.createVariableStatement(undefined, node.initializer);
          ts.setTextRange(synthetic, node.initializer);
          initializer = this.statements([synthetic]);
        }
        let increment: readonly StructuredStatement[] = [];
        if (node.incrementor) {
          const synthetic = ts.factory.createExpressionStatement(node.incrementor);
          ts.setTextRange(synthetic, node.incrementor);
          increment = this.statements([synthetic]);
        }
        return {
          tag: 'loop',
          initializer,
          condition: node.condition
            ? this.expression(node.condition)
            : { tag: 'literal', kind: 'boolean', value: true, source: this.location(node) },
          increment,
          body: this.body(node.statement),
          checkAfter: false,
          source: this.location(node),
        };
      }
      if (ts.isBreakStatement(node)) return { tag: 'break', source: this.location(node) };
      if (ts.isContinueStatement(node)) return { tag: 'continue', source: this.location(node) };
      if (ts.isReturnStatement(node) && node.expression)
        return { tag: 'return', value: this.expression(node.expression), source: this.location(node) };
      if (ts.isSwitchStatement(node))
        return {
          tag: 'switch',
          value: this.expression(node.expression),
          cases: node.caseBlock.clauses.map((clause) => {
            if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression))
              this.fail(clause, 'SS_SWITCH_EXHAUSTIVE', 'switch requires explicit string cases');
            return { value: clause.expression.text, body: this.statements(clause.statements) };
          }),
          source: this.location(node),
        };
      if (ts.isBlock(node))
        return {
          tag: 'if',
          condition: { tag: 'literal', kind: 'boolean', value: true, source: this.location(node) },
          whenTrue: this.statements(node.statements),
          whenFalse: [],
          source: this.location(node),
        };
      this.fail(node, 'SS_UNSUPPORTED_SYNTAX', `unsupported statement ${ts.SyntaxKind[node.kind]}`);
    });
  }
}

function modifiers(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === kind) === true;
}

function safetyFailure(sourceFile: ts.SourceFile): StructuredCompileFailure | undefined {
  let failure: StructuredCompileFailure | undefined;
  const reject = (node: ts.Node, code: CompilerDiagnosticCode, message: string): void => {
    if (!failure) failure = { code, message, start: node.getStart(sourceFile), end: node.getEnd() };
  };
  const rootIdentifier = (expression: ts.Expression): string | undefined => {
    let current = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
      current = current.expression;
    return ts.isIdentifier(current) ? current.text : undefined;
  };
  const consumedByPromiseAll = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isCallExpression(current)) current = current.parent;
    return (
      !!current &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === 'Promise' &&
      current.expression.name.text === 'all' &&
      ts.isAwaitExpression(current.parent)
    );
  };
  const visit = (node: ts.Node): void => {
    if (failure) return;
    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword)
      reject(node, 'SS_UNSAFE_TYPE', 'any and general unknown are rejected');
    else if (node.kind === ts.SyntaxKind.NullKeyword)
      reject(node, 'SS_NULL_REJECTED', 'null is rejected; use canonical Option absence');
    else if (
      (ts.isAsExpression(node) && !ts.isConstTypeReference(node.type)) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    )
      reject(node, 'SS_UNSAFE_ASSERTION', 'type and non-null assertions are rejected');
    else if (ts.isClassLike(node) || ts.isNewExpression(node))
      reject(node, 'SS_CLASS_REJECTED', 'classes and constructors are rejected');
    else if (ts.isThrowStatement(node) || ts.isTryStatement(node))
      reject(node, 'SS_EXCEPTION_REJECTED', 'exception control flow is rejected');
    else if (ts.isYieldExpression(node) || (ts.isFunctionLike(node) && 'asteriskToken' in node && !!node.asteriskToken))
      reject(node, 'SS_GENERATOR_REJECTED', 'generators are rejected');
    else if (ts.isRegularExpressionLiteral(node)) reject(node, 'SS_REGEX_REJECTED', 'regular expressions are rejected');
    else if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ].includes(node.operatorToken.kind)
    )
      reject(node.operatorToken, 'SS_UNSUPPORTED_OPERATOR', 'coercion and unsigned shift are rejected');
    else if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    )
      reject(node.left, 'SS_VALUE_MUTATION', 'property and element mutation are rejected');
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        reject(node, 'SS_DYNAMIC_IMPORT', 'dynamic imports are rejected');
      else if (ts.isIdentifier(node.expression) && ['eval', 'Function'].includes(node.expression.text))
        reject(node, 'SS_GENERATED_CODE', 'generated execution is rejected');
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Promise' &&
        ['race', 'any'].includes(node.expression.name.text)
      )
        reject(node, 'SS_PROMISE_RACE', 'Promise.race and Promise.any are rejected');
      else if (ts.isPropertyAccessExpression(node.expression) && /Locale/.test(node.expression.name.text))
        reject(node, 'SS_LOCALE_REJECTED', 'locale-sensitive behavior is rejected');
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort', 'fill', 'copyWithin'].includes(
          node.expression.name.text,
        )
      )
        reject(node, 'SS_VALUE_MUTATION', 'mutable collection methods are rejected');
      else if (
        rootIdentifier(node.expression) === 'ctx' &&
        !ts.isAwaitExpression(node.parent) &&
        !consumedByPromiseAll(node)
      )
        reject(node, 'SS_FLOATING_ACTION', 'every action must be consumed exactly once by await');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return failure;
}

export function compileStructuredProgram(
  sourceFile: ts.SourceFile,
  moduleId: ModuleId,
  registry: ContractRegistry,
  slot: SlotDefinition,
): { ok: true; program: StructuredProgram; handler: string } | { ok: false; failure: StructuredCompileFailure } {
  try {
    sourceFile = checkedSource(sourceFile);
    const unsafe = safetyFailure(sourceFile);
    if (unsafe) throw new Failure(unsafe);
    const declarations = sourceFile.statements.filter(ts.isFunctionDeclaration);
    const handler = declarations.find(
      (fn) => modifiers(fn, ts.SyntaxKind.ExportKeyword) && modifiers(fn, ts.SyntaxKind.AsyncKeyword),
    );
    if (
      !handler?.name ||
      !handler.body ||
      handler.parameters.length !== 2 ||
      !handler.parameters.every((parameter) => ts.isIdentifier(parameter.name))
    )
      throw new Failure({
        code: 'SS_HANDLER_SHAPE',
        message: 'language 1.1 requires one named exported async handler with event and context parameters',
        start: handler?.getStart(sourceFile) ?? 0,
        end: handler?.getEnd() ?? sourceFile.getEnd(),
      });
    const allowedTopLevel = sourceFile.statements.every(
      (statement) =>
        ts.isImportDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement),
    );
    if (!allowedTopLevel)
      throw new Failure({
        code: 'SS_MODULE_SHAPE',
        message: 'top-level execution and mutable state are rejected',
        start: 0,
        end: sourceFile.getEnd(),
      });
    const contextName = (handler.parameters[1]?.name as ts.Identifier).text;
    const lowerer = new Lowerer(sourceFile, moduleId, registry, slot, contextName);
    const functions: StructuredFunction[] = declarations.map((fn) => {
      if (!fn.name || !fn.body || fn.asteriskToken)
        lowerer.fail(fn, 'SS_UNSUPPORTED_FUNCTION', 'named non-generator functions require bodies');
      const name = fn.name as ts.Identifier;
      const body = fn.body as ts.Block;
      return {
        name: name.text,
        parameters: fn.parameters.map((parameter) => {
          if (!ts.isIdentifier(parameter.name))
            lowerer.fail(
              parameter.name,
              'SS_UNSUPPORTED_BINDING',
              'destructured parameters are not implemented in this slice',
            );
          return (parameter.name as ts.Identifier).text;
        }),
        body: lowerer.statements(body.statements),
        source: lowerer.location(fn),
      };
    });
    return {
      ok: true,
      handler: handler.name.text,
      program: Object.freeze({
        version: Object.freeze([1, 1] as const),
        handler: handler.name.text,
        eventParameter: (handler.parameters[0]?.name as ts.Identifier).text,
        contextParameter: contextName,
        functions: Object.freeze(functions),
        summary: Object.freeze({
          effects: Object.freeze([...lowerer.effects].sort()),
          capabilities: Object.freeze([...lowerer.capabilities].sort()),
        }),
      }),
    };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, failure: error.failure };
    throw error;
  }
}
