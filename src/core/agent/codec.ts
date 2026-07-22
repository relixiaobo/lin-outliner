import {
  THREAD_HISTORY_MODE,
  THREAD_ITEM_TYPES,
  REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS,
  REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS,
  isReservedThreadSource,
  threadFeatureSource,
  type AdditionalContext,
  type AdditionalContextEntry,
  type AgentCoreMethod,
  type AgentCoreNotification,
  type AgentCoreRequestByMethod,
  type AgentCoreResponseByMethod,
  type AgentMutationCausation,
  type CommandAction,
  type DynamicToolOutputContent,
  type FileUpdateChange,
  type ItemProvenance,
  type JsonValue,
  type MemoryCitation,
  type PrivilegedTurnStartRequest,
  type RequestUserInputRequest,
  type RequestUserInputQuestion,
  type RendererTurnStartRequest,
  type Thread,
  type ThreadAttachmentContent,
  type ThreadItem,
  type ThreadItemDelta,
  type ThreadNodeReferenceContent,
  type ThreadSource,
  type ThreadStatus,
  type ThreadTextContent,
  type ThreadUserContent,
  type Turn,
  type TurnProvenance,
  type TurnTrigger,
} from './protocol';
import {
  THREAD_GOAL_STATUSES,
  type ThreadGoal,
} from './goal';

export class AgentProtocolCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProtocolCodecError';
  }
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_EXECUTION_STATUSES = new Set(['inProgress', 'completed', 'failed', 'interrupted']);
export function decodeThreadSource(value: unknown, path = 'threadSource'): ThreadSource {
  const source = stringValue(value, path);
  if (source.startsWith('feature:')) fail(path, 'feature sources use their plain app-owned label');
  return isReservedThreadSource(source) ? source : threadFeatureSource(source);
}

export function decodeThread(value: unknown): Thread {
  const record = recordValue(value, 'thread');
  exactKeys(record, [
    'id',
    'sessionId',
    'parentThreadId',
    'forkedFromId',
    'agentNickname',
    'agentRole',
    'name',
    'preview',
    'ephemeral',
    'source',
    'threadSource',
    'modelProvider',
    'cwd',
    'createdAt',
    'updatedAt',
    'status',
    'historyMode',
    'turns',
  ], 'thread');
  if (record.historyMode !== THREAD_HISTORY_MODE) fail('thread.historyMode', 'only paginated history is supported');

  const result: Thread = {
    id: uuidV7(record.id, 'thread.id'),
    sessionId: uuidV7(record.sessionId, 'thread.sessionId'),
    parentThreadId: nullableUuidV7(record.parentThreadId, 'thread.parentThreadId'),
    forkedFromId: nullableUuidV7(record.forkedFromId, 'thread.forkedFromId'),
    agentNickname: nullableString(record.agentNickname, 'thread.agentNickname'),
    agentRole: nullableString(record.agentRole, 'thread.agentRole'),
    name: nullableString(record.name, 'thread.name'),
    preview: stringValue(record.preview, 'thread.preview', true),
    ephemeral: booleanValue(record.ephemeral, 'thread.ephemeral'),
    source: stringValue(record.source, 'thread.source'),
    threadSource: decodeThreadSource(record.threadSource),
    modelProvider: stringValue(record.modelProvider, 'thread.modelProvider'),
    cwd: stringValue(record.cwd, 'thread.cwd'),
    createdAt: finiteNumber(record.createdAt, 'thread.createdAt'),
    updatedAt: finiteNumber(record.updatedAt, 'thread.updatedAt'),
    status: decodeThreadStatus(record.status),
    historyMode: THREAD_HISTORY_MODE,
    ...(record.turns === undefined
      ? {}
      : { turns: arrayValue(record.turns, 'thread.turns').map(decodeTurn) }),
  };
  if (result.parentThreadId && result.forkedFromId) {
    fail('thread', 'parentThreadId and forkedFromId are mutually exclusive lineage edges');
  }
  return deepFreeze(result);
}

export function encodeThread(value: Thread): string {
  return JSON.stringify(decodeThread(value));
}

export function decodeThreadJson(encoded: string): Thread {
  return decodeThread(parseJson(encoded, 'thread'));
}

export function decodeTurn(value: unknown): Turn {
  const record = recordValue(value, 'turn');
  exactKeys(record, [
    'id',
    'items',
    'itemsView',
    'provenance',
    'status',
    'error',
    'startedAt',
    'completedAt',
    'durationMs',
  ], 'turn');
  const status = enumValue(record.status, ['inProgress', 'completed', 'interrupted', 'failed'], 'turn.status');
  const result: Turn = {
    id: uuidV7(record.id, 'turn.id'),
    items: arrayValue(record.items, 'turn.items').map(decodeThreadItem),
    itemsView: enumValue(record.itemsView, ['notLoaded', 'summary', 'full'], 'turn.itemsView'),
    provenance: decodeTurnProvenance(record.provenance),
    status,
    error: decodeTurnError(record.error),
    startedAt: finiteNumber(record.startedAt, 'turn.startedAt'),
    completedAt: nullableNumber(record.completedAt, 'turn.completedAt'),
    durationMs: nullableNumber(record.durationMs, 'turn.durationMs'),
  };
  if (result.provenance.originTurnId === result.id && result.provenance.originThreadId.length === 0) {
    fail('turn.provenance', 'locally originated Turns require an origin Thread');
  }
  if (status === 'inProgress' && result.completedAt !== null) {
    fail('turn.completedAt', 'an in-progress Turn cannot have a completion time');
  }
  if (status !== 'inProgress' && result.completedAt === null) {
    fail('turn.completedAt', 'a terminal Turn requires a completion time');
  }
  if (status !== 'inProgress' && result.items.some((item) => executionStatusOf(item) === 'inProgress')) {
    fail('turn.items', 'a terminal Turn cannot contain an in-progress Item');
  }
  return deepFreeze(result);
}

export function encodeTurn(value: Turn): string {
  return JSON.stringify(decodeTurn(value));
}

export function decodeTurnJson(encoded: string): Turn {
  return decodeTurn(parseJson(encoded, 'turn'));
}

