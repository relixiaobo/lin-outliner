import {
  CONTEXT_EVIDENCE_KINDS,
  CONTEXT_PAYLOAD_KINDS,
  MAX_THREAD_CONTEXT_PAYLOAD_BYTES,
  MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES,
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
  type AgentCoreRecordedNotification,
  type AgentCoreRequestByMethod,
  type AgentCoreResponseByMethod,
  type AgentCoreTransientNotification,
  type AgentMutationCausation,
  type CommandAction,
  type ContextCursor,
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
  type ThreadContextPayload,
  type ThreadContextPayloadReference,
  type ThreadFileSource,
  type ThreadItem,
  type ThreadItemDelta,
  type ThreadItemOutputReference,
  type ThreadNodeReferenceContent,
  type ThreadSource,
  type ThreadStatus,
  type ThreadTextContent,
  type ThreadUserContent,
  type ThreadResourceReference,
  type Turn,
  type TurnDiagnosticsPayload,
  type TurnDiagnosticsPayloadReference,
  type TurnProvenance,
  type TurnTrigger,
} from './protocol';
import { MAX_MANAGED_ATTACHMENT_BYTES } from '../agentAttachmentLimits';
import { safeAttachmentFileName } from '../agentAttachmentPaths';
import {
  THREAD_GOAL_STATUSES,
  type ThreadGoal,
} from './goal';
import { REASONING_EFFORTS } from './configuration';

export class AgentProtocolCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProtocolCodecError';
  }
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/;
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
  if (result.turns) validateThreadContextCursors(result.turns);
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
    'execution',
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
    execution: decodeTurnExecution(record.execution),
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
      exactKeys(record, ['type', 'id', 'provenance', 'clientId', 'content', 'acceptedAt'], 'item');
      result = {
        ...base,
        type,
        clientId: nullableString(record.clientId, 'item.clientId'),
        content: arrayValue(record.content, 'item.content').map(decodeUserContent),
        acceptedAt: nonNegativeNumber(record.acceptedAt, 'item.acceptedAt'),
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
        'aggregatedOutput', 'exitCode', 'durationMs', 'outputRef',
      ], 'item');
      result = {
        ...base,
        type,
        command: stringValue(record.command, 'item.command'),
        cwd: stringValue(record.cwd, 'item.cwd'),
        processId: nullableString(record.processId, 'item.processId'),
        status: itemExecutionStatus(record.status, 'item.status'),
        outputRef: decodeThreadItemOutputReference(record.outputRef),
        commandActions: arrayValue(record.commandActions, 'item.commandActions').map(decodeCommandAction),
        aggregatedOutput: nullableString(record.aggregatedOutput, 'item.aggregatedOutput', true),
        exitCode: nullableInteger(record.exitCode, 'item.exitCode'),
        durationMs: nullableNumber(record.durationMs, 'item.durationMs'),
      };
      break;
    case 'fileChange':
      exactKeys(record, ['type', 'id', 'provenance', 'changes', 'status', 'outputRef'], 'item');
      result = {
        ...base,
        type,
        changes: arrayValue(record.changes, 'item.changes').map(decodeFileChange),
        status: itemExecutionStatus(record.status, 'item.status'),
        outputRef: decodeThreadItemOutputReference(record.outputRef),
      };
      break;
    case 'mcpToolCall':
      exactKeys(record, [
        'type', 'id', 'provenance', 'server', 'tool', 'status', 'arguments', 'pluginId', 'result',
        'error', 'durationMs', 'outputRef',
      ], 'item');
      result = {
        ...base,
        type,
        server: stringValue(record.server, 'item.server'),
        tool: stringValue(record.tool, 'item.tool'),
        status: itemExecutionStatus(record.status, 'item.status'),
        outputRef: decodeThreadItemOutputReference(record.outputRef),
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
        'success', 'durationMs', 'outputRef',
      ], 'item');
      result = {
        ...base,
        type,
        namespace: nullableString(record.namespace, 'item.namespace'),
        tool: stringValue(record.tool, 'item.tool'),
        arguments: jsonValue(record.arguments, 'item.arguments'),
        status: itemExecutionStatus(record.status, 'item.status'),
        outputRef: decodeThreadItemOutputReference(record.outputRef),
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
        'model', 'reasoningEffort', 'agentsStates', 'outputRef',
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
        outputRef: decodeThreadItemOutputReference(record.outputRef),
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
      exactKeys(record, ['type', 'id', 'provenance', 'query', 'status', 'results', 'error', 'outputRef'], 'item');
      result = {
        ...base,
        type,
        query: stringValue(record.query, 'item.query'),
        status: itemExecutionStatus(record.status, 'item.status'),
        outputRef: decodeThreadItemOutputReference(record.outputRef),
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
    case 'contextEvidence':
      exactKeys(record, [
        'type', 'id', 'provenance', 'kind', 'payloadRef', 'summary', 'contextRefs', 'resourceRefs', 'outputRefs',
      ], 'item');
      result = {
        ...base,
        type,
        kind: enumValue(record.kind, CONTEXT_EVIDENCE_KINDS, 'item.kind'),
        payloadRef: decodeThreadContextPayloadReference(record.payloadRef, 'item.payloadRef'),
        summary: stringValue(record.summary, 'item.summary'),
        contextRefs: arrayValue(record.contextRefs, 'item.contextRefs')
          .map((ref, index) => decodeThreadContextPayloadReference(ref, `item.contextRefs[${index}]`)),
        resourceRefs: arrayValue(record.resourceRefs, 'item.resourceRefs')
          .map((ref, index) => decodeThreadResourceReference(ref, `item.resourceRefs[${index}]`)),
        outputRefs: arrayValue(record.outputRefs, 'item.outputRefs')
          .map((ref, index) => decodeRequiredThreadItemOutputReference(ref, `item.outputRefs[${index}]`)),
      };
      break;
    case 'contextReset':
      exactKeys(record, ['type', 'id', 'provenance', 'clearedThrough'], 'item');
      result = { ...base, type, clearedThrough: decodeContextCursor(record.clearedThrough, 'item.clearedThrough') };
      break;
    case 'contextCompaction':
      exactKeys(record, [
        'type', 'id', 'provenance', 'trigger', 'coveredFrom', 'coveredThrough', 'preservedFrom',
        'summaryRef', 'restoredStateRef', 'instructionsRef', 'contextRefs', 'resourceRefs', 'outputRefs',
      ], 'item');
      result = {
        ...base,
        type,
        trigger: enumValue(
          record.trigger,
          ['automaticPreflight', 'providerOverflow', 'manual'],
          'item.trigger',
        ),
        coveredFrom: decodeContextCursor(record.coveredFrom, 'item.coveredFrom'),
        coveredThrough: decodeContextCursor(record.coveredThrough, 'item.coveredThrough'),
        preservedFrom: record.preservedFrom === null
          ? null
          : decodeContextCursor(record.preservedFrom, 'item.preservedFrom'),
        summaryRef: decodeThreadContextPayloadReference(record.summaryRef, 'item.summaryRef'),
        restoredStateRef: decodeThreadContextPayloadReference(record.restoredStateRef, 'item.restoredStateRef'),
        instructionsRef: record.instructionsRef === null
          ? null
          : decodeThreadContextPayloadReference(record.instructionsRef, 'item.instructionsRef'),
        contextRefs: arrayValue(record.contextRefs, 'item.contextRefs')
          .map((ref, index) => decodeThreadContextPayloadReference(ref, `item.contextRefs[${index}]`)),
        resourceRefs: arrayValue(record.resourceRefs, 'item.resourceRefs')
          .map((ref, index) => decodeThreadResourceReference(ref, `item.resourceRefs[${index}]`)),
        outputRefs: arrayValue(record.outputRefs, 'item.outputRefs')
          .map((ref, index) => decodeRequiredThreadItemOutputReference(ref, `item.outputRefs[${index}]`)),
      };
      break;
    default:
      return assertNever(type);
  }
  validateContextItemReferences(result);
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
  exactKeys(record, ['threadId', 'input', 'clientUserMessageId', 'additionalContext', 'userView'], 'turnStart');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'turnStart.threadId'),
    input: arrayValue(record.input, 'turnStart.input').map(decodeUserContent),
    ...(record.clientUserMessageId === undefined
      ? {}
      : { clientUserMessageId: nullableString(record.clientUserMessageId, 'turnStart.clientUserMessageId') }),
    ...(record.additionalContext === undefined
      ? {}
      : { additionalContext: decodeAdditionalContext(record.additionalContext, false) }),
    ...(record.userView === undefined ? {} : { userView: decodeRendererUserViewHints(record.userView) }),
  });
}

export function decodePrivilegedTurnStartRequest(value: unknown): PrivilegedTurnStartRequest {
  const record = recordValue(value, 'privilegedTurnStart');
  exactKeys(record, [
    'threadId', 'turnId', 'input', 'clientUserMessageId', 'additionalContext', 'userView', 'trigger',
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
    ...(record.userView === undefined ? {} : { userView: decodeRendererUserViewHints(record.userView) }),
    trigger: decodeTurnTrigger(record.trigger),
  });
}

