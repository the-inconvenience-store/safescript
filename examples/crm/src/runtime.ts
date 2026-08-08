import { ids, type ExecutionLimits, type OperationId, type SemanticGraph } from '@safescript/contracts';
import { createSafeScript } from '@safescript/sdk';

import type { CrmActionInput } from './actions.js';
import { AUTOMATIONS, type AutomationExample } from './automations.js';
import { crmContract, type AutomationEvent, type AutomationResult } from './contract.js';
import { type CrmMutationKind } from './crm/model.js';
import { CrmStore } from './crm/store.js';
import { projectNodeEditor } from './graph/project.js';
import { renderDashboard, type DashboardAutomation } from './web/dashboard.js';

export interface CrmInvocationContext {
  readonly actorId: string;
  readonly workspaceIds: readonly string[];
  readonly deniedOperations?: readonly OperationId[];
}

const operationKinds: Readonly<Record<keyof typeof crmContract.operations, CrmMutationKind>> = {
  updateDealStage: 'deal-stage',
  addContactTag: 'contact-tag',
  createTask: 'task',
  createNote: 'note',
  assignOwner: 'owner',
  sendNotification: 'notification',
  scheduleFollowup: 'followup',
  recordAudit: 'audit',
};

const dashboardEvent = (event: AutomationEvent): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(event).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]),
    ),
  );

function decodeGraph(bytes: readonly number[]): SemanticGraph {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as SemanticGraph;
}

export interface CrmOptions {
  /** Test-only untrusted host seam used to prove malformed outcomes fail closed. */
  readonly mapHandlerResult?: (operation: keyof typeof crmContract.operations, result: unknown) => unknown;
}

export function createCrm(store = new CrmStore(), options: CrmOptions = {}) {
  let invocation = 0;
  const handler =
    (operation: keyof typeof crmContract.operations, kind: CrmMutationKind) => (input: CrmActionInput) => {
      const result = { tag: 'ok' as const, value: { id: store.apply(kind, input) } };
      return options.mapHandlerResult?.(operation, result) ?? result;
    };
  const handlers = Object.fromEntries(
    (Object.entries(operationKinds) as [keyof typeof operationKinds, CrmMutationKind][]).map(([key, kind]) => [
      key,
      handler(key, kind),
    ]),
  ) as unknown as Parameters<
    typeof createSafeScript<CrmInvocationContext, typeof crmContract.operations, typeof crmContract.slots>
  >[0]['handlers'];
  const safe = createSafeScript({
    contract: crmContract,
    handlers,
    authorise: ({ context, request, resourceScope }) =>
      context.workspaceIds.includes(resourceScope.workspaceId ?? '') &&
      !context.deniedOperations?.includes(request.operationId)
        ? { status: 'allowed' as const }
        : {
            status: 'rejected' as const,
            error: { code: 'crm_forbidden', detail: `actor ${context.actorId} cannot access this CRM resource` },
          },
    createInvocationId: () => ids.invocation(`invocation:${(++invocation).toString(16).padStart(32, '0')}`),
  });

  const context: CrmInvocationContext = Object.freeze({
    actorId: 'crm-admin',
    workspaceIds: Object.freeze(['workspace-acme']),
  });

  return {
    store,
    safe,
    context,
    async inspect(automation: AutomationExample): Promise<SemanticGraph> {
      const result = await safe.inspect({ slot: 'automation', source: automation.source, views: ['semantic_graph'] });
      if (result.status !== 'accepted' || !result.views.semantic_graph) {
        throw new Error(`automation ${automation.id} did not produce a semantic graph: ${result.status}`);
      }
      return decodeGraph(result.views.semantic_graph);
    },
    async run(
      automation: AutomationExample,
      options: Readonly<{
        context?: CrmInvocationContext;
        input?: AutomationEvent;
        limits?: Partial<ExecutionLimits>;
      }> = {},
    ) {
      return safe.execute({
        slot: 'automation',
        program: { kind: 'source', source: automation.source },
        input: options.input ?? automation.input,
        context: options.context ?? context,
        idempotencySeed: [...new TextEncoder().encode(`crm-example:${automation.id}:${invocation}`)],
        fixedInstant: { epochSeconds: 1_786_060_800n, nanoseconds: 0 },
        randomSeed: [1, 2, 3, 4],
        trace: 'semantic',
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
    },
    async render(): Promise<string> {
      const automations: DashboardAutomation[] = [];
      for (const automation of AUTOMATIONS) {
        const graph = await this.inspect(automation);
        automations.push({
          id: automation.id,
          name: automation.name,
          description: automation.description,
          event: dashboardEvent(automation.input),
          source: automation.source.modules[0]?.source ?? '',
          sourceHash: graph.sourceHash,
          editor: projectNodeEditor(graph),
        });
      }
      return renderDashboard(automations, store.snapshot());
    },
    async runAll(): Promise<readonly AutomationResult[]> {
      const outputs: AutomationResult[] = [];
      for (const automation of AUTOMATIONS) {
        const result = await this.run(automation);
        if (result.status !== 'completed') throw new Error(`${automation.id} execution ${result.status}`);
        outputs.push(result.output);
      }
      return outputs;
    },
  };
}
