import { useSyncExternalStore } from 'react';
import type { ScheduledRunResult } from '../../../core/agent/scheduledResult';
import type {
  Automation,
  AutomationResponseByMethod,
  AutomationCreateInput,
  AutomationNotification,
  AutomationRun,
  AutomationStatus,
  AutomationUpdateInput,
} from '../../../core/agent/automation';
import { api } from '../../api/client';

export type AutomationStoreClient = Pick<typeof api, 'automationRequest' | 'onAutomationNotification'>
  & Partial<Pick<typeof api, 'onAgentCoreNotification'>>;

export interface ScheduledTaskView {
  readonly summary?: { readonly attentionCount: number; readonly currentRunId: string | null; readonly latestRunId: string | null };
  readonly runIds: readonly string[];
  readonly missed: AutomationResponseByMethod['timing']['missed'];
  readonly nextBefore: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}
export interface ScheduledRunOperation { readonly pending: boolean; readonly error: string | null; readonly requestId: string | null }
const EMPTY_TASK_VIEW: ScheduledTaskView = { runIds: [], missed: [], nextBefore: null, loading: false, error: null };
export function canStopScheduledRun(result: ScheduledRunResult | undefined): boolean {
  return result?.state === 'running' || result?.state === 'waiting';
}

export interface AutomationStoreSnapshot {
  readonly taskViews: ReadonlyMap<string, ScheduledTaskView>;
  readonly runResults: ReadonlyMap<string, ScheduledRunResult>;
  readonly runOperations: ReadonlyMap<string, ScheduledRunOperation>;
  readonly automations: readonly Automation[];
  readonly runs: readonly AutomationRun[];
  readonly unreadAutomationIds: readonly string[];
  readonly selectedAutomationId: string | null;
  readonly statusFilter: AutomationStatus | 'all';
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_SNAPSHOT: AutomationStoreSnapshot = {
  taskViews: new Map(), runResults: new Map(), runOperations: new Map(),
  automations: [],
  runs: [],
  unreadAutomationIds: [],
  selectedAutomationId: null,
  statusFilter: 'all',
  loading: true,
  error: null,
};

export class AutomationRendererStore {
  private snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private consumers = 0;
  private coreUnsubscribe: (() => void) | null = null;
  private readonly watchedRuns = new Map<string, number>();
  private readonly resultGenerations = new Map<string, number>();
  private readonly summaryGenerations = new Map<string, number>();
  private readonly historyGenerations = new Map<string, number>();
  private readonly stopFlights = new Map<string, Promise<ScheduledRunResult>>();
  private queryGeneration = 0;
  private initializePromise: Promise<void> | null = null;
  private reloadGeneration = 0;
  private mutationVersion = 0;
  private readonly automationMutationVersions = new Map<string, number>();
  private readonly runMutationVersions = new Map<string, number>();
  private readonly automationDeletionVersions = new Map<string, number>();
  private readonly unreadMutationVersions = new Map<string, number>();
  private readonly runsMarkedReadVersions = new Map<string, {
    readonly eventSequence: number;
    readonly readAt: number;
    readonly version: number;
  }>();
  private readonly runLoadGenerations = new Map<string, number>();

  constructor(private readonly client: AutomationStoreClient = api) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AutomationStoreSnapshot => this.snapshot;

  acquire(): { ready: Promise<void>; release: () => void } {
    this.consumers++;
    let released = false;
    return { ready: this.initialize(), release: () => {
      if (released) return;
      released = true;
      if (--this.consumers === 0) this.dispose();
    } };
  }

  initialize(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = this.client.onAutomationNotification((notification) => this.applyNotification(notification));
    }
    if (!this.coreUnsubscribe && this.client.onAgentCoreNotification) {
      this.coreUnsubscribe = this.client.onAgentCoreNotification((event) => {
        if (!['turn/started', 'turn/completed', 'thread/status/changed', 'userInput/requested', 'userInput/resolved', 'toolTask/changed'].includes(event.type)) return;
        for (const id of this.watchedRuns.keys()) {
          const result = this.snapshot.runResults.get(id);
          if ('threadId' in event && result && event.threadId !== result.run.threadId) continue;
          void this.readRunResult(id).catch(() => undefined);
        }
      });
    }
    if (!this.initializePromise) this.initializePromise = this.reload();
    return this.initializePromise;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.coreUnsubscribe?.(); this.coreUnsubscribe = null;
    this.queryGeneration++;
    this.initializePromise = null;
    this.reloadGeneration += 1;
    this.runLoadGenerations.clear();
  }

