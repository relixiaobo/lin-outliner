import { createHash } from 'node:crypto';
import {
  SUBAGENT_BUDGET_EXHAUSTED_ERROR_CODE,
  type JsonValue,
  type ModelProviderToolCall,
  type TurnError,
} from '../../../../core/agent/protocol';
import { portableProviderToolCallId } from '../../../../core/agent/providerToolCallIdentity';
import { modelToolContract, type JsonSchema } from '../../../../core/agent/tools';
import { streamWithPolicy } from './retryPolicy';
import {
  redactSecretLikeContent,
} from '../../capabilities/agentSecretRedaction';
import { scanSecretStrings } from '../../capabilities/agentSecretStringScanner';
import type {
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AssistantMessage,
  KernelAgentOptions,
  KernelEvent,
  Message,
  NativeAgentToolResult,
  TenonAgentToolResult,
  ToolResultMessage,
} from './types';
import {
  canonicalToolIdentity,
  evidenceCorrection,
  modelToolSchemaDigest,
  persistenceFailureAdmission,
  prepareToolCallArguments,
  rewriteAssistantToolCallHistory,
  toolCallEvidenceText,
  transientToolCallAdmission,
  type ToolCallAdmissionDecision,
  type ToolCallAdmissionRequest,
} from '../toolCallHistory';
import { uuidV7 } from '../../uuid';
import { HostToolDenial } from './HostToolDenial';
import { compileToolParameters, validateExactToolArguments } from './exactToolArguments';

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

const MAX_DETERMINISTIC_ADMISSION_FAILURES = 8;
const MAX_TENON_RESULT_DATA_BYTES = 256 * 1024;
const MAX_TENON_RESULT_INSTRUCTIONS_LENGTH = 8_000;
const MAX_TENON_RESULT_WARNINGS = 20;
const MAX_TENON_RESULT_WARNING_LENGTH = 2_000;
const MAX_TENON_RESULT_ERROR_CODE_LENGTH = 128;
const MAX_TENON_RESULT_ERROR_MESSAGE_LENGTH = 2_000;

type DeterministicAdmissionFailureReason = Extract<
  ToolCallAdmissionRequest['outcome'],
  { readonly type: 'rejected' }
>['reason'];

/**
 * Truncation is a property of the response's output-token limit, not of the tool:
 * the same call succeeds as soon as the model writes shorter arguments, which is
 * exactly what the rejection message asks it to do. Quarantining there would answer
 * a compliant retry with "Tool is not exposed by the active registry", so truncation
 * only counts toward the Turn ceiling — enough to stop a Turn that never progresses.
 */
function quarantines(reason: DeterministicAdmissionFailureReason): boolean {
  return reason !== 'truncatedArguments';
}

class TurnAdmissionFailureGuard {
  private readonly occurrences = new Map<string, number>();
  private readonly quarantinedTools = new Set<string>();
  private deterministicFailureCount = 0;
  private finalToolFreeRequestIssued = false;

  beginProviderRequest(tools: readonly AgentTool[]): {
    readonly tools: AgentTool[];
    readonly finalToolFreeRequest: boolean;
  } {
    if (this.deterministicFailureCount >= MAX_DETERMINISTIC_ADMISSION_FAILURES) {
      this.finalToolFreeRequestIssued = true;
      return { tools: [], finalToolFreeRequest: true };
    }
    return {
      tools: tools.filter((tool) => !this.quarantinedTools.has(toolIdentityKey(tool))),
      finalToolFreeRequest: false,
    };
  }

  record(
    toolCall: AgentToolCall,
    tool: AgentTool | null,
    reason: DeterministicAdmissionFailureReason,
  ): void {
    this.deterministicFailureCount += 1;
    const fingerprint = deterministicAdmissionFailureFingerprint(toolCall, tool, reason);
    const count = (this.occurrences.get(fingerprint) ?? 0) + 1;
    this.occurrences.set(fingerprint, count);
    if (tool && count >= 2 && quarantines(reason)) {
      this.quarantinedTools.add(toolIdentityKey(tool));
    }
  }

