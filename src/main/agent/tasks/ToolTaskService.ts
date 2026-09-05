import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AdditionalContext,
  JsonValue,
  ThreadId,
  ThreadResourceReference,
  TurnId,
} from '../../../core/agent/protocol';
import { getAgentProcessExecutor, type AgentProcessWriteSandbox } from '../capabilities/agentProcessExecutor';
import { redactSecretLikeContent } from '../capabilities/agentSecretRedaction';
import { uuidV7 } from '../uuid';
import {
  projectToolTask,
  ToolTaskStore,
  type ToolTaskStorageLimits,
} from './ToolTaskStore';
import {
  isToolTaskTerminal,
  type ToolTaskDeliveryAdmission,
  type ToolTaskDeliveryBatch,
  type ToolTaskArtifactSettlement,
  type ToolTaskFinalReceipt,
  type ToolTaskProgress,
  type ToolTaskProducerReconciliation,
  type ToolTaskProjection,
  type ToolTaskRecord,
  type ToolTaskSchedulerLimits,
  type ToolTaskSchedulingPolicy,
  type ToolTaskProcessSpec,
  type ToolTaskSupervisorConfig,
  type ToolTaskSupervisorHeartbeat,
  type ToolTaskSupervisorIdentity,
} from './toolTaskTypes';
import {
  defaultToolTaskSupervisorRuntime,
  type ToolTaskSupervisorRuntime,
} from './toolTaskRuntime';

const TASK_MONITOR_INTERVAL_MS = 100;
const TASK_START_CONFIRMATION_MS = 2_000;
const TASK_HEARTBEAT_STALE_MS = 3_000;
const TASK_STOP_WAIT_MS = 3_000;
const TASK_DELIVERY_BATCH_LIMIT = 8;
const TASK_OUTPUT_PREVIEW_BYTES = 30_000;
const TOOL_TASK_PRIVATE_CONTROL_MAX_BYTES = 64 * 1024;
const TOOL_TASK_PREPARED_RESULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TOOL_TASK_SCHEDULER_LIMITS: ToolTaskSchedulerLimits = Object.freeze({
  maxConcurrentGlobal: 8,
  maxConcurrentThread: 4,
  maxQueuedGlobal: 32,
  maxQueuedThread: 8,
});
export interface ToolTaskServiceLimits extends ToolTaskStorageLimits {
  readonly detailTtlMs: number;
}

export const DEFAULT_TOOL_TASK_LIMITS: ToolTaskServiceLimits = Object.freeze({
  detailTtlMs: 30 * 24 * 60 * 60_000,
  taskDetailBytes: 64 * 1024 * 1024,
  threadDetailBytes: 1024 * 1024 * 1024,
  applicationDetailBytes: 8 * 1024 * 1024 * 1024,
});

export interface ToolTaskHost {
  ownerExists(threadId: ThreadId): boolean;
  readDeliveryAdmission(
    threadId: ThreadId,
    turnId: TurnId,
  ): Promise<ToolTaskDeliveryAdmission | null>;
  startCompletionTurn(input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly clientId: string;
    readonly admission: ToolTaskDeliveryAdmission;
    readonly additionalContext: AdditionalContext;
    readonly additionalContextResourceRefs: readonly ThreadResourceReference[];
  }): Promise<boolean>;
  reconcileTask?(
    task: ToolTaskRecord,
    producerContext: JsonValue | null,
    receipt: ToolTaskFinalReceipt,
  ): Promise<ToolTaskProducerReconciliation>;
  beforeStop?(task: ToolTaskRecord, sourceTurnId: TurnId | undefined): Promise<void>;
  settleTask?(
    task: ToolTaskRecord,
    producerContext: JsonValue | null,
    maxArtifactBytes: number,
  ): Promise<ToolTaskArtifactSettlement>;
  taskDetailsExpired?(ownerThreadId: ThreadId): Promise<void>;
  taskChanged(task: ToolTaskProjection): void;
}

export interface StartToolTaskInput {
  readonly ownerThreadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly sourceItemId: string;
  readonly producer: string;
  readonly description: string;
  readonly command: string;
  readonly process?: ToolTaskProcessSpec;
  readonly privateControlInput?: Uint8Array;
  readonly prepareProcess?: (
    context: ToolTaskProcessPreparationContext,
  ) => Promise<PreparedToolTaskProcess>;
  readonly cwd: string;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly sandbox?: AgentProcessWriteSandbox;
  readonly backgroundEnabled?: boolean;
  readonly reserveForBackground?: boolean;
  readonly producerContext?: JsonValue;
  readonly scheduling?: Partial<ToolTaskSchedulingPolicy>;
  readonly schedulerLimits?: ToolTaskSchedulerLimits;
  readonly signal?: AbortSignal;
}

export interface ToolTaskProcessPreparationContext {
  readonly taskId: string;
  readonly nonce: string;
  readonly cwd: string;
  readonly stdin: string;
}

export interface PreparedToolTaskProcess {
  readonly process: ToolTaskProcessSpec;
  readonly privateControlInput?: Uint8Array;
  readonly disposePrivateControl?: () => void;
}

export interface ToolTaskOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ToolTaskPreparedResult {
  readonly sha256: string;
  readonly byteLength: number;
}

export class ToolTaskService {
  private readonly monitors = new Map<string, ReturnType<typeof setInterval>>();
  private readonly startRuns = new Set<Promise<ToolTaskRecord>>();
  private readonly reconciliationRuns = new Map<string, Promise<void>>();
  private readonly admissionRuns = new Map<string, Promise<void>>();
  private readonly noProcessSettlementRuns = new Map<string, Promise<ToolTaskRecord>>();
  private readonly deliveryRuns = new Map<ThreadId, Promise<void>>();
  private readonly supervisors = new Map<string, ChildProcess>();
  private host: ToolTaskHost | null = null;
  private recoveryIdentityDeadline = 0;
  private closing = false;
  private initialized = false;

  constructor(
    readonly store: ToolTaskStore,
    private readonly detailRoot: string,
    private readonly runtime: ToolTaskSupervisorRuntime = defaultToolTaskSupervisorRuntime(),
    private readonly now: () => number = Date.now,
    private readonly limits: ToolTaskServiceLimits = DEFAULT_TOOL_TASK_LIMITS,
    private readonly schedulerLimits: ToolTaskSchedulerLimits = DEFAULT_TOOL_TASK_SCHEDULER_LIMITS,
  ) {}

  bindHost(host: ToolTaskHost): void {
    if (this.host) throw new Error('Tool Task host is already bound');
    this.host = host;
  }

  async prepareResult(taskId: string, ownerThreadId: ThreadId, bytes: Uint8Array): Promise<ToolTaskPreparedResult> {
    const task = this.store.owned(taskId, ownerThreadId);
    if (!task) throw new Error(`Tool Task not found: ${taskId}`);
    if (isToolTaskTerminal(task.state)) throw new Error(`Tool Task is already terminal: ${taskId}`);
    const maxPreparedResultBytes = preparedResultMaxBytes(this.limits.taskDetailBytes);
    if (bytes.byteLength < 1 || bytes.byteLength > maxPreparedResultBytes) {
      throw new Error(`Tool Task prepared result must be between 1 and ${maxPreparedResultBytes} bytes`);
    }
    const value = Buffer.from(bytes);
    const sha256 = createHash('sha256').update(value).digest('hex');
    const preparedPath = taskPaths(task.detailPath).preparedResult;
    const created = await atomicCreateBytes(preparedPath, value);
    if (!created) {
      const existing = await readFile(preparedPath);
      const existingDigest = createHash('sha256').update(existing).digest('hex');
      if (existingDigest !== sha256 || existing.byteLength !== value.byteLength) {
        throw new Error(`Tool Task prepared result is immutable: ${taskId}`);
      }
    }
    this.publish(this.store.markSettling(taskId, this.now()));
    return { sha256, byteLength: value.byteLength };
  }

