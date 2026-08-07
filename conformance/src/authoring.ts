/** Blind-agent authoring evidence and the computed V1 usability gate. */
import type {
  CapabilityId,
  CompileUsage,
  CompilerDiagnosticCode,
  DiagnosticCategory,
  EffectId,
  ExecutionUsage,
} from '@safescript/contracts';

export type AuthoringScenario = 'crm' | 'application-extension' | 'code-mode' | 'device-rule';

export interface AgentAuthoringEvidence {
  readonly scenario: AuthoringScenario;
  readonly bundleSchema: Readonly<{ major: number; minor: number; patch: number }>;
  readonly firstCheckAccepted: boolean;
  readonly diagnostics: readonly Readonly<{
    turn: number;
    codes: readonly CompilerDiagnosticCode[];
    categories: readonly DiagnosticCategory[];
  }>[];
  readonly repairTurns: number;
  readonly finalAccepted: boolean;
  readonly semanticallyCorrect: boolean;
  readonly expectedEffects: readonly EffectId[];
  readonly actualEffects: readonly EffectId[];
  readonly expectedCapabilities: readonly CapabilityId[];
  readonly actualCapabilities: readonly CapabilityId[];
  readonly compileUsage?: CompileUsage;
  readonly executionUsage?: ExecutionUsage;
  readonly resourceBehavior: 'within-limits' | 'expected-exhaustion' | 'unexpected-failure';
  readonly privateCompilerKnowledgeUsed: boolean;
}

export interface AuthoringGateThresholds {
  readonly scenarios: number;
  readonly minimumFirstCheckRate: number;
  readonly minimumFinalAcceptanceRate: number;
  readonly minimumSemanticCorrectnessRate: number;
  readonly minimumSummaryAccuracyRate: number;
  readonly maximumRepairTurnsPerRun: number;
  readonly maximumUnexpectedResourceFailures: number;
}

/** Thresholds fixed from the checked-in blind-run baseline before the V1 release gate. */
export const V1_AUTHORING_THRESHOLDS: AuthoringGateThresholds = Object.freeze({
  scenarios: 4,
  minimumFirstCheckRate: 0.5,
  minimumFinalAcceptanceRate: 1,
  minimumSemanticCorrectnessRate: 1,
  minimumSummaryAccuracyRate: 1,
  maximumRepairTurnsPerRun: 2,
  maximumUnexpectedResourceFailures: 0,
});

export type AuthoringFailureOwner = 'compiler-diagnostics' | 'declarations' | 'examples-guide' | 'language';

export interface AuthoringGateResult {
  readonly passed: boolean;
  readonly metrics: Readonly<{
    firstCheckRate: number;
    finalAcceptanceRate: number;
    semanticCorrectnessRate: number;
    summaryAccuracyRate: number;
    maximumRepairTurns: number;
    unexpectedResourceFailures: number;
  }>;
  readonly failures: readonly Readonly<{
    scenario?: AuthoringScenario;
    owner: AuthoringFailureOwner;
    reason: string;
  }>[];
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\n') === [...right].sort().join('\n');
}

/** Evaluates evidence without model-specific exceptions or access to private compiler structures. */
export function evaluateAuthoringGate(
  evidence: readonly AgentAuthoringEvidence[],
  thresholds: AuthoringGateThresholds = V1_AUTHORING_THRESHOLDS,
): AuthoringGateResult {
  const failures: Array<{ scenario?: AuthoringScenario; owner: AuthoringFailureOwner; reason: string }> = [];
  const count = evidence.length;
  const rate = (predicate: (run: AgentAuthoringEvidence) => boolean) =>
    count === 0 ? 0 : evidence.filter(predicate).length / count;
  const summaries = evidence.map(
    (run) =>
      sameValues(run.expectedEffects, run.actualEffects) &&
      sameValues(run.expectedCapabilities, run.actualCapabilities),
  );
  const metrics = {
    firstCheckRate: rate((run) => run.firstCheckAccepted),
    finalAcceptanceRate: rate((run) => run.finalAccepted),
    semanticCorrectnessRate: rate((run) => run.semanticallyCorrect),
    summaryAccuracyRate: count === 0 ? 0 : summaries.filter(Boolean).length / count,
    maximumRepairTurns: Math.max(0, ...evidence.map((run) => run.repairTurns)),
    unexpectedResourceFailures: evidence.filter((run) => run.resourceBehavior === 'unexpected-failure').length,
  };
  if (count !== thresholds.scenarios)
    failures.push({ owner: 'examples-guide', reason: `expected ${thresholds.scenarios} scenarios, received ${count}` });
  for (const [index, run] of evidence.entries()) {
    if (run.privateCompilerKnowledgeUsed)
      failures.push({ scenario: run.scenario, owner: 'examples-guide', reason: 'run used private compiler knowledge' });
    if (!run.finalAccepted)
      failures.push({
        scenario: run.scenario,
        owner: run.diagnostics.length === 0 ? 'declarations' : 'compiler-diagnostics',
        reason: 'source was not accepted',
      });
    if (!run.semanticallyCorrect)
      failures.push({
        scenario: run.scenario,
        owner: 'examples-guide',
        reason: 'accepted source missed the scenario intent',
      });
    if (!summaries[index])
      failures.push({
        scenario: run.scenario,
        owner: 'language',
        reason: 'effect or capability summary was inaccurate',
      });
    if (run.repairTurns > thresholds.maximumRepairTurnsPerRun)
      failures.push({ scenario: run.scenario, owner: 'compiler-diagnostics', reason: 'repair-turn limit exceeded' });
  }
  if (metrics.firstCheckRate < thresholds.minimumFirstCheckRate)
    failures.push({ owner: 'examples-guide', reason: 'first-check acceptance rate is below baseline threshold' });
  if (metrics.finalAcceptanceRate < thresholds.minimumFinalAcceptanceRate)
    failures.push({ owner: 'compiler-diagnostics', reason: 'final acceptance rate is below threshold' });
  if (metrics.semanticCorrectnessRate < thresholds.minimumSemanticCorrectnessRate)
    failures.push({ owner: 'examples-guide', reason: 'semantic correctness rate is below threshold' });
  if (metrics.summaryAccuracyRate < thresholds.minimumSummaryAccuracyRate)
    failures.push({ owner: 'language', reason: 'summary accuracy rate is below threshold' });
  if (metrics.unexpectedResourceFailures > thresholds.maximumUnexpectedResourceFailures)
    failures.push({ owner: 'language', reason: 'unexpected resource-failure threshold exceeded' });
  return Object.freeze({
    passed: failures.length === 0,
    metrics: Object.freeze(metrics),
    failures: Object.freeze(failures),
  });
}
