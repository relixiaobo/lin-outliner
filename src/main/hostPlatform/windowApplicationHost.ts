import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { EffectStep } from '../../core/actions/bindings';
import { externalPageLabel } from '../../core/actions/registry';
import { externalContextSourceKind } from '../../core/actions/objects';
import {
  ACTION_AMBIENT_CHANGED_CHANNEL,
  ACTION_AMBIENT_SEED_REQUEST_CHANNEL,
  ACTION_AMBIENT_SEED_TIMEOUT_MS,
  ACTION_OPENED_CHANNEL,
  ACTION_STEP_ACK_TIMEOUT_MS,
  ACTION_STEP_CHANNEL,
  type ActionStepAck,
} from '../../core/actions/transport';
import type {
  InvocationRef,
  InvocationSeed,
} from '../../core/actions/types';
import { LIN_APP_UPDATE_CHANGED_CHANNEL, type AppUpdateView } from '../../core/appUpdate';
import { APP_NAME } from '../../core/brand';
import { MAC_TRAFFIC_LIGHT_POSITION, MAC_WINDOW_CORNER_RADIUS } from '../../core/chromeGeometry';
import { getMessages } from '../../core/i18n';
import {
  isLocale,
  LIN_LANGUAGE_CHANGED_CHANNEL,
  resolveSystemLocale,
  type Locale,
} from '../../core/locale';
import {
  LAUNCHER_NAVIGATE_TO_NODE_CHANNEL,
  LAUNCHER_REMEDIATION_CHANNEL,
} from '../../core/launcher/commands';
import type { ExternalContext } from '../../core/launcher/context';
import {
  isSettingsAnchorTarget,
  isSettingsCategoryTarget,
  isSettingsPageTarget,
  LIN_SETTINGS_NAVIGATE_CHANNEL,
  PROVIDER_CONFIG_MODE_PARAM,
  PROVIDER_CONFIG_PROVIDER_PARAM,
  SETTINGS_ANCHOR_PARAM,
  SETTINGS_CATEGORY_PARAM,
  settingsTargetPath,
  WINDOW_SURFACE_QUERY_PARAM,
  type ProviderConfigMode,
  type SettingsOpenTarget,
} from '../../core/settingsWindow';
import { isThemeMode, type ThemeMode } from '../../core/theme';
import {
  isTranslationLanguage,
  LIN_TRANSLATION_LANGUAGE_CHANGED_CHANNEL,
  type TranslationLanguage,
} from '../../core/translationLanguage';
import {
  isUrlPageTranslationPreferences,
  LIN_URL_PAGE_TRANSLATION_PREFERENCES_CHANGED_CHANNEL,
  type UrlPageTranslationPreferences,
} from '../../core/urlPageTranslation';
import { LIN_WINDOW_ACTIVE_CHANNEL } from '../../core/windowActivity';
import type { DocumentProjection, SearchHit } from '../../core/types';
import { ActionInvocationService, type RendererStepAck } from '../actionInvocationService';
import {
  loadAppPreferences,
  saveLanguagePreference,
  saveThemePreference,
  saveTranslationLanguagePreference,
  saveUrlPageTranslationPreferences,
} from '../appPreferences';
import { AppUpdateService } from '../appUpdateService';
import { AppUpdateStore } from '../appUpdateStore';
import { captureExternalContext } from '../context/contextCapture';
import { getFrontmostApp, type FrontmostApp } from '../context/providers/browser';
import { isAccessibilityTrusted, promptAccessibility } from '../context/nativeBrowserTab';
import {
  createLauncherWindow,
  getLauncherWindow,
  hideLauncherWindow,
  showLauncherWindow,
} from '../launcher/launcherWindow';
import { registerLauncherHotkey, unregisterLauncherHotkeys } from '../launcher/launcherHotkey';
import { oauthLoginManager } from '../agent/capabilities/agentOAuthManager';
import { applyMacWindowCorner } from '../nativeWindowCorner';
import {
  APP_RENDERER_CAPABILITIES,
  LAUNCHER_RENDERER_CAPABILITIES,
  registerRendererCapabilities,
} from '../rendererCapabilities';
import { loadWindowState, trackWindowState } from '../windowState';
import { windowMaterialKind } from '../../core/windowMaterial';
import type { ErrorReport } from '../../core/errorObservability';

const MAIN_RENDERER_LOAD_TIMEOUT_MS = 8_000;

export interface WindowApplicationHostOptions {
  readonly userDataDir: string;
  readonly moduleDir: string;
  readonly appIconPath: string;
  readonly rendererDevUrl: string | null;
  readonly hardenWebContents: (contents: WebContents) => void;
  readonly disposeTranslation: () => void;
  readonly releaseOutlineRenderer: (ownerId: number) => void;
  readonly projection: () => DocumentProjection;
  readonly documentReady: () => Promise<void>;
  readonly runActionCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly searchNodes: (query: string, limit: number) => Promise<SearchHit[]>;
  readonly sanitizeInvocationSeed: (raw: unknown) => InvocationSeed | null;
  readonly reportError: (report: ErrorReport) => void;
}