  async reload(): Promise<void> {
    const generation = ++this.reloadGeneration;
    const baselineMutationVersion = this.mutationVersion;
    this.patch({ loading: true, error: null });
    try {
      const automations = await this.client.automationRequest('list', { includeDeleted: true });
      if (generation !== this.reloadGeneration) return;
      const unread = await Promise.all(automations.data.map(async (automation) => ({
        automationId: automation.id,
        response: await this.client.automationRequest('runs', {
          automationId: automation.id,
          unreadOnly: true,
          limit: 1,
        }),
      })));
      if (generation !== this.reloadGeneration) return;
      const mergedAutomations = this.mergeAutomationReload(automations.data, baselineMutationVersion);
      const unreadAutomationIds = this.mergeUnreadReload(
        unread.filter((entry) => entry.response.data.length > 0).map((entry) => entry.automationId),
        baselineMutationVersion,
      );
      const selectedAutomationId = this.snapshot.selectedAutomationId
        && mergedAutomations.some((automation) => automation.id === this.snapshot.selectedAutomationId)
        ? this.snapshot.selectedAutomationId
        : mergedAutomations[0]?.id ?? null;
      this.patch({
        automations: mergedAutomations,
        unreadAutomationIds,
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

  /** Outcome projections and stop receipts have one renderer owner across surfaces. */
  watchRun(id: string): { ready: Promise<void>; release: () => void } {
    const lease = this.acquire();
    this.watchedRuns.set(id, (this.watchedRuns.get(id) ?? 0) + 1);
    let released = false;
    return { ready: Promise.all([lease.ready, this.readRunResult(id)]).then(() => undefined), release: () => {
      if (released) return; released = true;
      const count = (this.watchedRuns.get(id) ?? 1) - 1;
      if (count) this.watchedRuns.set(id, count); else this.watchedRuns.delete(id);
      lease.release();
    } };
  }

  async readRunResult(id: string): Promise<ScheduledRunResult> {
    const lifetime = this.queryGeneration;
    const generation = (this.resultGenerations.get(id) ?? 0) + 1;
    this.resultGenerations.set(id, generation);
    const result = await this.client.automationRequest('result', { id });
    if (result.run.id !== id) throw new Error('The result does not belong to the requested run');
    if (lifetime === this.queryGeneration && generation === this.resultGenerations.get(id)) {
      this.patch({ runResults: new Map(this.snapshot.runResults).set(id, result) });
    }
    return this.snapshot.runResults.get(id) ?? result;
  }

  async loadTaskSummary(id: string): Promise<void> {
    const lifetime = this.queryGeneration;
    const generation = (this.summaryGenerations.get(id) ?? 0) + 1;
    this.summaryGenerations.set(id, generation);
    const baselineResults = new Map(this.resultGenerations);
    const summary = await this.client.automationRequest('summary', { id });
    if (lifetime !== this.queryGeneration || generation !== this.summaryGenerations.get(id)) return;
    const runResults = new Map(this.snapshot.runResults);
    for (const result of [summary.current, summary.latest]) {
      if (!result) continue;
      if (result.run.automationId !== id) throw new Error('Summary contains a run owned by another task');
      if (baselineResults.get(result.run.id) !== this.resultGenerations.get(result.run.id)) continue;
      this.resultGenerations.set(result.run.id, (this.resultGenerations.get(result.run.id) ?? 0) + 1);
      runResults.set(result.run.id, result);
    }
    // Summaries reference the same result cache as history and stop controls.
    const previous = this.snapshot.taskViews.get(id) ?? EMPTY_TASK_VIEW;
    this.patch({ runResults, taskViews: new Map(this.snapshot.taskViews).set(id, { ...previous, summary: {
      attentionCount: summary.attentionCount, currentRunId: summary.current?.run.id ?? null, latestRunId: summary.latest?.run.id ?? null,
    } }) });
  }

  async loadTaskHistory(id: string, before?: string): Promise<void> {
    const lifetime = this.queryGeneration;
    const generation = (this.historyGenerations.get(id) ?? 0) + 1;
    this.historyGenerations.set(id, generation);
    this.patchTaskView(id, { loading: true, error: null });
    try {
      const [page, timing] = await Promise.all([
        this.client.automationRequest('runs', { automationId: id, limit: 50, ...(before ? { before } : {}) }),
        this.client.automationRequest('timing', { id }),
      ]);
      if (lifetime !== this.queryGeneration || generation !== this.historyGenerations.get(id)) return;
      const results = await Promise.all(page.data.map((run) => this.readRunResult(run.id)));
      if (results.some((result) => result.run.automationId !== id)) throw new Error('History contains a run owned by another task');
      if (lifetime !== this.queryGeneration || generation !== this.historyGenerations.get(id)) return;
      const previous = this.snapshot.taskViews.get(id) ?? EMPTY_TASK_VIEW;
      const runIds = [...new Set([...results.map((result) => result.run.id), ...previous.runIds])]
        .sort((left, right) => (this.snapshot.runResults.get(right)?.run.createdSequence ?? 0) - (this.snapshot.runResults.get(left)?.run.createdSequence ?? 0));
      this.patchTaskView(id, { runIds, missed: timing.missed, nextBefore: page.data.length === 50 ? page.data.at(-1)!.id : null, loading: false });
    } catch (error) {
      if (lifetime === this.queryGeneration && generation === this.historyGenerations.get(id)) this.patchTaskView(id, { error: errorMessage(error), loading: false });
      throw error;
    }
  }

  stopRun(id: string): Promise<ScheduledRunResult> {
    const flight = this.stopFlights.get(id);
    if (flight) return flight;
    const requestId = this.snapshot.runOperations.get(id)?.requestId ?? crypto.randomUUID();
    this.resultGenerations.set(id, (this.resultGenerations.get(id) ?? 0) + 1);
    this.patch({ runOperations: new Map(this.snapshot.runOperations).set(id, { pending: true, error: null, requestId }) });
    const operation = this.client.automationRequest('runStop', { id, requestId }).then((result) => {
      if (result.run.id !== id) throw new Error('Stop returned another run');
      // A read started before this committed outcome cannot restore Running.
      this.resultGenerations.set(id, (this.resultGenerations.get(id) ?? 0) + 1);
      this.patch({ runResults: new Map(this.snapshot.runResults).set(id, result),
        runOperations: new Map(this.snapshot.runOperations).set(id, { pending: false, error: null, requestId: null }) });
      void this.loadTaskSummary(result.run.automationId).catch(() => undefined);
      return result;
    }).catch((error) => {
      this.patch({ runOperations: new Map(this.snapshot.runOperations).set(id, { pending: false, error: errorMessage(error), requestId }) });
      throw error;
    }).finally(() => { this.stopFlights.delete(id); });
    this.stopFlights.set(id, operation);
    return operation;
  }

  private patchTaskView(id: string, patch: Partial<ScheduledTaskView>): void {
    this.patch({ taskViews: new Map(this.snapshot.taskViews).set(id, { ...(this.snapshot.taskViews.get(id) ?? EMPTY_TASK_VIEW), ...patch }) });
  }

  select(id: string | null): void {
    this.patch({ selectedAutomationId: id });
  }

  async loadRunsForAutomation(automationId: string): Promise<void> {
    const generation = (this.runLoadGenerations.get(automationId) ?? 0) + 1;
    this.runLoadGenerations.set(automationId, generation);
    const baselineMutationVersion = this.mutationVersion;
    const response = await this.client.automationRequest('runs', { automationId, limit: 200 });
    if (this.runLoadGenerations.get(automationId) !== generation) return;
    const loaded = this.mergeRunReload(response.data, baselineMutationVersion);
    this.patch({
      runs: sortBySchedule([
        ...this.snapshot.runs.filter((run) => run.automationId !== automationId),
        ...loaded.filter((run) => run.automationId === automationId),
      ]),
    });
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
    const response = await this.client.automationRequest('startNow', { id: automation.id, requestId: crypto.randomUUID(), expectedRevision: automation.revision });
    for (const run of response.runs) this.upsertRun(run);
    return response.runs;
  }

  async markRunRead(run: AutomationRun): Promise<AutomationRun> {
    const response = await this.client.automationRequest('runMarkRead', { id: run.id });
    this.upsertRun(response.run);
    await this.refreshUnreadForAutomation(run.automationId);
    return response.run;
  }

  async markAutomationRunsRead(automationId: string): Promise<void> {
    const response = await this.client.automationRequest('runsMarkRead', { automationId });
    this.applyRunsMarkedRead(response.automationId, response.eventSequence, response.readAt);
  }

  async pinRun(run: AutomationRun, pinned: boolean): Promise<AutomationRun> {
    const response = await this.client.automationRequest('runPin', { id: run.id, pinned });
    this.upsertRun(response.run);
    return response.run;
  }

  private applyNotification(notification: AutomationNotification): void {
    if (notification.type === 'automation/open') { this.select(notification.automationId); return; }
    if (notification.type === 'automation/changed') {
      if (notification.automation) this.upsertAutomation(notification.automation);
      else this.removeAutomation(notification.automationId);
      return;
    }
    if (notification.type === 'automationRuns/markedRead') {
      this.applyRunsMarkedRead(notification.automationId, notification.eventSequence, notification.readAt);
      return;
    }
    this.upsertRun(notification.run);
    if (this.watchedRuns.has(notification.run.id)) void this.readRunResult(notification.run.id).catch(() => undefined);
  }

  private applyRunsMarkedRead(automationId: string, eventSequence: number, readAt: number): void {
    const version = this.recordMutation();
    const previous = this.runsMarkedReadVersions.get(automationId);
    if (previous && previous.eventSequence > eventSequence) return;
    this.runsMarkedReadVersions.set(automationId, { eventSequence, readAt, version });
    const runs = this.snapshot.runs.map((run) => {
      const normalized = this.applyRunsReadBoundary(run);
      if (normalized === run) return run;
      this.runMutationVersions.set(run.id, version);
      return normalized;
    });
    const ids = new Set(this.snapshot.unreadAutomationIds);
    if (runs.some((run) => run.automationId === automationId && isUnread(run))) ids.add(automationId);
    else ids.delete(automationId);
    this.unreadMutationVersions.set(automationId, version);
    this.patch({ runs, unreadAutomationIds: [...ids].sort() });
  }

  private upsertAutomation(automation: Automation): void {
    const version = this.recordMutation();
    this.automationMutationVersions.set(automation.id, version);
    this.automationDeletionVersions.delete(automation.id);
    this.patch({ automations: sortByUpdated(upsert(this.snapshot.automations, automation)) });
  }

  private upsertRun(run: AutomationRun): void {
    const version = this.recordMutation();
    const normalized = this.applyRunsReadBoundary(run);
    this.runMutationVersions.set(normalized.id, version);
    if (isUnread(normalized)) this.setUnread(normalized.automationId, true, version);
    this.patch({ runs: sortBySchedule(upsert(this.snapshot.runs, normalized)) });
  }

  private removeAutomation(id: string): void {
    const version = this.recordMutation();
    this.automationDeletionVersions.set(id, version);
    this.unreadMutationVersions.set(id, version);
    const automations = this.snapshot.automations.filter((item) => item.id !== id);
    this.patch({
      automations,
      unreadAutomationIds: this.snapshot.unreadAutomationIds.filter((candidate) => candidate !== id),
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
    let merged = loaded.map((run) => {
      const boundary = this.runsMarkedReadVersions.get(run.automationId);
      return boundary && boundary.version > baselineMutationVersion
        ? this.applyRunsReadBoundary(run)
        : run;
    });
    for (const run of this.snapshot.runs) {
      if ((this.runMutationVersions.get(run.id) ?? 0) > baselineMutationVersion) {
        merged = upsert(merged, run);
      }
    }
    return sortBySchedule(merged);
  }

  private applyRunsReadBoundary(run: AutomationRun): AutomationRun {
    const boundary = this.runsMarkedReadVersions.get(run.automationId);
    if (!boundary || !isUnread(run) || run.eventSequence > boundary.eventSequence) return run;
    return {
      ...run,
      eventSequence: boundary.eventSequence,
      readAt: boundary.readAt,
      updatedAt: boundary.readAt,
    };
  }

  private mergeUnreadReload(
    loaded: readonly string[],
    baselineMutationVersion: number,
  ): readonly string[] {
    const current = new Set(this.snapshot.unreadAutomationIds);
    const loadedSet = new Set(loaded);
    const ids = new Set([...current, ...loadedSet, ...this.unreadMutationVersions.keys()]);
    return [...ids]
      .filter((id) => (
        (this.unreadMutationVersions.get(id) ?? 0) > baselineMutationVersion
          ? current.has(id)
          : loadedSet.has(id)
      ))
      .sort();
  }

  private async refreshUnreadForAutomation(automationId: string): Promise<void> {
    const baselineMutationVersion = this.mutationVersion;
    const response = await this.client.automationRequest('runs', {
      automationId,
      unreadOnly: true,
      limit: 1,
    });
    if ((this.unreadMutationVersions.get(automationId) ?? 0) > baselineMutationVersion) return;
    this.setUnread(automationId, response.data.length > 0, this.recordMutation());
  }

  private setUnread(automationId: string, unread: boolean, version: number): void {
    const ids = new Set(this.snapshot.unreadAutomationIds);
    if (unread) ids.add(automationId);
    else ids.delete(automationId);
    this.unreadMutationVersions.set(automationId, version);
    this.patch({ unreadAutomationIds: [...ids].sort() });
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

const noSubscription = () => () => undefined;

export function useAutomationStore(active = true): AutomationStoreSnapshot {
  return useSyncExternalStore(active ? automationStore.subscribe : noSubscription, automationStore.getSnapshot, automationStore.getSnapshot);
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
  return [...items].sort((left, right) => right.createdSequence - left.createdSequence || right.id.localeCompare(left.id));
}

function isUnread(run: AutomationRun): boolean {
  return run.readAt === null && (run.state === 'dispatched' || run.state === 'failed');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
