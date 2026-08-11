import type { SemanticDiff, SemanticRevisionId } from '@safescript/contracts';

import type { SemanticIntent } from '../editor/operations.js';
import type { AcceptedBuildingDocument } from '../runtime.js';

export interface EditorResponse {
  readonly status: string;
  readonly document?: AcceptedBuildingDocument;
  readonly diagnostics?: readonly unknown[];
  readonly editDiagnostics?: readonly unknown[];
  readonly reason?: string;
  readonly diff?: SemanticDiff;
  readonly [key: string]: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = (await response.json()) as T;
  if (!response.ok) throw new Error(`SafeScript example API returned ${response.status}`);
  return value;
}

const post = <T>(path: string, value: unknown = {}): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });

export const editorApi = {
  open: () => request<AcceptedBuildingDocument>('/api/document'),
  source: (source: string) => post<EditorResponse>('/api/source', { source }),
  edit: (revision: SemanticRevisionId, intent: SemanticIntent) =>
    post<EditorResponse>('/api/edit', { revision, intent }),
  history: (direction: 'undo' | 'redo') => post<AcceptedBuildingDocument>('/api/history', { direction }),
  check: () => post<Record<string, unknown>>('/api/check'),
  run: (limits?: Readonly<Record<string, number>>) => post<Record<string, unknown>>('/api/run', { limits }),
};