export function decodeThreadItem(value: unknown): ThreadItem {
  const record = recordValue(value, 'item');
  const type = enumValue(record.type, THREAD_ITEM_TYPES, 'item.type');
  const base = {
    id: stringValue(record.id, 'item.id'),
    provenance: decodeItemProvenance(record.provenance),
  };

  let result: ThreadItem;
  switch (type) {
    case 'userMessage':
      exactKeys(record, ['type', 'id', 'provenance', 'clientId', 'content'], 'item');
      result = {
        ...base,
        type,
        clientId: nullableString(record.clientId, 'item.clientId'),
        content: arrayValue(record.content, 'item.content').map(decodeUserContent),
      };
      break;
    case 'agentMessage':
      exactKeys(record, ['type', 'id', 'provenance', 'text', 'phase', 'memoryCitation'], 'item');
      result = {
        ...base,
        type,
        text: stringValue(record.text, 'item.text', true),
        phase: nullableEnum(record.phase, ['commentary', 'final_answer'], 'item.phase'),
        memoryCitation: decodeMemoryCitation(record.memoryCitation),
      };
      break;
    case 'plan':
      exactKeys(record, ['type', 'id', 'provenance', 'text'], 'item');
      result = { ...base, type, text: stringValue(record.text, 'item.text', true) };
      break;
    case 'reasoning':
      exactKeys(record, ['type', 'id', 'provenance', 'summary', 'content'], 'item');
      result = {
        ...base,
        type,
        summary: stringArray(record.summary, 'item.summary'),
        content: stringArray(record.content, 'item.content'),
      };
      break;
    case 'commandExecution':
      exactKeys(record, [
        'type', 'id', 'provenance', 'command', 'cwd', 'processId', 'status', 'commandActions',
        'aggregatedOutput', 'exitCode', 'durationMs',
      ], 'item');
      result = {
        ...base,
        type,
        command: stringValue(record.command, 'item.command'),
        cwd: stringValue(record.cwd, 'item.cwd'),
        processId: nullableString(record.processId, 'item.processId'),
        status: itemExecutionStatus(record.status, 'item.status'),
        commandActions: arrayValue(record.commandActions, 'item.commandActions').map(decodeCommandAction),
        aggregatedOutput: nullableString(record.aggregatedOutput, 'item.aggregatedOutput', true),
        exitCode: nullableInteger(record.exitCode, 'item.exitCode'),
        durationMs: nullableNumber(record.durationMs, 'item.durationMs'),
      };
      break;
    case 'fileChange':
      exactKeys(record, ['type', 'id', 'provenance', 'changes', 'status'], 'item');
      result = {
        ...base,
        type,
        changes: arrayValue(record.changes, 'item.changes').map(decodeFileChange),
        status: itemExecutionStatus(record.status, 'item.status'),
      };
      break;
    case 'mcpToolCall':
      exactKeys(record, [
        'type', 'id', 'provenance', 'server', 'tool', 'status', 'arguments', 'pluginId', 'result',
        'error', 'durationMs',
      ], 'item');
      result = {
        ...base,
        type,
        server: stringValue(record.server, 'item.server'),
        tool: stringValue(record.tool, 'item.tool'),
        status: itemExecutionStatus(record.status, 'item.status'),
        arguments: jsonValue(record.arguments, 'item.arguments'),
        pluginId: nullableString(record.pluginId, 'item.pluginId'),
        result: record.result === null ? null : jsonValue(record.result, 'item.result'),
        error: nullableString(record.error, 'item.error', true),
        durationMs: nullableNumber(record.durationMs, 'item.durationMs'),
      };
      break;
    case 'dynamicToolCall':
      exactKeys(record, [
        'type', 'id', 'provenance', 'namespace', 'tool', 'arguments', 'status', 'contentItems',
        'success', 'durationMs',
      ], 'item');
      result = {
        ...base,
        type,
        namespace: nullableString(record.namespace, 'item.namespace'),
        tool: stringValue(record.tool, 'item.tool'),
        arguments: jsonValue(record.arguments, 'item.arguments'),
        status: itemExecutionStatus(record.status, 'item.status'),
        contentItems: record.contentItems === null
          ? null
          : arrayValue(record.contentItems, 'item.contentItems').map(decodeDynamicToolOutput),
        success: nullableBoolean(record.success, 'item.success'),
        durationMs: nullableNumber(record.durationMs, 'item.durationMs'),
      };
      break;
    case 'collabAgentToolCall': {
      exactKeys(record, [
        'type', 'id', 'provenance', 'tool', 'status', 'senderThreadId', 'receiverThreadIds', 'prompt',
        'model', 'reasoningEffort', 'agentsStates',
      ], 'item');
      const states = recordValue(record.agentsStates, 'item.agentsStates');
      const decodedStates: Record<string, 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'notFound'> = {};
      for (const [threadId, state] of Object.entries(states)) {
        decodedStates[uuidV7(threadId, 'item.agentsStates key')] = enumValue(
          state,
          ['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'notFound'],
          `item.agentsStates.${threadId}`,
        );
      }
      result = {
        ...base,
        type,
        tool: enumValue(
          record.tool,
          ['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent'],
          'item.tool',
        ),
        status: itemExecutionStatus(record.status, 'item.status'),
        senderThreadId: uuidV7(record.senderThreadId, 'item.senderThreadId'),
        receiverThreadIds: arrayValue(record.receiverThreadIds, 'item.receiverThreadIds')
          .map((entry, index) => uuidV7(entry, `item.receiverThreadIds[${index}]`)),
        prompt: nullableString(record.prompt, 'item.prompt', true),
        model: nullableString(record.model, 'item.model'),
        reasoningEffort: nullableString(record.reasoningEffort, 'item.reasoningEffort'),
        agentsStates: decodedStates,
      };
      break;
    }
    case 'subAgentActivity':
      exactKeys(record, ['type', 'id', 'provenance', 'kind', 'agentThreadId', 'agentPath'], 'item');
      result = {
        ...base,
        type,
        kind: enumValue(record.kind, ['started', 'completed', 'interrupted', 'errored'], 'item.kind'),
        agentThreadId: uuidV7(record.agentThreadId, 'item.agentThreadId'),
        agentPath: stringValue(record.agentPath, 'item.agentPath'),
      };
      break;
    case 'webSearch':
      exactKeys(record, ['type', 'id', 'provenance', 'query', 'status', 'results', 'error'], 'item');
      result = {
        ...base,
        type,
        query: stringValue(record.query, 'item.query'),
        status: itemExecutionStatus(record.status, 'item.status'),
        results: arrayValue(record.results, 'item.results').map((entry, index) => {
          const item = recordValue(entry, `item.results[${index}]`);
          exactKeys(item, ['title', 'url', 'snippet'], `item.results[${index}]`);
          return {
            title: stringValue(item.title, `item.results[${index}].title`),
            url: stringValue(item.url, `item.results[${index}].url`),
            ...(item.snippet === undefined
              ? {}
              : { snippet: stringValue(item.snippet, `item.results[${index}].snippet`, true) }),
          };
        }),
        error: nullableString(record.error, 'item.error', true),
      };
      break;
    case 'imageView':
      exactKeys(record, ['type', 'id', 'provenance', 'path'], 'item');
      result = { ...base, type, path: stringValue(record.path, 'item.path') };
      break;
    case 'contextCompaction':
      exactKeys(record, ['type', 'id', 'provenance'], 'item');
      result = { ...base, type };
      break;
    default:
      return assertNever(type);
  }
  return deepFreeze(result);
}

export function encodeThreadItem(value: ThreadItem): string {
  return JSON.stringify(decodeThreadItem(value));
}

export function decodeThreadItemJson(encoded: string): ThreadItem {
  return decodeThreadItem(parseJson(encoded, 'ThreadItem'));
}

export function decodeRendererTurnStartRequest(value: unknown): RendererTurnStartRequest {
  const record = recordValue(value, 'turnStart');
  exactKeys(record, ['threadId', 'input', 'clientUserMessageId', 'additionalContext'], 'turnStart');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'turnStart.threadId'),
    input: arrayValue(record.input, 'turnStart.input').map(decodeUserContent),
    ...(record.clientUserMessageId === undefined
      ? {}
      : { clientUserMessageId: nullableString(record.clientUserMessageId, 'turnStart.clientUserMessageId') }),
    ...(record.additionalContext === undefined
      ? {}
      : { additionalContext: decodeAdditionalContext(record.additionalContext, false) }),
  });
}

