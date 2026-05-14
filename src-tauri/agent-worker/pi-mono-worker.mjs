import { createInterface } from 'node:readline';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const sessions = new Map();

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
};

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitError(sessionId, message) {
  emit({
    type: 'error',
    sessionId,
    error: message,
    timestamp: Date.now(),
  });
}

function cloneMessage(message) {
  if (!message || typeof message !== 'object') return message;
  return JSON.parse(JSON.stringify(message));
}

function createSnapshot(sessionId, session, lastEventType = null) {
  const state = session.agent.state;
  return {
    type: 'snapshot',
    sessionId,
    lastEventType,
    revision: session.revision,
    state: {
      systemPrompt: state.systemPrompt,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      messages: state.messages.map(cloneMessage),
      streamingMessage: state.streamingMessage ? cloneMessage(state.streamingMessage) : null,
      isStreaming: state.isStreaming,
      pendingToolCallIds: Array.from(state.pendingToolCalls),
      errorMessage: state.errorMessage ?? null,
    },
    timestamp: Date.now(),
  };
}

function emitSnapshot(sessionId, lastEventType = null) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.revision += 1;
  emit(createSnapshot(sessionId, session, lastEventType));
}

function createAssistantBase(model) {
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

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return extractText(message.content).trim();
    }
  }
  return '';
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
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

function chunks(text) {
  const result = [];
  for (let index = 0; index < text.length; index += 10) {
    result.push(text.slice(index, index + 10));
  }
  return result;
}

function mockResponse(context) {
  const prompt = latestUserText(context.messages);
  const tail = prompt ? `\n\n收到：${prompt}` : '';
  return [
    '我已经通过 Rust AgentHost 连接到本地 pi-mono worker。',
    '现在 renderer 只负责 Agent UI；后续 web、node、file、bash 工具都会通过 Rust 工具网关进入这个 worker。',
  ].join('\n\n') + tail;
}

function createMockStreamFn() {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      let message = createAssistantBase(model);
      let text = '';

      try {
        const response = mockResponse(context);
        stream.push({ type: 'start', partial: cloneMessage(message) });

        message = {
          ...message,
          content: [{ type: 'text', text }],
        };
        stream.push({ type: 'text_start', contentIndex: 0, partial: cloneMessage(message) });

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
            partial: cloneMessage(message),
          });
        }

        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: text,
          partial: cloneMessage(message),
        });
        stream.push({ type: 'done', reason: 'stop', message: cloneMessage(message) });
        stream.end(cloneMessage(message));
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        const reason = aborted ? 'aborted' : 'error';
        const failure = {
          ...message,
          content: text ? [{ type: 'text', text }] : message.content,
          stopReason: reason,
          errorMessage: aborted
            ? 'Request was aborted'
            : error instanceof Error
              ? error.message
              : String(error),
        };
        stream.push({ type: 'error', reason, error: cloneMessage(failure) });
        stream.end(cloneMessage(failure));
      }
    })();

    return stream;
  };
}

function createSession(sessionId) {
  const existing = sessions.get(sessionId);
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
  });
  const session = {
    agent,
    revision: 0,
    unsubscribe: null,
  };

  session.unsubscribe = agent.subscribe((event) => {
    emitSnapshot(sessionId, event.type);
  });
  sessions.set(sessionId, session);
  emitSnapshot(sessionId, 'session_created');
}

async function sendMessage(sessionId, message) {
  const session = sessions.get(sessionId);
  if (!session) {
    emitError(sessionId, `Unknown agent session: ${sessionId}`);
    return;
  }

  try {
    if (session.agent.state.isStreaming) {
      session.agent.followUp({
        role: 'user',
        content: [{ type: 'text', text: message }],
        timestamp: Date.now(),
      });
      emitSnapshot(sessionId, 'follow_up_queued');
      return;
    }
    await session.agent.prompt(message);
  } catch (error) {
    emitError(sessionId, error instanceof Error ? error.message : String(error));
  }
}

function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.agent.abort();
  emitSnapshot(sessionId, 'stop_requested');
}

function resetSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.agent.reset();
  emitSnapshot(sessionId, 'session_reset');
}

function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.agent.abort();
  session.unsubscribe?.();
  sessions.delete(sessionId);
  emit({
    type: 'closed',
    sessionId,
    timestamp: Date.now(),
  });
}

async function handleCommand(command) {
  if (!command || typeof command !== 'object') return;
  const sessionId = typeof command.sessionId === 'string' ? command.sessionId : null;

  if (command.type === 'create_session' && sessionId) {
    createSession(sessionId);
    return;
  }

  if (!sessionId) {
    emitError('unknown', 'Missing agent session id');
    return;
  }

  if (command.type === 'send_message') {
    const message = typeof command.message === 'string' ? command.message : '';
    await sendMessage(sessionId, message);
    return;
  }

  if (command.type === 'stop_session') {
    stopSession(sessionId);
    return;
  }

  if (command.type === 'reset_session') {
    resetSession(sessionId);
    return;
  }

  if (command.type === 'close_session') {
    closeSession(sessionId);
    return;
  }

  emitError(sessionId, `Unknown worker command: ${command.type}`);
}

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on('line', (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    emitError('unknown', error instanceof Error ? error.message : String(error));
    return;
  }
  void handleCommand(command);
});

emit({
  type: 'ready',
  sessionId: null,
  timestamp: Date.now(),
});
