import type {
  CreateGoalInput,
  CreateGoalResponse,
  GetGoalInput,
  GetGoalResponse,
  ThreadGoalNotification,
  UpdateGoalInput,
  UpdateGoalResponse,
} from './goal';
import type { ReasoningEffort } from './configuration';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const MAX_INLINE_MODEL_TOOL_ARGUMENT_BYTES = 32 * 1024;
export const MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES = 32 * 1024;
export const MAX_MODEL_TOOL_PROVIDER_NAME_BYTES = 1024;
export const MAX_MODEL_TOOL_CORRECTION_BYTES = 4 * 1024;

export interface ModelToolIdentity {
  readonly namespace: string | null;
  readonly name: string;
}

export const MODEL_TOOL_CALL_EVIDENCE_REASONS = Object.freeze([
  'unresolvedTool',
  'invalidArguments',
  'truncatedArguments',
  'argumentPersistenceUnavailable',
  'schemaIncompatible',
  'argumentPayloadUnavailable',
  'resultPayloadUnavailable',
] as const);
export type ModelToolCallEvidenceReason = typeof MODEL_TOOL_CALL_EVIDENCE_REASONS[number];

export type ModelToolCallArguments =
  | { readonly storage: 'inline'; readonly value: JsonValue }
  | { readonly storage: 'payload'; readonly ref: ThreadContextPayloadReference };

export type ModelToolCallHistory =
  | {
      readonly disposition: 'replayable';
      readonly identity: ModelToolIdentity;
      readonly providerName: string;
      readonly arguments: ModelToolCallArguments;
      readonly schemaDigest: string;
    }
  | {
      readonly disposition: 'redactedReplay';
      readonly identity: ModelToolIdentity;
      readonly providerName: string;
      readonly redactedArguments: ModelToolCallArguments;
      readonly redactedPaths: readonly string[];
      readonly schemaDigest: string;
    }
  | {
      readonly disposition: 'evidenceOnly';
      readonly identity: ModelToolIdentity | null;
      readonly providerName: string;
      readonly redactedArgumentsSummary: JsonValue;
      readonly reason: ModelToolCallEvidenceReason;
      readonly correction: string;
    };

export type ThreadId = string;
export type TurnId = string;
export type ThreadItemId = string;

export const THREAD_HISTORY_MODE = 'paginated' as const;
export type ThreadHistoryMode = typeof THREAD_HISTORY_MODE;

export const RESERVED_THREAD_SOURCES = ['user', 'subagent', 'memory_consolidation'] as const;
export type ReservedThreadSource = typeof RESERVED_THREAD_SOURCES[number];

declare const threadFeatureSourceBrand: unique symbol;
export type ThreadFeatureSource = string & { readonly [threadFeatureSourceBrand]: 'ThreadFeatureSource' };
export type ThreadSource = ReservedThreadSource | ThreadFeatureSource;

export function threadFeatureSource(value: string): ThreadFeatureSource {
  if (!value || value !== value.trim() || value.startsWith('feature:') || isReservedThreadSource(value)) {
    throw new Error(`Invalid Thread feature source: ${value}`);
  }
  return value as ThreadFeatureSource;
}

export function isReservedThreadSource(value: string): value is ReservedThreadSource {
  return (RESERVED_THREAD_SOURCES as readonly string[]).includes(value);
}

export function classifyThreadSource(source: ThreadSource):
  | { readonly kind: ReservedThreadSource }
  | { readonly kind: 'feature'; readonly feature: ThreadFeatureSource } {
  return isReservedThreadSource(source)
    ? { kind: source }
    : { kind: 'feature', feature: source };
}

export type ThreadActiveFlag = 'waitingOnUserInput';
export type ThreadStatus =
  | { readonly type: 'notLoaded' }
  | { readonly type: 'idle' }
  | { readonly type: 'systemError'; readonly message?: string }
  | { readonly type: 'active'; readonly activeFlags: readonly ThreadActiveFlag[] };

export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed';
export type TurnItemsView = 'notLoaded' | 'summary' | 'full';

export const RUNTIME_FAILURE_ERROR_CODE = 'runtime_failure';
export const HOST_RESTART_ERROR_CODE = 'host_restart';
export const SUBAGENT_BUDGET_EXHAUSTED_ERROR_CODE = 'subagent_budget_exhausted';
export const SUBAGENT_STRUCTURAL_LIMIT_ERROR_CODE = 'subagent_structural_limit';
export const SUBAGENT_DELIVERY_ADMISSION_ERROR_CODE = 'subagent_delivery_admission_failed';
export const TURN_ERROR_CODES = [
  RUNTIME_FAILURE_ERROR_CODE,
  HOST_RESTART_ERROR_CODE,
  SUBAGENT_BUDGET_EXHAUSTED_ERROR_CODE,
  SUBAGENT_STRUCTURAL_LIMIT_ERROR_CODE,
  SUBAGENT_DELIVERY_ADMISSION_ERROR_CODE,
] as const;
export type TurnErrorCode = typeof TURN_ERROR_CODES[number];

export function isTurnErrorCode(value: unknown): value is TurnErrorCode {
  return typeof value === 'string' && (TURN_ERROR_CODES as readonly string[]).includes(value);
}

export function normalizeTurnErrorCode(value: unknown): TurnErrorCode {
  return isTurnErrorCode(value) ? value : RUNTIME_FAILURE_ERROR_CODE;
}

export type TurnTrigger =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'subagent';
      readonly parentThreadId: ThreadId;
      readonly parentItemId: ThreadItemId;
    }
  | {
      readonly kind: 'feature';
      readonly feature: string;
      readonly ref?: string;
    };

export interface TurnProvenance {
  readonly originThreadId: ThreadId;
  readonly originTurnId: TurnId;
  readonly trigger: TurnTrigger;
}

/** Host-only coordination identity persisted on the admission commit event. */
export interface SubagentTurnAdmission {
  readonly kind: 'exhaustedSettlement' | 'explicitAdmission';
  readonly batchId: string;
  readonly envelopeDigest: string;
}

export interface ItemProvenance {
  readonly originThreadId: ThreadId;
  readonly originTurnId: TurnId;
  readonly originItemId: ThreadItemId;
}

export interface Thread {
  readonly id: ThreadId;
  readonly sessionId: string;
  readonly parentThreadId: ThreadId | null;
  readonly forkedFromId: ThreadId | null;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
  readonly name: string | null;
  readonly preview: string;
  readonly ephemeral: boolean;
  readonly source: string;
  readonly threadSource: ThreadSource;
  readonly modelProvider: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: ThreadStatus;
  readonly historyMode: ThreadHistoryMode;
  readonly turns?: readonly Turn[];
}

/** Renderer-visible execution choices. Capability ceilings remain host-private. */
export interface ThreadConfigurationSummary {
  readonly modelProvider: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
}

export interface ThreadConfigurationSetRequest extends ThreadConfigurationSummary {
  readonly threadId: ThreadId;
}

export interface ThreadConfigurationResponse {
  readonly thread: Thread;
  readonly configuration: ThreadConfigurationSummary;
}

export interface TurnError {
  readonly message: string;
  readonly code?: TurnErrorCode;
  readonly detail?: string;
}

export interface TurnTokenCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly currency: 'USD';
}

