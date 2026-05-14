import { contextBridge, ipcRenderer } from 'electron';
import type { AgentWorkerEvent } from '../renderer/agent/types';

const api = {
  invoke: <T>(command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke('lin:invoke', command, args) as Promise<T>,
  onAgentEvent: (listener: (event: AgentWorkerEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentWorkerEvent) => listener(payload);
    ipcRenderer.on('lin-agent-event', handler);
    return () => ipcRenderer.removeListener('lin-agent-event', handler);
  },
  window: {
    minimize: () => ipcRenderer.invoke('lin:window', 'minimize') as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke('lin:window', 'toggle_maximize') as Promise<void>,
    close: () => ipcRenderer.invoke('lin:window', 'close') as Promise<void>,
  },
};

contextBridge.exposeInMainWorld('lin', api);

export type LinApi = typeof api;

