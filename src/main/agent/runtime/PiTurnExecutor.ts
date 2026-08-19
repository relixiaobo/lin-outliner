import { NativeAgentRuntime } from './kernel/NativeAgentRuntime';
import {
  PiModelGateway,
  type ModelGateway,
  type PiModelGatewayOptions,
} from './kernel/ModelGateway';
import type {
  AgentEvent,
  AgentState,
  AgentTool,
  Api,
  AssistantMessage,
  Context,
  KernelAgentOptions,
  Message,
  Model,
  TextContent,
  Usage,
  UserMessage,
} from './kernel/types';
import type { AgentRuntimeSettings } from '../../../core/types';
import type {
  ContextCompactionThreadItem,
  ContextCursor,
  DynamicToolOutputContent,
  JsonValue,
  MessagePhase,
  ModelToolCallHistory,
  SkillInvocationContextPayload,
  SubagentExecutionState,
  ThreadItem,
  ThreadImageArtifactReference,
  ThreadItemOutputReference,
  Turn,
  TurnExecutionDetails,
} from '../../../core/agent/protocol';
import { INITIAL_CONTEXT_EPOCH_ID } from '../../../core/agent/cacheAffinity';
import { decodeThreadContextPayload, decodeThreadImageArtifactReference } from '../../../core/agent/codec';
import {
  CanonicalContextProjector,
  type CanonicalContextProjection,
  type LiveModelToolCall,
} from '../context/ContextProjector';
import {
  ContextCapacityError,
  ContextCompactionRequiredError,
  planContextBudget,
} from '../context/ContextBudgetPlanner';
import { freezePendingToolOutputProjections } from '../context/ToolOutputProjection';
import { cursorFor, latestContextEpochId, selectEffectiveContext } from '../context/ContextEpoch';
import { composeStablePrompt } from '../context/stablePrompt';
import { providerCacheAffinity } from '../context/ProviderCache';
import { contextPayloadReferenceKey, outputReferenceKey } from '../context/contextDependencies';
import { TurnDiagnosticsCollector } from '../context/TurnDiagnostics';
import {
  lowestThinkingLevel,
  resolveAgentModelEffort,
  resolveProviderModel,
} from '../capabilities/agentModelResolution';
import { awaitWithAbort } from '../capabilities/agentAwaitWithAbort';
import {
  getAgentRuntimeSettings,
  getProviderRuntimeConfig,
  providerStreamOptionsFromRuntimeSettings,
} from '../capabilities/agentSettings';
import {
  persistedToolResultDetails,
  persistedToolResultText,
} from '../capabilities/agentToolResultPersistence';
import { readAgentImageDimensions } from '../capabilities/agentLocalTools';
import { createImageArtifactReference, ImageObservationNormalizationError } from '../imageArtifacts';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BYTES,
  ThreadResourceQuotaError,
  measureToolPayloadImage,
} from '../persistence/ToolPayloadStore';
import {
  piExternalProviderId,
  piCompleteSimple,
  piRequestApiKeyOverride,
} from '../../piModels';
import { customOpenAIResponsesPayloadProfileOption } from '../../openAIResponsesCompat';
import type {
  ThreadNameGenerationContext,
  ThreadNameGenerator,
  TurnExecutionContext,
  TurnExecutionResult,
  TurnExecutor,
} from './types';
import { persistToolCallAdmission } from './toolCallHistory';
import { agentProviderPayload } from './agentProviderPayload';

export { agentProviderPayload } from './agentProviderPayload';

export const MAX_PERSISTED_TOOL_ARGUMENT_CHARS = 32_000;
export const MAX_PERSISTED_TOOL_OUTPUT_CHARS = 50_000;
export const MAX_PERSISTED_TOOL_OUTPUT_IMAGES = 16;
export const MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PERSISTED_TOOL_STRING_CHARS = 8_000;
const MAX_PERSISTED_WEB_RESULTS = 50;
export const MAX_THREAD_NAME_CHARS = 80;
const MAX_THREAD_NAME_INPUT_CHARS = 16_000;
const MAX_THREAD_NAME_OUTPUT_TOKENS = 64;
const THREAD_NAME_SYSTEM_PROMPT = `Generate a concise title for this conversation.
Use the same language as the user's request when practical.
Return only the title, with no quotes, Markdown, label, or explanation.
Keep it specific and brief.`;

export type ModelRuntimeToolFactory = (
  context: TurnExecutionContext,
) => readonly AgentTool[] | Promise<readonly AgentTool[]>;

export interface PiTurnExecutorOptions {
  readonly createTools?: ModelRuntimeToolFactory;
  readonly beforeProviderContext?: (context: TurnExecutionContext) => void | Promise<void>;
  readonly resolveRuntime?: (context: PiRuntimeContext) => Promise<PiRuntimeSelection>;
  readonly createAgent?: (options: KernelAgentOptions) => PiAgentRuntime;
  readonly createGateway?: (options: PiModelGatewayOptions) => ModelGateway;
  readonly completeName?: (
    context: ThreadNameGenerationContext,
    runtime: PiRuntimeSelection,
  ) => Promise<string | null>;
  readonly resolveRuntimeSettings?: () => Promise<AgentRuntimeSettings>;
  /**
   * Where the episodic index lives, for the discovery doctrine. Passed in rather
   * than resolved here: this executor is constructed before the Thread service,
   * and the path is a pure function of `userData` either way.
   */
  readonly transcriptIndexPath?: string | null;
  /**
   * The name this Thread's agent answers to. Resolved per Turn rather than read
   * from the recorded configuration, so renaming an agent reaches the next Turn
   * instead of being frozen at spawn.
   */
  readonly resolvePersona?: (thread: TurnExecutionContext['thread']) => string;
}

export type PiRuntimeContext = Pick<TurnExecutionContext, 'thread' | 'configuration'>;

export interface PiRuntimeSelection {
  readonly model: Model<Api>;
  readonly thinkingLevel: AgentState['thinkingLevel'];
  getApiKey(providerId: string): Promise<string | undefined>;
}

export interface PiAgentRuntime {
  readonly state: Pick<AgentState, 'errorMessage' | 'interruptionError'>;
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  abort(): void;
  steer(message: Message, onDelivered?: () => void): void;
  prompt(message: Message): Promise<void>;
}

export class PiTurnExecutor implements TurnExecutor, ThreadNameGenerator {
  constructor(private readonly options: PiTurnExecutorOptions = {}) {}