export interface WindowApplicationHost {
  readonly windows: {
    main(): BrowserWindow | null;
    settings(): BrowserWindow | null;
    providerConfig(): BrowserWindow | null;
    launcher(): BrowserWindow | null;
    focusedOrMain(): BrowserWindow | null;
    settingsOrMain(): BrowserWindow | null;
  };
  readonly updates: {
    view(): Promise<AppUpdateView>;
    checkExplicitly(): Promise<AppUpdateView>;
    checkInBackground(): Promise<AppUpdateView>;
    setAutomaticChecksEnabled(enabled: boolean): Promise<AppUpdateView>;
    openAvailableUpdate(): ReturnType<AppUpdateService['openAvailableUpdate']>;
  };
  readonly actions: {
    openFromSeed: ActionInvocationService['openFromSeed'];
    queryObjects: ActionInvocationService['queryObjects'];
    queryParameterObjects: ActionInvocationService['queryParameterObjects'];
    request: ActionInvocationService['request'];
    event: ActionInvocationService['event'];
    acceptAmbientSeed(raw: unknown): void;
    acceptStepAck(raw: unknown): void;
  };
  createMainWindow(): BrowserWindow;
  focusMainWindow(): void;
  navigateMainToNode(nodeId: string): void;
  openSettings(raw?: unknown): void;
  openProviderConfig(providerId: string, mode: ProviderConfigMode): void;
  closeProviderConfig(): void;
  closeSettingsFrom(event: IpcMainInvokeEvent): void;
  windowCommand(command: string): void;
  isMainSender(event: IpcMainInvokeEvent): boolean;
  isSettingsSender(event: IpcMainInvokeEvent): boolean;
  isProviderConfigSender(event: IpcMainInvokeEvent): boolean;
  assertMainSender(event: IpcMainInvokeEvent, capability: string): void;
  assertSettingsSender(event: IpcMainInvokeEvent, capability: string): void;
  notifySettingsChanged(origin?: BrowserWindow | null): void;
  effectiveLocale(): Locale;
  effectiveTranslationLanguage(): TranslationLanguage;
  urlPageTranslationPreferences(): UrlPageTranslationPreferences;
  theme(): ThemeMode;
  setTheme(raw: unknown): void;
  setLocale(raw: unknown): void;
  setTranslationLanguage(raw: unknown): void;
  setUrlPageTranslationPreferences(raw: unknown): UrlPageTranslationPreferences;
  launcherHotkey(): string | null;
  toggleLauncher(): Promise<void>;
  dismissLauncher(): void;
  initialize(): Promise<void>;
  release(): void;
}

