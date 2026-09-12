import { automationStoreSchema } from './AutomationStore.schema';
import { AutomationRevisionConflict } from './AutomationRevisionConflict';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AUTOMATION_ERROR_MAX_LENGTH,
  AUTOMATION_DEFAULT_CONTEXT_HINT_ID,
  EMPTY_AUTOMATION_CONFIGURATION,
  isUuid,
  type Automation,
  type AutomationConfiguration,
  type AutomationCreateInput,
  type AutomationDestination,
  type AutomationListInput,
  type AutomationContextHint,
  type AutomationContextHintInput,
  type AutomationRun,
  type AutomationRunConfigurationSnapshot,
  type AutomationRunListInput,
  type AutomationRunOmission,
  type AutomationSchedule,
  type AutomationStatus,
  type AutomationUpdateInput,
  type AutomationWorktreeMetadata,
} from '../../../core/agent/automation';
import { closeSqliteAfterFailure, openSqlite, type SqliteDatabase } from '../persistence/sqlite';
import { AgentToolFailure } from '../AgentToolFailure';
import { uuidV7 } from '../uuid';
import { nextAutomationOccurrence } from './AutomationSchedule';

interface AutomationRow {
  id: string;
  name: string;
  prompt: string;
  materials_json: string;
  origin_json: string | null;
  schedule_json: string;
  destination_json: string;
  context_hints_json: string;
  configuration_json: string;
  status: AutomationStatus;
  revision: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  automation_revision: number;
  event_sequence: number;
  created_sequence: number;
  scheduled_for: number;
  context_hint_id: string;
  occurrence_key: string;
  dispatch_snapshot_ref_json: string | null;
  snapshot_json: string;
  state: AutomationRun['state'];
  thread_id: string | null;
  turn_id: string | null;
  worktree_json: string | null;
  omission_json: string | null;
  error: string | null;
  read_at: number | null;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface AutomationBindingCursor {
  readonly automationId: string;
  readonly contextHintKey: string;
  readonly evaluatedThrough: number;
  readonly overlapDeferred: boolean;
}

export interface DueClaimInput {
  readonly automation: Automation;
  readonly binding: AutomationContextHint | null;
  readonly expectedEvaluatedThrough: number;
  readonly evaluatedThrough: number;
  readonly occurrences: readonly number[];
  readonly truncated: boolean;
  readonly now: number;
}

export interface DueClaimResult {
  readonly claimed: AutomationRun | null;
  readonly omissions: AutomationRun | null;
  readonly cursorAdvanced: boolean;
}

export class AutomationStore {
  private readonly db: SqliteDatabase;
  private projectResolver: ((id: string) => import('../../../core/agent/project').Project) | null = null;

  bindProjectResolver(resolve: (id: string) => import('../../../core/agent/project').Project): void {
    if (this.projectResolver) throw new Error('Automation Project resolver is already bound');
    this.projectResolver = resolve;
  }

  recoveryState(threadIds: readonly string[]): { readonly state: unknown; readonly runs: readonly AutomationRun[] } {
    const runs = (this.db.prepare('SELECT * FROM automation_runs ORDER BY id').all() as AutomationRunRow[])
      .map((row) => this.readRun(row.id)!)
      .filter((run) => (run.threadId !== null && threadIds.includes(run.threadId))
        || (run.snapshot.destination.kind === 'existingThread' && threadIds.includes(run.snapshot.destination.threadId)));
    const ids = new Set(runs.map((run) => run.automationId));
    const definitions = this.list().filter((definition) => ids.has(definition.id)
      || (definition.destination.kind === 'existingThread' && threadIds.includes(definition.destination.threadId)));
    return { runs, state: {
      runs, definitions,
      receipts: this.db.prepare('SELECT * FROM automation_operation_receipts ORDER BY request_id').all(),
      acknowledgements: runs.flatMap((run) => this.db.prepare('SELECT * FROM automation_issue_acknowledgements WHERE run_id = ? ORDER BY issue_key').all(run.id)),
      missed: definitions.flatMap((definition) => this.db.prepare('SELECT * FROM automation_missed_occurrences WHERE automation_id = ? ORDER BY context_hint_id, scheduled_for').all(definition.id)),
    } };
  }

  retainRecovery(evidence: import('../recovery/RecoveryEvidence').RecoveryEvidence): Promise<void> {
    return evidence.sqlite('scheduled-tasks.sqlite', this.db);
  }

  removeRecoveryThreads(threadIds: readonly string[], now = Date.now()): void {
    this.transaction(() => {
      for (const definition of this.list()) {
        if (definition.destination.kind === 'existingThread' && threadIds.includes(definition.destination.threadId)
          && definition.status === 'active') this.setStatus(definition.id, 'paused', definition.revision, now);
      }
      for (const run of this.recoveryState(threadIds).runs) {
        if (run.state === 'pending') this.markFailed(run.id, 'The destination conversation was removed by confirmed recovery.', now);
        // Dispatched associations, acknowledgements and operation receipts remain
        // auditable. Their unavailable transcript is never a new pending request.
      }
    });
  }

  private captureSnapshot(automation: Automation, binding: AutomationContextHint | null): AutomationRunConfigurationSnapshot {
    const snapshot = runSnapshot(automation, binding);
    if (binding?.source.kind !== 'project') return snapshot;
    const projectSnapshot = this.projectResolver?.(binding.source.projectId);
    if (!projectSnapshot) throw new Error('Automation Project hint is unavailable');
    return Object.freeze({ ...snapshot, projectSnapshot });
  }

