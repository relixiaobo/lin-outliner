import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Thread } from '../../../core/agent/protocol';
import { startupIssue } from '../../startupIssue';
import type { ExtensionRegistry } from '../ExtensionRegistry';
import type { GoalStore } from '../extensions/goal/GoalStore';
import type { ToolTaskService } from '../tasks/ToolTaskService';
import { isToolTaskTerminal } from '../tasks/toolTaskTypes';
import type { ThreadCore } from '../thread/ThreadCore';
import type { ThreadRecordPublisher } from '../thread/ThreadRecordPublisher';
import type { ThreadResourceOps } from '../thread/ThreadResourceOps';
import { recoveryDigest, type RecoveryEvidence } from './RecoveryEvidence';
import { inspectRecoverySource, recoveryRolloutDigests, retainRecoverySource, verifyRecoveryHistory } from './ThreadRecoveryHistory';
import { ThreadRecoveryService, type RecoveryInspection, type ThreadRecoveryOperation, type ThreadRecoveryParticipant, type ThreadRecoveryOptions, type ThreadRecoveryStep } from './ThreadRecoveryService';
import type { RolloutEntry } from '../persistence/RolloutStore';

export interface ThreadRecoveryRuntimeOptions {
  readonly root: string;
  readonly recordRoot: string;
  readonly scratchRoot: string;
  readonly core: ThreadCore;
  readonly goals: GoalStore;
  readonly tasks: ToolTaskService;
  readonly records: ThreadRecordPublisher;
  readonly resources: ThreadResourceOps;
  readonly extensions: ExtensionRegistry;
  eligible(threadId: string): boolean;
  active(threadId: string): boolean;
  pendingInput(threadId: string): boolean;
  changed(operation: ThreadRecoveryOperation): void;
  completed(operation: ThreadRecoveryOperation): Promise<void>;
  forgetExclusions(sessionIds: readonly string[]): Promise<void>;
  readonly checkpoint?: ThreadRecoveryOptions['checkpoint'];
}

/** Bind the recovery transaction to the production owners without decoding broken history for removal. */
export class ThreadRecoveryRuntime {
  readonly service: ThreadRecoveryService;
  private participants: readonly ThreadRecoveryParticipant[] = [];

  constructor(private readonly options: ThreadRecoveryRuntimeOptions) {
    this.service = new ThreadRecoveryService({
      root: options.root,
      journal: options.core.metadata.recoveryJournal(),
      inspect: (id) => this.inspect(id),
      withFence: (threads, operation) => this.withFence(threads, operation),
      retain: (operation, evidence) => this.retain(operation, evidence),
      steps: (operation, evidence) => this.steps(operation, evidence),
      changed: options.changed,
      completed: options.completed,
      checkpoint: options.checkpoint,
    });
  }

  bind(participants: readonly ThreadRecoveryParticipant[]): void {
    if (this.participants.length) throw new Error('Recovery owners are already bound');
    if (new Set(participants.map((entry) => entry.name)).size !== participants.length) throw new Error('Duplicate recovery owner');
    this.participants = participants;
  }

  private async inspect(threadId: string): Promise<RecoveryInspection> {
    const { core, goals, tasks } = this.options;
    if (!this.options.eligible(threadId) && !this.service?.pending().some((entry) => entry.threadId === threadId)) {
      throw new Error('Conversation has no current recovery issue');
    }
    let threads: readonly Thread[];
    try { threads = core.metadata.recoveryClosure(threadId).map((record) => record.thread); }
    catch (error) {
      return { threads: [], revision: recoveryDigest({ threadId, unavailable: true }), source: null,
        rebuildUnavailable: 'The conversation catalog cannot prove its exact scope.',
        blockers: [startupIssue('agent', error).message], resourceCount: 0 };
    }
    const ids = threads.map((thread) => thread.id);
    const blockers: string[] = [];
    for (const id of ids) {
      if (this.options.active(id)) blockers.push(`Conversation ${id} has active work.`);
      if (this.options.pendingInput(id)) blockers.push(`Conversation ${id} has a live question awaiting settlement.`);
      for (const task of tasks.store.listAll(id)) {
        if (!isToolTaskTerminal(task.state)) blockers.push(`Task ${task.taskId} has a live or unverified process.`);
      }
    }
    try {
      const owners = await Promise.all(this.participants.map(async (owner) => ({ name: owner.name, ...await owner.inspect(ids) })));
      for (const owner of owners) blockers.push(...owner.blockers);
      const resources = core.resources.recoveryState(ids);
      if (resources.uploads) blockers.push('A conversation attachment upload is still active.');
      const source = await inspectRecoverySource(core, threads[0]!);
      const state = {
        metadata: core.metadata.recoveryState(ids), history: core.history.recoveryState(ids),
        goals: goals.recoveryState(ids), tasks: tasks.store.recoveryState(ids),
        resources, owners, rollouts: await recoveryRolloutDigests(core, ids),
      };
      return { threads, revision: recoveryDigest(state), source: source.source,
        rebuildUnavailable: source.unavailable, blockers, resourceCount: resources.count };
    } catch (error) {
      return { threads, revision: recoveryDigest({ ids, unavailable: true }), source: null,
        rebuildUnavailable: 'Recovery source inspection is unavailable.',
        blockers: [...blockers, startupIssue('agent', error).message], resourceCount: 0 };
    }
  }