export function decodePrivilegedTurnStartRequest(value: unknown): PrivilegedTurnStartRequest {
  const record = recordValue(value, 'privilegedTurnStart');
  exactKeys(record, [
    'threadId', 'turnId', 'input', 'clientUserMessageId', 'additionalContext', 'trigger',
  ], 'privilegedTurnStart');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'privilegedTurnStart.threadId'),
    ...(record.turnId === undefined ? {} : { turnId: uuidV7(record.turnId, 'privilegedTurnStart.turnId') }),
    input: arrayValue(record.input, 'privilegedTurnStart.input').map(decodeUserContent),
    ...(record.clientUserMessageId === undefined
      ? {}
      : { clientUserMessageId: nullableString(record.clientUserMessageId, 'privilegedTurnStart.clientUserMessageId') }),
    ...(record.additionalContext === undefined
      ? {}
      : { additionalContext: decodeAdditionalContext(record.additionalContext, true) }),
    trigger: decodeTurnTrigger(record.trigger),
  });
}

export function decodeAdditionalContext(
  value: unknown,
  allowApplication: false,
): Readonly<Record<string, AdditionalContextEntry & { readonly kind: 'untrusted' }>>;
export function decodeAdditionalContext(value: unknown, allowApplication: true): AdditionalContext;
export function decodeAdditionalContext(value: unknown, allowApplication: boolean): AdditionalContext {
  const record = recordValue(value, 'additionalContext');
  const result: Record<string, AdditionalContextEntry> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (!key.trim()) fail('additionalContext', 'keys must be non-empty');
    const entry = recordValue(entryValue, `additionalContext.${key}`);
    exactKeys(entry, ['value', 'kind'], `additionalContext.${key}`);
    const kind = enumValue(entry.kind, ['untrusted', 'application'], `additionalContext.${key}.kind`);
    if (!allowApplication && kind === 'application') {
      fail(`additionalContext.${key}.kind`, 'renderer input may author only untrusted context');
    }
    result[key] = { value: stringValue(entry.value, `additionalContext.${key}.value`, true), kind };
  }
  return deepFreeze(result);
}

export function decodeAgentCoreNotification(value: unknown): AgentCoreNotification {
  const record = recordValue(value, 'notification');
  const type = enumValue(record.type, [
    'thread/started',
    'thread/status/changed',
    'turn/started',
    'item/started',
    'item/delta',
    'item/completed',
    'turn/completed',
    'userInput/requested',
    'userInput/resolved',
    'goal/updated',
    'goal/cleared',
  ], 'notification.type');
  let result: AgentCoreNotification;
  switch (type) {
    case 'thread/started': {
      exactKeys(record, ['type', 'threadId', 'thread'], 'notification');
      const thread = decodeThread(record.thread);
      const threadId = uuidV7(record.threadId, 'notification.threadId');
      if (thread.id !== threadId) fail('notification.threadId', 'must match thread.id');
      result = { type, threadId, thread };
      break;
    }
    case 'thread/status/changed':
      exactKeys(record, ['type', 'threadId', 'status'], 'notification');
      result = {
        type,
        threadId: uuidV7(record.threadId, 'notification.threadId'),
        status: decodeThreadStatus(record.status),
      };
      break;
    case 'turn/started':
    case 'turn/completed': {
      exactKeys(record, ['type', 'threadId', 'turnId', 'turn'], 'notification');
      const turn = decodeTurn(record.turn);
      const turnId = uuidV7(record.turnId, 'notification.turnId');
      if (turn.id !== turnId) fail('notification.turnId', 'must match turn.id');
      if (type === 'turn/started' && turn.status !== 'inProgress') {
        fail('notification.turn', 'turn/started requires an in-progress Turn');
      }
      if (type === 'turn/completed' && turn.status === 'inProgress') {
        fail('notification.turn', 'turn/completed requires a terminal Turn');
      }
      result = { type, threadId: uuidV7(record.threadId, 'notification.threadId'), turnId, turn };
      break;
    }
    case 'item/started':
    case 'item/completed': {
      const timeKey = type === 'item/started' ? 'startedAt' : 'completedAt';
      exactKeys(record, ['type', 'threadId', 'turnId', 'itemId', 'item', timeKey], 'notification');
      const item = decodeThreadItem(record.item);
      const itemId = stringValue(record.itemId, 'notification.itemId');
      if (item.id !== itemId) fail('notification.itemId', 'must match item.id');
      const executionStatus = executionStatusOf(item);
      if (type === 'item/started' && executionStatus !== null && executionStatus !== 'inProgress') {
        fail('notification.item', 'item/started requires an in-progress executable Item');
      }
      if (type === 'item/completed' && executionStatus === 'inProgress') {
        fail('notification.item', 'item/completed requires a terminal executable Item');
      }
      const common = {
        threadId: uuidV7(record.threadId, 'notification.threadId'),
        turnId: uuidV7(record.turnId, 'notification.turnId'),
        itemId,
        item,
      };
      result = type === 'item/started'
        ? { type, ...common, startedAt: finiteNumber(record.startedAt, 'notification.startedAt') }
        : { type, ...common, completedAt: finiteNumber(record.completedAt, 'notification.completedAt') };
      break;
    }
    case 'item/delta':
      exactKeys(record, ['type', 'threadId', 'turnId', 'itemId', 'delta'], 'notification');
      result = {
        type,
        threadId: uuidV7(record.threadId, 'notification.threadId'),
        turnId: uuidV7(record.turnId, 'notification.turnId'),
        itemId: stringValue(record.itemId, 'notification.itemId'),
        delta: decodeItemDelta(record.delta),
      };
      break;
    case 'userInput/requested': {
      exactKeys(record, ['type', 'threadId', 'turnId', 'itemId', 'request'], 'notification');
      const threadId = uuidV7(record.threadId, 'notification.threadId');
      const turnId = uuidV7(record.turnId, 'notification.turnId');
      const itemId = stringValue(record.itemId, 'notification.itemId');
      const request = decodeRequestUserInputRequest(record.request);
      if (request.threadId !== threadId || request.turnId !== turnId || request.itemId !== itemId) {
        fail('notification.request', 'control-plane ids must match the notification envelope');
      }
      result = { type, threadId, turnId, itemId, request };
      break;
    }
    case 'userInput/resolved': {
      exactKeys(record, ['type', 'threadId', 'turnId', 'itemId', 'response'], 'notification');
      const threadId = uuidV7(record.threadId, 'notification.threadId');
      const turnId = uuidV7(record.turnId, 'notification.turnId');
      const itemId = stringValue(record.itemId, 'notification.itemId');
      const response = decodeRequestUserInputResponse(record.response);
      if (response.threadId !== threadId || response.turnId !== turnId || response.itemId !== itemId) {
        fail('notification.response', 'control-plane ids must match the notification envelope');
      }
      result = { type, threadId, turnId, itemId, response };
      break;
    }
    case 'goal/updated': {
      exactKeys(record, ['type', 'threadId', 'turnId', 'goal'], 'notification');
      const threadId = uuidV7(record.threadId, 'notification.threadId');
      const goal = decodeThreadGoal(record.goal);
      if (goal.threadId !== threadId) fail('notification.goal', 'goal.threadId must match the envelope');
      result = {
        type,
        threadId,
        turnId: nullableUuidV7(record.turnId, 'notification.turnId'),
        goal,
      };
      break;
    }
    case 'goal/cleared':
      exactKeys(record, ['type', 'threadId'], 'notification');
      result = { type, threadId: uuidV7(record.threadId, 'notification.threadId') };
      break;
    default:
      fail('notification.type', `unknown notification: ${type}`);
  }
  return deepFreeze(result);
}

