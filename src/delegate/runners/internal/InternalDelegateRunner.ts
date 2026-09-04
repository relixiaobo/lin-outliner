import type { DelegateUsage } from '../../contract';
import {
  canonicalModelToolKey,
  type ModelToolActionKind,
  type ModelToolContract,
} from '../../../core/agent/tools';
import {
  delegatedBashExecutionAllowed,
  delegatedToolContractAllowed,
  delegatedToolExecutionAllowed,
  type DelegatedToolPolicy,
} from '../../../main/agent/delegation/delegatedToolPolicy';
import {
  evaluateAgentToolCapability,
} from '../../../main/agent/capabilities/agentCapabilities';
import { HostToolDenial } from '../../../main/agent/runtime/kernel/HostToolDenial';
import { NativeAgentRuntime } from '../../../main/agent/runtime/kernel/NativeAgentRuntime';
import type { ModelGateway } from '../../../main/agent/runtime/kernel/ModelGateway';
import type {
  AgentEvent,
  AgentTool,
  Api,
  AssistantMessage,
  KernelAgentOptions,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from '../../../main/agent/runtime/kernel/types';
import type { ToolCallAdmissionDecision, ToolCallAdmissionRequest } from '../../../main/agent/runtime/toolCallHistory';

export interface InternalDelegateRunInput {
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly model: Model<Api>;
  readonly thinkingLevel: ThinkingLevel;
  readonly history: readonly Message[];
  readonly prompt: Message;
  readonly tools: readonly AgentTool[];
  readonly toolRegistry: readonly ModelToolContract[];
  readonly toolPolicy: DelegatedToolPolicy;
  readonly workspaceRoot: string;
  readonly capabilityConfig?: unknown;
  readonly gateway: ModelGateway;
  readonly getApiKey: NonNullable<KernelAgentOptions['getApiKey']>;
  readonly providerOptions?: Omit<SimpleStreamOptions, 'apiKey' | 'signal' | 'sessionId'>;
  readonly retryOptions?: KernelAgentOptions['retryOptions'];
  readonly admitToolCall?: (request: ToolCallAdmissionRequest) => Promise<ToolCallAdmissionDecision>;
  readonly onEvent?: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
  readonly signal: AbortSignal;
}

export interface InternalDelegateRunResult {
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly messages: readonly Message[];
  readonly terminalAssistant: AssistantMessage | null;
  readonly text: string | null;
  readonly error: string | null;
  readonly partialEvidence: boolean;
  readonly usage: DelegateUsage;
  readonly durationMs: number;
}

export interface InternalDelegateRunnerOptions {
  readonly createRuntime?: (options: KernelAgentOptions) => NativeAgentRuntime;
  readonly now?: () => number;
}

export class InternalDelegateRunner {
  private readonly active = new Map<string, NativeAgentRuntime>();
  private readonly createRuntime: (options: KernelAgentOptions) => NativeAgentRuntime;
  private readonly now: () => number;

  constructor(options: InternalDelegateRunnerOptions = {}) {
    this.createRuntime = options.createRuntime ?? ((runtimeOptions) => new NativeAgentRuntime(runtimeOptions));
    this.now = options.now ?? Date.now;
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  send(sessionId: string, message: Message, onDelivered?: () => void): boolean {
    if (message.role !== 'user') throw new Error('Delegation steering must be a user-context message');
    const runtime = this.active.get(sessionId);
    if (!runtime) return false;
    runtime.steer(message, onDelivered);
    return true;
  }

  stop(sessionId: string): boolean {
    const runtime = this.active.get(sessionId);
    if (!runtime) return false;
    runtime.abort();
    return true;
  }

  async run(input: InternalDelegateRunInput): Promise<InternalDelegateRunResult> {
    if (this.active.has(input.sessionId)) {
      throw new Error(`Internal Delegate Runner Session is already active: ${input.sessionId}`);
    }
    if (input.prompt.role !== 'user') throw new Error('Internal Delegate Runner prompt must be a user-context message');
    const startedAt = this.now();
    if (input.signal.aborted) return cancelledResult(this.now() - startedAt);
    const tools = delegatedAgentTools(input);
    const providerOptions = sanitizeProviderOptions(input.providerOptions);
    const runtime = this.createRuntime({
      initialState: {
        systemPrompt: input.systemPrompt,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        tools,
        messages: [...input.history],
      },
      gateway: input.gateway,
      getApiKey: input.getApiKey,
      providerOptions,
      retryOptions: input.retryOptions,
      admitToolCall: input.admitToolCall,
      sessionId: input.sessionId,
    });
    if (input.onEvent) runtime.subscribe(input.onEvent);
    const abort = () => runtime.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    this.active.set(input.sessionId, runtime);
    try {
      await runtime.prompt(input.prompt);
      return normalizeResult(
        runtime.state.messages.slice(input.history.length),
        input.signal.aborted,
        this.now() - startedAt,
      );
    } finally {
      input.signal.removeEventListener('abort', abort);
      this.active.delete(input.sessionId);
    }
  }
}

function delegatedAgentTools(input: InternalDelegateRunInput): AgentTool[] {
  const contracts = new Map(input.toolRegistry.map((contract) => [canonicalModelToolKey(contract.identity), contract]));
  return input.tools.flatMap((tool) => {
    const identity = tool.canonicalIdentity ?? { namespace: null, name: tool.name };
    const key = canonicalModelToolKey(identity);
    const contract = contracts.get(key);
    if (!contract) throw new Error(`Internal Delegate Runner tool has no canonical contract: ${key}`);
    if (!delegatedToolContractAllowed(contract, input.toolPolicy)) return [];
    const wrapped: AgentTool = {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const capability = evaluateAgentToolCapability({
          toolName: tool.name,
          args: params,
          actionKinds: contract.actionKinds,
          policy: {
            workspaceRoot: input.workspaceRoot,
            capabilityConfig: input.capabilityConfig,
          },
        });
        const actionKinds = capability.descriptors.map((descriptor) => descriptor.actionKind);
        const allowed = capability.behavior === 'allow' && (key === 'bash'
          ? delegatedBashExecutionAllowed(
              input.toolPolicy,
              actionKinds,
              capability.bashStdinConsumer ?? 'absent',
              booleanProperty(params, 'run_in_background'),
            )
          : delegatedToolExecutionAllowed(input.toolPolicy, actionKinds));
        if (!allowed) throw delegatedToolDenial(key, actionKinds);
        return await tool.execute(toolCallId, params, signal, onUpdate);
      },
    };
    return [wrapped];
  });
}

function delegatedToolDenial(tool: string, actionKinds: readonly ModelToolActionKind[]): HostToolDenial {
  return new HostToolDenial({
    code: 'delegation_tool_unavailable',
    message: `Tool action is unavailable in this delegated Session: ${tool}`,
    instructions: 'Continue within the delegated Session capability ceiling.',
    details: {
      reason: 'delegated_session_policy',
      tool,
      actionKinds: [...actionKinds],
    },
  });
}

function sanitizeProviderOptions(
  source: InternalDelegateRunInput['providerOptions'] | undefined,
): Omit<SimpleStreamOptions, 'apiKey' | 'signal' | 'sessionId'> | undefined {
  if (!source) return undefined;
  const unsafe = source as SimpleStreamOptions;
  const { apiKey: _apiKey, signal: _signal, sessionId: _sessionId, ...safe } = unsafe;
  return safe;
}

function normalizeResult(
  messages: readonly Message[],
  externallyAborted: boolean,
  durationMs: number,
): InternalDelegateRunResult {
  const terminalAssistant = [...messages].reverse()
    .find((message): message is AssistantMessage => message.role === 'assistant') ?? null;
  const outcome = externallyAborted || terminalAssistant?.stopReason === 'aborted'
    ? 'cancelled'
    : terminalAssistant?.stopReason === 'error' || !terminalAssistant
      ? 'failed'
      : 'succeeded';
  const text = terminalAssistant
    ? terminalAssistant.content
        .filter((part): part is Extract<AssistantMessage['content'][number], { readonly type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('') || null
    : null;
  const evidence = messages.some((message) => message.role === 'toolResult'
    || (message.role === 'assistant' && message.content.some((part) => (
      part.type === 'toolCall'
      || (part.type === 'text' && part.text.length > 0)
      || (part.type === 'thinking' && part.thinking.length > 0)
    ))));
  return {
    outcome,
    messages: [...messages],
    terminalAssistant,
    text,
    error: outcome === 'succeeded' ? null : terminalAssistant?.errorMessage ?? 'Internal Agent execution failed.',
    partialEvidence: outcome !== 'succeeded' && evidence,
    usage: summarizeUsage(messages),
    durationMs: Math.max(0, Math.floor(durationMs)),
  };
}

function summarizeUsage(messages: readonly Message[]): DelegateUsage {
  const assistants = messages.filter((message): message is AssistantMessage => message.role === 'assistant');
  const inputTokens = assistants.reduce((sum, message) => sum + message.usage.input, 0);
  const outputTokens = assistants.reduce((sum, message) => sum + message.usage.output, 0);
  const costUsd = assistants.reduce((sum, message) => sum + message.usage.cost.total, 0);
  if (inputTokens === 0 && outputTokens === 0 && costUsd === 0) return { state: 'unknown' };
  return {
    state: 'known',
    inputTokens,
    outputTokens,
    ...(costUsd > 0 ? { costUsd } : {}),
  };
}

function cancelledResult(durationMs: number): InternalDelegateRunResult {
  return {
    outcome: 'cancelled',
    messages: [],
    terminalAssistant: null,
    text: null,
    error: 'Internal Agent execution was cancelled before it started.',
    partialEvidence: false,
    usage: { state: 'unknown' },
    durationMs: Math.max(0, Math.floor(durationMs)),
  };
}

function booleanProperty(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>)[key] === true;
}
