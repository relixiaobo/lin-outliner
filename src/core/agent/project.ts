/** Project identity is organizational metadata, never an execution address. */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly rootHint: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectMembership {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly revision: number;
}

export interface ProjectInspectRequest { readonly threadIds?: readonly string[] }
export interface ProjectCatalogView {
  readonly projects: readonly Project[];
  readonly memberships: readonly ProjectMembership[];
}
export type ProjectManageRequest =
  | { readonly operation: 'create'; readonly name: string; readonly rootHint: string | null }
  | { readonly operation: 'update'; readonly projectId: string; readonly expectedRevision: number;
      readonly name: string; readonly rootHint: string | null }
  | { readonly operation: 'bind'; readonly threadId: string; readonly projectId: string | null;
      readonly expectedRevision: number | null; readonly expectedMembershipRevision: number }
  | { readonly operation: 'delete'; readonly projectId: string; readonly expectedRevision: number };
export interface ProjectManageResult {
  readonly outcome: 'applied' | 'cancelled';
  readonly project: Project | null;
  readonly affectedThreadIds: readonly string[];
}

export function decodeProjectInspectRequest(value: unknown): ProjectInspectRequest {
  const entry = record(value, ['threadIds']);
  return entry.threadIds === undefined ? {} : { threadIds: array(entry.threadIds, id, 200) };
}

export function decodeProjectSelection(value: unknown): { projectId: string; expectedRevision: number } {
  const entry = record(value, ['projectId', 'expectedRevision']);
  return { projectId: id(entry.projectId), expectedRevision: integer(entry.expectedRevision, 1) };
}

export function decodeProjectManageRequest(value: unknown): ProjectManageRequest {
  const entry = record(value, ['operation', 'name', 'rootHint', 'projectId', 'threadId', 'expectedRevision', 'expectedMembershipRevision']);
  switch (entry.operation) {
    case 'create':
      record(entry, ['operation', 'name', 'rootHint']);
      return { operation: 'create', name: label(entry.name), rootHint: root(entry.rootHint) };
    case 'update':
      record(entry, ['operation', 'name', 'rootHint', 'projectId', 'expectedRevision']);
      return { operation: 'update', projectId: id(entry.projectId), expectedRevision: integer(entry.expectedRevision, 1),
        name: label(entry.name), rootHint: root(entry.rootHint) };
    case 'bind':
      record(entry, ['operation', 'threadId', 'projectId', 'expectedRevision', 'expectedMembershipRevision']);
      if ((entry.projectId === null) !== (entry.expectedRevision === null)) throw new Error('Project binding revision must match its identity');
      return { operation: 'bind', threadId: id(entry.threadId), projectId: entry.projectId === null ? null : id(entry.projectId),
        expectedRevision: entry.expectedRevision === null ? null : integer(entry.expectedRevision, 1),
        expectedMembershipRevision: integer(entry.expectedMembershipRevision, 0) };
    case 'delete':
      record(entry, ['operation', 'projectId', 'expectedRevision']);
      return { operation: 'delete', projectId: id(entry.projectId), expectedRevision: integer(entry.expectedRevision, 1) };
    default: throw new Error('Unknown Project operation');
  }
}

export function decodeProject(value: unknown): Project {
  const entry = record(value, ['id', 'name', 'rootHint', 'revision', 'createdAt', 'updatedAt']);
  return Object.freeze({ id: id(entry.id), name: label(entry.name), rootHint: root(entry.rootHint),
    revision: integer(entry.revision, 1), createdAt: integer(entry.createdAt, 0), updatedAt: integer(entry.updatedAt, 0) });
}

export function decodeProjectCatalogView(value: unknown): ProjectCatalogView {
  const entry = record(value, ['projects', 'memberships']);
  return { projects: array(entry.projects, decodeProject, 1_000), memberships: array(entry.memberships, (value) => {
    const membership = record(value, ['threadId', 'projectId', 'revision']);
    return { threadId: id(membership.threadId), projectId: membership.projectId === null ? null : id(membership.projectId),
      revision: integer(membership.revision, 0) };
  }, 200) };
}

export function decodeProjectManageResult(value: unknown): ProjectManageResult {
  const entry = record(value, ['outcome', 'project', 'affectedThreadIds']);
  if (entry.outcome !== 'applied' && entry.outcome !== 'cancelled') throw new Error('Invalid Project outcome');
  return { outcome: entry.outcome, project: entry.project === null ? null : decodeProject(entry.project),
    affectedThreadIds: array(entry.affectedThreadIds, id, 100_000) };
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid Project record');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error('Invalid Project or Thread identity');
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) throw new Error('Invalid Project name');
  return value.trim();
}
function root(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:\/|[A-Za-z]:[\\/])/u.test(value) || value.includes('\0') || value.length > 4_096) throw new Error('Project root hint must be an absolute directory');
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid Project revision or timestamp');
  return value;
}
function array<T>(value: unknown, decode: (entry: unknown) => T, limit: number): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid Project list');
  return value.map(decode);
}