  async readPreparedResult(taskId: string, ownerThreadId: ThreadId): Promise<Buffer | null> {
    const task = this.store.owned(taskId, ownerThreadId);
    if (!task) throw new Error(`Tool Task not found: ${taskId}`);
    const bytes = await readFile(taskPaths(task.detailPath).preparedResult).catch((error: unknown) => {
      if (isErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (!bytes) return null;
    const maxPreparedResultBytes = preparedResultMaxBytes(this.limits.taskDetailBytes);
    if (bytes.byteLength < 1 || bytes.byteLength > maxPreparedResultBytes) {
      throw new Error('Tool Task prepared result exceeds its byte limit');
    }
    return Buffer.from(bytes);
  }

  async initialize(): Promise<void> {
    if (!this.host) throw new Error('Tool Task host is unavailable');
    this.closing = false;
    this.initialized = false;
    this.recoveryIdentityDeadline = Date.now() + TASK_START_CONFIRMATION_MS;
    await mkdir(this.detailRoot, { recursive: true, mode: 0o700 });
    await Promise.allSettled(this.store.allTerminalByAge()
      .filter((task) => task.detailState !== 'available')
      .map((task) => rm(task.detailPath, { recursive: true, force: true })));
    for (const task of this.store.allTerminalByAge()) this.store.releaseLease(task.taskId, this.now());
    for (const task of this.store.nonterminal()) {
      this.store.ensureRecoveryLease(task, schedulingPolicy(task.producer), this.now());
    }
    for (const ownerThreadId of this.store.ownerIds()) {
      if (!this.host.ownerExists(ownerThreadId)) await this.orphanOwner(ownerThreadId);
    }
    await this.reconcileDeliveryBatches();
    for (const task of this.store.nonterminal()) {
      if (this.store.readLease(task.taskId)?.state === 'queued') {
        await this.settleWithoutProcess(
          task,
          'failed',
          'admission_interrupted',
          'The Host restarted before the queued Tool Task acquired execution capacity.',
        );
      } else {
        await this.reconcileTask(task);
      }
    }
    await this.enforceRetention();
    for (const owner of this.store.ownersWithPendingDelivery()) this.wakeDelivery(owner);
    this.initialized = true;
  }

  async start(input: StartToolTaskInput): Promise<ToolTaskRecord> {
    if (this.closing) throw new Error('Tool Task admission is closed');
    if (!this.initialized) throw new Error('Tool Task recovery has not completed');
    if (!this.host?.ownerExists(input.ownerThreadId)) throw new Error('Tool Task owner does not exist');
    validateProcessInput(input);
    const run = this.startAccepted(input);
    this.startRuns.add(run);
    try {
      return await run;
    } finally {
      this.startRuns.delete(run);
    }
  }

  private async startAccepted(input: StartToolTaskInput): Promise<ToolTaskRecord> {
    const taskId = `task_${randomUUID()}`;
    const nonce = randomUUID();
    const detailPath = path.join(this.detailRoot, taskId);
    const startedAt = this.now();
    const paths = taskPaths(detailPath);
    await mkdir(detailPath, { recursive: false, mode: 0o700 });
    const task = this.store.create({
      taskId,
      ownerThreadId: input.ownerThreadId,
      sourceTurnId: input.sourceTurnId,
      sourceItemId: input.sourceItemId,
      producer: normalizedLabel(input.producer, 'tool'),
      description: normalizedLabel(input.description, 'Background command'),
      commandDigest: digestText(input.command),
      cwd: path.resolve(input.cwd),
      nonce,
      detailPath,
      backgroundEnabled: input.backgroundEnabled ?? true,
      timeoutMs: input.timeoutMs,
      startedAt,
    });
    try {
      await Promise.all([
        writeFile(paths.stdin, input.stdin ?? '', { encoding: 'utf8', mode: 0o600 }),
        writeFile(paths.stdout, '', { encoding: 'utf8', mode: 0o600 }),
        writeFile(paths.stderr, '', { encoding: 'utf8', mode: 0o600 }),
        atomicJsonWrite(paths.producer, input.producerContext ?? null),
      ]);
      if (input.signal?.aborted || this.closing) {
        return await this.settleWithoutProcess(
          this.store.read(taskId)!,
          'cancelled',
          input.signal?.aborted ? 'user_stop' : 'application_quit',
          null,
        );
      }
      const reservationBytes = input.reserveForBackground ?? input.backgroundEnabled ?? true
        ? this.limits.taskDetailBytes
        : 0;
      if (reservationBytes > 0) {
        await this.reclaimForReservation(input.ownerThreadId, reservationBytes);
        const reservation = this.store.reserveDetail(taskId, reservationBytes, this.limits, this.now());
        if (!reservation.accepted) {
          const pressure = reservation.task.storagePressure!;
          const receipt = await this.createHostFailureReceipt(
            reservation.task,
            'storage_limit',
            [
              `Tool Task storage reservation was refused for the ${pressure.scope} limit.`,
              `Required ${pressure.requiredBytes} bytes; ${pressure.usedBytes} bytes are in use,`,
              `${pressure.reclaimableBytes} reclaimable and ${pressure.protectedBytes} protected.`,
            ].join(' '),
          );
          await atomicJsonWrite(paths.receipt, receipt).catch(() => undefined);
          this.store.settleArtifacts(taskId, { artifacts: [], warnings: [] }, this.now());
          const terminal = this.store.commitTerminal(taskId, receipt, this.now());
          this.publish(terminal);
          if (terminal.backgroundEnabled) this.wakeDelivery(terminal.ownerThreadId);
          return terminal;
        }
      }
      const schedulerLimits = input.schedulerLimits ?? this.schedulerLimits;
      const admission = this.store.admitLease(
        taskId,
        schedulingPolicy(input.producer, input.scheduling),
        schedulerLimits,
        this.now(),
      );
      if (admission.state === 'refused') {
        return await this.settleWithoutProcess(
          this.store.read(taskId)!,
          'failed',
          'queue_limit',
          'The bounded Tool Task admission queue is full.',
        );
      }
      if (admission.state === 'queued') {
        const queued = this.store.setProgress(taskId, {
          phase: 'queued',
          message: 'Waiting for local task capacity',
          fraction: null,
          updatedAt: this.now(),
        }, this.now());
        this.publish(queued);
        if (queued.backgroundEnabled) {
          this.continueQueuedAdmission(taskId, input, schedulerLimits);
          return queued;
        }
        const acquired = await this.waitForLease(taskId, schedulerLimits, input.signal);
        if (!acquired || acquired.state === 'released') return this.store.read(taskId)!;
      }
      return await this.launchAdmittedTask(taskId, input);
    } catch (error) {
      const current = this.store.read(taskId)!;
      if (isToolTaskTerminal(current.state)) return current;
      const receipt = await this.createHostFailureReceipt(
        current,
        'admission_failed',
        `Tool Task admission failed: ${errorMessage(error)}`,
      );
      await atomicJsonWrite(paths.receipt, receipt).catch(() => undefined);
      await this.reconcileTask(current);
      return this.store.read(taskId)!;
    }
  }

  private continueQueuedAdmission(
    taskId: string,
    input: StartToolTaskInput,
    schedulerLimits: ToolTaskSchedulerLimits,
  ): void {
    const run = this.waitForLease(taskId, schedulerLimits)
      .then(async (lease) => {
        if (!lease || lease.state !== 'active') return;
        await this.launchAdmittedTask(taskId, input);
      })
      .catch((error) => {
        console.error(`[agent] Queued Tool Task admission failed for ${taskId}`, error);
      })
      .finally(() => this.admissionRuns.delete(taskId));
    this.admissionRuns.set(taskId, run);
  }

  private async launchAdmittedTask(
    taskId: string,
    input: StartToolTaskInput,
  ): Promise<ToolTaskRecord> {
    let task = this.store.read(taskId)!;
    if (isToolTaskTerminal(task.state)) return task;
    if (input.signal?.aborted || this.closing) {
      return this.settleWithoutProcess(
        task,
        'cancelled',
        input.signal?.aborted ? 'user_stop' : 'application_quit',
        null,
      );
    }
    if (task.state !== 'running' || this.store.readLease(taskId)?.state !== 'active') return task;
    const paths = taskPaths(task.detailPath);
    let supervisor: ChildProcess | null = null;
    let disposePrivateControl: (() => void) | undefined;
    let launchCompleted = false;
    try {
      const prepared = input.prepareProcess
        ? await input.prepareProcess({
            taskId,
            nonce: task.nonce,
            cwd: path.resolve(input.cwd),
            stdin: input.stdin ?? '',
          })
        : { process: input.process ?? { kind: 'shell', command: input.command },
            ...(input.privateControlInput ? { privateControlInput: input.privateControlInput } : {}) };
      validatePreparedProcess(prepared);
      disposePrivateControl = prepared.disposePrivateControl;
      const maxPreparedResultBytes = preparedResultMaxBytes(this.limits.taskDetailBytes);
      const config: ToolTaskSupervisorConfig = {
        version: 2,
        taskId,
        nonce: task.nonce,
        process: prepared.process,
        cwd: path.resolve(input.cwd),
        stdinPath: paths.stdin,
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        progressPath: paths.progress,
        identityPath: paths.identity,
        heartbeatPath: paths.heartbeat,
        stopRequestPath: paths.stop,
        finalReceiptPath: paths.receipt,
        preparedResultPath: paths.preparedResult,
        startedAt: task.startedAt,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: this.limits.taskDetailBytes - maxPreparedResultBytes,
        maxPreparedResultBytes,
      };
      await atomicJsonWrite(paths.config, config);
      task = this.store.read(taskId)!;
      if (isToolTaskTerminal(task.state)) return task;
      if (input.signal?.aborted || this.closing) {
        return await this.settleWithoutProcess(
          task,
          'cancelled',
          input.signal?.aborted ? 'user_stop' : 'application_quit',
          null,
        );
      }
      if (task.state !== 'running' || this.store.readLease(taskId)?.state !== 'active') return task;
      supervisor = await getAgentProcessExecutor().spawn({
        command: this.runtime.executable,
        args: [...this.runtime.argsPrefix, paths.config],
        cwd: input.cwd,
        env: {
          ...input.env,
          ...this.runtime.env,
          TENON_TOOL_TASK_PROGRESS_FILE: paths.progress,
        },
        detached: process.platform !== 'win32',
        stdio: prepared.privateControlInput ? ['ignore', 'ignore', 'ignore', 'pipe'] : 'ignore',
        windowsHide: true,
        sandbox: input.sandbox,
      });
      if (!supervisor.pid) throw new Error('Tool Task supervisor did not receive a process identity');
      if (prepared.privateControlInput) {
        await writePrivateControl(supervisor, prepared.privateControlInput);
      }
      this.supervisors.set(taskId, supervisor);
      supervisor.once('close', () => {
        if (this.supervisors.get(taskId) === supervisor) this.supervisors.delete(taskId);
      });
      supervisor.unref();
      this.store.setSupervisor(taskId, supervisor.pid, null, this.now());
      this.monitor(taskId);
      await this.waitForStartConfirmation(taskId, supervisor);
      await this.reconcileTask(this.store.read(taskId)!);
      await Promise.all([
        rm(paths.config, { force: true }),
        rm(paths.stdin, { force: true }),
      ]).catch(() => undefined);
      const current = this.store.read(taskId)!;
      this.publish(current);
      if (current.backgroundEnabled && isToolTaskTerminal(current.state)) {
        await this.enforceRetention();
        this.wakeDelivery(current.ownerThreadId);
      }
      launchCompleted = true;
      return current;
    } catch (error) {
      const current = this.store.read(taskId)!;
      if (isToolTaskTerminal(current.state)) return current;
      if (supervisor?.pid && processExists(supervisor.pid)) {
        const settling = this.store.setCoordinationError(
          taskId,
          `Tool Task admission teardown is pending: ${errorMessage(error)}`,
          this.now(),
        );
        await atomicJsonWrite(paths.stop, {
          version: 1,
          taskId,
          nonce: task.nonce,
          requestedAt: this.now(),
          reason: 'admission_failed',
        }).catch(() => undefined);
        this.monitor(taskId);
        this.publish(settling);
        return settling;
      }
      const receipt = await this.createHostFailureReceipt(
        current,
        'admission_failed',
        `Tool Task admission failed: ${errorMessage(error)}`,
      );
      await atomicJsonWrite(paths.receipt, receipt).catch(() => undefined);
      await this.reconcileTask(current);
      return this.store.read(taskId)!;
    } finally {
      if (!launchCompleted) disposePrivateControl?.();
    }
  }

  readOwned(taskId: string, ownerThreadId: ThreadId): ToolTaskRecord | null {
    return this.store.owned(taskId, ownerThreadId);
  }

  read(taskId: string, ownerThreadId: ThreadId): ToolTaskProjection | null {
    const task = this.store.owned(taskId, ownerThreadId);
    return task ? projectToolTask(task) : null;
  }

  list(ownerThreadId: ThreadId): readonly ToolTaskProjection[] {
    return this.store.list(ownerThreadId).map(projectToolTask);
  }

  async output(taskId: string, ownerThreadId: ThreadId): Promise<ToolTaskOutput | null> {
    const task = this.store.owned(taskId, ownerThreadId);
    if (!task || !isToolTaskTerminal(task.state) || task.detailState !== 'available') return null;
    const paths = taskPaths(task.detailPath);
    const [stdout, stderr] = await Promise.all([
      readPreview(paths.stdout, TASK_OUTPUT_PREVIEW_BYTES),
      readPreview(paths.stderr, TASK_OUTPUT_PREVIEW_BYTES),
    ]);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }

  async stop(taskId: string, ownerThreadId: ThreadId, sourceTurnId?: TurnId): Promise<ToolTaskRecord | null> {
    let task = this.store.owned(taskId, ownerThreadId);
    if (!task) return null;
    if (isToolTaskTerminal(task.state)) return task;
    await this.host?.beforeStop?.(task, sourceTurnId);
    if (this.store.readLease(taskId)?.state === 'queued') {
      return this.settleWithoutProcess(task, 'cancelled', 'user_stop', null);
    }
    task = this.store.markSettling(taskId, this.now(), true);
    await atomicJsonWrite(taskPaths(task.detailPath).stop, {
      version: 1,
      taskId: task.taskId,
      nonce: task.nonce,
      requestedAt: task.stopRequestedAt,
    });
    this.publish(task);
    const deadline = Date.now() + TASK_STOP_WAIT_MS;
    while (Date.now() < deadline) {
      await this.reconcileTask(this.store.read(taskId)!);
      task = this.store.read(taskId)!;
      if (isToolTaskTerminal(task.state)) return task;
      await delay(25);
    }
    return task;
  }

  promote(taskId: string, ownerThreadId: ThreadId): ToolTaskRecord | null {
    const task = this.store.owned(taskId, ownerThreadId);
    if (!task) return null;
    const promoted = task.backgroundEnabled ? task : this.store.promote(taskId, this.now());
    this.publish(promoted);
    if (isToolTaskTerminal(promoted.state)) this.wakeDelivery(promoted.ownerThreadId);
    return promoted;
  }

  async waitForTerminal(
    taskId: string,
    ownerThreadId: ThreadId,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ToolTaskRecord | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      const task = this.store.owned(taskId, ownerThreadId);
      if (!task || isToolTaskTerminal(task.state)) return task;
      if (signal?.aborted) return this.stop(taskId, ownerThreadId);
      await delay(25);
    }
    return this.store.owned(taskId, ownerThreadId);
  }

  async materializeCombinedOutput(taskId: string, ownerThreadId: ThreadId): Promise<string | null> {
    const task = this.store.owned(taskId, ownerThreadId);
    if (!task || task.detailState !== 'available') return null;
    const paths = taskPaths(task.detailPath);
    const [stdout, stderr] = await Promise.all([
      readFile(paths.stdout).catch(() => Buffer.alloc(0)),
      readFile(paths.stderr).catch(() => Buffer.alloc(0)),
    ]);
    const combined = path.join(task.detailPath, 'combined.log');
    await writeFile(combined, Buffer.concat([stdout, stderr]), { mode: 0o600 });
    return combined;
  }

  async consumeForeground(taskId: string, ownerThreadId: ThreadId): Promise<void> {
    const task = this.store.owned(taskId, ownerThreadId);
    if (!task || task.backgroundEnabled || !isToolTaskTerminal(task.state)) {
      throw new Error('Only a terminal foreground Tool Task can be consumed');
    }
    this.clearMonitor(taskId);
    await rm(task.detailPath, { recursive: true, force: true });
    this.store.deleteTask(taskId);
  }

  wakeDelivery(ownerThreadId: ThreadId): void {
    if (this.closing || this.deliveryRuns.has(ownerThreadId)) return;
    let delivered = false;
    const run = Promise.resolve()
      .then(() => this.deliver(ownerThreadId))
      .then((settled) => {
        delivered = settled;
      })
      .catch((error) => {
        console.error(`[agent] Tool Task delivery failed for ${ownerThreadId}`, error);
        const retry = setTimeout(() => this.wakeDelivery(ownerThreadId), 1_000);
        retry.unref?.();
      })
      .finally(() => {
        this.deliveryRuns.delete(ownerThreadId);
        if (delivered && !this.closing && this.store.pendingDelivery(ownerThreadId, 1).length > 0) {
          this.wakeDelivery(ownerThreadId);
        }
      });
    this.deliveryRuns.set(ownerThreadId, run);
  }

  async close(drainTimeoutMs: number): Promise<void> {
    this.closing = true;
    for (const timer of this.monitors.values()) clearInterval(timer);
    this.monitors.clear();
    await Promise.allSettled(this.store.nonterminal().map(async (task) => {
      if (this.store.readLease(task.taskId)?.state === 'queued') {
        await this.settleWithoutProcess(task, 'cancelled', 'application_quit', null);
      }
    }));
    await Promise.allSettled([...this.startRuns]);
    await Promise.allSettled([...this.admissionRuns.values()]);
    const active = this.store.nonterminal();
    await Promise.all(active.map(async (task) => {
      if (this.store.readLease(task.taskId)?.state === 'queued') {
        await this.settleWithoutProcess(task, 'cancelled', 'application_quit', null);
        return;
      }
      this.store.markSettling(task.taskId, this.now(), true);
      await atomicJsonWrite(taskPaths(task.detailPath).stop, {
        version: 1,
        taskId: task.taskId,
        nonce: task.nonce,
        requestedAt: this.now(),
        reason: 'application_quit',
      }).catch(() => undefined);
    }));
    const deadline = Date.now() + Math.max(0, drainTimeoutMs);
    while (Date.now() < deadline && this.store.nonterminal().length > 0) {
      await Promise.all(this.store.nonterminal().map((task) => this.reconcileTask(task)));
      if (this.store.nonterminal().length > 0) await delay(25);
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (this.deliveryRuns.size > 0 && remaining > 0) {
      await Promise.race([
        Promise.allSettled([...this.deliveryRuns.values()]),
        delay(remaining),
      ]);
    }
    await Promise.allSettled([...this.reconciliationRuns.values()]);
  }

  async deleteOwner(threadId: ThreadId): Promise<void> {
    const tasks = this.store.listAll(threadId);
    if (tasks.some((task) => !isToolTaskTerminal(task.state)
      || task.deliveryState === 'pending' || task.deliveryState === 'delivering')) {
      throw new Error('Cannot delete a Thread with active Tool Tasks');
    }
    await Promise.all(tasks.map((task) => rm(task.detailPath, { recursive: true, force: true })));
    this.store.deleteOwner(threadId);
  }

  async clearEligibleDetails(ownerThreadId: ThreadId): Promise<{
    readonly tasks: readonly ToolTaskProjection[];
    readonly reclaimedBytes: number;
  }> {
    if (!this.host?.ownerExists(ownerThreadId)) throw new Error('Tool Task owner does not exist');
    const before = this.store.physicalDetailBytes();
    const cleared: ToolTaskProjection[] = [];
    for (const task of this.store.clearableDetails(ownerThreadId)) {
      const current = this.store.owned(task.taskId, ownerThreadId);
      if (!current || current.detailState !== 'available' || current.deliveryState !== 'delivered') continue;
      await this.expireDetail(current, 'cleared');
      cleared.push(projectToolTask(this.store.read(current.taskId)!));
    }
    return {
      tasks: cleared,
      reclaimedBytes: Math.max(0, before - this.store.physicalDetailBytes()),
    };
  }

  private async orphanOwner(ownerThreadId: ThreadId): Promise<void> {
    this.store.blockOwnerDelivery(ownerThreadId, this.now());
    await Promise.all(this.store.listAll(ownerThreadId).map(async (task) => {
      if (isToolTaskTerminal(task.state)) return;
      const settling = this.store.setCoordinationError(
        task.taskId,
        'The owning Thread is missing; process-group teardown is pending.',
        this.now(),
      );
      await atomicJsonWrite(taskPaths(task.detailPath).stop, {
        version: 1,
        taskId: task.taskId,
        nonce: task.nonce,
        requestedAt: this.now(),
        reason: 'owner_missing',
      }).catch(() => undefined);
      this.publish(settling);
    }));
  }

  private reconcileTask(task: ToolTaskRecord): Promise<void> {
    const existing = this.reconciliationRuns.get(task.taskId);
    if (existing) return existing;
    const run = this.reconcileTaskOnce(task).finally(() => {
      if (this.reconciliationRuns.get(task.taskId) === run) {
        this.reconciliationRuns.delete(task.taskId);
      }
    });
    this.reconciliationRuns.set(task.taskId, run);
    return run;
  }

  private async reconcileTaskOnce(task: ToolTaskRecord): Promise<void> {
    if (isToolTaskTerminal(task.state)) {
      this.clearMonitor(task.taskId);
      return;
    }
    if (this.store.readLease(task.taskId)?.state === 'queued') return;
    const paths = taskPaths(task.detailPath);
    let receiptInvalid = false;
    const receipt = await readFinalReceipt(paths.receipt, task).catch((error) => {
      console.error(`[agent] Invalid Tool Task receipt for ${task.taskId}`, error);
      receiptInvalid = true;
      return null;
    });
    if (receipt) {
      try {
        await verifyPreparedResult(
          paths.preparedResult,
          receipt,
          preparedResultMaxBytes(this.limits.taskDetailBytes),
        );
        const terminalReceipt = await this.reconcileProducer(task, receipt);
        const stabilized = await stabilizeOutput(paths, task, terminalReceipt, this.limits.taskDetailBytes);
        await this.settleArtifacts(
          task,
          this.limits.taskDetailBytes
            - stabilized.stdoutBytes
            - stabilized.stderrBytes
            - terminalReceipt.preparedResultBytes,
        );
        const terminal = this.store.commitTerminal(task.taskId, terminalReceipt, this.now(), {
          ...stabilized,
          preparedResultBytes: terminalReceipt.preparedResultBytes,
        });
        this.supervisors.delete(task.taskId);
        this.clearMonitor(task.taskId);
        this.publish(terminal);
        await this.enforceRetention();
        if (terminal.backgroundEnabled) this.wakeDelivery(terminal.ownerThreadId);
      } catch (error) {
        this.publish(this.store.setCoordinationError(
          task.taskId,
          `Tool Task result settlement is pending: ${errorMessage(error)}`,
          this.now(),
        ));
        this.monitor(task.taskId);
      }
      return;
    }
    if (receiptInvalid) {
      this.publish(this.store.setCoordinationError(
        task.taskId,
        'The supervisor final receipt is invalid; task evidence was retained for recovery.',
        this.now(),
      ));
      this.monitor(task.taskId);
      return;
    }
    const identity = await readIdentity(paths.identity, task).catch(() => null);
    if (identity) {
      const current = this.store.setSupervisor(
        task.taskId,
        identity.supervisorPid,
        identity.childPid,
        this.now(),
      );
      const progress = await readProgress(paths.progress, this.now()).catch(() => null);
      if (progress && JSON.stringify(progress) !== JSON.stringify(current.progress)) {
        this.publish(this.store.setProgress(task.taskId, progress, this.now()));
      }
      const supervisorAlive = processExists(identity.supervisorPid);
      const groupAlive = processGroupExists(identity.childPid);
      const heartbeat = await readHeartbeat(paths.heartbeat, task, identity).catch(() => null);
      if (supervisorAlive || groupAlive) {
        if (heartbeat && this.now() - heartbeat.updatedAt <= TASK_HEARTBEAT_STALE_MS) {
          this.monitor(task.taskId);
          return;
        }
        this.publish(this.store.setCoordinationError(
          task.taskId,
          'The persisted process identity is live but no current nonce heartbeat proves ownership.',
          this.now(),
        ));
        this.monitor(task.taskId);
        return;
      }
      if (heartbeat && this.now() - heartbeat.updatedAt <= TASK_HEARTBEAT_STALE_MS) {
        this.monitor(task.taskId);
        return;
      }
    } else {
      if (task.supervisorPid !== null && processExists(task.supervisorPid)) {
        this.publish(this.store.setCoordinationError(
          task.taskId,
          'The supervisor process is live but its nonce identity is unavailable.',
          this.now(),
        ));
        this.monitor(task.taskId);
        return;
      }
      if (task.supervisorPid === null && Date.now() < this.recoveryIdentityDeadline) {
        this.monitor(task.taskId);
        return;
      }
    }
    const lost = await this.createLostReceipt(task, 'supervisor_missing');
    await atomicJsonWrite(paths.receipt, lost).catch(() => undefined);
    try {
      const terminalReceipt = await this.reconcileProducer(task, lost);
      const stabilized = await stabilizeOutput(paths, task, terminalReceipt, this.limits.taskDetailBytes);
      await this.settleArtifacts(
        task,
        this.limits.taskDetailBytes
          - stabilized.stdoutBytes
          - stabilized.stderrBytes
          - terminalReceipt.preparedResultBytes,
      );
      const terminal = this.store.commitTerminal(task.taskId, terminalReceipt, this.now(), {
        ...stabilized,
        preparedResultBytes: terminalReceipt.preparedResultBytes,
      });
      this.supervisors.delete(task.taskId);
      this.clearMonitor(task.taskId);
      this.publish(terminal);
      if (terminal.backgroundEnabled) this.wakeDelivery(terminal.ownerThreadId);
    } catch (error) {
      this.publish(this.store.setCoordinationError(
        task.taskId,
        `Lost Tool Task result settlement is pending: ${errorMessage(error)}`,
        this.now(),
      ));
      this.monitor(task.taskId);
    }
  }

  private monitor(taskId: string): void {
    if (this.closing || this.monitors.has(taskId)) return;
    const timer = setInterval(() => {
      const task = this.store.read(taskId);
      if (!task || isToolTaskTerminal(task.state)) {
        this.clearMonitor(taskId);
        return;
      }
      void this.reconcileTask(task).catch((error) => {
        console.error(`[agent] Tool Task reconciliation failed for ${taskId}`, error);
      });
    }, TASK_MONITOR_INTERVAL_MS);
    timer.unref?.();
    this.monitors.set(taskId, timer);
  }

  private clearMonitor(taskId: string): void {
    const timer = this.monitors.get(taskId);
    if (timer) clearInterval(timer);
    this.monitors.delete(taskId);
  }

  private async waitForStartConfirmation(taskId: string, supervisor: ChildProcess): Promise<void> {
    const deadline = Date.now() + TASK_START_CONFIRMATION_MS;
    let processError: Error | null = null;
    supervisor.once('error', (error) => { processError = error; });
    while (Date.now() < deadline) {
      if (processError) throw processError;
      const task = this.store.read(taskId)!;
      const paths = taskPaths(task.detailPath);
      const identity = await readIdentity(paths.identity, task).catch(() => null);
      if (identity) {
        this.store.setSupervisor(taskId, identity.supervisorPid, identity.childPid, this.now());
        return;
      }
      const receipt = await readFinalReceipt(paths.receipt, task).catch(() => null);
      if (receipt) return;
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
        throw new Error('Tool Task supervisor exited before publishing its identity');
      }
      await delay(10);
    }
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
      throw new Error('Tool Task supervisor exited before confirming command admission');
    }
  }

  private async reconcileDeliveryBatches(): Promise<void> {
    for (const batch of this.store.preparedBatches()) await this.reconcileDeliveryBatch(batch);
  }

  private async reconcileDeliveryBatch(batch: ToolTaskDeliveryBatch): Promise<void> {
    const host = this.host!;
    if (!host.ownerExists(batch.ownerThreadId)) {
      this.store.blockDelivery(batch.batchId, this.now());
      return;
    }
    const admission = await host.readDeliveryAdmission(batch.ownerThreadId, batch.reservedTurnId);
    if (!admission) {
      this.store.rollBackDelivery(batch.batchId, this.now());
    } else if (admission.batchId === batch.batchId && admission.envelopeDigest === batch.envelopeDigest) {
      this.store.linkDelivery(batch.batchId, batch.reservedTurnId, batch.envelopeDigest, this.now());
    } else {
      this.store.blockDelivery(batch.batchId, this.now());
    }
  }

  private async deliver(ownerThreadId: ThreadId): Promise<boolean> {
    if (this.closing) return false;
    if (!this.host?.ownerExists(ownerThreadId)) {
      this.store.blockOwnerDelivery(ownerThreadId, this.now());
      return false;
    }
    const tasks = this.store.pendingDelivery(ownerThreadId, TASK_DELIVERY_BATCH_LIMIT);
    if (tasks.length === 0) return false;
    const output = await Promise.all(tasks.map(async (task) => ({
      task,
      output: await this.output(task.taskId, ownerThreadId),
    })));
    const envelope = output.map(({ task, output: captured }) => ({
      taskId: task.taskId,
      producer: task.producer,
      description: task.description,
      state: task.state,
      exitCode: task.exitCode,
      signal: task.signal,
      reason: task.outcomeReason,
      error: task.error,
      progress: task.progress,
      artifacts: task.artifacts,
      artifactWarnings: task.artifactWarnings,
      detailState: task.detailState,
      storagePressure: task.storagePressure,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      stdout: captured?.stdout ?? '',
      stderr: captured?.stderr ?? '',
      outputTruncated: Boolean(captured?.stdoutTruncated || captured?.stderrTruncated),
    }));
    const envelopeText = JSON.stringify({ version: 1, tasks: envelope });
    const envelopeDigest = digestText(envelopeText);
    const batchId = `task_batch_${randomUUID()}`;
    const reservedTurnId = uuidV7(this.now());
    const clientId = `tool-task-delivery:${batchId}`;
    const batch = this.store.prepareDelivery({
      batchId,
      ownerThreadId,
      reservedTurnId,
      clientId,
      envelopeDigest,
      taskIds: tasks.map((task) => task.taskId),
      now: this.now(),
    });
    const admission = { batchId: batch.batchId, envelopeDigest: batch.envelopeDigest };
    let started: boolean;
    try {
      started = await this.host.startCompletionTurn({
        threadId: ownerThreadId,
        turnId: reservedTurnId,
        clientId,
        admission,
        additionalContext: deliveryContext(envelopeText, tasks),
        additionalContextResourceRefs: tasks.flatMap((task) => task.artifacts.map((artifact) => artifact.ref)),
      });
    } catch (error) {
      await this.reconcileDeliveryBatch(batch);
      if (this.store.readBatch(batch.batchId)?.state === 'linked') return true;
      throw error;
    }
    if (!started) {
      this.store.rollBackDelivery(batch.batchId, this.now());
      return false;
    }
    try {
      this.store.linkDelivery(batch.batchId, reservedTurnId, envelopeDigest, this.now());
    } catch (error) {
      await this.reconcileDeliveryBatch(batch);
      if (this.store.readBatch(batch.batchId)?.state !== 'linked') throw error;
    }
    for (const task of tasks) this.publish(this.store.read(task.taskId)!);
    return true;
  }

  private async createLostReceipt(task: ToolTaskRecord, reason: string): Promise<ToolTaskFinalReceipt> {
    const paths = taskPaths(task.detailPath);
    const [stdoutBytes, stderrBytes] = await Promise.all([fileSize(paths.stdout), fileSize(paths.stderr)]);
    const preparedResult = await readPreparedResultEvidence(
      paths.preparedResult,
      preparedResultMaxBytes(this.limits.taskDetailBytes),
    );
    const unsigned = {
      version: 2 as const,
      taskId: task.taskId,
      nonce: task.nonce,
      state: 'lost' as const,
      exitCode: null,
      signal: null,
      reason,
      error: 'The supervisor disappeared before writing a quiescent final receipt.',
      supervisorPid: task.supervisorPid,
      childPid: task.childPid,
      startedAt: task.startedAt,
      quiescedAt: this.now(),
      stdoutBytes,
      stderrBytes,
      preparedResultDigest: preparedResult.sha256,
      preparedResultBytes: preparedResult.byteLength,
    };
    return { ...unsigned, receiptDigest: digestText(JSON.stringify(unsigned)) };
  }

  private async createHostFailureReceipt(
    task: ToolTaskRecord,
    reason: string,
    error: string,
  ): Promise<ToolTaskFinalReceipt> {
    const paths = taskPaths(task.detailPath);
    const [stdoutBytes, stderrBytes] = await Promise.all([fileSize(paths.stdout), fileSize(paths.stderr)]);
    const unsigned = {
      version: 2 as const,
      taskId: task.taskId,
      nonce: task.nonce,
      state: 'failed' as const,
      exitCode: null,
      signal: null,
      reason,
      error,
      supervisorPid: task.supervisorPid,
      childPid: task.childPid,
      startedAt: task.startedAt,
      quiescedAt: this.now(),
      stdoutBytes,
      stderrBytes,
      preparedResultDigest: null,
      preparedResultBytes: 0,
    };
    return { ...unsigned, receiptDigest: digestText(JSON.stringify(unsigned)) };
  }

  private async settleWithoutProcess(
    task: ToolTaskRecord,
    state: 'failed' | 'cancelled',
    reason: string,
    error: string | null,
  ): Promise<ToolTaskRecord> {
    const existing = this.noProcessSettlementRuns.get(task.taskId);
    if (existing) return existing;
    const run = this.settleWithoutProcessOnce(task, state, reason, error).finally(() => {
      if (this.noProcessSettlementRuns.get(task.taskId) === run) {
        this.noProcessSettlementRuns.delete(task.taskId);
      }
    });
    this.noProcessSettlementRuns.set(task.taskId, run);
    return run;
  }

  private async settleWithoutProcessOnce(
    task: ToolTaskRecord,
    state: 'failed' | 'cancelled',
    reason: string,
    error: string | null,
  ): Promise<ToolTaskRecord> {
    const current = this.store.read(task.taskId)!;
    if (isToolTaskTerminal(current.state)) return current;
    this.store.markSettling(task.taskId, this.now(), state === 'cancelled');
    const paths = taskPaths(task.detailPath);
    const unsigned = {
      version: 2 as const,
      taskId: task.taskId,
      nonce: task.nonce,
      state,
      exitCode: null,
      signal: null,
      reason,
      error,
      supervisorPid: null,
      childPid: null,
      startedAt: task.startedAt,
      quiescedAt: this.now(),
      stdoutBytes: await fileSize(paths.stdout),
      stderrBytes: await fileSize(paths.stderr),
      preparedResultDigest: null,
      preparedResultBytes: 0,
    };
    const receipt: ToolTaskFinalReceipt = {
      ...unsigned,
      receiptDigest: digestText(JSON.stringify(unsigned)),
    };
    await atomicJsonWrite(paths.receipt, receipt).catch(() => undefined);
    const terminalReceipt = await this.reconcileProducer(task, receipt);
    await this.settleArtifacts(task, this.limits.taskDetailBytes);
    const terminal = this.store.commitTerminal(task.taskId, terminalReceipt, this.now());
    this.publish(terminal);
    if (terminal.backgroundEnabled) this.wakeDelivery(terminal.ownerThreadId);
    return terminal;
  }

  private async waitForLease(
    taskId: string,
    schedulerLimits: ToolTaskSchedulerLimits,
    signal?: AbortSignal,
  ): Promise<import('./toolTaskTypes').ToolTaskLease | null> {
    while (true) {
      const task = this.store.read(taskId);
      if (!task || isToolTaskTerminal(task.state)) return this.store.readLease(taskId);
      if (signal?.aborted || this.closing) {
        await this.settleWithoutProcess(
          task,
          'cancelled',
          signal?.aborted ? 'user_stop' : 'application_quit',
          null,
        );
        return this.store.readLease(taskId);
      }
      const lease = this.store.tryActivateLease(taskId, schedulerLimits, this.now());
      if (!lease || lease.state !== 'queued') return lease;
      await delay(25);
    }
  }

  private publish(task: ToolTaskRecord): void {
    if (task.backgroundEnabled) this.host?.taskChanged(projectToolTask(task));
  }

  private async settleArtifacts(
    task: ToolTaskRecord,
    maxArtifactBytes: number,
  ): Promise<ToolTaskRecord> {
    const current = this.store.read(task.taskId)!;
    if (current.artifactsSettled) return current;
    const producerContext = await readJson(taskPaths(task.detailPath).producer, 1024 * 1024);
    const settlement = this.host?.settleTask
      ? await this.host.settleTask(current, producerContext as JsonValue | null, maxArtifactBytes)
      : { artifacts: [], warnings: [] };
    const artifactBytes = settlement.artifacts.reduce((sum, artifact) => sum + artifact.ref.byteLength, 0);
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 0
      || !Number.isSafeInteger(artifactBytes) || artifactBytes < 0
      || artifactBytes > maxArtifactBytes) {
      throw new Error('Tool Task artifacts exceed the remaining durable detail ceiling');
    }
    return this.store.settleArtifacts(task.taskId, settlement, this.now());
  }

