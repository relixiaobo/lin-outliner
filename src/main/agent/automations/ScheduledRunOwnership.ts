import type { AutomationRun } from '../../../core/agent/automation';
import type { Turn } from '../../../core/agent/protocol';
import type { ThreadService } from '../ThreadService';
import type { AutomationStore } from './AutomationStore';
import type { ToolTaskRecord } from '../tasks/toolTaskTypes';

/** Derives ownership only from accepted Turn provenance and canonical delivery batches. */
export class ScheduledRunOwnership {
  constructor(private readonly store: AutomationStore, private readonly threads: ThreadService) {}

  forTurn(threadId: string, turnId: string, visited = new Set<string>()): AutomationRun | null {
    const key = `${threadId}:${turnId}`;
    if (visited.has(key) || visited.size >= 64) return null;
    visited.add(key);
    const turn = this.threads.readTurnForHost(threadId, turnId);
    if (!turn) return null;
    const trigger = turn.provenance.trigger;
    if (trigger.kind === 'continuation') return this.forTurn(threadId, trigger.sourceTurnId, visited);
    if (trigger.kind !== 'feature') return null;
    if (trigger.feature === 'automation' && trigger.ref) {
      const run = this.store.readRun(trigger.ref);
      return run?.state === 'dispatched' && run.threadId === threadId && run.turnId === turnId ? run : null;
    }
    if (trigger.feature !== 'tool-task-completion' || !trigger.ref) return null;
    const batch = this.threads.toolTaskService().store.readBatch(trigger.ref);
    if (!batch || batch.ownerThreadId !== threadId || batch.reservedTurnId !== turnId) return null;
    return this.forBatch(batch.batchId, threadId, visited);
  }

  forBatch(batchId: string, threadId: string, visited = new Set<string>()): AutomationRun | null {
    const tasks = this.threads.toolTaskService().store;
    const batch = tasks.readBatch(batchId);
    if (!batch || batch.ownerThreadId !== threadId || !batch.taskIds.length) return null;
    let owner: AutomationRun | null = null;
    for (const taskId of batch.taskIds) {
      const task = tasks.read(taskId);
      if (!task || task.ownerThreadId !== threadId) return null;
      const candidate = this.forTurn(threadId, task.sourceTurnId, new Set(visited));
      if (!candidate || (owner && candidate.id !== owner.id)) return null;
      owner = candidate;
    }
    return owner;
  }

  ownsTask(run: AutomationRun, task: ToolTaskRecord, visited = new Set<string>()): boolean {
    if (visited.has(task.taskId) || visited.size >= 64) return false;
    visited.add(task.taskId);
    const owner = this.forTurn(task.ownerThreadId, task.sourceTurnId);
    if (owner?.id === run.id) return true;
    if (!task.parentTaskId) return false;
    const parent = this.threads.toolTaskService().store.read(task.parentTaskId);
    return parent !== null && this.ownsTask(run, parent, visited);
  }

  turns(run: AutomationRun): readonly Turn[] {
    if (!run.threadId || !run.turnId) return [];
    const ids = new Set([run.turnId]);
    for (const task of this.threads.toolTaskService().store.listAll(run.threadId)) {
      if (task.deliveryTurnId) ids.add(task.deliveryTurnId);
    }
    const active = this.threads.activeTurnIdForHost(run.threadId);
    if (active) ids.add(active);
    return [...ids].filter((id) => this.forTurn(run.threadId!, id)?.id === run.id)
      .map((id) => this.threads.readTurnForHost(run.threadId!, id))
      .filter((turn): turn is Turn => turn !== null)
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  }

  processes(run: AutomationRun): readonly ToolTaskRecord[] {
    if (!run.threadId) return [];
    return this.threads.toolTaskService().store.listAll(run.threadId).filter((task) => task.backgroundEnabled && this.ownsTask(run, task));
  }
}
