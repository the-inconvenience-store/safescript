import type {
  Diagnostic,
  SemanticEditCapabilityManifest,
  SemanticEditId,
  SemanticEditLimits,
  SemanticGraph,
  SemanticRevisionId,
} from '@safescript/contracts';
import type { SafeScript, SourceProgram } from '@safescript/sdk';

import { buildingContract } from '../contract.js';
import { BUILDING_SOURCE } from '../fixtures.js';
import { decodeEditorViews, EDITOR_VIEWS } from '../semantic/inspection.js';
import { translateSemanticIntent, type SemanticIntent } from './operations.js';
import { projectSemanticEditor, type BuildingFlow } from './projection.js';
import { reconcileSemanticFlow } from './reconcile.js';

export interface AcceptedBuildingDocument {
  readonly acceptedSource: SourceProgram;
  readonly graph: SemanticGraph;
  readonly capabilities: SemanticEditCapabilityManifest;
  readonly flow: BuildingFlow;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

type DocumentSdk = Pick<
  SafeScript<typeof buildingContract.operations, typeof buildingContract.slots, never>,
  'inspect' | 'applySemanticEdits'
>;

export function createBuildingDocumentController(safe: DocumentSdk) {
  let document: AcceptedBuildingDocument | undefined;
  let editSequence = 0;
  let history: SourceProgram[] = [];
  let historyIndex = -1;

  const historyFlags = <T extends Omit<AcceptedBuildingDocument, 'canUndo' | 'canRedo'>>(value: T) => ({
    ...value,
    canUndo: historyIndex > 0,
    canRedo: historyIndex >= 0 && historyIndex < history.length - 1,
  });
  const remember = (source: SourceProgram) => {
    history = [...history.slice(0, historyIndex + 1), source];
    historyIndex = history.length - 1;
  };
  const inspectSource = async (source: SourceProgram) => {
    const inspected = await safe.inspect({ slot: 'automation', source, views: EDITOR_VIEWS });
    if (inspected.status !== 'accepted') return inspected;
    const { graph, capabilities } = decodeEditorViews(inspected.views);
    return {
      status: 'accepted' as const,
      document: historyFlags({
        acceptedSource: source,
        graph,
        capabilities,
        flow: projectSemanticEditor(graph, capabilities, source.source),
      }),
    };
  };

  return {
    async open(source = BUILDING_SOURCE): Promise<AcceptedBuildingDocument> {
      const inspected = await inspectSource(source);
      if (inspected.status !== 'accepted') throw new Error(`building source inspection ${inspected.status}`);
      history = [source];
      historyIndex = 0;
      document = historyFlags(inspected.document);
      return document;
    },
    async submitSource(source: string): Promise<
      | Readonly<{ status: 'accepted'; document: AcceptedBuildingDocument }>
      | Readonly<{
          status: 'rejected' | 'bridge_error';
          document: AcceptedBuildingDocument;
          diagnostics: readonly Diagnostic[];
        }>
    > {
      if (!document) throw new Error('building editor is not open');
      const candidate: SourceProgram = { moduleId: document.acceptedSource.moduleId, source };
      const inspected = await inspectSource(candidate);
      if (inspected.status === 'accepted') {
        remember(candidate);
        document = historyFlags({
          ...inspected.document,
          flow: reconcileSemanticFlow(document.flow, inspected.document.flow),
        });
        return { status: 'accepted', document };
      }
      return {
        status: inspected.status,
        document,
        diagnostics: inspected.status === 'rejected' ? inspected.diagnostics : [],
      };
    },
    async applyIntent(
      intent: SemanticIntent,
      baseRevision: SemanticRevisionId,
      editLimits?: Partial<SemanticEditLimits>,
    ) {
      if (!document) throw new Error('building editor is not open');
      const editId = `edit:building-${++editSequence}` as SemanticEditId;
      const edit = translateSemanticIntent(document.graph, document.capabilities, intent, editId);
      const result = await safe.applySemanticEdits({
        slot: 'automation',
        source: document.acceptedSource,
        baseRevision,
        edits: [edit],
        ...(editLimits === undefined ? {} : { editLimits }),
      });
      if (result.status !== 'accepted') return { ...result, document };
      const acceptedSource: SourceProgram = {
        moduleId: result.source.module,
        source: new TextDecoder().decode(Uint8Array.from(result.source.source)),
      };
      const inspected = await inspectSource(acceptedSource);
      if (inspected.status !== 'accepted') throw new Error('accepted semantic edit did not re-inspect');
      remember(acceptedSource);
      document = historyFlags({
        ...inspected.document,
        flow: reconcileSemanticFlow(document.flow, inspected.document.flow, result.diff),
      });
      return { ...result, document };
    },
    async undo(): Promise<AcceptedBuildingDocument> {
      if (!document || historyIndex <= 0) throw new Error('no accepted source revision to undo');
      historyIndex -= 1;
      const source = history[historyIndex];
      if (!source) throw new Error('undo history is inconsistent');
      const inspected = await inspectSource(source);
      if (inspected.status !== 'accepted') throw new Error('retained undo source no longer inspects');
      document = historyFlags({
        ...inspected.document,
        flow: reconcileSemanticFlow(document.flow, inspected.document.flow),
      });
      return document;
    },
    async redo(): Promise<AcceptedBuildingDocument> {
      if (!document || historyIndex >= history.length - 1) throw new Error('no accepted source revision to redo');
      historyIndex += 1;
      const source = history[historyIndex];
      if (!source) throw new Error('redo history is inconsistent');
      const inspected = await inspectSource(source);
      if (inspected.status !== 'accepted') throw new Error('retained redo source no longer inspects');
      document = historyFlags({
        ...inspected.document,
        flow: reconcileSemanticFlow(document.flow, inspected.document.flow),
      });
      return document;
    },
    current(): AcceptedBuildingDocument {
      if (!document) throw new Error('building editor is not open');
      return document;
    },
  };
}
