import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, protocol, shell } from 'electron';
import type { IpcMainInvokeEvent, NativeImage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, watch } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { registerDesktopOutlineIpc } from './outlineClient';
import {
  STARTUP_GET_CHANNEL,
  STARTUP_QUIT_CHANNEL,
  STARTUP_RETRY_CHANNEL,
  STARTUP_STATE_CHANNEL,
} from '../core/startup';
import { runOutlineActionCommand } from './outlineActionCommands';
import { AppQuitCoordinator, type QuitDecision } from './appQuitCoordinator';
import {
  mimeTypeForAssetFilename as mimeTypeForFilename,
  sniffAssetMimeType as sniffMimeType,
} from '../core/assetMetadata';
import { resolveRendererThreadStartDefaults } from './agent/rendererThreadStartDefaults';
import { MODEL_TOOL_CATALOG, canonicalModelToolKey } from '../core/agent/tools';
import type { ConfigurationLayerTarget } from './agent/AgentConfigurationWriter';
import { createImageArtifactReference, ImageObservationNormalizationError } from './agent/imageArtifacts';
import { Mutex } from './agent/Mutex';
import { resolveToolTaskSupervisorRuntime } from './agent/tasks/toolTaskRuntime';
import { resolveDelegateCliRuntime } from './delegateRuntime';
import { expandSkillDirectory } from './agent/capabilities/agentSkills';
import { isValidSkillName } from './agent/capabilities/agentSkillAuthoring';
import {
  decodeMemoryFeatureMode,
  decodeThreadMemoryMode,
  memoryTagId,
} from '../core/agent/memory';
import { decodeThreadResourceReference } from '../core/agent/codec';
import { threadTranscriptRoot } from './agent/thread/ThreadTranscriptArtifact';
import { threadTranscriptIndexPath } from './agent/thread/ThreadTranscriptIndex';
import {
  AUTOMATION_NOTIFICATION_CHANNEL,
  AUTOMATION_REQUEST_CHANNEL,
  AUTOMATION_METHODS,
  type AutomationMethod,
} from '../core/agent/automation';
import {
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
  ThreadMessageContextMenuAction,
  ThreadMessageContextMenuRequest,
} from '../core/agent/protocol';
import { projectAgentCoreNotification, projectAgentCoreResponse } from '../core/agent/rendererProjection';
import {
  type EffectiveThreadConfiguration,
} from '../core/agent/configuration';
import {
  AGENT_CORE_NOTIFICATION_CHANNEL,
  AGENT_CORE_REQUEST_CHANNEL,
  THREAD_MESSAGE_CONTEXT_MENU_CHANNEL,
} from '../core/agent/transport';
import {
  ManagedSkillServiceError,
  managedSkillErrorView,
} from './managedSkillService';
import type { ProviderConfigMode } from '../core/settingsWindow';
import {
  ASSET_URL_SCHEME,
  PREVIEW_LOCAL_URL_SCHEME,
  assetIdFromUrl,
  previewLocalUrl,
} from '../core/assets';
import {
  isUrlPageTranslationCommand,
  LIN_CLEAR_PREVIEW_TRANSLATION_CACHE_CHANNEL,
} from '../core/urlPageTranslation';
import { LIN_URL_PAGE_TRANSLATION_GUEST_CHANNEL } from '../core/urlPageTranslationGuest';
import {
  LIN_CLEAR_URL_PREVIEW_DATA_CHANNEL,
} from '../core/urlPreviewSession';
import { handlePreviewCommand } from './previewSource';
import { ingestThreadResourceAsset } from './threadResourceAssetIngest';
import { executeUrlPageTranslationGuestCommand } from './urlPageTranslationGuest';
import {
  LIN_AGENT_OAUTH_EVENT_CHANNEL,
  DAILY_NOTES_ID,
  type AgentCapabilityCatalog,
  type AgentEditorView,
  type AgentProfileDraft,
  type AssetIngestInput,
} from '../core/types';
import {
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
  rankedModels,
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
  isPreviewCommand,
  type AgentCommand,
  type AssetCommand,
} from '../core/commands';
import { oauthLoginManager } from './agent/capabilities/agentOAuthManager';
import { IPC_TRACE_ENABLED, traceIpc } from './ipcTrace';
import type {
  AgentImageGenerationSettingsInput,
  AgentProviderConfigInput,
  AgentRuntimeSettingsInput,
  AgentRuntimeSettings,
  AgentProviderSettingsView,
  ManagedSkillCommandResult,
} from '../core/types';
import {
  clearLastAgentThreadConfiguration,
  loadAppPreferences,
  saveLastAgentThreadConfiguration,
} from './appPreferences';
import { DEFAULT_FILE_PREFERENCES, loadFilePreferences } from './configuration/filePreferences';
import { writeFilePreferencesStatus } from './configuration/status';
import { writeFilePreferencesSchema } from './configuration/schema';
import type { ThemeMode } from '../core/theme';
import { getMessages } from '../core/i18n';
import { APP_NAME } from '../core/brand';
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  MAX_IMAGE_ATTACHMENT_SOURCE_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_DIMENSION,
} from '../core/agentAttachmentLimits';
import { isPathInside } from './agent/capabilities/agentAttachmentMaterialization';
import {
  rendererHasCapability,
} from './rendererCapabilities';
import {
  ACTION_AMBIENT_SEED_RESPONSE_CHANNEL,
  ACTION_EVENT_CHANNEL,
  ACTION_OBJECT_QUERY_CHANNEL,
  ACTION_OPEN_CHANNEL,
  ACTION_PARAMETER_QUERY_CHANNEL,
  ACTION_REQUEST_CHANNEL,
  ACTION_STEP_ACK_CHANNEL,
} from '../core/actions/transport';
import type {
  ActionRequest,
  InvocationEvent,
  InvocationSeed,
  ObjectQueryRequest,
  ParameterObjectQueryRequest,
} from '../core/actions/types';
import type { LauncherInitialState } from '../core/launcher/commands';
import {
  hasExplicitAgentLocalRoot,
  removeAgentConversationWorkspace,
  resolveAgentConversationWorkspace,
  resolveAgentScratchRoot,
  resolveAgentWorkdir,
} from './agent/capabilities/agentLocalRoot';
import { DiagnosticLogStore } from './diagnosticLog';
import {
  LIN_APP_UPDATE_CHECK_CHANNEL,
  LIN_APP_UPDATE_GET_CHANNEL,
  LIN_APP_UPDATE_OPEN_CHANNEL,
  LIN_APP_UPDATE_SET_AUTOMATIC_CHANNEL,
  type AppUpdateView,
} from '../core/appUpdate';
import {
  HostTransportComposition,
  type OwnedIpcMain,
  type TransportOwner,
} from './hostTransport/ownership';
import { createOutlineDesktopHost } from './hostDomain/outlineDesktopHost';
import { createAgentHost } from './hostDomain/agentHost';
import { createResourcePreviewHost } from './hostPlatform/resourcePreviewHost';
import type { LocalFileOperationInput } from './hostPlatform/nativeLocalFileHost';
import { createWindowApplicationHost } from './hostPlatform/windowApplicationHost';
import { DesktopHostLifecycle, type DesktopHostPhase } from './desktopHostLifecycle';
import { ResourceScope } from './resourceScope';

export interface DesktopHostEnvironment {
  readonly userDataDir: string;
  readonly moduleDir: string;
  readonly diagnosticLog: DiagnosticLogStore;
  readonly reportError: (report: ErrorReport) => void;
  readonly releaseBootstrapEffects: () => void;
}

export interface DesktopHost {
  start(): Promise<void>;
  requestQuit(): Promise<void>;
  focusSecondInstance(): void;
  allWindowsClosed(): void;
  phase(): DesktopHostPhase;
}

