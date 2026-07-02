import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  LIN_AGENT_EVENT_CHANNEL,
  LIN_AGENT_MESSAGE_CONTEXT_MENU_CHANNEL,
  LIN_AGENT_NAVIGATE_CONVERSATION_CHANNEL,
  type AgentMessageContextMenuAction,
  type AgentMessageContextMenuRequest,
  type AgentRuntimeEvent,
} from '../core/agentTypes';
import {
  LIN_AGENT_OAUTH_EVENT_CHANNEL,
  LIN_DOCUMENT_EVENT_CHANNEL,
  type AgentProviderStoredApiKey,
  type DocumentProjectionChangedEvent,
  type OAuthLoginEventEnvelope,
} from '../core/types';
import { windowMaterialKind } from '../core/windowMaterial';
import {
  LIN_SETTINGS_CHANGED_CHANNEL,
  LIN_SETTINGS_NAVIGATE_CHANNEL,
  type SettingsOpenTarget,
} from '../core/settingsWindow';
import { LIN_WINDOW_ACTIVE_CHANNEL } from '../core/windowActivity';
import type { ThemeMode } from '../core/theme';
import { DEFAULT_LOCALE, isLocale, LIN_LANGUAGE_CHANGED_CHANNEL, type Locale } from '../core/locale';
import {
  LAUNCHER_CONTEXT_CHANNEL,
  LAUNCHER_NAVIGATE_TO_NODE_CHANNEL,
  LAUNCHER_SHOWN_CHANNEL,
  type LauncherCommandId,
  type LauncherCreateCaptureResult,
  type LauncherExecuteResult,
  type LauncherInitialState,
  type LauncherNodeMatch,
} from '../core/launcher/commands';
import type { ExternalContext } from '../core/launcher/context';
import type { CaptureIntent } from '../core/launcher/sources';
import {
  diagnosticErrorMessage,
  diagnosticSourceLabel,
  LIN_EXPORT_DIAGNOSTICS_CHANNEL,
  LIN_REPORT_RENDERER_ERROR_CHANNEL,
  LIN_REVEAL_DIAGNOSTICS_LOG_CHANNEL,
  serializeUnknownError,
  type DiagnosticsActionResult,
  type ErrorReport,
} from '../core/errorObservability';

export interface LinPickedLocalFile {
  entryKind?: 'file' | 'directory';
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  lastModified: number;
  iconDataUrl?: string;
  imageDataBase64?: string;
  thumbnailDataUrl?: string;
}

export interface LinPickLocalFilesResult {
  canceled: boolean;
  files: LinPickedLocalFile[];
  skippedCount?: number;
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
}

export interface LinPreviewLocalFileReferenceResult {
  file: LinLocalFileReferencePreview | null;
}

export interface LinOpenLocalFileOptions {
  path: string;
}

export interface LinOpenLocalFileResult {
  opened: boolean;
}

export interface LinRevealLocalFileResult {
  revealed: boolean;
}