  async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    if (context.signal.aborted) return { status: 'interrupted' };
    let agent: PiAgentRuntime | null = null;
    let unsubscribe: (() => void) | null = null;
    const abort = () => agent?.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      const internalMemory = context.thread.threadSource === 'memory_consolidation';
      const runtime = await (this.options.resolveRuntime ?? resolveDefaultRuntime)(context);
      if (context.signal.aborted) return { status: 'interrupted' };
      const runtimeSettings = await (this.options.resolveRuntimeSettings ?? getAgentRuntimeSettings)();
      if (context.signal.aborted) return { status: 'interrupted' };
      const tools = internalMemory
        ? []
        : canonicalizeAgentTools(await this.options.createTools?.(context) ?? []);
      if (context.signal.aborted) return { status: 'interrupted' };
      const stablePrompt = internalMemory
        ? null
        : composeStablePrompt({
            thread: context.thread,
            configuration: context.configuration,
            availableToolNames: tools.map((tool) => tool.name),
            transcriptIndexPath: this.options.transcriptIndexPath ?? null,
            startupContext: context.startupContext ?? null,
            persona: this.options.resolvePersona?.(context.thread) ?? null,
          });
      const systemPrompt = stablePrompt?.text
        ?? context.configuration.developerInstructions.join('\n\n');
      const turnScopedReads = withTurnScopedContextReads(context);
      const projectionContext = turnScopedReads.context;
      const projector = new CanonicalContextProjector(runtime.model, projectionContext);
      const priorMessages = await projector.projectTurns(context.historyBeforeTurn);
      const currentMessages = await projector.projectTurns([context.turn]);
      const initialPrompt = currentMessages.at(-1);
      if (!initialPrompt || initialPrompt.role !== 'user') {
        throw new Error('Canonical Turn projection did not produce a trailing user message.');
      }
      priorMessages.push(...currentMessages.slice(0, -1));
      const prompt = initialPrompt;
      if (context.signal.aborted) return { status: 'interrupted' };
      let diagnostics: TurnDiagnosticsCollector;
      const providerOptions = providerStreamOptionsFromRuntimeSettings(
        runtimeSettings,
        runtime.model,
        {
          onNoiseFrame: (frame) => diagnostics.captureStreamNoiseFrame(frame),
        },
      );
      const contextTurns = [...context.historyBeforeTurn, context.turn];
      const cacheAffinity = providerCacheAffinity(context.thread.id, contextTurns);
      diagnostics = new TurnDiagnosticsCollector({
        contextEpochId: latestContextEpochId(contextTurns, INITIAL_CONTEXT_EPOCH_ID),
        cacheAffinity,
        configuration: context.configuration,
        stablePrompt,
        tools,
        model: runtime.model,
        thinkingLevel: runtime.thinkingLevel,
        providerOptions,
        initialInput: {
          acceptedAt: prompt.timestamp,
          itemIds: context.turn.items.map((item) => item.id),
        },
      });
      const disableDiagnostics = (error: unknown) => {
        if (!diagnostics.available) return;
        diagnostics.disable();
        context.onTurnDiagnosticsError(error);
      };
      const reasoningReplay = internalMemory ? null : new ActiveTurnReasoningReplay(context.turn.id);
      const liveModelToolCalls = new Map<string, LiveModelToolCall>();
      const normalizer = new PiEventNormalizer(context, {
        ...(reasoningReplay ? {
          assistantCompleted: ({ itemId, message }) => reasoningReplay.retain(itemId, message),
        } : {}),
        started: (execution) => diagnostics.captureToolExecutionStarted(
          execution.callId,
          execution.toolName,
          execution.itemId,
          execution.modelCall,
          execution.startedAt,
        ),
        completed: (execution) => diagnostics.captureToolExecutionCompleted(
          execution.callId,
          execution.failed,
          execution.completedAt,
        ),
      });
      if (internalMemory) {
        const messages = [...priorMessages, prompt];
        const budget = planContextBudget({
          model: runtime.model,
          systemPrompt,
          tools,
          messages,
          protectedFromMessageIndex: priorMessages.length,
        });
        diagnostics.prepareProviderPlan({
          protectedFromMessageIndex: priorMessages.length,
          budget,
          messagePartProvenance: messages.map((message) => (
            'content' in message
              ? (typeof message.content === 'string' ? [message.content] : message.content)
                .map(() => ({ source: 'unknown' as const }))
              : []
          )),
        });
      }
      const transformContext = internalMemory
        ? undefined
        : async () => {
            await normalizer.flush();
            await this.options.beforeProviderContext?.(context);
            turnScopedReads.beginBoundary();
            try {
              await freezePendingToolOutputProjections({
                turns: [...context.historyBeforeTurn, {
                  ...context.turn,
                  items: currentTurnItems(context),
                }],
                model: runtime.model,
                readContext: projectionContext.readContext,
                persist: (payload, summary) => context.persistContextEvidence(payload, summary),
                onActiveOutputKeys: turnScopedReads.retainOutputReads,
              });
              return await projectCanonicalProviderContext(
                projectionContext,
                runtime.model,
                systemPrompt,
                tools,
                prompt,
                reasoningReplay,
                liveModelToolCalls,
                {
                  prepared: (prepared) => diagnostics.prepareProviderPlan(prepared),
                  compacted: (compacted) => diagnostics.captureContextCompaction(compacted),
                },
              );
            } finally {
              turnScopedReads.finishBoundary();
            }
          };
      const gatewayOptions: PiModelGatewayOptions = {
        onProviderContext: (providerContext) => diagnostics.captureProviderContext(providerContext),
        onPayload: async (payload, model) => {
          const transformed = agentProviderPayload(payload, model, stablePrompt, tools);
          if (diagnostics.available) {
            try {
              await diagnostics.captureProviderRequest(transformed ?? payload);
            } catch (error) {
              disableDiagnostics(error);
            }
          }
          return transformed;
        },
        onResponse: (response) => diagnostics.captureTransportResponse(response),
      };
      agent = (this.options.createAgent ?? ((options) => new NativeAgentRuntime(options)))({
        initialState: {
          systemPrompt,
          model: runtime.model,
          thinkingLevel: runtime.thinkingLevel,
          tools,
          messages: priorMessages,
        },
        gateway: this.options.createGateway?.(gatewayOptions) ?? new PiModelGateway(gatewayOptions),
        retryOptions: {
          onProviderRetry: (event) => {
            if (event.phase === 'retrying') diagnostics.captureProviderRetry(event);
            context.onProviderRetry(event.phase === 'retrying'
              ? { kind: event.kind, attempt: event.attempt, maxRetries: event.maxRetries }
              : null);
          },
          maxRequestRetries: providerOptions.maxRetries,
          maxStreamRetries: providerOptions.maxRetries,
          maxRetryDelayMs: providerOptions.maxRetryDelayMs,
        },
        recoverContextOverflow: transformContext
          ? async () => {
              const compacted = await context.compactContext(
                'providerOverflow',
                activeAdmissionCursor(context.turn),
              );
              if (compacted) diagnostics.captureContextCompaction(compacted);
              return compacted ? await transformContext() : null;
            }
          : undefined,
        admitToolCall: async (request) => {
          const decision = await persistToolCallAdmission(
            request,
            (value) => context.persistToolCallArguments(value),
          );
          if (request.outcome.type === 'admitted' && decision.execute) {
            liveModelToolCalls.set(request.toolCallId, {
              providerName: request.providerName,
              arguments: request.outcome.arguments,
            });
          }
          return decision;
        },
        getApiKey: runtime.getApiKey,
        transformContext,
        sessionId: cacheAffinity,
        providerOptions,
        remainingTokenBudget: context.remainingTokenBudget
          ? () => context.remainingTokenBudget?.() ?? null
          : undefined,
        onBudgetWarning: context.onBudgetWarning,
      });
      if (context.signal.aborted) {
        agent.abort();
        return { status: 'interrupted' };
      }
      unsubscribe = agent.subscribe(async (event) => {
        if (diagnostics.available) {
          try {
            await diagnostics.captureEvent(event);
          } catch (error) {
            disableDiagnostics(error);
          }
        }
        normalizer.handle(event);
        await normalizer.flush();
      });
      context.onSteer(async (input) => {
        const activityIndex = diagnostics.captureSteering(input.items, input.acceptedAt);
        const message = await projector.projectUserItems(input.items, input.acceptedAt);
        if (!context.signal.aborted && agent) {
          agent.steer(message, () => {
            if (!diagnostics.available) return;
            try {
              diagnostics.setSteeringDelivered(activityIndex, true);
            } catch (error) {
              disableDiagnostics(error);
            }
          });
        }
      });
      await agent.prompt(prompt);
      await normalizer.flush();
      if (
        context.signal.aborted
        || normalizer.stopReason === 'aborted'
        || agent.state.interruptionError
      ) {
        diagnostics.finalizeOpenToolExecutions('interrupted');
        const persisted = await executionDetails(context, runtime, normalizer.usage, diagnostics);
        return {
          status: 'interrupted',
          ...(agent.state.interruptionError
            ? { error: agent.state.interruptionError }
            : {}),
          execution: persisted.details,
          refreshDiagnostics: persisted.refresh,
        };
      }
      if (agent.state.errorMessage || normalizer.stopReason === 'error') {
        diagnostics.finalizeOpenToolExecutions('failed');
        const persisted = await executionDetails(context, runtime, normalizer.usage, diagnostics);
        return {
          status: 'failed',
          error: { message: agent.state.errorMessage ?? normalizer.errorMessage ?? 'Model execution failed' },
          execution: persisted.details,
          refreshDiagnostics: persisted.refresh,
        };
      }
      diagnostics.finalizeOpenToolExecutions('completed');
      const persisted = await executionDetails(context, runtime, normalizer.usage, diagnostics);
      return {
        status: 'completed',
        execution: persisted.details,
        refreshDiagnostics: persisted.refresh,
      };
    } finally {
      context.signal.removeEventListener('abort', abort);
      unsubscribe?.();
    }
  }

  async generateName(context: ThreadNameGenerationContext): Promise<string | null> {
    if (context.signal.aborted) return null;
    const runtime = await (this.options.resolveRuntime ?? resolveDefaultRuntime)(context);
    if (context.signal.aborted) return null;
    const raw = await (this.options.completeName ?? completeThreadName)(context, runtime);
    return raw === null ? null : normalizeThreadName(raw);
  }
}