function executionStatusOf(item: ThreadItem): 'inProgress' | 'completed' | 'failed' | 'interrupted' | null {
  switch (item.type) {
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'webSearch':
      return item.status;
    case 'userMessage':
    case 'agentMessage':
    case 'plan':
    case 'reasoning':
    case 'subAgentActivity':
    case 'imageView':
    case 'contextCompaction':
      return null;
    default:
      return assertNever(item);
  }
}

export function decodeAgentCoreRequest<M extends AgentCoreMethod>(
  method: M,
  value: unknown,
): AgentCoreRequestByMethod[M] {
  let decoded: AgentCoreRequestByMethod[AgentCoreMethod];
  switch (method) {
    case 'thread/list':
      decoded = decodeThreadListRequest(value);
      break;
    case 'thread/read':
      decoded = decodeThreadReadRequest(value);
      break;
    case 'thread/start':
      decoded = decodeRendererThreadStartRequest(value);
      break;
    case 'thread/resume':
    case 'thread/archive':
    case 'thread/unarchive':
    case 'thread/delete':
      decoded = decodeThreadIdentityRequest(value);
      break;
    case 'thread/fork':
      decoded = decodeThreadForkRequest(value);
      break;
    case 'thread/name/set':
      decoded = decodeThreadNameSetRequest(value);
      break;
    case 'thread/turns/list':
      decoded = decodeThreadTurnsListRequest(value);
      break;
    case 'thread/items/list':
      decoded = decodeThreadItemsListRequest(value);
      break;
    case 'turn/start':
      decoded = decodeRendererTurnStartRequest(value);
      break;
    case 'turn/steer':
      decoded = decodeRendererTurnSteerRequest(value);
      break;
    case 'turn/interrupt':
      decoded = decodeTurnInterruptRequest(value);
      break;
    case 'goal/get':
      decoded = decodeGoalGetInput(value);
      break;
    case 'goal/create':
      decoded = decodeGoalCreateInput(value);
      break;
    case 'goal/update':
      decoded = decodeGoalUpdateInput(value);
      break;
    case 'userInput/respond':
      decoded = decodeRequestUserInputResponse(value);
      break;
    default:
      return assertNever(method);
  }
  return decoded as AgentCoreRequestByMethod[M];
}

export function encodeAgentCoreRequest<M extends AgentCoreMethod>(
  method: M,
  value: AgentCoreRequestByMethod[M],
): string {
  return JSON.stringify(decodeAgentCoreRequest(method, value));
}

export function decodeAgentCoreResponse<M extends AgentCoreMethod>(
  method: M,
  value: unknown,
): AgentCoreResponseByMethod[M] {
  let decoded: AgentCoreResponseByMethod[AgentCoreMethod];
  switch (method) {
    case 'thread/list':
      decoded = decodeThreadListResponse(value);
      break;
    case 'thread/read':
    case 'thread/start':
    case 'thread/resume':
    case 'thread/fork':
      decoded = decodeThreadResponse(value);
      break;
    case 'thread/name/set':
    case 'thread/archive':
    case 'thread/unarchive':
    case 'thread/delete':
    case 'userInput/respond':
      decoded = decodeEmptyResponse(value);
      break;
    case 'thread/turns/list':
      decoded = decodeThreadTurnsListResponse(value);
      break;
    case 'thread/items/list':
      decoded = decodeThreadItemsListResponse(value);
      break;
    case 'turn/start':
      decoded = decodeTurnStartResponse(value);
      break;
    case 'turn/steer':
      decoded = decodeTurnSteerResponse(value);
      break;
    case 'turn/interrupt':
      decoded = decodeTurnInterruptResponse(value);
      break;
    case 'goal/get':
      decoded = decodeGoalGetResponse(value);
      break;
    case 'goal/create':
    case 'goal/update':
      decoded = decodeGoalMutationResponse(value);
      break;
    default:
      return assertNever(method);
  }
  return decoded as AgentCoreResponseByMethod[M];
}

export function encodeAgentCoreResponse<M extends AgentCoreMethod>(
  method: M,
  value: AgentCoreResponseByMethod[M],
): string {
  return JSON.stringify(decodeAgentCoreResponse(method, value));
}

export function decodeThreadGoal(value: unknown): ThreadGoal {
  const record = recordValue(value, 'goal');
  exactKeys(record, [
    'threadId',
    'objective',
    'status',
    'tokenBudget',
    'tokensUsed',
    'timeUsedSeconds',
    'createdAt',
    'updatedAt',
  ], 'goal');
  const tokenBudget = nullableNumber(record.tokenBudget, 'goal.tokenBudget');
  if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
    fail('goal.tokenBudget', 'must be a positive safe integer or null');
  }
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'goal.threadId'),
    objective: stringValue(record.objective, 'goal.objective'),
    status: enumValue(record.status, THREAD_GOAL_STATUSES, 'goal.status'),
    tokenBudget,
    tokensUsed: nonNegativeInteger(record.tokensUsed, 'goal.tokensUsed'),
    timeUsedSeconds: nonNegativeNumber(record.timeUsedSeconds, 'goal.timeUsedSeconds'),
    createdAt: finiteNumber(record.createdAt, 'goal.createdAt'),
    updatedAt: finiteNumber(record.updatedAt, 'goal.updatedAt'),
  });
}

function decodeThreadListRequest(value: unknown): AgentCoreRequestByMethod['thread/list'] {
  const record = recordValue(value, 'thread/list');
  exactKeys(record, ['cursor', 'limit', 'sortDirection', 'archived', 'threadSources'], 'thread/list');
  return deepFreeze({
    ...decodePageRequest(record, 'thread/list'),
    ...(record.archived === undefined ? {} : { archived: booleanValue(record.archived, 'thread/list.archived') }),
    ...(record.threadSources === undefined
      ? {}
      : {
          threadSources: arrayValue(record.threadSources, 'thread/list.threadSources')
            .map((source, index) => decodeThreadSource(source, `thread/list.threadSources[${index}]`)),
        }),
  });
}

function decodeThreadReadRequest(value: unknown): AgentCoreRequestByMethod['thread/read'] {
  const record = recordValue(value, 'thread/read');
  exactKeys(record, ['threadId', 'includeTurns'], 'thread/read');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/read.threadId'),
    ...(record.includeTurns === undefined
      ? {}
      : { includeTurns: booleanValue(record.includeTurns, 'thread/read.includeTurns') }),
  });
}

