import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  decodeAutomationRequest,
  decodeAutomationCreateInput,
  decodeAutomationUpdateInput,
  EMPTY_AUTOMATION_CONFIGURATION,
  automationDirectoryHint,
  type Automation,
  type AutomationConfiguration,
  type AutomationCreateInput,
  type AutomationMethod,
  type AutomationNotification,
  type AutomationContextHintInput,
  type AutomationRequestByMethod,
  type AutomationResponseByMethod,
  type AutomationRun,
  type AutomationUpdateInput,
} from '../../../core/agent/automation';
import type { ThreadService } from '../ThreadService';
import { AgentToolFailure } from '../AgentToolFailure';
import {
  assertAutomationConfigurationMatchesThread,
  AutomationDispatcher,
} from './AutomationDispatcher';
import { normalizeAutomationSchedule } from './AutomationSchedule';
import { AutomationScheduler } from './AutomationScheduler';
import { AutomationStore } from './AutomationStore';

type AutomationListener = (notification: AutomationNotification) => void | Promise<void>;
const execFileAsync = promisify(execFile);

export interface AutomationServiceOptions {
  readonly resolveProjectHint?: (id: string) => import('../../../core/agent/project').Project;
  readonly beforeSchedulerStart?: () => Promise<void>;
  readonly store: AutomationStore;
  readonly scheduler: AutomationScheduler;
  readonly dispatcher: AutomationDispatcher;
  readonly threads: ThreadService;
  readonly now?: () => number;
}

export class AutomationService {
  private readonly listeners = new Set<AutomationListener>();
  private readonly now: () => number;
  private started = false;

  constructor(private readonly options: AutomationServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.options.beforeSchedulerStart?.();
      await this.options.scheduler.start();
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.options.scheduler.stop();
  }

  closeStore(): void {
    this.options.store.close();
  }

