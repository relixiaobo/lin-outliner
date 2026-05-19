import { expect, type Page } from '@playwright/test';

export const ids = {
  workspace: 'workspace',
  root: 'root',
  daily: 'daily',
  schema: 'schema',
  searches: 'searches',
  trash: 'trash',
  settings: 'settings',
  today: 'today',
  dayTag: 'tag-day',
  projectTag: 'tag-project',
  statusField: 'field-status',
  priorityField: 'field-priority',
  priorityEntry: 'field-entry-priority',
  priorityHigh: 'option-priority-high',
  priorityLow: 'option-priority-low',
  alpha: 'node-alpha',
  beta: 'node-beta',
  gamma: 'node-gamma',
} as const;

interface MockFixtureOptions {
  optionsField?: boolean;
}

type E2EWindow = Window & {
  __LIN_E2E__?: {
    calls: Array<{ cmd: string; args: Record<string, unknown> }>;
    projection: () => unknown;
    clipboardText: () => string;
    emitAgentEvent: (event: unknown) => void;
    emitDocumentEvent: (event: unknown) => void;
  };
  lin?: {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    onAgentEvent: (listener: (event: unknown) => void) => () => void;
    onDocumentEvent: (listener: (event: unknown) => void) => () => void;
  };
};

export async function installElectronMock(page: Page, options: MockFixtureOptions = {}) {
  await page.addInitScript(({ ids, options }) => {
    type RichText = { text: string; marks: unknown[]; inlineRefs: Array<{ offset: number; targetNodeId: string; displayName?: string }> };
    type RichTextPatch = {
      ops: Array<
        | { type: 'replace_all'; content: RichText }
        | { type: 'replace'; from: number; to: number; content: RichText }
        | { type: 'add_mark'; from: number; to: number; markType: string; attrs?: Record<string, string> }
        | { type: 'remove_mark'; from: number; to: number; markType: string }
      >;
    };
    type MockNode = {
      id: string;
      type?: string;
      parentId?: string;
      children: string[];
      content: RichText;
      description?: string;
      tags: string[];
      createdAt: number;
      updatedAt: number;
      completedAt?: number;
      locked: boolean;
      color?: string;
      showCheckbox: boolean;
      childSupertag?: string;
      extends?: string;
      doneStateEnabled: boolean;
      fieldDefId?: string;
      fieldType?: string;
      cardinality?: string;
      nullable?: boolean;
      hideField?: string;
      autoInitialize?: string;
      autocollectOptions: boolean;
      autoCollected: boolean;
      minValue?: number;
      maxValue?: number;
      sourceSupertag?: string;
      toolbarVisible: boolean;
      filterValues: string[];
      targetId?: string;
    };
    type CreateNodeTree = {
      content: RichText;
      children: CreateNodeTree[];
    };

    const win = window as E2EWindow;
    const rich = (text: string): RichText => ({ text, marks: [], inlineRefs: [] });
    const nodes = new Map<string, MockNode>();
    let now = 1_800_000_000_000;
    let sequence = 0;
    let clipboardText = '';
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    const agentListeners: Array<(event: unknown) => void> = [];
    const documentListeners: Array<(event: unknown) => void> = [];
    const agentSettings = {
      activeProviderId: 'openai',
      providers: [{
        providerId: 'openai',
        modelId: 'gpt-5.4',
        reasoningLevel: 'medium',
        baseUrl: '',
        enabled: true,
        hasApiKey: true,
        hasEnvApiKey: false,
      }],
      availableProviders: [{
        providerId: 'openai',
        hasEnvApiKey: false,
        envKeyNames: ['OPENAI_API_KEY'],
        models: [
          {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            reasoning: true,
            supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
            contextWindow: 256_000,
            maxTokens: 8192,
          },
          {
            id: 'gpt-5.4-mini',
            name: 'GPT-5.4 Mini',
            reasoning: true,
            supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
            contextWindow: 128_000,
            maxTokens: 4096,
          },
        ],
      }, {
        providerId: 'anthropic',
        hasEnvApiKey: false,
        envKeyNames: ['ANTHROPIC_API_KEY'],
        models: [
          {
            id: 'claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            reasoning: true,
            supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
            contextWindow: 200_000,
            maxTokens: 8192,
          },
        ],
      }],
    };
    const debugUsage = {
      input: 12000,
      output: 420,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12420,
      costUsd: 0.0005,
      costInputUsd: 0.0003,
      costOutputUsd: 0.0002,
      costCacheReadUsd: 0,
      costCacheWriteUsd: 0,
    };
    const debugPayloadJson = '{"model":"gpt-5.4","messages":[{"role":"user","content":"Summarize current outline."}]}';
    const debugSnapshot = {
      id: 'debug-snapshot-1',
      source: 'provider_payload',
      sessionId: 'mock-agent-session',
      sessionTitle: 'conversation',
      turnIndex: 1,
      queryIndex: 1,
      capturedAt: 1_800_000_000_100,
      modelId: 'gpt-5.4',
      provider: 'openai',
      status: 'completed',
      wire: {
        bytes: 86,
        hash: 'wireabc',
        payloadRef: {
          kind: 'payload_ref',
          id: 'debug-payload-1',
          storage: 'file',
          mimeType: 'application/json',
          byteLength: 86,
          sha256: 'debug-sha',
          role: 'debug',
          summary: 'Provider payload round 1',
        },
      },
      systemPrompt: 'You are Lin agent.',
      systemPromptBytes: 18,
      systemPromptHash: 'sysabc',
      reminders: [],
      remindersBytes: 0,
      remindersHash: '',
      tools: [{
        name: 'node_read',
        description: 'Read node context',
        schema: '{"type":"object","properties":{"nodeId":{"type":"string"}}}',
        bytes: 58,
      }],
      toolsBytes: 58,
      toolsHash: 'toolsabc',
      messages: [{
        id: 'debug-message-user',
        role: 'user',
        summary: 'Summarize current outline.',
        json: '{"role":"user","content":"Summarize current outline."}',
        bytes: 56,
        parts: [{ kind: 'text', body: 'Summarize current outline.' }],
      }],
      messageCount: 1,
      messagesBytes: 56,
      tokenEstimate: {
        systemPrompt: 39,
        tools: 766,
        messages: 11000,
        total: 12000,
        contextWindow: 256000,
        usagePercent: 4.7,
      },
      usage: debugUsage,
      responseParts: [
        { kind: 'thinking', body: 'Identify relevant outline nodes.' },
        { kind: 'toolCall', name: 'node_read', toolUseId: 'tool-1', body: '{"nodeId":"today"}' },
        { kind: 'toolResult', toolUseId: 'tool-1', body: 'Daily note content.', isError: false },
        { kind: 'text', body: 'Current outline focuses on UI work.' },
      ],
      errorMessage: null,
    };
    const debugTotals = {
      ...debugUsage,
      queries: 1,
      rounds: 1,
    };
    const agentSessions = [
      {
        id: 'mock-agent-session',
        title: 'Agent System',
        createdAt: now - 100_000,
        updatedAt: now - 1_000,
        messageCount: 33,
      },
      {
        id: 'mock-agent-session-2',
        title: null,
        createdAt: now - 200_000,
        updatedAt: now - 80_000,
        messageCount: 1,
      },
    ];

    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const applyRichTextPatch = (content: RichText, patch: RichTextPatch): RichText => {
      let next = clone(content);
      for (const op of patch.ops) {
        if (op.type === 'replace_all') {
          next = clone(op.content);
          continue;
        }
        if (op.type === 'replace') {
          const from = Math.max(0, Math.min(next.text.length, op.from));
          const to = Math.max(from, Math.min(next.text.length, op.to));
          next = {
            text: `${next.text.slice(0, from)}${op.content.text}${next.text.slice(to)}`,
            marks: clone(op.content.marks),
            inlineRefs: [
              ...next.inlineRefs.filter((ref) => ref.offset < from || ref.offset > to),
              ...op.content.inlineRefs.map((ref) => ({ ...ref, offset: from + ref.offset })),
            ],
          };
          continue;
        }
        if (op.type === 'add_mark') {
          next.marks.push({ start: op.from, end: op.to, type: op.markType, attrs: op.attrs });
          continue;
        }
        next.marks = next.marks.filter((mark) => {
          const typed = mark as { type?: string; start?: number; end?: number };
          return typed.type !== op.markType || typed.end! <= op.from || typed.start! >= op.to;
        });
      }
      return next;
    };
    const makeNode = (id: string, text: string, overrides: Partial<MockNode> = {}) => {
      nodes.set(id, {
        id,
        children: [],
        content: rich(text),
        tags: [],
        createdAt: ++now,
        updatedAt: now,
        locked: false,
        showCheckbox: false,
        doneStateEnabled: false,
        autocollectOptions: false,
        autoCollected: false,
        toolbarVisible: false,
        filterValues: [],
        ...overrides,
      });
      return nodes.get(id)!;
    };
    const appendChild = (parentId: string, childId: string, index: number | null = null) => {
      const parent = nodes.get(parentId);
      const child = nodes.get(childId);
      if (!parent || !child) return;
      parent.children = parent.children.filter((id) => id !== childId);
      const insertAt = index == null ? parent.children.length : Math.max(0, Math.min(index, parent.children.length));
      parent.children.splice(insertAt, 0, childId);
      child.parentId = parentId;
      parent.updatedAt = ++now;
      child.updatedAt = now;
    };
    const removeFromParent = (nodeId: string) => {
      const node = nodes.get(nodeId);
      if (!node?.parentId) return;
      const parent = nodes.get(node.parentId);
      if (parent) parent.children = parent.children.filter((id) => id !== nodeId);
    };
    const moveNode = (nodeId: string, parentId: string, index: number | null = null) => {
      const node = nodes.get(nodeId);
      if (!node || !nodes.has(parentId)) return;
      removeFromParent(nodeId);
      appendChild(parentId, nodeId, index);
      node.updatedAt = ++now;
    };
    const removeNode = (nodeId: string) => {
      const node = nodes.get(nodeId);
      if (!node) return;
      for (const childId of [...node.children]) removeNode(childId);
      removeFromParent(nodeId);
      nodes.delete(nodeId);
    };
    const resolveReferenceTargetId = (targetId: string) => {
      let currentId: string | undefined = targetId;
      const visited = new Set<string>();
      while (currentId) {
        if (visited.has(currentId)) return null;
        visited.add(currentId);
        const current = nodes.get(currentId);
        if (!current) return null;
        if (current.type !== 'reference') return current.id;
        currentId = current.targetId;
      }
      return null;
    };
    const projection = () => ({
      workspaceId: ids.workspace,
      rootId: ids.root,
      dailyNotesId: ids.daily,
      schemaId: ids.schema,
      searchesId: ids.searches,
      trashId: ids.trash,
      settingsId: ids.settings,
      todayId: ids.today,
      nodes: [...nodes.values()],
    });
    const outcome = (focus?: {
      nodeId: string;
      selectAll: boolean;
      parentId?: string | null;
      placement?: unknown;
      surface?: string;
    }) => ({
      projection: projection(),
      ...(focus ? { focus } : {}),
    });
    const createNode = (parentId: string, index: number | null, text: string, overrides: Partial<MockNode> = {}) => {
      const nodeId = `node-${++sequence}`;
      makeNode(nodeId, text, { parentId, showCheckbox: true, ...overrides });
      appendChild(parentId, nodeId, index);
      return nodeId;
    };
    const createTag = (name: string) => {
      const normalized = name.trim();
      const existing = [...nodes.values()].find((node) => node.type === 'tagDef' && node.content.text === normalized);
      if (existing) return outcome({ nodeId: existing.id, selectAll: false });
      const tagId = `tag-${normalized}-${++sequence}`;
      makeNode(tagId, normalized, { type: 'tagDef', parentId: ids.schema, color: '#6a8f6b' });
      appendChild(ids.schema, tagId);
      return outcome({ nodeId: tagId, selectAll: false });
    };
    const createTree = (parentId: string, tree: CreateNodeTree[], index: number | null = null) => {
      let lastId: string | null = null;
      tree.forEach((item, offset) => {
        const nodeId = createNode(parentId, index === null ? null : index + offset, item.content.text);
        const node = nodes.get(nodeId);
        if (node) node.content = clone(item.content);
        if (item.children.length > 0) createTree(nodeId, item.children);
        lastId = nodeId;
      });
      return lastId;
    };
    const registerOption = (fieldDefId: string, name: string) => {
      const field = nodes.get(fieldDefId);
      const normalized = name.trim();
      if (!field || !normalized) return outcome();
      const existing = field.children
        .map((childId) => nodes.get(childId))
        .find((node) => optionLabel(node).toLowerCase() === normalized.toLowerCase());
      if (existing) return outcome({ nodeId: existing.id, selectAll: false });
      const optionId = `option-${++sequence}`;
      makeNode(optionId, normalized, {
        parentId: fieldDefId,
        autoCollected: true,
      });
      appendChild(fieldDefId, optionId);
      return outcome({ nodeId: optionId, selectAll: false });
    };
    const optionTargetId = (option: MockNode) => (
      option.type === 'reference' && option.targetId ? option.targetId : option.id
    );
    const optionLabel = (option: MockNode | undefined) => {
      if (!option) return '';
      if (option.type === 'reference' && option.targetId) return nodes.get(option.targetId)?.content.text ?? option.content.text;
      return option.content.text;
    };
    const removeCollectedOptionRefs = (fieldDefId: string, valueIds: readonly string[]) => {
      const valueSet = new Set(valueIds);
      const field = nodes.get(fieldDefId);
      for (const childId of [...field?.children ?? []]) {
        const child = nodes.get(childId);
        if (child?.type === 'reference' && child.autoCollected && child.targetId && valueSet.has(child.targetId)) {
          removeFromParent(childId);
          nodes.delete(childId);
        }
      }
    };
    const selectOption = (fieldEntryId: string, optionNodeId: string) => {
      const fieldEntry = nodes.get(fieldEntryId);
      const option = nodes.get(optionNodeId);
      if (!fieldEntry || !option) return outcome();
      const fieldDef = fieldEntry.fieldDefId ? nodes.get(fieldEntry.fieldDefId) : undefined;
      const isList = fieldDef?.cardinality === 'list';
      const targetId = optionTargetId(option);
      if (fieldEntry.children.some((childId) => childId === targetId || nodes.get(childId)?.targetId === targetId)) {
        return outcome({ nodeId: fieldEntryId, selectAll: false });
      }
      if (!isList) {
        if (fieldEntry.fieldDefId) removeCollectedOptionRefs(fieldEntry.fieldDefId, fieldEntry.children);
        for (const childId of [...fieldEntry.children]) {
          removeFromParent(childId);
          nodes.delete(childId);
        }
      }
      const valueId = `option-value-${++sequence}`;
      makeNode(valueId, nodes.get(targetId)?.content.text ?? option.content.text, {
        type: 'reference',
        parentId: fieldEntryId,
        targetId,
      });
      appendChild(fieldEntryId, valueId);
      return outcome({ nodeId: fieldEntryId, selectAll: false });
    };
    const createCollectedOption = (fieldEntryId: string, name: string) => {
      const fieldEntry = nodes.get(fieldEntryId);
      const normalized = name.trim();
      if (!fieldEntry?.fieldDefId || !normalized) return outcome();
      const fieldDef = nodes.get(fieldEntry.fieldDefId);
      if (!fieldDef) return outcome();
      const existing = fieldDef.children
        .map((childId) => nodes.get(childId))
        .find((node) => optionLabel(node).toLowerCase() === normalized.toLowerCase());
      if (existing) return selectOption(fieldEntryId, existing.id);
      const isList = fieldDef.cardinality === 'list';
      if (!isList) {
        removeCollectedOptionRefs(fieldDef.id, fieldEntry.children);
        for (const childId of [...fieldEntry.children]) {
          removeFromParent(childId);
          nodes.delete(childId);
        }
      }
      const valueId = `option-value-${++sequence}`;
      makeNode(valueId, normalized, {
        parentId: fieldEntryId,
      });
      appendChild(fieldEntryId, valueId);
      const optionRefId = `option-ref-${++sequence}`;
      makeNode(optionRefId, normalized, {
        type: 'reference',
        parentId: fieldDef.id,
        targetId: valueId,
        autoCollected: true,
      });
      appendChild(fieldDef.id, optionRefId);
      return outcome({ nodeId: fieldEntryId, selectAll: false });
    };
    const clearFieldValue = (fieldEntryId: string) => {
      const fieldEntry = nodes.get(fieldEntryId);
      if (!fieldEntry) return outcome();
      if (fieldEntry.fieldDefId) removeCollectedOptionRefs(fieldEntry.fieldDefId, fieldEntry.children);
      for (const childId of [...fieldEntry.children]) {
        removeFromParent(childId);
        nodes.delete(childId);
      }
      return outcome({ nodeId: fieldEntryId, selectAll: false });
    };
    const duplicateNode = (nodeId: string) => {
      const node = nodes.get(nodeId);
      if (!node?.parentId) return null;
      const cloneId = `${nodeId}-copy-${++sequence}`;
      makeNode(cloneId, node.content.text, {
        type: node.type,
        parentId: node.parentId,
        tags: [...node.tags],
        showCheckbox: node.showCheckbox,
        doneStateEnabled: node.doneStateEnabled,
        completedAt: node.completedAt,
        targetId: node.targetId,
        fieldDefId: node.fieldDefId,
        fieldType: node.fieldType,
        cardinality: node.cardinality,
        color: node.color,
        childSupertag: node.childSupertag,
        extends: node.extends,
        nullable: node.nullable,
        hideField: node.hideField,
        autoInitialize: node.autoInitialize,
        autocollectOptions: node.autocollectOptions,
        minValue: node.minValue,
        maxValue: node.maxValue,
        sourceSupertag: node.sourceSupertag,
      });
      const cloneNode = nodes.get(cloneId)!;
      cloneNode.content = clone(node.content);
      const parent = nodes.get(node.parentId);
      const index = parent ? parent.children.indexOf(nodeId) + 1 : null;
      appendChild(node.parentId, cloneId, index);
      return cloneId;
    };
    const siblingMove = (nodeIds: string[], direction: 'up' | 'down') => {
      const idsToMove = direction === 'up' ? nodeIds : [...nodeIds].reverse();
      for (const nodeId of idsToMove) {
        const node = nodes.get(nodeId);
        const parent = node?.parentId ? nodes.get(node.parentId) : null;
        if (!node || !parent) continue;
        const index = parent.children.indexOf(nodeId);
        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || swapIndex < 0 || swapIndex >= parent.children.length) continue;
        if (nodeIds.includes(parent.children[swapIndex])) continue;
        [parent.children[index], parent.children[swapIndex]] = [parent.children[swapIndex], parent.children[index]];
      }
    };
    const inlineField = (parentId: string, index: number | null, name: string, fieldType: string) => {
      const fieldDefId = `field-def-${++sequence}`;
      makeNode(fieldDefId, name, { type: 'fieldDef', fieldType, parentId: ids.schema, cardinality: 'single', nullable: true });
      appendChild(ids.schema, fieldDefId);
      const fieldEntryId = `field-entry-${++sequence}`;
      makeNode(fieldEntryId, name, { type: 'fieldEntry', parentId, fieldDefId, fieldType });
      appendChild(parentId, fieldEntryId, index);
      return fieldEntryId;
    };
    const convertNodeToInlineField = (nodeId: string, name: string, fieldType: string) => {
      const node = nodes.get(nodeId);
      if (!node?.parentId) return nodeId;
      const fieldDefId = `field-def-${++sequence}`;
      makeNode(fieldDefId, name, { type: 'fieldDef', fieldType, parentId: ids.schema, cardinality: 'single', nullable: true });
      appendChild(ids.schema, fieldDefId);
      node.type = 'fieldEntry';
      node.fieldDefId = fieldDefId;
      node.fieldType = fieldType;
      node.content = rich('');
      node.tags = [];
      node.showCheckbox = false;
      node.doneStateEnabled = false;
      delete node.completedAt;
      node.updatedAt = ++now;
      return nodeId;
    };
    const setOptionalText = (node: MockNode, key: keyof MockNode, value: unknown) => {
      const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
      if (!normalized) {
        delete (node as Record<string, unknown>)[key];
        return;
      }
      (node as Record<string, unknown>)[key] = normalized;
    };
    const setOptionalNumber = (node: MockNode, key: keyof MockNode, value: unknown) => {
      if (value == null || value === '') {
        delete (node as Record<string, unknown>)[key];
        return;
      }
      const parsed = Number(value);
      if (Number.isFinite(parsed)) (node as Record<string, unknown>)[key] = parsed;
    };

    makeNode(ids.workspace, 'Workspace');
    makeNode(ids.root, 'Root', { parentId: ids.workspace });
    makeNode(ids.daily, 'Daily Notes', { parentId: ids.root });
    makeNode(ids.schema, 'Schema', { parentId: ids.root });
    makeNode(ids.searches, 'Searches', { parentId: ids.root });
    makeNode(ids.trash, 'Trash', { parentId: ids.root });
    makeNode(ids.settings, 'Settings', { parentId: ids.root });
    makeNode(ids.dayTag, 'day', { type: 'tagDef', parentId: ids.schema, color: 'gray' });
    makeNode(ids.projectTag, 'project', { type: 'tagDef', parentId: ids.schema, color: '#5e8e65' });
    makeNode(ids.statusField, 'Status', {
      type: 'fieldDef',
      parentId: ids.schema,
      fieldType: 'plain',
      cardinality: 'single',
      nullable: true,
    });
    if (options.optionsField) {
      makeNode(ids.priorityField, 'Priority', {
        type: 'fieldDef',
        parentId: ids.schema,
        fieldType: 'options',
        cardinality: 'single',
        nullable: true,
        autocollectOptions: true,
      });
      makeNode(ids.priorityHigh, 'High', { parentId: ids.priorityField });
      makeNode(ids.priorityLow, 'Low', { parentId: ids.priorityField });
      makeNode(ids.priorityEntry, 'Priority', {
        type: 'fieldEntry',
        parentId: ids.today,
        fieldDefId: ids.priorityField,
        fieldType: 'options',
      });
    }
    makeNode(ids.today, '2026-05-13', { parentId: ids.daily, tags: [ids.dayTag] });
    makeNode(ids.alpha, 'Alpha', { parentId: ids.today, showCheckbox: true });
    makeNode(ids.beta, 'Beta', { parentId: ids.today, showCheckbox: true });
    makeNode(ids.gamma, 'Gamma', { parentId: ids.today, showCheckbox: true });
    appendChild(ids.workspace, ids.root);
    for (const childId of [ids.daily, ids.schema, ids.searches, ids.trash, ids.settings]) appendChild(ids.root, childId);
    appendChild(ids.schema, ids.dayTag);
    appendChild(ids.schema, ids.projectTag);
    appendChild(ids.schema, ids.statusField);
    if (options.optionsField) {
      appendChild(ids.schema, ids.priorityField);
      appendChild(ids.priorityField, ids.priorityHigh);
      appendChild(ids.priorityField, ids.priorityLow);
    }
    appendChild(ids.daily, ids.today);
    if (options.optionsField) appendChild(ids.today, ids.priorityEntry);
    for (const childId of [ids.alpha, ids.beta, ids.gamma]) appendChild(ids.today, childId);

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          clipboardText = text;
        },
      },
      configurable: true,
    });

    const emitAgentEvent = (event: unknown) => {
      for (const listener of agentListeners) {
        listener(clone(event));
      }
    };

    const emitDocumentEvent = (event: unknown) => {
      for (const listener of documentListeners) {
        listener(clone(event));
      }
    };

    win.__LIN_E2E__ = { calls, projection, clipboardText: () => clipboardText, emitAgentEvent, emitDocumentEvent };
    win.lin = {
      invoke: async <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ cmd, args: clone(args) });
        if (cmd === 'agent_create_session' || cmd === 'agent_restore_latest_session' || cmd === 'agent_restore_session') {
          return clone({
            sessionId: 'mock-agent-session',
            renderProjection: {
              sessionId: 'mock-agent-session',
              revision: 1,
              sessionTitle: 'Agent System',
              activeRunId: null,
              isStreaming: false,
              model: { id: 'gpt-5.4', provider: 'openai' },
              thinkingLevel: 'medium',
              pendingToolCallIds: [],
              errorMessage: null,
              rows: [],
              entities: { messages: {} },
              streaming: null,
            },
          }) as T;
        }
        if (cmd === 'agent_get_provider_settings') return clone(agentSettings) as T;
        if (cmd === 'agent_list_sessions') return clone(agentSessions) as T;
        if (cmd === 'agent_rename_session') {
          const target = agentSessions.find((session) => session.id === args.sessionId);
          if (target) {
            target.title = String(args.title ?? '');
            target.updatedAt = now += 1;
          }
          return clone({ ok: true }) as T;
        }
        if (cmd === 'agent_delete_session') {
          const index = agentSessions.findIndex((session) => session.id === args.sessionId);
          if (index >= 0) agentSessions.splice(index, 1);
          return clone({ ok: true }) as T;
        }
        if (cmd === 'agent_upsert_provider_config') {
          const provider = args.provider as {
            providerId: string;
            modelId: string;
            reasoningLevel: string;
            baseUrl?: string | null;
            enabled?: boolean;
          };
          const existing = agentSettings.providers.find((item) => item.providerId === provider.providerId);
          if (existing) {
            existing.modelId = provider.modelId;
            existing.reasoningLevel = provider.reasoningLevel;
            existing.baseUrl = provider.baseUrl ?? '';
            existing.enabled = provider.enabled ?? true;
          } else {
            agentSettings.providers.push({
              providerId: provider.providerId,
              modelId: provider.modelId,
              reasoningLevel: provider.reasoningLevel,
              baseUrl: provider.baseUrl ?? '',
              enabled: provider.enabled ?? true,
              hasApiKey: true,
              hasEnvApiKey: false,
            });
          }
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_set_active_provider') {
          agentSettings.activeProviderId = String(args.providerId);
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_debug_snapshot') {
          return clone(String(args.sessionId) === 'mock-agent-session' ? debugSnapshot : null) as T;
        }
        if (cmd === 'agent_debug_history') {
          return clone(String(args.sessionId) === 'mock-agent-session' ? [debugSnapshot] : []) as T;
        }
        if (cmd === 'agent_debug_totals') {
          return clone(debugTotals) as T;
        }
        if (cmd === 'agent_debug_payload') {
          return clone(String(args.payloadId) === 'debug-payload-1' ? debugPayloadJson : null) as T;
        }
        if (cmd === 'agent_payload_text') {
          const payloadId = String(args.payloadId);
          if (payloadId === 'payload-full-output') return clone('Full persisted tool output from payload') as T;
          return clone(null) as T;
        }
        if (cmd === 'agent_queue_follow_up') return clone({ queued: true }) as T;
        if (cmd.startsWith('agent_')) return clone(undefined) as T;
        if (cmd === 'init_workspace' || cmd === 'get_projection') return clone(projection());
        if (cmd === 'create_node') {
          const nodeId = createNode(String(args.parentId), args.index as number | null, String(args.text ?? ''));
          return clone(outcome({ nodeId, parentId: String(args.parentId), placement: { kind: 'end' }, selectAll: false }));
        }
        if (cmd === 'create_rich_text_node') {
          const parentId = String(args.parentId);
          const content = clone(args.content as RichText);
          const nodeId = createNode(parentId, args.index as number | null, content.text);
          const node = nodes.get(nodeId);
          if (node) node.content = content;
          return clone(outcome({ nodeId, parentId, placement: { kind: 'end' }, selectAll: false }));
        }
        if (cmd === 'create_tagged_node') {
          const parentId = String(args.parentId);
          const tagId = String(args.tagId);
          const content = clone(args.content as RichText);
          const nodeId = createNode(parentId, null, content.text, { tags: [tagId] });
          const node = nodes.get(nodeId);
          if (node) node.content = content;
          return clone(outcome({ nodeId, parentId, placement: { kind: 'end' }, selectAll: false }));
        }
        if (cmd === 'create_tag_and_tagged_node') {
          const parentId = String(args.parentId);
          const content = clone(args.content as RichText);
          const tag = createTag(String(args.name ?? ''));
          const tagId = tag.focus?.nodeId;
          const nodeId = createNode(parentId, null, content.text, tagId ? { tags: [tagId] } : {});
          const node = nodes.get(nodeId);
          if (node) node.content = content;
          return clone(outcome({ nodeId, parentId, placement: { kind: 'end' }, selectAll: false }));
        }
        if (cmd === 'create_nodes_from_tree') {
          const lastId = createTree(String(args.parentId), args.nodes as CreateNodeTree[]);
          return clone(outcome(lastId ? {
            nodeId: lastId,
            parentId: String(args.parentId),
            placement: { kind: 'end' },
            selectAll: false,
          } : undefined));
        }
        if (cmd === 'paste_nodes_into_node') {
          const nodeId = String(args.nodeId);
          const node = nodes.get(nodeId);
          if (!node?.parentId) return clone(outcome());
          node.content = clone(args.content as RichText);
          node.updatedAt = ++now;
          createTree(nodeId, args.children as CreateNodeTree[]);
          const parent = nodes.get(node.parentId);
          const index = parent ? parent.children.indexOf(nodeId) + 1 : null;
          const lastSiblingId = createTree(node.parentId, args.siblingsAfter as CreateNodeTree[], index);
          return clone(outcome({ nodeId: lastSiblingId ?? nodeId, selectAll: false }));
        }
        if (cmd === 'apply_node_text_patch') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            node.content = applyRichTextPatch(node.content, args.patch as RichTextPatch);
            node.updatedAt = ++now;
          }
          return clone(outcome({
            nodeId: String(args.nodeId),
            selectAll: false,
            placement: { kind: 'preserve' },
          }));
        }
        if (cmd === 'split_node') {
          const nodeId = String(args.nodeId);
          const node = nodes.get(nodeId);
          if (!node?.parentId) return clone(outcome());
          node.content = clone(args.before as RichText);
          const targetParentId = typeof args.targetParentId === 'string' ? args.targetParentId : node.parentId;
          const parent = nodes.get(node.parentId);
          const insertAt = typeof args.targetIndex === 'number'
            ? args.targetIndex
            : targetParentId === node.parentId && parent
              ? parent.children.indexOf(nodeId) + 1
              : null;
          const nextId = createNode(targetParentId, insertAt, (args.after as RichText).text);
          const next = nodes.get(nextId);
          if (next) next.content = clone(args.after as RichText);
          return clone(outcome({
            nodeId: nextId,
            parentId: targetParentId,
            placement: args.focusPlacement ?? { kind: 'start' },
            selectAll: false,
          }));
        }
        if (cmd === 'merge_node_into') {
          const node = nodes.get(String(args.nodeId));
          const target = nodes.get(String(args.targetId));
          if (node && target) {
            target.content = rich(`${target.content.text}${node.content.text}`);
            removeFromParent(node.id);
            nodes.delete(node.id);
          }
          return clone(outcome({ nodeId: String(args.targetId), selectAll: false }));
        }
        if (cmd === 'trash_node') {
          if (nodes.has(String(args.nodeId))) moveNode(String(args.nodeId), ids.trash);
          return clone(outcome());
        }
        if (cmd === 'batch_trash_nodes') {
          for (const nodeId of args.nodeIds as string[]) {
            if (nodes.has(nodeId)) moveNode(nodeId, ids.trash);
          }
          return clone(outcome());
        }
        if (cmd === 'indent_node' || cmd === 'batch_indent_nodes') {
          for (const nodeId of (cmd === 'indent_node' ? [String(args.nodeId)] : args.nodeIds as string[])) {
            const node = nodes.get(nodeId);
            const parent = node?.parentId ? nodes.get(node.parentId) : null;
            if (!node || !parent) continue;
            const index = parent.children.indexOf(nodeId);
            if (index <= 0) continue;
            moveNode(nodeId, parent.children[index - 1]);
          }
          return clone(outcome());
        }
        if (cmd === 'outdent_node' || cmd === 'batch_outdent_nodes') {
          const idsToOutdent = cmd === 'outdent_node' ? [String(args.nodeId)] : [...(args.nodeIds as string[])].reverse();
          for (const nodeId of idsToOutdent) {
            const node = nodes.get(nodeId);
            const parent = node?.parentId ? nodes.get(node.parentId) : null;
            const grandParent = parent?.parentId ? nodes.get(parent.parentId) : null;
            if (!node || !parent || !grandParent) continue;
            const parentIndex = grandParent.children.indexOf(parent.id);
            moveNode(nodeId, grandParent.id, parentIndex + 1);
          }
          return clone(outcome());
        }
        if (cmd === 'batch_move_nodes_up' || cmd === 'batch_move_nodes_down') {
          siblingMove(args.nodeIds as string[], cmd === 'batch_move_nodes_up' ? 'up' : 'down');
          return clone(outcome());
        }
        if (cmd === 'batch_duplicate_nodes') {
          const firstClone = (args.nodeIds as string[]).map(duplicateNode).find(Boolean);
          return clone(outcome(firstClone ? { nodeId: firstClone, selectAll: false } : undefined));
        }
        if (
          cmd === 'toggle_done'
          || cmd === 'batch_toggle_done'
          || cmd === 'cycle_done_state'
          || cmd === 'batch_cycle_done_state'
        ) {
          const targetIds = cmd === 'toggle_done' || cmd === 'cycle_done_state'
            ? [String(args.nodeId)]
            : args.nodeIds as string[];
          for (const nodeId of targetIds) {
            const node = nodes.get(nodeId);
            if (!node) continue;
            if (cmd === 'cycle_done_state' || cmd === 'batch_cycle_done_state') {
              const hasCheckboxAffordance = node.showCheckbox || node.doneStateEnabled || Boolean(node.completedAt);
              if (!hasCheckboxAffordance) {
                node.showCheckbox = true;
                node.completedAt = undefined;
              } else if (!node.completedAt) {
                node.showCheckbox = true;
                node.completedAt = ++now;
              } else {
                node.completedAt = undefined;
                node.showCheckbox = Boolean(node.doneStateEnabled);
              }
            } else {
              node.completedAt = node.completedAt ? undefined : ++now;
              node.showCheckbox = true;
            }
          }
          return clone(outcome());
        }
        if (cmd === 'create_tag') return clone(createTag(String(args.name)));
        if (cmd === 'apply_tag' || cmd === 'batch_apply_tag') {
          const tagId = String(args.tagId);
          const targetIds = cmd === 'apply_tag' ? [String(args.nodeId)] : args.nodeIds as string[];
          for (const nodeId of targetIds) {
            const node = nodes.get(nodeId);
            if (node && !node.tags.includes(tagId)) node.tags.push(tagId);
          }
          return clone(outcome(cmd === 'apply_tag' ? { nodeId: String(args.nodeId), selectAll: false } : undefined));
        }
        if (cmd === 'remove_tag') {
          const node = nodes.get(String(args.nodeId));
          if (node) node.tags = node.tags.filter((id) => id !== String(args.tagId));
          return clone(outcome());
        }
        if (cmd === 'set_tag_config') {
          const node = nodes.get(String(args.tagId));
          const patch = args.patch as Record<string, unknown>;
          if (node) {
            if ('color' in patch) setOptionalText(node, 'color', patch.color);
            if ('extends' in patch) setOptionalText(node, 'extends', patch.extends);
            if ('childSupertag' in patch) setOptionalText(node, 'childSupertag', patch.childSupertag);
            if ('showCheckbox' in patch) node.showCheckbox = Boolean(patch.showCheckbox);
            if ('doneStateEnabled' in patch) node.doneStateEnabled = Boolean(patch.doneStateEnabled);
            node.updatedAt = ++now;
          }
          return clone(outcome({ nodeId: String(args.tagId), selectAll: false }));
        }
        if (cmd === 'set_field_config') {
          const node = nodes.get(String(args.fieldId));
          const patch = args.patch as Record<string, unknown>;
          if (node) {
            if ('fieldType' in patch) {
              node.fieldType = String(patch.fieldType);
              if (node.fieldType !== 'options_from_supertag') delete node.sourceSupertag;
              if (node.fieldType !== 'options') node.autocollectOptions = false;
              if (node.fieldType !== 'number') {
                delete node.minValue;
                delete node.maxValue;
              }
            }
            if ('sourceSupertag' in patch) setOptionalText(node, 'sourceSupertag', patch.sourceSupertag);
            if ('cardinality' in patch) setOptionalText(node, 'cardinality', patch.cardinality);
            if ('nullable' in patch) {
              if (patch.nullable == null) delete node.nullable;
              else node.nullable = Boolean(patch.nullable);
            }
            if ('hideField' in patch) setOptionalText(node, 'hideField', patch.hideField);
            if ('autoInitialize' in patch) setOptionalText(node, 'autoInitialize', patch.autoInitialize);
            if ('autocollectOptions' in patch) node.autocollectOptions = Boolean(patch.autocollectOptions);
            if ('minValue' in patch) setOptionalNumber(node, 'minValue', patch.minValue);
            if ('maxValue' in patch) setOptionalNumber(node, 'maxValue', patch.maxValue);
            node.updatedAt = ++now;
          }
          return clone(outcome({ nodeId: String(args.fieldId), selectAll: false }));
        }
        if (cmd === 'create_inline_field') {
          const fieldEntryId = inlineField(String(args.parentId), args.index as number | null, String(args.name), String(args.fieldType));
          return clone(outcome({
            nodeId: fieldEntryId,
            parentId: String(args.parentId),
            placement: { kind: 'all' },
            selectAll: true,
            surface: 'field-name',
          }));
        }
        if (cmd === 'create_inline_field_after_node') {
          const fieldEntryId = convertNodeToInlineField(String(args.afterNodeId), String(args.name), String(args.fieldType));
          const parentId = nodes.get(fieldEntryId)?.parentId ?? null;
          return clone(outcome({
            nodeId: fieldEntryId,
            parentId,
            placement: { kind: 'all' },
            selectAll: true,
            surface: 'field-name',
          }));
        }
        if (cmd === 'register_collected_option') {
          return clone(registerOption(String(args.fieldDefId), String(args.name)));
        }
        if (cmd === 'create_collected_field_option') {
          return clone(createCollectedOption(String(args.fieldEntryId), String(args.name)));
        }
        if (cmd === 'select_field_option') {
          return clone(selectOption(String(args.fieldEntryId), String(args.optionNodeId)));
        }
        if (cmd === 'clear_field_value') {
          return clone(clearFieldValue(String(args.fieldEntryId)));
        }
        if (cmd === 'add_reference') {
          const targetId = resolveReferenceTargetId(String(args.targetId)) ?? String(args.targetId);
          const target = nodes.get(targetId);
          const refId = createNode(String(args.parentId), args.index as number | null, target?.content.text ?? '', {
            type: 'reference',
            targetId,
          });
          return clone(outcome({ nodeId: refId, selectAll: false }));
        }
        if (cmd === 'set_reference_target') {
          const node = nodes.get(String(args.referenceId));
          const targetId = resolveReferenceTargetId(String(args.targetId)) ?? String(args.targetId);
          const target = nodes.get(targetId);
          if (node && target) {
            node.type = 'reference';
            node.targetId = target.id;
            node.content = clone(target.content);
          }
          return clone(outcome({ nodeId: String(args.referenceId), selectAll: false }));
        }
        if (cmd === 'replace_node_with_reference') {
          const node = nodes.get(String(args.nodeId));
          const targetId = resolveReferenceTargetId(String(args.targetId)) ?? String(args.targetId);
          const target = nodes.get(targetId);
          if (node && target) {
            node.type = 'reference';
            node.targetId = target.id;
            node.content = clone(target.content);
          }
          return clone(outcome({ nodeId: String(args.nodeId), selectAll: false }));
        }
        if (cmd === 'convert_reference_to_inline_node') {
          const reference = nodes.get(String(args.referenceId));
          const targetId = reference?.targetId ? resolveReferenceTargetId(reference.targetId) : null;
          const target = targetId ? nodes.get(targetId) : null;
          const parentId = reference?.parentId;
          const parent = parentId ? nodes.get(parentId) : null;
          if (!reference || reference.type !== 'reference' || !target || !parentId || !parent) {
            return clone(outcome());
          }
          const index = parent.children.indexOf(reference.id);
          const inlineNodeId = createNode(parentId, index < 0 ? null : index, '', { showCheckbox: false });
          const inlineNode = nodes.get(inlineNodeId);
          if (inlineNode) {
            inlineNode.content = {
              text: '',
              marks: [],
              inlineRefs: [{ offset: 0, targetNodeId: target.id, displayName: target.content.text || undefined }],
            };
          }
          removeNode(reference.id);
          return clone(outcome({
            nodeId: inlineNodeId,
            parentId,
            placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
            selectAll: false,
          }));
        }
        if (cmd === 'restore_inline_reference_node_to_reference') {
          const inlineNode = nodes.get(String(args.nodeId));
          const targetId = resolveReferenceTargetId(String(args.targetId)) ?? String(args.targetId);
          const target = nodes.get(targetId);
          const parentId = inlineNode?.parentId;
          const parent = parentId ? nodes.get(parentId) : null;
          if (!inlineNode || !target || !parentId || !parent) return clone(outcome());
          const index = parent.children.indexOf(inlineNode.id);
          const refId = createNode(parentId, index < 0 ? null : index, target.content.text, {
            type: 'reference',
            targetId: target.id,
            showCheckbox: false,
          });
          removeNode(inlineNode.id);
          return clone(outcome({ nodeId: refId, parentId, selectAll: false }));
        }
        if (cmd === 'ensure_date_node') {
          const label = `${String(args.year).padStart(4, '0')}-${String(args.month).padStart(2, '0')}-${String(args.day).padStart(2, '0')}`;
          const existing = [...nodes.values()].find((node) => node.parentId === ids.daily && node.content.text === label);
          const nodeId = existing?.id ?? createNode(ids.daily, null, label, { tags: [ids.dayTag], showCheckbox: false });
          return clone(outcome({ nodeId, selectAll: false }));
        }
        if (cmd === 'set_node_toolbar_visible') {
          const node = nodes.get(String(args.nodeId));
          if (node) node.toolbarVisible = Boolean(args.visible);
          return clone(outcome());
        }
        if (cmd === 'search_nodes') {
          const query = String(args.query ?? '').toLowerCase();
          return clone([...nodes.values()]
            .filter((node) => node.content.text.toLowerCase().includes(query))
            .map((node) => ({ nodeId: node.id, score: 1 })));
        }
        if (cmd === 'delete_node') {
          removeNode(String(args.nodeId));
          return clone(outcome());
        }
        if (cmd === 'ensure_tag_search' || cmd === 'restore_node' || cmd === 'undo' || cmd === 'redo') {
          return clone(outcome());
        }
        throw new Error(`Unhandled mock invoke: ${cmd}`);
      },
      onAgentEvent: (listener: (event: unknown) => void) => {
        agentListeners.push(listener);
        listener({ type: 'ready' });
        return () => {
          const index = agentListeners.indexOf(listener);
          if (index >= 0) agentListeners.splice(index, 1);
        };
      },
      onDocumentEvent: (listener: (event: unknown) => void) => {
        documentListeners.push(listener);
        return () => {
          const index = documentListeners.indexOf(listener);
          if (index >= 0) documentListeners.splice(index, 1);
        };
      },
    };
  }, { ids, options });
}

