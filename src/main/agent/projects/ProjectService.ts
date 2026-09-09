import { realpath, stat } from 'node:fs/promises';
import {
  decodeProjectInspectRequest, decodeProjectManageRequest,
  type ProjectCatalogView, type ProjectManageResult,
} from '../../../core/agent/project';
import type { Thread } from '../../../core/agent/protocol';
import { ProjectCatalogStore } from '../persistence/ProjectCatalogStore';
import { Mutex } from '../Mutex';

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
  inspect(raw: unknown): ProjectCatalogView {
    const request = decodeProjectInspectRequest(raw);
    return { projects: this.store.list(), memberships: (request.threadIds ?? []).map((id) => {
      this.requireRoot(id);
      return this.store.membership(id);
    }) };
  }
  async manage(raw: unknown, signal?: AbortSignal): Promise<ProjectManageResult> {
    let request = decodeProjectManageRequest(raw);
    signal?.throwIfAborted();
    // Canonicalize now, then revalidate inside the lifecycle lock before writing.
    if (request.operation === 'create' || request.operation === 'update') {
      request = { ...request, rootHint: await canonicalRoot(request.rootHint) };
    }
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      if (request.operation === 'create' || request.operation === 'update') {
        if (await canonicalRoot(request.rootHint) !== request.rootHint) throw new Error('Project directory changed during update');
        signal?.throwIfAborted();
        const saved = request.operation === 'create'
          ? this.store.create(request.name, request.rootHint, this.now())
          : this.store.update(request.projectId, request.expectedRevision, request.name, request.rootHint, this.now());
        return { outcome: 'applied', project: saved, affectedThreadIds: [] };
      }
      if (request.operation === 'bind') {
        this.requireRoot(request.threadId);
        const affectedThreadIds = this.store.bind(request.threadId, request.projectId,
          request.expectedRevision, request.expectedMembershipRevision);
        return { outcome: 'applied', project: request.projectId ? this.store.require(request.projectId) : null, affectedThreadIds };
      }
      this.store.beginDeletion(request.projectId, request.expectedRevision);
      return { outcome: 'applied', project: null, affectedThreadIds: await this.finishDeletion(request.projectId) };
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

async function canonicalRoot(root: string | null): Promise<string | null> {
  if (root === null) return null;
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Project root hint must be a directory');
  return canonical;
}