function decodeRendererThreadStartRequest(value: unknown): AgentCoreRequestByMethod['thread/start'] {
  const record = recordValue(value, 'thread/start');
  exactKeys(record, [
    'id', 'name', 'ephemeral', 'source', 'threadSource', 'modelProvider', 'cwd', 'configurationProfile',
  ], 'thread/start');
  if (record.source !== undefined && record.source !== 'app') fail('thread/start.source', 'renderer source must be app');
  if (record.threadSource !== undefined && record.threadSource !== 'user') {
    fail('thread/start.threadSource', 'renderer entry may create only user Threads');
  }
  return deepFreeze({
    ...(record.id === undefined ? {} : { id: uuidV7(record.id, 'thread/start.id') }),
    ...(record.name === undefined ? {} : { name: stringValue(record.name, 'thread/start.name') }),
    ...(record.ephemeral === undefined
      ? {}
      : { ephemeral: booleanValue(record.ephemeral, 'thread/start.ephemeral') }),
    ...(record.source === undefined ? {} : { source: 'app' as const }),
    ...(record.threadSource === undefined ? {} : { threadSource: 'user' as const }),
    modelProvider: stringValue(record.modelProvider, 'thread/start.modelProvider'),
    cwd: stringValue(record.cwd, 'thread/start.cwd'),
    ...(record.configurationProfile === undefined
      ? {}
      : { configurationProfile: stringValue(record.configurationProfile, 'thread/start.configurationProfile') }),
  });
}

function decodeThreadIdentityRequest(value: unknown): AgentCoreRequestByMethod['thread/resume'] {
  const record = recordValue(value, 'thread operation');
  exactKeys(record, ['threadId'], 'thread operation');
  return deepFreeze({ threadId: uuidV7(record.threadId, 'threadId') });
}

function decodeThreadForkRequest(value: unknown): AgentCoreRequestByMethod['thread/fork'] {
  const record = recordValue(value, 'thread/fork');
  exactKeys(record, ['threadId', 'boundary', 'name'], 'thread/fork');
  const boundary = recordValue(record.boundary, 'thread/fork.boundary');
  exactKeys(boundary, ['kind', 'turnId'], 'thread/fork.boundary');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/fork.threadId'),
    boundary: {
      kind: enumValue(boundary.kind, ['beforeTurn', 'afterTurn'], 'thread/fork.boundary.kind'),
      turnId: uuidV7(boundary.turnId, 'thread/fork.boundary.turnId'),
    },
    ...(record.name === undefined ? {} : { name: stringValue(record.name, 'thread/fork.name') }),
  });
}

function decodeThreadNameSetRequest(value: unknown): AgentCoreRequestByMethod['thread/name/set'] {
  const record = recordValue(value, 'thread/name/set');
  exactKeys(record, ['threadId', 'name'], 'thread/name/set');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/name/set.threadId'),
    name: nullableString(record.name, 'thread/name/set.name'),
  });
}

function decodeThreadTurnsListRequest(value: unknown): AgentCoreRequestByMethod['thread/turns/list'] {
  const record = recordValue(value, 'thread/turns/list');
  exactKeys(record, ['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView'], 'thread/turns/list');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/turns/list.threadId'),
    ...decodePageRequest(record, 'thread/turns/list'),
    ...(record.itemsView === undefined
      ? {}
      : { itemsView: nullableEnum(record.itemsView, ['notLoaded', 'summary', 'full'], 'thread/turns/list.itemsView') }),
  });
}

function decodeThreadItemsListRequest(value: unknown): AgentCoreRequestByMethod['thread/items/list'] {
  const record = recordValue(value, 'thread/items/list');
  exactKeys(record, ['threadId', 'turnId', 'cursor', 'limit', 'sortDirection'], 'thread/items/list');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/items/list.threadId'),
    ...decodePageRequest(record, 'thread/items/list'),
    ...(record.turnId === undefined
      ? {}
      : { turnId: nullableUuidV7(record.turnId, 'thread/items/list.turnId') }),
  });
}

function decodeRendererTurnSteerRequest(value: unknown): AgentCoreRequestByMethod['turn/steer'] {
  const record = recordValue(value, 'turn/steer');
  exactKeys(record, [
    'threadId', 'expectedTurnId', 'input', 'clientUserMessageId', 'additionalContext',
  ], 'turn/steer');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'turn/steer.threadId'),
    expectedTurnId: uuidV7(record.expectedTurnId, 'turn/steer.expectedTurnId'),
    input: arrayValue(record.input, 'turn/steer.input').map(decodeUserContent),
    ...(record.clientUserMessageId === undefined
      ? {}
      : { clientUserMessageId: nullableString(record.clientUserMessageId, 'turn/steer.clientUserMessageId') }),
    ...(record.additionalContext === undefined
      ? {}
      : { additionalContext: decodeAdditionalContext(record.additionalContext, false) }),
  });
}

function decodeTurnInterruptRequest(value: unknown): AgentCoreRequestByMethod['turn/interrupt'] {
  const record = recordValue(value, 'turn/interrupt');
  exactKeys(record, ['threadId', 'turnId'], 'turn/interrupt');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'turn/interrupt.threadId'),
    turnId: uuidV7(record.turnId, 'turn/interrupt.turnId'),
  });
}

function decodeGoalGetInput(value: unknown): AgentCoreRequestByMethod['goal/get'] {
  const record = recordValue(value, 'goal/get');
  exactKeys(record, ['threadId'], 'goal/get');
  return deepFreeze({ threadId: uuidV7(record.threadId, 'goal/get.threadId') });
}

function decodeGoalCreateInput(value: unknown): AgentCoreRequestByMethod['goal/create'] {
  const record = recordValue(value, 'goal/create');
  exactKeys(record, ['threadId', 'objective', 'tokenBudget'], 'goal/create');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'goal/create.threadId'),
    objective: stringValue(record.objective, 'goal/create.objective'),
    ...(record.tokenBudget === undefined
      ? {}
      : { tokenBudget: positiveInteger(record.tokenBudget, 'goal/create.tokenBudget') }),
  });
}

function decodeGoalUpdateInput(value: unknown): AgentCoreRequestByMethod['goal/update'] {
  const record = recordValue(value, 'goal/update');
  exactKeys(record, ['threadId', 'status'], 'goal/update');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'goal/update.threadId'),
    status: enumValue(record.status, ['complete', 'blocked'], 'goal/update.status'),
  });
}

function decodeThreadListResponse(value: unknown): AgentCoreResponseByMethod['thread/list'] {
  const record = recordValue(value, 'thread/list response');
  exactKeys(record, ['data', 'nextCursor'], 'thread/list response');
  return deepFreeze({
    data: arrayValue(record.data, 'thread/list response.data').map(decodeThread),
    nextCursor: nullableString(record.nextCursor, 'thread/list response.nextCursor'),
  });
}

function decodeThreadResponse(value: unknown): AgentCoreResponseByMethod['thread/read'] {
  const record = recordValue(value, 'thread response');
  exactKeys(record, ['thread'], 'thread response');
  return deepFreeze({ thread: decodeThread(record.thread) });
}

function decodeEmptyResponse(value: unknown): Readonly<Record<string, never>> {
  const record = recordValue(value, 'empty response');
  exactKeys(record, [], 'empty response');
  return deepFreeze({});
}

function decodeThreadTurnsListResponse(value: unknown): AgentCoreResponseByMethod['thread/turns/list'] {
  const record = recordValue(value, 'thread/turns/list response');
  exactKeys(record, ['data', 'nextCursor', 'backwardsCursor'], 'thread/turns/list response');
  return deepFreeze({
    data: arrayValue(record.data, 'thread/turns/list response.data').map(decodeTurn),
    nextCursor: nullableString(record.nextCursor, 'thread/turns/list response.nextCursor'),
    backwardsCursor: nullableString(record.backwardsCursor, 'thread/turns/list response.backwardsCursor'),
  });
}

