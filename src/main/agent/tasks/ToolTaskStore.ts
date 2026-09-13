import { toolTaskStoreSchema } from './ToolTaskStore.schema';
import { decodeProcessIsolationEvidence, pendingProcessIsolation, sameIsolationRequest, type ProcessIsolationEvidence } from '../../../core/agent/processIsolation';
import { createHash, randomUUID } from 'node:crypto';
import {
  decodeTaskCompletionAgreement, decodeTaskContinuation, decodeTaskControlInput, decodeTaskControlReceipt, initialTaskContinuation, taskDeliverySettled,
  settleTaskEvent, taskOwesContinuation,
  type TaskCompletionAgreement, type TaskContinuation, type TaskControlInput, type TaskControlReceipt,
  type TaskItemReference, type TaskStopProvenance,
} from '../../../core/agent/taskContinuation';
import { validateExecutionContext } from './ExecutionContext';
import type { ThreadContextPayloadReference, ThreadId, ThreadResourceReference, TurnId } from '../../../core/agent/protocol';
import { decodeThreadContextPayloadReference } from '../../../core/agent/codec';
import type { SqliteDatabase } from '../persistence/sqlite';
import {
  isToolTaskTerminal,
  type ToolTaskDeliveryBatch,
  type ToolTaskArtifactSettlement,
  type ToolTaskDeliveryState,
  type ToolTaskDetailState,
  type ToolTaskExecutionState,
  type ToolTaskFinalReceipt,
  type ToolTaskLease,
  type ToolTaskProgress,
  type ToolTaskProjection,
  type ToolTaskRecord,
  type ToolTaskStoragePressure,
  type ToolTaskSchedulerLimits,
  type ToolTaskSchedulingPolicy,
} from './toolTaskTypes';

interface ToolTaskRow {
  continuation_json: string;
  control_receipts_json: string;
  task_id: string;
  owner_thread_id: string;
  source_turn_id: string;
  source_item_id: string;
  producer: string;
  description: string;
  command_digest: string;
  cwd: string;
  execution_context_json: string;
  isolation_json: string;
  operation_kind: 'process' | 'host';
  parent_task_id: string | null;
  nonce: string;
  detail_path: string;
  background_enabled: number;
  supervisor_pid: number | null;
  child_pid: number | null;
  state: string;
  delivery_state: string;
  progress_json: string | null;
  exit_code: number | null;
  signal: string | null;
  outcome_reason: string | null;
  error_message: string | null;
  detail_state: string;
  timeout_ms: number | null;
  stop_requested_at: number | null;
  terminal_digest: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  output_bytes: number;
  started_at: number;
  completed_at: number | null;
  quiesced_at: number | null;
  delivery_turn_id: string | null;
  delivered_at: number | null;
  updated_at: number;
  artifacts_json: string;
  artifact_warnings_json: string;
  artifacts_settled: number;
  reservation_bytes: number;
  detail_bytes: number;
  storage_pressure_json: string | null;
}

export interface ToolTaskStorageLimits {
  readonly taskDetailBytes: number;
  readonly threadDetailBytes: number;
  readonly applicationDetailBytes: number;
}

export interface ToolTaskReservationResult {
  readonly accepted: boolean;
  readonly task: ToolTaskRecord;
}

interface DeliveryBatchRow {
  batch_id: string;
  owner_thread_id: string;
  reserved_turn_id: string;
  client_id: string;
  envelope_digest: string;
  state: string;
  created_at: number;
  updated_at: number;
}

interface DeliveryMemberRow {
  task_id: string;
  terminal_digest: string;
  ordinal: number;
}

interface ToolTaskLeaseRow {
  task_id: string;
  owner_thread_id: string;
  nonce: string;
  producer: string;
  pool: string;
  configuration_revision: string;
  max_concurrent_producer: number;
  max_concurrent_pool: number;
  state: string;
  created_at: number;
  acquired_at: number | null;
  released_at: number | null;
}

export class ToolTaskStore {
  private restoredTaskIds = '[]';
  setRestoredTaskIds(ids: readonly string[]): void { this.restoredTaskIds = JSON.stringify(ids); }

  constructor(private readonly db: SqliteDatabase) {
    const columns = this.db.prepare('PRAGMA table_info(tool_tasks)').all() as Array<{ name: string }>;
    if (columns.length > 0 && ['execution_context_json', 'isolation_json', 'continuation_json', 'control_receipts_json']
      .some((required) => !columns.some(({ name }) => name === required))) {
      throw new Error('Tool Task storage has an unsupported format. Use data recovery or a compatible application.');
    }
    this.db.exec(toolTaskStoreSchema);
  }

  /** Bytes live in the existing context evidence store; this is delivery ownership only. */
  publishContextSuccessor(taskId: string, ref: ThreadContextPayloadReference, createdAt: number): void {
    if (decodeThreadContextPayloadReference(ref).kind !== 'executionContextObservation') throw new Error('Invalid discovery reference');
    return this.transaction(() => {
      const task = this.require(taskId);
      const existing = this.db.prepare(
        'SELECT payload_ref_json FROM tool_task_context_successors WHERE predecessor_ref = ?',
      ).get(task.executionContext.snapshotRef) as { payload_ref_json: string } | undefined;
      if (existing) {
        if (existing.payload_ref_json !== JSON.stringify(ref)) {
          throw new Error('Execution context successor is immutable');
        }
        return;
      }
      this.db.prepare(`
        INSERT INTO tool_task_context_successors(predecessor_ref, task_id, payload_ref_json, created_at, delivery_state)
        VALUES (?, ?, ?, ?, 'pending')
      `).run(task.executionContext.snapshotRef, taskId, JSON.stringify(ref), createdAt);
    });
  }

  contextSuccessor(taskId: string): { taskId: string; ref: ThreadContextPayloadReference } | null {
    const task = this.read(taskId);
    if (!task) return null;
    const row = this.db.prepare(
      'SELECT task_id, payload_ref_json FROM tool_task_context_successors WHERE predecessor_ref = ?',
    ).get(task.executionContext.snapshotRef) as { task_id: string; payload_ref_json: string } | undefined;
    return row ? { taskId: row.task_id, ref: decodeThreadContextPayloadReference(JSON.parse(row.payload_ref_json)) } : null;
  }

  pendingContextObservations(ownerThreadId: string): readonly { taskId: string; ref: ThreadContextPayloadReference }[] {
    return (this.db.prepare(`SELECT s.task_id, s.payload_ref_json FROM tool_task_context_successors s
      JOIN tool_tasks t ON t.task_id = s.task_id WHERE t.owner_thread_id = ? AND s.delivery_state = 'pending'
      ORDER BY s.created_at, s.task_id LIMIT 32`).all(ownerThreadId) as { task_id: string; payload_ref_json: string }[])
      .map((row) => ({ taskId: row.task_id, ref: decodeThreadContextPayloadReference(JSON.parse(row.payload_ref_json)) }));
  }

  settleContextObservation(taskId: string, state: 'delivered' | 'blocked'): void {
    this.db.prepare("UPDATE tool_task_context_successors SET delivery_state = ? WHERE task_id = ? AND delivery_state = 'pending'").run(state, taskId);
  }

  discoveryCandidates(ownerThreadId: string, limit = 32): readonly ToolTaskRecord[] {
    return (this.db.prepare(`SELECT * FROM tool_tasks WHERE owner_thread_id = ? ORDER BY started_at DESC, task_id DESC LIMIT ?`)
      .all(ownerThreadId, limit) as ToolTaskRow[]).map(taskFromRow);
  }

