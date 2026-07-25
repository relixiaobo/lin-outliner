import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  decodeAutomationRequest,
  decodeAutomationCreateInput,
  decodeAutomationUpdateInput,
  EMPTY_AUTOMATION_CONFIGURATION,
  type Automation,
  type AutomationConfiguration,
  type AutomationCreateInput,
  type AutomationMethod,
  type AutomationNotification,
  type AutomationProjectBinding,
  type AutomationRequestByMethod,
  type AutomationResponseByMethod,
  type AutomationRun,
  type AutomationUpdateInput,
} from '../../../core/agent/automation';
import type { ThreadService } from '../ThreadService';
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
        return { runs: await this.startNow(value.id) } as AutomationResponseByMethod[Method];
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
    const validated = await this.validateDefinition(normalized);
    return this.options.scheduler.runExclusive(async () => {
      const automation = this.options.store.create(validated, this.now());
      await this.automationChanged(automation);
      this.wake();
      return automation;
    });
  }

  async update(raw: AutomationUpdateInput): Promise<Automation> {
    const input = decodeAutomationUpdateInput(raw);
    const current = this.options.store.read(input.id, this.now());
    if (!current) throw new Error(`Automation not found: ${input.id}`);
    const normalized = {
      ...input,
      ...(input.schedule ? { schedule: normalizeAutomationSchedule(input.schedule) } : {}),
    };
    const validated = await this.validateDefinition({
      name: normalized.name ?? current.name,
      prompt: normalized.prompt ?? current.prompt,
      schedule: normalized.schedule ?? current.schedule,
      destination: normalized.destination ?? current.destination,
      projectBindings: normalized.projectBindings ?? current.projectBindings,
      configuration: normalized.configuration
        ? { ...current.configuration, ...normalized.configuration }
        : current.configuration,
      status: current.status === 'paused' ? 'paused' : 'active',
    });
    const canonicalUpdate = normalized.projectBindings
      ? { ...normalized, projectBindings: validated.projectBindings }
      : normalized;
    return this.options.scheduler.runExclusive(async () => {
      if (canonicalUpdate.status === 'paused') {
        await this.options.dispatcher.recoverPendingRuns(input.id);
      }
      const pending = canonicalUpdate.status === 'paused' ? this.options.store.pendingRuns(input.id) : [];
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
      if (status === 'paused') await this.options.dispatcher.recoverPendingRuns(id);
      const pending = status === 'paused' ? this.options.store.pendingRuns(id) : [];
      const automation = this.options.store.setStatus(id, status, expectedRevision, this.now());
      for (const run of pending) await this.runChanged(this.options.store.readRun(run.id)!);
      await this.automationChanged(automation);
      this.wake();
      return automation;
    });
  }

  private async startNow(id: string): Promise<readonly AutomationRun[]> {
    return this.options.scheduler.runExclusive(async () => {
      const automation = this.options.store.read(id, this.now());
      if (!automation) throw new Error(`Automation not found: ${id}`);
      if (automation.status !== 'active') throw new Error('Only an active Automation can start now');
      const bindings = automation.projectBindings.length === 0 ? [null] : automation.projectBindings;
      for (const binding of bindings) {
        const key = binding?.id ?? 'no-project';
        const active = this.options.store.latestUnsettledRun(automation.id, key);
        if (active && this.options.dispatcher.isRunActive(active)) {
          throw new Error(`Automation already has an active occurrence for ${key}`);
        }
      }
      const runs: AutomationRun[] = [];
      for (const binding of bindings) {
        const claimed = this.options.store.claimNow(automation, binding, this.now());
        await this.runChanged(claimed);
        runs.push(await this.options.dispatcher.dispatch(claimed));
      }
      return Object.freeze(runs);
    });
  }

  private async validateDefinition(input: AutomationCreateInput): Promise<AutomationCreateInput> {
    const bindings = input.projectBindings ?? [];
    const resolvedBindings = await Promise.all(bindings.map(validateProjectBinding));
    const configuration: AutomationConfiguration = {
      ...EMPTY_AUTOMATION_CONFIGURATION,
      ...input.configuration,
    };
    if (input.destination.kind === 'existingThread') {
      if (bindings.length > 1) throw new Error('Existing-Thread Automations accept at most one project binding');
      if (bindings[0]?.executionMode === 'worktree') {
        throw new Error('Existing-Thread Automations accept only local project bindings');
      }
      const context = this.options.threads.persistentThreadExecutionContext(input.destination.threadId);
      if (context.thread.threadSource !== 'user') {
        throw new Error('An existing-Thread Automation must target a user root Thread');
      }
      if (bindings[0]) {
        const cwd = resolvedBindings[0]!;
        if (cwd !== await realpath(context.thread.cwd)) {
          throw new Error('Automation project does not match the destination Thread workspace');
        }
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
      const workspaces = resolvedBindings.length > 0 ? resolvedBindings : [undefined];
      await Promise.all(workspaces.map((cwd) => this.options.dispatcher.validateConfiguration(configuration, cwd)));
    }
    return Object.freeze({
      ...input,
      ...(input.projectBindings === undefined
        ? {}
        : {
            projectBindings: Object.freeze(input.projectBindings.map((binding, index) => Object.freeze({
              ...binding,
              cwd: resolvedBindings[index]!,
            }))),
          }),
    });
  }

  private async publish(notification: AutomationNotification): Promise<void> {
    await Promise.allSettled([...this.listeners].map((listener) => listener(notification)));
  }
}

async function validateProjectBinding(binding: AutomationProjectBinding): Promise<string> {
  const cwd = await realpath(binding.cwd);
  const value = await stat(cwd);
  if (!value.isDirectory()) throw new Error(`Automation project is not a directory: ${binding.cwd}`);
  if (binding.executionMode === 'worktree') {
    // Git repository validation is repeated during dispatch to prevent stale path substitution.
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      maxBuffer: 1024 * 1024,
    }).catch(() => {
      throw new Error(`Automation worktree mode requires a Git project root: ${binding.cwd}`);
    });
    const root = await realpath(stdout.trim());
    if (root !== cwd) {
      throw new Error(`Automation worktree mode requires the Git repository root: ${binding.cwd}`);
    }
  }
  return cwd;
}
