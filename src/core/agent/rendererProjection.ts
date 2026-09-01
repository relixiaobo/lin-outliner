import type {
  AgentCoreMethod,
  AgentCoreNotification,
  AgentCoreResponseByMethod,
  ModelToolCallArguments,
  ModelToolCallHistory,
  RendererAgentCoreNotification,
  RendererAgentCoreResponseByMethod,
  RendererModelToolCallArguments,
  RendererModelToolCallHistory,
  RendererThread,
  RendererThreadItem,
  RendererThreadItemEntry,
  RendererTurn,
  Thread,
  ThreadContextPayload,
  ThreadItem,
  ThreadItemEntry,
  Turn,
} from './protocol';

type RendererThreadContextPayload =
  | Exclude<ThreadContextPayload, { readonly kind: 'inheritedContext' }>
  | (Omit<Extract<ThreadContextPayload, { readonly kind: 'inheritedContext' }>, 'turns'> & {
      readonly turns: readonly RendererTurn[];
    });

export function projectAgentCoreResponse<Method extends AgentCoreMethod>(
  method: Method,
  response: AgentCoreResponseByMethod[Method],
): RendererAgentCoreResponseByMethod[Method] {
  const freezeProjected = (value: object): RendererAgentCoreResponseByMethod[Method] => (
    Object.freeze(value) as unknown as RendererAgentCoreResponseByMethod[Method]
  );
  switch (method) {
    case 'thread/list': {
      const value = response as AgentCoreResponseByMethod['thread/list'];
      return freezeProjected({ ...value, data: value.data.map(projectThread) });
    }
    case 'thread/descendants': {
      const value = response as AgentCoreResponseByMethod['thread/descendants'];
      return freezeProjected({ ...value, data: value.data.map(projectThread) });
    }
    case 'thread/read':
    case 'thread/start':
    case 'thread/resume':
    case 'thread/fork':
    case 'thread/rollback': {
      const value = response as AgentCoreResponseByMethod['thread/read'];
      return freezeProjected({ ...value, thread: projectThread(value.thread) });
    }
    case 'thread/configuration/get':
    case 'thread/configuration/set': {
      const value = response as AgentCoreResponseByMethod['thread/configuration/get'];
      return freezeProjected({ ...value, thread: projectThread(value.thread) });
    }
    case 'thread/turns/list': {
      const value = response as AgentCoreResponseByMethod['thread/turns/list'];
      return freezeProjected({ ...value, data: value.data.map(projectTurn) });
    }
    case 'thread/items/list': {
      const value = response as AgentCoreResponseByMethod['thread/items/list'];
      return freezeProjected({ ...value, data: value.data.map(projectThreadItemEntry) });
    }
    case 'thread/turn/details/read': {
      const value = response as AgentCoreResponseByMethod['thread/turn/details/read'];
      return freezeProjected({
        ...value,
        thread: projectThread(value.thread),
        turn: projectTurn(value.turn),
      });
    }
    case 'thread/context/read': {
      const value = response as AgentCoreResponseByMethod['thread/context/read'];
      if (value.context === null) return freezeProjected({ context: null });
      return freezeProjected({
        context: Object.freeze({
          ...value.context,
          payload: projectThreadContextPayload(value.context.payload),
        }),
      });
    }
    case 'turn/submit': {
      const value = response as AgentCoreResponseByMethod['turn/submit'];
      return freezeProjected({
        ...value,
        turn: value.turn === null ? null : projectTurn(value.turn),
      });
    }
    case 'turn/start': {
      const value = response as AgentCoreResponseByMethod['turn/start'];
      return freezeProjected({ ...value, turn: projectTurn(value.turn) });
    }
    case 'turn/retry': {
      const value = response as AgentCoreResponseByMethod['turn/retry'];
      return freezeProjected({
        ...value,
        thread: projectThread(value.thread),
        turn: projectTurn(value.turn),
      });
    }
    case 'thread/subagents/list':
    case 'thread/references/search':
    case 'thread/references/resolve':
    case 'thread/name/set':
    case 'thread/archive':
    case 'thread/unarchive':
    case 'thread/records/get':
    case 'thread/records/set':
    case 'thread/delete':
    case 'thread/item/output/read':
    case 'thread/item/arguments/read':
    case 'thread/trajectory/read':
    case 'thread/trajectory/detail/read':
    case 'thread/trajectory/export':
    case 'turn/steer':
    case 'turn/interrupt':
    case 'goal/get':
    case 'goal/create':
    case 'goal/update':
    case 'userInput/respond':
    case 'identities/get':
      return response as unknown as RendererAgentCoreResponseByMethod[Method];
    default:
      return assertNever(method);
  }
}

function projectThreadContextPayload(payload: ThreadContextPayload): RendererThreadContextPayload {
  if (payload.kind !== 'inheritedContext') return payload;
  return Object.freeze({ ...payload, turns: payload.turns.map(projectTurn) });
}

export function projectAgentCoreNotification(
  notification: AgentCoreNotification,
): RendererAgentCoreNotification {
  switch (notification.type) {
    case 'thread/started':
      return Object.freeze({ ...notification, thread: projectThread(notification.thread) });
    case 'turn/started':
      return Object.freeze({ ...notification, turn: projectTurn(notification.turn) });
    case 'item/started':
    case 'item/completed':
      return Object.freeze({ ...notification, item: projectThreadItem(notification.item) });
    case 'items/completed':
      return Object.freeze({ ...notification, items: notification.items.map(projectThreadItem) });
    case 'turn/completed':
      return Object.freeze({ ...notification, turn: projectTurn(notification.turn) });
    case 'thread/name/updated':
    case 'thread/status/changed':
    case 'item/delta':
    case 'turn/providerRetry/changed':
    case 'turn/plan/updated':
    case 'subagent/execution/changed':
    case 'userInput/requested':
    case 'userInput/resolved':
    case 'goal/updated':
    case 'goal/cleared':
      return notification;
    default:
      return assertNever(notification);
  }
}

function projectThread(thread: Thread): RendererThread {
  if (thread.turns === undefined) return Object.freeze({ ...thread }) as RendererThread;
  return Object.freeze({ ...thread, turns: thread.turns.map(projectTurn) });
}

function projectTurn(turn: Turn): RendererTurn {
  return Object.freeze({ ...turn, items: turn.items.map(projectThreadItem) });
}

function projectThreadItemEntry(entry: ThreadItemEntry): RendererThreadItemEntry {
  return Object.freeze({ ...entry, item: projectThreadItem(entry.item) });
}

function projectThreadItem(item: ThreadItem): RendererThreadItem {
  if (!('modelCall' in item)) return item;
  return Object.freeze({ ...item, modelCall: projectModelToolCallHistory(item.modelCall) });
}

function projectModelToolCallHistory(history: ModelToolCallHistory): RendererModelToolCallHistory {
  switch (history.disposition) {
    case 'replayable':
      return Object.freeze({ ...history, arguments: projectModelToolCallArguments(history.arguments) });
    case 'redactedReplay':
      return Object.freeze({
        ...history,
        redactedArguments: projectModelToolCallArguments(history.redactedArguments),
      });
    case 'evidenceOnly':
      return history;
    default:
      return assertNever(history);
  }
}

function projectModelToolCallArguments(argumentsValue: ModelToolCallArguments): RendererModelToolCallArguments {
  switch (argumentsValue.storage) {
    case 'inline':
      return argumentsValue;
    case 'payload':
      return Object.freeze({ storage: 'itemBound' });
    default:
      return assertNever(argumentsValue);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled renderer projection variant: ${JSON.stringify(value)}`);
}
