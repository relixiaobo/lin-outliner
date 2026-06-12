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
  commandNode: 'node-command',
  commandScheduleEntry: 'field-entry-command-schedule',
  commandAgentEntry: 'field-entry-command-agent',
} as const;

interface MockFixtureOptions {
  dateField?: boolean;
  optionsField?: boolean;
  referenceField?: boolean;
  /** Adds an OAuth sign-in provider (GitHub Copilot) to the catalog for the OAuth specs. */
  oauthProvider?: boolean;
  /** Leaves every provider uncredentialed so the agent panel shows the no-provider onboarding. */
  noProvider?: boolean;
  /** Adds an armed `command` (scheduled routine) node under today for the command-node specs. */
  commandNode?: boolean;
  /** Adds an agent loaded from an additional directory outside writable authoring roots. */
  additionalAgentDirectoryAgent?: boolean;
}

type E2EWindow = Window & {
  __LIN_E2E__?: {
    calls: Array<{ cmd: string; args: Record<string, unknown> }>;
    projection: () => unknown;
    clipboardText: () => string;
    emitAgentEvent: (event: unknown) => void;
    emitDocumentEvent: (event: unknown) => void;
    emitOAuthEvent: (envelope: unknown) => void;
    resolveOAuthLogin: (providerId: string) => void;
    setAgentMessageContextMenuAction: (action: 'copy' | 'retry' | 'regenerate' | 'details' | null) => void;
  };
  lin?: {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    onAgentEvent: (listener: (event: unknown) => void) => () => void;
    onDocumentEvent: (listener: (event: unknown) => void) => () => void;
    onAgentOAuthEvent?: (listener: (envelope: unknown) => void) => () => void;
    openProviderConfig?: (params: { providerId: string; mode: string }) => Promise<void>;
    openSettings?: (target?: unknown) => Promise<void>;
    closeProviderConfig?: () => Promise<void>;
    notifySettingsChanged?: () => Promise<void>;
    onSettingsNavigate?: (listener: (target: unknown) => void) => () => void;
    showAgentMessageContextMenu?: (request: {
      canCopy: boolean;
      canRetry: boolean;
      canRegenerate: boolean;
      canShowDetails: boolean;
    }) => Promise<'copy' | 'retry' | 'regenerate' | 'details' | null>;
    openLocalFile?: (options: { path: string }) => Promise<{ opened: boolean }>;
    previewLocalFile?: (options: { id: string }) => Promise<{ thumbnailDataUrl: string | null }>;
    previewLocalFileReference?: (options: { path: string }) => Promise<{
      file: {
        entryKind: 'file' | 'directory';
        path: string;
        name: string;
        parentPath: string;
        mimeType: string;
        sizeBytes: number;
        lastModified: number;
        iconDataUrl?: string;
        thumbnailDataUrl?: string;
      } | null;
    }>;
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
    stageAttachment?: (input: { name: string; mimeType: string; bytes: ArrayBuffer }) => Promise<{
      path: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
    }>;
  };
};

export type E2EReferenceTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'local-file'; path: string; entryKind: 'file' | 'directory' };

