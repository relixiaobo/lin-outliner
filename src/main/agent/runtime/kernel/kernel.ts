import { validateToolArguments } from '@earendil-works/pi-ai/compat';
import {
  SUBAGENT_BUDGET_EXHAUSTED_ERROR_CODE,
  type TurnError,
} from '../../../../core/agent/protocol';
import { streamWithPolicy } from './retryPolicy';
import {
  redactSecretLikeContent,
  redactSecretLikeJson,
} from '../../capabilities/agentSecretRedaction';
import type {
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AssistantMessage,
  KernelAgentOptions,
  KernelEvent,
  Message,
  ToolResultMessage,
} from './types';
import {
  canonicalToolIdentity,
  evidenceCorrection,
  modelToolSchemaDigest,
  persistenceFailureAdmission,
  toolCallEvidenceText,
  transientToolCallAdmission,
  type ToolCallAdmissionDecision,
  type ToolCallAdmissionRequest,
} from '../toolCallHistory';
import { uuidV7 } from '../../uuid';

export type KernelEventSink = (event: KernelEvent) => Promise<void> | void;

interface KernelContext {
  systemPrompt: string;
  messages: Message[];
  tools: AgentTool[];
}

export interface KernelRunResult {
  readonly messages: Message[];
  readonly interruptionError: TurnError | null;
}

export interface KernelSteeringMessage {
  readonly message: Message;
  readonly onDelivered?: () => void;
}