  private async reconcileProducer(
    task: ToolTaskRecord,
    receipt: ToolTaskFinalReceipt,
  ): Promise<ToolTaskFinalReceipt> {
    if (!this.host?.reconcileTask) return receipt;
    const producerContext = await readJson(taskPaths(task.detailPath).producer, 1024 * 1024);
    const reconciliation = await this.host.reconcileTask(
      this.store.read(task.taskId)!,
      producerContext as JsonValue | null,
      receipt,
    );
    if (reconciliation.outcome === 'preserve' || receipt.state !== 'succeeded') return receipt;
    const unsigned = {
      ...receipt,
      state: reconciliation.state,
      reason: boundedReceiptField(reconciliation.reason, 256, 'producer_reconciliation_failed'),
      error: reconciliation.error === null
        ? null
        : boundedReceiptField(reconciliation.error, 4_096, 'Tool Task producer reconciliation failed.'),
    };
    const { receiptDigest: _receiptDigest, ...withoutDigest } = unsigned;
    return {
      ...withoutDigest,
      receiptDigest: digestText(JSON.stringify(withoutDigest)),
    };
  }

  private async enforceRetention(): Promise<void> {
    const now = this.now();
    const terminal = this.store.allTerminalByAge();
    for (const task of terminal) {
      if (task.detailState !== 'available' || task.deliveredAt === null) continue;
      if (task.deliveredAt <= now - this.limits.detailTtlMs && task.deliveryState === 'delivered') {
        await this.expireDetail(task, 'expired');
      }
    }
    for (const ownerThreadId of this.store.ownerIds()) {
      await this.evictThreadToLimit(ownerThreadId, this.limits.threadDetailBytes);
    }
    await this.evictApplicationToLimit(this.limits.applicationDetailBytes);
  }