function decodeRendererUserViewHints(value: unknown) {
  const record = recordValue(value, 'userView');
  exactKeys(record, [
    'activePanelId', 'focusedPanelId', 'focusSurface', 'focusedNodeId',
    'selectedNodeIds', 'panels', 'truncated',
  ], 'userView');
  const selectedNodeIds = arrayValue(record.selectedNodeIds, 'userView.selectedNodeIds')
    .map((entry, index) => nonEmptyTrimmedString(entry, `userView.selectedNodeIds[${index}]`));
  if (selectedNodeIds.length > 50) fail('userView.selectedNodeIds', 'exceeds the 50-node limit');
  requireUnique(selectedNodeIds, 'userView.selectedNodeIds', 'Node ids');
  const panels = arrayValue(record.panels, 'userView.panels').map((entry, panelIndex) => {
    const panel = recordValue(entry, `userView.panels[${panelIndex}]`);
    exactKeys(panel, [
      'panelId', 'rootNodeId', 'order', 'active', 'focused', 'visibleNodes',
      'visibleOutlineTruncated',
    ], `userView.panels[${panelIndex}]`);
    return {
      panelId: nonEmptyTrimmedString(panel.panelId, `userView.panels[${panelIndex}].panelId`),
      rootNodeId: nonEmptyTrimmedString(panel.rootNodeId, `userView.panels[${panelIndex}].rootNodeId`),
      order: nonNegativeInteger(panel.order, `userView.panels[${panelIndex}].order`),
      active: booleanValue(panel.active, `userView.panels[${panelIndex}].active`),
      focused: booleanValue(panel.focused, `userView.panels[${panelIndex}].focused`),
      visibleNodes: arrayValue(panel.visibleNodes, `userView.panels[${panelIndex}].visibleNodes`)
        .map((visible, visibleIndex) => {
          const path = `userView.panels[${panelIndex}].visibleNodes[${visibleIndex}]`;
          const node = recordValue(visible, path);
          exactKeys(node, ['nodeId', 'depth', 'expanded'], path);
          const depth = nonNegativeInteger(node.depth, `${path}.depth`);
          if (depth > 5) fail(`${path}.depth`, 'exceeds the depth-5 limit');
          return {
            nodeId: nonEmptyTrimmedString(node.nodeId, `${path}.nodeId`),
            depth,
            expanded: booleanValue(node.expanded, `${path}.expanded`),
          };
        }),
      visibleOutlineTruncated: booleanValue(
        panel.visibleOutlineTruncated,
        `userView.panels[${panelIndex}].visibleOutlineTruncated`,
      ),
    };
  });
  if (panels.reduce((total, panel) => total + panel.visibleNodes.length, 0) > 80) {
    fail('userView.panels', 'exceeds the 80-visible-node limit');
  }
  requireUnique(panels.map((panel) => panel.panelId), 'userView.panels', 'panel ids');
  const decoded = {
    activePanelId: nullableString(record.activePanelId, 'userView.activePanelId'),
    focusedPanelId: nullableString(record.focusedPanelId, 'userView.focusedPanelId'),
    focusSurface: nullableString(record.focusSurface, 'userView.focusSurface'),
    focusedNodeId: nullableString(record.focusedNodeId, 'userView.focusedNodeId'),
    selectedNodeIds,
    panels,
    truncated: booleanValue(record.truncated, 'userView.truncated'),
  };
  if (new TextEncoder().encode(JSON.stringify(decoded)).byteLength > 64 * 1024) {
    fail('userView', 'exceeds the 64 KiB serialized limit');
  }
  return decoded;
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
    'thread/name/updated',
    'thread/status/changed',
    'turn/started',
    'item/started',
    'item/delta',
    'item/completed',
    'items/completed',
    'turn/completed',
    'turn/providerRetry/changed',
    'turn/plan/updated',
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
    case 'thread/name/updated': {
      exactKeys(record, ['type', 'threadId', 'threadName'], 'notification');
      const threadId = uuidV7(record.threadId, 'notification.threadId');
      result = {
        type,
        threadId,
        ...(record.threadName === undefined || record.threadName === null
          ? {}
          : { threadName: stringValue(record.threadName, 'notification.threadName') }),
      };
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
      if (type === 'turn/started' && turn.items.some((item) => executionStatusOf(item) === 'inProgress')) {
        fail('notification.turn', 'turn/started initial Items must already be complete');
      }
      if (type === 'turn/completed' && turn.status === 'inProgress') {
        fail('notification.turn', 'turn/completed requires a terminal Turn');
      }
      result = { type, threadId: uuidV7(record.threadId, 'notification.threadId'), turnId, turn };
      break;
    }
    case 'turn/providerRetry/changed': {
      exactKeys(record, ['type', 'threadId', 'turnId', 'status'], 'notification');
      const statusRecord = record.status === null
        ? null
        : recordValue(record.status, 'notification.status');
      if (statusRecord) exactKeys(statusRecord, ['kind', 'attempt', 'maxRetries'], 'notification.status');
      result = {
        type,
        threadId: uuidV7(record.threadId, 'notification.threadId'),
        turnId: uuidV7(record.turnId, 'notification.turnId'),
        status: statusRecord === null ? null : {
          kind: enumValue(statusRecord.kind, ['request', 'stream'], 'notification.status.kind'),
          attempt: positiveInteger(statusRecord.attempt, 'notification.status.attempt'),
          maxRetries: positiveInteger(statusRecord.maxRetries, 'notification.status.maxRetries'),
        },
      };
      if (result.status && result.status.attempt > result.status.maxRetries) {
        fail('notification.status.attempt', 'must not exceed maxRetries');
      }
      break;
    }
    case 'turn/plan/updated': {
      exactKeys(record, ['type', 'threadId', 'turnId', 'explanation', 'plan'], 'notification');
      const plan = arrayValue(record.plan, 'notification.plan').map((entry, index) => {
        const step = recordValue(entry, `notification.plan[${index}]`);
        exactKeys(step, ['step', 'status'], `notification.plan[${index}]`);
        return {
          step: stringValue(step.step, `notification.plan[${index}].step`),
          status: enumValue(
            step.status,
            ['pending', 'in_progress', 'completed'],
            `notification.plan[${index}].status`,
          ),
        };
      });
      if (plan.filter((step) => step.status === 'in_progress').length > 1) {
        fail('notification.plan', 'allows at most one in_progress step');
      }
      result = {
        type,
        threadId: uuidV7(record.threadId, 'notification.threadId'),
        turnId: uuidV7(record.turnId, 'notification.turnId'),
        ...(record.explanation === undefined
          ? {}
          : { explanation: stringValue(record.explanation, 'notification.explanation') }),
        plan,
      };
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
    case 'items/completed': {
      exactKeys(record, ['type', 'threadId', 'turnId', 'items', 'completedAt'], 'notification');
      const items = arrayValue(record.items, 'notification.items').map((item, index) => {
        const decoded = decodeThreadItem(item);
        if (executionStatusOf(decoded) === 'inProgress') {
          fail(`notification.items[${index}]`, 'items/completed requires terminal executable Items');
        }
        return decoded;
      });
      if (items.length === 0) fail('notification.items', 'must not be empty');
      const itemIds = items.map((item) => item.id);
      if (new Set(itemIds).size !== itemIds.length) fail('notification.items', 'must not contain duplicate Item ids');
      result = {
        type,
        threadId: uuidV7(record.threadId, 'notification.threadId'),
        turnId: uuidV7(record.turnId, 'notification.turnId'),
        items,
        completedAt: finiteNumber(record.completedAt, 'notification.completedAt'),
      };
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

export function decodeAgentCoreRecordedNotification(value: unknown): AgentCoreRecordedNotification {
  const notification = decodeAgentCoreNotification(value);
  switch (notification.type) {
    case 'thread/name/updated':
    case 'turn/providerRetry/changed':
    case 'turn/plan/updated':
      fail('notification.type', `cannot record transient notification ${notification.type}`);
    default:
      return notification;
  }
}

export function decodeAgentCoreTransientNotification(value: unknown): AgentCoreTransientNotification {
  const notification = decodeAgentCoreNotification(value);
  switch (notification.type) {
    case 'thread/name/updated':
    case 'turn/providerRetry/changed':
    case 'turn/plan/updated':
      return notification;
    default:
      fail('notification.type', `expected transient notification, received ${notification.type}`);
  }
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
    case 'reasoning':
    case 'subAgentActivity':
    case 'imageView':
    case 'contextEvidence':
    case 'contextReset':
    case 'contextCompaction':
      return null;
    default:
      return assertNever(item);
  }
}

function validateContextItemReferences(item: ThreadItem): void {
  if (item.type !== 'contextEvidence' && item.type !== 'contextCompaction') return;
  if (item.type === 'contextEvidence') {
    expectContextPayloadKind(item.payloadRef, item.kind, 'item.payloadRef');
  } else {
    expectContextPayloadKind(item.summaryRef, 'compactionSummary', 'item.summaryRef');
    expectContextPayloadKind(item.restoredStateRef, 'compactionRestoredState', 'item.restoredStateRef');
    if (item.instructionsRef) {
      expectContextPayloadKind(item.instructionsRef, 'compactionInstructions', 'item.instructionsRef');
    }
  }
  requireUnique(
    item.contextRefs.map((ref) => [
      ref.id,
      ref.mimeType,
      ref.byteLength,
      ref.schemaVersion,
      ref.kind,
    ].join('\0')),
    'item.contextRefs',
    'references',
  );
  requireUnique(
    item.resourceRefs.map((ref) => [ref.id, ref.mimeType, ref.byteLength, ref.fileName].join('\0')),
    'item.resourceRefs',
    'references',
  );
  requireUnique(
    item.outputRefs.map((ref) => [ref.id, ref.mimeType, ref.byteLength, ref.summary].join('\0')),
    'item.outputRefs',
    'references',
  );
  const direct = item.type === 'contextEvidence'
    ? [item.payloadRef]
    : [item.summaryRef, item.restoredStateRef, ...(item.instructionsRef ? [item.instructionsRef] : [])];
  const directIds = new Set(direct.map((ref) => ref.id));
  if (item.contextRefs.some((ref) => directIds.has(ref.id))) {
    fail('item.contextRefs', 'direct Item payloads must not be repeated as dependencies');
  }
}

function validateThreadContextCursors(turns: readonly Turn[]): void {
  if (turns.some((turn) => turn.itemsView !== 'full')) return;
  const positions = new Map<string, number>();
  const ordered: ThreadItem[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      const key = `${turn.id}\0${item.id}`;
      if (positions.has(key)) fail('thread.turns', `duplicate context cursor target ${turn.id}/${item.id}`);
      positions.set(key, ordered.length);
      ordered.push(item);
    }
  }
  const positionOf = (cursor: ContextCursor, field: string): number => {
    const position = positions.get(`${cursor.turnId}\0${cursor.itemId}`);
    if (position === undefined) fail(field, 'cursor target is not reachable in this Thread');
    return position;
  };
  for (let position = 0; position < ordered.length; position += 1) {
    const item = ordered[position]!;
    if (item.type === 'contextReset') {
      if (positionOf(item.clearedThrough, 'item.clearedThrough') >= position) {
        fail('item.clearedThrough', 'reset cursor must precede its Item');
      }
      continue;
    }
    if (item.type !== 'contextCompaction') continue;
    const coveredFrom = positionOf(item.coveredFrom, 'item.coveredFrom');
    const coveredThrough = positionOf(item.coveredThrough, 'item.coveredThrough');
    if (coveredFrom > coveredThrough) fail('item', 'coveredFrom must not follow coveredThrough');
    if (coveredThrough >= position) fail('item.coveredThrough', 'compaction range must precede its Item');
    if (item.preservedFrom) {
      const preservedFrom = positionOf(item.preservedFrom, 'item.preservedFrom');
      if (preservedFrom <= coveredThrough || preservedFrom >= position) {
        fail('item.preservedFrom', 'preserved tail must follow the covered range and precede compaction');
      }
    }
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
    case 'thread/configuration/get':
    case 'thread/archive':
    case 'thread/unarchive':
    case 'thread/delete':
      decoded = decodeThreadIdentityRequest(value);
      break;
    case 'thread/fork':
      decoded = decodeThreadForkRequest(value);
      break;
    case 'thread/rollback':
      decoded = decodeThreadRollbackRequest(value);
      break;
    case 'thread/name/set':
      decoded = decodeThreadNameSetRequest(value);
      break;
    case 'thread/configuration/set':
      decoded = decodeThreadConfigurationSetRequest(value);
      break;
    case 'thread/turns/list':
      decoded = decodeThreadTurnsListRequest(value);
      break;
    case 'thread/items/list':
      decoded = decodeThreadItemsListRequest(value);
      break;
    case 'thread/item/output/read':
      decoded = decodeThreadItemOutputReadRequest(value);
      break;
    case 'thread/context/read':
      decoded = decodeThreadContextReadRequest(value);
      break;
    case 'thread/turn/details/read':
      decoded = decodeThreadTurnDetailsReadRequest(value);
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
    case 'thread/rollback':
      decoded = decodeThreadResponse(value);
      break;
    case 'thread/configuration/get':
    case 'thread/configuration/set':
      decoded = decodeThreadConfigurationResponse(value);
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
    case 'thread/item/output/read':
      decoded = decodeThreadItemOutputReadResponse(value);
      break;
    case 'thread/context/read':
      decoded = decodeThreadContextReadResponse(value);
      break;
    case 'thread/turn/details/read':
      decoded = decodeThreadTurnDetailsReadResponse(value);
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
    ...(record.modelProvider === undefined
      ? {}
      : { modelProvider: stringValue(record.modelProvider, 'thread/start.modelProvider') }),
    ...(record.cwd === undefined ? {} : { cwd: stringValue(record.cwd, 'thread/start.cwd') }),
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

function decodeThreadRollbackRequest(value: unknown): AgentCoreRequestByMethod['thread/rollback'] {
  const record = recordValue(value, 'thread/rollback');
  exactKeys(record, ['threadId', 'numTurns'], 'thread/rollback');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/rollback.threadId'),
    numTurns: positiveInteger(record.numTurns, 'thread/rollback.numTurns'),
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

function decodeThreadConfigurationSetRequest(
  value: unknown,
): AgentCoreRequestByMethod['thread/configuration/set'] {
  const record = recordValue(value, 'thread/configuration/set');
  exactKeys(record, ['threadId', 'modelProvider', 'model', 'reasoningEffort'], 'thread/configuration/set');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/configuration/set.threadId'),
    ...decodeThreadConfigurationSummary({
      modelProvider: record.modelProvider,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
    }, 'thread/configuration/set'),
  });
}

function decodeThreadConfigurationResponse(
  value: unknown,
): AgentCoreResponseByMethod['thread/configuration/get'] {
  const record = recordValue(value, 'thread/configuration response');
  exactKeys(record, ['thread', 'configuration'], 'thread/configuration response');
  return deepFreeze({
    thread: decodeThread(record.thread),
    configuration: decodeThreadConfigurationSummary(
      recordValue(record.configuration, 'thread/configuration response.configuration'),
      'thread/configuration response.configuration',
    ),
  });
}

function decodeThreadConfigurationSummary(
  record: Record<string, unknown>,
  path: string,
): AgentCoreResponseByMethod['thread/configuration/get']['configuration'] {
  exactKeys(record, ['modelProvider', 'model', 'reasoningEffort'], path);
  const modelProvider = nonEmptyTrimmedString(record.modelProvider, `${path}.modelProvider`);
  const model = nonEmptyTrimmedString(record.model, `${path}.model`);
  const modelQualifier = model.indexOf('/');
  if (model !== 'inherit' && modelQualifier >= 0) {
    const qualifiedProvider = model.slice(0, modelQualifier);
    const qualifiedModel = model.slice(modelQualifier + 1);
    if (
      qualifiedProvider !== modelProvider
      || !qualifiedModel
      || qualifiedModel !== qualifiedModel.trim()
    ) {
      fail(`${path}.model`, 'expected a bare model id, inherit, or a model qualified by modelProvider');
    }
  }
  return deepFreeze({
    modelProvider,
    model,
    reasoningEffort: enumValue(record.reasoningEffort, REASONING_EFFORTS, `${path}.reasoningEffort`),
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

function decodeThreadItemOutputReadRequest(
  value: unknown,
): AgentCoreRequestByMethod['thread/item/output/read'] {
  const record = recordValue(value, 'thread/item/output/read');
  exactKeys(record, ['threadId', 'turnId', 'itemId', 'outputId'], 'thread/item/output/read');
  const outputId = stringValue(record.outputId, 'thread/item/output/read.outputId');
  if (!SHA_256_PATTERN.test(outputId)) {
    fail('thread/item/output/read.outputId', 'expected a lowercase SHA-256 digest');
  }
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/item/output/read.threadId'),
    turnId: uuidV7(record.turnId, 'thread/item/output/read.turnId'),
    itemId: stringValue(record.itemId, 'thread/item/output/read.itemId'),
    outputId,
  });
}

function decodeThreadContextReadRequest(
  value: unknown,
): AgentCoreRequestByMethod['thread/context/read'] {
  const record = recordValue(value, 'thread/context/read');
  exactKeys(record, ['threadId', 'turnId', 'itemId', 'contextId'], 'thread/context/read');
  const contextId = stringValue(record.contextId, 'thread/context/read.contextId');
  if (!SHA_256_PATTERN.test(contextId)) {
    fail('thread/context/read.contextId', 'expected a lowercase SHA-256 digest');
  }
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/context/read.threadId'),
    turnId: uuidV7(record.turnId, 'thread/context/read.turnId'),
    itemId: stringValue(record.itemId, 'thread/context/read.itemId'),
    contextId,
  });
}

function decodeThreadTurnDetailsReadRequest(
  value: unknown,
): AgentCoreRequestByMethod['thread/turn/details/read'] {
  const record = recordValue(value, 'thread/turn/details/read');
  exactKeys(record, ['threadId', 'turnId'], 'thread/turn/details/read');
  return deepFreeze({
    threadId: uuidV7(record.threadId, 'thread/turn/details/read.threadId'),
    turnId: uuidV7(record.turnId, 'thread/turn/details/read.turnId'),
  });
}

function decodeRendererTurnSteerRequest(value: unknown): AgentCoreRequestByMethod['turn/steer'] {
  const record = recordValue(value, 'turn/steer');
  exactKeys(record, [
    'threadId', 'expectedTurnId', 'input', 'clientUserMessageId', 'additionalContext', 'userView',
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
    ...(record.userView === undefined ? {} : { userView: decodeRendererUserViewHints(record.userView) }),
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

function decodeThreadItemOutputReadResponse(
  value: unknown,
): AgentCoreResponseByMethod['thread/item/output/read'] {
  const record = recordValue(value, 'thread/item/output/read response');
  exactKeys(record, ['output'], 'thread/item/output/read response');
  if (record.output === null) return deepFreeze({ output: null });
  const output = recordValue(record.output, 'thread/item/output/read response.output');
  exactKeys(output, ['ref', 'text'], 'thread/item/output/read response.output');
  const ref = decodeThreadItemOutputReference(output.ref);
  if (ref === null) fail('thread/item/output/read response.output.ref', 'expected an output reference');
  const text = stringValue(output.text, 'thread/item/output/read response.output.text', true);
  if (new TextEncoder().encode(text).byteLength !== ref.byteLength) {
    fail('thread/item/output/read response.output.text', 'byte length must match the output reference');
  }
  return deepFreeze({ output: { ref, text } });
}

function decodeThreadContextReadResponse(
  value: unknown,
): AgentCoreResponseByMethod['thread/context/read'] {
  const record = recordValue(value, 'thread/context/read response');
  exactKeys(record, ['context'], 'thread/context/read response');
  if (record.context === null) return deepFreeze({ context: null });
  const context = recordValue(record.context, 'thread/context/read response.context');
  exactKeys(context, ['ref', 'payload'], 'thread/context/read response.context');
  const ref = decodeThreadContextPayloadReference(context.ref, 'thread/context/read response.context.ref');
  const payload = decodeThreadContextPayload(context.payload);
  if (ref.kind !== payload.kind) {
    fail('thread/context/read response.context.payload.kind', 'must match the context reference kind');
  }
  const byteLength = new TextEncoder().encode(encodeThreadContextPayload(payload)).byteLength;
  if (byteLength !== ref.byteLength) {
    fail('thread/context/read response.context.payload', 'byte length must match the context reference');
  }
  return deepFreeze({ context: { ref, payload } });
}

function decodeThreadTurnDetailsReadResponse(
  value: unknown,
): AgentCoreResponseByMethod['thread/turn/details/read'] {
  const record = recordValue(value, 'thread/turn/details/read response');
  exactKeys(record, ['thread', 'turn', 'diagnostics'], 'thread/turn/details/read response');
  const thread = decodeThread(record.thread);
  const turn = decodeTurn(record.turn);
  if (record.diagnostics === null) {
    if (turn.execution.diagnosticsRef !== null) {
      fail('thread/turn/details/read response.diagnostics', 'is required by the Turn execution reference');
    }
    return deepFreeze({ thread, turn, diagnostics: null });
  }
  const diagnostics = recordValue(record.diagnostics, 'thread/turn/details/read response.diagnostics');
  exactKeys(diagnostics, ['ref', 'payload'], 'thread/turn/details/read response.diagnostics');
  const ref = decodeTurnDiagnosticsPayloadReference(
    diagnostics.ref,
    'thread/turn/details/read response.diagnostics.ref',
  );
  const payload = decodeTurnDiagnosticsPayload(diagnostics.payload);
  const turnItemsById = new Map(turn.items.map((item) => [item.id, item]));
  payload.providerCalls.forEach((call, callIndex) => {
    call.executionItemIds.forEach((itemId, itemIndex) => {
      const item = turnItemsById.get(itemId);
      if (!item || executionStatusOf(item) === null) {
        fail(
          `thread/turn/details/read response.diagnostics.payload.providerCalls[${callIndex}].executionItemIds[${itemIndex}]`,
          'must reference an executable Item in the returned Turn',
        );
      }
    });
  });
  const byteLength = new TextEncoder().encode(encodeTurnDiagnosticsPayload(payload)).byteLength;
  if (byteLength !== ref.byteLength) {
    fail('thread/turn/details/read response.diagnostics.payload', 'byte length must match the diagnostics reference');
  }
  const turnRef = turn.execution.diagnosticsRef;
  if (
    !turnRef
    || turnRef.id !== ref.id
    || turnRef.mimeType !== ref.mimeType
    || turnRef.byteLength !== ref.byteLength
    || turnRef.schemaVersion !== ref.schemaVersion
  ) {
    fail('thread/turn/details/read response.diagnostics.ref', 'must match the Turn execution reference');
  }
  return deepFreeze({ thread, turn, diagnostics: { ref, payload } });
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
  exactKeys(record, ['type', 'id', 'name', 'mimeType', 'sizeBytes', 'source', 'promptImage', 'extractedText'], 'userContent');
  const decodedSource = decodeThreadFileSource(record.source, 'userContent.source');
  return deepFreeze<ThreadAttachmentContent>({
    type,
    id: stringValue(record.id, 'userContent.id'),
    name: stringValue(record.name, 'userContent.name'),
    mimeType: stringValue(record.mimeType, 'userContent.mimeType'),
    sizeBytes: nonNegativeInteger(record.sizeBytes, 'userContent.sizeBytes'),
    source: decodedSource,
    ...(record.promptImage === undefined
      ? {}
      : { promptImage: decodeThreadResourceReference(record.promptImage, 'userContent.promptImage') }),
    ...(record.extractedText === undefined
      ? {}
      : { extractedText: stringValue(record.extractedText, 'userContent.extractedText', true) }),
  });
}

export function decodeThreadResourceReference(
  value: unknown,
  field = 'threadResourceReference',
): ThreadResourceReference {
  const record = recordValue(value, field);
  exactKeys(record, ['id', 'mimeType', 'byteLength', 'fileName'], field);
  const id = stringValue(record.id, `${field}.id`);
  if (!/^[a-f0-9]{64}$/u.test(id)) fail(`${field}.id`, 'expected a lowercase SHA-256 digest');
  const byteLength = nonNegativeInteger(record.byteLength, `${field}.byteLength`);
  if (byteLength > MAX_MANAGED_ATTACHMENT_BYTES) fail(`${field}.byteLength`, 'exceeds the managed resource budget');
  const fileName = stringValue(record.fileName, `${field}.fileName`);
  if (safeAttachmentFileName(fileName) !== fileName) fail(`${field}.fileName`, 'expected a safe base name');
  return deepFreeze({
    id,
    mimeType: stringValue(record.mimeType, `${field}.mimeType`),
    byteLength,
    fileName,
  });
}

function decodeThreadFileSource(value: unknown, field: string): ThreadFileSource {
  const source = recordValue(value, field);
  const kind = enumValue(source.kind, ['localFile', 'threadPayload'], `${field}.kind`);
  if (kind === 'localFile') {
    exactKeys(source, ['kind', 'path'], field);
    return deepFreeze({ kind, path: stringValue(source.path, `${field}.path`) });
  }
  exactKeys(source, ['kind', 'ref'], field);
  return deepFreeze({ kind, ref: decodeThreadResourceReference(source.ref, `${field}.ref`) });
}

export function decodeThreadContextPayloadReference(
  value: unknown,
  field = 'threadContextPayloadReference',
): ThreadContextPayloadReference {
  const record = recordValue(value, field);
  exactKeys(record, ['id', 'mimeType', 'byteLength', 'schemaVersion', 'kind'], field);
  const id = stringValue(record.id, `${field}.id`);
  if (!SHA_256_PATTERN.test(id)) fail(`${field}.id`, 'expected a lowercase SHA-256 digest');
  const byteLength = nonNegativeInteger(record.byteLength, `${field}.byteLength`);
  if (byteLength > MAX_THREAD_CONTEXT_PAYLOAD_BYTES) {
    fail(`${field}.byteLength`, 'exceeds the managed context payload budget');
  }
  if (record.schemaVersion !== 1) fail(`${field}.schemaVersion`, 'expected schema version 1');
  return deepFreeze({
    id,
    mimeType: enumValue(
      record.mimeType,
      ['application/vnd.tenon.agent-context+json'],
      `${field}.mimeType`,
    ),
    byteLength,
    schemaVersion: 1,
    kind: enumValue(record.kind, CONTEXT_PAYLOAD_KINDS, `${field}.kind`),
  });
}

export function decodeThreadContextPayload(value: unknown): ThreadContextPayload {
  const record = recordValue(value, 'contextPayload');
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== 1) fail('contextPayload.schemaVersion', 'expected schema version 1');
  const kind = enumValue(record.kind, CONTEXT_PAYLOAD_KINDS, 'contextPayload.kind');

  switch (kind) {
    case 'turnEnvironment':
      exactKeys(record, [
        'schemaVersion', 'kind', 'acceptedAt', 'utcInstant', 'localDate', 'localTime',
        'timeZone', 'utcOffsetMinutes', 'locale', 'workingDirectory', 'conversationMode',
        'executionMode', 'replyIdentity', 'todayNodeId',
      ], 'contextPayload');
      return deepFreeze({
        schemaVersion: 1,
        kind,
        acceptedAt: nonNegativeNumber(record.acceptedAt, 'contextPayload.acceptedAt'),
        utcInstant: isoInstant(record.utcInstant, 'contextPayload.utcInstant'),
        localDate: stringValue(record.localDate, 'contextPayload.localDate'),
        localTime: stringValue(record.localTime, 'contextPayload.localTime'),
        timeZone: stringValue(record.timeZone, 'contextPayload.timeZone'),
        utcOffsetMinutes: safeInteger(record.utcOffsetMinutes, 'contextPayload.utcOffsetMinutes'),
        locale: stringValue(record.locale, 'contextPayload.locale'),
        workingDirectory: stringValue(record.workingDirectory, 'contextPayload.workingDirectory'),
        conversationMode: enumValue(
          record.conversationMode,
          ['interactive', 'headless'],
          'contextPayload.conversationMode',
        ),
        executionMode: enumValue(
          record.executionMode,
          ['root', 'child', 'automation', 'memory', 'feature'],
          'contextPayload.executionMode',
        ),
        replyIdentity: nullableString(record.replyIdentity, 'contextPayload.replyIdentity'),
        todayNodeId: nullableString(record.todayNodeId, 'contextPayload.todayNodeId'),
      });
    case 'userView': {
      exactKeys(record, [
        'schemaVersion', 'kind', 'mode', 'activePanelId', 'focusedPanelId', 'focusSurface',
        'focusedNode', 'selectedNodes', 'referencedNodes', 'panels', 'truncated',
      ], 'contextPayload');
      const selectedNodes = arrayValue(record.selectedNodes, 'contextPayload.selectedNodes')
        .map((entry, index) => decodeUserViewNode(entry, `contextPayload.selectedNodes[${index}]`));
      if (selectedNodes.length > 50) fail('contextPayload.selectedNodes', 'exceeds the 50-node limit');
      const panels = arrayValue(record.panels, 'contextPayload.panels')
        .map((entry, index) => decodeUserViewPanel(entry, `contextPayload.panels[${index}]`));
      const visibleNodes = panels.reduce((total, panel) => total + panel.visibleOutline.length, 0);
      if (visibleNodes > 80) fail('contextPayload.panels', 'exceeds the 80-visible-node limit');
      return deepFreeze({
        schemaVersion: 1,
        kind,
        mode: enumValue(record.mode, ['interactive', 'nonInteractive'], 'contextPayload.mode'),
        activePanelId: nullableString(record.activePanelId, 'contextPayload.activePanelId'),
        focusedPanelId: nullableString(record.focusedPanelId, 'contextPayload.focusedPanelId'),
        focusSurface: nullableString(record.focusSurface, 'contextPayload.focusSurface'),
        focusedNode: record.focusedNode === null
          ? null
          : decodeUserViewNode(record.focusedNode, 'contextPayload.focusedNode'),
        selectedNodes,
        referencedNodes: arrayValue(record.referencedNodes, 'contextPayload.referencedNodes')
          .map((entry, index) => decodeUserViewNode(entry, `contextPayload.referencedNodes[${index}]`)),
        panels,
        truncated: booleanValue(record.truncated, 'contextPayload.truncated'),
      });
    }
    case 'additionalContext': {
      exactKeys(record, ['schemaVersion', 'kind', 'entries'], 'contextPayload');
      const entries = arrayValue(record.entries, 'contextPayload.entries')
        .map((entry, index) => decodeContextTextEntry(entry, `contextPayload.entries[${index}]`));
      requireUnique(entries.map((entry) => entry.key), 'contextPayload.entries', 'keys');
      return deepFreeze({ schemaVersion: 1, kind, entries });
    }
    case 'referencedResources':
      exactKeys(record, ['schemaVersion', 'kind', 'resources'], 'contextPayload');
      return deepFreeze({
        schemaVersion: 1,
        kind,
        resources: arrayValue(record.resources, 'contextPayload.resources')
          .map((entry, index) => decodeReferencedResource(entry, `contextPayload.resources[${index}]`)),
      });
    case 'skillCatalog': {
      exactKeys(record, [
        'schemaVersion', 'kind', 'mode', 'previousCatalogHash', 'catalogHash', 'entries',
      ], 'contextPayload');
      const mode = enumValue(record.mode, ['baseline', 'delta'], 'contextPayload.mode');
      const previousCatalogHash = nullableSha256(record.previousCatalogHash, 'contextPayload.previousCatalogHash');
      const catalogHash = sha256(record.catalogHash, 'contextPayload.catalogHash');
      const entries = arrayValue(record.entries, 'contextPayload.entries')
        .map((entry, index) => decodeSkillCatalogEntry(entry, `contextPayload.entries[${index}]`));
      validateCatalogJournal(mode, previousCatalogHash, catalogHash, entries.map((entry) => entry.change));
      requireUnique(entries.map((entry) => entry.name), 'contextPayload.entries', 'Skill names');
      return deepFreeze({
        schemaVersion: 1,
        kind,
        mode,
        previousCatalogHash,
        catalogHash,
        entries,
      });
    }
    case 'skillInvocation': {
      exactKeys(record, [
        'schemaVersion', 'kind', 'name', 'displayName', 'source', 'identity', 'resourceRoot',
        'contentHash', 'instructions', 'arguments', 'execution', 'invocationSource',
        'constraints', 'invokedAt',
      ], 'contextPayload');
      const execution = enumValue(record.execution, ['inline', 'isolated'], 'contextPayload.execution');
      const constraints = decodeSkillInvocationConstraints(record.constraints);
      if (execution === 'inline' && (
        constraints.allowedTools.length > 0
        || constraints.model !== null
        || constraints.effort !== null
      )) {
        fail('contextPayload.constraints', 'inline Skills cannot widen or replace the Turn configuration');
      }
      return deepFreeze({
        schemaVersion: 1,
        kind,
        name: nonEmptyTrimmedString(record.name, 'contextPayload.name'),
        displayName: nonEmptyTrimmedString(record.displayName, 'contextPayload.displayName'),
        source: enumValue(
          record.source,
          ['built-in', 'managed', 'user', 'project'],
          'contextPayload.source',
        ),
        identity: nonEmptyTrimmedString(record.identity, 'contextPayload.identity'),
        resourceRoot: nullableString(record.resourceRoot, 'contextPayload.resourceRoot'),
        contentHash: sha256(record.contentHash, 'contextPayload.contentHash'),
        instructions: stringValue(record.instructions, 'contextPayload.instructions', true),
        arguments: stringValue(record.arguments, 'contextPayload.arguments', true),
        execution,
        invocationSource: enumValue(
          record.invocationSource,
          ['user', 'model', 'runtime'],
          'contextPayload.invocationSource',
        ),
        constraints,
        invokedAt: nonNegativeNumber(record.invokedAt, 'contextPayload.invokedAt'),
      });
    }
    case 'roleCatalog': {
      exactKeys(record, [
        'schemaVersion', 'kind', 'mode', 'previousCatalogHash', 'catalogHash', 'entries',
      ], 'contextPayload');
      const mode = enumValue(record.mode, ['baseline', 'delta'], 'contextPayload.mode');
      const previousCatalogHash = nullableSha256(record.previousCatalogHash, 'contextPayload.previousCatalogHash');
      const catalogHash = sha256(record.catalogHash, 'contextPayload.catalogHash');
      const entries = arrayValue(record.entries, 'contextPayload.entries')
        .map((entry, index) => decodeRoleCatalogEntry(entry, `contextPayload.entries[${index}]`));
      validateCatalogJournal(mode, previousCatalogHash, catalogHash, entries.map((entry) => entry.change));
      requireUnique(entries.map((entry) => entry.name), 'contextPayload.entries', 'Role names');
      return deepFreeze({
        schemaVersion: 1,
        kind,
        mode,
        previousCatalogHash,
        catalogHash,
        entries,
      });
    }
    case 'toolOutputProjection':
      exactKeys(record, ['schemaVersion', 'kind', 'outputRef', 'projection'], 'contextPayload');
      return deepFreeze({
        schemaVersion: 1,
        kind,
        outputRef: decodeRequiredThreadItemOutputReference(record.outputRef, 'contextPayload.outputRef'),
        projection: decodeToolOutputProjection(record.projection),
      });
    case 'inheritedContext': {
      exactKeys(record, [
        'schemaVersion', 'kind', 'sourceThreadId', 'coveredThrough', 'requestedTurns', 'turns',
      ], 'contextPayload');
      const requestedTurns = record.requestedTurns === 'all'
        ? 'all'
        : positiveInteger(record.requestedTurns, 'contextPayload.requestedTurns');
      const turns = arrayValue(record.turns, 'contextPayload.turns').map(decodeTurn);
      if (turns.some((turn) => turn.itemsView !== 'full')) {
        fail('contextPayload.turns', 'inherited context requires complete Turns');
      }
      if (turns.some((turn) => turn.status === 'inProgress')) {
        fail('contextPayload.turns', 'inherited context cannot contain an in-progress Turn');
      }
      validateThreadContextCursors(turns);
      const coveredThrough = decodeContextCursor(record.coveredThrough, 'contextPayload.coveredThrough');
      if (!turns.some((turn) => (
        turn.id === coveredThrough.turnId
        && turn.items.some((item) => item.id === coveredThrough.itemId)
      ))) {
        fail('contextPayload.coveredThrough', 'cursor target is not reachable in inherited context');
      }
      return deepFreeze({
        schemaVersion: 1,
        kind,
        sourceThreadId: uuidV7(record.sourceThreadId, 'contextPayload.sourceThreadId'),
        coveredThrough,
        requestedTurns,
        turns,
      });
    }
    case 'compactionSummary':
      exactKeys(record, ['schemaVersion', 'kind', 'source', 'text'], 'contextPayload');
      return deepFreeze({
        schemaVersion: 1,
        kind,
        source: enumValue(record.source, ['model', 'fallback'], 'contextPayload.source'),
        text: stringValue(record.text, 'contextPayload.text', true),
      });
    case 'compactionRestoredState':
      exactKeys(record, [
        'schemaVersion', 'kind', 'skillCatalogHash', 'announcedSkills', 'activeSkills',
        'roleCatalogHash', 'announcedRoles', 'userViewBaselineRef', 'activeObservations',
      ], 'contextPayload');
      return decodeCompactionRestoredState(record, kind);
    case 'compactionInstructions': {
      exactKeys(record, ['schemaVersion', 'kind', 'entries'], 'contextPayload');
      const entries = arrayValue(record.entries, 'contextPayload.entries')
        .map((entry, index) => decodeContextTextEntry(entry, `contextPayload.entries[${index}]`));
      if (entries.some((entry) => entry.authority !== 'application' || entry.purpose !== 'instruction')) {
        fail('contextPayload.entries', 'compaction instructions require application/instruction entries');
      }
      requireUnique(entries.map((entry) => entry.key), 'contextPayload.entries', 'keys');
      return deepFreeze({ schemaVersion: 1, kind, entries });
    }
    default:
      return assertNever(kind);
  }
}

function decodeCompactionRestoredState(
  record: Record<string, unknown>,
  kind: 'compactionRestoredState',
): ThreadContextPayload {
  const announcedSkills = arrayValue(record.announcedSkills, 'contextPayload.announcedSkills')
    .map((entry, index) => decodeCatalogCheckpoint(entry, `contextPayload.announcedSkills[${index}]`));
  const activeSkills = arrayValue(record.activeSkills, 'contextPayload.activeSkills')
    .map((entry, index) => decodeActiveSkillCheckpoint(entry, `contextPayload.activeSkills[${index}]`));
  const announcedRoles = arrayValue(record.announcedRoles, 'contextPayload.announcedRoles')
    .map((entry, index) => decodeCatalogCheckpoint(entry, `contextPayload.announcedRoles[${index}]`));
  const activeObservations = arrayValue(record.activeObservations, 'contextPayload.activeObservations')
    .map((entry, index) => decodeActiveObservationCheckpoint(
      entry,
      `contextPayload.activeObservations[${index}]`,
    ));
  requireUnique(announcedSkills.map((entry) => entry.name), 'contextPayload.announcedSkills', 'Skill names');
  requireUnique(activeSkills.map((entry) => entry.name), 'contextPayload.activeSkills', 'Skill names');
  requireUnique(announcedRoles.map((entry) => entry.name), 'contextPayload.announcedRoles', 'Role names');
  requireUnique(activeObservations.map((entry) => entry.key), 'contextPayload.activeObservations', 'keys');
  return deepFreeze({
    schemaVersion: 1,
    kind,
    skillCatalogHash: nullableSha256(record.skillCatalogHash, 'contextPayload.skillCatalogHash'),
    announcedSkills,
    activeSkills,
    roleCatalogHash: nullableSha256(record.roleCatalogHash, 'contextPayload.roleCatalogHash'),
    announcedRoles,
    userViewBaselineRef: record.userViewBaselineRef === null
      ? null
      : expectContextPayloadKind(
          decodeThreadContextPayloadReference(record.userViewBaselineRef, 'contextPayload.userViewBaselineRef'),
          'userView',
          'contextPayload.userViewBaselineRef',
        ),
    activeObservations,
  });
}

export function encodeThreadContextPayload(value: ThreadContextPayload): string {
  return JSON.stringify(decodeThreadContextPayload(value));
}

export function decodeThreadContextPayloadJson(encoded: string): ThreadContextPayload {
  return decodeThreadContextPayload(parseJson(encoded, 'contextPayload'));
}

function decodeContextTextEntry(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, ['key', 'source', 'authority', 'purpose', 'text'], path);
  const authority = enumValue(record.authority, ['application', 'untrusted'], `${path}.authority`);
  const purpose = enumValue(record.purpose, ['instruction', 'observation'], `${path}.purpose`);
  if (authority === 'untrusted' && purpose === 'instruction') {
    fail(path, 'untrusted text cannot acquire instruction authority');
  }
  return {
    key: nonEmptyTrimmedString(record.key, `${path}.key`),
    source: nonEmptyTrimmedString(record.source, `${path}.source`),
    authority,
    purpose,
    text: stringValue(record.text, `${path}.text`, true),
  } as const;
}

function decodeUserViewNode(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, ['nodeId', 'title', 'panelId', 'surface'], path);
  return {
    nodeId: nonEmptyTrimmedString(record.nodeId, `${path}.nodeId`),
    title: stringValue(record.title, `${path}.title`, true),
    panelId: nullableString(record.panelId, `${path}.panelId`),
    surface: nullableString(record.surface, `${path}.surface`),
  };
}

function decodeUserViewOutlineNode(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, [
    'nodeId', 'title', 'depth', 'focused', 'collapsed', 'childCount', 'includedChildCount',
  ], path);
  const depth = nonNegativeInteger(record.depth, `${path}.depth`);
  if (depth > 5) fail(`${path}.depth`, 'exceeds the depth-5 limit');
  const childCount = nonNegativeInteger(record.childCount, `${path}.childCount`);
  const includedChildCount = nullableInteger(record.includedChildCount, `${path}.includedChildCount`);
  if (includedChildCount !== null && (includedChildCount < 0 || includedChildCount > childCount)) {
    fail(`${path}.includedChildCount`, 'must be between zero and childCount');
  }
  return {
    nodeId: nonEmptyTrimmedString(record.nodeId, `${path}.nodeId`),
    title: stringValue(record.title, `${path}.title`, true),
    depth,
    focused: booleanValue(record.focused, `${path}.focused`),
    collapsed: booleanValue(record.collapsed, `${path}.collapsed`),
    childCount,
    includedChildCount,
  };
}