function decodeThreadItemsListResponse(value: unknown): AgentCoreResponseByMethod['thread/items/list'] {
  const record = recordValue(value, 'thread/items/list response');
  exactKeys(record, ['data', 'nextCursor', 'backwardsCursor'], 'thread/items/list response');
  return deepFreeze({
    data: arrayValue(record.data, 'thread/items/list response.data').map((entry, index) => {
      const item = recordValue(entry, `thread/items/list response.data[${index}]`);
      exactKeys(item, ['turnId', 'item'], `thread/items/list response.data[${index}]`);
      return {
        turnId: uuidV7(item.turnId, `thread/items/list response.data[${index}].turnId`),
        item: decodeThreadItem(item.item),
      };
    }),
    nextCursor: nullableString(record.nextCursor, 'thread/items/list response.nextCursor'),
    backwardsCursor: nullableString(record.backwardsCursor, 'thread/items/list response.backwardsCursor'),
  });
}

function decodeTurnStartResponse(value: unknown): AgentCoreResponseByMethod['turn/start'] {
  const record = recordValue(value, 'turn/start response');
  exactKeys(record, ['turn', 'acceptedItemId', 'deduplicated'], 'turn/start response');
  return deepFreeze({
    turn: decodeTurn(record.turn),
    acceptedItemId: stringValue(record.acceptedItemId, 'turn/start response.acceptedItemId'),
    deduplicated: booleanValue(record.deduplicated, 'turn/start response.deduplicated'),
  });
}

function decodeTurnSteerResponse(value: unknown): AgentCoreResponseByMethod['turn/steer'] {
  const record = recordValue(value, 'turn/steer response');
  exactKeys(record, ['turnId', 'acceptedItemId', 'deduplicated'], 'turn/steer response');
  return deepFreeze({
    turnId: uuidV7(record.turnId, 'turn/steer response.turnId'),
    acceptedItemId: stringValue(record.acceptedItemId, 'turn/steer response.acceptedItemId'),
    deduplicated: booleanValue(record.deduplicated, 'turn/steer response.deduplicated'),
  });
}

function decodeTurnInterruptResponse(value: unknown): AgentCoreResponseByMethod['turn/interrupt'] {
  const record = recordValue(value, 'turn/interrupt response');
  exactKeys(record, ['turnId'], 'turn/interrupt response');
  return deepFreeze({ turnId: uuidV7(record.turnId, 'turn/interrupt response.turnId') });
}

function decodeGoalGetResponse(value: unknown): AgentCoreResponseByMethod['goal/get'] {
  const record = recordValue(value, 'goal/get response');
  exactKeys(record, ['goal'], 'goal/get response');
  return deepFreeze({ goal: record.goal === null ? null : decodeThreadGoal(record.goal) });
}

function decodeGoalMutationResponse(value: unknown): AgentCoreResponseByMethod['goal/create'] {
  const record = recordValue(value, 'goal mutation response');
  exactKeys(record, ['goal'], 'goal mutation response');
  return deepFreeze({ goal: decodeThreadGoal(record.goal) });
}

function decodeRequestUserInputRequest(value: unknown): RequestUserInputRequest {
  const record = recordValue(value, 'userInput request');
  exactKeys(record, ['threadId', 'turnId', 'itemId', 'questions', 'autoResolutionMs'], 'userInput request');
  const questions = decodeRequestUserInputQuestions(record.questions);
  const autoResolutionMs = record.autoResolutionMs === undefined
    ? undefined
    : positiveInteger(record.autoResolutionMs, 'userInput request.autoResolutionMs');
  if (
    autoResolutionMs !== undefined
    && (
      autoResolutionMs < REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS
      || autoResolutionMs > REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS
    )
  ) {
    fail('userInput request.autoResolutionMs', 'must be within the canonical non-blocking timeout range');
  }
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'userInput request.threadId'),
    turnId: uuidV7(record.turnId, 'userInput request.turnId'),
    itemId: stringValue(record.itemId, 'userInput request.itemId'),
    questions,
    ...(autoResolutionMs === undefined ? {} : { autoResolutionMs }),
  });
}

function decodeRequestUserInputResponse(value: unknown): AgentCoreRequestByMethod['userInput/respond'] {
  const record = recordValue(value, 'userInput response');
  exactKeys(record, ['threadId', 'turnId', 'itemId', 'answers', 'autoResolved'], 'userInput response');
  const answers = arrayValue(record.answers, 'userInput response.answers');
  if (answers.length < 1 || answers.length > 3) {
    fail('userInput response.answers', 'requires one to three answers');
  }
  const questionIds = new Set<string>();
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'userInput response.threadId'),
    turnId: uuidV7(record.turnId, 'userInput response.turnId'),
    itemId: stringValue(record.itemId, 'userInput response.itemId'),
    answers: answers.map((entry, index) => {
      const answer = recordValue(entry, `userInput response.answers[${index}]`);
      exactKeys(answer, ['questionId', 'optionLabel', 'otherText'], `userInput response.answers[${index}]`);
      if ((answer.optionLabel === undefined) === (answer.otherText === undefined)) {
        fail(`userInput response.answers[${index}]`, 'requires exactly one of optionLabel or otherText');
      }
      const questionId = snakeCaseId(answer.questionId, `userInput response.answers[${index}].questionId`);
      if (questionIds.has(questionId)) {
        fail(`userInput response.answers[${index}].questionId`, 'answer question ids must be unique');
      }
      questionIds.add(questionId);
      return {
        questionId,
        ...(answer.optionLabel === undefined
          ? {}
          : { optionLabel: stringValue(answer.optionLabel, `userInput response.answers[${index}].optionLabel`) }),
        ...(answer.otherText === undefined
          ? {}
          : { otherText: stringValue(answer.otherText, `userInput response.answers[${index}].otherText`, true) }),
      };
    }),
    autoResolved: booleanValue(record.autoResolved, 'userInput response.autoResolved'),
  });
}

export function decodeRequestUserInputQuestions(value: unknown): readonly RequestUserInputQuestion[] {
  const questions = arrayValue(value, 'questions');
  if (questions.length < 1 || questions.length > 3) fail('questions', 'requires one to three questions');
  const ids = new Set<string>();
  return deepFreeze(questions.map((entry, index) => {
    const question = recordValue(entry, `questions[${index}]`);
    exactKeys(question, ['id', 'header', 'question', 'options'], `questions[${index}]`);
    const id = snakeCaseId(question.id, `questions[${index}].id`);
    if (ids.has(id)) fail(`questions[${index}].id`, 'question ids must be unique');
    ids.add(id);
    const header = stringValue(question.header, `questions[${index}].header`);
    if ([...header].length > 12) fail(`questions[${index}].header`, 'must not exceed 12 characters');
    const options = arrayValue(question.options, `questions[${index}].options`);
    if (options.length < 2 || options.length > 3) {
      fail(`questions[${index}].options`, 'requires two or three choices');
    }
    const labels = new Set<string>();
    return {
      id,
      header,
      question: stringValue(question.question, `questions[${index}].question`),
      options: options.map((option, optionIndex) => {
        const item = recordValue(option, `questions[${index}].options[${optionIndex}]`);
        exactKeys(item, ['label', 'description'], `questions[${index}].options[${optionIndex}]`);
        const label = stringValue(item.label, `questions[${index}].options[${optionIndex}].label`);
        if (label.trim().toLowerCase() === 'other') fail('questions', 'Other is supplied by the host');
        if (label.trim().split(/\s+/).length > 5) fail('questions', 'option labels must not exceed five words');
        if (optionIndex === 0 && !label.endsWith('(Recommended)')) {
          fail('questions', 'the first option must mark the recommended choice');
        }
        if (labels.has(label)) fail('questions', 'option labels must be unique');
        labels.add(label);
        return {
          label,
          description: stringValue(item.description, `questions[${index}].options[${optionIndex}].description`),
        };
      }),
    };
  }));
}

