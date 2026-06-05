import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentService } from './documentService';
import { AssetService } from './assetService';
import { AgentRuntime } from './agentRuntime';
import { MAC_TRAFFIC_LIGHT_POSITION, MAC_WINDOW_CORNER_RADIUS } from '../core/chromeGeometry';
import { windowMaterialKind } from '../core/windowMaterial';
import { applyMacWindowCorner } from './nativeWindowCorner';
import {
  LIN_SETTINGS_CHANGED_CHANNEL,
  PROVIDER_CONFIG_MODE_PARAM,
  PROVIDER_CONFIG_PROVIDER_PARAM,
  WINDOW_SURFACE_QUERY_PARAM,
  type ProviderConfigMode,
} from '../core/settingsWindow';
import { LIN_WINDOW_ACTIVE_CHANNEL } from '../core/windowActivity';
import { ASSET_URL_SCHEME } from '../core/assets';
import { LIN_AGENT_OAUTH_EVENT_CHANNEL, LIN_DOCUMENT_EVENT_CHANNEL, type AssetIngestInput, type CommandResult } from '../core/types';
import {
  deleteProviderApiKey,
  deleteProviderConfig,
  getProviderSecretStatus,
  getProviderSettings,
  reconcileProviderConfig,
  setActiveProvider,
  setProviderApiKey,
  updateAgentRuntimeSettings,
  upsertProviderConfig,
  testProviderConnection,
} from './agentSettings';
import {
  readAgentToolPermissionSettingsView,
  writeAgentToolPermissionSettingsView,
} from './agentToolPermissionStore';
import { isAgentCommand, isAssetCommand, isDocumentCommand, type AgentCommand, type AssetCommand } from '../core/commands';
import { oauthLoginManager } from './agentOAuthManager';
import { IPC_TRACE_ENABLED, traceIpc } from './ipcTrace';
import type { AgentProviderConfigInput, AgentRuntimeSettingsInput } from '../core/types';
import { loadWindowState, trackWindowState } from './windowState';
import { loadAppPreferences, saveLanguagePreference, saveThemePreference } from './appPreferences';
import { isThemeMode, type ThemeMode } from '../core/theme';
import { isLocale, LIN_LANGUAGE_CHANGED_CHANNEL, resolveSystemLocale, type Locale } from '../core/locale';
import { getMessages } from '../core/i18n';
import { APP_NAME } from '../core/brand';
import { MAX_RAW_INLINE_IMAGE_BYTES, MAX_STAGED_ATTACHMENT_BYTES } from '../core/agentAttachmentLimits';
import { safeAttachmentFileName } from '../core/agentAttachmentPaths';
import { agentAttachmentDir, pruneOldAgentAttachments } from './agentAttachmentMaterialization';
import {
  createLauncherWindow,
  getLauncherWindow,
  hideLauncherWindow,
  showLauncherWindow,
} from './launcher/launcherWindow';
import { registerLauncherHotkey, unregisterLauncherHotkeys } from './launcher/launcherHotkey';
import {
  getStaticLauncherCommands,
  LAUNCHER_CONTEXT_CHANNEL,
  LAUNCHER_NAVIGATE_TO_NODE_CHANNEL,
  type LauncherCreateCaptureResult,
  type LauncherExecuteResult,
  type LauncherInitialState,
  type LauncherNodeMatch,
} from '../core/launcher/commands';
import { buildContextCaptureInput, buildManualNoteInput, isCaptureIntent } from '../core/launcher/sources';
import { resolveLauncherNodeMatches } from '../core/launcher/nodeMatches';
import { rankTextSearchLabel } from '../core/textSearchAnalyzer';
import { captureExternalContext } from './context/contextCapture';
import { isAccessibilityTrusted, promptAccessibility } from './context/nativeBrowserTab';
import { getFrontmostApp } from './context/providers/browser';
import type { FrontmostApp } from './context/providers/browser';
import type { ExternalContext } from '../core/launcher/context';
import type { SearchHit } from '../core/types';

if (process.env.ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', process.env.ELECTRON_USER_DATA_DIR);
} else if (!app.isPackaged) {
  // Running from source (electron-vite dev) with no explicit override. Never
  // share the installed prod app's default userData, so a bare `bun run dev`
  // can't read or clobber daily-use documents, agent sessions, or assets. The
  // clone-specific dev scripts still set ELECTRON_USER_DATA_DIR for per-clone
  // isolation; this is the catch-all for runs that forget to.
  app.setPath('userData', join(app.getPath('home'), '.lin-outliner-dev'));
}

// Unsigned local/dev builds (`mac.identity: null`) can't present a stable code
// signature to the macOS Keychain, so Chromium's os_crypt (cookie / network-state
// encryption) re-prompts for the keychain password on EVERY launch — independent
// of our own secret storage (the app's keychain use was already removed in #115).
// Use the mock keychain so os_crypt never touches the real Keychain: no per-launch
// password prompt. This trades keychain-derived cookie encryption for a static key
// — acceptable here (local single-user app; agent keys are already local 0600 JSON,
// see agentSettings). Revisit when we ship a Developer ID-signed build. Must run
// before the app `ready` event.
app.commandLine.appendSwitch('use-mock-keychain');

// Must run before the app `ready` event so the renderer can load assets with
// regular <img>/<video> tags via `asset://<id>`.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_URL_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// Image file extensions for the native "insert image" picker. The filter's display
// name is localized at the call site (it shows in the OS dialog).
const IMAGE_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'];

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const APP_ICON_PNG_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../build/icon.png');
app.setName(APP_NAME);
const documentService = new DocumentService();
const assetService = new AssetService(() => join(app.getPath('userData'), 'assets'));
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let providerConfigWindow: BrowserWindow | null = null;
let quitAfterFlush = false;
let lastAttachmentPickerDirectory: string | null = null;
const DEFAULT_ATTACHMENT_PICKER_LIMIT = 6;
const DEFAULT_LOCAL_FILE_SEARCH_LIMIT = 8;
const DEFAULT_RECENT_LOCAL_FILE_LIMIT = 6;
const LOCAL_FILE_SEARCH_TIMEOUT_MS = 1200;
const LOCAL_FILE_ICON_TIMEOUT_MS = 250;
const LOCAL_FILE_ICON_SIZE: Electron.FileIconOptions['size'] = 'normal';
const LOCAL_FILE_PREVIEW_TIMEOUT_MS = 1600;
const LOCAL_FILE_THUMBNAIL_TIMEOUT_MS = 350;
const LOCAL_FILE_THUMBNAIL_SIZE = 512;
const RECENT_LOCAL_FILE_TIMEOUT_MS = 900;
const LOCAL_FILE_CACHE_LIMIT = 1000;
const localFileSearchCache = new Map<string, string>();
const localFileIconCache = new Map<string, string | null>();
const localFileThumbnailCache = new Map<string, string | null>();
const pendingLocalFileIconLoads = new Map<string, Promise<string | null>>();
const pendingLocalFileThumbnailLoads = new Map<string, Promise<string | null>>();
const agentLocalFileRoot = process.env.LIN_AGENT_LOCAL_ROOT ?? process.cwd();
const agentRuntime = new AgentRuntime(() => mainWindow, documentService, {
  localFileRoot: agentLocalFileRoot,
});

documentService.onProjectionChanged((event) => {
  mainWindow?.webContents.send(LIN_DOCUMENT_EVENT_CHANNEL, event);
});

// ─── Security shell (the native host owns navigation + capabilities) ───

const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
const RENDERER_DEV_ORIGIN = RENDERER_DEV_URL ? safeOrigin(RENDERER_DEV_URL) : null;

// navigator.clipboard.writeText is the only renderer capability we rely on; deny
// everything else (geolocation, media, notifications, …) by default.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

