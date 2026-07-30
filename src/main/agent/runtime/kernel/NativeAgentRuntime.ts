import { runKernel, type KernelSteeringMessage } from './kernel';
import { EMPTY_USAGE } from './types';
import type {
  AgentEvent,
  AgentState,
  AssistantMessage,
  KernelAgentOptions,
  Message,
} from './types';

type MutableAgentState = { -readonly [Key in keyof AgentState]: AgentState[Key] };

interface ActiveRun {
  abortController: AbortController;
}

export class NativeAgentRuntime {
  private readonly mutableState: MutableAgentState;
  private readonly listeners = new Set<(
    event: AgentEvent,
    signal: AbortSignal,
  ) => Promise<void> | void>();
  private steeringQueue: KernelSteeringMessage[] = [];
  private activeRun?: ActiveRun;

  constructor(private readonly options: KernelAgentOptions) {
    this.mutableState = {
      systemPrompt: options.initialState.systemPrompt,
      model: options.initialState.model,
      thinkingLevel: options.initialState.thinkingLevel,
      tools: [...options.initialState.tools],
      messages: [...options.initialState.messages],
      isStreaming: false,
      streamingMessage: undefined,
      pendingToolCalls: new Set(),
      errorMessage: undefined,
      interruptionError: undefined,
    };
  }

  get state(): AgentState {
    return this.mutableState;
  }

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  steer(message: Message, onDelivered?: () => void): void {
    this.steeringQueue.push({ message, onDelivered });
  }

  abort(): void {
    this.activeRun?.abortController.abort();
  }

  async prompt(message: Message | Message[]): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        'Agent is already processing a prompt. Use steer() to queue messages, or wait for completion.',
      );
    }
    const prompts = Array.isArray(message) ? message : [message];
    const abortController = new AbortController();
    this.activeRun = { abortController };
    this.mutableState.isStreaming = true;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.errorMessage = undefined;
    this.mutableState.interruptionError = undefined;
    try {
      const result = await runKernel(
        prompts,
        {
          systemPrompt: this.mutableState.systemPrompt,
          messages: [...this.mutableState.messages],
          tools: [...this.mutableState.tools],
        },
        this.options,
        (event) => this.processEvent(event),
        abortController.signal,
        async () => this.drainSteering(),
      );
      this.mutableState.interruptionError = result.interruptionError ?? undefined;
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.mutableState.isStreaming = false;
      this.mutableState.streamingMessage = undefined;
      this.mutableState.pendingToolCalls = new Set();
      this.activeRun = undefined;
    }
  }

  private drainSteering(): KernelSteeringMessage[] {
    const drained = this.steeringQueue;
    this.steeringQueue = [];
    return drained;
  }

  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      api: this.mutableState.model.api,
      provider: this.mutableState.model.provider,
      model: this.mutableState.model.id,
      usage: EMPTY_USAGE,
      stopReason: aborted ? 'aborted' : 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.processEvent({ type: 'message_start', message });
    await this.processEvent({ type: 'message_end', message });
    await this.processEvent({ type: 'turn_end', message, toolResults: [] });
    await this.processEvent({ type: 'agent_end', messages: [message] });
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'message_start':
      case 'message_update':
        this.mutableState.streamingMessage = event.message;
        break;
      case 'message_end':
        this.mutableState.streamingMessage = undefined;
        this.mutableState.messages.push(event.message);
        break;
      case 'tool_execution_start': {
        const pending = new Set(this.mutableState.pendingToolCalls);
        pending.add(event.toolCallId);
        this.mutableState.pendingToolCalls = pending;
        break;
      }
      case 'tool_execution_end': {
        const pending = new Set(this.mutableState.pendingToolCalls);
        pending.delete(event.toolCallId);
        this.mutableState.pendingToolCalls = pending;
        break;
      }
      case 'turn_end':
        if (event.message.role === 'assistant' && event.message.errorMessage) {
          this.mutableState.errorMessage = event.message.errorMessage;
        }
        break;
      case 'agent_end':
        this.mutableState.streamingMessage = undefined;
        break;
    }

    const signal = this.activeRun?.abortController.signal;
    if (!signal) throw new Error('Agent listener invoked outside active run');
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }
}
