import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type {
  AdditionalContext,
  Thread,
  ThreadItemOutputReference,
  ThreadUserContent,
  Turn,
  TurnExecutionDetails,
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
  persistOutputImage(
    itemId: string,
    index: number,
    dataBase64: string,
    mimeType: string,
  ): Promise<string>;
  persistOutputText(
    itemId: string,
    text: string,
    mimeType: ThreadItemOutputReference['mimeType'],
    summary: string,
  ): Promise<ThreadItemOutputReference>;
  onProviderRetry(status: import('../../../core/agent/protocol').ProviderRetryStatus | null): void;
  onSteer(handler: (input: SteeredTurnInput) => void | Promise<void>): void;
}

export interface TurnExecutionResult {
  readonly status?: Exclude<TurnStatus, 'inProgress'>;
  readonly error?: TurnError | null;
  readonly execution?: TurnExecutionDetails;
}

export interface TurnExecutor {
  execute(context: TurnExecutionContext): Promise<TurnExecutionResult>;
}

export interface ThreadNameGenerationContext {
  readonly thread: Thread;
  readonly turn: Turn;
  readonly configuration: EffectiveThreadConfiguration;
  readonly signal: AbortSignal;
}

export interface ThreadNameGenerator {
  generateName(context: ThreadNameGenerationContext): Promise<string | null>;
}