function decodeUserViewPanel(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, [
    'panelId', 'rootNodeId', 'rootTitle', 'rootType', 'active', 'focused', 'order',
    'childCount', 'breadcrumb', 'visibleOutline', 'visibleOutlineTruncated',
  ], path);
  const breadcrumb = arrayValue(record.breadcrumb, `${path}.breadcrumb`)
    .map((entry, index) => decodeUserViewNode(entry, `${path}.breadcrumb[${index}]`));
  if (breadcrumb.length > 6) fail(`${path}.breadcrumb`, 'exceeds the six-node limit');
  return {
    panelId: nonEmptyTrimmedString(record.panelId, `${path}.panelId`),
    rootNodeId: nonEmptyTrimmedString(record.rootNodeId, `${path}.rootNodeId`),
    rootTitle: stringValue(record.rootTitle, `${path}.rootTitle`, true),
    rootType: nonEmptyTrimmedString(record.rootType, `${path}.rootType`),
    active: booleanValue(record.active, `${path}.active`),
    focused: booleanValue(record.focused, `${path}.focused`),
    order: nonNegativeInteger(record.order, `${path}.order`),
    childCount: nonNegativeInteger(record.childCount, `${path}.childCount`),
    breadcrumb,
    visibleOutline: arrayValue(record.visibleOutline, `${path}.visibleOutline`)
      .map((entry, index) => decodeUserViewOutlineNode(entry, `${path}.visibleOutline[${index}]`)),
    visibleOutlineTruncated: booleanValue(record.visibleOutlineTruncated, `${path}.visibleOutlineTruncated`),
  };
}

