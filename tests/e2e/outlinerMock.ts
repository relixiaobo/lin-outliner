import { expect, type Page } from '@playwright/test';
import type { TranslationLanguage } from '../../src/core/translationLanguage';
import type { UrlPageTranslationPreferences } from '../../src/core/urlPageTranslation';

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
  relatedField?: boolean;
  /** Appends deterministic content rows under Today for table-windowing specs. */
  tableRowCount?: number;
  /** Adds an OAuth sign-in provider (GitHub Copilot) to the catalog for the OAuth specs. */
  oauthProvider?: boolean;
  /** Preloads user blocklist rules for settings/security specs. */
  capabilityBlocks?: string[];
  /** Delays initial workspace restoration so startup chrome can be asserted before data arrives. */
  initWorkspaceDelayMs?: number;
  /** Delays provider settings so Settings chrome can be asserted before settings data arrives. */
  providerSettingsDelayMs?: number;
  /** Seeds the shared preview-translation target language. */
  translationLanguage?: TranslationLanguage;
  /** Seeds URL/EPUB automatic translation and model preferences. */
  translationPreferences?: UrlPageTranslationPreferences;
  /** Keeps translated blocks pending long enough for loader assertions. */
  translationDelayMs?: number;
  /** Completes mock Agent Turns as failed without an assistant message. */
  agentTurnFailure?: boolean | string;
  /** Starts with the configured language-model provider disabled and uncredentialed. */
  agentProviderUsable?: boolean;
}