  constructor(path: string, database?: SqliteDatabase) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? openSqlite(path);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.db.exec(automationStoreSchema);
    } catch (error) {
      if (!database) closeSqliteAfterFailure(this.db, error);
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  operationReceipt<T>(requestId: string, input: unknown): T | null {
    const row = this.db.prepare('SELECT input_json, receipt_json FROM automation_operation_receipts WHERE request_id = ?')
      .get(requestId) as { input_json: string; receipt_json: string } | undefined;
    if (!row) return null;
    if (row.input_json !== canonicalJson(input)) throw new Error('Request identity was already used with different input');
    const receipt: unknown = JSON.parse(row.receipt_json);
    if (!receipt || typeof receipt !== 'object') throw new Error('Scheduled operation association is unreadable; mutation is blocked');
    return receipt as T;
  }

  *priorRuns(current: AutomationRun): Iterable<AutomationRun> {
    let before = current.id;
    while (true) {
      const page = this.listRuns({ automationId: current.automationId, before, limit: 50 });
      yield* page;
      if (page.length < 50) return;
      before = page.at(-1)!.id;
    }
  }

  isAcknowledged(automationRunId: string, issueKey: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM automation_issue_acknowledgements WHERE run_id = ? AND issue_key = ?')
      .get(automationRunId, issueKey));
  }

  acknowledge(automationRunId: string, issueKey: string, now = Date.now()): void {
    const inserted = this.db.prepare('INSERT OR IGNORE INTO automation_issue_acknowledgements (run_id, issue_key, acknowledged_at) VALUES (?, ?, ?)')
      .run(automationRunId, issueKey, now);
    if (inserted.changes) this.db.prepare('UPDATE automation_runs SET event_sequence = ?, updated_at = ? WHERE id = ?')
      .run(this.nextRunEventSequence(), now, automationRunId);
  }

  restore(id: string, expectedRevision: number, now = Date.now()): Automation {
    const current = this.read(id, now, true);
    if (!current) throw new Error('Scheduled task is unavailable');
    if (current.revision !== expectedRevision) throw revisionConflict(current);
    if (current.archivedAt === null) throw new Error('Scheduled task is not archived');
    this.db.prepare(`UPDATE automations SET deleted_at = NULL, status = 'paused', revision = revision + 1,
      updated_at = ? WHERE id = ? AND revision = ?`).run(now, id, expectedRevision);
    return this.read(id, now)!;
  }

  /** The receipt and domain write commit together; neither can survive alone. */
  withOperationReceipt<T>(requestId: string, input: unknown, operation: () => T): T {
    return this.transaction(() => {
      const existing = this.operationReceipt<T>(requestId, input);
      if (existing !== null) return existing;
      const receipt = operation();
      this.db.prepare('INSERT INTO automation_operation_receipts (request_id, input_json, receipt_json) VALUES (?, ?, ?)')
        .run(requestId, canonicalJson(input), json(receipt));
      return receipt;
    });
  }

  private admitHints(inputs: readonly AutomationContextHintInput[], current: readonly AutomationContextHint[], now: number): readonly AutomationContextHint[] {
    const currentIds = new Set(current.map((hint) => hint.contextHintId));
    return inputs.map((hint) => {
      if (hint.contextHintId && !currentIds.has(hint.contextHintId)) {
        throw new Error('New context hints must omit contextHintId; the Host allocates their identity.');
      }
      return { ...hint, contextHintId: hint.contextHintId ?? uuidV7(now) };
    });
  }

  setDispatchSnapshot(id: string, ref: import('../../../core/agent/protocol').ThreadContextPayloadReference, now: number): AutomationRun {
    const current = this.requireRun(id);
    if (current.dispatchSnapshotRef) {
      if (json(current.dispatchSnapshotRef) !== json(ref)) throw new Error('Automation dispatch snapshot is immutable');
      return current;
    }
    if (current.state !== 'pending') throw new Error('Only pending claims can prepare dispatch');
    this.db.prepare('UPDATE automation_runs SET dispatch_snapshot_ref_json = ?, event_sequence = ?, updated_at = ? WHERE id = ? AND dispatch_snapshot_ref_json IS NULL')
      .run(json(ref), this.nextRunEventSequence(), now, id);
    return this.requireRun(id);
  }

