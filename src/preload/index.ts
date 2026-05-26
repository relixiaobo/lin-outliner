import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../core/agentTypes';
import { LIN_DOCUMENT_EVENT_CHANNEL, type DocumentProjectionChangedEvent } from '../core/types';

export interface LinPickedLocalFile {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  lastModified: number;
  imageDataBase64?: string;
}

export interface LinPickLocalFilesResult {
  canceled: boolean;
  files: LinPickedLocalFile[];
  skippedCount?: number;
}

export interface LinPickLocalFilesOptions {
  maxFiles?: number;
}

const nativeAttachmentPickerDisabled = process.env.LIN_ATTACHMENT_PICKER_METHOD === 'web'
  || process.env.LIN_DISABLE_NATIVE_ATTACHMENT_PICKER === '1';

const api = {
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
};

contextBridge.exposeInMainWorld('lin', api);

export type LinApi = typeof api;