function decodePageRequest(record: Record<string, unknown>, path: string) {
  return {
    ...(record.cursor === undefined ? {} : { cursor: nullableString(record.cursor, `${path}.cursor`) }),
    ...(record.limit === undefined ? {} : { limit: nullablePositiveInteger(record.limit, `${path}.limit`) }),
    ...(record.sortDirection === undefined
      ? {}
      : { sortDirection: nullableEnum(record.sortDirection, ['asc', 'desc'], `${path}.sortDirection`) }),
  };
}

export function decodeAgentMutationCausation(value: unknown): AgentMutationCausation {
  const record = recordValue(value, 'causation');
  exactKeys(record, ['threadId', 'turnId', 'itemId'], 'causation');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'causation.threadId'),
    turnId: uuidV7(record.turnId, 'causation.turnId'),
    itemId: stringValue(record.itemId, 'causation.itemId'),
  });
}

export function createLocalTurnProvenance(
  threadId: string,
  turnId: string,
  trigger: TurnTrigger,
): TurnProvenance {
  return deepFreeze({
    originThreadId: uuidV7(threadId, 'threadId'),
    originTurnId: uuidV7(turnId, 'turnId'),
    trigger: decodeTurnTrigger(trigger),
  });
}

export function createLocalItemProvenance(
  threadId: string,
  turnId: string,
  itemId: string,
): ItemProvenance {
  return deepFreeze({
    originThreadId: uuidV7(threadId, 'threadId'),
    originTurnId: uuidV7(turnId, 'turnId'),
    originItemId: stringValue(itemId, 'itemId'),
  });
}

function decodeThreadStatus(value: unknown): ThreadStatus {
  const record = recordValue(value, 'thread.status');
  const type = enumValue(record.type, ['notLoaded', 'idle', 'active', 'systemError'], 'thread.status.type');
  switch (type) {
    case 'active': {
      exactKeys(record, ['type', 'activeFlags'], 'thread.status');
      const activeFlags = arrayValue(record.activeFlags, 'thread.status.activeFlags').map((entry, index) =>
        enumValue(entry, ['waitingOnUserInput'], `thread.status.activeFlags[${index}]`));
      if (new Set(activeFlags).size !== activeFlags.length) fail('thread.status.activeFlags', 'flags must be unique');
      return deepFreeze({ type, activeFlags });
    }
    case 'systemError':
      exactKeys(record, ['type', 'message'], 'thread.status');
      return deepFreeze({
        type,
        ...(record.message === undefined ? {} : { message: stringValue(record.message, 'thread.status.message') }),
      });
    case 'notLoaded':
    case 'idle':
      exactKeys(record, ['type'], 'thread.status');
      return deepFreeze({ type });
  }
}

function decodeTurnProvenance(value: unknown): TurnProvenance {
  const record = recordValue(value, 'turn.provenance');
  exactKeys(record, ['originThreadId', 'originTurnId', 'trigger'], 'turn.provenance');
  return deepFreeze({
    originThreadId: uuidV7(record.originThreadId, 'turn.provenance.originThreadId'),
    originTurnId: uuidV7(record.originTurnId, 'turn.provenance.originTurnId'),
    trigger: decodeTurnTrigger(record.trigger),
  });
}

function decodeTurnTrigger(value: unknown): TurnTrigger {
  const record = recordValue(value, 'turn.trigger');
  const kind = enumValue(record.kind, ['user', 'subagent', 'feature'], 'turn.trigger.kind');
  switch (kind) {
    case 'user':
      exactKeys(record, ['kind'], 'turn.trigger');
      return deepFreeze({ kind });
    case 'subagent':
      exactKeys(record, ['kind', 'parentThreadId', 'parentItemId'], 'turn.trigger');
      return deepFreeze({
        kind,
        parentThreadId: uuidV7(record.parentThreadId, 'turn.trigger.parentThreadId'),
        parentItemId: stringValue(record.parentItemId, 'turn.trigger.parentItemId'),
      });
    case 'feature':
      exactKeys(record, ['kind', 'feature', 'ref'], 'turn.trigger');
      return deepFreeze({
        kind,
        feature: featureLabelValue(record.feature, 'turn.trigger.feature'),
        ...(record.ref === undefined ? {} : { ref: stringValue(record.ref, 'turn.trigger.ref') }),
      });
  }
}

function decodeItemProvenance(value: unknown): ItemProvenance {
  const record = recordValue(value, 'item.provenance');
  exactKeys(record, ['originThreadId', 'originTurnId', 'originItemId'], 'item.provenance');
  return deepFreeze({
    originThreadId: uuidV7(record.originThreadId, 'item.provenance.originThreadId'),
    originTurnId: uuidV7(record.originTurnId, 'item.provenance.originTurnId'),
    originItemId: stringValue(record.originItemId, 'item.provenance.originItemId'),
  });
}

function decodeUserContent(value: unknown): ThreadUserContent {
  const record = recordValue(value, 'userContent');
  const type = enumValue(record.type, ['text', 'attachment', 'nodeReference'], 'userContent.type');
  if (type === 'text') {
    exactKeys(record, ['type', 'text'], 'userContent');
    return deepFreeze<ThreadTextContent>({ type, text: stringValue(record.text, 'userContent.text', true) });
  }
  if (type === 'nodeReference') {
    exactKeys(record, ['type', 'nodeId', 'note'], 'userContent');
    return deepFreeze<ThreadNodeReferenceContent>({
      type,
      nodeId: stringValue(record.nodeId, 'userContent.nodeId'),
      ...(record.note === undefined ? {} : { note: stringValue(record.note, 'userContent.note', true) }),
    });
  }
  exactKeys(record, ['type', 'id', 'name', 'mimeType', 'sizeBytes', 'source', 'extractedText'], 'userContent');
  const source = recordValue(record.source, 'userContent.source');
  const kind = enumValue(source.kind, ['asset', 'localFile', 'inline'], 'userContent.source.kind');
  let decodedSource: ThreadAttachmentContent['source'];
  if (kind === 'asset') {
    exactKeys(source, ['kind', 'assetId'], 'userContent.source');
    decodedSource = { kind, assetId: stringValue(source.assetId, 'userContent.source.assetId') };
  } else if (kind === 'localFile') {
    exactKeys(source, ['kind', 'path'], 'userContent.source');
    decodedSource = { kind, path: stringValue(source.path, 'userContent.source.path') };
  } else {
    exactKeys(source, ['kind', 'dataBase64'], 'userContent.source');
    decodedSource = { kind, dataBase64: stringValue(source.dataBase64, 'userContent.source.dataBase64') };
  }
  return deepFreeze<ThreadAttachmentContent>({
    type,
    id: stringValue(record.id, 'userContent.id'),
    name: stringValue(record.name, 'userContent.name'),
    mimeType: stringValue(record.mimeType, 'userContent.mimeType'),
    sizeBytes: nonNegativeInteger(record.sizeBytes, 'userContent.sizeBytes'),
    source: decodedSource,
    ...(record.extractedText === undefined
      ? {}
      : { extractedText: stringValue(record.extractedText, 'userContent.extractedText', true) }),
  });
}