  private async reclaimForReservation(ownerThreadId: ThreadId, reservationBytes: number): Promise<void> {
    await this.evictThreadToLimit(ownerThreadId, this.limits.threadDetailBytes - reservationBytes);
    await this.evictApplicationToLimit(this.limits.applicationDetailBytes - reservationBytes);
  }

  private async evictThreadToLimit(ownerThreadId: ThreadId, limit: number): Promise<void> {
    for (const task of this.store.allTerminalByAge()) {
      if (this.store.logicalDetailBytes(ownerThreadId) <= Math.max(0, limit)) return;
      if (task.ownerThreadId !== ownerThreadId || task.detailState !== 'available'
        || task.deliveryState !== 'delivered') continue;
      await this.expireDetail(task, 'storage_pressure');
    }
  }

  private async evictApplicationToLimit(limit: number): Promise<void> {
    for (const task of this.store.allTerminalByAge()) {
      if (this.store.physicalDetailBytes() <= Math.max(0, limit)) return;
      if (task.detailState !== 'available' || task.deliveryState !== 'delivered') continue;
      await this.expireDetail(task, 'storage_pressure');
    }
  }

  private async expireDetail(
    task: ToolTaskRecord,
    reason: 'expired' | 'cleared' | 'storage_pressure',
  ): Promise<void> {
    const expired = this.store.expireDetail(task.taskId, reason, this.now());
    this.publish(expired);
    try {
      await this.host?.taskDetailsExpired?.(task.ownerThreadId);
    } finally {
      await rm(task.detailPath, { recursive: true, force: true });
    }
  }

}

