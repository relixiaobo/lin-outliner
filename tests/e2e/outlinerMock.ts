import { expect, type Page } from '@playwright/test';

export const ids = {
  workspace: 'workspace',
  root: 'root',
  library: 'library',
  daily: 'daily',
  projects: 'projects',
  areas: 'areas',
  resources: 'resources',
  schema: 'schema',
  searches: 'searches',
  recents: 'recents',
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
  dueField: 'field-due',
  dueEntry: 'field-entry-due',
  referencesField: 'field-references',
  referencesEntry: 'field-entry-references',
  alpha: 'node-alpha',
  beta: 'node-beta',
  gamma: 'node-gamma',
} as const;

interface MockFixtureOptions {
  dateField?: boolean;
  optionsField?: boolean;
  referenceField?: boolean;
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
    openProviderConfig?: (params: { providerId: string; mode: string }) => Promise<void>;
    closeProviderConfig?: () => Promise<void>;
    notifySettingsChanged?: () => Promise<void>;
    previewLocalFile?: (options: { id: string }) => Promise<{ thumbnailDataUrl: string | null }>;
    recentLocalFiles?: (options?: { limit?: number }) => Promise<{
      files: Array<{
        entryKind: 'file' | 'directory';
        id: string;
        path: string;
        name: string;
        parentPath: string;
        mimeType: string;
        sizeBytes: number;
        lastModified: number;
        iconDataUrl?: string;
        thumbnailDataUrl?: string;
      }>;
    }>;
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
      nullable?: boolean;
      hideField?: string;
      autoInitialize?: string;
      autocollectOptions: boolean;
      autoCollected: boolean;
      minValue?: number;
      maxValue?: number;
      sourceSupertag?: string;
	      icon?: string;
	      iconKind?: string;
	      bannerAssetId?: string;
	      bannerPositionX?: number;
	      bannerPositionY?: number;
	      bannerAlt?: string;
	      viewMode?: string;
	      toolbarVisible?: boolean;
	      groupField?: string;
	      sortField?: string;
	      sortDirection?: string;
	      filterField?: string;
	      filterOperator?: string;
	      filterValueLogic?: string;
	      filterValues?: string[];
	      displayField?: string;
	      displayVisible?: boolean;
	      displayWidth?: number;
	      displayOrder?: number;
	      displayLabel?: string;
	      displayPlacement?: string;
	      queryLogic?: string;
	      queryOp?: string;
	      targetId?: string;
	      codeLanguage?: string;
	      configKey?: string;
	      refRole?: string;
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
      agent: {
        permissionMode: 'trusted',
        automaticSkillsEnabled: true,
        slashSkillsEnabled: true,
        compactEnabled: true,
        additionalSkillDirectories: [],
        additionalAgentDirectories: [],
        providerTimeoutMs: null,
        providerMaxRetries: null,
        providerMaxRetryDelayMs: 60_000,
        providerCacheRetention: 'short',
      },
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
        defaultBaseUrl: 'https://api.openai.com/v1',
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
        defaultBaseUrl: 'https://api.anthropic.com',
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
      }, {
        providerId: 'amazon-bedrock',
        hasEnvApiKey: false,
        envKeyNames: [],
        defaultBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
        models: [
          {
            id: 'amazon.nova-lite-v1:0',
            name: 'Nova Lite',
            reasoning: false,
            supportedThinkingLevels: ['off'],
            contextWindow: 300_000,
            maxTokens: 4096,
          },
        ],
      }],
    };
    const agentToolPermissions = {
      permissions: { allow: [] as string[], ask: [] as string[], deny: [] as string[] },
      diagnostics: [] as Array<{ ruleValue: string; decision: 'allow' | 'ask' | 'deny'; code: string; message: string }>,
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
    const subagentTranscriptJson = JSON.stringify({
      v: 1,
      runId: 'subagent-1',
      messageCount: 4,
      messages: [
        {
          role: 'user',
          timestamp: now - 500,
          content: [{ type: 'text', text: 'Inspect the current UI.' }],
        },
        {
          role: 'assistant',
          timestamp: now - 400,
          api: 'openai-completions',
          provider: 'openai',
          model: 'gpt-5.4',
          usage: {
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
          },
          stopReason: 'toolUse',
          content: [
            { type: 'thinking', thinking: 'Read the visible outline before summarizing.', redacted: false },
            { type: 'toolCall', id: 'subagent-tool-read-1', name: 'node_read', arguments: { nodeId: 'today' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'subagent-tool-read-1',
          toolName: 'node_read',
          timestamp: now - 300,
          content: [{ type: 'text', text: 'Daily note content from subagent.' }],
          isError: false,
        },
        {
          role: 'assistant',
          timestamp: now - 200,
          api: 'openai-completions',
          provider: 'openai',
          model: 'gpt-5.4',
          usage: {
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
          },
          stopReason: 'stop',
          content: [{ type: 'text', text: 'The subagent finished inspecting the UI.' }],
        },
      ],
    });
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
          const removedRefs = op.deletedInlineRefs ?? [];
          const removesRef = (ref: RichText['inlineRefs'][number]) => removedRefs.some((candidate) =>
            candidate.offset === ref.offset
            && candidate.targetNodeId === ref.targetNodeId
            && (candidate.displayName === undefined || candidate.displayName === ref.displayName));
          const insertedLength = op.content.text.length;
          const delta = insertedLength - (to - from);
          // Mirror the real splice semantics (loroDocument.replaceRichTextRange):
          // marks outside the replaced range survive (shifted by delta), marks
          // inside it collapse, and the replacement content's marks are placed at
          // `from`. Boundaries are non-inclusive on the right and inclusive-after
          // on the left so typing next to a mark does not extend or drop it.
          const mapPos = (pos: number, isStart: boolean) => {
            if (pos < from) return pos;
            if (pos > to) return pos + delta;
            return isStart ? from + insertedLength : from;
          };
          const remappedMarks = next.marks
            .map((mark) => {
              const typed = mark as { start: number; end: number; type: string; attrs?: unknown };
              return { ...typed, start: mapPos(typed.start, true), end: mapPos(typed.end, false) };
            })
            .filter((mark) => mark.end > mark.start);
          const insertedMarks = op.content.marks.map((mark) => ({
            ...mark,
            start: from + mark.start,
            end: from + mark.end,
          }));
          next = {
            text: `${next.text.slice(0, from)}${op.content.text}${next.text.slice(to)}`,
            marks: [...remappedMarks, ...insertedMarks],
            inlineRefs: [
              ...next.inlineRefs
                .filter((ref) => !removesRef(ref))
                .flatMap((ref) => {
                  if (ref.offset <= from) return [ref];
                  if (ref.offset > to) return [{ ...ref, offset: ref.offset + delta }];
                  return [];
                }),
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
    // Config-as-nodes parity: the renderer reads tag/field config from a
    // `defConfig` child subtree (pinned leading segment), not the flat node
    // fields this mock authors with. At projection time we synthesize that
    // subtree from the flat fields so the real renderer resolves
    // color/checkbox/field-type exactly as in production. The flat fields stay
    // on the emitted node (harmless extras some specs still read directly).
    const cfgDefaults = () => ({
      children: [] as string[],
      tags: [] as string[],
      createdAt: now,
      updatedAt: now,
      locked: false,
      showCheckbox: false,
      doneStateEnabled: false,
      autocollectOptions: false,
      autoCollected: false,
    });
    const systemOptionId = (key: string, value: string) => `sysopt:${key}:${value}`;
    const expandConfigForDef = (def: MockNode, sink: Map<string, MockNode>): string[] => {
      const defId = def.id;
      const configIds: string[] = [];
      const cfgId = (key: string) => `${defId}::cfg::${key}`;
      const valueNode = (id: string, text: string) => {
        sink.set(id, { id, content: rich(text), parentId: '', ...cfgDefaults() });
      };
      const refNode = (id: string, targetId: string, role: string) => {
        sink.set(id, { id, type: 'reference', targetId, refRole: role, content: rich(''), parentId: '', ...cfgDefaults() });
      };
      const option = (key: string, value: string) => {
        const id = systemOptionId(key, value);
        if (!sink.has(id)) sink.set(id, { id, type: 'systemOption', content: rich(value), parentId: ids.schema, ...cfgDefaults() });
        return id;
      };
      const defConfig = (key: string, childIds: string[]) => {
        const id = cfgId(key);
        sink.set(id, { id, type: 'defConfig', configKey: key, parentId: defId, content: rich(''), ...cfgDefaults(), children: childIds });
        configIds.push(id);
      };
      const addScalar = (key: string, value: string | number | boolean | undefined) => {
        if (value === undefined || value === null) return;
        const valueId = `${cfgId(key)}::v`;
        valueNode(valueId, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
        defConfig(key, [valueId]);
      };
      const addRef = (key: string, targetId: string | undefined) => {
        if (!targetId) return;
        const refId = `${cfgId(key)}::ref`;
        refNode(refId, targetId, 'config');
        defConfig(key, [refId]);
      };
      const addEnum = (key: string, value: string | undefined) => {
        if (value === undefined || value === '') return;
        const refId = `${cfgId(key)}::ref`;
        refNode(refId, option(key, value), 'enum');
        defConfig(key, [refId]);
      };
      const addEnumList = (key: string, values: string[]) => {
        if (!values.length) return;
        const refIds = values.map((value, i) => {
          const refId = `${cfgId(key)}::ref::${i}`;
          refNode(refId, option(key, value), 'enum');
          return refId;
        });
        defConfig(key, refIds);
      };

      if (def.type === 'tagDef') {
        addScalar('color', def.color);
        addRef('extends', def.extends);
        addRef('childSupertag', def.childSupertag);
        addScalar('showCheckbox', def.showCheckbox);
        addScalar('doneStateEnabled', def.doneStateEnabled);
      } else if (def.type === 'fieldDef') {
        addEnum('fieldType', def.fieldType);
        addRef('sourceSupertag', def.sourceSupertag);
        addScalar('autocollectOptions', def.autocollectOptions);
        addEnumList(
          'autoInitialize',
          def.autoInitialize ? def.autoInitialize.split(',').map((s) => s.trim()).filter(Boolean) : [],
        );
        addScalar('nullable', def.nullable);
        addEnum('hideField', def.hideField);
        addScalar('minValue', def.minValue);
        addScalar('maxValue', def.maxValue);
      }
      return configIds;
    };
    const tagDrivenCheckbox = (node: MockNode): boolean => node.tags.some((tagId) => {
      const tag = nodes.get(tagId);
      return tag?.type === 'tagDef' && Boolean(tag.showCheckbox);
    });
    const projection = () => {
      const sink = new Map<string, MockNode>();
      const emitted = [...nodes.values()].map((node) => {
        if (node.type !== 'tagDef' && node.type !== 'fieldDef') {
          // Mirror the real `nodeShowsCheckbox`: a content node shows a checkbox
          // when its `completedAt` sentinel is set (manual) or an applied tag
          // drives it. The renderer recomputes this itself; we project it so e2e
          // assertions can read `node.showCheckbox` directly. (Def nodes keep
          // their stored `showCheckbox`, which is the tag's *config* flag.)
          return { ...node, showCheckbox: node.completedAt !== undefined || tagDrivenCheckbox(node) };
        }
        const configIds = expandConfigForDef(node, sink);
        return configIds.length ? { ...node, children: [...configIds, ...node.children] } : node;
      });
      return {
        workspaceId: ids.workspace,
        rootId: ids.root,
        libraryId: ids.library,
        dailyNotesId: ids.daily,
        schemaId: ids.schema,
        searchesId: ids.searches,
        recentsId: ids.recents,
        trashId: ids.trash,
        settingsId: ids.settings,
        todayId: ids.today,
        nodes: [...emitted, ...sink.values()],
      };
    };
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
    const createNode = (
      parentId: string,
      index: number | null,
      text: string,
      overrides: Partial<MockNode> = {},
      id?: string,
    ) => {
      // Honor a client-proposed id (the eager-materialize / field-value draft
      // contract): the renderer mints the trailing draft row's stable id and
      // expects the created node to adopt it, so the row reconciles into a single
      // real node instead of leaving an orphan beside the still-buffering draft.
      const nodeId = id ?? `node-${++sequence}`;
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
        if (node) {
          node.content = clone(item.content);
          if (item.type === 'codeBlock') {
            node.type = 'codeBlock';
            const lang = item.codeLanguage?.trim().toLowerCase();
            if (lang) node.codeLanguage = lang;
            else delete node.codeLanguage;
          }
        }
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
    const selectOption = (fieldEntryId: string, optionNodeId: string, id?: string) => {
      const fieldEntry = nodes.get(fieldEntryId);
      const option = nodes.get(optionNodeId);
      if (!fieldEntry || !option) return outcome();
      const targetId = optionTargetId(option);
      // Everything is a node: selecting an option appends a value (deduped against an
      // already-present selection). Core no longer replaces on cardinality.
      if (fieldEntry.children.some((childId) => childId === targetId || nodes.get(childId)?.targetId === targetId)) {
        return outcome({ nodeId: fieldEntryId, selectAll: false });
      }
      const valueId = id ?? `option-value-${++sequence}`;
      makeNode(valueId, nodes.get(targetId)?.content.text ?? option.content.text, {
        type: 'reference',
        parentId: fieldEntryId,
        targetId,
      });
      appendChild(fieldEntryId, valueId);
      return outcome({ nodeId: fieldEntryId, selectAll: false });
    };
    // Append a reference to an arbitrary document node (the reference field picker).
    // Unlike selectOption the target is any node, not a pool option, but the append
    // is identical: a deduped `reference` value child. Mirrors core.addFieldReference.
    const addFieldReference = (fieldEntryId: string, targetNodeId: string, id?: string) => {
      const fieldEntry = nodes.get(fieldEntryId);
      const target = nodes.get(targetNodeId);
      if (!fieldEntry || !target) return outcome();
      const targetId = optionTargetId(target);
      if (fieldEntry.children.some((childId) => childId === targetId || nodes.get(childId)?.targetId === targetId)) {
        return outcome({ nodeId: fieldEntryId, selectAll: false });
      }
      const valueId = id ?? `reference-value-${++sequence}`;
      makeNode(valueId, nodes.get(targetId)?.content.text ?? target.content.text, {
        type: 'reference',
        parentId: fieldEntryId,
        targetId,
      });
      appendChild(fieldEntryId, valueId);
      return outcome({ nodeId: fieldEntryId, selectAll: false });
    };
    const createCollectedOption = (fieldEntryId: string, name: string, id?: string) => {
      const fieldEntry = nodes.get(fieldEntryId);
      const normalized = name.trim();
      if (!fieldEntry?.fieldDefId || !normalized) return outcome();
      const fieldDef = nodes.get(fieldEntry.fieldDefId);
      if (!fieldDef) return outcome();
      const existing = fieldDef.children
        .map((childId) => nodes.get(childId))
        .find((node) => optionLabel(node).toLowerCase() === normalized.toLowerCase());
      if (existing) return selectOption(fieldEntryId, existing.id, id);
      // Everything is a node: each created value appends. Core no longer
      // special-cases cardinality (the single-vs-list distinction was removed).
      const valueId = id ?? `option-value-${++sequence}`;
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
    // Everything is a node: a free-text value appends as a plain content child of
    // the entry under the renderer-proposed id (the draft->value contract). Empty
    // text is a no-op, mirroring core.setFieldFreeTextValue.
    const setFieldFreeTextValue = (fieldEntryId: string, text: string, id?: string) => {
      const fieldEntry = nodes.get(fieldEntryId);
      const normalized = text.trim();
      if (!fieldEntry || !normalized) return outcome({ nodeId: fieldEntryId, selectAll: false });
      createNode(fieldEntryId, null, normalized, {}, id);
      return outcome({ nodeId: fieldEntryId, selectAll: false });
    };
    // Remove a single field value (the backspace-an-empty-value gesture), dropping
    // any auto-collected pool references that target it so the option pool never
    // keeps an orphan reference. Mirrors core.removeFieldValue.
    const removeFieldValue = (valueId: string) => {
      const value = nodes.get(valueId);
      const fieldEntryId = value?.parentId;
      const fieldEntry = fieldEntryId ? nodes.get(fieldEntryId) : undefined;
      if (fieldEntry?.fieldDefId) removeCollectedOptionRefs(fieldEntry.fieldDefId, [valueId]);
      removeFromParent(valueId);
      nodes.delete(valueId);
      return outcome({ nodeId: fieldEntryId ?? valueId, selectAll: false });
    };
	    const setSearchQueryOutline = (nodeId: string, queryOutline: string) => {
	      const search = nodes.get(nodeId);
	      if (!search || search.type !== 'search') return;
	      for (const childId of [...search.children]) {
	        if (nodes.get(childId)?.type === 'queryCondition') removeNode(childId);
	      }
	      const firstLine = queryOutline
	        .split('\n')
	        .map((line) => line.trim())
	        .find(Boolean);
	      if (!firstLine) return;
	      const title = firstLine.replace(/^-\s*/, '').trim();
	      const conditionId = `condition-${++sequence}`;
	      makeNode(conditionId, title, {
	        type: 'queryCondition',
	        parentId: nodeId,
	        ...(title === 'AND' || title === 'OR' || title === 'NOT' ? { queryLogic: title } : { queryOp: title }),
	      });
	      appendChild(nodeId, conditionId, 0);
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
      makeNode(fieldDefId, name, { type: 'fieldDef', fieldType, parentId: ids.schema, nullable: true });
      appendChild(ids.schema, fieldDefId);
      const fieldEntryId = `field-entry-${++sequence}`;
      makeNode(fieldEntryId, '', { type: 'fieldEntry', parentId, fieldDefId, fieldType });
      appendChild(parentId, fieldEntryId, index);
      return fieldEntryId;
    };
    const convertNodeToInlineField = (nodeId: string, name: string, fieldType: string) => {
      const node = nodes.get(nodeId);
      if (!node?.parentId) return nodeId;
      const fieldDefId = `field-def-${++sequence}`;
      makeNode(fieldDefId, name, { type: 'fieldDef', fieldType, parentId: ids.schema, nullable: true });
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
    const reuseFieldDefinition = (entryId: string, targetDefId: string) => {
      const entry = nodes.get(entryId);
      const targetDef = nodes.get(targetDefId);
      // A `sys:*` target is a read-only system field with no backing def node.
      const isSystemField = targetDefId.startsWith('sys:');
      if (entry?.type === 'fieldEntry' && (isSystemField || targetDef?.type === 'fieldDef')) {
        const previousDefId = entry.fieldDefId;
        if (previousDefId !== targetDefId) {
          entry.fieldDefId = targetDefId;
          entry.fieldType = isSystemField ? 'plain' : targetDef!.fieldType;
          entry.updatedAt = ++now;
          // A system field's value is computed from the owner, not stored — drop
          // any value children the draft entry carried (mirrors core).
          if (isSystemField) {
            for (const childId of [...entry.children]) removeNode(childId);
          }
          if (previousDefId) {
            const prevDef = nodes.get(previousDefId);
            const stillReferenced = [...nodes.values()].some(
              (other) => other.type === 'fieldEntry' && other.id !== entryId && other.fieldDefId === previousDefId,
            );
            if (prevDef?.type === 'fieldDef' && prevDef.parentId === ids.schema && !stillReferenced) {
              removeNode(previousDefId);
            }
          }
        }
      }
      return outcome({
        nodeId: entryId,
        parentId: entry?.parentId ?? null,
        placement: { kind: 'all' },
        selectAll: true,
        surface: 'field-name',
      });
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
	    const directChildOfType = (parentId: string, type: string) => nodes.get(parentId)?.children
	      .map((childId) => nodes.get(childId))
	      .find((node): node is MockNode => Boolean(node) && node.type === type);
	    const directChildrenOfType = (parentId: string, type: string) => nodes.get(parentId)?.children
	      .map((childId) => nodes.get(childId))
	      .filter((node): node is MockNode => Boolean(node) && node.type === type) ?? [];
	    const ensureViewDef = (nodeId: string) => {
	      const existing = directChildOfType(nodeId, 'viewDef');
	      if (existing) return existing;
	      const viewId = `view-${++sequence}`;
	      const view = makeNode(viewId, '', {
	        type: 'viewDef',
	        parentId: nodeId,
	        viewMode: 'list',
	        toolbarVisible: false,
	      });
	      appendChild(nodeId, viewId, 0);
	      return view;
	    };

	    makeNode(ids.workspace, 'Workspace', { locked: true });
    makeNode(ids.root, 'Root', { parentId: ids.workspace, locked: true });
    makeNode(ids.daily, 'Daily Notes', { parentId: ids.root, locked: true });
    makeNode(ids.library, 'Library', { parentId: ids.root, locked: true });
    makeNode(ids.schema, 'Schema', { parentId: ids.root, locked: true });
    makeNode(ids.searches, 'Saved searches', { parentId: ids.root, locked: true });
	    makeNode(ids.recents, 'Recents', {
	      type: 'search',
	      parentId: ids.searches,
	      locked: true,
	    });
	    makeNode('recents-view', '', { type: 'viewDef', parentId: ids.recents, viewMode: 'list', children: ['recents-sort'] });
	    makeNode('recents-sort', '', {
	      type: 'sortRule',
	      parentId: 'recents-view',
	      sortField: 'sys:updatedAt',
	      sortDirection: 'desc',
	    });
	    makeNode('recents-query', '30', {
	      type: 'queryCondition',
	      parentId: ids.recents,
	      queryOp: 'EDITED_LAST_DAYS',
	      children: ['recents-query-value'],
	    });
	    makeNode('recents-query-value', '30', { parentId: 'recents-query' });
    makeNode(ids.trash, 'Trash', { parentId: ids.root, locked: true });
    makeNode(ids.settings, 'Settings', { parentId: ids.root, locked: true });
    makeNode(ids.dayTag, 'day', { type: 'tagDef', parentId: ids.schema, color: 'gray' });
    makeNode(ids.projectTag, 'project', { type: 'tagDef', parentId: ids.schema, color: '#5e8e65' });
    makeNode(ids.statusField, 'Status', {
      type: 'fieldDef',
      parentId: ids.schema,
      fieldType: 'plain',
      nullable: true,
    });
    if (options.optionsField) {
      makeNode(ids.priorityField, 'Priority', {
        type: 'fieldDef',
        parentId: ids.schema,
        fieldType: 'options',
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
    if (options.dateField) {
      makeNode(ids.dueField, 'Due', {
        type: 'fieldDef',
        parentId: ids.schema,
        fieldType: 'date',
        nullable: true,
      });
      makeNode(ids.dueEntry, 'Due', {
        type: 'fieldEntry',
        parentId: ids.today,
        fieldDefId: ids.dueField,
        fieldType: 'date',
      });
    }
    if (options.referenceField) {
      makeNode(ids.referencesField, 'Related', {
        type: 'fieldDef',
        parentId: ids.schema,
        fieldType: 'reference',
        nullable: true,
      });
      makeNode(ids.referencesEntry, 'Related', {
        type: 'fieldEntry',
        parentId: ids.today,
        fieldDefId: ids.referencesField,
        fieldType: 'reference',
      });
    }
    // Daily-note date pages are locked in core (`freshId('date')` + `locked: true`):
    // you can add/edit children, but the page node itself is read-only. Mirror that
    // so a system field owned by the date page (e.g. Done) behaves as in the app.
    makeNode(ids.today, '2026-05-13', { parentId: ids.daily, tags: [ids.dayTag], locked: true });
    // Manual checkbox items (undone): `completedAt: 0` is the "box shown, not
    // done" sentinel, so the real `nodeShowsCheckbox` renders a checkbox the
    // done-cycling specs can toggle. `showCheckbox` is derived in `projection()`.
    makeNode(ids.alpha, 'Alpha', { parentId: ids.today, completedAt: 0 });
    makeNode(ids.beta, 'Beta', { parentId: ids.today, completedAt: 0 });
    makeNode(ids.gamma, 'Gamma', { parentId: ids.today, completedAt: 0 });
    appendChild(ids.workspace, ids.root);
    for (const childId of [ids.daily, ids.library, ids.schema, ids.searches, ids.trash, ids.settings]) appendChild(ids.root, childId);
	    appendChild(ids.searches, ids.recents);
	    appendChild(ids.recents, 'recents-query');
	    appendChild(ids.recents, 'recents-view');
	    appendChild('recents-view', 'recents-sort');
	    appendChild('recents-query', 'recents-query-value');
    appendChild(ids.schema, ids.dayTag);
    appendChild(ids.schema, ids.projectTag);
    appendChild(ids.schema, ids.statusField);
    if (options.optionsField) {
      appendChild(ids.schema, ids.priorityField);
      appendChild(ids.priorityField, ids.priorityHigh);
      appendChild(ids.priorityField, ids.priorityLow);
    }
    if (options.dateField) appendChild(ids.schema, ids.dueField);
    if (options.referenceField) appendChild(ids.schema, ids.referencesField);
    appendChild(ids.daily, ids.today);
    if (options.optionsField) appendChild(ids.today, ids.priorityEntry);
    if (options.dateField) appendChild(ids.today, ids.dueEntry);
    if (options.referenceField) appendChild(ids.today, ids.referencesEntry);
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
      // The per-provider config opens as its own native window in the app; in tests
      // it is reached by navigating to ?surface=provider-config directly, so this
      // just records the open request (so the list can assert it) and no-ops close.
      openProviderConfig: async (params: { providerId: string; mode: string }) => {
        calls.push({ cmd: 'open_provider_config', args: clone(params) });
      },
      closeProviderConfig: async () => {},
      notifySettingsChanged: async () => {},
      recentLocalFiles: async () => ({
        files: [{
          entryKind: 'file',
          id: 'recent-local-notes',
          path: '/Users/test/Documents/recent-notes.md',
          name: 'recent-notes.md',
          parentPath: '/Users/test/Documents',
          mimeType: 'text/plain',
          sizeBytes: 123,
          lastModified: now - 1_000,
        }],
      }),
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
              activeCompaction: null,
              isStreaming: false,
              model: { id: 'gpt-5.4', provider: 'openai' },
              thinkingLevel: 'medium',
              pendingToolCallIds: [],
              errorMessage: null,
              rows: [],
              transcriptRows: [],
              subagentRunIds: [],
              entities: { messages: {}, subagents: {}, compactions: {} },
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
        if (cmd === 'agent_update_runtime_settings') {
          const settings = args.settings as {
            permissionMode?: string;
            automaticSkillsEnabled?: boolean;
            slashSkillsEnabled?: boolean;
            compactEnabled?: boolean;
            additionalSkillDirectories?: string[];
            additionalAgentDirectories?: string[];
            providerTimeoutMs?: number | null;
            providerMaxRetries?: number | null;
            providerMaxRetryDelayMs?: number | null;
            providerCacheRetention?: string;
          };
          agentSettings.agent = {
            permissionMode: settings.permissionMode === 'restricted' ? 'restricted' : 'trusted',
            automaticSkillsEnabled: settings.automaticSkillsEnabled ?? agentSettings.agent.automaticSkillsEnabled,
            slashSkillsEnabled: settings.slashSkillsEnabled ?? agentSettings.agent.slashSkillsEnabled,
            compactEnabled: settings.compactEnabled ?? agentSettings.agent.compactEnabled,
            additionalSkillDirectories: Array.isArray(settings.additionalSkillDirectories)
              ? settings.additionalSkillDirectories.map(String)
              : agentSettings.agent.additionalSkillDirectories,
            additionalAgentDirectories: Array.isArray(settings.additionalAgentDirectories)
              ? settings.additionalAgentDirectories.map(String)
              : agentSettings.agent.additionalAgentDirectories,
            providerTimeoutMs: typeof settings.providerTimeoutMs === 'number' || settings.providerTimeoutMs === null
              ? settings.providerTimeoutMs
              : agentSettings.agent.providerTimeoutMs,
            providerMaxRetries: typeof settings.providerMaxRetries === 'number' || settings.providerMaxRetries === null
              ? settings.providerMaxRetries
              : agentSettings.agent.providerMaxRetries,
            providerMaxRetryDelayMs: typeof settings.providerMaxRetryDelayMs === 'number' || settings.providerMaxRetryDelayMs === null
              ? settings.providerMaxRetryDelayMs
              : agentSettings.agent.providerMaxRetryDelayMs,
            providerCacheRetention: settings.providerCacheRetention === 'none' || settings.providerCacheRetention === 'long'
              ? settings.providerCacheRetention
              : settings.providerCacheRetention === 'short'
                ? 'short'
                : agentSettings.agent.providerCacheRetention,
          };
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_set_active_provider') {
          agentSettings.activeProviderId = String(args.providerId);
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_get_tool_permission_settings') {
          return clone(agentToolPermissions) as T;
        }
        if (cmd === 'agent_update_tool_permission_settings') {
          const next = args.settings as { permissions?: { allow?: string[]; ask?: string[]; deny?: string[] } };
          agentToolPermissions.permissions = {
            allow: next.permissions?.allow ?? [],
            ask: next.permissions?.ask ?? [],
            deny: next.permissions?.deny ?? [],
          };
          return clone(agentToolPermissions) as T;
        }
        if (cmd === 'agent_test_provider_connection') {
          // The credential sheet drives this for its async validate step. Echo a
          // deterministic result keyed off the supplied key so a test can exercise
          // both the success and failure paths.
          const apiKey = typeof args.apiKey === 'string' ? args.apiKey : '';
          const success = !apiKey || !apiKey.includes('bad');
          return clone({
            success,
            message: success ? 'Connection successful' : 'Invalid API key',
          }) as T;
        }
        if (cmd === 'agent_set_provider_api_key') {
          const providerId = String(args.providerId);
          const existing = agentSettings.providers.find((item) => item.providerId === providerId);
          if (existing) {
            existing.hasApiKey = true;
          } else {
            const catalog = agentSettings.availableProviders.find((item) => item.providerId === providerId);
            agentSettings.providers.push({
              providerId,
              modelId: catalog?.models[0]?.id ?? '',
              reasoningLevel: 'medium',
              baseUrl: '',
              enabled: true,
              hasApiKey: true,
              hasEnvApiKey: false,
            });
          }
          return clone({ providerId, hasApiKey: true }) as T;
        }
        if (cmd === 'agent_delete_provider_api_key') {
          const providerId = String(args.providerId);
          const existing = agentSettings.providers.find((item) => item.providerId === providerId);
          if (existing) existing.hasApiKey = false;
          return clone({ providerId, hasApiKey: false }) as T;
        }
        if (cmd === 'agent_delete_provider_config') {
          const providerId = String(args.providerId);
          const index = agentSettings.providers.findIndex((item) => item.providerId === providerId);
          if (index >= 0) agentSettings.providers.splice(index, 1);
          if (agentSettings.activeProviderId === providerId) agentSettings.activeProviderId = '';
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
          if (payloadId === 'subagent-transcript-1') return clone(subagentTranscriptJson) as T;
          return clone(null) as T;
        }
        if (cmd === 'agent_subagent_status') {
          return clone({
            status: 'running',
            agent_id: String(args.agentId),
            description: 'Inspect subagent UI',
            prompt: 'Inspect the current UI.',
            subagent_type: 'explorer',
            context_mode: 'fork',
            started_at: now - 500,
            updated_at: now,
            transcript_message_count: 4,
          }) as T;
        }
        if (cmd === 'agent_subagent_send') {
          return clone({
            status: 'queued',
            agent_id: String(args.agentId),
            description: 'Inspect subagent UI',
            prompt: 'Inspect the current UI.',
            subagent_type: 'explorer',
            context_mode: 'fork',
            started_at: now - 500,
            updated_at: now,
            transcript_message_count: 4,
            instructions: 'Message queued for the running background agent.',
          }) as T;
        }
        if (cmd === 'agent_subagent_stop') {
          return clone({
            status: 'stopped',
            agent_id: String(args.agentId),
            description: 'Inspect subagent UI',
            prompt: 'Inspect the current UI.',
            subagent_type: 'explorer',
            context_mode: 'fork',
            started_at: now - 500,
            updated_at: now,
            completed_at: now,
            transcript_message_count: 4,
          }) as T;
        }
        if (cmd === 'agent_list_slash_commands') {
          return clone([
            {
              id: 'compact',
              kind: 'runtime',
              label: '/compact',
              description: 'Compact the current conversation',
              insertText: '/compact ',
            },
            {
              id: 'skill:auto-skill',
              kind: 'skill',
              label: '/auto-skill',
              description: 'Run automatic skill',
              insertText: '/auto-skill ',
            },
          ]) as T;
        }
        if (cmd === 'agent_queue_follow_up') return clone({ queued: true }) as T;
        if (cmd === 'agent_steer_session') return clone({ queued: true }) as T;
        if (cmd.startsWith('agent_')) return clone(undefined) as T;
        if (cmd === 'init_workspace' || cmd === 'get_projection') return clone(projection());
        if (cmd === 'create_node') {
          const nodeId = createNode(
            String(args.parentId),
            args.index as number | null,
            String(args.text ?? ''),
            {},
            typeof args.id === 'string' ? args.id : undefined,
          );
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
        if (cmd === 'update_node_description') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            const description = typeof args.description === 'string' ? args.description.trim() : '';
            if (description) node.description = description;
            else delete node.description;
            node.updatedAt = ++now;
          }
          return clone(outcome());
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
              // Manual three-state cycle over the completedAt sentinel
              // (undefined = no box → 0 = undone box → >0 = done → none).
              if (node.completedAt === undefined) node.completedAt = 0;
              else if (node.completedAt === 0) node.completedAt = ++now;
              else node.completedAt = undefined;
            } else {
              // Toggle keeps the box: done (>0) → undone (0); otherwise → done.
              node.completedAt = node.completedAt ? 0 : ++now;
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
        if (cmd === 'reuse_field_definition') {
          return clone(reuseFieldDefinition(String(args.entryId), String(args.targetDefId)));
        }
        if (cmd === 'register_collected_option') {
          return clone(registerOption(String(args.fieldDefId), String(args.name)));
        }
        if (cmd === 'create_collected_field_option') {
          return clone(createCollectedOption(
            String(args.fieldEntryId),
            String(args.name),
            typeof args.id === 'string' ? args.id : undefined,
          ));
        }
        if (cmd === 'select_field_option') {
          return clone(selectOption(
            String(args.fieldEntryId),
            String(args.optionNodeId),
            typeof args.id === 'string' ? args.id : undefined,
          ));
        }
        if (cmd === 'add_field_reference') {
          return clone(addFieldReference(
            String(args.fieldEntryId),
            String(args.targetNodeId),
            typeof args.id === 'string' ? args.id : undefined,
          ));
        }
        if (cmd === 'set_field_free_text_value') {
          return clone(setFieldFreeTextValue(
            String(args.fieldEntryId),
            String(args.text ?? ''),
            typeof args.id === 'string' ? args.id : undefined,
          ));
        }
        if (cmd === 'clear_field_value') {
          return clone(clearFieldValue(String(args.fieldEntryId)));
        }
        if (cmd === 'remove_field_value') {
          return clone(removeFieldValue(String(args.valueId)));
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
        if (cmd === 'add_reference_conversion') {
          const parentId = String(args.parentId);
          const targetId = resolveReferenceTargetId(String(args.targetId)) ?? String(args.targetId);
          const target = nodes.get(targetId);
          if (!target) return clone(outcome());
          const inlineNodeId = createNode(parentId, args.index as number | null, '', { showCheckbox: false });
          const inlineNode = nodes.get(inlineNodeId);
          if (inlineNode) {
            inlineNode.content = {
              text: '',
              marks: [],
              inlineRefs: [{ offset: 0, targetNodeId: target.id, displayName: target.content.text || undefined }],
            };
          }
          return clone(outcome({
            nodeId: inlineNodeId,
            parentId,
            placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
            selectAll: false,
          }));
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
        if (cmd === 'replace_node_with_reference_conversion') {
          const node = nodes.get(String(args.nodeId));
          const targetId = resolveReferenceTargetId(String(args.targetId)) ?? String(args.targetId);
          const target = nodes.get(targetId);
          const parentId = node?.parentId;
          const parent = parentId ? nodes.get(parentId) : null;
          if (!node || !target || !parentId || !parent) return clone(outcome());
          const index = parent.children.indexOf(node.id);
          const inlineNodeId = createNode(parentId, index < 0 ? null : index, '', { showCheckbox: false });
          const inlineNode = nodes.get(inlineNodeId);
          if (inlineNode) {
            inlineNode.content = {
              text: '',
              marks: [],
              inlineRefs: [{ offset: 0, targetNodeId: target.id, displayName: target.content.text || undefined }],
            };
          }
          removeNode(node.id);
          return clone(outcome({
            nodeId: inlineNodeId,
            parentId,
            placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
            selectAll: false,
          }));
        }
        if (cmd === 'replace_node_with_inline_reference') {
          const node = nodes.get(String(args.nodeId));
          const targetId = resolveReferenceTargetId(String(args.targetId)) ?? String(args.targetId);
          const target = nodes.get(targetId);
          const parentId = node?.parentId;
          const parent = parentId ? nodes.get(parentId) : null;
          if (!node || !target || !parentId || !parent) return clone(outcome());
          const index = parent.children.indexOf(node.id);
          const inlineNodeId = createNode(parentId, index < 0 ? null : index, '', { showCheckbox: false });
          const inlineNode = nodes.get(inlineNodeId);
          if (inlineNode) {
            inlineNode.content = {
              text: '',
              marks: [],
              inlineRefs: [{ offset: 0, targetNodeId: target.id, displayName: target.content.text || undefined }],
            };
          }
          removeNode(node.id);
          return clone(outcome({
            nodeId: inlineNodeId,
            parentId,
            placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
            selectAll: false,
          }));
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
	        if (cmd === 'set_view_toolbar_visible') {
	          if (nodes.has(String(args.nodeId))) ensureViewDef(String(args.nodeId)).toolbarVisible = Boolean(args.visible);
	          return clone(outcome());
	        }
	        if (cmd === 'set_view_mode') {
	          if (nodes.has(String(args.nodeId))) ensureViewDef(String(args.nodeId)).viewMode = String(args.mode ?? 'list');
	          return clone(outcome());
	        }
	        if (cmd === 'add_sort_rule') {
	          const view = nodes.has(String(args.nodeId)) ? ensureViewDef(String(args.nodeId)) : null;
	          if (view) {
	            const ruleId = `sort-${++sequence}`;
	            makeNode(ruleId, '', {
	              type: 'sortRule',
	              parentId: view.id,
	              sortField: String(args.field ?? 'sys:name'),
	              sortDirection: args.direction === 'desc' ? 'desc' : 'asc',
	            });
	            appendChild(view.id, ruleId);
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'update_sort_rule') {
	          const rule = nodes.get(String(args.ruleId));
	          if (rule?.type === 'sortRule') {
	            rule.sortField = String(args.field ?? rule.sortField ?? 'sys:name');
	            rule.sortDirection = args.direction === 'desc' ? 'desc' : 'asc';
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'remove_sort_rule') {
	          removeNode(String(args.ruleId));
	          return clone(outcome());
	        }
	        if (cmd === 'clear_sort_rules') {
	          const view = directChildOfType(String(args.nodeId), 'viewDef');
	          if (view) for (const rule of directChildrenOfType(view.id, 'sortRule')) removeNode(rule.id);
	          return clone(outcome());
	        }
	        if (cmd === 'add_filter_rule') {
	          const view = nodes.has(String(args.nodeId)) ? ensureViewDef(String(args.nodeId)) : null;
	          if (view) {
	            const ruleId = `filter-${++sequence}`;
	            makeNode(ruleId, '', {
	              type: 'filterRule',
	              parentId: view.id,
	              filterField: String(args.field ?? 'sys:name'),
	              filterOperator: String(args.operator ?? 'contains'),
	              filterValueLogic: args.valueLogic === 'all' ? 'all' : 'any',
	              filterValues: Array.isArray(args.values) ? args.values.map(String) : [],
	            });
	            appendChild(view.id, ruleId);
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'update_filter_rule') {
	          const rule = nodes.get(String(args.ruleId));
	          if (rule?.type === 'filterRule') {
	            if (args.field != null) rule.filterField = String(args.field);
	            if (args.operator != null) rule.filterOperator = String(args.operator);
	            if (args.valueLogic != null) rule.filterValueLogic = args.valueLogic === 'all' ? 'all' : 'any';
	            if (Array.isArray(args.values)) rule.filterValues = args.values.map(String);
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'remove_filter_rule') {
	          removeNode(String(args.ruleId));
	          return clone(outcome());
	        }
	        if (cmd === 'clear_filter_rules') {
	          const view = directChildOfType(String(args.nodeId), 'viewDef');
	          if (view) for (const rule of directChildrenOfType(view.id, 'filterRule')) removeNode(rule.id);
	          return clone(outcome());
	        }
	        if (cmd === 'set_group_field') {
	          if (nodes.has(String(args.nodeId))) {
	            const view = ensureViewDef(String(args.nodeId));
	            if (args.field == null || args.field === '') delete view.groupField;
	            else view.groupField = String(args.field);
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'add_display_field') {
	          const view = nodes.has(String(args.nodeId)) ? ensureViewDef(String(args.nodeId)) : null;
	          if (view) {
	            const displayId = `display-${++sequence}`;
	            makeNode(displayId, '', {
	              type: 'displayField',
	              parentId: view.id,
	              displayField: String(args.field ?? 'sys:name'),
	              displayVisible: true,
	            });
	            appendChild(view.id, displayId);
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'update_display_field') {
	          const display = nodes.get(String(args.displayFieldId));
	          if (display?.type === 'displayField') {
	            if (args.field != null) display.displayField = String(args.field);
	            if (args.visible != null) display.displayVisible = Boolean(args.visible);
	            if (args.width != null) setOptionalNumber(display, 'displayWidth', args.width);
	            if (args.label != null) setOptionalText(display, 'displayLabel', args.label);
	            if (args.placement != null) display.displayPlacement = String(args.placement);
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'remove_display_field') {
	          removeNode(String(args.displayFieldId));
	          return clone(outcome());
	        }
	        if (cmd === 'set_node_icon') {
	          const node = nodes.get(String(args.nodeId));
	          if (node) {
	            setOptionalText(node, 'icon', args.icon);
	            if (args.iconKind == null || args.iconKind === '') delete node.iconKind;
	            else node.iconKind = String(args.iconKind);
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'set_node_banner') {
	          const node = nodes.get(String(args.nodeId));
	          if (node) {
	            setOptionalText(node, 'bannerAssetId', args.assetId);
	            const position = args.position && typeof args.position === 'object' ? args.position as Record<string, unknown> : {};
	            if (position.x != null) setOptionalNumber(node, 'bannerPositionX', position.x);
	            if (position.y != null) setOptionalNumber(node, 'bannerPositionY', position.y);
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'set_search_query_outline') {
	          setSearchQueryOutline(String(args.nodeId), String(args.queryOutline ?? ''));
	          return clone(outcome({ nodeId: String(args.nodeId), selectAll: false }));
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
        if (cmd === 'set_code_block') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            node.type = 'codeBlock';
            const lang = typeof args.codeLanguage === 'string' ? args.codeLanguage.trim().toLowerCase() : '';
            if (lang) node.codeLanguage = lang;
            else delete node.codeLanguage;
            node.updatedAt = ++now;
          }
          return clone(outcome({
            nodeId: String(args.nodeId),
            parentId: node?.parentId ?? null,
            placement: { kind: 'end' },
            selectAll: false,
          }));
        }
        if (cmd === 'set_code_language') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            const lang = typeof args.codeLanguage === 'string' ? args.codeLanguage.trim().toLowerCase() : '';
            if (lang) node.codeLanguage = lang;
            else delete node.codeLanguage;
            node.updatedAt = ++now;
          }
          return clone(outcome({ nodeId: String(args.nodeId), selectAll: false }));
        }
        if (
          cmd === 'ensure_tag_search'
          || cmd === 'refresh_search_node_results'
          || cmd === 'restore_node'
          || cmd === 'undo'
          || cmd === 'redo'
        ) {
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
  const compactions: Record<string, any> = {};
  const rows: Array<{ id: string; kind: string; messageId: string; compactionId?: string }> = [];

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
  const rawSubagents = state.subagents ?? {};
  const subagents = Array.isArray(rawSubagents)
    ? Object.fromEntries(rawSubagents.map((subagent: any) => [subagent.id, subagent]))
    : rawSubagents;
  const subagentRunIds = state.subagentRunIds
    ?? (Array.isArray(rawSubagents) ? rawSubagents.map((subagent: any) => subagent.id) : Object.keys(subagents));

  for (const entry of state.conversation ?? []) {
    if (entry.kind === 'compaction') {
      const compaction = entry.compaction;
      const messageId = compaction.messageId ?? entry.nodeId ?? `compact-${compaction.id}`;
      rows.push({ id: `compaction:${messageId}`, kind: 'compaction', messageId, compactionId: compaction.id });
      entities[messageId] = {
        id: messageId,
        role: 'user',
        status: 'completed',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Conversation compacted.' }],
        createdAt: compaction.createdAt,
        updatedAt: compaction.createdAt,
        branches: null,
      };
      compactions[compaction.id] = {
        compactedThroughMessageId: compaction.compactedThroughMessageId ?? messageId,
        createdAt: compaction.createdAt,
        id: compaction.id,
        messageId,
        summary: compaction.summary,
        trigger: compaction.trigger ?? 'manual',
      };
      continue;
    }

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
      activeCompaction: state.activeCompaction ?? null,
      isStreaming: !!state.isStreaming,
      model: state.model ?? {},
      thinkingLevel: state.thinkingLevel ?? 'off',
      pendingToolCallIds: state.pendingToolCallIds ?? [],
      errorMessage: state.errorMessage ?? null,
      rows,
      transcriptRows: state.transcriptRows ?? rows,
      subagentRunIds,
      entities: { messages: entities, subagents, compactions },
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