async function projectCanonicalProviderContext(
  context: TurnExecutionContext,
  model: Model<Api>,
  systemPrompt: string,
  tools: readonly AgentTool[],
  preparedInitialPrompt: UserMessage,
  reasoningReplay: ActiveTurnReasoningReplay | null,
  liveModelToolCalls: ReadonlyMap<string, LiveModelToolCall>,
  observer?: {
    readonly prepared?: (input: {
      readonly messages: readonly Message[];
      readonly messagePartProvenance: CanonicalContextProjection['messagePartProvenance'];
      readonly protectedFromMessageIndex: number;
      readonly budget: ReturnType<typeof planContextBudget>;
    }) => void;
    readonly compacted?: (item: Extract<ThreadItem, { type: 'contextCompaction' }>) => void;
  },
): Promise<Message[]> {
  const build = async (stagedCompaction?: ContextCompactionThreadItem) => {
    const sourceTurns = [
      ...context.historyBeforeTurn,
      {
        ...context.turn,
        items: [
          ...currentTurnItems(context),
          ...(stagedCompaction ? [stagedCompaction] : []),
        ],
      },
    ];
    const projector = new CanonicalContextProjector(model, context, {
      liveToolCall: (turnId, itemId) => (
        turnId === context.turn.id ? liveModelToolCalls.get(itemId) ?? null : null
      ),
    });
    const canonicalProjection = await projector.projectTurnsWithBoundaries(sourceTurns);
    const projection = reasoningReplay?.reattach(canonicalProjection, model) ?? canonicalProjection;
    const initialUser = context.turn.items.find((item) => (
      item.type === 'userMessage' && item.acceptedAt === preparedInitialPrompt.timestamp
    ));
    const protectedBoundary = initialUser
      ? projection.userBoundaries.find((boundary) => (
          boundary.turnId === context.turn.id && boundary.itemId === initialUser.id
        ))
      : null;
    if (!protectedBoundary) throw new Error('Canonical Turn projection did not preserve the initial user Item.');
    const selectedTurns = selectEffectiveContext(sourceTurns).turns;
    return {
      ...projection,
      turnBoundaries: projection.turnBoundaries.map((boundary) => {
        const turn = selectedTurns.find((candidate) => candidate.id === boundary.turnId);
        if (!turn?.items[0]) throw new Error(`Projected Turn boundary is unreachable: ${boundary.turnId}`);
        return {
          ...boundary,
          preserveFrom: boundary.turnId === context.turn.id
            ? activeAdmissionCursor(context.turn)
            : cursorFor(turn, turn.items[0]),
        };
      }),
      protectedFromMessageIndex: protectedBoundary.messageIndex,
    };
  };
  const plan = async (stagedCompaction?: ContextCompactionThreadItem) => {
    const projection = await build(stagedCompaction);
    const budget = planContextBudget({
      model,
      systemPrompt,
      tools,
      messages: projection.messages,
      protectedFromMessageIndex: projection.protectedFromMessageIndex,
    });
    return {
      budget,
      messagePartProvenance: projection.messagePartProvenance,
      protectedFromMessageIndex: projection.protectedFromMessageIndex,
    };
  };
  const preparedMessages = (prepared: Awaited<ReturnType<typeof plan>>) => {
    observer?.prepared?.({
      messages: prepared.budget.messages,
      messagePartProvenance: prepared.messagePartProvenance,
      protectedFromMessageIndex: prepared.protectedFromMessageIndex,
      budget: prepared.budget,
    });
    return [...prepared.budget.messages];
  };
  let initialError: ContextCompactionRequiredError;
  try {
    return preparedMessages(await plan());
  } catch (error) {
    if (!(error instanceof ContextCompactionRequiredError)) throw error;
    initialError = error;
  }
  const projection = await build();
  const candidates = uniqueContextCursors([
    ...projection.turnBoundaries
      .filter((boundary) => boundary.messageIndex >= initialError.retainFromMessageIndex)
      .map((boundary) => boundary.preserveFrom),
    activeAdmissionCursor(context.turn),
  ]);
  let lastError = initialError;
  for (const preserveFrom of candidates) {
    const staged = await context.stageContextCompaction('automaticPreflight', preserveFrom);
    if (!staged) continue;
    try {
      const prepared = await plan(staged.item);
      const compacted = await staged.commit();
      observer?.compacted?.(compacted);
      return preparedMessages(prepared);
    } catch (error) {
      await staged.discard();
      if (!(error instanceof ContextCompactionRequiredError)) throw error;
      lastError = error;
    }
  }
  throw new ContextCapacityError(
    'Canonical history still exceeds the model input capacity after exhausting automatic compaction boundaries.',
    lastError.estimatedTokens,
    lastError.availableTokens,
  );
}

function activeAdmissionCursor(turn: Turn): ContextCursor {
  const item = turn.items.find((candidate) => (
    candidate.type !== 'contextEvidence' || candidate.kind !== 'inheritedContext'
  )) ?? turn.items[0];
  if (!item) throw new Error(`Active Turn has no canonical admission boundary: ${turn.id}`);
  return cursorFor(turn, item);
}

function contextCursorKey(cursor: ContextCursor): string {
  return `${cursor.turnId}\0${cursor.itemId}`;
}

function uniqueContextCursors(cursors: readonly ContextCursor[]): ContextCursor[] {
  return [...new Map(cursors.map((cursor) => [contextCursorKey(cursor), cursor])).values()];
}

function currentTurnItems(context: TurnExecutionContext): readonly ThreadItem[] {
  const recorded = context.recorder.orderedItems();
  const recordedById = new Map(recorded.map((item) => [item.id, item]));
  const initialIds = new Set(context.turn.items.map((item) => item.id));
  return [
    ...context.turn.items.map((item) => recordedById.get(item.id) ?? item),
    ...recorded.filter((item) => !initialIds.has(item.id)),
  ];
}

type SignedThinkingContent = Extract<AssistantMessage['content'][number], { type: 'thinking' }> & {
  readonly thinkingSignature: string;
};

class ActiveTurnReasoningReplay {
  private readonly retained = new Map<string, Map<string, readonly SignedThinkingContent[]>>();

  constructor(private readonly turnId: string) {}

