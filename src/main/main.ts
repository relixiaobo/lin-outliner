import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, protocol, session, shell } from 'electron';
import type { IpcMainInvokeEvent, NativeImage } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { DocumentService } from './documentService';
import { AssetService, mimeTypeForFilename, sniffMimeType } from './assetService';
import { ThreadService } from './agent/ThreadService';
import { closeAgentServices } from './agent/closeAgentServices';
import { ExtensionRegistry } from './agent/ExtensionRegistry';
import { MemoryControlStore } from './agent/extensions/memory/MemoryControlStore';
import { MemoryExtension } from './agent/extensions/memory/MemoryExtension';
import { TimelineMemoryStore } from './agent/extensions/memory/TimelineMemoryStore';
import { AutomationDispatcher } from './agent/automations/AutomationDispatcher';
import { AutomationScheduler } from './agent/automations/AutomationScheduler';
import { AutomationService } from './agent/automations/AutomationService';
import { AutomationStore } from './agent/automations/AutomationStore';
import { createAutomationTool } from './agent/automations/AutomationTool';
import { AutomationWorktree } from './agent/automations/AutomationWorktree';
import { AgentConfigurationLoader } from './agent/AgentConfigurationLoader';
import { PiTurnExecutor } from './agent/runtime/PiTurnExecutor';
import { ToolRuntime } from './agent/runtime/ToolRuntime';
import { observedSkillFilePaths } from './agent/context/SkillContextReducer';
import { AttachmentResolver } from './agent/tools/attachments';
import { createImageArtifactReference, ImageObservationNormalizationError } from './agent/imageArtifacts';
import { Mutex } from './agent/Mutex';
import { AgentSkillRuntime, expandSkillDirectory, resolveUserSkillInvocation } from './agent/capabilities/agentSkills';
import { isValidSkillName } from './agent/capabilities/agentSkillAuthoring';
import { createAgentSkillProvenanceStore } from './agent/capabilities/agentSkillProvenanceStore';
import { executeAgentSkillShellCommand } from './agent/capabilities/agentSkillShell';
import {
  decodeMemoryFeatureMode,
  decodeThreadMemoryMode,
  memoryTagId,
} from '../core/agent/memory';
import { decodeThreadResourceReference } from '../core/agent/codec';
import {
  AUTOMATION_NOTIFICATION_CHANNEL,
  AUTOMATION_REQUEST_CHANNEL,
  AUTOMATION_METHODS,
  type AutomationMethod,
} from '../core/agent/automation';
import {
  createAgentLocalWorkspaceContext,
  resolveAgentLocalReadPath,
  type AgentLocalWorkspaceContext,
} from './agent/capabilities/agentLocalTools';
import type { AgentImageGenerationRuntime } from './agent/capabilities/agentImageGenerationTool';
import {
  piFindImageModel,
  piGenerateImages,
  piImageModelsForProvider,
  validateImageGenerationOptions,
} from './piImageModels';
import type {
  AgentCoreMethod,
  AgentCoreRequestByMethod,
  ThreadAttachmentContent,
  ThreadUserContent,
  ThreadMessageContextMenuAction,
  ThreadMessageContextMenuRequest,
} from '../core/agent/protocol';
import {
  REASONING_EFFORTS,
  type EffectiveThreadConfiguration,
  type ReasoningEffort,
} from '../core/agent/configuration';
import {
  AGENT_CORE_NOTIFICATION_CHANNEL,
  AGENT_CORE_REQUEST_CHANNEL,
  THREAD_MESSAGE_CONTEXT_MENU_CHANNEL,
} from '../core/agent/transport';
import {
  ManagedSkillService,
  ManagedSkillServiceError,
  managedSkillErrorView,
} from './managedSkillService';
import { ManagedSkillStore } from './managedSkillStore';
import { DEFAULT_MANAGED_SKILLS } from './managedSkillDefaults';
import { BROWSER_PILOT_MANAGED_SKILL_ID, BrowserPilotHost } from './browserPilotHost';
import { ManagedSkillShellEnvironmentRegistry } from './managedSkillShellEnvironment';
import { AgentImportService } from './agent/capabilities/agentImportService';
import { AgentImportApiServer } from './agent/capabilities/agentImportApi';
import { configureTenonImportRuntime } from './tenonImportRuntime';
import { isRendererPermissionAllowed } from './rendererPermissions';
import {
  clearUrlPreviewSessionData,
  configureUrlPreviewSession,
  createUrlPreviewWindowOpenHandler,
  flushUrlPreviewSession,
} from './urlPreviewSession';
import { MAC_TRAFFIC_LIGHT_POSITION, MAC_WINDOW_CORNER_RADIUS } from '../core/chromeGeometry';
import { windowMaterialKind } from '../core/windowMaterial';
import { applyMacWindowCorner } from './nativeWindowCorner';
import {
  LIN_SETTINGS_CHANGED_CHANNEL,
  LIN_SETTINGS_NAVIGATE_CHANNEL,
  SETTINGS_ANCHOR_PARAM,
  SETTINGS_CATEGORY_PARAM,
  PROVIDER_CONFIG_MODE_PARAM,
  PROVIDER_CONFIG_PROVIDER_PARAM,
  WINDOW_SURFACE_QUERY_PARAM,
  isSettingsAnchorTarget,
  isSettingsCategoryTarget,
  isSettingsPageTarget,
  settingsTargetPath,
  type ProviderConfigMode,
  type SettingsOpenTarget,
} from '../core/settingsWindow';
import { LIN_WINDOW_ACTIVE_CHANNEL } from '../core/windowActivity';
import { ASSET_URL_SCHEME, PREVIEW_LOCAL_URL_SCHEME, previewLocalUrl } from '../core/assets';
import { normalizePreviewHttpUrl } from '../core/preview';
import { officeOwnershipFileInfo } from '../core/officeFiles';
import {
  isUrlPageTranslationCommand,
  isUrlPageTranslationPreferences,
  LIN_CLEAR_PREVIEW_TRANSLATION_CACHE_CHANNEL,
  LIN_URL_PAGE_TRANSLATION_PREFERENCES_CHANGED_CHANNEL,
  LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL,
  type ClearPreviewTranslationCacheResult,
  type UrlPageTranslationPreferences,
} from '../core/urlPageTranslation';
import { LIN_URL_PAGE_TRANSLATION_GUEST_CHANNEL } from '../core/urlPageTranslationGuest';
import {
  LIN_CLEAR_URL_PREVIEW_DATA_CHANNEL,
  URL_PREVIEW_WEBVIEW_PARTITION,
  type ClearUrlPreviewDataResult,
} from '../core/urlPreviewSession';
import { handlePreviewCommand } from './previewSource';
import { ingestThreadResourceAsset } from './threadResourceAssetIngest';
import { PageTranslationService, pageTranslationErrorReport } from './pageTranslation';
import { PreviewTranslationCacheStore } from './previewTranslationCacheStore';
import { clearPreviewTranslationCacheFromSettings } from './previewTranslationCacheClear';
import { executeUrlPageTranslationGuestCommand } from './urlPageTranslationGuest';
import { setBoundedMapEntry } from './boundedMap';
import { LocalFilePreviewStreamRegistry } from './localFilePreviewStream';
import {
  LIN_AGENT_OAUTH_EVENT_CHANNEL,
  LIN_DOCUMENT_EVENT_CHANNEL,
  DAILY_NOTES_ID,
  TRASH_ID,
  type AssetIngestInput,
  type CommandResult,
  type NodeProjection,
  type ProjectionUpdate,
} from '../core/types';
import {
  serializeUnknownError,
  LIN_APP_INFO_CHANNEL,
  LIN_EXPORT_DIAGNOSTICS_CHANNEL,
  LIN_REPORT_RENDERER_ERROR_CHANNEL,
  LIN_REVEAL_DIAGNOSTICS_LOG_CHANNEL,
  type DiagnosticEnvironment,
  type DiagnosticsActionResult,
  type ErrorReport,
  type ErrorReportContext,
  type ErrorSeverity,
} from '../core/errorObservability';
import {
  deleteProviderApiKey,
  deleteProviderConfig,
  getActiveProviderRuntimeConfig,
  getProviderRuntimeConfig,
  getAgentRuntimeSettings,
  getProviderSecretStatus,
  getStoredProviderApiKey,
  getProviderSettings,
  reconcileProviderConfig,
  refreshProviderModels,
  setActiveProvider,
  setProviderApiKey,
  updateImageGenerationSettings,
  updateAgentRuntimeSettings,
  upsertProviderConfig,
  prepareProviderConnectionProbe,
  recordProviderConnectionCheck,
  testProviderConnection,
} from './agent/capabilities/agentSettings';
import { validateAgentModelSelection } from './agent/capabilities/agentModelResolution';
import {
  applyAgentCapabilitySettingsPatchView,
  appendAgentCapabilityBlockView,
  readAgentCapabilitySettingsView,
} from './agent/capabilities/agentCapabilityStore';
import {
  isAgentCommand,
  isAssetCommand,
  isDocumentCommand,
  isPreviewCommand,
  type AgentCommand,
  type AssetCommand,
  type DocumentCommand,
  type PreviewCommand,
} from '../core/commands';
import { oauthLoginManager } from './agent/capabilities/agentOAuthManager';
import { IPC_TRACE_ENABLED, traceIpc } from './ipcTrace';
import { resolveRipgrepCommand } from './agent/capabilities/agentRipgrep';
import { buildAgentLocalToolProcessEnv } from './agent/capabilities/agentToolProcess';
import type {
  AgentImageGenerationSettingsInput,
  AgentProviderConfigInput,
  AgentRuntimeSettingsInput,
  AgentRuntimeSettings,
  AgentProviderSettingsView,
  ManagedSkillCommandResult,
} from '../core/types';
import { loadWindowState, trackWindowState } from './windowState';
import {
  loadAppPreferences,
  saveLanguagePreference,
  saveThemePreference,
  saveTranslationLanguagePreference,
  saveUrlPageTranslationPreferences,
} from './appPreferences';
import { isThemeMode, type ThemeMode } from '../core/theme';
import { isLocale, LIN_LANGUAGE_CHANGED_CHANNEL, resolveSystemLocale, type Locale } from '../core/locale';
import {
  isTranslationLanguage,
  LIN_TRANSLATION_LANGUAGE_CHANGED_CHANNEL,
  type TranslationLanguage,
} from '../core/translationLanguage';
import { getMessages } from '../core/i18n';
import { APP_NAME } from '../core/brand';
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  MAX_IMAGE_ATTACHMENT_SOURCE_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_DIMENSION,
} from '../core/agentAttachmentLimits';
import { safeAttachmentFileName } from '../core/agentAttachmentPaths';
import {
  isPathInside,
  pruneAgentScratch,
} from './agent/capabilities/agentAttachmentMaterialization';
import {
  isSafeLocalFileOpenTarget,
  resolveTrustedLocalFileReference,
  type TrustedLocalFileReference,
} from './localFileReferenceSecurity';
import {
  createLauncherWindow,
  getLauncherWindow,
  hideLauncherWindow,
  showLauncherWindow,
} from './launcher/launcherWindow';
import { registerLauncherHotkey, unregisterLauncherHotkeys } from './launcher/launcherHotkey';
import { ActionInvocationService, type RendererStepAck } from './actionInvocationService';
import {
  APP_RENDERER_CAPABILITIES,
  LAUNCHER_RENDERER_CAPABILITIES,
  registerRendererCapabilities,
  rendererHasCapability,
} from './rendererCapabilities';
import type { EffectStep } from '../core/actions/bindings';
import {
  ACTION_EVENT_CHANNEL,
  ACTION_OBJECT_QUERY_CHANNEL,
  ACTION_OPEN_CHANNEL,
  ACTION_OPENED_CHANNEL,
  ACTION_PARAMETER_QUERY_CHANNEL,
  ACTION_REQUEST_CHANNEL,
  ACTION_STEP_ACK_CHANNEL,
  ACTION_STEP_ACK_TIMEOUT_MS,
  ACTION_STEP_CHANNEL,
  type ActionStepAck,
} from '../core/actions/transport';
import type {
  ActionRequest,
  InvocationEvent,
  InvocationSeed,
  ObjectQueryRequest,
  ParameterObjectQueryRequest,
} from '../core/actions/types';
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
import {
  hasExplicitAgentLocalRoot,
  resolveAgentScratchRoot,
  resolveAgentWorkdir,
} from './agent/capabilities/agentLocalRoot';
import { DiagnosticLogStore } from './diagnosticLog';
import { NodeAccessStore } from './nodeAccessStore';
import { resolveUserDataDir } from './userDataPath';
import type { NodeAccessSource } from '../core/nodeAccessRanking';

// App identity for menus / "About" / notifications. Kept deliberately separate
// from the userData directory, which we resolve EXPLICITLY below instead of
// letting Electron derive it from `app.getName()`.
app.setName(APP_NAME);

// Resolve userData explicitly (see userDataPath.ts) so the packaged data
// directory is pinned to `<appData>/Tenon` and can never drift with how the asar
// package.json is generated. `home`/`appData` are app-name-independent, so reading
// them here is safe regardless of setName ordering.
const resolvedUserDataDir = resolveUserDataDir({
  envOverride: process.env.ELECTRON_USER_DATA_DIR,
  isPackaged: app.isPackaged,
  home: app.getPath('home'),
  appData: app.getPath('appData'),
  appName: APP_NAME,
});
app.setPath('userData', resolvedUserDataDir);
// Cheap safety net: record the resolved directory at boot so a future "lost data"
// report can be diagnosed from the log instead of reverse-engineering it via lsof.
console.log(`[startup] userData directory: ${resolvedUserDataDir}`);

const diagnosticLog = new DiagnosticLogStore(app.getPath('userData'));

function reportError(report: ErrorReport): void {
  void diagnosticLog.reportError(report).catch((error) => {
    console.error('[diagnostics] failed to write diagnostic error', error);
  });
}

function installMainErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    const serialized = serializeUnknownError(reason);
    reportError({
      domain: 'uncaught',
      severity: 'fatal',
      code: 'unhandled-rejection',
      message: serialized.message ?? 'Unhandled promise rejection',
      context: { operation: 'unhandledRejection' },
      error: reason,
    });
  });

  process.on('uncaughtException', (error) => {
    console.error(error);
    void Promise.race([
      diagnosticLog
        .reportError({
          domain: 'uncaught',
          severity: 'fatal',
          code: 'uncaught-exception',
          message: error.message || 'Uncaught exception',
          context: { operation: 'uncaughtException' },
          error,
        })
        .then(() =>
          diagnosticLog.flushNow({ reason: 'fatal', timeoutMs: 750 }).catch(() => undefined),
        ),
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]).finally(() => app.exit(1));
  });
}

installMainErrorHandlers();

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

