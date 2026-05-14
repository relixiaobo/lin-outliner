import { contextBridge, ipcRenderer } from 'electron';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../core/agentTypes';

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
  window: {
    minimize: () => ipcRenderer.invoke('lin:window', 'minimize') as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke('lin:window', 'toggle_maximize') as Promise<void>,
    close: () => ipcRenderer.invoke('lin:window', 'close') as Promise<void>,
  },
};

contextBridge.exposeInMainWorld('lin', api);

export type LinApi = typeof api;
