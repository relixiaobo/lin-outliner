import type { ThreadId, TurnId } from './protocol';
import type { VerificationConfiguration, VerificationView } from './verification';

export const THREAD_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
] as const;

export type ThreadGoalStatus = typeof THREAD_GOAL_STATUSES[number];
export type AgentWritableThreadGoalStatus = 'blocked' | 'complete';

export interface ThreadGoal {
  readonly threadId: ThreadId;
  readonly objective: string;
  readonly status: ThreadGoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GetGoalInput {
  readonly threadId: ThreadId;
}

export interface CreateGoalInput {
  readonly threadId: ThreadId;
  readonly objective: string;
  readonly tokenBudget?: number;
  readonly verification?: VerificationConfiguration;
}

export interface UpdateGoalInput {
  readonly threadId: ThreadId;
  readonly status: AgentWritableThreadGoalStatus;
}

export interface GetGoalResponse {
  readonly goal: ThreadGoal | null;
  readonly verification?: VerificationView;
}

export interface CreateGoalResponse {
  readonly goal: ThreadGoal;
  readonly verification?: VerificationView;
}

export interface UpdateGoalResponse {
  readonly goal: ThreadGoal;
  readonly verification?: VerificationView;
}

export type GoalToolName = 'get_goal' | 'create_goal' | 'update_goal';

export type ThreadGoalNotification =
  | {
      readonly type: 'goal/updated';
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly goal: ThreadGoal;
    }
  | { readonly type: 'goal/cleared'; readonly threadId: ThreadId };
