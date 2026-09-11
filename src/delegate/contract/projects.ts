import { decodeProjectManageRequest, type ProjectManageRequest } from '../../core/agent/project';

export type ProjectCliInput =
  | { readonly action: 'inspect'; readonly offset: number; readonly catalogRevision?: string }
  | { readonly action: 'manage'; readonly operationId: string; readonly request: ProjectManageRequest }
  | { readonly action: 'receipt'; readonly operationId: string };

export function decodeProjectCliInput(value: unknown): ProjectCliInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project input must be an object');
  const entry = value as Record<string, unknown>;
  const keys = entry.action === 'inspect' ? ['action', 'offset', 'catalogRevision']
    : entry.action === 'manage' ? ['action', 'operationId', 'request'] : ['action', 'operationId'];
  if (Object.keys(entry).some((key) => !keys.includes(key))) throw new Error('Unknown Project input field');
  if (entry.action === 'inspect') {
    const offset = entry.offset ?? 0;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000) throw new Error('Invalid Project page offset');
    if (entry.catalogRevision !== undefined && (typeof entry.catalogRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.catalogRevision))) throw new Error('Invalid Project catalog revision');
    if (offset !== 0 && !entry.catalogRevision) throw new Error('Subsequent pages require the catalog revision');
    return { action: 'inspect', offset: offset as number, ...(entry.catalogRevision ? { catalogRevision: entry.catalogRevision as string } : {}) };
  }
  if (typeof entry.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(entry.operationId)) throw new Error('A stable operationId is required');
  if (entry.action === 'manage') return { action: 'manage', operationId: entry.operationId, request: decodeProjectManageRequest(entry.request) };
  if (entry.action === 'receipt') return { action: 'receipt', operationId: entry.operationId };
  throw new Error('Unknown Project action');
}