function decodeReferencedResource(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, [
    'nodeId', 'nodeType', 'title', 'breadcrumb', 'content', 'contentTruncated',
    'resourceRef', 'inlineImage', 'unavailableReason',
  ], path);
  const resourceRef = record.resourceRef === null
    ? null
    : decodeThreadResourceReference(record.resourceRef, `${path}.resourceRef`);
  const inlineImage = booleanValue(record.inlineImage, `${path}.inlineImage`);
  const unavailableReason = nullableEnum(
    record.unavailableReason,
    ['missing', 'corrupt', 'unsupported', 'quotaExceeded'],
    `${path}.unavailableReason`,
  );
  if (unavailableReason !== null && (resourceRef !== null || inlineImage)) {
    fail(path, 'an unavailable resource cannot claim bytes or an inline image');
  }
  if (inlineImage && (!resourceRef || !resourceRef.mimeType.startsWith('image/'))) {
    fail(path, 'an inline image requires an image resource');
  }
  return {
    nodeId: nonEmptyTrimmedString(record.nodeId, `${path}.nodeId`),
    nodeType: nonEmptyTrimmedString(record.nodeType, `${path}.nodeType`),
    title: stringValue(record.title, `${path}.title`, true),
    breadcrumb: arrayValue(record.breadcrumb, `${path}.breadcrumb`)
      .map((entry, index) => decodeUserViewNode(entry, `${path}.breadcrumb[${index}]`)),
    content: stringValue(record.content, `${path}.content`, true),
    contentTruncated: booleanValue(record.contentTruncated, `${path}.contentTruncated`),
    resourceRef,
    inlineImage,
    unavailableReason,
  };
}