function validateProcessInput(input: StartToolTaskInput): void {
  if (input.prepareProcess && (input.process || input.privateControlInput)) {
    throw new Error('Prepared Tool Task process cannot be combined with a static process or private control input');
  }
  if (input.prepareProcess) return;
  validatePreparedProcess({
    process: input.process ?? { kind: 'shell', command: input.command },
    ...(input.privateControlInput ? { privateControlInput: input.privateControlInput } : {}),
  });
}

function validatePreparedProcess(input: PreparedToolTaskProcess): void {
  if (input.disposePrivateControl && !input.privateControlInput) {
    throw new Error('Private Tool Task control cleanup requires private control input');
  }
  const processSpec = input.process;
  if (processSpec.kind === 'shell') {
    if (input.privateControlInput) throw new Error('Private Tool Task control input requires a direct process');
    return;
  }
  if (!processSpec.executable || processSpec.executable.includes('\0')) {
    throw new Error('Direct Tool Task executable is invalid');
  }
  if (processSpec.args.some((arg) => arg.includes('\0'))
    || Object.entries(processSpec.env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || value.includes('\0'))) {
    throw new Error('Direct Tool Task arguments or environment are invalid');
  }
  if (processSpec.privateControl !== Boolean(input.privateControlInput)) {
    throw new Error('Direct Tool Task private control declaration does not match its input');
  }
  if (input.privateControlInput && input.privateControlInput.byteLength === 0) {
    throw new Error('Private Tool Task control input must not be empty');
  }
  if (input.privateControlInput && input.privateControlInput.byteLength > TOOL_TASK_PRIVATE_CONTROL_MAX_BYTES) {
    throw new Error(`Private Tool Task control input exceeds ${TOOL_TASK_PRIVATE_CONTROL_MAX_BYTES} bytes`);
  }
}

