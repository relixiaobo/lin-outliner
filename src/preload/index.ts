import type { ProviderApiKeyReadMode, ProviderApiKeyReadResult } from '../core/providerApiKeyPreview';
import type { PreferenceEdit, PreferencesView } from '../core/settingsDefinitions';
import type { DelegationSettingsView } from '../core/delegationSettings';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { MEMORY_CHANGED_CHANNEL } from '../core/agent/memoryOperations';
import { DATA_CHANGED_CHANNEL, PREVIEW_ACTION_CHANNEL, PREVIEW_ACTION_ACK_CHANNEL, PREVIEW_CONTEXT_CHANNEL, PREVIEW_OPERATIONS_CHANNEL,
  type PreviewAction, type PreviewActionAck, type PreviewObservation, type PreviewOperationName, type PreviewOperationResult } from '../core/previewOperations';
import { SKILL_LIBRARY_CHANGED_CHANNEL, SKILL_REVIEW_DECIDE_CHANNEL, SKILL_REVIEW_GET_CHANNEL, SKILL_REVIEW_PRELOAD_ARG } from '../core/agent/skillOperations';
import {
  STARTUP_GET_CHANNEL, STARTUP_QUIT_CHANNEL, STARTUP_RETRY_CHANNEL, STARTUP_STATE_CHANNEL,
  STARTUP_ISSUE_ACTION_CHANNEL, type StartupIssueAction, type StartupState,
} from '../core/startup';
import { buildLauncherPreloadApi } from './launcher';
import { LAUNCHER_PRELOAD_ROLE_ARG } from '../core/launcher/commands';
import {
  ACTION_AMBIENT_SEED_REQUEST_CHANNEL,
  ACTION_AMBIENT_SEED_RESPONSE_CHANNEL,
  ACTION_EVENT_CHANNEL,
  ACTION_OPEN_CHANNEL,
  ACTION_PARAMETER_QUERY_CHANNEL,
  ACTION_REQUEST_CHANNEL,
  ACTION_STEP_ACK_CHANNEL,
  ACTION_STEP_CHANNEL,
  type ActionStepAck,
  type ActionStepEnvelope,
} from '../core/actions/transport';
import type {
  ActionRequest,
  ActionRequestResult,
  InvocationEvent,
  InvocationEventResult,
  InvocationOpened,
  InvocationSeed,
  ParameterObjectQueryRequest,
  ParameterObjectQueryResult,
} from '../core/actions/types';
import { decodeRendererAgentCoreNotification, decodeRendererAgentCoreResponse } from '../core/agent/codec';
import type {
  AgentCoreMethod,
  RendererAgentCoreNotification,
  AgentCoreRequestByMethod,
  RendererAgentCoreResponseByMethod,
  ThreadResourceReference,
  ThreadMessageContextMenuAction,
  ThreadMessageContextMenuRequest,
} from '../core/agent/protocol';
import {
  AGENT_CORE_NOTIFICATION_CHANNEL,
  AGENT_CORE_REQUEST_CHANNEL,
  THREAD_MESSAGE_CONTEXT_MENU_CHANNEL,
} from '../core/agent/transport';
import {
  AUTOMATION_NOTIFICATION_CHANNEL,
  AUTOMATION_REQUEST_CHANNEL,
  decodeAutomationNotification,
  decodeAutomationResponse,
  type AutomationMethod,
  type AutomationNotification,
  type AutomationRequestByMethod,
  type AutomationResponseByMethod,
} from '../core/agent/automation';
import {
  LIN_AGENT_OAUTH_EVENT_CHANNEL,
  type OAuthLoginEventEnvelope,
} from '../core/types';
import { windowMaterialKind } from '../core/windowMaterial';
import {
  CONFIGURATION_CHANGED_CHANNEL,
  type ConfigurationDomain,
  LIN_SETTINGS_NAVIGATE_CHANNEL,
  type SettingsOpenTarget,
} from '../core/settingsWindow';
import { LIN_WINDOW_ACTIVE_CHANNEL } from '../core/windowActivity';
import type { ThemeMode } from '../core/theme';
import { DEFAULT_LOCALE, isLocale, LIN_LANGUAGE_CHANGED_CHANNEL, type Locale } from '../core/locale';
import { LAUNCHER_NAVIGATE_TO_NODE_CHANNEL } from '../core/launcher/commands';
import {
  LIN_APP_INFO_CHANNEL,
  LIN_EXPORT_DIAGNOSTICS_CHANNEL,
  LIN_REPORT_RENDERER_ERROR_CHANNEL,
  LIN_REVEAL_DIAGNOSTICS_LOG_CHANNEL,
  type AppInfo,
  type DiagnosticsActionResult,
  type ErrorReport,
} from '../core/errorObservability';
import {
  LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL,
} from '../core/urlPageTranslation';
import {
  LIN_URL_PAGE_TRANSLATION_GUEST_CHANNEL,
  type UrlPageTranslationGuestRequest,
} from '../core/urlPageTranslationGuest';
import {
  LIN_APP_UPDATE_CHANGED_CHANNEL,
  LIN_APP_UPDATE_CHECK_CHANNEL,
  LIN_APP_UPDATE_GET_CHANNEL,
  LIN_APP_UPDATE_OPEN_CHANNEL,
  LIN_APP_UPDATE_SET_AUTOMATIC_CHANNEL,
  type AppUpdateOpenResult,
  type AppUpdateView,
} from '../core/appUpdateProtocol';
import {
  LIN_APP_OPEN_DESTINATION_CHANNEL,
  LIN_APP_RELEASE_CHANNEL,
  type ApplicationDestination,
  type BundledApplicationRelease,
} from '../core/applicationOperations';
import { OUTLINE_PROTOCOL_VERSION } from '../outline/contract/version';
import {
  KEYBINDINGS_CHANGED_CHANNEL,
  KEYBINDINGS_GET_CHANNEL,
  KEYBINDINGS_GET_SYNC_CHANNEL,
  KEYBINDINGS_OPEN_FILE_CHANNEL,
  KEYBINDINGS_UPDATE_CHANNEL,
  effectiveShortcutBindings,
  type EffectiveShortcutBindings,
  type KeybindingsUpdateInput,
  type KeybindingsView,
} from '../core/keybindings';
import type { OutlineStreamRecord } from '../outline/contract/schemas';
import {
  OUTLINE_DESKTOP_CANCEL_CHANNEL,
  OUTLINE_DESKTOP_COMMIT_CHANNEL,
  OUTLINE_DESKTOP_REQUEST_CHANNEL,
  OUTLINE_DESKTOP_STREAM_CHANNEL,
  OUTLINE_DESKTOP_SUBSCRIBE_CHANNEL,
  OUTLINE_DESKTOP_UNSUBSCRIBE_CHANNEL,
  type OutlineDesktopRequest,
  type OutlineDesktopCommitRequest,
  type OutlineDesktopCommitResponse,
  type OutlineDesktopResponse,
  type OutlineDesktopStreamMessage,
  type OutlineDesktopSubscription,
} from '../main/outlineClient/protocol';

