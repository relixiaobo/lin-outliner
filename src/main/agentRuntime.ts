import type { BrowserWindow } from 'electron';
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, getModels, streamSimple } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, KnownProvider, Model } from '@earendil-works/pi-ai';
import type { AgentWorkerEvent } from '../renderer/agent/types';
import { getActiveProviderRuntimeConfig, getProviderApiKey, type AgentProviderRuntimeConfig } from './agentSettings';

export const AGENT_EVENT = 'lin-agent-event';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const CONFIGURATION_ERROR_MODEL = {
  id: 'lin-provider-not-configured',
  name: 'Lin Provider Not Configured',
  api: 'openai-completions',
  provider: 'lin',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
} satisfies Model<'openai-completions'>;

interface AgentSessionState {
  agent: Agent;
  revision: number;
  unsubscribe: (() => void) | null;
}

export class AgentRuntime {
  private sessions = new Map<string, AgentSessionState>();
  private nextSessionId = 1;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  ready() {
    this.emit({ type: 'ready', sessionId: null, timestamp: Date.now() });
  }

  async createSession() {
    const sessionId = `lin-agent-${this.nextSessionId++}`;
    await this.createSessionWithId(sessionId);
    return { sessionId };
  }

  async sendMessage(sessionId: string, message: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emitError(sessionId, `Unknown agent session: ${sessionId}`);
      return;
    }

    try {
      if (session.agent.state.isStreaming) {
        session.agent.followUp({
          role: 'user',
          content: [{ type: 'text', text: message }],
          timestamp: Date.now(),
        });
        this.emitSnapshot(sessionId, 'follow_up_queued');
        return;
      }
      await session.agent.prompt(message);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  stopSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.abort();
    this.emitSnapshot(sessionId, 'stop_requested');
  }

  resetSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.reset();
    this.emitSnapshot(sessionId, 'session_reset');
  }

  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.abort();
    session.unsubscribe?.();
    this.sessions.delete(sessionId);
    this.emit({ type: 'closed', sessionId, timestamp: Date.now() });
  }

  private async createSessionWithId(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    existing?.unsubscribe?.();
    existing?.agent.abort();

    const providerConfig = await getActiveProviderRuntimeConfig();
    const agent = providerConfig
      ? createConfiguredAgent(sessionId, providerConfig)
      : createConfigurationErrorAgent(sessionId, 'No enabled agent provider is configured.');

    const session: AgentSessionState = {
      agent,
      revision: 0,
      unsubscribe: null,
    };

    session.unsubscribe = agent.subscribe((event) => {
      this.emitSnapshot(sessionId, event.type);
    });
    this.sessions.set(sessionId, session);
    this.emitSnapshot(sessionId, 'session_created');
  }

  private emitSnapshot(sessionId: string, lastEventType: string | null = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.revision += 1;
    const state = session.agent.state;
    this.emit({
      type: 'snapshot',
      sessionId,
      lastEventType,
      revision: session.revision,
      state: {
        systemPrompt: state.systemPrompt,
        model: clone(state.model) as unknown as Record<string, unknown>,
        thinkingLevel: state.thinkingLevel,
        messages: state.messages.map(clone),
        streamingMessage: state.streamingMessage ? clone(state.streamingMessage) : null,
        isStreaming: state.isStreaming,
        pendingToolCallIds: Array.from(state.pendingToolCalls),
        errorMessage: state.errorMessage ?? null,
      },
      timestamp: Date.now(),
    });
  }

  private emitError(sessionId: string, message: string) {
    this.emit({
      type: 'error',
      sessionId,
      error: message,
      timestamp: Date.now(),
    });
  }

  private emit(payload: AgentWorkerEvent) {
    this.getWindow()?.webContents.send(AGENT_EVENT, payload);
  }
}

function createConfiguredAgent(sessionId: string, providerConfig: AgentProviderRuntimeConfig) {
  const model = resolveModel(providerConfig);
  return new Agent({
    initialState: {
      systemPrompt: [
        'You are Lin Outliner local agent.',
        'Use concise, concrete responses. When document tools become available, prefer structured edits over broad text rewrites.',
      ].join('\n'),
      model,
      thinkingLevel: 'off',
      tools: [],
      messages: [],
    },
    streamFn: streamSimple as StreamFn,
    getApiKey: async (provider) => {
      if (provider === providerConfig.providerId) {
        return providerConfig.apiKey ?? getProviderApiKey(provider);
      }
      return getProviderApiKey(provider);
    },
    sessionId,
  });
}

function createConfigurationErrorAgent(sessionId: string, message: string) {
  return new Agent({
    initialState: {
      systemPrompt: 'You are Lin Outliner local agent.',
      model: CONFIGURATION_ERROR_MODEL,
      thinkingLevel: 'off',
      tools: [],
      messages: [],
    },
    streamFn: createConfigurationErrorStreamFn(message),
    sessionId,
  });
}

function resolveModel(config: AgentProviderRuntimeConfig): Model<Api> {
  const knownModel = findKnownModel(config.providerId, config.modelId);
  if (knownModel) {
    return config.baseUrl ? { ...knownModel, baseUrl: config.baseUrl } : knownModel;
  }
  if (config.baseUrl) {
    return createOpenAICompatibleModel(config);
  }
  throw new Error(`model not found for provider ${config.providerId}: ${config.modelId}`);
}

function findKnownModel(providerId: string, modelId: string): Model<Api> | null {
  try {
    return getModels(providerId as KnownProvider).find((model) => model.id === modelId) as Model<Api> | undefined ?? null;
  } catch {
    return null;
  }
}

function createOpenAICompatibleModel(config: AgentProviderRuntimeConfig): Model<'openai-completions'> {
  return {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: config.providerId,
    baseUrl: config.baseUrl ?? '',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function createConfigurationErrorStreamFn(messageText: string): StreamFn {
  return (model) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const message = createAssistantBase(model as Model<Api>);
      stream.push({ type: 'start', partial: clone(message) });
      const failure: AssistantMessage = {
        ...message,
        stopReason: 'error',
        errorMessage: messageText,
      };
      stream.push({ type: 'error', reason: 'error', error: clone(failure) });
      stream.end(clone(failure));
    })();

    return stream;
  };
}

function createAssistantBase(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