export function createWindowApplicationHost(options: WindowApplicationHostOptions): WindowApplicationHost {
  let mainWindow: BrowserWindow | null = null;
  let settingsWindow: BrowserWindow | null = null;
  let providerConfigWindow: BrowserWindow | null = null;
  let cachedLocale: Locale | null = null;
  let launcherHotkeyAccelerator: string | null = null;
  let launcherContext: ExternalContext | null = null;
  let launcherOpenSeq = 0;
  let launcherInvocationRef: InvocationRef | null = null;
  let accessibilityPrompted = false;
  let pendingNavigateNodeIds: string[] = [];
  const pendingAmbientSeeds = new Map<string, (seed: unknown) => void>();
  const pendingActionStepAcks = new Map<string, (ack: ActionStepAck) => void>();
  const releases: Array<() => void> = [];
  let initialized = false;
  let released = false;

  const effectiveLocale = (): Locale => {
    cachedLocale ??= loadAppPreferences().language ?? resolveSystemLocale(app.getLocale());
    return cachedLocale;
  };
  const effectiveTranslationLanguage = (): TranslationLanguage => (
    loadAppPreferences().translationLanguage ?? effectiveLocale()
  );
  const urlPageTranslationPreferences = (): UrlPageTranslationPreferences => {
    const { translationModel, autoTranslateEpubs, autoTranslateUrls } = loadAppPreferences();
    return { translationModel, autoTranslateEpubs, autoTranslateUrls };
  };

  const attachNativeContextMenu = (contents: WebContents): void => {
    contents.on('context-menu', (_event, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      if (params.isEditable) {
        if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
          for (const suggestion of params.dictionarySuggestions) {
            template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
          }
          template.push({
            label: getMessages(effectiveLocale()).menu.addToDictionary,
            click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
          });
          template.push({ type: 'separator' });
        }
        template.push(
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
          { role: 'pasteAndMatchStyle' }, { role: 'delete' },
          { type: 'separator' }, { role: 'selectAll' },
        );
      } else if (params.selectionText.trim().length > 0) {
        template.push({ role: 'copy' });
      }
      if (template.length === 0) return;
      const window = BrowserWindow.fromWebContents(contents);
      Menu.buildFromTemplate(template).popup(window ? { window } : {});
    });
  };

  const forwardWindowActivity = (window: BrowserWindow): void => {
    const send = (active: boolean) => {
      if (!window.isDestroyed()) window.webContents.send(LIN_WINDOW_ACTIVE_CHANNEL, active);
    };
    window.on('focus', () => send(true));
    window.on('blur', () => send(false));
    window.webContents.on('did-finish-load', () => send(window.isFocused()));
  };

  const prePaintBackgroundColor = (): string => nativeTheme.shouldUseDarkColors ? '#2a2a2c' : '#ececec';

  const flushPendingNavigates = (): void => {
    if (pendingNavigateNodeIds.length === 0) return;
    const ids = pendingNavigateNodeIds;
    pendingNavigateNodeIds = [];
    for (const id of ids) mainWindow?.webContents.send(LAUNCHER_NAVIGATE_TO_NODE_CHANNEL, id);
  };

  const focusMainWindow = (): void => {
    const target = liveWindow(mainWindow);
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  };

  const createMainWindow = (): BrowserWindow => {
    const existing = liveWindow(mainWindow);
    if (existing) return existing;
    const windowState = loadWindowState();
    const material = windowMaterialKind(process.platform);
    const icon = nativeImage.createFromPath(options.appIconPath);
    const target = new BrowserWindow({
      title: APP_NAME,
      width: windowState.bounds?.width ?? 1120,
      height: windowState.bounds?.height ?? 820,
      ...(windowState.bounds ? { x: windowState.bounds.x, y: windowState.bounds.y } : {}),
      minWidth: 760,
      minHeight: 560,
      show: false,
      backgroundColor: material ? '#00000000' : prePaintBackgroundColor(),
      ...(material === 'vibrancy' ? { vibrancy: 'under-window' as const } : {}),
      ...(material === 'mica' ? { backgroundMaterial: 'mica' as const } : {}),
      ...(icon.isEmpty() ? {} : { icon }),
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
      webPreferences: {
        preload: join(options.moduleDir, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    });
    mainWindow = target;
    if (windowState.maximized) target.maximize();
    options.hardenWebContents(target.webContents);
    attachNativeContextMenu(target.webContents);
    forwardWindowActivity(target);
    trackWindowState(target);
    applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
    target.once('ready-to-show', () => {
      if (target.isDestroyed()) return;
      applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
      target.show();
    });
    target.on('enter-full-screen', () => applyMacWindowCorner(target, 0));
    target.on('leave-full-screen', () => applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS));
    if (options.rendererDevUrl) void target.loadURL(options.rendererDevUrl);
    else void target.loadFile(join(options.moduleDir, '../renderer/index.html'));
    registerRendererCapabilities(target.webContents, APP_RENDERER_CAPABILITIES);
    const rendererId = target.webContents.id;
    target.webContents.once('destroyed', () => options.releaseOutlineRenderer(rendererId));
    target.on('closed', () => {
      options.disposeTranslation();
      actionInvocationService.invalidateRenderer(rendererId);
      if (mainWindow === target) mainWindow = null;
    });
    target.webContents.on('did-start-loading', options.disposeTranslation);
    target.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) actionInvocationService.invalidateRenderer(rendererId);
    });
    target.webContents.on('did-finish-load', flushPendingNavigates);
    return target;
  };

  const navigateMainToNode = (nodeId: string): void => {
    const target = liveWindow(mainWindow);
    if (!target) {
      pendingNavigateNodeIds.push(nodeId);
      createMainWindow();
    } else if (target.webContents.isLoading()) {
      pendingNavigateNodeIds.push(nodeId);
    } else {
      target.webContents.send(LAUNCHER_NAVIGATE_TO_NODE_CHANNEL, nodeId);
    }
    focusMainWindow();
  };

  const waitForMainRendererLoad = async (): Promise<boolean> => {
    const contents = liveWindow(mainWindow)?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    if (!contents.isLoading()) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), MAIN_RENDERER_LOAD_TIMEOUT_MS);
      contents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  };

  const routeActionRendererStep = async (
    step: EffectStep,
    invocationRef: string,
  ): Promise<RendererStepAck> => {
    if (step.on === 'mainRenderer' && step.kind === 'navigate' && typeof step.nodeId === 'string') {
      const target = liveWindow(mainWindow);
      if (!target || target.webContents.isLoading()) {
        navigateMainToNode(step.nodeId);
        return { status: 'ok' };
      }
    }
    if (step.on === 'mainRenderer' && !liveWindow(mainWindow)) {
      createMainWindow();
      if (!await waitForMainRendererLoad()) return { status: 'gone' };
    }
    const target = liveWindow(mainWindow)?.webContents;
    if (!target || target.isDestroyed()) return { status: 'gone' };
    if (step.on === 'mainRenderer' && (step.kind === 'navigate' || step.kind === 'workspace')) focusMainWindow();
    const token = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingActionStepAcks.delete(token);
        resolve({ status: 'timeout' });
      }, ACTION_STEP_ACK_TIMEOUT_MS);
      pendingActionStepAcks.set(token, (ack) => {
        clearTimeout(timer);
        pendingActionStepAcks.delete(token);
        resolve(ack.status === 'ok' ? { status: 'ok' } : { status: 'reported', code: ack.code });
      });
      try {
        target.send(ACTION_STEP_CHANNEL, { token, invocationRef, step });
      } catch {
        clearTimeout(timer);
        pendingActionStepAcks.delete(token);
        resolve({ status: 'notDelivered' });
      }
    });
  };

  const actionInvocationService = new ActionInvocationService({
    projection: options.projection,
    runCommand: options.runActionCommand,
    searchNodes: options.searchNodes,
    executeRendererStep: routeActionRendererStep,
    activateAppSurface: async (surface) => {
      if (surface === 'settings') {
        openSettings();
        return;
      }
      if (!liveWindow(mainWindow)) createMainWindow();
      else focusMainWindow();
    },
    writeClipboard: (text) => clipboard.writeText(text),
    untitled: () => getMessages(effectiveLocale()).common.untitled,
    now: Date.now,
    externalContext: (contextId) => launcherContext?.id === contextId ? launcherContext : null,
    describeExternalPage: (contextId) => {
      const context = launcherContext?.id === contextId ? launcherContext : null;
      if (!context) return null;
      const subtitle = context.browser?.hostname ?? context.app.name;
      return {
        title: externalPageLabel(context),
        sourceKind: externalContextSourceKind(context),
        ...(subtitle ? { subtitle } : {}),
      };
    },
    newCaptureId: () => `cap:${randomUUID()}`,
    confirmNatively: async (spec) => {
      const locale = effectiveLocale();
      const strings = getMessages(locale).dialog;
      const launcher = liveWindow(getLauncherWindow());
      const parent = launcher?.isVisible() ? launcher : liveWindow(mainWindow);
      const response = await dialog.showMessageBox(parent ?? undefined as never, {
        type: 'warning',
        buttons: [spec.confirmLabel[locale] ?? spec.confirmLabel.en, strings.cancel],
        defaultId: 1,
        cancelId: 1,
        message: spec.title[locale] ?? spec.title.en,
        detail: spec.message[locale] ?? spec.message.en,
      });
      return response.response === 0;
    },
  });

  const dismissLauncher = (): void => {
    hideLauncherWindow();
    launcherContext = null;
    actionInvocationService.releaseOpening(launcherInvocationRef);
    launcherInvocationRef = null;
    launcherOpenSeq += 1;
  };

  const requestInAppAmbientSeed = async (openSeq: number): Promise<InvocationSeed | null> => {
    const target = liveWindow(mainWindow)?.webContents;
    if (!target || target.isDestroyed()) return null;
    const token = randomUUID();
    const raw = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pendingAmbientSeeds.delete(token);
        resolve(null);
      }, ACTION_AMBIENT_SEED_TIMEOUT_MS);
      pendingAmbientSeeds.set(token, (seed) => {
        clearTimeout(timer);
        pendingAmbientSeeds.delete(token);
        resolve(seed);
      });
      try {
        target.send(ACTION_AMBIENT_SEED_REQUEST_CHANNEL, { token });
      } catch {
        clearTimeout(timer);
        pendingAmbientSeeds.delete(token);
        resolve(null);
      }
    });
    if (openSeq !== launcherOpenSeq) return null;
    return options.sanitizeInvocationSeed(raw);
  };

  const toggleLauncher = async (): Promise<void> => {
    const win = getLauncherWindow();
    if (win?.isVisible()) {
      dismissLauncher();
      return;
    }
    const openSeq = ++launcherOpenSeq;
    try {
      await options.documentReady();
    } catch {
      focusMainWindow();
      return;
    }
    if (released || openSeq !== launcherOpenSeq) return;
    launcherContext = null;
    const contextId = `ctx:${randomUUID()}`;
    const capturedAt = new Date().toISOString();
    const front: { app: FrontmostApp | null } = { app: null };
    await showLauncherWindow(async () => {
      front.app = await getFrontmostApp();
    });
    const launcherContents = getLauncherWindow()?.webContents;
    if (launcherContents && !launcherContents.isDestroyed()) {
      const opened = actionInvocationService.openLauncher({ openSeq, consumerId: launcherContents.id });
      launcherInvocationRef = opened.invocationRef;
      launcherContents.send(ACTION_OPENED_CHANNEL, opened);
    }
    if (front.app?.name === APP_NAME) {
      const seeded = await requestInAppAmbientSeed(openSeq);
      if (launcherContents && !launcherContents.isDestroyed() && launcherInvocationRef) {
        launcherContents.send(ACTION_AMBIENT_CHANGED_CHANNEL, actionInvocationService.resolveAmbient({
          invocationRef: launcherInvocationRef,
          openSeq,
          resolution: seeded ? { kind: 'inApp', seed: seeded } : { kind: 'none' },
        }));
      }
      return;
    }
    try {
      const context = await captureExternalContext({
        id: contextId,
        capturedAt,
        captureOrigin: 'global-hotkey',
        frontmost: front.app,
      });
      if (openSeq !== launcherOpenSeq || !getLauncherWindow()?.isVisible()) return;
      launcherContext = context;
      if (!app.isPackaged) {
        console.log('[launcher] captured context', {
          frontmostApp: front.app?.name ?? null,
          pid: front.app?.pid ?? null,
          axTrusted: isAccessibilityTrusted(),
          providerId: context.providerId,
          confidence: context.confidence,
          browser: context.browser?.name ?? null,
          url: context.browser?.url ?? null,
          title: context.source?.title ?? null,
          warnings: context.warnings.map((warning) => warning.code),
        });
      }
      const contents = getLauncherWindow()?.webContents;
      contents?.send(
        LAUNCHER_REMEDIATION_CHANNEL,
        (await import('../../core/launcher/remediation')).remediationForContext(
          context,
          getMessages(effectiveLocale()),
          APP_NAME,
        ),
      );
      if (contents && launcherInvocationRef) {
        contents.send(ACTION_AMBIENT_CHANGED_CHANNEL, actionInvocationService.resolveAmbient({
          invocationRef: launcherInvocationRef,
          openSeq,
          resolution: { kind: 'externalPage', contextId: context.id as never },
        }));
      }
      if (!accessibilityPrompted && context.providerId === 'generic-webpage' && !isAccessibilityTrusted()) {
        accessibilityPrompted = true;
        promptAccessibility();
      }
    } catch (error) {
      console.error('[launcher] context capture failed', error);
    }
  };

  const loadRendererSurface = (target: BrowserWindow, query: Record<string, string>): void => {
    if (options.rendererDevUrl) {
      const url = new URL(options.rendererDevUrl);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      void target.loadURL(url.toString());
    } else {
      void target.loadFile(join(options.moduleDir, '../renderer/index.html'), { query });
    }
  };

  const openSettings = (raw: unknown = {}): void => {
    const openTarget = sanitizeSettingsOpenTarget(raw);
    const existing = liveWindow(settingsWindow);
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      if (openTarget.category || openTarget.page) {
        existing.webContents.send(LIN_SETTINGS_NAVIGATE_CHANNEL, openTarget);
      }
      return;
    }
    const icon = nativeImage.createFromPath(options.appIconPath);
    const target = new BrowserWindow({
      title: getMessages(effectiveLocale()).window.settingsTitle({ app: APP_NAME }),
      width: 760,
      height: 620,
      minWidth: 560,
      minHeight: 480,
      show: false,
      backgroundColor: prePaintBackgroundColor(),
      ...(icon.isEmpty() ? {} : { icon }),
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
      webPreferences: {
        preload: join(options.moduleDir, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    settingsWindow = target;
    registerRendererCapabilities(target.webContents, APP_RENDERER_CAPABILITIES);
    options.hardenWebContents(target.webContents);
    attachNativeContextMenu(target.webContents);
    applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
    target.once('ready-to-show', () => {
      applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
      target.show();
    });
    target.on('enter-full-screen', () => applyMacWindowCorner(target, 0));
    target.on('leave-full-screen', () => applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS));
    loadRendererSurface(target, settingsWindowQuery(openTarget));
    target.on('closed', () => {
      if (settingsWindow === target) settingsWindow = null;
    });
  };

  const createConfigChildWindow = (config: {
    title: string;
    width: number;
    height: number;
    parent?: BrowserWindow;
    query: Record<string, string>;
  }): BrowserWindow => {
    const bounds = liveWindow(config.parent)?.getBounds();
    const target = new BrowserWindow({
      title: config.title,
      width: config.width,
      height: config.height,
      ...(bounds ? {
        x: Math.round(bounds.x + (bounds.width - config.width) / 2),
        y: Math.round(bounds.y + Math.max(48, (bounds.height - config.height) / 2)),
      } : {}),
      parent: config.parent,
      modal: Boolean(config.parent),
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: prePaintBackgroundColor(),
      frame: false,
      webPreferences: {
        preload: join(options.moduleDir, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    registerRendererCapabilities(target.webContents, APP_RENDERER_CAPABILITIES);
    options.hardenWebContents(target.webContents);
    attachNativeContextMenu(target.webContents);
    applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
    target.once('ready-to-show', () => {
      applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
      target.show();
    });
    loadRendererSurface(target, config.query);
    return target;
  };

  const openProviderConfig = (providerId: string, mode: ProviderConfigMode): void => {
    const current = liveWindow(providerConfigWindow);
    if (current) {
      oauthLoginManager.cancelAll();
      current.close();
    }
    providerConfigWindow = null;
    const target = createConfigChildWindow({
      title: getMessages(effectiveLocale()).window.providerConfigTitle,
      width: 460,
      height: 384,
      parent: liveWindow(settingsWindow),
      query: {
        [WINDOW_SURFACE_QUERY_PARAM]: 'provider-config',
        [PROVIDER_CONFIG_PROVIDER_PARAM]: providerId,
        [PROVIDER_CONFIG_MODE_PARAM]: mode,
      },
    });
    providerConfigWindow = target;
    target.on('closed', () => {
      if (providerConfigWindow === target) {
        oauthLoginManager.cancelAll();
        providerConfigWindow = null;
      }
    });
  };

  const buildApplicationMenu = (): Electron.Menu => {
    const isMac = process.platform === 'darwin';
    const t = getMessages(effectiveLocale()).menu;
    const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
      ...(!app.isPackaged ? [
        { role: 'reload' as const, label: t.reload },
        { role: 'forceReload' as const, label: t.forceReload },
        { role: 'toggleDevTools' as const, label: t.toggleDevTools },
        { type: 'separator' as const },
      ] : []),
      { role: 'resetZoom', label: t.resetZoom },
      { role: 'zoomIn', label: t.zoomIn },
      { role: 'zoomOut', label: t.zoomOut },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ];
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (isMac) {
      template.push({
        label: APP_NAME,
        submenu: [
          { label: t.about({ app: APP_NAME }), click: () => openSettings({ page: 'about' }) },
          { type: 'separator' },
          { label: t.settings, accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
          { type: 'separator' }, { role: 'services' }, { type: 'separator' },
          { role: 'hide', label: t.hide({ app: APP_NAME }) }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' }, { role: 'quit', label: t.quit({ app: APP_NAME }) },
        ],
      });
    } else {
      template.push({
        label: t.file,
        submenu: [
          { label: t.settings, accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
          { type: 'separator' }, { role: 'quit' },
        ],
      });
    }
    template.push({
      label: t.edit,
      submenu: [
        { role: 'undo', label: t.undo }, { role: 'redo', label: t.redo }, { type: 'separator' },
        { role: 'cut', label: t.cut }, { role: 'copy', label: t.copy }, { role: 'paste', label: t.paste },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' as const, label: t.pasteAndMatchStyle },
          { role: 'delete' as const, label: t.delete },
          { role: 'selectAll' as const, label: t.selectAll },
          { type: 'separator' as const },
          { label: t.speech, submenu: [
            { role: 'startSpeaking' as const, label: t.startSpeaking },
            { role: 'stopSpeaking' as const, label: t.stopSpeaking },
          ] },
        ] : [
          { role: 'delete' as const, label: t.delete }, { type: 'separator' as const },
          { role: 'selectAll' as const, label: t.selectAll },
        ]),
      ],
    });
    template.push({ label: t.view, submenu: viewSubmenu });
    template.push({
      label: t.window,
      submenu: isMac
        ? [
            { role: 'minimize', label: t.minimize }, { role: 'zoom', label: t.zoom },
            { type: 'separator' }, { role: 'front', label: t.front },
            { type: 'separator' }, { role: 'window' },
          ]
        : [
            { role: 'minimize', label: t.minimize }, { role: 'zoom', label: t.zoom },
            { type: 'separator' }, { role: 'close' },
          ],
    });
    template.push({
      role: 'help',
      label: t.helpTitle,
      submenu: [
        { label: t.help({ app: APP_NAME }), click: () => void shell.openExternal('https://github.com/relixiaobo/lin-outliner') },
        { label: t.reportIssue, click: () => void shell.openExternal('https://github.com/relixiaobo/lin-outliner/issues') },
      ],
    });
    return Menu.buildFromTemplate(template);
  };

  const appUpdateStore = new AppUpdateStore(options.userDataDir, {
    onError: (error, operation) => options.reportError({
      domain: 'app-update',
      severity: 'warn',
      code: `app-update-store-${operation}`,
      message: `App update state ${operation} failed`,
      context: { operation },
      error,
    }),
  });
  const appUpdateService = new AppUpdateService({
    currentVersion: app.getVersion(),
    defaultAutomaticChecksEnabled: app.isPackaged,
    store: appUpdateStore,
    openExternal: (url) => shell.openExternal(url),
    onChanged: (view) => liveWindow(settingsWindow)?.webContents.send(LIN_APP_UPDATE_CHANGED_CHANNEL, view),
    onError: (error, operation) => options.reportError({
      domain: 'app-update',
      severity: 'warn',
      code: `app-update-${operation}`,
      message: `App update ${operation} failed`,
      context: { operation },
      error,
    }),
  });

  const host: WindowApplicationHost = {
    windows: {
      main: () => liveWindow(mainWindow) ?? null,
      settings: () => liveWindow(settingsWindow) ?? null,
      providerConfig: () => liveWindow(providerConfigWindow) ?? null,
      launcher: () => liveWindow(getLauncherWindow()) ?? null,
      focusedOrMain: () => BrowserWindow.getFocusedWindow() ?? liveWindow(mainWindow) ?? null,
      settingsOrMain: () => liveWindow(settingsWindow) ?? liveWindow(mainWindow) ?? null,
    },
    updates: {
      view: () => appUpdateService.view(),
      checkExplicitly: () => appUpdateService.checkExplicitly(),
      checkInBackground: () => appUpdateService.checkInBackground(),
      setAutomaticChecksEnabled: (enabled) => appUpdateService.setAutomaticChecksEnabled(enabled),
      openAvailableUpdate: () => appUpdateService.openAvailableUpdate(),
    },
    actions: {
      openFromSeed: (...args) => actionInvocationService.openFromSeed(...args),
      queryObjects: (...args) => actionInvocationService.queryObjects(...args),
      queryParameterObjects: (...args) => actionInvocationService.queryParameterObjects(...args),
      request: (...args) => actionInvocationService.request(...args),
      event: (...args) => actionInvocationService.event(...args),
      acceptAmbientSeed: (raw) => {
        const response = raw as { token?: unknown; seed?: unknown } | undefined;
        if (typeof response?.token === 'string') pendingAmbientSeeds.get(response.token)?.(response.seed ?? null);
      },
      acceptStepAck: (raw) => {
        const ack = raw as ActionStepAck | undefined;
        if (typeof ack?.token !== 'string') return;
        if (ack.status !== 'ok' && ack.status !== 'reported') return;
        pendingActionStepAcks.get(ack.token)?.(ack);
      },
    },
    createMainWindow,
    focusMainWindow,
    navigateMainToNode,
    openSettings,
    openProviderConfig,
    closeProviderConfig: () => liveWindow(providerConfigWindow)?.close(),
    closeSettingsFrom: (event) => {
      const target = liveWindow(settingsWindow);
      if (target && event.sender === target.webContents) target.close();
    },
    windowCommand: (command) => {
      const target = BrowserWindow.getFocusedWindow() ?? liveWindow(mainWindow);
      if (!target) return;
      if (command === 'minimize') target.minimize();
      if (command === 'toggle_maximize') target.isMaximized() ? target.unmaximize() : target.maximize();
      if (command === 'close') target.close();
    },
    isMainSender: (event) => event.sender === liveWindow(mainWindow)?.webContents,
    isSettingsSender: (event) => event.sender === liveWindow(settingsWindow)?.webContents,
    isProviderConfigSender: (event) => event.sender === liveWindow(providerConfigWindow)?.webContents,
    assertMainSender: (event, capability) => {
      if (event.sender !== liveWindow(mainWindow)?.webContents) {
        throw new Error(`${capability} is available only to the main application window.`);
      }
    },
    assertSettingsSender: (event, capability) => {
      if (event.sender !== liveWindow(settingsWindow)?.webContents) {
        throw new Error(`${capability} is only available from Settings.`);
      }
    },
    notifySettingsChanged: (origin) => {
      for (const target of [liveWindow(mainWindow), liveWindow(settingsWindow)]) {
        if (target && target !== origin) target.webContents.send('lin:settings-changed');
      }
    },
    effectiveLocale,
    effectiveTranslationLanguage,
    urlPageTranslationPreferences,
    theme: () => nativeTheme.themeSource,
    setTheme: (raw) => {
      if (!isThemeMode(raw)) return;
      if (nativeTheme.themeSource === raw) return;
      nativeTheme.themeSource = raw;
      saveThemePreference(raw);
    },
    setLocale: (raw) => {
      if (!isLocale(raw)) return;
      if (cachedLocale === raw) return;
      saveLanguagePreference(raw);
      cachedLocale = raw;
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(LIN_LANGUAGE_CHANGED_CHANNEL, raw);
        if (loadAppPreferences().translationLanguage === null) {
          window.webContents.send(LIN_TRANSLATION_LANGUAGE_CHANGED_CHANNEL, raw);
        }
      }
      Menu.setApplicationMenu(buildApplicationMenu());
      const messages = getMessages(raw);
      liveWindow(settingsWindow)?.setTitle(messages.window.settingsTitle({ app: APP_NAME }));
      liveWindow(providerConfigWindow)?.setTitle(messages.window.providerConfigTitle);
    },
    setTranslationLanguage: (raw) => {
      if (!isTranslationLanguage(raw)) return;
      saveTranslationLanguagePreference(raw);
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(LIN_TRANSLATION_LANGUAGE_CHANGED_CHANNEL, raw);
      }
    },
    setUrlPageTranslationPreferences: (raw) => {
      if (!isUrlPageTranslationPreferences(raw)) return urlPageTranslationPreferences();
      saveUrlPageTranslationPreferences(raw);
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(LIN_URL_PAGE_TRANSLATION_PREFERENCES_CHANGED_CHANNEL, raw);
      }
      return raw;
    },
    launcherHotkey: () => launcherHotkeyAccelerator,
    toggleLauncher,
    dismissLauncher,
    initialize: async () => {
      if (initialized || released) return;
      initialized = true;
      nativeTheme.themeSource = loadAppPreferences().theme;
      const target = createMainWindow();
      const launcherWindow = createLauncherWindow({
        preloadPath: join(options.moduleDir, '../preload/index.cjs'),
        devUrl: options.rendererDevUrl ? `${new URL(options.rendererDevUrl).origin}/launcher.html` : null,
        packagedHtmlPath: join(options.moduleDir, '../renderer/launcher.html'),
        harden: options.hardenWebContents,
        onBlurHide: dismissLauncher,
      });
      registerRendererCapabilities(launcherWindow.webContents, LAUNCHER_RENDERER_CAPABILITIES);
      if (process.platform === 'darwin') app.setActivationPolicy('regular');
      const hotkey = registerLauncherHotkey(() => void toggleLauncher());
      launcherHotkeyAccelerator = hotkey.accelerator;
      if (hotkey.accelerator) console.log(`[launcher] global hotkey: ${hotkey.accelerator}`);
      else console.warn(`[launcher] no global hotkey registered; tried: ${hotkey.attempted.join(', ')}`);
      Menu.setApplicationMenu(buildApplicationMenu());
      const handleActivate = () => {
        if (!liveWindow(mainWindow)) createMainWindow();
      };
      app.on('activate', handleActivate);
      releases.push(() => app.removeListener('activate', handleActivate));
      if (!target.isVisible()) await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          target.removeListener('show', shown);
          target.removeListener('closed', closed);
        };
        const shown = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error('The startup window closed before its first paint.')); };
        target.once('show', shown);
        target.once('closed', closed);
      });
    },
    release: () => {
      if (released) return;
      released = true;
      if (app.isReady()) unregisterLauncherHotkeys();
      for (const release of releases.splice(0).reverse()) release();
      for (const resolve of pendingAmbientSeeds.values()) resolve(null);
      pendingAmbientSeeds.clear();
      for (const acknowledge of pendingActionStepAcks.values()) {
        acknowledge({ token: '', status: 'reported', code: 'host-released' });
      }
      pendingActionStepAcks.clear();
      actionInvocationService.releaseOpening(launcherInvocationRef);
      launcherInvocationRef = null;
      launcherContext = null;
      pendingNavigateNodeIds = [];
    },
  };
  return host;
}

function sanitizeSettingsOpenTarget(raw: unknown): SettingsOpenTarget {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as { category?: unknown; page?: unknown; anchor?: unknown };
  const category = isSettingsCategoryTarget(input.category) ? input.category : undefined;
  const page = isSettingsPageTarget(input.page) ? input.page : undefined;
  const anchor = (category || page) && isSettingsAnchorTarget(input.anchor) ? input.anchor : undefined;
  return {
    ...(category ? { category } : {}),
    ...(page ? { page } : {}),
    ...(anchor ? { anchor } : {}),
  };
}

function settingsWindowQuery(target: SettingsOpenTarget = {}): Record<string, string> {
  const path = settingsTargetPath(target);
  return {
    [WINDOW_SURFACE_QUERY_PARAM]: 'settings',
    ...(path ? { [SETTINGS_CATEGORY_PARAM]: path } : {}),
    ...(path && target.anchor ? { [SETTINGS_ANCHOR_PARAM]: target.anchor } : {}),
  };
}

function isLiveWindow(window: BrowserWindow | null | undefined): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed());
}

function liveWindow(window: BrowserWindow | null | undefined): BrowserWindow | undefined {
  return isLiveWindow(window) ? window : undefined;
}