export function createDesktopHost(environment: DesktopHostEnvironment): DesktopHost {
const resolvedUserDataDir = environment.userDataDir;
const hostSessionId = randomUUID();
const diagnosticLog = environment.diagnosticLog;
const reportError = environment.reportError;
const resources = new ResourceScope('desktop-host');
const bootstrapEffects = new ResourceScope('desktop-host/bootstrap-effects');
bootstrapEffects.defer('main-process-and-app-listeners', environment.releaseBootstrapEffects);
const devEffects = resources.child('dev-effects');
const transportEffects = resources.child('transport');
const windowEffects = resources.child('window-application');
const backgroundEffects = resources.child('background-effects');
let applyFilePreferencesNow: (() => void) | null = null;

// Image file extensions for the native "insert image" picker. The filter's display
// name is localized at the call site (it shows in the OS dialog).
const IMAGE_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'];

const APP_ICON_PNG_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(environment.moduleDir, '../../build/icon.png');
const outlineHost = createOutlineDesktopHost({
  userDataDir: resolvedUserDataDir,
  moduleDir: environment.moduleDir,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath,
  reportError,
  hostSessionId,
  ready: (service) => lifecycle.ready(service),
});
const {
  assetExportRoot: outlineAssetExportRoot,
} = outlineHost;

let quitCoordinator: AppQuitCoordinator;
let mainTransport: TransportOwner | null = null;
const agentLocalFileRoot = resolveAgentWorkdir({
  envLocalRoot: process.env.LIN_AGENT_LOCAL_ROOT,
  userDataPath: app.getPath('userData'),
});
const agentScratchRoot = resolveAgentScratchRoot({ userDataPath: app.getPath('userData') });
const hasExplicitAgentRoot = hasExplicitAgentLocalRoot(process.env.LIN_AGENT_LOCAL_ROOT);
// The workspace collection and scratch roots are app-owned. An explicit
// `LIN_AGENT_LOCAL_ROOT` is user-owned and must already exist.
function ensureAgentDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error(`[agent] failed to create directory ${dir} at startup`, error);
  }
}
if (!hasExplicitAgentRoot) {
  ensureAgentDir(agentLocalFileRoot);
}
ensureAgentDir(agentScratchRoot);
const resourcePreviewHost = createResourcePreviewHost({
  userDataDir: resolvedUserDataDir,
  rendererDevUrl: process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL,
  previewRoots: () => [agentLocalFileRoot, agentScratchRoot, outlineAssetExportRoot],
  localFileRoots: () => [agentLocalFileRoot, agentScratchRoot],
  resolveAttachmentFile: async (threadId, attachmentId) => {
    await lifecycle.ready('agent');
    return agentHost.threads.resolveAttachmentFile(threadId, attachmentId);
  },
  resolveResourceFile: async (threadId, ref, intent) => {
    await lifecycle.ready('agent');
    return intent === 'source'
      ? agentHost.threads.resolveThreadResourceSource(threadId, ref)
      : agentHost.threads.resolveThreadResourceFile(threadId, ref);
  },
  reportError,
});
// An available Skill update should be visible without going looking for it, but
// nothing about that is urgent enough to spend the launch path on. So: one
// throttled sweep per launch, deferred until after first paint, fire-and-forget.
// No periodic polling while the app sits open, no auto-download, no auto-apply.
const MANAGED_SKILL_UPDATE_THROTTLE_MS = 6 * 60 * 60 * 1_000;
const MANAGED_SKILL_UPDATE_STARTUP_DELAY_MS = 30_000;
const APP_UPDATE_STARTUP_DELAY_MS = 10_000;

function scheduleManagedSkillUpdateCheck(): void {
  const timer = setTimeout(() => {
    // Failure records an update_failed diagnostic on the record and does nothing
    // else (A12): no alert, nothing blocked, no Skill's enabled state or pinned
    // version touched. The throttle stamps lastCheckedAt on failure too, so a
    // record that keeps failing is retried on the same schedule as one that
    // succeeds rather than on every launch.
    void agentHost.skills.catalog
      .checkUpdates(undefined, { throttleMs: MANAGED_SKILL_UPDATE_THROTTLE_MS })
      .catch(() => { /* recorded on the record; retried next launch */ });
  }, MANAGED_SKILL_UPDATE_STARTUP_DELAY_MS);
  backgroundEffects.defer('managed-skill-update-timer', () => clearTimeout(timer));
  // Never hold the event loop open on this.
  timer.unref?.();
}

function scheduleAppUpdateCheck(): void {
  const timer = setTimeout(() => {
    void windowApplicationHost.updates.checkInBackground();
  }, APP_UPDATE_STARTUP_DELAY_MS);
  backgroundEffects.defer('app-update-timer', () => clearTimeout(timer));
  timer.unref?.();
}