  retain(itemId: string, message: AssistantMessage): void {
    const thinking = message.content.flatMap((part): SignedThinkingContent[] => (
      part.type === 'thinking' && typeof part.thinkingSignature === 'string' && part.thinkingSignature.trim()
        ? [{ ...part, thinkingSignature: part.thinkingSignature }]
        : []
    ));
    if (thinking.length === 0) return;
    const key = reasoningReplayIdentity(this.turnId, message.provider, message.api, message.model);
    const messages = this.retained.get(key) ?? new Map<string, readonly SignedThinkingContent[]>();
    messages.set(itemId, thinking);
    this.retained.set(key, messages);
  }

  reattach(projection: CanonicalContextProjection, model: Model<Api>): CanonicalContextProjection {
    const retained = this.retained.get(reasoningReplayIdentity(
      this.turnId,
      model.provider,
      model.api,
      model.id,
    ));
    if (!retained) return projection;

    const byMessageIndex = new Map<number, SignedThinkingContent[]>();
    for (const boundary of projection.assistantBoundaries) {
      if (boundary.turnId !== this.turnId) continue;
      const thinking = boundary.itemIds.flatMap((itemId) => retained.get(itemId) ?? []);
      if (thinking.length === 0) continue;
      const message = projection.messages[boundary.messageIndex];
      if (message?.role !== 'assistant') continue;
      byMessageIndex.set(boundary.messageIndex, thinking);
    }
    if (byMessageIndex.size === 0) return projection;

    const messages = [...projection.messages];
    const messagePartProvenance = projection.messagePartProvenance.map((parts) => [...parts]);
    for (const [messageIndex, thinking] of byMessageIndex) {
      const message = messages[messageIndex];
      if (message?.role !== 'assistant') continue;
      messages[messageIndex] = { ...message, content: [...thinking, ...message.content] };
      messagePartProvenance[messageIndex] = [
        ...thinking.map(() => ({ source: 'assistantHistory' as const })),
        ...(messagePartProvenance[messageIndex] ?? []),
      ];
    }
    return { ...projection, messages, messagePartProvenance };
  }
}

function reasoningReplayIdentity(turnId: string, provider: string, api: Api, model: string): string {
  return `${turnId}\0${provider}\0${api}\0${model}`;
}

export function canonicalizeAgentTools(tools: readonly AgentTool[]): AgentTool[] {
  return [...tools].sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
}

async function resolveDefaultRuntime(context: PiRuntimeContext): Promise<PiRuntimeSelection> {
  const provider = await getProviderRuntimeConfig(context.thread.modelProvider);
  if (!provider) throw new Error(`Provider is not configured: ${context.thread.modelProvider}`);
  const { model, thinkingLevel } = resolveAgentModelEffort(
    context.configuration.model,
    context.configuration.reasoningEffort,
    provider,
    () => resolveProviderModel(provider),
  );
  return {
    model,
    thinkingLevel,
    getApiKey: async (providerId) => {
      if (piExternalProviderId(providerId) !== provider.providerId) return undefined;
      return provider.apiKey ?? piRequestApiKeyOverride(model);
    },
  };
}

async function completeThreadName(
  context: ThreadNameGenerationContext,
  runtime: PiRuntimeSelection,
): Promise<string | null> {
  const prompt = threadNamePrompt(context);
  if (!prompt) return null;
  const runtimeSettings = await getAgentRuntimeSettings();
  if (context.signal.aborted) return null;
  const apiKey = await runtime.getApiKey(runtime.model.provider);
  if (context.signal.aborted) return null;
  const reasoning = lowestThinkingLevel(runtime.model);
  const modelContext: Context = {
    systemPrompt: THREAD_NAME_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    tools: [],
  };
  const response = await awaitWithAbort(piCompleteSimple(runtime.model, modelContext, {
    ...providerStreamOptionsFromRuntimeSettings(runtimeSettings, runtime.model),
    ...customOpenAIResponsesPayloadProfileOption(),
    ...(apiKey ? { apiKey } : {}),
    cacheRetention: 'none',
    maxTokens: Math.min(runtime.model.maxTokens, MAX_THREAD_NAME_OUTPUT_TOKENS),
    ...(reasoning === 'off' ? {} : { reasoning }),
    sessionId: context.thread.sessionId,
    signal: context.signal,
  }), { signal: context.signal });
  if (response.stopReason === 'error') throw new Error(response.errorMessage || 'Thread name generation failed');
  if (response.stopReason === 'aborted') return null;
  const text = response.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return text || null;
}

function threadNamePrompt(context: ThreadNameGenerationContext): string | null {
  const user = context.turn.items
    .filter((item) => item.type === 'userMessage')
    .flatMap((item) => item.content.map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'attachment') return `[Attachment: ${part.name}]`;
      return `[Node: ${part.note?.trim() || part.nodeId}]`;
    }))
    .join('\n')
    .trim();
  const assistant = context.turn.items
    .filter((item) => item.type === 'agentMessage')
    .map((item) => item.text)
    .join('\n')
    .trim();
  const body = [
    user ? `User request:\n${user}` : '',
    assistant ? `Assistant response:\n${assistant}` : '',
  ].filter(Boolean).join('\n\n');
  if (!body) return null;
  return body.slice(0, MAX_THREAD_NAME_INPUT_CHARS);
}

export function normalizeThreadName(value: string): string | null {
  let title = value.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  title = title
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:thread\s+title|conversation\s+title|title|标题)\s*[:：-]\s*/i, '')
    .trim();
  for (let index = 0; index < 2; index += 1) {
    const unwrapped = unwrapThreadName(title);
    if (unwrapped === title) break;
    title = unwrapped.trim();
  }
  title = title.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const characters = Array.from(title);
  return characters.length <= MAX_THREAD_NAME_CHARS
    ? title
    : characters.slice(0, MAX_THREAD_NAME_CHARS).join('').trim();
}

function unwrapThreadName(value: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['\u201c', '\u201d'],
    ['\u2018', '\u2019'],
  ];
  const pair = pairs.find(([start, end]) => value.startsWith(start) && value.endsWith(end));
  return pair && value.length >= 2 ? value.slice(pair[0].length, -pair[1].length) : value;
}