// Must run before the app `ready` event so the renderer can load internal
// preview streams with regular <img>/<video> tags.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_URL_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  // Only opaque, main-issued UUID tokens use this CORS-enabled scheme. It is
  // registered on the default app session, not the remote URL-preview partition.
  {
    scheme: PREVIEW_LOCAL_URL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// Image file extensions for the native "insert image" picker. The filter's display
// name is localized at the call site (it shows in the OS dialog).
const IMAGE_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'];

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const APP_ICON_PNG_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../build/icon.png');
const documentService = new DocumentService();
const extensionRegistry = new ExtensionRegistry();
const memoryControlStore = new MemoryControlStore(join(app.getPath('userData'), 'agent', 'memories.sqlite'));
const timelineMemoryStore = new TimelineMemoryStore(documentService);
const memoryExtension = new MemoryExtension(memoryControlStore, timelineMemoryStore);
const importService = new AgentImportService(documentService, { toolName: 'tenon-import' });
const importApiServer = new AgentImportApiServer(importService, { userDataDir: app.getPath('userData') });
configureTenonImportRuntime({
  isPackaged: app.isPackaged,
  moduleDir: __dirname,
  resourcesPath: process.resourcesPath,
  processExecPath: process.execPath,
  descriptorPath: importApiServer.descriptorPath,
});
const nodeAccessStore = new NodeAccessStore(join(app.getPath('userData'), 'node-access-stats.json'), {
  onError: (error, operation) => reportError({
    domain: 'node-access',
    severity: 'warn',
    code: `node-access-${operation}`,
    message: `Node access store ${operation} failed`,
    context: { operation },
    error,
  }),
});
const assetRoot = () => join(app.getPath('userData'), 'assets');
const assetService = new AssetService(assetRoot);
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let providerConfigWindow: BrowserWindow | null = null;
let urlPreviewSession: Electron.Session | null = null;
const urlPreviewGuests = new Set<Electron.WebContents>();
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
const agentLocalFileRoot = resolveAgentWorkdir({
  envLocalRoot: process.env.LIN_AGENT_LOCAL_ROOT,
  userDataPath: app.getPath('userData'),
});
const agentScratchRoot = resolveAgentScratchRoot({ userDataPath: app.getPath('userData') });
// The default workdir is app-owned (`<userData>/agent-workdir`), so create it; an explicit
// `LIN_AGENT_LOCAL_ROOT` is the user's own directory and must already exist. Scratch is always
// app-owned, so always create it. Both are best-effort: the agent tools mkdir lazily before each
// write, so a startup failure (e.g. an unwritable userData) degrades the agent workdir rather
// than aborting the whole app at module load.
function ensureAgentDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error(`[agent] failed to create directory ${dir} at startup`, error);
  }
}
if (!hasExplicitAgentLocalRoot(process.env.LIN_AGENT_LOCAL_ROOT)) {
  ensureAgentDir(agentLocalFileRoot);
}
ensureAgentDir(agentScratchRoot);
const browserPilotHost = new BrowserPilotHost({
  userDataRoot: resolvedUserDataDir,
  scratchRoot: agentScratchRoot,
});
const managedSkillStore = new ManagedSkillStore(resolvedUserDataDir);
let managedSkillShellEnvironment: ManagedSkillShellEnvironmentRegistry | null = null;
let skillRuntime!: AgentSkillRuntime;
const turnSkillRuntimes = new Map<string, AgentSkillRuntime>();
const turnSkillRuntimeInitializations = new Map<string, Promise<AgentSkillRuntime>>();
const managedSkillService: ManagedSkillService = new ManagedSkillService({
  appVersion: app.getVersion(),
  store: managedSkillStore,
  onChanged: async (): Promise<void> => {
    managedSkillShellEnvironment?.invalidate();
    await Promise.all(
      [skillRuntime, ...turnSkillRuntimes.values()].map((runtime) => runtime.notifySkillContentWritten([])),
    );
  },
  findNameConflict: async (name, excludingManagedSkillId) => {
    const normalized = name.trim();
    if (!normalized) return null;
    const skills = await skillRuntime.listAllSkills();
    const conflict = skills.find((skill) => (
      skill.name === normalized
      && !(skill.source === 'managed' && skill.name === excludingManagedSkillId)
    ));
    return conflict ? { source: conflict.source, location: conflict.skillFile } : null;
  },
});
managedSkillShellEnvironment = new ManagedSkillShellEnvironmentRegistry({
  activeSkillIds: async () => new Set(
    (await managedSkillService.activeRuntimeRoots()).map((root) => root.id),
  ),
  contributors: [{
    skillId: BROWSER_PILOT_MANAGED_SKILL_ID,
    processEnvironment: (threadId, turnId) => browserPilotHost.processEnvironment(threadId, turnId),
  }],
});
// An available Skill update should be visible without going looking for it, but
// nothing about that is urgent enough to spend the launch path on. So: one
// throttled sweep per launch, deferred until after first paint, fire-and-forget.
// No periodic polling while the app sits open, no auto-download, no auto-apply.
const MANAGED_SKILL_UPDATE_THROTTLE_MS = 6 * 60 * 60 * 1_000;
const MANAGED_SKILL_UPDATE_STARTUP_DELAY_MS = 30_000;

function scheduleManagedSkillUpdateCheck(): void {
  const timer = setTimeout(() => {
    // Failure records an update_failed diagnostic on the record and does nothing
    // else (A12): no alert, nothing blocked, no Skill's enabled state or pinned
    // version touched. The throttle stamps lastCheckedAt on failure too, so a
    // record that keeps failing is retried on the same schedule as one that
    // succeeds rather than on every launch.
    void managedSkillService
      .checkUpdates(undefined, { throttleMs: MANAGED_SKILL_UPDATE_THROTTLE_MS })
      .catch(() => { /* recorded on the record; retried next launch */ });
  }, MANAGED_SKILL_UPDATE_STARTUP_DELAY_MS);
  // Never hold the event loop open on this.
  timer.unref?.();
}

// Scratch holds only ephemeral, app-owned data (attachment observations, web-fetch binaries, bash
// overflow logs, and PDF page images). Reclaim anything past the TTL once per launch; failures
// are swallowed so cleanup never blocks startup.
void pruneAgentScratch(agentScratchRoot).catch((error) => {
  console.error('[agent] failed to prune scratch root at startup', error);
});
skillRuntime = new AgentSkillRuntime({
  localRoot: agentLocalFileRoot,
  provenanceStore: createAgentSkillProvenanceStore(),
  managedSkillRoots: () => managedSkillService.activeRuntimeRoots(),
  managedSkillContentRoot: managedSkillService.contentRoot,
  assertManagedSkillInvocable: (skillId, expectedContentHash) => (
    managedSkillService.assertInvocable(skillId, expectedContentHash)
  ),
  executeSkillShell: ({ command, signal }) => executeAgentSkillShellCommand({
    command,
    localRoot: agentLocalFileRoot,
    scratchRoot: agentScratchRoot,
    signal,
  }),
});
const managedSkillBootstrap = managedSkillService.bootstrapDefaults(DEFAULT_MANAGED_SKILLS, {
  findNameConflict: findUnmanagedSkillNameConflict,
});
void managedSkillBootstrap.then((results) => {
  for (const result of results) {
    if (result.status === 'failed') {
      console.warn(`[managed-skills] default acquisition failed for ${result.id}: ${result.error?.code ?? 'unexpected_error'}`);
    }
  }
});
void getAgentRuntimeSettings().then((settings) => {
  for (const runtime of [skillRuntime, ...turnSkillRuntimes.values()]) {
    runtime.updateAdditionalSkillDirectories(settings.additionalSkillDirectories);
    runtime.updateDisabledSkills(settings.disabledSkills ?? []);
  }
}).catch((error) => console.error('[agent] failed to load skill settings', error));