export interface E2EInlineRef {
  offset: number;
  target: E2EReferenceTarget;
  displayName?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export function e2eInlineRefNodeId(ref: E2EInlineRef): string | null {
  return ref.target.kind === 'node' ? ref.target.nodeId : null;
}

export function e2eNodeInlineRef(offset: number, nodeId: string, displayName?: string): E2EInlineRef {
  return {
    offset,
    target: { kind: 'node', nodeId },
    ...(displayName ? { displayName } : {}),
  };
}

export async function installElectronMock(page: Page, options: MockFixtureOptions = {}) {
  await page.addInitScript(({ ids, options }) => {
    type ReferenceTarget =
      | { kind: 'node'; nodeId: string }
      | { kind: 'local-file'; path: string; entryKind: 'file' | 'directory' };
    type RichText = { text: string; marks: unknown[]; inlineRefs: Array<{ offset: number; target: ReferenceTarget; displayName?: string; mimeType?: string; sizeBytes?: number }> };
    type RichTextPatch = {
      ops: Array<
        | { type: 'replace_all'; content: RichText }
        | { type: 'replace'; from: number; to: number; content: RichText }
        | { type: 'add_mark'; from: number; to: number; markType: string; attrs?: Record<string, string> }
        | { type: 'remove_mark'; from: number; to: number; markType: string }
      >;
    };
    const referenceTargetsEqual = (left: ReferenceTarget, right: ReferenceTarget) => {
      if (left.kind !== right.kind) return false;
      if (left.kind === 'node') return left.nodeId === (right as Extract<ReferenceTarget, { kind: 'node' }>).nodeId;
      const localRight = right as Extract<ReferenceTarget, { kind: 'local-file' }>;
      return left.path === localRight.path && left.entryKind === localRight.entryKind;
    };
    const nodeInlineRef = (offset: number, nodeId: string, displayName?: string): RichText['inlineRefs'][number] => ({
      offset,
      target: { kind: 'node', nodeId },
      ...(displayName ? { displayName } : {}),
    });
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
	      assetId?: string;
	      mediaUrl?: string;
	      mediaAlt?: string;
	      imageWidth?: number;
	      imageHeight?: number;
	      mimeType?: string;
	      originalFilename?: string;
	      fileSize?: number;
	      thumbnailAssetId?: string;
	      pdfPageCount?: number;
	      audioDurationMs?: number;
	      videoDurationMs?: number;
	      configKey?: string;
	      refRole?: string;
	      commandSchedule?: string;
	      commandAgent?: string;
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
    // The mock doesn't track per-command change sets, so every command/event ships
    // a `full` ProjectionUpdate (the renderer rebuilds from it). Revision advances
    // monotonically to mirror the real emit chain; the delta path is unit-tested
    // separately (reduceProjection.test.ts).
    let revision = 0;
    let clipboardText = '';
    const MAIN_AGENT_ID = 'built-in:core:assistant';
    const GENERAL_AGENT_ID = 'built-in:tenon:general';
    const ASSISTANT_DM_ID = 'mock-agent-conversation';
    const GENERAL_DM_ID = 'mock-agent-dm-general';
    const PLANNING_CHANNEL_ID = 'mock-agent-channel-planning';
    const assets = new Map<string, {
      id: string;
      mimeType: string;
      byteSize: number;
      originalFilename?: string;
      createdAt: number;
      imageWidth?: number;
      imageHeight?: number;
      thumbnailAssetId?: string;
      pdfPageCount?: number;
      audioDurationMs?: number;
      videoDurationMs?: number;
    }>();
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    const agentListeners: Array<(event: unknown) => void> = [];
    const documentListeners: Array<(event: unknown) => void> = [];
    const oauthListeners: Array<(envelope: unknown) => void> = [];
    let messageContextMenuAction: 'copy' | 'retry' | 'regenerate' | 'details' | null = null;
    // An in-flight sign-in's resolve/reject, keyed by providerId. The spec drives
    // the event stream (emitOAuthEvent) and completes it (resolveOAuthLogin), so
    // the flow is fully deterministic — no real provider, timers, or network.
    const oauthPending = new Map<string, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>();
    const agentSettings = {
      activeProviderId: 'openai',
      agent: {
        safetyMode: 'balanced',
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
        // Main now always populates the `auth` descriptor (the single
        // `credentialed` signal the renderer reads); the mock mirrors it.
        auth: { authKind: 'api-key', credentialed: true, hasStoredKey: true },
      }],
      availableProviders: [{
        providerId: 'openai',
        authKind: 'api-key',
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
        authKind: 'api-key',
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
        authKind: 'managed',
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
    // Strip every credential so the agent panel renders the no-provider
    // onboarding and the send-guard engages (settings still LOAD — they just
    // report no usable provider).
    if (options.noProvider) {
      for (const provider of agentSettings.providers) {
        provider.hasApiKey = false;
        provider.auth = { authKind: 'api-key', credentialed: false, hasStoredKey: false };
      }
    }
    // An OAuth sign-in provider for the OAuth specs. Gated so the api-key /
    // managed specs keep their fixed catalog. `authKind: 'oauth'` makes the
    // config window render the sign-in surface (ProviderOAuthForm).
    if (options.oauthProvider) {
      agentSettings.availableProviders.push({
        providerId: 'github-copilot',
        authKind: 'oauth',
        hasEnvApiKey: false,
        envKeyNames: [],
        defaultBaseUrl: 'https://api.githubcopilot.com',
        models: [
          {
            id: 'gpt-4o-copilot',
            name: 'GPT-4o (Copilot)',
            reasoning: false,
            supportedThinkingLevels: ['off'],
            contextWindow: 128_000,
            maxTokens: 4096,
          },
        ],
      });
    }
    const agentToolPermissions = {
      permissions: { allow: [] as string[], ask: [] as string[], deny: [] as string[] },
      diagnostics: [] as Array<{ ruleValue: string; decision: 'allow' | 'ask' | 'deny'; code: string; message: string }>,
    };
    const agentSkills = [{
      name: 'workspace-review',
      source: 'project',
      rootDir: '/mock/workspace/.agents/skills/workspace-review',
      skillFile: '/mock/workspace/.agents/skills/workspace-review/SKILL.md',
      description: 'Review workspace conventions before automatic use.',
      hasUserSpecifiedDescription: true,
      userInvocable: true,
      modelInvocable: true,
      ratified: false,
      accepted: false,
      canUndoLastAgentEdit: false,
      contentHash: 'hash-workspace-review-v1',
      allowedTools: [],
      argumentNames: [],
      context: 'inline',
      contentLength: 64,
      body: 'Review workspace conventions before automatic use.',
    }];
    const agentDefinitions = [
      {
        agentId: GENERAL_AGENT_ID,
        name: 'general',
        displayName: 'general',
        source: 'built-in',
        rootDir: 'built-in',
        agentFile: 'built-in/general',
        writable: false,
        description: 'General-purpose focused child run for research, analysis, and execution.',
        model: 'gpt-5.4-mini',
        body: [
          'You are a focused child agent running inside Lin.',
          'Complete the assigned task independently and report only the result that matters.',
        ].join('\n'),
        permissionMode: 'restricted',
        maxTurns: null,
      },
    ];
    if (options.additionalAgentDirectoryAgent) {
      agentDefinitions.push({
        agentId: 'user:external123:external-reviewer',
        name: 'external-reviewer',
        displayName: 'external-reviewer',
        source: 'user',
        rootDir: '/mock/shared-agents/external-reviewer',
        agentFile: '/mock/shared-agents/external-reviewer/AGENT.md',
        writable: false,
        description: 'Reviews work from a shared directory.',
        model: 'gpt-5.4-mini',
        effort: 'high',
        body: 'You review work from a shared directory.',
        permissionMode: 'restricted',
        maxTurns: null,
      });
    }
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
    // Replayed transcript for the delegated run's own ledger — served whole by
    // `agent_child_run_transcript` (the payload-pinned snapshot is gone).
    const childRunTranscriptMessages = [
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
            { type: 'toolCall', id: 'child-run-tool-read-1', name: 'node_read', arguments: { nodeId: 'today' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'child-run-tool-read-1',
          toolName: 'node_read',
          timestamp: now - 300,
          content: [{ type: 'text', text: 'Daily note content from child run.' }],
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
          content: [{ type: 'text', text: 'The child run finished inspecting the UI.' }],
        },
      ];
    const debugSnapshot = {
      id: 'debug-snapshot-1',
      source: 'provider_payload',
      conversationId: 'mock-agent-conversation',
      conversationTitle: 'conversation',
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
    const agentConversations = [
      {
        id: ASSISTANT_DM_ID,
        title: 'Agent System',
        members: [
          { type: 'user', userId: 'local-user' },
          { type: 'agent', agentId: MAIN_AGENT_ID },
        ],
        canonicalDmAgentId: MAIN_AGENT_ID,
        createdAt: now - 100_000,
        updatedAt: now - 1_000,
        messageCount: 33,
        lastMessageSnippet: 'Current outline focuses on UI work.',
        lastMessageAt: now - 1_000,
        unreadCount: 0,
      },
      {
        id: GENERAL_DM_ID,
        title: 'general',
        members: [
          { type: 'user', userId: 'local-user' },
          { type: 'agent', agentId: GENERAL_AGENT_ID },
        ],
        canonicalDmAgentId: GENERAL_AGENT_ID,
        createdAt: now - 200_000,
        updatedAt: now - 80_000,
        messageCount: 0,
        lastMessageSnippet: null,
        lastMessageAt: null,
        unreadCount: 0,
      },
      {
        id: PLANNING_CHANNEL_ID,
        title: 'Planning Channel',
        members: [
          { type: 'user', userId: 'local-user' },
          { type: 'agent', agentId: MAIN_AGENT_ID },
          { type: 'agent', agentId: GENERAL_AGENT_ID },
        ],
        goal: 'Planning Channel',
        createdAt: now - 180_000,
        updatedAt: now - 60_000,
        messageCount: 1,
        lastMessageSnippet: 'Coordinate the launch plan.',
        lastMessageAt: now - 60_000,
        unreadCount: 0,
      },
    ];
    // Memory entries are principal-keyed (the pool they belong to); the Settings pane
    // groups/labels by `principal`, so one agent-pool fact and one user-pool fact.
    const agentMemoryEntries = [
      {
        id: 'memory-active',
        principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        fact: 'Prefer concise, direct implementation notes in agent review work.',
        originWorkspace: '/mock/local-root',
        sources: [{
          conversationId: 'mock-agent-conversation',
          runId: 'run-memory-e2e',
          eventId: 'event-memory-e2e',
        }],
        status: 'active',
        createdAt: now - 4_000,
      },
      {
        id: 'memory-forgotten',
        principal: { type: 'user', userId: 'local-user' },
        fact: 'Use the old conversation vocabulary in public UI.',
        originWorkspace: '/mock/local-root',
        sources: [{
          conversationId: 'mock-agent-conversation',
          runId: 'run-memory-old',
          eventId: 'event-memory-old',
        }],
        status: 'invalidated',
        createdAt: now - 8_000,
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
            && referenceTargetsEqual(candidate.target, ref.target)
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
    const projectionSnapshot = () => ({ revision: ++revision, projection: projection() });
    const fullUpdate = () => ({ kind: 'full' as const, revision: ++revision, projection: projection() });
    const outcome = (focus?: {
      nodeId: string;
      selectAll: boolean;
      parentId?: string | null;
      placement?: unknown;
      surface?: string;
    }) => ({
      update: fullUpdate(),
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
    const inferMimeType = (name: string, hinted?: string) => {
      if (hinted) return hinted;
      const lower = name.toLowerCase();
      if (lower.endsWith('.png')) return 'image/png';
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
      if (lower.endsWith('.pdf')) return 'application/pdf';
      if (lower.endsWith('.wav')) return 'audio/wav';
      if (lower.endsWith('.mp4')) return 'video/mp4';
      if (lower.endsWith('.md')) return 'text/markdown';
      if (lower.endsWith('.txt')) return 'text/plain';
      return 'application/octet-stream';
    };
    const createAsset = (input: { mimeType?: string; originalFilename?: string; byteSize?: number }) => {
      const name = input.originalFilename || 'attachment';
      const mimeType = inferMimeType(name, input.mimeType);
      const id = `asset-${++sequence}`;
      const asset = {
        id,
        mimeType,
        byteSize: input.byteSize ?? 128,
        originalFilename: name,
        createdAt: ++now,
        ...(mimeType.startsWith('image/') ? { imageWidth: 320, imageHeight: 180 } : {}),
        ...(mimeType === 'application/pdf' ? { pdfPageCount: 1 } : {}),
        ...(mimeType === 'audio/wav' ? { audioDurationMs: 1000 } : {}),
        ...(mimeType === 'video/mp4' ? { videoDurationMs: 1000 } : {}),
      };
      assets.set(id, asset);
      return asset;
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
          // GFM task-list paste: completedAt sentinel mirrors core
          // (0 = unchecked checkbox, a timestamp = checked).
          if (item.checkbox) node.completedAt = item.done ? ++now : 0;
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
    if (options.commandNode) {
      makeNode(ids.commandNode, 'Summarize my unread feeds and post the highlights', {
        type: 'command',
        parentId: ids.today,
        commandSchedule: '2026-06-09T09:00 RRULE:FREQ=DAILY',
        commandAgent: 'general',
      });
      // The two node-native config rows (Schedule / Agent) — real field entries
      // pointing at the built-in system fields, as `setCommandNode` seeds them.
      makeNode(ids.commandScheduleEntry, '', {
        type: 'fieldEntry',
        parentId: ids.commandNode,
        fieldDefId: 'sys:commandSchedule',
      });
      makeNode(ids.commandAgentEntry, '', {
        type: 'fieldEntry',
        parentId: ids.commandNode,
        fieldDefId: 'sys:commandAgent',
      });
    }
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
    if (options.commandNode) {
      appendChild(ids.today, ids.commandNode);
      appendChild(ids.commandNode, ids.commandScheduleEntry);
      appendChild(ids.commandNode, ids.commandAgentEntry);
    }

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
      // Test-boundary adapter: specs author `projection_changed` events with a
      // legacy `{ projection }` field; the renderer now consumes a
      // `ProjectionUpdate`. Wrap a bare projection into a `full` update here so
      // the many existing call sites stay terse. (Not a production shim — the
      // real main process emits `update` directly.)
      const normalized = ((): unknown => {
        if (event && typeof event === 'object') {
          const e = event as Record<string, unknown>;
          if (e.type === 'projection_changed' && 'projection' in e && !('update' in e)) {
            const { projection: proj, ...rest } = e;
            return { ...rest, update: { kind: 'full', revision: ++revision, projection: proj } };
          }
        }
        return event;
      })();
      for (const listener of documentListeners) {
        listener(clone(normalized));
      }
    };

    const emitOAuthEvent = (envelope: unknown) => {
      for (const listener of oauthListeners) {
        listener(clone(envelope));
      }
    };

    // Mark an OAuth provider connected and resolve its pending login with the
    // updated settings — the renderer re-renders into the connected state.
    type MockAuthProvider = {
      providerId: string;
      modelId: string;
      reasoningLevel: string;
      baseUrl: string;
      enabled: boolean;
      hasApiKey: boolean;
      hasEnvApiKey: boolean;
      auth?: { authKind: string; credentialed: boolean; oauth?: { connected: boolean; expiresAt?: number } };
    };
    const resolveOAuthLogin = (providerId: string) => {
      const providers = agentSettings.providers as unknown as MockAuthProvider[];
      const catalog = agentSettings.availableProviders.find((item) => item.providerId === providerId);
      const auth = { authKind: 'oauth', credentialed: true, oauth: { connected: true, expiresAt: now + 1_000 * 60 * 60 * 24 * 30 } };
      const existing = providers.find((item) => item.providerId === providerId);
      if (existing) { existing.enabled = true; existing.hasApiKey = false; existing.auth = auth; } else {
        providers.push({
          providerId,
          modelId: catalog?.models[0]?.id ?? '',
          reasoningLevel: 'medium',
          baseUrl: '',
          enabled: true,
          hasApiKey: false,
          hasEnvApiKey: false,
          auth,
        });
      }
      const pending = oauthPending.get(providerId);
      if (pending) { oauthPending.delete(providerId); pending.resolve(clone(agentSettings)); }
    };

    win.__LIN_E2E__ = {
      calls,
      projection,
      clipboardText: () => clipboardText,
      emitAgentEvent,
      emitDocumentEvent,
      emitOAuthEvent,
      resolveOAuthLogin,
      setAgentMessageContextMenuAction: (action) => { messageContextMenuAction = action; },
    };
    (win as unknown as { e2eNodeInlineRef: typeof nodeInlineRef }).e2eNodeInlineRef = nodeInlineRef;

    const agentLabel = (agentId: string) => agentId === MAIN_AGENT_ID ? 'Agent System' : 'general';
    const agentMention = (agentId: string) => agentId === MAIN_AGENT_ID ? 'assistant' : 'general';
    const povInspectorsForConversation = (conversationId: string) => {
      if (conversationId !== PLANNING_CHANNEL_ID) return {};
      return {
        [GENERAL_AGENT_ID]: {
          agentId: GENERAL_AGENT_ID,
          addressedByMessageId: 'assistant-planning-e2e',
          memoryBriefing: [
            '<memory>',
            '<self>',
            '- Prefers terse launch-risk notes.',
            '</self>',
            '<principal name="Agent System">',
            '- Tracks architecture seams for handoffs.',
            '</principal>',
            '</memory>',
          ].join('\n'),
          messages: [{
            id: 'flattened:planning:1',
            role: 'user',
            sourceMessageIds: ['user-planning-e2e', 'assistant-planning-e2e'],
            createdAt: now - 55_000,
            parts: [{
              preamble: '@user (the human user) said:',
              text: 'Coordinate the launch plan.',
              sourceMessageId: 'user-planning-e2e',
              sourceRole: 'user',
              sourceActor: { type: 'user', userId: 'local-user' },
            }, {
              preamble: '@assistant (agent "Agent System") said:',
              text: '@general please review launch risk.',
              sourceMessageId: 'assistant-planning-e2e',
              sourceRole: 'assistant',
              sourceActor: { type: 'agent', agentId: MAIN_AGENT_ID },
            }],
          }, {
            id: 'verbatim:general-planning-e2e',
            role: 'assistant',
            sourceMessageIds: ['general-planning-e2e'],
            createdAt: now - 50_000,
            parts: [{
              text: 'General sees the launch-risk request and answers as itself.',
              sourceMessageId: 'general-planning-e2e',
              sourceRole: 'assistant',
              sourceActor: { type: 'agent', agentId: GENERAL_AGENT_ID },
            }],
          }],
        },
      };
    };
    const renderMembers = (agentIds: string[]) => [
      { principal: { type: 'user', userId: 'local-user' }, mention: '', displayName: 'You' },
      ...agentIds.map((agentId) => ({
        principal: { type: 'agent', agentId },
        mention: agentMention(agentId),
        displayName: agentLabel(agentId),
        ...(agentId === MAIN_AGENT_ID ? { coordinator: true } : {}),
      })),
    ];
    const agentIdsForConversation = (conversationId: string, fallback: string[] = [MAIN_AGENT_ID]) => {
      if (conversationId === GENERAL_DM_ID) return [GENERAL_AGENT_ID];
      const entry = agentConversations.find((conversation) => conversation.id === conversationId);
      const ids = entry?.members
        .filter((member): member is { type: 'agent'; agentId: string } => member.type === 'agent')
        .map((member) => member.agentId);
      return ids && ids.length > 0 ? ids : fallback;
    };
    const agentProjection = (
      conversationId: string,
      options: {
        title?: string | null;
        agentIds?: string[];
        systemNotice?: string;
        seedText?: string;
      } = {},
    ) => {
      const agentIds = options.agentIds ?? agentIdsForConversation(conversationId);
      const title = options.title ?? (
        conversationId === GENERAL_DM_ID ? 'general'
          : conversationId === PLANNING_CHANNEL_ID ? 'Planning Channel'
            : 'Agent System'
      );
      const rows: Array<{ id: string; kind: 'message'; messageId: string }> = [];
      const messages: Record<string, unknown> = {};
      const addMessage = (id: string, text: string, actor: unknown, timestamp: number) => {
        rows.push({ id: `user:${id}`, kind: 'message', messageId: id });
        messages[id] = {
          id,
          role: 'user',
          status: 'completed',
          parentMessageId: null,
          content: [{ type: 'text', text }],
          createdAt: timestamp,
          updatedAt: timestamp,
          branches: null,
          actor,
        };
      };
      if (options.systemNotice) addMessage('system-notice-e2e', options.systemNotice, { type: 'system' }, now - 20);
      if (options.seedText) addMessage('seed-note-e2e', options.seedText, { type: 'user', userId: 'local-user' }, now - 10);
      return {
        conversationId,
        revision: 1,
        conversationTitle: title,
        members: renderMembers(agentIds),
        activeRunId: null,
        activeRuns: [],
        activityEntries: [],
        povInspectors: povInspectorsForConversation(conversationId),
        activeCompaction: null,
        activeDream: null,
        isStreaming: false,
        model: { id: 'gpt-5.4', provider: 'openai' },
        thinkingLevel: 'medium',
        pendingToolCallIds: [],
        errorMessage: null,
        rows,
        transcriptRows: rows,
        taskIds: [],
        childRunIds: [],
        entities: { messages, childRuns: {}, compactions: {}, dreams: {}, tasks: {} },
        streaming: null,
      };
    };
    const restoreAgentConversation = (conversationId: string) => ({
      conversationId,
      renderProjection: agentProjection(conversationId),
    });
    win.lin = {
      // The per-provider config opens as its own native window in the app; in tests
      // it is reached by navigating to ?surface=provider-config directly, so this
      // just records the open request (so the list can assert it) and no-ops close.
      openProviderConfig: async (params: { providerId: string; mode: string }) => {
        calls.push({ cmd: 'open_provider_config', args: clone(params) });
      },
      // The Settings window opens natively; in tests just record the request so
      // the onboarding CTA can be asserted (it deep-links to Providers).
      openSettings: async (target?: unknown) => {
        calls.push({ cmd: 'open_settings', args: clone(target ?? {}) });
      },
      closeProviderConfig: async () => {},
      notifySettingsChanged: async () => {},
      onSettingsNavigate: () => () => {},
      showAgentMessageContextMenu: async (request) => {
        calls.push({ cmd: 'agent_message_context_menu', args: clone(request) });
        if (!messageContextMenuAction) return null;
        if (messageContextMenuAction === 'copy' && !request.canCopy) return null;
        if (messageContextMenuAction === 'retry' && !request.canRetry) return null;
        if (messageContextMenuAction === 'regenerate' && !request.canRegenerate) return null;
        if (messageContextMenuAction === 'details' && !request.canShowDetails) return null;
        return messageContextMenuAction;
      },
      agentMarkConversationRead: async () => {},
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
      stageAttachment: async (input) => {
        const safeName = (input.name || 'attachment').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'attachment';
        return {
          path: `/mock/local-root/tmp/agent-attachments/${++sequence}-${safeName}`,
          name: input.name || 'attachment',
          mimeType: input.mimeType || 'application/octet-stream',
          sizeBytes: input.bytes.byteLength,
        };
      },
      invoke: async <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ cmd, args: clone(args) });
        if (cmd === 'agent_restore_latest_conversation') {
          return clone(restoreAgentConversation(ASSISTANT_DM_ID)) as T;
        }
        if (cmd === 'agent_restore_conversation') {
          return clone(restoreAgentConversation(String(args.conversationId ?? ASSISTANT_DM_ID))) as T;
        }
        if (cmd === 'agent_create_conversation') {
          const agentIds = Array.isArray(args.agentIds) ? args.agentIds.map(String) : [];
          const title = String(args.title ?? args.goal ?? '').trim();
          if (!title) throw new Error('A Channel requires a name.');
          const conversationId = `mock-agent-channel-created-${++sequence}`;
          const members = [
            { type: 'user', userId: 'local-user' },
            ...Array.from(new Set([MAIN_AGENT_ID, ...agentIds])).map((agentId) => ({ type: 'agent', agentId })),
          ];
          agentConversations.push({
            id: conversationId,
            title,
            members,
            goal: title,
            createdAt: now,
            updatedAt: now += 1,
            messageCount: (typeof args.systemNotice === 'string' ? 1 : 0) + (typeof args.seedText === 'string' ? 1 : 0),
            lastMessageSnippet: typeof args.seedText === 'string'
              ? args.seedText
              : typeof args.systemNotice === 'string'
                ? args.systemNotice
                : null,
            lastMessageAt: now,
            unreadCount: 0,
          });
          return clone({
            conversationId,
            renderProjection: agentProjection(conversationId, {
              title,
              agentIds: Array.from(new Set(agentIds)),
              systemNotice: typeof args.systemNotice === 'string' ? args.systemNotice : undefined,
              seedText: typeof args.seedText === 'string' ? args.seedText : undefined,
            }),
          }) as T;
        }
        if (cmd === 'agent_get_provider_settings') return clone(agentSettings) as T;
        if (cmd === 'agent_list_conversations') return clone(agentConversations) as T;
        if (cmd === 'agent_rename_conversation') {
          const target = agentConversations.find((conversation) => conversation.id === args.conversationId);
          if (target) {
            target.title = String(args.title ?? '');
            target.updatedAt = now += 1;
          }
          return clone({ ok: true }) as T;
        }
        if (cmd === 'agent_delete_conversation') {
          const index = agentConversations.findIndex((conversation) => conversation.id === args.conversationId);
          if (index >= 0) agentConversations.splice(index, 1);
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
              auth: { authKind: 'api-key', credentialed: true, hasStoredKey: true },
            });
          }
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_update_runtime_settings') {
          const settings = args.settings as {
            safetyMode?: string;
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
            safetyMode: ['ask_first', 'balanced', 'full_access'].includes(settings.safetyMode ?? '')
              ? settings.safetyMode
              : agentSettings.agent.safetyMode,
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
        if (cmd === 'agent_list_all_skills') {
          return clone(agentSkills) as T;
        }
        if (cmd === 'agent_accept_skill') {
          const skillName = String(args.skillName ?? '');
          const expectedHash = String(args.expectedHash ?? '');
          const skill = agentSkills.find((item) => item.name === skillName);
          if (skill && skill.contentHash === expectedHash) {
            skill.ratified = true;
            skill.accepted = true;
          }
          return clone(agentSkills) as T;
        }
        if (cmd === 'agent_revoke_skill_acceptance') {
          const skillName = String(args.skillName ?? '');
          const skill = agentSkills.find((item) => item.name === skillName);
          if (skill) {
            skill.ratified = false;
            skill.accepted = false;
          }
          return clone(agentSkills) as T;
        }
        if (cmd === 'agent_list_all_definitions') {
          return clone(agentDefinitions) as T;
        }
        if (cmd === 'agent_list_memory') {
          const includeInvalidated = args.includeInvalidated === true;
          const limit = typeof args.limit === 'number' ? args.limit : agentMemoryEntries.length;
          return clone(agentMemoryEntries
            .filter((entry) => includeInvalidated || entry.status === 'active')
            .slice(0, limit)) as T;
        }
        if (cmd === 'agent_update_memory') {
          const memoryId = String(args.memoryId ?? '');
          const fact = String(args.fact ?? '').trim();
          const entry = agentMemoryEntries.find((item) => item.id === memoryId && item.status === 'active');
          if (!entry) return clone(null) as T;
          entry.fact = fact;
          return clone(entry) as T;
        }
        if (cmd === 'agent_forget_memory') {
          const memoryId = String(args.memoryId ?? '');
          const entry = agentMemoryEntries.find((item) => item.id === memoryId);
          if (!entry) return clone(null) as T;
          entry.status = 'invalidated';
          return clone(entry) as T;
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
          const keyAuth = { authKind: 'api-key', credentialed: true, hasStoredKey: true };
          if (existing) {
            existing.hasApiKey = true;
            existing.auth = keyAuth;
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
              auth: keyAuth,
            });
          }
          return clone({ providerId, hasApiKey: true }) as T;
        }
        if (cmd === 'agent_delete_provider_api_key') {
          const providerId = String(args.providerId);
          const existing = agentSettings.providers.find((item) => item.providerId === providerId);
          if (existing) { existing.hasApiKey = false; existing.auth = { authKind: 'api-key', credentialed: false, hasStoredKey: false }; }
          return clone({ providerId, hasApiKey: false }) as T;
        }
        if (cmd === 'agent_delete_provider_config') {
          const providerId = String(args.providerId);
          const index = agentSettings.providers.findIndex((item) => item.providerId === providerId);
          if (index >= 0) agentSettings.providers.splice(index, 1);
          if (agentSettings.activeProviderId === providerId) agentSettings.activeProviderId = '';
          return clone(agentSettings) as T;
        }
        if (cmd === 'open_external_url') {
          // The OAuth form opens loopback / verification URLs through this; the
          // spec asserts the call rather than launching a real browser.
          return clone({ opened: true }) as T;
        }
        if (cmd === 'agent_oauth_login') {
          // Resolve only when the spec calls resolveOAuthLogin (or rejects on
          // cancel) — the renderer subscribes to oauth events while it awaits.
          const providerId = String(args.providerId);
          return new Promise<T>((resolve, reject) => {
            oauthPending.set(providerId, { resolve: (value) => resolve(value as T), reject });
          });
        }
        if (cmd === 'agent_oauth_logout') {
          const providerId = String(args.providerId);
          const existing = (agentSettings.providers as unknown as MockAuthProvider[]).find((item) => item.providerId === providerId);
          if (existing) { existing.auth = { authKind: 'oauth', credentialed: false, oauth: { connected: false } }; existing.enabled = false; }
          if (agentSettings.activeProviderId === providerId) agentSettings.activeProviderId = '';
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_oauth_respond') {
          // The renderer's answer to a prompt/select/manual-code step. Recorded
          // (above) for assertions; the spec drives the next event itself.
          return undefined as T;
        }
        if (cmd === 'agent_oauth_cancel') {
          const providerId = String(args.providerId);
          const pending = oauthPending.get(providerId);
          if (pending) { oauthPending.delete(providerId); pending.reject(new Error('cancelled')); }
          return undefined as T;
        }
        if (cmd === 'agent_debug_snapshot') {
          return clone(String(args.conversationId) === 'mock-agent-conversation' ? debugSnapshot : null) as T;
        }
        if (cmd === 'agent_debug_history') {
          return clone(String(args.conversationId) === 'mock-agent-conversation' ? [debugSnapshot] : []) as T;
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
        if (cmd === 'agent_child_run_transcript') {
          return clone(String(args.runId) === 'child-run-1' ? { messages: childRunTranscriptMessages } : null) as T;
        }
        if (cmd === 'agent_child_run_status') {
          return clone({
            status: 'running',
            agent_id: String(args.agentId),
            description: 'Inspect child run UI',
            prompt: 'Inspect the current UI.',
            agent_type: 'explorer',
            context_mode: 'fork',
            started_at: now - 500,
            updated_at: now,
            transcript_message_count: 4,
          }) as T;
        }
        if (cmd === 'agent_child_run_send') {
          return clone({
            status: 'queued',
            agent_id: String(args.agentId),
            description: 'Inspect child run UI',
            prompt: 'Inspect the current UI.',
            agent_type: 'explorer',
            context_mode: 'fork',
            started_at: now - 500,
            updated_at: now,
            transcript_message_count: 4,
            instructions: 'Message queued for the running background agent.',
          }) as T;
        }
        if (cmd === 'agent_child_run_stop') {
          return clone({
            status: 'stopped',
            agent_id: String(args.agentId),
            description: 'Inspect child run UI',
            prompt: 'Inspect the current UI.',
            agent_type: 'explorer',
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
        if (cmd === 'agent_steer_conversation') return clone({ queued: true }) as T;
        if (cmd.startsWith('agent_')) return clone(undefined) as T;
        if (cmd === 'init_workspace' || cmd === 'get_projection') return clone(projectionSnapshot());
        if (cmd === 'ingest_asset') {
          const data = args.data as { byteLength?: number } | undefined;
          return clone(createAsset({
            mimeType: typeof args.mimeType === 'string' ? args.mimeType : undefined,
            originalFilename: typeof args.originalFilename === 'string' ? args.originalFilename : undefined,
            byteSize: typeof data?.byteLength === 'number' ? data.byteLength : undefined,
          })) as T;
        }
        if (cmd === 'lookup_asset') return clone(assets.get(String(args.id)) ?? null) as T;
        if (cmd === 'delete_asset') {
          assets.delete(String(args.id));
          return clone(undefined) as T;
        }
        if (cmd === 'pick_image_files') {
          return clone([createAsset({ mimeType: 'image/png', originalFilename: 'picked-image.png', byteSize: 24 })]) as T;
        }
        if (cmd === 'pick_attachment_files') {
          return clone([createAsset({ mimeType: 'application/pdf', originalFilename: 'picked-report.pdf', byteSize: 256 })]) as T;
        }
        if (cmd === 'open_asset') return clone({ opened: assets.has(String(args.id)) }) as T;
        if (cmd === 'reveal_asset') return clone({ revealed: assets.has(String(args.id)) }) as T;
        if (cmd === 'copy_asset_file') return clone({ copied: assets.has(String(args.id)) }) as T;
        if (cmd === 'preview_resolve_source') {
          const target = args.target as {
            kind?: string;
            assetId?: string;
            conversationId?: string;
            entryKind?: 'file' | 'directory';
            label?: string;
            path?: string;
            payloadId?: string;
            runId?: string;
            url?: string;
          } | undefined;
          if (target?.kind === 'asset' && target.assetId) {
            const asset = assets.get(target.assetId);
            return clone({
              source: asset ? {
                kind: 'file',
                sourceKind: 'asset',
                id: `asset:${target.assetId}`,
                target,
                name: target.label || asset.originalFilename || target.assetId,
                ext: (asset.originalFilename || '').split('.').pop() || '',
                mimeType: asset.mimeType,
                entryKind: 'file',
                sizeBytes: asset.byteSize,
                streamUrl: `asset://${target.assetId}`,
              } : null,
            }) as T;
          }
          if (target?.kind === 'local-file' && target.path) {
            const name = target.label || target.path.split('/').filter(Boolean).at(-1) || target.path;
            return clone({
              source: {
                kind: 'file',
                sourceKind: 'local-file',
                id: `local-file:${target.entryKind ?? 'file'}:${target.path}`,
                target,
                name,
                ext: name.split('.').pop() || '',
                mimeType: target.entryKind === 'directory' ? 'inode/directory' : 'text/markdown',
                entryKind: target.entryKind ?? 'file',
                sizeBytes: target.entryKind === 'directory' ? 0 : 128,
                displayPath: target.path,
              },
            }) as T;
          }
          if (target?.kind === 'agent-payload' && target.payloadId) {
            if (target.payloadId === 'payload-full-output' && target.runId !== 'run-payload-output') {
              return clone({ source: null, error: 'missing' }) as T;
            }
            return clone({
              source: {
                kind: 'file',
                sourceKind: 'agent-payload',
                id: `agent-payload:${target.conversationId ?? ''}:${target.runId ?? ''}:${target.payloadId}`,
                target,
                name: target.label || `${target.payloadId}.txt`,
                ext: 'txt',
                mimeType: 'text/plain',
                entryKind: 'file',
                sizeBytes: 39,
              },
            }) as T;
          }
          return clone({ source: null, error: 'missing' }) as T;
        }
        if (cmd === 'preview_read_text') {
          const target = args.target as { kind?: string; path?: string; payloadId?: string; runId?: string } | undefined;
          if (target?.kind === 'agent-payload') {
            if (target.payloadId === 'payload-full-output' && target.runId !== 'run-payload-output') {
              return clone({ text: null, error: 'missing' }) as T;
            }
            return clone({ text: 'Full persisted tool output from payload' }) as T;
          }
          if (target?.kind === 'local-file') return clone({ text: `# ${target.path?.split('/').pop() ?? 'file'}\n\nMock preview text.` }) as T;
          return clone({ text: 'Mock asset preview text.' }) as T;
        }
        if (cmd === 'preview_read_bytes') return clone({ bytes: new ArrayBuffer(0), mimeType: 'application/octet-stream' }) as T;
        if (cmd === 'preview_list_directory') {
          const target = args.target as { kind?: string; path?: string } | undefined;
          const base = target?.path ?? '/mock/local-root/tmp/agent-attachments';
          return clone({
            entries: [{
              entryKind: 'file',
              name: 'nested.md',
              target: { kind: 'local-file', path: `${base}/nested.md`, entryKind: 'file', label: 'nested.md' },
              mimeType: 'text/markdown',
              sizeBytes: 42,
            }],
          }) as T;
        }
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
        if (cmd === 'create_image_node') {
          const parentId = String(args.parentId);
          const nodeId = createNode(parentId, args.index as number | null, '', {
            type: 'image',
            showCheckbox: false,
            assetId: typeof args.assetId === 'string' ? args.assetId : undefined,
            mediaUrl: typeof args.mediaUrl === 'string' ? args.mediaUrl : undefined,
            imageWidth: typeof args.width === 'number' ? args.width : undefined,
            imageHeight: typeof args.height === 'number' ? args.height : undefined,
            mediaAlt: typeof args.alt === 'string' ? args.alt : undefined,
          });
          return clone(outcome({ nodeId, parentId, placement: { kind: 'end' }, selectAll: false }));
        }
        if (cmd === 'create_attachment_node') {
          const parentId = String(args.parentId);
          const nodeId = createNode(parentId, args.index as number | null, '', {
            type: 'attachment',
            showCheckbox: false,
            assetId: String(args.assetId ?? ''),
            mimeType: String(args.mimeType ?? 'application/octet-stream'),
            originalFilename: String(args.originalFilename ?? 'attachment'),
            fileSize: typeof args.fileSize === 'number' ? args.fileSize : 0,
            thumbnailAssetId: typeof args.thumbnailAssetId === 'string' ? args.thumbnailAssetId : undefined,
            pdfPageCount: typeof args.pdfPageCount === 'number' ? args.pdfPageCount : undefined,
            audioDurationMs: typeof args.audioDurationMs === 'number' ? args.audioDurationMs : undefined,
            videoDurationMs: typeof args.videoDurationMs === 'number' ? args.videoDurationMs : undefined,
          });
          return clone(outcome({ nodeId, parentId, placement: { kind: 'end' }, selectAll: false }));
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
          // Mirror core: the merged first row adopts the pasted checkbox state
          // only when the renderer forwarded it (it suppresses checkbox/done for a
          // non-empty target row so an existing line isn't silently checked).
          const firstMeta = (args.firstMeta ?? {}) as { checkbox?: boolean; done?: boolean };
          if (firstMeta.checkbox) node.completedAt = firstMeta.done ? ++now : 0;
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
        if (cmd === 'move_node') {
          moveNode(String(args.nodeId), String(args.parentId), typeof args.index === 'number' ? args.index : null);
          return clone(outcome({ nodeId: String(args.nodeId), parentId: String(args.parentId), selectAll: false }));
        }
        if (cmd === 'batch_move_nodes') {
          for (const move of args.moves as Array<{ nodeId?: unknown; parentId?: unknown; index?: unknown }>) {
            moveNode(String(move.nodeId), String(move.parentId), typeof move.index === 'number' ? move.index : null);
          }
          return clone(outcome());
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
              inlineRefs: [nodeInlineRef(0, target.id, target.content.text || undefined)],
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
              inlineRefs: [nodeInlineRef(0, target.id, target.content.text || undefined)],
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
              inlineRefs: [nodeInlineRef(0, target.id, target.content.text || undefined)],
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
              inlineRefs: [nodeInlineRef(0, target.id, target.content.text || undefined)],
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
        if (cmd === 'set_node_image') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            node.type = 'image';
            node.assetId = typeof args.assetId === 'string' ? args.assetId : undefined;
            node.mediaUrl = typeof args.mediaUrl === 'string' ? args.mediaUrl : undefined;
            node.imageWidth = typeof args.width === 'number' ? args.width : undefined;
            node.imageHeight = typeof args.height === 'number' ? args.height : undefined;
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
        if (cmd === 'set_command_node') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            node.type = 'command';
            // Seed the two node-native config rows (Schedule / Agent) if absent —
            // find-or-create, mirroring `ensureCommandFieldEntriesDirect`.
            const seedField = (defId: string, index: number) => {
              const exists = node.children.some((childId) => {
                const child = nodes.get(childId);
                return child?.type === 'fieldEntry' && child.fieldDefId === defId;
              });
              if (exists) return;
              const entryId = `field-entry-${++sequence}`;
              makeNode(entryId, '', { type: 'fieldEntry', parentId: node.id, fieldDefId: defId });
              appendChild(node.id, entryId, index);
            };
            seedField('sys:commandSchedule', 0);
            seedField('sys:commandAgent', 1);
          }
          return clone(outcome({ nodeId: String(args.nodeId), selectAll: false }));
        }
        if (cmd === 'set_command_schedule') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            const schedule = args.schedule == null ? '' : String(args.schedule);
            if (schedule) node.commandSchedule = schedule; else delete node.commandSchedule;
          }
          return clone(outcome({ nodeId: String(args.nodeId), selectAll: false }));
        }
        if (cmd === 'set_command_agent') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            const agent = args.agent == null ? '' : String(args.agent);
            if (agent) node.commandAgent = agent; else delete node.commandAgent;
          }
          return clone(outcome({ nodeId: String(args.nodeId), selectAll: false }));
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
      onAgentOAuthEvent: (listener: (envelope: unknown) => void) => {
        oauthListeners.push(listener);
        return () => {
          const index = oauthListeners.indexOf(listener);
          if (index >= 0) oauthListeners.splice(index, 1);
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

// Push one main->renderer OAuth login event (device-code / auth / progress /
// prompt / select / manual-code) to the subscribed sign-in form.
export async function emitOAuthEvent(page: Page, providerId: string, event: unknown) {
  await page.evaluate(({ providerId, event }) => {
    const win = window as E2EWindow;
    win.__LIN_E2E__?.emitOAuthEvent({ providerId, event });
  }, { providerId, event });
}

// Complete the in-flight sign-in: mark the provider connected and resolve the
// login promise so the form re-renders into its connected state.
export async function resolveOAuthLogin(page: Page, providerId: string) {
  await page.evaluate((providerId) => {
    const win = window as E2EWindow;
    win.__LIN_E2E__?.resolveOAuthLogin(providerId);
  }, providerId);
}

export async function setAgentMessageContextMenuAction(
  page: Page,
  action: 'copy' | 'retry' | 'regenerate' | 'details' | null,
) {
  await page.evaluate((action) => {
    const win = window as E2EWindow;
    win.__LIN_E2E__?.setAgentMessageContextMenuAction(action);
  }, action);
}

export async function emitAgentProjection(page: Page, conversationId: string, state: Record<string, any>, revision = 1) {
  const entities: Record<string, any> = {};
  const compactions: Record<string, any> = {};
  const rows: Array<{ id: string; kind: string; messageId?: string; compactionId?: string; childRunId?: string }> = [];

  const persistedContent = (message: any) => {
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content ?? [];
    return content.map((part: any, index: number) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'thinking') return { type: 'thinking', thinking: part.thinking, redacted: part.redacted };
      if (part.type === 'toolCall') return { type: 'toolCall', id: part.id, name: part.name, arguments: part.arguments ?? {} };
      if (part.type === 'payload_ref') return part;
      if (part.type === 'image') {
        const mimeType = part.mimeType ?? 'image/png';
        return {
          type: 'image',
          alt: part.alt ?? 'Image attachment',
          imageRef: {
            kind: 'payload_ref',
            id: `mock-image-${index}`,
            storage: 'file',
            mimeType,
            byteLength: 0,
            sha256: `mock-image-${index}`,
            role: 'source',
            summary: part.alt ?? 'Image attachment',
          },
        };
      }
      return { type: 'text', text: JSON.stringify(part) };
    });
  };
  const rawChildRuns = state.childRuns ?? {};
  const childRuns = Array.isArray(rawChildRuns)
    ? Object.fromEntries(rawChildRuns.map((childRun: any) => [childRun.id, childRun]))
    : rawChildRuns;
  const childRunIds = state.childRunIds
    ?? (Array.isArray(rawChildRuns) ? rawChildRuns.map((childRun: any) => childRun.id) : Object.keys(childRuns));
  const childRunTasks = Object.values(childRuns).map((childRun: any) => ({
    id: `child-run:${childRun.id}`,
    kind: 'child-run',
    status: childRun.status,
    title: (childRun.description ?? '').trim() || (childRun.name ?? '').trim() || childRun.id,
    subtitle: `${childRun.contextMode} · ${childRun.agentType}`,
    startedAt: childRun.startedAt,
    updatedAt: childRun.updatedAt,
    completedAt: childRun.completedAt,
    childRunId: childRun.id,
  }));
  const tasks = {
    ...Object.fromEntries(childRunTasks.map((task: any) => [task.id, task])),
    ...(state.tasks ?? {}),
  };
  const taskIds = state.taskIds ?? Object.keys(tasks);

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
        createdAt: compaction.createdAt,
        id: compaction.id,
        messageId,
        source: compaction.source ?? { fromMessageId: messageId, throughMessageId: messageId },
        summary: compaction.summary,
        trigger: compaction.trigger ?? 'manual',
      };
      continue;
    }

    const message = entry.message;
    const messageId = entry.nodeId;
    const actor = entry.actor ?? (message.role === 'user'
      ? { type: 'user', userId: 'local-user' }
      : { type: 'agent', agentId: 'built-in:core:assistant' });
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
      actor,
      addressedTo: entry.addressedTo ?? message.addressedTo,
      addressedByMessageId: entry.addressedByMessageId ?? message.addressedByMessageId,
      apiId: message.api,
      providerId: message.provider,
      modelId: message.model,
      runId: entry.runId ?? message.runId,
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
      actor: streamingMessage.actor ?? { type: 'agent', agentId: 'built-in:core:assistant' },
      addressedByMessageId: streamingMessage.addressedByMessageId ?? null,
      apiId: streamingMessage.api,
      providerId: streamingMessage.provider,
      modelId: streamingMessage.model,
      runId: streamingMessage.runId ?? 'run-e2e',
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
      actor: message.actor ?? { type: 'tool', toolName: message.toolName, toolCallId: message.toolCallId },
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    };
  }

  // Mirror the core projection's insertChildRunRows: the full transcript carries
  // an inline boundary row per child run (the active `rows` stays clean). A
  // parented run anchors after its tool_result row, else after the assistant
  // message that issued the call; a parentless run is ordered by start time.
  const messageHasToolCall = (entity: any, toolCallId: string) =>
    !!entity?.content?.some((block: any) => block.type === 'toolCall' && block.id === toolCallId);
  const childRunInsertIndex = (currentRows: typeof rows, run: any) => {
    if (run.parentToolCallId) {
      const resultIndex = currentRows.findIndex(
        (row) => row.kind === 'tool_result' && entities[row.messageId ?? '']?.toolCallId === run.parentToolCallId,
      );
      if (resultIndex >= 0) return resultIndex + 1;
      const callIndex = currentRows.findIndex(
        (row) => row.kind === 'message' && messageHasToolCall(entities[row.messageId ?? ''], run.parentToolCallId),
      );
      return callIndex >= 0 ? callIndex + 1 : -1;
    }
    let index = -1;
    for (let position = 0; position < currentRows.length; position += 1) {
      const messageId = currentRows[position]!.messageId;
      const message = messageId ? entities[messageId] : undefined;
      if (message && message.createdAt <= run.startedAt) index = position;
    }
    return index < 0 ? -1 : index + 1;
  };
  const childRunRows = [...rows];
  const orderedRuns = Object.values(childRuns).sort(
    (left: any, right: any) => left.startedAt - right.startedAt || String(left.id).localeCompare(String(right.id)),
  );
  for (const run of orderedRuns as any[]) {
    const row = { id: `child-run:${run.id}`, kind: 'child-run', childRunId: run.id };
    const insertAt = childRunInsertIndex(childRunRows, run);
    if (insertAt < 0) childRunRows.push(row);
    else childRunRows.splice(insertAt, 0, row);
  }

  await emitAgentEvent(page, {
    type: 'projection',
    conversationId,
    lastEventType: null,
    revision,
    renderProjection: {
      conversationId,
      revision,
      conversationTitle: state.conversationTitle ?? null,
      members: state.members ?? [
        { principal: { type: 'user', userId: 'local-user' }, mention: '', displayName: 'You' },
        {
          principal: { type: 'agent', agentId: 'built-in:core:assistant' },
          mention: 'assistant',
          displayName: 'Agent System',
          coordinator: true,
        },
      ],
      activeRunId: state.activeRunId ?? (state.isStreaming ? 'run-e2e' : null),
      activityEntries: state.activityEntries ?? [],
      povInspectors: state.povInspectors ?? {},
      activeCompaction: state.activeCompaction ?? null,
      isStreaming: !!state.isStreaming,
      model: state.model ?? {},
      thinkingLevel: state.thinkingLevel ?? 'off',
      pendingToolCallIds: state.pendingToolCallIds ?? [],
      errorMessage: state.errorMessage ?? null,
      rows,
      transcriptRows: state.transcriptRows ?? childRunRows,
      taskIds,
      childRunIds,
      entities: { messages: entities, childRuns, compactions, tasks },
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
  content: { text: string; inlineRefs: E2EInlineRef[] };
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
      content: { text: string; inlineRefs: E2EInlineRef[] };
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