export interface LinStageAttachmentInput {
  name: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

export interface LinStageAttachmentResult {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

const nativeAttachmentPickerDisabled = process.env.LIN_ATTACHMENT_PICKER_METHOD === 'web'
  || process.env.LIN_DISABLE_NATIVE_ATTACHMENT_PICKER === '1';

function reportRendererError(report: ErrorReport): void {
  void ipcRenderer.invoke(LIN_REPORT_RENDERER_ERROR_CHANNEL, report).catch(() => undefined);
}

window.addEventListener('error', (event) => {
  const source = event.filename ? diagnosticSourceLabel(event.filename) : undefined;
  reportRendererError({
    domain: 'render',
    severity: 'fatal',
    code: 'window-error',
    message: event.message || diagnosticErrorMessage(event.error, 'Renderer error'),
    context: {
      ...(source ? { source } : {}),
      ...(typeof event.lineno === 'number' ? { line: event.lineno } : {}),
      ...(typeof event.colno === 'number' ? { column: event.colno } : {}),
    },
    error: serializeUnknownError(event.error),
  });
});

window.addEventListener('unhandledrejection', (event) => {
  reportRendererError({
    domain: 'render',
    severity: 'fatal',
    code: 'window-unhandled-rejection',
    message: diagnosticErrorMessage(event.reason, 'Unhandled renderer promise rejection'),
    context: { operation: 'unhandledRejection' },
    error: serializeUnknownError(event.reason),
  });
});

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

const api = {
  // Which OS window material the main process applied, so the renderer can make
  // its chrome surfaces translucent only when there's a material behind them.
  windowMaterial: windowMaterialKind(process.platform),
  invoke: <T>(command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke('lin:invoke', command, args) as Promise<T>,
  recordNodeAccess: (nodeId: string) =>
    ipcRenderer.invoke('lin:record-node-access', nodeId) as Promise<void>,
  onAgentEvent: (listener: (event: AgentRuntimeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentRuntimeEvent) => listener(payload);
    ipcRenderer.on(LIN_AGENT_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_AGENT_EVENT_CHANNEL, handler);
    };
  },
  onAgentOAuthEvent: (listener: (envelope: OAuthLoginEventEnvelope) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: OAuthLoginEventEnvelope) => listener(payload);
    ipcRenderer.on(LIN_AGENT_OAUTH_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_AGENT_OAUTH_EVENT_CHANNEL, handler);
    };
  },
  onDocumentEvent: (listener: (event: DocumentProjectionChangedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DocumentProjectionChangedEvent) => listener(payload);
    ipcRenderer.on(LIN_DOCUMENT_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_DOCUMENT_EVENT_CHANNEL, handler);
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
  // Opt-in OS-notification preference for off-floor task delivery (default off).
  getNotificationPrefs: () =>
    ipcRenderer.invoke('lin:get-notification-prefs') as Promise<{ osNotificationsEnabled: boolean }>,
  setNotificationPrefs: (prefs: { osNotificationsEnabled: boolean }) =>
    ipcRenderer.invoke('lin:set-notification-prefs', prefs) as Promise<{ osNotificationsEnabled: boolean }>,
  // Durably mark a conversation read (the user opened/viewed it). Separate from
  // restoreConversation so a config reload never clears unread.
  agentMarkConversationRead: (conversationId: string) =>
    ipcRenderer.invoke('lin:agent-mark-conversation-read', conversationId) as Promise<void>,
  // Report the conversation the user can actually see (dock open), or null when the
  // dock is collapsed — used to suppress an OS banner only when truly looking at it.
  agentSetViewedConversation: (conversationId: string | null) =>
    ipcRenderer.invoke('lin:agent-set-viewed-conversation', conversationId) as Promise<void>,
  agentNavigateToConversation: (conversationId: string) =>
    ipcRenderer.invoke('lin:agent-navigate-conversation', conversationId) as Promise<void>,
  // The user clicked an OS notification banner — route the agent panel to the
  // originating conversation.
  onNavigateToConversation: (listener: (conversationId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, conversationId: string) => listener(conversationId);
    ipcRenderer.on(LIN_AGENT_NAVIGATE_CONVERSATION_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_AGENT_NAVIGATE_CONVERSATION_CHANNEL, handler);
    };
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
  openProviderConfig: (params: { providerId: string; mode: 'configure' | 'custom' }) =>
    ipcRenderer.invoke('lin:open-provider-config', params) as Promise<void>,
  closeProviderConfig: () => ipcRenderer.invoke('lin:close-provider-config') as Promise<void>,
  getProviderApiKey: (providerId: string) =>
    ipcRenderer.invoke('lin:get-provider-api-key', { providerId }) as Promise<AgentProviderStoredApiKey>,
  openAgentConfig: (params: { agentId: string }) =>
    ipcRenderer.invoke('lin:open-agent-config', params) as Promise<void>,
  closeAgentConfig: () => ipcRenderer.invoke('lin:close-agent-config') as Promise<void>,
  openChannelConfig: (params: { conversationId?: string; mode: 'create' | 'configure' }) =>
    ipcRenderer.invoke('lin:open-channel-config', params) as Promise<void>,
  closeChannelConfig: () => ipcRenderer.invoke('lin:close-channel-config') as Promise<void>,
  notifySettingsChanged: () => ipcRenderer.invoke('lin:settings-changed') as Promise<void>,
  revealDiagnosticsLog: () =>
    ipcRenderer.invoke(LIN_REVEAL_DIAGNOSTICS_LOG_CHANNEL) as Promise<DiagnosticsActionResult>,
  exportDiagnostics: () =>
    ipcRenderer.invoke(LIN_EXPORT_DIAGNOSTICS_CHANNEL) as Promise<DiagnosticsActionResult>,
  reportRendererError: (report: ErrorReport) => reportRendererError(report),
  onSettingsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(LIN_SETTINGS_CHANGED_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_SETTINGS_CHANGED_CHANNEL, handler);
    };
  },
  onSettingsNavigate: (listener: (target: SettingsOpenTarget) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: SettingsOpenTarget) => listener(target);
    ipcRenderer.on(LIN_SETTINGS_NAVIGATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_SETTINGS_NAVIGATE_CHANNEL, handler);
    };
  },
  showAgentMessageContextMenu: (request: AgentMessageContextMenuRequest) =>
    ipcRenderer.invoke(LIN_AGENT_MESSAGE_CONTEXT_MENU_CHANNEL, request) as Promise<AgentMessageContextMenuAction | null>,
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
  // Dedicated launcher window bridge (the prewarmed global launcher).
  launcher: {
    getInitialState: () => ipcRenderer.invoke('launcher:getInitialState') as Promise<LauncherInitialState>,
    executeCommand: (id: LauncherCommandId) =>
      ipcRenderer.invoke('launcher:executeCommand', id) as Promise<LauncherExecuteResult>,
    createCapture: (payload: { title: string; note?: string }) =>
      ipcRenderer.invoke('launcher:createCapture', payload) as Promise<LauncherCreateCaptureResult>,
    createContextCapture: (payload: { note?: string; intent?: CaptureIntent } = {}) =>
      ipcRenderer.invoke('launcher:createContextCapture', payload) as Promise<LauncherCreateCaptureResult>,
    searchNodes: (query: string) =>
      ipcRenderer.invoke('launcher:searchNodes', query) as Promise<LauncherNodeMatch[]>,
    openNode: (nodeId: string) => ipcRenderer.invoke('launcher:openNode', nodeId) as Promise<void>,
    hide: () => ipcRenderer.invoke('launcher:hide') as Promise<void>,
    onShown: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(LAUNCHER_SHOWN_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(LAUNCHER_SHOWN_CHANNEL, handler);
      };
    },
    onContext: (listener: (context: ExternalContext) => void) => {
      const handler = (_event: unknown, context: ExternalContext) => listener(context);
      ipcRenderer.on(LAUNCHER_CONTEXT_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(LAUNCHER_CONTEXT_CHANNEL, handler);
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
  stageAttachment: (input: LinStageAttachmentInput) =>
    ipcRenderer.invoke('lin:stage-attachment', input) as Promise<LinStageAttachmentResult>,
};

contextBridge.exposeInMainWorld('lin', api);

export type LinApi = typeof api;