function decodeSkillCatalogEntry(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, [
    'change', 'name', 'displayName', 'source', 'identity', 'contentHash', 'description',
  ], path);
  return {
    change: enumValue(record.change, ['available', 'added', 'changed', 'removed'], `${path}.change`),
    name: nonEmptyTrimmedString(record.name, `${path}.name`),
    displayName: nonEmptyTrimmedString(record.displayName, `${path}.displayName`),
    source: enumValue(record.source, ['built-in', 'managed', 'user', 'project'], `${path}.source`),
    identity: nonEmptyTrimmedString(record.identity, `${path}.identity`),
    contentHash: sha256(record.contentHash, `${path}.contentHash`),
    description: stringValue(record.description, `${path}.description`, true),
  };
}

function decodeRoleCatalogEntry(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, [
    'change', 'name', 'displayName', 'source', 'identity', 'contentHash', 'description',
  ], path);
  return {
    change: enumValue(record.change, ['available', 'added', 'changed', 'removed'], `${path}.change`),
    name: nonEmptyTrimmedString(record.name, `${path}.name`),
    displayName: nonEmptyTrimmedString(record.displayName, `${path}.displayName`),
    source: enumValue(record.source, ['built-in', 'user', 'project'], `${path}.source`),
    identity: nonEmptyTrimmedString(record.identity, `${path}.identity`),
    contentHash: sha256(record.contentHash, `${path}.contentHash`),
    description: stringValue(record.description, `${path}.description`, true),
  };
}