export function row(page: Page, id: string) {
  return page.locator(`[data-node-id="${id}"]`).first();
}

export function rowBody(page: Page, id: string) {
  return row(page, id).locator('> .row').first();
}

export function rowEditor(page: Page, id: string) {
  return row(page, id).locator('.ProseMirror').first();
}

export function trailingEditor(page: Page, parentId = ids.today) {
  return page.locator(`[data-trailing-parent-id="${parentId}"] .ProseMirror`).first();
}

export async function openMockedApp(page: Page, options: MockFixtureOptions = {}) {
  await installElectronMock(page, options);
  await page.goto('/');
  await expect(row(page, ids.alpha)).toContainText('Alpha');
  await expect(row(page, ids.beta)).toContainText('Beta');
}

export async function emitAgentEvent(page: Page, event: unknown) {
  await page.evaluate((nextEvent) => {
    const win = window as E2EWindow;
    win.__LIN_E2E__?.emitAgentEvent(nextEvent);
  }, event);
}

export async function emitAgentProjection(page: Page, sessionId: string, state: Record<string, any>, revision = 1) {
  const entities: Record<string, any> = {};
  const rows: Array<{ id: string; kind: string; messageId: string }> = [];

  const persistedContent = (message: any) => {
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content ?? [];
    return content.map((part: any) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'thinking') return { type: 'thinking', thinking: part.thinking, redacted: part.redacted };
      if (part.type === 'toolCall') return { type: 'toolCall', id: part.id, name: part.name, arguments: part.arguments ?? {} };
      if (part.type === 'payload_ref') return part;
      if (part.type === 'image') return { type: 'text', text: `[image:${part.mimeType ?? 'image'}]` };
      return { type: 'text', text: JSON.stringify(part) };
    });
  };

  for (const entry of state.conversation ?? []) {
    const message = entry.message;
    const messageId = entry.nodeId;
    rows.push({ id: `${message.role}:${messageId}`, kind: 'message', messageId });
    entities[messageId] = {
      id: messageId,
      role: message.role,
      status: 'completed',
      parentMessageId: null,
      content: persistedContent(message),
      createdAt: message.timestamp,
      updatedAt: message.timestamp,
      branches: entry.branches ?? null,
      apiId: message.api,
      providerId: message.provider,
      modelId: message.model,
      stopReason: message.stopReason,
      usage: message.usage,
      errorMessage: message.errorMessage,
    };
  }

  let streaming = null;
  const streamingMessage = state.streamingMessage;
  if (streamingMessage?.role === 'assistant') {
    const messageId = 'assistant-streaming';
    rows.push({ id: `assistant:${messageId}`, kind: 'message', messageId });
    entities[messageId] = {
      id: messageId,
      role: 'assistant',
      status: 'streaming',
      parentMessageId: null,
      content: persistedContent(streamingMessage),
      createdAt: streamingMessage.timestamp,
      updatedAt: streamingMessage.timestamp,
      branches: null,
      apiId: streamingMessage.api,
      providerId: streamingMessage.provider,
      modelId: streamingMessage.model,
      stopReason: streamingMessage.stopReason,
      usage: streamingMessage.usage,
      errorMessage: streamingMessage.errorMessage,
    };
    streaming = {
      messageId,
      rowId: `assistant:${messageId}`,
      text: persistedContent(streamingMessage)
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join(''),
      updatedAt: streamingMessage.timestamp,
    };
  }

  for (const message of state.messages ?? []) {
    if (message.role !== 'toolResult') continue;
    const messageId = `tool-result:${message.toolCallId}`;
    entities[messageId] = {
      id: messageId,
      role: 'toolResult',
      status: 'completed',
      parentMessageId: null,
      content: persistedContent(message),
      createdAt: message.timestamp,
      updatedAt: message.timestamp,
      branches: null,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    };
  }

  await emitAgentEvent(page, {
    type: 'projection',
    sessionId,
    lastEventType: null,
    revision,
    renderProjection: {
      sessionId,
      revision,
      sessionTitle: state.sessionTitle ?? null,
      activeRunId: state.isStreaming ? 'run-e2e' : null,
      isStreaming: !!state.isStreaming,
      model: state.model ?? {},
      thinkingLevel: state.thinkingLevel ?? 'off',
      pendingToolCallIds: state.pendingToolCallIds ?? [],
      errorMessage: state.errorMessage ?? null,
      rows,
      entities: { messages: entities },
      streaming,
    },
    timestamp: Date.now(),
  });
}