async function findUnmanagedSkillNameConflict(name: string) {
  const normalized = name.trim();
  if (!normalized) return null;
  const settings = await getAgentRuntimeSettings();
  const runtime = new AgentSkillRuntime({
    localRoot: agentLocalFileRoot,
    additionalSkillDirectories: settings.additionalSkillDirectories,
  });
  const conflict = (await runtime.listAllSkills()).find((skill) => skill.name === normalized);
  return conflict ? { source: conflict.source, location: conflict.skillFile } : null;
}
let toolRuntime!: ToolRuntime;
const agentConfigurationLoader = new AgentConfigurationLoader(resolvedUserDataDir);
let threadService!: ThreadService;
const agentImageObservationMutex = new Mutex();
const attachmentResolver = new AttachmentResolver({
  useResourcePath: (threadId, ref, use) => threadService.useThreadResourcePath(threadId, ref, use),
  prepareImageArtifact: async ({ threadId, attachment, sourcePath }) => {
    const snapshot = await prepareAttachmentPromptImage(attachment, sourcePath);
    const written = await threadService.writeThreadResourceWithStatus(
      threadId,
      snapshot.bytes,
      snapshot.mimeType,
      snapshot.fileName,
    );
    return {
      artifactRef: createImageArtifactReference({
        retention: attachment.source.kind === 'localFile' ? 'external' : 'durable',
        original: attachment.source,
        observation: written.ref,
        sourceDimensions: snapshot.sourceDimensions,
        observationDimensions: snapshot.dimensions,
      }),
      createdResources: written.created ? [written.ref] : [],
    };
  },
});
const turnExecutor = new PiTurnExecutor({
  createTools: (context) => toolRuntime.createTools(context),
  beforeProviderContext: (context) => toolRuntime.prepareProviderContext(context),
});
threadService = ThreadService.open(
  resolvedUserDataDir,
  turnExecutor,
  {
    attachmentScratchRoot: agentScratchRoot,
    nameGenerator: turnExecutor,
    resolveConfiguration: (request) => agentConfigurationLoader.resolveProfile(
      request.configurationProfile,
      request.cwd,
    ),
    resolveRole: (name, cwd) => agentConfigurationLoader.resolveRole(name, cwd),
    resolveRoleCatalog: (cwd) => agentConfigurationLoader.buildRoleCatalogSnapshot(cwd),
    resolveSubagentTokenBudget: async () => (await getAgentRuntimeSettings()).subagentTokenBudget,
    resolveRendererStartDefaults: async () => {
      const provider = await getActiveProviderRuntimeConfig();
      if (!provider) throw new Error('Configure an AI provider before starting a Thread.');
      return { modelProvider: provider.providerId, cwd: agentLocalFileRoot };
    },
    validateRendererConfiguration: async (selection) => {
      const provider = await getProviderRuntimeConfig(selection.modelProvider);
      if (!provider) throw new Error(`Provider is not configured: ${selection.modelProvider}`);
      validateAgentModelSelection(selection.model, selection.reasoningEffort, provider);
    },
    resolveUserContent: (content, context) => attachmentResolver.resolve(content, context),
    normalizeOutputImage: async ({ bytes, mimeType, signal }) => {
      try {
        const prepared = await prepareBoundedAgentImageBytes(
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          mimeType,
          'tool output image',
          signal,
        );
        return {
          bytes: prepared.bytes,
          mimeType: prepared.mimeType,
          sourceDimensions: prepared.sourceDimensions,
          observationDimensions: prepared.dimensions,
        };
      } catch (error) {
        if (signal?.aborted || error instanceof ImageObservationNormalizationError) throw error;
        throw new ImageObservationNormalizationError(
          `Tool output image could not be normalized: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    getDocumentProjection: () => documentService.getProjection(),
    resolveReferencedAsset: async (assetId) => {
      const [path, metadata] = await Promise.all([
        assetService.pathFor(assetId),
        assetService.lookup(assetId),
      ]);
      return path ? { path, metadata } : null;
    },
    resolveSkillAdmission: async ({
      thread,
      turnId,
      configuration,
      content,
      acceptedAt,
      observedFilePaths,
    }) => {
      if (!configuration.tools.includes('skill')) {
        return { catalogSnapshot: null, invocation: null };
      }
      const runtime = new AgentSkillRuntime({
        localRoot: agentLocalFileRoot,
        threadId: thread.id,
        enabledSkills: configuration.skills,
        provenanceStore: createAgentSkillProvenanceStore(),
        managedSkillRoots: () => managedSkillService.activeRuntimeRoots(),
        managedSkillContentRoot: managedSkillService.contentRoot,
        assertManagedSkillInvocable: (skillId, expectedContentHash) => (
          managedSkillService.assertInvocable(skillId, expectedContentHash)
        ),
        executeSkillShell: ({ command, signal }) => executeAgentSkillShellCommand({
          command,
          localRoot: agentLocalFileRoot,
          scratchRoot: agentScratchRoot,
          signal,
          processEnvironment: () => managedSkillShellEnvironment!.processEnvironment(thread.id, turnId),
        }),
      });
      const settings = await getAgentRuntimeSettings();
      runtime.updateAdditionalSkillDirectories(settings.additionalSkillDirectories);
      runtime.updateDisabledSkills(settings.disabledSkills ?? []);
      await runtime.notifyFileTouched([...observedFilePaths]);
      const directInput = directSkillAdmissionInput(content);
      const invocation = directInput
        ? await resolveUserSkillInvocation(runtime, directInput, { invokedAt: acceptedAt })
        : null;
      return {
        catalogSnapshot: await runtime.buildSkillCatalogSnapshot(),
        invocation: invocation?.ok ? invocation.evidence : null,
      };
    },
    extensions: extensionRegistry,
    beforeInitialTurnAdmission: () => memoryExtension.prepareForTurnAdmission(),
  },
);
memoryExtension.bindHost(threadService);
extensionRegistry.register(memoryExtension);
documentService.setMutationGuard((command, args, meta, projection) => {
  return { affectsMemory: memoryExtension.authorizeMutation(command, args, meta, projection) };
});
documentService.setMutationCoordinator((meta, operation) => (
  meta.origin === 'system' && meta.operationId?.startsWith('memory:')
    ? operation()
    : timelineMemoryStore.withWriteGate(operation)
));
function skillRuntimeForTurn(context: Parameters<ToolRuntime['createTools']>[0]): AgentSkillRuntime {
  const existing = turnSkillRuntimes.get(context.turn.id);
  if (existing) return existing;
  const runtime = new AgentSkillRuntime({
    localRoot: agentLocalFileRoot,
    threadId: context.thread.id,
    enabledSkills: context.configuration.skills,
    provenanceStore: createAgentSkillProvenanceStore(),
    managedSkillRoots: () => managedSkillService.activeRuntimeRoots(),
    managedSkillContentRoot: managedSkillService.contentRoot,
    assertManagedSkillInvocable: (skillId, expectedContentHash) => (
      managedSkillService.assertInvocable(skillId, expectedContentHash)
    ),
    executeSkillShell: ({ command, signal }) => executeAgentSkillShellCommand({
      command,
      localRoot: agentLocalFileRoot,
      scratchRoot: agentScratchRoot,
      signal,
      processEnvironment: () => managedSkillShellEnvironment!.processEnvironment(context.thread.id, context.turn.id),
    }),
    executeIsolatedSkill: async ({
      skill,
      renderedContent,
      parentToolCallId,
      readOnlyIsolated,
    }) => {
      if (!parentToolCallId) throw new Error('An isolated Skill requires its parent dynamic-tool Item identity.');
      const spawned = await threadService.spawnIsolatedSkillThread({
        parentThreadId: context.thread.id,
        parentTurnId: context.turn.id,
        parentItemId: parentToolCallId,
        skillName: skill.name,
        prompt: renderedContent,
        allowedTools: skill.allowedTools,
        readOnly: readOnlyIsolated === true,
        ...(skill.model === undefined ? {} : { model: skill.model }),
        ...(skill.effort === undefined ? {} : { reasoningEffort: parseSkillReasoningEffort(skill.effort) }),
      });
      await threadService.waitForIdle(spawned.thread.id);
      const completed = threadService.readThread({
        threadId: spawned.thread.id,
        includeTurns: true,
      }).thread.turns?.find((turn) => turn.id === spawned.turn.id);
      if (!completed || completed.status === 'inProgress') {
        throw new Error(`Isolated Skill child Thread did not reach a terminal Turn: ${spawned.thread.id}`);
      }
      const result = completed.items
        .flatMap((item) => item.type === 'agentMessage' && item.phase !== 'commentary'
          ? [item.text.trim()]
          : [])
        .filter(Boolean)
        .join('\n\n');
      const transcriptPath = await threadService.subagentTranscriptPath(spawned.thread.id);
      return {
        threadId: spawned.thread.id,
        agentRole: spawned.thread.agentRole ?? (readOnlyIsolated ? 'explorer' : 'worker'),
        status: completed.status,
        ...(result ? { result } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(completed.error?.message ? { error: completed.error.message } : {}),
      };
    },
  });
  turnSkillRuntimes.set(context.turn.id, runtime);
  return runtime;
}

async function prepareSkillRuntimeForTurn(
  context: Parameters<ToolRuntime['createTools']>[0],
): Promise<AgentSkillRuntime> {
  const existing = turnSkillRuntimeInitializations.get(context.turn.id);
  if (existing) return existing;
  const runtime = skillRuntimeForTurn(context);
  const initialization = (async () => {
    const settings = await getAgentRuntimeSettings();
    runtime.updateAdditionalSkillDirectories(settings.additionalSkillDirectories);
    runtime.updateDisabledSkills(settings.disabledSkills ?? []);
    await runtime.notifyFileTouched(observedSkillFilePaths([
      ...context.historyBeforeTurn,
      { ...context.turn, items: context.recorder.orderedItems() },
    ]));
    return runtime;
  })();
  turnSkillRuntimeInitializations.set(context.turn.id, initialization);
  try {
    return await initialization;
  } catch (error) {
    if (turnSkillRuntimeInitializations.get(context.turn.id) === initialization) {
      turnSkillRuntimeInitializations.delete(context.turn.id);
      turnSkillRuntimes.delete(context.turn.id);
      managedSkillShellEnvironment?.clearTurn(context.turn.id);
    }
    throw error;
  }
}

async function refreshTurnSkillProvenanceRecords(): Promise<void> {
  await Promise.all(
    [...turnSkillRuntimes.values()].map((runtime) => runtime.refreshProvenanceRecords()),
  );
}

function directSkillAdmissionInput(content: readonly ThreadUserContent[]): string | null {
  if (content.some((part) => part.type === 'attachment')) return null;
  const text = content.flatMap((part): string[] => {
    if (part.type === 'text') return [part.text];
    if (part.type === 'nodeReference') {
      return [`[Outliner Node ${part.nodeId}]${part.note ? ` ${part.note}` : ''}`];
    }
    return [];
  }).join('\n').trim();
  return text || null;
}

function parseSkillReasoningEffort(value: string): ReasoningEffort {
  const normalized = value.trim().toLowerCase();
  if ((REASONING_EFFORTS as readonly string[]).includes(normalized)) return normalized as ReasoningEffort;
  throw new Error(`Unsupported isolated Skill reasoning effort: ${value}`);
}

function localWorkspaceForTurn(context: Parameters<ToolRuntime['createTools']>[0]): AgentLocalWorkspaceContext {
  return createAgentLocalWorkspaceContext(
    agentLocalFileRoot,
    agentScratchRoot,
    skillRuntimeForTurn(context),
    () => managedSkillShellEnvironment!.processEnvironment(context.thread.id, context.turn.id),
  );
}

const automationStore = new AutomationStore(join(resolvedUserDataDir, 'agent', 'automations.sqlite'));
const automationWorktree = new AutomationWorktree(resolvedUserDataDir);
let automationService!: AutomationService;
async function validateAutomationEffectiveConfiguration(
  modelProvider: string,
  configuration: EffectiveThreadConfiguration,
): Promise<void> {
  const provider = await getProviderRuntimeConfig(modelProvider);
  if (!provider) throw new Error(`Automation model provider is unavailable: ${modelProvider}`);
  validateAgentModelSelection(configuration.model, configuration.reasoningEffort, provider);
}
const automationDispatcher = new AutomationDispatcher({
  store: automationStore,
  threads: threadService,
  worktrees: automationWorktree,
  defaultCwd: agentLocalFileRoot,
  resolveConfiguration: async (selection, cwd) => {
    const configuration = agentConfigurationLoader.resolveProfile(undefined, cwd);
    const effectiveConfiguration = Object.freeze({
      ...configuration,
      ...(selection.model === null ? {} : { model: selection.model }),
      ...(selection.reasoningEffort === null ? {} : { reasoningEffort: selection.reasoningEffort }),
    });
    const provider = selection.modelProvider
      ? await getProviderRuntimeConfig(selection.modelProvider)
      : await getActiveProviderRuntimeConfig();
    if (!provider) throw new Error('Configure the Automation model provider before its next occurrence.');
    await validateAutomationEffectiveConfiguration(provider.providerId, effectiveConfiguration);
    return { modelProvider: provider.providerId, configuration: effectiveConfiguration };
  },
  validateEffectiveConfiguration: validateAutomationEffectiveConfiguration,
  onRunChanged: (run) => automationService.runChanged(run),
});
const automationScheduler = new AutomationScheduler({
  store: automationStore,
  dispatcher: automationDispatcher,
  onAutomationChanged: (automation) => automationService.automationChanged(automation),
  onRunChanged: (run) => automationService.runChanged(run),
});
automationService = new AutomationService({
  store: automationStore,
  scheduler: automationScheduler,
  dispatcher: automationDispatcher,
  threads: threadService,
});
const wakeAutomationsOnResume = () => automationService.wake();

toolRuntime = new ToolRuntime(threadService, {
  outliner: documentService,
  filterOutlinerProjection: (projection, causation) => memoryExtension.filterProjection(projection, causation),
  localWorkspace: localWorkspaceForTurn,
  imageNormalizer: async ({ filePath, signal }) => {
    return prepareBoundedAgentImage(filePath, basename(filePath), signal);
  },
  skillRuntime: prepareSkillRuntimeForTurn,
  imageGeneration: (context) => createThreadImageGenerationRuntime(
    context,
    localWorkspaceForTurn(context),
  ),
  dynamicTools: () => [createAutomationTool(automationService)],
});
threadService.subscribe((notification) => {
  if (notification.type === 'turn/completed') {
    turnSkillRuntimes.delete(notification.turnId);
    turnSkillRuntimeInitializations.delete(notification.turnId);
    managedSkillShellEnvironment?.clearTurn(notification.turnId);
  }
  if (notification.type === 'turn/completed' || notification.type === 'thread/status/changed') {
    automationService.wake();
  }
  liveWindow(mainWindow)?.webContents.send(AGENT_CORE_NOTIFICATION_CHANNEL, notification);
});
automationService.subscribe((notification) => {
  liveWindow(mainWindow)?.webContents.send(AUTOMATION_NOTIFICATION_CHANNEL, notification);
});

function createThreadImageGenerationRuntime(
  context: import('./agent/runtime/types').TurnExecutionContext,
  workspace: AgentLocalWorkspaceContext,
): AgentImageGenerationRuntime {
  return {
    listModels: async () => {
      const settings = await getProviderSettings();
      const activeProviderId = (await getActiveProviderRuntimeConfig().catch(() => null))?.providerId
        ?? settings.activeProviderId
        ?? null;
      const priority = [...new Set([
        activeProviderId,
        'openai',
        'google',
        'openrouter',
      ].filter((value): value is string => Boolean(value)))];
      return settings.providers
        .filter((provider) => provider.enabled && (provider.auth?.credentialed ?? (provider.hasApiKey || provider.hasEnvApiKey)))
        .sort((left, right) => imageProviderPriority(priority, left.providerId) - imageProviderPriority(priority, right.providerId))
        .flatMap((provider) => piImageModelsForProvider(provider.providerId).map((model) => ({
          providerId: provider.providerId,
          id: model.id,
          name: model.name,
          input: [...model.input],
          output: [...model.output],
        })));
    },
    getActiveProviderId: async () => (
      await getActiveProviderRuntimeConfig().catch(() => null)
    )?.providerId ?? null,
    getDefaultModel: async () => (await getProviderSettings()).imageGeneration.defaultModel ?? null,
    validateOptions: ({ providerId, modelId, options }) => (
      validateImageGenerationOptions(providerId, modelId, options)
    ),
    readLocalImage: async ({ filePath }) => {
      const resolvedPath = resolveAgentLocalReadPath(workspace, filePath);
      const data = await readFile(resolvedPath);
      const mimeType = sniffMimeType(data, resolvedPath);
      if (!mimeType?.startsWith('image/')) throw new Error(`File is not a supported image: ${filePath}`);
      return { data, mimeType, label: basename(resolvedPath) };
    },
    persistGeneratedImage: async ({ toolCallId, index, data, mimeType, signal }) => {
      signal?.throwIfAborted();
      const callDigest = createHash('sha256').update(toolCallId).digest('hex').slice(0, 6);
      const fileName = `image-${index}-${callDigest}${generatedImageExtension(mimeType)}`;
      const original = await context.persistOutputResource(data, mimeType, fileName);
      const persistedObservation = await context.persistOutputImage(data, mimeType);
      signal?.throwIfAborted();
      const artifactRef = createImageArtifactReference({
        retention: 'tiered',
        original: { kind: 'threadPayload', ref: original },
        observation: persistedObservation.observation,
        sourceDimensions: persistedObservation.sourceDimensions,
        observationDimensions: persistedObservation.observationDimensions,
      });
      const materializedPath = await context.resolveImageArtifactPath(artifactRef);
      if (!materializedPath) throw new Error('Generated image artifact could not be materialized.');
      return {
        artifactRef,
        path: materializedPath,
        observation: {
          data: Buffer.from(
            persistedObservation.observationBytes.buffer,
            persistedObservation.observationBytes.byteOffset,
            persistedObservation.observationBytes.byteLength,
          ),
          mimeType: persistedObservation.observation.mimeType,
          label: persistedObservation.observation.fileName,
        },
      };
    },
    generateImages: async ({ providerId, modelId, context, options }) => {
      const model = piFindImageModel(providerId, modelId);
      if (!model) throw new Error(`Unknown image model: ${providerId}:${modelId}`);
      const settings = await getProviderSettings();
      const provider = settings.providers.find((candidate) => candidate.providerId === providerId);
      return piGenerateImages(model, context, { ...options, baseUrl: provider?.baseUrl });
    },
  };
}

function imageProviderPriority(priority: readonly string[], providerId: string): number {
  const index = priority.indexOf(providerId);
  return index >= 0 ? index : priority.length;
}

function generatedImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  return '.png';
}

const previewTranslationCache = new PreviewTranslationCacheStore(
  join(app.getPath('userData'), 'preview-translation-cache'),
  {
    onError: (operation) => reportError({
      domain: 'page-translation',
      severity: 'warn',
      code: `preview-translation-cache-${operation}-failed`,
      message: 'Preview translation cache operation failed.',
      context: { operation: `translation-cache-${operation}` },
    }),
  },
);
const pageTranslationService = new PageTranslationService({
  cache: previewTranslationCache,
  onError: () => reportError(pageTranslationErrorReport()),
});
const localFilePreviewStreams = new LocalFilePreviewStreamRegistry(() => [
  agentLocalFileRoot,
  agentScratchRoot,
  assetRoot(),
]);

documentService.onProjectionChanged(({ event, sourceWebContentsId, operationId }) => {
  const target = liveWindow(mainWindow)?.webContents;
  if (target && target.id !== sourceWebContentsId) {
    target.send(LIN_DOCUMENT_EVENT_CHANNEL, event);
  }
  pruneNodeAccessForProjectionUpdate(event.update);
  memoryExtension.documentChanged(operationId);
});

documentService.setTransientSearchOptionsProvider(() => ({
  personalAccessRanking: {
    getNodeAccessStats: (nodeId) => nodeAccessStore.get(nodeId),
    now: Date.now(),
  },
}));
documentService.setNodeAccessRecorder((nodeIds, source) => recordDocumentNodeAccess(nodeIds, source));

async function recordDocumentNodeAccess(nodeIds: readonly string[], source: NodeAccessSource): Promise<void> {
  const uniqueIds = [...new Set(nodeIds.filter((nodeId) => typeof nodeId === 'string' && nodeId.length > 0))];
  if (uniqueIds.length === 0) return;
  const existingIds = new Set(documentService.projectionNodesByIds(uniqueIds).map((node) => node.id));
  const validIds = uniqueIds.filter((nodeId) => existingIds.has(nodeId));
  if (validIds.length === 0) return;
  await nodeAccessStore.recordMany(validIds, source);
}

function pruneNodeAccessForProjectionUpdate(update: ProjectionUpdate): void {
  if (update.kind === 'full') {
    void nodeAccessStore.retainOnly(update.projection.nodes.map((node) => node.id)).catch(() => undefined);
    return;
  }
  const trashedIds = update.changedNodes
    .filter((node) => node.parentId === TRASH_ID)
    .map((node) => node.id);
  const staleIds = new Set([...update.removedIds, ...trashedIds]);
  if (trashedIds.length > 0) {
    for (const descendantId of descendantProjectionIds(trashedIds, documentService.getProjection().nodes)) {
      staleIds.add(descendantId);
    }
  }
  if (staleIds.size === 0) return;
  void nodeAccessStore.deleteMany([...staleIds]).catch(() => undefined);
}

function descendantProjectionIds(rootIds: readonly string[], nodes: readonly NodeProjection[]): string[] {
  if (rootIds.length === 0) return [];
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node.id);
    childrenByParent.set(node.parentId, children);
  }

  const descendants: string[] = [];
  const stack = [...rootIds];
  while (stack.length > 0) {
    const parentId = stack.pop()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      descendants.push(childId);
      stack.push(childId);
    }
  }
  return descendants;
}

// ─── Security shell (the native host owns navigation + capabilities) ───

const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
const RENDERER_DEV_ORIGIN = RENDERER_DEV_URL ? safeOrigin(RENDERER_DEV_URL) : null;
const RENDERER_SCRIPT_SRC = "script-src 'self'";
// Hash of @vitejs/plugin-react's dev preamble for base "/". Recompute if the
// plugin changes that injected module script.
const VITE_REACT_REFRESH_PREAMBLE_CSP_HASH =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

// The renderer is locked to its own resources.
// 'unsafe-inline' styles cover Shiki's inline color spans + React style props;
// remote http(s) is allowed only as <img>/<video> sources. The renderer makes
// no direct network calls (everything else goes through IPC) and runs no
// WebAssembly (loro-crdt lives in the main process), so script-src and
// connect-src stay tight.
const RENDERER_CSP_DIRECTIVES = [
  "default-src 'self'",
  RENDERER_SCRIPT_SRC,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: http: ${ASSET_URL_SCHEME}: ${PREVIEW_LOCAL_URL_SCHEME}:`,
  `media-src 'self' data: blob: https: http: ${ASSET_URL_SCHEME}: ${PREVIEW_LOCAL_URL_SCHEME}:`,
  "font-src 'self' data:",
  "object-src 'none'",
  // EPUB preview renders book sections in blob: iframes; packaged script-src
  // stays 'self', while dev admits only Vite's hashed React-refresh preamble.
  "frame-src blob:",
  "base-uri 'self'",
  "form-action 'none'",
];

const RENDERER_DEV_CSP_DIRECTIVES = RENDERER_CSP_DIRECTIVES.map((directive) =>
  directive === RENDERER_SCRIPT_SRC
    ? `${RENDERER_SCRIPT_SRC} ${VITE_REACT_REFRESH_PREAMBLE_CSP_HASH}`
    : directive,
);

const RENDERER_CSP = [
  ...RENDERER_CSP_DIRECTIVES,
  `connect-src 'self' ${ASSET_URL_SCHEME}: ${PREVIEW_LOCAL_URL_SCHEME}:`,
].join('; ');

const RENDERER_DEV_CSP = RENDERER_DEV_ORIGIN ? [
  ...RENDERER_DEV_CSP_DIRECTIVES,
  `connect-src 'self' ${ASSET_URL_SCHEME}: ${PREVIEW_LOCAL_URL_SCHEME}: ${RENDERER_DEV_ORIGIN} ${RENDERER_DEV_ORIGIN.replace(/^http/i, 'ws')}`,
].join('; ') : null;

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
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : '';
    const normalizedSrc = normalizePreviewHttpUrl(src);
    if (!normalizedSrc) {
      event.preventDefault();
      return;
    }
    delete params.preload;
    delete params.webpreferences;
    delete webPreferences.preload;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.partition = URL_PREVIEW_WEBVIEW_PARTITION;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.plugins = false;
    webPreferences.safeDialogs = true;
    webPreferences.disableDialogs = true;
    webPreferences.navigateOnDragDrop = false;
    params.partition = URL_PREVIEW_WEBVIEW_PARTITION;
    params.src = normalizedSrc;
  });
  contents.on('did-attach-webview', (_event, webContents) => {
    if (!urlPreviewSession || webContents.session !== urlPreviewSession) {
      webContents.close();
      return;
    }
    urlPreviewGuests.add(webContents);
    webContents.once('destroyed', () => urlPreviewGuests.delete(webContents));
    webContents.setWindowOpenHandler(createUrlPreviewWindowOpenHandler(webContents, (error) => {
      reportError({
        domain: 'url-preview',
        severity: 'warn',
        code: 'url-preview-popup-navigation',
        message: 'URL Preview could not route a new-window request in place',
        context: { operation: 'popup-navigation' },
        error,
      });
    }));
    const guardWebviewNavigation = (event: Electron.Event, url: string) => {
      if (normalizePreviewHttpUrl(url)) return;
      event.preventDefault();
    };
    webContents.on('will-navigate', guardWebviewNavigation);
    webContents.on('will-redirect', guardWebviewNavigation);
    webContents.on('before-input-event', (event, input) => {
      const isTranslationShortcut = input.type === 'keyDown'
        && !input.isAutoRepeat
        && input.alt
        && !input.control
        && !input.meta
        && !input.shift
        && (input.code === 'KeyA' || input.key.toLowerCase() === 'a');
      if (!isTranslationShortcut) return;
      event.preventDefault();
      if (!contents.isDestroyed()) {
        contents.send(LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL, webContents.id);
      }
    });
  });
}

function configureSessionSecurity() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isRendererPermissionAllowed(permission));
  });
  ses.setPermissionCheckHandler((_contents, permission) => isRendererPermissionAllowed(permission));
  // Enforce CSP on app renderer documents. Dev admits only Vite React refresh's
  // exact inline preamble by hash and widens connect-src for Vite HMR.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({});
      return;
    }
    const csp = details.url.startsWith('file:')
      ? RENDERER_CSP
      : RENDERER_DEV_ORIGIN && safeOrigin(details.url) === RENDERER_DEV_ORIGIN
        ? RENDERER_DEV_CSP
        : null;
    if (!csp) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
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