async function writePrivateControl(supervisor: ChildProcess, input: Uint8Array): Promise<void> {
  const stream = supervisor.stdio[3];
  if (!stream || typeof (stream as NodeJS.WritableStream).write !== 'function') {
    throw new Error('Tool Task supervisor private control pipe is unavailable');
  }
  const writable = stream as NodeJS.WritableStream;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    writable.once('error', onError);
    writable.end(Buffer.from(input), () => {
      writable.removeListener('error', onError);
      resolve();
    });
  });
}

function schedulingPolicy(
  producer: string,
  override: Partial<ToolTaskSchedulingPolicy> = {},
): ToolTaskSchedulingPolicy {
  return {
    pool: normalizedLabel(override.pool ?? producer, 'tool'),
    configurationRevision: normalizedLabel(override.configurationRevision ?? 'product-default-v1', 'default'),
    maxConcurrentProducer: override.maxConcurrentProducer ?? 4,
    maxConcurrentPool: override.maxConcurrentPool ?? 4,
  };
}

function deliveryContext(envelopeText: string, tasks: readonly ToolTaskRecord[]): AdditionalContext {
  return {
    'tool-task.completion': {
      kind: 'untrusted',
      purpose: 'observation',
      value: scanUntrustedOutput(envelopeText),
    },
    'tool-task.metadata': {
      kind: 'application',
      purpose: 'observation',
      value: tasks.map((task) => [
        `task_id=${task.taskId}`,
        `producer=${task.producer}`,
        `state=${task.state}`,
        `completed_at=${task.completedAt ?? 'unknown'}`,
      ].join('\n')).join('\n\n'),
    },
    'tool-task.handling': {
      kind: 'application',
      purpose: 'instruction',
      value: [
        '[SYSTEM NOTIFICATION - NOT USER INPUT]',
        'This is an automated background Tool Task event, not a message or approval from the user.',
        'Inspect the untrusted output and factual metadata. Integrate verified evidence, recover ownership after failure, or report the limitation.',
        'Do not poll task_status; completion is delivered automatically.',
      ].join('\n'),
    },
  };
}