function validateCatalogJournal(
  mode: 'baseline' | 'delta',
  previousCatalogHash: string | null,
  catalogHash: string,
  changes: readonly ('available' | 'added' | 'changed' | 'removed')[],
): void {
  if (mode === 'baseline' && previousCatalogHash !== null) {
    fail('contextPayload.previousCatalogHash', 'a baseline cannot name a previous catalog');
  }
  if (mode === 'delta' && previousCatalogHash === null) {
    fail('contextPayload.previousCatalogHash', 'a delta requires a previous catalog hash');
  }
  if (mode === 'baseline' && changes.some((change) => change !== 'available')) {
    fail('contextPayload.entries', 'baseline entries must use the available change');
  }
  if (mode === 'delta' && changes.some((change) => change === 'available')) {
    fail('contextPayload.entries', 'delta entries must use added, changed, or removed');
  }
  if (mode === 'delta' && (previousCatalogHash === catalogHash || changes.length === 0)) {
    fail('contextPayload', 'a delta must describe a real catalog change');
  }
}

function decodeSkillInvocationConstraints(value: unknown) {
  const record = recordValue(value, 'contextPayload.constraints');
  exactKeys(record, ['allowedTools', 'model', 'effort'], 'contextPayload.constraints');
  return {
    allowedTools: stringArray(record.allowedTools, 'contextPayload.constraints.allowedTools')
      .map((tool, index) => nonEmptyTrimmedString(tool, `contextPayload.constraints.allowedTools[${index}]`)),
    model: nullableString(record.model, 'contextPayload.constraints.model'),
    effort: nullableString(record.effort, 'contextPayload.constraints.effort'),
  };
}

function decodeToolOutputProjection(value: unknown) {
  const record = recordValue(value, 'contextPayload.projection');
  const type = enumValue(record.type, ['full', 'inline', 'observation'], 'contextPayload.projection.type');
  if (type === 'full') {
    exactKeys(record, ['type'], 'contextPayload.projection');
    return { type } as const;
  }
  exactKeys(record, ['type', 'text'], 'contextPayload.projection');
  return { type, text: stringValue(record.text, 'contextPayload.projection.text', true) } as const;
}

function decodeCatalogCheckpoint(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, ['name', 'identity', 'contentHash'], path);
  return {
    name: nonEmptyTrimmedString(record.name, `${path}.name`),
    identity: nonEmptyTrimmedString(record.identity, `${path}.identity`),
    contentHash: sha256(record.contentHash, `${path}.contentHash`),
  };
}

function decodeActiveSkillCheckpoint(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, ['name', 'identity', 'contentHash', 'payloadRef'], path);
  return {
    ...decodeCatalogCheckpoint({
      name: record.name,
      identity: record.identity,
      contentHash: record.contentHash,
    }, path),
    payloadRef: expectContextPayloadKind(
      decodeThreadContextPayloadReference(record.payloadRef, `${path}.payloadRef`),
      'skillInvocation',
      `${path}.payloadRef`,
    ),
  };
}

function decodeActiveObservationCheckpoint(value: unknown, path: string) {
  const record = recordValue(value, path);
  exactKeys(record, ['key', 'tool', 'subject', 'outputRef', 'projectionRef'], path);
  return {
    key: nonEmptyTrimmedString(record.key, `${path}.key`),
    tool: nonEmptyTrimmedString(record.tool, `${path}.tool`),
    subject: stringValue(record.subject, `${path}.subject`, true),
    outputRef: decodeRequiredThreadItemOutputReference(record.outputRef, `${path}.outputRef`),
    projectionRef: expectContextPayloadKind(
      decodeThreadContextPayloadReference(record.projectionRef, `${path}.projectionRef`),
      'toolOutputProjection',
      `${path}.projectionRef`,
    ),
  };
}

function expectContextPayloadKind<K extends ThreadContextPayload['kind']>(
  ref: ThreadContextPayloadReference,
  expected: K,
  path: string,
): ThreadContextPayloadReference & { readonly kind: K } {
  if (ref.kind !== expected) fail(`${path}.kind`, `expected ${expected}`);
  return ref as ThreadContextPayloadReference & { readonly kind: K };
}

