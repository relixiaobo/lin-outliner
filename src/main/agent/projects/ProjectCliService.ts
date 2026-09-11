import { createHash } from 'node:crypto';
import { decodeProjectCliInput } from '../../../delegate/contract/projects';
import type { DelegateCapabilityExecution } from '../delegation/DelegateCapabilityBroker';
import type { ProjectService } from './ProjectService';
import type { ProjectManageRequest } from '../../../core/agent/project';

export const PROJECT_CLI_CONFIGURATION_REVISION = 'project-host-v1';
export function projectCliScheduling() {
  return {
    scheduling: { pool: 'project-host', configurationRevision: PROJECT_CLI_CONFIGURATION_REVISION, maxConcurrentProducer: 4, maxConcurrentPool: 4 },
    schedulerLimits: { maxConcurrentGlobal: 16, maxConcurrentThread: 4, maxQueuedGlobal: 64, maxQueuedThread: 16 },
    timeoutMs: 120_000,
  };
}

/** The invocation-bound broker is the transport; the Project service remains the owner. */
export class ProjectCliService {
  private readonly pending = new Set<string>();
  constructor(private readonly projects: ProjectService,
    private readonly authorize: (execution: DelegateCapabilityExecution) => Promise<void>,
    private readonly confirm: (request: ProjectManageRequest, signal: AbortSignal) => Promise<boolean>,
  ) {}

  async execute(execution: DelegateCapabilityExecution): Promise<unknown> {
    const { admission, signal } = execution;
    await this.authorize(execution);
    signal.throwIfAborted();
    const input = decodeProjectCliInput(JSON.parse(admission.stdin));
    const threadId = admission.source.rootThreadId;
    if (input.action === 'inspect') {
      const view = await this.projects.inspect({ threadIds: [threadId] });
      const catalogRevision = digest(view.projects);
      if (input.catalogRevision && input.catalogRevision !== catalogRevision) throw new Error('Project catalog changed; restart inspection at offset 0');
      const projects = view.projects.slice(input.offset, input.offset + 50);
      const selected = view.projects.find((project) => project.id === view.memberships[0]?.projectId) ?? null;
      return { ...view, projects, selectedProject: selected, catalogRevision, totalProjects: view.projects.length,
        unavailableFolders: view.unavailableFolders.filter((path) => projects.some((p) => p.folders.includes(path))
          || selected?.folders.includes(path) || path === view.workFolders[0]?.path),
        nextOffset: input.offset + 50 < view.projects.length ? input.offset + 50 : null };
    }
    const key = `${threadId}:${input.operationId}`;
    if (input.action === 'receipt') {
      const result = this.projects.store.receipt(threadId, input.operationId);
      return result ? { outcome: 'applied', result }
        : { outcome: this.pending.has(key) || this.projects.store.receiptPending(threadId, input.operationId) ? 'pending' : 'not_committed' };
    }
    const request = input.request;
    const receipt = { sourceThreadId: threadId, operationId: input.operationId, digest: digest(request) };
    const existing = this.projects.store.receipt(threadId, input.operationId, receipt.digest);
    if (existing) return { operationId: input.operationId, ...existing };
    if (this.pending.has(key) || this.projects.store.receiptPending(threadId, input.operationId, receipt.digest)) {
      throw new Error('Project operation is pending; inspect its receipt before retrying');
    }
    this.pending.add(key);
    try {
      const result = await this.projects.manage(request, signal, request.operation === 'setWorkFolder' ? undefined : async (prepared) => {
        const accepted = await this.confirm(prepared, signal);
        if (accepted) await this.authorize(execution);
        return accepted;
      }, receipt, () => this.authorize(execution));
      return { operationId: input.operationId, ...result };
    } finally { this.pending.delete(key); }
  }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