export async function runKernel(
  prompts: Message[],
  initialContext: KernelContext,
  options: KernelAgentOptions,
  emit: KernelEventSink,
  signal: AbortSignal,
  getSteeringMessages: () => Promise<KernelSteeringMessage[]>,
): Promise<KernelRunResult> {
  const newMessages: Message[] = [...prompts];
  const context: KernelContext = {
    ...initialContext,
    messages: [...initialContext.messages, ...prompts],
  };
  const usedToolCallIds = historicalToolCallIds(context.messages);

  await emit({ type: 'agent_start' });
  await emit({ type: 'turn_start' });
  for (const prompt of prompts) {
    await emit({ type: 'message_start', message: prompt });
    await emit({ type: 'message_end', message: prompt });
  }
  let providerCallCount = 0;
  let budgetWarningSent = false;
  let pendingMessages = await getSteeringMessages();
  let hasMoreToolCalls = true;
  while (true) {
    if (providerCallCount > 0) {
      const actuals = options.remainingTokenBudget?.() ?? null;
      if (actuals && actuals.remaining <= 0) {
        if (hasMoreToolCalls) {
          const interruptionError = {
            code: SUBAGENT_BUDGET_EXHAUSTED_ERROR_CODE,
            message: `Token budget exhausted mid-Turn (${actuals.used} of ${actuals.total} tokens)`,
          } satisfies TurnError;
          await emit({ type: 'agent_end', messages: newMessages });
          return { messages: newMessages, interruptionError };
        }
        break;
      }

      pendingMessages = await getSteeringMessages();
      if (!hasMoreToolCalls && pendingMessages.length === 0) break;

      if (
        actuals
        && actuals.used >= Math.ceil(actuals.total * 0.8)
        && !budgetWarningSent
        && options.onBudgetWarning
      ) {
        budgetWarningSent = true;
        try {
          await options.onBudgetWarning(actuals);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[agent] Budget warning delivery failed: ${message}`);
        }
        pendingMessages.push(...await getSteeringMessages());
      }

      await emit({ type: 'turn_start' });
    }

    for (const steering of pendingMessages) {
      const { message } = steering;
      await emit({ type: 'message_start', message });
      await emit({ type: 'message_end', message });
      context.messages.push(message);
      newMessages.push(message);
      steering.onDelivered?.();
    }
    pendingMessages = [];

    const message = await streamAssistantResponse(context, options, signal, emit);
    providerCallCount += 1;
    newMessages.push(message);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      await emit({ type: 'turn_end', message, toolResults: [] });
      await emit({ type: 'agent_end', messages: newMessages });
      return { messages: newMessages, interruptionError: null };
    }

    const providerToolCalls = message.content.filter((part): part is AgentToolCall => part.type === 'toolCall');
    const toolCalls = canonicalizeToolCallIds(providerToolCalls, usedToolCallIds);
    const toolResults: ToolResultMessage[] = [];
    hasMoreToolCalls = false;
    if (toolCalls.length > 0) {
      const batch = message.stopReason === 'length'
        ? await failTruncatedToolCalls(context, toolCalls, emit, options.admitToolCall)
        : await executeToolCalls(context, toolCalls, signal, emit, options.admitToolCall);
      toolResults.push(...batch.messages);
      hasMoreToolCalls = !batch.terminate && !signal.aborted;
      const liveAssistant = liveAssistantToolHistory(message, batch.admissions);
      context.messages[context.messages.length - 1] = liveAssistant;
      newMessages[newMessages.length - 1] = liveAssistant;
      for (const result of batch.historyMessages) {
        context.messages.push(result);
        newMessages.push(result);
      }
    }

    await emit({ type: 'turn_end', message, toolResults });
  }

  await emit({ type: 'agent_end', messages: newMessages });
  return { messages: newMessages, interruptionError: null };
}

async function streamAssistantResponse(
  context: KernelContext,
  options: KernelAgentOptions,
  signal: AbortSignal,
  emit: KernelEventSink,
): Promise<AssistantMessage> {
  const projectedMessages = options.transformContext
    ? await options.transformContext()
    : [...context.messages];
  const resolvedApiKey = await options.getApiKey?.(options.initialState.model.provider);
  const response = streamWithPolicy({
    model: options.initialState.model,
    signal,
    ...options.retryOptions,
    recoverContextOverflow: options.recoverContextOverflow,
    attempt: (refreshedMessages, attemptSignal) => options.gateway.stream({
      model: options.initialState.model,
      context: {
        systemPrompt: context.systemPrompt,
        messages: refreshedMessages ?? projectedMessages,
        tools: context.tools,
      },
      options: {
        ...options.providerOptions,
        apiKey: resolvedApiKey || options.providerOptions?.apiKey,
        signal: attemptSignal,
        sessionId: options.sessionId,
        reasoning: options.initialState.thinkingLevel === 'off'
          ? undefined
          : options.initialState.thinkingLevel,
      },
    }),
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;
  streamEvents: for await (const event of response) {
    switch (event.type) {
      case 'start':
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: 'message_start', message: { ...partialMessage } });
        break;
      case 'text_start':
      case 'text_delta':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: 'message_update',
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;
      case 'done':
      case 'error':
        break streamEvents;
    }
  }

  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: 'message_start', message: { ...finalMessage } });
  }
  await emit({ type: 'message_end', message: finalMessage });
  return finalMessage;
}

interface ExecutedToolBatch {
  messages: ToolResultMessage[];
  historyMessages: ToolResultMessage[];
  admissions: ToolCallAdmissionRecord[];
  terminate: boolean;
}

interface CanonicalizedToolCall {
  readonly providerToolCallId: string;
  readonly toolCall: AgentToolCall;
}

interface PreparedToolCall {
  kind: 'prepared';
  toolCall: AgentToolCall;
  tool: AgentTool<any>;
  args: unknown;
  admission: ToolCallAdmissionRequest;
}

interface ImmediateToolCall {
  kind: 'immediate';
  result: AgentToolResult<any>;
  isError: boolean;
  admission: ToolCallAdmissionRequest;
}

interface ToolCallAdmissionRecord {
  readonly providerToolCallId: string;
  readonly toolCallId: string;
  readonly decision: ToolCallAdmissionDecision;
}

interface ExecutedToolCall {
  result: AgentToolResult<any>;
  isError: boolean;
}

interface FinalizedToolCall extends ExecutedToolCall {
  toolCall: AgentToolCall;
}

type FinalizedToolEntry = FinalizedToolCall | (() => Promise<FinalizedToolCall>);

async function failTruncatedToolCalls(
  context: KernelContext,
  toolCalls: CanonicalizedToolCall[],
  emit: KernelEventSink,
  admit: KernelAgentOptions['admitToolCall'],
): Promise<ExecutedToolBatch> {
  const messages: ToolResultMessage[] = [];
  const admissions: ToolCallAdmissionRecord[] = [];
  for (const { providerToolCallId, toolCall } of toolCalls) {
    const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
    const admission = await admitAndEmit({
      toolCallId: toolCall.id,
      providerName: toolCall.name,
      outcome: {
        type: 'rejected',
        identity: tool ? canonicalToolIdentity(tool) : null,
        arguments: toolCall.arguments,
        reason: 'truncatedArguments',
        correction: evidenceCorrection('truncatedArguments'),
      },
    }, providerToolCallId, admit, emit);
    admissions.push(admission);
    const finalized: FinalizedToolCall = {
      toolCall,
      result: errorToolResult(
        `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      ),
      isError: true,
    };
    await emitToolExecutionEnd(finalized, emit);
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    messages.push(message);
  }
  return { messages, historyMessages: [], admissions, terminate: false };
}

async function executeToolCalls(
  context: KernelContext,
  toolCalls: CanonicalizedToolCall[],
  signal: AbortSignal,
  emit: KernelEventSink,
  admit: KernelAgentOptions['admitToolCall'],
): Promise<ExecutedToolBatch> {
  const hasSequentialTool = toolCalls.some(({ toolCall }) => (
    context.tools.find((tool) => tool.name === toolCall.name)?.executionMode === 'sequential'
  ));
  return !hasSequentialTool
    ? executeToolCallsParallel(context, toolCalls, signal, emit, admit)
    : executeToolCallsSequential(context, toolCalls, signal, emit, admit);
}

async function executeToolCallsSequential(
  context: KernelContext,
  toolCalls: CanonicalizedToolCall[],
  signal: AbortSignal,
  emit: KernelEventSink,
  admit: KernelAgentOptions['admitToolCall'],
): Promise<ExecutedToolBatch> {
  const finalizedCalls: FinalizedToolCall[] = [];
  const messages: ToolResultMessage[] = [];
  const historyMessages: ToolResultMessage[] = [];
  const admissions: ToolCallAdmissionRecord[] = [];
  for (const { providerToolCallId, toolCall } of toolCalls) {
    if (signal.aborted) break;
    const preparation = await prepareToolCall(context, toolCall);
    if (signal.aborted) break;
    const admission = await admitAndEmit(preparation.admission, providerToolCallId, admit, emit);
    admissions.push(admission);
    const admitted = preparation.kind === 'prepared' && admission.decision.execute;
    let finalized: FinalizedToolCall;
    if (preparation.kind === 'prepared' && admission.decision.execute) {
      if (!signal.aborted) await emitToolExecutionStart(preparation.toolCall, emit);
      finalized = signal.aborted
        ? abortedPreparedToolCall(preparation)
        : { toolCall: preparation.toolCall, ...await executePreparedToolCall(preparation, signal, emit) };
    } else {
      finalized = {
        toolCall: preparation.kind === 'prepared' ? preparation.toolCall : toolCall,
        result: preparation.kind === 'immediate'
          ? preparation.result
          : errorToolResult('Tool call was not executed because its canonical arguments could not be persisted.'),
        isError: true,
      };
    }
    await emitToolExecutionEnd(finalized, emit);
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    finalizedCalls.push(finalized);
    messages.push(message);
    if (admitted) historyMessages.push(message);
  }
  return { messages, historyMessages, admissions, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

async function executeToolCallsParallel(
  context: KernelContext,
  toolCalls: CanonicalizedToolCall[],
  signal: AbortSignal,
  emit: KernelEventSink,
  admit: KernelAgentOptions['admitToolCall'],
): Promise<ExecutedToolBatch> {
  const entries: Array<{ readonly entry: FinalizedToolEntry; readonly includeInHistory: boolean }> = [];
  const admissions: ToolCallAdmissionRecord[] = [];
  for (const { providerToolCallId, toolCall } of toolCalls) {
    if (signal.aborted) break;
    const preparation = await prepareToolCall(context, toolCall);
    if (signal.aborted) break;
    const admission = await admitAndEmit(preparation.admission, providerToolCallId, admit, emit);
    admissions.push(admission);
    const admitted = preparation.kind === 'prepared' && admission.decision.execute;
    if (!admitted) {
      const finalized = {
        toolCall: preparation.kind === 'prepared' ? preparation.toolCall : toolCall,
        result: preparation.kind === 'immediate'
          ? preparation.result
          : errorToolResult('Tool call was not executed because its canonical arguments could not be persisted.'),
        isError: true,
      };
      await emitToolExecutionEnd(finalized, emit);
      entries.push({ entry: finalized, includeInHistory: false });
    } else if (signal.aborted) {
      const finalized = abortedPreparedToolCall(preparation);
      await emitToolExecutionEnd(finalized, emit);
      entries.push({ entry: finalized, includeInHistory: true });
    } else {
      await emitToolExecutionStart(preparation.toolCall, emit);
      entries.push({ includeInHistory: true, entry: async () => {
        const finalized = signal.aborted
          ? abortedPreparedToolCall(preparation)
          : { toolCall: preparation.toolCall, ...await executePreparedToolCall(preparation, signal, emit) };
        await emitToolExecutionEnd(finalized, emit);
        return finalized;
      } });
    }
  }

  const finalizedCalls = await Promise.all(entries.map(({ entry }) => (
    typeof entry === 'function' ? entry() : Promise.resolve(entry)
  )));
  const messages: ToolResultMessage[] = [];
  const historyMessages: ToolResultMessage[] = [];
  for (const [index, finalized] of finalizedCalls.entries()) {
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    messages.push(message);
    if (entries[index]?.includeInHistory) historyMessages.push(message);
  }
  return { messages, historyMessages, admissions, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

async function prepareToolCall(
  context: KernelContext,
  toolCall: AgentToolCall,
): Promise<PreparedToolCall | ImmediateToolCall> {
  const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return {
      kind: 'immediate',
      result: errorToolResult('Tool is not exposed by the active registry.'),
      isError: true,
      admission: {
        toolCallId: toolCall.id,
        providerName: toolCall.name,
        outcome: {
          type: 'rejected',
          identity: null,
          arguments: toolCall.arguments,
          reason: 'unresolvedTool',
          correction: evidenceCorrection('unresolvedTool'),
        },
      },
    };
  }
  const identity = canonicalToolIdentity(tool);
  try {
    const preparedArguments = tool.prepareArguments
      ? tool.prepareArguments(toolCall.arguments)
      : toolCall.arguments;
    const preparedCall = preparedArguments === toolCall.arguments
      ? toolCall
      : { ...toolCall, arguments: preparedArguments as Record<string, any> };
    const args = validateToolArguments(tool, preparedCall);
    const canonicalArguments = JSON.parse(JSON.stringify(args ?? null)) as import('../../../../core/agent/protocol').JsonValue;
    const canonicalCall = { ...toolCall, arguments: canonicalArguments as Record<string, any> };
    const redacted = redactSecretLikeJson(canonicalArguments);
    let redactedArgumentsReplayable = true;
    if (redacted.redactedPaths.length > 0) {
      try {
        validateToolArguments(tool, {
          ...canonicalCall,
          arguments: redacted.value as Record<string, any>,
        });
      } catch {
        redactedArgumentsReplayable = false;
      }
    }
    return {
      kind: 'prepared',
      toolCall: canonicalCall,
      tool,
      args,
      admission: {
        toolCallId: toolCall.id,
        providerName: toolCall.name,
        outcome: {
          type: 'admitted',
          identity,
          arguments: canonicalArguments,
          schemaDigest: modelToolSchemaDigest(tool.parameters),
          redactedArgumentsReplayable,
        },
      },
    };
  } catch (error) {
    return {
      kind: 'immediate',
      result: errorToolResult(errorMessage(error)),
      isError: true,
      admission: {
        toolCallId: toolCall.id,
        providerName: toolCall.name,
        outcome: {
          type: 'rejected',
          identity,
          arguments: toolCall.arguments,
          reason: 'invalidArguments',
          correction: evidenceCorrection('invalidArguments'),
        },
      },
    };
  }
}

function abortedPreparedToolCall(prepared: PreparedToolCall): FinalizedToolCall {
  return {
    toolCall: prepared.toolCall,
    result: errorToolResult('Operation aborted'),
    isError: true,
  };
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal,
  emit: KernelEventSink,
): Promise<ExecutedToolCall> {
  const updates: Promise<void>[] = [];
  let acceptingUpdates = true;
  try {
    const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, (partialResult) => {
      if (!acceptingUpdates) return;
      updates.push(Promise.resolve(emit({
        type: 'tool_execution_update',
        toolCallId: prepared.toolCall.id,
        toolName: prepared.toolCall.name,
        partialResult,
      })));
    });
    acceptingUpdates = false;
    await Promise.all(updates);
    return { result, isError: false };
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updates);
    return { result: errorToolResult(errorMessage(error)), isError: true };
  } finally {
    acceptingUpdates = false;
  }
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCall[]): boolean {
  return finalizedCalls.length > 0
    && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function errorToolResult(message: string): AgentToolResult<Record<string, never>> {
  return { content: [{ type: 'text', text: message }], details: {} };
}

async function emitToolExecutionStart(toolCall: AgentToolCall, emit: KernelEventSink): Promise<void> {
  await emit({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
}

async function admitAndEmit(
  request: ToolCallAdmissionRequest,
  providerToolCallId: string,
  admit: KernelAgentOptions['admitToolCall'],
  emit: KernelEventSink,
): Promise<ToolCallAdmissionRecord> {
  let decision: ToolCallAdmissionDecision;
  try {
    decision = admit ? await admit(request) : transientToolCallAdmission(request);
  } catch {
    decision = persistenceFailureAdmission(request);
  }
  await emit({
    type: 'tool_call_admission',
    toolCallId: request.toolCallId,
    providerToolCallId,
    toolName: request.providerName,
    decision,
  });
  return {
    providerToolCallId,
    toolCallId: request.toolCallId,
    decision,
  };
}

function liveAssistantToolHistory(
  message: AssistantMessage,
  admissions: readonly ToolCallAdmissionRecord[],
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  let admissionIndex = 0;
  for (const part of message.content) {
    if (part.type !== 'toolCall') {
      content.push(part);
      continue;
    }
    const admission = admissions[admissionIndex];
    admissionIndex += 1;
    if (!admission) continue;
    const { modelCall } = admission.decision;
    if (!admission.decision.execute) {
      content.push({
        type: 'text' as const,
        text: modelCall.disposition === 'evidenceOnly'
          ? toolCallEvidenceText(admission.toolCallId, modelCall)
          : `[Tool call ${admission.toolCallId} was not executed.]`,
      });
      continue;
    }
    content.push({
      ...part,
      id: admission.toolCallId,
    });
  }
  return { ...message, content };
}

function historicalToolCallIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'toolCall' && part.id.trim()) ids.add(part.id);
      }
    } else if (message.role === 'toolResult' && message.toolCallId.trim()) {
      ids.add(message.toolCallId);
    }
  }
  return ids;
}

function canonicalizeToolCallIds(
  toolCalls: readonly AgentToolCall[],
  usedIds: Set<string>,
): CanonicalizedToolCall[] {
  return toolCalls.map((toolCall) => {
    let canonicalId = toolCall.id;
    if (!canonicalId.trim() || usedIds.has(canonicalId)) {
      do canonicalId = uuidV7(); while (usedIds.has(canonicalId));
    }
    usedIds.add(canonicalId);
    return {
      providerToolCallId: toolCall.id,
      toolCall: canonicalId === toolCall.id ? toolCall : { ...toolCall, id: canonicalId },
    };
  });
}

async function emitToolExecutionEnd(finalized: FinalizedToolCall, emit: KernelEventSink): Promise<void> {
  await emit({
    type: 'tool_execution_end',
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(finalized: FinalizedToolCall): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content ?? [],
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function emitToolResultMessage(message: ToolResultMessage, emit: KernelEventSink): Promise<void> {
  await emit({ type: 'message_start', message });
  await emit({ type: 'message_end', message });
}

function errorMessage(error: unknown): string {
  return redactSecretLikeContent(error instanceof Error ? error.message : String(error));
}