export interface TurnTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: TurnTokenCost | null;
}

export interface TurnExecutionDetails {
  readonly modelProvider: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly usage: TurnTokenUsage;
  readonly diagnosticsRef: TurnDiagnosticsPayloadReference | null;
}

export interface TurnDiagnosticsPayloadReference {
  /** Content-addressed lowercase SHA-256 digest. */
  readonly id: string;
  readonly mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json';
  readonly byteLength: number;
  readonly schemaVersion: 1;
}

export interface TurnDiagnosticsStablePromptBlock {
  readonly id: string;
  readonly layer: 'L0' | 'L1' | 'L2';
  readonly text: string;
  readonly fingerprint: string;
}

export interface TurnDiagnosticsStablePrompt {
  readonly blocks: readonly TurnDiagnosticsStablePromptBlock[];
  readonly fingerprints: {
    readonly l0: string;
    readonly l1: string;
    readonly l2: string;
    readonly complete: string;
  };
}

export interface TurnDiagnosticsConfiguration {
  readonly profileName: string | null;
  readonly developerInstructions: readonly string[];
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly plugins: readonly string[];
  readonly mcpServers: readonly string[];
}

export interface TurnDiagnosticsToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
}

export interface TurnDiagnosticsRuntime {
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly configuredBaseUrl: string;
  readonly transportSelection: 'sse' | 'websocket' | 'websocket-cached' | 'auto';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly thinkingLevel: string;
  readonly timeoutMs: number | null;
  readonly maxRetries: number | null;
  readonly maxRetryDelayMs: number | null;
  readonly cacheRetention: 'none' | 'short' | 'long';
  readonly toolExecution: 'parallel';
  readonly steeringMode: 'all';
}

export interface TurnDiagnosticsMessage {
  readonly id: string;
  readonly estimatedTokens: number;
  readonly value: JsonValue;
}

export interface TurnDiagnosticsRequestFragment {
  /** Content-addressed lowercase SHA-256 digest of `value`. */
  readonly id: string;
  readonly value: JsonValue;
}

export type TurnDiagnosticsProviderRequestField =
  | {
      readonly name: string;
      readonly representation: 'inline';
      readonly value: JsonValue;
    }
  | {
      readonly name: string;
      readonly representation: 'fragments';
      readonly container: 'array' | 'value';
      readonly fragmentIds: readonly string[];
      /** Typed canonical origins for each fragment's ordered content parts, when mapping is exact. */
      readonly fragmentPartProvenance: readonly (
        readonly TurnDiagnosticsMessagePartProvenance[] | null
      )[];
    };

export type TurnDiagnosticsProviderRequest =
  | {
      readonly kind: 'object';
      /** Preserves the post-adapter payload's top-level insertion order. */
      readonly fields: readonly TurnDiagnosticsProviderRequestField[];
    }
  | {
      readonly kind: 'value';
      readonly value: JsonValue;
    };

export interface TurnDiagnosticsPreparedContext {
  /** Content-addressed exact system prompt supplied to the provider adapter. */
  readonly systemPromptFragmentId: string;
  /** Canonical tool schemas supplied to the provider adapter, in runtime order. */
  readonly toolNames: readonly string[];
  /** Canonical messages supplied to the provider adapter, in model-context order. */
  readonly messageIds: readonly string[];
  /** Typed source for every content part of every canonical message, in the same order. */
  readonly messagePartProvenance: readonly (readonly TurnDiagnosticsMessagePartProvenance[])[];
}

export type TurnDiagnosticsMessagePartProvenance =
  | {
      readonly source: 'systemContext';
      readonly entries: readonly TurnDiagnosticsSystemContextEntry[];
    }
  | {
      readonly source: 'userInput' | 'assistantHistory' | 'toolResult' | 'unknown';
    };

export interface TurnDiagnosticsSystemContextEntry {
  readonly kind: ContextPayloadKind;
  readonly authority: ContextAuthority;
  readonly purpose: ContextPurpose;
}

export interface TurnDiagnosticsProviderUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h: number | null;
  readonly reasoning: number | null;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

export interface TurnDiagnosticsProviderResponse {
  readonly receivedAt: number;
  readonly stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  readonly errorMessage: string | null;
  readonly usage: TurnDiagnosticsProviderUsage;
  /** Provider-neutral assistant message emitted by the model runtime. */
  readonly value: JsonValue;
}

export interface TurnDiagnosticsTransportResponse {
  readonly headersReceivedAt: number;
  readonly httpStatus: number;
  readonly requestId: string | null;
}

export const MAX_TURN_DIAGNOSTICS_STREAM_NOISE_FRAMES = 64;

export interface TurnDiagnosticsStreamNoiseFrame {
  readonly arrivedAt: number;
  readonly frameType: string | null;
  readonly snippet: string;
}

export interface TurnDiagnosticsProviderCall {
  readonly index: number;
  readonly requestedAt: number;
  readonly preparedContext: TurnDiagnosticsPreparedContext;
  readonly protectedFromMessageIndex: number;
  readonly estimatedInputTokens: number;
  readonly inputTokenLimit: number;
  readonly reservedOutputTokens: number;
  readonly commonPrefixMessageCount: number;
  /** Reconstructable, image-sanitized request captured at the post-adapter send boundary. */
  readonly request: TurnDiagnosticsProviderRequest;
  readonly requestFingerprint: string;
  readonly cacheBreakpoints: readonly string[];
  readonly streamNoiseFrames?: readonly TurnDiagnosticsStreamNoiseFrame[];
  readonly transportResponse: TurnDiagnosticsTransportResponse | null;
  readonly response: TurnDiagnosticsProviderResponse | null;
}

export interface TurnDiagnosticsAcceptedInputActivity {
  readonly type: 'acceptedInput';
  readonly source: 'initial' | 'steering';
  readonly acceptedAt: number;
  readonly itemIds: readonly ThreadItemId[];
  /** The provider call whose prepared context first consumed this input, when observed. */
  readonly consumedByCallIndex: number | null;
}

export interface TurnDiagnosticsModelCallActivity {
  readonly type: 'modelCall';
  readonly callIndex: number;
}

export interface TurnDiagnosticsToolExecution {
  readonly callId: string;
  readonly toolName: string;
  /** Null only for deliberately transient tools that have no canonical Thread Item. */
  readonly itemId: ThreadItemId | null;
  readonly admissionDisposition: ModelToolCallHistory['disposition'];
  readonly canonicalIdentity: ModelToolIdentity | null;
  readonly schemaDigest: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly status: ItemExecutionStatus;
}

export interface TurnDiagnosticsToolExecutionBatchActivity {
  readonly type: 'toolExecutionBatch';
  readonly sourceCallIndex: number;
  readonly consumedByCallIndex: number | null;
  readonly executions: readonly TurnDiagnosticsToolExecution[];
}

export interface TurnDiagnosticsProviderRetryActivity {
  readonly type: 'providerRetry';
  readonly retryKind: 'request' | 'stream';
  readonly attempt: number;
  readonly maxRetries: number;
  readonly occurredAt: number;
  readonly sourceCallIndex: number;
  readonly nextCallIndex: number | null;
}

