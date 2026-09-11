/** Project identity is organizational metadata, never an execution address. */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly folders: readonly string[];
  readonly primaryFolder: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectMembership {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly revision: number;
}

/** Immutable provenance sampled from Project membership at task admission. */
export interface ProjectExecutionDefault {
  readonly projectId: string | null;
  readonly revision: number;
  readonly path: string | null;
}

export interface ProjectInspectRequest { readonly threadIds?: readonly string[] }
export interface ProjectCatalogView {
  readonly projects: readonly Project[];
  readonly memberships: readonly ProjectMembership[];
  readonly unavailableFolders: readonly string[];
  readonly applicationDefault: { readonly path: string | null; readonly available: boolean };
}
export type ProjectManageRequest =
  | { readonly operation: 'create'; readonly name: string; readonly folders: readonly string[]; readonly primaryFolder: string | null }
  | { readonly operation: 'update'; readonly projectId: string; readonly expectedRevision: number;
      readonly name: string; readonly folders: readonly string[]; readonly primaryFolder: string | null }
  | { readonly operation: 'bind'; readonly threadId: string; readonly projectId: string | null;
      readonly expectedRevision: number | null; readonly expectedMembershipRevision: number }
  | { readonly operation: 'delete'; readonly projectId: string; readonly expectedRevision: number };
export interface ProjectManageResult {
  readonly outcome: 'applied';
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
  const entry = record(value, ['operation', 'name', 'folders', 'primaryFolder', 'projectId', 'threadId', 'expectedRevision', 'expectedMembershipRevision']);
  switch (entry.operation) {
    case 'create':
      record(entry, ['operation', 'name', 'folders', 'primaryFolder']);
      return { operation: 'create', name: label(entry.name), ...decodeFolders(entry) };
    case 'update':
      record(entry, ['operation', 'name', 'folders', 'primaryFolder', 'projectId', 'expectedRevision']);
      return { operation: 'update', projectId: id(entry.projectId), expectedRevision: integer(entry.expectedRevision, 1),
        name: label(entry.name), ...decodeFolders(entry) };
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
  const entry = record(value, ['id', 'name', 'folders', 'primaryFolder', 'revision', 'createdAt', 'updatedAt']);
  return Object.freeze({ id: id(entry.id), name: label(entry.name), ...decodeFolders(entry),
    revision: integer(entry.revision, 1), createdAt: integer(entry.createdAt, 0), updatedAt: integer(entry.updatedAt, 0) });
}

export function decodeProjectCatalogView(value: unknown): ProjectCatalogView {
  const entry = record(value, ['projects', 'memberships', 'unavailableFolders', 'applicationDefault']);
  return { projects: array(entry.projects, decodeProject, 1_000), memberships: array(entry.memberships, (value) => {
    const membership = record(value, ['threadId', 'projectId', 'revision']);
    return { threadId: id(membership.threadId), projectId: membership.projectId === null ? null : id(membership.projectId),
      revision: integer(membership.revision, 0) };
  }, 200),
    unavailableFolders: array(entry.unavailableFolders, requiredRoot, 20_200),
    applicationDefault: decodeApplicationDefault(entry.applicationDefault) };
}

export function decodeProjectManageResult(value: unknown): ProjectManageResult {
  const entry = record(value, ['outcome', 'project', 'affectedThreadIds']);
  if (entry.outcome !== 'applied') throw new Error('Invalid Project outcome');
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
  if (typeof value !== 'string' || !/^(?:\/|[A-Za-z]:[\\/])/u.test(value) || value.includes('\0') || value.length > 4_096) throw new Error('Work folder must be an absolute directory');
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

export function decodeProjectExecutionDefault(value: unknown): ProjectExecutionDefault {
  const entry = record(value, ['projectId', 'path', 'revision']);
  const projectId = entry.projectId === null ? null : id(entry.projectId);
  const revision = integer(entry.revision, projectId === null ? 0 : 1);
  const path = root(entry.path);
  if (projectId === null && (revision !== 0 || path !== null)) throw new Error('Invalid application default provenance');
  return { projectId, path, revision };
}
function requiredRoot(value: unknown): string {
  const path = root(value);
  if (path === null) throw new Error('Folder path is required');
  return path;
}
function decodeFolders(entry: Record<string, unknown>): { folders: readonly string[]; primaryFolder: string | null } {
  const folders = array(entry.folders, requiredRoot, 20);
  const primaryFolder = root(entry.primaryFolder);
  if (new Set(folders).size !== folders.length) throw new Error('Duplicate Project folders');
  if (folders.length ? primaryFolder === null || !folders.includes(primaryFolder) : primaryFolder !== null) {
    throw new Error('A nonempty Project must have exactly one explicit primary folder');
  }
  return { folders: Object.freeze(folders), primaryFolder };
}
function decodeApplicationDefault(value: unknown): ProjectCatalogView['applicationDefault'] {
  const entry = record(value, ['path', 'available']);
  if (typeof entry.available !== 'boolean' || (entry.available && entry.path === null)) throw new Error('Invalid default folder availability');
  return { path: root(entry.path), available: entry.available };
}

export function decodeProjectFolderPick(value: unknown): { paths: readonly string[] } {
  const entry = record(value, ['paths']);
  return { paths: Object.freeze(array(entry.paths, requiredRoot, 1_000)) };
}