  missingContextSuccessors(ownerThreadId: string, afterTaskId: string, limit: number): readonly ToolTaskRecord[] {
    return (this.db.prepare(`SELECT t.* FROM tool_tasks t
      WHERE t.owner_thread_id = ? AND t.task_id > ? AND t.delivery_state != 'blocked'
        AND NOT EXISTS (SELECT 1 FROM tool_task_context_successors s
          WHERE s.predecessor_ref = json_extract(t.execution_context_json, '$.snapshotRef'))
      ORDER BY t.task_id LIMIT ?`).all(ownerThreadId, afterTaskId, limit) as ToolTaskRow[]).map(taskFromRow);
  }

  admitLease(
    taskId: string,
    policy: ToolTaskSchedulingPolicy,
    limits: ToolTaskSchedulerLimits,
    now: number,
  ): { readonly state: 'active' | 'queued' | 'refused'; readonly lease: ToolTaskLease | null } {
    assertScheduling(policy, limits);
    return this.transaction(() => {
      const task = this.require(taskId);
      const existing = this.readLease(taskId);
      if (existing) return { state: existing.state === 'released' ? 'refused' : existing.state, lease: existing };
      const active = this.activeLeases();
      const canStart = leaseFits(active, task, policy, limits);
      if (!canStart) {
        const queued = this.queuedLeases();
        const threadQueued = queued.filter((lease) => lease.ownerThreadId === task.ownerThreadId).length;
        if (queued.length >= limits.maxQueuedGlobal || threadQueued >= limits.maxQueuedThread) {
          return { state: 'refused', lease: null };
        }
      }
      this.db.prepare(`
        INSERT INTO tool_task_leases(
          task_id, owner_thread_id, nonce, producer, pool, configuration_revision,
          max_concurrent_producer, max_concurrent_pool, state, created_at, acquired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.taskId,
        task.ownerThreadId,
        task.nonce,
        task.producer,
        policy.pool,
        policy.configurationRevision,
        policy.maxConcurrentProducer,
        policy.maxConcurrentPool,
        canStart ? 'active' : 'queued',
        now,
        canStart ? now : null,
      );
      return { state: canStart ? 'active' : 'queued', lease: this.readLease(taskId)! };
    });
  }

  ensureRecoveryLease(
    task: ToolTaskRecord,
    policy: ToolTaskSchedulingPolicy,
    now: number,
  ): ToolTaskLease {
    const existing = this.readLease(task.taskId);
    if (existing) {
      if (existing.ownerThreadId !== task.ownerThreadId || existing.nonce !== task.nonce) {
        throw new Error(`Tool Task lease identity mismatch: ${task.taskId}`);
      }
      return existing;
    }
    this.db.prepare(`
      INSERT INTO tool_task_leases(
        task_id, owner_thread_id, nonce, producer, pool, configuration_revision,
        max_concurrent_producer, max_concurrent_pool, state, created_at, acquired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      task.taskId,
      task.ownerThreadId,
      task.nonce,
      task.producer,
      policy.pool,
      policy.configurationRevision,
      policy.maxConcurrentProducer,
      policy.maxConcurrentPool,
      task.startedAt,
      task.startedAt,
    );
    return this.readLease(task.taskId)!;
  }

  tryActivateLease(taskId: string, limits: ToolTaskSchedulerLimits, now: number): ToolTaskLease | null {
    return this.transaction(() => {
      const lease = this.readLease(taskId);
      if (!lease || lease.state !== 'queued') return lease;
      const first = this.queuedLeases()[0];
      if (first?.taskId !== taskId) return lease;
      const task = this.require(taskId);
      const policy: ToolTaskSchedulingPolicy = {
        pool: lease.pool,
        configurationRevision: lease.configurationRevision,
        maxConcurrentProducer: lease.maxConcurrentProducer,
        maxConcurrentPool: lease.maxConcurrentPool,
      };
      if (!leaseFits(this.activeLeases(), task, policy, limits)) return lease;
      this.db.prepare(`
        UPDATE tool_task_leases SET state = 'active', acquired_at = ?
        WHERE task_id = ? AND state = 'queued'
      `).run(now, taskId);
      return this.readLease(taskId);
    });
  }

  readLease(taskId: string): ToolTaskLease | null {
    const row = this.db.prepare('SELECT * FROM tool_task_leases WHERE task_id = ?')
      .get(taskId) as ToolTaskLeaseRow | undefined;
    return row ? leaseFromRow(row) : null;
  }

  queuedLeases(): readonly ToolTaskLease[] {
    return (this.db.prepare(`
      SELECT * FROM tool_task_leases WHERE state = 'queued'
        AND task_id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at, task_id
    `).all(this.restoredTaskIds) as ToolTaskLeaseRow[]).map(leaseFromRow);
  }

  activeLeases(): readonly ToolTaskLease[] {
    return (this.db.prepare(`
      SELECT * FROM tool_task_leases WHERE state = 'active'
        AND task_id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at, task_id
    `).all(this.restoredTaskIds) as ToolTaskLeaseRow[]).map(leaseFromRow);
  }

  releaseLease(taskId: string, now: number): ToolTaskLease | null {
    this.db.prepare(`
      UPDATE tool_task_leases SET state = 'released', released_at = ?
      WHERE task_id = ? AND state IN ('queued', 'active')
    `).run(now, taskId);
    return this.readLease(taskId);
  }

  create(input: Omit<ToolTaskRecord,
    | 'state' | 'deliveryState' | 'progress' | 'supervisorPid' | 'childPid'
    | 'exitCode' | 'signal' | 'outcomeReason' | 'error' | 'detailState'
    | 'stopRequestedAt' | 'terminalDigest' | 'stdoutBytes' | 'stderrBytes'
    | 'outputBytes' | 'completedAt' | 'quiescedAt' | 'deliveryTurnId' | 'updatedAt'
    | 'artifacts' | 'artifactWarnings' | 'artifactsSettled' | 'reservationBytes' | 'deliveredAt'
    | 'detailBytes' | 'storagePressure' | 'isolation'
    | 'continuation' | 'controlReceipts'
  > & { isolation?: ProcessIsolationEvidence; completionAgreement?: TaskCompletionAgreement }): ToolTaskRecord {
    const agreement = decodeTaskCompletionAgreement(input.completionAgreement ?? { kind: 'result' });
    if (agreement.kind === 'service' && (!input.backgroundEnabled || input.operationKind !== 'process' || input.producer !== 'bash')) {
      throw new Error('Only explicit background Bash services may use a service agreement');
    }
    const continuation = initialTaskContinuation(agreement, `watch_${randomUUID()}`);
    validateExecutionContext(input.executionContext);
    const isolation = decodeProcessIsolationEvidence(input.isolation ?? pendingProcessIsolation(input.executionContext.policy, process.platform));
    if (isolation.requested !== input.executionContext.policy.isolation) throw new Error('Task isolation differs from admitted policy');
    if (input.cwd !== input.executionContext.address.cwd) throw new Error('Task cwd differs from admitted address');
    return this.transaction(() => {
      if (input.parentTaskId) {
        const owner = this.read(input.parentTaskId);
        if (!owner || isToolTaskTerminal(owner.state)) throw new Error('Execution owner is unavailable');
      }
      this.db.prepare(`
      INSERT INTO tool_tasks(
        task_id, owner_thread_id, source_turn_id, source_item_id, producer, description,
        command_digest, cwd, execution_context_json, isolation_json, operation_kind, parent_task_id,
        nonce, detail_path, background_enabled, state, delivery_state, detail_state,
        timeout_ms, started_at, updated_at, continuation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'pending', 'available', ?, ?, ?, ?)
    `).run(
      input.taskId, input.ownerThreadId, input.sourceTurnId, input.sourceItemId,
      input.producer, input.description, input.commandDigest, input.cwd,
      JSON.stringify(input.executionContext), JSON.stringify(isolation), input.operationKind, input.parentTaskId, input.nonce,
      input.detailPath, input.backgroundEnabled ? 1 : 0, input.timeoutMs, input.startedAt, input.startedAt, JSON.stringify(continuation),
    );
      return this.read(input.taskId)!;
    });
  }

  controlReceipt(input: TaskControlInput): TaskControlReceipt | null {
    const normalized = decodeTaskControlInput(input);
    const prior = this.require(input.task_id).controlReceipts.find(({ receipt }) => receipt.operationId === input.operation_id);
    if (!prior) return null;
    if (prior.digest !== controlDigest(normalized)) throw new Error('Task operation identity was reused with different input');
    return prior.receipt;
  }

  /** Caller authority and readiness are checked by the Host before entering this synchronous commit. */
  control(input: TaskControlInput, caller: TaskItemReference, now: number): TaskControlReceipt {
    input = decodeTaskControlInput(input);
    return this.transaction(() => {
      const replay = this.controlReceipt(input);
      if (replay) return replay;
      const task = this.require(input.task_id);
      if (task.controlReceipts.length >= 256) throw new Error('Task operation receipt limit reached');
      let continuation = task.continuation;
      let status: TaskControlReceipt['status'] = 'conflict';
      const mutableEvent = task.deliveryState !== 'delivering' && task.deliveryState !== 'blocked';
      const liveService = task.state === 'running' && task.supervisorPid !== null && task.childPid !== null
        && continuation.kind === 'service' && continuation.stop === null;
      if (input.action === 'acknowledge') {
        const event = continuation.event;
        if (event?.id === input.event_id) {
          if (event.disposition === 'handled' || event.disposition === 'admitted') status = 'already_handled';
          else if (mutableEvent && event.disposition === 'pending') {
            status = 'accepted';
            continuation = { ...continuation, event: { ...event, disposition: 'handled', handling: { kind: 'turn', ...caller } } };
          }
        }
      } else if (input.expected_revision === continuation.revision && mutableEvent) {
        if (input.action === 'handoff' && liveService && !continuation.handoff) {
          status = 'accepted';
          continuation = { ...continuation, handoff: { by: caller, readiness: input.readiness } };
        } else if (input.action === 'start_watch' && liveService && continuation.watch?.revokedAt !== null
          && JSON.stringify(continuation.watch?.request) !== JSON.stringify(input.request)) {
          status = 'accepted';
          continuation = { ...continuation, watch: { id: `watch_${randomUUID()}`, request: input.request, revokedAt: null } };
        } else if (input.action === 'revoke_watch' && continuation.watch?.id === input.watch_id
          && continuation.watch.revokedAt === null) {
          status = 'accepted';
          continuation = { ...continuation, watch: { ...continuation.watch, revokedAt: now } };
        }
      }
      if (status === 'accepted') {
        continuation = { ...continuation, revision: continuation.revision + 1 };
        if (continuation.event?.disposition === 'pending') continuation = { ...continuation, event: settleTaskEvent(continuation, continuation.event.id) };
      }
      const receipt: TaskControlReceipt = {
        operationId: input.operation_id, taskId: task.taskId, action: input.action, status,
        revision: continuation.revision, watchId: continuation.watch?.id ?? null, event: continuation.event,
      };
      this.writeContinuation(task, continuation, now);
      this.db.prepare('UPDATE tool_tasks SET control_receipts_json = ? WHERE task_id = ?')
        .run(JSON.stringify([...task.controlReceipts, { digest: controlDigest(input), receipt }]), task.taskId);
      return receipt;
    });
  }

  stopResponsibilities(taskId: string, source: TaskStopProvenance, now: number): ToolTaskRecord {
    return this.transaction(() => {
      const task = this.require(taskId);
      if (task.continuation.stop) return task;
      if (task.deliveryState === 'delivering') throw new Error('Reconcile the prepared delivery before accepting Stop');
      let continuation: TaskContinuation = { ...task.continuation, stop: source, revision: task.continuation.revision + 1 };
      if (continuation.event?.disposition === 'pending' && task.deliveryState !== 'blocked') {
        continuation = { ...continuation, event: settleTaskEvent(continuation, continuation.event.id) };
      }
      this.writeContinuation(task, continuation, now);
      return this.require(taskId);
    });
  }

  deliveryIsCurrent(batchId: string): boolean {
    const batch = this.readBatch(batchId);
    return batch?.state === 'prepared' && batch.taskIds.every((id) => {
      const task = this.require(id);
      return task.deliveryState === 'delivering' && task.continuation.event?.disposition === 'pending'
        && taskOwesContinuation(task.continuation);
    });
  }

  private writeContinuation(task: ToolTaskRecord, continuation: TaskContinuation, now: number): void {
    decodeTaskContinuation(continuation);
    const disposition = continuation.event?.disposition;
    const delivery = disposition === 'silent' || disposition === 'handled' ? disposition : task.deliveryState;
    this.db.prepare(`UPDATE tool_tasks SET continuation_json = ?, delivery_state = ?,
      delivered_at = CASE WHEN ? IN ('silent', 'handled') THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
      updated_at = ? WHERE task_id = ?`).run(JSON.stringify(continuation), delivery, delivery, now, now, task.taskId);
  }

  setIsolation(taskId: string, evidence: ProcessIsolationEvidence): ToolTaskRecord {
    decodeProcessIsolationEvidence(evidence);
    const current = this.require(taskId);
    if (!sameIsolationRequest(current.isolation, evidence)) throw new Error('Process isolation request is immutable');
    if (current.isolation.state !== null || isToolTaskTerminal(current.state)) {
      if (current.isolation.state !== evidence.state || current.isolation.reason !== evidence.reason) throw new Error('Process isolation result is immutable');
      return current;
    }
    this.db.prepare('UPDATE tool_tasks SET isolation_json = ? WHERE task_id = ?').run(JSON.stringify(evidence), taskId);
    return this.require(taskId);
  }

  reserveDetail(
    taskId: string,
    bytes: number,
    limits: ToolTaskStorageLimits,
    now: number,
  ): ToolTaskReservationResult {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.taskDetailBytes) {
      throw new Error('Invalid Tool Task detail reservation');
    }
    return this.transaction(() => {
      const task = this.require(taskId);
      if (task.reservationBytes === bytes && task.storagePressure === null) {
        return { accepted: true, task };
      }
      if (task.reservationBytes !== 0 || isToolTaskTerminal(task.state)) {
        throw new Error(`Tool Task detail reservation is immutable: ${taskId}`);
      }
      const records = this.allRecords();
      const withoutTask = records.filter((candidate) => candidate.taskId !== taskId);
      const thread = storageUsage(withoutTask.filter((candidate) => candidate.ownerThreadId === task.ownerThreadId), 'logical');
      const application = storageUsage(withoutTask, 'physical');
      const pressure = thread.usedBytes + bytes > limits.threadDetailBytes
        ? storagePressure('thread', limits.threadDetailBytes, thread, bytes)
        : application.usedBytes + bytes > limits.applicationDetailBytes
          ? storagePressure('application', limits.applicationDetailBytes, application, bytes)
          : null;
      if (pressure) {
        this.db.prepare(`
          UPDATE tool_tasks SET detail_state = 'storage_pressure', storage_pressure_json = ?, updated_at = ?
          WHERE task_id = ? AND reservation_bytes = 0 AND state IN ('running', 'settling')
        `).run(JSON.stringify(pressure), now, taskId);
        return { accepted: false, task: this.require(taskId) };
      }
      this.db.prepare(`
        UPDATE tool_tasks SET reservation_bytes = ?, storage_pressure_json = NULL, updated_at = ?
        WHERE task_id = ? AND reservation_bytes = 0 AND state IN ('running', 'settling')
      `).run(bytes, now, taskId);
      return { accepted: true, task: this.require(taskId) };
    });
  }

  read(taskId: string): ToolTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tool_tasks WHERE task_id = ?').get(taskId) as ToolTaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  owned(taskId: string, ownerThreadId: ThreadId): ToolTaskRecord | null {
    const task = this.read(taskId);
    return task?.ownerThreadId === ownerThreadId ? task : null;
  }

  list(ownerThreadId: ThreadId): readonly ToolTaskRecord[] {
    return (this.db.prepare(`
      SELECT * FROM tool_tasks WHERE owner_thread_id = ? AND background_enabled = 1
      ORDER BY started_at, task_id
    `).all(ownerThreadId) as ToolTaskRow[]).map(taskFromRow);
  }

  nonterminal(): readonly ToolTaskRecord[] {
    return (this.db.prepare(`
      SELECT * FROM tool_tasks WHERE state IN ('running', 'settling')
        AND task_id NOT IN (SELECT value FROM json_each(?)) ORDER BY started_at, task_id
    `).all(this.restoredTaskIds) as ToolTaskRow[]).map(taskFromRow);
  }

  coveredChildren(taskId: string): readonly ToolTaskRecord[] {
    return (this.db.prepare(`
      SELECT * FROM tool_tasks WHERE parent_task_id = ? AND state IN ('running', 'settling')
      ORDER BY started_at DESC, task_id
    `).all(taskId) as ToolTaskRow[]).map(taskFromRow);
  }

  sessionExecution(sessionId: ThreadId): ToolTaskRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM tool_tasks WHERE owner_thread_id = ? AND producer = 'delegate_execution'
      AND state IN ('running', 'settling') ORDER BY started_at DESC, task_id LIMIT 1
    `).get(sessionId) as ToolTaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  setSupervisor(taskId: string, supervisorPid: number, childPid: number | null, now: number): ToolTaskRecord {
    this.db.prepare(`
      UPDATE tool_tasks SET supervisor_pid = ?, child_pid = COALESCE(?, child_pid), updated_at = ?
      WHERE task_id = ? AND state IN ('running', 'settling')
    `).run(supervisorPid, childPid, now, taskId);
    return this.require(taskId);
  }

  markSettling(taskId: string, now: number, stopRequested = false): ToolTaskRecord {
    this.db.prepare(`
      UPDATE tool_tasks SET state = 'settling',
        stop_requested_at = CASE WHEN ? = 1 THEN COALESCE(stop_requested_at, ?) ELSE stop_requested_at END,
        updated_at = ?
      WHERE task_id = ? AND state IN ('running', 'settling')
    `).run(stopRequested ? 1 : 0, now, now, taskId);
    return this.require(taskId);
  }

  setCoordinationError(taskId: string, error: string, now: number, reason: 'ownership_unverified' | null = null): ToolTaskRecord {
    this.db.prepare(`
      UPDATE tool_tasks SET state = 'settling', error_message = ?, outcome_reason = ?, updated_at = ?
      WHERE task_id = ? AND state IN ('running', 'settling')
    `).run(error, reason, now, taskId);
    return this.require(taskId);
  }

  restoreVerifiedOwnership(taskId: string, now: number): ToolTaskRecord | null {
    const changed = this.db.prepare(`UPDATE tool_tasks SET state = 'running', error_message = NULL,
      outcome_reason = NULL, updated_at = ? WHERE task_id = ? AND state = 'settling'
      AND outcome_reason = 'ownership_unverified' AND stop_requested_at IS NULL AND terminal_digest IS NULL`)
      .run(now, taskId);
    return changed.changes ? this.require(taskId) : null;
  }

  commitTerminal(
    taskId: string,
    receipt: ToolTaskFinalReceipt,
    now: number,
    stabilizedOutput = {
      stdoutBytes: receipt.stdoutBytes,
      stderrBytes: receipt.stderrBytes,
      preparedResultBytes: receipt.preparedResultBytes,
    },
  ): ToolTaskRecord {
    const current = this.require(taskId);
    assertFinalReceipt(current, receipt);
    if (isToolTaskTerminal(current.state)) {
      if (current.terminalDigest !== receipt.receiptDigest) {
        throw new Error(`Tool Task terminal receipt is immutable: ${taskId}`);
      }
      return current;
    }
    if (!current.artifactsSettled) {
      throw new Error(`Tool Task artifacts must settle before terminal commit: ${taskId}`);
    }
    if (this.coveredChildren(taskId).length > 0) throw new Error('Covered child execution must settle before releasing its owner execution');
    if (receipt.taskId !== taskId || receipt.nonce !== current.nonce) {
      throw new Error(`Tool Task receipt identity mismatch: ${taskId}`);
    }
    const artifactBytes = current.artifacts.reduce((sum, artifact) => sum + artifact.ref.byteLength, 0);
    const outputBytes = stabilizedOutput.stdoutBytes + stabilizedOutput.stderrBytes;
    const detailBytes = outputBytes + artifactBytes + stabilizedOutput.preparedResultBytes;
    if (!Number.isSafeInteger(outputBytes) || outputBytes < 0
      || !Number.isSafeInteger(detailBytes) || detailBytes < 0) {
      throw new Error(`Invalid Tool Task settled detail size: ${taskId}`);
    }
    this.transaction(() => {
      this.setIsolation(taskId, receipt.isolation);
      this.db.prepare(`
        UPDATE tool_tasks SET
          state = ?, exit_code = ?, signal = ?, outcome_reason = ?, error_message = ?,
          supervisor_pid = COALESCE(?, supervisor_pid), child_pid = COALESCE(?, child_pid),
          terminal_digest = ?, stdout_bytes = ?, stderr_bytes = ?, output_bytes = ?, detail_bytes = ?,
          reservation_bytes = 0, completed_at = ?, quiesced_at = ?, updated_at = ?
        WHERE task_id = ? AND state IN ('running', 'settling')
      `).run(
        receipt.state, receipt.exitCode, receipt.signal, receipt.reason, receipt.error,
        receipt.supervisorPid, receipt.childPid, receipt.receiptDigest,
        stabilizedOutput.stdoutBytes, stabilizedOutput.stderrBytes, outputBytes, detailBytes,
        receipt.quiescedAt, receipt.quiescedAt, now, taskId,
      );
      this.releaseLease(taskId, now);
      const settled = this.require(taskId);
      this.writeContinuation(settled, { ...settled.continuation, event: settleTaskEvent(settled.continuation, receipt.receiptDigest) }, now);
    });
    return this.require(taskId);
  }

  setProgress(taskId: string, progress: ToolTaskProgress, now: number): ToolTaskRecord {
    assertToolTaskProgress(progress);
    this.db.prepare(`
      UPDATE tool_tasks SET progress_json = ?, updated_at = ?
      WHERE task_id = ? AND state IN ('running', 'settling')
    `).run(JSON.stringify(progress), now, taskId);
    return this.require(taskId);
  }

  settleArtifacts(taskId: string, settlement: ToolTaskArtifactSettlement, now: number): ToolTaskRecord {
    const current = this.require(taskId);
    if (current.artifactsSettled) {
      if (JSON.stringify(current.artifacts) !== JSON.stringify(settlement.artifacts)
        || JSON.stringify(current.artifactWarnings) !== JSON.stringify(settlement.warnings)) {
        throw new Error(`Tool Task artifact settlement is immutable: ${taskId}`);
      }
      return current;
    }
    if (isToolTaskTerminal(current.state)) {
      throw new Error(`Tool Task artifact settlement is terminal: ${taskId}`);
    }
    decodeArtifacts(JSON.stringify(settlement.artifacts));
    decodeArtifactWarnings(JSON.stringify(settlement.warnings));
    this.db.prepare(`
      UPDATE tool_tasks SET artifacts_json = ?, artifact_warnings_json = ?, artifacts_settled = 1, updated_at = ?
      WHERE task_id = ? AND artifacts_settled = 0 AND state IN ('running', 'settling')
    `).run(JSON.stringify(settlement.artifacts), JSON.stringify(settlement.warnings), now, taskId);
    return this.require(taskId);
  }

  artifactReferences(ownerThreadId: ThreadId): readonly ThreadResourceReference[] {
    return this.listAll(ownerThreadId).flatMap((task) => task.artifacts.map((artifact) => artifact.ref));
  }

  ownerIds(): readonly ThreadId[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT owner_thread_id FROM tool_tasks ORDER BY owner_thread_id
    `).all() as Array<{ owner_thread_id: string }>;
    return rows.map((row) => row.owner_thread_id);
  }

  blockOwnerDelivery(ownerThreadId: ThreadId, now: number): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE tool_task_delivery_batches SET state = 'blocked', updated_at = ?
        WHERE owner_thread_id = ? AND state = 'prepared'
      `).run(now, ownerThreadId);
      this.db.prepare(`
        UPDATE tool_tasks SET delivery_state = 'blocked', updated_at = ?
        WHERE owner_thread_id = ? AND background_enabled = 1
          AND delivery_state IN ('pending', 'delivering')
      `).run(now, ownerThreadId);
      this.db.prepare(`
        UPDATE tool_task_context_successors SET delivery_state = 'blocked'
        WHERE task_id IN (SELECT task_id FROM tool_tasks WHERE owner_thread_id = ?)
          AND delivery_state = 'pending'
      `).run(ownerThreadId);
    });
  }

  logicalDetailBytes(ownerThreadId: ThreadId): number {
    return storageUsage(this.listAll(ownerThreadId), 'logical').usedBytes;
  }

  physicalDetailBytes(): number {
    return storageUsage(this.allRecords(), 'physical').usedBytes;
  }

  hasBlockingWork(threadId: ThreadId): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM tool_tasks
      WHERE owner_thread_id = ? AND background_enabled = 1 AND (
        state IN ('running', 'settling') OR delivery_state IN ('pending', 'delivering')
      ) AND task_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1
    `).get(threadId, this.restoredTaskIds));
  }

  prepareDelivery(input: {
    readonly batchId: string;
    readonly ownerThreadId: ThreadId;
    readonly reservedTurnId: TurnId;
    readonly clientId: string;
    readonly envelopeDigest: string;
    readonly taskIds: readonly string[];
    readonly now: number;
  }): ToolTaskDeliveryBatch {
    if (input.taskIds.length === 0) throw new Error('Tool Task delivery batch must not be empty');
    this.transaction(() => {
      const tasks = input.taskIds.map((taskId) => this.require(taskId));
      if (tasks.some((task) => (
        task.ownerThreadId !== input.ownerThreadId
        || !isToolTaskTerminal(task.state)
        || task.deliveryState !== 'pending'
        || task.terminalDigest === null
        || task.continuation.event?.disposition !== 'pending'
        || !taskOwesContinuation(task.continuation)
      ))) throw new Error('Tool Task delivery membership is stale');
      this.db.prepare(`
        INSERT INTO tool_task_delivery_batches(
          batch_id, owner_thread_id, reserved_turn_id, client_id, envelope_digest,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)
      `).run(
        input.batchId, input.ownerThreadId, input.reservedTurnId, input.clientId,
        input.envelopeDigest, input.now, input.now,
      );
      const insert = this.db.prepare(`
        INSERT INTO tool_task_delivery_members(batch_id, task_id, terminal_digest, ordinal)
        VALUES (?, ?, ?, ?)
      `);
      input.taskIds.forEach((taskId, ordinal) => {
        insert.run(input.batchId, taskId, tasks[ordinal]!.terminalDigest!, ordinal);
      });
      const placeholders = input.taskIds.map(() => '?').join(', ');
      const changed = this.db.prepare(`
        UPDATE tool_tasks SET delivery_state = 'delivering', updated_at = ?
        WHERE task_id IN (${placeholders}) AND delivery_state = 'pending'
      `).run(input.now, ...input.taskIds).changes;
      if (Number(changed) !== input.taskIds.length) throw new Error('Tool Task delivery claim raced');
    });
    return this.readBatch(input.batchId)!;
  }

  linkDelivery(batchId: string, turnId: TurnId, envelopeDigest: string, now: number): ToolTaskDeliveryBatch {
    let mismatchedTaskId: string | null = null;
    this.transaction(() => {
      const batch = this.requireBatch(batchId);
      if (batch.state === 'linked') {
        if (batch.reservedTurnId !== turnId || batch.envelopeDigest !== envelopeDigest) {
          throw new Error(`Tool Task delivery commit mismatch: ${batchId}`);
        }
        return;
      }
      if (batch.state !== 'prepared'
        || batch.reservedTurnId !== turnId
        || batch.envelopeDigest !== envelopeDigest) {
        throw new Error(`Tool Task delivery admission mismatch: ${batchId}`);
      }
      const members = this.batchMembers(batchId);
      for (const member of members) {
        const task = this.require(member.task_id);
        if (task.deliveryState !== 'delivering' || task.terminalDigest !== member.terminal_digest) {
          mismatchedTaskId = member.task_id;
          this.reconcileBatchMemberMismatchWithinTransaction(batchId, now);
          return;
        }
      }
      this.db.prepare(`
        UPDATE tool_task_delivery_batches SET state = 'linked', updated_at = ? WHERE batch_id = ?
      `).run(now, batchId);
      this.db.prepare(`
        UPDATE tool_tasks SET delivery_state = 'delivered', delivery_turn_id = ?,
          delivered_at = COALESCE(delivered_at, ?), updated_at = ?
        WHERE task_id IN (SELECT task_id FROM tool_task_delivery_members WHERE batch_id = ?)
      `).run(turnId, now, now, batchId);
      for (const member of members) {
        const task = this.require(member.task_id);
        this.writeContinuation(task, { ...task.continuation, event: {
          id: member.terminal_digest, disposition: 'admitted', reason: null,
          handling: { kind: 'completion', turnId, batchId },
        } }, now);
      }
    });
    if (mismatchedTaskId !== null) {
      throw new Error(`Tool Task delivery member mismatch: ${mismatchedTaskId}`);
    }
    return this.requireBatch(batchId);
  }

  rollBackDelivery(batchId: string, now: number): ToolTaskDeliveryBatch {
    this.transaction(() => {
      const batch = this.requireBatch(batchId);
      if (batch.state !== 'prepared') return;
      this.db.prepare(`
        UPDATE tool_tasks SET delivery_state = 'pending', updated_at = ?
        WHERE delivery_state = 'delivering'
          AND task_id IN (SELECT task_id FROM tool_task_delivery_members WHERE batch_id = ?)
      `).run(now, batchId);
      this.db.prepare(`
        UPDATE tool_task_delivery_batches SET state = 'rolled_back', updated_at = ? WHERE batch_id = ?
      `).run(now, batchId);
    });
    return this.requireBatch(batchId);
  }

  blockDelivery(batchId: string, now: number): ToolTaskDeliveryBatch {
    this.transaction(() => this.blockBatchWithinTransaction(batchId, now));
    return this.requireBatch(batchId);
  }

  preparedBatches(): readonly ToolTaskDeliveryBatch[] {
    return (this.db.prepare(`
      SELECT * FROM tool_task_delivery_batches WHERE state = 'prepared' ORDER BY created_at, batch_id
    `).all() as DeliveryBatchRow[]).map((row) => this.batchFromRow(row));
  }

  readBatch(batchId: string): ToolTaskDeliveryBatch | null {
    const row = this.db.prepare(`
      SELECT * FROM tool_task_delivery_batches WHERE batch_id = ?
    `).get(batchId) as DeliveryBatchRow | undefined;
    return row ? this.batchFromRow(row) : null;
  }

  pendingDelivery(ownerThreadId: ThreadId, limit: number): readonly ToolTaskRecord[] {
    return (this.db.prepare(`
      SELECT * FROM tool_tasks
      WHERE owner_thread_id = ? AND delivery_state = 'pending'
        AND background_enabled = 1
        AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'lost')
        AND task_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY completed_at, task_id LIMIT ?
    `).all(ownerThreadId, this.restoredTaskIds, limit) as ToolTaskRow[]).map(taskFromRow);
  }

  ownersWithPendingDelivery(): readonly ThreadId[] {
    return (this.db.prepare(`
      SELECT DISTINCT owner_thread_id FROM tool_tasks
      WHERE delivery_state = 'pending'
        AND background_enabled = 1
        AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'lost')
        AND task_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY owner_thread_id
    `).all(this.restoredTaskIds) as Array<{ owner_thread_id: string }>).map((row) => row.owner_thread_id);
  }

  expireDetail(taskId: string, state: Exclude<ToolTaskDetailState, 'available'>, now: number): ToolTaskRecord {
    this.db.prepare(`
      UPDATE tool_tasks
      SET detail_state = ?, artifacts_json = '[]', artifact_warnings_json = '[]', updated_at = ?
      WHERE task_id = ? AND state NOT IN ('running', 'settling') AND detail_state = 'available'
    `).run(state, now, taskId);
    return this.require(taskId);
  }

  promote(taskId: string, now: number): ToolTaskRecord {
    this.db.prepare(`
      UPDATE tool_tasks SET background_enabled = 1, updated_at = ? WHERE task_id = ?
    `).run(now, taskId);
    return this.require(taskId);
  }

  deleteTask(taskId: string): void {
    this.db.prepare('DELETE FROM tool_tasks WHERE task_id = ?').run(taskId);
  }

  deleteOwner(threadId: ThreadId): void {
    this.db.prepare('DELETE FROM tool_tasks WHERE owner_thread_id = ?').run(threadId);
  }

  allTerminalByAge(): readonly ToolTaskRecord[] {
    return (this.db.prepare(`
      SELECT * FROM tool_tasks
      WHERE state NOT IN ('running', 'settling') ORDER BY completed_at, task_id
    `).all() as ToolTaskRow[]).map(taskFromRow);
  }

  clearableDetails(ownerThreadId: ThreadId): readonly ToolTaskRecord[] {
    return (this.db.prepare(`
      SELECT * FROM tool_tasks
      WHERE owner_thread_id = ? AND state NOT IN ('running', 'settling')
        AND delivery_state IN ('delivered', 'silent', 'handled') AND detail_state = 'available'
      ORDER BY completed_at, task_id
    `).all(ownerThreadId) as ToolTaskRow[]).map(taskFromRow);
  }

  listAll(ownerThreadId: ThreadId): readonly ToolTaskRecord[] {
    return (this.db.prepare(`
      SELECT * FROM tool_tasks WHERE owner_thread_id = ? ORDER BY started_at, task_id
    `).all(ownerThreadId) as ToolTaskRow[]).map(taskFromRow);
  }

  private allRecords(): readonly ToolTaskRecord[] {
    return (this.db.prepare(`SELECT * FROM tool_tasks ORDER BY started_at, task_id`).all() as ToolTaskRow[])
      .map(taskFromRow);
  }

  recoveryState(threadIds: readonly ThreadId[]): unknown {
    return threadIds.map((id) => ({
      tasks: this.listAll(id),
      batches: this.db.prepare('SELECT * FROM tool_task_delivery_batches WHERE owner_thread_id = ? ORDER BY batch_id').all(id),
      leases: this.db.prepare('SELECT * FROM tool_task_leases WHERE owner_thread_id = ? ORDER BY task_id').all(id),
      successors: this.db.prepare(`SELECT successors.* FROM tool_task_context_successors successors JOIN tool_tasks tasks USING(task_id)
        WHERE tasks.owner_thread_id = ? ORDER BY task_id`).all(id),
    }));
  }

  removeRecoveryDelivery(threadId: ThreadId): void {
    this.blockOwnerDelivery(threadId, Date.now());
    this.db.prepare('DELETE FROM tool_task_delivery_batches WHERE owner_thread_id = ?').run(threadId);
  }

  private require(taskId: string): ToolTaskRecord {
    const task = this.read(taskId);
    if (!task) throw new Error(`Tool Task not found: ${taskId}`);
    return task;
  }

  private requireBatch(batchId: string): ToolTaskDeliveryBatch {
    const batch = this.readBatch(batchId);
    if (!batch) throw new Error(`Tool Task delivery batch not found: ${batchId}`);
    return batch;
  }

  private batchMembers(batchId: string): readonly DeliveryMemberRow[] {
    return this.db.prepare(`
      SELECT task_id, terminal_digest, ordinal FROM tool_task_delivery_members
      WHERE batch_id = ? ORDER BY ordinal
    `).all(batchId) as DeliveryMemberRow[];
  }

  private batchFromRow(row: DeliveryBatchRow): ToolTaskDeliveryBatch {
    return {
      batchId: row.batch_id,
      ownerThreadId: row.owner_thread_id,
      reservedTurnId: row.reserved_turn_id,
      clientId: row.client_id,
      envelopeDigest: row.envelope_digest,
      state: row.state as ToolTaskDeliveryBatch['state'],
      taskIds: this.batchMembers(row.batch_id).map((member) => member.task_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private blockBatchWithinTransaction(batchId: string, now: number): void {
    const batch = this.requireBatch(batchId);
    if (batch.state === 'linked') throw new Error(`Delivered Tool Task batch is immutable: ${batchId}`);
    this.db.prepare(`
      UPDATE tool_tasks SET delivery_state = 'blocked', updated_at = ?
      WHERE task_id IN (SELECT task_id FROM tool_task_delivery_members WHERE batch_id = ?)
    `).run(now, batchId);
    this.db.prepare(`
      UPDATE tool_task_delivery_batches SET state = 'blocked', updated_at = ? WHERE batch_id = ?
    `).run(now, batchId);
  }

  private reconcileBatchMemberMismatchWithinTransaction(batchId: string, now: number): void {
    const batch = this.requireBatch(batchId);
    if (batch.state === 'linked') throw new Error(`Delivered Tool Task batch is immutable: ${batchId}`);
    const members = this.batchMembers(batchId);
    for (const member of members) {
      const task = this.require(member.task_id);
      const state = task.deliveryState === 'delivering' && task.terminalDigest === member.terminal_digest
        ? 'pending'
        : 'blocked';
      this.db.prepare(`UPDATE tool_tasks SET delivery_state = ?, updated_at = ? WHERE task_id = ?`)
        .run(state, now, member.task_id);
    }
    this.db.prepare(`
      UPDATE tool_task_delivery_batches SET state = 'blocked', updated_at = ? WHERE batch_id = ?
    `).run(now, batchId);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }
}

function taskFromRow(row: ToolTaskRow): ToolTaskRecord {
  const state = row.state as ToolTaskExecutionState;
  const deliveryState = row.delivery_state as ToolTaskDeliveryState;
  const detailState = row.detail_state as ToolTaskDetailState;
  if (![
    'running', 'settling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'lost',
  ].includes(state)) throw new Error('Invalid persisted Tool Task state');
  if (!['pending', 'delivering', 'delivered', 'blocked', 'silent', 'handled'].includes(deliveryState)) {
    throw new Error('Invalid persisted Tool Task delivery state');
  }
  if (!['available', 'expired', 'cleared', 'storage_pressure'].includes(detailState)) {
    throw new Error('Invalid persisted Tool Task detail state');
  }
  const progress = row.progress_json === null ? null : JSON.parse(row.progress_json) as ToolTaskProgress;
  const artifacts = decodeArtifacts(row.artifacts_json);
  const artifactWarnings = decodeArtifactWarnings(row.artifact_warnings_json);
  return {
    taskId: row.task_id,
    continuation: decodeTaskContinuation(JSON.parse(row.continuation_json)),
    controlReceipts: decodeControlReceipts(row.control_receipts_json),
    ownerThreadId: row.owner_thread_id,
    sourceTurnId: row.source_turn_id,
    sourceItemId: row.source_item_id,
    producer: row.producer,
    description: row.description,
    commandDigest: row.command_digest,
    cwd: row.cwd,
    executionContext: validateExecutionContext(JSON.parse(row.execution_context_json)),
    isolation: decodeProcessIsolationEvidence(JSON.parse(row.isolation_json)),
    operationKind: row.operation_kind,
    parentTaskId: row.parent_task_id,
    nonce: row.nonce,
    detailPath: row.detail_path,
    backgroundEnabled: row.background_enabled === 1,
    supervisorPid: row.supervisor_pid,
    childPid: row.child_pid,
    state,
    deliveryState,
    progress,
    exitCode: row.exit_code,
    signal: row.signal,
    outcomeReason: row.outcome_reason,
    error: row.error_message,
    detailState,
    artifacts,
    artifactWarnings,
    timeoutMs: row.timeout_ms,
    stopRequestedAt: row.stop_requested_at,
    terminalDigest: row.terminal_digest,
    stdoutBytes: row.stdout_bytes,
    stderrBytes: row.stderr_bytes,
    outputBytes: row.output_bytes,
    detailBytes: row.detail_bytes,
    storagePressure: decodeStoragePressure(row.storage_pressure_json),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    quiescedAt: row.quiesced_at,
    deliveryTurnId: row.delivery_turn_id,
    deliveredAt: row.delivered_at,
    updatedAt: row.updated_at,
    artifactsSettled: row.artifacts_settled === 1,
    reservationBytes: row.reservation_bytes,
  };
}

export function projectToolTask(task: ToolTaskRecord): ToolTaskProjection {
  const {
    controlReceipts: _controlReceipts,
    backgroundEnabled: _backgroundEnabled,
    commandDigest: _commandDigest,
    cwd: _cwd,
    operationKind: _operationKind,
    parentTaskId: _parentTaskId,
    nonce: _nonce,
    detailPath: _detailPath,
    supervisorPid: _supervisorPid,
    childPid: _childPid,
    timeoutMs: _timeoutMs,
    stopRequestedAt: _stopRequestedAt,
    terminalDigest: _terminalDigest,
    stdoutBytes: _stdoutBytes,
    stderrBytes: _stderrBytes,
    quiescedAt: _quiescedAt,
    updatedAt: _updatedAt,
    artifactsSettled: _artifactsSettled,
    reservationBytes: _reservationBytes,
    deliveredAt: _deliveredAt,
    ...projection
  } = task;
  return projection;
}

function assertToolTaskProgress(progress: ToolTaskProgress): void {
  if (!(progress.phase === null || (typeof progress.phase === 'string' && progress.phase.length <= 120))
    || !(progress.message === null || (typeof progress.message === 'string' && progress.message.length <= 1_000))
    || !(progress.fraction === null || (Number.isFinite(progress.fraction)
      && progress.fraction >= 0 && progress.fraction <= 1))
    || !Number.isFinite(progress.updatedAt)) {
    throw new Error('Invalid Tool Task progress');
  }
}

function assertScheduling(policy: ToolTaskSchedulingPolicy, limits: ToolTaskSchedulerLimits): void {
  const positive = [
    policy.maxConcurrentProducer,
    policy.maxConcurrentPool,
    limits.maxConcurrentGlobal,
    limits.maxConcurrentThread,
    limits.maxQueuedGlobal,
    limits.maxQueuedThread,
  ].every((value) => Number.isSafeInteger(value) && value > 0);
  if (!positive || !policy.pool || !policy.configurationRevision) {
    throw new Error('Invalid Tool Task scheduling policy');
  }
}

function leaseFits(
  active: readonly ToolTaskLease[],
  task: ToolTaskRecord,
  policy: ToolTaskSchedulingPolicy,
  limits: ToolTaskSchedulerLimits,
): boolean {
  return active.length < limits.maxConcurrentGlobal
    && active.filter((lease) => lease.ownerThreadId === task.ownerThreadId).length < limits.maxConcurrentThread
    && active.filter((lease) => lease.producer === task.producer).length < policy.maxConcurrentProducer
    && active.filter((lease) => lease.pool === policy.pool).length < policy.maxConcurrentPool;
}

function leaseFromRow(row: ToolTaskLeaseRow): ToolTaskLease {
  if (!['queued', 'active', 'released'].includes(row.state)) {
    throw new Error('Invalid persisted Tool Task lease state');
  }
  return {
    taskId: row.task_id,
    ownerThreadId: row.owner_thread_id,
    nonce: row.nonce,
    producer: row.producer,
    pool: row.pool,
    configurationRevision: row.configuration_revision,
    maxConcurrentProducer: row.max_concurrent_producer,
    maxConcurrentPool: row.max_concurrent_pool,
    state: row.state as ToolTaskLease['state'],
    createdAt: row.created_at,
    acquiredAt: row.acquired_at,
    releasedAt: row.released_at,
  };
}

function assertFinalReceipt(task: ToolTaskRecord, receipt: ToolTaskFinalReceipt): void {
  decodeProcessIsolationEvidence(receipt.isolation);
  if (receipt.isolation.state === null) throw new Error('Terminal isolation evidence must be resolved');
  const { receiptDigest, ...unsigned } = receipt;
  const digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  if (receipt.taskId !== task.taskId || receipt.nonce !== task.nonce
    || receipt.version !== 3
    || !['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'].includes(receipt.state)
    || receipt.startedAt !== task.startedAt || !Number.isFinite(receipt.quiescedAt)
    || receipt.quiescedAt < task.startedAt || !/^[0-9a-f]{64}$/u.test(receiptDigest)
    || receiptDigest !== digest
    || !Number.isSafeInteger(receipt.stdoutBytes) || receipt.stdoutBytes < 0
    || !Number.isSafeInteger(receipt.stderrBytes) || receipt.stderrBytes < 0
    || !(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode))
    || !(receipt.signal === null || (typeof receipt.signal === 'string' && receipt.signal.length <= 256))
    || typeof receipt.reason !== 'string' || receipt.reason.length === 0 || receipt.reason.length > 256
    || !(receipt.error === null || (typeof receipt.error === 'string' && receipt.error.length <= 4_096))
    || !(receipt.supervisorPid === null
      || (Number.isSafeInteger(receipt.supervisorPid) && receipt.supervisorPid > 0))
    || !(receipt.childPid === null || (Number.isSafeInteger(receipt.childPid) && receipt.childPid > 0))
    || !(receipt.preparedResultDigest === null
      || (typeof receipt.preparedResultDigest === 'string'
        && /^[0-9a-f]{64}$/u.test(receipt.preparedResultDigest)))
    || !Number.isSafeInteger(receipt.preparedResultBytes) || receipt.preparedResultBytes < 0
    || ((receipt.preparedResultDigest === null) !== (receipt.preparedResultBytes === 0))
    || (receipt.state === 'succeeded' && task.operationKind === 'process'
      && (receipt.exitCode !== 0 || receipt.signal !== null || receipt.error !== null
        || receipt.supervisorPid === null || receipt.childPid === null))) {
    throw new Error(`Invalid Tool Task terminal receipt: ${task.taskId}`);
  }
}

function decodeArtifacts(value: string): ToolTaskRecord['artifacts'] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 16) throw new Error('Invalid persisted Tool Task artifacts');
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Invalid persisted Tool Task artifact');
    }
    const artifact = entry as Record<string, unknown>;
    const ref = artifact.ref as Record<string, unknown> | undefined;
    if (Object.keys(artifact).some((key) => !['ref', 'readablePath', 'label'].includes(key))
      || !ref || typeof ref !== 'object' || Array.isArray(ref)
      || Object.keys(ref).some((key) => !['id', 'mimeType', 'byteLength', 'fileName'].includes(key))
      || typeof ref.id !== 'string' || ref.id.length > 512
      || typeof ref.mimeType !== 'string' || ref.mimeType.length > 512
      || !Number.isSafeInteger(ref.byteLength) || Number(ref.byteLength) < 0
      || typeof ref.fileName !== 'string' || ref.fileName.length > 1_000
      || typeof artifact.label !== 'string' || artifact.label.length > 2_000
      || !(artifact.readablePath === null
        || (typeof artifact.readablePath === 'string' && artifact.readablePath.length <= 32_768))) {
      throw new Error('Invalid persisted Tool Task artifact');
    }
    return artifact as unknown as ToolTaskRecord['artifacts'][number];
  });
}

