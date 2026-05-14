import type { BrowserWindow } from 'electron';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage, Context, Model, StreamOptions } from '@earendil-works/pi-ai';
import type { AgentWorkerEvent } from '../renderer/agent/types';

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

const MOCK_MODEL = {
  id: 'lin-local-mock',
  name: 'Lin Local Mock',
  api: 'lin-local',
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
} satisfies Model<string>;

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

  createSession() {
    const sessionId = `lin-agent-${this.nextSessionId++}`;
    this.createSessionWithId(sessionId);
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

  private createSessionWithId(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    existing?.unsubscribe?.();

    const agent = new Agent({
      initialState: {
        systemPrompt: 'You are Lin Outliner local agent.',
        model: MOCK_MODEL,
        thinkingLevel: 'off',
        tools: [],
        messages: [],
      },
      streamFn: createMockStreamFn(),
      sessionId,
    });
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

function createMockStreamFn() {
  return (_model: Model<string>, context: Context, options?: StreamOptions) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      let message = createAssistantBase(MOCK_MODEL);
      let text = '';

      try {
        const response = mockResponse(context);
        stream.push({ type: 'start', partial: clone(message) });
        message = {
          ...message,
          content: [{ type: 'text', text }],
        };
        stream.push({ type: 'text_start', contentIndex: 0, partial: clone(message) });

        for (const chunk of chunks(response)) {
          await wait(28, options?.signal);
          text += chunk;
          message = {
            ...message,
            content: [{ type: 'text', text }],
          };
          stream.push({
            type: 'text_delta',
            contentIndex: 0,
            delta: chunk,
            partial: clone(message),
          });
        }

        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: text,
          partial: clone(message),
        });
        stream.push({ type: 'done', reason: 'stop', message: clone(message) });
        stream.end(clone(message));
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        const reason = aborted ? 'aborted' : 'error';
        const failure: AssistantMessage = {
          ...message,
          content: text ? [{ type: 'text', text }] : message.content,
          stopReason: reason,
          errorMessage: aborted
            ? 'Request was aborted'
            : error instanceof Error
              ? error.message
              : String(error),
        };
        stream.push({ type: 'error', reason, error: clone(failure) });
        stream.end(clone(failure));
      }
    })();

    return stream;
  };
}

function createAssistantBase(model: Model<string>): AssistantMessage {
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

function mockResponse(context: Context) {
  const prompt = latestUserText(context.messages);
  const tail = prompt ? `\n\n收到：${prompt}` : '';
  return [
    '我已经在 Electron 主进程中连接到 pi-agent-core。',
    '现在 renderer 通过 preload IPC 与 agent 通信，后续工具可以直接调用 TypeScript document core。',
  ].join('\n\n') + tail;
}

function latestUserText(messages: Context['messages']) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return extractText(message.content).trim();
  }
  return '';
}

function extractText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object'
      && block !== null
      && 'type' in block
      && block.type === 'text'
      && 'text' in block
      && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request was aborted'));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('Request was aborted'));
    }, { once: true });
  });
}

function chunks(text: string) {
  const result: string[] = [];
  for (let index = 0; index < text.length; index += 10) {
    result.push(text.slice(index, index + 10));
  }
  return result;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