// The packaged renderer (loaded from file://) is locked to its own resources.
// 'unsafe-inline' styles cover Shiki's inline color spans + React style props;
// remote http(s) is allowed only as <img>/<video> sources. The renderer makes
// no direct network calls (everything else goes through IPC) and runs no
// WebAssembly (loro-crdt lives in the main process), so script-src and
// connect-src stay tight.
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: http: ${ASSET_URL_SCHEME}:`,
  `media-src 'self' data: blob: https: http: ${ASSET_URL_SCHEME}:`,
  "font-src 'self' data:",
  `connect-src 'self' ${ASSET_URL_SCHEME}:`,
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Only http(s) may reach the OS browser — never file:// or a custom scheme.
function openExternalUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  void shell.openExternal(url).catch(() => {});
  return true;
}

function isAppDocumentUrl(url: string): boolean {
  if (url.startsWith('file:')) return true; // packaged renderer
  return RENDERER_DEV_ORIGIN != null && safeOrigin(url) === RENDERER_DEV_ORIGIN; // vite dev
}

// The renderer is a fixed local surface. Block any attempt to navigate it away
// (clicked links, injected redirects) or to spawn child windows; real http(s)
// links open in the OS browser instead.
function hardenWebContents(contents: Electron.WebContents) {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (isAppDocumentUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
}

function configureSessionSecurity() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Enforce CSP on the packaged renderer's own document (loaded from file://).
  // Dev loads from the Vite origin, which needs a relaxed policy for HMR, so it
  // falls through here untouched; the agent's remote web-fetch windows load
  // http(s) and are excluded too.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !details.url.startsWith('file:')) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [RENDERER_CSP],
      },
    });
  });
}

// Opaque pre-paint frame colour for non-material windows. Mirrors the renderer
// deck colour per OS scheme (light `--bg-window` = #ececec, dark #2a2a2c) so a
// launch never flashes a mismatched backing behind the first paint. Dark/light
// follows the OS via @media (prefers-color-scheme) in the renderer (no
// [data-theme] bridge), so this only backs the window before React mounts;
// keeping it scheme-matched to --bg-window closes the residual seam.
function prePaintBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#2a2a2c' : '#ececec';
}

// Native right-click menu (design-system B10 — native OS menus, not a web-style
// context menu). The renderer's command menus (NodeContextMenu, tag menus, the
// page-title menu) already call event.preventDefault() on the DOM contextmenu
// event in the regions they own, and Electron only emits this main-process
// 'context-menu' event when the renderer did NOT preventDefault (verified on
// Electron 42). So this never double-pops over a custom React menu — it fires
// only for the bare right-clicks those menus leave alone: an editable field
// (e.g. the agent composer) gets the text-editing menu (with spelling
// suggestions when the word is flagged), a text selection gets Copy, and inert
// chrome gets nothing at all.
function attachNativeContextMenu(contents: Electron.WebContents): void {
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
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      );
    } else if (params.selectionText.trim().length > 0) {
      template.push({ role: 'copy' });
    }

    if (template.length === 0) return;
    const window = BrowserWindow.fromWebContents(contents);
    Menu.buildFromTemplate(template).popup(window ? { window } : {});
  });
}

// Forward the window's OS focus state to its renderer so the chrome can
// desaturate while the window is inactive — the macOS convention where an
// unfocused window's toolbars / sidebars lose their tint. This is UI state, not
// a document mutation, so it rides its own channel (see core/windowActivity.ts).
function forwardWindowActivity(window: BrowserWindow): void {
  const send = (active: boolean) => {
    if (window.isDestroyed()) return;
    window.webContents.send(LIN_WINDOW_ACTIVE_CHANNEL, active);
  };
  window.on('focus', () => send(true));
  window.on('blur', () => send(false));
  // Seed the initial state once the renderer is listening, so a window that
  // launches unfocused starts correct without waiting for the first toggle.
  window.webContents.on('did-finish-load', () => send(window.isFocused()));
}

// The effective UI language: the user's explicit pick, else the nearest supported
// OS locale (core/locale.ts). Cached in-memory because the ~8 hot-path callers
// (right-click context menu, every window create, launcher node-search, menu rebuild)
// would otherwise each do a sync readFileSync + JSON.parse for a value that only
// changes via lin:set-language. That handler refreshes the cache to the broadcast
// value — the in-session source of truth, the same way theme rides
// nativeTheme.themeSource in memory rather than re-reading the file. The OS locale is
// fixed for the session, so first read resolves it once.
let cachedLocale: Locale | null = null;
function effectiveLocale(): Locale {
  cachedLocale ??= loadAppPreferences().language ?? resolveSystemLocale(app.getLocale());
  return cachedLocale;
}

// Standard application menu (A2b). macOS gets the conventional App / Edit / View
// / Window / Help bar with Preferences on Cmd+,; other platforms drop the App
// menu and surface Settings under File (no app menu exists there). Dev-only View
// items (reload, devtools) are gated on a source run.
//
// Roles still carry the native behavior, accelerators, and enable state, but a
// role's *label* defaults to the OS language, not the app's. So we expand the
// role-based bars (Edit / Window) into explicit role+label items and give View's
// standard items + the Help-menu title explicit labels too — the whole bar then
// follows the effective locale (PM decision 2026-06-04: in-app language wins over
// the macOS-native OS-language convention, since we expose an in-app picker). The
// lone exception is `togglefullscreen`: its role title is dynamic ("Enter" vs
// "Exit Full Screen"), which a static label would freeze, so it stays role-only.
// The menu is rebuilt on language change (see the set-language IPC).
function buildApplicationMenu(): Electron.Menu {
  const isMac = process.platform === 'darwin';
  const isDev = !app.isPackaged;
  const t = getMessages(effectiveLocale()).menu;

  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    ...(isDev
      ? ([
          { role: 'reload', label: t.reload },
          { role: 'forceReload', label: t.forceReload },
          { role: 'toggleDevTools', label: t.toggleDevTools },
          { type: 'separator' },
        ] satisfies Electron.MenuItemConstructorOptions[])
      : []),
    { role: 'resetZoom', label: t.resetZoom },
    { role: 'zoomIn', label: t.zoomIn },
    { role: 'zoomOut', label: t.zoomOut },
    { type: 'separator' },
    // role-only by design: keeps macOS's dynamic "Enter/Exit Full Screen" title.
    { role: 'togglefullscreen' },
  ];

  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    // macOS draws some app-menu strings itself, from the running bundle, NOT from
    // this template:
    //   • the bold app-menu title and the ⌘, Settings item are OS-managed — in a
    //     dev run (Electron.app, CFBundleName "Electron") they read "Electron" /
    //     "Preferences…" no matter what label we pass; a packaged build supplies
    //     CFBundleName from productName ("Tenon") and the macOS-13+ "Settings…".
    //   • About / Hide / Quit are ordinary items, so an explicit label DOES win —
    //     set them off APP_NAME so even a dev run reads "About Tenon" etc.
    // We still pass label: APP_NAME on the first submenu as the packaged-correct
    // value even though macOS overrides the dev rendering.
    template.push({
      label: APP_NAME,
      submenu: [
        { role: 'about', label: t.about({ app: APP_NAME }) },
        { type: 'separator' },
        { label: t.settings, accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: t.hide({ app: APP_NAME }) },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: t.quit({ app: APP_NAME }) },
      ],
    });
  } else {
    template.push({
      label: t.file,
      submenu: [
        { label: t.settings, accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  // Manual equivalent of `role: 'editMenu'` (Electron's documented expansion) with
  // explicit labels. macOS still auto-injects Emoji & Symbols / Start Dictation at
  // the bottom; those stay OS-localized.
  template.push({
    label: t.edit,
    submenu: [
      { role: 'undo', label: t.undo },
      { role: 'redo', label: t.redo },
      { type: 'separator' },
      { role: 'cut', label: t.cut },
      { role: 'copy', label: t.copy },
      { role: 'paste', label: t.paste },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle', label: t.pasteAndMatchStyle },
            { role: 'delete', label: t.delete },
            { role: 'selectAll', label: t.selectAll },
            { type: 'separator' },
            {
              label: t.speech,
              submenu: [
                { role: 'startSpeaking', label: t.startSpeaking },
                { role: 'stopSpeaking', label: t.stopSpeaking },
              ],
            },
          ] satisfies Electron.MenuItemConstructorOptions[])
        : ([
            { role: 'delete', label: t.delete },
            { type: 'separator' },
            { role: 'selectAll', label: t.selectAll },
          ] satisfies Electron.MenuItemConstructorOptions[])),
    ],
  });
  template.push({ label: t.view, submenu: viewSubmenu });
  // Manual equivalent of `role: 'windowMenu'`; the trailing `role: 'window'` keeps
  // macOS appending the live window list under the localized title.
  template.push({
    label: t.window,
    submenu: isMac
      ? [
          { role: 'minimize', label: t.minimize },
          { role: 'zoom', label: t.zoom },
          { type: 'separator' },
          { role: 'front', label: t.front },
          { type: 'separator' },
          { role: 'window' },
        ]
      : [
          { role: 'minimize', label: t.minimize },
          { role: 'zoom', label: t.zoom },
          { type: 'separator' },
          { role: 'close' },
        ],
  });
  template.push({
    role: 'help',
    label: t.helpTitle,
    submenu: [
      {
        label: t.help({ app: APP_NAME }),
        click: () => void shell.openExternal('https://github.com/relixiaobo/lin-outliner'),
      },
      {
        label: t.reportIssue,
        click: () => void shell.openExternal('https://github.com/relixiaobo/lin-outliner/issues'),
      },
    ],
  });

  return Menu.buildFromTemplate(template);
}

function createWindow() {
  const windowState = loadWindowState();
  const material = windowMaterialKind(process.platform);
  const icon = nativeImage.createFromPath(APP_ICON_PNG_PATH);
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: windowState.bounds?.width ?? 1120,
    height: windowState.bounds?.height ?? 820,
    ...(windowState.bounds ? { x: windowState.bounds.x, y: windowState.bounds.y } : {}),
    minWidth: 760,
    minHeight: 560,
    // Create hidden and reveal on first paint so launch never flashes an empty
    // white frame; the platform animates the show.
    show: false,
    // With a window material the background must be transparent so the OS
    // material (vibrancy / mica) shows through; otherwise keep the opaque deck
    // colour as the pre-paint frame.
    backgroundColor: material ? '#00000000' : prePaintBackgroundColor(),
    ...(material === 'vibrancy' ? { vibrancy: 'under-window' as const } : {}),
    ...(material === 'mica' ? { backgroundMaterial: 'mica' as const } : {}),
    ...(icon.isEmpty() ? {} : { icon }),
    // Standard window: hiddenInset keeps the native traffic lights (the OS draws
    // and manages close/minimize/zoom — focus graying, ⌥-zoom, real fullscreen —
    // exactly like Raycast, which repositions standardWindowButton rather than
    // self-drawing). The corner radius is set on the window's *native* corner by
    // the window_corner addon below (see applyMacWindowCorner), so the OS still
    // owns the corner clip + shadow and the native chrome is preserved.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (windowState.maximized) mainWindow.maximize();
  hardenWebContents(mainWindow.webContents);
  attachNativeContextMenu(mainWindow.webContents);
  forwardWindowActivity(mainWindow);
  trackWindowState(mainWindow);

  // Custom window corner via the native window_corner addon (no-op off macOS /
  // if unbuilt): it sets MAC_WINDOW_CORNER_RADIUS on the window's native corner
  // (macOS 26 reads the private _cornerRadius selectors; older macOS the
  // _cornerMask) so the standard window keeps its native traffic lights, OS
  // shadow, and vibrancy. Apply once before show (so the first paint is already
  // rounded, no default-corner flash) and again on ready-to-show; drop to 0 in
  // fullscreen, where a rounded corner would clip content into empty triangles.
  applyMacWindowCorner(mainWindow, MAC_WINDOW_CORNER_RADIUS);
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    applyMacWindowCorner(mainWindow, MAC_WINDOW_CORNER_RADIUS);
    mainWindow.show();
  });
  mainWindow.on('enter-full-screen', () => mainWindow && applyMacWindowCorner(mainWindow, 0));
  mainWindow.on('leave-full-screen', () =>
    mainWindow && applyMacWindowCorner(mainWindow, MAC_WINDOW_CORNER_RADIUS),
  );

  if (RENDERER_DEV_URL) {
    void mainWindow.loadURL(RENDERER_DEV_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.once('did-finish-load', () => {
    agentRuntime.ready();
  });
  // A launcher "open node" that had to spin up the main window — or that arrived
  // during a renderer reload — waits for the renderer to load before the navigate
  // can land. `on` (not `once`) so it re-arms across reloads (dev HMR full reload,
  // in-app reload); a spent `once` would silently drop a later deferred navigate.
  mainWindow.webContents.on('did-finish-load', () => {
    flushPendingNavigates();
  });
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Node ids the launcher asked to open before the main window's renderer had
// finished loading; flushed on each `did-finish-load` (see createWindow). A queue,
// not a single slot, so two rapid cold opens before load don't clobber each other.
let pendingNavigateNodeIds: string[] = [];

function flushPendingNavigates(): void {
  if (pendingNavigateNodeIds.length === 0) return;
  const ids = pendingNavigateNodeIds;
  pendingNavigateNodeIds = [];
  for (const id of ids) {
    mainWindow?.webContents.send(LAUNCHER_NAVIGATE_TO_NODE_CHANNEL, id);
  }
}

/**
 * Open a document node in the main window (from a launcher inline search result):
 * bring the window up and tell the renderer to navigate + focus. If the window
 * isn't created yet, or its renderer hasn't finished loading, defer the navigate
 * until the next `did-finish-load` flush (re-armable across reloads).
 */
function navigateMainToNode(nodeId: string): void {
  if (!mainWindow) {
    pendingNavigateNodeIds.push(nodeId);
    createWindow();
  } else if (mainWindow.webContents.isLoading()) {
    // Window exists but its renderer hasn't finished loading — defer; the
    // did-finish-load handler flushes the queue.
    pendingNavigateNodeIds.push(nodeId);
  } else {
    mainWindow.webContents.send(LAUNCHER_NAVIGATE_TO_NODE_CHANNEL, nodeId);
  }
  focusMainWindow();
}

/**
 * Resolve `search_nodes` hits into serializable matches for the launcher (which
 * can't read the document itself). Each match carries the node's single-line text
 * and its parent's text for disambiguation. Bounded to the top results.
 */
async function searchLauncherNodes(query: string): Promise<LauncherNodeMatch[]> {
  const q = query.trim();
  if (!q) return [];
  const hits = (await documentService.handle('search_nodes', { query: q })) as SearchHit[];
  if (hits.length === 0) return [];
  // Only the top hits are shown — resolve just those nodes (+ their parents, for
  // the subtitle) by id, never materializing/mapping the whole-document projection
  // on every debounced keystroke. Slice before lookup so work is bounded by the
  // result limit, not the hit count.
  const hitIds = hits.slice(0, LAUNCHER_NODE_RESULT_LIMIT).map((hit) => hit.nodeId);
  const hitNodes = documentService.projectionNodesByIds(hitIds);
  const parentIds = hitNodes
    .map((node) => node.parentId)
    .filter((id): id is string => Boolean(id));
  const matchable = [...hitNodes, ...documentService.projectionNodesByIds(parentIds)].map((node) => ({
    id: node.id,
    text: node.content.text,
    parentId: node.parentId,
    icon: node.icon,
    iconKind: node.iconKind,
  }));
  return resolveLauncherNodeMatches(
    hitIds,
    matchable,
    LAUNCHER_NODE_RESULT_LIMIT,
    getMessages(effectiveLocale()).common.untitled,
  );
}

/** Max inline node results shown in the launcher (keeps the list scannable). */
const LAUNCHER_NODE_RESULT_LIMIT = 8;

// The accelerator the launcher hotkey actually registered under (or null if none
// was free), surfaced to the launcher renderer so it can reflect/repair it later.
let launcherHotkeyAccelerator: string | null = null;

// The external context captured for the CURRENT launcher open (what app/page the
// user was looking at when the hotkey fired). Main holds the authoritative copy;
// the renderer gets a pushed view for display, and "Capture page" saves from
// this — so the saved metadata can't be tampered with from the renderer. Cleared
// on each open and on hide.
let launcherContext: ExternalContext | null = null;
// Monotonic id per launcher open. An in-flight async context capture stamps the
// open it belongs to and is dropped if the launcher was dismissed or re-opened
// before it resolved — so a slow capture can never repopulate a stale/next open.
let launcherOpenSeq = 0;

/**
 * Dismiss the launcher and forget its captured context. EVERY hide path routes
 * here — including clicking away (window blur) — so the previous page's metadata
 * can't linger and be saved into a later open. Bumping the open-seq also
 * invalidates any context capture still in flight for the dismissed open.
 */
function dismissLauncher(): void {
  hideLauncherWindow();
  launcherContext = null;
  launcherOpenSeq++;
}

// Request Accessibility at most once per app run (the first browser capture
// without it). The system prompt both shows the dialog and registers the app in
// Privacy & Security → Accessibility, so the user can enable the reliable AX
// capture path; without this the unsigned dev binary never appears in the list.
let accessibilityPrompted = false;

/**
 * Hotkey handler: toggle the launcher, capturing what the user was looking at.
 *
 * Order matters — the launcher steals focus on show, after which the frontmost
 * app is us. So we read the frontmost app in the `beforeFocus` window (while the
 * old app is still active), then finish the slower tab/page reads after focus
 * (those target the browser by name, so focus having moved is fine) and push the
 * result to the renderer.
 */
async function toggleLauncher(): Promise<void> {
  const win = getLauncherWindow();
  if (win?.isVisible()) {
    dismissLauncher();
    return;
  }
  const openSeq = ++launcherOpenSeq;
  launcherContext = null;
  const contextId = `ctx:${randomUUID()}`;
  const capturedAt = new Date().toISOString();
  // Holder (not a bare `let`) so the value assigned inside the async beforeFocus
  // callback keeps its declared type for later reads — TS control flow does not
  // track assignments made through a callback.
  const front: { app: FrontmostApp | null } = { app: null };
  await showLauncherWindow(async () => {
    front.app = await getFrontmostApp();
  });
  try {
    const context = await captureExternalContext({
      id: contextId,
      capturedAt,
      captureOrigin: 'global-hotkey',
      frontmost: front.app,
    });
    // Drop if this open was dismissed (click-away / Esc) or superseded by a newer
    // open while we were capturing — never repopulate a stale or already-closed open.
    if (openSeq !== launcherOpenSeq || !getLauncherWindow()?.isVisible()) return;
    launcherContext = context;
    // Dev diagnostic: surface what each capture layer resolved to, so a
    // wrong-page capture (e.g. the browser's "front window" ≠ the visible tab)
    // can be pinpointed from the dev terminal. Quiet in packaged builds.
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
        warnings: context.warnings.map((w) => w.code),
      });
    }
    getLauncherWindow()?.webContents.send(LAUNCHER_CONTEXT_CHANNEL, context);
    // First browser capture without Accessibility → request it once (shows the
    // system prompt and registers the app in the Privacy list).
    if (!accessibilityPrompted && context.providerId === 'generic-webpage' && !isAccessibilityTrusted()) {
      accessibilityPrompted = true;
      promptAccessibility();
    }
  } catch (error) {
    console.error('[launcher] context capture failed', error);
  }
}

function executeLauncherCommand(id: unknown): LauncherExecuteResult {
  switch (id) {
    case 'open-main':
      if (!mainWindow) createWindow();
      focusMainWindow();
      return { hide: true };
    case 'open-settings':
      openSettingsWindow();
      return { hide: true };
    default:
      // Only open-main / open-settings ship today; AI, capture destinations, and
      // navigation commands are deferred to follow-up plans and aren't registered
      // yet. An unknown id just dismisses the launcher.
      return { hide: true };
  }
}

// Settings open in their own window — the native "Preferences" convention —
// reusing the single renderer bundle via a ?surface=settings query. Like the main
// window it is frameless with inset traffic lights (the lights sit over the
// settings rail, no separate title-bar strip); the renderer draws its own top drag
// region. It isn't persisted across launches.
function openSettingsWindow() {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  // A utilitarian Preferences window: opaque content, no OS material (unlike the
  // main window). Frameless with inset traffic lights (titleBarStyle: hiddenInset)
  // so the lights sit over the settings rail and there is no native title-bar
  // strip — the renderer provides the top drag region. Security defaults (A3) are
  // unchanged.
  settingsWindow = new BrowserWindow({
    title: getMessages(effectiveLocale()).window.settingsTitle({ app: APP_NAME }),
    width: 760,
    height: 620,
    minWidth: 560,
    minHeight: 480,
    show: false,
    backgroundColor: prePaintBackgroundColor(),
    ...(() => {
      const icon = nativeImage.createFromPath(APP_ICON_PNG_PATH);
      return icon.isEmpty() ? {} : { icon };
    })(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const target = settingsWindow;
  hardenWebContents(target.webContents);
  attachNativeContextMenu(target.webContents);
  // Match the main window's custom native corner (MAC_WINDOW_CORNER_RADIUS) so the
  // frameless settings window has the SAME rounded corners — not the smaller macOS
  // default (16pt on Tahoe). Apply before show (no default-corner flash) and again
  // on ready-to-show; reset to 0 in fullscreen where a rounded corner clips content.
  applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
  target.once('ready-to-show', () => {
    applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
    target.show();
  });
  target.on('enter-full-screen', () => applyMacWindowCorner(target, 0));
  target.on('leave-full-screen', () => applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS));

  if (RENDERER_DEV_URL) {
    void target.loadURL(`${RENDERER_DEV_URL}?${WINDOW_SURFACE_QUERY_PARAM}=settings`);
  } else {
    void target.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { [WINDOW_SURFACE_QUERY_PARAM]: 'settings' },
    });
  }

  target.on('closed', () => {
    settingsWindow = null;
  });
}

// The per-provider API-key form opens as its OWN native window — a modal child of
// the settings window (the macOS System Settings idiom: a list row pushes its
// detail into a real attached dialog, not an in-renderer overlay). It reuses the
// single renderer bundle via ?surface=provider-config and is told which provider /
// mode through the query. Frameless (no traffic lights — it is a dialog, closed by
// its own Cancel / Save), opaque, fixed-size, centred over the parent. Security
// defaults (A3) match every other window.
function openProviderConfigWindow(providerId: string, mode: ProviderConfigMode) {
  const parent = settingsWindow ?? undefined;
  // Replace any open config window (clicking another provider re-targets it).
  if (providerConfigWindow) {
    // Abort any in-flight sign-in tied to the window we're replacing, so its
    // loopback server / parked prompts don't leak and stale events can't reach
    // the new window. (Only this provider's login can be in flight here.)
    oauthLoginManager.cancelAll();
    providerConfigWindow.close();
    providerConfigWindow = null;
  }

  const bounds = parent?.getBounds();
  const width = 460;
  const height = 384;
  const position = bounds
    ? {
        x: Math.round(bounds.x + (bounds.width - width) / 2),
        y: Math.round(bounds.y + Math.max(48, (bounds.height - height) / 2)),
      }
    : {};

  providerConfigWindow = new BrowserWindow({
    title: getMessages(effectiveLocale()).window.providerConfigTitle,
    width,
    height,
    ...position,
    parent,
    modal: Boolean(parent),
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: prePaintBackgroundColor(),
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const target = providerConfigWindow;
  hardenWebContents(target.webContents);
  attachNativeContextMenu(target.webContents);
  applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
  target.once('ready-to-show', () => {
    applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
    target.show();
  });

  const query = {
    [WINDOW_SURFACE_QUERY_PARAM]: 'provider-config',
    [PROVIDER_CONFIG_PROVIDER_PARAM]: providerId,
    [PROVIDER_CONFIG_MODE_PARAM]: mode,
  };
  if (RENDERER_DEV_URL) {
    const url = new URL(RENDERER_DEV_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void target.loadURL(url.toString());
  } else {
    void target.loadFile(join(__dirname, '../renderer/index.html'), { query });
  }

  target.on('closed', () => {
    // Act only on a genuine close of the *current* window — a re-target already
    // cancelled the old login and reassigned the ref. Closing the live window
    // must abort its in-flight sign-in (loopback server / parked prompts).
    if (providerConfigWindow === target) {
      oauthLoginManager.cancelAll();
      providerConfigWindow = null;
    }
  });
}

function registerIpc() {
  ipcMain.handle('lin:invoke', async (_event, command: string, args?: Record<string, unknown>) => {
    const dispatch = () => {
      if (isAgentCommand(command)) return handleAgentCommand(command, args ?? {});
      if (isAssetCommand(command)) return handleAssetCommand(command, args ?? {});
      if (isDocumentCommand(command)) return documentService.handle(command, args);
      throw new Error(`Unknown command: ${command}`);
    };
    if (!IPC_TRACE_ENABLED) return dispatch();
    const start = performance.now();
    const result = await dispatch();
    traceIpc(command, result, performance.now() - start);
    return result;
  });

  ipcMain.handle('lin:window', (_event, command: string) => {
    const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!window) return;
    if (command === 'minimize') window.minimize();
    if (command === 'toggle_maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    if (command === 'close') window.close();
  });

  ipcMain.handle('lin:open-settings', () => openSettingsWindow());
  ipcMain.handle('lin:close-settings', () => settingsWindow?.close());
  // Launcher window IPC (the prewarmed global launcher).
  ipcMain.handle('launcher:hide', () => {
    dismissLauncher();
  });
  ipcMain.handle('launcher:getInitialState', (): LauncherInitialState => ({
    commands: getStaticLauncherCommands(),
    hotkey: launcherHotkeyAccelerator,
  }));
  ipcMain.handle('launcher:executeCommand', (_event, id: unknown): LauncherExecuteResult =>
    executeLauncherCommand(id));
  // New node from the launcher: a plain typed note (no external source). Ensure
  // today's date node, then create the node under it. NOT a capture — no sidecar.
  ipcMain.handle('launcher:createCapture', async (_event, raw: unknown): Promise<LauncherCreateCaptureResult> => {
    const payload = (raw ?? {}) as { title?: unknown; note?: unknown };
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (!title) return { ok: false };
    const note = typeof payload.note === 'string' ? payload.note : undefined;
    try {
      const now = new Date();
      await documentService.handle('ensure_date_node', {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
      });
      const input = buildManualNoteInput({
        destinationParentId: documentService.todayId(),
        title,
        note,
      });
      const outcome = await documentService.handle('create_capture', { input }) as CommandResult;
      return { ok: true, nodeId: outcome.focus?.nodeId };
    } catch (error) {
      console.error('[launcher] createCapture failed', error);
      return { ok: false };
    }
  });
  // Context capture: save what the user was looking at (the main-held authoritative
  // ExternalContext for this open) under Today. The renderer supplies only an
  // optional note/intent — never the source metadata — so it can't be tampered with.
  ipcMain.handle('launcher:createContextCapture', async (_event, raw: unknown): Promise<LauncherCreateCaptureResult> => {
    const context = launcherContext;
    if (!context) return { ok: false };
    const payload = (raw ?? {}) as { note?: unknown; intent?: unknown };
    const note = typeof payload.note === 'string' ? payload.note : undefined;
    // Validate against the known set — an out-of-enum string must not be persisted
    // into the durable CaptureNodeMetadata (the renderer is across the seam).
    const intent = isCaptureIntent(payload.intent) ? payload.intent : undefined;
    try {
      const now = new Date();
      await documentService.handle('ensure_date_node', {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
      });
      const captureId = `cap:${randomUUID()}`;
      // Basic-info capture: the node carries title + URL + author only. Rich page
      // content (body/selection/transcript) is not extracted today — it returns
      // with the unified browser extension/CDP backend
      // (docs/plans/browser-extension-integration.md).
      const input = buildContextCaptureInput({
        context,
        destinationParentId: documentService.todayId(),
        captureId,
        note,
        intent,
      });
      const outcome = await documentService.handle('create_capture', { input }) as CommandResult;
      if (!app.isPackaged) {
        console.log('[launcher] capture saved', { nodeId: outcome.focus?.nodeId ?? null });
      }
      return { ok: true, nodeId: outcome.focus?.nodeId };
    } catch (error) {
      console.error('[launcher] createContextCapture failed', error);
      return { ok: false };
    }
  });
  // Inline node search: the launcher input queries the document directly (no
  // "Search notes" command). Read-only; main enriches hits with node text.
  ipcMain.handle('launcher:searchNodes', async (_event, raw: unknown): Promise<LauncherNodeMatch[]> => {
    try {
      return await searchLauncherNodes(typeof raw === 'string' ? raw : '');
    } catch (error) {
      console.error('[launcher] searchNodes failed', error);
      return [];
    }
  });
  // Open a node search result: bring up the main window and navigate to it.
  ipcMain.handle('launcher:openNode', (_event, raw: unknown): void => {
    if (typeof raw !== 'string' || !raw) return;
    navigateMainToNode(raw);
    dismissLauncher();
  });
  // Appearance preference. Setting nativeTheme.themeSource rewrites
  // prefers-color-scheme in every renderer, so the @media rules in theme-dark.css
  // flip all windows at once — no per-window broadcast needed. We mirror the stored
  // mode (not the resolved scheme) so the settings control reflects the user's pick.
  ipcMain.handle('lin:get-theme', (): ThemeMode => nativeTheme.themeSource);
  ipcMain.handle('lin:set-theme', (_event, mode: unknown): void => {
    if (!isThemeMode(mode)) return;
    nativeTheme.themeSource = mode;
    saveThemePreference(mode);
  });
  // Language preference. Read synchronously so preload can seed the renderer's first
  // paint without a flash; setting it persists, broadcasts to every window (open
  // windows re-render via I18nProvider without a reload), and rebuilds the native
  // menu in the new locale. Language has no nativeTheme-style free broadcast, so we
  // push it ourselves. See core/locale.ts.
  ipcMain.on('lin:get-language-sync', (event) => {
    event.returnValue = effectiveLocale();
  });
  ipcMain.handle('lin:set-language', (_event, raw: unknown): void => {
    if (!isLocale(raw)) return;
    saveLanguagePreference(raw); // best-effort persistence (see appPreferences.ts)
    // The broadcast value is the in-session source of truth — persistence can fail
    // silently. Refresh the cache from it so the native menu + window titles rebuilt
    // below agree with the locale the windows switch to, even if the file write failed
    // (otherwise effectiveLocale() would re-read the stale file and the menu would lag).
    cachedLocale = raw;
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(LIN_LANGUAGE_CHANGED_CHANNEL, raw);
    }
    Menu.setApplicationMenu(buildApplicationMenu());
    // Open windows localize their native title bar once at construction; their content
    // re-renders via I18nProvider, but the OS title bar would otherwise stay stale.
    const messages = getMessages(raw);
    settingsWindow?.setTitle(messages.window.settingsTitle({ app: APP_NAME }));
    providerConfigWindow?.setTitle(messages.window.providerConfigTitle);
  });
  // Open the per-provider config as its own native (modal child) window.
  ipcMain.handle('lin:open-provider-config', (_event, args?: { providerId?: unknown; mode?: unknown }) => {
    const providerId = typeof args?.providerId === 'string' ? args.providerId : '';
    const mode: ProviderConfigMode = args?.mode === 'custom' ? 'custom' : 'configure';
    openProviderConfigWindow(providerId, mode);
  });
  ipcMain.handle('lin:close-provider-config', () => providerConfigWindow?.close());
  // A provider/agent setting changed (from the settings window OR its config child).
  // Tell BOTH the main window (stale provider state) and the settings window (its
  // list reflects the new connection) to re-fetch.
  ipcMain.handle('lin:settings-changed', () => {
    mainWindow?.webContents.send(LIN_SETTINGS_CHANGED_CHANNEL);
    settingsWindow?.webContents.send(LIN_SETTINGS_CHANGED_CHANNEL);
  });

  ipcMain.handle('lin:pick-local-files', async (event, rawOptions?: {
    maxFiles?: unknown;
  }) => {
    const maxFiles = clampPickerLimit(rawOptions?.maxFiles);
    const window = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? mainWindow;
    const defaultPath = attachmentPickerDefaultPath();
    const multiSelections = maxFiles > 1;
    const options: Electron.OpenDialogOptions = {
      ...(defaultPath.path ? { defaultPath: defaultPath.path } : {}),
      properties: multiSelections ? ['openFile', 'multiSelections'] : ['openFile'],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return {
        canceled: true,
        files: [],
      };
    }
    lastAttachmentPickerDirectory = dirname(result.filePaths[0]!);
    const selectedPaths = result.filePaths.slice(0, maxFiles);
    const skippedCount = Math.max(0, result.filePaths.length - selectedPaths.length);
    const files = (await Promise.all(selectedPaths.map(localPickedFile))).filter(
      (file): file is NonNullable<Awaited<ReturnType<typeof localPickedFile>>> => Boolean(file),
    );
    return {
      canceled: false,
      files,
      ...(skippedCount > 0 ? { skippedCount } : {}),
    };
  });

  ipcMain.handle('lin:search-local-files', async (_event, rawOptions?: {
    limit?: unknown;
    query?: unknown;
  }) => {
    const query = normalizeLocalFileQuery(rawOptions?.query);
    const limit = clampLocalFileSearchLimit(rawOptions?.limit);
    if (!query) return { files: [], query };
    const paths = await searchLocalFilePaths(query, limit * 6);
    const files = await localFileSearchResults(paths, query, limit);
    return { files, query };
  });

  ipcMain.handle('lin:recent-local-files', async (_event, rawOptions?: { limit?: unknown }) => {
    const limit = clampRecentLocalFileLimit(rawOptions?.limit);
    const paths = await recentLocalFilePaths(limit * 12);
    const files = await withLocalFileIcons((await localFileMetadataResults(paths, limit * 12))
      .sort((left, right) => right.lastModified - left.lastModified)
      .slice(0, limit));
    return { files };
  });

  ipcMain.handle('lin:prepare-local-file', async (_event, rawOptions?: { id?: unknown }) => {
    const id = typeof rawOptions?.id === 'string' ? rawOptions.id : '';
    const filePath = localFileSearchCache.get(id);
    if (!filePath) return { file: null };
    return { file: await localPickedFile(filePath) };
  });

  ipcMain.handle('lin:preview-local-file', async (_event, rawOptions?: { id?: unknown }) => {
    const id = typeof rawOptions?.id === 'string' ? rawOptions.id : '';
    const filePath = localFileSearchCache.get(id);
    if (!filePath) return { thumbnailDataUrl: null };
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return { thumbnailDataUrl: null };
      const file = {
        entryKind: 'file',
        mimeType: inferMimeType(filePath),
        name: basename(filePath),
      };
      if (!shouldLoadLocalFileThumbnail(file)) return { thumbnailDataUrl: null };
      return {
        thumbnailDataUrl: await localFileThumbnailDataUrl(filePath, LOCAL_FILE_PREVIEW_TIMEOUT_MS),
      };
    } catch {
      return { thumbnailDataUrl: null };
    }
  });

  ipcMain.handle('lin:stage-attachment', async (_event, rawOptions?: {
    bytes?: unknown;
    mimeType?: unknown;
    name?: unknown;
  }) => {
    const bytes = stagedAttachmentBuffer(rawOptions?.bytes);
    if (!bytes) throw new Error('Attachment bytes are required.');
    if (bytes.byteLength > MAX_STAGED_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is larger than ${formatBytes(MAX_STAGED_ATTACHMENT_BYTES)} and cannot be staged.`);
    }
    const rawName = typeof rawOptions?.name === 'string' && rawOptions.name.trim()
      ? rawOptions.name.trim()
      : 'attachment';
    const mimeType = typeof rawOptions?.mimeType === 'string' && rawOptions.mimeType.trim()
      ? rawOptions.mimeType.trim()
      : 'application/octet-stream';
    const name = safeAttachmentFileName(rawName);
    await pruneOldAgentAttachments(agentLocalFileRoot);
    const attachmentDir = agentAttachmentDir(agentLocalFileRoot);
    await mkdir(attachmentDir, { recursive: true });
    const filePath = join(attachmentDir, `${randomUUID()}-${name}`);
    await writeFile(filePath, bytes);
    return {
      path: filePath,
      name: rawName,
      mimeType,
      sizeBytes: bytes.byteLength,
    };
  });
}

