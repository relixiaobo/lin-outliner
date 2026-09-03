import { expect, type Page } from '@playwright/test';
import type { TranslationLanguage } from '../../src/core/translationLanguage';
import type { UrlPageTranslationPreferences } from '../../src/core/urlPageTranslation';
import type { ManagedSkillCatalogEntryView, ManagedSkillView } from '../../src/core/types';
import type { AppInfo } from '../../src/core/errorObservability';
import type { AppUpdateView } from '../../src/core/appUpdate';
import { SEARCH_QUERY_COMPLEXITY_LIMITS } from '../../src/core/searchQueryCompiler';
import { assetUrl } from '../../src/core/assets';

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
  searchIntermediate: 'search-intermediate-reference',
  searchResult: 'search-result-reference',
  searchStatusEntry: 'search-status-entry',
  searchStatusValue: 'search-status-value',
  alpha: 'node:11111111-1111-4111-8111-111111111111',
  beta: 'node:22222222-2222-4222-8222-222222222222',
  gamma: 'node:33333333-3333-4333-8333-333333333333',
} as const;

interface MockFixtureOptions {
  dateField?: boolean;
  optionsField?: boolean;
  relatedField?: boolean;
  /** Seeds Recents with a search-result reference whose target is another reference. */
  searchReferenceChain?: boolean;
  /** Seeds an editable Recents query whose projected children exceed the editor limit. */
  truncatedSearchQuery?: boolean;
  /** Appends deterministic content rows under Today for table-windowing specs. */
  tableRowCount?: number;
  /** Adds an OAuth sign-in provider (GitHub Copilot) to the catalog for the OAuth specs. */
  oauthProvider?: boolean;
  /** Adds an OAuth-capable OpenRouter connection backed by a stored API key. */
  oauthApiKeyProvider?: boolean;
  /** Adds a connection with more models than the composer menu lists at rest, so
   *  the per-provider "Show all models" expander renders. */
  manyModelProvider?: boolean;
  /** Preloads user blocklist rules for settings/security specs. */
  capabilityBlocks?: string[];
  /** Delays initial workspace restoration so startup chrome can be asserted before data arrives. */
  initWorkspaceDelayMs?: number;
  /** Delays provider settings so Settings chrome can be asserted before settings data arrives. */
  providerSettingsDelayMs?: number;
  /** Delays only the first automatic Thread creation request. */
  initialThreadStartDelayMs?: number;
  /** Seeds the shared preview-translation target language. */
  translationLanguage?: TranslationLanguage;
  /** Seeds URL/EPUB automatic translation and model preferences. */
  translationPreferences?: UrlPageTranslationPreferences;
  /** Keeps translated blocks pending long enough for loader assertions. */
  translationDelayMs?: number;
  /** Completes mock Agent Turns as failed without an assistant message. */
  agentTurnFailure?: boolean | string;
  /** Keeps the normal assistant response when the mock Turn fails. */
  agentTurnFailureHasResponse?: boolean;
  /** Rejects turn/submit before accepting a Turn. */
  agentTurnSubmitReject?: boolean | string;
  /** Completes a request-time active Turn, then delays before admitting a new Turn. */
  agentTurnSubmitFinishingDelayMs?: number;
  /** Leaves accepted mock Turns active so background-work flows can be tested. */
  agentTurnStaysActive?: boolean;
  /** Holds each pathless attachment chunk long enough to exercise upload cancellation. */
  attachmentUploadDelayMs?: number;
  /** Rejects pathless attachment chunks so composer recovery can be asserted. */
  attachmentUploadReject?: boolean | string;
  /** Starts with the configured language-model provider disabled and uncredentialed. */
  agentProviderUsable?: boolean;
  /** Seeds the global Memory switch; defaults to enabled. */
  memoryFeatureMode?: 'enabled' | 'disabled';
  /** Seeds the Memory status line's freshness, backlog, error, and stray-node count. */
  memoryLastSuccessfulRunAt?: number | null;
  memoryLastError?: string | null;
  memoryPendingJobs?: number;
  memoryStrayTaggedNodeCount?: number;
  /** Installs managed Skills; empty by default, since the pane must be right with none. */
  managedSkills?: ManagedSkillView[];
  /** Seeds the Linlab catalog rows and its freshness state. */
  managedCatalogEntries?: ManagedSkillCatalogEntryView[];
  managedCatalogStatus?: 'fresh' | 'cached' | 'unavailable';
  /** Seeds Settings-only application update status. */
  appUpdate?: AppUpdateView;
}

