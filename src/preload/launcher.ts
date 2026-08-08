// The launcher window's ENTIRE bridge.
//
// The shipped launcher loaded the shared app preload, which exposes the generic
// `window.lin.invoke` — so a compromised launcher renderer could call
// `get_projection` and `delete_node` directly, bypassing every invocation check
// the action seam performs. This bundle is least privilege: the full app bridge
// is simply not here to acquire, and navigating or reloading this renderer
// cannot obtain it.
//
// It is not the only defence. Main also registers capabilities against the real
// `webContents` and rejects `lin:invoke` from this sender BEFORE dispatch — that
// gate stays authoritative if this file is ever widened by accident. See
// `docs/plans/unified-command-surface.md` D1b.

import { contextBridge, ipcRenderer } from 'electron';
import {
  ACTION_AMBIENT_CHANGED_CHANNEL,
  ACTION_EVENT_CHANNEL,
  ACTION_OPENED_CHANNEL,
  ACTION_OBJECT_QUERY_CHANNEL,
  ACTION_PARAMETER_QUERY_CHANNEL,
  ACTION_REQUEST_CHANNEL,
} from '../core/actions/transport';
import type {
  ActionRequest,
  ActionRequestResult,
  AmbientContextChanged,
  InvocationEvent,
  InvocationEventResult,
  InvocationOpened,
  ObjectQueryRequest,
  ObjectQueryResult,
  ParameterObjectQueryRequest,
  ParameterObjectQueryResult,
} from '../core/actions/types';
import {
  LAUNCHER_REMEDIATION_CHANNEL,
  LAUNCHER_SHOWN_CHANNEL,
  type LauncherInitialState,
} from '../core/launcher/commands';
import type { LauncherRemediation } from '../core/launcher/remediation';
import { DEFAULT_LOCALE, isLocale, LIN_LANGUAGE_CHANGED_CHANNEL, type Locale } from '../core/locale';

/** The effective locale, resolved before first paint (same seam as the app). */
function initialLanguage(): Locale {
  try {
    const value = ipcRenderer.sendSync('lin:get-language-sync');
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

const launcherApi = {
  initialLanguage: initialLanguage(),
  setLanguage: (locale: Locale) => ipcRenderer.invoke('lin:set-language', locale) as Promise<void>,
  onLanguageChanged: (listener: (locale: Locale) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, next: unknown) => {
      if (isLocale(next)) listener(next);
    };
    ipcRenderer.on(LIN_LANGUAGE_CHANGED_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIN_LANGUAGE_CHANGED_CHANNEL, handler);
    };
  },
  launcher: {
    getInitialState: () =>
      ipcRenderer.invoke('launcher:getInitialState') as Promise<LauncherInitialState>,
    hide: () => ipcRenderer.invoke('launcher:hide') as Promise<void>,
    // Main derives the capture-degraded hint from its own warnings and pushes
    // only that view; the raw ExternalContext never reaches this renderer.
    onRemediation: (listener: (remediation: LauncherRemediation | null) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, next: LauncherRemediation | null) => {
        listener(next);
      };
      ipcRenderer.on(LAUNCHER_REMEDIATION_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(LAUNCHER_REMEDIATION_CHANNEL, handler);
      };
    },
    onShown: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(LAUNCHER_SHOWN_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(LAUNCHER_SHOWN_CHANNEL, handler);
      };
    },
  },
  // The action seam, minus `open`: the launcher's invocation is created by MAIN
  // on the hotkey and pushed here. A renderer that could open its own would be
  // authoring the very facts main is supposed to attest.
  actions: {
    queryObjects: (request: ObjectQueryRequest) =>
      ipcRenderer.invoke(ACTION_OBJECT_QUERY_CHANNEL, request) as Promise<ObjectQueryResult>,
    queryParameters: (request: ParameterObjectQueryRequest) =>
      ipcRenderer.invoke(ACTION_PARAMETER_QUERY_CHANNEL, request) as Promise<ParameterObjectQueryResult>,
    request: (request: ActionRequest) =>
      ipcRenderer.invoke(ACTION_REQUEST_CHANNEL, request) as Promise<ActionRequestResult>,
    event: (event: InvocationEvent) =>
      ipcRenderer.invoke(ACTION_EVENT_CHANNEL, event) as Promise<InvocationEventResult>,
    onOpened: (listener: (opening: InvocationOpened) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, opening: InvocationOpened) => {
        listener(opening);
      };
      ipcRenderer.on(ACTION_OPENED_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(ACTION_OPENED_CHANNEL, handler);
      };
    },
    onAmbientChanged: (listener: (change: AmbientContextChanged) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, change: AmbientContextChanged) => {
        listener(change);
      };
      ipcRenderer.on(ACTION_AMBIENT_CHANGED_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(ACTION_AMBIENT_CHANGED_CHANNEL, handler);
      };
    },
  },
};

export type LauncherPreloadApi = typeof launcherApi;

contextBridge.exposeInMainWorld('lin', launcherApi);