function decodeArtifactWarnings(value: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 32
    || parsed.some((entry) => typeof entry !== 'string' || entry.length > 2_000)) {
    throw new Error('Invalid persisted Tool Task artifact warnings');
  }
  return parsed;
}

function decodeStoragePressure(value: string | null): ToolTaskStoragePressure | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid persisted Tool Task storage pressure');
  }
  const pressure = parsed as Record<string, unknown>;
  if (Object.keys(pressure).some((key) => ![
    'scope', 'limitBytes', 'usedBytes', 'requiredBytes', 'reclaimableBytes', 'protectedBytes',
  ].includes(key))
    || !['thread', 'application'].includes(String(pressure.scope))
    || ['limitBytes', 'usedBytes', 'requiredBytes', 'reclaimableBytes', 'protectedBytes']
      .some((key) => !Number.isSafeInteger(pressure[key]) || Number(pressure[key]) < 0)) {
    throw new Error('Invalid persisted Tool Task storage pressure');
  }
  return pressure as unknown as ToolTaskStoragePressure;
}

function storagePressure(
  scope: ToolTaskStoragePressure['scope'],
  limitBytes: number,
  usage: ReturnType<typeof storageUsage>,
  requiredBytes: number,
): ToolTaskStoragePressure {
  return {
    scope,
    limitBytes,
    usedBytes: usage.usedBytes,
    requiredBytes,
    reclaimableBytes: usage.reclaimableBytes,
    protectedBytes: usage.protectedBytes,
  };
}