export async function emitDocumentEvent(page: Page, event: unknown) {
  await page.evaluate((nextEvent) => {
    const win = window as E2EWindow;
    win.__LIN_E2E__?.emitDocumentEvent(nextEvent);
  }, event);
}

export async function multiSelect(page: Page, rowIds: string[]) {
  for (const rowId of rowIds) {
    await row(page, rowId).click({ modifiers: ['Meta'] });
  }
  for (const rowId of rowIds) {
    await expect(rowBody(page, rowId)).toHaveClass(/selected/);
  }
}

export async function e2eProjection(page: Page): Promise<{ nodes: Array<{
  id: string;
  parentId?: string;
  children: string[];
  content: { text: string; inlineRefs: Array<{ targetNodeId: string }> };
  completedAt?: number;
  tags: string[];
  type?: string;
  targetId?: string;
  color?: string;
  childSupertag?: string;
  extends?: string;
  showCheckbox?: boolean;
  doneStateEnabled?: boolean;
  fieldType?: string;
  cardinality?: string;
  nullable?: boolean;
  hideField?: string;
  autocollectOptions?: boolean;
  minValue?: number;
  maxValue?: number;
  sourceSupertag?: string;
}> }> {
  return page.evaluate(() => {
    const win = window as E2EWindow;
    return win.__LIN_E2E__?.projection() as { nodes: Array<{
      id: string;
      parentId?: string;
      children: string[];
      content: { text: string; inlineRefs: Array<{ targetNodeId: string }> };
      completedAt?: number;
      tags: string[];
      type?: string;
      targetId?: string;
      color?: string;
      childSupertag?: string;
      extends?: string;
      showCheckbox?: boolean;
      doneStateEnabled?: boolean;
      fieldType?: string;
      cardinality?: string;
      nullable?: boolean;
      hideField?: string;
      autocollectOptions?: boolean;
      minValue?: number;
      maxValue?: number;
      sourceSupertag?: string;
    }> };
  });
}

export async function nodeByText(page: Page, text: string) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.content.text === text);
}

export async function nodeById(page: Page, id: string) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === id);
}

export async function commandCalls(page: Page) {
  return page.evaluate(() => {
    const win = window as E2EWindow;
    return win.__LIN_E2E__?.calls ?? [];
  });
}

export async function clipboardText(page: Page) {
  return page.evaluate(() => {
    const win = window as E2EWindow;
    return win.__LIN_E2E__?.clipboardText() ?? '';
  });
}