export interface TurnDiagnosticsContextCompactionActivity {
  readonly type: 'contextCompaction';
  readonly trigger: 'automaticPreflight' | 'providerOverflow';
  readonly itemId: ThreadItemId;
  readonly completedAt: number;
  /** Null when compaction happens before the first provider call. */
  readonly sourceCallIndex: number | null;
  readonly nextCallIndex: number | null;
}

export type TurnDiagnosticsActivity =
  | TurnDiagnosticsAcceptedInputActivity
  | TurnDiagnosticsModelCallActivity
  | TurnDiagnosticsToolExecutionBatchActivity
  | TurnDiagnosticsProviderRetryActivity
  | TurnDiagnosticsContextCompactionActivity;

/** Immutable provider-boundary facts for one canonical Turn. */
export interface TurnDiagnosticsPayload {
  readonly schemaVersion: 1;
  readonly contextEpochId: string;
  readonly cacheAffinity: string;
  readonly configuration: TurnDiagnosticsConfiguration;
  readonly stablePrompt: TurnDiagnosticsStablePrompt | null;
  readonly toolSchemas: readonly TurnDiagnosticsToolSchema[];
  readonly runtime: TurnDiagnosticsRuntime;
  readonly canonicalMessages: readonly TurnDiagnosticsMessage[];
  readonly requestFragments: readonly TurnDiagnosticsRequestFragment[];
  readonly providerCalls: readonly TurnDiagnosticsProviderCall[];
  /** Ordered runtime activity facts. The renderer must not reconstruct this sequence. */
  readonly activities: readonly TurnDiagnosticsActivity[];
}

export type TurnPlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface TurnPlanStep {
  readonly step: string;
  readonly status: TurnPlanStepStatus;
}

export interface TurnPlanSnapshot {
  readonly explanation?: string;
  readonly plan: readonly TurnPlanStep[];
}

export interface Turn {
  readonly id: TurnId;
  readonly items: readonly ThreadItem[];
  readonly itemsView: TurnItemsView;
  readonly provenance: TurnProvenance;
  readonly status: TurnStatus;
  readonly error: TurnError | null;
  readonly execution: TurnExecutionDetails;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
}

export interface ThreadTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface ThreadResourceReference {
  /** Content-addressed lowercase SHA-256 digest. */
  readonly id: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly fileName: string;
}

export type ThreadFileSource =
  | { readonly kind: 'localFile'; readonly path: string }
  | { readonly kind: 'threadPayload'; readonly ref: ThreadResourceReference };

export const IMAGE_ARTIFACT_RETENTIONS = [
  'external',
  'durable',
  'tiered',
  'observationOnly',
] as const;

export type ImageArtifactRetention = typeof IMAGE_ARTIFACT_RETENTIONS[number];

export interface ImageArtifactGeometry {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly observationWidth: number;
  readonly observationHeight: number;
  /** Row-major 2D affine matrix mapping observation pixels to source pixels. */
  readonly observationToSource: readonly [number, number, number, number, number, number];
}

/** Immutable logical image identity. Rendition availability may change independently. */
export interface ThreadImageArtifactReference {
  /** Lowercase SHA-256 digest of the immutable artifact fields. */
  readonly id: string;
  readonly createdAt: number;
  readonly retention: ImageArtifactRetention;
  readonly original: ThreadFileSource | null;
  readonly observation: ThreadResourceReference;
  readonly geometry: ImageArtifactGeometry;
}

export interface ThreadAttachmentContent {
  readonly type: 'attachment';
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source: ThreadFileSource;
  readonly artifactRef?: ThreadImageArtifactReference;
  readonly extractedText?: string;
}

export interface ThreadNodeReferenceContent {
  readonly type: 'nodeReference';
  readonly nodeId: string;
  readonly note?: string;
}

export type ThreadUserContent = ThreadTextContent | ThreadAttachmentContent | ThreadNodeReferenceContent;

export interface RendererUserViewVisibleNodeHint {
  readonly nodeId: string;
  readonly depth: number;
  readonly expanded: boolean;
}

export interface RendererUserViewPanelHint {
  readonly panelId: string;
  readonly rootNodeId: string;
  readonly order: number;
  readonly active: boolean;
  readonly focused: boolean;
  readonly visibleNodes: readonly RendererUserViewVisibleNodeHint[];
  readonly visibleOutlineTruncated: boolean;
}

/** Renderer-authored structure only. Main resolves all Node content and identity. */
export interface RendererUserViewHints {
  readonly activePanelId: string | null;
  readonly focusedPanelId: string | null;
  readonly focusSurface: string | null;
  readonly focusedNodeId: string | null;
  readonly selectedNodeIds: readonly string[];
  readonly panels: readonly RendererUserViewPanelHint[];
  readonly truncated: boolean;
}

export interface MemoryCitationEntry {
  readonly nodeId: string;
  readonly note: string;
}

export interface MemoryCitation {
  readonly entries: readonly MemoryCitationEntry[];
  readonly threadIds: readonly ThreadId[];
}

export type MessagePhase = 'commentary' | 'final_answer' | 'interrupted';
export type ItemExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';

interface ThreadItemBase {
  readonly id: ThreadItemId;
  readonly provenance: ItemProvenance;
}

export interface ThreadItemOutputReference {
  /** Content-addressed lowercase SHA-256 digest. */
  readonly id: string;
  readonly mimeType: 'text/plain' | 'application/json';
  readonly byteLength: number;
  readonly summary: string;
}

export const MAX_THREAD_CONTEXT_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface ThreadContextPayloadReference {
  /** Content-addressed lowercase SHA-256 digest. */
  readonly id: string;
  readonly mimeType: 'application/vnd.tenon.agent-context+json';
  readonly byteLength: number;
  readonly schemaVersion: 1;
  readonly kind: ContextPayloadKind;
}

export interface ContextCursor {
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
}

export const CONTEXT_EVIDENCE_KINDS = Object.freeze([
  'turnEnvironment',
  'userView',
  'additionalContext',
  'referencedResources',
  'skillCatalog',
  'skillInvocation',
  'roleCatalog',
  'toolOutputProjection',
  'inheritedContext',
] as const);
export type ContextEvidenceKind = typeof CONTEXT_EVIDENCE_KINDS[number];

export type ContextAuthority = 'application' | 'untrusted';
export type ContextPurpose = 'instruction' | 'observation';

export interface ContextTextEntry {
  readonly key: string;
  readonly source: string;
  readonly authority: ContextAuthority;
  readonly purpose: ContextPurpose;
  readonly text: string;
}

export interface TurnEnvironmentContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'turnEnvironment';
  readonly acceptedAt: number;
  readonly utcInstant: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly utcOffsetMinutes: number;
  readonly locale: string;
  readonly workingDirectory: string;
  readonly conversationMode: 'interactive' | 'headless';
  readonly executionMode: 'root' | 'child' | 'automation' | 'memory' | 'feature';
  readonly replyIdentity: string | null;
  readonly todayNodeId: string | null;
  readonly todayNodeTitle: string | null;
}

export interface UserViewNodeSnapshot {
  readonly nodeId: string;
  readonly title: string;
  readonly panelId: string | null;
  readonly surface: string | null;
}