function stagedAttachmentBuffer(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

async function handleAssetCommand(command: AssetCommand, args: Record<string, unknown>) {
  switch (command) {
    case 'ingest_asset': {
      // Only the buffer path is exposed to the renderer. Path ingest is an
      // arbitrary-local-file read primitive, so it stays main-process-only
      // (used internally by pick_image_files); the renderer can never name a
      // path to read back through asset://.
      if ((args as { kind?: unknown }).kind !== 'buffer') {
        throw new Error('ingest_asset accepts only kind:"buffer" over IPC');
      }
      return assetService.ingest(args as unknown as AssetIngestInput);
    }
    case 'lookup_asset':
      return assetService.lookup(String(args.id));
    case 'delete_asset':
      return assetService.delete(String(args.id));
    case 'pick_image_files': {
      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const dialogStrings = getMessages(effectiveLocale()).window;
      const options = {
        title: dialogStrings.insertImageTitle,
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [{ name: dialogStrings.imageFilesFilter, extensions: IMAGE_FILE_EXTENSIONS }],
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      return Promise.all(result.filePaths.map((path) => assetService.ingest({ kind: 'path', path })));
    }
    case 'open_asset': {
      const path = await assetService.pathFor(String(args.id));
      if (path) await shell.openPath(path);
      return { opened: Boolean(path) };
    }
    case 'reveal_asset': {
      const path = await assetService.pathFor(String(args.id));
      if (path) shell.showItemInFolder(path);
      return { revealed: Boolean(path) };
    }
    case 'open_external_url': {
      // Opens a remote media node's source in the OS default browser. Only
      // http(s) is allowed so a node can never smuggle a file:// or other
      // scheme into shell.openExternal.
      return { opened: openExternalUrl(String(args.url)) };
    }
    default:
      throw new Error(`Unknown asset command: ${command}`);
  }
}

function attachmentPickerDefaultPath(): { path?: string; source: string } {
  const mode = process.env.LIN_ATTACHMENT_PICKER_DEFAULT_PATH ?? 'last';
  if (mode === 'none' || mode === 'system') return { source: 'system' };
  if (mode === 'last') {
    if (lastAttachmentPickerDirectory) return { path: lastAttachmentPickerDirectory, source: 'last' };
    const downloads = safeAppPath('downloads');
    if (downloads) return { path: downloads, source: 'downloads-fallback' };
    return { source: 'system' };
  }
  if (mode === 'downloads') {
    const downloads = safeAppPath('downloads');
    return downloads ? { path: downloads, source: 'downloads' } : { source: 'system' };
  }
  if (mode === 'documents') {
    const documents = safeAppPath('documents');
    return documents ? { path: documents, source: 'documents' } : { source: 'system' };
  }
  if (mode === 'home') {
    const home = safeAppPath('home');
    return home ? { path: home, source: 'home' } : { source: 'system' };
  }
  return { source: 'system' };
}

function clampPickerLimit(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_ATTACHMENT_PICKER_LIMIT;
  return Math.min(50, Math.max(1, numeric));
}

function clampLocalFileSearchLimit(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_LOCAL_FILE_SEARCH_LIMIT;
  return Math.min(24, Math.max(1, numeric));
}

function clampRecentLocalFileLimit(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_RECENT_LOCAL_FILE_LIMIT;
  return Math.min(18, Math.max(1, numeric));
}

function normalizeLocalFileQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function searchLocalFilePaths(query: string, limit: number): Promise<string[]> {
  if (process.platform === 'darwin') {
    const spotlight = await mdfindFileNameMatches(query, limit);
    if (spotlight.length > 0) return spotlight;
  }
  return rgFileNameMatches(query, limit);
}

function mdfindFileNameMatches(query: string, limit: number): Promise<string[]> {
  return collectNullDelimitedProcess('/usr/bin/mdfind', ['-0', '-name', query], limit, LOCAL_FILE_SEARCH_TIMEOUT_MS);
}

async function recentLocalFilePaths(limit: number): Promise<string[]> {
  if (process.platform === 'darwin') {
    const spotlight = await collectNullDelimitedProcess(
      '/usr/bin/mdfind',
      ['-0', 'kMDItemFSContentChangeDate >= $time.today(-30)'],
      limit,
      RECENT_LOCAL_FILE_TIMEOUT_MS,
    );
    if (spotlight.length > 0) return spotlight;
  }
  return commonDirectoryRecentFilePaths(limit);
}

async function commonDirectoryRecentFilePaths(limit: number): Promise<string[]> {
  const roots = ['desktop', 'documents', 'downloads']
    .map((name) => safeAppPath(name as Parameters<typeof app.getPath>[0]))
    .filter((path): path is string => Boolean(path));
  const paths: string[] = [];
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isDirectory()) continue;
        paths.push(join(root, entry.name));
        if (paths.length >= limit) return paths;
      }
    } catch {
      // Ignore folders the user has not granted or that do not exist.
    }
  }
  return paths;
}