export interface LinPickedLocalFile {
  entryKind?: 'file' | 'directory';
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  lastModified: number;
  iconDataUrl?: string;
  thumbnailDataUrl?: string;
}

export interface LinPickLocalFilesResult {
  canceled: boolean;
  files: LinPickedLocalFile[];
  rejectedFiles?: LinRejectedLocalFile[];
  skippedCount?: number;
}

export interface LinRejectedLocalFile {
  name: string;
  reason: 'officeOwnershipFile';
  suggestedName?: string;
}

export interface LinPickLocalFilesOptions {
  maxFiles?: number;
}

export interface LinLocalFileSearchResult {
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
}

export interface LinSearchLocalFilesOptions {
  query: string;
  limit?: number;
}

export interface LinSearchLocalFilesResult {
  files: LinLocalFileSearchResult[];
  query: string;
}

export interface LinRecentLocalFilesOptions {
  limit?: number;
}

export interface LinRecentLocalFilesResult {
  files: LinLocalFileSearchResult[];
}

export interface LinPrepareLocalFileOptions {
  id: string;
}

export interface LinPrepareLocalFileResult {
  file: LinPickedLocalFile | null;
}

export interface LinPreviewLocalFileOptions {
  id: string;
}

export interface LinPreviewLocalFileResult {
  thumbnailDataUrl: string | null;
}