type E2EWindow = Window & {
  __LIN_E2E__?: {
    calls: Array<{ cmd: string; args: Record<string, unknown> }>;
    projection: () => unknown;
    clipboardText: () => string;
    emitAgentCoreNotification: (notification: unknown) => void;
    emitDocumentEvent: (event: unknown) => void;
    emitOAuthEvent: (envelope: unknown) => void;
    resolveOAuthLogin: (providerId: string) => void;
    setTranslationDelayMs: (delayMs: number) => void;
    setTranslationLanguage: (language: TranslationLanguage) => void;
    setTranslationPreferences: (preferences: UrlPageTranslationPreferences) => void;
  };
  lin?: {
    initialTranslationLanguage?: TranslationLanguage;
    initialUrlPageTranslationPreferences?: UrlPageTranslationPreferences;
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T>;
    getProviderApiKey: (providerId: string) => Promise<{ providerId: string; apiKey?: string }>;
    onAgentCoreNotification: (listener: (notification: unknown) => void) => () => void;
    onDocumentEvent: (listener: (event: unknown) => void) => () => void;
    onAgentOAuthEvent?: (listener: (envelope: unknown) => void) => () => void;
    onTranslationLanguageChanged?: (listener: (language: TranslationLanguage) => void) => () => void;
    onUrlPageTranslationPreferencesChanged?: (listener: (preferences: UrlPageTranslationPreferences) => void) => () => void;
    onUrlPageTranslationShortcut?: (listener: (webContentsId: number) => void) => () => void;
    setTranslationLanguage?: (language: TranslationLanguage) => Promise<void>;
    setUrlPageTranslationPreferences?: (preferences: UrlPageTranslationPreferences) => Promise<UrlPageTranslationPreferences>;
    openProviderConfig?: (params: { providerId: string; mode: string }) => Promise<void>;
    openSettings?: (target?: unknown) => Promise<void>;
    closeProviderConfig?: () => Promise<void>;
    notifySettingsChanged?: () => Promise<void>;
    onSettingsChanged?: (listener: () => void) => () => void;
    onSettingsNavigate?: (listener: (target: unknown) => void) => () => void;
    openLocalFile?: (options: { path: string }) => Promise<{ opened: boolean }>;
    previewLocalFile?: (options: { id: string }) => Promise<{ thumbnailDataUrl: string | null }>;
    prepareLocalFile?: (options: { id: string }) => Promise<{
      file: {
        entryKind: 'file' | 'directory';
        path: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
        lastModified: number;
        imageDataBase64?: string;
      } | null;
    }>;
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
    const agentCoreListeners: Array<(notification: unknown) => void> = [];
    const documentListeners: Array<(event: unknown) => void> = [];
    const oauthListeners: Array<(envelope: unknown) => void> = [];
    const settingsChangedListeners: Array<() => void> = [];
    const translationLanguageListeners: Array<(language: TranslationLanguage) => void> = [];
    const translationPreferenceListeners: Array<(preferences: UrlPageTranslationPreferences) => void> = [];
    let translationLanguage = options.translationLanguage ?? 'en';
    let translationPreferences: UrlPageTranslationPreferences = options.translationPreferences ?? {
      translationModel: null,
      autoTranslateEpubs: false,
      autoTranslateUrls: false,
    };
    let translationDelayMs = options.translationDelayMs ?? 80;
    const providerApiKeys = new Map<string, string>(
      options.agentProviderUsable === false ? [] : [['openai', 'sk-openai-saved']],
    );
    // An in-flight sign-in's resolve/reject, keyed by providerId. The spec drives
    // the event stream (emitOAuthEvent) and completes it (resolveOAuthLogin), so
    // the flow is fully deterministic — no real provider, timers, or network.
    const oauthPending = new Map<string, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>();
    const agentSettings = {
      activeProviderId: 'openai',
      agent: {
        additionalSkillDirectories: [],
        disabledSkills: [] as string[],
        providerTimeoutMs: null,
        providerMaxRetries: null,
        providerMaxRetryDelayMs: 60_000,
        providerCacheRetention: 'short',
      },
      imageGeneration: {},
      providers: [{
        providerId: 'openai',
        baseUrl: '',
        enabled: options.agentProviderUsable !== false,
        hasApiKey: options.agentProviderUsable !== false,
        hasEnvApiKey: false,
        // Main now always populates the `auth` descriptor (the single
        // `credentialed` signal the renderer reads); the mock mirrors it.
        auth: {
          authKind: 'api-key',
          credentialed: options.agentProviderUsable !== false,
          hasStoredKey: options.agentProviderUsable !== false,
        },
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
        providerId: 'cc-switch',
        authKind: 'api-key',
        credentialed: true,
        detected: true,
        connectionStatus: 'ready',
        hasEnvApiKey: false,
        envKeyNames: [],
        defaultBaseUrl: 'https://registry.example.com/v1',
        models: [
          {
            id: 'cc-switch%3Acodex%3Aprovider-openai::gpt-5.4',
            name: 'Codex / OpenAI / GPT 5.4',
            reasoning: true,
            supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
            contextWindow: 256_000,
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
    const agentCapabilities = {
      blocks: [...(options.capabilityBlocks ?? [])] as string[],
      diagnostics: [] as Array<{ ruleValue: string; code: string; message: string }>,
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
      execution: 'inline',
      contentLength: 64,
      body: 'Review workspace conventions before automatic use.',
    }];
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const delay = (ms: number) => new Promise((resolve) => { window.setTimeout(resolve, ms); });
    type MockThreadItem = {
      id: string;
      type: 'userMessage' | 'agentMessage';
      provenance: { originThreadId: string; originTurnId: string; originItemId: string };
      clientId?: string | null;
      content?: Array<
        | { type: 'text'; text: string }
        | { type: 'nodeReference'; nodeId: string; note?: string }
        | {
            type: 'attachment';
            id: string;
            name: string;
            mimeType: string;
            sizeBytes: number;
            source: { kind: 'asset'; assetId: string } | { kind: 'localFile'; path: string } | { kind: 'inline'; dataBase64: string };
          }
      >;
      text?: string;
      phase?: 'commentary' | 'final_answer' | null;
      memoryCitation?: null;
    };
    type MockTurn = {
      id: string;
      items: MockThreadItem[];
      itemsView: 'full';
      provenance: { originThreadId: string; originTurnId: string; trigger: { kind: 'user' } };
      status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
      error: { message: string } | null;
      execution: {
        modelProvider: string;
        model: string;
        reasoningEffort: string;
        usage: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          totalTokens: number;
          cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
            currency: 'USD';
          } | null;
        };
      };
      startedAt: number;
      completedAt: number | null;
      durationMs: number | null;
    };
    type MockThread = {
      id: string;
      sessionId: string;
      parentThreadId: string | null;
      forkedFromId: string | null;
      agentNickname: string | null;
      agentRole: string | null;
      name: string | null;
      preview: string;
      ephemeral: boolean;
      source: string;
      threadSource: 'user';
      modelProvider: string;
      cwd: string;
      createdAt: number;
      updatedAt: number;
      status: { type: 'idle' } | { type: 'active'; activeFlags: [] };
      historyMode: 'paginated';
    };
    const mockThreads: MockThread[] = [];
    const mockTurns = new Map<string, MockTurn[]>();
    const mockGoals = new Map<string, unknown>();
    const mockThreadConfigurations = new Map<string, {
      modelProvider: string;
      model: string;
      reasoningEffort: string;
    }>();
    const nextCanonicalId = () => `01910000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
    const threadById = (threadId: string) => {
      const thread = mockThreads.find((candidate) => candidate.id === threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      return thread;
    };
    const emitAgentCoreNotification = (notification: unknown) => {
      for (const listener of agentCoreListeners) listener(clone(notification));
    };
    const createMockThread = (input: Record<string, unknown>, forkedFromId: string | null = null) => {
      const timestamp = ++now;
      const thread: MockThread = {
        id: typeof input.id === 'string' ? input.id : nextCanonicalId(),
        sessionId: nextCanonicalId(),
        parentThreadId: null,
        forkedFromId,
        agentNickname: null,
        agentRole: null,
        name: typeof input.name === 'string' ? input.name : null,
        preview: '',
        ephemeral: input.ephemeral === true,
        source: 'app',
        threadSource: 'user',
        modelProvider: typeof input.modelProvider === 'string' ? input.modelProvider : 'openai',
        cwd: typeof input.cwd === 'string' ? input.cwd : '/mock/workspace',
        createdAt: timestamp,
        updatedAt: timestamp,
        status: { type: 'idle' },
        historyMode: 'paginated',
      };
      mockThreads.push(thread);
      mockTurns.set(thread.id, []);
      mockThreadConfigurations.set(thread.id, {
        modelProvider: thread.modelProvider,
        model: `${thread.modelProvider}/gpt-5.4`,
        reasoningEffort: 'medium',
      });
      return thread;
    };
    const nextMockForkName = (source: MockThread) => {
      const displayed = source.name?.trim() || source.preview.trim() || 'Untitled Thread';
      const base = source.forkedFromId
        ? displayed.replace(/\s+\(([1-9]\d*)\)$/, '').trim() || displayed
        : displayed;
      let root = source;
      while (root.forkedFromId) root = threadById(root.forkedFromId);
      const familyIds = [root.id];
      for (let index = 0; index < familyIds.length; index += 1) {
        const parentId = familyIds[index]!;
        for (const candidate of mockThreads) {
          if (candidate.forkedFromId === parentId) familyIds.push(candidate.id);
        }
      }
      let highest = 0;
      for (const id of familyIds) {
        const candidate = threadById(id).name?.trim();
        if (!candidate || candidate === base) continue;
        if (!candidate.startsWith(`${base} (`) || !candidate.endsWith(')')) continue;
        const suffix = candidate.slice(base.length + 2, -1);
        const index = Number(suffix);
        if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(index)) highest = Math.max(highest, index);
      }
      return `${base} (${highest + 1})`;
    };
    const itemProvenance = (threadId: string, turnId: string, itemId: string) => ({
      originThreadId: threadId,
      originTurnId: turnId,
      originItemId: itemId,
    });
    const previewPdfBytes = () => {
      const base64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUiA3IDAgUl0gL0NvdW50IDMgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA5IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0OSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcyMCBUZCAoUHJldmlldyBQREYgUGFnZSAxKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA5IDAgUiA+PiA+PiAvQ29udGVudHMgNiAwIFIgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL0xlbmd0aCA0OSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcyMCBUZCAoUHJldmlldyBQREYgUGFnZSAyKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjcgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA5IDAgUiA+PiA+PiAvQ29udGVudHMgOCAwIFIgPj4KZW5kb2JqCjggMCBvYmoKPDwgL0xlbmd0aCA0OSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcyMCBUZCAoUHJldmlldyBQREYgUGFnZSAzKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjkgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgMTAKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyNyAwMDAwMCBuIAowMDAwMDAwMjUzIDAwMDAwIG4gCjAwMDAwMDAzNTIgMDAwMDAgbiAKMDAwMDAwMDQ3OCAwMDAwMCBuIAowMDAwMDAwNTc3IDAwMDAwIG4gCjAwMDAwMDA3MDMgMDAwMDAgbiAKMDAwMDAwMDgwMiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDEwIC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo4NzIKJSVFT0YK';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    };
    const previewEpubBytes = () => {
      const base64 = 'UEsDBBQAAAgAAAAA2VxvYassFAAAABQAAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi9lcHViK3ppcFBLAwQUAAAICAAAANlc8QeEKq8AAADzAAAAFgAAAE1FVEEtSU5GL2NvbnRhaW5lci54bWxdjrFuAyEQRPv7CrStdSbuLARYipS0thTnAwi35yDDLgIusv8+2MVFSjfFvDejD7cUxQ+WGpgM7LYvIJA8T4EuBj7P7+MeDnbQnqm5QFj+dTtN1cBSSLGroSpyCatqXnFGmtgvCampZ02tErCDELowtzlErHaNYl5iHLNr3waOb6+nD/lgumHLeQaRcApubPeMBlzOMXjX+hfJ+JVrx/zVXXDTx0BaLf/8g5brtv0FUEsDBBQAAAgIAAAA2VwM6K5Z0gAAADwBAAAPAAAAT0VCUFMvbmF2LnhodG1sbc7BboMwDAbgO08R+V4M3WEDOelh0o67bHuAFFISiSYRuNC+/RLQNE3axQf70++fTvfrKBYzzS54CXVZgTC+C73zg4Svz7fDC5xUQZYTS9TPEixzbBHXdS3XpzJMA9ZN0+A9G9hRa+Lt/Ee6Pl42e6yqZwxxBlUIQdboXhE7Ho1614sbNKcihPuGcLtneA79Q5HXi8jRLT+ikcChA0VhVDQ6RVrYyVwkdFZHNtOhLvdK6oP1xIQ65WX3nz3+2Nfg2fmb+eWY8zF9TnNrUaRayapvUEsDBBQAAAgIAAAA2Vxj7Fd5wQAAABYHAAAVAAAAT0VCUFMvY2hhcHRlci0xLnhodG1s7ZUxbsMwDAB3v4LQXqlGl7qgGSBAMgeo84A0ZiMBiWRIROT+vrKTPR8QwIXHG7gdbubbFe4ckwu+V61+V8D+HEbnL706Dvu3T7WhBq0Urag+9cqKTF/G5Jx1/tAhXkzbdZ2ZF0dRA4CWTyOhOLkyfcspCprHgmY9Lc5PGP8IbUsD++Bhdzhu4RD57jgXqyWcaLAuQRmxDL8uJnlYic9SvtVopsXar5cnBOFZNFRWWWWVVVbZK7ZmxKw5akp5SsToH1BLAwQUAAAICAAAANlcciAJEM0AAAB5BwAAFQAAAE9FQlBTL2NoYXB0ZXItMi54aHRtbO2VsU7EMAyG9z6FlZ2E6haKXJ8EOmYk7h4AEusSqZdUiaHl7UnLxAswZbL8+bPl7cfjepvgi3MJKY6q1/cKONrkQryO6nJ+uXtQR+rQS9WqGsuovMj8aMyyLHo56JSvph+Gwaybo6gDQM/vjlCCTEzPKUqIn4zmt0ezTzftI7lvQt/TG9sUHRS2Ut+oRk8409kzFJvTNEGuK5y3Yj07kDqJvAqcXi9PUOYQGYLwTaOZt82/90CqqqHBBhtssMEG/xnusWT2uOtqutWcpB9QSwMEFAAACAgAAADZXHzCK3ZPAQAA4AIAABEAAABPRUJQUy9jb250ZW50Lm9wZpWSTW6DMBCF9zmF5W0FDnTRCgGRKrXrLJIDOHiAUcB2jR3S29f8JCSpKrU7j2be92aenG7ObUNOYDpUMqNRuKYEZKEEyiqj+91H8Eo3+SrVvDjyCoifll1Ga2t1wljf9yEKXYbKVCxer1+Y0iVdcM8Dzkn8dBCgAGmxRDAZPSh1REHzFSFpC5YLbvmETkRxpWtnmpEsCgYNtF7fsSiM2Cj0UlEkC5WgWMDOyMQ5FIkFqWQA2h0CbeCE0AcWOpuyO+3Cs2gbyHeDirxv929kO6lGwdS8zjZcVs6HkoMc29d6OItd7pqO5BJL7zuL0UI77iv5iZLaQDk+w3Nt24aSFgTywH5pyCjXusGCW58nG9tP52FEG6XBWIRugrBHclFzbcFEF/xcB9HfTX5jxo/M+J9MH85NHmmnUcKNl2d7u1uH6G6Xn/34wp1RKZv/a/4NUEsBAhQAFAAACAAAAADZXG9hqywUAAAAFAAAAAgAAAAAAAAAAAAAAAAAAAAAAG1pbWV0eXBlUEsBAhQAFAAACAgAAADZXPEHhCqvAAAA8wAAABYAAAAAAAAAAAAAAAAAOgAAAE1FVEEtSU5GL2NvbnRhaW5lci54bWxQSwECFAAUAAAICAAAANlcDOiuWdIAAAA8AQAADwAAAAAAAAAAAAAAAAAdAQAAT0VCUFMvbmF2LnhodG1sUEsBAhQAFAAACAgAAADZXGPsV3nBAAAAFgcAABUAAAAAAAAAAAAAAAAAHAIAAE9FQlBTL2NoYXB0ZXItMS54aHRtbFBLAQIUABQAAAgIAAAA2VxyIAkQzQAAAHkHAAAVAAAAAAAAAAAAAAAAABADAABPRUJQUy9jaGFwdGVyLTIueGh0bWxQSwECFAAUAAAICAAAANlcfMIrdk8BAADgAgAAEQAAAAAAAAAAAAAAAAAQBAAAT0VCUFMvY29udGVudC5vcGZQSwUGAAAAAAYABgB8AQAAjgUAAAAA';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    };
    // A 12-section EPUB (each section a fixed 900px-tall block) used to exercise the
    // reader's lazy section mounting: the later sections sit far below the viewport, so
    // their iframes stay unmounted until scrolled into view.
    const previewLongEpubBytes = () => {
      const base64 = 'UEsDBBQAAAAAAAAAAABvYassFAAAABQAAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi9lcHViK3ppcFBLAwQUAAAAAAAAAAAAHkBH+PQAAAD0AAAAFgAAAE1FVEEtSU5GL2NvbnRhaW5lci54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCI/Pgo8Y29udGFpbmVyIHZlcnNpb249IjEuMCIgeG1sbnM9InVybjpvYXNpczpuYW1lczp0YzpvcGVuZG9jdW1lbnQ6eG1sbnM6Y29udGFpbmVyIj4KICA8cm9vdGZpbGVzPjxyb290ZmlsZSBmdWxsLXBhdGg9Ik9FQlBTL2NvbnRlbnQub3BmIiBtZWRpYS10eXBlPSJhcHBsaWNhdGlvbi9vZWJwcy1wYWNrYWdlK3htbCIvPjwvcm9vdGZpbGVzPgo8L2NvbnRhaW5lcj4KUEsDBBQAAAAAAAAAAAApYNaLKAMAACgDAAAPAAAAT0VCUFMvbmF2LnhodG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPGh0bWwgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWwiIHhtbG5zOmVwdWI9Imh0dHA6Ly93d3cuaWRwZi5vcmcvMjAwNy9vcHMiPgogIDxoZWFkPjx0aXRsZT5OYXZpZ2F0aW9uPC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+PG5hdiBlcHViOnR5cGU9InRvYyI+PG9sPjxsaT48YSBocmVmPSJjaGFwdGVyLTEueGh0bWwiPkNoYXB0ZXIgMTwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTIueGh0bWwiPkNoYXB0ZXIgMjwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTMueGh0bWwiPkNoYXB0ZXIgMzwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTQueGh0bWwiPkNoYXB0ZXIgNDwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTUueGh0bWwiPkNoYXB0ZXIgNTwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTYueGh0bWwiPkNoYXB0ZXIgNjwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTcueGh0bWwiPkNoYXB0ZXIgNzwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTgueGh0bWwiPkNoYXB0ZXIgODwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTkueGh0bWwiPkNoYXB0ZXIgOTwvYT48L2xpPjxsaT48YSBocmVmPSJjaGFwdGVyLTEwLnhodG1sIj5DaGFwdGVyIDEwPC9hPjwvbGk+PGxpPjxhIGhyZWY9ImNoYXB0ZXItMTEueGh0bWwiPkNoYXB0ZXIgMTE8L2E+PC9saT48bGk+PGEgaHJlZj0iY2hhcHRlci0xMi54aHRtbCI+Q2hhcHRlciAxMjwvYT48L2xpPjwvb2w+PC9uYXY+PC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAAY8u9M+QAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItMS54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciAxPC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciAxPC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciAxIGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAAhpOD+OQAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItMi54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciAyPC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciAyPC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciAyIGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAAJaRpvuQAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItMy54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciAzPC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciAzPC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciAzIGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAADSSOteQAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItNC54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciA0PC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciA0PC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciA0IGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAArhNk8+QAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItNS54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciA1PC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciA1PC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciA1IGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAAS0taOOQAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItNi54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciA2PC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciA2PC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciA2IGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAA6HywfuQAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItNy54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciA3PC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciA3PC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciA3IGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAAG0uVL+QAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItOC54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciA4PC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciA4PC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciA4IGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAAuHx/aeQAAADkAAAAFQAAAE9FQlBTL2NoYXB0ZXItOS54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciA5PC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciA5PC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciA5IGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAAUdolLucAAADnAAAAFgAAAE9FQlBTL2NoYXB0ZXItMTAueGh0bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCI/Pgo8aHRtbCB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94aHRtbCI+CiAgPGhlYWQ+PHRpdGxlPkNoYXB0ZXIgMTA8L3RpdGxlPjwvaGVhZD4KICA8Ym9keT4KICAgIDxoMT5DaGFwdGVyIDEwPC9oMT4KICAgIDxkaXYgc3R5bGU9ImhlaWdodDo5MDBweCI+Q2hhcHRlciAxMCBjb250ZW50LjwvZGl2PgogIDwvYm9keT4KPC9odG1sPgpQSwMEFAAAAAAAAAAAAH/0fPjnAAAA5wAAABYAAABPRUJQUy9jaGFwdGVyLTExLnhodG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPGh0bWwgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWwiPgogIDxoZWFkPjx0aXRsZT5DaGFwdGVyIDExPC90aXRsZT48L2hlYWQ+CiAgPGJvZHk+CiAgICA8aDE+Q2hhcHRlciAxMTwvaDE+CiAgICA8ZGl2IHN0eWxlPSJoZWlnaHQ6OTAwcHgiPkNoYXB0ZXIgMTEgY29udGVudC48L2Rpdj4KICA8L2JvZHk+CjwvaHRtbD4KUEsDBBQAAAAAAAAAAABMgOZZ5wAAAOcAAAAWAAAAT0VCUFMvY2hhcHRlci0xMi54aHRtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxodG1sIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sIj4KICA8aGVhZD48dGl0bGU+Q2hhcHRlciAxMjwvdGl0bGU+PC9oZWFkPgogIDxib2R5PgogICAgPGgxPkNoYXB0ZXIgMTI8L2gxPgogICAgPGRpdiBzdHlsZT0iaGVpZ2h0OjkwMHB4Ij5DaGFwdGVyIDEyIGNvbnRlbnQuPC9kaXY+CiAgPC9ib2R5Pgo8L2h0bWw+ClBLAwQUAAAAAAAAAAAAD1mr2HwHAAB8BwAAEQAAAE9FQlBTL2NvbnRlbnQub3BmPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHBhY2thZ2UgeG1sbnM9Imh0dHA6Ly93d3cuaWRwZi5vcmcvMjAwNy9vcGYiIHZlcnNpb249IjMuMCIgdW5pcXVlLWlkZW50aWZpZXI9ImJvb2tpZCI+CiAgPG1ldGFkYXRhIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyI+CiAgICA8ZGM6aWRlbnRpZmllciBpZD0iYm9va2lkIj51cm46dXVpZDp0ZW5vbi1lcHViLWxvbmctcHJldmlldy10ZXN0PC9kYzppZGVudGlmaWVyPgogICAgPGRjOnRpdGxlPlRlbm9uIEVQVUIgTG9uZyBQcmV2aWV3PC9kYzp0aXRsZT4KICAgIDxkYzpsYW5ndWFnZT5lbjwvZGM6bGFuZ3VhZ2U+CiAgPC9tZXRhZGF0YT4KICA8bWFuaWZlc3Q+CiAgICA8aXRlbSBpZD0ibmF2IiBocmVmPSJuYXYueGh0bWwiIG1lZGlhLXR5cGU9ImFwcGxpY2F0aW9uL3hodG1sK3htbCIgcHJvcGVydGllcz0ibmF2Ii8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjEiIGhyZWY9ImNoYXB0ZXItMS54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjIiIGhyZWY9ImNoYXB0ZXItMi54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjMiIGhyZWY9ImNoYXB0ZXItMy54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjQiIGhyZWY9ImNoYXB0ZXItNC54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjUiIGhyZWY9ImNoYXB0ZXItNS54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjYiIGhyZWY9ImNoYXB0ZXItNi54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjciIGhyZWY9ImNoYXB0ZXItNy54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjgiIGhyZWY9ImNoYXB0ZXItOC54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjkiIGhyZWY9ImNoYXB0ZXItOS54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgICA8aXRlbSBpZD0iY2hhcHRlcjEwIiBocmVmPSJjaGFwdGVyLTEwLnhodG1sIiBtZWRpYS10eXBlPSJhcHBsaWNhdGlvbi94aHRtbCt4bWwiLz4KICAgIDxpdGVtIGlkPSJjaGFwdGVyMTEiIGhyZWY9ImNoYXB0ZXItMTEueGh0bWwiIG1lZGlhLXR5cGU9ImFwcGxpY2F0aW9uL3hodG1sK3htbCIvPgogICAgPGl0ZW0gaWQ9ImNoYXB0ZXIxMiIgaHJlZj0iY2hhcHRlci0xMi54aHRtbCIgbWVkaWEtdHlwZT0iYXBwbGljYXRpb24veGh0bWwreG1sIi8+CiAgPC9tYW5pZmVzdD4KICA8c3BpbmU+CiAgICA8aXRlbXJlZiBpZHJlZj0iY2hhcHRlcjEiLz4KICAgIDxpdGVtcmVmIGlkcmVmPSJjaGFwdGVyMiIvPgogICAgPGl0ZW1yZWYgaWRyZWY9ImNoYXB0ZXIzIi8+CiAgICA8aXRlbXJlZiBpZHJlZj0iY2hhcHRlcjQiLz4KICAgIDxpdGVtcmVmIGlkcmVmPSJjaGFwdGVyNSIvPgogICAgPGl0ZW1yZWYgaWRyZWY9ImNoYXB0ZXI2Ii8+CiAgICA8aXRlbXJlZiBpZHJlZj0iY2hhcHRlcjciLz4KICAgIDxpdGVtcmVmIGlkcmVmPSJjaGFwdGVyOCIvPgogICAgPGl0ZW1yZWYgaWRyZWY9ImNoYXB0ZXI5Ii8+CiAgICA8aXRlbXJlZiBpZHJlZj0iY2hhcHRlcjEwIi8+CiAgICA8aXRlbXJlZiBpZHJlZj0iY2hhcHRlcjExIi8+CiAgICA8aXRlbXJlZiBpZHJlZj0iY2hhcHRlcjEyIi8+CiAgPC9zcGluZT4KPC9wYWNrYWdlPgpQSwECFAAUAAAAAAAAAAAAb2GrLBQAAAAUAAAACAAAAAAAAAAAAAAAAAAAAAAAbWltZXR5cGVQSwECFAAUAAAAAAAAAAAAHkBH+PQAAAD0AAAAFgAAAAAAAAAAAAAAAAA6AAAATUVUQS1JTkYvY29udGFpbmVyLnhtbFBLAQIUABQAAAAAAAAAAAApYNaLKAMAACgDAAAPAAAAAAAAAAAAAAAAAGIBAABPRUJQUy9uYXYueGh0bWxQSwECFAAUAAAAAAAAAAAAY8u9M+QAAADkAAAAFQAAAAAAAAAAAAAAAAC3BAAAT0VCUFMvY2hhcHRlci0xLnhodG1sUEsBAhQAFAAAAAAAAAAAAIaTg/jkAAAA5AAAABUAAAAAAAAAAAAAAAAAzgUAAE9FQlBTL2NoYXB0ZXItMi54aHRtbFBLAQIUABQAAAAAAAAAAAAlpGm+5AAAAOQAAAAVAAAAAAAAAAAAAAAAAOUGAABPRUJQUy9jaGFwdGVyLTMueGh0bWxQSwECFAAUAAAAAAAAAAAADSSOteQAAADkAAAAFQAAAAAAAAAAAAAAAAD8BwAAT0VCUFMvY2hhcHRlci00LnhodG1sUEsBAhQAFAAAAAAAAAAAAK4TZPPkAAAA5AAAABUAAAAAAAAAAAAAAAAAEwkAAE9FQlBTL2NoYXB0ZXItNS54aHRtbFBLAQIUABQAAAAAAAAAAABLS1o45AAAAOQAAAAVAAAAAAAAAAAAAAAAACoKAABPRUJQUy9jaGFwdGVyLTYueGh0bWxQSwECFAAUAAAAAAAAAAAA6HywfuQAAADkAAAAFQAAAAAAAAAAAAAAAABBCwAAT0VCUFMvY2hhcHRlci03LnhodG1sUEsBAhQAFAAAAAAAAAAAABtLlS/kAAAA5AAAABUAAAAAAAAAAAAAAAAAWAwAAE9FQlBTL2NoYXB0ZXItOC54aHRtbFBLAQIUABQAAAAAAAAAAAC4fH9p5AAAAOQAAAAVAAAAAAAAAAAAAAAAAG8NAABPRUJQUy9jaGFwdGVyLTkueGh0bWxQSwECFAAUAAAAAAAAAAAAUdolLucAAADnAAAAFgAAAAAAAAAAAAAAAACGDgAAT0VCUFMvY2hhcHRlci0xMC54aHRtbFBLAQIUABQAAAAAAAAAAAB/9Hz45wAAAOcAAAAWAAAAAAAAAAAAAAAAAKEPAABPRUJQUy9jaGFwdGVyLTExLnhodG1sUEsBAhQAFAAAAAAAAAAAAEyA5lnnAAAA5wAAABYAAAAAAAAAAAAAAAAAvBAAAE9FQlBTL2NoYXB0ZXItMTIueGh0bWxQSwECFAAUAAAAAAAAAAAAD1mr2HwHAAB8BwAAEQAAAAAAAAAAAAAAAADXEQAAT0VCUFMvY29udGVudC5vcGZQSwUGAAAAABAAEAAdBAAAghkAAAAA';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    };
    const previewPngBytes = () => {
      // A 600×360 solid-color PNG — intrinsically wider than the inline cap, so the
      // image renders at its max width and tests the overlay pinning to its real edge.
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAFoCAIAAAAElhK7AAAFZklEQVR4nO3VMQ0AMAzAsOIaqLEaz8HoEUsGkC9z7gOArFkvAIBFRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkGaEAKQZIQBpRghAmhECkPYBAwrJCBZIoboAAAAASUVORK5CYII=';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    };
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
                  if (ref.offset >= to) return [{ ...ref, offset: ref.offset + delta }];
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
      if (lower.endsWith('.epub')) return 'application/epub+zip';
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
        ...(mimeType === 'application/pdf' ? { pdfPageCount: 3 } : {}),
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
      makeNode(tagId, normalized, { type: 'tagDef', parentId: ids.schema, color: 'green' });
      appendChild(ids.schema, tagId);
      return outcome({ nodeId: tagId, selectAll: false });
    };
    const applyPasteMetadata = (
      nodeId: string,
      metadata: { tags?: string[]; fields?: Array<{ name: string; value: string }> },
    ) => {
      const owner = nodes.get(nodeId);
      if (!owner) return;
      for (const rawName of metadata.tags ?? []) {
        const name = rawName.trim();
        if (!name) continue;
        const existing = [...nodes.values()].find((node) => (
          node.type === 'tagDef' && node.content.text.trim().toLowerCase() === name.toLowerCase()
        ));
        const tagId = existing?.id ?? createTag(name).focus?.nodeId;
        if (tagId && !owner.tags.includes(tagId)) owner.tags.push(tagId);
      }
      for (const field of metadata.fields ?? []) {
        const name = field.name.trim();
        const value = field.value.trim();
        if (!name || !value) continue;
        let fieldDef = [...nodes.values()].find((node) => (
          node.type === 'fieldDef' && node.content.text.trim().toLowerCase() === name.toLowerCase()
        ));
        if (!fieldDef) {
          const fieldDefId = `field-def-${++sequence}`;
          makeNode(fieldDefId, name, { type: 'fieldDef', fieldType: 'plain', parentId: ids.schema, nullable: true });
          appendChild(ids.schema, fieldDefId);
          fieldDef = nodes.get(fieldDefId);
        }
        if (!fieldDef) continue;
        let entry = owner.children
          .map((childId) => nodes.get(childId))
          .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === fieldDef.id);
        if (!entry) {
          const entryId = `field-entry-${++sequence}`;
          makeNode(entryId, '', {
            type: 'fieldEntry',
            parentId: nodeId,
            fieldDefId: fieldDef.id,
            fieldType: fieldDef.fieldType ?? 'plain',
          });
          appendChild(nodeId, entryId);
          entry = nodes.get(entryId);
        }
        if (entry) createNode(entry.id, null, value);
      }
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
        applyPasteMetadata(nodeId, item);
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
    const inlineField = (
      parentId: string,
      index: number | null,
      name: string,
      fieldType: string,
      targetDefId?: string,
    ) => {
      const fieldDefId = targetDefId ?? `field-def-${++sequence}`;
      if (targetDefId) {
        fieldType = nodes.get(targetDefId)?.fieldType ?? fieldType;
      } else {
        makeNode(fieldDefId, name, { type: 'fieldDef', fieldType, parentId: ids.schema, nullable: true });
        appendChild(ids.schema, fieldDefId);
      }
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
    makeNode(ids.dayTag, 'day', { type: 'tagDef', parentId: ids.schema, color: 'gray' });
    makeNode(ids.projectTag, 'project', { type: 'tagDef', parentId: ids.schema, color: 'green' });
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
    if (options.relatedField) {
      makeNode(ids.referencesField, 'Related', {
        type: 'fieldDef',
        parentId: ids.schema,
        fieldType: 'plain',
        nullable: true,
      });
      makeNode(ids.referencesEntry, 'Related', {
        type: 'fieldEntry',
        parentId: ids.today,
        fieldDefId: ids.referencesField,
        fieldType: 'plain',
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
    const tableRowIds = Array.from({ length: options.tableRowCount ?? 0 }, (_, index) => {
      const rowId = `table-row-${String(index).padStart(3, '0')}`;
      makeNode(rowId, `Table row ${String(index + 1).padStart(3, '0')}`, { parentId: ids.today });
      return rowId;
    });
    appendChild(ids.workspace, ids.root);
    for (const childId of [ids.daily, ids.library, ids.schema, ids.searches, ids.trash]) appendChild(ids.root, childId);
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
    if (options.relatedField) appendChild(ids.schema, ids.referencesField);
    appendChild(ids.daily, ids.today);
    if (options.optionsField) appendChild(ids.today, ids.priorityEntry);
    if (options.dateField) appendChild(ids.today, ids.dueEntry);
    if (options.relatedField) appendChild(ids.today, ids.referencesEntry);
    for (const childId of [ids.alpha, ids.beta, ids.gamma]) appendChild(ids.today, childId);
    for (const childId of tableRowIds) appendChild(ids.today, childId);

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          clipboardText = text;
        },
      },
      configurable: true,
    });

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
      baseUrl: string;
      enabled: boolean;
      hasApiKey: boolean;
      hasEnvApiKey: boolean;
      auth?: { authKind: string; credentialed: boolean; oauth?: { connected: boolean; expiresAt?: number } };
    };
    const resolveOAuthLogin = (providerId: string) => {
      const providers = agentSettings.providers as unknown as MockAuthProvider[];
      const auth = { authKind: 'oauth', credentialed: true, oauth: { connected: true, expiresAt: now + 1_000 * 60 * 60 * 24 * 30 } };
      const existing = providers.find((item) => item.providerId === providerId);
      if (existing) { existing.enabled = true; existing.hasApiKey = false; existing.auth = auth; } else {
        providers.push({
          providerId,
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

    const setMockTranslationLanguage = (language: TranslationLanguage) => {
      translationLanguage = language;
      if (win.lin) win.lin.initialTranslationLanguage = language;
      for (const listener of translationLanguageListeners) listener(language);
    };

    const setMockTranslationPreferences = (preferences: UrlPageTranslationPreferences) => {
      translationPreferences = clone(preferences);
      if (win.lin) win.lin.initialUrlPageTranslationPreferences = clone(translationPreferences);
      for (const listener of translationPreferenceListeners) listener(clone(translationPreferences));
    };

    win.__LIN_E2E__ = {
      calls,
      projection,
      clipboardText: () => clipboardText,
      emitAgentCoreNotification,
      emitDocumentEvent,
      emitOAuthEvent,
      resolveOAuthLogin,
      setTranslationDelayMs: (delayMs) => { translationDelayMs = Math.max(0, delayMs); },
      setTranslationLanguage: setMockTranslationLanguage,
      setTranslationPreferences: setMockTranslationPreferences,
    };
    (win as unknown as { e2eNodeInlineRef: typeof nodeInlineRef }).e2eNodeInlineRef = nodeInlineRef;

    win.lin = {
      initialTranslationLanguage: translationLanguage,
      initialUrlPageTranslationPreferences: clone(translationPreferences),
      agentCoreRequest: async <T,>(method: string, input: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ cmd: method, args: clone(input) });
        if (method === 'thread/list') {
          return clone({ data: [...mockThreads].sort((left, right) => right.updatedAt - left.updatedAt), nextCursor: null }) as T;
        }
        if (method === 'thread/read') {
          const thread = threadById(String(input.threadId));
          return clone({ thread: input.includeTurns ? { ...thread, turns: mockTurns.get(thread.id) ?? [] } : thread }) as T;
        }
        if (method === 'thread/start') {
          const thread = createMockThread(input);
          emitAgentCoreNotification({ type: 'thread/started', threadId: thread.id, thread });
          return clone({ thread }) as T;
        }
        if (method === 'thread/resume') {
          return clone({ thread: threadById(String(input.threadId)) }) as T;
        }
        if (method === 'thread/fork') {
          const source = threadById(String(input.threadId));
          const sourceTurns = mockTurns.get(source.id) ?? [];
          const boundary = input.boundary as { kind?: string; turnId?: string } | undefined;
          const boundaryIndex = sourceTurns.findIndex((turn) => turn.id === boundary?.turnId);
          if (boundaryIndex < 0) throw new Error('Fork boundary Turn not found.');
          const includeCount = boundary?.kind === 'afterTurn' ? boundaryIndex + 1 : boundaryIndex;
          const thread = createMockThread({
            name: typeof input.name === 'string' ? input.name : nextMockForkName(source),
          }, source.id);
          thread.preview = source.preview;
          mockThreadConfigurations.set(
            thread.id,
            clone(mockThreadConfigurations.get(source.id) ?? {
              modelProvider: source.modelProvider,
              model: `${source.modelProvider}/gpt-5.4`,
              reasoningEffort: 'medium',
            }),
          );
          mockTurns.set(thread.id, clone(sourceTurns.slice(0, includeCount)));
          emitAgentCoreNotification({ type: 'thread/started', threadId: thread.id, thread });
          return clone({ thread }) as T;
        }
        if (method === 'thread/rollback') {
          const thread = threadById(String(input.threadId));
          const turns = mockTurns.get(thread.id) ?? [];
          const numTurns = Number(input.numTurns);
          if (!Number.isSafeInteger(numTurns) || numTurns <= 0 || numTurns > turns.length) {
            throw new Error('Invalid rollback Turn count.');
          }
          turns.splice(turns.length - numTurns, numTurns);
          thread.updatedAt = ++now;
          return clone({ thread }) as T;
        }
        if (method === 'thread/name/set') {
          const thread = threadById(String(input.threadId));
          thread.name = typeof input.name === 'string' ? input.name : null;
          thread.updatedAt = ++now;
          return {} as T;
        }
        if (method === 'thread/archive' || method === 'thread/unarchive') return {} as T;
        if (method === 'thread/delete') {
          const targetId = String(input.threadId);
          const deleted = new Set([targetId]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const thread of mockThreads) {
              if ((thread.parentThreadId && deleted.has(thread.parentThreadId)) || (thread.forkedFromId && deleted.has(thread.forkedFromId))) {
                if (!deleted.has(thread.id)) {
                  deleted.add(thread.id);
                  changed = true;
                }
              }
            }
          }
          for (let index = mockThreads.length - 1; index >= 0; index -= 1) {
            if (deleted.has(mockThreads[index]!.id)) mockThreads.splice(index, 1);
          }
          for (const threadId of deleted) {
            mockTurns.delete(threadId);
            mockGoals.delete(threadId);
            mockThreadConfigurations.delete(threadId);
          }
          return {} as T;
        }
        if (method === 'thread/configuration/get') {
          const thread = threadById(String(input.threadId));
          return clone({ thread, configuration: mockThreadConfigurations.get(thread.id) }) as T;
        }
        if (method === 'thread/configuration/set') {
          const thread = threadById(String(input.threadId));
          const configuration = {
            modelProvider: String(input.modelProvider),
            model: String(input.model),
            reasoningEffort: String(input.reasoningEffort),
          };
          mockThreadConfigurations.set(thread.id, configuration);
          thread.modelProvider = configuration.modelProvider;
          thread.updatedAt = ++now;
          return clone({ thread, configuration }) as T;
        }
        if (method === 'thread/turns/list') {
          return clone({ data: mockTurns.get(String(input.threadId)) ?? [], nextCursor: null, backwardsCursor: null }) as T;
        }
        if (method === 'thread/items/list') {
          const turns = mockTurns.get(String(input.threadId)) ?? [];
          const turnId = typeof input.turnId === 'string' ? input.turnId : null;
          return clone({
            data: turns.filter((turn) => !turnId || turn.id === turnId)
              .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
            nextCursor: null,
            backwardsCursor: null,
          }) as T;
        }
        if (method === 'turn/start') {
          const thread = threadById(String(input.threadId));
          const turnId = nextCanonicalId();
          const userItemId = nextCanonicalId();
          const responseItemId = nextCanonicalId();
          const content = Array.isArray(input.input) ? clone(input.input) as NonNullable<MockThreadItem['content']> : [];
          const prompt = content.flatMap((entry) => entry.type === 'text' ? [entry.text] : []).join('\n');
          const userItem: MockThreadItem = {
            id: userItemId,
            type: 'userMessage',
            provenance: itemProvenance(thread.id, turnId, userItemId),
            clientId: typeof input.clientUserMessageId === 'string' ? input.clientUserMessageId : null,
            content,
          };
          const responseItem: MockThreadItem = {
            id: responseItemId,
            type: 'agentMessage',
            provenance: itemProvenance(thread.id, turnId, responseItemId),
            text: 'Current outline focuses on design-system work.',
            phase: 'final_answer',
            memoryCitation: null,
          };
          const startedAt = ++now;
          const provenance = { originThreadId: thread.id, originTurnId: turnId, trigger: { kind: 'user' as const } };
          const configuration = mockThreadConfigurations.get(thread.id)!;
          const execution = {
            ...configuration,
            usage: {
              input: 120,
              output: 48,
              cacheRead: 32,
              cacheWrite: 0,
              totalTokens: 200,
              cost: {
                input: 0.0002,
                output: 0.0004,
                cacheRead: 0.00001,
                cacheWrite: 0,
                total: 0.00061,
                currency: 'USD' as const,
              },
            },
          };
          const activeTurn: MockTurn = {
            id: turnId,
            items: [userItem],
            itemsView: 'full',
            provenance,
            status: 'inProgress',
            error: null,
            execution,
            startedAt,
            completedAt: null,
            durationMs: null,
          };
          const failureMessage = typeof options.agentTurnFailure === 'string'
            ? options.agentTurnFailure
            : 'Mock provider failure';
          const completedTurn: MockTurn = {
            ...activeTurn,
            items: options.agentTurnFailure ? [userItem] : [userItem, responseItem],
            status: options.agentTurnFailure ? 'failed' : 'completed',
            error: options.agentTurnFailure ? { message: failureMessage } : null,
            completedAt: startedAt + 24,
            durationMs: 24,
          };
          mockTurns.get(thread.id)!.push(completedTurn);
          thread.preview = prompt;
          thread.updatedAt = startedAt + 24;
          thread.status = { type: 'active', activeFlags: [] };
          emitAgentCoreNotification({ type: 'thread/status/changed', threadId: thread.id, status: thread.status });
          emitAgentCoreNotification({ type: 'turn/started', threadId: thread.id, turnId, turn: activeTurn });
          if (!options.agentTurnFailure) {
            emitAgentCoreNotification({ type: 'item/completed', threadId: thread.id, turnId, itemId: responseItemId, item: responseItem });
          }
          thread.status = { type: 'idle' };
          emitAgentCoreNotification({ type: 'turn/completed', threadId: thread.id, turnId, turn: completedTurn });
          emitAgentCoreNotification({ type: 'thread/status/changed', threadId: thread.id, status: thread.status });
          return clone({ turn: activeTurn, acceptedItemId: userItemId, deduplicated: false }) as T;
        }
        if (method === 'turn/steer') {
          return clone({
            turnId: String(input.expectedTurnId),
            acceptedItemId: nextCanonicalId(),
            deduplicated: false,
          }) as T;
        }
        if (method === 'turn/interrupt') {
          const threadId = String(input.threadId);
          const turnId = String(input.turnId);
          const turn = (mockTurns.get(threadId) ?? []).find((candidate) => candidate.id === turnId);
          if (turn) {
            turn.status = 'interrupted';
            turn.completedAt = ++now;
            turn.durationMs = Math.max(0, turn.completedAt - turn.startedAt);
            emitAgentCoreNotification({ type: 'turn/completed', threadId, turnId, turn });
          }
          return clone({ turnId }) as T;
        }
        if (method === 'goal/get') return clone({ goal: mockGoals.get(String(input.threadId)) ?? null }) as T;
        if (method === 'goal/create' || method === 'goal/update') {
          const threadId = String(input.threadId);
          const goal = { ...input, threadId, updatedAt: ++now };
          mockGoals.set(threadId, goal);
          emitAgentCoreNotification({ type: 'goal/updated', threadId, goal });
          return clone({ goal }) as T;
        }
        if (method === 'userInput/respond') return clone({ response: input }) as T;
        throw new Error(`Unhandled Agent Core mock request: ${method}`);
      },
      onAgentCoreNotification: (listener) => {
        agentCoreListeners.push(listener);
        return () => {
          const index = agentCoreListeners.indexOf(listener);
          if (index >= 0) agentCoreListeners.splice(index, 1);
        };
      },
      setTranslationLanguage: async (language) => {
        setMockTranslationLanguage(language);
      },
      onTranslationLanguageChanged: (listener) => {
        translationLanguageListeners.push(listener);
        return () => {
          const index = translationLanguageListeners.indexOf(listener);
          if (index >= 0) translationLanguageListeners.splice(index, 1);
        };
      },
      setUrlPageTranslationPreferences: async (preferences) => {
        setMockTranslationPreferences(preferences);
        return clone(translationPreferences);
      },
      onUrlPageTranslationPreferencesChanged: (listener) => {
        translationPreferenceListeners.push(listener);
        return () => {
          const index = translationPreferenceListeners.indexOf(listener);
          if (index >= 0) translationPreferenceListeners.splice(index, 1);
        };
      },
      onUrlPageTranslationShortcut: () => () => undefined,
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
      notifySettingsChanged: async () => {
        for (const listener of settingsChangedListeners) listener();
      },
      onSettingsChanged: (listener) => {
        settingsChangedListeners.push(listener);
        return () => {
          const index = settingsChangedListeners.indexOf(listener);
          if (index >= 0) settingsChangedListeners.splice(index, 1);
        };
      },
      onSettingsNavigate: () => () => {},
      recentLocalFiles: async () => ({
        files: [
          {
            entryKind: 'file',
            id: 'recent-local-notes',
            path: '/Users/test/Documents/recent-notes.md',
            name: 'recent-notes.md',
            parentPath: '/Users/test/Documents',
            mimeType: 'text/plain',
            sizeBytes: 123,
            lastModified: now - 1_000,
          },
          {
            entryKind: 'directory',
            id: 'recent-local-workspace',
            path: '/mock/local-root/workspace',
            name: 'workspace',
            parentPath: '/mock/local-root',
            mimeType: 'inode/directory',
            sizeBytes: 0,
            lastModified: now - 2_000,
          },
          {
            entryKind: 'file',
            id: 'recent-local-image',
            path: '/mock/local-root/reference.png',
            name: 'reference.png',
            parentPath: '/mock/local-root',
            mimeType: 'image/png',
            sizeBytes: 10,
            lastModified: now - 3_000,
          },
        ],
      }),
      prepareLocalFile: async ({ id }) => {
        if (id === 'recent-local-notes') {
          return {
            file: {
              entryKind: 'file',
              path: '/Users/test/Documents/recent-notes.md',
              name: 'recent-notes.md',
              mimeType: 'text/plain',
              sizeBytes: 123,
              lastModified: now - 1_000,
            },
          };
        }
        if (id === 'recent-local-workspace') {
          return {
            file: {
              entryKind: 'directory',
              path: '/mock/local-root/workspace',
              name: 'workspace',
              mimeType: 'inode/directory',
              sizeBytes: 0,
              lastModified: now - 2_000,
            },
          };
        }
        if (id === 'recent-local-image') {
          return {
            file: {
              entryKind: 'file',
              path: '/mock/local-root/reference.png',
              name: 'reference.png',
              mimeType: 'image/png',
              sizeBytes: 10,
              lastModified: now - 3_000,
              imageDataBase64: 'bW9jayBpbWFnZQ==',
            },
          };
        }
        return { file: null };
      },
      stageAttachment: async (input) => {
        const safeName = (input.name || 'attachment').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'attachment';
        return {
          path: `/mock/local-root/tmp/agent-attachments/${++sequence}-${safeName}`,
          name: input.name || 'attachment',
          mimeType: input.mimeType || 'application/octet-stream',
          sizeBytes: input.bytes.byteLength,
        };
      },
      getProviderApiKey: async (providerId) => {
        const args = { providerId };
        calls.push({ cmd: 'lin:get-provider-api-key', args: clone(args) });
        return clone({ providerId, apiKey: providerApiKeys.get(providerId) });
      },
      invoke: async <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ cmd, args: clone(args) });
        if (cmd === 'url_page_translate_blocks') {
          await delay(translationDelayMs);
          const blocks = Array.isArray(args.blocks)
            ? args.blocks.flatMap((entry) => {
                if (!entry || typeof entry !== 'object') return [];
                const { id, text } = entry as { id?: unknown; text?: unknown };
                return typeof id === 'string' && typeof text === 'string' ? [{ id, text }] : [];
              })
            : [];
          return clone({
            ok: true,
            requestId: String(args.requestId ?? ''),
            translations: blocks.map(({ id, text }) => ({
              id,
              translation: `Translated: ${text}`,
            })),
          }) as T;
        }
        if (cmd === 'url_page_translation_cancel') {
          return clone({ cancelled: true }) as T;
        }
        if (cmd === 'agent_get_provider_settings') {
          if (options.providerSettingsDelayMs) await delay(options.providerSettingsDelayMs);
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_refresh_provider_models') {
          const providerId = String(args.providerId ?? '');
          const provider = agentSettings.availableProviders.find((item) => item.providerId === providerId);
          if (providerId === 'cc-switch' && provider) {
            provider.models = [
              {
                id: 'claude-fable-5',
                name: 'Codex / OpenAI / Claude Fable 5',
                reasoning: true,
                supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
                contextWindow: 200_000,
                maxTokens: 8192,
              },
              {
                id: 'gpt-5.4',
                name: 'Codex / OpenAI / GPT 5.4',
                reasoning: true,
                supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
                contextWindow: 256_000,
                maxTokens: 8192,
              },
            ];
          }
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_upsert_provider_config') {
          // Connection-only: the provider config carries credentials + endpoint
          // only; model/effort now live on the Configuration Profile, never here.
          const provider = args.provider as {
            providerId: string;
            baseUrl?: string | null;
            enabled?: boolean;
          };
          const baseUrl = provider.baseUrl ?? '';
          const hasStoredKey = providerApiKeys.has(provider.providerId);
          const isKeylessLocal = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(baseUrl);
          const auth = { authKind: 'api-key', credentialed: hasStoredKey || isKeylessLocal, hasStoredKey };
          const existing = agentSettings.providers.find((item) => item.providerId === provider.providerId);
          if (existing) {
            existing.baseUrl = baseUrl;
            existing.enabled = provider.enabled ?? true;
            existing.hasApiKey = hasStoredKey;
            existing.auth = auth;
          } else {
            agentSettings.providers.push({
              providerId: provider.providerId,
              baseUrl,
              enabled: provider.enabled ?? true,
              hasApiKey: hasStoredKey,
              hasEnvApiKey: false,
              auth,
            });
          }
          return clone(agentSettings) as T;
        }
        if (cmd === 'agent_update_runtime_settings') {
          const settings = args.settings as {
            additionalSkillDirectories?: string[];
            providerTimeoutMs?: number | null;
            providerMaxRetries?: number | null;
            providerMaxRetryDelayMs?: number | null;
            providerCacheRetention?: string;
          };
          agentSettings.agent = {
            additionalSkillDirectories: Array.isArray(settings.additionalSkillDirectories)
              ? settings.additionalSkillDirectories.map(String)
              : agentSettings.agent.additionalSkillDirectories,
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
        if (cmd === 'agent_get_capability_settings') {
          return clone(agentCapabilities) as T;
        }
        if (cmd === 'agent_list_all_skills') {
          if (options.agentSkillsDelayMs) await delay(options.agentSkillsDelayMs);
          const skills = args.userInvocableOnly === true
            ? agentSkills.filter((skill) => (
              skill.userInvocable && !agentSettings.agent.disabledSkills.includes(skill.name)
            ))
            : agentSkills;
          return clone(skills) as T;
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
        if (cmd === 'agent_apply_capability_settings_patch') {
          const patch = args.patch as {
            removeBlocks?: string[];
          };
          const removed = Array.isArray(patch.removeBlocks) ? patch.removeBlocks.map(String) : [];
          agentCapabilities.blocks = agentCapabilities.blocks.filter((block) => !removed.includes(block));
          return clone(agentCapabilities) as T;
        }
        if (cmd === 'agent_append_capability_block') {
          const ruleValue = String(args.ruleValue ?? '');
          if (ruleValue && !agentCapabilities.blocks.includes(ruleValue)) {
            agentCapabilities.blocks.push(ruleValue);
          }
          return clone(agentCapabilities) as T;
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
          const apiKey = String(args.apiKey ?? '').trim();
          if (apiKey) providerApiKeys.set(providerId, apiKey);
          else providerApiKeys.delete(providerId);
          const existing = agentSettings.providers.find((item) => item.providerId === providerId);
          const keyAuth = { authKind: 'api-key', credentialed: true, hasStoredKey: true };
          if (existing) {
            existing.hasApiKey = true;
            existing.auth = keyAuth;
          } else {
            agentSettings.providers.push({
              providerId,
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
          providerApiKeys.delete(providerId);
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
        if (cmd === 'init_workspace' || cmd === 'get_projection') {
          if (cmd === 'init_workspace' && options.initWorkspaceDelayMs) await delay(options.initWorkspaceDelayMs);
          return clone(projectionSnapshot()) as T;
        }
        if (cmd === 'ingest_asset') {
          const data = args.data as { byteLength?: number } | undefined;
          return clone(createAsset({
            mimeType: typeof args.mimeType === 'string' ? args.mimeType : undefined,
            originalFilename: typeof args.originalFilename === 'string' ? args.originalFilename : undefined,
            byteSize: typeof data?.byteLength === 'number' ? data.byteLength : undefined,
          })) as T;
        }
        if (cmd === 'ingest_local_file') {
          const path = typeof args.path === 'string' ? args.path : '';
          const name = path.split('/').filter(Boolean).at(-1) ?? 'file';
          const mimeType = name.endsWith('.png') || name.endsWith('.jpg')
            ? 'image/png'
            : name.endsWith('.pdf') ? 'application/pdf'
              : name.endsWith('.epub') ? 'application/epub+zip' : 'application/octet-stream';
          return clone(createAsset({ mimeType, originalFilename: name, byteSize: 4096 })) as T;
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
            entryKind?: 'file' | 'directory';
            label?: string;
            path?: string;
            url?: string;
          } | undefined;
          if (target?.kind === 'asset' && target.assetId) {
            const asset = assets.get(target.assetId);
            const epubBytes = asset?.mimeType === 'application/epub+zip'
              ? asset.originalFilename?.toLowerCase().includes('long')
                ? previewLongEpubBytes()
                : previewEpubBytes()
              : null;
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
                lastModified: asset.createdAt,
                streamUrl: epubBytes
                  ? URL.createObjectURL(new Blob([epubBytes], { type: asset.mimeType }))
                  : `asset://${target.assetId}`,
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
          return clone({ source: null, error: 'missing' }) as T;
        }
        if (cmd === 'preview_read_text') {
          const target = args.target as {
            assetId?: string;
            kind?: string;
            path?: string;
          } | undefined;
          if (target?.kind === 'local-file') return clone({ text: `# ${target.path?.split('/').pop() ?? 'file'}\n\nMock preview text.` }) as T;
          if (target?.kind === 'asset' && target.assetId) {
            const asset = assets.get(target.assetId);
            const mimeType = asset?.mimeType.toLowerCase() ?? '';
            const filename = asset?.originalFilename.toLowerCase() ?? '';
            if (mimeType === 'text/markdown' || filename.endsWith('.md')) {
              return clone({
                text: [
                  '# Markdown edge preview',
                  '',
                  'Body text should sit inside the file preview frame.',
                  '',
                  '```ts',
                  `const message = "${'long-code-segment.'.repeat(16)}";`,
                  '```',
                ].join('\n'),
              }) as T;
            }
            if (mimeType === 'text/csv' || filename.endsWith('.csv')) {
              const headers = Array.from({ length: 12 }, (_, index) => `column_${index + 1}`).join(',');
              const values = Array.from({ length: 12 }, (_, index) => `value_${index + 1}`).join(',');
              return clone({
                text: `${headers}\n${values}`,
              }) as T;
            }
            if (mimeType.startsWith('text/') || filename.endsWith('.txt')) {
              return clone({
                text: `Mock asset preview text ${'long-text-segment '.repeat(24)}`,
              }) as T;
            }
          }
          return clone({ text: 'Mock asset preview text.' }) as T;
        }
        if (cmd === 'preview_read_bytes') {
          const target = args.target as { kind?: string; assetId?: string; path?: string } | undefined;
          if (
            (target?.kind === 'asset' && target.assetId && assets.get(target.assetId)?.mimeType === 'application/pdf')
            || (target?.kind === 'local-file' && target.path?.toLowerCase().endsWith('.pdf'))
          ) {
            return { bytes: previewPdfBytes(), mimeType: 'application/pdf' } as T;
          }
          if (target?.kind === 'asset' && target.assetId && assets.get(target.assetId)?.mimeType === 'application/epub+zip') {
            const epubAsset = assets.get(target.assetId);
            const isLong = epubAsset?.originalFilename?.toLowerCase().includes('long') ?? false;
            return { bytes: isLong ? previewLongEpubBytes() : previewEpubBytes(), mimeType: 'application/epub+zip' } as T;
          }
          const imageAsset = target?.kind === 'asset' && target.assetId ? assets.get(target.assetId) : undefined;
          if (imageAsset?.mimeType?.startsWith('image/')) {
            return { bytes: previewPngBytes(), mimeType: imageAsset.mimeType } as T;
          }
          return { bytes: new ArrayBuffer(0), mimeType: 'application/octet-stream' } as T;
        }
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
          const nodeId = createNode(parentId, args.index as number | null, typeof args.name === 'string' ? args.name : '', {
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
          const nodeId = createNode(parentId, args.index as number | null, String(args.originalFilename ?? 'attachment'), {
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
          const firstMeta = (args.firstMeta ?? {}) as {
            checkbox?: boolean;
            done?: boolean;
            tags?: string[];
            fields?: Array<{ name: string; value: string }>;
          };
          if (firstMeta.checkbox) node.completedAt = firstMeta.done ? ++now : 0;
          applyPasteMetadata(nodeId, firstMeta);
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
          const targetDefId = typeof args.targetDefId === 'string' ? args.targetDefId : undefined;
          const fieldEntryId = inlineField(
            String(args.parentId),
            args.index as number | null,
            String(args.name),
            String(args.fieldType),
            targetDefId,
          );
          return clone(outcome({
            nodeId: fieldEntryId,
            parentId: targetDefId ? fieldEntryId : String(args.parentId),
            placement: targetDefId ? { kind: 'end' } : { kind: 'all' },
            selectAll: !targetDefId,
            surface: targetDefId ? 'trailing' : 'field-name',
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
	            let fieldId = typeof args.field === 'string' ? args.field : '';
	            if (typeof args.createFieldName === 'string') {
	              const name = args.createFieldName.trim();
	              const existing = [...nodes.values()].find((node) => (
	                node.type === 'fieldDef'
	                && node.parentId === ids.schema
	                && node.content.text.trim().toLowerCase() === name.toLowerCase()
	              ));
	              if (existing) fieldId = existing.id;
	              else {
	                fieldId = `field-def-${++sequence}`;
	                makeNode(fieldId, name, {
	                  type: 'fieldDef',
	                  fieldType: String(args.createFieldType ?? 'plain'),
	                  parentId: ids.schema,
	                  nullable: true,
	                });
	                appendChild(ids.schema, fieldId);
	              }
	            }
	            const existingDisplay = directChildrenOfType(view.id, 'displayField')
	              .find((display) => display.displayField === fieldId);
	            if (existingDisplay) {
	              existingDisplay.displayVisible = true;
	              return clone(outcome({ nodeId: existingDisplay.id, selectAll: false }));
	            }
	            const displayId = `display-${++sequence}`;
	            const displayOrder = directChildrenOfType(view.id, 'displayField').length;
	            makeNode(displayId, '', {
	              type: 'displayField',
	              parentId: view.id,
	              displayField: fieldId || 'sys:name',
	              displayVisible: true,
	              displayOrder,
	            });
	            appendChild(view.id, displayId);
	            return clone(outcome({ nodeId: displayId, selectAll: false }));
	          }
	          return clone(outcome());
	        }
	        if (cmd === 'update_display_field') {
	          const display = nodes.get(String(args.displayFieldId));
	          if (display?.type === 'displayField') {
	            if (args.field != null) display.displayField = String(args.field);
	            if (args.visible != null) display.displayVisible = Boolean(args.visible);
	            if ('width' in args) setOptionalNumber(display, 'displayWidth', args.width);
	            if ('label' in args) setOptionalText(display, 'displayLabel', args.label);
	            if (args.placement != null) display.displayPlacement = String(args.placement);
	            if (args.move === 'left' || args.move === 'right') {
	              const parent = display.parentId ? nodes.get(display.parentId) : null;
	              if (parent) {
	                const siblings = parent.children
	                  .map((childId) => nodes.get(childId))
	                  .filter((child): child is MockNode => child?.type === 'displayField')
	                  .sort((left, right) => (
	                    (left.displayOrder ?? Number.MAX_SAFE_INTEGER)
	                    - (right.displayOrder ?? Number.MAX_SAFE_INTEGER)
	                  ));
	                const currentIndex = siblings.findIndex((sibling) => sibling.id === display.id);
	                const direction = args.move === 'left' ? -1 : 1;
	                let targetIndex = currentIndex + direction;
	                while (
	                  targetIndex >= 0
	                  && targetIndex < siblings.length
	                  && siblings[targetIndex]?.displayVisible === false
	                ) {
	                  targetIndex += direction;
	                }
	                if (currentIndex >= 0 && targetIndex >= 0 && targetIndex < siblings.length) {
	                  [siblings[currentIndex], siblings[targetIndex]] = [siblings[targetIndex]!, siblings[currentIndex]!];
	                  siblings.forEach((sibling, order) => { sibling.displayOrder = order; });
	                }
	              }
	            }
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
        throw new Error(`Unhandled mock invoke: ${cmd}`);
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

export async function configurePreviewTranslationMock(
  page: Page,
  options: {
    delayMs?: number;
    language?: TranslationLanguage;
    preferences?: UrlPageTranslationPreferences;
  },
) {
  await page.evaluate((input) => {
    const mock = (window as E2EWindow).__LIN_E2E__;
    if (!mock) throw new Error('Missing E2E fixture');
    if (input.delayMs !== undefined) mock.setTranslationDelayMs(input.delayMs);
    if (input.language) mock.setTranslationLanguage(input.language);
    if (input.preferences) mock.setTranslationPreferences(input.preferences);
  }, options);
}

export async function emitAgentCoreNotification(page: Page, notification: unknown) {
  await page.evaluate((nextNotification) => {
    const win = window as E2EWindow;
    win.__LIN_E2E__?.emitAgentCoreNotification(nextNotification);
  }, notification);
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