function decodeContextCursor(value: unknown, field: string): ContextCursor {
  const record = recordValue(value, field);
  exactKeys(record, ['turnId', 'itemId'], field);
  return deepFreeze({
    turnId: uuidV7(record.turnId, `${field}.turnId`),
    itemId: stringValue(record.itemId, `${field}.itemId`),
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

function decodeTurnExecution(value: unknown): Turn['execution'] {
  const record = recordValue(value, 'turn.execution');
  exactKeys(record, ['modelProvider', 'model', 'reasoningEffort', 'usage', 'diagnosticsRef'], 'turn.execution');
  const usage = recordValue(record.usage, 'turn.execution.usage');
  exactKeys(usage, ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cost'], 'turn.execution.usage');
  const cost = usage.cost === null ? null : decodeTurnTokenCost(usage.cost);
  const input = nonNegativeInteger(usage.input, 'turn.execution.usage.input');
  const output = nonNegativeInteger(usage.output, 'turn.execution.usage.output');
  const cacheRead = nonNegativeInteger(usage.cacheRead, 'turn.execution.usage.cacheRead');
  const cacheWrite = nonNegativeInteger(usage.cacheWrite, 'turn.execution.usage.cacheWrite');
  const result: Turn['execution'] = {
    modelProvider: stringValue(record.modelProvider, 'turn.execution.modelProvider'),
    model: stringValue(record.model, 'turn.execution.model'),
    reasoningEffort: enumValue(record.reasoningEffort, REASONING_EFFORTS, 'turn.execution.reasoningEffort'),
    diagnosticsRef: record.diagnosticsRef === null
      ? null
      : decodeTurnDiagnosticsPayloadReference(record.diagnosticsRef, 'turn.execution.diagnosticsRef'),
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: nonNegativeInteger(usage.totalTokens, 'turn.execution.usage.totalTokens'),
      cost,
    },
  };
  if (result.usage.totalTokens < input + output + cacheRead + cacheWrite) {
    fail('turn.execution.usage.totalTokens', 'must cover input, output, cache-read, and cache-write tokens');
  }
  return deepFreeze(result);
}

export function decodeTurnDiagnosticsPayloadReference(
  value: unknown,
  field = 'turnDiagnosticsPayloadReference',
): TurnDiagnosticsPayloadReference {
  const record = recordValue(value, field);
  exactKeys(record, ['id', 'mimeType', 'byteLength', 'schemaVersion'], field);
  const id = sha256(record.id, `${field}.id`);
  const byteLength = nonNegativeInteger(record.byteLength, `${field}.byteLength`);
  if (byteLength > MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES) {
    fail(`${field}.byteLength`, 'exceeds the managed diagnostics payload budget');
  }
  if (record.schemaVersion !== 1) fail(`${field}.schemaVersion`, 'expected schema version 1');
  return deepFreeze({
    id,
    mimeType: enumValue(
      record.mimeType,
      ['application/vnd.tenon.agent-turn-diagnostics+json'],
      `${field}.mimeType`,
    ),
    byteLength,
    schemaVersion: 1,
  });
}

export function decodeTurnDiagnosticsPayload(value: unknown): TurnDiagnosticsPayload {
  const record = recordValue(value, 'turnDiagnostics');
  exactKeys(record, [
    'schemaVersion', 'contextEpochId', 'cacheAffinity', 'configuration', 'stablePrompt',
    'toolSchemas', 'runtime', 'canonicalMessages', 'requestFragments', 'providerCalls',
  ], 'turnDiagnostics');
  if (record.schemaVersion !== 1) fail('turnDiagnostics.schemaVersion', 'expected schema version 1');
  const configuration = recordValue(record.configuration, 'turnDiagnostics.configuration');
  exactKeys(configuration, [
    'profileName', 'developerInstructions', 'model', 'reasoningEffort', 'tools',
    'skills', 'plugins', 'mcpServers',
  ], 'turnDiagnostics.configuration');
  const stablePrompt = record.stablePrompt === null
    ? null
    : decodeTurnDiagnosticsStablePrompt(record.stablePrompt);
  const runtime = recordValue(record.runtime, 'turnDiagnostics.runtime');
  exactKeys(runtime, [
    'provider', 'model', 'api', 'configuredBaseUrl', 'transportSelection', 'contextWindow', 'maxOutputTokens', 'thinkingLevel',
    'timeoutMs', 'maxRetries', 'maxRetryDelayMs', 'cacheRetention', 'toolExecution',
    'steeringMode',
  ], 'turnDiagnostics.runtime');
  const canonicalMessages = arrayValue(record.canonicalMessages, 'turnDiagnostics.canonicalMessages').map((entry, index) => {
    const message = recordValue(entry, `turnDiagnostics.canonicalMessages[${index}]`);
    exactKeys(message, ['id', 'estimatedTokens', 'value'], `turnDiagnostics.canonicalMessages[${index}]`);
    return {
      id: sha256(message.id, `turnDiagnostics.canonicalMessages[${index}].id`),
      estimatedTokens: nonNegativeInteger(
        message.estimatedTokens,
        `turnDiagnostics.canonicalMessages[${index}].estimatedTokens`,
      ),
      value: jsonValue(message.value, `turnDiagnostics.canonicalMessages[${index}].value`),
    };
  });
  requireUnique(
    canonicalMessages.map((message) => message.id),
    'turnDiagnostics.canonicalMessages',
    'message ids',
  );
  const requestFragments = arrayValue(record.requestFragments, 'turnDiagnostics.requestFragments').map((entry, index) => {
    const fragment = recordValue(entry, `turnDiagnostics.requestFragments[${index}]`);
    exactKeys(fragment, ['id', 'value'], `turnDiagnostics.requestFragments[${index}]`);
    return {
      id: sha256(fragment.id, `turnDiagnostics.requestFragments[${index}].id`),
      value: jsonValue(fragment.value, `turnDiagnostics.requestFragments[${index}].value`),
    };
  });
  requireUnique(
    requestFragments.map((fragment) => fragment.id),
    'turnDiagnostics.requestFragments',
    'fragment ids',
  );
  const toolSchemas = arrayValue(record.toolSchemas, 'turnDiagnostics.toolSchemas').map((entry, index) => {
    const tool = recordValue(entry, `turnDiagnostics.toolSchemas[${index}]`);
    exactKeys(tool, ['name', 'description', 'parameters'], `turnDiagnostics.toolSchemas[${index}]`);
    return {
      name: stringValue(tool.name, `turnDiagnostics.toolSchemas[${index}].name`),
      description: stringValue(tool.description, `turnDiagnostics.toolSchemas[${index}].description`, true),
      parameters: jsonValue(tool.parameters, `turnDiagnostics.toolSchemas[${index}].parameters`),
    };
  });
  requireUnique(toolSchemas.map((tool) => tool.name), 'turnDiagnostics.toolSchemas', 'tool names');
  toolSchemas.forEach((tool, index) => {
    const previous = toolSchemas[index - 1];
    if (previous && previous.name > tool.name) {
      fail(`turnDiagnostics.toolSchemas[${index}].name`, 'tool schemas must use canonical name order');
    }
  });
  const messageIds = new Set(canonicalMessages.map((message) => message.id));
  const fragmentsById = new Map(requestFragments.map((fragment) => [fragment.id, fragment.value]));
  const fragmentIds = new Set(requestFragments.map((fragment) => fragment.id));
  const canonicalToolNames = toolSchemas.map((tool) => tool.name);
  const providerCalls = arrayValue(record.providerCalls, 'turnDiagnostics.providerCalls').map((entry, index) => {
    const call = recordValue(entry, `turnDiagnostics.providerCalls[${index}]`);
    exactKeys(call, [
      'index', 'requestedAt', 'preparedContext', 'protectedFromMessageIndex',
      'estimatedInputTokens', 'inputTokenLimit', 'reservedOutputTokens',
      'commonPrefixMessageCount', 'request', 'requestFingerprint',
      'cacheBreakpoints', 'executionItemIds', 'transportResponse', 'response',
    ], `turnDiagnostics.providerCalls[${index}]`);
    const preparedContext = recordValue(
      call.preparedContext,
      `turnDiagnostics.providerCalls[${index}].preparedContext`,
    );
    exactKeys(
      preparedContext,
      ['systemPromptFragmentId', 'toolNames', 'messageIds'],
      `turnDiagnostics.providerCalls[${index}].preparedContext`,
    );
    const systemPromptFragmentId = sha256(
      preparedContext.systemPromptFragmentId,
      `turnDiagnostics.providerCalls[${index}].preparedContext.systemPromptFragmentId`,
    );
    if (!fragmentIds.has(systemPromptFragmentId)) {
      fail(
        `turnDiagnostics.providerCalls[${index}].preparedContext.systemPromptFragmentId`,
        'references an unknown request fragment',
      );
    }
    if (typeof fragmentsById.get(systemPromptFragmentId) !== 'string') {
      fail(
        `turnDiagnostics.providerCalls[${index}].preparedContext.systemPromptFragmentId`,
        'must reference a string system prompt fragment',
      );
    }
    const callToolNames = stringArray(
      preparedContext.toolNames,
      `turnDiagnostics.providerCalls[${index}].preparedContext.toolNames`,
    );
    requireUnique(
      callToolNames,
      `turnDiagnostics.providerCalls[${index}].preparedContext.toolNames`,
      'tool names',
    );
    if (
      callToolNames.length !== canonicalToolNames.length
      || callToolNames.some((name, toolIndex) => name !== canonicalToolNames[toolIndex])
    ) {
      fail(
        `turnDiagnostics.providerCalls[${index}].preparedContext.toolNames`,
        'must match canonical tool schema order',
      );
    }
    const callMessageIds = stringArray(
      preparedContext.messageIds,
      `turnDiagnostics.providerCalls[${index}].preparedContext.messageIds`,
    );
    if (callMessageIds.some((id) => !messageIds.has(id))) {
      fail(`turnDiagnostics.providerCalls[${index}].preparedContext.messageIds`, 'references an unknown message');
    }
    const request = decodeTurnDiagnosticsProviderRequest(
      call.request,
      fragmentIds,
      `turnDiagnostics.providerCalls[${index}].request`,
    );
    const executionItemIds = stringArray(
      call.executionItemIds,
      `turnDiagnostics.providerCalls[${index}].executionItemIds`,
    );
    requireUnique(
      executionItemIds,
      `turnDiagnostics.providerCalls[${index}].executionItemIds`,
      'Item ids',
    );
    const response = call.response === null
      ? null
      : decodeTurnDiagnosticsProviderResponse(
          call.response,
          `turnDiagnostics.providerCalls[${index}].response`,
        );
    const transportResponse = call.transportResponse === null
      ? null
      : decodeTurnDiagnosticsTransportResponse(
          call.transportResponse,
          `turnDiagnostics.providerCalls[${index}].transportResponse`,
        );
    const protectedFromMessageIndex = nonNegativeInteger(
      call.protectedFromMessageIndex,
      `turnDiagnostics.providerCalls[${index}].protectedFromMessageIndex`,
    );
    if (protectedFromMessageIndex > callMessageIds.length) {
      fail(`turnDiagnostics.providerCalls[${index}].protectedFromMessageIndex`, 'exceeds the message window');
    }
    const commonPrefixMessageCount = nonNegativeInteger(
      call.commonPrefixMessageCount,
      `turnDiagnostics.providerCalls[${index}].commonPrefixMessageCount`,
    );
    if (commonPrefixMessageCount > callMessageIds.length) {
      fail(`turnDiagnostics.providerCalls[${index}].commonPrefixMessageCount`, 'exceeds the message window');
    }
    return {
      index: nonNegativeInteger(call.index, `turnDiagnostics.providerCalls[${index}].index`),
      requestedAt: nonNegativeNumber(call.requestedAt, `turnDiagnostics.providerCalls[${index}].requestedAt`),
      preparedContext: {
        systemPromptFragmentId,
        toolNames: callToolNames,
        messageIds: callMessageIds,
      },
      protectedFromMessageIndex,
      estimatedInputTokens: nonNegativeInteger(
        call.estimatedInputTokens,
        `turnDiagnostics.providerCalls[${index}].estimatedInputTokens`,
      ),
      inputTokenLimit: positiveInteger(call.inputTokenLimit, `turnDiagnostics.providerCalls[${index}].inputTokenLimit`),
      reservedOutputTokens: positiveInteger(
        call.reservedOutputTokens,
        `turnDiagnostics.providerCalls[${index}].reservedOutputTokens`,
      ),
      commonPrefixMessageCount,
      request,
      requestFingerprint: sha256(
        call.requestFingerprint,
        `turnDiagnostics.providerCalls[${index}].requestFingerprint`,
      ),
      cacheBreakpoints: stringArray(
        call.cacheBreakpoints,
        `turnDiagnostics.providerCalls[${index}].cacheBreakpoints`,
      ),
      executionItemIds,
      transportResponse,
      response,
    };
  });
  providerCalls.forEach((call, index) => {
    if (call.index !== index) fail(`turnDiagnostics.providerCalls[${index}].index`, 'must match array order');
    const previousIds = providerCalls[index - 1]?.preparedContext.messageIds ?? [];
    let expectedCommonPrefix = 0;
    const limit = Math.min(previousIds.length, call.preparedContext.messageIds.length);
    while (
      expectedCommonPrefix < limit
      && previousIds[expectedCommonPrefix] === call.preparedContext.messageIds[expectedCommonPrefix]
    ) {
      expectedCommonPrefix += 1;
    }
    if (call.commonPrefixMessageCount !== expectedCommonPrefix) {
      fail(
        `turnDiagnostics.providerCalls[${index}].commonPrefixMessageCount`,
        'must match the preceding prepared message window',
      );
    }
    if (call.response && call.response.receivedAt < call.requestedAt) {
      fail(`turnDiagnostics.providerCalls[${index}].response.receivedAt`, 'cannot precede the request');
    }
    if (call.transportResponse && call.transportResponse.headersReceivedAt < call.requestedAt) {
      fail(
        `turnDiagnostics.providerCalls[${index}].transportResponse.headersReceivedAt`,
        'cannot precede the request',
      );
    }
    if (
      call.transportResponse
      && call.response
      && call.transportResponse.headersReceivedAt > call.response.receivedAt
    ) {
      fail(
        `turnDiagnostics.providerCalls[${index}].transportResponse.headersReceivedAt`,
        'cannot follow the completed assistant response',
      );
    }
  });
  requireUnique(
    providerCalls.flatMap((call) => call.executionItemIds),
    'turnDiagnostics.providerCalls',
    'execution Item ids across calls',
  );
  return deepFreeze({
    schemaVersion: 1,
    contextEpochId: stringValue(record.contextEpochId, 'turnDiagnostics.contextEpochId'),
    cacheAffinity: sha256(record.cacheAffinity, 'turnDiagnostics.cacheAffinity'),
    configuration: {
      profileName: nullableString(configuration.profileName, 'turnDiagnostics.configuration.profileName'),
      developerInstructions: stringArray(
        configuration.developerInstructions,
        'turnDiagnostics.configuration.developerInstructions',
      ),
      model: stringValue(configuration.model, 'turnDiagnostics.configuration.model'),
      reasoningEffort: enumValue(
        configuration.reasoningEffort,
        REASONING_EFFORTS,
        'turnDiagnostics.configuration.reasoningEffort',
      ),
      tools: stringArray(configuration.tools, 'turnDiagnostics.configuration.tools'),
      skills: stringArray(configuration.skills, 'turnDiagnostics.configuration.skills'),
      plugins: stringArray(configuration.plugins, 'turnDiagnostics.configuration.plugins'),
      mcpServers: stringArray(configuration.mcpServers, 'turnDiagnostics.configuration.mcpServers'),
    },
    stablePrompt,
    toolSchemas,
    runtime: {
      provider: stringValue(runtime.provider, 'turnDiagnostics.runtime.provider'),
      model: stringValue(runtime.model, 'turnDiagnostics.runtime.model'),
      api: stringValue(runtime.api, 'turnDiagnostics.runtime.api'),
      configuredBaseUrl: stringValue(
        runtime.configuredBaseUrl,
        'turnDiagnostics.runtime.configuredBaseUrl',
        true,
      ),
      transportSelection: enumValue(
        runtime.transportSelection,
        ['sse', 'websocket', 'websocket-cached', 'auto'],
        'turnDiagnostics.runtime.transportSelection',
      ),
      contextWindow: positiveInteger(runtime.contextWindow, 'turnDiagnostics.runtime.contextWindow'),
      maxOutputTokens: positiveInteger(runtime.maxOutputTokens, 'turnDiagnostics.runtime.maxOutputTokens'),
      thinkingLevel: stringValue(runtime.thinkingLevel, 'turnDiagnostics.runtime.thinkingLevel'),
      timeoutMs: nullableNonNegativeInteger(runtime.timeoutMs, 'turnDiagnostics.runtime.timeoutMs'),
      maxRetries: nullableNonNegativeInteger(runtime.maxRetries, 'turnDiagnostics.runtime.maxRetries'),
      maxRetryDelayMs: nullableNonNegativeInteger(
        runtime.maxRetryDelayMs,
        'turnDiagnostics.runtime.maxRetryDelayMs',
      ),
      cacheRetention: enumValue(
        runtime.cacheRetention,
        ['none', 'short', 'long'],
        'turnDiagnostics.runtime.cacheRetention',
      ),
      toolExecution: enumValue(runtime.toolExecution, ['parallel'], 'turnDiagnostics.runtime.toolExecution'),
      steeringMode: enumValue(runtime.steeringMode, ['all'], 'turnDiagnostics.runtime.steeringMode'),
    },
    canonicalMessages,
    requestFragments,
    providerCalls,
  });
}

function decodeTurnDiagnosticsProviderRequest(
  value: unknown,
  knownFragmentIds: ReadonlySet<string>,
  path: string,
): TurnDiagnosticsPayload['providerCalls'][number]['request'] {
  const record = recordValue(value, path);
  const kind = enumValue(record.kind, ['object', 'value'], `${path}.kind`);
  if (kind === 'value') {
    exactKeys(record, ['kind', 'value'], path);
    return { kind, value: jsonValue(record.value, `${path}.value`) };
  }
  exactKeys(record, ['kind', 'fields'], path);
  const fields = arrayValue(record.fields, `${path}.fields`).map((entry, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    const field = recordValue(entry, fieldPath);
    const representation = enumValue(
      field.representation,
      ['inline', 'fragments'],
      `${fieldPath}.representation`,
    );
    const name = stringValue(field.name, `${fieldPath}.name`);
    if (representation === 'inline') {
      exactKeys(field, ['name', 'representation', 'value'], fieldPath);
      return { name, representation, value: jsonValue(field.value, `${fieldPath}.value`) };
    }
    exactKeys(field, ['name', 'representation', 'container', 'fragmentIds'], fieldPath);
    const requestFragmentIds = stringArray(field.fragmentIds, `${fieldPath}.fragmentIds`);
    if (requestFragmentIds.some((id) => !knownFragmentIds.has(id))) {
      fail(`${fieldPath}.fragmentIds`, 'references an unknown request fragment');
    }
    return {
      name,
      representation,
      container: enumValue(field.container, ['array', 'value'], `${fieldPath}.container`),
      fragmentIds: requestFragmentIds,
    };
  });
  requireUnique(fields.map((field) => field.name), `${path}.fields`, 'field names');
  return { kind, fields };
}

export function encodeTurnDiagnosticsPayload(value: TurnDiagnosticsPayload): string {
  return JSON.stringify(decodeTurnDiagnosticsPayload(value));
}

export function decodeTurnDiagnosticsPayloadJson(encoded: string): TurnDiagnosticsPayload {
  return decodeTurnDiagnosticsPayload(parseJson(encoded, 'turnDiagnostics'));
}

function decodeTurnDiagnosticsStablePrompt(value: unknown): NonNullable<TurnDiagnosticsPayload['stablePrompt']> {
  const record = recordValue(value, 'turnDiagnostics.stablePrompt');
  exactKeys(record, ['blocks', 'fingerprints'], 'turnDiagnostics.stablePrompt');
  const fingerprints = recordValue(record.fingerprints, 'turnDiagnostics.stablePrompt.fingerprints');
  exactKeys(fingerprints, ['l0', 'l1', 'l2', 'complete'], 'turnDiagnostics.stablePrompt.fingerprints');
  return {
    blocks: arrayValue(record.blocks, 'turnDiagnostics.stablePrompt.blocks').map((entry, index) => {
      const block = recordValue(entry, `turnDiagnostics.stablePrompt.blocks[${index}]`);
      exactKeys(block, ['id', 'layer', 'text', 'fingerprint'], `turnDiagnostics.stablePrompt.blocks[${index}]`);
      return {
        id: stringValue(block.id, `turnDiagnostics.stablePrompt.blocks[${index}].id`),
        layer: enumValue(block.layer, ['L0', 'L1', 'L2'], `turnDiagnostics.stablePrompt.blocks[${index}].layer`),
        text: stringValue(block.text, `turnDiagnostics.stablePrompt.blocks[${index}].text`, true),
        fingerprint: sha256(
          block.fingerprint,
          `turnDiagnostics.stablePrompt.blocks[${index}].fingerprint`,
        ),
      };
    }),
    fingerprints: {
      l0: sha256(fingerprints.l0, 'turnDiagnostics.stablePrompt.fingerprints.l0'),
      l1: sha256(fingerprints.l1, 'turnDiagnostics.stablePrompt.fingerprints.l1'),
      l2: sha256(fingerprints.l2, 'turnDiagnostics.stablePrompt.fingerprints.l2'),
      complete: sha256(fingerprints.complete, 'turnDiagnostics.stablePrompt.fingerprints.complete'),
    },
  };
}

function decodeTurnDiagnosticsProviderResponse(
  value: unknown,
  path: string,
): NonNullable<TurnDiagnosticsPayload['providerCalls'][number]['response']> {
  const record = recordValue(value, path);
  exactKeys(record, ['receivedAt', 'stopReason', 'errorMessage', 'usage', 'value'], path);
  return {
    receivedAt: nonNegativeNumber(record.receivedAt, `${path}.receivedAt`),
    stopReason: enumValue(
      record.stopReason,
      ['stop', 'length', 'toolUse', 'error', 'aborted'],
      `${path}.stopReason`,
    ),
    errorMessage: nullableString(record.errorMessage, `${path}.errorMessage`),
    usage: decodeTurnDiagnosticsProviderUsage(record.usage, `${path}.usage`),
    value: jsonValue(record.value, `${path}.value`),
  };
}

function decodeTurnDiagnosticsProviderUsage(
  value: unknown,
  path: string,
): NonNullable<TurnDiagnosticsPayload['providerCalls'][number]['response']>['usage'] {
  const record = recordValue(value, path);
  exactKeys(record, [
    'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning',
    'totalTokens', 'cost',
  ], path);
  const cost = recordValue(record.cost, `${path}.cost`);
  exactKeys(cost, ['input', 'output', 'cacheRead', 'cacheWrite', 'total'], `${path}.cost`);
  return {
    input: nonNegativeInteger(record.input, `${path}.input`),
    output: nonNegativeInteger(record.output, `${path}.output`),
    cacheRead: nonNegativeInteger(record.cacheRead, `${path}.cacheRead`),
    cacheWrite: nonNegativeInteger(record.cacheWrite, `${path}.cacheWrite`),
    cacheWrite1h: nullableNonNegativeInteger(record.cacheWrite1h, `${path}.cacheWrite1h`),
    reasoning: nullableNonNegativeInteger(record.reasoning, `${path}.reasoning`),
    totalTokens: nonNegativeInteger(record.totalTokens, `${path}.totalTokens`),
    cost: {
      input: nonNegativeNumber(cost.input, `${path}.cost.input`),
      output: nonNegativeNumber(cost.output, `${path}.cost.output`),
      cacheRead: nonNegativeNumber(cost.cacheRead, `${path}.cost.cacheRead`),
      cacheWrite: nonNegativeNumber(cost.cacheWrite, `${path}.cost.cacheWrite`),
      total: nonNegativeNumber(cost.total, `${path}.cost.total`),
    },
  };
}

function decodeTurnDiagnosticsTransportResponse(
  value: unknown,
  path: string,
): NonNullable<TurnDiagnosticsPayload['providerCalls'][number]['transportResponse']> {
  const record = recordValue(value, path);
  exactKeys(record, ['headersReceivedAt', 'httpStatus', 'requestId'], path);
  const httpStatus = positiveInteger(record.httpStatus, `${path}.httpStatus`);
  if (httpStatus < 100 || httpStatus > 599) fail(`${path}.httpStatus`, 'must be a valid HTTP status');
  return {
    headersReceivedAt: nonNegativeNumber(record.headersReceivedAt, `${path}.headersReceivedAt`),
    httpStatus,
    requestId: nullableString(record.requestId, `${path}.requestId`),
  };
}

function decodeTurnTokenCost(value: unknown): NonNullable<Turn['execution']['usage']['cost']> {
  const record = recordValue(value, 'turn.execution.usage.cost');
  exactKeys(record, ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'currency'], 'turn.execution.usage.cost');
  return deepFreeze({
    input: nonNegativeNumber(record.input, 'turn.execution.usage.cost.input'),
    output: nonNegativeNumber(record.output, 'turn.execution.usage.cost.output'),
    cacheRead: nonNegativeNumber(record.cacheRead, 'turn.execution.usage.cost.cacheRead'),
    cacheWrite: nonNegativeNumber(record.cacheWrite, 'turn.execution.usage.cost.cacheWrite'),
    total: nonNegativeNumber(record.total, 'turn.execution.usage.cost.total'),
    currency: enumValue(record.currency, ['USD'], 'turn.execution.usage.cost.currency'),
  });
}

function decodeThreadItemOutputReference(
  value: unknown,
  field = 'item.outputRef',
): ThreadItemOutputReference | null {
  if (value === null) return null;
  const record = recordValue(value, field);
  exactKeys(record, ['id', 'mimeType', 'byteLength', 'summary'], field);
  const id = stringValue(record.id, `${field}.id`);
  if (!SHA_256_PATTERN.test(id)) fail(`${field}.id`, 'expected a lowercase SHA-256 digest');
  return deepFreeze({
    id,
    mimeType: enumValue(record.mimeType, ['text/plain', 'application/json'], `${field}.mimeType`),
    byteLength: nonNegativeInteger(record.byteLength, `${field}.byteLength`),
    summary: stringValue(record.summary, `${field}.summary`),
  });
}

function decodeRequiredThreadItemOutputReference(value: unknown, field: string): ThreadItemOutputReference {
  const ref = decodeThreadItemOutputReference(value, field);
  if (!ref) fail(field, 'expected an output reference');
  return ref;
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
    const source = decodeThreadFileSource(record.source, 'dynamicToolOutput.source');
    if (source.kind === 'localFile') {
      exactKeys(record, ['type', 'source', 'promptImage', 'alt'], 'dynamicToolOutput');
      return deepFreeze({
        type,
        source,
        promptImage: decodeImageResourceReference(record.promptImage, 'dynamicToolOutput.promptImage'),
        ...(record.alt === undefined ? {} : { alt: stringValue(record.alt, 'dynamicToolOutput.alt', true) }),
      });
    }
    exactKeys(record, ['type', 'source', 'alt'], 'dynamicToolOutput');
    assertImageResourceReference(source.ref, 'dynamicToolOutput.source.ref');
    return deepFreeze({
      type,
      source,
      ...(record.alt === undefined ? {} : { alt: stringValue(record.alt, 'dynamicToolOutput.alt', true) }),
    });
  }
  exactKeys(record, ['type', 'value'], 'dynamicToolOutput');
  return deepFreeze({ type, value: jsonValue(record.value, 'dynamicToolOutput.value') });
}

function decodeImageResourceReference(value: unknown, field: string): ThreadResourceReference {
  const ref = decodeThreadResourceReference(value, field);
  assertImageResourceReference(ref, field);
  return ref;
}

function assertImageResourceReference(ref: ThreadResourceReference, field: string): void {
  if (!/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(ref.mimeType)) {
    fail(`${field}.mimeType`, 'expected an image MIME type');
  }
}

function decodeItemDelta(value: unknown): ThreadItemDelta {
  const record = recordValue(value, 'item.delta');
  const type = enumValue(
    record.type,
    ['agentMessageText', 'reasoningSummary', 'reasoningContent', 'commandOutput', 'dynamicToolOutput'],
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

function nonEmptyTrimmedString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  const result = value;
  if (!result.trim()) fail(path, 'expected a non-empty string');
  if (result !== result.trim()) fail(path, 'expected a trimmed string');
  return result;
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

function safeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) fail(path, 'expected a safe integer');
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, 'expected a non-negative safe integer');
  return value as number;
}

function nullableNonNegativeInteger(value: unknown, path: string): number | null {
  return value === null ? null : nonNegativeInteger(value, path);
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

function isoInstant(value: unknown, path: string): string {
  const instant = stringValue(value, path);
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== instant) {
    fail(path, 'expected a canonical ISO-8601 UTC instant');
  }
  return instant;
}

function sha256(value: unknown, path: string): string {
  const digest = stringValue(value, path);
  if (!SHA_256_PATTERN.test(digest)) fail(path, 'expected a lowercase SHA-256 digest');
  return digest;
}

function nullableSha256(value: unknown, path: string): string | null {
  return value === null ? null : sha256(value, path);
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

function requireUnique(values: readonly string[], path: string, label: string): void {
  if (new Set(values).size !== values.length) fail(path, `duplicate ${label}`);
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