export class PiEventNormalizer {
  readonly usage: MutableTurnUsage = emptyTurnUsage();
  stopReason: AssistantMessage['stopReason'] | null = null;
  errorMessage: string | null = null;
  private activeMessageItem: Extract<ThreadItem, { type: 'agentMessage' }> | null = null;
  private activeReasoningItem: Extract<ThreadItem, { type: 'reasoning' }> | null = null;
  private readonly toolItems = new Map<string, { item: ThreadItem; startedAt: number }>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: TurnExecutionContext,
    private readonly executionObserver?: {
      readonly assistantCompleted?: (completion: {
        readonly itemId: string;
        readonly message: AssistantMessage;
      }) => void;
      readonly started?: (execution: {
        readonly callId: string;
        readonly toolName: string;
        readonly itemId: string | null;
        readonly modelCall: ModelToolCallHistory;
        readonly startedAt: number;
      }) => void;
      readonly completed?: (execution: {
        readonly callId: string;
        readonly failed: boolean;
        readonly completedAt: number;
      }) => void;
    },
  ) {}

  handle(event: AgentEvent): void {
    this.tail = this.tail.then(() => this.process(event));
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private async process(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') await this.ensureMessageItem();
        return;
      case 'message_restart':
        if (event.message.role === 'assistant') await this.completeAssistant(event.message, 'interrupted');
        return;
      case 'message_update':
        if (event.message.role !== 'assistant') return;
        if (event.assistantMessageEvent.type === 'text_delta') {
          const item = await this.ensureMessageItem();
          await this.context.recorder.delta(item.id, {
            type: 'agentMessageText',
            delta: event.assistantMessageEvent.delta,
          });
        } else if (event.assistantMessageEvent.type === 'thinking_delta') {
          const item = await this.ensureReasoningItem();
          await this.context.recorder.delta(item.id, {
            type: 'reasoningContent',
            delta: event.assistantMessageEvent.delta,
          });
        }
        return;
      case 'message_end':
        if (event.message.role === 'assistant') await this.completeAssistant(event.message);
        return;
      case 'tool_call_admission':
        await this.startTool(
          event.toolCallId,
          event.decision.modelCall,
          event.decision.displayArguments,
        );
        return;
      case 'tool_execution_start':
        return;
      case 'tool_execution_end':
        await this.completeTool(event.toolCallId, event.result, event.isError);
        return;
      case 'agent_end': {
        const terminal = [...event.messages].reverse().find((message): message is AssistantMessage => message.role === 'assistant');
        if (terminal) {
          this.stopReason = terminal.stopReason;
          this.errorMessage = terminal.errorMessage ?? null;
        }
        return;
      }
      default:
        return;
    }
  }

  private async ensureMessageItem(): Promise<Extract<ThreadItem, { type: 'agentMessage' }>> {
    if (this.activeMessageItem) return this.activeMessageItem;
    const id = this.context.recorder.createItemId();
    const item: ThreadItem = {
      type: 'agentMessage',
      id,
      provenance: this.context.recorder.localProvenance(id),
      text: '',
      phase: null,
      memoryCitation: null,
    };
    this.activeMessageItem = await this.context.recorder.started(item) as Extract<ThreadItem, { type: 'agentMessage' }>;
    return this.activeMessageItem;
  }

  private async ensureReasoningItem(): Promise<Extract<ThreadItem, { type: 'reasoning' }>> {
    if (this.activeReasoningItem) return this.activeReasoningItem;
    const id = this.context.recorder.createItemId();
    const item: ThreadItem = {
      type: 'reasoning',
      id,
      provenance: this.context.recorder.localProvenance(id),
      summary: [],
      content: [],
    };
    this.activeReasoningItem = await this.context.recorder.started(item) as Extract<ThreadItem, { type: 'reasoning' }>;
    return this.activeReasoningItem;
  }

  private async completeAssistant(
    message: AssistantMessage,
    completion: 'terminal' | 'interrupted' = 'terminal',
  ): Promise<void> {
    const messageItem = await this.ensureMessageItem();
    await this.context.recorder.completed({
      ...messageItem,
      text: message.content
        .filter((part): part is TextContent => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      phase: completion === 'interrupted' ? 'interrupted' : messagePhase(message),
    });
    if (this.activeReasoningItem) {
      await this.context.recorder.completed({
        ...this.activeReasoningItem,
        content: message.content
          .filter((part) => part.type === 'thinking')
          .map((part) => part.thinking),
      });
    }
    if (completion === 'terminal') {
      this.executionObserver?.assistantCompleted?.({ itemId: messageItem.id, message });
      addUsage(this.usage, message.usage);
      try {
        this.context.onModelCallUsage?.(message.usage.totalTokens);
      } catch (error) {
        console.error('[agent][subagent-budget-audit] model-call usage observation failed', error);
      }
      this.stopReason = message.stopReason;
      this.errorMessage = message.errorMessage ?? null;
    }
    this.activeMessageItem = null;
    this.activeReasoningItem = null;
  }

  private async startTool(
    callId: string,
    modelCall: ModelToolCallHistory,
    args: unknown,
  ): Promise<void> {
    const providerName = modelCall.providerName;
    const identity = modelCall.identity ?? canonicalIdentity(providerName);
    const startedAt = Date.now();
    const item = startedToolItem(this.context, callId, identity, modelCall, args);
    const started = await this.context.recorder.started(item);
    this.toolItems.set(callId, { item: started, startedAt });
    this.executionObserver?.started?.({
      callId,
      toolName: providerName,
      itemId: started.id,
      modelCall,
      startedAt,
    });
  }

  private async completeTool(callId: string, result: unknown, isError: boolean): Promise<void> {
    const active = this.toolItems.get(callId);
    if (!active) return;
    const completed = await this.context.recorder.completed(await completedToolItem(
      this.context,
      active.item,
      result,
      isError,
      Math.max(0, Date.now() - active.startedAt),
    ));
    await persistCompletedToolContext(this.context, completed, result, isError);
    this.toolItems.delete(callId);
    this.executionObserver?.completed?.({ callId, failed: isError, completedAt: Date.now() });
  }
}

export async function persistCompletedToolContext(
  context: TurnExecutionContext,
  item: ThreadItem,
  result: unknown,
  isError: boolean,
): Promise<void> {
  if (
    isError
    || item.type !== 'dynamicToolCall'
    || item.namespace !== null
    || item.tool !== 'skill'
  ) return;
  // A refusal has no invocation to record, because no Skill ran. The envelope
  // carries a message written FOR THE MODEL to act on — an unknown Skill name,
  // a disabled one, an exhausted child budget — and it is delivered as an
  // ordinary result precisely so the model can read it and adapt. Demanding
  // evidence here turned every one of those into a dead Turn, and the guidance
  // never reached the model that needed it.
  if (skillToolRefused(result)) return;
  const invocation = skillInvocationEvidence(result);
  if (!invocation) {
    // Recorded, not thrown. This is a bookkeeping side effect the user never
    // sees, and it runs inside tool completion — throwing kills the Turn and
    // discards assistant work already produced, which is exactly the failure
    // the refusal case above was written to remove (A12: fail closed at
    // write/decode boundaries, degrade on the user path).
    console.error('[agent] Completed Skill tool result is missing invocation evidence');
    return;
  }
  await context.persistContextEvidence(invocation, `Invoked Skill: ${invocation.displayName}`);
}

/** A `skill` result that reports its own failure, rather than a malformed one. */
function skillToolRefused(result: unknown): boolean {
  const details = toolDetails(result);
  return isRecord(details) && details.ok === false;
}

function skillInvocationEvidence(result: unknown): SkillInvocationContextPayload | null {
  const details = toolDetails(result);
  if (!isRecord(details) || !details.ok || details.tool !== 'skill' || !isRecord(details.data)) return null;
  try {
    const payload = decodeThreadContextPayload(details.data.invocationEvidence);
    return payload.kind === 'skillInvocation' ? payload : null;
  } catch {
    return null;
  }
}