  subscribe(listener: AutomationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wake(): void {
    if (this.started) {
      void this.options.scheduler.wake().catch((error) => {
        console.error('[automation] scheduler wake failed', error);
      });
    }
  }

  async request<Method extends AutomationMethod>(
    method: Method,
    input: unknown,
  ): Promise<AutomationResponseByMethod[Method]> {
    const decoded = decodeAutomationRequest(method, input);
    switch (method) {
      case 'list':
        return { data: this.options.store.list(decoded as AutomationRequestByMethod['list'], this.now()) } as AutomationResponseByMethod[Method];
      case 'read':
        return { automation: this.options.store.read((decoded as AutomationRequestByMethod['read']).id, this.now()) } as AutomationResponseByMethod[Method];
      case 'create':
        return { automation: await this.create(decoded as AutomationRequestByMethod['create']) } as AutomationResponseByMethod[Method];
      case 'update':
        return { automation: await this.update(decoded as AutomationRequestByMethod['update']) } as AutomationResponseByMethod[Method];
      case 'pause': {
        const value = decoded as AutomationRequestByMethod['pause'];
        return { automation: await this.setStatus(value.id, 'paused', value.expectedRevision) } as AutomationResponseByMethod[Method];
      }
      case 'resume': {
        const value = decoded as AutomationRequestByMethod['resume'];
        return { automation: await this.setStatus(value.id, 'active', value.expectedRevision) } as AutomationResponseByMethod[Method];
      }
      case 'delete': {
        const value = decoded as AutomationRequestByMethod['delete'];
        await this.options.scheduler.runExclusive(async () => {
          await this.options.dispatcher.recoverPendingRuns(value.id);
          const pending = this.options.store.pendingRuns(value.id);
          this.options.store.delete(value.id, value.expectedRevision, this.now());
          for (const run of pending) await this.runChanged(this.options.store.readRun(run.id)!);
          await this.publish({ type: 'automation/changed', automation: null, automationId: value.id });
          this.wake();
        });
        return { deleted: true, id: value.id } as AutomationResponseByMethod[Method];
      }
      case 'startNow': {
        const value = decoded as AutomationRequestByMethod['startNow'];
        return { runs: await this.startNow(value.id, value.requestId) } as AutomationResponseByMethod[Method];
      }
      case 'runs':
        return { data: this.options.store.listRuns(decoded as AutomationRequestByMethod['runs']) } as AutomationResponseByMethod[Method];
      case 'runRead':
        return { run: this.options.store.readRun((decoded as AutomationRequestByMethod['runRead']).id) } as AutomationResponseByMethod[Method];
      case 'runMarkRead': {
        const run = this.options.store.markRunRead(
          (decoded as AutomationRequestByMethod['runMarkRead']).id,
          this.now(),
        );
        await this.runChanged(run);
        return { run } as AutomationResponseByMethod[Method];
      }
      case 'runsMarkRead': {
        const { automationId } = decoded as AutomationRequestByMethod['runsMarkRead'];
        const result = this.options.store.markAutomationRunsRead(automationId, this.now());
        await this.publish({
          type: 'automationRuns/markedRead',
          automationId,
          eventSequence: result.eventSequence,
          readAt: result.readAt,
        });
        return { automationId, ...result } as AutomationResponseByMethod[Method];
      }
      case 'runPin': {
        const value = decoded as AutomationRequestByMethod['runPin'];
        return this.options.scheduler.runExclusive(async () => {
          const run = this.options.store.pinRun(value.id, value.pinned, this.now());
          await this.runChanged(run);
          return { run } as AutomationResponseByMethod[Method];
        });
      }
    }
  }

  async create(raw: AutomationCreateInput): Promise<Automation> {
    const input = decodeAutomationCreateInput(raw);
    const normalized = { ...input, schedule: normalizeAutomationSchedule(input.schedule) };
    return this.options.scheduler.runExclusive(async () => {
      const validated = await this.validateDefinition(normalized);
      const automation = this.options.store.create(validated, this.now());
      await this.automationChanged(automation);
      this.wake();
      return automation;
    });
  }

  async update(raw: AutomationUpdateInput): Promise<Automation> {
    const input = decodeAutomationUpdateInput(raw);
    return this.options.scheduler.runExclusive(async () => {
      const current = this.options.store.read(input.id, this.now());
      if (!current) {
        throw new AgentToolFailure(
          'automation_not_found',
          `Automation not found: ${input.id}`,
          'View the current Automations, then retry with an existing automation_id.',
        );
      }
      const normalized = {
        ...input,
        ...(input.schedule ? { schedule: normalizeAutomationSchedule(input.schedule) } : {}),
      };
      const validated = await this.validateDefinition({
        name: normalized.name ?? current.name,
        prompt: normalized.prompt ?? current.prompt,
        schedule: normalized.schedule ?? current.schedule,
        destination: normalized.destination ?? current.destination,
        contextHints: normalized.contextHints ?? current.contextHints,
        configuration: normalized.configuration
          ? { ...current.configuration, ...normalized.configuration }
          : current.configuration,
        status: current.status === 'paused' ? 'paused' : 'active',
      });
      const canonicalUpdate = normalized.contextHints
        ? { ...normalized, contextHints: validated.contextHints }
        : normalized;
      await this.options.dispatcher.recoverPendingRuns(input.id);
      const pending = this.options.store.pendingRuns(input.id);
      const automation = this.options.store.update(canonicalUpdate, this.now());
      for (const run of pending) await this.runChanged(this.options.store.readRun(run.id)!);
      await this.automationChanged(automation);
      this.wake();
      return automation;
    });
  }

  async automationChanged(automation: Automation): Promise<void> {
    await this.publish({ type: 'automation/changed', automation, automationId: automation.id });
  }

  async runChanged(run: AutomationRun): Promise<void> {
    await this.publish({ type: 'automationRun/changed', run });
  }

  private async setStatus(
    id: string,
    status: 'active' | 'paused',
    expectedRevision: number | undefined,
  ): Promise<Automation> {
    return this.options.scheduler.runExclusive(async () => {
      if (status === 'active') {
        const current = this.options.store.read(id, this.now());
        if (!current) throw new Error('Automation no longer exists');
        if (current.status === 'completed') return this.options.store.setStatus(id, status, expectedRevision, this.now());
        await this.validateDefinition({ ...current, status: 'active' });
      }
      if (status === 'paused') await this.options.dispatcher.recoverPendingRuns(id);
      const pending = status === 'paused' ? this.options.store.pendingRuns(id) : [];
      const automation = this.options.store.setStatus(id, status, expectedRevision, this.now());
      for (const run of pending) await this.runChanged(this.options.store.readRun(run.id)!);
      await this.automationChanged(automation);
      this.wake();
      return automation;
    });
  }

  private async startNow(id: string, requestId: string): Promise<readonly AutomationRun[]> {
    return this.options.scheduler.runExclusive(async () => {
      const automation = this.options.store.read(id, this.now());
      if (!automation) throw new Error(`Automation not found: ${id}`);
      if (automation.status !== 'active') throw new Error('Only an active Automation can start now');
      const bindings = automation.contextHints.length === 0 ? [null] : automation.contextHints;
      for (const binding of bindings) {
        const key = binding?.contextHintId ?? 'default';
        if (this.options.store.runForOccurrence(id, `manual:${requestId}`, key)) continue;
        const active = this.options.store.latestUnsettledRun(automation.id, key);
        if (active && this.options.dispatcher.isRunActive(active)) {
          throw new Error(`Automation already has an active occurrence for ${key}`);
        }
      }
      const runs: AutomationRun[] = [];
      for (const binding of bindings) {
        const claimed = this.options.store.claimNow(automation, binding, this.now(), requestId);
        await this.runChanged(claimed);
        runs.push(await this.options.dispatcher.dispatch(claimed));
      }
      return Object.freeze(runs);
    });
  }

  private async validateDefinition(input: AutomationCreateInput): Promise<AutomationCreateInput> {
    const bindings = input.contextHints ?? [];
    await Promise.all(bindings.map((binding) => validateContextHint(binding, this.options.resolveProjectHint)));
    const configuration: AutomationConfiguration = {
      ...EMPTY_AUTOMATION_CONFIGURATION,
      ...input.configuration,
    };
    if (input.destination.kind === 'existingThread') {
      if (bindings.length > 1) throw new Error('Existing-Thread Automations accept at most one context hint');
      const context = this.options.threads.persistentThreadExecutionContext(input.destination.threadId);
      if (context.thread.threadSource !== 'user') {
        throw new Error('An existing-Thread Automation must target a user root Thread');
      }
      assertAutomationConfigurationMatchesThread(
        configuration,
        context.thread.modelProvider,
        context.configuration,
      );
      await this.options.dispatcher.validateResolvedConfiguration(
        context.thread.modelProvider,
        context.configuration,
      );
    } else {
      await this.options.dispatcher.validateConfiguration(configuration);
    }
    return Object.freeze(input);
  }

  private async publish(notification: AutomationNotification): Promise<void> {
    await Promise.allSettled([...this.listeners].map((listener) => listener(notification)));
  }
}

async function validateContextHint(binding: AutomationContextHintInput,
  resolveProject?: AutomationServiceOptions['resolveProjectHint'],
): Promise<string> {
  const rootHint = binding.source.kind === 'project'
    ? resolveProject?.(binding.source.projectId).primaryFolder : automationDirectoryHint(binding);
  if (!rootHint) throw new Error('Automation Project hint is unavailable or has no saved directory');
  const cwd = await realpath(rootHint);
  if (binding.source.kind === 'project' && cwd !== rootHint) throw new Error('Saved Project directory was redirected; edit its root hint before scheduling');
  const value = await stat(cwd);
  if (!value.isDirectory()) throw new Error(`Automation hint is not a directory: ${rootHint}`);
  if (binding.executionMode === 'worktree') {
    // Git repository validation is repeated during dispatch to prevent stale path substitution.
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      maxBuffer: 1024 * 1024,
    }).catch(() => {
      throw new Error(`Automation worktree mode requires a Git project root: ${rootHint}`);
    });
    const root = await realpath(stdout.trim());
    if (root !== cwd) {
      throw new Error(`Automation worktree mode requires the Git repository root: ${rootHint}`);
    }
  }
  return cwd;
}