function storageUsage(
  tasks: readonly ToolTaskRecord[],
  accounting: 'logical' | 'physical',
): { readonly usedBytes: number; readonly reclaimableBytes: number; readonly protectedBytes: number } {
  const visible = tasks.filter((task) => task.detailState === 'available');
  if (accounting === 'logical') {
    const bytesFor = (task: ToolTaskRecord) => task.reservationBytes + task.detailBytes;
    const usedBytes = visible.reduce((sum, task) => sum + bytesFor(task), 0);
    const reclaimableBytes = visible
      .filter((task) => isToolTaskTerminal(task.state) && taskDeliverySettled(task.deliveryState))
      .reduce((sum, task) => sum + bytesFor(task), 0);
    return { usedBytes, reclaimableBytes, protectedBytes: usedBytes - reclaimableBytes };
  }

  const reservations = visible.reduce((sum, task) => sum + task.reservationBytes, 0);
  const outputBytes = visible.reduce((sum, task) => sum + task.outputBytes, 0);
  const artifactOwners = new Map<string, { byteLength: number; reclaimable: boolean }>();
  for (const task of visible) {
    for (const artifact of task.artifacts) {
      const current = artifactOwners.get(artifact.ref.id);
      const reclaimable = isToolTaskTerminal(task.state) && taskDeliverySettled(task.deliveryState);
      artifactOwners.set(artifact.ref.id, {
        byteLength: Math.max(current?.byteLength ?? 0, artifact.ref.byteLength),
        reclaimable: (current?.reclaimable ?? true) && reclaimable,
      });
    }
  }
  const artifacts = [...artifactOwners.values()];
  const artifactBytes = artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0);
  const reclaimableOutput = visible
    .filter((task) => isToolTaskTerminal(task.state) && taskDeliverySettled(task.deliveryState))
    .reduce((sum, task) => sum + task.outputBytes, 0);
  const reclaimableArtifacts = artifacts
    .filter((artifact) => artifact.reclaimable)
    .reduce((sum, artifact) => sum + artifact.byteLength, 0);
  const usedBytes = reservations + outputBytes + artifactBytes;
  const reclaimableBytes = reclaimableOutput + reclaimableArtifacts;
  return { usedBytes, reclaimableBytes, protectedBytes: usedBytes - reclaimableBytes };
}

function controlDigest(input: TaskControlInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function decodeControlReceipts(value: string): ToolTaskRecord['controlReceipts'] {
  const records = JSON.parse(value) as unknown;
  if (!Array.isArray(records) || records.length > 256) throw new Error('Invalid Task operation receipts');
  const ids = new Set<string>();
  return records.map((entry) => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => !['digest', 'receipt'].includes(key))
      || typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.digest)) throw new Error('Invalid Task operation digest');
    const receipt = decodeTaskControlReceipt(entry.receipt);
    if (ids.has(receipt.operationId)) throw new Error('Duplicate Task operation receipt');
    ids.add(receipt.operationId);
    return { digest: entry.digest, receipt };
  });
}