function scanUntrustedOutput(value: string): string {
  return value
    .replace(/<\/?system-reminder\b/giu, (match) => match.replace('<', '<\\'))
    .replace(/^(Human|Assistant):/gmu, '\\$&');
}

function taskPaths(root: string) {
  return {
    config: path.join(root, 'config.json'),
    producer: path.join(root, 'producer.json'),
    stdin: path.join(root, 'stdin.bin'),
    stdout: path.join(root, 'stdout.log'),
    stderr: path.join(root, 'stderr.log'),
    progress: path.join(root, 'progress.json'),
    identity: path.join(root, 'identity.json'),
    heartbeat: path.join(root, 'heartbeat.json'),
    stop: path.join(root, 'stop.json'),
    receipt: path.join(root, 'final-receipt.json'),
    preparedResult: path.join(root, 'prepared-result.bin'),
    sanitized: path.join(root, 'sanitized.json'),
  };
}

async function atomicCreateBytes(filePath: string, bytes: Uint8Array): Promise<boolean> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    try {
      await link(temporary, filePath);
      return true;
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readIdentity(filePath: string, task: ToolTaskRecord): Promise<ToolTaskSupervisorIdentity | null> {
  const value = await readJson(filePath);
  if (value === null) return null;
  const record = value as Partial<ToolTaskSupervisorIdentity>;
  if (record.version !== 1 || record.taskId !== task.taskId || record.nonce !== task.nonce
    || !Number.isSafeInteger(record.supervisorPid) || Number(record.supervisorPid) < 1
    || !Number.isSafeInteger(record.childPid) || Number(record.childPid) < 1
    || !Number.isFinite(record.startedAt)) throw new Error('Invalid Tool Task supervisor identity');
  return record as ToolTaskSupervisorIdentity;
}

async function readFinalReceipt(filePath: string, task: ToolTaskRecord): Promise<ToolTaskFinalReceipt | null> {
  const value = await readJson(filePath);
  if (value === null) return null;
  const record = value as Partial<ToolTaskFinalReceipt>;
  if (record.version !== 2 || record.taskId !== task.taskId || record.nonce !== task.nonce
    || !['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'].includes(record.state ?? '')
    || typeof record.receiptDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(record.receiptDigest)
    || record.startedAt !== task.startedAt
    || !Number.isFinite(record.quiescedAt) || Number(record.quiescedAt) < task.startedAt
    || !nonNegativeInteger(record.stdoutBytes) || !nonNegativeInteger(record.stderrBytes)
    || !(record.exitCode === null || Number.isSafeInteger(record.exitCode))
    || !(record.signal === null || (typeof record.signal === 'string' && record.signal.length <= 256))
    || typeof record.reason !== 'string' || record.reason.length === 0 || record.reason.length > 256
    || !(record.error === null || (typeof record.error === 'string' && record.error.length <= 4_096))
    || !(record.supervisorPid === null
      || (Number.isSafeInteger(record.supervisorPid) && Number(record.supervisorPid) > 0))
    || !(record.childPid === null
      || (Number.isSafeInteger(record.childPid) && Number(record.childPid) > 0))
    || !(record.preparedResultDigest === null
      || (typeof record.preparedResultDigest === 'string'
        && /^[0-9a-f]{64}$/u.test(record.preparedResultDigest)))
    || !nonNegativeInteger(record.preparedResultBytes)
    || ((record.preparedResultDigest === null) !== (record.preparedResultBytes === 0))
    || (record.state === 'succeeded'
      && (record.exitCode !== 0 || record.signal !== null || record.error !== null
        || record.supervisorPid === null || record.childPid === null))) {
    throw new Error('Invalid Tool Task final receipt');
  }
  const { receiptDigest, ...unsigned } = record;
  if (digestText(JSON.stringify(unsigned)) !== receiptDigest) throw new Error('Tool Task receipt digest mismatch');
  return record as ToolTaskFinalReceipt;
}

async function readHeartbeat(
  filePath: string,
  task: ToolTaskRecord,
  identity: ToolTaskSupervisorIdentity,
): Promise<ToolTaskSupervisorHeartbeat | null> {
  const value = await readJson(filePath, 4_096);
  if (value === null || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<ToolTaskSupervisorHeartbeat>;
  if (record.version !== 1 || record.taskId !== task.taskId || record.nonce !== task.nonce
    || record.supervisorPid !== identity.supervisorPid || !Number.isFinite(record.updatedAt)) return null;
  return record as ToolTaskSupervisorHeartbeat;
}

async function readProgress(filePath: string, now: number): Promise<ToolTaskProgress | null> {
  const value = await readJson(filePath, 4_096);
  if (value === null || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['phase', 'message', 'fraction'].includes(key))) return null;
  const phase = record.phase === undefined || record.phase === null ? null : normalizedOptionalText(record.phase, 120);
  const message = record.message === undefined || record.message === null ? null : normalizedOptionalText(record.message, 1_000);
  const fraction = record.fraction === undefined || record.fraction === null ? null : Number(record.fraction);
  if (fraction !== null && (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)) return null;
  return { phase, message, fraction, updatedAt: now };
}

function normalizedOptionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || null;
}