  shouldEndAfter(finalToolFreeRequest: boolean): boolean {
    return finalToolFreeRequest && this.finalToolFreeRequestIssued;
  }
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
  const usedProviderToolCallIds = historicalToolCallIds(context.messages);
  const admissionFailureGuard = new TurnAdmissionFailureGuard();

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

    const request = admissionFailureGuard.beginProviderRequest(context.tools);
    const requestContext: KernelContext = { ...context, tools: request.tools };
    const message = await streamAssistantResponse(requestContext, options, signal, emit);
    providerCallCount += 1;
    newMessages.push(message);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      await emit({ type: 'turn_end', message, toolResults: [] });
      await emit({ type: 'agent_end', messages: newMessages });
      return { messages: newMessages, interruptionError: null };
    }

    const providerToolCalls = message.content.filter((part): part is AgentToolCall => part.type === 'toolCall');
    const toolCalls = canonicalizeToolCalls(message, providerToolCalls, usedProviderToolCallIds);
    const toolResults: ToolResultMessage[] = [];
    hasMoreToolCalls = false;
    if (toolCalls.length > 0) {
      const batch = message.stopReason === 'length'
        ? await failTruncatedToolCalls(
            requestContext,
            toolCalls,
            signal,
            emit,
            options.admitToolCall,
            admissionFailureGuard,
          )
        : await executeToolCalls(
            requestContext,
            toolCalls,
            signal,
            emit,
            options.admitToolCall,
            admissionFailureGuard,
          );
      toolResults.push(...batch.messages);
      hasMoreToolCalls = !batch.terminate && !signal.aborted;
      const liveAssistant = rewriteAssistantToolCallHistory(message, batch.admissions);
      context.messages[context.messages.length - 1] = liveAssistant;
      newMessages[newMessages.length - 1] = liveAssistant;
      for (const result of batch.historyMessages) {
        context.messages.push(result);
        newMessages.push(result);
      }
    }

    await emit({ type: 'turn_end', message, toolResults });
    if (admissionFailureGuard.shouldEndAfter(request.finalToolFreeRequest)) break;
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
    recoverOptionalContextOverflow: options.recoverOptionalContextOverflow,
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
      case 'start': {
        const nextPartial = event.partial;
        if (addedPartial) {
          if (partialMessage) {
            await emit({ type: 'message_restart', message: { ...partialMessage } });
          }
          context.messages[context.messages.length - 1] = nextPartial;
        } else {
          context.messages.push(nextPartial);
          addedPartial = true;
        }
        partialMessage = nextPartial;
        await emit({ type: 'message_start', message: { ...partialMessage } });
        break;
      }
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
  readonly activeProviderToolCallId: string;
  readonly providerCall: ModelProviderToolCall;
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
  tool: AgentTool<any> | null;
  result: NativeAgentToolResult<any>;
  isError: boolean;
  admission: ToolCallAdmissionRequest;
}

interface ToolCallAdmissionRecord {
  readonly providerToolCallId: string;
  readonly toolCallId: string;
  readonly decision: ToolCallAdmissionDecision;
  readonly completed: boolean;
}

interface ExecutedToolCall {
  result: NativeAgentToolResult<any>;
  isError: boolean;
}

interface FinalizedToolCall extends ExecutedToolCall {
  toolCall: AgentToolCall;
  providerToolCallId: string;
}

type FinalizedToolEntry = FinalizedToolCall | (() => Promise<FinalizedToolCall>);