function startedToolItem(
  context: TurnExecutionContext,
  itemId: string,
  identity: { namespace: string | null; name: string },
  modelCall: ModelToolCallHistory,
  args: unknown,
): ThreadItem {
  const base = {
    id: itemId,
    provenance: context.recorder.localProvenance(itemId),
    outputRef: null,
    modelCall,
  };
  if (identity.namespace === null && isAgentTaskToolName(identity.name)) {
    const input = isRecord(args) ? args : {};
    return {
      ...base,
      type: 'collabAgentToolCall',
      tool: identity.name,
      status: 'inProgress',
      senderThreadId: context.thread.id,
      receiverThreadIds: [],
      prompt: identity.name === 'agent'
        ? optionalToolArgumentText(input.prompt)
        : identity.name === 'agent_message'
          ? optionalToolArgumentText(input.message)
          : null,
      summary: identity.name === 'agent_message'
        ? optionalToolArgumentText(input.summary)
        : null,
      model: optionalToolArgumentText(input.model),
      reasoningEffort: null,
      agentsStates: {},
    };
  }
  if (identity.name === 'bash' && identity.namespace === null) {
    const input = isRecord(args) ? args : {};
    return {
      ...base,
      type: 'commandExecution',
      command: boundedText(
        typeof input.command === 'string' ? input.command : JSON.stringify(boundedJsonValue(args)),
        MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
      ),
      // The bash contract already asks the caller to describe the command in
      // active voice, and `normalizeBashParams` already validates it — it was
      // simply never carried to the transcript.
      description: typeof input.description === 'string' && input.description.trim()
        ? boundedText(input.description.trim(), MAX_PERSISTED_TOOL_STRING_CHARS)
        : null,
      cwd: boundedText(context.thread.cwd, MAX_PERSISTED_TOOL_STRING_CHARS),
      processId: null,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
  }
  if (identity.namespace === null && isFileMutationTool(identity.name)) {
    const input = isRecord(args) ? args : {};
    const path = optionalToolArgumentText(input.path)
      ?? optionalToolArgumentText(input.file_path)
      ?? '(unknown path)';
    return {
      ...base,
      type: 'fileChange',
      changes: [{
        path: boundedText(path, MAX_PERSISTED_TOOL_STRING_CHARS),
        kind: identity.name === 'file_delete' ? 'delete' : identity.name === 'file_write' ? 'add' : 'update',
      }],
      status: 'inProgress',
    };
  }
  if (identity.name === 'web_search' && identity.namespace === null) {
    const input = isRecord(args) ? args : {};
    return {
      ...base,
      type: 'webSearch',
      query: typeof input.query === 'string'
        ? boundedText(input.query, MAX_PERSISTED_TOOL_STRING_CHARS)
        : '',
      status: 'inProgress',
      results: [],
      error: null,
    };
  }
  if (identity.namespace && context.configuration.mcpServers.includes(identity.namespace)) {
    return {
      ...base,
      type: 'mcpToolCall',
      server: identity.namespace,
      tool: identity.name,
      status: 'inProgress',
      arguments: boundedJsonValue(args),
      pluginId: null,
      result: null,
      error: null,
      durationMs: null,
    };
  }
  return {
    ...base,
    type: 'dynamicToolCall',
    namespace: identity.namespace,
    tool: identity.name,
    arguments: boundedJsonValue(args),
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null,
  };
}

async function completedToolItem(
  context: TurnExecutionContext,
  item: ThreadItem,
  result: unknown,
  isError: boolean,
  durationMs: number,
): Promise<ThreadItem> {
  const status = isError ? 'failed' : 'completed';
  const outputRef = await persistFullToolOutput(context, item, result, isError);
  switch (item.type) {
    case 'commandExecution': {
      const details = toolDetails(result);
      const data = isRecord(details) && isRecord(details.data) ? details.data : details;
      return {
        ...item,
        status,
        outputRef,
        processId: isRecord(data) && typeof data.processId === 'string' ? data.processId : item.processId,
        aggregatedOutput: boundedText(toolResultText(result), MAX_PERSISTED_TOOL_OUTPUT_CHARS),
        // A timeout or a kill has no exit code; synthesizing 1 made the row
        // claim the shell reported a status it never did. `null` is the honest
        // value and the renderer has a wording for it.
        exitCode: isRecord(data) && typeof data.exitCode === 'number' ? data.exitCode : isError ? null : 0,
        durationMs,
      };
    }
    case 'fileChange':
      return { ...item, status, outputRef };
    case 'webSearch':
      return {
        ...item,
        status,
        outputRef,
        results: webResults(result),
        error: isError
          ? boundedText(toolResultText(result) || 'Web search failed', MAX_PERSISTED_TOOL_STRING_CHARS)
          : null,
      };
    case 'mcpToolCall':
      return {
        ...item,
        status,
        outputRef,
        result: isError ? null : boundedJsonValue(toolDetails(result), MAX_PERSISTED_TOOL_OUTPUT_CHARS),
        error: isError
          ? boundedText(toolResultText(result) || 'MCP tool failed', MAX_PERSISTED_TOOL_STRING_CHARS)
          : null,
        durationMs,
      };
    case 'dynamicToolCall':
      return {
        ...item,
        status,
        outputRef,
        contentItems: await dynamicOutput(context, item, result),
        success: !isError,
        durationMs,
      };
    case 'collabAgentToolCall': {
      const views = collaborationViews(result);
      const agentsStates: Record<string, SubagentExecutionState> = {};
      for (const view of views) {
        const threadId = collaborationThreadId(view);
        if (threadId === null) continue;
        agentsStates[threadId] = {
          status: collaborationStatus(view.status, isError),
          taskPath: collaborationText(view.taskPath ?? view.task_name),
          nickname: collaborationText(view.nickname),
          role: collaborationText(view.role),
        };
      }
      return {
        ...item,
        status,
        outputRef,
        receiverThreadIds: Object.keys(agentsStates),
        agentsStates,
      };
    }
    default:
      throw new Error(`Unexpected executable Thread Item: ${item.type}`);
  }
}

async function executionDetails(
  context: TurnExecutionContext,
  runtime: PiRuntimeSelection,
  usage: TurnExecutionDetails['usage'],
  diagnostics: TurnDiagnosticsCollector,
): Promise<{
  readonly details: TurnExecutionDetails;
  readonly refresh: () => Promise<TurnExecutionDetails['diagnosticsRef']>;
}> {
  let diagnosticsRef: TurnExecutionDetails['diagnosticsRef'] = null;
  const refresh = async () => {
    if (!diagnostics.available) return null;
    try {
      diagnosticsRef = await context.persistTurnDiagnostics(diagnostics.payload());
    } catch (error) {
      diagnosticsRef = null;
      context.onTurnDiagnosticsError(error);
    }
    return diagnosticsRef;
  };
  await refresh();
  return {
    details: {
      modelProvider: context.thread.modelProvider,
      model: runtime.model.id,
      reasoningEffort: context.configuration.reasoningEffort,
      diagnosticsRef,
      usage: {
        ...usage,
        cost: usage.cost ? { ...usage.cost } : null,
      },
    },
    refresh,
  };
}

function withTurnScopedContextReads(context: TurnExecutionContext): {
  readonly context: TurnExecutionContext;
  readonly beginBoundary: () => void;
  readonly retainOutputReads: (activeKeys: readonly string[]) => void;
  readonly finishBoundary: () => void;
} {
  const contextReads = new Map<string, ReturnType<TurnExecutionContext['readContext']>>();
  const outputReads = new Map<string, ReturnType<TurnExecutionContext['readOutput']>>();
  let activeContextKeys: Set<string> | null = null;
  let activeOutputKeys: Set<string> | null = null;
  return {
    context: {
      ...context,
      readContext: (ref) => {
        const key = contextPayloadReferenceKey(ref);
        activeContextKeys?.add(key);
        const cached = contextReads.get(key);
        if (cached) return cached;
        const pending = context.readContext(ref).then(
          (payload) => {
            if (!payload) contextReads.delete(key);
            return payload;
          },
          (error) => {
            contextReads.delete(key);
            throw error;
          },
        );
        contextReads.set(key, pending);
        return pending;
      },
      readOutput: (ref) => {
        const key = outputReferenceKey(ref);
        activeOutputKeys?.add(key);
        const cached = outputReads.get(key);
        if (cached) return cached;
        const pending = context.readOutput(ref).then(
          (payload) => {
            if (payload === null) outputReads.delete(key);
            return payload;
          },
          (error) => {
            outputReads.delete(key);
            throw error;
          },
        );
        outputReads.set(key, pending);
        return pending;
      },
    },
    beginBoundary: () => {
      activeContextKeys = new Set();
      activeOutputKeys = new Set();
    },
    retainOutputReads: (activeKeys) => {
      if (!activeOutputKeys) return;
      for (const key of activeKeys) activeOutputKeys.add(key);
    },
    finishBoundary: () => {
      if (!activeContextKeys || !activeOutputKeys) return;
      for (const key of contextReads.keys()) {
        if (!activeContextKeys.has(key)) contextReads.delete(key);
      }
      for (const key of outputReads.keys()) {
        if (!activeOutputKeys.has(key)) outputReads.delete(key);
      }
      activeContextKeys = null;
      activeOutputKeys = null;
    },
  };
}

interface MutableTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    currency: 'USD';
  } | null;
}