export interface UserViewOutlineNodeSnapshot {
  readonly nodeId: string;
  readonly title: string;
  readonly depth: number;
  readonly focused: boolean;
  readonly collapsed: boolean;
  readonly childCount: number;
  readonly includedChildCount: number | null;
}

export interface UserViewPanelSnapshot {
  readonly panelId: string;
  readonly rootNodeId: string;
  readonly rootTitle: string;
  readonly rootType: string;
  readonly active: boolean;
  readonly focused: boolean;
  readonly order: number;
  readonly childCount: number;
  readonly breadcrumb: readonly UserViewNodeSnapshot[];
  readonly visibleOutline: readonly UserViewOutlineNodeSnapshot[];
  readonly visibleOutlineTruncated: boolean;
}

export interface UserViewContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'userView';
  readonly mode: 'interactive' | 'nonInteractive';
  readonly activePanelId: string | null;
  readonly focusedPanelId: string | null;
  readonly focusSurface: string | null;
  readonly focusedNode: UserViewNodeSnapshot | null;
  readonly selectedNodes: readonly UserViewNodeSnapshot[];
  readonly referencedNodes: readonly UserViewNodeSnapshot[];
  readonly panels: readonly UserViewPanelSnapshot[];
  readonly truncated: boolean;
}

export type AdditionalContextPayloadEntry = ContextTextEntry;

export interface AdditionalContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'additionalContext';
  /** Events that apply only to the admitted user input and must not be deduplicated. */
  readonly turnEntries: readonly AdditionalContextPayloadEntry[];
  /** Complete current Thread state, or null when Thread state was not evaluated. */
  readonly threadState: readonly AdditionalContextPayloadEntry[] | null;
}

export type ReferencedResourceUnavailableReason =
  | 'missing'
  | 'corrupt'
  | 'unsupported'
  | 'quotaExceeded';

export interface ReferencedResourceSnapshot {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly title: string;
  readonly breadcrumb: readonly UserViewNodeSnapshot[];
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly resourceRef: ThreadResourceReference | null;
  readonly inlineImage: boolean;
  readonly unavailableReason: ReferencedResourceUnavailableReason | null;
}

export interface ReferencedResourcesContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'referencedResources';
  readonly resources: readonly ReferencedResourceSnapshot[];
}

export type ContextCatalogChange = 'available' | 'added' | 'changed' | 'removed';
export type ContextCatalogMode = 'baseline' | 'delta';

export interface SkillCatalogEntry {
  readonly change: ContextCatalogChange;
  readonly name: string;
  readonly displayName: string;
  readonly source: 'built-in' | 'managed' | 'user' | 'project';
  readonly identity: string;
  readonly contentHash: string;
  readonly description: string;
}

export interface SkillCatalogContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'skillCatalog';
  readonly mode: ContextCatalogMode;
  readonly previousCatalogHash: string | null;
  readonly catalogHash: string;
  readonly entries: readonly SkillCatalogEntry[];
}

export interface SkillInvocationConstraints {
  readonly allowedTools: readonly string[];
  readonly model: string | null;
  readonly effort: string | null;
}

export interface SkillInvocationContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'skillInvocation';
  readonly name: string;
  readonly displayName: string;
  readonly source: 'built-in' | 'managed' | 'user' | 'project';
  readonly identity: string;
  readonly resourceRoot: string | null;
  readonly contentHash: string;
  readonly instructions: string;
  readonly arguments: string;
  readonly execution: 'inline' | 'isolated';
  readonly invocationSource: 'user' | 'model' | 'runtime';
  readonly constraints: SkillInvocationConstraints;
  readonly invokedAt: number;
}

export interface RoleCatalogEntry {
  readonly change: ContextCatalogChange;
  readonly name: string;
  readonly displayName: string;
  readonly source: 'built-in' | 'user' | 'project';
  readonly identity: string;
  readonly contentHash: string;
  readonly description: string;
}

export interface RoleCatalogContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'roleCatalog';
  readonly mode: ContextCatalogMode;
  readonly previousCatalogHash: string | null;
  readonly catalogHash: string;
  readonly entries: readonly RoleCatalogEntry[];
}

export type ToolOutputProjection =
  | { readonly type: 'full' }
  | { readonly type: 'inline'; readonly text: string }
  | { readonly type: 'observation'; readonly text: string };

export interface ToolOutputProjectionContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'toolOutputProjection';
  readonly outputRef: ThreadItemOutputReference;
  readonly projection: ToolOutputProjection;
}

export interface InheritedContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'inheritedContext';
  readonly sourceThreadId: ThreadId;
  readonly coveredThrough: ContextCursor;
  readonly requestedTurns: 'all' | number;
  readonly turns: readonly Turn[];
}

export interface CompactionSummaryContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'compactionSummary';
  readonly source: 'deterministic';
  readonly text: string;
}

export interface ContextCatalogCheckpointEntry {
  readonly name: string;
  readonly identity: string;
  readonly contentHash: string;
}

export interface ActiveSkillCheckpointEntry extends ContextCatalogCheckpointEntry {
  readonly payloadRef: ThreadContextPayloadReference;
}

export interface ActiveObservationCheckpointEntry {
  readonly key: string;
  readonly tool: string;
  readonly subject: string;
  readonly outputRef: ThreadItemOutputReference;
  readonly projectionRef: ThreadContextPayloadReference;
}

export type ContextDegradationCode =
  | 'payloadUnavailable'
  | 'payloadInvalid'
  | 'journalDiscontinuity'
  | 'checkpointMismatch'
  | 'projectionConflict';

export interface ContextDegradationCheckpointEntry {
  readonly code: ContextDegradationCode;
  readonly source: string;
  readonly reference: string;
}

export interface CompactionRestoredStateContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'compactionRestoredState';
  readonly skillCatalogHash: string | null;
  readonly announcedSkills: readonly ContextCatalogCheckpointEntry[];
  readonly activeSkills: readonly ActiveSkillCheckpointEntry[];
  readonly roleCatalogHash: string | null;
  readonly announcedRoles: readonly ContextCatalogCheckpointEntry[];
  readonly userViewBaselineRef: ThreadContextPayloadReference | null;
  readonly additionalContextBaselineRef: ThreadContextPayloadReference | null;
  readonly activeObservations: readonly ActiveObservationCheckpointEntry[];
  readonly degradations: readonly ContextDegradationCheckpointEntry[];
}

export interface CompactionInstructionsContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'compactionInstructions';
  readonly entries: readonly ContextTextEntry[];
}

export interface ToolCallArgumentsContextPayload {
  readonly schemaVersion: 1;
  readonly kind: 'toolCallArguments';
  readonly value: JsonValue;
}

export type ThreadContextPayload =
  | TurnEnvironmentContextPayload
  | UserViewContextPayload
  | AdditionalContextPayload
  | ReferencedResourcesContextPayload
  | SkillCatalogContextPayload
  | SkillInvocationContextPayload
  | RoleCatalogContextPayload
  | ToolOutputProjectionContextPayload
  | InheritedContextPayload
  | CompactionSummaryContextPayload
  | CompactionRestoredStateContextPayload
  | CompactionInstructionsContextPayload
  | ToolCallArgumentsContextPayload;

export type ContextPayloadKind = ThreadContextPayload['kind'];

