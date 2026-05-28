import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../core/agentTypes';
import { LIN_DOCUMENT_EVENT_CHANNEL, type DocumentProjectionChangedEvent } from '../core/types';
import { windowMaterialKind } from '../core/windowMaterial';

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
