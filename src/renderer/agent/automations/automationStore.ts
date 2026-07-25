import { useSyncExternalStore } from 'react';
import type {
  Automation,
  AutomationCreateInput,
  AutomationNotification,
  AutomationRun,
  AutomationStatus,
  AutomationUpdateInput,
} from '../../../core/agent/automation';
import { api } from '../../api/client';

export type AutomationStoreClient = Pick<typeof api, 'automationRequest' | 'onAutomationNotification'>;

export interface AutomationStoreSnapshot {
  readonly automations: readonly Automation[];
  readonly runs: readonly AutomationRun[];
  readonly selectedAutomationId: string | null;
  readonly statusFilter: AutomationStatus | 'all';
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_SNAPSHOT: AutomationStoreSnapshot = {
  automations: [],
  runs: [],
  selectedAutomationId: null,
  statusFilter: 'all',
  loading: true,
  error: null,
};

export class AutomationRendererStore {
  private snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private initializePromise: Promise<void> | null = null;
  private reloadGeneration = 0;
  private mutationVersion = 0;
  private readonly automationMutationVersions = new Map<string, number>();
  private readonly runMutationVersions = new Map<string, number>();
  private readonly automationDeletionVersions = new Map<string, number>();

  constructor(private readonly client: AutomationStoreClient = api) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AutomationStoreSnapshot => this.snapshot;

  initialize(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = this.client.onAutomationNotification((notification) => this.applyNotification(notification));
    }
    if (!this.initializePromise) this.initializePromise = this.reload();
    return this.initializePromise;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.initializePromise = null;
    this.reloadGeneration += 1;
  }

  async reload(): Promise<void> {
    const generation = ++this.reloadGeneration;
    const baselineMutationVersion = this.mutationVersion;
    this.patch({ loading: true, error: null });
    try {
      const [automations, runs] = await Promise.all([
        this.client.automationRequest('list', {}),
        this.client.automationRequest('runs', { limit: 200 }),
      ]);
      if (generation !== this.reloadGeneration) return;
      const mergedAutomations = this.mergeAutomationReload(automations.data, baselineMutationVersion);
      const mergedRuns = this.mergeRunReload(runs.data, baselineMutationVersion);
      const selectedAutomationId = this.snapshot.selectedAutomationId
        && mergedAutomations.some((automation) => automation.id === this.snapshot.selectedAutomationId)
        ? this.snapshot.selectedAutomationId
        : mergedAutomations[0]?.id ?? null;
      this.patch({
        automations: mergedAutomations,
        runs: mergedRuns,
        selectedAutomationId,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (generation !== this.reloadGeneration) return;
      this.patch({ loading: false, error: errorMessage(error) });
      throw error;
    }
  }

  select(id: string | null): void {
    this.patch({ selectedAutomationId: id });
  }

  setStatusFilter(statusFilter: AutomationStoreSnapshot['statusFilter']): void {
    this.patch({ statusFilter });
  }

  async create(input: AutomationCreateInput): Promise<Automation> {
    const response = await this.client.automationRequest('create', input);
    this.upsertAutomation(response.automation);
    this.patch({ selectedAutomationId: response.automation.id });
    return response.automation;
  }

  async update(input: AutomationUpdateInput): Promise<Automation> {
    const response = await this.client.automationRequest('update', input);
    this.upsertAutomation(response.automation);
    return response.automation;
  }

  async pause(automation: Automation): Promise<void> {
    const response = await this.client.automationRequest('pause', {
      id: automation.id,
      expectedRevision: automation.revision,
    });
    this.upsertAutomation(response.automation);
  }

  async resume(automation: Automation): Promise<void> {
    const response = await this.client.automationRequest('resume', {
      id: automation.id,
      expectedRevision: automation.revision,
    });
    this.upsertAutomation(response.automation);
  }

  async delete(automation: Automation): Promise<void> {
    await this.client.automationRequest('delete', {
      id: automation.id,
      expectedRevision: automation.revision,
    });
    this.removeAutomation(automation.id);
  }

  async startNow(automation: Automation): Promise<readonly AutomationRun[]> {
    const response = await this.client.automationRequest('startNow', { id: automation.id });
    for (const run of response.runs) this.upsertRun(run);
    return response.runs;
  }

  async markRunRead(run: AutomationRun): Promise<AutomationRun> {
    const response = await this.client.automationRequest('runMarkRead', { id: run.id });
    this.upsertRun(response.run);
    return response.run;
  }

  async pinRun(run: AutomationRun, pinned: boolean): Promise<AutomationRun> {
    const response = await this.client.automationRequest('runPin', { id: run.id, pinned });
    this.upsertRun(response.run);
    return response.run;
  }

  private applyNotification(notification: AutomationNotification): void {
    if (notification.type === 'automation/changed') {
      if (notification.automation) this.upsertAutomation(notification.automation);
      else this.removeAutomation(notification.automationId);
      return;
    }
    this.upsertRun(notification.run);
  }

  private upsertAutomation(automation: Automation): void {
    const version = this.recordMutation();
    this.automationMutationVersions.set(automation.id, version);
    this.automationDeletionVersions.delete(automation.id);
    this.patch({ automations: sortByUpdated(upsert(this.snapshot.automations, automation)) });
  }

  private upsertRun(run: AutomationRun): void {
    this.runMutationVersions.set(run.id, this.recordMutation());
    this.patch({ runs: sortBySchedule(upsert(this.snapshot.runs, run)) });
  }

  private removeAutomation(id: string): void {
    this.automationDeletionVersions.set(id, this.recordMutation());
    const automations = this.snapshot.automations.filter((item) => item.id !== id);
    this.patch({
      automations,
      selectedAutomationId: this.snapshot.selectedAutomationId === id
        ? automations[0]?.id ?? null
        : this.snapshot.selectedAutomationId,
    });
  }

  private mergeAutomationReload(
    loaded: readonly Automation[],
    baselineMutationVersion: number,
  ): readonly Automation[] {
    let merged = [...loaded];
    for (const automation of this.snapshot.automations) {
      if ((this.automationMutationVersions.get(automation.id) ?? 0) > baselineMutationVersion) {
        merged = upsert(merged, automation);
      }
    }
    merged = merged.filter((automation) => (
      (this.automationDeletionVersions.get(automation.id) ?? 0) <= baselineMutationVersion
    ));
    return sortByUpdated(merged);
  }

  private mergeRunReload(
    loaded: readonly AutomationRun[],
    baselineMutationVersion: number,
  ): readonly AutomationRun[] {
    let merged = [...loaded];
    for (const run of this.snapshot.runs) {
      if ((this.runMutationVersions.get(run.id) ?? 0) > baselineMutationVersion) {
        merged = upsert(merged, run);
      }
    }
    return sortBySchedule(merged);
  }

  private recordMutation(): number {
    this.mutationVersion += 1;
    return this.mutationVersion;
  }

  private patch(patch: Partial<AutomationStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export const automationStore = new AutomationRendererStore();

export function useAutomationStore(): AutomationStoreSnapshot {
  return useSyncExternalStore(automationStore.subscribe, automationStore.getSnapshot, automationStore.getSnapshot);
}

function upsert<T extends { readonly id: string }>(items: readonly T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) return [...items, value];
  const next = [...items];
  next[index] = value;
  return next;
}

function sortByUpdated(items: readonly Automation[]): Automation[] {
  return [...items].sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
}

function sortBySchedule(items: readonly AutomationRun[]): AutomationRun[] {
  return [...items].sort((left, right) => right.scheduledFor - left.scheduledFor || right.id.localeCompare(left.id));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
