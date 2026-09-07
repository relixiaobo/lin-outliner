import { createHash } from 'node:crypto';
import type { ThreadId, TurnId } from '../../../core/agent/protocol';
import type { SqliteDatabase } from '../persistence/sqlite';
import {
  DelegationStateError,
  type DelegationExecutionSettlement,
  type DelegationPolicySnapshot,
  type DelegationResumeRecord,
  type DelegationRootMessage,
  type DelegationSessionBinding,
  type DelegationSettlementState,
  type DelegationStopFence,
  type DelegationWorktreeDisposition,
} from './delegationSessionTypes';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST = createHash('sha256')
  .update('tenon:delegation-message-sequence:v1:empty')
  .digest('hex');

interface SessionRow {
  session_id: string;
  owner_thread_id: string;
  state: string;
  revision: number;
  policy_json: string;
  adapter_session_id: string | null;
  current_task_id: string | null;
  previous_task_id: string | null;
  message_sequence: number;
  stop_fence_json: string | null;
  last_resume_json: string | null;
  worktree_json: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface MessageRow {
  message_id: string;
  session_id: string;
  sequence: number;
  digest: string;
  prefix_digest: string;
  body: string | null;
  state: string;
  source_task_id: string;
  source_root_turn_id: string;
  source_root_item_id: string;
  source_root_intent_revision: number | null;
  delivery_turn_id: string | null;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface SettlementRow {
  settlement_id: string;
  session_id: string;
  turn_id: string;
  task_id: string;
  request_digest: string;
  message_sequence: number;
  message_sequence_digest: string;
  prepared_result_digest: string | null;
  final_receipt_digest: string | null;
  state: string;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateDelegationSessionInput {
  readonly sessionId: ThreadId;
  readonly ownerThreadId: ThreadId;
  readonly policy: DelegationPolicySnapshot;
  readonly worktree?: DelegationWorktreeDisposition;
  readonly now: number;
}

export interface AppendDelegationMessageInput {
  readonly sessionId: ThreadId;
  readonly expectedRevision: number;
  readonly messageId: string;
  readonly text: string;
  readonly sourceTaskId: string;
  readonly sourceRootTurnId: TurnId;
  readonly sourceRootItemId: string;
  readonly sourceRootIntentRevision: number | null;
  readonly now: number;
}

export interface ReserveDelegationExecutionInput {
  readonly settlementId: string;
  readonly sessionId: ThreadId;
  readonly expectedRevision: number;
  readonly turnId: TurnId;
  readonly taskId: string;
  readonly requestDigest: string;
  readonly messageSequence: number;
  readonly messageSequenceDigest: string;
  readonly now: number;
}

export class DelegationSessionStore {
  constructor(private readonly db: SqliteDatabase) {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegation_sessions (
        session_id TEXT PRIMARY KEY,
        owner_thread_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        policy_json TEXT NOT NULL,
        adapter_session_id TEXT,
        current_task_id TEXT,
        previous_task_id TEXT,
        message_sequence INTEGER NOT NULL DEFAULT 0 CHECK (message_sequence >= 0),
        stop_fence_json TEXT,
        last_resume_json TEXT,
        worktree_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        CHECK ((state = 'closed') = (closed_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delegation_sessions_owner_idx
        ON delegation_sessions(owner_thread_id, state, updated_at, session_id);

      CREATE TABLE IF NOT EXISTS delegation_root_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES delegation_sessions(session_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        digest TEXT NOT NULL,
        prefix_digest TEXT NOT NULL,
        body TEXT,
        state TEXT NOT NULL CHECK (state IN ('queued', 'committed', 'blocked')),
        source_task_id TEXT NOT NULL,
        source_root_turn_id TEXT NOT NULL,
        source_root_item_id TEXT NOT NULL,
        source_root_intent_revision INTEGER CHECK (
          source_root_intent_revision IS NULL OR source_root_intent_revision > 0
        ),
        delivery_turn_id TEXT,
        blocked_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence),
        UNIQUE(session_id, source_root_item_id),
        CHECK ((state = 'queued') = (body IS NOT NULL)),
        CHECK ((state = 'committed') = (delivery_turn_id IS NOT NULL)),
        CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delegation_messages_pending_idx
        ON delegation_root_messages(session_id, state, sequence);

      CREATE TABLE IF NOT EXISTS delegation_execution_settlements (
        settlement_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES delegation_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        message_sequence INTEGER NOT NULL CHECK (message_sequence >= 0),
        message_sequence_digest TEXT NOT NULL,
        prepared_result_digest TEXT,
        final_receipt_digest TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'awaiting_result', 'prepared', 'context_committed', 'committed', 'blocked'
        )),
        blocked_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (state = 'awaiting_result' AND prepared_result_digest IS NULL)
          OR state = 'blocked'
          OR (state IN ('prepared', 'context_committed', 'committed') AND prepared_result_digest IS NOT NULL)
        ),
        CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delegation_settlements_recovery_idx
        ON delegation_execution_settlements(state, updated_at, settlement_id);
      CREATE INDEX IF NOT EXISTS delegation_settlements_session_idx
        ON delegation_execution_settlements(session_id, created_at, settlement_id);
    `);
  }

  createSession(input: CreateDelegationSessionInput): DelegationSessionBinding {
    validatePolicy(input.policy);
    validateWorktree(input.worktree ?? { kind: 'none' });
    const existing = this.readSession(input.sessionId);
    if (existing) {
      if (existing.ownerThreadId !== input.ownerThreadId
        || JSON.stringify(existing.policy) !== JSON.stringify(input.policy)
        || JSON.stringify(existing.worktree) !== JSON.stringify(input.worktree ?? { kind: 'none' })) {
        throw new DelegationStateError('conflict', `Delegation Session identity conflict: ${input.sessionId}`);
      }
      return existing;
    }
    this.db.prepare(`
      INSERT INTO delegation_sessions(
        session_id, owner_thread_id, state, revision, policy_json, worktree_json,
        created_at, updated_at
      ) VALUES (?, ?, 'open', 1, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.ownerThreadId,
      JSON.stringify(input.policy),
      JSON.stringify(input.worktree ?? { kind: 'none' }),
      input.now,
      input.now,
    );
    return this.requireSession(input.sessionId);
  }

  readSession(sessionId: ThreadId): DelegationSessionBinding | null {
    const row = this.db.prepare('SELECT * FROM delegation_sessions WHERE session_id = ?')
      .get(sessionId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  sessionsForOwner(ownerThreadId: ThreadId): readonly DelegationSessionBinding[] {
    return (this.db.prepare(`
      SELECT * FROM delegation_sessions WHERE owner_thread_id = ? ORDER BY created_at, session_id
    `).all(ownerThreadId) as SessionRow[]).map(sessionFromRow);
  }

  openSessions(): readonly DelegationSessionBinding[] {
    return (this.db.prepare(`
      SELECT * FROM delegation_sessions WHERE state = 'open' ORDER BY created_at, session_id
    `).all() as SessionRow[]).map(sessionFromRow);
  }

  idleSessionsUpdatedBefore(cutoff: number): readonly DelegationSessionBinding[] {
    if (!Number.isSafeInteger(cutoff)) throw new DelegationStateError('invalid', 'Delegation idle cutoff is invalid');
    return (this.db.prepare(`
      SELECT * FROM delegation_sessions AS session
      WHERE session.state = 'open'
        AND session.current_task_id IS NULL
        AND session.updated_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM delegation_root_messages AS message
          WHERE message.session_id = session.session_id AND message.state = 'queued'
        )
      ORDER BY session.updated_at, session.session_id
    `).all(cutoff) as SessionRow[]).map(sessionFromRow);
  }

  appendMessage(input: AppendDelegationMessageInput): DelegationRootMessage {
    if (!input.messageId || !input.sourceTaskId || !input.sourceRootItemId || !input.text) {
      throw new DelegationStateError('invalid', 'Delegation message identity and text must be non-empty');
    }
    if (input.sourceRootIntentRevision !== null && !isPositiveInteger(input.sourceRootIntentRevision)) {
      throw new DelegationStateError('invalid', 'Delegation message root intent revision must be positive');
    }
    const digest = digestText(input.text);
    return this.transaction(() => {
      const replay = this.readMessage(input.messageId);
      if (replay) {
        if (!sameMessageAdmission(replay, input, digest)) {
          throw new DelegationStateError('conflict', `Delegation message identity conflict: ${input.messageId}`);
        }
        return replay;
      }
      const session = this.requireOpenSession(input.sessionId);
      this.assertRevision(session, input.expectedRevision);
      this.assertResumeFence(session, input.sourceRootTurnId, input.sourceRootIntentRevision);
      const blocked = this.blockedSettlementForSession(input.sessionId);
      if (blocked) {
        throw new DelegationStateError(
          'blocked',
          `Delegation Session has a blocked settlement: ${blocked.settlementId}`,
        );
      }
      const sequence = session.messageSequence + 1;
      const prefixDigest = digestMessagePrefix(
        this.messageSequenceDigest(input.sessionId, sequence - 1),
        sequence,
        digest,
        input.sourceRootTurnId,
        input.sourceRootItemId,
      );
      this.db.prepare(`
        INSERT INTO delegation_root_messages(
          message_id, session_id, sequence, digest, prefix_digest, body, state,
          source_task_id, source_root_turn_id, source_root_item_id,
          source_root_intent_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        input.messageId,
        input.sessionId,
        sequence,
        digest,
        prefixDigest,
        input.text,
        input.sourceTaskId,
        input.sourceRootTurnId,
        input.sourceRootItemId,
        input.sourceRootIntentRevision,
        input.now,
        input.now,
      );
      this.advanceSession(input.sessionId, input.now, 'message_sequence = ?', sequence);
      return this.requireMessage(input.messageId);
    });
  }

  readMessage(messageId: string): DelegationRootMessage | null {
    const row = this.db.prepare('SELECT * FROM delegation_root_messages WHERE message_id = ?')
      .get(messageId) as MessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  messagesForSession(sessionId: ThreadId): readonly DelegationRootMessage[] {
    return (this.db.prepare(`
      SELECT * FROM delegation_root_messages WHERE session_id = ? ORDER BY sequence
    `).all(sessionId) as MessageRow[]).map(messageFromRow);
  }

  queuedMessages(sessionId: ThreadId): readonly DelegationRootMessage[] {
    return (this.db.prepare(`
      SELECT * FROM delegation_root_messages
      WHERE session_id = ? AND state = 'queued' ORDER BY sequence
    `).all(sessionId) as MessageRow[]).map(messageFromRow);
  }

  messageSequenceDigest(sessionId: ThreadId, throughSequence?: number): string {
    const session = this.requireSession(sessionId);
    const sequence = throughSequence ?? session.messageSequence;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > session.messageSequence) {
      throw new DelegationStateError('invalid', 'Delegation message sequence is outside the Session prefix');
    }
    if (sequence === 0) return EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST;
    const row = this.db.prepare(`
      SELECT prefix_digest FROM delegation_root_messages WHERE session_id = ? AND sequence = ?
    `).get(sessionId, sequence) as { prefix_digest: string } | undefined;
    if (!row || !isDigest(row.prefix_digest)) {
      throw new DelegationStateError('blocked', `Delegation message prefix is incomplete at sequence ${sequence}`);
    }
    return row.prefix_digest;
  }

  commitMessagePrefix(
    sessionId: ThreadId,
    expectedRevision: number,
    throughSequence: number,
    turnId: TurnId,
    now: number,
  ): readonly DelegationRootMessage[] {
    return this.transaction(() => {
      const session = this.requireOpenSession(sessionId);
      const prefix = this.messagesForSession(sessionId).filter((message) => message.sequence <= throughSequence);
      if (throughSequence < 1 || prefix.length !== throughSequence) {
        throw new DelegationStateError('invalid', 'Delegation message commit must name a complete non-empty prefix');
      }
      const queued = prefix.filter((message) => message.state === 'queued');
      const previouslyCommitted = prefix.filter((message) => message.deliveryTurnId === turnId);
      if (queued.length === 0) return previouslyCommitted;
      this.assertRevision(session, expectedRevision);
      this.db.prepare(`
        UPDATE delegation_root_messages
        SET body = NULL, state = 'committed', delivery_turn_id = ?, updated_at = ?
        WHERE session_id = ? AND sequence <= ? AND state = 'queued'
      `).run(turnId, now, sessionId, throughSequence);
      this.advanceSession(sessionId, now);
      return this.messagesForSession(sessionId)
        .filter((message) => message.sequence <= throughSequence && message.deliveryTurnId === turnId);
    });
  }

  blockQueuedMessages(sessionId: ThreadId, expectedRevision: number, reason: string, now: number): readonly DelegationRootMessage[] {
    if (!reason) throw new DelegationStateError('invalid', 'Delegation message block requires a reason');
    return this.transaction(() => {
      const session = this.requireOpenSession(sessionId);
      const queued = this.queuedMessages(sessionId);
      if (queued.length === 0) return [];
      this.assertRevision(session, expectedRevision);
      this.blockQueuedMessagesWithinTransaction(sessionId, reason, now);
      this.advanceSession(sessionId, now);
      return this.messagesForSession(sessionId).filter((message) => queued.some((entry) => entry.messageId === message.messageId));
    });
  }

  reserveExecution(input: ReserveDelegationExecutionInput): DelegationExecutionSettlement {
    assertDigest(input.requestDigest, 'request');
    assertDigest(input.messageSequenceDigest, 'message sequence');
    return this.transaction(() => {
      const replay = this.readSettlement(input.settlementId);
      if (replay) {
        if (sameSettlementAdmission(replay, input)) return replay;
        return this.blockSettlementWithinTransaction(
          replay,
          `Delegation settlement identity conflict: ${input.settlementId}`,
          input.now,
        );
      }
      const session = this.requireOpenSession(input.sessionId);
      this.assertRevision(session, input.expectedRevision);
      if (session.stopFence) {
        throw new DelegationStateError('blocked', 'Delegation Session is fenced by a user stop');
      }
      const identityConflict = this.db.prepare(`
        SELECT * FROM delegation_execution_settlements WHERE turn_id = ? OR task_id = ? LIMIT 1
      `).get(input.turnId, input.taskId) as SettlementRow | undefined;
      if (identityConflict) {
        return this.blockSettlementWithinTransaction(
          settlementFromRow(identityConflict),
          'Delegation Turn or Tool Task identity is bound to another settlement',
          input.now,
        );
      }
      if (session.currentTaskId) {
        throw new DelegationStateError('conflict', `Delegation Session already has an active execution: ${session.currentTaskId}`);
      }
      const blocked = this.blockedSettlementForSession(input.sessionId);
      if (blocked) {
        throw new DelegationStateError('blocked', `Delegation Session has a blocked settlement: ${blocked.settlementId}`);
      }
      if (this.messageSequenceDigest(input.sessionId, input.messageSequence) !== input.messageSequenceDigest) {
        throw new DelegationStateError('conflict', 'Delegation execution message prefix digest does not match');
      }
      this.db.prepare(`
        INSERT INTO delegation_execution_settlements(
          settlement_id, session_id, turn_id, task_id, request_digest,
          message_sequence, message_sequence_digest, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_result', ?, ?)
      `).run(
        input.settlementId,
        input.sessionId,
        input.turnId,
        input.taskId,
        input.requestDigest,
        input.messageSequence,
        input.messageSequenceDigest,
        input.now,
        input.now,
      );
      this.advanceSession(input.sessionId, input.now, 'current_task_id = ?', input.taskId);
      return this.requireSettlement(input.settlementId);
    });
  }

  readSettlement(settlementId: string): DelegationExecutionSettlement | null {
    const row = this.db.prepare(`
      SELECT * FROM delegation_execution_settlements WHERE settlement_id = ?
    `).get(settlementId) as SettlementRow | undefined;
    return row ? settlementFromRow(row) : null;
  }

  settlementForTask(taskId: string): DelegationExecutionSettlement | null {
    const row = this.db.prepare(`
      SELECT * FROM delegation_execution_settlements WHERE task_id = ?
    `).get(taskId) as SettlementRow | undefined;
    return row ? settlementFromRow(row) : null;
  }

  unsettledSettlements(): readonly DelegationExecutionSettlement[] {
    return (this.db.prepare(`
      SELECT * FROM delegation_execution_settlements
      WHERE state NOT IN ('committed', 'blocked') ORDER BY created_at, settlement_id
    `).all() as SettlementRow[]).map(settlementFromRow);
  }

  activeSettlements(): readonly DelegationExecutionSettlement[] {
    return (this.db.prepare(`
      SELECT settlements.*
      FROM delegation_execution_settlements AS settlements
      INNER JOIN delegation_sessions AS sessions
        ON sessions.session_id = settlements.session_id
        AND sessions.current_task_id = settlements.task_id
      ORDER BY settlements.created_at, settlements.settlement_id
    `).all() as SettlementRow[]).map(settlementFromRow);
  }

  extendSettlementMessagePrefix(input: {
    readonly settlementId: string;
    readonly throughSequence: number;
    readonly messageSequenceDigest: string;
    readonly now: number;
  }): DelegationExecutionSettlement {
    assertDigest(input.messageSequenceDigest, 'message sequence');
    return this.transaction(() => {
      const settlement = this.requireSettlement(input.settlementId);
      if (!Number.isSafeInteger(input.throughSequence)
        || input.throughSequence < settlement.messageSequence) {
        throw new DelegationStateError('invalid', 'Delegation settlement message prefix cannot move backward');
      }
      if (input.throughSequence === settlement.messageSequence) {
        if (input.messageSequenceDigest !== settlement.messageSequenceDigest) {
          return this.blockSettlementWithinTransaction(
            settlement,
            'Delegation settlement message prefix digest mismatch',
            input.now,
          );
        }
        return settlement;
      }
      if (settlement.state !== 'awaiting_result') {
        return this.blockSettlementWithinTransaction(
          settlement,
          'Delegation settlement message prefix changed after result preparation',
          input.now,
        );
      }
      if (this.messageSequenceDigest(settlement.sessionId, input.throughSequence)
        !== input.messageSequenceDigest) {
        return this.blockSettlementWithinTransaction(
          settlement,
          'Delegation settlement message prefix does not match Session evidence',
          input.now,
        );
      }
      this.db.prepare(`
        UPDATE delegation_execution_settlements
        SET message_sequence = ?, message_sequence_digest = ?, updated_at = ?
        WHERE settlement_id = ? AND state = 'awaiting_result'
      `).run(
        input.throughSequence,
        input.messageSequenceDigest,
        input.now,
        input.settlementId,
      );
      return this.requireSettlement(input.settlementId);
    });
  }

  prepareSettlement(input: {
    readonly settlementId: string;
    readonly requestDigest: string;
    readonly preparedResultDigest: string;
    readonly now: number;
  }): DelegationExecutionSettlement {
    assertDigest(input.requestDigest, 'request');
    assertDigest(input.preparedResultDigest, 'prepared result');
    return this.transitionSettlement(input.settlementId, input.now, (settlement) => {
      if (settlement.requestDigest !== input.requestDigest) return { blocked: 'Prepared result request digest mismatch' };
      if (settlement.preparedResultDigest && settlement.preparedResultDigest !== input.preparedResultDigest) {
        return { blocked: 'Prepared result digest mismatch' };
      }
      if (settlement.state === 'blocked' || settlement.state === 'committed') return { unchanged: true };
      if (settlement.state !== 'awaiting_result') return { unchanged: true };
      return { state: 'prepared', preparedResultDigest: input.preparedResultDigest };
    });
  }

  commitSettlementContext(input: {
    readonly settlementId: string;
    readonly turnId: TurnId;
    readonly requestDigest: string;
    readonly messageSequenceDigest: string;
    readonly preparedResultDigest: string;
    readonly now: number;
  }): DelegationExecutionSettlement {
    assertDigest(input.requestDigest, 'request');
    assertDigest(input.messageSequenceDigest, 'message sequence');
    assertDigest(input.preparedResultDigest, 'prepared result');
    return this.transitionSettlement(input.settlementId, input.now, (settlement) => {
      if (settlement.turnId !== input.turnId) return { blocked: 'Canonical completion Turn identity mismatch' };
      if (settlement.requestDigest !== input.requestDigest) return { blocked: 'Canonical completion request digest mismatch' };
      if (settlement.messageSequenceDigest !== input.messageSequenceDigest) {
        return { blocked: 'Canonical completion message sequence digest mismatch' };
      }
      if (settlement.preparedResultDigest !== input.preparedResultDigest) {
        return { blocked: 'Canonical completion prepared result digest mismatch' };
      }
      if (settlement.state === 'blocked' || settlement.state === 'committed'
        || settlement.state === 'context_committed') return { unchanged: true };
      if (settlement.state !== 'prepared') return { blocked: 'Canonical completion exists without a prepared result' };
      return { state: 'context_committed' };
    });
  }

  recordFinalReceipt(input: {
    readonly settlementId: string;
    readonly taskId: string;
    readonly preparedResultDigest: string;
    readonly finalReceiptDigest: string;
    readonly now: number;
  }): DelegationExecutionSettlement {
    assertDigest(input.preparedResultDigest, 'prepared result');
    assertDigest(input.finalReceiptDigest, 'final receipt');
    return this.transitionSettlement(input.settlementId, input.now, (settlement) => {
      if (settlement.taskId !== input.taskId) return { blocked: 'Final receipt Tool Task identity mismatch' };
      if (settlement.preparedResultDigest !== input.preparedResultDigest) {
        return { blocked: 'Final receipt prepared result digest mismatch' };
      }
      if (settlement.finalReceiptDigest && settlement.finalReceiptDigest !== input.finalReceiptDigest) {
        return { blocked: 'Final receipt digest mismatch' };
      }
      if (settlement.state === 'blocked' || settlement.state === 'committed') return { unchanged: true };
      if (settlement.state === 'awaiting_result') return { blocked: 'Final receipt exists without a prepared result' };
      return { state: settlement.state, finalReceiptDigest: input.finalReceiptDigest };
    });
  }

  commitSettlement(input: {
    readonly settlementId: string;
    readonly taskId: string;
    readonly preparedResultDigest: string;
    readonly finalReceiptDigest: string;
    readonly now: number;
  }): DelegationExecutionSettlement {
    assertDigest(input.preparedResultDigest, 'prepared result');
    assertDigest(input.finalReceiptDigest, 'final receipt');
    return this.transitionSettlement(input.settlementId, input.now, (settlement) => {
      if (settlement.taskId !== input.taskId) return { blocked: 'Terminal commit Tool Task identity mismatch' };
      if (settlement.preparedResultDigest !== input.preparedResultDigest) {
        return { blocked: 'Terminal commit prepared result digest mismatch' };
      }
      if (settlement.finalReceiptDigest !== input.finalReceiptDigest) {
        return { blocked: 'Terminal commit final receipt digest mismatch' };
      }
      if (settlement.state === 'blocked' || settlement.state === 'committed') return { unchanged: true };
      if (settlement.state !== 'context_committed') {
        return { blocked: 'Terminal commit requires canonical context completion' };
      }
      return { state: 'committed' };
    });
  }

  blockSettlement(settlementId: string, reason: string, now: number): DelegationExecutionSettlement {
    if (!reason) throw new DelegationStateError('invalid', 'Delegation settlement block requires a reason');
    return this.transaction(() => this.blockSettlementWithinTransaction(
      this.requireSettlement(settlementId),
      reason,
      now,
    ));
  }

  releaseExecution(sessionId: ThreadId, taskId: string, now: number): DelegationSessionBinding {
    return this.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.currentTaskId === null && session.previousTaskId === taskId) return session;
      if (session.currentTaskId !== taskId) {
        throw new DelegationStateError('conflict', `Delegation Session does not own active task: ${taskId}`);
      }
      const settlement = this.settlementForTask(taskId);
      if (!settlement || (settlement.state !== 'committed' && settlement.state !== 'blocked')) {
        throw new DelegationStateError('conflict', 'Delegation execution cannot release before settlement reconciliation');
      }
      this.advanceSession(sessionId, now, 'current_task_id = NULL, previous_task_id = ?', taskId);
      return this.requireSession(sessionId);
    });
  }

  fenceUserStop(input: {
    readonly sessionId: ThreadId;
    readonly expectedRevision: number;
    readonly cancelledTaskId: string;
    readonly stoppedByRootTurnId: TurnId;
    readonly currentRootIntentRevision: number;
    readonly now: number;
  }): DelegationSessionBinding {
    if (!isPositiveInteger(input.currentRootIntentRevision)
      || input.currentRootIntentRevision === Number.MAX_SAFE_INTEGER) {
      throw new DelegationStateError('invalid', 'User stop requires a positive root intent revision');
    }
    return this.transaction(() => {
      const session = this.requireOpenSession(input.sessionId);
      const expectedFence: DelegationStopFence = {
        cancelledTaskId: input.cancelledTaskId,
        stoppedByRootTurnId: input.stoppedByRootTurnId,
        stoppedAtRootIntentRevision: input.currentRootIntentRevision,
        minimumResumeRevision: input.currentRootIntentRevision + 1,
        stoppedAt: input.now,
      };
      if (session.stopFence
        && sameStopFenceIdentity(session.stopFence, expectedFence)) return session;
      this.assertRevision(session, input.expectedRevision);
      if (session.currentTaskId !== input.cancelledTaskId) {
        throw new DelegationStateError('conflict', 'User stop must fence the active delegation task');
      }
      this.blockQueuedMessagesWithinTransaction(
        input.sessionId,
        'Delegation message was blocked by user stop',
        input.now,
      );
      this.advanceSession(input.sessionId, input.now, 'stop_fence_json = ?, last_resume_json = NULL', JSON.stringify(expectedFence));
      return this.requireSession(input.sessionId);
    });
  }

  clearUserStopFence(input: {
    readonly sessionId: ThreadId;
    readonly expectedRevision: number;
    readonly rootTurnId: TurnId;
    readonly rootIntentRevision: number | null;
    readonly now: number;
  }): DelegationSessionBinding {
    return this.transaction(() => {
      const session = this.requireOpenSession(input.sessionId);
      if (session.lastResume?.rootTurnId === input.rootTurnId
        && session.lastResume.rootIntentRevision === input.rootIntentRevision) return session;
      this.assertRevision(session, input.expectedRevision);
      if (!session.stopFence) throw new DelegationStateError('conflict', 'Delegation Session has no user-stop fence');
      if (session.currentTaskId !== null) {
        throw new DelegationStateError('conflict', 'Delegation Session cannot resume before its stopped task settles');
      }
      if (input.rootIntentRevision === null
        || input.rootIntentRevision < session.stopFence.minimumResumeRevision) {
        throw new DelegationStateError('blocked', 'Delegation Session requires a fresh renderer-authored root request');
      }
      const resume: DelegationResumeRecord = {
        rootTurnId: input.rootTurnId,
        rootIntentRevision: input.rootIntentRevision,
        resumedAt: input.now,
      };
      this.advanceSession(input.sessionId, input.now, 'stop_fence_json = NULL, last_resume_json = ?', JSON.stringify(resume));
      return this.requireSession(input.sessionId);
    });
  }

  setAdapterSessionId(sessionId: ThreadId, expectedRevision: number, adapterSessionId: string, now: number): DelegationSessionBinding {
    if (!adapterSessionId) throw new DelegationStateError('invalid', 'Adapter Session ID must be non-empty');
    return this.transaction(() => {
      const session = this.requireOpenSession(sessionId);
      if (session.adapterSessionId === adapterSessionId) return session;
      if (session.adapterSessionId !== null) {
        throw new DelegationStateError('conflict', 'Adapter Session identity is immutable');
      }
      this.assertRevision(session, expectedRevision);
      this.advanceSession(sessionId, now, 'adapter_session_id = ?', adapterSessionId);
      return this.requireSession(sessionId);
    });
  }

  setWorktree(
    sessionId: ThreadId,
    expectedRevision: number,
    worktree: DelegationWorktreeDisposition,
    now: number,
  ): DelegationSessionBinding {
    validateWorktree(worktree);
    return this.transaction(() => {
      const session = this.requireSession(sessionId);
      if (JSON.stringify(session.worktree) === JSON.stringify(worktree)) return session;
      this.assertRevision(session, expectedRevision);
      this.advanceSession(sessionId, now, 'worktree_json = ?', JSON.stringify(worktree));
      return this.requireSession(sessionId);
    });
  }

  closeSession(sessionId: ThreadId, expectedRevision: number, now: number): DelegationSessionBinding {
    return this.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.state === 'closed') return session;
      this.assertRevision(session, expectedRevision);
      if (session.currentTaskId) {
        throw new DelegationStateError('conflict', 'An active Delegation execution must settle before Session closure');
      }
      if (this.queuedMessages(sessionId).length > 0) {
        throw new DelegationStateError('conflict', 'Queued Delegation messages must settle before Session closure');
      }
      this.db.prepare(`
        UPDATE delegation_sessions
        SET state = 'closed', revision = revision + 1, closed_at = ?, updated_at = ?
        WHERE session_id = ?
      `).run(now, now, sessionId);
      return this.requireSession(sessionId);
    });
  }

  deleteSessionsForOwner(ownerThreadId: ThreadId): number {
    return this.transaction(() => {
      const open = this.db.prepare(`
        SELECT session_id FROM delegation_sessions
        WHERE owner_thread_id = ? AND state = 'open' LIMIT 1
      `).get(ownerThreadId) as { session_id: string } | undefined;
      if (open) {
        throw new DelegationStateError('conflict', 'Open Delegation Sessions must close before owner deletion');
      }
      return Number(this.db.prepare('DELETE FROM delegation_sessions WHERE owner_thread_id = ?')
        .run(ownerThreadId).changes);
    });
  }

  private transitionSettlement(
    settlementId: string,
    now: number,
    transition: (settlement: DelegationExecutionSettlement) =>
      | { readonly unchanged: true }
      | { readonly blocked: string }
      | {
        readonly state: DelegationSettlementState;
        readonly preparedResultDigest?: string;
        readonly finalReceiptDigest?: string;
      },
  ): DelegationExecutionSettlement {
    return this.transaction(() => {
      const settlement = this.requireSettlement(settlementId);
      const result = transition(settlement);
      if ('unchanged' in result) return settlement;
      if (settlement.state === 'committed') {
        throw new DelegationStateError('conflict', `Committed Delegation settlement is immutable: ${settlementId}`);
      }
      if (settlement.state === 'blocked') return settlement;
      if ('blocked' in result) {
        return this.blockSettlementWithinTransaction(settlement, result.blocked, now);
      } else {
        this.db.prepare(`
          UPDATE delegation_execution_settlements
          SET state = ?,
              prepared_result_digest = COALESCE(?, prepared_result_digest),
              final_receipt_digest = COALESCE(?, final_receipt_digest),
              updated_at = ?
          WHERE settlement_id = ?
        `).run(
          result.state,
          result.preparedResultDigest ?? null,
          result.finalReceiptDigest ?? null,
          now,
          settlementId,
        );
      }
      this.advanceSession(settlement.sessionId, now);
      return this.requireSettlement(settlementId);
    });
  }

  private blockSettlementWithinTransaction(
    settlement: DelegationExecutionSettlement,
    reason: string,
    now: number,
  ): DelegationExecutionSettlement {
    if (settlement.state === 'committed') {
      throw new DelegationStateError('conflict', `Committed Delegation settlement is immutable: ${settlement.settlementId}`);
    }
    if (settlement.state === 'blocked') return settlement;
    this.db.prepare(`
      UPDATE delegation_execution_settlements
      SET state = 'blocked', blocked_reason = ?, updated_at = ? WHERE settlement_id = ?
    `).run(reason, now, settlement.settlementId);
    this.blockQueuedMessagesWithinTransaction(
      settlement.sessionId,
      `Delegation message was blocked because execution settlement ${settlement.settlementId} failed: ${reason}`,
      now,
    );
    this.advanceSession(settlement.sessionId, now);
    return this.requireSettlement(settlement.settlementId);
  }

  private blockQueuedMessagesWithinTransaction(sessionId: ThreadId, reason: string, now: number): void {
    this.db.prepare(`
      UPDATE delegation_root_messages
      SET body = NULL, state = 'blocked', blocked_reason = ?, updated_at = ?
      WHERE session_id = ? AND state = 'queued'
    `).run(reason, now, sessionId);
  }

  blockQueuedMessagesForSourceTask(
    sessionId: ThreadId,
    sourceTaskId: string,
    reason: string,
    now: number,
  ): number {
    if (!sourceTaskId || !reason) throw new DelegationStateError('invalid', 'Delegation message block requires identity and reason');
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE delegation_root_messages
      SET body = NULL, state = 'blocked', blocked_reason = ?, updated_at = ?
      WHERE session_id = ? AND source_task_id = ? AND state = 'queued'
    `).run(reason, now, sessionId, sourceTaskId).changes));
  }

  private blockedSettlementForSession(sessionId: ThreadId): DelegationExecutionSettlement | null {
    const row = this.db.prepare(`
      SELECT * FROM delegation_execution_settlements
      WHERE session_id = ? AND state = 'blocked' ORDER BY created_at, settlement_id LIMIT 1
    `).get(sessionId) as SettlementRow | undefined;
    return row ? settlementFromRow(row) : null;
  }

  private requireSession(sessionId: ThreadId): DelegationSessionBinding {
    const session = this.readSession(sessionId);
    if (!session) throw new DelegationStateError('not_found', `Delegation Session not found: ${sessionId}`);
    return session;
  }

  private requireOpenSession(sessionId: ThreadId): DelegationSessionBinding {
    const session = this.requireSession(sessionId);
    if (session.state !== 'open') throw new DelegationStateError('closed', `Delegation Session is closed: ${sessionId}`);
    return session;
  }

  private requireMessage(messageId: string): DelegationRootMessage {
    const message = this.readMessage(messageId);
    if (!message) throw new DelegationStateError('not_found', `Delegation message not found: ${messageId}`);
    return message;
  }

  private requireSettlement(settlementId: string): DelegationExecutionSettlement {
    const settlement = this.readSettlement(settlementId);
    if (!settlement) throw new DelegationStateError('not_found', `Delegation settlement not found: ${settlementId}`);
    return settlement;
  }

  private assertRevision(session: DelegationSessionBinding, expectedRevision: number): void {
    if (!isPositiveInteger(expectedRevision) || session.revision !== expectedRevision) {
      throw new DelegationStateError(
        'stale_revision',
        `Delegation Session revision changed: expected ${expectedRevision}, current ${session.revision}`,
      );
    }
  }

  private assertResumeFence(
    session: DelegationSessionBinding,
    rootTurnId: TurnId,
    rootIntentRevision: number | null,
  ): void {
    if (!session.stopFence) return;
    if (session.lastResume?.rootTurnId === rootTurnId
      && session.lastResume.rootIntentRevision === rootIntentRevision) return;
    throw new DelegationStateError('blocked', 'Delegation Session is fenced by a user stop');
  }

  private advanceSession(sessionId: ThreadId, now: number, assignment?: string, ...params: readonly (string | number | null)[]): void {
    const set = assignment ? `${assignment}, ` : '';
    const result = this.db.prepare(`
      UPDATE delegation_sessions SET ${set}revision = revision + 1, updated_at = ? WHERE session_id = ?
    `).run(...params, now, sessionId);
    if (result.changes !== 1) throw new DelegationStateError('not_found', `Delegation Session not found: ${sessionId}`);
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

function sessionFromRow(row: SessionRow): DelegationSessionBinding {
  if (row.state !== 'open' && row.state !== 'closed') throw new Error('Invalid persisted Delegation Session state');
  const policy = decodePolicy(row.policy_json);
  const worktree = decodeWorktree(row.worktree_json);
  const stopFence = row.stop_fence_json ? decodeStopFence(row.stop_fence_json) : null;
  const lastResume = row.last_resume_json ? decodeResume(row.last_resume_json) : null;
  return {
    sessionId: row.session_id,
    ownerThreadId: row.owner_thread_id,
    state: row.state,
    revision: row.revision,
    policy,
    adapterSessionId: row.adapter_session_id,
    currentTaskId: row.current_task_id,
    previousTaskId: row.previous_task_id,
    messageSequence: row.message_sequence,
    stopFence,
    lastResume,
    worktree,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function messageFromRow(row: MessageRow): DelegationRootMessage {
  if (row.state !== 'queued' && row.state !== 'committed' && row.state !== 'blocked') {
    throw new Error('Invalid persisted Delegation message state');
  }
  assertDigest(row.digest, 'persisted message');
  assertDigest(row.prefix_digest, 'persisted message prefix');
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    sequence: row.sequence,
    digest: row.digest,
    prefixDigest: row.prefix_digest,
    text: row.body,
    state: row.state,
    sourceTaskId: row.source_task_id,
    sourceRootTurnId: row.source_root_turn_id,
    sourceRootItemId: row.source_root_item_id,
    sourceRootIntentRevision: row.source_root_intent_revision,
    deliveryTurnId: row.delivery_turn_id,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function settlementFromRow(row: SettlementRow): DelegationExecutionSettlement {
  if (!['awaiting_result', 'prepared', 'context_committed', 'committed', 'blocked'].includes(row.state)) {
    throw new Error('Invalid persisted Delegation settlement state');
  }
  assertDigest(row.request_digest, 'persisted request');
  assertDigest(row.message_sequence_digest, 'persisted message sequence');
  if (row.prepared_result_digest) assertDigest(row.prepared_result_digest, 'persisted prepared result');
  if (row.final_receipt_digest) assertDigest(row.final_receipt_digest, 'persisted final receipt');
  return {
    settlementId: row.settlement_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    taskId: row.task_id,
    requestDigest: row.request_digest,
    messageSequence: row.message_sequence,
    messageSequenceDigest: row.message_sequence_digest,
    preparedResultDigest: row.prepared_result_digest,
    finalReceiptDigest: row.final_receipt_digest,
    state: row.state as DelegationSettlementState,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validatePolicy(policy: DelegationPolicySnapshot): void {
  if (!policy.runnerId || !policy.configurationRevision || !policy.cwd) {
    throw new DelegationStateError('invalid', 'Delegation policy identity, revision, and cwd must be non-empty');
  }
  if (!['general', 'explore', 'plan'].includes(policy.profile)
    || !['read-only', 'workspace-write'].includes(policy.access)
    || !['none', 'dedicated'].includes(policy.worktreePolicy)) {
    throw new DelegationStateError('invalid', 'Delegation policy contains an unsupported value');
  }
  assertDigest(policy.capabilityCeilingDigest, 'capability ceiling');
  assertDigest(policy.schedulingPolicyDigest, 'scheduling policy');
}

function decodePolicy(value: string): DelegationPolicySnapshot {
  const parsed = JSON.parse(value) as DelegationPolicySnapshot;
  validatePolicy(parsed);
  return parsed;
}

function validateWorktree(worktree: DelegationWorktreeDisposition): void {
  if (worktree.kind === 'none') return;
  if (worktree.kind === 'planned') {
    validateWorktreeIntent(worktree.intent);
    return;
  }
  if (worktree.kind === 'cleaned') {
    if (!worktree.baseRevision) throw new DelegationStateError('invalid', 'Cleaned worktree requires a base revision');
    return;
  }
  if (worktree.kind === 'ambiguous') {
    validateWorktreeIntent(worktree.intent);
    if (worktree.metadata !== null) validateWorktreeMetadata(worktree.metadata);
    return;
  }
  if (!['active', 'unchanged', 'changed', 'retained'].includes(worktree.kind)) {
    throw new DelegationStateError('invalid', 'Delegation worktree disposition is invalid');
  }
  validateWorktreeMetadata(worktree.metadata);
}

function validateWorktreeIntent(intent: {
  readonly sourceCwd: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly gitCommonDir: string;
}): void {
  if (!intent.sourceCwd || !intent.path || !intent.branch || !intent.baseCommit || !intent.gitCommonDir) {
    throw new DelegationStateError('invalid', 'Delegation worktree intent is invalid');
  }
}

function validateWorktreeMetadata(metadata: {
  readonly sourceCwd: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly gitCommonDir: string;
  readonly gitWorktreeDir: string;
  readonly managed: true;
  readonly removedAt: number | null;
}): void {
  validateWorktreeIntent(metadata);
  if (!metadata.gitWorktreeDir || metadata.managed !== true
    || (metadata.removedAt !== null && !Number.isSafeInteger(metadata.removedAt))) {
    throw new DelegationStateError('invalid', 'Delegation worktree metadata is invalid');
  }
}

function decodeWorktree(value: string): DelegationWorktreeDisposition {
  const parsed = JSON.parse(value) as DelegationWorktreeDisposition;
  validateWorktree(parsed);
  return parsed;
}

function decodeStopFence(value: string): DelegationStopFence {
  const parsed = JSON.parse(value) as DelegationStopFence;
  if (!parsed.cancelledTaskId || !parsed.stoppedByRootTurnId
    || !isPositiveInteger(parsed.stoppedAtRootIntentRevision)
    || parsed.minimumResumeRevision !== parsed.stoppedAtRootIntentRevision + 1
    || !Number.isSafeInteger(parsed.stoppedAt)) {
    throw new Error('Invalid persisted Delegation stop fence');
  }
  return parsed;
}

function decodeResume(value: string): DelegationResumeRecord {
  const parsed = JSON.parse(value) as DelegationResumeRecord;
  if (!parsed.rootTurnId || !isPositiveInteger(parsed.rootIntentRevision) || !Number.isSafeInteger(parsed.resumedAt)) {
    throw new Error('Invalid persisted Delegation resume record');
  }
  return parsed;
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestMessagePrefix(
  previousDigest: string,
  sequence: number,
  digest: string,
  sourceRootTurnId: TurnId,
  sourceRootItemId: string,
): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    previousDigest,
    sequence,
    digest,
    sourceRootTurnId,
    sourceRootItemId,
  })).digest('hex');
}

function sameMessageAdmission(
  message: DelegationRootMessage,
  input: AppendDelegationMessageInput,
  digest: string,
): boolean {
  return message.sessionId === input.sessionId
    && message.digest === digest
    && message.sourceTaskId === input.sourceTaskId
    && message.sourceRootTurnId === input.sourceRootTurnId
    && message.sourceRootItemId === input.sourceRootItemId
    && message.sourceRootIntentRevision === input.sourceRootIntentRevision;
}

function sameSettlementAdmission(
  settlement: DelegationExecutionSettlement,
  input: ReserveDelegationExecutionInput,
): boolean {
  return settlement.sessionId === input.sessionId
    && settlement.turnId === input.turnId
    && settlement.taskId === input.taskId
    && settlement.requestDigest === input.requestDigest
    && settlement.messageSequence === input.messageSequence
    && settlement.messageSequenceDigest === input.messageSequenceDigest;
}

function sameStopFenceIdentity(left: DelegationStopFence, right: DelegationStopFence): boolean {
  return left.cancelledTaskId === right.cancelledTaskId
    && left.stoppedByRootTurnId === right.stoppedByRootTurnId
    && left.stoppedAtRootIntentRevision === right.stoppedAtRootIntentRevision;
}

function assertDigest(value: string, label: string): void {
  if (!isDigest(value)) throw new DelegationStateError('invalid', `Delegation ${label} digest must be lowercase SHA-256`);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