async function failTruncatedToolCalls(
  context: KernelContext,
  toolCalls: CanonicalizedToolCall[],
  signal: AbortSignal,
  emit: KernelEventSink,
  admit: KernelAgentOptions['admitToolCall'],
  admissionFailureGuard: TurnAdmissionFailureGuard,
): Promise<ExecutedToolBatch> {
  const messages: ToolResultMessage[] = [];
  const admissions: ToolCallAdmissionRecord[] = [];
  for (const call of toolCalls) {
    const { toolCall } = call;
    if (signal.aborted) break;
    const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
    const request = await rejectedToolCallAdmissionRequest(
      toolCall,
      call.providerCall,
      tool ? canonicalToolIdentity(tool) : null,
      'truncatedArguments',
    );
    if (signal.aborted) break;
    const admission = await admitAndEmit(request, admit, emit);
    admissions.push(admission);
    recordDeterministicAdmissionFailure(
      admissionFailureGuard,
      request,
      toolCall,
      tool ?? null,
      admission,
    );
    const finalized: FinalizedToolCall = {
      toolCall,
      providerToolCallId: call.activeProviderToolCallId,
      result: errorToolResult(
        'invalid_arguments',
        `Tool call "${toolCall.name}" was not executed because its arguments may be truncated. Re-issue the call with complete arguments.`,
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
  admissionFailureGuard: TurnAdmissionFailureGuard,
): Promise<ExecutedToolBatch> {
  const hasSequentialTool = toolCalls.some(({ toolCall }) => (
    context.tools.find((tool) => tool.name === toolCall.name)?.executionMode === 'sequential'
  ));
  return !hasSequentialTool
    ? executeToolCallsParallel(context, toolCalls, signal, emit, admit, admissionFailureGuard)
    : executeToolCallsSequential(context, toolCalls, signal, emit, admit, admissionFailureGuard);
}

async function executeToolCallsSequential(
  context: KernelContext,
  toolCalls: CanonicalizedToolCall[],
  signal: AbortSignal,
  emit: KernelEventSink,
  admit: KernelAgentOptions['admitToolCall'],
  admissionFailureGuard: TurnAdmissionFailureGuard,
): Promise<ExecutedToolBatch> {
  const finalizedCalls: FinalizedToolCall[] = [];
  const messages: ToolResultMessage[] = [];
  const historyMessages: ToolResultMessage[] = [];
  const admissions: ToolCallAdmissionRecord[] = [];
  for (const call of toolCalls) {
    const { toolCall } = call;
    if (signal.aborted) break;
    const preparation = await prepareToolCall(context, call);
    if (signal.aborted) break;
    const admission = await admitAndEmit(preparation.admission, admit, emit);
    admissions.push(admission);
    recordDeterministicAdmissionFailure(
      admissionFailureGuard,
      preparation.admission,
      toolCall,
      preparation.tool,
      admission,
    );
    const admitted = preparation.kind === 'prepared' && admission.decision.execute;
    let finalized: FinalizedToolCall;
    if (preparation.kind === 'prepared' && admission.decision.execute) {
      if (!signal.aborted) await emitToolExecutionStart(preparation.toolCall, emit);
      finalized = signal.aborted
        ? abortedPreparedToolCall(preparation)
        : {
            toolCall: preparation.toolCall,
            providerToolCallId: call.activeProviderToolCallId,
            ...await executePreparedToolCall(preparation, signal, emit),
          };
    } else {
      finalized = {
        toolCall: preparation.kind === 'prepared' ? preparation.toolCall : toolCall,
        providerToolCallId: call.activeProviderToolCallId,
        result: preparation.kind === 'immediate'
          ? preparation.result
          : errorToolResult('operation_unavailable', 'Tool call arguments could not be persisted.'),
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
  admissionFailureGuard: TurnAdmissionFailureGuard,
): Promise<ExecutedToolBatch> {
  const entries: Array<{ readonly entry: FinalizedToolEntry; readonly includeInHistory: boolean }> = [];
  const admissions: ToolCallAdmissionRecord[] = [];
  for (const call of toolCalls) {
    const { toolCall } = call;
    if (signal.aborted) break;
    const preparation = await prepareToolCall(context, call);
    if (signal.aborted) break;
    const admission = await admitAndEmit(preparation.admission, admit, emit);
    admissions.push(admission);
    recordDeterministicAdmissionFailure(
      admissionFailureGuard,
      preparation.admission,
      toolCall,
      preparation.tool,
      admission,
    );
    const admitted = preparation.kind === 'prepared' && admission.decision.execute;
    if (!admitted) {
      const finalized = {
        toolCall: preparation.kind === 'prepared' ? preparation.toolCall : toolCall,
        providerToolCallId: call.activeProviderToolCallId,
        result: preparation.kind === 'immediate'
          ? preparation.result
          : errorToolResult('operation_unavailable', 'Tool call arguments could not be persisted.'),
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
          : {
              toolCall: preparation.toolCall,
              providerToolCallId: call.activeProviderToolCallId,
              ...await executePreparedToolCall(preparation, signal, emit),
            };
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
  call: CanonicalizedToolCall,
): Promise<PreparedToolCall | ImmediateToolCall> {
  const { toolCall, providerCall } = call;
  const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return {
      kind: 'immediate',
      tool: null,
      result: errorToolResult('tool_not_exposed', 'Tool is not exposed by the active registry.'),
      isError: true,
      admission: await rejectedToolCallAdmissionRequest(toolCall, providerCall, null, 'unresolvedTool'),
    };
  }
  const identity = canonicalToolIdentity(tool);
  try {
    // Keep provider-authored history independent from tool-owned defaults and
    // presentation normalization. Execution receives its own clone below.
    const providerArguments = structuredClone(toolCall.arguments);
    const preparedArguments = tool.prepareArguments
      ? tool.prepareArguments(structuredClone(providerArguments))
      : providerArguments;
    const args = structuredClone(validateExactToolArguments(tool, preparedArguments));
    const historyArguments = await prepareToolCallArguments(providerArguments ?? null, tool.largeTextArguments);
    const displayArguments = await prepareToolCallArguments(args ?? null, tool.largeTextArguments);
    let redactedArgumentsReplayable = true;
    if (historyArguments.redactedPaths.length > 0) {
      try {
        validateExactToolArguments(tool, historyArguments.redactedArguments);
      } catch {
        redactedArgumentsReplayable = false;
      }
    }
    return {
      kind: 'prepared',
      toolCall,
      tool,
      args,
      admission: {
        toolCallId: toolCall.id,
        providerName: toolCall.name,
        providerCall,
        outcome: {
          type: 'admitted',
          identity,
          arguments: historyArguments.arguments,
          redactedArguments: historyArguments.redactedArguments,
          redactedPaths: historyArguments.redactedPaths,
          displayArguments: displayArguments.redactedArguments,
          schemaDigest: modelToolSchemaDigest(tool.parameters),
          redactedArgumentsReplayable,
          ...(tool.largeTextArguments === undefined ? {} : { largeTextArguments: tool.largeTextArguments }),
        },
      },
    };
  } catch (error) {
    return {
      kind: 'immediate',
      tool,
      result: errorToolResult('invalid_arguments', errorMessage(error)),
      isError: true,
      admission: await rejectedToolCallAdmissionRequest(toolCall, providerCall, identity, 'invalidArguments'),
    };
  }
}

async function rejectedToolCallAdmissionRequest(
  toolCall: AgentToolCall,
  providerCall: ModelProviderToolCall,
  identity: import('../../../../core/agent/protocol').ModelToolIdentity | null,
  reason: Extract<ToolCallAdmissionRequest['outcome'], { readonly type: 'rejected' }>['reason'],
): Promise<ToolCallAdmissionRequest> {
  const redacted = await prepareToolCallArguments(toolCall.arguments);
  return {
    toolCallId: toolCall.id,
    providerName: toolCall.name,
    providerCall,
    outcome: {
      type: 'rejected',
      identity,
      redactedArguments: redacted.redactedArguments,
      reason,
      correction: evidenceCorrection(reason),
    },
  };
}

function abortedPreparedToolCall(prepared: PreparedToolCall): FinalizedToolCall {
  return {
    toolCall: prepared.toolCall,
    providerToolCallId: prepared.admission.providerCall.id,
    result: errorToolResult('aborted', 'Operation aborted.'),
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
    return finalizeToolResult(prepared.tool, result);
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updates);
    if (error instanceof HostToolDenial) return hostDeniedToolResult(error);
    const aborted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
    return {
      result: errorToolResult(
        aborted ? 'aborted' : 'execution_failed',
        aborted ? 'Operation aborted.' : errorMessage(error),
      ),
      isError: true,
    };
  } finally {
    acceptingUpdates = false;
  }
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCall[]): boolean {
  return finalizedCalls.length > 0
    && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function finalizeToolResult(
  tool: AgentTool,
  result: AgentToolResult<unknown>,
): ExecutedToolCall {
  const contract = modelToolContract(canonicalToolIdentity(tool));
  if (!result || typeof result !== 'object' || (result.kind !== 'native' && result.kind !== 'tenon')) {
    return {
      result: errorToolResult('invalid_internal_result', 'The tool returned a malformed internal result.'),
      isError: true,
    };
  }
  if (contract === null) {
    if (result.kind === 'native') return { result, isError: false };
    return {
      result: errorToolResult('invalid_internal_result', 'An owner-native tool returned a non-native result.'),
      isError: true,
    };
  }
  if (result.kind !== 'tenon') {
    return {
      result: errorToolResult('invalid_internal_result', 'A Tenon tool bypassed the semantic result protocol.'),
      isError: true,
    };
  }
  const schemaIssue = tenonResultSchemaIssue(contract.outputSchema, result);
  if (schemaIssue !== null) {
    return {
      result: errorToolResult('invalid_internal_result', schemaIssue),
      isError: true,
    };
  }
  return { result: compileTenonToolResult(result), isError: false };
}

function hostDeniedToolResult(error: HostToolDenial): ExecutedToolCall {
  const result: TenonAgentToolResult<JsonValue> = {
    kind: 'tenon',
    outcome: {
      ok: false,
      status: 'denied',
      error: { code: error.denial.code, message: error.denial.message },
    },
    ...(error.denial.instructions === undefined ? {} : { instructions: error.denial.instructions }),
    content: [],
    details: error.denial.details,
  };
  const shapeIssue = tenonResultShapeIssue(result);
  return shapeIssue === null
    ? { result: compileTenonToolResult(result), isError: false }
    : {
        result: errorToolResult('invalid_internal_result', shapeIssue),
        isError: true,
      };
}

function tenonResultSchemaIssue(
  schema: JsonSchema | null | undefined,
  result: TenonAgentToolResult<unknown>,
): string | null {
  const shapeIssue = tenonResultShapeIssue(result);
  if (shapeIssue !== null) return shapeIssue;
  if (schema === undefined) return 'The Tenon tool contract does not declare an output schema.';
  if (result.data === undefined) {
    return result.outcome.ok && schema !== null
      ? 'A successful Tenon tool result omitted its declared data.'
      : null;
  }
  if (schema === null) return 'A Tenon tool declared no output data but returned data.';
  try {
    const validator = compileToolParameters(schema as import('typebox').TSchema);
    return validator.Check(result.data) ? null : 'Tenon tool result data does not match its output schema.';
  } catch {
    return 'The Tenon tool output schema is invalid.';
  }
}

function tenonResultShapeIssue(result: TenonAgentToolResult<unknown>): string | null {
  if (!hasOnlyKeys(result, [
    'kind',
    'outcome',
    'data',
    'instructions',
    'warnings',
    'content',
    'details',
    'terminate',
    'resourceRefs',
    'persistedTextReplacements',
  ])) return 'The Tenon tool returned unexpected result fields.';
  if (!result.outcome || typeof result.outcome !== 'object' || Array.isArray(result.outcome) || typeof result.outcome.ok !== 'boolean') {
    return 'The Tenon tool returned a malformed outcome.';
  }
  if (result.outcome.ok) {
    if (!hasOnlyKeys(result.outcome, ['ok', 'status'])) return 'The Tenon tool returned unexpected success outcome fields.';
    if (result.outcome.status !== undefined && result.outcome.status !== 'unchanged' && result.outcome.status !== 'partial') {
      return 'The Tenon tool returned an invalid success status.';
    }
  } else {
    if (!hasOnlyKeys(result.outcome, ['ok', 'status', 'error'])) return 'The Tenon tool returned unexpected failure outcome fields.';
    if (result.outcome.status !== undefined && result.outcome.status !== 'denied') {
      return 'The Tenon tool returned an invalid failure status.';
    }
    if (
      !result.outcome.error
      || typeof result.outcome.error !== 'object'
      || Array.isArray(result.outcome.error)
      || !hasOnlyKeys(result.outcome.error, ['code', 'message'])
      || typeof result.outcome.error.code !== 'string'
      || typeof result.outcome.error.message !== 'string'
      || result.outcome.error.code.length === 0
      || result.outcome.error.message.length === 0
    ) {
      return 'The Tenon tool returned a malformed error outcome.';
    }
    if (result.outcome.error.code.length > MAX_TENON_RESULT_ERROR_CODE_LENGTH) {
      return 'The Tenon tool error code exceeds the result limit.';
    }
    if (result.outcome.error.message.length > MAX_TENON_RESULT_ERROR_MESSAGE_LENGTH) {
      return 'The Tenon tool error message exceeds the result limit.';
    }
  }
  if (result.instructions !== undefined) {
    if (typeof result.instructions !== 'string') return 'The Tenon tool returned malformed instructions.';
    if (result.instructions.length > MAX_TENON_RESULT_INSTRUCTIONS_LENGTH) {
      return 'The Tenon tool instructions exceed the result limit.';
    }
  }
  if (result.warnings !== undefined) {
    if (!Array.isArray(result.warnings) || result.warnings.length > MAX_TENON_RESULT_WARNINGS) {
      return 'The Tenon tool warnings exceed the result limit.';
    }
    if (result.warnings.some((warning) => typeof warning !== 'string' || warning.length > MAX_TENON_RESULT_WARNING_LENGTH)) {
      return 'A Tenon tool warning exceeds the result limit.';
    }
  }
  if (!Array.isArray(result.content) || result.content.some((part) => (
    !part
    || typeof part !== 'object'
    || Array.isArray(part)
    || (part.type === 'text'
      ? typeof part.text !== 'string'
      : part.type === 'image'
        ? typeof part.data !== 'string' || typeof part.mimeType !== 'string'
        : true)
  ))) return 'The Tenon tool returned malformed supplemental content.';
  if (result.terminate !== undefined && typeof result.terminate !== 'boolean') {
    return 'The Tenon tool returned a malformed termination flag.';
  }
  if (result.data === undefined) {
    return null;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(result.data), 'utf8') > MAX_TENON_RESULT_DATA_BYTES) {
      return 'The Tenon tool result data exceeds the result limit.';
    }
    return null;
  } catch {
    return 'The Tenon tool result data is not serializable JSON.';
  }
}

function compileTenonToolResult(
  result: TenonAgentToolResult<unknown>,
): NativeAgentToolResult<unknown> {
  const header = {
    ok: result.outcome.ok,
    ...(result.outcome.status === undefined ? {} : { status: result.outcome.status }),
    ...(result.outcome.ok ? {} : { error: result.outcome.error }),
    ...(result.data === undefined ? {} : { data: result.data }),
    ...(result.instructions?.trim() ? { instructions: result.instructions } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
  const serialized = JSON.stringify(header);
  const redacted = scanSecretStrings([{ content: serialized, inspectEncodedJson: true }])[0]
    ?? '{"ok":false,"error":{"code":"invalid_internal_result","message":"Tool result redaction failed."}}';
  return {
    kind: 'native',
    content: [{ type: 'text', text: redacted }, ...result.content],
    details: result.details,
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
    ...(result.resourceRefs === undefined ? {} : { resourceRefs: result.resourceRefs }),
    ...(result.persistedTextReplacements === undefined
      ? {}
      : { persistedTextReplacements: result.persistedTextReplacements }),
  };
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function errorToolResult(code: string, message: string): NativeAgentToolResult<Record<string, never>> {
  return {
    kind: 'native',
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message } }) }],
    details: {},
  };
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
  admit: KernelAgentOptions['admitToolCall'],
  emit: KernelEventSink,
): Promise<ToolCallAdmissionRecord> {
  let decision: ToolCallAdmissionDecision;
  let completed = true;
  try {
    decision = admit ? await admit(request) : transientToolCallAdmission(request);
  } catch {
    completed = false;
    decision = persistenceFailureAdmission(request);
  }
  await emit({
    type: 'tool_call_admission',
    toolCallId: request.toolCallId,
    providerToolCallId: request.providerCall.id,
    toolName: request.providerName,
    decision,
  });
  return {
    providerToolCallId: request.providerCall.id,
    toolCallId: request.toolCallId,
    decision,
    completed,
  };
}

function recordDeterministicAdmissionFailure(
  guard: TurnAdmissionFailureGuard,
  request: ToolCallAdmissionRequest,
  toolCall: AgentToolCall,
  tool: AgentTool | null,
  admission: ToolCallAdmissionRecord,
): void {
  if (!admission.completed || request.outcome.type !== 'rejected') return;
  guard.record(toolCall, tool, request.outcome.reason);
}

function deterministicAdmissionFailureFingerprint(
  toolCall: AgentToolCall,
  tool: AgentTool | null,
  reason: DeterministicAdmissionFailureReason,
): string {
  const identity = tool ? canonicalToolIdentity(tool) : null;
  return createHash('sha256').update(stableJson([
    identity ?? { providerName: toolCall.name },
    tool ? modelToolSchemaDigest(tool.parameters) : null,
    toolCall.arguments,
    reason,
  ])).digest('hex');
}

function toolIdentityKey(tool: AgentTool): string {
  const identity = canonicalToolIdentity(tool);
  return identity.namespace === null ? identity.name : `${identity.namespace}.${identity.name}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(',')}}`;
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

function canonicalizeToolCalls(
  message: AssistantMessage,
  toolCalls: readonly AgentToolCall[],
  usedIds: Set<string>,
): CanonicalizedToolCall[] {
  return toolCalls.map((toolCall) => {
    let toolCallId: string;
    let portableId: string;
    do {
      toolCallId = uuidV7();
      portableId = portableProviderToolCallId(toolCallId);
    } while (usedIds.has(portableId));
    const activeProviderToolCallId = toolCall.id.trim() && !usedIds.has(toolCall.id)
      ? toolCall.id
      : portableId;
    usedIds.add(activeProviderToolCallId);
    return {
      activeProviderToolCallId,
      providerCall: {
        id: activeProviderToolCallId,
        api: message.api,
        provider: message.provider,
        model: message.model,
        thoughtSignature: toolCall.thoughtSignature?.length ? toolCall.thoughtSignature : null,
      },
      toolCall: { ...toolCall, id: toolCallId },
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
    toolCallId: finalized.providerToolCallId,
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
  return redactSecretLikeContent(error instanceof Error ? error.message : String(error))
    .slice(0, MAX_TENON_RESULT_ERROR_MESSAGE_LENGTH);
}