function decodeMemoryCitation(value: unknown): MemoryCitation | null {
  if (value === null) return null;
  const record = recordValue(value, 'item.memoryCitation');
  exactKeys(record, ['entries', 'threadIds'], 'item.memoryCitation');
  return deepFreeze({
    entries: arrayValue(record.entries, 'item.memoryCitation.entries').map((entry, index) => {
      const item = recordValue(entry, `item.memoryCitation.entries[${index}]`);
      exactKeys(item, ['nodeId', 'note'], `item.memoryCitation.entries[${index}]`);
      return {
        nodeId: stringValue(item.nodeId, `item.memoryCitation.entries[${index}].nodeId`),
        note: stringValue(item.note, `item.memoryCitation.entries[${index}].note`, true),
      };
    }),
    threadIds: arrayValue(record.threadIds, 'item.memoryCitation.threadIds')
      .map((entry, index) => uuidV7(entry, `item.memoryCitation.threadIds[${index}]`)),
  });
}

function decodeTurnError(value: unknown): Turn['error'] {
  if (value === null) return null;
  const record = recordValue(value, 'turn.error');
  exactKeys(record, ['message', 'code', 'detail'], 'turn.error');
  return deepFreeze({
    message: stringValue(record.message, 'turn.error.message'),
    ...(record.code === undefined ? {} : { code: stringValue(record.code, 'turn.error.code') }),
    ...(record.detail === undefined ? {} : { detail: stringValue(record.detail, 'turn.error.detail', true) }),
  });
}

function decodeCommandAction(value: unknown): CommandAction {
  const record = recordValue(value, 'commandAction');
  exactKeys(record, ['kind', 'command', 'path', 'query'], 'commandAction');
  return deepFreeze({
    kind: stringValue(record.kind, 'commandAction.kind'),
    command: stringValue(record.command, 'commandAction.command'),
    ...(record.path === undefined ? {} : { path: stringValue(record.path, 'commandAction.path') }),
    ...(record.query === undefined ? {} : { query: stringValue(record.query, 'commandAction.query', true) }),
  });
}

function decodeFileChange(value: unknown): FileUpdateChange {
  const record = recordValue(value, 'fileChange');
  exactKeys(record, ['path', 'kind', 'diff', 'movedTo'], 'fileChange');
  const kind = enumValue(record.kind, ['add', 'delete', 'update', 'move'], 'fileChange.kind');
  if (kind === 'move' && record.movedTo === undefined) fail('fileChange.movedTo', 'move requires a destination');
  return deepFreeze({
    path: stringValue(record.path, 'fileChange.path'),
    kind,
    ...(record.diff === undefined ? {} : { diff: stringValue(record.diff, 'fileChange.diff', true) }),
    ...(record.movedTo === undefined ? {} : { movedTo: stringValue(record.movedTo, 'fileChange.movedTo') }),
  });
}

function decodeDynamicToolOutput(value: unknown): DynamicToolOutputContent {
  const record = recordValue(value, 'dynamicToolOutput');
  const type = enumValue(record.type, ['text', 'image', 'json'], 'dynamicToolOutput.type');
  if (type === 'text') {
    exactKeys(record, ['type', 'text'], 'dynamicToolOutput');
    return deepFreeze({ type, text: stringValue(record.text, 'dynamicToolOutput.text', true) });
  }
  if (type === 'image') {
    exactKeys(record, ['type', 'imageRef', 'alt'], 'dynamicToolOutput');
    return deepFreeze({
      type,
      imageRef: stringValue(record.imageRef, 'dynamicToolOutput.imageRef'),
      ...(record.alt === undefined ? {} : { alt: stringValue(record.alt, 'dynamicToolOutput.alt', true) }),
    });
  }
  exactKeys(record, ['type', 'value'], 'dynamicToolOutput');
  return deepFreeze({ type, value: jsonValue(record.value, 'dynamicToolOutput.value') });
}

function decodeItemDelta(value: unknown): ThreadItemDelta {
  const record = recordValue(value, 'item.delta');
  const type = enumValue(
    record.type,
    ['agentMessageText', 'planText', 'reasoningSummary', 'reasoningContent', 'commandOutput', 'dynamicToolOutput'],
    'item.delta.type',
  );
  if (type === 'dynamicToolOutput') {
    exactKeys(record, ['type', 'delta'], 'item.delta');
    return deepFreeze({ type, delta: decodeDynamicToolOutput(record.delta) });
  }
  exactKeys(record, ['type', 'delta'], 'item.delta');
  return deepFreeze({ type, delta: stringValue(record.delta, 'item.delta.delta', true) });
}

function itemExecutionStatus(value: unknown, path: string) {
  const status = stringValue(value, path);
  if (!ITEM_EXECUTION_STATUSES.has(status)) fail(path, 'invalid item execution status');
  return status as 'inProgress' | 'completed' | 'failed' | 'interrupted';
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'JSON numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`));
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = jsonValue(entry, `${path}.${key}`);
    }
    return result;
  }
  fail(path, 'value is not JSON serializable');
}

function parseJson(value: string, path: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail(path, 'invalid JSON');
  }
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object');
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return arrayValue(value, path).map((entry, index) => stringValue(entry, `${path}[${index}]`, true));
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) fail(path, 'expected a string');
  return value;
}

function nullableString(value: unknown, path: string, allowEmpty = false): string | null {
  return value === null ? null : stringValue(value, path, allowEmpty);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  return value === null ? null : booleanValue(value, path);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : finiteNumber(value, path);
}

function nullableInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) fail(path, 'expected a safe integer');
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, 'expected a non-negative safe integer');
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(path, 'expected a positive safe integer');
  return value as number;
}

function nullablePositiveInteger(value: unknown, path: string): number | null {
  return value === null ? null : positiveInteger(value, path);
}

function nonNegativeNumber(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number < 0) fail(path, 'expected a non-negative number');
  return number;
}

function snakeCaseId(value: unknown, path: string): string {
  const id = stringValue(value, path);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) fail(path, 'expected a snake_case identifier');
  return id;
}

function featureLabelValue(value: unknown, path: string): string {
  const label = stringValue(value, path);
  if (label !== label.trim() || label.startsWith('feature:')) {
    fail(path, 'expected a plain canonical feature label');
  }
  return label;
}

function uuidV7(value: unknown, path: string): string {
  const id = stringValue(value, path);
  if (!UUID_V7_PATTERN.test(id)) fail(path, 'expected a UUIDv7 identifier');
  return id;
}

function nullableUuidV7(value: unknown, path: string): string | null {
  return value === null ? null : uuidV7(value, path);
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  const entry = stringValue(value, path);
  if (!(allowed as readonly string[]).includes(entry)) fail(path, `expected one of: ${allowed.join(', ')}`);
  return entry as T[number];
}

function nullableEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] | null {
  return value === null ? null : enumValue(value, allowed, path);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(path, `unknown fields: ${unknown.join(', ')}`);
}

function fail(path: string, message: string): never {
  throw new AgentProtocolCodecError(`${path}: ${message}`);
}

function assertNever(value: never): never {
  throw new AgentProtocolCodecError(`Unhandled ThreadItem variant: ${String(value)}`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}
