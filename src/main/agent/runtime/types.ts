import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type {
  Thread,
  ContextCursor,
  ThreadContextPayload,
  ContextEvidenceThreadItem,
  ContextCompactionThreadItem,
  ContextEvidenceKind,
  ThreadContextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  ThreadResourceReference,
  ThreadUserContent,
  Turn,
  TurnExecutionDetails,
  TurnError,
  TurnStatus,
  SkillCatalogContextPayload,
} from '../../../core/agent/protocol';
import type { ItemRecorder } from './ItemRecorder';

export interface SteeredTurnInput {
  readonly items: readonly ThreadItem[];
  readonly acceptedAt: number;
}

export interface TurnExecutionContext {
  readonly thread: Thread;
  readonly turn: Turn;
  readonly historyBeforeTurn: readonly Turn[];
  readonly configuration: EffectiveThreadConfiguration;
  readonly signal: AbortSignal;
  readonly recorder: ItemRecorder;
  readContext(ref: ThreadContextPayloadReference): Promise<ThreadContextPayload | null>;
  readOutput(ref: ThreadItemOutputReference): Promise<string | null>;
  resolveResourceObservationPath(ref: ThreadResourceReference): Promise<string | null>;
  readResource(ref: ThreadResourceReference): Promise<Buffer | null>;
  persistOutputImage(
    dataBase64: string,
    mimeType: string,
  ): Promise<ThreadResourceReference>;
  persistOutputText(
    itemId: string,
    text: string,
    mimeType: ThreadItemOutputReference['mimeType'],
    summary: string,
  ): Promise<ThreadItemOutputReference>;
  persistContextEvidence(
    payload: Extract<ThreadContextPayload, { readonly kind: ContextEvidenceKind }>,
    summary: string,
  ): Promise<ContextEvidenceThreadItem>;
  persistSkillCatalog(
    snapshot: SkillCatalogContextPayload,
  ): Promise<ContextEvidenceThreadItem | null>;
  compactContext(
    trigger: Extract<ContextCompactionThreadItem['trigger'], 'automaticPreflight' | 'providerOverflow'>,
    preserveFrom?: ContextCursor,
  ): Promise<ContextCompactionThreadItem | null>;
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
