import { describe, expect, it } from 'bun:test';

import { ids } from '@safescript/contracts';

import {
  evaluateAuthoringGate,
  type AgentAuthoringEvidence,
  type AuthoringGateThresholds,
  type AuthoringScenario,
} from './authoring.js';
import { blindApplicationExtensionReference, blindDeviceRuleReference } from './authoring-fixtures.js';

const scenarios: AuthoringScenario[] = ['crm', 'application-extension', 'code-mode', 'device-rule'];
const effect = ids.effect('effect:authoring.test');
const capability = ids.capability('capability:authoring.test');

function evidence(scenario: AuthoringScenario, firstCheckAccepted: boolean): AgentAuthoringEvidence {
  return {
    scenario,
    bundleSchema: { major: 1, minor: 0, patch: 0 },
    firstCheckAccepted,
    diagnostics: firstCheckAccepted ? [] : [{ turn: 0, codes: ['SS_TYPE_MISMATCH'], categories: ['types'] }],
    repairTurns: firstCheckAccepted ? 0 : 1,
    finalAccepted: true,
    semanticallyCorrect: true,
    expectedEffects: [effect],
    actualEffects: [effect],
    expectedCapabilities: [capability],
    actualCapabilities: [capability],
    resourceBehavior: 'within-limits',
    privateCompilerKnowledgeUsed: false,
  };
}

describe('agent authoring usability gate', () => {
  it('retains the exact blind-run sources recorded by the release evidence', () => {
    expect(new Bun.CryptoHasher('sha256').update(blindApplicationExtensionReference.source).digest('hex')).toBe(
      '09f749ff2fd05922135c1e411067742b1c665c1bfae9322fc9ae6e805a757d8f',
    );
    expect(new Bun.CryptoHasher('sha256').update(blindDeviceRuleReference.source).digest('hex')).toBe(
      '53f6a18c9c055f2707c96bb746ea2077c4bafc6ead1e61925d10dbb6c1646b61',
    );
  });

  it('passes the explicit four-scenario baseline thresholds', () => {
    const result = evaluateAuthoringGate(scenarios.map((scenario, index) => evidence(scenario, index < 2)));
    expect(result.passed).toBe(true);
    expect(result.metrics.firstCheckRate).toBe(0.5);
    expect(result.metrics.finalAcceptanceRate).toBe(1);
  });

  it('attributes actionable failures to the bundle or language surface', () => {
    const runs = scenarios.map((scenario) => evidence(scenario, true));
    const [first, second, third, fourth] = runs;
    if (!first || !second || !third || !fourth) throw new Error('missing authoring scenario');
    const result = evaluateAuthoringGate([
      { ...first, finalAccepted: false, diagnostics: [] },
      { ...second, semanticallyCorrect: false },
      { ...third, actualCapabilities: [] },
      { ...fourth, repairTurns: 3 },
    ]);
    expect(result.passed).toBe(false);
    expect(new Set(result.failures.map(({ owner }) => owner))).toEqual(
      new Set(['declarations', 'examples-guide', 'language', 'compiler-diagnostics']),
    );
  });

  it('recomputes the remediated blind-run baseline as release-ready evidence', async () => {
    const baseline = (await Bun.file(new URL('../evidence/agent-authoring-baseline.json', import.meta.url)).json()) as {
      readonly thresholds: AuthoringGateThresholds;
      readonly runs: readonly Omit<AgentAuthoringEvidence, 'bundleSchema'>[];
    };
    const result = evaluateAuthoringGate(
      baseline.runs.map((run) => ({ ...run, bundleSchema: { major: 1, minor: 0, patch: 0 } })),
      baseline.thresholds,
    );
    expect(result.passed).toBe(true);
    expect(result.metrics).toEqual({
      firstCheckRate: 1,
      finalAcceptanceRate: 1,
      semanticCorrectnessRate: 1,
      summaryAccuracyRate: 1,
      maximumRepairTurns: 0,
      unexpectedResourceFailures: 0,
    });
  });
});
