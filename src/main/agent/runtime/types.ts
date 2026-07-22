import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type {
  AdditionalContext,
  Thread,
  ThreadUserContent,
  Turn,
  TurnError,
  TurnStatus,
} from '../../../core/agent/protocol';
import type { ItemRecorder } from './ItemRecorder';

export interface SteeredTurnInput {
  readonly content: readonly ThreadUserContent[];
  readonly additionalContext?: AdditionalContext;
}

export interface TurnExecutionContext {
  readonly thread: Thread;
  readonly turn: Turn;
  readonly historyBeforeTurn: readonly Turn[];
  readonly configuration: EffectiveThreadConfiguration;
  readonly additionalContext?: AdditionalContext;
  readonly systemContext: readonly string[];
  readonly signal: AbortSignal;
  readonly recorder: ItemRecorder;
  onSteer(handler: (input: SteeredTurnInput) => void | Promise<void>): void;
}

export interface TurnExecutionResult {
  readonly status?: Exclude<TurnStatus, 'inProgress'>;
  readonly error?: TurnError | null;
  readonly tokensUsed?: number;
}

export interface TurnExecutor {
  execute(context: TurnExecutionContext): Promise<TurnExecutionResult>;
}
