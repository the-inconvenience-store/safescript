import type { SemanticEditCapabilityManifest, SemanticGraph } from '@safescript/contracts';

import type { SemanticIntent } from './operations.js';
import type { BuildingFlow, BuildingFlowNode } from './projection.js';

interface ComposableDocument {
  readonly acceptedSource: Readonly<{ source: string }>;
  readonly graph: SemanticGraph;
  readonly capabilities: SemanticEditCapabilityManifest;
  readonly flow: BuildingFlow;
}

export interface BuildingStepTemplate {
  readonly id: 'calculation' | 'humidity-alert';
  readonly label: string;
  readonly description: string;
  readonly intent: SemanticIntent;
}

function availableName(source: string, base: string): string {
  if (!new RegExp(`\\b${base}\\b`).test(source)) return base;
  let suffix = 2;
  while (new RegExp(`\\b${base}${suffix}\\b`).test(source)) suffix += 1;
  return `${base}${suffix}`;
}

/** Curated source fragments are UI conveniences; the advertised insert capability remains the authority. */
export function buildingStepTemplates(document: ComposableDocument): readonly BuildingStepTemplate[] {
  const composer = document.flow.composer;
  const insertion = composer?.controls.find(
    ({ operation, capability }) =>
      operation === 'insert_at_anchor' &&
      capability.fragmentCategories.includes('statement') &&
      capability.anchors.some(
        ({ container, index }) => container === composer.container && index === composer.insertionIndex,
      ),
  );
  if (!composer || !insertion) return [];
  const humidityLimit = availableName(document.acceptedSource.source, 'humidityLimit');
  const humidityAlert = availableName(document.acceptedSource.source, 'humidityAlert');
  const atEnd = (source: string): SemanticIntent => ({
    kind: 'insert_statement',
    container: composer.container,
    index: composer.insertionIndex,
    source,
  });
  return [
    {
      id: 'calculation',
      label: 'Calculation',
      description: 'Add a reusable humidity threshold.',
      intent: atEnd(`const ${humidityLimit} = 70n`),
    },
    {
      id: 'humidity-alert',
      label: 'Humidity alert rule',
      description: 'Branch on humidity and request a host alert.',
      intent: atEnd(`if (event.humidityPercent > 70n) {
    const ${humidityAlert} = await ctx.alerts.send({
      buildingId: event.buildingId,
      zoneId: event.zoneId,
      value: "high humidity",
    })
    if (${humidityAlert}.tag === "error") return Err(${humidityAlert}.value)
  }`),
    },
  ];
}

export function moveBuildingStep(
  document: ComposableDocument,
  node: BuildingFlowNode,
  direction: 'earlier' | 'later',
): SemanticIntent | undefined {
  const composer = document.flow.composer;
  const statement = node.statementId;
  if (!composer || !statement) return undefined;
  const currentIndex = composer.children.indexOf(statement);
  if (currentIndex < 0) return undefined;
  const destinationIndex = direction === 'earlier' ? currentIndex - 1 : currentIndex + 2;
  if (destinationIndex < 0 || destinationIndex > composer.insertionIndex) return undefined;
  if (direction === 'later' && currentIndex + 1 >= composer.insertionIndex) return undefined;
  const move = composer.controls.find(({ operation }) => operation === 'move_statement_range');
  const destination = move?.capability.anchors.find(
    ({ container, index }) => container === composer.container && index === destinationIndex,
  );
  if (!destination) return undefined;
  return {
    kind: 'move_statement_range',
    container: composer.container,
    first: statement,
    last: statement,
    destination,
  };
}