type E2EWindow = Window & {
  __LIN_E2E__?: {
    calls: Array<{ cmd: string; args: Record<string, unknown> }>;
    projection: () => unknown;
    clipboardText: () => string;
    emitAgentCoreNotification: (notification: unknown) => void;
    /** Registers a child Thread in the mock catalog, as a spawn would. */
    createMockSubagentThread: (input: {
      parentThreadId: string;
      name: string;
      active?: boolean;
      queuedWork?: boolean;
    }) => { id: string };
    /**
     * Seeds a Thread's canonical history. A drawer or a selection READS history
     * from the host, so a Turn only pushed as a notification is replaced by the
     * server's answer the moment anything loads that Thread.
     */
    setMockThreadTurns: (threadId: string, turns: readonly unknown[]) => void;
    /** Flips a mock Thread between idle and active, as a Turn boundary would. */
    setMockThreadActive: (threadId: string, active: boolean) => void;
    /**
     * Overrides one Agent's execution record — the canonical lifecycle state
     * the renderer's registry is built from. Every delegated mock Thread gets a
     * default record; this is for the states a Thread alone cannot express,
     * such as a user stop, a retained worktree, or foreground placement.
     */
    setMockSubagentExecution: (agentId: string, patch: Record<string, unknown>) => void;
    /** Applies one delayed or failed outcome to the next thread/start call. */
    setNextThreadStartBehavior: (behavior: { delayMs?: number; error?: string }) => void;
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
    automationRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T>;
    getProviderApiKey: (providerId: string) => Promise<{ providerId: string; apiKey?: string }>;
    onAgentCoreNotification: (listener: (notification: unknown) => void) => () => void;
    onAutomationNotification: (listener: (notification: unknown) => void) => () => void;
    onDocumentEvent: (listener: (event: unknown) => void) => () => void;
    outline: {
      commit: (request: {
        requestId: string;
        changeSet: MockChangeSet;
        undoGroup?: Record<string, unknown>;
      }) => Promise<unknown>;
      request: (request: { requestId: string; command: string; input: unknown }) => Promise<{
        protocolVersion: 1;
        requestId: string;
        command: string;
        ok: boolean;
        revision?: number;
        data?: unknown;
        error?: unknown;
      }>;
      cancel: (requestId: string) => void;
      subscribe: (
        subscription: { subscriptionId: string; input: Record<string, unknown> },
        listener: (record: Record<string, unknown>) => void,
      ) => () => void;
    };
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
    appInfo?: () => Promise<AppInfo>;
    appUpdate?: {
      get: () => Promise<AppUpdateView>;
      check: () => Promise<AppUpdateView>;
      setAutomaticChecksEnabled: (enabled: boolean) => Promise<AppUpdateView>;
      open: () => Promise<{ ok: boolean; destination?: 'download' | 'release'; error?: string }>;
      onChanged: (listener: (view: AppUpdateView) => void) => () => void;
    };
    onSettingsChanged?: (listener: () => void) => () => void;
    onSettingsNavigate?: (listener: (target: unknown) => void) => () => void;
    openLocalFile?: (options: { path: string; threadId?: string; attachmentId?: string }) => Promise<{ opened: boolean }>;
    revealLocalFile?: (options: { path: string; threadId?: string; attachmentId?: string }) => Promise<{ revealed: boolean }>;
    previewLocalFile?: (options: { id: string }) => Promise<{ thumbnailDataUrl: string | null }>;
    prepareLocalFile?: (options: { id: string }) => Promise<{
      file: {
        entryKind: 'file' | 'directory';
        path: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
        lastModified: number;
        thumbnailDataUrl?: string;
      } | null;
    }>;
    previewLocalFileReference?: (options: { path: string; threadId?: string; attachmentId?: string }) => Promise<{
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
    beginAttachmentUpload?: (input: {
      threadId: string;
      attachmentId: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
    }) => Promise<{ uploadId: string }>;
    appendAttachmentUpload?: (input: {
      threadId: string;
      attachmentId: string;
      uploadId: string;
      bytes: ArrayBuffer;
    }) => Promise<Record<string, never>>;
    finishAttachmentUpload?: (input: {
      threadId: string;
      attachmentId: string;
      uploadId: string;
    }) => Promise<{ id: string; mimeType: string; byteLength: number; fileName: string }>;
    abortAttachmentUpload?: (input: {
      threadId: string;
      attachmentId: string;
      uploadId: string;
    }) => Promise<Record<string, never>>;
    discardAttachmentResource?: (input: {
      threadId: string;
      ref: { id: string; mimeType: string; byteLength: number; fileName: string };
    }) => Promise<{ discarded: boolean }>;
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

// The real `ActionInvocationService`, bundled once per process for injection.
// `addInitScript(fn)` serializes its function, so the service cannot be
// imported from inside the fixture — but a second, hand-written action bridge
// would be exactly the duplicate implementation this plan removes.
let actionBridgeBundle: Promise<string> | null = null;
let viewConfigBridgeBundle: Promise<string> | null = null;

function bundledBridge(entry: string): Promise<string> {
  return (async () => {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [new URL(entry, import.meta.url).pathname],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      write: false,
    });
    return result.outputFiles[0]!.text;
  })();
}

function bundledActionBridge(): Promise<string> {
  actionBridgeBundle ??= bundledBridge('./actionBridgeEntry.ts');
  return actionBridgeBundle;
}

function bundledViewConfigBridge(): Promise<string> {
  viewConfigBridgeBundle ??= bundledBridge('./viewConfigBridgeEntry.ts');
  return viewConfigBridgeBundle;
}

export async function installElectronMock(page: Page, options: MockFixtureOptions = {}) {
  const [actionBridge, viewConfigBridge] = await Promise.all([
    bundledActionBridge(),
    bundledViewConfigBridge(),
  ]);
  await page.addInitScript({ content: actionBridge });
  await page.addInitScript({ content: viewConfigBridge });
  await page.addInitScript(({ assetUrlPrefix, ids, options, queryChildLimit }) => {
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
    const mockAssetUrl = (assetId: string) => `${assetUrlPrefix}${encodeURIComponent(assetId)}`;
    const mockAssetSourceUri = (assetId: string) => `asset://local/${encodeURIComponent(assetId)}`;
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
    const focusedTrajectoryRecord = (
      records: Array<Record<string, unknown>>,
      turnId: string,
    ): Record<string, unknown> | null => {
      const candidates = records.filter((record) => record.turnId === turnId);
      for (const kind of ['assistant', 'tool', 'delegation', 'compaction', 'context', 'input']) {
        const match = candidates.find((record) => record.kind === kind);
        if (match) return match;
      }
      return candidates[0] ?? null;
    };
    const trajectoryOrderKey = (turnIndex: number, stepIndex: number): string => {
      const component = (value: number) => value.toString(36).padStart(13, '0');
      return [turnIndex, 1, stepIndex, 0, 0, 0].map(component).join(':');
    };
    type MockNode = {
      id: string;
      type?: string;
      parentId?: string;
      children: string[];
      content: RichText;
      description?: string;
      templateId?: string;
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
	      queryTagDefId?: string;
	      queryFieldDefId?: string;
	      queryTargetId?: string;
	      targetId?: string;
	      codeLanguage?: string;
	      configKey?: string;
	      refRole?: string;
	    };
    type CreateNodeTree = {
      content: RichText;
      children: CreateNodeTree[];
      description?: string;
      type?: string;
      codeLanguage?: string;
      tags?: string[];
      fields?: Array<{ name: string; value: string }>;
      checkbox?: boolean;
      done?: boolean;
    };

    const win = window as E2EWindow;
    const rich = (text: string): RichText => ({ text, marks: [], inlineRefs: [] });
    const nodes = new Map<string, MockNode>();
    let now = 1_800_000_000_000;
    let sequence = 0;
    let automationRunEventSequence = 0;
    // The mock doesn't track per-command change sets, so every command/event ships
    // a `full` ProjectionUpdate (the renderer rebuilds from it). Revision advances
    // monotonically to mirror the real emit chain; the delta path is unit-tested
    // separately (reduceProjection.test.ts).
	    let revision = 0;
    let outlineEventSequence = 0;
    let initialOutlineShowPending = true;
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
    let initialThreadStartDelayMs = options.initialThreadStartDelayMs ?? 0;
    let nextThreadStartBehavior: { delayMs: number; error: string | null } | null = null;
    const attachmentUploads = new Map<string, {
      threadId: string;
      attachmentId: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      receivedBytes: number;
      chunks: Uint8Array[];
    }>();
    const agentCoreListeners: Array<(notification: unknown) => void> = [];
    const automationListeners: Array<(notification: unknown) => void> = [];
    const documentListeners: Array<(event: unknown) => void> = [];
    const outlineSubscriptions = new Map<
      string,
      { input: Record<string, unknown>; listener: (record: Record<string, unknown>) => void }
    >();
    const oauthListeners: Array<(envelope: unknown) => void> = [];
    const settingsChangedListeners: Array<() => void> = [];
    const appUpdateListeners: Array<(view: AppUpdateView) => void> = [];
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
    if (options.oauthApiKeyProvider) providerApiKeys.set('openrouter', 'sk-or-saved');
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
    // Past RECENT_MODEL_COUNT, so the model submenu truncates and offers to expand.
    if (options.manyModelProvider) {
      agentSettings.providers.push({
        providerId: 'many-models',
        baseUrl: '',
        enabled: true,
        hasApiKey: true,
        hasEnvApiKey: false,
        auth: { authKind: 'api-key', credentialed: true, hasStoredKey: true },
      });
      agentSettings.availableProviders.push({
        providerId: 'many-models',
        authKind: 'api-key',
        credentialed: true,
        detected: true,
        connectionStatus: 'ready',
        hasEnvApiKey: false,
        envKeyNames: [],
        defaultBaseUrl: 'https://many.example/v1',
        models: Array.from({ length: 24 }, (_, index) => ({
          id: `many-${index + 1}`,
          name: `Many Model ${index + 1}`,
          reasoning: false,
          supportedThinkingLevels: ['off'],
          contextWindow: 128_000,
          maxTokens: 4096,
        })),
      });
    }
    if (options.oauthApiKeyProvider) {
      agentSettings.providers.push({
        providerId: 'openrouter',
        baseUrl: '',
        enabled: true,
        hasApiKey: true,
        hasEnvApiKey: false,
        auth: {
          authKind: 'oauth',
          credentialed: true,
          hasStoredKey: true,
        },
      });
      agentSettings.availableProviders.push({
        providerId: 'openrouter',
        authKind: 'oauth',
        hasEnvApiKey: false,
        envKeyNames: [],
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        models: [{
          id: 'openai/gpt-5.4',
          name: 'GPT-5.4',
          reasoning: true,
          supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
          contextWindow: 256_000,
          maxTokens: 8192,
        }],
      });
    }
    const agentCapabilities = {
      blocks: [...(options.capabilityBlocks ?? [])] as string[],
      diagnostics: [] as Array<{ ruleValue: string; code: string; message: string }>,
    };
    // The Memory group polls `memory_settings_get` on an interval for as long as
    // its pane is mounted. Without a branch for it the mock's unhandled-invoke
    // throw became a red alert on the pane every few seconds — including in the
    // design-system probes, which were photographing that banner rather than the
    // pane. Deterministic: no timers, no worker, and the counters only move when
    // a spec drives them.
    const memorySettings = {
      status: {
        featureMode: options.memoryFeatureMode ?? 'enabled',
        featureModeGeneration: 1,
        resetEpoch: 0,
        memoryVisibilityGeneration: 1,
        lastSuccessfulRunAt: options.memoryLastSuccessfulRunAt ?? null,
        lastError: options.memoryLastError ?? null,
        pendingJobs: options.memoryPendingJobs ?? 0,
        strayTaggedNodeCount: options.memoryStrayTaggedNodeCount ?? 0,
      },
      thread: null as { threadId: string; mode: string } | null,
    };
    // Managed Skills default to none installed and an empty catalog: the pane has
    // to be correct in that state, and a spec that wants rows opts into them.
    const managedSkills = (options.managedSkills ?? []).map((skill) => ({ ...skill }));
    const managedCatalogEntries = options.managedCatalogEntries ?? [];
    const IDENTITY_COLOR_NAMES = ['orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];
    const agentIdentityEntries = [
      { agentType: 'main', persona: 'Aspen', color: 'teal', source: 'built-in' },
      { agentType: 'general-purpose', persona: 'Bruno', color: 'amber', source: 'built-in' },
      { agentType: 'explore', persona: 'Rena', color: 'orange', source: 'built-in' },
      { agentType: 'plan', persona: 'Ada', color: 'blue', source: 'built-in' },
    ];
    const agentRoles: Array<{
      name: string; layer: string; description: string; developerInstructions: string;
      persona: string | null; color: string | null;
      tools: string[] | null; skills: string[] | null;
    }> = [{
      name: 'auditor',
      layer: 'user',
      description: 'Audits a change before it is proposed.',
      developerInstructions: 'Read the diff and report what is wrong.',
      persona: 'Wren',
      color: 'violet',
      tools: null,
      skills: null,
    }];
    const agentPresentationOverrides: Array<{
      agentType: string; layer: string; persona: string | null; color: string | null;
    }> = [];
    const agentExecutionSelections: Array<{
      agentType: string;
      layer: 'user' | 'project';
      modelProvider: string | null;
      model: string | null;
      reasoningEffort: string | null;
    }> = [];
    const agentProfile = {
      name: 'default',
      layer: null as string | null,
      developerInstructions: null as string | null,
      model: null as string | null,
      reasoningEffort: null as string | null,
      tools: null as string[] | null,
      skills: null as string[] | null,
    };
    const agentCapabilityCatalog = {
      tools: [
        { key: 'file_read', description: 'Read a file.' },
        { key: 'file_write', description: 'Write a file.' },
        { key: 'bash', description: 'Run a command.' },
      ],
      skills: ['review', 'summarize'],
    };
    const agentBuiltInDefinitions = [
      { agentType: 'general-purpose', description: 'General-purpose agent.', developerInstructions: 'Do the task fully.' },
      { agentType: 'explore', description: 'Fast codebase explorer.', developerInstructions: 'Search, never write.' },
      { agentType: 'plan', description: 'Software architect.', developerInstructions: 'Design, never write.' },
    ];
    const applyAgentExecution = (agentType: string, layer: 'user' | 'project', value: unknown) => {
      if (value === undefined) return;
      const draft = value as {
        modelProvider?: string | null;
        model?: string | null;
        reasoningEffort?: string | null;
      };
      const index = agentExecutionSelections.findIndex((row) => (
        row.agentType === agentType && row.layer === layer
      ));
      if (!draft.model && !draft.reasoningEffort) {
        if (index >= 0) agentExecutionSelections.splice(index, 1);
        return;
      }
      const row = {
        agentType,
        layer,
        modelProvider: draft.modelProvider ?? null,
        model: draft.model ?? null,
        reasoningEffort: draft.reasoningEffort ?? null,
      };
      if (index >= 0) agentExecutionSelections[index] = row;
      else agentExecutionSelections.push(row);
    };
    const agentIdentityView = () => ({
      entries: [
        ...agentIdentityEntries,
        ...agentRoles.map((role) => ({
          agentType: role.name,
          persona: role.persona ?? role.name,
          color: role.color ?? 'green',
          source: role.layer,
        })),
      ],
      roles: agentRoles,
      presentationOverrides: agentPresentationOverrides,
      executionSelections: agentExecutionSelections,
      profile: { ...agentProfile },
      builtInDefinitions: agentBuiltInDefinitions,
      capabilities: agentCapabilityCatalog,
    });
    const agentSkills = [{
      name: 'workspace-review',
      source: 'project',
      rootDir: '/mock/workspace/.agents/skills/workspace-review',
      skillFile: '/mock/workspace/.agents/skills/workspace-review/SKILL.md',
      description: 'Review workspace conventions before automatic use.',
      hasUserSpecifiedDescription: true,
      userInvocable: true,
      modelInvocable: true,
      canUndoLastAgentEdit: false,
      contentHash: 'hash-workspace-review-v1',
      allowedTools: [],
      argumentNames: [],
      execution: 'inline',
      contentLength: 64,
      body: 'Review workspace conventions before automatic use.',
    }];
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    let appUpdate = clone(options.appUpdate ?? {
      currentVersion: '0.1.0',
      automaticChecksEnabled: true,
      phase: 'idle',
      lastSuccessfulCheckAt: now,
      availableRelease: null,
      manualError: null,
    } satisfies AppUpdateView);
    const delay = (ms: number) => new Promise((resolve) => { window.setTimeout(resolve, ms); });
    type MockThreadInputAuthor =
      | { kind: 'reader' }
      | { kind: 'agent'; threadId: string }
      | { kind: 'host' }
      | { kind: 'feature'; feature: string; ref?: string }
      | { kind: 'unknown' };
    type MockAgentAttachmentKind = 'attachment';
    type MockThreadUserContent = Array<
      | { type: 'text'; text: string }
      | { type: 'nodeReference'; nodeId: string; note?: string }
      | {
          type: MockAgentAttachmentKind;
          id: string;
          name: string;
          mimeType: string;
          sizeBytes: number;
          source:
            | { kind: 'localFile'; path: string }
            | {
                kind: 'resource';
                ref: { id: string; mimeType: string; byteLength: number; fileName: string };
              };
        }
    >;
    type MockThreadItemBase = {
      id: string;
      provenance: { originThreadId: string; originTurnId: string; originItemId: string };
    };
    type MockThreadItem = MockThreadItemBase & (
      | {
          type: 'userMessage';
          author: MockThreadInputAuthor;
          clientId: string | null;
          acceptedAt: number;
          content: MockThreadUserContent;
        }
      | {
          type: 'agentMessage';
          text: string;
          phase: 'commentary' | 'final_answer' | 'interrupted' | null;
          memoryCitation: null;
        }
    );
    type MockTurn = {
      id: string;
      items: MockThreadItem[];
      itemsView: 'full';
      provenance: {
        originThreadId: string;
        originTurnId: string;
        trigger:
          | { kind: 'user' }
          | { kind: 'continuation'; sourceTurnId: string }
          | { kind: 'feature'; feature: 'automation'; ref: string };
      };
      status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
      error: { message: string } | null;
      execution: {
        modelProvider: string;
        model: string;
        reasoningEffort: string;
        diagnosticsRef: null;
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
      threadSource: 'user' | 'automation';
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
      const mockToolTasks = new Map<string, Record<string, unknown>>();
    type MockAutomation = {
      id: string;
      name: string;
      prompt: string;
      schedule: { rrule: string; timezone: string };
      destination: { kind: 'standalone' } | { kind: 'existingThread'; threadId: string };
      projectBindings: Array<{ id: string; cwd: string; executionMode: 'local' | 'worktree' }>;
      configuration: {
        modelProvider: string | null;
        model: string | null;
        reasoningEffort: string | null;
      };
      status: 'active' | 'paused' | 'completed';
      revision: number;
      nextOccurrenceAt: number | null;
      createdAt: number;
      updatedAt: number;
    };
    type MockAutomationRun = {
      id: string;
      automationId: string;
      automationRevision: number;
      eventSequence: number;
      scheduledFor: number;
      projectBindingKey: string;
      snapshot: {
        automationName: string;
        prompt: string;
        schedule: MockAutomation['schedule'];
        destination: MockAutomation['destination'];
        projectBinding: MockAutomation['projectBindings'][number] | null;
        configuration: MockAutomation['configuration'];
      };
      state: 'pending' | 'dispatched' | 'failed' | 'omitted';
      threadId: string | null;
      turnId: string | null;
      worktree: null;
      omission: null;
      error: string | null;
      readAt: number | null;
      pinned: boolean;
      createdAt: number;
      updatedAt: number;
    };
    const mockAutomations: MockAutomation[] = [];
    const mockAutomationRuns: MockAutomationRun[] = [];
    const mockThreadConfigurations = new Map<string, {
      modelProvider: string;
      model: string;
      reasoningEffort: string;
    }>();
    const nextCanonicalId = () => `01910000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
    const nextCanonicalNodeId = () => `node:00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
    const threadById = (threadId: string) => {
      const thread = mockThreads.find((candidate) => candidate.id === threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      return thread;
    };
    const emitAgentCoreNotification = (notification: unknown) => {
      const event = notification as {
        type?: unknown;
        threadId?: unknown;
        turnId?: unknown;
        turn?: unknown;
        thread?: unknown;
        task?: unknown;
      };
      // A started Thread is in the catalog, so the mock's catalog learns it
      // here rather than in every test that announces one. A delegated child
      // also has an execution record by then — the host publishes its start
      // only after that record commits — so the registry hears about it too.
      if (
        event.type === 'thread/started'
        && event.thread !== null
        && typeof event.thread === 'object'
        && !mockThreads.some((candidate) => candidate.id === (event.thread as MockThread).id)
      ) {
        mockThreads.push(clone(event.thread) as unknown as MockThread);
      }
      if (
        event.type === 'toolTask/changed'
        && event.task !== null
        && typeof event.task === 'object'
      ) {
        const task = clone(event.task) as Record<string, unknown>;
        mockToolTasks.set(String(task.taskId), task);
      }
      if (
        (event.type === 'turn/started' || event.type === 'turn/completed')
        && typeof event.threadId === 'string'
        && typeof event.turnId === 'string'
        && event.turn !== null
        && typeof event.turn === 'object'
      ) {
        const turns = mockTurns.get(event.threadId);
        if (turns) {
          const turn = clone(event.turn) as unknown as MockTurn;
          const index = turns.findIndex((candidate) => candidate.id === event.turnId);
          if (index < 0) turns.push(turn);
          else turns[index] = turn;
        }
      }
      for (const listener of agentCoreListeners) listener(clone(notification));
      // A delegated child's Turn boundary IS an execution change: the host
      // advances the record's current generation Turn and announces it.
      if (
        (event.type === 'turn/started' || event.type === 'turn/completed')
        && typeof event.threadId === 'string'
        && typeof event.turnId === 'string'
      ) {
        mockCurrentTurnByThread.set(event.threadId, event.turnId);
      }
      if (
        (event.type === 'thread/started' || event.type === 'turn/started' || event.type === 'turn/completed')
        && typeof event.threadId === 'string'
      ) {
        const execution = subagentExecutionFor(event.threadId);
        if (execution) {
          for (const listener of agentCoreListeners) {
            listener(clone({
              type: 'subagent/execution/changed',
              threadId: execution.parentThreadId,
              execution,
            }));
          }
        }
      }
    };
    const emitAutomationNotification = (notification: unknown) => {
      for (const listener of automationListeners) listener(clone(notification));
    };
    const mockQueuedWorkThreadIds = new Set<string>();
    const mockSubagentExecutionPatches = new Map<string, Record<string, unknown>>();
    /** The generation Turn a delegated Thread is on, as its record would say. */
    const mockCurrentTurnByThread = new Map<string, string>();
    /**
     * The canonical Agent execution record for a delegated mock Thread.
     *
     * Every delegated child has one in the real host, so the mock derives a
     * default from the Thread rather than making each test build one; a test
     * that needs a state the Thread cannot express patches it.
     */
    const subagentExecutionFor = (agentId: string): Record<string, unknown> | null => {
      const thread = mockThreads.find((candidate) => candidate.id === agentId);
      if (!thread || thread.parentThreadId === null) return null;
      const isolatedSkill = thread.source === 'agent.skill';
      const turns = mockTurns.get(agentId) ?? [];
      const latestTurn = turns.at(-1) ?? null;
      const terminalStatus = latestTurn?.status === 'completed'
        ? 'finished'
        : latestTurn?.status === 'failed'
          ? 'failed'
          : latestTurn?.status === 'interrupted'
            ? 'interrupted'
            : null;
      const terminalError = latestTurn?.status === 'failed' && latestTurn.error
        ? {
          code: latestTurn.error.code ?? 'subagent_failed',
          messagePreview: latestTurn.error.message,
          omittedBytes: 0,
        }
        : null;
      const patch = mockSubagentExecutionPatches.get(agentId) ?? {};
      const projectedTerminalStatus = (patch.terminalStatus ?? terminalStatus) as string | null;
      const projectedTerminalError = patch.terminalError ?? terminalError;
      const projectedNotificationState = String(patch.notificationState ?? 'none');
      const projectedDeliveryTurnId = typeof patch.deliveryTurnId === 'string' ? patch.deliveryTurnId : null;
      const latestTrigger = latestTurn?.provenance.trigger;
      const projectedParentItemId = String(
        patch.parentItemId
        ?? (latestTrigger?.kind === 'subagent' ? latestTrigger.parentItemId : `${thread.id}-parent-item`),
      );
      const projectedStopProvenance = String(patch.stopProvenance ?? 'none');
      const generationReceipts = projectedTerminalStatus === null
        ? []
        : [{
            generation: Number(patch.generation ?? 1),
            turnId: String(patch.currentTurnId ?? latestTurn?.id ?? `${thread.id}-generation-1`),
            parentItemId: projectedParentItemId,
            terminalStatus: projectedTerminalStatus,
            stopProvenance: projectedStopProvenance,
            durationMs: latestTurn?.durationMs ?? null,
            error: projectedTerminalError,
            partialOutputAvailable: latestTurn?.items.some((item) => (
              item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim().length > 0
            )) ?? false,
            parentThreadId: thread.parentThreadId,
            notificationState: projectedNotificationState,
            deliveryTurnId: projectedDeliveryTurnId,
          }];
      return {
        agentId: thread.id,
        parentThreadId: thread.parentThreadId,
        description: thread.agentNickname ?? thread.name ?? '',
        agentType: isolatedSkill ? 'isolated-skill' : thread.agentRole ?? 'general-purpose',
        runMode: isolatedSkill ? 'foreground' : 'background',
        generation: 1,
        currentTurnId: mockCurrentTurnByThread.get(agentId)
          ?? latestTurn?.id
          ?? `${thread.id}-generation-1`,
        parentItemId: projectedParentItemId,
        stopProvenance: projectedStopProvenance,
        terminalStatus: projectedTerminalStatus,
        notificationState: 'none',
        terminalError: projectedTerminalError,
        deliveryTurnId: null,
        deliveryClass: null,
        eligibleAfterGeneration: null,
        coverageDisposition: null,
        omittedOutputBytes: 0,
        omittedOutputTokens: 0,
        generationReceipts,
        notificationCutoff: 'open',
        executionMode: 'ordinary',
        settlementCoverage: null,
        executionSelectionFallback: null,
        worktree: null,
        createdAt: thread.createdAt,
        updatedAt: latestTurn?.completedAt ?? thread.updatedAt,
        ...patch,
      };
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
    const previewSmallPngBytes = () => {
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    };
    const previewImageBytes = (filename?: string) => (
      filename?.toLowerCase().includes('small-preview')
        ? previewSmallPngBytes()
        : previewPngBytes()
    );
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
      const node: MockNode = {
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
      };
      nodes.set(id, node);
      return node;
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
    const isInTrash = (nodeId: string) => {
      const visited = new Set<string>();
      let currentId: string | undefined = nodeId;
      while (currentId) {
        if (currentId === ids.trash) return true;
        if (visited.has(currentId)) return false;
        visited.add(currentId);
        currentId = nodes.get(currentId)?.parentId;
      }
      return false;
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
      const nodeId = id ?? nextCanonicalNodeId();
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
    const tagExtendsChain = (tagId: string) => {
      const chain: string[] = [];
      const visited = new Set<string>();
      let currentId: string | undefined = tagId;
      while (currentId && !visited.has(currentId)) {
        const current = nodes.get(currentId);
        if (current?.type !== 'tagDef') break;
        visited.add(currentId);
        chain.push(currentId);
        currentId = current.extends;
      }
      return chain;
    };
    const tagTemplateContentNodeIds = (tagId: string) => (
      tagExtendsChain(tagId).reverse().flatMap((chainTagId) => (
        nodes.get(chainTagId)?.children.filter((childId) => {
          const type = nodes.get(childId)?.type;
          return type === undefined || type === 'codeBlock';
        }) ?? []
      ))
    );
    const cloneTemplateContentNode = (parentId: string, templateId: string) => {
      const parent = nodes.get(parentId);
      const template = nodes.get(templateId);
      if (!parent || !template) return;
      if (parent.children.some((childId) => nodes.get(childId)?.templateId === templateId)) return;
      const cloneId = `template-${++sequence}`;
      makeNode(cloneId, template.content.text, {
        type: template.type,
        parentId,
        templateId,
        showCheckbox: false,
      });
      const created = nodes.get(cloneId)!;
      created.content = clone(template.content);
      created.description = template.description;
      created.codeLanguage = template.codeLanguage;
      appendChild(parentId, cloneId);
    };
    const tagTemplateBackfillPlan = (tagId: string) => {
      const templateNodeIds = tagTemplateContentNodeIds(tagId);
      const matchingAppliedTagIds = new Set([...nodes.values()]
        .filter((node) => node.type === 'tagDef' && tagExtendsChain(node.id).includes(tagId))
        .map((node) => node.id));
      const targets = [...nodes.values()].flatMap((node) => {
        if (
          node.locked
          || isInTrash(node.id)
          || !node.tags.some((appliedTagId) => matchingAppliedTagIds.has(appliedTagId))
        ) return [];
        if (node.type === 'tagDef' && node.id === ids.dayTag) return [];
        const existingTemplateIds = new Set(node.children.flatMap((childId) => {
          const templateId = nodes.get(childId)?.templateId;
          return templateId ? [templateId] : [];
        }));
        const missingTemplateNodeIds = templateNodeIds.filter((templateId) => !existingTemplateIds.has(templateId));
        return missingTemplateNodeIds.length > 0 ? [{ nodeId: node.id, templateNodeIds: missingTemplateNodeIds }] : [];
      });
      return {
        nodeCount: targets.length,
        additionCount: targets.reduce((count, target) => count + target.templateNodeIds.length, 0),
        targets,
      };
    };
    const applyPasteMetadata = (
      nodeId: string,
      metadata: {
        tags?: string[];
        fields?: Array<{ name: string; value: string }>;
        metadata?: { pasteTags?: string[]; pasteFields?: Array<{ name: string; value: string }> };
      },
    ) => {
      const owner = nodes.get(nodeId);
      if (!owner) return;
      const tagNames = [
        ...(metadata.tags ?? []),
        ...(metadata.metadata?.pasteTags ?? []),
      ];
      const fields = [
        ...(metadata.fields ?? []),
        ...(metadata.metadata?.pasteFields ?? []),
      ];
      for (const rawName of tagNames) {
        const name = rawName.trim();
        if (!name) continue;
        const existing = [...nodes.values()].find((node) => (
          node.type === 'tagDef' && node.content.text.trim().toLowerCase() === name.toLowerCase()
        ));
        const tagId = existing?.id ?? createTag(name).focus?.nodeId;
        if (tagId && !owner.tags.includes(tagId)) owner.tags.push(tagId);
      }
      for (const field of fields) {
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
    const createTree = (
      parentId: string,
      tree: CreateNodeTree[],
      index: number | null = null,
      firstId?: string,
    ) => {
      let lastId: string | null = null;
      tree.forEach((item, offset) => {
        const nodeId = createNode(
          parentId,
          index === null ? null : index + offset,
          item.content.text,
          {},
          offset === 0 ? firstId : undefined,
        );
        const node = nodes.get(nodeId);
        if (node) {
          node.content = clone(item.content);
          const description = item.description?.trim();
          if (description) node.description = description;
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
        removeNode(childId);
	      }
	      const survivingEntryId = fieldEntry.parentId && fieldEntry.fieldDefId
	        ? commitFieldSlot(fieldEntry.parentId, fieldEntry.fieldDefId, fieldEntryId)
	        : fieldEntryId;
	      return outcome({ nodeId: survivingEntryId ?? fieldEntry.parentId ?? fieldEntryId, selectAll: false });
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
      removeNode(valueId);
      const survivingEntryId = fieldEntry?.parentId && fieldEntry.fieldDefId
        ? commitFieldSlot(fieldEntry.parentId, fieldEntry.fieldDefId, fieldEntryId)
        : fieldEntryId;
      return outcome({ nodeId: survivingEntryId ?? fieldEntry?.parentId ?? fieldEntryId ?? valueId, selectAll: false });
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
	    const duplicateSubtree = (nodeId: string, parentId: string, index: number | null): string | null => {
	      const node = nodes.get(nodeId);
      if (!node) return null;
      const cloneId = `${nodeId}-copy-${++sequence}`;
      makeNode(cloneId, node.content.text, {
        type: node.type,
        parentId,
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
        templateId: node.templateId,
      });
      const cloneNode = nodes.get(cloneId)!;
      cloneNode.content = clone(node.content);
      appendChild(parentId, cloneId, index);
      for (const childId of node.children) duplicateSubtree(childId, cloneId, null);
      return cloneId;
    };
	    const duplicateNode = (nodeId: string) => {
	      const node = nodes.get(nodeId);
      if (!node?.parentId) return null;
      const parent = nodes.get(node.parentId);
      const index = parent ? parent.children.indexOf(nodeId) + 1 : null;
      return duplicateSubtree(nodeId, node.parentId, index);
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
    const fieldSlotEntry = (ownerId: string, fieldDefId: string, preferredEntryId?: string) => {
      const preferred = preferredEntryId ? nodes.get(preferredEntryId) : undefined;
      if (
        preferred?.type === 'fieldEntry'
        && preferred.parentId === ownerId
        && preferred.fieldDefId === fieldDefId
      ) return preferred;
      const owner = nodes.get(ownerId);
      return owner?.children
        .map((childId) => nodes.get(childId))
        .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === fieldDefId);
    };
    const ensureFieldSlotEntry = (ownerId: string, fieldDefId: string, preferredEntryId?: string) => {
      const existing = fieldSlotEntry(ownerId, fieldDefId, preferredEntryId);
      if (existing) return existing;
      const fieldDef = nodes.get(fieldDefId);
      const entryId = inlineField(
        ownerId,
        null,
        fieldDef?.content.text ?? '',
        fieldDef?.fieldType ?? 'plain',
        fieldDefId,
      );
      return nodes.get(entryId)!;
    };
    const tagProjectsField = (ownerId: string, fieldDefId: string) => {
      const owner = nodes.get(ownerId);
      for (const appliedTagId of owner?.tags ?? []) {
        const visited = new Set<string>();
        let currentTagId: string | undefined = appliedTagId;
        while (currentTagId && !visited.has(currentTagId)) {
          visited.add(currentTagId);
          const tag = nodes.get(currentTagId);
          if (tag?.type !== 'tagDef') break;
          if (tag.children.some((childId) => {
            const child = nodes.get(childId);
            return child?.type === 'fieldEntry' && child.fieldDefId === fieldDefId;
          })) return true;
          currentTagId = tag.extends;
        }
      }
      return false;
    };
    const commitFieldSlot = (ownerId: string, fieldDefId: string, preferredEntryId?: string) => {
      const entry = fieldSlotEntry(ownerId, fieldDefId, preferredEntryId);
      if (!entry) return undefined;
      for (const childId of [...entry.children]) {
        const child = nodes.get(childId);
        if (
          child?.type === undefined
          && child.content.text.trim().length === 0
          && child.content.inlineRefs.length === 0
          && child.children.length === 0
          && !child.description
        ) removeNode(childId);
      }
      if (entry.children.length > 0 || !tagProjectsField(ownerId, fieldDefId)) return entry.id;
      removeNode(entry.id);
      return undefined;
    };
    const updateFieldSlot = (args: Record<string, unknown>) => {
      const ownerId = String(args.ownerId);
      const fieldDefId = String(args.fieldDefId);
      const kind = String(args.kind);
      const preferredEntryId = typeof args.entryId === 'string' ? args.entryId : undefined;
      const proposedId = typeof args.id === 'string' ? args.id : undefined;
      const currentEntry = fieldSlotEntry(ownerId, fieldDefId, preferredEntryId);

      if (kind === 'commit') {
        const survivingEntryId = commitFieldSlot(ownerId, fieldDefId, preferredEntryId);
        return outcome({ nodeId: survivingEntryId ?? ownerId, selectAll: false });
      }
      if (kind === 'acceptDefault') {
        if (currentEntry) return outcome({ nodeId: currentEntry.id, selectAll: false });
        const owner = nodes.get(ownerId);
        let templateEntry: MockNode | undefined;
        for (const appliedTagId of owner?.tags ?? []) {
          const visited = new Set<string>();
          let currentTagId: string | undefined = appliedTagId;
          while (currentTagId && !visited.has(currentTagId) && !templateEntry) {
            visited.add(currentTagId);
            const tag = nodes.get(currentTagId);
            if (tag?.type !== 'tagDef') break;
            templateEntry = tag.children
              .map((childId) => nodes.get(childId))
              .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === fieldDefId);
            currentTagId = tag.extends;
          }
          if (templateEntry) break;
        }
        if (!templateEntry?.children.length) return outcome({ nodeId: ownerId, selectAll: false });
        const entry = ensureFieldSlotEntry(ownerId, fieldDefId);
        for (const valueId of templateEntry.children) {
          const value = nodes.get(valueId);
          if (!value) continue;
          createNode(entry.id, null, value.content.text, {
            type: value.type,
            targetId: value.targetId,
            codeLanguage: value.codeLanguage,
            description: value.description,
          });
        }
        return outcome({ nodeId: entry.id, selectAll: false });
      }
      if (kind === 'appendText') {
        const text = String(args.text ?? '').trim();
        if (!text) {
          const survivingEntryId = commitFieldSlot(ownerId, fieldDefId, preferredEntryId);
          return outcome({ nodeId: survivingEntryId ?? ownerId, selectAll: false });
        }
        const entry = currentEntry ?? ensureFieldSlotEntry(ownerId, fieldDefId, preferredEntryId);
        if (args.collect === true) return createCollectedOption(entry.id, text, proposedId);
        createNode(entry.id, null, text, {}, proposedId);
        return outcome({ nodeId: entry.id, selectAll: false });
      }
      if (kind === 'appendReference') {
        const entry = currentEntry ?? ensureFieldSlotEntry(ownerId, fieldDefId, preferredEntryId);
        const targetId = resolveReferenceTargetId(String(args.targetId)) ?? String(args.targetId);
        const target = nodes.get(targetId);
        createNode(entry.id, null, target?.content.text ?? '', {
          type: 'reference',
          targetId,
        }, proposedId);
        return outcome({ nodeId: entry.id, selectAll: false });
      }
      if (kind === 'selectOption') {
        const entry = currentEntry ?? ensureFieldSlotEntry(ownerId, fieldDefId, preferredEntryId);
        return selectOption(entry.id, String(args.optionNodeId), proposedId);
      }
      if (kind === 'appendNodes') {
        const trees = Array.isArray(args.nodes) ? args.nodes as CreateNodeTree[] : [];
        if (trees.length === 0) return outcome({ nodeId: currentEntry?.id ?? ownerId, selectAll: false });
        const entry = currentEntry ?? ensureFieldSlotEntry(ownerId, fieldDefId, preferredEntryId);
        const firstIndex = entry.children.length;
        createTree(entry.id, trees, null, proposedId);
        const firstValue = nodes.get(entry.children[firstIndex] ?? '');
        for (const tagId of Array.isArray(args.firstTagIds) ? args.firstTagIds : []) {
          if (firstValue && typeof tagId === 'string' && !firstValue.tags.includes(tagId)) firstValue.tags.push(tagId);
        }
        return outcome({ nodeId: entry.id, selectAll: false });
      }
      if (kind === 'appendField') {
        const entry = currentEntry ?? ensureFieldSlotEntry(ownerId, fieldDefId, preferredEntryId);
        const nestedFieldDefId = `field-def-${++sequence}`;
        const nestedFieldType = String(args.fieldType ?? 'plain');
        makeNode(nestedFieldDefId, String(args.name ?? '').trim(), {
          type: 'fieldDef',
          fieldType: nestedFieldType,
          parentId: ids.schema,
          nullable: true,
        });
        appendChild(ids.schema, nestedFieldDefId);
        const nestedEntryId = proposedId ?? `field-entry-${++sequence}`;
        makeNode(nestedEntryId, '', {
          type: 'fieldEntry',
          parentId: entry.id,
          fieldDefId: nestedFieldDefId,
          fieldType: nestedFieldType,
        });
        appendChild(entry.id, nestedEntryId);
        return outcome({
          nodeId: nestedEntryId,
          parentId: entry.id,
          placement: { kind: 'all' },
          selectAll: true,
          surface: 'field-name',
        });
      }
      return outcome();
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
	    const addMissingTableDisplayFields = (nodeId: string, view: MockNode) => {
	      const owner = nodes.get(nodeId);
	      const schema = nodes.get(ids.schema);
	      if (!owner || !schema) return;
	      const helpers = (globalThis as typeof globalThis & {
	        __linViewConfigHelpers?: {
	          missingDisplayOrderPlan: <T extends { id: string; displayOrder?: number }>(fields: readonly T[]) => {
	            assignments: Array<{ field: T; order: number }>;
	            nextOrder: number;
	          };
	          tableDisplayFieldInitialization: (params: {
	            byId: Map<string, MockNode>;
	            owner: MockNode;
	            schema: MockNode;
	          }) => { displayFields: MockNode[]; missingFieldIds: string[] } | null;
	        };
	      }).__linViewConfigHelpers;
	      if (!helpers) throw new Error('Missing shared view configuration helpers');
	      const initialization = helpers.tableDisplayFieldInitialization({
	        byId: nodes,
	        owner,
	        schema,
	      });
	      if (!initialization) return;
	      const orderPlan = helpers.missingDisplayOrderPlan(initialization.displayFields);
	      orderPlan.assignments.forEach(({ field, order }) => { field.displayOrder = order; });
	      let nextOrder = orderPlan.nextOrder;
	      for (const fieldId of initialization.missingFieldIds) {
	        const displayId = `display-${++sequence}`;
	        makeNode(displayId, '', {
	          type: 'displayField',
	          parentId: view.id,
	          displayField: fieldId,
	          displayVisible: true,
	          displayOrder: nextOrder++,
	        });
	        appendChild(view.id, displayId);
	      }
	    };

	    makeNode(ids.workspace, 'Workspace', { locked: true });
    makeNode(ids.root, 'Root', { parentId: ids.workspace, locked: true });
    makeNode(ids.daily, 'Daily Notes', { parentId: ids.root, locked: true });
    makeNode(ids.library, 'Library', { parentId: ids.root, locked: true });
    makeNode(ids.schema, 'Schema', { parentId: ids.root, locked: true });
    makeNode(ids.searches, 'Saved searches', { parentId: ids.root, locked: true });
	    const truncatedQueryRuleIds = options.truncatedSearchQuery
	      ? Array.from({ length: queryChildLimit + 1 }, (_, index) => `recents-query-rule-${index}`)
	      : [];
	    makeNode(ids.recents, 'Recents', {
	      type: 'search',
	      parentId: ids.searches,
	      locked: !options.truncatedSearchQuery,
	    });
	    makeNode('recents-view', '', { type: 'viewDef', parentId: ids.recents, viewMode: 'list', children: ['recents-sort'] });
	    makeNode('recents-sort', '', {
	      type: 'sortRule',
	      parentId: 'recents-view',
	      sortField: 'sys:updatedAt',
	      sortDirection: 'desc',
	    });
	    makeNode('recents-query', options.truncatedSearchQuery ? '' : '30', {
	      type: 'queryCondition',
	      parentId: ids.recents,
	      ...(options.truncatedSearchQuery
	        ? { queryLogic: 'AND', children: truncatedQueryRuleIds }
	        : { queryOp: 'EDITED_LAST_DAYS', children: ['recents-query-value'] }),
	    });
    if (options.truncatedSearchQuery) {
      for (const [index, ruleId] of truncatedQueryRuleIds.entries()) {
        makeNode(ruleId, `Term ${index}`, {
          type: 'queryCondition',
          parentId: 'recents-query',
          queryOp: 'STRING_MATCH',
        });
      }
    } else {
      makeNode('recents-query-value', '30', { parentId: 'recents-query' });
    }
    makeNode(ids.trash, 'Trash', { parentId: ids.root, locked: true });
    makeNode(ids.dayTag, 'day', { type: 'tagDef', parentId: ids.schema, color: 'gray' });
    makeNode(ids.projectTag, 'project', { type: 'tagDef', parentId: ids.schema, color: 'green' });
    makeNode('field:source', 'URI', {
      type: 'fieldDef',
      parentId: ids.schema,
      fieldType: 'uri',
      nullable: true,
      locked: true,
    });
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
    if (options.searchReferenceChain) {
      makeNode(ids.searchStatusEntry, '', {
        type: 'fieldEntry',
        parentId: ids.alpha,
        fieldDefId: ids.statusField,
        fieldType: 'plain',
      });
      makeNode(ids.searchStatusValue, 'Chain value', { parentId: ids.searchStatusEntry });
      makeNode(ids.searchIntermediate, '', {
        type: 'reference',
        parentId: ids.library,
        targetId: ids.alpha,
      });
      makeNode(ids.searchResult, '', {
        type: 'reference',
        parentId: ids.recents,
        targetId: ids.searchIntermediate,
        refRole: 'searchResult',
      });
    }
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
	    if (options.truncatedSearchQuery) {
	      for (const ruleId of truncatedQueryRuleIds) appendChild('recents-query', ruleId);
	    } else {
	      appendChild('recents-query', 'recents-query-value');
	    }
    if (options.searchReferenceChain) appendChild(ids.recents, ids.searchResult);
    appendChild(ids.schema, ids.dayTag);
    appendChild(ids.schema, ids.projectTag);
    appendChild(ids.schema, 'field:source');
    appendChild(ids.schema, ids.statusField);
    if (options.optionsField) {
      appendChild(ids.schema, ids.priorityField);
      appendChild(ids.priorityField, ids.priorityHigh);
      appendChild(ids.priorityField, ids.priorityLow);
    }
    if (options.dateField) appendChild(ids.schema, ids.dueField);
    if (options.relatedField) appendChild(ids.schema, ids.referencesField);
    appendChild(ids.daily, ids.today);
    if (options.searchReferenceChain) {
      appendChild(ids.library, ids.searchIntermediate);
      appendChild(ids.alpha, ids.searchStatusEntry);
      appendChild(ids.searchStatusEntry, ids.searchStatusValue);
    }
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
      if (normalized && typeof normalized === 'object') {
        const eventRecord = normalized as Record<string, unknown>;
        const update = eventRecord.update as Record<string, unknown> | undefined;
        if (eventRecord.type === 'projection_changed' && update) {
          const eventRevision = typeof update.revision === 'number' ? update.revision : ++revision;
          revision = Math.max(revision, eventRevision);
          const fullProjection = update.projection as { todayId?: unknown; nodes?: unknown } | undefined;
          const changedNodes = Array.isArray(fullProjection?.nodes) ? fullProjection.nodes : projection().nodes;
          const changedNodeIds = new Set(changedNodes.flatMap((node) => (
            node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string'
              ? [(node as { id: string }).id]
              : []
          )));
          const eventSequence = ++outlineEventSequence;
          const cursor = `cursor:${eventSequence}`;
          emitOutlineEvent({
            protocolVersion: 1,
            kind: 'outline.event',
            type: 'projection.changed',
            instanceId: 'runtime:e2e',
            sequence: eventSequence,
            revision: eventRevision,
            cursor,
            changes: update.kind === 'delta'
              ? {
                  todayId: String(update.todayId ?? ids.today),
                  changedNodes: Array.isArray(update.changedNodes) ? update.changedNodes : [],
                  removedIds: Array.isArray(update.removedIds) ? update.removedIds : [],
                }
              : {
                  todayId: String(fullProjection?.todayId ?? ids.today),
                  changedNodes,
                  removedIds: projection().nodes
                    .map((node) => node.id)
                    .filter((id) => !changedNodeIds.has(id)),
                },
          });
        }
      }
    };

    const emitOutlineEvent = (event: Record<string, unknown>) => {
      const cursor = String(event.cursor);
      for (const [subscriptionId, subscription] of outlineSubscriptions) {
        const types = (subscription.input.filter as { types?: unknown } | undefined)?.types;
        if (Array.isArray(types) && !types.includes(event.type)) continue;
        subscription.listener(clone({
          protocolVersion: 1,
          requestId: `desktop:${subscriptionId}`,
          sequence: event.sequence,
          type: 'event',
          cursor,
          event,
        }));
      }
    };

    type MockTargetRef =
      | { binding: string }
      | { target: { selector: Record<string, unknown>; cardinality: string; max?: number } };
    type MockPlacement =
      | { kind: 'first' | 'last'; parent: MockTargetRef }
      | { kind: 'index'; parent: MockTargetRef; index: number }
      | { kind: 'before' | 'after'; sibling: MockTargetRef }
      | { kind: 'previous' | 'next' };
    type MockChangeSet = {
      protocolVersion: 1;
      kind: 'outline.changeset';
      base?: { revision?: number };
      operations: Array<Record<string, unknown>>;
      source?: Record<string, unknown>;
    };
    type MockDiff = {
      protocolVersion: 1;
      kind: 'outline.diff';
      diffHash: string;
      intentHash: string;
      changeSetHash: string;
      baseRevision: number;
      normalizedChangeSet: MockChangeSet;
      bindings: Record<string, string[]>;
      affected: Array<{
        id: string;
        effect: 'create' | 'update' | 'move' | 'trash' | 'restore' | 'purge';
        beforeDigest: string | null;
        afterDigest: string | null;
      }>;
      destructive: Array<{ kind: 'purge' | 'empty-trash' | 'replace' | 'merge'; targetCount: number }>;
      warnings: unknown[];
      resultEstimate: { nodeCount: number; encodedBytes: number };
    };
    type MockRuntimeSnapshot = {
      nodes: Array<[string, MockNode]>;
      sequence: number;
      now: number;
      revision: number;
    };

    const outlineSnapshot = (): MockRuntimeSnapshot => ({
      nodes: clone([...nodes.entries()]),
      sequence,
      now,
      revision,
    });
    const restoreOutlineSnapshot = (snapshot: MockRuntimeSnapshot) => {
      nodes.clear();
      for (const [id, node] of clone(snapshot.nodes)) nodes.set(id, node);
      sequence = snapshot.sequence;
      now = snapshot.now;
      revision = snapshot.revision;
    };
    const mockDigest = (value: unknown) => {
      const text = JSON.stringify(value);
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
    };
    const outlineAliases: Record<string, string> = {
      home: ids.root,
      inbox: ids.library,
      library: ids.library,
      schema: ids.schema,
      trash: ids.trash,
      'daily-notes': ids.daily,
      'saved-searches': ids.searches,
      today: ids.today,
    };
    const queryMatches = (node: MockNode, query: Record<string, unknown>): boolean => {
      if (query.kind === 'group') {
        const children = Array.isArray(query.children) ? query.children as Array<Record<string, unknown>> : [];
        if (query.logic === 'OR') return children.some((child) => queryMatches(node, child));
        if (query.logic === 'NOT') return children.every((child) => !queryMatches(node, child));
        return children.every((child) => queryMatches(node, child));
      }
      if (query.op === 'STRING_MATCH') {
        return node.content.text.toLocaleLowerCase().includes(String(query.text ?? '').toLocaleLowerCase());
      }
      if (query.op === 'HAS_TAG') return node.tags.includes(String(query.tagDefId ?? ''));
      if (query.op === 'DONE') return (node.completedAt ?? 0) > 0;
      if (query.op === 'NOT_DONE') return (node.completedAt ?? 0) <= 0;
      if (
        query.op === 'HAS_MEDIA'
        || query.op === 'HAS_IMAGE'
        || query.op === 'HAS_AUDIO'
        || query.op === 'HAS_VIDEO'
      ) {
        const sourceEntries = node.children.flatMap((childId) => {
          const child = nodes.get(childId);
          return child?.type === 'fieldEntry' && child.fieldDefId === 'field:source' ? [child] : [];
        });
        const sourceMimeTypes = sourceEntries.flatMap((entry) => entry.children).flatMap((valueId) => {
          const sourceText = nodes.get(valueId)?.content.text;
          if (!sourceText?.startsWith('asset://local/')) return [];
          let assetId: string;
          try {
            assetId = decodeURIComponent(sourceText.slice('asset://local/'.length));
          } catch {
            return [];
          }
          const mimeType = assets.get(assetId)?.mimeType;
          return mimeType ? [mimeType.toLocaleLowerCase()] : [];
        });
        if (query.op === 'HAS_IMAGE') return sourceMimeTypes.some((mimeType) => mimeType.startsWith('image/'));
        if (query.op === 'HAS_AUDIO') return sourceMimeTypes.some((mimeType) => mimeType.startsWith('audio/'));
        if (query.op === 'HAS_VIDEO') return sourceMimeTypes.some((mimeType) => mimeType.startsWith('video/'));
        return sourceMimeTypes.some((mimeType) => (
          mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')
        ));
      }
      if (query.op === 'IS_TYPE') return node.type === String(query.text ?? 'plain');
      return true;
    };
    const resolveMockSelector = (selector: Record<string, unknown>): string[] => {
      if (selector.by === 'id') return nodes.has(String(selector.id)) ? [String(selector.id)] : [];
      if (selector.by === 'ids') {
        const selectedIds = Array.isArray(selector.ids) ? selector.ids.map(String) : [];
        const missingIds = selectedIds.filter((nodeId) => !nodes.has(nodeId));
        if (missingIds.length > 0) throw new Error(`Outline targets do not exist: ${missingIds.join(', ')}`);
        return selectedIds;
      }
      if (selector.by === 'alias') {
        const id = outlineAliases[String(selector.alias)];
        return id && nodes.has(id) ? [id] : [];
      }
      if (selector.by === 'date') {
        const date = String(selector.date);
        return [...nodes.values()]
          .filter((node) => node.parentId === ids.daily && node.content.text === date)
          .map((node) => node.id);
      }
      if (selector.by === 'query') {
        const limit = typeof selector.limit === 'number' ? selector.limit : 1_000;
        return [...nodes.values()]
          .filter((node) => selector.includeTrash === true || !isInTrash(node.id))
          .filter((node) => queryMatches(node, selector.query as Record<string, unknown>))
          .slice(0, limit)
          .map((node) => node.id);
      }
      return [];
    };
    const resolveMockTarget = (reference: MockTargetRef, bindings: Record<string, string[]>): string[] => {
      if ('binding' in reference) return [...bindings[reference.binding] ?? []];
      const resolved = resolveMockSelector(reference.target.selector);
      if (reference.target.cardinality === 'one' && resolved.length !== 1) {
        throw new Error(`Expected one Outline target; found ${resolved.length}.`);
      }
      if (reference.target.cardinality === 'zero-or-one' && resolved.length > 1) {
        throw new Error(`Expected at most one Outline target; found ${resolved.length}.`);
      }
      return resolved.slice(0, reference.target.max ?? resolved.length);
    };
    const oneMockTarget = (reference: MockTargetRef, bindings: Record<string, string[]>) => {
      const resolved = resolveMockTarget(reference, bindings);
      if (resolved.length !== 1) throw new Error(`Expected one Outline target; found ${resolved.length}.`);
      return resolved[0]!;
    };
    const resolveMockDestinations = (
      placement: Exclude<MockPlacement, { kind: 'previous' | 'next' }>,
      bindings: Record<string, string[]>,
    ): Array<{ parentId: string; index: number | null }> => {
      if (placement.kind === 'first' || placement.kind === 'last' || placement.kind === 'index') {
        return resolveMockTarget(placement.parent, bindings).map((parentId) => ({
          parentId,
          index: placement.kind === 'first' ? 0 : placement.kind === 'index' ? placement.index : null,
        }));
      }
      const siblingId = oneMockTarget(placement.sibling, bindings);
      const sibling = nodes.get(siblingId);
      const parent = sibling?.parentId ? nodes.get(sibling.parentId) : undefined;
      if (!sibling?.parentId || !parent) throw new Error(`Placement sibling has no parent: ${siblingId}`);
      const siblingIndex = parent.children.indexOf(siblingId);
      if (siblingIndex < 0) throw new Error(`Placement sibling is absent from its parent: ${siblingId}`);
      return [{
        parentId: sibling.parentId,
        index: siblingIndex + (placement.kind === 'after' ? 1 : 0),
      }];
    };
    const moveMockTargetBlock = (
      targetIds: string[],
      destination: { parentId: string; index: number | null },
    ) => {
      const parent = nodes.get(destination.parentId);
      if (!parent) throw new Error(`Move destination does not exist: ${destination.parentId}`);
      const selected = new Set(targetIds);
      const anchorId = destination.index === null
        ? undefined
        : parent.children.slice(destination.index).find((childId) => !selected.has(childId));
      for (const targetId of targetIds) {
        removeFromParent(targetId);
        const destinationParent = nodes.get(destination.parentId);
        if (!destinationParent) throw new Error(`Move destination does not exist: ${destination.parentId}`);
        const anchorIndex = anchorId ? destinationParent.children.indexOf(anchorId) : -1;
        moveNode(targetId, destination.parentId, anchorIndex >= 0 ? anchorIndex : null);
      }
    };
    const oneMockFieldTarget = (reference: MockTargetRef, bindings: Record<string, string[]>) => {
      if (
        'target' in reference
        && reference.target.selector.by === 'id'
        && String(reference.target.selector.id).startsWith('sys:')
      ) {
        return String(reference.target.selector.id);
      }
      return oneMockTarget(reference, bindings);
    };
    const mockViewField = (field: unknown, bindings: Record<string, string[]>): string | null => {
      if (field === null) return null;
      if (typeof field === 'string') return field;
      return oneMockTarget(field as MockTargetRef, bindings);
    };
    const createMockQueryCondition = (parentId: string, query: Record<string, unknown>) => {
      const conditionId = `condition-${++sequence}`;
      if (query.kind === 'group') {
        makeNode(conditionId, String(query.logic), {
          type: 'queryCondition',
          parentId,
          queryLogic: String(query.logic),
        });
        appendChild(parentId, conditionId);
        for (const child of query.children as Array<Record<string, unknown>>) {
          createMockQueryCondition(conditionId, child);
        }
        return conditionId;
      }
      makeNode(conditionId, String(query.text ?? query.op ?? ''), {
        type: 'queryCondition',
        parentId,
        queryOp: String(query.op),
        queryFieldDefId: typeof query.fieldDefId === 'string' ? query.fieldDefId : undefined,
        queryTagDefId: typeof query.tagDefId === 'string' ? query.tagDefId : undefined,
        queryTargetId: typeof query.targetId === 'string' ? query.targetId : undefined,
      });
      appendChild(parentId, conditionId);
      for (const operand of Array.isArray(query.operands) ? query.operands as Array<Record<string, unknown>> : []) {
        const targetId = typeof operand.targetId === 'string' ? operand.targetId : undefined;
        const operandId = `${targetId ? 'ref' : 'operand'}-${++sequence}`;
        makeNode(operandId, String(operand.text ?? ''), {
          parentId: conditionId,
          ...(targetId ? { type: 'reference', targetId } : {}),
        });
        appendChild(conditionId, operandId);
      }
      return conditionId;
    };
    const setMockSearch = (nodeId: string, title: string, query: Record<string, unknown>) => {
      const search = nodes.get(nodeId);
      if (!search) return;
      search.type = 'search';
      search.content = rich(title);
      for (const childId of [...search.children]) {
        if (nodes.get(childId)?.type === 'queryCondition') removeNode(childId);
      }
      createMockQueryCondition(nodeId, query);
      search.updatedAt = ++now;
    };
    const createMockDraft = (
      parentId: string,
      index: number | null,
      draft: Record<string, unknown>,
    ): string => {
      const nodeId = typeof draft.id === 'string' ? draft.id : nextCanonicalNodeId();
      const content = clone(draft.content as RichText);
      const metadata = draft.metadata && typeof draft.metadata === 'object'
        ? draft.metadata as Record<string, unknown>
        : {};
      const draftType = typeof draft.type === 'string' ? draft.type : undefined;
      const type = draftType === 'plain' ? undefined : draftType;
      const overrides: Partial<MockNode> = {
        type,
        showCheckbox: draft.checkbox === true,
        completedAt: draft.done === true ? ++now : draft.checkbox === true ? 0 : undefined,
      };
      if (type === 'reference') {
        overrides.targetId = String(draft.referenceTargetId ?? '');
      } else if (type === 'codeBlock') {
        overrides.codeLanguage = typeof draft.codeLanguage === 'string' ? draft.codeLanguage : undefined;
      }
      createNode(parentId, index, content.text, overrides, nodeId);
      const node = nodes.get(nodeId)!;
      node.content = content;
      if (typeof draft.description === 'string' && draft.description.trim()) node.description = draft.description;
      for (const tagId of Array.isArray(draft.tags) ? draft.tags.map(String) : []) {
        if (!node.tags.includes(tagId)) node.tags.push(tagId);
        for (const templateNodeId of tagTemplateContentNodeIds(tagId)) cloneTemplateContentNode(nodeId, templateNodeId);
      }
      for (const field of Array.isArray(draft.fields) ? draft.fields as Array<Record<string, unknown>> : []) {
        const entryId = inlineField(nodeId, null, '', 'plain', String(field.fieldDefId));
        for (const value of Array.isArray(field.values) ? field.values as Array<Record<string, unknown>> : []) {
          createMockDraft(entryId, null, value);
        }
      }
      applyPasteMetadata(nodeId, {
        metadata: {
          pasteTags: Array.isArray(metadata.pasteTags) ? metadata.pasteTags.map(String) : undefined,
          pasteFields: Array.isArray(metadata.pasteFields)
            ? (metadata.pasteFields as Array<Record<string, unknown>>).map((field) => ({
                name: String(field.name ?? ''),
                value: String(field.value ?? ''),
              }))
            : undefined,
        },
      });
      for (const child of Array.isArray(draft.children) ? draft.children as Array<Record<string, unknown>> : []) {
        createMockDraft(nodeId, null, child);
      }
      if (type === 'search' && metadata.query && typeof metadata.query === 'object') {
        setMockSearch(nodeId, content.text, metadata.query as Record<string, unknown>);
      }
      return nodeId;
    };
    const mockFieldEntry = (ownerId: string, fieldDefId: string) => nodes.get(ownerId)?.children
      .map((childId) => nodes.get(childId))
      .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === fieldDefId);
    const applyMockFieldInstruction = (
      ownerId: string,
      instruction: Record<string, unknown>,
      bindings: Record<string, string[]>,
    ) => {
      if (instruction.action === 'register-option') {
        registerOption(ownerId, String(instruction.name));
        return;
      }
      if (instruction.action === 'convert') {
        convertNodeToInlineField(ownerId, String(instruction.name), String(instruction.fieldType));
        return;
      }
      if (instruction.action === 'define') {
        inlineField(
          ownerId,
          typeof instruction.index === 'number' ? instruction.index : null,
          String(instruction.name),
          String(instruction.fieldType),
        );
        return;
      }
      const fieldDefId = oneMockFieldTarget(instruction.field as MockTargetRef, bindings);
      if (instruction.action === 'attach') {
        inlineField(ownerId, typeof instruction.index === 'number' ? instruction.index : null, '', 'plain', fieldDefId);
        return;
      }
      const entry = mockFieldEntry(ownerId, fieldDefId);
      if (instruction.action === 'clear') {
        if (entry) clearFieldValue(entry.id);
      } else if (instruction.action === 'remove') {
        if (entry) removeNode(entry.id);
      } else if (instruction.action === 'reuse') {
        const sourceFieldId = oneMockFieldTarget(instruction.sourceField as MockTargetRef, bindings);
        const sourceEntry = mockFieldEntry(ownerId, sourceFieldId);
        if (sourceEntry) reuseFieldDefinition(sourceEntry.id, fieldDefId);
      } else if (instruction.action === 'select') {
        const optionId = oneMockTarget(instruction.option as MockTargetRef, bindings);
        if (entry) selectOption(entry.id, optionId);
      } else if (instruction.action === 'set') {
        if (entry) clearFieldValue(entry.id);
        const nextEntry = mockFieldEntry(ownerId, fieldDefId) ?? ensureFieldSlotEntry(ownerId, fieldDefId);
        createNode(nextEntry.id, null, instruction.value == null ? '' : String(instruction.value));
      }
    };
    const applyMockFieldSlot = (
      ownerId: string,
      instruction: Record<string, unknown>,
      bindings: Record<string, string[]>,
    ) => {
      const fieldDefId = oneMockTarget(instruction.field as MockTargetRef, bindings);
      const mutation = instruction.mutation as Record<string, unknown>;
      if (mutation.action === 'remove-value') {
        removeFieldValue(oneMockTarget(mutation.value as MockTargetRef, bindings));
        return;
      }
      const actionKinds: Record<string, string> = {
        'accept-default': 'acceptDefault',
        'append-text': 'appendText',
        'append-reference': 'appendReference',
        'select-option': 'selectOption',
        'append-nodes': 'appendNodes',
        'append-field': 'appendField',
        commit: 'commit',
      };
      const args: Record<string, unknown> = {
        ownerId,
        fieldDefId,
        kind: actionKinds[String(mutation.action)],
        ...(typeof mutation.entryId === 'string' ? { entryId: mutation.entryId } : {}),
        ...(typeof mutation.id === 'string' ? { id: mutation.id } : {}),
      };
      if (mutation.action === 'append-text') Object.assign(args, { text: mutation.text, collect: mutation.collect });
      if (mutation.action === 'append-reference') {
        args.targetId = oneMockTarget(mutation.target as MockTargetRef, bindings);
      }
      if (mutation.action === 'select-option') {
        args.optionNodeId = oneMockTarget(mutation.option as MockTargetRef, bindings);
      }
      if (mutation.action === 'append-nodes') {
        args.nodes = mutation.nodes;
        args.firstTagIds = Array.isArray(mutation.firstTags)
          ? (mutation.firstTags as MockTargetRef[]).flatMap((target) => resolveMockTarget(target, bindings))
          : [];
      }
      if (mutation.action === 'append-field') Object.assign(args, { name: mutation.name, fieldType: mutation.fieldType });
      updateFieldSlot(args);
    };

    const applyMockSourceInstruction = (
      ownerId: string,
      instruction: Record<string, unknown>,
      bindings: Record<string, string[]>,
    ) => {
      const owner = nodes.get(ownerId);
      if (!owner) throw new Error(`Source owner does not exist: ${ownerId}`);
      const sourceEntries = () => owner.children.flatMap((childId) => {
        const child = nodes.get(childId);
        return child?.type === 'fieldEntry' && child.fieldDefId === 'field:source' ? [child] : [];
      });

      const oneSourceValue = (reference: unknown) => {
        const valueId = oneMockTarget(reference as MockTargetRef, bindings);
        const value = nodes.get(valueId);
        const entry = value?.parentId ? nodes.get(value.parentId) : undefined;
        if (entry?.type !== 'fieldEntry' || entry.parentId !== ownerId || entry.fieldDefId !== 'field:source') {
          throw new Error(`Source value is not owned by ${ownerId}: ${valueId}`);
        }
        return { entry, value: value! };
      };

      if (instruction.action === 'add') {
        const entries = sourceEntries();
        const anchor = instruction.after !== undefined && instruction.after !== null
          ? oneSourceValue(instruction.after)
          : undefined;
        let entry = anchor?.entry
          ?? (instruction.after === undefined ? entries.at(-1) : entries[0]);
        if (!entry) {
          const entryId = nextCanonicalNodeId();
          entry = makeNode(entryId, '', {
            type: 'fieldEntry',
            parentId: ownerId,
            fieldDefId: 'field:source',
            fieldType: 'uri',
          });
          appendChild(ownerId, entryId);
        }
        const valueId = typeof instruction.valueId === 'string' ? instruction.valueId : nextCanonicalNodeId();
        if (nodes.has(valueId)) throw new Error(`Source value already exists: ${valueId}`);
        let index: number | null = null;
        if (instruction.after === null) index = 0;
        else if (anchor) index = entry.children.indexOf(anchor.value.id) + 1;
        makeNode(valueId, String(instruction.sourceText ?? ''), { parentId: entry.id });
        appendChild(entry.id, valueId, index);
      } else if (instruction.action === 'replace') {
        oneSourceValue(instruction.value).value.content = rich(String(instruction.sourceText ?? ''));
      } else if (instruction.action === 'reorder') {
        const { entry, value } = oneSourceValue(instruction.value);
        const anchor = instruction.after === null ? null : oneSourceValue(instruction.after);
        if (anchor?.value.id === value.id) throw new Error('Source value cannot anchor itself.');
        const targetEntry = anchor?.entry ?? sourceEntries()[0] ?? entry;
        removeFromParent(value.id);
        appendChild(targetEntry.id, value.id, anchor ? targetEntry.children.indexOf(anchor.value.id) + 1 : 0);
        if (entry.id !== targetEntry.id && entry.children.length === 0) removeNode(entry.id);
      } else if (instruction.action === 'remove') {
        const { entry, value } = oneSourceValue(instruction.value);
        removeNode(entry.children.length === 1 ? entry.id : value.id);
      } else if (instruction.action === 'clear') {
        for (const entry of sourceEntries()) removeNode(entry.id);
      }
      if (nodes.has(ownerId)) nodes.get(ownerId)!.updatedAt = ++now;
    };
    const applyMockViewInstruction = (
      targetId: string,
      instruction: Record<string, unknown>,
      bindings: Record<string, string[]>,
    ) => {
      if (instruction.property === 'mode') {
        const view = ensureViewDef(targetId);
        const previous = view.viewMode ?? 'list';
        view.viewMode = String(instruction.mode);
        if (previous !== 'table' && instruction.mode === 'table') addMissingTableDisplayFields(targetId, view);
        return;
      }
      if (instruction.property === 'toolbar') {
        ensureViewDef(targetId).toolbarVisible = instruction.visible === true;
        return;
      }
      if (instruction.property === 'group') {
        const view = ensureViewDef(targetId);
        const field = mockViewField(instruction.field, bindings);
        if (field) view.groupField = field;
        else delete view.groupField;
        return;
      }
      const target = nodes.get(targetId);
      const parent = target?.parentId ? nodes.get(target.parentId) : undefined;
      const ownerView = target?.type === 'viewDef'
        ? target
        : parent?.type === 'viewDef'
          ? parent
          : ensureViewDef(targetId);
      if (instruction.property === 'sort') {
        if (instruction.action === 'add') {
          const id = `sort-${++sequence}`;
          makeNode(id, '', {
            type: 'sortRule', parentId: ownerView.id,
            sortField: mockViewField(instruction.field, bindings) ?? 'sys:name',
            sortDirection: String(instruction.direction),
          });
          appendChild(ownerView.id, id);
        } else if (instruction.action === 'set') {
          const rule = nodes.get(String(instruction.ruleId));
          if (rule) {
            rule.sortField = mockViewField(instruction.field, bindings) ?? 'sys:name';
            rule.sortDirection = String(instruction.direction);
          }
        } else if (instruction.action === 'remove') removeNode(String(instruction.ruleId));
        else for (const rule of directChildrenOfType(ownerView.id, 'sortRule')) removeNode(rule.id);
        return;
      }
      if (instruction.property === 'filter') {
        if (instruction.action === 'add') {
          const id = `filter-${++sequence}`;
          makeNode(id, '', {
            type: 'filterRule', parentId: ownerView.id,
            filterField: mockViewField(instruction.field, bindings) ?? 'sys:name',
            filterOperator: String(instruction.operator),
            filterValueLogic: String(instruction.valueLogic),
            filterValues: Array.isArray(instruction.values) ? instruction.values.map(String) : [],
          });
          appendChild(ownerView.id, id);
        } else if (instruction.action === 'set') {
          const rule = nodes.get(String(instruction.ruleId));
          if (rule) {
            if (instruction.field !== undefined) rule.filterField = mockViewField(instruction.field, bindings) ?? undefined;
            if (instruction.operator != null) rule.filterOperator = String(instruction.operator);
            if (instruction.valueLogic != null) rule.filterValueLogic = String(instruction.valueLogic);
            if (Array.isArray(instruction.values)) rule.filterValues = instruction.values.map(String);
          }
        } else if (instruction.action === 'remove') removeNode(String(instruction.ruleId));
        else for (const rule of directChildrenOfType(ownerView.id, 'filterRule')) removeNode(rule.id);
        return;
      }
      if (instruction.action === 'add') {
        const field = mockViewField(instruction.field, bindings) ?? 'sys:name';
        const existing = directChildrenOfType(ownerView.id, 'displayField').find((node) => node.displayField === field);
        if (existing) existing.displayVisible = true;
        else {
          const id = `display-${++sequence}`;
          makeNode(id, '', {
            type: 'displayField', parentId: ownerView.id, displayField: field,
            displayVisible: true, displayOrder: directChildrenOfType(ownerView.id, 'displayField').length,
          });
          appendChild(ownerView.id, id);
        }
      } else if (instruction.action === 'remove') removeNode(String(instruction.displayFieldId));
      else {
        const display = nodes.get(String(instruction.displayFieldId));
        if (!display) return;
        if (instruction.field !== undefined) display.displayField = mockViewField(instruction.field, bindings) ?? undefined;
        if (instruction.visible !== undefined && instruction.visible !== null) display.displayVisible = instruction.visible === true;
        if (instruction.width !== undefined) setOptionalNumber(display, 'displayWidth', instruction.width);
        if (instruction.order !== undefined) setOptionalNumber(display, 'displayOrder', instruction.order);
        if (instruction.label !== undefined) setOptionalText(display, 'displayLabel', instruction.label);
        if (instruction.placement !== undefined) setOptionalText(display, 'displayPlacement', instruction.placement);
        if (instruction.move === 'left' || instruction.move === 'right') {
          const siblings = directChildrenOfType(ownerView.id, 'displayField')
            .sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0));
          const current = siblings.findIndex((node) => node.id === display.id);
          const direction = instruction.move === 'left' ? -1 : 1;
          let next = current + direction;
          while (next >= 0 && next < siblings.length && siblings[next]?.displayVisible === false) {
            next += direction;
          }
          if (current >= 0 && next >= 0 && next < siblings.length) {
            [siblings[current], siblings[next]] = [siblings[next]!, siblings[current]!];
            siblings.forEach((node, order) => { node.displayOrder = order; });
          }
        }
      }
    };
    const applyMockUpdate = (
      targetId: string,
      instruction: Record<string, unknown>,
      bindings: Record<string, string[]>,
    ) => {
      const node = nodes.get(targetId);
      if (!node) return;
      if (instruction.kind === 'content') {
        node.content = clone(instruction.value as RichText);
      } else if (instruction.kind === 'description') {
        if (typeof instruction.value === 'string' && instruction.value.trim()) node.description = instruction.value;
        else delete node.description;
      } else if (instruction.kind === 'text-patch') {
        if (instruction.field === 'content') node.content = applyRichTextPatch(node.content, instruction.patch as RichTextPatch);
        else {
          const current = node.description ?? '';
          const from = Number(instruction.from);
          const to = Number(instruction.to);
          node.description = `${current.slice(0, from)}${String(instruction.value ?? '')}${current.slice(to)}`;
        }
      } else if (instruction.kind === 'code') {
        node.type = 'codeBlock';
        const language = String(instruction.language ?? '').trim().toLocaleLowerCase();
        if (language) node.codeLanguage = language;
        else delete node.codeLanguage;
      } else if (instruction.kind === 'checkbox') {
        if (instruction.visible === true && node.completedAt === undefined) node.completedAt = 0;
        if (instruction.visible === false) delete node.completedAt;
      } else if (instruction.kind === 'done') {
        node.completedAt = instruction.value === true ? ++now : 0;
      } else if (instruction.kind === 'tag') {
        const tagId = oneMockTarget(instruction.tag as MockTargetRef, bindings);
        if (instruction.action === 'add') {
          if (!node.tags.includes(tagId)) node.tags.push(tagId);
          for (const templateNodeId of tagTemplateContentNodeIds(tagId)) cloneTemplateContentNode(targetId, templateNodeId);
        } else node.tags = node.tags.filter((id) => id !== tagId);
      } else if (instruction.kind === 'source') {
        applyMockSourceInstruction(targetId, instruction, bindings);
      } else if (instruction.kind === 'field') {
        applyMockFieldInstruction(targetId, instruction, bindings);
      } else if (instruction.kind === 'field-slot') {
        applyMockFieldSlot(targetId, instruction, bindings);
      } else if (instruction.kind === 'definition') {
        const patch = instruction.patch as Record<string, unknown>;
        if (instruction.definitionType === 'tag') {
          if ('color' in patch) setOptionalText(node, 'color', patch.color);
          if ('extends' in patch) setOptionalText(node, 'extends', patch.extends);
          if ('childSupertag' in patch) setOptionalText(node, 'childSupertag', patch.childSupertag);
          if ('showCheckbox' in patch) node.showCheckbox = patch.showCheckbox === true;
          if ('doneStateEnabled' in patch) node.doneStateEnabled = patch.doneStateEnabled === true;
        } else {
          if ('fieldType' in patch) {
            setOptionalText(node, 'fieldType', patch.fieldType);
            if (node.fieldType !== 'number') {
              delete node.minValue;
              delete node.maxValue;
            }
            if (node.fieldType !== 'options') node.autocollectOptions = false;
            if (node.fieldType !== 'options_from_supertag') delete node.sourceSupertag;
          }
          if ('sourceSupertag' in patch) setOptionalText(node, 'sourceSupertag', patch.sourceSupertag);
          if ('nullable' in patch) node.nullable = patch.nullable === null ? undefined : patch.nullable === true;
          if ('hideField' in patch) setOptionalText(node, 'hideField', patch.hideField);
          if ('autoInitialize' in patch) setOptionalText(node, 'autoInitialize', patch.autoInitialize);
          if ('autocollectOptions' in patch) node.autocollectOptions = patch.autocollectOptions === true;
          if ('minValue' in patch) setOptionalNumber(node, 'minValue', patch.minValue);
          if ('maxValue' in patch) setOptionalNumber(node, 'maxValue', patch.maxValue);
        }
      } else if (instruction.kind === 'reference') {
        const referenceTargetId = oneMockTarget(instruction.target as MockTargetRef, bindings);
        const referenceTarget = nodes.get(resolveReferenceTargetId(referenceTargetId) ?? referenceTargetId);
        if (instruction.action === 'add') {
          createNode(targetId, null, referenceTarget?.content.text ?? '', {
            type: 'reference', targetId: referenceTarget?.id ?? referenceTargetId, showCheckbox: false,
          });
        } else if (instruction.action === 'retarget') {
          node.type = 'reference';
          node.targetId = referenceTarget?.id ?? referenceTargetId;
          if (referenceTarget) node.content = clone(referenceTarget.content);
        } else if (instruction.action === 'inline') {
          if (!node.parentId) return;
          const parent = nodes.get(node.parentId);
          const index = parent?.children.indexOf(node.id) ?? -1;
          const inlineId = createNode(
            node.parentId,
            index < 0 ? null : index,
            '',
            { showCheckbox: false },
            typeof instruction.replacementId === 'string' ? instruction.replacementId : undefined,
          );
          const inline = nodes.get(inlineId)!;
          inline.content = {
            text: '', marks: [],
            inlineRefs: [nodeInlineRef(0, referenceTarget?.id ?? referenceTargetId, referenceTarget?.content.text)],
          };
          removeNode(node.id);
        } else {
          if (!node.parentId) return;
          const parent = nodes.get(node.parentId);
          const index = parent?.children.indexOf(node.id) ?? -1;
          createNode(node.parentId, index < 0 ? null : index, referenceTarget?.content.text ?? '', {
            type: 'reference', targetId: referenceTarget?.id ?? referenceTargetId, showCheckbox: false,
          }, typeof instruction.replacementId === 'string' ? instruction.replacementId : undefined);
          removeNode(node.id);
        }
      } else if (instruction.kind === 'view') {
        applyMockViewInstruction(targetId, instruction, bindings);
      } else if (instruction.kind === 'search') {
        if (instruction.action === 'set') {
          setMockSearch(targetId, String(instruction.title), instruction.query as Record<string, unknown>);
        }
      } else if (instruction.kind === 'icon') {
        setOptionalText(node, 'icon', instruction.value);
        if (instruction.iconKind != null) node.iconKind = String(instruction.iconKind);
        else delete node.iconKind;
      } else if (instruction.kind === 'banner') {
        setOptionalText(node, 'bannerAssetId', instruction.assetLeaseId);
        const position = instruction.position as Record<string, unknown> | undefined;
        if (position?.x != null) setOptionalNumber(node, 'bannerPositionX', position.x);
        if (position?.y != null) setOptionalNumber(node, 'bannerPositionY', position.y);
      }
      if (nodes.has(targetId)) nodes.get(targetId)!.updatedAt = ++now;
    };
    const executeMockChangeSet = (changeSet: MockChangeSet) => {
      const bindings: Record<string, string[]> = {};
      for (const change of changeSet.operations) {
        let result: string[] = [];
        if (change.op === 'resolve') {
          result = resolveMockSelector(change.target as Record<string, unknown>);
        } else if (change.op === 'ensure') {
          if (change.resource === 'date') {
            const date = String(change.date);
            const existing = [...nodes.values()].find((node) => node.parentId === ids.daily && node.content.text === date);
            result = [existing?.id ?? createNode(ids.daily, null, date, { tags: [ids.dayTag], showCheckbox: false })];
          } else if (change.resource === 'tag-search') {
            const tagId = oneMockTarget(change.tag as MockTargetRef, bindings);
            const existing = [...nodes.values()].find((node) => node.type === 'search' && node.queryTagDefId === tagId);
            if (existing) result = [existing.id];
            else {
              const tag = nodes.get(tagId);
              const searchId = createNode(ids.searches, null, tag?.content.text ?? 'Search', {
                type: 'search', queryTagDefId: tagId, showCheckbox: false,
              });
              setMockSearch(searchId, tag?.content.text ?? 'Search', { kind: 'rule', op: 'HAS_TAG', tagDefId: tagId });
              result = [searchId];
            }
          } else {
            const type = change.definitionType === 'tag' ? 'tagDef' : 'fieldDef';
            const name = String(change.name).trim();
            const existing = [...nodes.values()].find((node) => (
              node.type === type && node.content.text.trim().toLocaleLowerCase() === name.toLocaleLowerCase()
            ));
            if (existing) result = [existing.id];
            else if (type === 'tagDef') result = [createTag(name).focus!.nodeId];
            else {
              const fieldId = `field-def-${++sequence}`;
              const config = change.config as Record<string, unknown> | undefined;
              makeNode(fieldId, name, {
                type: 'fieldDef', parentId: ids.schema,
                fieldType: String(config?.fieldType ?? 'plain'), nullable: true,
              });
              appendChild(ids.schema, fieldId);
              result = [fieldId];
            }
          }
        } else if (change.op === 'create') {
          const destinations = resolveMockDestinations(change.placement as Exclude<MockPlacement, { kind: 'previous' | 'next' }>, bindings);
          for (const [parentIndex, destination] of destinations.entries()) {
            for (const [draftIndex, draft] of (change.nodes as Array<Record<string, unknown>>).entries()) {
              const copy = parentIndex === 0 ? draft : {
                ...clone(draft), id: `${String(draft.id ?? 'node')}:copy:${parentIndex}:${draftIndex}`,
              };
              result.push(createMockDraft(
                destination.parentId,
                destination.index === null ? null : destination.index + draftIndex,
                copy,
              ));
            }
          }
        } else if (change.op === 'update') {
          result = resolveMockTarget(change.targets as MockTargetRef, bindings);
          for (const targetId of result) {
            for (const instruction of change.changes as Array<Record<string, unknown>>) {
              applyMockUpdate(targetId, instruction, bindings);
            }
          }
        } else if (change.op === 'move') {
          result = resolveMockTarget(change.targets as MockTargetRef, bindings);
          const placement = change.placement as MockPlacement;
          if (placement.kind === 'previous' || placement.kind === 'next') {
            siblingMove(result, placement.kind === 'previous' ? 'up' : 'down');
          } else {
            const destinations = resolveMockDestinations(placement, bindings);
            if (destinations.length !== 1) throw new Error('Move destination must resolve to exactly one parent.');
            moveMockTargetBlock(result, destinations[0]!);
          }
        } else if (change.op === 'duplicate') {
          const placement = change.placement as MockPlacement;
          const destinations = placement.kind === 'previous' || placement.kind === 'next'
            ? []
            : resolveMockDestinations(placement, bindings);
          if (destinations.length > 1) throw new Error('Duplicate destination must resolve to exactly one parent.');
          const destination = destinations[0] ?? null;
          for (const [index, targetId] of resolveMockTarget(change.targets as MockTargetRef, bindings).entries()) {
            const duplicateId = duplicateNode(targetId);
            if (!duplicateId) continue;
            if (placement.kind === 'previous') {
              const source = nodes.get(targetId);
              const parent = source?.parentId ? nodes.get(source.parentId) : undefined;
              if (!source?.parentId || !parent) throw new Error(`Duplicate source has no parent: ${targetId}`);
              moveNode(duplicateId, source.parentId, parent.children.indexOf(targetId));
            } else if (placement.kind !== 'next') {
              if (!destination) throw new Error('Duplicate destination must resolve to exactly one parent.');
              moveNode(
                duplicateId,
                destination.parentId,
                destination.index === null ? null : destination.index + index,
              );
            }
            result.push(duplicateId);
          }
        } else if (change.op === 'merge') {
          const targetId = oneMockTarget(change.target as MockTargetRef, bindings);
          const target = nodes.get(targetId);
          for (const sourceId of resolveMockTarget(change.sources as MockTargetRef, bindings)) {
            const source = nodes.get(sourceId);
            if (!source || !target) continue;
            target.content = rich(`${target.content.text}${source.content.text}`);
            for (const childId of [...source.children]) moveNode(childId, targetId);
            removeNode(sourceId);
          }
          result = [targetId];
        } else if (change.op === 'template') {
          const tagId = oneMockTarget(change.tag as MockTargetRef, bindings);
          const plan = tagTemplateBackfillPlan(tagId);
          for (const target of plan.targets) {
            for (const templateNodeId of target.templateNodeIds) cloneTemplateContentNode(target.nodeId, templateNodeId);
          }
          result = [tagId];
        } else if (change.op === 'lifecycle') {
          result = resolveMockTarget(change.targets as MockTargetRef, bindings);
          if (change.action === 'purge' && change.contents === true && result.includes(ids.trash)) {
            result = [...nodes.get(ids.trash)?.children ?? []];
          }
          for (const targetId of result) {
            if (change.action === 'trash') moveNode(targetId, ids.trash);
            else if (change.action === 'restore') moveNode(targetId, ids.today);
            else removeNode(targetId);
          }
        }
        if (typeof change.bind === 'string') bindings[change.bind] = [...result];
      }
      return bindings;
    };
    const diffAffectedNodes = (
      before: Array<[string, MockNode]>,
      after: Array<[string, MockNode]>,
    ): MockDiff['affected'] => {
      const beforeById = new Map(before);
      const afterById = new Map(after);
      const idsToCompare = new Set([...beforeById.keys(), ...afterById.keys()]);
      return [...idsToCompare].flatMap((id): MockDiff['affected'] => {
        const oldNode = beforeById.get(id);
        const newNode = afterById.get(id);
        if (!oldNode && newNode) return [{ id, effect: 'create', beforeDigest: null, afterDigest: mockDigest(newNode) }];
        if (oldNode && !newNode) return [{ id, effect: 'purge', beforeDigest: mockDigest(oldNode), afterDigest: null }];
        if (JSON.stringify(oldNode) !== JSON.stringify(newNode)) {
          const effect = oldNode?.parentId === ids.trash && newNode?.parentId !== ids.trash
            ? 'restore'
            : oldNode?.parentId !== ids.trash && newNode?.parentId === ids.trash
              ? 'trash'
              : oldNode?.parentId !== newNode?.parentId ? 'move' : 'update';
          return [{ id, effect, beforeDigest: mockDigest(oldNode), afterDigest: mockDigest(newNode) }];
        }
        return [];
      });
    };
    const previewMockChangeSet = (input: MockChangeSet): MockDiff => {
      if (input.base?.revision !== undefined && input.base.revision !== revision) {
        throw new Error(`Stale Runtime revision ${input.base.revision}; expected ${revision}.`);
      }
      const normalizedChangeSet = clone({
        ...input,
        base: { ...input.base, revision },
      });
      const before = outlineSnapshot();
      let bindings: Record<string, string[]>;
      let after: MockRuntimeSnapshot;
      try {
        bindings = executeMockChangeSet(normalizedChangeSet);
        after = outlineSnapshot();
      } finally {
        restoreOutlineSnapshot(before);
      }
      const affected = diffAffectedNodes(before.nodes, after!.nodes);
      const destructive = normalizedChangeSet.operations.flatMap((change) => {
        if (change.op === 'merge') {
          return [{ kind: 'merge' as const, targetCount: resolveMockTarget(change.sources as MockTargetRef, bindings).length }];
        }
        if (change.op === 'lifecycle' && change.action === 'purge') {
          return [{
            kind: change.contents === true ? 'empty-trash' as const : 'purge' as const,
            targetCount: affected.filter((entry) => entry.effect === 'purge').length,
          }];
        }
        return [];
      });
      const intentHash = mockDigest(input);
      const changeSetHash = mockDigest(normalizedChangeSet);
      return {
        protocolVersion: 1,
        kind: 'outline.diff',
        diffHash: mockDigest({ intentHash, changeSetHash, bindings, affected, destructive }),
        intentHash,
        changeSetHash,
        baseRevision: revision,
        normalizedChangeSet,
        bindings,
        affected,
        destructive,
        warnings: [],
        resultEstimate: { nodeCount: affected.length, encodedBytes: JSON.stringify(affected).length },
      };
    };
    const outlineHistory: Array<{ before: MockRuntimeSnapshot; after: MockRuntimeSnapshot; operationId: string }> = [];
    const outlineRedoHistory: Array<{ before: MockRuntimeSnapshot; after: MockRuntimeSnapshot; operationId: string }> = [];
    const mockAnchors = () => ({
      workspaceId: ids.workspace,
      rootId: ids.root,
      libraryId: ids.library,
      dailyNotesId: ids.daily,
      schemaId: ids.schema,
      searchesId: ids.searches,
      recentsId: ids.recents,
      trashId: ids.trash,
      todayId: ids.today,
    });
    const mockBacklinks = (targetId: string) => {
      const result: Array<Record<string, unknown>> = [];
      for (const node of nodes.values()) {
        if (isInTrash(node.id)) continue;
        if (node.type === 'reference' && node.targetId === targetId) {
          const parent = node.parentId ? nodes.get(node.parentId) : undefined;
          const fieldEntry = parent?.type === 'fieldEntry' ? parent : undefined;
          result.push({
            targetId,
            sourceId: fieldEntry?.parentId ?? node.id,
            referenceId: node.id,
            kind: fieldEntry ? 'field' : 'tree',
            ...(fieldEntry ? { fieldEntryId: fieldEntry.id, fieldDefId: fieldEntry.fieldDefId } : {}),
          });
        }
        for (const inlineRef of node.content.inlineRefs) {
          if (inlineRef.target.kind === 'node' && inlineRef.target.nodeId === targetId) {
            result.push({
              targetId,
              sourceId: node.id,
              referenceId: node.id,
              kind: 'inline',
              inlineDisplayName: inlineRef.displayName,
            });
          }
        }
      }
      return result;
    };
    const mockProjectionResult = (
      projectionSpec: Record<string, unknown>,
      selectedIds?: string[],
    ) => {
      let projected: unknown[];
      if (projectionSpec.kind === 'backlinks') {
        const targetRef = projectionSpec.targets as MockTargetRef;
        projected = resolveMockTarget(targetRef, {}).flatMap(mockBacklinks);
      } else {
        const full = projection().nodes;
        projected = selectedIds ? full.filter((node) => selectedIds.includes(node.id)) : full;
      }
      const page = projectionSpec.page as { limit?: number; cursor?: string } | undefined;
      const limit = page?.limit ?? 100;
      const cursorParts = page?.cursor?.split(':') ?? [];
      const offset = cursorParts.length === 3 && Number(cursorParts[1]) === revision
        ? Number(cursorParts[2])
        : 0;
      const pageNodes = projected.slice(offset, offset + limit);
      const nextOffset = offset + pageNodes.length;
      return {
        projection: clone(projectionSpec),
        revision,
        anchors: mockAnchors(),
        nodes: clone(pageNodes),
        ...(nextOffset < projected.length ? {
          truncated: true,
          cursor: `mock:${revision}:${nextOffset}`,
        } : {}),
      };
    };
    const mockOperation = (
      diff: MockDiff,
      revisionBefore: number,
      revertsOperationId?: string,
    ) => {
      const operationId = `operation-${++sequence}`;
      const affectedNodeIds = diff.affected.map((entry) => entry.id);
      return {
        protocolVersion: 1,
        kind: 'outline.operation',
        operationId,
        intentHash: diff.intentHash,
        changeSetHash: diff.changeSetHash,
        diffHash: diff.diffHash,
        origin: 'desktop',
        ...(diff.normalizedChangeSet.source ? { source: diff.normalizedChangeSet.source } : {}),
        summary: `Applied ${diff.normalizedChangeSet.operations.length} ChangeSet operation(s).`,
        affectedNodeIds,
        affectedNodeCount: affectedNodeIds.length,
        affectedNodeIdsHash: mockDigest(affectedNodeIds),
        revisionBefore,
        revisionAfter: revision,
        createdAt: new Date(++now).toISOString(),
        recovery: {
          recoveryPatchId: `recovery-${operationId}`,
          state: 'available',
          retainedUntilAtLeast: new Date(now + 86_400_000).toISOString(),
        },
        ...(revertsOperationId ? { revertsOperationId } : {}),
      };
    };
    const publishMockOperation = (
      operation: Record<string, unknown>,
      removedIds: string[],
      type: 'operation.committed' | 'operation.reverted' = 'operation.committed',
    ) => {
      const eventSequence = ++outlineEventSequence;
      const cursor = `cursor:${eventSequence}`;
      emitOutlineEvent({
        protocolVersion: 1,
        kind: 'outline.event',
        type,
        instanceId: 'runtime:e2e',
        sequence: eventSequence,
        revision,
        cursor,
        operation,
        changes: {
          todayId: ids.today,
          changedNodes: projection().nodes,
          removedIds,
        },
      });
    };
    const applyMockDiff = (diff: MockDiff, acknowledgeDestructive: boolean) => {
      if (diff.baseRevision !== revision || diff.normalizedChangeSet.base?.revision !== revision) {
        throw new Error('The Runtime revision changed after this Diff was created.');
      }
      if (diff.destructive.length > 0 && !acknowledgeDestructive) {
        throw new Error('Destructive ChangeSet requires explicit acknowledgement.');
      }
      const before = outlineSnapshot();
      try {
        executeMockChangeSet(diff.normalizedChangeSet);
      } catch (error) {
        restoreOutlineSnapshot(before);
        throw error;
      }
      const previousIds = new Set(before.nodes.map(([id]) => id));
      revision = before.revision + 1;
      const after = outlineSnapshot();
      const operation = mockOperation(diff, before.revision);
      outlineHistory.push({ before, after, operationId: String(operation.operationId) });
      outlineRedoHistory.length = 0;
      publishMockOperation(
        operation,
        [...previousIds].filter((id) => !nodes.has(id)),
      );
      return operation;
    };
    const commitMockChangeSet = (changeSet: MockChangeSet) => {
      const diff = previewMockChangeSet(changeSet);
      if (diff.destructive.length > 0) {
        throw new Error('Direct commit accepts only non-destructive ChangeSets.');
      }
      return applyMockDiff(diff, false);
    };
    const applyMockHistory = (direction: 'undo' | 'redo') => {
      const source = direction === 'undo' ? outlineHistory : outlineRedoHistory;
      const destination = direction === 'undo' ? outlineRedoHistory : outlineHistory;
      const entry = source.pop();
      if (!entry) {
        const emptyDiff = previewMockChangeSet({
          protocolVersion: 1,
          kind: 'outline.changeset',
          base: { revision },
          operations: [{ op: 'update', targets: { target: { selector: { by: 'id', id: ids.today }, cardinality: 'one' } }, changes: [{ kind: 'description', value: nodes.get(ids.today)?.description ?? null }] }],
        });
        const beforeRevision = revision;
        revision += 1;
        const operation = mockOperation(emptyDiff, beforeRevision);
        publishMockOperation(operation, [], direction === 'undo' ? 'operation.reverted' : 'operation.committed');
        return operation;
      }
      const previousIds = new Set(nodes.keys());
      const target = direction === 'undo' ? entry.before : entry.after;
      const currentRevision = revision;
      restoreOutlineSnapshot(target);
      revision = currentRevision + 1;
      const diff = previewMockChangeSet({
        protocolVersion: 1,
        kind: 'outline.changeset',
        base: { revision },
        operations: [{ op: 'update', targets: { target: { selector: { by: 'id', id: ids.today }, cardinality: 'one' } }, changes: [{ kind: 'description', value: nodes.get(ids.today)?.description ?? null }] }],
      });
      const operation = mockOperation(diff, currentRevision, direction === 'undo' ? entry.operationId : undefined);
      destination.push(entry);
      publishMockOperation(
        operation,
        [...previousIds].filter((id) => !nodes.has(id)),
        direction === 'undo' ? 'operation.reverted' : 'operation.committed',
      );
      return operation;
    };
    const outlineSuccess = (requestId: string, command: string, data: unknown) => ({
      protocolVersion: 1 as const,
      requestId,
      command,
      ok: true,
      revision,
      data: clone(data),
    });
    const outlineFailure = (requestId: string, command: string, error: unknown) => ({
      protocolVersion: 1 as const,
      requestId,
      command,
      ok: false,
      error: {
        code: 'invalid_input',
        category: 'usage',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    });
    const requestMockOutline = async (request: { requestId: string; command: string; input: unknown }) => {
      const input = request.input && typeof request.input === 'object'
        ? request.input as Record<string, unknown>
        : {};
      calls.push({ cmd: `outline/${request.command}`, args: clone(input) });
      try {
        if (request.command === 'get') {
          if (initialOutlineShowPending) {
            initialOutlineShowPending = false;
            if (options.initWorkspaceDelayMs) await delay(options.initWorkspaceDelayMs);
          }
          const projectionSpec = input.projection as Record<string, unknown>;
          return outlineSuccess(request.requestId, request.command, mockProjectionResult(projectionSpec));
        }
        if (request.command === 'find') {
          const target = input.target as { selector: Record<string, unknown> };
          const selectedIds = resolveMockSelector(target.selector);
          const projectionSpec = input.projection && typeof input.projection === 'object'
            ? input.projection as Record<string, unknown>
            : {
                kind: 'summary',
                targets: { target: input.target },
                page: { limit: 10_000 },
              };
          return outlineSuccess(
            request.requestId,
            request.command,
            mockProjectionResult(projectionSpec, selectedIds),
          );
        }
        if (request.command === 'preview') {
          return outlineSuccess(
            request.requestId,
            request.command,
            previewMockChangeSet(input.changeSet as MockChangeSet),
          );
        }
        if (request.command === 'transact') {
          return outlineSuccess(
            request.requestId,
            request.command,
            commitMockChangeSet(input.changeSet as MockChangeSet),
          );
        }
        if (request.command === 'apply') {
          return outlineSuccess(
            request.requestId,
            request.command,
            applyMockDiff(input.diff as MockDiff, input.acknowledgeDestructive === true),
          );
        }
        if (request.command === 'undo' || request.command === 'redo') {
          return outlineSuccess(
            request.requestId,
            request.command,
            applyMockHistory(request.command),
          );
        }
        if (request.command === 'asset ingest') {
          const encoded = typeof input.data === 'string' ? input.data : '';
          const byteSize = encoded ? Math.floor(encoded.length * 0.75) : 0;
          const asset = createAsset({
            mimeType: typeof input.mimeType === 'string' ? input.mimeType : undefined,
            originalFilename: typeof input.originalFilename === 'string' ? input.originalFilename : undefined,
            byteSize,
          });
          return outlineSuccess(request.requestId, request.command, {
            protocolVersion: 1,
            leaseId: asset.id,
            assetId: asset.id,
            metadata: {
              mimeType: asset.mimeType,
              byteSize: asset.byteSize,
              originalFilename: asset.originalFilename,
              imageWidth: asset.imageWidth,
              imageHeight: asset.imageHeight,
              thumbnailAssetId: asset.thumbnailAssetId,
              pdfPageCount: asset.pdfPageCount,
              audioDurationMs: asset.audioDurationMs,
              videoDurationMs: asset.videoDurationMs,
            },
            expiresAt: new Date(now + 86_400_000).toISOString(),
          });
        }
        throw new Error(`Unhandled mock Outline request: ${request.command}`);
      } catch (error) {
        return outlineFailure(request.requestId, request.command, error);
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
      setMockThreadTurns: (threadId, turns) => {
        mockTurns.set(threadId, clone(turns) as MockTurn[]);
      },
      createMockSubagentThread: ({ parentThreadId, name, active, queuedWork }) => {
        const parent = threadById(parentThreadId);
        const thread = createMockThread({ name });
        thread.parentThreadId = parent.id;
        thread.sessionId = parent.sessionId;
        thread.threadSource = 'subagent';
        thread.source = 'collaboration';
        thread.agentNickname = name;
        thread.agentRole = 'worker';
        if (active) thread.status = { type: 'active', activeFlags: [] };
        if (queuedWork) mockQueuedWorkThreadIds.add(thread.id);
        emitAgentCoreNotification({ type: 'thread/started', threadId: thread.id, thread });
        return { id: thread.id };
      },
      setMockThreadActive: (threadId, active) => {
        const thread = threadById(threadId);
        thread.status = active ? { type: 'active', activeFlags: [] } : { type: 'idle' };
        thread.updatedAt = ++now;
        emitAgentCoreNotification({ type: 'thread/status/changed', threadId, status: clone(thread.status) });
      },
      setMockSubagentExecution: (agentId, patch) => {
        const merged = { ...mockSubagentExecutionPatches.get(agentId) ?? {}, ...clone(patch) };
        mockSubagentExecutionPatches.set(agentId, merged);
        const execution = subagentExecutionFor(agentId);
        if (execution) {
          emitAgentCoreNotification({
            type: 'subagent/execution/changed',
            threadId: execution.parentThreadId,
            execution,
          });
        }
      },
      setNextThreadStartBehavior: (behavior) => {
        nextThreadStartBehavior = {
          delayMs: Math.max(0, behavior.delayMs ?? 0),
          error: behavior.error ?? null,
        };
      },
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
      outline: {
        commit: async (request) => {
          const before = projection();
          const diff = previewMockChangeSet(request.changeSet);
          const response = await win.lin!.outline.request({
            requestId: request.requestId,
            command: 'transact',
            input: {
              changeSet: request.changeSet,
              ...(request.undoGroup ? { undoGroup: request.undoGroup } : {}),
            },
          });
          if (!response.ok) {
            const error = response.error && typeof response.error === 'object'
              ? response.error as { message?: unknown }
              : undefined;
            throw new Error(typeof error?.message === 'string' ? error.message : 'Mock Outline commit failed.');
          }
          const after = projection();
          const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
          const afterById = new Map(after.nodes.map((node) => [node.id, node]));
          return clone({
            settlement: response.data,
            update: {
              kind: 'delta',
              revision,
              todayId: after.todayId,
              changedNodes: after.nodes.filter((node) => (
                JSON.stringify(beforeById.get(node.id)) !== JSON.stringify(node)
              )),
              removedIds: before.nodes
                .filter((node) => !afterById.has(node.id))
                .map((node) => node.id),
            },
            diff,
          });
        },
        request: requestMockOutline,
        cancel: () => undefined,
        subscribe: (subscription, listener) => {
          const record = {
            protocolVersion: 1,
            requestId: `desktop:${subscription.subscriptionId}`,
            sequence: outlineEventSequence,
            type: 'hello',
            cursor: `cursor:${outlineEventSequence}`,
          };
          outlineSubscriptions.set(subscription.subscriptionId, {
            input: clone(subscription.input),
            listener,
          });
          queueMicrotask(() => {
            if (outlineSubscriptions.has(subscription.subscriptionId)) listener(clone(record));
          });
          return () => {
            outlineSubscriptions.delete(subscription.subscriptionId);
          };
        },
      },
      appInfo: async () => ({
        name: 'Tenon',
        version: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        electron: '39.0.0',
        chrome: '142.0.0',
        node: '22.0.0',
      }),
      appUpdate: {
        get: async () => clone(appUpdate),
        check: async () => clone(appUpdate),
        setAutomaticChecksEnabled: async (enabled) => {
          appUpdate = { ...appUpdate, automaticChecksEnabled: enabled };
          for (const listener of appUpdateListeners) listener(clone(appUpdate));
          return clone(appUpdate);
        },
        open: async () => {
          calls.push({ cmd: 'app_update_open', args: {} });
          return { ok: true, destination: appUpdate.availableRelease?.downloadAvailable ? 'download' : 'release' };
        },
        onChanged: (listener) => {
          appUpdateListeners.push(listener);
          return () => {
            const index = appUpdateListeners.indexOf(listener);
            if (index >= 0) appUpdateListeners.splice(index, 1);
          };
        },
      },
      automationRequest: async <T,>(method: string, input: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ cmd: `automation/${method}`, args: clone(input) });
        if (method === 'list') return clone({ data: mockAutomations }) as T;
        if (method === 'runs') {
          let runs = mockAutomationRuns.filter((run) => (
            input.automationId === undefined || run.automationId === input.automationId
          ));
          if (input.unreadOnly === true) {
            runs = runs.filter((run) => (
              run.readAt === null && (run.state === 'dispatched' || run.state === 'failed')
            ));
          }
          const limit = typeof input.limit === 'number' ? input.limit : 100;
          return clone({ data: runs.slice(0, limit) }) as T;
        }
        if (method === 'read') {
          return clone({ automation: mockAutomations.find((item) => item.id === input.id) ?? null }) as T;
        }
        if (method === 'create') {
          const schedule = clone(input.schedule) as MockAutomation['schedule'];
          const configuration = input.configuration as Partial<MockAutomation['configuration']> | undefined;
          const timestamp = ++now;
          const automation: MockAutomation = {
            id: nextCanonicalId(),
            name: String(input.name),
            prompt: String(input.prompt),
            schedule,
            destination: clone(input.destination) as MockAutomation['destination'],
            projectBindings: clone(input.projectBindings ?? []) as MockAutomation['projectBindings'],
            configuration: {
              modelProvider: null,
              model: null,
              reasoningEffort: null,
              ...clone(configuration ?? {}),
            },
            status: input.status === 'paused' ? 'paused' : 'active',
            revision: 1,
            nextOccurrenceAt: timestamp + 60 * 60 * 1_000,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          mockAutomations.push(automation);
          emitAutomationNotification({ type: 'automation/changed', automationId: automation.id, automation });
          return clone({ automation }) as T;
        }
        if (method === 'update') {
          const index = mockAutomations.findIndex((item) => item.id === input.id);
          if (index < 0) throw new Error(`Automation not found: ${String(input.id)}`);
          const current = mockAutomations[index]!;
          if (input.expectedRevision !== current.revision) throw new Error('Automation revision conflict');
          const automation: MockAutomation = {
            ...current,
            ...clone(input),
            id: current.id,
            configuration: input.configuration
              ? { ...current.configuration, ...clone(input.configuration as Partial<MockAutomation['configuration']>) }
              : current.configuration,
            revision: current.revision + 1,
            updatedAt: ++now,
          };
          mockAutomations[index] = automation;
          emitAutomationNotification({ type: 'automation/changed', automationId: automation.id, automation });
          return clone({ automation }) as T;
        }
        if (method === 'pause' || method === 'resume') {
          const automation = mockAutomations.find((item) => item.id === input.id);
          if (!automation) throw new Error(`Automation not found: ${String(input.id)}`);
          automation.status = method === 'pause' ? 'paused' : 'active';
          automation.revision += 1;
          automation.updatedAt = ++now;
          emitAutomationNotification({ type: 'automation/changed', automationId: automation.id, automation });
          return clone({ automation }) as T;
        }
        if (method === 'delete') {
          const index = mockAutomations.findIndex((item) => item.id === input.id);
          if (index < 0) throw new Error(`Automation not found: ${String(input.id)}`);
          const [deleted] = mockAutomations.splice(index, 1);
          emitAutomationNotification({ type: 'automation/changed', automationId: deleted!.id, automation: null });
          return clone({ deleted: true, id: deleted!.id }) as T;
        }
        if (method === 'startNow') {
          const automation = mockAutomations.find((item) => item.id === input.id);
          if (!automation) throw new Error(`Automation not found: ${String(input.id)}`);
          const thread = automation.destination.kind === 'existingThread'
            ? threadById(automation.destination.threadId)
            : createMockThread({ name: automation.name });
          if (automation.destination.kind === 'standalone') {
            thread.source = 'agent.automation';
            thread.threadSource = 'automation';
            emitAgentCoreNotification({ type: 'thread/started', threadId: thread.id, thread });
          }
          const automationRunId = nextCanonicalId();
          const turnId = nextCanonicalId();
          const userItemId = nextCanonicalId();
          const responseItemId = nextCanonicalId();
          const timestamp = ++now;
          const turn: MockTurn = {
            id: turnId,
            items: [
              {
                id: userItemId,
                type: 'userMessage',
                author: { kind: 'feature', feature: 'automation', ref: automationRunId },
                provenance: itemProvenance(thread.id, turnId, userItemId),
                clientId: automationRunId,
                acceptedAt: timestamp,
                content: [{ type: 'text', text: automation.prompt }],
              },
              {
                id: responseItemId,
                type: 'agentMessage',
                provenance: itemProvenance(thread.id, turnId, responseItemId),
                text: 'Automation completed in the canonical Thread.',
                phase: 'final_answer',
                memoryCitation: null,
              },
            ],
            itemsView: 'full',
            provenance: {
              originThreadId: thread.id,
              originTurnId: turnId,
              trigger: { kind: 'feature', feature: 'automation', ref: automationRunId },
            },
            status: 'completed',
            error: null,
            execution: {
              modelProvider: 'openai',
              model: 'openai/gpt-5.4',
              reasoningEffort: 'medium',
              diagnosticsRef: null,
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: null },
            },
            startedAt: timestamp,
            completedAt: timestamp + 20,
            durationMs: 20,
          };
          mockTurns.get(thread.id)!.push(turn);
          thread.preview = automation.prompt;
          thread.updatedAt = timestamp + 20;
          const run: MockAutomationRun = {
            id: automationRunId,
            automationId: automation.id,
            automationRevision: automation.revision,
            eventSequence: ++automationRunEventSequence,
            scheduledFor: timestamp,
            projectBindingKey: 'no-project',
            snapshot: {
              automationName: automation.name,
              prompt: automation.prompt,
              schedule: automation.schedule,
              destination: automation.destination,
              projectBinding: null,
              configuration: automation.configuration,
            },
            state: 'dispatched',
            threadId: thread.id,
            turnId,
            worktree: null,
            omission: null,
            error: null,
            readAt: null,
            pinned: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          mockAutomationRuns.push(run);
          emitAutomationNotification({ type: 'automationRun/changed', run });
          return clone({ runs: [run] }) as T;
        }
        if (method === 'runRead') {
          return clone({ run: mockAutomationRuns.find((item) => item.id === input.id) ?? null }) as T;
        }
        if (method === 'runsMarkRead') {
          const readAt = ++now;
          const eventSequence = ++automationRunEventSequence;
          let updatedCount = 0;
          for (const run of mockAutomationRuns) {
            if (
              run.automationId !== input.automationId
              || run.readAt !== null
              || (run.state !== 'dispatched' && run.state !== 'failed')
            ) continue;
            run.readAt = readAt;
            run.eventSequence = eventSequence;
            run.updatedAt = readAt;
            updatedCount += 1;
          }
          emitAutomationNotification({
            type: 'automationRuns/markedRead',
            automationId: String(input.automationId),
            eventSequence,
            readAt,
          });
          return clone({ automationId: input.automationId, eventSequence, readAt, updatedCount }) as T;
        }
        if (method === 'runMarkRead' || method === 'runPin') {
          const run = mockAutomationRuns.find((item) => item.id === input.id);
          if (!run) throw new Error(`AutomationRun not found: ${String(input.id)}`);
          if (method === 'runMarkRead') run.readAt = ++now;
          else run.pinned = input.pinned === true;
          run.eventSequence = ++automationRunEventSequence;
          run.updatedAt = ++now;
          emitAutomationNotification({ type: 'automationRun/changed', run });
          return clone({ run }) as T;
        }
        throw new Error(`Unhandled Automation mock request: ${method}`);
      },
      agentCoreRequest: async <T,>(method: string, input: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ cmd: method, args: clone(input) });
        if (method === 'thread/list') {
          // Root conversations only, like the real catalog: a child Thread is
          // reached from its parent, never from the history list.
          const data = mockThreads
            .filter((thread) => thread.parentThreadId === null)
            .sort((left, right) => right.updatedAt - left.updatedAt);
          return clone({ data, nextCursor: null }) as T;
        }
        if (method === 'thread/references/search') {
          const currentThreadId = String(input.currentThreadId);
          threadById(currentThreadId);
          const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : '';
          const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(20, input.limit)) : 8;
          const data = mockThreads
            .filter((thread) => thread.parentThreadId === null && thread.id !== currentThreadId)
            .filter((thread) => !query || `${thread.name ?? ''}\n${thread.preview}`.toLocaleLowerCase().includes(query))
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, limit)
            .map((thread) => ({
              threadId: thread.id,
              title: thread.name?.trim() || thread.preview.trim() || null,
              updatedAt: thread.updatedAt,
              availability: 'available',
              snippet: thread.preview,
              archived: false,
            }));
          return clone({ data }) as T;
        }
        if (method === 'thread/references/resolve') {
          const currentThreadId = String(input.currentThreadId);
          threadById(currentThreadId);
          const data = (Array.isArray(input.threadIds) ? input.threadIds : []).map((value) => {
            const threadId = String(value);
            const thread = mockThreads.find((candidate) => candidate.id === threadId);
            return thread
              ? {
                  threadId,
                  title: thread.name?.trim() || thread.preview.trim() || null,
                  updatedAt: thread.updatedAt,
                  availability: threadId === currentThreadId ? 'current' : 'available',
                }
              : { threadId, title: null, updatedAt: null, availability: 'missing' };
          });
          return clone({ data }) as T;
        }
        if (method === 'thread/descendants') {
          const rootId = String(input.threadId);
          const data: MockThread[] = [];
          const pending = [rootId];
          while (pending.length > 0) {
            const parentId = pending.shift()!;
            for (const thread of mockThreads) {
              if (thread.parentThreadId !== parentId || data.some((seen) => seen.id === thread.id)) continue;
              data.push(thread);
              pending.push(thread.id);
            }
          }
          data.sort((left, right) => right.updatedAt - left.updatedAt);
          return clone({
            data,
            queuedWorkThreadIds: data
              .filter((thread) => mockQueuedWorkThreadIds.has(thread.id))
              .map((thread) => thread.id),
          }) as T;
        }
        if (method === 'thread/subagents/list') {
          const rootId = String(input.threadId);
          const data: Array<Record<string, unknown>> = [];
          const pending = [rootId];
          while (pending.length > 0) {
            const parentId = pending.shift()!;
            for (const thread of mockThreads) {
              if (thread.parentThreadId !== parentId) continue;
              if (data.some((seen) => seen.agentId === thread.id)) continue;
              const execution = subagentExecutionFor(thread.id);
              if (execution) data.push(execution);
              pending.push(thread.id);
            }
          }
          data.sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
          return clone({ data }) as T;
        }
        if (method === 'thread/tasks/list') {
          const ownerThreadId = String(input.threadId);
          const data = [...mockToolTasks.values()]
            .filter((task) => task.ownerThreadId === ownerThreadId)
            .sort((left, right) => Number(left.startedAt) - Number(right.startedAt));
          return clone({ data }) as T;
        }
        if (method === 'task/read') {
          const task = mockToolTasks.get(String(input.taskId));
          if (!task || task.ownerThreadId !== input.threadId) throw new Error('Tool Task not found');
          return clone({
            task,
            output: task.detailState === 'available'
              ? { stdout: 'Mock background output', stderr: '', stdoutTruncated: false, stderrTruncated: false }
              : null,
          }) as T;
        }
        if (method === 'task/stop') {
          const taskId = String(input.taskId);
          const task = mockToolTasks.get(taskId);
          if (!task || task.ownerThreadId !== input.threadId) throw new Error('Tool Task not found');
          const stopped = {
            ...task,
            state: 'cancelled',
            outcomeReason: 'user_stop',
            completedAt: Date.now(),
          };
          mockToolTasks.set(taskId, stopped);
          emitAgentCoreNotification({ type: 'toolTask/changed', threadId: input.threadId, task: stopped });
          return clone({ task: stopped }) as T;
        }
        if (method === 'task/details/clear') {
          const ownerThreadId = String(input.threadId);
          const data: Array<Record<string, unknown>> = [];
          let reclaimedBytes = 0;
          for (const [taskId, task] of mockToolTasks) {
            if (task.ownerThreadId !== ownerThreadId
              || task.deliveryState !== 'delivered'
              || task.detailState !== 'available') continue;
            reclaimedBytes += Number(task.detailBytes ?? 0);
            const cleared = { ...task, detailState: 'cleared', artifacts: [], artifactWarnings: [] };
            mockToolTasks.set(taskId, cleared);
            data.push(cleared);
          }
          return clone({ data, reclaimedBytes }) as T;
        }
        if (method === 'thread/read') {
          const thread = threadById(String(input.threadId));
          return clone({ thread: input.includeTurns ? { ...thread, turns: mockTurns.get(thread.id) ?? [] } : thread }) as T;
        }
        if (method === 'thread/start') {
          const behavior = nextThreadStartBehavior;
          nextThreadStartBehavior = null;
          const delayMs = behavior?.delayMs ?? initialThreadStartDelayMs;
          initialThreadStartDelayMs = 0;
          if (delayMs) await delay(delayMs);
          if (behavior?.error) throw new Error(behavior.error);
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
        if (method === 'turn/recovery/read') {
          const thread = threadById(String(input.threadId));
          const target = (mockTurns.get(thread.id) ?? []).at(-1);
          const available = target?.id === input.turnId && target.status === 'failed';
          return clone({
            canContinue: available && target.items.some((item) => (
              item.type === 'agentMessage' && item.phase !== 'interrupted' && item.text.length > 0
            )),
            canRerun: available,
            rerunRequiresConfirmation: false,
          }) as T;
        }
        if (method === 'turn/continue') {
          const thread = threadById(String(input.threadId));
          const turns = mockTurns.get(thread.id) ?? [];
          const target = turns.at(-1);
          if (!target || target.id !== input.turnId || target.status !== 'failed') {
            throw new Error('Only the latest failed Turn can be continued.');
          }
          if (!target.items.some((item) => (
            item.type === 'agentMessage' && item.phase !== 'interrupted' && item.text.length > 0
          ))) {
            throw new Error('This Turn cannot continue from failure.');
          }
          const turnId = nextCanonicalId();
          const userItemId = nextCanonicalId();
          const startedAt = ++now;
          const continuation: MockTurn = {
            id: turnId,
            items: [{
              type: 'userMessage',
              id: userItemId,
              provenance: itemProvenance(thread.id, turnId, userItemId),
              author: { kind: 'host' },
              clientId: null,
              acceptedAt: startedAt,
              content: [],
            }],
            itemsView: 'full',
            provenance: {
              originThreadId: thread.id,
              originTurnId: turnId,
              trigger: { kind: 'continuation', sourceTurnId: target.id },
            },
            status: 'inProgress',
            error: null,
            execution: clone(target.execution),
            startedAt,
            completedAt: null,
            durationMs: null,
            updatedAt: startedAt,
          };
          emitAgentCoreNotification({
            type: 'turn/started',
            threadId: thread.id,
            turnId,
            turn: continuation,
          });
          thread.status = { type: 'active', activeFlags: [] };
          thread.updatedAt = startedAt;
          emitAgentCoreNotification({ type: 'thread/status/changed', threadId: thread.id, status: thread.status });
          return clone({ thread, turn: continuation, sourceTurnId: target.id }) as T;
        }
        if (method === 'turn/rerun') {
          const thread = threadById(String(input.threadId));
          const turns = mockTurns.get(thread.id) ?? [];
          const target = turns.at(-1);
          if (!target || target.id !== input.turnId) throw new Error('Only the latest Turn can be rerun.');
          if (target.status !== 'failed') throw new Error('This Turn cannot be rerun.');
          if (typeof input.confirmToolReplay !== 'boolean') {
            throw new Error('Rerun confirmation must be explicit.');
          }
          const sourceUserItem = target.items.find((item) => item.type === 'userMessage');
          if (!sourceUserItem) throw new Error('Rerun input is missing from the canonical Turn.');
          const turnId = nextCanonicalId();
          const userItemId = nextCanonicalId();
          const startedAt = ++now;
          const userItem: MockThreadItem = {
            ...clone(sourceUserItem),
            id: userItemId,
            provenance: itemProvenance(thread.id, turnId, userItemId),
            acceptedAt: startedAt,
          };
          const replacement: MockTurn = {
            ...clone(target),
            id: turnId,
            items: [userItem],
            provenance: {
              originThreadId: thread.id,
              originTurnId: turnId,
              trigger: clone(target.provenance.trigger),
            },
            status: 'inProgress',
            error: null,
            startedAt,
            completedAt: null,
            durationMs: null,
          };
          turns.pop();
          emitAgentCoreNotification({ type: 'turn/started', threadId: thread.id, turnId, turn: replacement });
          thread.status = { type: 'active', activeFlags: [] };
          thread.updatedAt = startedAt;
          emitAgentCoreNotification({ type: 'thread/status/changed', threadId: thread.id, status: thread.status });
          return clone({ thread, turn: replacement, replacedTurnId: target.id }) as T;
        }
        if (method === 'thread/name/set') {
          const thread = threadById(String(input.threadId));
          thread.name = typeof input.name === 'string' ? input.name : null;
          thread.updatedAt = ++now;
          return {} as T;
        }
        if (method === 'thread/archive' || method === 'thread/unarchive') return {} as T;
        if (method === 'thread/records/get') return { recorded: true } as T;
        if (method === 'thread/records/set') {
          return { recorded: (input as { recorded: boolean }).recorded } as T;
        }
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
          const turns = mockTurns.get(String(input.threadId)) ?? [];
          const data = input.sortDirection === 'desc' ? [...turns].reverse() : turns;
          return clone({ data, nextCursor: null, backwardsCursor: null }) as T;
        }
        if (method === 'thread/turn/details/read') {
          const thread = threadById(String(input.threadId));
          const turn = (mockTurns.get(thread.id) ?? []).find((candidate) => candidate.id === input.turnId);
          if (!turn) throw new Error(`Turn not found: ${String(input.turnId)}`);
          const userItem = turn.items.find((item) => item.type === 'userMessage');
          if (!userItem) return clone({ thread, turn, diagnostics: null }) as T;
          const messageId = 'e'.repeat(64);
          const instructionFragmentId = '6'.repeat(64);
          const toolFragmentId = '7'.repeat(64);
          const providerMessage = {
            role: 'user',
            content: [
              ...userItem.content,
              {
                type: 'text',
                text: [
                  '<system-reminder>',
                  '<context-evidence kind="turnEnvironment" authority="application" purpose="observation">',
                  'working_directory=/workspace',
                  '</context-evidence>',
                  '</system-reminder>',
                ].join('\n'),
              },
            ],
            timestamp: userItem.acceptedAt,
          };
          const messagePartProvenance = providerMessage.content.map((_part, index) => (
            index === providerMessage.content.length - 1
              ? {
                  source: 'systemContext' as const,
                  entries: [{
                    kind: 'turnEnvironment' as const,
                    authority: 'application' as const,
                    purpose: 'observation' as const,
                  }],
                }
              : { source: 'userInput' as const, itemId: userItem.id }
          ));
          const providerTool = {
            type: 'function',
            name: 'file_read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
          };
          const diagnostics = {
            schemaVersion: 1,
            contextEpochId: 'initial',
            cacheAffinity: 'a'.repeat(64),
            configuration: {
              profileName: 'default',
              developerInstructions: [],
              model: turn.execution.model,
              reasoningEffort: turn.execution.reasoningEffort,
              tools: ['file_read'],
              skills: [],
              plugins: [],
              mcpServers: [],
            },
            stablePrompt: {
              blocks: [{
                id: 'framework-firmware',
                layer: 'L0',
                text: 'Canonical mock system prompt.',
                fingerprint: '1'.repeat(64),
              }],
              fingerprints: {
                l0: '1'.repeat(64),
                l1: '2'.repeat(64),
                l2: '3'.repeat(64),
                complete: '4'.repeat(64),
              },
            },
            toolSchemas: [{
              name: 'file_read',
              description: 'Read a file',
              parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
            }],
            runtime: {
              provider: turn.execution.modelProvider,
              model: turn.execution.model,
              api: 'openai-responses',
              configuredBaseUrl: 'https://api.openai.com/v1',
              transportSelection: 'auto',
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              thinkingLevel: turn.execution.reasoningEffort,
              timeoutMs: 30_000,
              maxRetries: 2,
              maxRetryDelayMs: 60_000,
              cacheRetention: 'short',
              toolExecution: 'parallel',
              steeringMode: 'all',
            },
            canonicalMessages: [{
              id: messageId,
              estimatedTokens: Math.max(1, Math.ceil(JSON.stringify(userItem).length / 4)),
              value: providerMessage,
            }],
            requestFragments: [
              { id: instructionFragmentId, value: 'Canonical mock system prompt.' },
              { id: messageId, value: providerMessage },
              { id: toolFragmentId, value: providerTool },
            ],
            providerCalls: [{
              index: 0,
              requestedAt: turn.startedAt,
              preparedContext: {
                systemPromptFragmentId: instructionFragmentId,
                toolNames: ['file_read'],
                messageIds: [messageId],
                messagePartProvenance: [messagePartProvenance],
              },
              protectedFromMessageIndex: 0,
              estimatedInputTokens: turn.execution.usage.input,
              inputTokenLimit: 100_000,
              reservedOutputTokens: 8_192,
              commonPrefixMessageCount: 0,
              request: {
                kind: 'object',
                fields: [
                  { name: 'model', representation: 'inline', value: turn.execution.model },
                  {
                    name: 'instructions',
                    representation: 'fragments',
                    container: 'value',
                    fragmentIds: [instructionFragmentId],
                    fragmentPartProvenance: [null],
                  },
                  {
                    name: 'input',
                    representation: 'fragments',
                    container: 'array',
                    fragmentIds: [messageId],
                    fragmentPartProvenance: [messagePartProvenance],
                  },
                  {
                    name: 'tools',
                    representation: 'fragments',
                    container: 'array',
                    fragmentIds: [toolFragmentId],
                    fragmentPartProvenance: [null],
                  },
                ],
              },
              requestFingerprint: '5'.repeat(64),
              cacheBreakpoints: [],
              transportResponse: {
                headersReceivedAt: turn.startedAt,
                httpStatus: 200,
                requestId: 'mock-request-1',
              },
              response: {
                receivedAt: turn.completedAt ?? turn.startedAt,
                stopReason: 'stop',
                errorMessage: null,
                usage: {
                  input: turn.execution.usage.input,
                  output: turn.execution.usage.output,
                  cacheRead: turn.execution.usage.cacheRead,
                  cacheWrite: turn.execution.usage.cacheWrite,
                  cacheWrite1h: null,
                  reasoning: null,
                  totalTokens: turn.execution.usage.totalTokens,
                  cost: turn.execution.usage.cost
                    ? {
                        input: turn.execution.usage.cost.input,
                        output: turn.execution.usage.cost.output,
                        cacheRead: turn.execution.usage.cost.cacheRead,
                        cacheWrite: turn.execution.usage.cost.cacheWrite,
                        total: turn.execution.usage.cost.total,
                      }
                    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                value: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Mock response' }],
                  stopReason: 'stop',
                },
              },
            }],
            activities: [
              {
                type: 'acceptedInput',
                source: 'initial',
                acceptedAt: userItem.acceptedAt,
                itemIds: [userItem.id],
                consumedByCallIndex: 0,
              },
              { type: 'modelCall', callIndex: 0 },
            ],
          };
          const ref = {
            id: 'd'.repeat(64),
            mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
            byteLength: JSON.stringify(diagnostics).length,
            schemaVersion: 1,
          };
          return clone({
            thread,
            turn: { ...turn, execution: { ...turn.execution, diagnosticsRef: ref } },
            diagnostics: { ref, payload: diagnostics },
          }) as T;
        }
        if (method === 'thread/trajectory/read') {
          const thread = threadById(String(input.threadId));
          const turns = mockTurns.get(thread.id) ?? [];
          const records = turns.flatMap((turn, turnIndex) => {
            const userItem = turn.items.find((item) => item.type === 'userMessage');
            const compactionItems = turn.items.filter((item) => item.type === 'contextCompaction');
            const agentItem = turn.items.find((item) => item.type === 'agentMessage');
            const entries: Array<Record<string, unknown>> = [];
            if (userItem) {
              entries.push({
                id: `turn:${turn.id}:input:item:${userItem.id}`,
                kind: 'input',
                lane: 'input',
                threadId: thread.id,
                turnId: turn.id,
                orderKey: trajectoryOrderKey(turnIndex, 0),
                turnIndex,
                stepIndex: 0,
                parentRecordId: null,
                label: { type: 'input', source: 'initial' },
                meta: null,
                preview: 'Mock request',
                state: 'completed',
                timing: { startedAt: turn.startedAt, firstTokenAt: null, completedAt: turn.startedAt, durationMs: 0 },
                usage: null,
                primaryEvidence: { type: 'threadItem', threadId: thread.id, turnId: turn.id, itemId: userItem.id },
                relatedEvidence: [],
                availability: [],
                childThreadId: null,
              });
            }
            if (agentItem) {
              entries.push({
                id: `turn:${turn.id}:assistant:0`,
                kind: 'assistant',
                lane: 'assistant',
                threadId: thread.id,
                turnId: turn.id,
                orderKey: trajectoryOrderKey(turnIndex, 5),
                turnIndex,
                stepIndex: 0,
                parentRecordId: null,
                label: { type: 'assistantCall', callIndex: 0 },
                meta: `${turn.execution.modelProvider} · ${turn.execution.model}`,
                preview: 'Mock response',
                state: turn.status === 'inProgress' ? 'running' : 'completed',
                timing: {
                  startedAt: turn.startedAt,
                  firstTokenAt: null,
                  completedAt: turn.completedAt,
                  durationMs: turn.completedAt === null ? null : Math.max(0, turn.completedAt - turn.startedAt),
                },
                usage: {
                  input: turn.execution.usage.input,
                  output: turn.execution.usage.output,
                  cacheRead: turn.execution.usage.cacheRead,
                  cacheWrite: turn.execution.usage.cacheWrite,
                  reasoning: null,
                  totalTokens: turn.execution.usage.totalTokens,
                  costUsd: turn.execution.usage.cost?.total ?? null,
                },
                primaryEvidence: { type: 'providerCall', threadId: thread.id, turnId: turn.id, callIndex: 0 },
                relatedEvidence: [{ type: 'threadItem', threadId: thread.id, turnId: turn.id, itemId: agentItem.id }],
                availability: [],
                childThreadId: null,
              });
            }
            compactionItems.forEach((item, index) => {
              entries.push({
                id: `turn:${turn.id}:compaction:item:${item.id}`,
                kind: 'compaction',
                lane: 'input',
                threadId: thread.id,
                turnId: turn.id,
                orderKey: trajectoryOrderKey(turnIndex, 7 + index),
                turnIndex,
                stepIndex: 0,
                parentRecordId: null,
                label: { type: 'contextCompaction', trigger: item.trigger },
                meta: item.trigger,
                preview: `${item.trigger} compaction`,
                state: 'completed',
                timing: { startedAt: turn.startedAt, firstTokenAt: null, completedAt: turn.completedAt ?? turn.startedAt, durationMs: null },
                usage: null,
                primaryEvidence: { type: 'threadItem', threadId: thread.id, turnId: turn.id, itemId: item.id },
                relatedEvidence: [],
                availability: [{ reason: 'diagnosticsUnavailable' }],
                childThreadId: null,
              });
            });
            return entries;
          }).sort((left, right) => String(left.orderKey).localeCompare(String(right.orderKey)));
          const stepsByTurn = new Map<string, number>();
          records.forEach((record) => {
            const turnId = String(record.turnId);
            const stepIndex = stepsByTurn.get(turnId) ?? 0;
            stepsByTurn.set(turnId, stepIndex + 1);
            record.stepIndex = stepIndex;
          });
          const focus = input.focus as { recordId?: string | null; turnId?: string | null } | null | undefined;
          const selectedRecordId = focus?.recordId && records.some((record) => record.id === focus.recordId)
            ? focus.recordId
            : focus?.turnId
              ? String(focusedTrajectoryRecord(records, focus.turnId)?.id ?? records.at(-1)?.id ?? '')
              : null;
          const usage = turns.reduce((accumulator, turn) => ({
            input: accumulator.input + turn.execution.usage.input,
            output: accumulator.output + turn.execution.usage.output,
            cacheRead: accumulator.cacheRead + turn.execution.usage.cacheRead,
            cacheWrite: accumulator.cacheWrite + turn.execution.usage.cacheWrite,
            reasoning: null,
            totalTokens: accumulator.totalTokens + turn.execution.usage.totalTokens,
            costUsd: accumulator.costUsd === null || turn.execution.usage.cost === null
              ? null
              : accumulator.costUsd + turn.execution.usage.cost.total,
          }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, totalTokens: 0, costUsd: 0 as number | null });
          return clone({
            threadId: thread.id,
            summary: {
              threadId: thread.id,
              turnCount: turns.length,
              startedAt: turns[0]?.startedAt ?? null,
              completedAt: turns.some((turn) => turn.completedAt === null) ? null : turns.at(-1)?.completedAt ?? null,
              durationMs: null,
              usage: turns.length > 0 ? usage : null,
              availability: [],
            },
            records,
            replacementRange: records.length > 0
              ? {
                startOrderKey: String(records[0]!.orderKey),
                endOrderKey: String(records.at(-1)!.orderKey),
              }
              : null,
            olderCursor: null,
            newerCursor: null,
            hasOlder: false,
            hasNewer: false,
            selectedRecordId: selectedRecordId || null,
          }) as T;
        }
        if (method === 'thread/trajectory/detail/read') {
          const thread = threadById(String(input.threadId));
          const turns = mockTurns.get(thread.id) ?? [];
          const recordId = String(input.recordId);
          const turn = turns.find((candidate) => recordId.includes(candidate.id));
          if (!turn) return clone({ threadId: thread.id, record: null, detail: null }) as T;
          const item = turn.items.find((candidate) => recordId.includes(candidate.id)) ?? null;
          const turnIndex = turns.findIndex((candidate) => candidate.id === turn.id);
          const kind = recordId.includes(':assistant:') ? 'assistant'
            : recordId.includes(':compaction:') ? 'compaction'
              : recordId.includes(':context:') ? 'context'
                : 'input';
          const summary = {
            id: recordId,
            kind,
            lane: kind === 'assistant' ? 'assistant' : 'input',
            threadId: thread.id,
            turnId: turn.id,
            orderKey: trajectoryOrderKey(turnIndex, 0),
            turnIndex,
            stepIndex: 0,
            parentRecordId: null,
            label: kind === 'assistant'
              ? { type: 'assistantCall', callIndex: 0 }
              : kind === 'compaction'
                ? { type: 'contextCompaction', trigger: 'manual' }
                : kind === 'context'
                  ? { type: 'context', kinds: ['additionalContext'] }
                  : { type: 'input', source: 'initial' },
            meta: null,
            preview: item && 'text' in item ? String(item.text) : null,
            state: 'completed',
            timing: { startedAt: turn.startedAt, firstTokenAt: null, completedAt: turn.completedAt, durationMs: turn.durationMs },
            usage: kind === 'assistant' ? {
              input: turn.execution.usage.input,
              output: turn.execution.usage.output,
              cacheRead: turn.execution.usage.cacheRead,
              cacheWrite: turn.execution.usage.cacheWrite,
              reasoning: null,
              totalTokens: turn.execution.usage.totalTokens,
              costUsd: turn.execution.usage.cost?.total ?? null,
            } : null,
            primaryEvidence: kind === 'assistant'
              ? { type: 'providerCall', threadId: thread.id, turnId: turn.id, callIndex: 0 }
              : { type: 'threadItem', threadId: thread.id, turnId: turn.id, itemId: item?.id ?? turn.items[0]?.id ?? 'missing' },
            relatedEvidence: [],
            availability: [],
            childThreadId: null,
          };
          const turnEvidence = {
            id: turn.id,
            status: turn.status,
            error: turn.error,
            startedAt: turn.startedAt,
            completedAt: turn.completedAt,
            durationMs: turn.durationMs,
            modelProvider: turn.execution.modelProvider,
            model: turn.execution.model,
            reasoningEffort: turn.execution.reasoningEffort,
          };
          const itemEvidence = item ? {
            itemId: item.id,
            type: item.type,
            title: item.type,
            preview: item.type === 'agentMessage' ? item.text : null,
            status: 'status' in item ? item.status : null,
          } : null;
          const diagnosticsEvidence = kind === 'assistant' ? {
            ref: {
              id: 'd'.repeat(64),
              mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
              byteLength: 1024,
              schemaVersion: 1,
            },
            runtime: {
              provider: turn.execution.modelProvider,
              model: turn.execution.model,
              api: 'responses',
              transportSelection: 'sse',
              contextWindow: 128000,
              maxOutputTokens: 8192,
              thinkingLevel: turn.execution.reasoningEffort,
              timeoutMs: null,
              maxRetries: 2,
              maxRetryDelayMs: 1000,
              cacheRetention: 'short',
              toolExecution: 'parallel',
              steeringMode: 'all',
            },
            activity: null,
            providerCall: {
              index: 0,
              requestedAt: turn.startedAt,
              estimatedInputTokens: turn.execution.usage.input,
              inputTokenLimit: 128000,
              reservedOutputTokens: 8192,
              commonPrefixMessageCount: 0,
              requestFingerprint: 'e'.repeat(64),
              cacheBreakpoints: [],
              request: { input: 'Mock request' },
              response: { outputText: 'Mock response' },
              transportResponse: {
                headersReceivedAt: turn.startedAt,
                httpStatus: 200,
                requestId: 'mock-request',
              },
            },
          } : null;
          return clone({
            threadId: thread.id,
            record: summary,
            detail: kind === 'assistant'
              ? {
                kind,
                turn: turnEvidence,
                modelOutputParts: [{ type: 'text', text: 'Mock response' }],
                diagnostics: diagnosticsEvidence,
                providerCallIndex: 0,
                relatedItems: itemEvidence ? [itemEvidence] : [],
              }
              : kind === 'context'
                ? { kind, turn: turnEvidence, item: itemEvidence, modelContextText: null, payload: null }
                : kind === 'compaction'
                  ? {
                    kind,
                    turn: turnEvidence,
                    item: itemEvidence,
                    diagnostics: null,
                    activityIndex: null,
                    summaryText: null,
                  }
                  : {
                    kind,
                    turn: turnEvidence,
                    modelInputParts: item?.type === 'userMessage'
                      ? [{ type: 'text', text: 'Mock request' }]
                      : null,
                    message: item?.type === 'userMessage'
                      ? { itemId: item.id, acceptedAt: item.acceptedAt, content: item.content }
                      : null,
                    diagnostics: null,
                    activityIndex: null,
                  },
          }) as T;
        }
        if (method === 'thread/trajectory/export') {
          return clone({ status: 'written', fileName: 'tenon-trajectory-mock.json', byteLength: 128 }) as T;
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
        const contextCommandText = method === 'turn/submit'
          && Array.isArray(input.input)
          && input.input.length === 1
          && (input.input[0] as { type?: string; text?: string }).type === 'text'
          ? String((input.input[0] as { text?: string }).text ?? '').trim()
          : null;
        // `/clear` and `/compact` are ordinary composer text on the way out, and
        // the host routes them into a context command: a Turn whose Item is a
        // `contextReset`, never a `userMessage`. It is the one submission that
        // comes back carrying nothing of the reader's, and both of the host's
        // branches matter here — a fresh reset, and the deduplicated repeat that
        // answers `turn: null` when nothing has been added since the last one.
        if (contextCommandText === '/clear') {
          const thread = threadById(String(input.threadId));
          const turns = mockTurns.get(thread.id) ?? [];
          const last = turns.at(-1);
          const lastItem = last?.items.at(-1);
          if (lastItem?.type === 'contextReset') {
            return clone({
              turn: null,
              turnId: last!.id,
              acceptedItemId: lastItem.id,
              deduplicated: true,
            }) as T;
          }
          const turnId = nextCanonicalId();
          const itemId = nextCanonicalId();
          const startedAt = ++now;
          const resetTurn: MockTurn = {
            id: turnId,
            items: [{
              id: itemId,
              type: 'contextReset',
              provenance: itemProvenance(thread.id, turnId, itemId),
              clearedThrough: {
                turnId: last?.id ?? turnId,
                itemId: lastItem?.id ?? itemId,
              },
            }],
            itemsView: 'full',
            provenance: {
              originThreadId: thread.id,
              originTurnId: turnId,
              trigger: { kind: 'feature' as const, feature: 'context.clear', ref: String(input.clientUserMessageId ?? '') },
            },
            status: 'completed',
            error: null,
            execution: {
              ...mockThreadConfigurations.get(thread.id)!,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: null,
              },
            },
            startedAt,
            completedAt: startedAt,
            durationMs: 0,
          };
          thread.updatedAt = startedAt;
          emitAgentCoreNotification({ type: 'turn/started', threadId: thread.id, turnId, turn: resetTurn });
          emitAgentCoreNotification({ type: 'turn/completed', threadId: thread.id, turnId, turn: resetTurn });
          return clone({
            turn: resetTurn,
            turnId,
            acceptedItemId: itemId,
            deduplicated: false,
          }) as T;
        }
        let submittedActiveTurn = method === 'turn/submit'
          ? (mockTurns.get(String(input.threadId)) ?? []).findLast((turn) => turn.status === 'inProgress')
          : undefined;
        if (
          method === 'turn/submit'
          && submittedActiveTurn
          && options.agentTurnSubmitFinishingDelayMs !== undefined
        ) {
          const thread = threadById(String(input.threadId));
          const completedAt = ++now;
          const completedTurn: MockTurn = {
            ...submittedActiveTurn,
            status: 'completed',
            completedAt,
            durationMs: Math.max(0, completedAt - submittedActiveTurn.startedAt),
          };
          thread.status = { type: 'idle' };
          thread.updatedAt = completedAt;
          emitAgentCoreNotification({
            type: 'turn/completed',
            threadId: thread.id,
            turnId: completedTurn.id,
            turn: completedTurn,
          });
          emitAgentCoreNotification({
            type: 'thread/status/changed',
            threadId: thread.id,
            status: thread.status,
          });
          await delay(Math.max(0, options.agentTurnSubmitFinishingDelayMs));
          submittedActiveTurn = undefined;
        }
        if (method === 'turn/start' || (method === 'turn/submit' && !submittedActiveTurn)) {
          if (method === 'turn/submit' && options.agentTurnSubmitReject) {
            throw new Error(typeof options.agentTurnSubmitReject === 'string'
              ? options.agentTurnSubmitReject
              : 'Mock turn/submit rejection');
          }
          const thread = threadById(String(input.threadId));
          const turnId = nextCanonicalId();
          const userItemId = nextCanonicalId();
          const responseItemId = nextCanonicalId();
          const content = Array.isArray(input.input) ? clone(input.input) as NonNullable<MockThreadItem['content']> : [];
          const prompt = content.flatMap((entry) => entry.type === 'text' ? [entry.text] : []).join('\n');
          const startedAt = ++now;
          const userItem: MockThreadItem = {
            id: userItemId,
            type: 'userMessage',
            author: { kind: 'reader' },
            provenance: itemProvenance(thread.id, turnId, userItemId),
            clientId: typeof input.clientUserMessageId === 'string' ? input.clientUserMessageId : null,
            acceptedAt: startedAt,
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
            items: options.agentTurnFailure && !options.agentTurnFailureHasResponse
              ? [userItem]
              : [userItem, responseItem],
            status: options.agentTurnFailure ? 'failed' : 'completed',
            error: options.agentTurnFailure ? { message: failureMessage } : null,
            completedAt: startedAt + 24,
            durationMs: 24,
          };
          thread.preview = prompt;
          thread.updatedAt = startedAt + 24;
          emitAgentCoreNotification({ type: 'turn/started', threadId: thread.id, turnId, turn: activeTurn });
          thread.status = { type: 'active', activeFlags: [] };
          emitAgentCoreNotification({ type: 'thread/status/changed', threadId: thread.id, status: thread.status });
          if (!options.agentTurnFailure) {
            emitAgentCoreNotification({
              type: 'item/started',
              threadId: thread.id,
              turnId,
              itemId: responseItemId,
              item: { ...responseItem, text: '' },
              startedAt: startedAt + 1,
            });
          }
          if (options.agentTurnStaysActive) {
            return clone({
              turn: activeTurn,
              ...(method === 'turn/submit' ? { turnId } : {}),
              acceptedItemId: userItemId,
              deduplicated: false,
            }) as T;
          }
          if (!options.agentTurnFailure) {
            emitAgentCoreNotification({
              type: 'item/completed',
              threadId: thread.id,
              turnId,
              itemId: responseItemId,
              item: responseItem,
              completedAt: startedAt + 23,
            });
          }
          thread.status = { type: 'idle' };
          emitAgentCoreNotification({ type: 'turn/completed', threadId: thread.id, turnId, turn: completedTurn });
          emitAgentCoreNotification({ type: 'thread/status/changed', threadId: thread.id, status: thread.status });
          return clone({
            turn: activeTurn,
            ...(method === 'turn/submit' ? { turnId } : {}),
            acceptedItemId: userItemId,
            deduplicated: false,
          }) as T;
        }
        if (method === 'turn/steer' || (method === 'turn/submit' && submittedActiveTurn)) {
          const threadId = String(input.threadId);
          const turnId = submittedActiveTurn?.id ?? String(input.expectedTurnId);
          const acceptedAt = ++now;
          const acceptedItemId = nextCanonicalId();
          const item: MockThreadItem = {
            id: acceptedItemId,
            type: 'userMessage',
            author: { kind: 'reader' },
            provenance: itemProvenance(threadId, turnId, acceptedItemId),
            clientId: typeof input.clientUserMessageId === 'string' ? input.clientUserMessageId : null,
            acceptedAt,
            content: Array.isArray(input.input) ? clone(input.input) as NonNullable<MockThreadItem['content']> : [],
          };
          emitAgentCoreNotification({
            type: 'items/completed',
            threadId,
            turnId,
            items: [item],
            completedAt: acceptedAt,
          });
          return clone({
            ...(method === 'turn/submit' ? { turn: null } : {}),
            turnId,
            acceptedItemId,
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
          } else {
            // A child Thread whose Turns reached the renderer as notifications
            // rather than through this mock's history: the host still settles
            // the addressed Turn, which is what the delegation row reads.
            const completedAt = ++now;
            emitAgentCoreNotification({
              type: 'turn/completed',
              threadId,
              turnId,
              turn: {
                id: turnId,
                items: [],
                itemsView: 'full',
                provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
                status: 'interrupted',
                error: null,
                startedAt: completedAt - 1,
                completedAt,
                durationMs: 1,
              },
            });
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
      onAutomationNotification: (listener) => {
        automationListeners.push(listener);
        return () => {
          const index = automationListeners.indexOf(listener);
          if (index >= 0) automationListeners.splice(index, 1);
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
      beginAttachmentUpload: async (input) => {
        const uploadId = `upload-${++sequence}`;
        attachmentUploads.set(uploadId, { ...input, receivedBytes: 0, chunks: [] });
        calls.push({ cmd: 'attachment-upload/begin', args: clone({ ...input, uploadId }) });
        return { uploadId };
      },
      appendAttachmentUpload: async (input) => {
        if (options.attachmentUploadDelayMs) await delay(options.attachmentUploadDelayMs);
        if (options.attachmentUploadReject) {
          throw new Error(typeof options.attachmentUploadReject === 'string'
            ? options.attachmentUploadReject
            : 'Mock attachment upload rejection');
        }
        const upload = attachmentUploads.get(input.uploadId);
        if (!upload) throw new Error('Mock attachment upload was not found');
        upload.receivedBytes += input.bytes.byteLength;
        upload.chunks.push(new Uint8Array(input.bytes.slice(0)));
        calls.push({
          cmd: 'attachment-upload/append',
          args: clone({
            threadId: input.threadId,
            attachmentId: input.attachmentId,
            uploadId: input.uploadId,
            byteLength: input.bytes.byteLength,
          }),
        });
        return {};
      },
      finishAttachmentUpload: async (input) => {
        const upload = attachmentUploads.get(input.uploadId);
        if (!upload || upload.receivedBytes !== upload.sizeBytes) {
          throw new Error('Mock attachment upload length mismatch');
        }
        attachmentUploads.delete(input.uploadId);
        calls.push({ cmd: 'attachment-upload/finish', args: clone(input) });
        const bytes = new Uint8Array(upload.receivedBytes);
        let offset = 0;
        for (const chunk of upload.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        return {
          id,
          mimeType: upload.mimeType,
          byteLength: upload.sizeBytes,
          fileName: upload.name,
        };
      },
      abortAttachmentUpload: async (input) => {
        attachmentUploads.delete(input.uploadId);
        calls.push({ cmd: 'attachment-upload/abort', args: clone(input) });
        return {};
      },
      discardAttachmentResource: async (input) => {
        calls.push({ cmd: 'attachment-resource/discard', args: clone(input) });
        return { discarded: true };
      },
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
              thumbnailDataUrl: 'data:image/png;base64,bW9jayBpbWFnZQ==',
            },
          };
        }
        return { file: null };
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
        if (cmd === 'memory_settings_get') {
          return clone(memorySettings) as T;
        }
        if (cmd === 'memory_feature_mode_set') {
          memorySettings.status.featureMode = String(args.mode ?? 'enabled');
          memorySettings.status.featureModeGeneration += 1;
          return clone(memorySettings) as T;
        }
        if (cmd === 'memory_open') {
          memorySettings.status.memoryVisibilityGeneration += 1;
          return clone(memorySettings) as T;
        }
        if (cmd === 'memory_reset') {
          memorySettings.status.resetEpoch += 1;
          memorySettings.status.lastSuccessfulRunAt = null;
          memorySettings.status.lastError = null;
          memorySettings.status.pendingJobs = 0;
          memorySettings.status.strayTaggedNodeCount = 0;
          return clone(memorySettings) as T;
        }
        // Managed-Skill channels. `managedCommand` unwraps an { ok, value } /
        // { ok, error } envelope, so these return that shape rather than the view
        // directly — a bare view would surface as `undefined` at the call site
        // instead of failing loudly.
        if (cmd === 'agent_managed_skill_list') {
          return { ok: true, value: clone(managedSkills) } as T;
        }
        if (cmd === 'agent_managed_skill_catalog') {
          return {
            ok: true,
            value: { status: options.managedCatalogStatus ?? 'fresh', entries: clone(managedCatalogEntries) },
          } as T;
        }
        if (cmd === 'agent_managed_skill_check_updates') {
          return { ok: true, value: clone(managedSkills) } as T;
        }
        if (cmd === 'agent_managed_skill_set_enabled') {
          const skill = managedSkills.find((candidate) => candidate.id === String(args.skillId ?? ''));
          if (!skill) return { ok: false, error: { code: 'skill_missing', message: 'Managed skill is no longer installed.' } } as T;
          skill.enabled = args.enabled === true;
          skill.status = skill.enabled ? 'enabled' : 'installed-disabled';
          return { ok: true, value: clone(skill) } as T;
        }
        if (cmd === 'agent_managed_skill_uninstall') {
          const index = managedSkills.findIndex((candidate) => candidate.id === String(args.skillId ?? ''));
          if (index >= 0) managedSkills.splice(index, 1);
          return { ok: true, value: clone(managedSkills) } as T;
        }
        if (cmd === 'agent_update_image_generation_settings') {
          const settings = (args.settings ?? {}) as { defaultModel?: string | null };
          agentSettings.imageGeneration = settings.defaultModel
            ? { defaultModel: settings.defaultModel }
            : {};
          return clone(agentSettings) as T;
        }
        // The Agents editor's whole surface: one read, three writes, all
        // answering with the refreshed view — the same contract the real
        // commands have, so a spec that drives the editor drives it for real.
        if (cmd === 'agent_identity_catalog') {
          return clone(agentIdentityView()) as T;
        }
        if (cmd === 'agent_write_role') {
          const role = args.role as {
            name: string; description: string; developerInstructions: string;
            persona?: string; color?: string;
            tools?: string[] | null; skills?: string[] | null;
          };
          const layer = args.layer === 'project' ? 'project' : 'user';
          const clash = agentRoles.find((candidate) => candidate.name === role.name);
          if (args.mode === 'create' && clash) {
            throw new Error(`An agent named '${role.name}' already exists in this layer`);
          }
          const next = {
            name: role.name,
            layer,
            description: role.description,
            developerInstructions: role.developerInstructions,
            persona: role.persona ?? null,
            color: role.color ?? null,
            tools: role.tools === undefined ? clash?.tools ?? null : role.tools,
            skills: role.skills === undefined ? clash?.skills ?? null : role.skills,
          };
          const index = agentRoles.findIndex((candidate) => candidate.name === role.name);
          if (index >= 0) agentRoles[index] = next;
          else agentRoles.push(next);
          applyAgentExecution(role.name, layer, args.execution);
          return clone(agentIdentityView()) as T;
        }
        if (cmd === 'agent_delete_role') {
          const name = String(args.name ?? '');
          const index = agentRoles.findIndex((candidate) => candidate.name === name);
          if (index < 0) throw new Error(`No Agent Role named '${name}' in this configuration`);
          const layer = agentRoles[index]!.layer;
          agentRoles.splice(index, 1);
          const executionIndex = agentExecutionSelections.findIndex((row) => (
            row.agentType === name && row.layer === layer
          ));
          if (executionIndex >= 0) agentExecutionSelections.splice(executionIndex, 1);
          return clone(agentIdentityView()) as T;
        }
        if (cmd === 'agent_write_profile') {
          const profile = (args.profile ?? {}) as {
            developerInstructions?: string; tools?: string[] | null; skills?: string[] | null;
          };
          agentProfile.layer = args.layer === 'project' ? 'project' : 'user';
          agentProfile.developerInstructions = profile.developerInstructions || null;
          // Three states, like the writer: undefined leaves it, null removes the
          // narrowing, an array — including empty — is the exact set.
          if (profile.tools !== undefined) agentProfile.tools = profile.tools;
          if (profile.skills !== undefined) agentProfile.skills = profile.skills;
          // The paired re-skin lands in the same write, not a second one.
          const presentation = args.presentation as { persona?: string; color?: string } | undefined;
          if (presentation) {
            const agentType = String(args.agentType ?? '');
            const entry = agentIdentityEntries.find((candidate) => candidate.agentType === agentType);
            if (entry && presentation.persona) entry.persona = presentation.persona;
            if (entry && presentation.color) entry.color = presentation.color;
          }
          return clone(agentIdentityView()) as T;
        }
        if (cmd === 'agent_write_presentation') {
          const agentType = String(args.agentType ?? '');
          const presentation = (args.presentation ?? {}) as { persona?: string; color?: string };
          if (presentation.color && !IDENTITY_COLOR_NAMES.includes(presentation.color)) {
            throw new Error(`Refused: Unknown identity colour '${presentation.color}'`);
          }
          const entry = agentIdentityEntries.find((candidate) => candidate.agentType === agentType);
          if (entry) {
            if (presentation.persona) entry.persona = presentation.persona;
            if (presentation.color) entry.color = presentation.color;
          }
          const layer = args.layer === 'project' ? 'project' : 'user';
          const index = agentPresentationOverrides.findIndex((row) => row.agentType === agentType);
          if (index >= 0) agentPresentationOverrides.splice(index, 1);
          if (presentation.persona || presentation.color) {
            agentPresentationOverrides.push({
              agentType,
              layer,
              persona: presentation.persona || null,
              color: presentation.color || null,
            });
          }
          applyAgentExecution(agentType, layer, args.execution);
          return clone(agentIdentityView()) as T;
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
        if (cmd === 'ingest_thread_resource') {
          const ref = args.resourceRef as { mimeType?: unknown; fileName?: unknown; byteLength?: unknown } | undefined;
          return clone(createAsset({
            mimeType: typeof ref?.mimeType === 'string' ? ref.mimeType : undefined,
            originalFilename: typeof ref?.fileName === 'string' ? ref.fileName : undefined,
            byteSize: typeof ref?.byteLength === 'number' ? ref.byteLength : undefined,
          })) as T;
        }
        if (cmd === 'lookup_asset') return clone(assets.get(String(args.id)) ?? null) as T;
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
            const browserStreamBytes = epubBytes
              ?? (asset?.mimeType.startsWith('image/')
                ? previewImageBytes(asset.originalFilename)
                : null);
            return clone({
              source: asset ? {
                kind: 'file',
                sourceKind: 'asset',
                id: `asset:${target.assetId}`,
                target: {
                  ...target,
                  label: asset.originalFilename || target.label || target.assetId,
                },
                name: asset.originalFilename || target.label || target.assetId,
                ext: (asset.originalFilename || '').split('.').pop() || '',
                mimeType: asset.mimeType,
                entryKind: 'file',
                sizeBytes: asset.byteSize,
                lastModified: asset.createdAt,
                streamUrl: browserStreamBytes
                  ? URL.createObjectURL(new Blob([browserStreamBytes], { type: asset.mimeType }))
                  : mockAssetUrl(target.assetId),
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
          if (target?.kind === 'url' && target.url) {
            return clone({
              source: {
                kind: 'url',
                id: `url:${target.url}`,
                target,
                title: target.label || target.url,
                url: target.url,
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
          if (target?.kind === 'local-file' && target.path?.toLowerCase().endsWith('.png')) {
            return { bytes: previewPngBytes(), mimeType: 'image/png' } as T;
          }
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
            return {
              bytes: previewImageBytes(imageAsset.originalFilename),
              mimeType: imageAsset.mimeType,
            } as T;
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
        if (cmd === 'preview_tag_template_backfill') {
          const { nodeCount, additionCount } = tagTemplateBackfillPlan(String(args.tagId));
          return clone({ nodeCount, additionCount });
        }
        if (cmd === 'apply_template_to_tagged_nodes') {
          const plan = tagTemplateBackfillPlan(String(args.tagId));
          for (const target of plan.targets) {
            for (const templateNodeId of target.templateNodeIds) {
              cloneTemplateContentNode(target.nodeId, templateNodeId);
            }
          }
          return clone(outcome());
        }
        if (cmd === 'apply_tag' || cmd === 'batch_apply_tag') {
          const tagId = String(args.tagId);
          const targetIds = cmd === 'apply_tag' ? [String(args.nodeId)] : args.nodeIds as string[];
          for (const nodeId of targetIds) {
            const node = nodes.get(nodeId);
            if (node && !node.tags.includes(tagId)) {
              node.tags.push(tagId);
              for (const templateNodeId of tagTemplateContentNodeIds(tagId)) {
                cloneTemplateContentNode(nodeId, templateNodeId);
              }
            }
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
        if (cmd === 'update_field_slot') {
          return clone(updateFieldSlot(args));
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
	          const nodeId = String(args.nodeId);
	          if (nodes.has(nodeId)) {
	            const view = ensureViewDef(nodeId);
	            const previousMode = view.viewMode ?? 'list';
	            const nextMode = String(args.mode ?? 'list');
	            view.viewMode = nextMode;
	            const entersTable = (globalThis as typeof globalThis & {
	              __linViewConfigHelpers?: { entersTable: (previous: string | undefined, next: string) => boolean };
	            }).__linViewConfigHelpers?.entersTable;
	            if (!entersTable) throw new Error('Missing shared view configuration helpers');
	            if (entersTable(previousMode, nextMode)) addMissingTableDisplayFields(nodeId, view);
	          }
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

    // The action seam runs the REAL main-side service in the page (bundled by
    // `installElectronMock` from `actionBridgeEntry.ts`), so the e2e suite
    // asserts the product's registry rather than a mock's opinion of it.
    const actionStepListeners: Array<(envelope: unknown) => unknown> = [];
    const bridgeFactory = (globalThis as unknown as {
      __linActionBridgeFactory?: (host: {
        projection: () => unknown;
        runCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>;
        writeClipboard: (text: string) => void;
        runRendererStep: (envelope: { invocationRef: string; step: unknown }) => void;
      }) => Record<string, unknown>;
    }).__linActionBridgeFactory;
    if (bridgeFactory && win.lin) {
      const bridge = bridgeFactory({
        projection: () => projection(),
        runCommand: async (command, args) => {
          // Mirror the real main process: it does NOT tag the command with a
          // source renderer, so the projection-changed event is delivered to
          // the renderer instead of being suppressed as its own echo.
          const result = await win.lin!.invoke<{ update?: unknown }>(command, args);
          if (result && typeof result === 'object' && 'update' in result) {
            emitDocumentEvent({
              type: 'projection_changed',
              origin: 'user',
              update: result.update,
              timestamp: Date.now(),
            });
          }
          return result;
        },
        writeClipboard: (text) => { clipboardText = text; },
        runRendererStep: ({ invocationRef, step }) => {
          for (const listener of actionStepListeners) {
            listener({ token: 'e2e', invocationRef, step });
          }
        },
      });
      (win.lin as unknown as { actions: unknown }).actions = {
        ...bridge,
        onStep: (listener: (envelope: unknown) => unknown) => {
          actionStepListeners.push(listener);
          return () => {
            const index = actionStepListeners.indexOf(listener);
            if (index >= 0) actionStepListeners.splice(index, 1);
          };
        },
      };
    }
  }, {
    assetUrlPrefix: assetUrl(''),
    ids,
    options,
    queryChildLimit: SEARCH_QUERY_COMPLEXITY_LIMITS.maxChildrenPerGroup,
  });
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

export async function setNextThreadStartBehavior(
  page: Page,
  behavior: { delayMs?: number; error?: string },
) {
  await page.evaluate((nextBehavior) => {
    const win = window as E2EWindow;
    win.__LIN_E2E__?.setNextThreadStartBehavior(nextBehavior);
  }, behavior);
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

export interface E2EProjectionNode {
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
  fieldDefId?: string;
  fieldType?: string;
  nullable?: boolean;
  hideField?: string;
  autocollectOptions?: boolean;
  minValue?: number;
  maxValue?: number;
  sourceSupertag?: string;
  templateId?: string;
}

export async function e2eProjection(page: Page): Promise<{ nodes: E2EProjectionNode[] }> {
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
      fieldDefId?: string;
      nullable?: boolean;
      hideField?: string;
      autocollectOptions?: boolean;
      minValue?: number;
      maxValue?: number;
      sourceSupertag?: string;
      templateId?: string;
    }> };
  });
}

export function ordinaryChildIds(node: { id: string; children: string[] } | null | undefined): string[] {
  return node?.children ?? [];
}

export function sourceFieldEntries(
  projection: { nodes: E2EProjectionNode[] },
  ownerId: string,
): E2EProjectionNode[] {
  const owner = projection.nodes.find((node) => node.id === ownerId);
  return owner?.children.flatMap((childId) => {
    const child = projection.nodes.find((node) => node.id === childId);
    return child?.type === 'fieldEntry' && child.fieldDefId === 'field:source' ? [child] : [];
  }) ?? [];
}

export function sourceFieldValues(
  projection: { nodes: E2EProjectionNode[] },
  ownerId: string,
): E2EProjectionNode[] {
  return sourceFieldEntries(projection, ownerId).flatMap((entry) => entry.children.flatMap((valueId) => {
    const value = projection.nodes.find((node) => node.id === valueId);
    return value ? [value] : [];
  }));
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

export async function appliedOutlineOperations(page: Page, fromCall = 0): Promise<Array<Record<string, unknown>>> {
  const calls = (await commandCalls(page)).slice(fromCall);
  return calls.flatMap((call) => {
    const input = call.args as {
      diff?: { normalizedChangeSet?: { operations?: Array<Record<string, unknown>> } };
      changeSet?: { operations?: Array<Record<string, unknown>> };
    };
    if (call.cmd === 'outline/apply') return input.diff?.normalizedChangeSet?.operations ?? [];
    if (call.cmd === 'outline/transact') return input.changeSet?.operations ?? [];
    return [];
  });
}

export interface OutlineMutationMatch {
  instructionKind?: string;
  op?: string;
}

/**
 * Holds the first matching renderer mutation before it reaches the mock
 * Runtime. Tests can assert the complete optimistic frame, then release the
 * exact request and verify authoritative settlement without timing windows.
 */
export async function holdOutlineMutation(
  page: Page,
  match: OutlineMutationMatch = {},
): Promise<() => Promise<void>> {
  const gateId = `outline-mutation-${Date.now()}-${Math.random()}`;
  await page.evaluate(({ gateId, match }) => {
    const win = window as E2EWindow & {
      __outlineMutationGates?: Record<string, () => void>;
    };
    const outline = win.lin?.outline;
    if (!outline) throw new Error('Missing Outline bridge');
    const originalRequest = outline.request;
    let releaseGate = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    win.__outlineMutationGates ??= {};
    win.__outlineMutationGates[gateId] = releaseGate;
    let held = false;

    outline.request = async (request) => {
      const input = request.input as {
        changeSet?: { operations?: Array<Record<string, unknown>> };
        diff?: { normalizedChangeSet?: { operations?: Array<Record<string, unknown>> } };
      };
      const operations = request.command === 'transact'
        ? input.changeSet?.operations ?? []
        : input.diff?.normalizedChangeSet?.operations ?? [];
      const matches = !held
        && (request.command === 'apply' || request.command === 'transact')
        && operations.some((operation) => (
          (!match.op || operation.op === match.op)
          && (!match.instructionKind || (
            Array.isArray(operation.changes)
            && operation.changes.some((change) => (
              typeof change === 'object'
              && change !== null
              && (change as Record<string, unknown>).kind === match.instructionKind
            ))
          ))
        ));
      if (matches) {
        held = true;
        await gate;
      }
      return originalRequest(request);
    };
  }, { gateId, match });

  return async () => {
    await page.evaluate((id) => {
      const win = window as E2EWindow & {
        __outlineMutationGates?: Record<string, () => void>;
      };
      win.__outlineMutationGates?.[id]?.();
      if (win.__outlineMutationGates) delete win.__outlineMutationGates[id];
    }, gateId);
  };
}

export async function observeNextRowMoveAnimation(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((targetNodeId) => {
    type RowMoveObservation = {
      nodeId: string;
      observed: boolean;
      observer: MutationObserver;
    };
    const win = window as Window & {
      __rowMoveAnimationObservation?: RowMoveObservation;
    };
    win.__rowMoveAnimationObservation?.observer.disconnect();

    let observation: RowMoveObservation;
    const inspect = () => {
      const animated = [...document.querySelectorAll<HTMLElement>('[data-node-id][data-parent-id] > .row')]
        .some((row) => (
          row.parentElement?.dataset.nodeId === targetNodeId
          && row.classList.contains('row-move-animating')
        ));
      if (!animated) return;
      observation.observed = true;
      observation.observer.disconnect();
    };
    observation = {
      nodeId: targetNodeId,
      observed: false,
      observer: new MutationObserver(inspect),
    };
    win.__rowMoveAnimationObservation = observation;
    observation.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
    inspect();
  }, nodeId);
}

export async function expectRowMoveAnimationObserved(page: Page, nodeId: string): Promise<void> {
  await expect.poll(() => page.evaluate((targetNodeId) => {
    const observation = (window as Window & {
      __rowMoveAnimationObservation?: { nodeId: string; observed: boolean };
    }).__rowMoveAnimationObservation;
    return observation?.nodeId === targetNodeId && observation.observed;
  }, nodeId), { timeout: 1000 }).toBe(true);
}

export async function clipboardText(page: Page) {
  return page.evaluate(() => {
    const win = window as E2EWindow;
    return win.__LIN_E2E__?.clipboardText() ?? '';
  });
}