export const CONTEXT_PAYLOAD_KINDS = Object.freeze([
  ...CONTEXT_EVIDENCE_KINDS,
  'compactionSummary',
  'compactionRestoredState',
  'compactionInstructions',
  'toolCallArguments',
] as const satisfies readonly ContextPayloadKind[]);

type MissingContextPayloadKind = Exclude<ContextPayloadKind, typeof CONTEXT_PAYLOAD_KINDS[number]>;
const CONTEXT_PAYLOAD_KINDS_ARE_EXHAUSTIVE: MissingContextPayloadKind extends never ? true : never = true;
void CONTEXT_PAYLOAD_KINDS_ARE_EXHAUSTIVE;

interface ThreadToolItemBase extends ThreadItemBase {
  readonly status: ItemExecutionStatus;
  readonly outputRef: ThreadItemOutputReference | null;
  readonly modelCall: ModelToolCallHistory;
}

export interface UserMessageThreadItem extends ThreadItemBase {
  readonly type: 'userMessage';
  readonly clientId: string | null;
  readonly content: readonly ThreadUserContent[];
  readonly acceptedAt: number;
}

export interface AgentMessageThreadItem extends ThreadItemBase {
  readonly type: 'agentMessage';
  readonly text: string;
  readonly phase: MessagePhase | null;
  readonly memoryCitation: MemoryCitation | null;
}

export interface ReasoningThreadItem extends ThreadItemBase {
  readonly type: 'reasoning';
  readonly summary: readonly string[];
  readonly content: readonly string[];
}

export interface CommandAction {
  readonly kind: string;
  readonly command: string;
  readonly path?: string;
  readonly query?: string;
}

export interface CommandExecutionThreadItem extends ThreadToolItemBase {
  readonly type: 'commandExecution';
  readonly command: string;
  /**
   * The model's own one-line account of what this command does, in active
   * voice, as requested by the `bash` tool contract. This is the honest source
   * for a readable row: the shell text alone cannot distinguish three
   * `python3 - <<'PY'` heredocs. Null when the caller omitted it.
   */
  readonly description: string | null;
  readonly cwd: string;
  readonly processId: string | null;
  readonly commandActions: readonly CommandAction[];
  readonly aggregatedOutput: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

export interface FileUpdateChange {
  readonly path: string;
  readonly kind: 'add' | 'delete' | 'update' | 'move';
  readonly diff?: string;
  readonly movedTo?: string;
}

export interface FileChangeThreadItem extends ThreadToolItemBase {
  readonly type: 'fileChange';
  readonly changes: readonly FileUpdateChange[];
}

export interface McpToolCallThreadItem extends ThreadToolItemBase {
  readonly type: 'mcpToolCall';
  readonly server: string;
  readonly tool: string;
  readonly arguments: JsonValue;
  readonly pluginId: string | null;
  readonly result: JsonValue | null;
  readonly error: string | null;
  readonly durationMs: number | null;
}

export type DynamicToolOutputContent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly artifactRef: ThreadImageArtifactReference;
      readonly alt?: string;
    }
  | { readonly type: 'json'; readonly value: JsonValue };

export interface DynamicToolCallThreadItem extends ThreadToolItemBase {
  readonly type: 'dynamicToolCall';
  readonly namespace: string | null;
  readonly tool: string;
  readonly arguments: JsonValue;
  readonly contentItems: readonly DynamicToolOutputContent[] | null;
  readonly success: boolean | null;
  readonly durationMs: number | null;
}

export type AgentTaskToolName = 'agent' | 'agent_message' | 'task_stop';

export type SubagentExecutionStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'notFound';

export interface SubagentExecutionState {
  readonly status: SubagentExecutionStatus;
  readonly taskPath: string | null;
  readonly nickname: string | null;
  readonly role: string | null;
}

export type SubagentRunMode = 'foreground' | 'background';

/** Who ended a generation, when one was ended deliberately. */
export type SubagentStopProvenance = 'none' | 'model' | 'user' | 'budget' | 'hostRestart';

/**
 * Where this generation's terminal notification stands. `none` covers both a
 * generation still running and one whose form never notifies (foreground), so
 * the renderer reads liveness from the child's own Turn rather than from here.
 */
export type SubagentNotificationState = 'none' | 'pending' | 'delivering' | 'delivered';

/** How one delegated generation ended, as the host recorded it. */
export type SubagentTerminalStatus = 'finished' | 'failed' | 'interrupted' | 'killed';

export type SubagentExecutionMode = 'ordinary' | 'exhaustedSettlement';
export type SubagentNotificationCutoff = 'open' | 'closing' | 'closed';
export type SubagentDeliveryClass = 'ordinary' | 'carryForward';
export type SubagentCoverageDisposition = 'full' | 'excerpted' | 'omitted';

export interface SubagentTerminalError {
  readonly code: string;
  readonly messagePreview: string;
  readonly omittedBytes: number;
}

export interface SubagentSettlementCoverage {
  readonly origin: 'budgetInterrupted' | 'normalOvershoot' | 'explicitAdmission';
  readonly full: number;
  readonly excerpted: number;
  readonly omitted: number;
  readonly providerAttempted: boolean;
}

/** The retained managed worktree a settled generation left behind. */
export interface SubagentWorktreeSummary {
  readonly branch: string;
  readonly path: string;
}

/** One background generation whose result has reached its parent Turn. */
export interface SubagentDeliveredNotificationProjection {
  readonly generation: number;
  readonly deliveryTurnId: TurnId;
}

/**
 * The canonical Agent execution record, projected across the process seam.
 *
 * Presentation re-derives a delegated child's lifecycle from this record — one
 * entry per stable Agent ID, carrying the generation that a resume increments —
 * rather than from the wait-era Turn Items that could only describe one episode
 * inside one Turn. Only the identity, lifecycle, and placement fields cross:
 * the tool policy, startup snapshot, and recovery intent stay main-side, since
 * nothing the user reads is derived from them.
 */