  private withFence<T>(threads: readonly Thread[], operation: () => Promise<T>): Promise<T> {
    const ids = threads.map((thread) => thread.id).sort();
    const { core, tasks } = this.options;
    const withThreads = async () => {
      if (ids.some((id) => core.stoppingThreads.has(id) && !this.service.isFenced(id))) throw new Error('Conversation is already stopping');
      for (const id of ids) core.stoppingThreads.add(id);
      tasks.fenceRecovery(ids);
      const enter = (index: number): Promise<T> => index === ids.length
        ? operation() : core.threadMutex.run(ids[index]!, () => enter(index + 1));
      try {
        await Promise.all(ids.map((id) => core.flushThreadNotifications(id)));
        return await enter(0);
      } finally {
        for (const id of ids) if (!this.service.isFenced(id)) core.stoppingThreads.delete(id);
        tasks.releaseRecovery(ids.filter((id) => !this.service.isFenced(id)));
      }
    };
    const withOwners = (index: number): Promise<T> => index === this.participants.length ? withThreads()
      : this.participants[index]!.withLock(ids, () => withOwners(index + 1));
    return withOwners(0);
  }

  private async retain(operation: ThreadRecoveryOperation, evidence: RecoveryEvidence): Promise<void> {
    const { core, goals, tasks } = this.options;
    const ids = operation.threads.map((thread) => thread.id);
    await evidence.json('scope.json', operation);
    await core.metadata.retainRecovery(evidence);
    await core.history.retainRecovery(evidence);
    await goals.retainRecovery(evidence);
    for (const id of ids) {
      await core.rollout.retainRecovery(id, evidence);
      await core.payloads.retainRecovery(id, evidence);
      await evidence.directory(`scratch/${id}`, join(this.options.scratchRoot, 'edits', id));
    }
    await core.resources.retainRecovery(ids, evidence);
    await tasks.retainRecovery(ids, evidence);
    for (const owner of this.participants) await owner.retain(ids, evidence);
    if (operation.action === 'rebuild') await retainRecoverySource(core, operation.threadId, operation.source!, evidence);
  }

  private steps(operation: ThreadRecoveryOperation, evidence: RecoveryEvidence): readonly ThreadRecoveryStep[] {
    const { core, tasks, goals, records } = this.options;
    const ids = operation.threads.map((thread) => thread.id);
    const each = (name: string, run: (id: string) => Promise<void> | void): ThreadRecoveryStep => ({
      name, run: async () => { for (const id of [...ids].reverse()) await run(id); },
    });
    if (operation.action === 'rebuild') {
      return [
        { name: 'publication-fence', run: () => records.deleteForRecovery(operation.threadId) },
        { name: 'rollout-install', run: () => core.rollout.installRecovery(operation.threadId, join(evidence.root, 'source-rollout.jsonl')) },
        { name: 'history-install', run: async () => {
          const entries = JSON.parse(await readFile(join(evidence.root, 'source-entries.json'), 'utf8')) as readonly RolloutEntry[];
          verifyRecoveryHistory(operation.threadId, entries);
          core.history.rebuildThread(operation.threadId, entries);
          core.metadata.setStatus(operation.threadId, { type: 'idle' }, Date.now());
        } },
        { name: 'history-verify', run: async () => {
          const entries = await core.rollout.readForRecovery(operation.threadId);
          verifyRecoveryHistory(operation.threadId, entries);
          core.history.rolloutSnapshot(operation.threadId);
        } },
      ];
    }
    return [
      each('publication-fence', (id) => records.deleteForRecovery(id)),
      ...this.participants.map((owner): ThreadRecoveryStep => ({ name: owner.name, run: () => owner.remove(ids) })),
      each('task-delivery', (id) => tasks.store.removeRecoveryDelivery(id)),
      each('tasks', (id) => tasks.deleteOwner(id)),
      each('goals', (id) => { goals.clear(id); }),
      each('history', (id) => core.history.deleteThread(id)),
      each('rollouts', (id) => core.rollout.delete(id)),
      each('payloads', (id) => core.payloads.deleteThread(id)),
      { name: 'resource-links', run: () => core.resources.removeRecoveryLinks(ids) },
      each('scratch', (id) => this.options.resources.deleteThreadScratch(id)),
      { name: 'catalog', run: () => {
        const present = core.metadata.read(operation.threadId);
        if (present) {
          const actual = core.metadata.recoveryClosure(operation.threadId).map((record) => record.thread.id).sort();
          if (JSON.stringify(actual) !== JSON.stringify([...ids].sort())) throw new Error('Recovery removal scope changed');
          core.metadata.delete(operation.threadId);
        }
        if (ids.some((id) => core.metadata.read(id))) throw new Error('Recovery catalog removal is incomplete');
        core.clearThreadAdmissionBarriers(ids);
      } },
      { name: 'owner-notifications', run: async () => {
        for (const thread of [...operation.threads].reverse()) {
          await this.options.extensions.threadStopped(thread);
          await this.options.extensions.threadDeleted(thread);
        }
        await this.options.forgetExclusions(operation.threads.map((thread) => thread.sessionId));
      } },
      each('publication-verify', (id) => records.deleteForRecovery(id)),
    ];
  }
}