function rgFileNameMatches(query: string, limit: number): Promise<string[]> {
  const home = safeAppPath('home');
  if (!home) return Promise.resolve([]);
  return new Promise((resolve) => {
    const results: string[] = [];
    const seen = new Set<string>();
    const lowerQuery = query.toLowerCase();
    const child = spawn('rg', [
      '--files',
      '--hidden',
      '--glob', '!**/.git/**',
      '--glob', '!**/node_modules/**',
      '--glob', '!**/Library/**',
      home,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(results);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, LOCAL_FILE_SEARCH_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const filePath = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (basename(filePath).toLowerCase().includes(lowerQuery) && !seen.has(filePath)) {
          seen.add(filePath);
          results.push(filePath);
          if (results.length >= limit) {
            child.kill();
            finish();
            return;
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

function collectNullDelimitedProcess(
  command: string,
  args: string[],
  limit: number,
  timeoutMs: number,
): Promise<string[]> {
  return new Promise((resolve) => {
    const results: string[] = [];
    const seen = new Set<string>();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(results);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let delimiter = buffer.indexOf(0);
      while (delimiter >= 0) {
        const filePath = buffer.subarray(0, delimiter).toString('utf8');
        buffer = buffer.subarray(delimiter + 1);
        if (filePath && !seen.has(filePath)) {
          seen.add(filePath);
          results.push(filePath);
          if (results.length >= limit) {
            child.kill();
            finish();
            return;
          }
        }
        delimiter = buffer.indexOf(0);
      }
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

async function localFileSearchResults(paths: string[], query: string, limit: number) {
  const rankedPaths = [...paths].sort((left, right) =>
    localFilePathRank(left, query) - localFilePathRank(right, query));
  return withLocalFileIcons(await localFileMetadataResults(rankedPaths, limit));
}

async function localFileMetadataResults(paths: string[], limit: number) {
  const files = [];
  for (const filePath of paths) {
    if (files.length >= limit) break;
    try {
      const fileStat = await stat(filePath);
      const entryKind = fileStat.isDirectory() ? 'directory' : fileStat.isFile() ? 'file' : null;
      if (!entryKind) continue;
      files.push({
        entryKind,
        id: cacheLocalFileSearchPath(filePath),
        path: filePath,
        name: basename(filePath),
        parentPath: dirname(filePath),
        mimeType: entryKind === 'directory' ? 'inode/directory' : inferMimeType(filePath),
        sizeBytes: entryKind === 'directory' ? 0 : fileStat.size,
        lastModified: fileStat.mtimeMs,
      });
    } catch {
      // Spotlight can return stale paths; ignore entries that no longer stat.
    }
  }
  return files;
}

function withLocalFileIcons<T extends {
  entryKind?: string;
  mimeType?: string;
  name?: string;
  path: string;
}>(files: T[]): Promise<Array<T & { iconDataUrl?: string; thumbnailDataUrl?: string }>> {
  return Promise.all(files.map(async (file) => {
    const [iconDataUrl, thumbnailDataUrl] = await Promise.all([
      localFileIconDataUrl(file.path),
      shouldLoadLocalFileThumbnail(file) ? localFileThumbnailDataUrl(file.path, LOCAL_FILE_THUMBNAIL_TIMEOUT_MS) : Promise.resolve(null),
    ]);
    return {
      ...file,
      ...(iconDataUrl ? { iconDataUrl } : {}),
      ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
    };
  }));
}

function shouldLoadLocalFileThumbnail(file: { entryKind?: string; mimeType?: string; name?: string }): boolean {
  if (file.entryKind === 'directory' || file.mimeType === 'inode/directory') return false;
  const mimeType = (file.mimeType ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  const extension = extname(file.name ?? '').toLowerCase();
  return [
    '.avif',
    '.bmp',
    '.gif',
    '.heic',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.tif',
    '.tiff',
    '.webp',
  ].includes(extension);
}

function localFilePathRank(filePath: string, query: string): number {
  const match = rankTextSearchLabel(basename(filePath), query);
  return match ? match.rank + match.index / 1000 : 10;
}

// Bounded LRU-ish insert: re-touch the key so it stays fresh and evict the
// oldest entries when over the cap, instead of clearing the whole map. Wholesale
// clearing would drop ids that prepare/preview still need for the visible
// results, leaving recently surfaced files unselectable mid-session.
function setBoundedLocalFileCache<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > LOCAL_FILE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cacheLocalFileSearchPath(filePath: string): string {
  const id = createHash('sha256').update(filePath).digest('hex').slice(0, 24);
  setBoundedLocalFileCache(localFileSearchCache, id, filePath);
  return id;
}

async function localFileIconDataUrl(filePath: string): Promise<string | null> {
  const cached = localFileIconCache.get(filePath);
  if (cached !== undefined) return cached;
  let pending = pendingLocalFileIconLoads.get(filePath);
  if (!pending) {
    pending = loadLocalFileIconDataUrl(filePath)
      .finally(() => pendingLocalFileIconLoads.delete(filePath));
    pendingLocalFileIconLoads.set(filePath, pending);
  }
  return promiseWithTimeout(pending, LOCAL_FILE_ICON_TIMEOUT_MS, null);
}

async function loadLocalFileIconDataUrl(filePath: string): Promise<string | null> {
  try {
    const image = await app.getFileIcon(filePath, { size: LOCAL_FILE_ICON_SIZE });
    const iconDataUrl = image.isEmpty() ? null : image.toDataURL();
    setBoundedLocalFileCache(localFileIconCache, filePath, iconDataUrl);
    return iconDataUrl;
  } catch {
    setBoundedLocalFileCache(localFileIconCache, filePath, null);
    return null;
  }
}

async function localFileThumbnailDataUrl(filePath: string, timeoutMs: number): Promise<string | null> {
  const cached = localFileThumbnailCache.get(filePath);
  if (cached !== undefined) return cached;
  let pending = pendingLocalFileThumbnailLoads.get(filePath);
  if (!pending) {
    pending = loadLocalFileThumbnailDataUrl(filePath)
      .finally(() => pendingLocalFileThumbnailLoads.delete(filePath));
    pendingLocalFileThumbnailLoads.set(filePath, pending);
  }
  return promiseWithTimeout(pending, timeoutMs, null);
}

async function loadLocalFileThumbnailDataUrl(filePath: string): Promise<string | null> {
  try {
    const image = await nativeImage.createThumbnailFromPath(filePath, {
      width: LOCAL_FILE_THUMBNAIL_SIZE,
      height: LOCAL_FILE_THUMBNAIL_SIZE,
    });
    const thumbnailDataUrl = image.isEmpty() ? null : image.toDataURL();
    setBoundedLocalFileCache(localFileThumbnailCache, filePath, thumbnailDataUrl);
    return thumbnailDataUrl;
  } catch {
    setBoundedLocalFileCache(localFileThumbnailCache, filePath, null);
    return null;
  }
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

async function localPickedFile(filePath: string) {
  try {
    const fileStat = await stat(filePath);
    const entryKind = fileStat.isDirectory() ? 'directory' : fileStat.isFile() ? 'file' : null;
    if (!entryKind) return null;
    if (entryKind === 'file' && fileStat.size <= 0) return null;
    const mimeType = entryKind === 'directory' ? 'inode/directory' : inferMimeType(filePath);
    const imageDataBase64 = entryKind === 'file' && isInlineImageMimeType(mimeType) && fileStat.size <= MAX_RAW_INLINE_IMAGE_BYTES
      ? (await readFile(filePath)).toString('base64')
      : undefined;
    const [visual] = await withLocalFileIcons([{
      entryKind,
      mimeType,
      name: basename(filePath),
      path: filePath,
    }]);
    return {
      entryKind,
      path: filePath,
      name: basename(filePath),
      mimeType,
      sizeBytes: entryKind === 'directory' ? 0 : fileStat.size,
      lastModified: fileStat.mtimeMs,
      ...(visual?.iconDataUrl ? { iconDataUrl: visual.iconDataUrl } : {}),
      ...(visual?.thumbnailDataUrl ? { thumbnailDataUrl: visual.thumbnailDataUrl } : {}),
      ...(imageDataBase64 ? { imageDataBase64 } : {}),
    };
  } catch {
    return null;
  }
}

function safeAppPath(name: Parameters<typeof app.getPath>[0]): string | null {
  try {
    return app.getPath(name);
  } catch {
    return null;
  }
}

function inferMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.avif') return 'image/avif';
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.heic') return 'image/heic';
  if (extension === '.tif' || extension === '.tiff') return 'image/tiff';
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.doc') return 'application/msword';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === '.ppt') return 'application/vnd.ms-powerpoint';
  if (extension === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (extension === '.key' || extension === '.keynote') return 'application/vnd.apple.keynote';
  if (extension === '.pages') return 'application/vnd.apple.pages';
  if (extension === '.odp') return 'application/vnd.oasis.opendocument.presentation';
  if (extension === '.xls') return 'application/vnd.ms-excel';
  if (extension === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (extension === '.numbers') return 'application/vnd.apple.numbers';
  if (extension === '.json') return 'application/json';
  if (extension === '.xml') return 'application/xml';
  if (extension === '.yaml' || extension === '.yml') return 'application/yaml';
  if (TEXT_ATTACHMENT_EXTENSIONS.has(extension)) return 'text/plain';
  return 'application/octet-stream';
}

function isInlineImageMimeType(mimeType: string): boolean {
  return mimeType === 'image/jpeg'
    || mimeType === 'image/png'
    || mimeType === 'image/gif'
    || mimeType === 'image/webp';
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.c',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.log',
  '.md',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
]);

async function handleAgentCommand(command: AgentCommand, args: Record<string, unknown>) {
  switch (command) {
    case 'agent_restore_latest_session':
      return agentRuntime.restoreLatestSession();
    case 'agent_restore_session':
      return agentRuntime.restoreSession(String(args.sessionId));
    case 'agent_create_session':
      return agentRuntime.createSession();
    case 'agent_list_sessions':
      return agentRuntime.listSessions();
    case 'agent_rename_session':
      return agentRuntime.renameSession(String(args.sessionId), String(args.title ?? ''));
    case 'agent_delete_session':
      return agentRuntime.deleteSession(String(args.sessionId));
    case 'agent_debug_snapshot':
      return agentRuntime.debugSnapshot(String(args.sessionId));
    case 'agent_debug_history':
      return agentRuntime.debugHistory(String(args.sessionId));
    case 'agent_debug_totals':
      return agentRuntime.debugTotals(String(args.sessionId));
    case 'agent_debug_payload':
      return agentRuntime.debugPayload(String(args.sessionId), String(args.payloadId));
    case 'agent_payload_text':
      return agentRuntime.payloadText(String(args.sessionId), String(args.payloadId));
    case 'agent_subagent_status':
      return agentRuntime.subagentStatus(String(args.sessionId), String(args.agentId), {
        wait: args.wait === true,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });
    case 'agent_subagent_send':
      return agentRuntime.subagentSend(String(args.sessionId), String(args.agentId), String(args.message ?? ''));
    case 'agent_subagent_stop':
      return agentRuntime.subagentStop(String(args.sessionId), String(args.agentId));
    case 'agent_send_message':
      return agentRuntime.sendMessage(
        String(args.sessionId),
        String(args.message ?? ''),
        args.attachments,
        args.userViewContext,
      );
    case 'agent_edit_message':
      return agentRuntime.editMessage(
        String(args.sessionId),
        String(args.nodeId),
        String(args.message ?? ''),
      );
    case 'agent_regenerate_message':
      return agentRuntime.regenerateMessage(String(args.sessionId), String(args.nodeId));
    case 'agent_retry_message':
      return agentRuntime.retryMessage(String(args.sessionId), String(args.nodeId));
    case 'agent_switch_branch':
      return agentRuntime.switchBranch(String(args.sessionId), String(args.nodeId));
    case 'agent_queue_follow_up':
      return agentRuntime.queueFollowUp(
        String(args.sessionId),
        String(args.message ?? ''),
        args.userViewContext,
      );
    case 'agent_clear_follow_up':
      return agentRuntime.clearFollowUp(String(args.sessionId));
    case 'agent_steer_session':
      return agentRuntime.steerSession(
        String(args.sessionId),
        String(args.message ?? ''),
      );
    case 'agent_clear_steer':
      return agentRuntime.clearSteer(String(args.sessionId));
    case 'agent_resolve_approval':
      return agentRuntime.resolveApproval(
        String(args.sessionId),
        String(args.requestId),
        args.approved === true,
        args.scope === 'always' ? 'always' : args.scope === 'session' ? 'session' : 'once',
      );
    case 'agent_stop_session':
      return agentRuntime.stopSession(String(args.sessionId));
    case 'agent_reset_session':
      return agentRuntime.resetSession(String(args.sessionId));
    case 'agent_close_session':
      return agentRuntime.closeSession(String(args.sessionId));
    case 'agent_list_slash_commands':
      return agentRuntime.listSlashCommands(String(args.sessionId));
    case 'agent_get_provider_settings':
      return getProviderSettings();
    case 'agent_update_runtime_settings':
      return updateAgentRuntimeSettings(args.settings as AgentRuntimeSettingsInput);
    case 'agent_get_tool_permission_settings':
      return readAgentToolPermissionSettingsView();
    case 'agent_update_tool_permission_settings':
      return writeAgentToolPermissionSettingsView(args.settings as { permissions?: { allow?: unknown; ask?: unknown; deny?: unknown } });
    case 'agent_upsert_provider_config':
      return upsertProviderConfig(args.provider as AgentProviderConfigInput);
    case 'agent_delete_provider_config':
      return deleteProviderConfig(String(args.providerId));
    case 'agent_set_active_provider':
      return setActiveProvider(String(args.providerId));
    case 'agent_set_provider_api_key':
      return setProviderApiKey(String(args.providerId), String(args.apiKey ?? ''));
    case 'agent_delete_provider_api_key':
      return deleteProviderApiKey(String(args.providerId));
    case 'agent_get_provider_secret_status':
      return getProviderSecretStatus(String(args.providerId));
    case 'agent_oauth_login': {
      // Route events to the window that initiated this sign-in, so a re-target to
      // another provider can't deliver them to the wrong window (where they'd be
      // dropped, leaving the interactive step unanswerable and login() hung).
      const loginWindow = providerConfigWindow;
      return oauthLoginManager.startLogin(String(args.providerId), (envelope) => {
        if (loginWindow && !loginWindow.isDestroyed()) {
          loginWindow.webContents.send(LIN_AGENT_OAUTH_EVENT_CHANNEL, envelope);
        }
      });
    }
    case 'agent_oauth_logout':
      return oauthLoginManager.logout(String(args.providerId));
    case 'agent_oauth_respond':
      oauthLoginManager.respond(String(args.requestId), args.value === undefined ? undefined : String(args.value));
      return undefined;
    case 'agent_oauth_cancel':
      oauthLoginManager.cancel(String(args.providerId));
      return undefined;
    case 'agent_list_all_definitions':
      return agentRuntime.listAllAgentDefinitions(String(args.sessionId));
    case 'agent_test_provider_connection':
      return testProviderConnection({
        providerId: String(args.providerId),
        modelId: String(args.modelId),
        baseUrl: args.baseUrl ? String(args.baseUrl) : undefined,
        apiKey: args.apiKey ? String(args.apiKey) : undefined,
      });
    case 'agent_list_all_skills':
      return agentRuntime.listAllSkills(String(args.sessionId));
    default:
      throw new Error(`Unknown agent command: ${command}`);
  }
}

// Single-instance: a second launch focuses the running window instead of
// spawning a duplicate process (macOS enforces this for packaged apps, Windows
// does not). If we don't hold the lock, another instance owns the session — let
// it surface its window and exit immediately.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);

  // Dev only: electron-vite spawns this GUI process as a child of the dev server
  // (`spawn(electron, …, { stdio: 'inherit' })`) and only binds child→parent exit
  // (`ps.on('close', process.exit)`), never parent→child. So on Ctrl+C the dev
  // server dies but this app lingers, its renderer spamming ERR_CONNECTION_REFUSED
  // against the now-dead Vite server until a manual ⌘Q.
  //
  // We do NOT rely on receiving the signal: on macOS Chromium's browser process
  // owns SIGINT/SIGTERM handling, so a `process.on('SIGINT')` here fires
  // unreliably (it didn't). Instead detect the dev server's death directly —
  // record its pid at startup and poll `process.kill(pid, 0)` (a 0-signal
  // existence probe, sends nothing); once it throws ESRCH the parent is gone, so
  // we quit too. This is independent of signal delivery. Packaged builds are never
  // launched this way, so it is gated to dev. The signal handlers stay as a
  // best-effort fast path for the cases where a signal *does* arrive.
  if (!app.isPackaged) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => app.quit());
    }
    const devServerPid = process.ppid;
    const watchDevServer = setInterval(() => {
      try {
        process.kill(devServerPid, 0);
      } catch {
        clearInterval(watchDevServer);
        app.quit();
      }
    }, 1000);
    // Don't let the watchdog timer itself keep the event loop (and the app) alive.
    watchDevServer.unref();
  }

  app.whenReady().then(() => {
    const icon = nativeImage.createFromPath(APP_ICON_PNG_PATH);
    if (process.platform === 'darwin' && !icon.isEmpty()) app.dock?.setIcon(icon);
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: '© 2026 Lin Lab',
      ...(icon.isEmpty() ? {} : { iconPath: APP_ICON_PNG_PATH }),
    });
    protocol.handle(ASSET_URL_SCHEME, (request) => {
      const id = new URL(request.url).hostname;
      return assetService.serve(id);
    });
    // Apply the persisted appearance preference before any window is created, so
    // the first paint (prePaintBackgroundColor → shouldUseDarkColors) already
    // matches the chosen theme rather than the OS default.
    nativeTheme.themeSource = loadAppPreferences().theme;
    // One-time, best-effort cleanup of any keyless junk provider row left on disk
    // (the old save-side-effect bug); skips itself when secrets are unreadable so a
    // transient secret-file read failure never turns into row loss. Fire-and-forget — boot never waits
    // on or fails from it. See `reconcileProviderConfig`.
    void reconcileProviderConfig().catch(() => { /* best-effort; cleaned next launch */ });
    configureSessionSecurity();
    registerIpc();
    createWindow();
    // Prewarm the hidden launcher window and bind the global toggle hotkey.
    createLauncherWindow({
      preloadPath: join(__dirname, '../preload/index.cjs'),
      devUrl: RENDERER_DEV_ORIGIN ? `${RENDERER_DEV_ORIGIN}/launcher.html` : null,
      packagedHtmlPath: join(__dirname, '../renderer/launcher.html'),
      harden: hardenWebContents,
      onBlurHide: dismissLauncher,
    });
    // Tenon is a regular foreground app (dock icon + menu bar). Creating the
    // launcher as a non-activating NSPanel, plus launching the dev binary straight
    // from the terminal (not via LaunchServices), can leave the app in macOS
    // "accessory" activation policy (background-only → no dock icon). Re-assert the
    // regular policy after the launcher exists so the dock icon is always present;
    // this does NOT affect the launcher panel's per-window non-activating behavior.
    if (process.platform === 'darwin') void app.dock?.show();
    const hotkey = registerLauncherHotkey(() => void toggleLauncher());
    launcherHotkeyAccelerator = hotkey.accelerator;
    if (hotkey.accelerator) console.log(`[launcher] global hotkey: ${hotkey.accelerator}`);
    else console.warn(`[launcher] no global hotkey registered; tried: ${hotkey.attempted.join(', ')}`);
    Menu.setApplicationMenu(buildApplicationMenu());
    // The prewarmed launcher window is always present (hidden), so check for the
    // main window specifically rather than "no windows at all".
    app.on('activate', () => {
      if (!mainWindow) createWindow();
    });
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Release the global hotkey(s) on quit so we never leave a dangling binding.
  app.on('will-quit', () => unregisterLauncherHotkeys());

  app.on('before-quit', (event) => {
    if (quitAfterFlush) return;
    event.preventDefault();
    quitAfterFlush = true;
    void documentService.flushPendingChanges()
      .catch((error) => console.error(error))
      .finally(() => app.quit());
  });
}
