import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type { AgentStartupContextSnapshot } from '../context/AgentStartupContext';
import type {
  Thread,
  JsonValue,
  ContextCursor,
  ThreadContextPayload,
  ContextEvidenceThreadItem,
  ContextCompactionThreadItem,
  ContextEvidenceKind,
  ThreadContextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  ThreadImageArtifactReference,
  ThreadResourceReference,
  ThreadUserContent,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
  TurnExecutionDetails,
  TurnError,
  TurnStatus,
  SkillCatalogContextPayload,
} from '../../../core/agent/protocol';
import type { ItemRecorder } from './ItemRecorder';
import type { TokenBudgetUsage } from './kernel/types';

export interface ImagePixelDimensions {
  readonly width: number;
  readonly height: number;
}

export interface PreparedOutputImageObservation {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sourceDimensions: ImagePixelDimensions;
  readonly observationDimensions: ImagePixelDimensions;
}

export type OutputImageObservationNormalizer = (input: {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly signal?: AbortSignal;
}) => Promise<PreparedOutputImageObservation>;

export interface PersistedOutputImageObservation {
  readonly observation: ThreadResourceReference;
  readonly observationBytes: Uint8Array;
  readonly sourceDimensions: ImagePixelDimensions;
  readonly observationDimensions: ImagePixelDimensions;
}

export interface SteeredTurnInput {
  readonly items: readonly ThreadItem[];
  readonly acceptedAt: number;
}

export interface StagedContextCompaction {
  readonly item: ContextCompactionThreadItem;
  commit(): Promise<ContextCompactionThreadItem>;
  discard(): Promise<void>;
}

export interface TurnExecutionContext {
  readonly thread: Thread;
  readonly turn: Turn;
  /** Immutable repository/session inputs for a child's first generation only. */
  readonly startupContext?: AgentStartupContextSnapshot | null;
  readonly historyBeforeTurn: readonly Turn[];
  readonly configuration: EffectiveThreadConfiguration;
  readonly signal: AbortSignal;
  readonly recorder: ItemRecorder;
  readContext(ref: ThreadContextPayloadReference): Promise<ThreadContextPayload | null>;
  readOutput(ref: ThreadItemOutputReference): Promise<string | null>;
  resolveResourceObservationPath(ref: ThreadResourceReference): Promise<string | null>;
  resolveImageArtifactPath(artifact: ThreadImageArtifactReference): Promise<string | null>;
  readResource(ref: ThreadResourceReference): Promise<Buffer | null>;
  persistOutputImage(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<PersistedOutputImageObservation>;
  persistOutputResource(
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<ThreadResourceReference>;
  persistOutputText(
    itemId: string,
    text: string,
    mimeType: ThreadItemOutputReference['mimeType'],
    summary: string,
  ): Promise<ThreadItemOutputReference>;
  persistToolCallArguments(value: JsonValue): Promise<ThreadContextPayloadReference>;
  persistContextEvidence(
    payload: Extract<ThreadContextPayload, { readonly kind: ContextEvidenceKind }>,
    summary: string,
  ): Promise<ContextEvidenceThreadItem>;
  persistTurnDiagnostics(
    payload: TurnDiagnosticsPayload,
  ): Promise<TurnDiagnosticsPayloadReference>;
  onTurnDiagnosticsError(error: unknown): void;
  persistSkillCatalog(
    snapshot: SkillCatalogContextPayload,
  ): Promise<ContextEvidenceThreadItem | null>;
  compactContext(
    trigger: Extract<ContextCompactionThreadItem['trigger'], 'automaticPreflight' | 'providerOverflow'>,
    preserveFrom?: ContextCursor,
  ): Promise<ContextCompactionThreadItem | null>;
  stageContextCompaction(
    trigger: Extract<ContextCompactionThreadItem['trigger'], 'automaticPreflight' | 'providerOverflow'>,
    preserveFrom?: ContextCursor,
  ): Promise<StagedContextCompaction | null>;
  onProviderRetry(status: import('../../../core/agent/protocol').ProviderRetryStatus | null): void;
  readonly onProviderAttempt?: () => void | Promise<void>;
  readonly carryForwardSidecar?: {
    readonly itemId: string;
    isDetached(): boolean;
    detachForOverflow(): Promise<{ readonly providerAttemptSerial: number } | null>;
    canRetryAfterDetach(providerAttemptSerial: number): boolean;
  };
  onSteer(handler: (input: SteeredTurnInput) => void | Promise<void>): void;
  readonly onModelCallUsage?: (tokens: number) => void;
  readonly remainingTokenBudget?: () => TokenBudgetUsage | null;
  readonly onBudgetWarning?: (actuals: TokenBudgetUsage) => Promise<void>;
}

export interface TurnExecutionResult {
  readonly status?: Exclude<TurnStatus, 'inProgress'>;
  readonly error?: TurnError | null;
  readonly execution?: TurnExecutionDetails;
  readonly refreshDiagnostics?: () => Promise<TurnDiagnosticsPayloadReference | null>;
  readonly failureOrigin?: 'providerFailure' | 'contextFailure' | 'hostFailure';
}

export interface TurnExecutor {
  execute(context: TurnExecutionContext): Promise<TurnExecutionResult>;
  /** Read-only admission probe used before optional carry-forward is attached. */
  planInputCapacity?(context: TurnExecutionContext): Promise<{
    readonly remainingInputTokens: number;
  }>;
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
