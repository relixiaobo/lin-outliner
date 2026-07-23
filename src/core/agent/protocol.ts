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
  readonly code?: string;
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

export interface ThreadAttachmentContent {
  readonly type: 'attachment';
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source:
    | { readonly kind: 'asset'; readonly assetId: string }
    | { readonly kind: 'localFile'; readonly path: string }
    | { readonly kind: 'inline'; readonly dataBase64: string };
  readonly extractedText?: string;
}

export interface ThreadNodeReferenceContent {
  readonly type: 'nodeReference';
  readonly nodeId: string;
  readonly note?: string;
}

export type ThreadUserContent = ThreadTextContent | ThreadAttachmentContent | ThreadNodeReferenceContent;

export interface MemoryCitationEntry {
  readonly nodeId: string;
  readonly note: string;
}

export interface MemoryCitation {
  readonly entries: readonly MemoryCitationEntry[];
  readonly threadIds: readonly ThreadId[];
}

export type MessagePhase = 'commentary' | 'final_answer';
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

interface ThreadToolItemBase extends ThreadItemBase {
  readonly status: ItemExecutionStatus;
  readonly outputRef: ThreadItemOutputReference | null;
}

export interface UserMessageThreadItem extends ThreadItemBase {
  readonly type: 'userMessage';
  readonly clientId: string | null;
  readonly content: readonly ThreadUserContent[];
}

export interface AgentMessageThreadItem extends ThreadItemBase {
  readonly type: 'agentMessage';
  readonly text: string;
  readonly phase: MessagePhase | null;
  readonly memoryCitation: MemoryCitation | null;
}

export interface PlanThreadItem extends ThreadItemBase {
  readonly type: 'plan';
  readonly text: string;
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
  | { readonly type: 'image'; readonly imageRef: string; readonly alt?: string }
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

export type CollaborationToolName =
  | 'spawn_agent'
  | 'send_message'
  | 'followup_task'
  | 'wait_agent'
  | 'list_agents'
  | 'interrupt_agent';

export type SubagentExecutionStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'notFound';

export interface CollabAgentToolCallThreadItem extends ThreadToolItemBase {
  readonly type: 'collabAgentToolCall';
  readonly tool: CollaborationToolName;
  readonly senderThreadId: ThreadId;
  readonly receiverThreadIds: readonly ThreadId[];
  readonly prompt: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly agentsStates: Readonly<Record<ThreadId, SubagentExecutionStatus>>;
}

export interface SubAgentActivityThreadItem extends ThreadItemBase {
  readonly type: 'subAgentActivity';
  readonly kind: 'started' | 'completed' | 'interrupted' | 'errored';
  readonly agentThreadId: ThreadId;
  readonly agentPath: string;
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

export interface ContextCompactionThreadItem extends ThreadItemBase {
  readonly type: 'contextCompaction';
}

export type ThreadItem =
  | UserMessageThreadItem
  | AgentMessageThreadItem
  | PlanThreadItem
  | ReasoningThreadItem
  | CommandExecutionThreadItem
  | FileChangeThreadItem
  | McpToolCallThreadItem
  | DynamicToolCallThreadItem
  | CollabAgentToolCallThreadItem
  | SubAgentActivityThreadItem
  | WebSearchThreadItem
  | ImageViewThreadItem
  | ContextCompactionThreadItem;

export const THREAD_ITEM_TYPES = [
  'userMessage',
  'agentMessage',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
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

export interface ProviderRetryStatus {
  readonly kind: 'request' | 'stream';
  readonly attempt: number;
  readonly maxRetries: number;
}

export type ThreadMessageContextMenuAction = 'copy' | 'retry' | 'regenerate' | 'details';

export interface ThreadMessageContextMenuRequest {
  readonly canCopy: boolean;
  readonly canRetry: boolean;
  readonly canRegenerate: boolean;
  readonly canShowDetails: boolean;
}

export interface TurnInputRequest {
  readonly threadId: ThreadId;
  readonly input: readonly ThreadUserContent[];
  readonly clientUserMessageId?: string | null;
  readonly additionalContext?: AdditionalContext;
}

export interface RendererTurnStartRequest extends TurnInputRequest {
  readonly additionalContext?: Readonly<Record<string, AdditionalContextEntry & { readonly kind: 'untrusted' }>>;
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

export interface TurnInterruptRequest {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export interface TurnInterruptResponse {
  readonly turnId: TurnId;
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

export const AGENT_CORE_METHODS = [
  'thread/list',
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
  'thread/delete',
  'thread/turns/list',
  'thread/items/list',
  'thread/item/output/read',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'goal/get',
  'goal/create',
  'goal/update',
  'userInput/respond',
] as const;

export type AgentCoreMethod = typeof AGENT_CORE_METHODS[number];

export interface AgentCoreRequestByMethod {
  readonly 'thread/list': ThreadListRequest;
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
  readonly 'thread/delete': ThreadIdentityRequest;
  readonly 'thread/turns/list': ThreadTurnsListRequest;
  readonly 'thread/items/list': ThreadItemsListRequest;
  readonly 'thread/item/output/read': ThreadItemOutputReadRequest;
  readonly 'turn/start': RendererTurnStartRequest;
  readonly 'turn/steer': RendererTurnSteerRequest;
  readonly 'turn/interrupt': TurnInterruptRequest;
  readonly 'goal/get': GetGoalInput;
  readonly 'goal/create': CreateGoalInput;
  readonly 'goal/update': UpdateGoalInput;
  readonly 'userInput/respond': RequestUserInputResponse;
}

export interface AgentCoreResponseByMethod {
  readonly 'thread/list': ThreadListResponse;
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
  readonly 'thread/delete': EmptyAgentCoreResponse;
  readonly 'thread/turns/list': ThreadTurnsListResponse;
  readonly 'thread/items/list': ThreadItemsListResponse;
  readonly 'thread/item/output/read': ThreadItemOutputReadResponse;
  readonly 'turn/start': TurnStartResponse;
  readonly 'turn/steer': TurnSteerResponse;
  readonly 'turn/interrupt': TurnInterruptResponse;
  readonly 'goal/get': GetGoalResponse;
  readonly 'goal/create': CreateGoalResponse;
  readonly 'goal/update': UpdateGoalResponse;
  readonly 'userInput/respond': EmptyAgentCoreResponse;
}

export type ThreadItemDelta =
  | { readonly type: 'agentMessageText'; readonly delta: string }
  | { readonly type: 'planText'; readonly delta: string }
  | { readonly type: 'reasoningSummary'; readonly delta: string }
  | { readonly type: 'reasoningContent'; readonly delta: string }
  | { readonly type: 'commandOutput'; readonly delta: string }
  | { readonly type: 'dynamicToolOutput'; readonly delta: DynamicToolOutputContent };

export type AgentCoreNotification =
  | { readonly type: 'thread/started'; readonly threadId: ThreadId; readonly thread: Thread }
  | {
      readonly type: 'thread/status/changed';
      readonly threadId: ThreadId;
      readonly status: ThreadStatus;
    }
  | { readonly type: 'turn/started'; readonly threadId: ThreadId; readonly turnId: TurnId; readonly turn: Turn }
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

export interface AgentMutationCausation {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
}