export interface LinLocalFileReferencePreview {
  entryKind: 'file' | 'directory';
  path: string;
  name: string;
  parentPath: string;
  mimeType: string;
  sizeBytes: number;
  lastModified: number;
  iconDataUrl?: string;
  thumbnailDataUrl?: string;
}

export interface LinPreviewLocalFileReferenceOptions {
  path: string;
  threadId?: string;
  attachmentId?: string;
  resourceRef?: ThreadResourceReference;
  resourceIntent?: 'delivered' | 'source';
}

export interface LinPreviewLocalFileReferenceResult {
  file: LinLocalFileReferencePreview | null;
}

export interface LinOpenLocalFileOptions {
  path: string;
  threadId?: string;
  attachmentId?: string;
  resourceRef?: ThreadResourceReference;
  resourceIntent?: 'delivered' | 'source';
}

export interface LinOpenLocalFileResult {
  opened: boolean;
}

export interface LinRevealLocalFileResult {
  revealed: boolean;
}

export interface LinBeginAttachmentUploadInput {
  threadId: string;
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface LinAttachmentUploadIdentity {
  threadId: string;
  attachmentId: string;
  uploadId: string;
}

export interface LinAppendAttachmentUploadInput extends LinAttachmentUploadIdentity {
  bytes: ArrayBuffer;
}

export interface LinBeginAttachmentUploadResult {
  uploadId: string;
}

export interface LinDiscardAttachmentResourceInput {
  threadId: string;
  ref: ThreadResourceReference;
}

const nativeAttachmentPickerDisabled = process.env.LIN_ATTACHMENT_PICKER_METHOD === 'web'
  || process.env.LIN_DISABLE_NATIVE_ATTACHMENT_PICKER === '1';

function reportRendererError(report: ErrorReport): void {
  void ipcRenderer.invoke(LIN_REPORT_RENDERER_ERROR_CHANNEL, report).catch(() => undefined);
}

// Read the effective UI language synchronously at preload time so the renderer's
// I18nProvider can seed its first render before paint (no English→target flash).
// The main process resolves it (stored pick, else OS locale); a one-time sendSync
// is the standard Electron pattern for this and runs once per window.
function readInitialLanguage(): Locale {
  try {
    const value = ipcRenderer.sendSync('lin:get-language-sync');
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function readInitialKeybindings(): EffectiveShortcutBindings {
  try {
    const value = ipcRenderer.sendSync(KEYBINDINGS_GET_SYNC_CHANNEL) as EffectiveShortcutBindings;
    return value ?? effectiveShortcutBindings({});
  } catch {
    return effectiveShortcutBindings({});
  }
}

const api = {
  initialKeybindings: readInitialKeybindings(),
  keybindings: {
    get: () => ipcRenderer.invoke(KEYBINDINGS_GET_CHANNEL) as Promise<KeybindingsView>,
    update: (input: KeybindingsUpdateInput) => (
      ipcRenderer.invoke(KEYBINDINGS_UPDATE_CHANNEL, input) as Promise<KeybindingsView>
    ),
    openFile: () => ipcRenderer.invoke(KEYBINDINGS_OPEN_FILE_CHANNEL) as Promise<void>,
    onChanged: (listener: (view: KeybindingsView) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, view: KeybindingsView) => listener(view);
      ipcRenderer.on(KEYBINDINGS_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(KEYBINDINGS_CHANGED_CHANNEL, handler);
    },
  },
  onMemoryChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(MEMORY_CHANGED_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(MEMORY_CHANGED_CHANNEL, handler); };
  },
  skillReview: {
    get: () => ipcRenderer.invoke(SKILL_REVIEW_GET_CHANNEL) as Promise<import('../core/agent/skillOperations').SkillReview>,
    decide: (approved: boolean) => ipcRenderer.invoke(SKILL_REVIEW_DECIDE_CHANNEL, approved) as Promise<void>,
  },
  onSkillLibraryChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(SKILL_LIBRARY_CHANGED_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(SKILL_LIBRARY_CHANGED_CHANNEL, handler); };
  },
  startup: {
    issueAction: (startupIssueId: string, action: StartupIssueAction) => ipcRenderer.invoke(
      STARTUP_ISSUE_ACTION_CHANNEL, { startupIssueId, action },
    ) as Promise<void>,
    get: () => ipcRenderer.invoke(STARTUP_GET_CHANNEL) as Promise<StartupState>,
    retry: () => ipcRenderer.invoke(STARTUP_RETRY_CHANNEL) as Promise<StartupState>,
    quit: () => ipcRenderer.invoke(STARTUP_QUIT_CHANNEL) as Promise<void>,
    onChanged: (listener: (state: StartupState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: StartupState) => listener(state);
      ipcRenderer.on(STARTUP_STATE_CHANNEL, handler);
      return () => ipcRenderer.removeListener(STARTUP_STATE_CHANNEL, handler);
    },
  },
  // Which OS window material the main process applied, so the renderer can make
  // its chrome surfaces translucent only when there's a material behind them.
  windowMaterial: windowMaterialKind(process.platform),
  invoke: <T>(command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke('lin:invoke', command, args) as Promise<T>,
  outline: {
    request: (request: OutlineDesktopRequest) => (
      ipcRenderer.invoke(OUTLINE_DESKTOP_REQUEST_CHANNEL, request) as Promise<OutlineDesktopResponse>
    ),
    commit: (request: OutlineDesktopCommitRequest) => (
      ipcRenderer.invoke(OUTLINE_DESKTOP_COMMIT_CHANNEL, request) as Promise<OutlineDesktopCommitResponse>
    ),
    cancel: (requestId: string) => {
      ipcRenderer.send(OUTLINE_DESKTOP_CANCEL_CHANNEL, requestId);
    },
    subscribe: (
      subscription: OutlineDesktopSubscription,
      listener: (record: OutlineStreamRecord) => void,
    ) => {
      let active = true;
      const handler = (_event: Electron.IpcRendererEvent, message: OutlineDesktopStreamMessage) => {
        if (active && message.subscriptionId === subscription.subscriptionId) listener(message.record);
      };
      ipcRenderer.on(OUTLINE_DESKTOP_STREAM_CHANNEL, handler);
      void ipcRenderer.invoke(OUTLINE_DESKTOP_SUBSCRIBE_CHANNEL, subscription).catch((error: unknown) => {
        if (!active) return;
        listener({
          protocolVersion: OUTLINE_PROTOCOL_VERSION,
          requestId: `desktop:${subscription.subscriptionId}`,
          sequence: 0,
          type: 'error',
          error: {
            code: 'runtime_unavailable',
            category: 'unavailable',
            message: error instanceof Error ? error.message : 'Outline Runtime subscription failed.',
            retryable: true,
          },
        } as unknown as OutlineStreamRecord);
      });
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(OUTLINE_DESKTOP_STREAM_CHANNEL, handler);
        ipcRenderer.send(OUTLINE_DESKTOP_UNSUBSCRIBE_CHANNEL, subscription.subscriptionId);
      };
    },
  },
  agentCoreRequest: <Method extends AgentCoreMethod>(
    method: Method,
    input: AgentCoreRequestByMethod[Method],
  ) => ipcRenderer.invoke(AGENT_CORE_REQUEST_CHANNEL, method, input)
    .then((response) => decodeRendererAgentCoreResponse(method, response)) as Promise<RendererAgentCoreResponseByMethod[Method]>,
  onAgentCoreNotification: (listener: (notification: RendererAgentCoreNotification) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, notification: unknown) => {
      try { listener(decodeRendererAgentCoreNotification(notification)); }
      catch { console.error('[agent:user-input] preload notification decode/consumer failed'); }
    };
    ipcRenderer.on(AGENT_CORE_NOTIFICATION_CHANNEL, handler);
    return () => ipcRenderer.removeListener(AGENT_CORE_NOTIFICATION_CHANNEL, handler);
  },
  automationRequest: <Method extends AutomationMethod>(
    method: Method,
    input: AutomationRequestByMethod[Method],
  ) => ipcRenderer.invoke(AUTOMATION_REQUEST_CHANNEL, method, input)
    .then((response) => decodeAutomationResponse(method, response)) as Promise<AutomationResponseByMethod[Method]>,
  onAutomationNotification: (listener: (notification: AutomationNotification) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, notification: unknown) => (
      listener(decodeAutomationNotification(notification))
    );
    ipcRenderer.on(AUTOMATION_NOTIFICATION_CHANNEL, handler);
    return () => ipcRenderer.removeListener(AUTOMATION_NOTIFICATION_CHANNEL, handler);
  },
  showThreadMessageContextMenu: (request: ThreadMessageContextMenuRequest) =>
    ipcRenderer.invoke(THREAD_MESSAGE_CONTEXT_MENU_CHANNEL, request) as Promise<ThreadMessageContextMenuAction | null>,
  recordNodeAccess: (nodeId: string) =>
    ipcRenderer.invoke('lin:record-node-access', nodeId) as Promise<void>,
  onAgentOAuthEvent: (listener: (envelope: OAuthLoginEventEnvelope) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: OAuthLoginEventEnvelope) => listener(payload);
    ipcRenderer.on(LIN_AGENT_OAUTH_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_AGENT_OAUTH_EVENT_CHANNEL, handler);
    };
  },
  window: {
    minimize: () => ipcRenderer.invoke('lin:window', 'minimize') as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke('lin:window', 'toggle_maximize') as Promise<void>,
    close: () => ipcRenderer.invoke('lin:window', 'close') as Promise<void>,
  },
  openSettings: (target?: SettingsOpenTarget) => ipcRenderer.invoke('lin:open-settings', target) as Promise<void>,
  closeSettings: () => ipcRenderer.invoke('lin:close-settings') as Promise<void>,
  // Appearance preference. setTheme applies immediately across all windows (via
  // nativeTheme.themeSource → prefers-color-scheme) and persists; getTheme returns
  // the stored mode so the settings control can reflect the current pick.
  getTheme: () => ipcRenderer.invoke('lin:get-theme') as Promise<ThemeMode>,
  setTheme: (mode: ThemeMode) => ipcRenderer.invoke('lin:set-theme', mode) as Promise<void>,
  /** Summon the command surface from an in-app entry point. */
  showLauncher: () => ipcRenderer.invoke('lin:show-launcher') as Promise<void>,
  registerPreview: (observation: PreviewObservation) => ipcRenderer.invoke(PREVIEW_CONTEXT_CHANNEL, 'register', null, observation) as Promise<string>,
  observePreview: (previewId: string, observation: PreviewObservation) => ipcRenderer.invoke(PREVIEW_CONTEXT_CHANNEL, 'observe', previewId, observation) as Promise<void>,
  unregisterPreview: (previewId: string) => ipcRenderer.invoke(PREVIEW_CONTEXT_CHANNEL, 'unregister', previewId) as Promise<void>,
  acknowledgePreview: (ack: PreviewActionAck) => ipcRenderer.invoke(PREVIEW_ACTION_ACK_CHANNEL, ack) as Promise<void>,
  previewOperation: (name: PreviewOperationName, input: unknown) => ipcRenderer.invoke(PREVIEW_OPERATIONS_CHANNEL, name, input) as Promise<PreviewOperationResult>,
  onPreviewAction: (listener: (action: PreviewAction) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: PreviewAction) => listener(action);
    ipcRenderer.on(PREVIEW_ACTION_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(PREVIEW_ACTION_CHANNEL, handler); };
  },
  onPreviewDataChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(DATA_CHANGED_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(DATA_CHANGED_CHANNEL, handler); };
  },
  // Language preference. initialLanguage is the synchronously-resolved effective
  // locale for first paint; setLanguage applies immediately across all windows (the
  // main process broadcasts it + rebuilds the native menu) and persists;
  // onLanguageChanged lets every window follow a change made from the settings pane.
  initialLanguage: readInitialLanguage(),
  setLanguage: (locale: Locale) => ipcRenderer.invoke('lin:set-language', locale) as Promise<void>,
  onLanguageChanged: (listener: (locale: Locale) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, locale: Locale) => listener(locale);
    ipcRenderer.on(LIN_LANGUAGE_CHANGED_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_LANGUAGE_CHANGED_CHANNEL, handler);
    };
  },
  onUrlPageTranslationShortcut: (listener: (webContentsId: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, webContentsId: unknown) => {
      if (typeof webContentsId === 'number' && Number.isInteger(webContentsId) && webContentsId > 0) {
        listener(webContentsId);
      }
    };
    ipcRenderer.on(LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL, handler);
    };
  },
  executeUrlPageTranslationGuest: (request: UrlPageTranslationGuestRequest) =>
    ipcRenderer.invoke(LIN_URL_PAGE_TRANSLATION_GUEST_CHANNEL, request) as Promise<unknown>,
  openProviderConfig: (params: { providerId: string; mode: 'configure' | 'custom' }) =>
    ipcRenderer.invoke('lin:open-provider-config', params) as Promise<void>,
  closeProviderConfig: () => ipcRenderer.invoke('lin:close-provider-config') as Promise<void>,
  getProviderApiKey: <Mode extends ProviderApiKeyReadMode>(providerId: string, mode: Mode) =>
    ipcRenderer.invoke('lin:get-provider-api-key', { providerId, mode }) as Promise<ProviderApiKeyReadResult<Mode>>,
  preferences: {
    get: () => ipcRenderer.invoke('lin:preferences/get') as Promise<PreferencesView>,
    edit: (input: PreferenceEdit) => ipcRenderer.invoke('lin:preferences/edit', input) as Promise<PreferencesView>,
    openFile: () => ipcRenderer.invoke('lin:preferences/open-file') as Promise<void>,
    openSource: (sourceId: 'agent-user' | 'agent-project' | 'shortcuts') => ipcRenderer.invoke('lin:configuration/open-source', sourceId) as Promise<void>,
  },
  getDelegationSettings: () => ipcRenderer.invoke('lin:delegation/get') as Promise<DelegationSettingsView>,
  appInfo: () => ipcRenderer.invoke(LIN_APP_INFO_CHANNEL) as Promise<AppInfo>,
  bundledApplicationRelease: () =>
    ipcRenderer.invoke(LIN_APP_RELEASE_CHANNEL) as Promise<BundledApplicationRelease | null>,
  openApplicationDestination: (destination: Exclude<ApplicationDestination, 'release' | 'download'>) =>
    ipcRenderer.invoke(LIN_APP_OPEN_DESTINATION_CHANNEL, destination) as Promise<void>,
  appUpdate: {
    get: () => ipcRenderer.invoke(LIN_APP_UPDATE_GET_CHANNEL) as Promise<AppUpdateView>,
    check: () => ipcRenderer.invoke(LIN_APP_UPDATE_CHECK_CHANNEL) as Promise<AppUpdateView>,
    setAutomaticChecksEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(LIN_APP_UPDATE_SET_AUTOMATIC_CHANNEL, enabled) as Promise<AppUpdateView>,
    open: () => ipcRenderer.invoke(LIN_APP_UPDATE_OPEN_CHANNEL) as Promise<AppUpdateOpenResult>,
    onChanged: (listener: (view: AppUpdateView) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, view: AppUpdateView) => listener(view);
      ipcRenderer.on(LIN_APP_UPDATE_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(LIN_APP_UPDATE_CHANGED_CHANNEL, handler);
    },
  },
  revealDiagnosticsLog: () =>
    ipcRenderer.invoke(LIN_REVEAL_DIAGNOSTICS_LOG_CHANNEL) as Promise<DiagnosticsActionResult>,
  exportDiagnostics: () =>
    ipcRenderer.invoke(LIN_EXPORT_DIAGNOSTICS_CHANNEL) as Promise<DiagnosticsActionResult>,
  reportRendererError: (report: ErrorReport) => reportRendererError(report),
  onConfigurationChanged: (domain: ConfigurationDomain, listener: () => void) => {
    const handler = (_event: Electron.IpcRendererEvent, changed: ConfigurationDomain) => { if (changed === domain) listener(); };
    ipcRenderer.on(CONFIGURATION_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(CONFIGURATION_CHANGED_CHANNEL, handler);
  },
  onSettingsNavigate: (listener: (target: SettingsOpenTarget) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: SettingsOpenTarget) => listener(target);
    ipcRenderer.on(LIN_SETTINGS_NAVIGATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_SETTINGS_NAVIGATE_CHANNEL, handler);
    };
  },
  // The main process forwards the window's OS focus state so the chrome can
  // desaturate while the window is inactive (the macOS inactive-window look).
  onWindowActiveChange: (listener: (active: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, active: boolean) => listener(active);
    ipcRenderer.on(LIN_WINDOW_ACTIVE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_WINDOW_ACTIVE_CHANNEL, handler);
    };
  },
  // The global launcher asked to open a node (an inline search result) — jump the
  // active panel to it and focus it.
  onNavigateToNode: (listener: (nodeId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, nodeId: string) => listener(nodeId);
    ipcRenderer.on(LAUNCHER_NAVIGATE_TO_NODE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LAUNCHER_NAVIGATE_TO_NODE_CHANNEL, handler);
    };
  },
  // The action seam. A renderer may NAME an action — action id, invocation ref,
  // subject ref, typed arguments — and nothing else; main re-evaluates and
  // executes. Effect plans travel main -> renderer only.
  actions: {
    /** Main asks what the user had focused; the app shell answers. */
    onAmbientSeedRequest: (respond: (token: string) => unknown) => {
      const handler = (_event: Electron.IpcRendererEvent, request: { token: string }) => {
        void ipcRenderer.invoke(ACTION_AMBIENT_SEED_RESPONSE_CHANNEL, {
          token: request.token,
          seed: respond(request.token),
        });
      };
      ipcRenderer.on(ACTION_AMBIENT_SEED_REQUEST_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(ACTION_AMBIENT_SEED_REQUEST_CHANNEL, handler);
      };
    },
    open: (seed: InvocationSeed) =>
      ipcRenderer.invoke(ACTION_OPEN_CHANNEL, seed) as Promise<InvocationOpened | null>,
    queryParameters: (request: ParameterObjectQueryRequest) =>
      ipcRenderer.invoke(ACTION_PARAMETER_QUERY_CHANNEL, request) as Promise<ParameterObjectQueryResult>,
    request: (request: ActionRequest) =>
      ipcRenderer.invoke(ACTION_REQUEST_CHANNEL, request) as Promise<ActionRequestResult>,
    event: (event: InvocationEvent) =>
      ipcRenderer.invoke(ACTION_EVENT_CHANNEL, event) as Promise<InvocationEventResult>,
    onStep: (listener: (envelope: ActionStepEnvelope) => ActionStepAck) => {
      const handler = (_event: Electron.IpcRendererEvent, envelope: ActionStepEnvelope) => {
        void ipcRenderer.invoke(ACTION_STEP_ACK_CHANNEL, listener(envelope));
      };
      ipcRenderer.on(ACTION_STEP_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(ACTION_STEP_CHANNEL, handler);
      };
    },
  },
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  ...(nativeAttachmentPickerDisabled ? {} : {
    pickLocalFiles: (options: LinPickLocalFilesOptions = {}) =>
      ipcRenderer.invoke('lin:pick-local-files', options) as Promise<LinPickLocalFilesResult>,
  }),
  prepareLocalFile: (options: LinPrepareLocalFileOptions) =>
    ipcRenderer.invoke('lin:prepare-local-file', options) as Promise<LinPrepareLocalFileResult>,
  previewLocalFile: (options: LinPreviewLocalFileOptions) =>
    ipcRenderer.invoke('lin:preview-local-file', options) as Promise<LinPreviewLocalFileResult>,
  previewLocalFileReference: (options: LinPreviewLocalFileReferenceOptions) =>
    ipcRenderer.invoke('lin:preview-local-file-reference', options) as Promise<LinPreviewLocalFileReferenceResult>,
  openLocalFile: (options: LinOpenLocalFileOptions) =>
    ipcRenderer.invoke('lin:open-local-file', options) as Promise<LinOpenLocalFileResult>,
  revealLocalFile: (options: LinOpenLocalFileOptions) =>
    ipcRenderer.invoke('lin:reveal-local-file', options) as Promise<LinRevealLocalFileResult>,
  recentLocalFiles: (options: LinRecentLocalFilesOptions = {}) =>
    ipcRenderer.invoke('lin:recent-local-files', options) as Promise<LinRecentLocalFilesResult>,
  searchLocalFiles: (options: LinSearchLocalFilesOptions) =>
    ipcRenderer.invoke('lin:search-local-files', options) as Promise<LinSearchLocalFilesResult>,
  beginAttachmentUpload: (input: LinBeginAttachmentUploadInput) =>
    ipcRenderer.invoke('lin:attachment-upload/begin', input) as Promise<LinBeginAttachmentUploadResult>,
  appendAttachmentUpload: (input: LinAppendAttachmentUploadInput) =>
    ipcRenderer.invoke('lin:attachment-upload/append', input) as Promise<Record<string, never>>,
  finishAttachmentUpload: (input: LinAttachmentUploadIdentity) =>
    ipcRenderer.invoke('lin:attachment-upload/finish', input) as Promise<ThreadResourceReference>,
  abortAttachmentUpload: (input: LinAttachmentUploadIdentity) =>
    ipcRenderer.invoke('lin:attachment-upload/abort', input) as Promise<Record<string, never>>,
  discardAttachmentResource: (input: LinDiscardAttachmentResourceInput) =>
    ipcRenderer.invoke('lin:attachment-resource/discard', input) as Promise<{ discarded: boolean }>,
};

/**
 * Which bridge this window gets. Passed by main as an `additionalArguments`
 * flag, so it is fixed before any page script runs and cannot be influenced by
 * the renderer.
 */
function isLauncherWindow(): boolean {
  return process.argv.includes(LAUNCHER_PRELOAD_ROLE_ARG);
}

// One exposure per window. The launcher gets its own narrow API and never the
// generic command surface; the page cannot re-run this file, so it cannot
// reach what was not exposed to it.
contextBridge.exposeInMainWorld('lin', isLauncherWindow() ? buildLauncherPreloadApi()
  : process.argv.includes(SKILL_REVIEW_PRELOAD_ARG) ? {
      skillReview: api.skillReview, initialLanguage: api.initialLanguage,
      onLanguageChanged: api.onLanguageChanged, reportRendererError: api.reportRendererError,
    } : api);

export type LinApi = typeof api;