  create(input: AutomationCreateInput, now = Date.now(), origin: import('../../../core/agent/automation').AutomationOrigin | null = null): Automation {
    const id = uuidV7(now);
    const status = input.status ?? 'active';
    const configuration = fullConfiguration(input.configuration);
    const contextHints = this.admitHints(input.contextHints ?? [], [], now);
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO automations(
          id, name, prompt, materials_json, origin_json, schedule_json, destination_json, context_hints_json,
          configuration_json, status, revision, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
      `).run(
        id,
        input.name,
        input.prompt,
        json(input.materials ?? []),
        origin ? json(origin) : null,
        json(input.schedule),
        json(input.destination),
        json(contextHints),
        json(configuration),
        status,
        now,
        now,
      );
      this.syncContextHintCursors(id, contextHints, now - 1);
    });
    return this.read(id, now)!;
  }

  update(input: AutomationUpdateInput, now = Date.now()): Automation {
    const current = this.require(input.id, now);
    if (current.revision !== input.expectedRevision) throw revisionConflict(current);
    const scheduleChanged = input.schedule !== undefined
      && json(input.schedule) !== json(current.schedule);
    const bindingsChanged = input.contextHints !== undefined
      && json(input.contextHints) !== json(current.contextHints);
    if (current.status === 'completed' && input.status !== undefined && !scheduleChanged) {
      throw new AgentToolFailure(
        'automation_invalid_state',
        'A completed Automation can only be reactivated by changing its schedule',
        'Change the Automation schedule when reactivating it, or create a new Automation.',
      );
    }
    const status = current.status === 'completed' && scheduleChanged
      ? input.status ?? 'active'
      : input.status ?? current.status;
    const next: Automation = {
      ...current,
      name: input.name ?? current.name,
      prompt: input.prompt ?? current.prompt,
      materials: input.materials ?? current.materials,
      schedule: input.schedule ?? current.schedule,
      destination: input.destination ?? current.destination,
      contextHints: input.contextHints ? this.admitHints(input.contextHints, current.contextHints, now) : current.contextHints,
      configuration: input.configuration
        ? fullConfiguration({ ...current.configuration, ...input.configuration })
        : current.configuration,
      status,
      revision: current.revision + 1,
      updatedAt: now,
      nextOccurrenceAt: null,
    };
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE automations SET
          name = ?, prompt = ?, materials_json = ?, schedule_json = ?, destination_json = ?,
          context_hints_json = ?, configuration_json = ?, status = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND deleted_at IS NULL
      `).run(
        next.name,
        next.prompt,
        json(next.materials),
        json(next.schedule),
        json(next.destination),
        json(next.contextHints),
        json(next.configuration),
        next.status,
        next.revision,
        now,
        next.id,
        input.expectedRevision,
      );
      if (result.changes !== 1) throw revisionConflict(this.require(input.id, now));
      if (scheduleChanged || next.status === 'paused') {
        this.omitPending(next.id, next.status === 'paused' ? 'paused' : 'updated', now);
      }
      if (scheduleChanged || bindingsChanged) {
        this.db.prepare(`UPDATE automation_missed_occurrences SET resolution = 'replaced', resolved_at = ?
          WHERE automation_id = ? AND resolution IS NULL`).run(now, next.id);
      }
      const previousKeys = new Set(contextHintKeys(current.contextHints));
      this.syncContextHintCursors(next.id, next.contextHints, now, scheduleChanged, previousKeys);
    });
    return this.read(input.id, now)!;
  }

  setStatus(
    id: string,
    status: Extract<AutomationStatus, 'active' | 'paused'>,
    expectedRevision: number | undefined,
    now = Date.now(),
  ): Automation {
    const current = this.require(id, now);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw revisionConflict(current);
    if (current.status === 'completed' && status === 'active') return current;
    if (current.status === status) return current;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE automations SET status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(status, now, id);
      if (status === 'paused') this.omitPending(id, 'paused', now);
      if (status === 'active') {
        // Resume starts at the current instant, without replaying intentionally paused time.
        this.db.prepare(`UPDATE automation_binding_cursors
          SET evaluated_through = MAX(evaluated_through, ?), overlap_deferred = 0
          WHERE automation_id = ?`).run(now, id);
      }
    });
    return this.read(id, now)!;
  }

  completeIfExhausted(id: string, revision: number, now = Date.now()): Automation | null {
    const current = this.read(id, now);
    if (!current || current.revision !== revision || current.status !== 'active') return current;
    const exhausted = this.bindingCursors(current).every((cursor) => (
      nextAutomationOccurrence(current.schedule, cursor.evaluatedThrough) === null
    ));
    if (!exhausted) return current;
    this.db.prepare(`
      UPDATE automations SET status = 'completed', revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'active' AND deleted_at IS NULL
    `).run(now, id, revision);
    return this.read(id, now);
  }

  delete(id: string, expectedRevision: number | undefined, now = Date.now()): boolean {
    const current = this.require(id, now);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw revisionConflict(current);
    this.transaction(() => {
      this.omitPending(id, 'deleted', now);
      const result = this.db.prepare(`
        UPDATE automations
        SET deleted_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now, now, id);
      if (result.changes !== 1) {
        throw new AgentToolFailure(
          'automation_not_found',
          `Automation not found: ${id}`,
          'View the current Automations, then retry with an existing automation_id.',
        );
      }
    });
    return true;
  }

  read(id: string, now = Date.now(), includeDeleted = false): Automation | null {
    const row = this.db.prepare(`
      SELECT * FROM automations WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(id) as AutomationRow | undefined;
    return row ? automationFromRow(row, now) : null;
  }

  list(input: AutomationListInput = {}, now = Date.now()): readonly Automation[] {
    const rows = this.db.prepare(`
      SELECT * FROM automations
      ${input.includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
      ORDER BY updated_at DESC, id DESC
    `).all() as AutomationRow[];
    const statuses = input.statuses ? new Set(input.statuses) : null;
    return Object.freeze(rows
      .map((row) => automationFromRow(row, now))
      .filter((automation) => !statuses || statuses.has(automation.status)));
  }

  bindingCursors(automation: Automation): readonly AutomationBindingCursor[] {
    const keys = contextHintKeys(automation.contextHints);
    const rows = this.db.prepare(`
      SELECT automation_id, context_hint_id, evaluated_through, overlap_deferred
      FROM automation_binding_cursors WHERE automation_id = ?
    `).all(automation.id) as Array<{
      automation_id: string;
      context_hint_id: string;
      evaluated_through: number;
      overlap_deferred: number;
    }>;
    const byKey = new Map(rows.map((row) => [row.context_hint_id, row]));
    return Object.freeze(keys.map((contextHintKey) => {
      const row = byKey.get(contextHintKey);
      if (!row) throw new Error(`Missing Automation context hint cursor: ${automation.id}/${contextHintKey}`);
      return {
        automationId: row.automation_id,
        contextHintKey: row.context_hint_id,
        evaluatedThrough: row.evaluated_through,
        overlapDeferred: row.overlap_deferred === 1,
      };
    }));
  }

  claimDueBatch(input: DueClaimInput): DueClaimResult {
    if (input.occurrences.length === 0) {
      const advanced = this.advanceCursor(
        input.automation.id,
        contextHintKey(input.binding),
        input.expectedEvaluatedThrough,
        input.evaluatedThrough,
      );
      return { claimed: null, omissions: null, cursorAdvanced: advanced };
    }
    let claimed: AutomationRun | null = null;
    let omissions: AutomationRun | null = null;
    let cursorAdvanced = false;
    this.transaction(() => {
      const current = this.read(input.automation.id, input.now);
      if (!current || current.status !== 'active' || current.revision !== input.automation.revision) return;
      const key = contextHintKey(input.binding);
      const cursor = this.readCursor(current.id, key);
      if (!cursor || cursor.evaluatedThrough !== input.expectedEvaluatedThrough) return;
      const omittedOccurrences = input.truncated ? input.occurrences : input.occurrences.slice(0, -1);
      if (omittedOccurrences.length > 0) {
        omissions = this.recordOmission(
          current,
          input.binding,
          omittedOccurrences[0]!,
          omittedOccurrences.at(-1)!,
          omittedOccurrences.length,
          cursor.overlapDeferred ? 'overlap' : 'catchUp',
          input.now,
        );
      }
      if (!input.truncated) {
        claimed = this.insertClaim(current, input.binding, input.occurrences.at(-1)!, input.now);
      }
      cursorAdvanced = this.advanceCursor(
        current.id,
        key,
        input.expectedEvaluatedThrough,
        input.evaluatedThrough,
      );
      if (!cursorAdvanced) throw new Error('Automation cursor changed during claim');
    });
    return { claimed, omissions, cursorAdvanced };
  }

  claimNow(automation: Automation, binding: AutomationContextHint | null, now = Date.now(), requestId = uuidV7(now)): AutomationRun {
    return this.insertClaim(automation, binding, now, now, `manual:${requestId}`);
  }

  missedOccurrences(automationId: string): readonly { contextHintId: string; scheduledFor: number }[] {
    return (this.db.prepare(`SELECT context_hint_id, scheduled_for FROM automation_missed_occurrences
      WHERE automation_id = ? AND resolution IS NULL ORDER BY scheduled_for`)
      .all(automationId) as { context_hint_id: string; scheduled_for: number }[])
      .map((row) => ({ contextHintId: row.context_hint_id, scheduledFor: row.scheduled_for }));
  }

  /** Called only under the Host admission lock, before creating an execution claim. */
  recordMissedOccurrence(automation: Automation, binding: AutomationContextHint | null,
    scheduledFor: number, expectedEvaluatedThrough: number): void {
    this.transaction(() => {
      const current = this.require(automation.id, scheduledFor);
      if (current.revision !== automation.revision) throw revisionConflict(current);
      this.db.prepare(`INSERT OR IGNORE INTO automation_missed_occurrences
        (automation_id, context_hint_id, scheduled_for) VALUES (?, ?, ?)`)
        .run(automation.id, contextHintKey(binding), scheduledFor);
      if (!this.advanceCursor(automation.id, contextHintKey(binding), expectedEvaluatedThrough, scheduledFor)) {
        throw new Error('Scheduled task cursor changed before missed-time decision');
      }
    });
  }

  resolveMissedOccurrence(automation: Automation, contextHintId: string, scheduledFor: number,
    resolution: 'fulfilled' | 'skipped', now = Date.now()): AutomationRun | null {
    return this.transaction(() => {
      const current = this.require(automation.id, now);
      if (current.revision !== automation.revision) throw revisionConflict(current);
      const unresolved = this.missedOccurrences(automation.id).some((time) => time.contextHintId === contextHintId && time.scheduledFor === scheduledFor);
      if (!unresolved) throw new Error('This missed occurrence is already resolved or unavailable');
      if (resolution === 'skipped') {
        this.db.prepare(`UPDATE automation_missed_occurrences SET resolution = 'skipped', resolved_at = ?
          WHERE automation_id = ? AND context_hint_id = ? AND scheduled_for = ? AND resolution IS NULL`)
          .run(now, automation.id, contextHintId, scheduledFor);
        const prepared = this.runForOccurrence(automation.id, `scheduled:${scheduledFor}`, contextHintId);
        if (prepared?.state === 'pending') {
          const omission: AutomationRunOmission = { from: scheduledFor, through: scheduledFor, count: 1, reason: 'skipped' };
          this.db.prepare(`UPDATE automation_runs SET state = 'omitted', thread_id = NULL, error = NULL,
            omission_json = ?, event_sequence = ?, updated_at = ? WHERE id = ? AND state = 'pending'`)
            .run(json(omission), this.nextRunEventSequence(), now, prepared.id);
        }
        return null;
      }
      const binding = contextHintId === AUTOMATION_DEFAULT_CONTEXT_HINT_ID ? null
        : automation.contextHints.find((candidate) => candidate.contextHintId === contextHintId);
      if (binding === undefined) throw new Error('The missed occurrence work location is unavailable');
      return this.insertClaim(automation, binding, scheduledFor, now);
    });
  }

  pendingRuns(automationId?: string): readonly AutomationRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM automation_runs
      WHERE state = 'pending' ${automationId ? 'AND automation_id = ?' : ''}
      ORDER BY created_at ASC, id ASC
    `).all(...(automationId ? [automationId] : [])) as AutomationRunRow[];
    return Object.freeze(rows.map(runFromRow));
  }

  latestUnsettledRun(automationId: string, contextHintId: string): AutomationRun | null {
    const row = this.db.prepare(`
      SELECT * FROM automation_runs
      WHERE automation_id = ? AND context_hint_id = ? AND state IN ('pending', 'dispatched')
      ORDER BY created_sequence DESC, id DESC LIMIT 1
    `).get(automationId, contextHintId) as AutomationRunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  markOverlapDeferred(automationId: string, contextHintId: string): void {
    const result = this.db.prepare(`
      UPDATE automation_binding_cursors SET overlap_deferred = 1
      WHERE automation_id = ? AND context_hint_id = ?
    `).run(automationId, contextHintId);
    if (result.changes !== 1) {
      throw new Error(`Missing Automation context hint cursor: ${automationId}/${contextHintId}`);
    }
  }

  markDispatched(id: string, threadId: string, turnId: string, now = Date.now()): AutomationRun {
    return this.transaction(() => {
    const eventSequence = this.nextRunEventSequence();
    const result = this.db.prepare(`
      UPDATE automation_runs
      SET state = 'dispatched', thread_id = ?, turn_id = ?, error = NULL, event_sequence = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `).run(threadId, turnId, eventSequence, now, id);
    if (result.changes !== 1) {
      const current = this.requireRun(id);
      if (current.state === 'dispatched' && current.threadId === threadId && current.turnId === turnId) return current;
      throw new Error(`AutomationRun cannot be dispatched: ${id}`);
    }
    const dispatched = this.requireRun(id);
    if (dispatched.occurrenceKey === `scheduled:${dispatched.scheduledFor}`) {
      this.db.prepare(`UPDATE automation_missed_occurrences SET resolution = 'fulfilled', resolved_at = ?
        WHERE automation_id = ? AND context_hint_id = ? AND scheduled_for = ? AND resolution IS NULL`)
        .run(now, dispatched.automationId, dispatched.contextHintId, dispatched.scheduledFor);
    }
    return dispatched;
    });
  }

  markFailed(id: string, error: string, now = Date.now()): AutomationRun {
    const eventSequence = this.nextRunEventSequence();
    const result = this.db.prepare(`
      UPDATE automation_runs
      SET state = 'failed', thread_id = NULL, error = ?, event_sequence = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `).run(boundedError(error), eventSequence, now, id);
    if (result.changes !== 1) throw new Error(`AutomationRun cannot fail before dispatch: ${id}`);
    return this.requireRun(id);
  }

  recordPendingError(id: string, error: string, now = Date.now()): AutomationRun {
    const eventSequence = this.nextRunEventSequence();
    this.db.prepare(`
      UPDATE automation_runs SET error = ?, event_sequence = ?, updated_at = ? WHERE id = ? AND state = 'pending'
    `).run(boundedError(error), eventSequence, now, id);
    return this.requireRun(id);
  }

  refreshPendingBrief(id: string, now = Date.now()): AutomationRun {
    const run = this.requireRun(id);
    if (run.state !== 'pending') return run;
    const automation = this.require(run.automationId, now);
    const binding = automation.revision === run.automationRevision
      ? automation.contextHints.find((hint) => hint.contextHintId === run.contextHintId) ?? null
      : automation.contextHints[0] ?? null;
    const snapshot = this.captureSnapshot(automation, binding);
    if (automation.revision === run.automationRevision && json(snapshot.projectSnapshot) === json(run.snapshot.projectSnapshot)) return run;
    this.db.prepare(`UPDATE automation_runs SET automation_revision = ?, snapshot_json = ?, context_hint_id = ?,
      dispatch_snapshot_ref_json = NULL, event_sequence = ?, updated_at = ? WHERE id = ? AND state = 'pending'`)
      .run(automation.revision, json(snapshot), contextHintKey(binding), this.nextRunEventSequence(), now, id);
    return this.requireRun(id);
  }

  setThread(id: string, threadId: string, now = Date.now()): AutomationRun {
    const eventSequence = this.nextRunEventSequence();
    this.db.prepare(`
      UPDATE automation_runs SET thread_id = ?, event_sequence = ?, updated_at = ?
      WHERE id = ? AND state = 'pending' AND (thread_id IS NULL OR thread_id = ?)
    `).run(threadId, eventSequence, now, id, threadId);
    return this.requireRun(id);
  }

  setWorktree(id: string, worktree: AutomationWorktreeMetadata | null, now = Date.now()): AutomationRun {
    const eventSequence = this.nextRunEventSequence();
    this.db.prepare(`
      UPDATE automation_runs SET worktree_json = ?, event_sequence = ?, updated_at = ? WHERE id = ?
    `).run(worktree ? json(worktree) : null, eventSequence, now, id);
    return this.requireRun(id);
  }

  readRun(id: string): AutomationRun | null {
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as AutomationRunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  allRunsForAutomation(automationId: string): readonly AutomationRun[] {
    return (this.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_sequence DESC, id DESC')
      .all(automationId) as AutomationRunRow[]).map(runFromRow);
  }

  listRuns(input: AutomationRunListInput = {}): readonly AutomationRun[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.automationId) {
      clauses.push('automation_id = ?');
      params.push(input.automationId);
    }
    if (input.unreadOnly) clauses.push("read_at IS NULL AND state IN ('dispatched', 'failed')");
    if (input.before) {
      const before = this.readRun(input.before);
      if (!before || (input.automationId && before.automationId !== input.automationId)) throw new Error('Run page cursor is unavailable');
      clauses.push('created_sequence < ?');
      params.push(before.createdSequence);
    }
    const limit = input.limit ?? 100;
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM automation_runs
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_sequence DESC, id DESC LIMIT ?
    `).all(...params) as AutomationRunRow[];
    return Object.freeze(rows.map(runFromRow));
  }

  /**
   * The most recent runs of one Automation on ONE context hint, newest first.
   *
   * Filtering in SQL rather than over a scanned page is what makes this correct
   * at the binding cap: an Automation may carry 32 bindings and its runs
   * interleave across them, so any window wide enough to hold three rows for a
   * heavily-bound Automation is far wider than one occurrence needs, and any
   * window narrow enough to be cheap would silently return fewer than asked.
   */
  recentRunsForContextHint(
    automationId: string,
    contextHintId: string,
    limit: number,
  ): readonly AutomationRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM automation_runs
      WHERE automation_id = ? AND context_hint_id = ?
      ORDER BY created_sequence DESC, id DESC LIMIT ?
    `).all(automationId, contextHintId, limit) as AutomationRunRow[];
    return Object.freeze(rows.map(runFromRow));
  }

  dispatchedRunsForReconciliation(): readonly AutomationRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM automation_runs
      WHERE state = 'dispatched'
      ORDER BY created_sequence DESC, id DESC
    `).all() as AutomationRunRow[];
    return Object.freeze(rows.map(runFromRow));
  }

  retainedWorktreeRunsForCleanup(): readonly AutomationRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM automation_runs
      WHERE worktree_json IS NOT NULL
        AND json_extract(worktree_json, '$.removedAt') IS NULL
      ORDER BY created_sequence DESC, id DESC
    `).all() as AutomationRunRow[];
    return Object.freeze(rows.map(runFromRow));
  }

  markRunRead(id: string, now = Date.now()): AutomationRun {
    const eventSequence = this.nextRunEventSequence();
    this.db.prepare(`
      UPDATE automation_runs SET read_at = ?, event_sequence = ?, updated_at = ? WHERE id = ?
    `).run(now, eventSequence, now, id);
    return this.requireRun(id);
  }

  markAutomationRunsRead(
    automationId: string,
    now = Date.now(),
  ): { readonly eventSequence: number; readonly readAt: number; readonly updatedCount: number } {
    this.require(automationId, now);
    const eventSequence = this.nextRunEventSequence();
    const result = this.db.prepare(`
      UPDATE automation_runs SET read_at = ?, event_sequence = ?, updated_at = ?
      WHERE automation_id = ? AND read_at IS NULL AND state IN ('dispatched', 'failed')
    `).run(now, eventSequence, now, automationId);
    return Object.freeze({ eventSequence, readAt: now, updatedCount: Number(result.changes) });
  }

  pinRun(id: string, pinned: boolean, now = Date.now()): AutomationRun {
    const current = this.requireRun(id);
    if (!current.worktree || current.worktree.removedAt !== null) {
      throw new Error(`AutomationRun has no retained worktree to pin: ${id}`);
    }
    const eventSequence = this.nextRunEventSequence();
    this.db.prepare('UPDATE automation_runs SET pinned = ?, event_sequence = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, eventSequence, now, id);
    return this.requireRun(id);
  }

  private require(id: string, now: number): Automation {
    const automation = this.read(id, now);
    if (!automation) {
      throw new AgentToolFailure(
        'automation_not_found',
        `Automation not found: ${id}`,
        'View the current Automations, then retry with an existing automation_id.',
      );
    }
    return automation;
  }

  private requireRun(id: string): AutomationRun {
    const run = this.readRun(id);
    if (!run) throw new Error(`AutomationRun not found: ${id}`);
    return run;
  }

  private readCursor(
    automationId: string,
    contextHintKeyValue: string,
  ): { readonly evaluatedThrough: number; readonly overlapDeferred: boolean } | null {
    const row = this.db.prepare(`
      SELECT evaluated_through, overlap_deferred FROM automation_binding_cursors
      WHERE automation_id = ? AND context_hint_id = ?
    `).get(automationId, contextHintKeyValue) as {
      evaluated_through: number;
      overlap_deferred: number;
    } | undefined;
    return row
      ? { evaluatedThrough: row.evaluated_through, overlapDeferred: row.overlap_deferred === 1 }
      : null;
  }

  private advanceCursor(
    automationId: string,
    contextHintKeyValue: string,
    expected: number,
    next: number,
  ): boolean {
    if (next < expected) throw new Error('Automation context hint cursor cannot move backwards');
    return this.db.prepare(`
      UPDATE automation_binding_cursors SET evaluated_through = ?, overlap_deferred = 0
      WHERE automation_id = ? AND context_hint_id = ? AND evaluated_through = ?
    `).run(next, automationId, contextHintKeyValue, expected).changes === 1;
  }

  private syncContextHintCursors(
    automationId: string,
    bindings: readonly AutomationContextHint[],
    evaluatedThrough: number,
    reset = true,
    previousKeys: ReadonlySet<string> = new Set(),
  ): void {
    const keys = contextHintKeys(bindings);
    for (const key of keys) {
      if (!reset && previousKeys.has(key)) continue;
      this.db.prepare(`
        INSERT INTO automation_binding_cursors(automation_id, context_hint_id, evaluated_through, overlap_deferred)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(automation_id, context_hint_id) DO UPDATE SET
          evaluated_through = excluded.evaluated_through,
          overlap_deferred = 0
      `).run(automationId, key, evaluatedThrough);
    }
  }

  private omitPending(
    automationId: string,
    reason: Extract<AutomationRunOmission['reason'], 'paused' | 'deleted' | 'updated'>,
    now: number,
  ): void {
    const rows = this.db.prepare(`
      SELECT * FROM automation_runs WHERE automation_id = ? AND state = 'pending'
      ${reason === 'paused' || reason === 'updated' ? "AND occurrence_key NOT LIKE 'manual:%'" : ''}
    `).all(automationId) as AutomationRunRow[];
    for (const row of rows) {
      const eventSequence = this.nextRunEventSequence();
      const omission: AutomationRunOmission = {
        from: row.scheduled_for,
        through: row.scheduled_for,
        count: 1,
        reason,
      };
      this.db.prepare(`
        UPDATE automation_runs
        SET state = 'omitted', thread_id = NULL, error = NULL, omission_json = ?, event_sequence = ?, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(json(omission), eventSequence, now, row.id);
    }
  }

  private recordOmission(
    automation: Automation,
    binding: AutomationContextHint | null,
    from: number,
    through: number,
    count: number,
    reason: AutomationRunOmission['reason'],
    now: number,
  ): AutomationRun {
    const key = contextHintKey(binding);
    const previous = this.db.prepare(`
      SELECT * FROM automation_runs
      WHERE automation_id = ? AND context_hint_id = ?
      ORDER BY scheduled_for DESC LIMIT 1
    `).get(automation.id, key) as AutomationRunRow | undefined;
    if (previous?.state === 'omitted' && previous.automation_revision === automation.revision) {
      const omission = parseJson<AutomationRunOmission>(previous.omission_json!, 'AutomationRun omission');
      if (omission.reason === reason && omission.through < from) {
        const merged = { ...omission, through, count: omission.count + count };
        const eventSequence = this.nextRunEventSequence();
        this.db.prepare(`
          UPDATE automation_runs
          SET scheduled_for = ?, omission_json = ?, event_sequence = ?, updated_at = ? WHERE id = ?
        `).run(through, json(merged), eventSequence, now, previous.id);
        return this.requireRun(previous.id);
      }
    }
    const id = uuidV7(now);
    const eventSequence = this.nextRunEventSequence();
    const snapshot = this.captureSnapshot(automation, binding);
    const omission: AutomationRunOmission = { from, through, count, reason };
    this.db.prepare(`
      INSERT INTO automation_runs(
        id, automation_id, automation_revision, event_sequence, created_sequence, scheduled_for, context_hint_id, occurrence_key,
        snapshot_json, state, thread_id, turn_id, worktree_json, omission_json,
        error, read_at, pinned, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'omitted', NULL, NULL, NULL, ?, NULL, NULL, 0, ?, ?)
    `).run(id, automation.id, automation.revision, eventSequence, eventSequence, through, key, `omitted:${id}`, json(snapshot), json(omission), now, now);
    return this.requireRun(id);
  }

  private insertClaim(
    automation: Automation,
    binding: AutomationContextHint | null,
    scheduledFor: number,
    now: number,
    occurrenceKey = `scheduled:${scheduledFor}`,
  ): AutomationRun {
    const existing = this.runForOccurrence(automation.id, occurrenceKey, contextHintKey(binding));
    if (existing) return existing;
    const id = uuidV7(now);
    const eventSequence = this.nextRunEventSequence();
    const threadId = automation.destination.kind === 'standalone' ? uuidV7(now) : automation.destination.threadId;
    this.db.prepare(`
      INSERT INTO automation_runs(
        id, automation_id, automation_revision, event_sequence, created_sequence, scheduled_for, context_hint_id, occurrence_key,
        snapshot_json, state, thread_id, turn_id, worktree_json, omission_json,
        error, read_at, pinned, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)
    `).run(
      id,
      automation.id,
      automation.revision,
      eventSequence,
      eventSequence,
      scheduledFor,
      contextHintKey(binding),
      occurrenceKey,
      json(this.captureSnapshot(automation, binding)),
      threadId,
      now,
      now,
    );
    return this.requireRun(id);
  }

  runForOccurrence(automationId: string, occurrenceKey: string, contextHintId: string): AutomationRun | null {
    const row = this.db.prepare(`
      SELECT * FROM automation_runs
      WHERE automation_id = ? AND occurrence_key = ? AND context_hint_id = ?
    `).get(automationId, occurrenceKey, contextHintId) as AutomationRunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  private nextRunEventSequence(): number {
    this.db.prepare(`
      UPDATE automation_run_event_clock SET sequence = sequence + 1 WHERE id = 1
    `).run();
    const row = this.db.prepare(`
      SELECT sequence FROM automation_run_event_clock WHERE id = 1
    `).get() as { sequence: number } | undefined;
    if (!row) throw new Error('Automation Run event clock is unavailable');
    return row.sequence;
  }

  private transactionDepth = 0;

  private transaction<T>(operation: () => T): T {
    const name = `automation_${this.transactionDepth++}`;
    const outer = this.transactionDepth === 1;
    let began = false;
    try {
      this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      began = true;
      const result = operation();
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      if (began && outer) this.db.exec('ROLLBACK');
      else if (began) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
      }
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function automationFromRow(row: AutomationRow, now: number): Automation {
  const schedule = parseJson<AutomationSchedule>(row.schedule_json, 'Automation schedule');
  return Object.freeze({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    origin: optionalOrigin(row.origin_json),
    materials: parseJson<import("../../../core/agent/scheduledMaterial").ScheduledMaterial[]>(row.materials_json, "Scheduled materials"),
    schedule,
    destination: parseJson<AutomationDestination>(row.destination_json, 'Automation destination'),
    contextHints: Object.freeze(parseJson<AutomationContextHint[]>(
      row.context_hints_json,
      'Automation context hints',
    )),
    configuration: Object.freeze(parseJson<AutomationConfiguration>(
      row.configuration_json,
      'Automation configuration',
    )),
    status: row.status,
    revision: row.revision,
    nextOccurrenceAt: row.deleted_at === null && row.status === 'active'
      ? nextAutomationOccurrence(schedule, now - 1)
      : null,
    archivedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function runFromRow(row: AutomationRunRow): AutomationRun {
  return Object.freeze({
    id: row.id,
    automationId: row.automation_id,
    automationRevision: row.automation_revision,
    eventSequence: row.event_sequence,
    createdSequence: row.created_sequence,
    scheduledFor: row.scheduled_for,
    contextHintId: row.context_hint_id,
    occurrenceKey: row.occurrence_key,
    dispatchSnapshotRef: row.dispatch_snapshot_ref_json === null ? null : JSON.parse(row.dispatch_snapshot_ref_json),
    snapshot: Object.freeze(parseJson<AutomationRunConfigurationSnapshot>(row.snapshot_json, 'AutomationRun snapshot')),
    state: row.state,
    threadId: row.thread_id,
    turnId: row.turn_id,
    worktree: row.worktree_json
      ? Object.freeze(parseJson<AutomationWorktreeMetadata>(row.worktree_json, 'AutomationRun worktree'))
      : null,
    omission: row.omission_json
      ? Object.freeze(parseJson<AutomationRunOmission>(row.omission_json, 'AutomationRun omission'))
      : null,
    error: row.error,
    readAt: row.read_at,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function runSnapshot(
  automation: Automation,
  contextHint: AutomationContextHint | null,
): AutomationRunConfigurationSnapshot {
  return Object.freeze({
    automationName: automation.name,
    prompt: automation.prompt,
    materials: automation.materials,
    schedule: automation.schedule,
    destination: automation.destination,
    contextHint,
    configuration: automation.configuration,
  });
}

function fullConfiguration(value: Partial<AutomationConfiguration> | undefined): AutomationConfiguration {
  return Object.freeze({ ...EMPTY_AUTOMATION_CONFIGURATION, ...value });
}

function contextHintKeys(bindings: readonly AutomationContextHint[]): readonly string[] {
  return bindings.length === 0 ? [AUTOMATION_DEFAULT_CONTEXT_HINT_ID] : bindings.map((binding) => binding.contextHintId);
}

function contextHintKey(binding: AutomationContextHint | null): string {
  return binding?.contextHintId ?? AUTOMATION_DEFAULT_CONTEXT_HINT_ID;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string, path: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${path} is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nonEmpty(value: string, path: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${path} must be non-empty`);
  return normalized;
}

function boundedError(value: string): string {
  return nonEmpty(value, 'AutomationRun error').slice(0, AUTOMATION_ERROR_MAX_LENGTH);
}

function revisionConflict(current: Automation): Error {
  return new AutomationRevisionConflict(current.revision);
}

function optionalOrigin(encoded: string | null): import('../../../core/agent/automation').AutomationOrigin | null {
  // Origin is inspection-only; its loss must not hide an otherwise readable assignment.
  if (!encoded) return null;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.threadId !== 'string' || !isUuid(row.threadId) || typeof row.turnId !== 'string' || !isUuid(row.turnId)
      || typeof row.itemId !== 'string' || !row.itemId.trim() || row.itemId.length > 256) return null;
    return { threadId: row.threadId, turnId: row.turnId, itemId: row.itemId };
  } catch { return null; }
}
