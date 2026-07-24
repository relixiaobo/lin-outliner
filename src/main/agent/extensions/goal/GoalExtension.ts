import type { AgentCoreExtension, ThreadServiceExtensionHost } from '../../../../core/agent/extensions';
import type {
  CreateGoalInput,
  CreateGoalResponse,
  GetGoalInput,
  GetGoalResponse,
  ThreadGoal,
  UpdateGoalInput,
  UpdateGoalResponse,
} from '../../../../core/agent/goal';
import type { AgentCoreNotification, Thread, ThreadId, TurnId } from '../../../../core/agent/protocol';
import { GoalStore, type GoalRecord } from './GoalStore';

type NotificationPublisher = (notification: AgentCoreNotification) => Promise<void>;
type ThreadReader = (threadId: ThreadId) => Thread;

export class GoalExtension implements AgentCoreExtension {
  readonly id = 'goal';
  private host: ThreadServiceExtensionHost | null = null;
  private readThread: ThreadReader | null = null;
  private readonly ephemeralGoals = new Map<ThreadId, GoalRecord>();

  constructor(
    private readonly store: GoalStore,
    private readonly publish: NotificationPublisher,
  ) {}

  bindHost(host: ThreadServiceExtensionHost, readThread: ThreadReader): void {
    this.host = host;
    this.readThread = readThread;
  }

  get(input: GetGoalInput): GetGoalResponse {
    return { goal: this.read(input.threadId)?.goal ?? null };
  }

  async create(input: CreateGoalInput, turnId: TurnId | null = null): Promise<CreateGoalResponse> {
    const thread = this.requireThread(input.threadId);
    const record = thread.ephemeral
      ? this.createEphemeral(input.threadId, input.objective, input.tokenBudget ?? null)
      : this.store.create(input.threadId, input.objective, input.tokenBudget ?? null);
    await this.publish({ type: 'goal/updated', threadId: input.threadId, turnId, goal: record.goal });
    return { goal: record.goal };
  }

  async update(input: UpdateGoalInput, turnId: TurnId | null = null): Promise<UpdateGoalResponse> {
    const thread = this.requireThread(input.threadId);
    const record = thread.ephemeral
      ? this.updateEphemeral(input.threadId, input.status)
      : this.store.updateFromAgent(input.threadId, input.status);
    await this.publish({ type: 'goal/updated', threadId: input.threadId, turnId, goal: record.goal });
    return { goal: record.goal };
  }

  async addUsage(threadId: ThreadId, tokens: number, timeSeconds: number, turnId: TurnId): Promise<void> {
    const current = this.read(threadId);
    if (!current || (tokens === 0 && timeSeconds === 0)) return;
    const thread = this.requireThread(threadId);
    const record = thread.ephemeral
      ? this.addEphemeralUsage(threadId, tokens, timeSeconds)
      : this.store.addUsage(threadId, tokens, timeSeconds);
    await this.publish({ type: 'goal/updated', threadId, turnId, goal: record.goal });
  }

  async clear(threadId: ThreadId): Promise<void> {
    const removed = this.ephemeralGoals.delete(threadId) || this.store.clear(threadId);
    if (removed) await this.publish({ type: 'goal/cleared', threadId });
  }

  async onThreadIdle(thread: Thread): Promise<void> {
    const record = this.read(thread.id);
    if (!record || record.goal.status !== 'active' || !this.host) return;
    if (!thread.ephemeral && this.store.readDeferral(thread.id)) {
      this.store.clearDeferral(thread.id);
    }
    const turn = await this.host.tryStartTurnIfIdle({
      threadId: thread.id,
      input: [{ type: 'text', text: `Continue working toward the active Goal: ${record.goal.objective}` }],
      trigger: { kind: 'feature', feature: 'goal_continuation', ref: String(record.generation) },
    });
    if (!turn && !thread.ephemeral) {
      this.store.deferContinuation(thread.id, record.generation, 'Thread was not idle at continuation admission');
    }
  }

  private read(threadId: ThreadId): GoalRecord | null {
    return this.ephemeralGoals.get(threadId) ?? this.store.read(threadId);
  }

  private requireThread(threadId: ThreadId): Thread {
    if (!this.readThread) throw new Error('Goal extension is not bound to ThreadService');
    return this.readThread(threadId);
  }

  private createEphemeral(threadId: ThreadId, objective: string, tokenBudget: number | null): GoalRecord {
    const existing = this.ephemeralGoals.get(threadId);
    if (existing && existing.goal.status !== 'complete') throw new Error('An unfinished Goal already exists for this Thread');
    const now = Date.now();
    const record: GoalRecord = {
      generation: (existing?.generation ?? 0) + 1,
      goal: goalValue(threadId, objective, 'active', tokenBudget, 0, 0, now, now),
    };
    this.ephemeralGoals.set(threadId, record);
    return record;
  }

  private updateEphemeral(threadId: ThreadId, status: 'blocked' | 'complete'): GoalRecord {
    const current = this.ephemeralGoals.get(threadId);
    if (!current) throw new Error(`Goal not found for Thread: ${threadId}`);
    const record = {
      generation: current.generation,
      goal: { ...current.goal, status, updatedAt: Date.now() },
    } satisfies GoalRecord;
    this.ephemeralGoals.set(threadId, record);
    return record;
  }

  private addEphemeralUsage(threadId: ThreadId, tokens: number, timeSeconds: number): GoalRecord {
    const current = this.ephemeralGoals.get(threadId);
    if (!current) throw new Error(`Goal not found for Thread: ${threadId}`);
    const tokensUsed = current.goal.tokensUsed + tokens;
    const status = current.goal.tokenBudget !== null && tokensUsed >= current.goal.tokenBudget
      ? 'budgetLimited'
      : current.goal.status;
    const record = {
      generation: current.generation,
      goal: {
        ...current.goal,
        status,
        tokensUsed,
        timeUsedSeconds: current.goal.timeUsedSeconds + timeSeconds,
        updatedAt: Date.now(),
      },
    } satisfies GoalRecord;
    this.ephemeralGoals.set(threadId, record);
    return record;
  }
}

function goalValue(
  threadId: ThreadId,
  objective: string,
  status: ThreadGoal['status'],
  tokenBudget: number | null,
  tokensUsed: number,
  timeUsedSeconds: number,
  createdAt: number,
  updatedAt: number,
): ThreadGoal {
  const normalized = objective.trim();
  if (!normalized) throw new Error('Goal objective must be non-empty');
  if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
    throw new Error('Goal token budget must be a positive integer');
  }
  return {
    threadId,
    objective: normalized,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}
