import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../core/agentTypes';
import { LIN_DOCUMENT_EVENT_CHANNEL, type DocumentProjectionChangedEvent } from '../core/types';
import { windowMaterialKind } from '../core/windowMaterial';
import { LIN_SETTINGS_CHANGED_CHANNEL } from '../core/settingsWindow';
import { LIN_WINDOW_ACTIVE_CHANNEL } from '../core/windowActivity';
import type { ThemeMode } from '../core/theme';

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

const nativeAttachmentPickerDisabled = process.env.LIN_ATTACHMENT_PICKER_METHOD === 'web'
  || process.env.LIN_DISABLE_NATIVE_ATTACHMENT_PICKER === '1';

const api = {
  // Which OS window material the main process applied, so the renderer can make
  // its chrome surfaces translucent only when there's a material behind them.
  windowMaterial: windowMaterialKind(process.platform),
  invoke: <T>(command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke('lin:invoke', command, args) as Promise<T>,
  onAgentEvent: (listener: (event: AgentRuntimeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentRuntimeEvent) => listener(payload);
    ipcRenderer.on(LIN_AGENT_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_AGENT_EVENT_CHANNEL, handler);
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
  openSettings: () => ipcRenderer.invoke('lin:open-settings') as Promise<void>,
  closeSettings: () => ipcRenderer.invoke('lin:close-settings') as Promise<void>,
  // Appearance preference. setTheme applies immediately across all windows (via
  // nativeTheme.themeSource → prefers-color-scheme) and persists; getTheme returns
  // the stored mode so the settings control can reflect the current pick.
  getTheme: () => ipcRenderer.invoke('lin:get-theme') as Promise<ThemeMode>,
  setTheme: (mode: ThemeMode) => ipcRenderer.invoke('lin:set-theme', mode) as Promise<void>,
  openProviderConfig: (params: { providerId: string; mode: 'configure' | 'custom' }) =>
    ipcRenderer.invoke('lin:open-provider-config', params) as Promise<void>,
  closeProviderConfig: () => ipcRenderer.invoke('lin:close-provider-config') as Promise<void>,
  notifySettingsChanged: () => ipcRenderer.invoke('lin:settings-changed') as Promise<void>,
  onSettingsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(LIN_SETTINGS_CHANGED_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_SETTINGS_CHANGED_CHANNEL, handler);
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
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  ...(nativeAttachmentPickerDisabled ? {} : {
    pickLocalFiles: (options: LinPickLocalFilesOptions = {}) =>
      ipcRenderer.invoke('lin:pick-local-files', options) as Promise<LinPickLocalFilesResult>,
  }),
  prepareLocalFile: (options: LinPrepareLocalFileOptions) =>
    ipcRenderer.invoke('lin:prepare-local-file', options) as Promise<LinPrepareLocalFileResult>,
  previewLocalFile: (options: LinPreviewLocalFileOptions) =>
    ipcRenderer.invoke('lin:preview-local-file', options) as Promise<LinPreviewLocalFileResult>,
  recentLocalFiles: (options: LinRecentLocalFilesOptions = {}) =>
    ipcRenderer.invoke('lin:recent-local-files', options) as Promise<LinRecentLocalFilesResult>,
  searchLocalFiles: (options: LinSearchLocalFilesOptions) =>
    ipcRenderer.invoke('lin:search-local-files', options) as Promise<LinSearchLocalFilesResult>,
};

contextBridge.exposeInMainWorld('lin', api);

export type LinApi = typeof api;