function emptyTurnUsage(): MutableTurnUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: null,
  };
}

function addUsage(target: MutableTurnUsage, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  const cost = target.cost ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    currency: 'USD' as const,
  };
  cost.input += usage.cost.input;
  cost.output += usage.cost.output;
  cost.cacheRead += usage.cost.cacheRead;
  cost.cacheWrite += usage.cost.cacheWrite;
  cost.total += usage.cost.total;
  target.cost = cost;
}

async function persistFullToolOutput(
  context: TurnExecutionContext,
  item: ThreadItem,
  result: unknown,
  isError: boolean,
): Promise<ThreadItemOutputReference | null> {
  const output = fullToolOutput(result);
  const text = item.type === 'dynamicToolCall'
    ? persistedToolResultText({ toolNamespace: item.namespace, toolName: item.tool, text: output.text })
    : output.text;
  if (!text) return null;
  const state = isError ? 'error' : 'output';
  const tool = toolItemLabel(item);
  const normalized = text.replace(/\s+/g, ' ').trim();
  const preview = normalized.length > 200 ? `${normalized.slice(0, 200).trim()}...` : normalized;
  return context.persistOutputText(
    item.id,
    text,
    output.mimeType,
    preview ? `${tool} ${state}: ${preview}` : `${tool} ${state}`,
  );
}

function fullToolOutput(result: unknown): {
  readonly text: string;
  readonly mimeType: ThreadItemOutputReference['mimeType'];
} {
  const text = toolResultText(result);
  if (text) return { text, mimeType: 'text/plain' };
  const details = toolDetails(result);
  if (details === undefined) return { text: '', mimeType: 'text/plain' };
  return {
    text: JSON.stringify(withoutInlineBinary(details), null, 2),
    mimeType: 'application/json',
  };
}

function withoutInlineBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInlineBinary);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (value.type === 'image' && key === 'data' && typeof entry === 'string') {
      return [key, `[binary image omitted: ${entry.length} base64 chars]`];
    }
    if (
      typeof entry === 'string'
      && (key.toLowerCase().includes('base64') || key === 'data')
      && entry.length > MAX_PERSISTED_TOOL_OUTPUT_CHARS
    ) {
      return [key, `[binary data omitted: ${entry.length} base64 chars]`];
    }
    return [key, withoutInlineBinary(entry)];
  }));
}

function toolItemLabel(item: ThreadItem): string {
  switch (item.type) {
    case 'commandExecution': return 'Command';
    case 'fileChange': return 'File change';
    case 'webSearch': return 'Web search';
    case 'mcpToolCall': return `${item.server}.${item.tool}`;
    case 'dynamicToolCall': return item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
    case 'collabAgentToolCall': return `Agent task ${item.tool}`;
    default: return 'Tool';
  }
}

function isAgentTaskToolName(value: string): value is Extract<ThreadItem, { type: 'collabAgentToolCall' }>['tool'] {
  return ['agent', 'agent_message', 'task_stop'].includes(value);
}

function isFileMutationTool(value: string): boolean {
  return value === 'file_edit' || value === 'file_write' || value === 'file_delete';
}

function toolDetails(result: unknown): unknown {
  return isRecord(result) && 'details' in result ? result.details : result;
}

function toolResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return '';
  return result.content.flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    ? [part.text]
    : []).join('\n');
}

function webResults(result: unknown): Array<{ title: string; url: string; snippet?: string }> {
  const details = toolDetails(result);
  const data = isRecord(details) && isRecord(details.data) ? details.data : details;
  const entries = isRecord(data) && Array.isArray(data.results) ? data.results : [];
  return entries.slice(0, MAX_PERSISTED_WEB_RESULTS).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.title !== 'string' || typeof entry.url !== 'string') return [];
    return [{
      title: boundedText(entry.title, MAX_PERSISTED_TOOL_STRING_CHARS),
      url: boundedText(entry.url, MAX_PERSISTED_TOOL_STRING_CHARS),
      ...(typeof entry.snippet === 'string'
        ? { snippet: boundedText(entry.snippet, MAX_PERSISTED_TOOL_STRING_CHARS) }
        : {}),
    }];
  });
}

function collaborationViews(result: unknown): Array<Record<string, unknown>> {
  const details = toolDetails(result);
  if (Array.isArray(details)) return details.filter(isRecord);
  if (!isRecord(details)) return [];
  if (Array.isArray(details.agents)) return details.agents.filter(isRecord);
  if (typeof details.agentId === 'string') {
    return [{ ...details, threadId: details.agentId, status: 'running' }];
  }
  if (typeof details.resumedAgentId === 'string') {
    return [{ ...details, threadId: details.resumedAgentId, status: 'running' }];
  }
  if (isRecord(details.pin) && typeof details.pin.id === 'string') {
    return [{ ...details, threadId: details.pin.id, status: 'running' }];
  }
  if (typeof details.thread_id === 'string') {
    return [{ ...details, status: 'running' }];
  }
  return [details];
}