function effectiveTranslationLanguage(): TranslationLanguage {
  return loadAppPreferences().translationLanguage ?? effectiveLocale();
}

function urlPageTranslationPreferences(): UrlPageTranslationPreferences {
  const { translationModel, autoTranslateEpubs, autoTranslateUrls } = loadAppPreferences();
  return { translationModel, autoTranslateEpubs, autoTranslateUrls };
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
        {
          label: t.about({ app: APP_NAME }),
          click: () => openSettingsWindow({ page: 'about' }),
        },
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
      webviewTag: true,
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

  registerRendererCapabilities(mainWindow.webContents, APP_RENDERER_CAPABILITIES);

  mainWindow.on('closed', () => {
    pageTranslationService.dispose();
    actionInvocationService.invalidateRenderer(mainWindow?.webContents.id ?? -1);
    mainWindow = null;
  });
  mainWindow.webContents.on('did-start-loading', () => pageTranslationService.dispose());
  // A reload invalidates the renderer's ATTESTATIONS rather than leaving a
  // stale `view`/`workspace` bit admissible against the reloaded surface.
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) actionInvocationService.invalidateRenderer(mainWindow!.webContents.id);
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
  // The invocation is created SYNCHRONOUSLY for this open, with its ambient slot
  // pending: the panel accepts input and can already act on the stable objects
  // before external capture resolves. That is what closes the show->context race
  // at its source rather than making the renderer wait.
  const launcherContents = getLauncherWindow()?.webContents;
  if (launcherContents && !launcherContents.isDestroyed()) {
    launcherContents.send(
      ACTION_OPENED_CHANNEL,
      actionInvocationService.openLauncher({ openSeq, consumerId: launcherContents.id }),
    );
  }
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

function settingsWindowSearch(target: SettingsOpenTarget = {}): string {
  return new URLSearchParams(settingsWindowQuery(target)).toString();
}

function openSettingsWindow(openTarget: SettingsOpenTarget = {}) {
  // `liveWindow`, not a truthiness check: `settingsWindow` is cleared on 'closed',
  // so a ⌘, landing between 'close' and 'closed' found a destroyed window and threw
  // inside the ipcMain handler — an unhandled rejection, and no window opened.
  const existing = liveWindow(settingsWindow);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    // An untargeted Cmd+, must not yank a user who is already somewhere else back
    // to General. A page names its own category, so it is independently explicit.
    if (openTarget.category || openTarget.page) {
      existing.webContents.send(LIN_SETTINGS_NAVIGATE_CHANNEL, openTarget);
    }
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

  const window = settingsWindow;
  // Settings keeps the app preload, so it keeps the app capabilities its
  // `api/client` path uses.
  registerRendererCapabilities(window.webContents, APP_RENDERER_CAPABILITIES);
  hardenWebContents(window.webContents);
  attachNativeContextMenu(window.webContents);
  // Match the main window's custom native corner (MAC_WINDOW_CORNER_RADIUS) so the
  // frameless settings window has the SAME rounded corners — not the smaller macOS
  // default (16pt on Tahoe). Apply before show (no default-corner flash) and again
  // on ready-to-show; reset to 0 in fullscreen where a rounded corner clips content.
  applyMacWindowCorner(window, MAC_WINDOW_CORNER_RADIUS);
  window.once('ready-to-show', () => {
    applyMacWindowCorner(window, MAC_WINDOW_CORNER_RADIUS);
    window.show();
  });
  window.on('enter-full-screen', () => applyMacWindowCorner(window, 0));
  window.on('leave-full-screen', () => applyMacWindowCorner(window, MAC_WINDOW_CORNER_RADIUS));

  if (RENDERER_DEV_URL) {
    void window.loadURL(`${RENDERER_DEV_URL}?${settingsWindowSearch(openTarget)}`);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: settingsWindowQuery(openTarget),
    });
  }

  window.on('closed', () => {
    settingsWindow = null;
  });
}