export interface SubagentExecutionProjection {
  readonly agentId: ThreadId;
  readonly parentThreadId: ThreadId;
  /** The model's own one-line description of the delegated task. */
  readonly description: string;
  readonly agentType: string;
  readonly runMode: SubagentRunMode;
  readonly generation: number;
  readonly currentTurnId: TurnId;
  readonly stopProvenance: SubagentStopProvenance;
  /**
   * How this generation ended, recorded when its result was queued for the
   * parent. Durable, so a conversation reopened later states the outcome
   * without reloading every child's Turns; `null` while the generation runs,
   * and for foreground work, whose result travels back through its own call.
   */
  readonly terminalStatus: SubagentTerminalStatus | null;
  readonly notificationState: SubagentNotificationState;
  readonly terminalError: SubagentTerminalError | null;
  /** First committed delivery Turn, resolved through canonical Retry aliases. */
  readonly deliveryTurnId: TurnId | null;
  readonly deliveryClass: SubagentDeliveryClass | null;
  readonly eligibleAfterGeneration: number | null;
  readonly coverageDisposition: SubagentCoverageDisposition | null;
  readonly omittedOutputBytes: number;
  readonly omittedOutputTokens: number;
  /**
   * Delivered background generations for this stable Agent, including earlier
   * generations after a later resume advances the execution record.
   */
  readonly deliveredNotifications: readonly SubagentDeliveredNotificationProjection[];
  readonly notificationCutoff: SubagentNotificationCutoff;
  readonly executionMode: SubagentExecutionMode;
  readonly settlementCoverage: SubagentSettlementCoverage | null;
  /** Present only while a managed worktree is retained for this Agent. */
  readonly worktree: SubagentWorktreeSummary | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CollabAgentToolCallThreadItem extends ThreadToolItemBase {
  readonly type: 'collabAgentToolCall';
  readonly tool: AgentTaskToolName;
  readonly senderThreadId: ThreadId;
  readonly receiverThreadIds: readonly ThreadId[];
  readonly prompt: string | null;
  /** Normalized one-line preview for `agent_message`; null for other tools and legacy Items. */
  readonly summary: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly agentsStates: Readonly<Record<ThreadId, SubagentExecutionState>>;
}

export interface SubAgentActivityThreadItem extends ThreadItemBase {
  readonly type: 'subAgentActivity';
  readonly kind: 'started' | 'completed' | 'interrupted' | 'errored';
  readonly agentThreadId: ThreadId;
  /** Exact child Turn represented by this activity; null only for legacy Items. */
  readonly agentTurnId: TurnId | null;
  readonly agentPath: string;
  readonly error: TurnError | null;
  /**
   * The tool call that delegated this work — the `skill` call or the
   * collaboration spawn call — so one delegation renders as one row at its
   * cause's position instead of a tool row and a child row saying the same
   * thing in two vocabularies.
   *
   * Recorded on the spawn-time `started` Item only. A terminal activity is
   * `null` because it can be flushed into a LATER parent Turn, where the
   * delegating call is not among the Items and nothing may be claimed.
   */
  readonly spawnItemId: string | null;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
}

export interface WebSearchThreadItem extends ThreadToolItemBase {
  readonly type: 'webSearch';
  readonly query: string;
  readonly results: readonly WebSearchResult[];
  readonly error: string | null;
}

export interface ImageViewThreadItem extends ThreadItemBase {
  readonly type: 'imageView';
  readonly path: string;
}

export interface ContextEvidenceThreadItem extends ThreadItemBase {
  readonly type: 'contextEvidence';
  readonly kind: ContextEvidenceKind;
  readonly payloadRef: ThreadContextPayloadReference;
  readonly summary: string;
  readonly contextRefs: readonly ThreadContextPayloadReference[];
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly outputRefs: readonly ThreadItemOutputReference[];
}

export interface ContextResetThreadItem extends ThreadItemBase {
  readonly type: 'contextReset';
  readonly clearedThrough: ContextCursor;
}

export interface ContextCompactionThreadItem extends ThreadItemBase {
  readonly type: 'contextCompaction';
  readonly trigger: 'automaticPreflight' | 'providerOverflow' | 'manual';
  readonly coveredFrom: ContextCursor;
  readonly coveredThrough: ContextCursor;
  readonly preservedFrom: ContextCursor | null;
  readonly summaryRef: ThreadContextPayloadReference;
  readonly restoredStateRef: ThreadContextPayloadReference;
  readonly instructionsRef: ThreadContextPayloadReference | null;
  readonly contextRefs: readonly ThreadContextPayloadReference[];
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly outputRefs: readonly ThreadItemOutputReference[];
}

export type ThreadItem =
  | UserMessageThreadItem
  | AgentMessageThreadItem
  | ReasoningThreadItem
  | CommandExecutionThreadItem
  | FileChangeThreadItem
  | McpToolCallThreadItem
  | DynamicToolCallThreadItem
  | CollabAgentToolCallThreadItem
  | SubAgentActivityThreadItem
  | WebSearchThreadItem
  | ImageViewThreadItem
  | ContextEvidenceThreadItem
  | ContextResetThreadItem
  | ContextCompactionThreadItem;

export const THREAD_ITEM_TYPES = [
  'userMessage',
  'agentMessage',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'contextEvidence',
  'contextReset',
  'contextCompaction',
] as const satisfies readonly ThreadItem['type'][];

type MissingThreadItemType = Exclude<ThreadItem['type'], typeof THREAD_ITEM_TYPES[number]>;
const THREAD_ITEM_TYPES_ARE_EXHAUSTIVE: MissingThreadItemType extends never ? true : never = true;
void THREAD_ITEM_TYPES_ARE_EXHAUSTIVE;

export type AdditionalContextKind = 'untrusted' | 'application';

export interface AdditionalContextEntry {
  readonly value: string;
  readonly kind: AdditionalContextKind;
}

export type AdditionalContext = Readonly<Record<string, AdditionalContextEntry>>;

export const REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS = 60_000;
export const REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS = 240_000;

export interface ThreadPageRequest {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  readonly sortDirection?: 'asc' | 'desc' | null;
}

export interface ThreadListRequest extends ThreadPageRequest {
  readonly archived?: boolean;
  readonly threadSources?: readonly ThreadSource[];
}

export interface ThreadListResponse {
  readonly data: readonly Thread[];
  readonly nextCursor: string | null;
}

export interface ThreadDescendantsRequest {
  readonly threadId: ThreadId;
}

export interface ThreadDescendantsResponse {
  readonly data: readonly Thread[];
  /**
   * Descendants holding queued work that has not started a Turn yet. An idle
   * status is not evidence a child is finished: a queued message leaves it idle
   * until admission, and deleting it would discard work already accepted.
   */
  readonly queuedWorkThreadIds: readonly ThreadId[];
}

export interface ThreadSubagentsRequest {
  readonly threadId: ThreadId;
}

export interface ThreadSubagentsResponse {
  /**
   * Every committed Agent execution in this conversation's subtree, oldest
   * first. An admission that has not committed is absent: the host publishes no
   * start for it, and a chip for a child that may still be rolled back would be
   * a delegation the conversation never made.
   */
  readonly data: readonly SubagentExecutionProjection[];
}

export interface ThreadReadRequest {
  readonly threadId: ThreadId;
  readonly includeTurns?: boolean;
}

export interface ThreadReadResponse {
  readonly thread: Thread;
}

export interface ThreadStartRequest {
  readonly id?: ThreadId;
  readonly name?: string;
  readonly ephemeral?: boolean;
  readonly source: string;
  readonly threadSource: ThreadSource;
  readonly modelProvider: string;
  readonly cwd: string;
  readonly configurationProfile?: string;
}

export interface RendererThreadStartRequest extends Omit<
  ThreadStartRequest,
  'source' | 'threadSource' | 'modelProvider' | 'cwd'
> {
  readonly source?: 'app';
  readonly threadSource?: 'user';
  readonly modelProvider?: string;
  readonly cwd?: string;
}

export interface ThreadStartResponse {
  readonly thread: Thread;
}

export interface ThreadResumeRequest {
  readonly threadId: ThreadId;
}

export interface ThreadResumeResponse {
  readonly thread: Thread;
}

export type ThreadForkBoundary =
  | { readonly kind: 'beforeTurn'; readonly turnId: TurnId }
  | { readonly kind: 'afterTurn'; readonly turnId: TurnId };

export interface ThreadForkRequest {
  readonly threadId: ThreadId;
  readonly boundary: ThreadForkBoundary;
  readonly name?: string;
}

export interface ThreadForkResponse {
  readonly thread: Thread;
}

export interface ThreadRollbackRequest {
  readonly threadId: ThreadId;
  readonly numTurns: number;
}

export interface ThreadRollbackResponse {
  readonly thread: Thread;
}

export interface ThreadNameSetRequest {
  readonly threadId: ThreadId;
  readonly name: string | null;
}

export interface ThreadIdentityRequest {
  readonly threadId: ThreadId;
}

/** Whether this Thread is kept in the readable transcript records. */
export interface ThreadRecordsSetRequest {
  readonly threadId: ThreadId;
  readonly recorded: boolean;
}

export interface ThreadRecordsResponse {
  readonly recorded: boolean;
}

export interface ThreadTurnsListRequest extends ThreadPageRequest {
  readonly threadId: ThreadId;
  readonly itemsView?: TurnItemsView | null;
}

export interface ThreadTurnsListResponse {
  readonly data: readonly Turn[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
}

export interface ThreadItemsListRequest extends ThreadPageRequest {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | null;
}

export interface ThreadItemEntry {
  readonly turnId: TurnId;
  readonly item: ThreadItem;
}

export interface ThreadItemsListResponse {
  readonly data: readonly ThreadItemEntry[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
}

export interface ThreadItemOutputReadRequest {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
  readonly outputId: string;
}

export interface ThreadItemOutputReadResponse {
  readonly output: {
    readonly ref: ThreadItemOutputReference;
    readonly text: string;
  } | null;
}

export interface ThreadContextReadRequest {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
  readonly contextId: string;
}

export interface ThreadContextReadResponse {
  readonly context: {
    readonly ref: ThreadContextPayloadReference;
    readonly payload: ThreadContextPayload;
  } | null;
}

export interface ThreadTurnDetailsReadRequest {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export interface ThreadTurnDetailsReadResponse {
  readonly thread: Thread;
  readonly turn: Turn;
  readonly diagnostics: {
    readonly ref: TurnDiagnosticsPayloadReference;
    readonly payload: TurnDiagnosticsPayload;
  } | null;
}

export interface ProviderRetryStatus {
  readonly kind: 'request' | 'stream';
  readonly attempt: number;
  readonly maxRetries: number;
}

export const THREAD_MESSAGE_CONTEXT_MENU_ACTIONS = Object.freeze([
  'copy',
  'continueInNewChat',
  'details',
] as const);
export type ThreadMessageContextMenuAction = typeof THREAD_MESSAGE_CONTEXT_MENU_ACTIONS[number];

export const THREAD_MESSAGE_CONTEXT_MENU_CAPABILITY_FIELDS = Object.freeze([
  'canCopy',
  'canContinueInNewChat',
  'canShowDetails',
] as const);
export type ThreadMessageContextMenuRequest = Readonly<Record<
  typeof THREAD_MESSAGE_CONTEXT_MENU_CAPABILITY_FIELDS[number],
  boolean
>>;

export interface TurnInputRequest {
  readonly threadId: ThreadId;
  readonly input: readonly ThreadUserContent[];
  readonly clientUserMessageId?: string | null;
  readonly additionalContext?: AdditionalContext;
  readonly userView?: RendererUserViewHints;
}

export interface RendererTurnStartRequest extends TurnInputRequest {
  readonly additionalContext?: Readonly<Record<string, AdditionalContextEntry & { readonly kind: 'untrusted' }>>;
}

export interface RendererTurnSubmitRequest extends Omit<RendererTurnStartRequest, 'clientUserMessageId'> {
  readonly clientUserMessageId: string;
}

export interface PrivilegedTurnStartRequest extends TurnInputRequest {
  readonly turnId?: TurnId;
  readonly trigger: TurnTrigger;
}

export interface TurnStartResponse {
  readonly turn: Turn;
  readonly acceptedItemId: ThreadItemId;
  readonly deduplicated: boolean;
}

export interface TurnSteerRequest extends TurnInputRequest {
  readonly expectedTurnId: TurnId;
}

export interface RendererTurnSteerRequest extends Omit<TurnSteerRequest, 'additionalContext'> {
  readonly additionalContext?: Readonly<Record<string, AdditionalContextEntry & { readonly kind: 'untrusted' }>>;
}

export interface TurnSteerResponse {
  readonly turnId: TurnId;
  readonly acceptedItemId: ThreadItemId;
  readonly deduplicated: boolean;
}

export interface TurnSubmitResponse {
  /** Non-null only when this request admitted a new Turn. */
  readonly turn: Turn | null;
  readonly turnId: TurnId;
  readonly acceptedItemId: ThreadItemId;
  readonly deduplicated: boolean;
}

export interface TurnInterruptRequest {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export interface TurnInterruptResponse {
  readonly turnId: TurnId;
}

export interface TurnRetryRequest {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export interface TurnRetryResponse {
  readonly thread: Thread;
  readonly turn: Turn;
  readonly replacedTurnId: TurnId;
}

export interface RequestUserInputOption {
  readonly label: string;
  readonly description: string;
}

export interface RequestUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly RequestUserInputOption[];
}

export interface RequestUserInputRequest {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
  readonly questions: readonly RequestUserInputQuestion[];
  readonly autoResolutionMs?: number;
}

export interface RequestUserInputAnswer {
  readonly questionId: string;
  readonly optionLabel?: string;
  readonly otherText?: string;
}

export interface RequestUserInputResponse {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
  readonly answers: readonly RequestUserInputAnswer[];
  readonly autoResolved: boolean;
}

export type EmptyAgentCoreResponse = Readonly<Record<string, never>>;

/**
 * One identity as the reader meets it: what it is called and what it looks
 * like. Keyed by Agent TYPE — `main` for the conversation's own agent, a
 * canonical built-in type, or a Role name.
 *
 * Presentation travels its own path rather than riding on Thread or Item
 * records: it is configuration, not history. A persona renamed today must
 * rename the speaker of every message that Agent ever sent, which is only true
 * if the transcript resolves identity at render time instead of recording it.
 */
export interface AgentIdentityEntry {
  readonly agentType: string;
  readonly persona: string;
  /** An identity-palette colour name; always resolved, never empty. */
  readonly color: string;
  readonly source: 'built-in' | 'user' | 'project';
}

export interface AgentIdentityCatalogRequest {
  /**
   * Whose project layer to read. A Thread names a working directory, and a
   * project may define both Roles and re-skins; null asks for the user layer
   * alone, which is what an empty dock has.
   */
  readonly threadId: ThreadId | null;
}

export interface AgentIdentityCatalogResponse {
  readonly entries: readonly AgentIdentityEntry[];
}

export const AGENT_CORE_METHODS = [
  'thread/list',
  'thread/descendants',
  'thread/subagents/list',
  'thread/read',
  'thread/start',
  'thread/resume',
  'thread/fork',
  'thread/rollback',
  'thread/name/set',
  'thread/configuration/get',
  'thread/configuration/set',
  'thread/archive',
  'thread/unarchive',
  'thread/records/get',
  'thread/records/set',
  'thread/delete',
  'thread/turns/list',
  'thread/items/list',
  'thread/item/output/read',
  'thread/context/read',
  'thread/turn/details/read',
  'turn/submit',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'turn/retry',
  'goal/get',
  'goal/create',
  'goal/update',
  'userInput/respond',
  'identities/get',
] as const;

export type AgentCoreMethod = typeof AGENT_CORE_METHODS[number];

export interface AgentCoreRequestByMethod {
  readonly 'thread/list': ThreadListRequest;
  readonly 'thread/descendants': ThreadDescendantsRequest;
  readonly 'thread/subagents/list': ThreadSubagentsRequest;
  readonly 'thread/read': ThreadReadRequest;
  readonly 'thread/start': RendererThreadStartRequest;
  readonly 'thread/resume': ThreadResumeRequest;
  readonly 'thread/fork': ThreadForkRequest;
  readonly 'thread/rollback': ThreadRollbackRequest;
  readonly 'thread/name/set': ThreadNameSetRequest;
  readonly 'thread/configuration/get': ThreadIdentityRequest;
  readonly 'thread/configuration/set': ThreadConfigurationSetRequest;
  readonly 'thread/archive': ThreadIdentityRequest;
  readonly 'thread/unarchive': ThreadIdentityRequest;
  readonly 'thread/records/get': ThreadIdentityRequest;
  readonly 'thread/records/set': ThreadRecordsSetRequest;
  readonly 'thread/delete': ThreadIdentityRequest;
  readonly 'thread/turns/list': ThreadTurnsListRequest;
  readonly 'thread/items/list': ThreadItemsListRequest;
  readonly 'thread/item/output/read': ThreadItemOutputReadRequest;
  readonly 'thread/context/read': ThreadContextReadRequest;
  readonly 'thread/turn/details/read': ThreadTurnDetailsReadRequest;
  readonly 'turn/submit': RendererTurnSubmitRequest;
  readonly 'turn/start': RendererTurnStartRequest;
  readonly 'turn/steer': RendererTurnSteerRequest;
  readonly 'turn/interrupt': TurnInterruptRequest;
  readonly 'turn/retry': TurnRetryRequest;
  readonly 'goal/get': GetGoalInput;
  readonly 'goal/create': CreateGoalInput;
  readonly 'goal/update': UpdateGoalInput;
  readonly 'userInput/respond': RequestUserInputResponse;
  readonly 'identities/get': AgentIdentityCatalogRequest;
}

export interface AgentCoreResponseByMethod {
  readonly 'thread/list': ThreadListResponse;
  readonly 'thread/descendants': ThreadDescendantsResponse;
  readonly 'thread/subagents/list': ThreadSubagentsResponse;
  readonly 'thread/read': ThreadReadResponse;
  readonly 'thread/start': ThreadStartResponse;
  readonly 'thread/resume': ThreadResumeResponse;
  readonly 'thread/fork': ThreadForkResponse;
  readonly 'thread/rollback': ThreadRollbackResponse;
  readonly 'thread/name/set': EmptyAgentCoreResponse;
  readonly 'thread/configuration/get': ThreadConfigurationResponse;
  readonly 'thread/configuration/set': ThreadConfigurationResponse;
  readonly 'thread/archive': EmptyAgentCoreResponse;
  readonly 'thread/unarchive': EmptyAgentCoreResponse;
  readonly 'thread/records/get': ThreadRecordsResponse;
  readonly 'thread/records/set': ThreadRecordsResponse;
  readonly 'thread/delete': EmptyAgentCoreResponse;
  readonly 'thread/turns/list': ThreadTurnsListResponse;
  readonly 'thread/items/list': ThreadItemsListResponse;
  readonly 'thread/item/output/read': ThreadItemOutputReadResponse;
  readonly 'thread/context/read': ThreadContextReadResponse;
  readonly 'thread/turn/details/read': ThreadTurnDetailsReadResponse;
  readonly 'turn/submit': TurnSubmitResponse;
  readonly 'turn/start': TurnStartResponse;
  readonly 'turn/steer': TurnSteerResponse;
  readonly 'turn/interrupt': TurnInterruptResponse;
  readonly 'turn/retry': TurnRetryResponse;
  readonly 'goal/get': GetGoalResponse;
  readonly 'goal/create': CreateGoalResponse;
  readonly 'goal/update': UpdateGoalResponse;
  readonly 'userInput/respond': EmptyAgentCoreResponse;
  readonly 'identities/get': AgentIdentityCatalogResponse;
}

export type ThreadItemDelta =
  | { readonly type: 'agentMessageText'; readonly delta: string }
  | { readonly type: 'reasoningSummary'; readonly delta: string }
  | { readonly type: 'reasoningContent'; readonly delta: string }
  | { readonly type: 'commandOutput'; readonly delta: string }
  | { readonly type: 'dynamicToolOutput'; readonly delta: DynamicToolOutputContent };

export type AgentCoreNotification =
  | { readonly type: 'thread/started'; readonly threadId: ThreadId; readonly thread: Thread }
  | {
      readonly type: 'thread/name/updated';
      readonly threadId: ThreadId;
      readonly threadName?: string;
    }
  | {
      readonly type: 'thread/status/changed';
      readonly threadId: ThreadId;
      readonly status: ThreadStatus;
    }
  | {
      readonly type: 'turn/started';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly turn: Turn;
      readonly subagentAdmission?: SubagentTurnAdmission;
    }
  | {
      readonly type: 'item/started';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly itemId: ThreadItemId;
      readonly item: ThreadItem;
      readonly startedAt: number;
    }
  | {
      readonly type: 'item/delta';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly itemId: ThreadItemId;
      readonly delta: ThreadItemDelta;
    }
  | {
      readonly type: 'item/completed';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly itemId: ThreadItemId;
      readonly item: ThreadItem;
      readonly completedAt: number;
    }
  | {
      readonly type: 'items/completed';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly items: readonly ThreadItem[];
      readonly completedAt: number;
    }
  | {
      readonly type: 'turn/completed';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly turn: Turn;
    }
  | {
      readonly type: 'turn/providerRetry/changed';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly status: ProviderRetryStatus | null;
    }
  | ({
      readonly type: 'turn/plan/updated';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
    } & TurnPlanSnapshot)
  | {
      /**
       * One Agent's execution record changed. `threadId` is the direct parent,
       * so the event is ordered with the conversation that delegated the work.
       * Derived state, never history: an Agent's canonical lifecycle already
       * lives in its own Thread, Turns, and Items.
       */
      readonly type: 'subagent/execution/changed';
      readonly threadId: ThreadId;
      readonly execution: SubagentExecutionProjection;
    }
  | {
      readonly type: 'userInput/requested';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly itemId: ThreadItemId;
      readonly request: RequestUserInputRequest;
    }
  | {
      readonly type: 'userInput/resolved';
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly itemId: ThreadItemId;
      readonly response: RequestUserInputResponse;
    }
  | ThreadGoalNotification;

export type AgentCoreTransientNotification = Extract<AgentCoreNotification, {
  readonly type:
    | 'thread/name/updated'
    | 'turn/providerRetry/changed'
    | 'turn/plan/updated'
    | 'subagent/execution/changed';
}>;

export type AgentCoreRecordedNotification = Exclude<AgentCoreNotification, AgentCoreTransientNotification>;

export interface AgentMutationCausation {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
}