function startFilePreferencesWatcher(): void {
  const configDir = join(resolvedUserDataDir, 'config');
  ensureAgentDir(configDir);
  writeFilePreferencesSchema(resolvedUserDataDir);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let applying = false;
  let pendingApply = false;
  let effectivePreferences = DEFAULT_FILE_PREFERENCES;
  const apply = () => {
    if (applying) {
      pendingApply = true;
      return;
    }
    applying = true;
    timer = null;
    const loaded = loadFilePreferences(resolvedUserDataDir);
    writeFilePreferencesStatus(resolvedUserDataDir, hostSessionId, loaded, {
      effective: effectivePreferences,
      applicationStatus: 'pending',
    });
    const { appearance } = loaded.preferences;
    if (windowApplicationHost.theme() !== appearance.theme) {
      windowApplicationHost.setTheme(appearance.theme);
    }
    if (typeof appearance.language === 'string' && windowApplicationHost.effectiveLocale() !== appearance.language) {
      windowApplicationHost.setLocale(appearance.language);
    }
    void Promise.all([
      getAgentRuntimeSettings().then((settings) => {
        agentHost.skills.updateRuntimeSettings(settings);
      }),
      Promise.resolve(agentHost.memory.settings()).then((current) => {
        const mode = loaded.preferences.agent.memory.enabled ? 'enabled' : 'disabled';
        return current.status.featureMode === mode ? undefined : agentHost.memory.setFeatureMode(mode);
      }),
      windowApplicationHost.updates.applyAutomaticChecksEnabled(loaded.preferences.updates.checkAutomatically),
    ]).then(() => {
      effectivePreferences = loaded.preferences;
      writeFilePreferencesStatus(resolvedUserDataDir, hostSessionId, loaded, {
        effective: effectivePreferences,
        applicationStatus: 'applied',
      });
    }).catch((error) => {
      writeFilePreferencesStatus(resolvedUserDataDir, hostSessionId, loaded, {
        effective: effectivePreferences,
        applicationStatus: 'failed',
        applicationError: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      applying = false;
      if (pendingApply) {
        pendingApply = false;
        queueMicrotask(apply);
      }
    });
  };
  applyFilePreferencesNow = apply;
  const watcher = watch(configDir, { persistent: false }, (_event, filename) => {
    if (filename && filename.toString() !== 'settings.jsonc') return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(apply, 100);
  });
  const initial = loadFilePreferences(resolvedUserDataDir);
  writeFilePreferencesStatus(resolvedUserDataDir, hostSessionId, initial, {
    effective: effectivePreferences,
    applicationStatus: 'pending',
  });
  resources.defer('file-preferences-watcher', () => {
    watcher.close();
    if (timer !== null) clearTimeout(timer);
    if (applyFilePreferencesNow === apply) applyFilePreferencesNow = null;
  });
}

const agentImageObservationMutex = new Mutex();
const agentHost = createAgentHost({
  userDataDir: resolvedUserDataDir,
  scratchRoot: agentScratchRoot,
  defaultCwd: agentLocalFileRoot,
  appVersion: app.getVersion(),
  toolTaskSupervisorRuntime: resolveToolTaskSupervisorRuntime({
    isPackaged: app.isPackaged,
    moduleDir: environment.moduleDir,
    resourcesPath: process.resourcesPath,
    processExecPath: process.execPath,
  }),
  delegateCliRuntime: resolveDelegateCliRuntime({
    isPackaged: app.isPackaged,
    moduleDir: environment.moduleDir,
    resourcesPath: process.resourcesPath,
    processExecPath: process.execPath,
  }),
  loadRuntimeSettings: getAgentRuntimeSettings,
  timeline: outlineHost.timeline,
  reportError,
  prepareImageArtifact: async ({ threadId, attachment, sourcePath, writeResource }) => {
    const snapshot = await prepareAttachmentPromptImage(attachment, sourcePath);
    const written = await writeResource(
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
  createTurnExecutorOptions: ({ configuration }) => ({
    transcriptIndexPath: threadTranscriptIndexPath(threadTranscriptRoot(resolvedUserDataDir)),
    // One name, wherever it is drawn or spoken: the prompt now asks configuration
    // who this agent is instead of hard-coding a name the transcript disagreed
    // with. Delegated Threads are hidden and use no renderer identity catalog.
    resolvePersona: (thread) => configuration.resolveThreadPersona(thread, reportError),
  }),
  createThreadOptions: ({ configuration, worktrees }) => ({
    resolveRootWorkspace: async (threadId) => {
      if (hasExplicitAgentRoot) return agentLocalFileRoot;
      const workspace = resolveAgentConversationWorkspace({
        userDataPath: resolvedUserDataDir,
        threadId,
      });
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      return workspace;
    },
    cleanupRootWorkspace: hasExplicitAgentRoot ? undefined : async (threadId, cwd) => {
      await removeAgentConversationWorkspace({
        userDataPath: resolvedUserDataDir,
        threadId,
        cwd,
      });
    },
    ownsRootWorkspace: hasExplicitAgentRoot ? undefined : (threadId, cwd) => (
      resolve(cwd) === resolve(resolveAgentConversationWorkspace({
        userDataPath: resolvedUserDataDir,
        threadId,
      }))
    ),
    resolveConfiguration: (request) => configuration.resolveProfile(
      request.configurationProfile,
      request.cwd,
    ),
    resolveIdentityCatalog: (cwd, reportFailure) => (
      configuration.resolveIdentityCatalogForUserPath(cwd, reportFailure)
    ),
    resolvePersona: (thread, reportFailure) => (
      configuration.resolveThreadPersona(thread, reportFailure)
    ),
    reportError,
    resolveRendererStartDefaults: (request) => resolveRendererThreadStartDefaults({
      request,
      remembered: loadAppPreferences().lastAgentThreadConfiguration,
      cwd: agentLocalFileRoot,
      getProviderRuntimeConfig,
      getActiveProviderRuntimeConfig,
      validateRememberedSelection: (selection, provider) => {
        validateAgentModelSelection(selection.model, selection.reasoningEffort, provider);
      },
    }),
    validateRendererConfiguration: async (selection) => {
      const provider = await getProviderRuntimeConfig(selection.modelProvider);
      if (!provider) throw new Error(`Provider is not configured: ${selection.modelProvider}`);
      validateAgentModelSelection(selection.model, selection.reasoningEffort, provider);
    },
    onRendererConfigurationCommitted: saveLastAgentThreadConfiguration,
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
    getDocumentProjection: () => outlineHost.document.getProjection(),
    resolveReferencedAsset: async (assetId) => {
      const [path, metadata] = await Promise.all([
        outlineHost.assets.pathFor(assetId),
        outlineHost.assets.lookup(assetId),
      ]);
      return path ? { path, metadata } : null;
    },
  }),
  createAdmissionSkillRuntimeOptions: ({ thread, configuration }) => ({
    localRoot: thread.cwd,
    threadId: thread.id,
    enabledSkills: configuration.skills,
  }),
  createTurnSkillRuntimeOptions: (context) => ({
    localRoot: context.thread.cwd,
    threadId: context.thread.id,
    enabledSkills: context.configuration.skills,
  }),
  createToolOptions: () => ({
    disabledTools: async () => (await getAgentRuntimeSettings()).disabledTools ?? [],
    imageNormalizer: async ({ filePath, signal }) => {
      return prepareBoundedAgentImage(filePath, basename(filePath), signal);
    },
  }),
  createLocalWorkspaceOptions: (context) => ({
    processEnvironment: outlineHost.createAgentShellEnvironment(
      context.thread.id,
      context.turn.id,
      (shell) => agentHost.skills.processEnvironment(context.thread.id, context.turn.id, shell),
    ),
  }),
  createImageGenerationRuntime: createThreadImageGenerationRuntime,
  resolveAutomationConfiguration: async (selection, cwd, { configuration }) => {
    const resolvedConfiguration = configuration.resolveProfile(undefined, cwd);
    const effectiveConfiguration = Object.freeze({
      ...resolvedConfiguration,
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
  validateAutomationConfiguration: validateAutomationEffectiveConfiguration,
});
const windowApplicationHost = createWindowApplicationHost({
  userDataDir: resolvedUserDataDir,
  moduleDir: environment.moduleDir,
  appIconPath: APP_ICON_PNG_PATH,
  rendererDevUrl: resourcePreviewHost.rendererDevUrl,
  hardenWebContents: resourcePreviewHost.hardenWebContents,
  disposeTranslation: resourcePreviewHost.translation.dispose,
  releaseOutlineRenderer: outlineHost.renderer.releaseOwner,
  projection: () => outlineHost.document.liveProjection(),
  documentReady: () => lifecycle.ready('outline-documents'),
  runActionCommand: async (command, args) => {
    await lifecycle.ready('outline-documents');
    return runOutlineActionCommand(outlineHost.document, command, args);
  },
  searchNodes: async (query, limit) => {
    await lifecycle.ready('personal-ranking');
    return outlineHost.document.searchNodeHits(query, limit);
  },
  sanitizeInvocationSeed,
  reportError,
});
async function validateAutomationEffectiveConfiguration(
  modelProvider: string,
  configuration: EffectiveThreadConfiguration,
): Promise<void> {
  const provider = await getProviderRuntimeConfig(modelProvider);
  if (!provider) throw new Error(`Automation model provider is unavailable: ${modelProvider}`);
  validateAgentModelSelection(configuration.model, configuration.reasoningEffort, provider);
}
const wakeAutomationsOnResume = () => {
  void lifecycle.ready('agent').then(() => agentHost.automations.wake()).catch(() => undefined);
};
agentHost.threads.subscribeRenderer((notification) => {
  windowApplicationHost.windows.main()?.webContents.send(
    AGENT_CORE_NOTIFICATION_CHANNEL,
    projectAgentCoreNotification(notification),
  );
});

/**
 * Generations already announced, so one terminal event notifies exactly once.
 *
 * Bounded: the ledger emits repeatedly for one generation, so this must remember
 * them — but a long session delegating steadily would otherwise grow it for the
 * life of the process. The oldest keys are dropped once it passes the cap; a
 * generation that old cannot still be settling.
 */
agentHost.automations.subscribe((notification) => {
  windowApplicationHost.windows.main()?.webContents.send(AUTOMATION_NOTIFICATION_CHANNEL, notification);
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
        original: { kind: 'resource', ref: original },
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

outlineHost.observeProjection(({ event, update }) => {
  agentHost.projectionChanged(update, event.operation);
});

function registerMainTransport(previewSession: Electron.Session): HostTransportComposition {
  const transport = new HostTransportComposition('desktop-host', { ipcMain, protocol });
  try {
    transport.registerOwner('automation-resume', (owner) => {
      powerMonitor.on('resume', wakeAutomationsOnResume);
      owner.add(() => powerMonitor.removeListener('resume', wakeAutomationsOnResume));
    });
    transport.registerOwner('default-session-security', (owner) => {
      owner.add(resourcePreviewHost.configureDefaultSessionSecurity());
    });
    transport.registerOwner('url-preview-session-security', (owner) => {
      owner.add(resourcePreviewHost.configurePreviewSession());
    });
    transport.registerProtocolOwner('source-preview-protocols', (protocol) => {
      protocol.handle(ASSET_URL_SCHEME, (request) => {
        const assetId = assetIdFromUrl(request.url);
        return assetId
          ? outlineHost.assets.serve(assetId, request)
          : new Response('Asset not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      });
      protocol.handle(PREVIEW_LOCAL_URL_SCHEME, (request) => {
        const token = new URL(request.url).hostname;
        return resourcePreviewHost.streams.serve(token, request);
      });
    });
    transport.registerIpcOwner('outline', registerOutlineTransport);
    transport.registerIpcOwner('startup', registerStartupTransport);
    transport.registerIpcOwner('updates', registerUpdateTransport);
    transport.registerIpcOwner('actions', registerActionTransport);
    transport.registerIpcOwner('agent-memory-automation', registerAgentTransport);
    transport.registerIpcOwner('source-assets-preview', registerSourcePreviewTransport);
    transport.registerIpcOwner('windows-settings-launcher-providers', registerWindowSettingsTransport);
    transport.registerIpcOwner('diagnostics', registerDiagnosticsTransport);
    transport.registerIpcOwner('native-files', registerNativeFileTransport);
    transport.registerIpcOwner('agent-resources', (owned) => registerAgentResourceTransport({
      ...owned,
      handle: (channel, handler) => owned.handle(channel, async (event, ...args) => {
        assertMainRenderer(event, 'Agent resources');
        await lifecycle.ready('agent');
        return handler(event, ...args);
      }),
    }));
    return transport;
  } catch (error) {
    try {
      transport.dispose();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Desktop Host transport registration and rollback both failed.');
    }
    throw error;
  }
}

function registerStartupTransport(ipcMain: OwnedIpcMain): void {
  ipcMain.handle(STARTUP_GET_CHANNEL, (event) => {
    assertMainRenderer(event, 'Startup status');
    return lifecycle.state();
  });
  ipcMain.handle(STARTUP_RETRY_CHANNEL, async (event) => {
    assertMainRenderer(event, 'Startup retry');
    await lifecycle.start().catch(() => undefined);
    return lifecycle.state();
  });
  ipcMain.handle(STARTUP_QUIT_CHANNEL, (event) => {
    assertMainRenderer(event, 'Startup quit');
    return lifecycle.requestQuit();
  });
}

function registerOutlineTransport(ipcMain: OwnedIpcMain): void {
  registerDesktopOutlineIpc({
    ipcMain,
    client: outlineHost.renderer,
    authorize: (event) => windowApplicationHost.assertMainSender(event, 'Outline Runtime'),
  });
}

function registerUpdateTransport(ipcMain: OwnedIpcMain): void {
  ipcMain.handle(LIN_APP_UPDATE_GET_CHANNEL, (event): Promise<AppUpdateView> => {
    windowApplicationHost.assertSettingsSender(event, 'App update status');
    return windowApplicationHost.updates.view();
  });

  ipcMain.handle(LIN_APP_UPDATE_CHECK_CHANNEL, (event): Promise<AppUpdateView> => {
    windowApplicationHost.assertSettingsSender(event, 'App update checks');
    return windowApplicationHost.updates.checkExplicitly();
  });

  ipcMain.handle(LIN_APP_UPDATE_SET_AUTOMATIC_CHANNEL, (event, enabled: unknown): Promise<AppUpdateView> => {
    windowApplicationHost.assertSettingsSender(event, 'Automatic app update checks');
    if (typeof enabled !== 'boolean') throw new Error('Automatic update-check preference must be a boolean.');
    return windowApplicationHost.updates.setAutomaticChecksEnabled(enabled);
  });

  ipcMain.handle(LIN_APP_UPDATE_OPEN_CHANNEL, (event) => {
    windowApplicationHost.assertSettingsSender(event, 'Opening an app update');
    return windowApplicationHost.updates.openAvailableUpdate();
  });
}

function registerActionTransport(ipcMain: OwnedIpcMain): void {
  // Every action channel is main-renderer only. The seed carries renderer FACTS
  // — anchored row, selection, panel identity, pin and expansion — and main
  // constructs the objects, mints the refs and owns the lifetime.
  // Creating an invocation from a seed is ATTESTATION: only the main renderer
  // can say which row was right-clicked, what is selected, and whether the row
  // is pinned or expanded. The launcher has no such capability.
  ipcMain.handle(ACTION_OPEN_CHANNEL, async (event, raw: unknown) => {
    if (!rendererHasCapability(event.sender.id, 'actionAttestation')) {
      throw new Error('This renderer may not attest invocation context.');
    }
    assertMainRenderer(event, 'Action invocations');
    await lifecycle.ready('outline-documents');
    const seed = sanitizeInvocationSeed(raw);
    if (!seed) return null;
    return windowApplicationHost.actions.openFromSeed(seed, {
      webContentsId: event.sender.id,
      renderGeneration: event.sender.getProcessId(),
    });
  });

  ipcMain.handle(ACTION_OBJECT_QUERY_CHANNEL, async (event, raw: unknown) => {
    assertActionRequester(event);
    await lifecycle.ready('personal-ranking');
    const request = sanitizeObjectQuery(raw);
    if (!request) return null;
    return windowApplicationHost.actions.queryObjects(request, event.sender.id);
  });

  ipcMain.handle(ACTION_PARAMETER_QUERY_CHANNEL, async (event, raw: unknown) => {
    assertActionRequester(event);
    await lifecycle.ready('personal-ranking');
    const request = sanitizeParameterQuery(raw);
    if (!request) return null;
    return windowApplicationHost.actions.queryParameterObjects(request, event.sender.id);
  });

  ipcMain.handle(ACTION_REQUEST_CHANNEL, async (event, raw: unknown) => {
    assertActionRequester(event);
    await lifecycle.ready('outline-documents');
    const request = sanitizeActionRequest(raw);
    // A malformed request is not "stale" — it never named anything.
    if (!request) return { status: 'stale', reason: 'invocation' };
    return windowApplicationHost.actions.request(request, event.sender.id);
  });

  ipcMain.handle(ACTION_EVENT_CHANNEL, (event, raw: unknown) => {
    assertActionRequester(event);
    const invocationEvent = sanitizeInvocationEvent(raw);
    if (!invocationEvent) return { status: 'spent' };
    return windowApplicationHost.actions.event(invocationEvent, event.sender.id);
  });

  ipcMain.handle(ACTION_AMBIENT_SEED_RESPONSE_CHANNEL, (event, raw: unknown) => {
    // Only the main renderer may answer, and only a request main issued.
    assertMainRenderer(event, 'Action invocations');
    windowApplicationHost.actions.acceptAmbientSeed(raw);
  });

  ipcMain.handle(ACTION_STEP_ACK_CHANNEL, (event, raw: unknown) => {
    // Renderer steps only ever route to the MAIN renderer, so only it can ack.
    assertMainRenderer(event, 'Action invocations');
    windowApplicationHost.actions.acceptStepAck(raw);
  });
}

function registerAgentTransport(ipcMain: OwnedIpcMain): void {
  ipcMain.handle(AUTOMATION_REQUEST_CHANNEL, async (event, method: unknown, input: unknown) => {
    if (!windowApplicationHost.isMainSender(event)) {
      throw new Error('Automations are available only to the main application window.');
    }
    if (typeof method !== 'string' || !(AUTOMATION_METHODS as readonly string[]).includes(method)) {
      throw new Error(`Unknown Automation method: ${String(method)}`);
    }
    await lifecycle.ready('agent');
    return agentHost.automations.request(method as AutomationMethod, input);
  });
  ipcMain.handle(AGENT_CORE_REQUEST_CHANNEL, async (event, method: AgentCoreMethod, input: unknown) => {
    if (!windowApplicationHost.isMainSender(event)) {
      throw new Error('Agent Core is available only to the main application window.');
    }
    await lifecycle.ready('agent');
    const response = await agentHost.threads.request(method, input as AgentCoreRequestByMethod[AgentCoreMethod]);
    return projectAgentCoreResponse(method, response);
  });
  ipcMain.handle(
    THREAD_MESSAGE_CONTEXT_MENU_CHANNEL,
    async (
      event,
      request?: Partial<ThreadMessageContextMenuRequest>,
    ): Promise<ThreadMessageContextMenuAction | null> => {
      const mainWindow = windowApplicationHost.windows.main();
      if (!mainWindow || event.sender !== mainWindow.webContents) return null;
      const messages = getMessages(windowApplicationHost.effectiveLocale()).agent;
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
          template.push({ label: messages.message.openTrajectory, click: () => pick('details') });
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
    },
  );
}

function registerSourcePreviewTransport(ipcMain: OwnedIpcMain): void {
  ipcMain.handle('lin:invoke', async (event, command: string, args?: Record<string, unknown>) => {
    // BEFORE dispatch, not inside it: the launcher must not reach
    // `get_projection` or `delete_node` by any command name, and a renderer
    // with no registered capabilities fails closed rather than inheriting the
    // app's rights.
    if (!rendererHasCapability(event.sender.id, 'appCommands')) {
      throw new Error('This renderer may not invoke application commands.');
    }
    const dispatch = async () => {
      if (command.startsWith('memory_') || isAgentCommand(command) || isPreviewCommand(command)
        || isUrlPageTranslationCommand(command)) {
        await lifecycle.ready('agent');
      } else if (isAssetCommand(command)) {
        await lifecycle.ready('outline-documents');
      }
      if (command.startsWith('memory_')) return handleMemoryCommand(command, args ?? {});
      if (isAgentCommand(command)) return handleAgentCommand(event, command, args ?? {});
      if (isAssetCommand(command)) return handleAssetCommand(event, command, args ?? {});
      if (isUrlPageTranslationCommand(command)) {
        if (!windowApplicationHost.isMainSender(event)) {
          throw new Error('Page translation is only available to the main window.');
        }
        return resourcePreviewHost.translation.handle(command, args ?? {});
      }
      if (isPreviewCommand(command)) {
        assertMainRenderer(event, 'Preview');
        return handlePreviewCommand(command, args ?? {}, {
          agentLocalFileRoots: [agentLocalFileRoot, agentScratchRoot],
          assetService: outlineHost.assets,
          assetFileStreamUrl: async (filePath, mimeType) => {
            const token = await resourcePreviewHost.streams.issuePath(filePath, mimeType);
            return token ? previewLocalUrl(token) : null;
          },
          inferMimeType,
          localFileStreamUrl: async (file, mimeType) => {
            const token = await resourcePreviewHost.streams.issue(file, mimeType);
            return token ? previewLocalUrl(token) : null;
          },
          threadAttachmentFile: async (threadId, attachmentId) =>
            agentHost.threads
              .resolveAttachmentFile(threadId, attachmentId)
              .then(async (resolved) => {
                if (!resolved) return null;
                return {
                  ...resolved,
                  ...(resolved.attachment.artifactRef
                    ? { mimeType: await sniffPreviewFileMimeType(resolved.path, resolved.attachment.mimeType) }
                    : {}),
                  acceptedPathHints:
                    resolved.attachment.source.kind === 'localFile'
                      ? [resolved.attachment.source.path]
                      : [resolved.attachment.name, resolved.attachment.source.ref.fileName],
                };
              })
              .catch(() => null),
          threadResourceFile: async (threadId, ref, intent) =>
            (intent === 'source'
              ? agentHost.threads.resolveThreadResourceSource(threadId, ref)
              : agentHost.threads.resolveThreadResourceFile(threadId, ref))
              .then((resolved) => {
                if (!resolved) return null;
                return {
                  ...resolved,
                  acceptedPathHints: [resolved.ref.fileName],
                };
              })
              .catch(() => null),
          threadImageArtifactFile: async (threadId, artifact) =>
            agentHost.threads
              .resolveImageArtifactFile(threadId, artifact)
              .then(async (resolved) => {
                if (!resolved) return null;
                return {
                  ...resolved,
                  mimeType: await sniffPreviewFileMimeType(resolved.path, resolved.artifact.observation.mimeType),
                  acceptedPathHints: [
                    resolved.artifact.id,
                    resolved.artifact.observation.fileName,
                    ...(resolved.artifact.original?.kind === 'resource'
                      ? [resolved.artifact.original.ref.fileName]
                      : []),
                  ],
                };
              })
              .catch(() => null),
          threadManagedFileStreamUrl: async (filePath, mimeType) => {
            const token = await resourcePreviewHost.streams.issueExactPath(filePath, mimeType);
            return token ? previewLocalUrl(token) : null;
          },
          linkedFileGrant: resourcePreviewHost.linkedFileGrant,
          chooseLinkedFile: async () => {
            const window =
              BrowserWindow.fromWebContents(event.sender)
              ?? BrowserWindow.getFocusedWindow()
              ?? windowApplicationHost.windows.main();
            const options: Electron.OpenDialogOptions = { properties: ['openFile'] };
            const paths = await resourcePreviewHost.localFiles.pickPaths(window, options);
            return paths[0] ?? null;
          },
          linkedFileStreamUrl: async (file, mimeType) => {
            const token = await resourcePreviewHost.streams.issueExactFile(file, mimeType);
            return token ? previewLocalUrl(token) : null;
          },
          mutateLinkedFileSource: (input) =>
            outlineHost.document.runChanges(
              [
                {
                  op: 'update',
                  targets: {
                    target: { selector: { by: 'id', id: input.ownerId }, cardinality: 'one' },
                  },
                  changes: [
                    input.kind === 'add'
                      ? {
                          kind: 'source',
                          action: 'add',
                          sourceText: input.sourceText,
                          valueId: `node:${randomUUID()}`,
                        }
                      : {
                          kind: 'source',
                          action: 'replace',
                          value: {
                            target: { selector: { by: 'id', id: input.sourceValueId }, cardinality: 'one' },
                          },
                          sourceText: input.sourceText,
                        },
                  ],
                },
              ],
              { focus: { nodeId: input.ownerId, selectAll: false } },
            ),
          localFileReferencePreview: resourcePreviewHost.localFiles.metadata,
        });
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
    await outlineHost.recordNodeAccess([raw], 'human');
  });

  ipcMain.handle(LIN_URL_PAGE_TRANSLATION_GUEST_CHANNEL, (event, raw: unknown) => {
    if (!windowApplicationHost.isMainSender(event)) {
      throw new Error('Page translation guest access is only available to the main window.');
    }
    return executeUrlPageTranslationGuestCommand(event.sender, raw);
  });
}

function registerWindowSettingsTransport(ipcMain: OwnedIpcMain): void {
  ipcMain.handle('lin:window', (_event, command: string) => windowApplicationHost.windowCommand(command));
  ipcMain.handle('lin:open-settings', (_event, target?: unknown) => windowApplicationHost.openSettings(target));
  ipcMain.handle('lin:close-settings', (event) => windowApplicationHost.closeSettingsFrom(event));
  ipcMain.handle(LIN_CLEAR_URL_PREVIEW_DATA_CHANNEL, (event) => resourcePreviewHost.clearWebsiteData(
    event,
    windowApplicationHost.windows.settings(),
    windowApplicationHost.effectiveLocale(),
  ));
  ipcMain.handle(LIN_CLEAR_PREVIEW_TRANSLATION_CACHE_CHANNEL, (event) => resourcePreviewHost.clearTranslationCache(
    event,
    windowApplicationHost.windows.settings(),
    windowApplicationHost.effectiveLocale(),
  ));

  const assertLauncherRenderer = (event: IpcMainInvokeEvent): void => {
    if (!rendererHasCapability(event.sender.id, 'launcher')) {
      throw new Error('The launcher bridge is available only to the launcher window.');
    }
  };
  ipcMain.handle('lin:show-launcher', async (event) => {
    windowApplicationHost.assertMainSender(event, 'Summoning the command surface');
    await windowApplicationHost.toggleLauncher();
  });
  ipcMain.handle('launcher:hide', (event) => {
    assertLauncherRenderer(event);
    windowApplicationHost.dismissLauncher();
  });
  ipcMain.handle('launcher:getInitialState', (event): LauncherInitialState => {
    assertLauncherRenderer(event);
    return { hotkey: windowApplicationHost.launcherHotkey() };
  });
  ipcMain.handle('lin:get-theme', (): ThemeMode => windowApplicationHost.theme());
  ipcMain.handle('lin:launcher-hotkey', (): string | null => windowApplicationHost.launcherHotkey());
  ipcMain.handle('lin:set-theme', (_event, mode: unknown) => windowApplicationHost.setTheme(mode));
  ipcMain.on('lin:get-language-sync', (event) => {
    event.returnValue = windowApplicationHost.effectiveLocale();
  });
  ipcMain.on('lin:get-translation-language-sync', (event) => {
    event.returnValue = windowApplicationHost.effectiveTranslationLanguage();
  });
  ipcMain.on('lin:get-url-page-translation-preferences-sync', (event) => {
    event.returnValue = windowApplicationHost.urlPageTranslationPreferences();
  });
  ipcMain.handle('lin:set-translation-language', (_event, raw: unknown) => (
    windowApplicationHost.setTranslationLanguage(raw)
  ));
  ipcMain.handle('lin:set-url-page-translation-preferences', (_event, raw: unknown) => (
    windowApplicationHost.setUrlPageTranslationPreferences(raw)
  ));
  ipcMain.handle('lin:set-language', (_event, raw: unknown) => windowApplicationHost.setLocale(raw));
  ipcMain.handle('lin:open-provider-config', (_event, args?: { providerId?: unknown; mode?: unknown }) => {
    const providerId = typeof args?.providerId === 'string' ? args.providerId : '';
    const mode: ProviderConfigMode = args?.mode === 'custom' ? 'custom' : 'configure';
    windowApplicationHost.openProviderConfig(providerId, mode);
  });
  ipcMain.handle('lin:close-provider-config', () => windowApplicationHost.closeProviderConfig());
  ipcMain.handle('lin:get-provider-api-key', async (event, args?: { providerId?: unknown }) => {
    if (!windowApplicationHost.isProviderConfigSender(event)) {
      throw new Error('Provider API keys are only available to the provider config window.');
    }
    await lifecycle.ready('provider-configuration');
    return getStoredProviderApiKey(String(args?.providerId ?? ''));
  });
  ipcMain.handle('lin:settings-changed', (event) => {
    windowApplicationHost.notifySettingsChanged(BrowserWindow.fromWebContents(event.sender));
  });
}

function registerDiagnosticsTransport(ipcMain: OwnedIpcMain): void {
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
      const window =
        BrowserWindow.fromWebContents(event.sender)
        ?? BrowserWindow.getFocusedWindow()
        ?? windowApplicationHost.windows.settingsOrMain();
      const defaultPath = join(
        app.getPath('desktop'),
        `tenon-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      );
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
}

function registerNativeFileTransport(ipcMain: OwnedIpcMain): void {
  ipcMain.handle('lin:pick-local-files', (event, rawOptions?: { maxFiles?: unknown }) => (
    resourcePreviewHost.localFiles.pick(
      BrowserWindow.fromWebContents(event.sender)
        ?? BrowserWindow.getFocusedWindow()
        ?? windowApplicationHost.windows.main(),
      rawOptions,
    )
  ));
  ipcMain.handle('lin:search-local-files', (_event, rawOptions?: { limit?: unknown; query?: unknown }) => (
    resourcePreviewHost.localFiles.search(rawOptions)
  ));
  ipcMain.handle('lin:recent-local-files', (_event, rawOptions?: { limit?: unknown }) => (
    resourcePreviewHost.localFiles.recent(rawOptions)
  ));
  ipcMain.handle('lin:prepare-local-file', (_event, rawOptions?: { id?: unknown }) => (
    resourcePreviewHost.localFiles.prepare(rawOptions)
  ));
  ipcMain.handle('lin:preview-local-file', (_event, rawOptions?: { id?: unknown }) => (
    resourcePreviewHost.localFiles.preview(rawOptions)
  ));

  ipcMain.handle('lin:preview-local-file-reference', async (event, rawOptions?: LocalFileOperationInput) => {
    assertAttachmentFileOperationRenderer(event, rawOptions, 'Attachment preview');
    return resourcePreviewHost.localFiles.previewReference(rawOptions);
  });

  ipcMain.handle('lin:open-local-file', async (event, rawOptions?: LocalFileOperationInput) => {
    assertAttachmentFileOperationRenderer(event, rawOptions, 'Attachment open');
    return resourcePreviewHost.localFiles.openReference(rawOptions);
  });

  ipcMain.handle('lin:reveal-local-file', async (event, rawOptions?: LocalFileOperationInput) => {
    // Reveal-in-Finder never executes the file, so it carries no `isSafeLocalFileOpenTarget`
    // gate (an app/script that can't be opened can still be revealed); the same trusted-root
    // boundary as `lin:open-local-file` is the authority.
    assertAttachmentFileOperationRenderer(event, rawOptions, 'Attachment reveal');
    return resourcePreviewHost.localFiles.revealReference(rawOptions);
  });
}

function registerAgentResourceTransport(ipcMain: OwnedIpcMain): void {
  ipcMain.handle('lin:attachment-upload/begin', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment upload');
    const expectedBytes = Number(raw?.sizeBytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
      throw new Error('Attachment upload size must be a non-negative safe integer.');
    }
    const threadId = requiredNonEmptyString(raw?.threadId, 'threadId');
    const attachmentId = requiredNonEmptyString(raw?.attachmentId, 'attachmentId');
    const uploadId = await agentHost.threads.beginAttachmentUpload({
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
    await agentHost.threads.appendAttachmentUpload({
      threadId: requiredNonEmptyString(raw?.threadId, 'threadId'),
      attachmentId: requiredNonEmptyString(raw?.attachmentId, 'attachmentId'),
      uploadId: requiredNonEmptyString(raw?.uploadId, 'uploadId'),
      bytes,
    });
    return {};
  });

  ipcMain.handle('lin:attachment-upload/finish', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment upload');
    return agentHost.threads.finishAttachmentUpload({
      threadId: requiredNonEmptyString(raw?.threadId, 'threadId'),
      attachmentId: requiredNonEmptyString(raw?.attachmentId, 'attachmentId'),
      uploadId: requiredNonEmptyString(raw?.uploadId, 'uploadId'),
    });
  });

  ipcMain.handle('lin:attachment-upload/abort', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment upload');
    await agentHost.threads.abortAttachmentUpload({
      threadId: requiredNonEmptyString(raw?.threadId, 'threadId'),
      attachmentId: requiredNonEmptyString(raw?.attachmentId, 'attachmentId'),
      uploadId: requiredNonEmptyString(raw?.uploadId, 'uploadId'),
    });
    return {};
  });

  ipcMain.handle('lin:attachment-resource/discard', async (event, raw?: Record<string, unknown>) => {
    assertMainRenderer(event, 'Attachment resource discard');
    const discarded = await agentHost.threads.discardUnreferencedThreadResource(
      requiredNonEmptyString(raw?.threadId, 'threadId'),
      decodeThreadResourceReference(raw?.ref, 'attachmentResource.ref'),
    );
    return { discarded };
  });
}

async function handleMemoryCommand(command: string, args: Record<string, unknown>) {
  switch (command) {
    case 'memory_settings_get':
      return agentHost.memory.settings(typeof args.threadId === 'string' ? args.threadId : null);
    case 'memory_feature_mode_set':
      return agentHost.memory.setFeatureMode(decodeMemoryFeatureMode(args.mode));
    case 'memory_thread_mode_set':
      return agentHost.memory.setThreadMode(
        requiredNonEmptyString(args.threadId, 'threadId'),
        decodeThreadMemoryMode(args.mode),
      );
    case 'memory_open':
      {
        const outcome = await outlineHost.document.runChanges(
          [
            {
              op: 'ensure',
              resource: 'tag-search',
              tag: {
                target: {
                  selector: { by: 'id', id: memoryTagId('memory') },
                  cardinality: 'one',
                },
              },
              bind: 'search',
            },
          ],
          {
            focus: (_operation, diff) => {
              const nodeId = diff.bindings.search?.[0];
              return nodeId ? { nodeId, selectAll: false } : undefined;
            },
          },
        );
        windowApplicationHost.navigateMainToNode(outcome.focus?.nodeId ?? DAILY_NOTES_ID);
      }
      return agentHost.memory.settings();
    case 'memory_reset':
      return agentHost.memory.reset();
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
    ...(typeof seed.selectionRootId === 'string' ? { selectionRootId: seed.selectionRootId } : {}),
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
  windowApplicationHost.assertMainSender(event, capability);
}

function assertAttachmentFileOperationRenderer(
  event: IpcMainInvokeEvent,
  input: LocalFileOperationInput | undefined,
  capability: string,
): void {
  if (
    input?.threadId !== undefined
    || input?.attachmentId !== undefined
    || input?.resourceRef !== undefined
  ) {
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
      return outlineHost.assets.ingest(args as unknown as AssetIngestInput);
    }
    case 'ingest_local_file': {
      // The ingest bridge (agent working file -> committed outliner asset). Unlike
      // ingest_asset, this takes a path -- but only one inside the agent's trusted
      // roots (workdir/scratch), gated by the same check that backs preview/open of
      // these chips. The renderer can only name a file it could already preview, so
      // this does NOT reopen the arbitrary-local-file read primitive that
      // ingest_asset's buffer-only rule guards against. Directories are rejected.
      const file = await resourcePreviewHost.localFiles.resolve({ path: (args as { path?: unknown }).path });
      if (!file || file.entryKind !== 'file') return null;
      return outlineHost.assets.ingest({ kind: 'path', path: file.path });
    }
    case 'ingest_thread_resource': {
      assertMainRenderer(event, 'Thread resource ingest');
      return ingestThreadResourceAsset(args, {
        readResource: (threadId, ref) => agentHost.threads
          .readReferencedThreadResource(threadId, ref)
          .catch(() => null),
        ingestResource: (bytes, ref) => outlineHost.assets.ingest({
          kind: 'buffer',
          data: bytes,
          mimeType: ref.mimeType,
          originalFilename: ref.fileName,
        }),
      });
    }
    case 'lookup_asset':
      return outlineHost.assets.lookup(String(args.id));
    case 'pick_image_files': {
      const window = windowApplicationHost.windows.focusedOrMain();
      const dialogStrings = getMessages(windowApplicationHost.effectiveLocale()).window;
      const options = {
        title: dialogStrings.insertImageTitle,
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [{ name: dialogStrings.imageFilesFilter, extensions: IMAGE_FILE_EXTENSIONS }],
      };
      const paths = await resourcePreviewHost.localFiles.pickPaths(window, options);
      return Promise.all(paths.map((path) => outlineHost.assets.ingest({ kind: 'path', path })));
    }
    case 'pick_attachment_files': {
      const window = windowApplicationHost.windows.focusedOrMain();
      const dialogStrings = getMessages(windowApplicationHost.effectiveLocale()).window;
      const options = {
        title: dialogStrings.insertAttachmentTitle,
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      };
      const paths = await resourcePreviewHost.localFiles.pickPaths(window, options);
      return Promise.all(paths.map((path) => outlineHost.assets.ingest({ kind: 'path', path })));
    }
    case 'open_asset': {
      const path = await outlineHost.assets.pathFor(String(args.id));
      if (!path) return { opened: false };
      const pathStat = await stat(path);
      return { opened: await resourcePreviewHost.localFiles.open({ entryKind: 'file', path, stats: pathStat }) };
    }
    case 'reveal_asset': {
      const path = await outlineHost.assets.pathFor(String(args.id));
      if (path) resourcePreviewHost.localFiles.reveal(path);
      return { revealed: Boolean(path) };
    }
    case 'copy_asset_file': {
      const path = await outlineHost.assets.pathFor(String(args.id));
      if (!path) return { copied: false };
      resourcePreviewHost.localFiles.copy(path);
      return { copied: true };
    }
    case 'open_external_url': {
      // Opens a remote media node's source in the OS default browser. Only
      // http(s) is allowed so a node can never smuggle a file:// or other
      // scheme into shell.openExternal.
      return { opened: resourcePreviewHost.openExternal(String(args.url)) };
    }
    default:
      throw new Error(`Unknown asset command: ${command}`);
  }
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
  windowApplicationHost.notifySettingsChanged(origin);
}

/**
 * Which layer an editor change lands in. Anything unrecognised is the user
 * layer: a write must not silently reach into a project the caller did not
 * name.
 */
function layerTarget(value: unknown): ConfigurationLayerTarget {
  return value === 'project' ? 'project' : 'user';
}

/**
 * The working directory an editor request resolves project configuration
 * against. The renderer may name one — the conversation it is editing from —
 * but never a path outside a real directory.
 *
 * The fallback is the agent's own working root, because that is the directory
 * Threads are created in (`defaultCwd: agentLocalFileRoot`) and therefore the
 * project layer the transcript actually resolves. Falling back to the home
 * directory pointed the editor at a layer nothing reads: "This project" wrote a
 * file no Thread would ever load, and Roles defined in the real workspace were
 * invisible to the page that claims to list them.
 */
function agentEditorCwd(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && existsSync(value)
    ? value
    : agentLocalFileRoot;
}

/**
 * The Agents editor's whole view: the catalog the transcript draws from beside
 * the Roles the user may change. One helper so the two halves are always read
 * from the same cwd, and so a handler resolves that cwd once rather than per
 * response literal.
 */
async function agentEditorView(cwd: string): Promise<AgentEditorView> {
  return {
    entries: agentHost.configuration.resolveIdentityCatalog(cwd),
    presentationOverrides: agentHost.configuration.listPresentationOverrides(cwd),
    profile: agentHost.configuration.resolveEditableProfile(cwd),
    capabilities: await agentCapabilityCatalog(),
  };
}

/**
 * What a capability narrowing may name. Resolved here rather than imported by
 * the renderer: a settings pane that read the runtime's own tool module would
 * drift the moment the runtime gained a tool, and would pull the codec into the
 * renderer bundle to do it.
 */
async function agentCapabilityCatalog(): Promise<AgentCapabilityCatalog> {
  return {
    tools: MODEL_TOOL_CATALOG.map((tool) => ({
      key: canonicalModelToolKey(tool.identity),
      description: tool.description,
    })),
    // Every Skill the install can see, so a narrowing names real Skills; which
    // of them are enabled is a separate setting on its own page.
    skills: (await agentHost.skills.list(false)).map((skill) => skill.name),
  };
}

function decodeProfileDraft(value: unknown): AgentProfileDraft {
  const record = plainObject(value, 'profile');
  return {
    ...(record.developerInstructions === undefined
      ? {}
      : { developerInstructions: optionalText(record.developerInstructions, 'profile.developerInstructions') }),
    ...(record.model === undefined ? {} : { model: optionalText(record.model, 'profile.model') }),
    ...(record.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: optionalText(record.reasoningEffort, 'profile.reasoningEffort') }),
    ...(record.tools === undefined ? {} : { tools: textList(record.tools, 'profile.tools') }),
    ...(record.skills === undefined ? {} : { skills: textList(record.skills, 'profile.skills') }),
  };
}

/**
 * Null is meaningful here — it removes a narrowing — so it survives decode
 * rather than being folded into "absent" or into an empty list.
 */
function textList(value: unknown, path: string): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of strings or null`);
  return value.map((entry, index) => requiredText(entry, `${path}[${index}]`));
}

function decodePresentationDraft(value: unknown): { persona?: string; color?: string } {
  const record = plainObject(value, 'presentation');
  return {
    ...(record.persona === undefined ? {} : { persona: optionalText(record.persona, 'presentation.persona') }),
    ...(record.color === undefined ? {} : { color: optionalText(record.color, 'presentation.color') }),
  };
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
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

async function withDelegationRunners(settings: AgentProviderSettingsView) {
  return {
    ...withCanonicalSkillDirectories(settings),
    delegationRunners: await agentHost.delegationRunners(),
  };
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
  const skills = await agentHost.skills.list(false).catch(() => []);
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

async function handleAgentCommand(event: IpcMainInvokeEvent, command: AgentCommand, args: Record<string, unknown>) {
  switch (command) {
    case 'agent_get_provider_settings':
      return withDelegationRunners(await getProviderSettings());
    case 'agent_refresh_provider_models':
      return withDelegationRunners(await refreshProviderModels(String(args.providerId)));
    case 'agent_pick_skill_directory': {
      // Tenon points at the directory; it never copies it in. The picker returns
      // a path the caller stores in additionalSkillDirectories, so the user's
      // files stay where they are and stay live.
      const window = windowApplicationHost.windows.focusedOrMain();
      const options = {
        title: getMessages(windowApplicationHost.effectiveLocale()).window.chooseSkillDirectoryTitle,
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
      agentHost.skills.updateRuntimeSettings(settings.agent);
      return withDelegationRunners(settings);
    }
    case 'agent_update_image_generation_settings':
      return withDelegationRunners(await updateImageGenerationSettings(args.settings as AgentImageGenerationSettingsInput));
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
      const settings = await withDelegationRunners(await upsertProviderConfig(input));
      if (input.enabled === false) clearLastAgentThreadConfiguration();
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
    case 'agent_delete_provider_config': {
      const settings = await withDelegationRunners(
        await deleteProviderConfig(String(args.providerId)),
      );
      clearLastAgentThreadConfiguration();
      return settings;
    }
    case 'agent_set_active_provider': {
      const settings = await withDelegationRunners(
        await setActiveProvider(String(args.providerId)),
      );
      clearLastAgentThreadConfiguration();
      return settings;
    }
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
      const loginWindow = windowApplicationHost.windows.providerConfig();
      const providerId = String(args.providerId);
      const settings = await withDelegationRunners(await oauthLoginManager.startLogin(providerId, (envelope) => {
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
      return withDelegationRunners(await oauthLoginManager.logout(String(args.providerId)));
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
      return agentHost.skills.list(args.userInvocableOnly === true);
    case 'agent_undo_skill_agent_edit': {
      return agentHost.skills.undoAgentEdit(String(args.skillName));
    }
    // Main Agent configuration file IO stays behind the seam (A2).
    case 'agent_identity_catalog':
      return await agentEditorView(agentEditorCwd(args.cwd));
    case 'agent_write_profile': {
      const cwd = agentEditorCwd(args.cwd);
      await agentHost.configuration.writeProfile(
        layerTarget(args.layer),
        cwd,
        requiredText(args.name, 'name'),
        decodeProfileDraft(args.profile),
        args.presentation === undefined ? undefined : decodePresentationDraft(args.presentation),
      );
      notifySettingsChanged(BrowserWindow.fromWebContents(event.sender));
      return await agentEditorView(cwd);
    }

    case 'agent_managed_skill_catalog':
      return managedSkillCommand(() => agentHost.skills.catalog.load());
    case 'agent_managed_skill_discover':
      return managedSkillCommand(() => agentHost.skills.catalog.discover({
        sourceUrl: typeof args.sourceUrl === 'string' ? args.sourceUrl : undefined,
        catalogId: typeof args.catalogId === 'string' ? args.catalogId : undefined,
      }));
    case 'agent_managed_skill_install':
      return managedSkillCommand(() => agentHost.skills.catalog.install({
        discoveryId: String(args.discoveryId ?? ''),
        candidateId: String(args.candidateId ?? ''),
        expectedCommit: String(args.expectedCommit ?? ''),
      }));
    case 'agent_managed_skill_list':
      return managedSkillCommand(() => agentHost.skills.catalog.list());
    case 'agent_managed_skill_check_updates':
      // The throttle window is main's policy, so the renderer only says whether
      // the check was ambient — it never carries the number.
      return managedSkillCommand(() => agentHost.skills.catalog.checkUpdates(
        typeof args.skillId === 'string' ? args.skillId : undefined,
        args.ambient === true ? { throttleMs: MANAGED_SKILL_UPDATE_THROTTLE_MS } : undefined,
      ));
    case 'agent_managed_skill_preview_update':
      return managedSkillCommand(() => agentHost.skills.catalog.previewUpdate({
        skillId: String(args.skillId ?? ''),
        expectedActiveHash: String(args.expectedActiveHash ?? ''),
      }));
    case 'agent_managed_skill_apply_update':
      return managedSkillCommand(() => agentHost.skills.catalog.applyUpdate({
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
        return agentHost.skills.catalog.setEnabled({
          skillId: String(args.skillId ?? ''),
          enabled: args.enabled,
          expectedActiveHash: String(args.expectedActiveHash ?? ''),
        });
      });
    }
    case 'agent_managed_skill_rollback':
      return managedSkillCommand(() => agentHost.skills.catalog.rollback({
        skillId: String(args.skillId ?? ''),
        expectedActiveHash: String(args.expectedActiveHash ?? ''),
        expectedPreviousHash: String(args.expectedPreviousHash ?? ''),
      }));
    case 'agent_managed_skill_uninstall':
      return managedSkillCommand(() => agentHost.skills.catalog.uninstall({
        skillId: String(args.skillId ?? ''),
        expectedActiveHash: String(args.expectedActiveHash ?? ''),
      }));
    default:
      throw new Error(`Unknown agent command: ${command}`);
  }
}

// electron-vite does not terminate the child Electron process when its dev
// server exits. Keep the signal fast path and parent liveness probe together as
// one reversible effect owned by the Desktop Host.
if (!app.isPackaged) {
  const handleDevSignal = () => app.quit();
  process.on('SIGINT', handleDevSignal);
  devEffects.defer('process-SIGINT', () => {
    process.removeListener('SIGINT', handleDevSignal);
  });
  process.on('SIGTERM', handleDevSignal);
  devEffects.defer('process-SIGTERM', () => {
    process.removeListener('SIGTERM', handleDevSignal);
  });
  const devServerPid = process.ppid;
  const watchDevServer = setInterval(() => {
    try {
      process.kill(devServerPid, 0);
    } catch {
      clearInterval(watchDevServer);
      app.quit();
    }
  }, 1000);
  watchDevServer.unref();
  devEffects.defer('parent-process-watchdog', () => clearInterval(watchDevServer));
}

windowEffects.defer('window-application-host', () => windowApplicationHost.release());

let closeSettlement: Promise<void> | null = null;
const settleWithin = <T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> => (
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, timeoutMs);
    timer.unref?.();
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  })
);
const attemptFailedStartDurability = async (milestones: ReadonlySet<string>): Promise<void> => {
  if (!milestones.has('outline-documents')) return;
  const target = await outlineHost.quit.latestAcceptedRevision();
  await settleWithin(
    outlineHost.quit.drainToRevision(target),
    2_500,
    'Failed-start durability attempt timed out.',
  );
};
const closeDesktopResources = (
  milestones: ReadonlySet<string>,
  reason: 'ordinary-quit' | 'startup-failure' | 'quit-before-start',
): Promise<void> => {
  if (closeSettlement) return closeSettlement;
  closeSettlement = (async () => {
    const failures: unknown[] = [];
    if (reason !== 'ordinary-quit') {
      try {
        await attemptFailedStartDurability(milestones);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await resources.dispose();
    } catch (error) {
      failures.push(error);
      reportError({
        domain: 'lifecycle',
        severity: 'error',
        code: 'resource-dispose-failed',
        message: 'Desktop Host reversible resource disposal failed',
        context: { operation: reason },
        error,
      });
    } finally {
      mainTransport = null;
    }

    let serviceSettlements: PromiseSettledResult<unknown>[] = [];
    try {
      serviceSettlements = await settleWithin(
        Promise.allSettled([
          ...(milestones.has('personal-ranking') ? [outlineHost.flushDerivedState()] : []),
          agentHost.close(),
          diagnosticLog.flushNow({ reason: reason === 'ordinary-quit' ? 'before-quit' : 'fatal' }),
          resourcePreviewHost.close(),
        ]),
        2_500,
        `Desktop Host ${reason} service settlement timed out.`,
      );
    } catch (error) {
      failures.push(error);
    }
    for (const settlement of serviceSettlements) {
      if (settlement.status === 'rejected') failures.push(settlement.reason);
    }
    outlineHost.close();
    try {
      await bootstrapEffects.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Desktop Host ${reason} cleanup failed.`);
    }
  })();
  return closeSettlement;
};

const teardownForQuit = () => closeDesktopResources(lifecycle.completedMilestones(), 'ordinary-quit');
quitCoordinator = new AppQuitCoordinator({
  freezeAdmission: () => outlineHost.quit.freezeAdmission(),
  unfreezeAdmission: () => outlineHost.quit.unfreezeAdmission(),
  commitAdmissionFreeze: () => outlineHost.quit.commitAdmissionFreeze(),
  latestAcceptedRevision: () => outlineHost.quit.latestAcceptedRevision(),
  durableRevision: () => outlineHost.quit.durableRevision(),
  drainToRevision: (revision) => outlineHost.quit.drainToRevision(revision),
  showDrainFailure: async (_error, _outcome): Promise<QuitDecision> => {
    const strings = getMessages(windowApplicationHost.effectiveLocale()).dialog;
    const parent = windowApplicationHost.windows.main();
    const options: Electron.MessageBoxOptions = {
      type: 'error',
      buttons: [strings.retrySave, strings.quitAnyway, strings.cancel],
      defaultId: 0,
      cancelId: 2,
      message: strings.saveFailedTitle,
      detail: strings.saveFailedDetail,
    };
    const response = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response.response === 0 ? 'retry' : response.response === 1 ? 'quit-anyway' : 'cancel';
  },
  teardown: teardownForQuit,
  shutdownRuntime: (signal) => outlineHost.quit.shutdownRuntime(signal),
  exit: () => app.exit(0),
});

const lifecycle = new DesktopHostLifecycle({
  startSteps: [
    {
      name: 'native-application',
      run: () => {
        const icon = nativeImage.createFromPath(APP_ICON_PNG_PATH);
        if (process.platform === 'darwin' && !icon.isEmpty()) app.dock?.setIcon(icon);
        app.setAboutPanelOptions({
          applicationName: APP_NAME,
          applicationVersion: app.getVersion(),
          copyright: '© 2026 Lin Lab',
          ...(icon.isEmpty() ? {} : { iconPath: APP_ICON_PNG_PATH }),
        });
      },
    },
    {
      name: 'transport',
      run: () => {
        const previewSession = resourcePreviewHost.initializeSession();
        mainTransport = registerMainTransport(previewSession);
        transportEffects.defer('main-transport', () => mainTransport?.dispose());
      },
    },
    { name: 'windows', run: async () => {
      await windowApplicationHost.initialize();
      startFilePreferencesWatcher();
    } },
    {
      name: 'provider-configuration',
      dependsOn: ['windows'],
      retryable: true,
      run: async () => {
        const providerReconcile = await reconcileProviderConfig();
        if (providerReconcile?.activeProviderChanged) clearLastAgentThreadConfiguration();
      },
    },
    {
      name: 'outline-documents',
      dependsOn: ['windows'],
      retryable: true,
      run: () => outlineHost.initializeDocuments().then(() => undefined),
    },
    {
      name: 'node-access',
      dependsOn: ['windows'],
      run: () => outlineHost.loadPersonalAccessRanking(),
    },
    {
      name: 'personal-ranking',
      dependsOn: ['outline-documents', 'node-access'],
      retryable: true,
      run: () => outlineHost.initializePersonalAccessRanking(),
    },
    {
      name: 'agent',
      dependsOn: ['provider-configuration', 'outline-documents'],
      retryable: true,
      run: async ({ assertActive }) => {
        await agentHost.initialize(outlineHost.document.liveProjection(), assertActive);
        applyFilePreferencesNow?.();
      },
    },
    {
      name: 'background-producers',
      dependsOn: ['agent', 'personal-ranking'],
      run: () => {
        scheduleAppUpdateCheck();
        scheduleManagedSkillUpdateCheck();
      },
    },
  ],
  closeAdmission: () => outlineHost.quit.freezeAdmission(),
  ordinaryQuit: async () => {
    try {
      await quitCoordinator.requestQuit();
    } catch (error) {
      if (quitCoordinator.phase() !== 'idle') throw error;
      reportError({
        domain: 'lifecycle',
        severity: 'error',
        code: 'quit-decision-failed',
        message: 'Quit decision failed; the application remains open.',
        context: { operation: 'quit-decision' },
        error,
      });
    }
    return quitCoordinator.phase() === 'idle' ? 'cancelled' : 'disposed';
  },
  rollback: (milestones, cause) => closeDesktopResources(milestones, cause),
  exitAfterStartupFailure: () => app.exit(1),
  exitAfterEarlyQuit: () => app.exit(0),
  onStartupState: (state) => {
    const window = windowApplicationHost.windows.main();
    if (window && !window.isDestroyed()) window.webContents.send(STARTUP_STATE_CHANNEL, state);
    if (state.status === 'failed') reportError({
      domain: 'lifecycle',
      severity: 'error',
      code: 'startup-failed',
      message: state.message,
      context: { operation: state.step },
    });
  },
});

return {
  start: () => lifecycle.start(),
  requestQuit: () => lifecycle.requestQuit(),
  focusSecondInstance: () => windowApplicationHost.focusMainWindow(),
  allWindowsClosed: () => {
    if (process.platform !== 'darwin') app.quit();
  },
  phase: () => lifecycle.phase(),
};
}