function collaborationThreadId(view: Record<string, unknown>): string | null {
  const value = view.threadId ?? view.thread_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function collaborationText(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? boundedText(value.trim(), MAX_PERSISTED_TOOL_STRING_CHARS)
    : null;
}

function collaborationStatus(value: unknown, isError: boolean): 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'notFound' {
  if (
    value === 'pendingInit'
    || value === 'running'
    || value === 'interrupted'
    || value === 'completed'
    || value === 'errored'
    || value === 'notFound'
  ) return value;
  return isError ? 'notFound' : 'completed';
}

function messagePhase(message: AssistantMessage): MessagePhase {
  if (message.stopReason === 'toolUse') return 'commentary';
  const signature = message.content.find((part): part is TextContent => part.type === 'text')?.textSignature;
  if (signature) {
    try {
      const parsed = JSON.parse(signature) as { phase?: unknown };
      if (parsed.phase === 'commentary' || parsed.phase === 'final_answer') return parsed.phase;
    } catch {
      // Provider signatures are opaque unless they use the documented JSON envelope.
    }
  }
  return 'final_answer';
}

function canonicalIdentity(providerName: string): { namespace: string | null; name: string } {
  const separator = providerName.indexOf('__');
  return separator < 0
    ? { namespace: null, name: providerName }
    : { namespace: providerName.slice(0, separator), name: providerName.slice(separator + 2) };
}

async function dynamicOutput(
  context: TurnExecutionContext,
  item: Extract<ThreadItem, { type: 'dynamicToolCall' }>,
  result: unknown,
): Promise<readonly DynamicToolOutputContent[]> {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return [{ type: 'json', value: boundedJsonValue(result, MAX_PERSISTED_TOOL_OUTPUT_CHARS) }];
  }
  const content: DynamicToolOutputContent[] = [];
  let remainingText = MAX_PERSISTED_TOOL_OUTPUT_CHARS;
  let imageIndex = 0;
  let persistedImages = 0;
  let persistedImageBytes = 0;
  const omittedImages: Record<ImageOmissionReason, number> = {
    countLimit: 0,
    invalidBase64: 0,
    invalidMimeType: 0,
    imageByteLimit: 0,
    callByteLimit: 0,
    quotaExceeded: 0,
    dimensionsUnavailable: 0,
    normalizationFailed: 0,
  };
  for (const part of result.content) {
    if (!isRecord(part) || typeof part.type !== 'string') continue;
    if (part.type === 'text' && typeof part.text === 'string' && remainingText > 0) {
      const persisted = persistedToolResultText({
        toolNamespace: item.namespace,
        toolName: item.tool,
        text: part.text,
      });
      const text = boundedText(persisted, remainingText);
      content.push({ type: 'text', text });
      remainingText -= text.length;
    }
    if (part.type === 'image' && typeof part.data === 'string') {
      const sourceImageIndex = imageIndex;
      imageIndex += 1;
      if (persistedImages >= MAX_PERSISTED_TOOL_OUTPUT_IMAGES) {
        omittedImages.countLimit += 1;
        continue;
      }
      const measurement = measureToolPayloadImage(part.data);
      if (!measurement.ok) {
        omittedImages[measurement.reason] += 1;
        continue;
      }
      if (persistedImageBytes + measurement.byteLength > MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES) {
        omittedImages.callByteLimit += 1;
        continue;
      }
      const mimeType = dynamicImageMimeType(part.mimeType);
      if (!mimeType) {
        omittedImages.invalidMimeType += 1;
        continue;
      }
      const observationBytes = Buffer.from(part.data, 'base64');
      const observationDimensions = readAgentImageDimensions(observationBytes, mimeType);
      if (!observationDimensions) {
        omittedImages.dimensionsUnavailable += 1;
        continue;
      }
      const persistedArtifact = toolImageArtifact(item.namespace, item.tool, result, sourceImageIndex);
      const canonicalObservation = persistedArtifact
        && persistedArtifact.observation.mimeType === mimeType
        && persistedArtifact.observation.byteLength === observationBytes.byteLength
        && persistedArtifact.geometry.observationWidth === observationDimensions.width
        && persistedArtifact.geometry.observationHeight === observationDimensions.height
        ? await context.readResource(persistedArtifact.observation).catch(() => null)
        : null;
      if (canonicalObservation?.equals(observationBytes)) {
        persistedImageBytes += measurement.byteLength;
        content.push({ type: 'image', artifactRef: persistedArtifact! });
        persistedImages += 1;
        continue;
      }
      const persisted = await context.persistOutputImage(observationBytes, mimeType).catch((error: unknown) => {
        if (error instanceof ThreadResourceQuotaError) return 'quotaExceeded' as const;
        if (error instanceof ImageObservationNormalizationError) return 'normalizationFailed' as const;
        throw error;
      });
      if (persisted === 'quotaExceeded' || persisted === 'normalizationFailed') {
        omittedImages[persisted] += 1;
        continue;
      }
      persistedImageBytes += measurement.byteLength;
      const existingPath = toolImagePath(item.namespace, item.tool, result);
      const artifactRef = createImageArtifactReference({
        retention: existingPath ? 'external' : 'observationOnly',
        original: existingPath ? { kind: 'localFile', path: existingPath } : null,
        observation: persisted.observation,
        sourceDimensions: toolImageSourceDimensions(
          item.namespace,
          item.tool,
          result,
          persisted.sourceDimensions,
        ),
        observationDimensions: persisted.observationDimensions,
      });
      content.push({ type: 'image', artifactRef });
      persistedImages += 1;
    }
  }
  const omittedImageCount = Object.values(omittedImages).reduce((total, count) => total + count, 0);
  if (omittedImageCount > 0) {
    content.push({
      type: 'json',
      value: {
        imagesOmitted: omittedImageCount,
        reasons: Object.fromEntries(Object.entries(omittedImages).filter(([, count]) => count > 0)),
        limits: {
          maxImages: MAX_PERSISTED_TOOL_OUTPUT_IMAGES,
          maxImageBytes: MAX_TOOL_PAYLOAD_IMAGE_BYTES,
          maxCallBytes: MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES,
        },
      },
    });
  }
  const persistedDetails = persistedToolResultDetails({
    toolNamespace: item.namespace,
    toolName: item.tool,
    details: result.details,
  });
  if (persistedDetails !== undefined) {
    content.push({ type: 'json', value: boundedJsonValue(persistedDetails, MAX_PERSISTED_TOOL_OUTPUT_CHARS) });
  } else if (content.length === 0 && result.details !== undefined) {
    content.push({ type: 'json', value: boundedJsonValue(result.details, MAX_PERSISTED_TOOL_OUTPUT_CHARS) });
  }
  return content;
}

function toolImagePath(
  toolNamespace: string | null,
  toolName: string,
  result: Record<string, unknown>,
): string | null {
  const details = toolDetails(result);
  if (!isRecord(details) || !isRecord(details.data)) return null;
  if (toolNamespace === null && toolName === 'file_read' && isRecord(details.data.file)) {
    if (details.data.type === 'image' && typeof details.data.file.filePath === 'string') {
      return details.data.file.filePath;
    }
  }
  return null;
}

function toolImageArtifact(
  toolNamespace: string | null,
  toolName: string,
  result: Record<string, unknown>,
  imageIndex: number,
): ThreadImageArtifactReference | null {
  if (toolNamespace !== null || toolName !== 'generate_image') return null;
  const details = toolDetails(result);
  if (!isRecord(details) || !isRecord(details.data) || !Array.isArray(details.data.images)) return null;
  const image = details.data.images.find((candidate) => (
    isRecord(candidate) && candidate.previewIndex === imageIndex
  ));
  if (!isRecord(image) || image.artifactRef === undefined) return null;
  try {
    return decodeThreadImageArtifactReference(image.artifactRef, 'generateImage.artifactRef');
  } catch {
    return null;
  }
}

function toolImageSourceDimensions(
  toolNamespace: string | null,
  toolName: string,
  result: Record<string, unknown>,
  fallback: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  if (toolNamespace !== null || toolName !== 'file_read') return fallback;
  const details = toolDetails(result);
  if (!isRecord(details) || !isRecord(details.data) || !isRecord(details.data.file)) return fallback;
  const dimensions = details.data.file.sourceDimensions;
  if (!isRecord(dimensions)) return fallback;
  return typeof dimensions.width === 'number' && typeof dimensions.height === 'number'
    && Number.isSafeInteger(dimensions.width) && dimensions.width > 0
    && Number.isSafeInteger(dimensions.height) && dimensions.height > 0
    ? { width: dimensions.width, height: dimensions.height }
    : fallback;
}

type ImageOmissionReason =
  | 'countLimit'
  | 'invalidBase64'
  | 'invalidMimeType'
  | 'imageByteLimit'
  | 'callByteLimit'
  | 'quotaExceeded'
  | 'dimensionsUnavailable'
  | 'normalizationFailed';

function dynamicImageMimeType(value: unknown): string | null {
  if (value === undefined) return 'image/png';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^image\/[a-z0-9][a-z0-9.+-]*$/u.test(normalized) ? normalized : null;
}

function boundedJsonValue(
  value: unknown,
  maxChars = MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
): JsonValue {
  const normalized = jsonValue(value);
  const encoded = JSON.stringify(normalized);
  if (encoded.length <= maxChars) return normalized;
  const previewBudget = Math.max(0, maxChars - 160);
  return {
    truncated: true,
    originalChars: encoded.length,
    preview: boundedText(encoded, previewBudget),
  };
}

/**
 * An optional string tool argument the model left blank means "not specified".
 *
 * A provider that fills an omitted parameter with `""` — rather than omitting
 * the key — otherwise produces an Item that cannot be decoded, and the decode
 * runs before the Item is recorded, so the whole Turn fails with nothing on
 * disk to explain it. Blank is absence, and absence is `null`.
 */
function optionalToolArgumentText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return boundedText(value, MAX_PERSISTED_TOOL_STRING_CHARS);
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return '';
  const marker = `\n... ${value.length - maxChars} chars omitted ...\n`;
  if (marker.length >= maxChars) return value.slice(0, maxChars);
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`;
}

function jsonValue(value: unknown): JsonValue {
  try {
    const encoded = JSON.stringify(value ?? null);
    return JSON.parse(encoded) as JsonValue;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