async function clearUrlPreviewWebsiteData(
  event: IpcMainInvokeEvent,
): Promise<ClearUrlPreviewDataResult> {
  const window = liveWindow(settingsWindow);
  if (!window || event.sender !== window.webContents || !urlPreviewSession) {
    return { status: 'failed', error: 'unavailable' };
  }

  const labels = getMessages(effectiveLocale()).settings.general;
  const confirmation = await dialog.showMessageBox(window, {
    type: 'warning',
    title: labels.websiteDataClearConfirmTitle,
    message: labels.websiteDataClearConfirmMessage,
    detail: labels.websiteDataClearConfirmDetail,
    buttons: [labels.websiteDataClearConfirmAction, labels.websiteDataCancelAction],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return { status: 'canceled' };

  try {
    await clearUrlPreviewSessionData(urlPreviewSession);
    for (const guest of [...urlPreviewGuests]) {
      if (guest.isDestroyed()) {
        urlPreviewGuests.delete(guest);
        continue;
      }
      guest.reloadIgnoringCache();
    }
    return { status: 'cleared' };
  } catch (error) {
    reportError({
      domain: 'url-preview',
      severity: 'error',
      code: 'url-preview-clear-data',
      message: 'URL Preview website data could not be cleared',
      context: { operation: 'clear-data' },
      error,
    });
    return { status: 'failed', error: 'clear-failed' };
  }
}

function clearPreviewTranslationCache(
  event: IpcMainInvokeEvent,
): Promise<ClearPreviewTranslationCacheResult> {
  return clearPreviewTranslationCacheFromSettings(event, {
    cache: previewTranslationCache,
    getSettingsWindow: () => liveWindow(settingsWindow) ?? null,
    labels: () => getMessages(effectiveLocale()).settings.general,
    showMessageBox: (window, options) => dialog.showMessageBox(window, options),
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
  // Replace any open config window (clicking another provider re-targets it).
  if (isLiveWindow(providerConfigWindow)) {
    // Abort any in-flight sign-in tied to the window we're replacing, so its
    // loopback server / parked prompts don't leak and stale events can't reach
    // the new window. (Only this provider's login can be in flight here.)
    oauthLoginManager.cancelAll();
    providerConfigWindow.close();
  }
  providerConfigWindow = null;

  const width = 460;
  const height = 384;
  const target = createConfigChildWindow({
    title: getMessages(effectiveLocale()).window.providerConfigTitle,
    width,
    height,
    resizable: false,
    parent: liveWindow(settingsWindow),
    query: {
      [WINDOW_SURFACE_QUERY_PARAM]: 'provider-config',
      [PROVIDER_CONFIG_PROVIDER_PARAM]: providerId,
      [PROVIDER_CONFIG_MODE_PARAM]: mode,
    },
  });
  providerConfigWindow = target;

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

function isLiveWindow(window: BrowserWindow | null | undefined): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed());
}

function liveWindow(window: BrowserWindow | null | undefined): BrowserWindow | undefined {
  return isLiveWindow(window) ? window : undefined;
}

function isProviderConfigSender(event: IpcMainInvokeEvent): boolean {
  const target = liveWindow(providerConfigWindow);
  return Boolean(target && event.sender === target.webContents);
}

function centeredChildWindowPosition(parent: BrowserWindow | null | undefined, width: number, height: number) {
  const bounds = isLiveWindow(parent) ? parent.getBounds() : undefined;
  return bounds
    ? {
        x: Math.round(bounds.x + (bounds.width - width) / 2),
        y: Math.round(bounds.y + Math.max(48, (bounds.height - height) / 2)),
      }
    : {};
}

function loadRendererSurface(
  target: BrowserWindow,
  query: Record<string, string>,
) {
  if (RENDERER_DEV_URL) {
    const url = new URL(RENDERER_DEV_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void target.loadURL(url.toString());
  } else {
    void target.loadFile(join(__dirname, '../renderer/index.html'), { query });
  }
}

function createConfigChildWindow(options: {
  title: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  parent?: BrowserWindow;
  query: Record<string, string>;
  resizable: boolean;
}): BrowserWindow {
  const { width, height, parent } = options;
  const target = new BrowserWindow({
    title: options.title,
    width,
    height,
    ...(options.minWidth ? { minWidth: options.minWidth } : {}),
    ...(options.minHeight ? { minHeight: options.minHeight } : {}),
    ...centeredChildWindowPosition(parent, width, height),
    parent,
    modal: Boolean(parent),
    show: false,
    resizable: options.resizable,
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

  // Provider-config child windows likewise keep the app bridge.
  registerRendererCapabilities(target.webContents, APP_RENDERER_CAPABILITIES);
  hardenWebContents(target.webContents);
  attachNativeContextMenu(target.webContents);
  applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
  target.once('ready-to-show', () => {
    applyMacWindowCorner(target, MAC_WINDOW_CORNER_RADIUS);
    target.show();
  });
  loadRendererSurface(target, options.query);
  return target;
}

function configChildWindowParent(excluded: BrowserWindow | null = null): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (isLiveWindow(focused) && focused !== excluded) {
    if (focused === providerConfigWindow) {
      return liveWindow(focused.getParentWindow()) ?? liveWindow(settingsWindow) ?? liveWindow(mainWindow);
    }
    return focused;
  }
  return liveWindow(settingsWindow) ?? liveWindow(mainWindow);
}

interface LocalFileOperationInput {
  readonly path?: unknown;
  readonly threadId?: unknown;
  readonly attachmentId?: unknown;
}

async function resolveLocalFileOperation(
  raw: LocalFileOperationInput | undefined,
  allowAttachmentPathHint = false,
): Promise<TrustedLocalFileReference | null> {
  const threadId = typeof raw?.threadId === 'string' && raw.threadId.trim() ? raw.threadId : null;
  const attachmentId = typeof raw?.attachmentId === 'string' && raw.attachmentId.trim()
    ? raw.attachmentId
    : null;
  if (Boolean(threadId) !== Boolean(attachmentId)) return null;
  if (!threadId || !attachmentId) {
    return resolveTrustedLocalFileReference(
      raw?.path,
      [agentLocalFileRoot, agentScratchRoot],
    );
  }
  const attachment = await threadService.resolveAttachmentFile(threadId, attachmentId).catch(() => null);
  if (!attachment) return null;
  if (attachment.entryKind === 'directory') {
    return resolveTrustedLocalFileReference(
      raw?.path,
      [attachment.path],
    );
  }
  if (allowAttachmentPathHint) {
    const requestedPath = typeof raw?.path === 'string' ? raw.path : '';
    const acceptedHints = attachment.attachment.source.kind === 'localFile'
      ? [attachment.path, attachment.attachment.source.path]
      : [
          attachment.path,
          attachment.attachment.name,
          attachment.attachment.source.ref.fileName,
        ];
    return acceptedHints.includes(requestedPath) ? attachment : null;
  }
  if (typeof raw?.path !== 'string') return null;
  const requestedPath = await realpath(raw.path).catch(() => null);
  return requestedPath === attachment.path ? attachment : null;
}

// ---------------------------------------------------------------------------
// The action seam (docs/plans/unified-command-surface.md D1b)
// ---------------------------------------------------------------------------

// Renderer steps in flight, by one-shot token. Main emits a renderer step only
// after the preceding main step succeeded, and waits for this ack before the
// next one — without it main cannot know a renderer step failed.
const pendingActionStepAcks = new Map<string, (ack: ActionStepAck) => void>();

async function routeActionRendererStep(
  step: EffectStep,
  invocationRef: string,
): Promise<RendererStepAck> {
  // A navigate can arrive from the LAUNCHER, whose whole point is working when
  // the main window is closed. Reuse the shipped deferred-navigate path — bring
  // the window up and flush on `did-finish-load` — instead of reporting `gone`
  // for the one case the surface exists to serve.
  if (step.on === 'mainRenderer' && step.kind === 'navigate' && typeof step.nodeId === 'string') {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
      navigateMainToNode(step.nodeId);
      return { status: 'ok' };
    }
  }
  const target = mainWindow?.webContents;
  if (!target || target.isDestroyed()) return { status: 'gone' };
  const token = randomUUID();
  return new Promise<RendererStepAck>((resolve) => {
    const timer = setTimeout(() => {
      pendingActionStepAcks.delete(token);
      // A missing ack does NOT prove the step did not run.
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
}

const actionInvocationService = new ActionInvocationService({
  projection: () => documentService.liveProjection(),
  // Deliberately NO `sourceWebContentsId`: the renderer no longer applies the
  // command result itself, so it must receive the projection-changed event
  // rather than have it suppressed as its own echo.
  runCommand: (command, args) => documentService.handle(
    command as DocumentCommand,
    args,
    { origin: 'user', command },
  ),
  searchNodes: (query, limit) => documentService.searchNodeHits(query, limit),
  executeRendererStep: routeActionRendererStep,
  activateAppSurface: async (surface) => {
    if (surface === 'settings') {
      openSettingsWindow();
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else focusMainWindow();
  },
  writeClipboard: (text) => clipboard.writeText(text),
  untitled: () => getMessages(effectiveLocale()).common.untitled,
  now: () => Date.now(),
});

function registerIpc() {
  // Every action channel is main-renderer only. The seed carries renderer FACTS
  // — anchored row, selection, panel identity, pin and expansion — and main
  // constructs the objects, mints the refs and owns the lifetime.
  // Creating an invocation from a seed is ATTESTATION: only the main renderer
  // can say which row was right-clicked, what is selected, and whether the row
  // is pinned or expanded. The launcher has no such capability.
  ipcMain.handle(ACTION_OPEN_CHANNEL, (event, raw: unknown) => {
    if (!rendererHasCapability(event.sender.id, 'actionAttestation')) {
      throw new Error('This renderer may not attest invocation context.');
    }
    assertMainRenderer(event, 'Action invocations');
    const seed = sanitizeInvocationSeed(raw);
    if (!seed) return null;
    return actionInvocationService.openFromSeed(seed, {
      webContentsId: event.sender.id,
      renderGeneration: event.sender.getProcessId(),
    });
  });

  ipcMain.handle(ACTION_OBJECT_QUERY_CHANNEL, (event, raw: unknown) => {
    assertActionRequester(event);
    const request = sanitizeObjectQuery(raw);
    if (!request) return null;
    return actionInvocationService.queryObjects(request, event.sender.id);
  });

  ipcMain.handle(ACTION_PARAMETER_QUERY_CHANNEL, (event, raw: unknown) => {
    assertActionRequester(event);
    const request = sanitizeParameterQuery(raw);
    if (!request) return null;
    return actionInvocationService.queryParameterObjects(request, event.sender.id);
  });

  ipcMain.handle(ACTION_REQUEST_CHANNEL, (event, raw: unknown) => {
    assertActionRequester(event);
    const request = sanitizeActionRequest(raw);
    // A malformed request is not "stale" — it never named anything.
    if (!request) return { status: 'stale', reason: 'invocation' };
    return actionInvocationService.request(request, event.sender.id);
  });

  ipcMain.handle(ACTION_EVENT_CHANNEL, (event, raw: unknown) => {
    assertActionRequester(event);
    const invocationEvent = sanitizeInvocationEvent(raw);
    if (!invocationEvent) return { status: 'spent' };
    return actionInvocationService.event(invocationEvent, event.sender.id);
  });

  ipcMain.handle(ACTION_STEP_ACK_CHANNEL, (event, raw: unknown) => {
    // Renderer steps only ever route to the MAIN renderer, so only it can ack.
    assertMainRenderer(event, 'Action invocations');
    const ack = raw as ActionStepAck | undefined;
    if (typeof ack?.token !== 'string') return;
    if (ack.status !== 'ok' && ack.status !== 'reported') return;
    pendingActionStepAcks.get(ack.token)?.(ack);
  });

  ipcMain.handle(AUTOMATION_REQUEST_CHANNEL, async (event, method: unknown, input: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Automations are available only to the main application window.');
    }
    if (typeof method !== 'string' || !(AUTOMATION_METHODS as readonly string[]).includes(method)) {
      throw new Error(`Unknown Automation method: ${String(method)}`);
    }
    return automationService.request(method as AutomationMethod, input);
  });
  ipcMain.handle(AGENT_CORE_REQUEST_CHANNEL, async (event, method: AgentCoreMethod, input: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Agent Core is available only to the main application window.');
    }
    return threadService.request(method, input as AgentCoreRequestByMethod[AgentCoreMethod]);
  });
  ipcMain.handle(THREAD_MESSAGE_CONTEXT_MENU_CHANNEL, async (
    event,
    request?: Partial<ThreadMessageContextMenuRequest>,
  ): Promise<ThreadMessageContextMenuAction | null> => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    const messages = getMessages(effectiveLocale()).agent;
    let settled = false;
    return new Promise<ThreadMessageContextMenuAction | null>((resolve) => {
      const pick = (action: ThreadMessageContextMenuAction) => {
        settled = true;
        resolve(action);
      };
      const template: Electron.MenuItemConstructorOptions[] = [];
      if (request?.canCopy === true) {
        template.push({ label: messages.message.copyMessage, click: () => pick('copy') });
      }
      if (request?.canContinueInNewChat === true) {
        if (template.length > 0) template.push({ type: 'separator' });
        template.push({
          label: messages.thread.continueInNewChat,
          click: () => pick('continueInNewChat'),
        });
      }
      if (request?.canShowDetails === true) {
        if (template.length > 0) template.push({ type: 'separator' });
        template.push({ label: messages.message.details, click: () => pick('details') });
      }
      if (template.length === 0) {
        resolve(null);
        return;
      }
      Menu.buildFromTemplate(template).popup({
        window: mainWindow!,
        callback: () => {
          if (!settled) resolve(null);
        },
      });
    });
  });
  ipcMain.handle('lin:invoke', async (event, command: string, args?: Record<string, unknown>) => {
    // BEFORE dispatch, not inside it: the launcher must not reach
    // `get_projection` or `delete_node` by any command name, and a renderer
    // with no registered capabilities fails closed rather than inheriting the
    // app's rights.
    if (!rendererHasCapability(event.sender.id, 'appCommands')) {
      throw new Error('This renderer may not invoke application commands.');
    }
    const dispatch = () => {
      if (command.startsWith('memory_')) return handleMemoryCommand(command, args ?? {});
      if (isAgentCommand(command)) return handleAgentCommand(event, command, args ?? {});
      if (isAssetCommand(command)) return handleAssetCommand(event, command, args ?? {});
      if (isUrlPageTranslationCommand(command)) {
        if (!mainWindow || event.sender !== mainWindow.webContents) {
          throw new Error('Page translation is only available to the main window.');
        }
        return pageTranslationService.handle(command, args ?? {});
      }
      if (isPreviewCommand(command)) {
        assertMainRenderer(event, 'Preview');
        return handlePreviewCommand(command, args ?? {}, {
          agentLocalFileRoots: [agentLocalFileRoot, agentScratchRoot],
          assetService,
          assetFileStreamUrl: async (filePath, mimeType) => {
            const token = await localFilePreviewStreams.issuePath(filePath, mimeType);
            return token ? previewLocalUrl(token) : null;
          },
          inferMimeType,
          localFileStreamUrl: async (file, mimeType) => {
            const token = await localFilePreviewStreams.issue(file, mimeType);
            return token ? previewLocalUrl(token) : null;
          },
          threadAttachmentFile: async (threadId, attachmentId) => (
            threadService.resolveAttachmentFile(threadId, attachmentId).then(async (resolved) => {
              if (!resolved) return null;
              return {
                ...resolved,
                ...(resolved.attachment.artifactRef
                  ? { mimeType: await sniffPreviewFileMimeType(resolved.path, resolved.attachment.mimeType) }
                  : {}),
                acceptedPathHints: resolved.attachment.source.kind === 'localFile'
                  ? [resolved.attachment.source.path]
                  : [resolved.attachment.name, resolved.attachment.source.ref.fileName],
              };
            }).catch(() => null)
          ),
          threadResourceFile: async (threadId, ref) => (
            threadService.resolveThreadResourceFile(threadId, ref).then((resolved) => {
              if (!resolved) return null;
              return {
                ...resolved,
                acceptedPathHints: [resolved.ref.fileName],
              };
            }).catch(() => null)
          ),
          threadImageArtifactFile: async (threadId, artifact) => (
            threadService.resolveImageArtifactFile(threadId, artifact).then(async (resolved) => {
              if (!resolved) return null;
              return {
                ...resolved,
                mimeType: await sniffPreviewFileMimeType(resolved.path, resolved.artifact.observation.mimeType),
                acceptedPathHints: [
                  resolved.artifact.id,
                  resolved.artifact.observation.fileName,
                  ...(resolved.artifact.original?.kind === 'threadPayload'
                    ? [resolved.artifact.original.ref.fileName]
                    : []),
                ],
              };
            }).catch(() => null)
          ),
          threadManagedFileStreamUrl: async (filePath, mimeType) => {
            const token = await localFilePreviewStreams.issueExactPath(filePath, mimeType);
            return token ? previewLocalUrl(token) : null;
          },
          localFileReferencePreview,
        });
      }
      if (isDocumentCommand(command)) {
        return documentService.handle(command, args, { sourceWebContentsId: event.sender.id });
      }
      throw new Error(`Unknown command: ${command}`);
    };
    if (!IPC_TRACE_ENABLED) return dispatch();
    const start = performance.now();
    const result = await dispatch();
    traceIpc(command, result, performance.now() - start);
    return result;
  });

  ipcMain.handle('lin:record-node-access', async (_event, raw: unknown): Promise<void> => {
    if (typeof raw !== 'string' || !raw) return;
    await recordDocumentNodeAccess([raw], 'human');
  });

  ipcMain.handle(LIN_URL_PAGE_TRANSLATION_GUEST_CHANNEL, (event, raw: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Page translation guest access is only available to the main window.');
    }
    return executeUrlPageTranslationGuestCommand(event.sender, raw);
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

  ipcMain.handle('lin:open-settings', (_event, target?: unknown) => openSettingsWindow(sanitizeSettingsOpenTarget(target)));
  // Only the settings surface may close the settings window. Every sibling
  // privileged handler checks its sender; this one did not, so any renderer could
  // close it.
  ipcMain.handle('lin:close-settings', (event) => {
    const window = liveWindow(settingsWindow);
    if (window && BrowserWindow.fromWebContents(event.sender) === window) window.close();
  });
  ipcMain.handle(LIN_CLEAR_URL_PREVIEW_DATA_CHANNEL, clearUrlPreviewWebsiteData);
  ipcMain.handle(LIN_CLEAR_PREVIEW_TRANSLATION_CACHE_CHANNEL, clearPreviewTranslationCache);
  // Launcher window IPC (the prewarmed global launcher). Every handler below is
  // sender-checked: `launcher:*` is the launcher's own bridge, and a non-launcher
  // renderer naming these channels is refused rather than served.
  function assertLauncherRenderer(event: IpcMainInvokeEvent): void {
    if (!rendererHasCapability(event.sender.id, 'launcher')) {
      throw new Error('The launcher bridge is available only to the launcher window.');
    }
  }

  ipcMain.handle('launcher:hide', (event) => {
    assertLauncherRenderer(event);
    dismissLauncher();
  });
  ipcMain.handle('launcher:getInitialState', (event): LauncherInitialState => {
    assertLauncherRenderer(event);
    return {
      commands: getStaticLauncherCommands(),
      hotkey: launcherHotkeyAccelerator,
    };
  });
  ipcMain.handle('launcher:executeCommand', (event, id: unknown): LauncherExecuteResult => {
    assertLauncherRenderer(event);
    return executeLauncherCommand(id);
  });
  // New node from the launcher: a plain typed note (no external source). Ensure
  // today's date node, then create the node under it. NOT a capture — no sidecar.
  ipcMain.handle('launcher:createCapture', async (event, raw: unknown): Promise<LauncherCreateCaptureResult> => {
    assertLauncherRenderer(event);
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
  ipcMain.handle('launcher:createContextCapture', async (event, raw: unknown): Promise<LauncherCreateCaptureResult> => {
    assertLauncherRenderer(event);
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
      // content (body/selection/transcript) is not extracted today, and no browser
      // extension or CDP backend is planned; when it lands it will be an explicit
      // reader invoked after the user picks an action, never on the ambient hotkey
      // path (docs/plans/unified-command-surface.md).
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
  ipcMain.handle('launcher:searchNodes', async (event, raw: unknown): Promise<LauncherNodeMatch[]> => {
    assertLauncherRenderer(event);
    try {
      return await searchLauncherNodes(typeof raw === 'string' ? raw : '');
    } catch (error) {
      console.error('[launcher] searchNodes failed', error);
      return [];
    }
  });
  // Open a node search result: bring up the main window and navigate to it.
  ipcMain.handle('launcher:openNode', (event, raw: unknown): void => {
    assertLauncherRenderer(event);
    if (typeof raw !== 'string' || !raw) return;
    navigateMainToNode(raw);
    dismissLauncher();
  });
  // Appearance preference. Setting nativeTheme.themeSource rewrites
  // prefers-color-scheme in every renderer, so the @media rules in theme-dark.css
  // flip all windows at once — no per-window broadcast needed. We mirror the stored
  // mode (not the resolved scheme) so the settings control reflects the user's pick.
  ipcMain.handle('lin:get-theme', (): ThemeMode => nativeTheme.themeSource);
  // Read-only view of the accelerator the launcher hotkey registered under (null
  // when every candidate was taken), so Settings → General can state it. No args,
  // no mutation: registration stays main's.
  ipcMain.handle('lin:launcher-hotkey', (): string | null => launcherHotkeyAccelerator);
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
  ipcMain.on('lin:get-translation-language-sync', (event) => {
    event.returnValue = effectiveTranslationLanguage();
  });
  ipcMain.on('lin:get-url-page-translation-preferences-sync', (event) => {
    event.returnValue = urlPageTranslationPreferences();
  });
  ipcMain.handle('lin:set-translation-language', (_event, raw: unknown): void => {
    if (!isTranslationLanguage(raw)) return;
    saveTranslationLanguagePreference(raw);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(LIN_TRANSLATION_LANGUAGE_CHANGED_CHANNEL, raw);
    }
  });
  ipcMain.handle('lin:set-url-page-translation-preferences', (_event, raw: unknown): UrlPageTranslationPreferences => {
    if (!isUrlPageTranslationPreferences(raw)) return urlPageTranslationPreferences();
    saveUrlPageTranslationPreferences(raw);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(LIN_URL_PAGE_TRANSLATION_PREFERENCES_CHANGED_CHANNEL, raw);
    }
    return raw;
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
      if (loadAppPreferences().translationLanguage === null) {
        window.webContents.send(LIN_TRANSLATION_LANGUAGE_CHANGED_CHANNEL, raw);
      }
    }
    Menu.setApplicationMenu(buildApplicationMenu());
    // Open windows localize their native title bar once at construction; their content
    // re-renders via I18nProvider, but the OS title bar would otherwise stay stale.
    const messages = getMessages(raw);
    liveWindow(settingsWindow)?.setTitle(messages.window.settingsTitle({ app: APP_NAME }));
    liveWindow(providerConfigWindow)?.setTitle(messages.window.providerConfigTitle);
  });
  // Open the per-provider config as its own native (modal child) window.
  ipcMain.handle('lin:open-provider-config', (_event, args?: { providerId?: unknown; mode?: unknown }) => {
    const providerId = typeof args?.providerId === 'string' ? args.providerId : '';
    const mode: ProviderConfigMode = args?.mode === 'custom' ? 'custom' : 'configure';
    openProviderConfigWindow(providerId, mode);
  });
  ipcMain.handle('lin:close-provider-config', () => liveWindow(providerConfigWindow)?.close());
  ipcMain.handle('lin:get-provider-api-key', (event, args?: { providerId?: unknown }) => {
    if (!isProviderConfigSender(event)) {
      throw new Error('Provider API keys are only available to the provider config window.');
    }
    return getStoredProviderApiKey(String(args?.providerId ?? ''));
  });
  // A provider setting changed in the settings window or its config child.
  // Tell the main window (stale provider state) and the settings window (its list
  // reflects the new configured provider row) to re-fetch — but never the window
  // that just wrote.
  //
  // Fanning it back to the sender was a real defect, not just waste: the settings
  // window's listener refetches and reapplies wholesale, so a write made there
  // reverted the user's other pending toggles. Deleting the draft removed the
  // damage; excluding the sender removes the cause, and with it a full settings
  // round-trip plus a list re-render on every instant toggle.
  ipcMain.handle('lin:settings-changed', (event) => {
    notifySettingsChanged(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle(LIN_REPORT_RENDERER_ERROR_CHANNEL, (_event, raw: unknown) => {
    reportError(errorReportFromIpc(raw, 'render'));
  });

  ipcMain.handle(LIN_REVEAL_DIAGNOSTICS_LOG_CHANNEL, async (): Promise<DiagnosticsActionResult> => {
    try {
      const logPath = await diagnosticLog.ensureLogFile();
      shell.showItemInFolder(logPath);
      return { ok: true, path: logPath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(LIN_APP_INFO_CHANNEL, async () => {
    const environment = await diagnosticEnvironment();
    return {
      name: APP_NAME,
      version: environment.appVersion,
      platform: environment.platform,
      arch: environment.arch,
      electron: environment.electron,
      chrome: environment.chrome,
      node: environment.node,
    };
  });

  ipcMain.handle(LIN_EXPORT_DIAGNOSTICS_CHANNEL, async (event): Promise<DiagnosticsActionResult> => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? settingsWindow ?? mainWindow;
      const defaultPath = join(app.getPath('desktop'), `tenon-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      const result = window
        ? await dialog.showSaveDialog(window, {
            defaultPath,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          })
        : await dialog.showSaveDialog({
            defaultPath,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      const filePath = await diagnosticLog.writeExport(result.filePath, await diagnosticEnvironment());
      return { ok: true, path: filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
      properties: multiSelections
        ? ['openFile', 'openDirectory', 'multiSelections']
        : ['openFile', 'openDirectory'],
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
    let skippedCount = 0;
    const files: NonNullable<Awaited<ReturnType<typeof localPickedFile>>>[] = [];
    const rejectedFiles: Array<{
      name: string;
      reason: 'officeOwnershipFile';
      suggestedName?: string;
    }> = [];
    for (const filePath of result.filePaths) {
      const rejected = await rejectedOfficeOwnershipFile(filePath);
      if (rejected) {
        rejectedFiles.push(rejected);
        continue;
      }
      if (files.length >= maxFiles) {
        skippedCount += 1;
        continue;
      }
      const file = await localPickedFile(filePath);
      if (file) files.push(file);
    }
    return {
      canceled: false,
      files,
      ...(rejectedFiles.length > 0 ? { rejectedFiles } : {}),
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

  ipcMain.handle('lin:preview-local-file-reference', async (event, rawOptions?: LocalFileOperationInput) => {
    assertAttachmentFileOperationRenderer(event, rawOptions, 'Attachment preview');
    const file = await resolveLocalFileOperation(rawOptions, true);
    if (!file) return { file: null };
    return { file: await localFileReferencePreview(file) };
  });

  ipcMain.handle('lin:open-local-file', async (event, rawOptions?: LocalFileOperationInput) => {
    assertAttachmentFileOperationRenderer(event, rawOptions, 'Attachment open');
    const file = await resolveLocalFileOperation(rawOptions, true);
    if (!file || !isSafeLocalFileOpenTarget(file)) return { opened: false };
    const error = await shell.openPath(file.path);
    return { opened: error.length === 0 };
  });

  ipcMain.handle('lin:reveal-local-file', async (event, rawOptions?: LocalFileOperationInput) => {
    // Reveal-in-Finder never executes the file, so it carries no `isSafeLocalFileOpenTarget`
    // gate (an app/script that can't be opened can still be revealed); the same trusted-root
    // boundary as `lin:open-local-file` is the authority.
    assertAttachmentFileOperationRenderer(event, rawOptions, 'Attachment reveal');
    const file = await resolveLocalFileOperation(rawOptions, true);
    if (!file) return { revealed: false };
    shell.showItemInFolder(file.path);
    return { revealed: true };
  });

  ipcMain.handle('lin:attachment-upload/begin', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment upload');
    const expectedBytes = Number(raw?.sizeBytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
      throw new Error('Attachment upload size must be a non-negative safe integer.');
    }
    const threadId = requiredNonEmptyString(raw?.threadId, 'threadId');
    const attachmentId = requiredNonEmptyString(raw?.attachmentId, 'attachmentId');
    const uploadId = await threadService.beginAttachmentUpload({
      threadId,
      attachmentId,
      expectedBytes,
      mimeType: requiredNonEmptyString(raw?.mimeType, 'mimeType'),
      fileName: requiredNonEmptyString(raw?.name, 'name'),
    });
    return { uploadId };
  });

  ipcMain.handle('lin:attachment-upload/append', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment upload');
    const bytes = stagedAttachmentBuffer(raw?.bytes);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_UPLOAD_CHUNK_BYTES) {
      throw new Error('Attachment upload chunk is invalid.');
    }
    await threadService.appendAttachmentUpload({
      threadId: requiredNonEmptyString(raw?.threadId, 'threadId'),
      attachmentId: requiredNonEmptyString(raw?.attachmentId, 'attachmentId'),
      uploadId: requiredNonEmptyString(raw?.uploadId, 'uploadId'),
      bytes,
    });
    return {};
  });

  ipcMain.handle('lin:attachment-upload/finish', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment upload');
    return threadService.finishAttachmentUpload({
      threadId: requiredNonEmptyString(raw?.threadId, 'threadId'),
      attachmentId: requiredNonEmptyString(raw?.attachmentId, 'attachmentId'),
      uploadId: requiredNonEmptyString(raw?.uploadId, 'uploadId'),
    });
  });

  ipcMain.handle('lin:attachment-upload/abort', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment upload');
    await threadService.abortAttachmentUpload({
      threadId: requiredNonEmptyString(raw?.threadId, 'threadId'),
      attachmentId: requiredNonEmptyString(raw?.attachmentId, 'attachmentId'),
      uploadId: requiredNonEmptyString(raw?.uploadId, 'uploadId'),
    });
    return {};
  });

  ipcMain.handle('lin:attachment-resource/discard', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment resource discard');
    const discarded = await threadService.discardUnreferencedThreadResource(
      requiredNonEmptyString(raw?.threadId, 'threadId'),
      decodeThreadResourceReference(raw?.ref, 'attachmentResource.ref'),
    );
    return { discarded };
  });
}

async function handleMemoryCommand(command: string, args: Record<string, unknown>) {
  switch (command) {
    case 'memory_settings_get':
      return memoryExtension.settings(typeof args.threadId === 'string' ? args.threadId : null);
    case 'memory_feature_mode_set':
      return memoryExtension.setFeatureMode(decodeMemoryFeatureMode(args.mode));
    case 'memory_thread_mode_set':
      return memoryExtension.setThreadMode(
        requiredNonEmptyString(args.threadId, 'threadId'),
        decodeThreadMemoryMode(args.mode),
      );
    case 'memory_open':
      {
        const outcome = await documentService.handle('ensure_tag_search', {
          tagId: memoryTagId('memory'),
        }) as CommandResult;
        navigateMainToNode(outcome.focus?.nodeId ?? DAILY_NOTES_ID);
      }
      return memoryExtension.settings();
    case 'memory_reset':
      return memoryExtension.reset();
    default:
      throw new Error(`Unknown Memory command: ${command}`);
  }
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

/**
 * A seed is raw FACTS, never a finished invocation: main validates the ids and
 * builds the objects itself. Anything malformed is rejected outright rather
 * than partially trusted.
 */
function sanitizeInvocationSeed(raw: unknown): InvocationSeed | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const seed = raw as Record<string, unknown>;
  const anchorNodeId = typeof seed.anchorNodeId === 'string' ? seed.anchorNodeId : null;
  const visualRowId = typeof seed.visualRowId === 'string' ? seed.visualRowId : null;
  const panelId = typeof seed.panelId === 'string' ? seed.panelId : null;
  if (!anchorNodeId || !visualRowId || panelId === null) return null;
  const selectedIds = Array.isArray(seed.selectedIds)
    ? seed.selectedIds.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    from: 'mainRenderer',
    anchorNodeId,
    visualRowId,
    panelId,
    selectedIds,
    isPinned: seed.isPinned === true,
    rowExpanded: seed.rowExpanded === true,
  };
}

/**
 * Inbound action messages are bounded shapes, not free-form objects: main
 * re-derives everything else. Anything malformed is refused outright rather
 * than half-trusted.
 */
function sanitizeObjectQuery(raw: unknown): ObjectQueryRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.invocationRef !== 'string'
    || typeof value.openSeq !== 'number'
    || typeof value.requestId !== 'string'
    || typeof value.query !== 'string'
  ) return null;
  return {
    invocationRef: value.invocationRef as ObjectQueryRequest['invocationRef'],
    openSeq: value.openSeq,
    requestId: value.requestId as ObjectQueryRequest['requestId'],
    query: value.query.slice(0, 512),
  };
}

function sanitizeParameterQuery(raw: unknown): ParameterObjectQueryRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const slot = value.slot as Record<string, unknown> | undefined;
  if (
    typeof value.invocationRef !== 'string'
    || typeof value.requestId !== 'string'
    || typeof value.query !== 'string'
    || typeof slot !== 'object' || slot === null
    || typeof slot.actionId !== 'string'
    || typeof slot.subjectRef !== 'string'
    || typeof slot.parameterId !== 'string'
  ) return null;
  return {
    invocationRef: value.invocationRef as ParameterObjectQueryRequest['invocationRef'],
    openSeq: typeof value.openSeq === 'number' ? value.openSeq : null,
    slot: slot as unknown as ParameterObjectQueryRequest['slot'],
    requestId: value.requestId as ParameterObjectQueryRequest['requestId'],
    // Bounded: the query is a search string, never a payload.
    query: value.query.slice(0, 512),
  };
}

function sanitizeActionRequest(raw: unknown): ActionRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.actionId !== 'string'
    || typeof value.invocationRef !== 'string'
    || typeof value.subjectRef !== 'string'
    || typeof value.arguments !== 'object' || value.arguments === null
  ) return null;
  if (value.challenge !== undefined && typeof value.challenge !== 'string') return null;
  return raw as ActionRequest;
}

function sanitizeInvocationEvent(raw: unknown): InvocationEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.invocationRef !== 'string') return null;
  switch (value.kind) {
    case 'confirmationCancelled':
      return typeof value.challenge === 'string' ? (raw as InvocationEvent) : null;
    case 'objectRemoved':
      return typeof value.objectRef === 'string' ? (raw as InvocationEvent) : null;
    case 'selectionMemberRemoved':
      return typeof value.selectionRef === 'string' && typeof value.memberRef === 'string'
        ? (raw as InvocationEvent)
        : null;
    case 'abandoned':
      return raw as InvocationEvent;
    default:
      return null;
  }
}

/**
 * Naming an action, querying its parameters and reporting a lifecycle event are
 * open to any renderer holding `actionRequests` — the launcher included. That
 * is safe precisely because main re-evaluates the named tuple itself; it is not
 * safe for `lin:invoke`, which is why that channel has its own gate.
 */
function assertActionRequester(event: IpcMainInvokeEvent): void {
  if (!rendererHasCapability(event.sender.id, 'actionRequests')) {
    throw new Error('This renderer may not request actions.');
  }
}

function assertMainRenderer(event: IpcMainInvokeEvent, capability: string): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error(`${capability} is available only to the main application window.`);
  }
}

function assertAttachmentFileOperationRenderer(
  event: IpcMainInvokeEvent,
  input: LocalFileOperationInput | undefined,
  capability: string,
): void {
  if (input?.threadId !== undefined || input?.attachmentId !== undefined) {
    assertMainRenderer(event, capability);
  }
}

function stagedAttachmentBuffer(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

async function handleAssetCommand(
  event: IpcMainInvokeEvent,
  command: AssetCommand,
  args: Record<string, unknown>,
) {
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
    case 'ingest_local_file': {
      // The ingest bridge (agent working file -> committed outliner asset). Unlike
      // ingest_asset, this takes a path -- but only one inside the agent's trusted
      // roots (workdir/scratch), gated by the same check that backs preview/open of
      // these chips. The renderer can only name a file it could already preview, so
      // this does NOT reopen the arbitrary-local-file read primitive that
      // ingest_asset's buffer-only rule guards against. Directories are rejected.
      const file = await resolveTrustedLocalFileReference(
        (args as { path?: unknown }).path,
        [agentLocalFileRoot, agentScratchRoot],
      );
      if (!file || file.entryKind !== 'file') return null;
      return assetService.ingest({ kind: 'path', path: file.path });
    }
    case 'ingest_thread_resource': {
      assertMainRenderer(event, 'Thread resource ingest');
      return ingestThreadResourceAsset(args, {
        readResource: (threadId, ref) => threadService
          .readReferencedThreadResource(threadId, ref)
          .catch(() => null),
        ingestResource: (bytes, ref) => assetService.ingest({
          kind: 'buffer',
          data: bytes,
          mimeType: ref.mimeType,
          originalFilename: ref.fileName,
        }),
      });
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
    case 'pick_attachment_files': {
      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const dialogStrings = getMessages(effectiveLocale()).window;
      const options = {
        title: dialogStrings.insertAttachmentTitle,
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      return Promise.all(result.filePaths.map((path) => assetService.ingest({ kind: 'path', path })));
    }
    case 'open_asset': {
      const path = await assetService.pathFor(String(args.id));
      if (!path) return { opened: false };
      const pathStat = await stat(path);
      if (!isSafeLocalFileOpenTarget({ entryKind: 'file', path, stats: pathStat })) return { opened: false };
      await shell.openPath(path);
      return { opened: true };
    }
    case 'reveal_asset': {
      const path = await assetService.pathFor(String(args.id));
      if (path) shell.showItemInFolder(path);
      return { revealed: Boolean(path) };
    }
    case 'copy_asset_file': {
      const path = await assetService.pathFor(String(args.id));
      if (!path) return { copied: false };
      copyFilePathToClipboard(path);
      return { copied: true };
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

function copyFilePathToClipboard(path: string): void {
  clipboard.writeText(path);
  if (process.platform !== 'darwin') return;
  const fileUrl = pathToFileURL(path).toString();
  clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf8'));
  clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` +
    `<plist version="1.0"><array><string>${escapeXml(path)}</string></array></plist>`,
    'utf8',
  ));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

function errorReportFromIpc(raw: unknown, defaultDomain: string): ErrorReport {
  const input = isRecord(raw) ? raw : {};
  const error = isRecord(input.error) ? {
    ...(typeof input.error.name === 'string' ? { name: input.error.name } : {}),
    ...(typeof input.error.message === 'string' ? { message: input.error.message } : {}),
    ...(typeof input.error.stack === 'string' ? { stack: input.error.stack } : {}),
  } : undefined;
  const message = typeof input.message === 'string' && input.message.trim()
    ? input.message
    : error?.message ?? 'Renderer error';
  return {
    domain: typeof input.domain === 'string' && input.domain.trim() ? input.domain : defaultDomain,
    severity: severityFromIpc(input.severity),
    ...(typeof input.code === 'string' && input.code.trim() ? { code: input.code } : {}),
    message,
    ...(input.context ? { context: contextFromIpc(input.context) } : {}),
    ...(error ? { error } : {}),
  };
}

function severityFromIpc(value: unknown): ErrorSeverity {
  return value === 'warn' || value === 'error' || value === 'fatal' ? value : 'error';
}

function contextFromIpc(value: unknown): ErrorReportContext | undefined {
  if (!isRecord(value)) return undefined;
  const context: ErrorReportContext = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = contextValueFromIpc(entry);
    if (normalized !== undefined) context[key] = normalized;
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

function contextValueFromIpc(value: unknown): ErrorReportContext[string] | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, 20);
  if (items.every((item): item is string => typeof item === 'string')) return items;
  if (items.every((item): item is number => typeof item === 'number' && Number.isFinite(item))) return items;
  if (items.every((item): item is boolean => typeof item === 'boolean')) return items;
  return undefined;
}

async function diagnosticEnvironment(): Promise<DiagnosticEnvironment> {
  let providerId: string | null = null;
  try {
    providerId = (await getProviderSettings()).activeProviderId ?? null;
  } catch (error) {
    reportError({
      domain: 'provider',
      severity: 'warn',
      code: 'diagnostic-provider-read-failed',
      message: error instanceof Error ? error.message : String(error),
      context: { operation: 'diagnosticEnvironment' },
      error,
    });
  }
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    providerId,
  };
}

/**
 * Tell the windows that read provider settings to re-fetch, skipping the one that
 * wrote. Fanning a write back to its own sender was a real defect — the settings
 * window reapplies wholesale, so its own write reverted the user's other pending
 * changes — and even without a draft to lose it costs a settings round trip and a
 * list re-render for nothing. `origin` is undefined when main itself is the
 * writer, in which case every window hears it.
 */
function notifySettingsChanged(origin?: BrowserWindow | null): void {
  for (const target of [liveWindow(mainWindow), liveWindow(settingsWindow)]) {
    if (target && target !== origin) target.webContents.send(LIN_SETTINGS_CHANGED_CHANNEL);
  }
}

/**
 * Run the connection probe for a provider and store what it found. Failures here
 * are not the user's problem — a probe that cannot run leaves the row unverified,
 * which is the honest state and the one it started in.
 */
async function probeAndRecordConnection(providerIdInput: unknown): Promise<void> {
  const providerId = String(providerIdInput ?? '');
  if (!providerId) return;
  let connectionGeneration: number | undefined;
  try {
    const probe = await prepareProviderConnectionProbe({ providerId });
    connectionGeneration = probe.connectionGeneration;
    if (!probe.matchesStoredConnection || connectionGeneration === undefined) return;
    const result = await testProviderConnection(probe.input);
    const recorded = await recordProviderConnectionCheck(providerId, result, connectionGeneration);
    if (recorded) notifySettingsChanged();
  } catch {
    if (connectionGeneration !== undefined) {
      const recorded = await recordProviderConnectionCheck(providerId, null, connectionGeneration)
        .catch(() => false);
      if (recorded) notifySettingsChanged();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      // Ignore folders that are unavailable to the current OS account or do not exist.
    }
  }
  return paths;
}

async function rgFileNameMatches(query: string, limit: number): Promise<string[]> {
  const home = safeAppPath('home');
  if (!home) return [];
  const ripgrep = await resolveRipgrepCommand(home).catch(() => null);
  if (!ripgrep) return [];
  return new Promise((resolve) => {
    const results: string[] = [];
    const seen = new Set<string>();
    const lowerQuery = query.toLowerCase();
    const child = spawn(ripgrep.command, [...ripgrep.argsPrefix,
      '--files',
      '--hidden',
      '--glob', '!**/.git/**',
      '--glob', '!**/node_modules/**',
      '--glob', '!**/Library/**',
      home,
    ], { env: buildAgentLocalToolProcessEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
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
    if (officeOwnershipFileInfo(filePath)) continue;
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

async function rejectedOfficeOwnershipFile(filePath: string): Promise<{
  name: string;
  reason: 'officeOwnershipFile';
  suggestedName?: string;
} | null> {
  const ownershipFile = officeOwnershipFileInfo(filePath);
  if (!ownershipFile) return null;
  const suggestedPath = join(dirname(filePath), ownershipFile.suggestedName);
  const suggestedName = await stat(suggestedPath)
    .then((candidate) => candidate.isFile() ? ownershipFile.suggestedName : undefined)
    .catch(() => undefined);
  return {
    name: ownershipFile.name,
    reason: 'officeOwnershipFile',
    ...(suggestedName ? { suggestedName } : {}),
  };
}

async function localFileReferencePreview(file: TrustedLocalFileReference) {
  const mimeType = file.entryKind === 'directory' ? 'inode/directory' : inferMimeType(file.path);
  const [visual] = await withLocalFileIcons([{
    entryKind: file.entryKind,
    mimeType,
    name: basename(file.path),
    path: file.path,
  }]);
  return {
    entryKind: file.entryKind,
    path: file.path,
    name: basename(file.path),
    parentPath: dirname(file.path),
    mimeType,
    sizeBytes: file.entryKind === 'directory' ? 0 : file.stats.size,
    lastModified: file.stats.mtimeMs,
    ...(visual?.iconDataUrl ? { iconDataUrl: visual.iconDataUrl } : {}),
    ...(visual?.thumbnailDataUrl ? { thumbnailDataUrl: visual.thumbnailDataUrl } : {}),
  };
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
  setBoundedMapEntry(cache, key, value, LOCAL_FILE_CACHE_LIMIT);
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
    const mimeType = entryKind === 'directory' ? 'inode/directory' : inferMimeType(filePath);
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
    };
  } catch {
    return null;
  }
}

async function prepareAttachmentPromptImage(
  attachment: ThreadAttachmentContent,
  sourcePath: string,
): Promise<PreparedBoundedAgentImage> {
  return prepareBoundedAgentImage(sourcePath, attachment.name);
}

interface PreparedBoundedAgentImage {
  readonly bytes: Buffer;
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly fileName: string;
  readonly sourceDimensions: { readonly width: number; readonly height: number };
  readonly dimensions: { readonly width: number; readonly height: number };
}

async function prepareBoundedAgentImage(
  sourcePath: string,
  displayName: string,
  signal?: AbortSignal,
): Promise<PreparedBoundedAgentImage> {
  return agentImageObservationMutex.run(async () => {
    signal?.throwIfAborted();
    return prepareBoundedAgentImageUnlocked(sourcePath, displayName);
  });
}

async function prepareBoundedAgentImageBytes(
  sourceBytes: Buffer,
  sourceMimeType: string,
  displayName: string,
  signal?: AbortSignal,
): Promise<PreparedBoundedAgentImage> {
  return agentImageObservationMutex.run(async () => {
    signal?.throwIfAborted();
    if (sourceBytes.byteLength === 0) {
      throw new ImageObservationNormalizationError(`Image is empty: ${displayName}`);
    }
    if (sourceBytes.byteLength > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES) {
      throw new ImageObservationNormalizationError(
        `Image exceeds the ${formatFileSize(MAX_IMAGE_ATTACHMENT_SOURCE_BYTES)} image decode budget: ${displayName}`,
      );
    }
    let image = nativeImage.createFromBuffer(sourceBytes);
    if (image.isEmpty()) {
      throw new ImageObservationNormalizationError(`Image could not be decoded: ${displayName}`);
    }
    const sourceDimensions = image.getSize();
    const boundedSource = sourceBytes.byteLength <= MAX_PROMPT_IMAGE_BYTES
      && sourceDimensions.width <= MAX_PROMPT_IMAGE_DIMENSION
      && sourceDimensions.height <= MAX_PROMPT_IMAGE_DIMENSION;
    const normalizedSourceMimeType = sourceMimeType.trim().toLowerCase();
    if (boundedSource && (normalizedSourceMimeType === 'image/png' || normalizedSourceMimeType === 'image/jpeg')) {
      return {
        bytes: sourceBytes,
        mimeType: normalizedSourceMimeType,
        fileName: normalizedSourceMimeType === 'image/png' ? 'prompt.png' : 'prompt.jpg',
        sourceDimensions,
        dimensions: sourceDimensions,
      };
    }
    const scale = Math.min(
      1,
      MAX_PROMPT_IMAGE_DIMENSION / sourceDimensions.width,
      MAX_PROMPT_IMAGE_DIMENSION / sourceDimensions.height,
    );
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.floor(sourceDimensions.width * scale)),
        height: Math.max(1, Math.floor(sourceDimensions.height * scale)),
        quality: 'best',
      });
    }
    signal?.throwIfAborted();
    return encodeBoundedAgentImage(image, sourceDimensions, displayName);
  });
}

async function prepareBoundedAgentImageUnlocked(
  sourcePath: string,
  displayName: string,
): Promise<PreparedBoundedAgentImage> {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size <= 0) {
    throw new Error(`Image is not a readable regular file: ${displayName}`);
  }
  if (sourceStat.size > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES) {
    throw new Error(
      `Image exceeds the ${formatFileSize(MAX_IMAGE_ATTACHMENT_SOURCE_BYTES)} image decode budget: ${displayName}`,
    );
  }
  const sourceImage = nativeImage.createFromPath(sourcePath);
  if (sourceImage.isEmpty()) throw new Error(`Image could not be decoded: ${displayName}`);
  const sourceDimensions = sourceImage.getSize();
  let image = await nativeImage.createThumbnailFromPath(sourcePath, {
    width: MAX_PROMPT_IMAGE_DIMENSION,
    height: MAX_PROMPT_IMAGE_DIMENSION,
  });
  if (image.isEmpty()) throw new Error(`Image could not be decoded: ${displayName}`);

  return encodeBoundedAgentImage(image, sourceDimensions, displayName);
}

function encodeBoundedAgentImage(
  initialImage: NativeImage,
  sourceDimensions: { readonly width: number; readonly height: number },
  displayName: string,
): PreparedBoundedAgentImage {
  let image = initialImage;
  const png = image.toPNG();
  if (png.byteLength <= MAX_PROMPT_IMAGE_BYTES) {
    return {
      bytes: png,
      mimeType: 'image/png',
      fileName: 'prompt.png',
      sourceDimensions,
      dimensions: image.getSize(),
    };
  }

  for (;;) {
    for (const quality of [80, 70, 55, 40]) {
      const jpeg = image.toJPEG(quality);
      if (jpeg.byteLength <= MAX_PROMPT_IMAGE_BYTES) {
        return {
          bytes: jpeg,
          mimeType: 'image/jpeg',
          fileName: 'prompt.jpg',
          sourceDimensions,
          dimensions: image.getSize(),
        };
      }
    }
    const size = image.getSize();
    const width = Math.max(1, Math.floor(size.width * 0.75));
    const height = Math.max(1, Math.floor(size.height * 0.75));
    if (width === size.width && height === size.height) break;
    image = image.resize({ width, height, quality: 'best' });
  }
  throw new ImageObservationNormalizationError(
    `Image could not fit the model-input image budget: ${displayName}`,
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function safeAppPath(name: Parameters<typeof app.getPath>[0]): string | null {
  try {
    return app.getPath(name);
  } catch {
    return null;
  }
}

function inferMimeType(filePath: string): string {
  const sharedMimeType = mimeTypeForFilename(filePath);
  if (sharedMimeType) return sharedMimeType;
  const extension = extname(filePath).toLowerCase();
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
  if (extension === '.xml') return 'application/xml';
  if (extension === '.yaml' || extension === '.yml') return 'application/yaml';
  if (TEXT_ATTACHMENT_EXTENSIONS.has(extension)) return 'text/plain';
  return 'application/octet-stream';
}

async function sniffPreviewFileMimeType(filePath: string, fallback: string): Promise<string> {
  const handle = await open(filePath, 'r').catch(() => null);
  if (!handle) return fallback;
  try {
    const head = Buffer.alloc(512);
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    return sniffMimeType(head.subarray(0, bytesRead), filePath) ?? fallback;
  } finally {
    await handle.close();
  }
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

/**
 * Hands the renderer the same expanded paths the loader uses. The stored setting
 * may hold `~/skills` or `./skills`; the Skill library decides which rows belong
 * to a bound directory by comparing against each Skill's rootDir, which is
 * always expanded. Comparing the two forms matches nothing, so a bound
 * directory's Skills would lose their local chip and their unbind action while
 * the directory itself rendered, two rows down, as empty.
 */
/**
 * Keeps the user's own spelling of a directory they did not touch.
 *
 * The renderer only ever sees expanded paths, so it necessarily sends expanded
 * ones back — which would rewrite a stored `~/skills` or `./skills` into an
 * absolute path the first time anything is bound or unbound. `./skills` is the
 * costly one: frozen to whatever the agent workdir was at that moment, it stops
 * following the workspace, and the Skills in the next workspace's ./skills
 * quietly stop loading while the stale row lists as empty.
 */
function preserveStoredDirectoryForms(
  input: AgentRuntimeSettingsInput,
  stored: AgentRuntimeSettings,
): AgentRuntimeSettingsInput {
  if (!input.additionalSkillDirectories) return input;
  const byExpanded = new Map(stored.additionalSkillDirectories.map((dir) => (
    [expandSkillDirectory(dir, agentLocalFileRoot), dir]
  )));
  return {
    ...input,
    additionalSkillDirectories: input.additionalSkillDirectories.map((dir) => (
      byExpanded.get(expandSkillDirectory(dir, agentLocalFileRoot)) ?? dir
    )),
  };
}

function withCanonicalSkillDirectories(settings: AgentProviderSettingsView): AgentProviderSettingsView {
  // Applied to EVERY handler that returns this view, not just the two that look
  // skill-related. The renderer stores all of them into one settings state, so a
  // single un-expanded reply — switching provider, signing out — silently
  // restores the raw list and the library loses its local chips and unbind
  // actions until the pane is reopened.
  const expanded = settings.agent.additionalSkillDirectories
    .map((dir) => expandSkillDirectory(dir, agentLocalFileRoot))
    .filter(Boolean);
  return { ...settings, agent: { ...settings.agent, additionalSkillDirectories: expanded } };
}

/**
 * A reveal target must be a Skill location: a loaded Skill's own root, or a
 * directory the user bound. The renderer supplies the path, so this is the
 * authority — matching how lin:reveal-local-file and reveal_asset each gate to
 * their own trusted root rather than trusting the caller.
 */
async function isRevealableSkillLocation(target: string): Promise<boolean> {
  const resolved = resolve(target);
  const settings = await getAgentRuntimeSettings().catch(() => null);
  const bound = (settings?.additionalSkillDirectories ?? [])
    .map((dir) => expandSkillDirectory(dir, agentLocalFileRoot))
    .filter(Boolean);
  if (bound.some((dir) => isPathInside(dir, resolved))) return true;
  const skills = await skillRuntime.listAllSkills().catch(() => []);
  return skills.some((skill) => (
    // Managed content is pinned and immutable: resolveSkillContentTarget
    // refuses it for the same reason. Opening it invites the hand edit that
    // flips the record to `modified`, after which the Skill leaves the model's
    // catalog until it is reinstalled — so the fence holds here too, not only
    // in the UI that stopped offering the action.
    skill.source !== 'managed'
    && skill.rootDir.startsWith('/')
    && isPathInside(skill.rootDir, resolved)
  ));
}

async function managedSkillCommand<T>(operation: () => Promise<T> | T): Promise<ManagedSkillCommandResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: managedSkillErrorView(error) };
  }
}

async function handleAgentCommand(_event: IpcMainInvokeEvent, command: AgentCommand, args: Record<string, unknown>) {
  switch (command) {
    case 'agent_get_provider_settings':
      return withCanonicalSkillDirectories(await getProviderSettings());
    case 'agent_refresh_provider_models':
      return withCanonicalSkillDirectories(await refreshProviderModels(String(args.providerId)));
    case 'agent_pick_skill_directory': {
      // Tenon points at the directory; it never copies it in. The picker returns
      // a path the caller stores in additionalSkillDirectories, so the user's
      // files stay where they are and stay live.
      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const options = {
        title: getMessages(effectiveLocale()).window.chooseSkillDirectoryTitle,
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      const picked = result.canceled ? undefined : result.filePaths[0];
      if (!picked) return { path: null };
      // A bound directory is a CONTAINER of Skills. Picking the folder that is
      // itself a Skill is at least as natural, and binding it verbatim loaded
      // nothing and said nothing — the dead end that made the old picker
      // useless. Report the shape and let the caller bind the parent, rather
      // than inferring ownership per write, which is a different seam.
      const resolvedPick = resolve(picked);
      const isSkillFolder = await stat(join(resolvedPick, 'SKILL.md')).then(
        (entry) => entry.isFile(),
        () => false,
      );
      // Resolved here so the stored path is canonical. The renderer decides
      // which rows belong to a bound directory by comparing it against each
      // Skill's rootDir, and a trailing separator or a `.`/`..` segment would
      // match nothing — the directory's Skills would lose their local chip and
      // their actions, and the directory would list as if it were empty.
      return {
        path: resolvedPick,
        isSkillFolder,
        // Identity is the directory name, so this decides whether binding the
        // parent would actually surface it.
        nameValid: isValidSkillName(basename(resolvedPick)),
      };
    }
    case 'agent_reveal_skill_directory': {
      const target = String(args.path ?? '');
      if (!target) return { revealed: false };
      // Only Skill locations, like every neighbouring reveal gates to its own
      // trusted root. Without this the renderer could name any absolute path:
      // it would open Finder there, and the existence check below would answer
      // whether an arbitrary path exists.
      if (!(await isRevealableSkillLocation(target))) return { revealed: false };
      // showItemInFolder returns void and reports nothing, so check first. The
      // common case is the failing one: a bound directory that was renamed,
      // deleted, or unmounted is exactly what the user clicks Reveal to
      // investigate, and reporting success there is indistinguishable from a
      // genuinely empty folder.
      try {
        await stat(target);
      } catch {
        return { revealed: false };
      }
      shell.showItemInFolder(target);
      return { revealed: true };
    }
    case 'agent_update_runtime_settings': {
      const settings = await updateAgentRuntimeSettings(
        preserveStoredDirectoryForms(args.settings as AgentRuntimeSettingsInput, await getAgentRuntimeSettings()),
      );
      for (const runtime of [skillRuntime, ...turnSkillRuntimes.values()]) {
        runtime.updateAdditionalSkillDirectories(settings.agent.additionalSkillDirectories);
        runtime.updateDisabledSkills(settings.agent.disabledSkills ?? []);
      }
      return withCanonicalSkillDirectories(settings);
    }
    case 'agent_update_image_generation_settings':
      return withCanonicalSkillDirectories(await updateImageGenerationSettings(args.settings as AgentImageGenerationSettingsInput));
    case 'agent_get_capability_settings':
      return readAgentCapabilitySettingsView();
    case 'agent_apply_capability_settings_patch':
      return applyAgentCapabilitySettingsPatchView(args.patch as {
        removeBlocks?: unknown;
      });
    case 'agent_append_capability_block':
      return appendAgentCapabilityBlockView(String(args.ruleValue ?? ''));
    case 'agent_upsert_provider_config': {
      const input = args.provider as AgentProviderConfigInput;
      const settings = withCanonicalSkillDirectories(await upsertProviderConfig(input));
      // Prove the connection AFTER committing it when the caller says this was a
      // connection save. The same upsert command also backs the provider-list
      // enable switch; that switch must not spend a billed completion merely to
      // change local activation state.
      //
      // Saving a credential is the
      // user's intent and must not wait on a network round trip — the window
      // closes at once, which is also why there is no timeout to design here and
      // no "can I close mid-probe" question to answer. The verdict lands on the
      // row when it arrives and the broadcast refreshes whoever is looking.
      //
      // This is one of exactly two things that probe: an explicit write, and the
      // explicit Test button. Nothing probes on open, on a schedule, or in the
      // background, because the probe bills a 1-token completion.
      if (args.probeConnection === true) void probeAndRecordConnection(input.providerId);
      return settings;
    }
    case 'agent_delete_provider_config':
      return withCanonicalSkillDirectories(await deleteProviderConfig(String(args.providerId)));
    case 'agent_set_active_provider':
      return withCanonicalSkillDirectories(await setActiveProvider(String(args.providerId)));
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
      const providerId = String(args.providerId);
      const settings = withCanonicalSkillDirectories(await oauthLoginManager.startLogin(providerId, (envelope) => {
        if (loginWindow && !loginWindow.isDestroyed()) {
          loginWindow.webContents.send(LIN_AGENT_OAUTH_EVENT_CHANNEL, envelope);
        }
      }));
      // A successful sign-in is a credential write just like saving an API key.
      // Keep the login response fast, then persist the same conservative probe
      // verdict the API-key path records in the background.
      void probeAndRecordConnection(providerId);
      return settings;
    }
    case 'agent_oauth_logout':
      return withCanonicalSkillDirectories(await oauthLoginManager.logout(String(args.providerId)));
    case 'agent_oauth_respond':
      oauthLoginManager.respond(String(args.requestId), args.value === undefined ? undefined : String(args.value));
      return undefined;
    case 'agent_oauth_cancel':
      oauthLoginManager.cancel(String(args.providerId));
      return undefined;
    case 'agent_test_provider_connection': {
      const providerId = String(args.providerId);
      const apiKeyOverride = typeof args.apiKey === 'string' && args.apiKey.trim().length > 0;
      const probe = await prepareProviderConnectionProbe({
        providerId,
        baseUrl: typeof args.baseUrl === 'string' ? args.baseUrl : undefined,
        apiKey: apiKeyOverride ? args.apiKey as string : undefined,
        baseUrlOverride: Object.prototype.hasOwnProperty.call(args, 'baseUrl'),
        apiKeyOverride,
      });
      const result = await testProviderConnection(probe.input);
      // An explicit Test is the other thing allowed to probe, so its answer is
      // kept rather than thrown away the moment the dialog closes — which is how
      // "Ready" came to mean "has a credential" instead of "works". Recorded only
      // when it probed the STORED connection: a test against a key typed into the
      // form but not saved is not a verdict about what is on disk.
      if (probe.matchesStoredConnection && probe.connectionGeneration !== undefined) {
        const recorded = await recordProviderConnectionCheck(
          providerId,
          result,
          probe.connectionGeneration,
        ).catch(() => false);
        if (recorded) notifySettingsChanged();
      }
      return result;
    }
    case 'agent_list_all_skills':
      return args.userInvocableOnly === true
        ? skillRuntime.listUserInvocableSkills()
        : skillRuntime.listAllSkills();
    case 'agent_undo_skill_agent_edit': {
      await skillRuntime.undoLastAgentSkillEdit(String(args.skillName));
      await refreshTurnSkillProvenanceRecords();
      return skillRuntime.listAllSkills();
    }
    case 'agent_managed_skill_catalog':
      return managedSkillCommand(() => managedSkillService.loadCatalog());
    case 'agent_managed_skill_discover':
      return managedSkillCommand(() => managedSkillService.discover({
        sourceUrl: typeof args.sourceUrl === 'string' ? args.sourceUrl : undefined,
        catalogId: typeof args.catalogId === 'string' ? args.catalogId : undefined,
      }));
    case 'agent_managed_skill_install':
      return managedSkillCommand(() => managedSkillService.install({
        discoveryId: String(args.discoveryId ?? ''),
        candidateId: String(args.candidateId ?? ''),
        expectedCommit: String(args.expectedCommit ?? ''),
      }));
    case 'agent_managed_skill_list':
      return managedSkillCommand(() => managedSkillService.list());
    case 'agent_managed_skill_check_updates':
      // The throttle window is main's policy, so the renderer only says whether
      // the check was ambient — it never carries the number.
      return managedSkillCommand(() => managedSkillService.checkUpdates(
        typeof args.skillId === 'string' ? args.skillId : undefined,
        args.ambient === true ? { throttleMs: MANAGED_SKILL_UPDATE_THROTTLE_MS } : undefined,
      ));
    case 'agent_managed_skill_preview_update':
      return managedSkillCommand(() => managedSkillService.previewUpdate({
        skillId: String(args.skillId ?? ''),
        expectedActiveHash: String(args.expectedActiveHash ?? ''),
      }));
    case 'agent_managed_skill_apply_update':
      return managedSkillCommand(() => managedSkillService.applyUpdate({
        skillId: String(args.skillId ?? ''),
        previewId: String(args.previewId ?? ''),
        expectedActiveHash: String(args.expectedActiveHash ?? ''),
        expectedCandidateHash: String(args.expectedCandidateHash ?? ''),
      }));
    case 'agent_managed_skill_set_enabled': {
      return managedSkillCommand(() => {
        if (typeof args.enabled !== 'boolean') {
          throw new ManagedSkillServiceError('invalid_request', 'Managed skill enabled state must be boolean.');
        }
        return managedSkillService.setEnabled({
          skillId: String(args.skillId ?? ''),
          enabled: args.enabled,
          expectedActiveHash: String(args.expectedActiveHash ?? ''),
        });
      });
    }
    case 'agent_managed_skill_rollback':
      return managedSkillCommand(() => managedSkillService.rollback({
        skillId: String(args.skillId ?? ''),
        expectedActiveHash: String(args.expectedActiveHash ?? ''),
        expectedPreviousHash: String(args.expectedPreviousHash ?? ''),
      }));
    case 'agent_managed_skill_uninstall':
      return managedSkillCommand(() => managedSkillService.uninstall({
        skillId: String(args.skillId ?? ''),
        expectedActiveHash: String(args.expectedActiveHash ?? ''),
      }));
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

  app.whenReady().then(async () => {
    // Restore persisted dynamic model catalogs before Threads or Automations can
    // resolve a saved model. The same best-effort pass cleans legacy keyless rows;
    // neither local catalog corruption nor cleanup failure may block app startup.
    await reconcileProviderConfig().catch(() => { /* best-effort; catalog reads remain guarded */ });
    await documentService.initWorkspace();
    await threadService.initialize();
    await memoryExtension.startWorker();
    await automationService.start();
    powerMonitor.on('resume', wakeAutomationsOnResume);
    await nodeAccessStore.load().catch((error) => {
      reportError({
        domain: 'node-access',
        severity: 'warn',
        code: 'node-access-startup-load',
        message: 'Node access store startup load failed',
        context: { operation: 'startup-load' },
        error,
      });
    });
    await importApiServer.start().catch((error) => {
      reportError({
        domain: 'agent',
        severity: 'warn',
        code: 'tenon-import-api-startup',
        message: 'Tenon import API startup failed',
        context: { operation: 'startup' },
        error,
      });
    });
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
      return assetService.serve(id, request);
    });
    protocol.handle(PREVIEW_LOCAL_URL_SCHEME, (request) => {
      const token = new URL(request.url).hostname;
      return localFilePreviewStreams.serve(token, request);
    });
    // Apply the persisted appearance preference before any window is created, so
    // the first paint (prePaintBackgroundColor → shouldUseDarkColors) already
    // matches the chosen theme rather than the OS default.
    nativeTheme.themeSource = loadAppPreferences().theme;
    configureSessionSecurity();
    urlPreviewSession = session.fromPartition(URL_PREVIEW_WEBVIEW_PARTITION);
    configureUrlPreviewSession(urlPreviewSession);
    registerIpc();
    createWindow();
    scheduleManagedSkillUpdateCheck();
    // Prewarm the hidden launcher window and bind the global toggle hotkey.
    const launcherWindow = createLauncherWindow({
      preloadPath: join(__dirname, '../preload/launcher.cjs'),
      devUrl: RENDERER_DEV_ORIGIN ? `${RENDERER_DEV_ORIGIN}/launcher.html` : null,
      packagedHtmlPath: join(__dirname, '../renderer/launcher.html'),
      harden: hardenWebContents,
      onBlurHide: dismissLauncher,
    });
    // Least privilege at the seam, not only in the preload bundle: no
    // `appCommands` (so `lin:invoke` is refused before dispatch) and no
    // `actionAttestation` (so `view` / `workspace` facts stay the main
    // renderer's to attest).
    registerRendererCapabilities(launcherWindow.webContents, LAUNCHER_RENDERER_CAPABILITIES);
    // Tenon is a regular foreground app (dock icon + menu bar). In dev, launching
    // the binary straight from the terminal (not via LaunchServices) can leave the
    // app in macOS "accessory" activation policy (background-only → no dock icon, no
    // ⌘Tab); `app.dock.show()` does NOT reliably restore it (it only un-does an
    // explicit `dock.hide()`), so we assert the regular policy here. This is
    // idempotent for a normally-launched packaged app. (The separate packaged
    // dock-hiding bug — the launcher's all-Spaces behavior transforming the app to
    // an accessory process, electron#26350 — is fixed in launcherWindow.ts via the
    // `skipTransformProcessType` option on setVisibleOnAllWorkspaces.) Does not
    // affect the launcher panel's per-window non-activating behavior.
    if (process.platform === 'darwin') app.setActivationPolicy('regular');
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

  app.on('before-quit', (event) => {
    if (quitAfterFlush) return;
    event.preventDefault();
    quitAfterFlush = true;
    // We force-exit below (app.exit bypasses will-quit), so do the on-quit cleanup
    // here: release the global hotkey(s).
    unregisterLauncherHotkeys();
    powerMonitor.removeListener('resume', wakeAutomationsOnResume);
    pageTranslationService.dispose();
    // Settle in-flight writes, then exit. We force-exit instead of re-issuing
    // app.quit(): after preventDefault() cancels the OS ⌘Q terminate, Electron's
    // graceful re-quit lingers for seconds before the process actually exits, so ⌘Q
    // reads as "didn't quit, press again". But a bare exit would truncate in-flight
    // async writes, so we first drain them — the document mutation queue and the
    // Thread rollout/state writes — bounded by a hard timeout so a slow write
    // cannot block quit indefinitely.
    void Promise.race([
      Promise.allSettled([
        documentService.flushPendingChanges(),
        nodeAccessStore.flushNow(),
        previewTranslationCache.flushNow(),
        importApiServer.stop(),
        closeAgentServices(memoryExtension, threadService, automationService),
        diagnosticLog.flushNow({ reason: 'before-quit' }),
        flushUrlPreviewSession(urlPreviewSession),
      ]),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]).finally(() => app.exit(0));
  });
}
