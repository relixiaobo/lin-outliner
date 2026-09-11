import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import {
  decodeProjectInspectRequest, decodeProjectManageRequest,
  type ProjectCatalogView, type ProjectManageResult, type ProjectManageRequest,
} from '../../../core/agent/project';
import type { Thread } from '../../../core/agent/protocol';
import { ProjectCatalogStore } from '../persistence/ProjectCatalogStore';
import { Mutex } from '../Mutex';

export interface ProjectReview {
  readonly request: ProjectManageRequest;
  readonly project: import('../../../core/agent/project').Project | null;
  readonly threadName: string | null;
  readonly currentWorkFolder: string | null;
}

export interface ProjectAutomationLifecycle {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  reconcileAcceptedClaims(): Promise<void>;
  references(projectId: string): readonly string[];
}

export class ProjectService {
  private readonly mutex = new Mutex();
  private automation: ProjectAutomationLifecycle | null = null;

  constructor(
    readonly store: ProjectCatalogStore,
    private readonly readThread: (id: string) => Thread | null,
    private readonly now: () => number = Date.now,
    private readonly applicationDirectory: () => string = homedir,
    private readonly changed: () => void = () => {},
  ) {}

  attachAutomation(lifecycle: ProjectAutomationLifecycle): void {
    if (this.automation) throw new Error('Project Automation lifecycle is already attached');
    this.automation = lifecycle;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.automation ? this.automation.runExclusive(operation) : this.mutex.run(operation);
  }
  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      for (const id of this.store.deletionIntents()) {
        try { await this.finishDeletion(id); }
        catch (error) { if (!(error instanceof ProjectDeletionBlockedError)) throw error; }
      }
    });
  }
  async inspect(raw: unknown): Promise<ProjectCatalogView> {
    const request = decodeProjectInspectRequest(raw);
    return this.buildView(this.store.list(), request.threadIds ?? []);
  }
  async currentContext(threadId: string): Promise<ProjectCatalogView> {
    const membership = this.store.membership(threadId);
    const project = membership.projectId ? this.store.read(membership.projectId) : null;
    return this.buildView(project ? [project] : [], [threadId]);
  }
  private async buildView(projects: ProjectCatalogView['projects'], threadIds: readonly string[]): Promise<ProjectCatalogView> {
    const memberships = threadIds.map((id) => { this.requireRoot(id); return this.store.membership(id); });
    const workFolders = threadIds.map((id) => this.store.workFolder(id));
    const paths = [...new Set([...projects.flatMap((p) => p.folders), ...workFolders.flatMap((f) => f.path ? [f.path] : [])])];
    const unavailableFolders = (await Promise.all(paths.map(async (path) => await directoryAvailable(path) ? [] : [path]))).flat();
    let applicationDefault: ProjectCatalogView['applicationDefault'];
    try {
      const path = await realpath(this.applicationDirectory());
      applicationDefault = { path, available: await directoryAvailable(path) };
    } catch { applicationDefault = { path: null, available: false }; }
    return { projects, memberships, workFolders, unavailableFolders, applicationDefault };
  }
  proposal(request: ProjectManageRequest): ProjectReview {
    const project = 'projectId' in request && request.projectId ? this.store.require(request.projectId, request.expectedRevision ?? undefined) : null;
    const thread = 'threadId' in request ? this.requireRoot(request.threadId) : null;
    return { request, project, threadName: thread ? thread.name || thread.preview || thread.id : null,
      currentWorkFolder: thread ? this.store.workFolder(thread.id).path : null };
  }
  async manage(raw: unknown, signal?: AbortSignal,
    confirm?: (request: ProjectManageRequest) => Promise<boolean>,
    receipt?: { sourceThreadId: string; operationId: string; digest: string },
    beforeCommit?: () => Promise<void>,
  ): Promise<ProjectManageResult> {
    let request = decodeProjectManageRequest(raw);
    if (receipt) {
      const previous = this.store.receipt(receipt.sourceThreadId, receipt.operationId, receipt.digest);
      if (previous) return previous;
    }
    signal?.throwIfAborted();
    const witnesses = new Map<string, string>();
    const canonicalize = async (path: string | null): Promise<string | null> => {
      if (path === null) return null;
      const canonical = await realpath(path);
      witnesses.set(canonical, await directoryIdentity(canonical));
      return canonical;
    };
    if (request.operation === 'create' || request.operation === 'update') {
      const previous = request.operation === 'update' ? this.store.require(request.projectId, request.expectedRevision) : null;
      const paths = new Map<string, string>();
      for (const path of request.folders) {
        // Retaining an unavailable reference does not prevent unrelated Project edits.
        const canonical = previous?.folders.includes(path) && !await directoryAvailable(path)
          ? path : (await canonicalize(path))!;
        paths.set(path, canonical);
      }
      request = decodeProjectManageRequest({ ...request, folders: [...paths.values()],
        primaryFolder: request.primaryFolder === null ? null : paths.get(request.primaryFolder) });
    } else if (request.operation === 'setWorkFolder') {
      this.requireRoot(request.threadId);
      request = { ...request, path: await canonicalize(request.path) };
    } else if (request.operation === 'bind' && request.workFolder) {
      request = { ...request, workFolder: { ...request.workFolder, path: await canonicalize(request.workFolder.path) } };
    }
    if (confirm && !await confirm(request)) throw new Error('Project proposal cancelled; no change was committed');
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      for (const [path, identity] of witnesses) {
        if (await directoryIdentity(path) !== identity) throw new Error('Directory changed during proposal; inspect it again');
      }
      await beforeCommit?.();
      signal?.throwIfAborted();
      if (receipt) {
        const previous = this.store.receipt(receipt.sourceThreadId, receipt.operationId, receipt.digest);
        if (previous) return previous;
      }
      if (request.operation === 'delete') {
        this.store.beginDeletion(request.projectId, request.expectedRevision, receipt);
        try { await this.automation?.reconcileAcceptedClaims(); }
        catch (error) { if (signal?.aborted) this.store.cancelDeletion(request.projectId); throw error; }
        if (signal?.aborted) { this.store.cancelDeletion(request.projectId); signal.throwIfAborted(); }
        try { await beforeCommit?.(); }
        catch (error) { this.store.cancelDeletion(request.projectId); throw error; }
        const references = this.automation?.references(request.projectId) ?? [];
        if (references.length) {
          this.store.cancelDeletion(request.projectId);
          throw new ProjectDeletionBlockedError(`Project is still used by Automations or pending runs: ${references.join(', ')}`);
        }
      }
      signal?.throwIfAborted();
      const result = this.store.withReceipt(receipt, (): ProjectManageResult => {
      if (request.operation === 'create' || request.operation === 'update') {
        const saved = request.operation === 'create'
          ? this.store.create(request.name, request.folders, request.primaryFolder, this.now())
          : this.store.update(request.projectId, request.expectedRevision, request.name, request.folders, request.primaryFolder, this.now());
        return { outcome: 'applied', project: saved, affectedThreadIds: [] };
      } else if (request.operation === 'setWorkFolder') {
        this.requireRoot(request.threadId);
        this.store.setWorkFolder(request.threadId, request.path, request.expectedRevision);
        return { outcome: 'applied', project: null, affectedThreadIds: [request.threadId] };
      } else if (request.operation === 'bind') {
        this.requireRoot(request.threadId);
        const affectedThreadIds = this.store.bind(request.threadId, request.projectId,
          request.expectedRevision, request.expectedMembershipRevision, request.workFolder);
        return { outcome: 'applied', project: request.projectId ? this.store.require(request.projectId) : null, affectedThreadIds };
      } else {
        return { outcome: 'applied', project: null, affectedThreadIds: this.store.finishDeletion(request.projectId) };
      }
      });
      // Observers cannot turn a committed write into a failed operation.
      try { this.changed(); } catch (error) { console.warn('[projects] Change notification failed', error); }
      return result;
    });
  }
  private async finishDeletion(projectId: string): Promise<readonly string[]> {
    await this.automation?.reconcileAcceptedClaims();
    const references = this.automation?.references(projectId) ?? [];
    if (references.length) {
      this.store.cancelDeletion(projectId);
      throw new ProjectDeletionBlockedError(`Project is still used by Automations or pending runs: ${references.join(', ')}`);
    }
    return this.store.finishDeletion(projectId);
  }
  private requireRoot(id: string): Thread {
    const thread = this.readThread(id);
    if (!thread || thread.ephemeral || thread.parentThreadId || thread.threadSource !== 'user') {
      throw new Error('Project membership requires a persistent user Chat');
    }
    return thread;
  }
}

class ProjectDeletionBlockedError extends Error {}

export async function directoryAvailable(path: string): Promise<boolean> {
  try { await directoryIdentity(path); return true; } catch { return false; }
}
async function directoryIdentity(path: string): Promise<string> {
  if (await realpath(path) !== path) throw new Error('Saved folder was redirected');
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error('Work folder must be a directory');
  return `${info.dev}:${info.ino}`;
}