async function readJson(filePath: string, maxBytes = 64 * 1024): Promise<unknown | null> {
  try {
    const bytes = await readFile(filePath);
    if (bytes.byteLength > maxBytes) throw new Error(`JSON file exceeds ${maxBytes} bytes`);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function stabilizeOutput(
  paths: ReturnType<typeof taskPaths>,
  task: ToolTaskRecord,
  receipt: ToolTaskFinalReceipt,
  maxBytes: number,
): Promise<{ readonly stdoutBytes: number; readonly stderrBytes: number }> {
  const existing = await readJson(paths.sanitized, 4_096).catch(() => null) as {
    readonly version?: unknown;
    readonly taskId?: unknown;
    readonly nonce?: unknown;
    readonly receiptDigest?: unknown;
  } | null;
  if (existing?.version === 1 && existing.taskId === task.taskId && existing.nonce === task.nonce
    && existing.receiptDigest === receipt.receiptDigest) {
    const [stdoutBytes, stderrBytes] = await Promise.all([fileSize(paths.stdout), fileSize(paths.stderr)]);
    return { stdoutBytes, stderrBytes };
  }
  const [stdout, stderr] = await Promise.all([readFile(paths.stdout), readFile(paths.stderr)]);
  if (stdout.byteLength + stderr.byteLength > maxBytes) {
    throw new Error('Tool Task output exceeds its durable detail ceiling');
  }
  const stabilized = boundCombinedBuffers(
    Buffer.from(scanUntrustedOutput(redactSecretLikeContent(stdout.toString('utf8')))),
    Buffer.from(scanUntrustedOutput(redactSecretLikeContent(stderr.toString('utf8')))),
    maxBytes,
  );
  await Promise.all([
    atomicBufferWrite(paths.stdout, stabilized.stdout),
    atomicBufferWrite(paths.stderr, stabilized.stderr),
  ]);
  await atomicJsonWrite(paths.sanitized, {
    version: 1,
    taskId: task.taskId,
    nonce: task.nonce,
    receiptDigest: receipt.receiptDigest,
  });
  return {
    stdoutBytes: stabilized.stdout.byteLength,
    stderrBytes: stabilized.stderr.byteLength,
  };
}

function boundCombinedBuffers(
  stdout: Buffer,
  stderr: Buffer,
  maxBytes: number,
): { readonly stdout: Buffer; readonly stderr: Buffer } {
  if (stdout.byteLength + stderr.byteLength <= maxBytes) return { stdout, stderr };
  const stdoutLimit = Math.min(stdout.byteLength, Math.floor(maxBytes * 0.75));
  const stderrLimit = Math.min(stderr.byteLength, maxBytes - stdoutLimit);
  const unused = maxBytes - stdoutLimit - stderrLimit;
  const expandedStdoutLimit = Math.min(stdout.byteLength, stdoutLimit + unused);
  const expandedStderrLimit = Math.min(stderr.byteLength, maxBytes - expandedStdoutLimit);
  return {
    stdout: stdout.subarray(0, expandedStdoutLimit),
    stderr: stderr.subarray(0, expandedStderrLimit),
  };
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

async function atomicBufferWrite(target: string, value: Buffer): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, target);
}

async function readPreview(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  try {
    const bytes = await readFile(filePath);
    if (bytes.byteLength <= maxBytes) return { text: bytes.toString('utf8'), truncated: false };
    const head = Math.floor(maxBytes * 0.7);
    const tail = maxBytes - head;
    return {
      text: `${bytes.subarray(0, head).toString('utf8')}\n...[output truncated]...\n${bytes.subarray(-tail).toString('utf8')}`,
      truncated: true,
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { text: '', truncated: false };
    throw error;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try { return (await stat(filePath)).size; }
  catch { return 0; }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}

function processGroupExists(pid: number): boolean {
  if (process.platform === 'win32') return processExists(pid);
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}

async function atomicJsonWrite(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

async function readPreparedResultEvidence(filePath: string, maxBytes: number): Promise<{
  readonly sha256: string | null;
  readonly byteLength: number;
}> {
  const bytes = await readFile(filePath).catch((error: unknown) => {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (!bytes) return { sha256: null, byteLength: 0 };
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new Error('Tool Task prepared result exceeds its byte limit');
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

async function verifyPreparedResult(
  filePath: string,
  receipt: ToolTaskFinalReceipt,
  maxBytes: number,
): Promise<void> {
  const evidence = await readPreparedResultEvidence(filePath, maxBytes);
  if (evidence.sha256 !== receipt.preparedResultDigest
    || evidence.byteLength !== receipt.preparedResultBytes) {
    throw new Error('Tool Task prepared result does not match its final receipt');
  }
}

function preparedResultMaxBytes(taskDetailBytes: number): number {
  return Math.min(
    TOOL_TASK_PREPARED_RESULT_MAX_BYTES,
    Math.max(1, Math.floor(taskDetailBytes / 4)),
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedLabel(value: string, fallback: string): string {
  return value.trim().slice(0, 500) || fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedReceiptField(value: string, maxLength: number, fallback: string): string {
  const normalized = value.trim() || fallback;
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
