import { join } from 'node:path';
import type { EffectiveThreadConfiguration } from '../../core/agent/configuration';
import type { AutomationConfiguration } from '../../core/agent/automation';
import type { ErrorReport } from '../../core/errorObservability';
import type { DocumentProjection, ProjectionUpdate } from '../../core/types';
import type { Operation } from '../../outline/contract';
import {
  createAgentLocalWorkspaceContext,
  type AgentLocalWorkspaceContext,
  type AgentShellProcessEnvironmentContext,
  type AgentShellProcessEnvironmentProvider,
  type AgentWorkspaceWriteBoundary,
} from '../agent/capabilities/agentLocalTools';
import type { AgentImageGenerationRuntime } from '../agent/capabilities/agentImageGenerationTool';
import type { SkillLoadOptions } from '../agent/capabilities/agentSkills';
import { AgentConfigurationLoader } from '../agent/AgentConfigurationLoader';
import { AgentConfigurationWriter } from '../agent/AgentConfigurationWriter';
import { ExtensionRegistry } from '../agent/ExtensionRegistry';
import { ThreadService, type ThreadServiceOptions } from '../agent/ThreadService';
import { AutomationDispatcher, type ResolvedAutomationConfiguration } from '../agent/automations/AutomationDispatcher';
import { AutomationScheduler } from '../agent/automations/AutomationScheduler';
import { AutomationService } from '../agent/automations/AutomationService';
import { AutomationStore } from '../agent/automations/AutomationStore';
import { createAutomationTool } from '../agent/automations/AutomationTool';
import { AutomationWorktree } from '../agent/automations/AutomationWorktree';
import { MemoryControlStore } from '../agent/extensions/memory/MemoryControlStore';
import { MemoryExtension } from '../agent/extensions/memory/MemoryExtension';
import { TimelineMemoryStore, type TimelineMemoryHost } from '../agent/extensions/memory/TimelineMemoryStore';
import { PiTurnExecutor, type PiTurnExecutorOptions } from '../agent/runtime/PiTurnExecutor';
import { ToolRuntime, type ToolRuntimeOptions } from '../agent/runtime/ToolRuntime';
import type { TurnExecutionContext } from '../agent/runtime/types';
import { AgentWorktree } from '../agent/worktree/AgentWorktree';
import { AttachmentResolver, type AttachmentResolverOptions } from '../agent/tools/attachments';
import { ManagedSkillService } from '../managedSkillService';
import { createManagedSkillsHost } from './managedSkillsHost';
import { assignOnce, createAgentHostLifecycle } from './compositionLifecycle';

type ThreadHostOptions = Omit<
  ThreadServiceOptions,
  | 'stores'
  | 'executor'
  | 'transcriptRoot'
  | 'attachmentScratchRoot'
  | 'nameGenerator'
  | 'resolveUserContent'
  | 'extensions'
  | 'beforeInitialTurnAdmission'
  | 'resolveSkillAdmission'
>;

export interface AgentHostComposition {
  readonly configuration: AgentConfigurationCompositionCapability;
  readonly worktrees: AgentWorktreeCompositionCapability;
  readonly threads: () => AgentThreadCapability;
}

export interface AgentHostOptions {
  readonly userDataDir: string;
  readonly scratchRoot: string;
  readonly defaultCwd: string;
  readonly appVersion: string;
  readonly loadRuntimeSettings: () => Promise<{
    readonly additionalSkillDirectories: readonly string[];
    readonly disabledSkills?: readonly string[];
  }>;
  readonly timeline: TimelineMemoryHost;
  readonly reportError: (report: ErrorReport) => void;
  readonly prepareImageArtifact: (
    input: Parameters<AttachmentResolverOptions['prepareImageArtifact']>[0] & {
      readonly writeResource: AgentThreadCapability['writeThreadResourceWithStatus'];
    },
  ) => ReturnType<AttachmentResolverOptions['prepareImageArtifact']>;
  readonly createTurnExecutorOptions: (
    composition: AgentHostComposition,
  ) => Omit<PiTurnExecutorOptions, 'createTools' | 'beforeProviderContext'>;
  readonly createThreadOptions: (composition: AgentHostComposition) => ThreadHostOptions;
  readonly createToolOptions: (
    composition: AgentHostComposition,
  ) => Omit<
    ToolRuntimeOptions,
    'dynamicTools' | 'skillRuntime' | 'localWorkspace' | 'imageGeneration'
  >;
  readonly createLocalWorkspaceOptions: (
    context: TurnExecutionContext,
    composition: AgentHostComposition,
  ) => {
    readonly processEnvironment: AgentShellProcessEnvironmentProvider;
    readonly writeBoundary?: AgentWorkspaceWriteBoundary;
  };
  readonly createImageGenerationRuntime: (
    context: TurnExecutionContext,
    localWorkspace: AgentLocalWorkspaceContext,
  ) => AgentImageGenerationRuntime;
  readonly createAdmissionSkillRuntimeOptions: (
    input: Parameters<NonNullable<ThreadServiceOptions['resolveSkillAdmission']>>[0],
    composition: AgentHostComposition,
  ) => Omit<
    SkillLoadOptions,
    'provenanceStore' | 'managedSkillRoots' | 'managedSkillContentRoot' | 'assertManagedSkillInvocable'
  >;
  readonly createTurnSkillRuntimeOptions: (
    context: TurnExecutionContext,
    composition: AgentHostComposition,
  ) => Omit<
    SkillLoadOptions,
    'provenanceStore' | 'managedSkillRoots' | 'managedSkillContentRoot' | 'assertManagedSkillInvocable'
  >;
  readonly resolveAutomationConfiguration: (
    selection: AutomationConfiguration,
    cwd: string,
    composition: AgentHostComposition,
  ) => Promise<ResolvedAutomationConfiguration>;
  readonly validateAutomationConfiguration: (
    modelProvider: string,
    configuration: EffectiveThreadConfiguration,
  ) => Promise<void>;
}

export interface AgentHost {
  readonly configuration: AgentConfigurationCapability;
  readonly worktrees: AgentWorktreeCapability;
  readonly threads: AgentThreadCapability;
  readonly memory: AgentMemoryCapability;
  readonly automations: AgentAutomationCapability;
  readonly skills: AgentSkillsCapability;
  projectionChanged(update: ProjectionUpdate, operation?: Operation): void;
  initialize(projection: DocumentProjection, assertActive?: () => void): Promise<void>;
  close(): Promise<void>;
}

export type AgentToolContext = TurnExecutionContext;

export interface AgentConfigurationCompositionCapability {
  resolveProfile: AgentConfigurationLoader['resolveProfile'];
  resolveRole: AgentConfigurationLoader['resolveRole'];
  resolveAgentType: AgentConfigurationLoader['resolveAgentType'];
  buildRoleCatalogSnapshotForUserPath: AgentConfigurationLoader['buildRoleCatalogSnapshotForUserPath'];
  resolveIdentityCatalogForUserPath: AgentConfigurationLoader['resolveIdentityCatalogForUserPath'];
  resolveThreadPersona: AgentConfigurationLoader['resolveThreadPersona'];
}

export interface AgentConfigurationCapability {
  resolveIdentityCatalog: AgentConfigurationLoader['resolveIdentityCatalog'];
  listEditableRoles: AgentConfigurationLoader['listEditableRoles'];
  listPresentationOverrides: AgentConfigurationLoader['listPresentationOverrides'];
  resolveEditableProfile: AgentConfigurationLoader['resolveEditableProfile'];
  listBuiltInDefinitions: AgentConfigurationLoader['listBuiltInDefinitions'];
  writeRole: AgentConfigurationWriter['writeRole'];
  deleteRole: AgentConfigurationWriter['deleteRole'];
  writeProfile: AgentConfigurationWriter['writeProfile'];
  writePresentation: AgentConfigurationWriter['writePresentation'];
}

export interface AgentWorktreeCompositionCapability {
  plan: AgentWorktree['plan'];
  prepare: AgentWorktree['prepare'];
  settle: AgentWorktree['settle'];
  recover: AgentWorktree['recover'];
  cleanupResidual: AgentWorktree['cleanupResidual'];
}

export interface AgentWorktreeCapability {
  sandboxPaths: AgentWorktree['sandboxPaths'];
}

export interface AgentThreadCapability {
  request: ThreadService['request'];
  subscribe: ThreadService['subscribe'];
  subagentExecution: ThreadService['subagentExecution'];
  agentWorktree: ThreadService['agentWorktree'];
  writeThreadResourceWithStatus: ThreadService['writeThreadResourceWithStatus'];
  spawnIsolatedSkillThread: ThreadService['spawnIsolatedSkillThread'];
  waitForIdle: ThreadService['waitForIdle'];
  readThread: ThreadService['readThread'];
  threadTranscriptPath: ThreadService['threadTranscriptPath'];
  resolveAttachmentFile: ThreadService['resolveAttachmentFile'];
  resolveThreadResourceFile: ThreadService['resolveThreadResourceFile'];
  resolveImageArtifactFile: ThreadService['resolveImageArtifactFile'];
  readReferencedThreadResource: ThreadService['readReferencedThreadResource'];
  beginAttachmentUpload: ThreadService['beginAttachmentUpload'];
  appendAttachmentUpload: ThreadService['appendAttachmentUpload'];
  finishAttachmentUpload: ThreadService['finishAttachmentUpload'];
  abortAttachmentUpload: ThreadService['abortAttachmentUpload'];
  discardUnreferencedThreadResource: ThreadService['discardUnreferencedThreadResource'];
}

export interface AgentMemoryCapability {
  settings: MemoryExtension['settings'];
  setFeatureMode: MemoryExtension['setFeatureMode'];
  setThreadMode: MemoryExtension['setThreadMode'];
  reset: MemoryExtension['reset'];
}

export interface AgentAutomationCapability {
  request: AutomationService['request'];
  subscribe: AutomationService['subscribe'];
  wake: AutomationService['wake'];
}

export interface AgentSkillsCapability {
  processEnvironment(
    threadId: string,
    turnId: string,
    context: AgentShellProcessEnvironmentContext,
  ): ReturnType<ReturnType<typeof createManagedSkillsHost>['processEnvironment']>;
  updateRuntimeSettings(settings: {
    readonly additionalSkillDirectories: readonly string[];
    readonly disabledSkills?: readonly string[];
  }): void;
  list(userInvocableOnly: boolean): ReturnType<ReturnType<typeof createManagedSkillsHost>['listPrimarySkills']>;
  undoAgentEdit(skillName: string): ReturnType<ReturnType<typeof createManagedSkillsHost>['undoPrimarySkillEdit']>;
  readonly catalog: {
    load: ManagedSkillService['loadCatalog'];
    discover: ManagedSkillService['discover'];
    install: ManagedSkillService['install'];
    list: ManagedSkillService['list'];
    checkUpdates: ManagedSkillService['checkUpdates'];
    previewUpdate: ManagedSkillService['previewUpdate'];
    applyUpdate: ManagedSkillService['applyUpdate'];
    setEnabled: ManagedSkillService['setEnabled'];
    rollback: ManagedSkillService['rollback'];
    uninstall: ManagedSkillService['uninstall'];
  };
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const managedSkills = createManagedSkillsHost({
    userDataDir: options.userDataDir,
    localRoot: options.defaultCwd,
    scratchRoot: options.scratchRoot,
    appVersion: options.appVersion,
    loadRuntimeSettings: options.loadRuntimeSettings,
  });
  const extensions = new ExtensionRegistry();
  const memoryControl = new MemoryControlStore(join(options.userDataDir, 'agent', 'memories.sqlite'));
  const memoryTimeline = new TimelineMemoryStore(options.timeline);
  const memory = new MemoryExtension(memoryControl, memoryTimeline, {
    onError: (error, operation) => options.reportError({
      domain: 'memory',
      severity: 'error',
      code: `memory-${operation}-failed`,
      message: `Memory ${operation} failed.`,
      context: { operation },
      error,
    }),
  });
  const configurationLoader = new AgentConfigurationLoader(options.userDataDir);
  const configurationWriter = new AgentConfigurationWriter(options.userDataDir);
  const worktree = new AgentWorktree(options.userDataDir);
  const threadReference = assignOnce<ThreadService>('ThreadService');
  const threadCapabilityReference = assignOnce<AgentThreadCapability>('Agent Thread capability');
  const toolReference = assignOnce<ToolRuntime>('ToolRuntime');
  const configurationComposition: AgentConfigurationCompositionCapability = {
    resolveProfile: (...args) => configurationLoader.resolveProfile(...args),
    resolveRole: (...args) => configurationLoader.resolveRole(...args),
    resolveAgentType: (...args) => configurationLoader.resolveAgentType(...args),
    buildRoleCatalogSnapshotForUserPath: (...args) => (
      configurationLoader.buildRoleCatalogSnapshotForUserPath(...args)
    ),
    resolveIdentityCatalogForUserPath: (...args) => (
      configurationLoader.resolveIdentityCatalogForUserPath(...args)
    ),
    resolveThreadPersona: (...args) => configurationLoader.resolveThreadPersona(...args),
  };
  const worktreeComposition: AgentWorktreeCompositionCapability = {
    plan: (...args) => worktree.plan(...args),
    prepare: (...args) => worktree.prepare(...args),
    settle: (...args) => worktree.settle(...args),
    recover: (...args) => worktree.recover(...args),
    cleanupResidual: (...args) => worktree.cleanupResidual(...args),
  };
  const composition: AgentHostComposition = {
    configuration: configurationComposition,
    worktrees: worktreeComposition,
    threads: threadCapabilityReference.get,
  };
  const attachmentResolver = new AttachmentResolver({
    useResourcePath: (threadId, ref, use) => threadReference.get().useThreadResourcePath(threadId, ref, use),
    prepareImageArtifact: (input) => options.prepareImageArtifact({
      ...input,
      writeResource: (...args) => threadCapabilityReference.get().writeThreadResourceWithStatus(...args),
    }),
  });
  const turnExecutor = new PiTurnExecutor({
    ...options.createTurnExecutorOptions(composition),
    createTools: (context) => toolReference.get().createTools(context),
    beforeProviderContext: (context) => toolReference.get().prepareProviderContext(context),
  });
  const threadService = ThreadService.open(options.userDataDir, turnExecutor, {
    ...options.createThreadOptions(composition),
    attachmentScratchRoot: options.scratchRoot,
    nameGenerator: turnExecutor,
    resolveUserContent: (content, context) => attachmentResolver.resolve(content, context),
    extensions,
    beforeInitialTurnAdmission: () => memory.prepareForTurnAdmission(),
    resolveSkillAdmission: (input) => managedSkills.resolveAdmission(
      input,
      options.createAdmissionSkillRuntimeOptions(input, composition),
    ),
  });
  threadReference.set(threadService);
  const threads: AgentThreadCapability = {
    request: (...args) => threadService.request(...args),
    subscribe: (...args) => threadService.subscribe(...args),
    subagentExecution: (...args) => threadService.subagentExecution(...args),
    agentWorktree: (...args) => threadService.agentWorktree(...args),
    writeThreadResourceWithStatus: (...args) => threadService.writeThreadResourceWithStatus(...args),
    spawnIsolatedSkillThread: (...args) => threadService.spawnIsolatedSkillThread(...args),
    waitForIdle: (...args) => threadService.waitForIdle(...args),
    readThread: (...args) => threadService.readThread(...args),
    threadTranscriptPath: (...args) => threadService.threadTranscriptPath(...args),
    resolveAttachmentFile: (...args) => threadService.resolveAttachmentFile(...args),
    resolveThreadResourceFile: (...args) => threadService.resolveThreadResourceFile(...args),
    resolveImageArtifactFile: (...args) => threadService.resolveImageArtifactFile(...args),
    readReferencedThreadResource: (...args) => threadService.readReferencedThreadResource(...args),
    beginAttachmentUpload: (...args) => threadService.beginAttachmentUpload(...args),
    appendAttachmentUpload: (...args) => threadService.appendAttachmentUpload(...args),
    finishAttachmentUpload: (...args) => threadService.finishAttachmentUpload(...args),
    abortAttachmentUpload: (...args) => threadService.abortAttachmentUpload(...args),
    discardUnreferencedThreadResource: (...args) => (
      threadService.discardUnreferencedThreadResource(...args)
    ),
  };
  threadCapabilityReference.set(threads);
  memory.bindHost(threadService);
  extensions.register(memory);

  const automationStore = new AutomationStore(join(options.userDataDir, 'agent', 'automations.sqlite'));
  const automationWorktree = new AutomationWorktree(options.userDataDir);
  const automationReference = assignOnce<AutomationService>('AutomationService');
  const automationDispatcher = new AutomationDispatcher({
    store: automationStore,
    threads: threadService,
    worktrees: automationWorktree,
    defaultCwd: options.defaultCwd,
    resolveConfiguration: (selection, cwd) => options.resolveAutomationConfiguration(selection, cwd, composition),
    validateEffectiveConfiguration: options.validateAutomationConfiguration,
    onRunChanged: (run) => automationReference.get().runChanged(run),
  });
  const automationScheduler = new AutomationScheduler({
    store: automationStore,
    dispatcher: automationDispatcher,
    onAutomationChanged: (automation) => automationReference.get().automationChanged(automation),
    onRunChanged: (run) => automationReference.get().runChanged(run),
  });
  const automationService = new AutomationService({
    store: automationStore,
    scheduler: automationScheduler,
    dispatcher: automationDispatcher,
    threads: threadService,
  });
  automationReference.set(automationService);
  const localWorkspaceForContext = (context: TurnExecutionContext) => {
    const workspaceOptions = options.createLocalWorkspaceOptions(context, composition);
    return createAgentLocalWorkspaceContext(
      context.thread.cwd,
      options.scratchRoot,
      managedSkills.runtimeForTurn(context.turn.id),
      workspaceOptions.processEnvironment,
      workspaceOptions.writeBoundary,
      context.thread.id,
    );
  };
  const toolRuntime = new ToolRuntime(threadService, {
    ...options.createToolOptions(composition),
    skillRuntime: (context) => managedSkills.prepareTurnRuntime(
      context,
      options.createTurnSkillRuntimeOptions(context, composition),
    ),
    localWorkspace: localWorkspaceForContext,
    imageGeneration: (context) => options.createImageGenerationRuntime(
      context,
      localWorkspaceForContext(context),
    ),
    dynamicTools: () => [createAutomationTool(automationService)],
  });
  toolReference.set(toolRuntime);
  threadService.subscribe((notification) => {
    if (notification.type === 'turn/completed') managedSkills.clearTurn(notification.turnId);
    if (notification.type === 'turn/completed' || notification.type === 'thread/status/changed') {
      automationService.wake();
    }
  });
  const lifecycle = createAgentHostLifecycle({
    memory,
    threads: threadService,
    automations: automationService,
  });

  return {
    configuration: {
      resolveIdentityCatalog: (...args) => configurationLoader.resolveIdentityCatalog(...args),
      listEditableRoles: (...args) => configurationLoader.listEditableRoles(...args),
      listPresentationOverrides: (...args) => configurationLoader.listPresentationOverrides(...args),
      resolveEditableProfile: (...args) => configurationLoader.resolveEditableProfile(...args),
      listBuiltInDefinitions: (...args) => configurationLoader.listBuiltInDefinitions(...args),
      writeRole: (...args) => configurationWriter.writeRole(...args),
      deleteRole: (...args) => configurationWriter.deleteRole(...args),
      writeProfile: (...args) => configurationWriter.writeProfile(...args),
      writePresentation: (...args) => configurationWriter.writePresentation(...args),
    },
    worktrees: {
      sandboxPaths: (...args) => worktree.sandboxPaths(...args),
    },
    threads,
    memory: {
      settings: (...args) => memory.settings(...args),
      setFeatureMode: (...args) => memory.setFeatureMode(...args),
      setThreadMode: (...args) => memory.setThreadMode(...args),
      reset: (...args) => memory.reset(...args),
    },
    automations: {
      request: (...args) => automationService.request(...args),
      subscribe: (...args) => automationService.subscribe(...args),
      wake: () => automationService.wake(),
    },
    skills: {
      processEnvironment: (...args) => managedSkills.processEnvironment(...args),
      updateRuntimeSettings: (settings) => managedSkills.updateRuntimeSettings(settings),
      list: (userInvocableOnly) => managedSkills.listPrimarySkills(userInvocableOnly),
      undoAgentEdit: (skillName) => managedSkills.undoPrimarySkillEdit(skillName),
      catalog: managedSkills.catalog,
    },
    projectionChanged: (update, operation) => {
      try {
        memory.projectionChanged({ update, ...(operation ? { operation } : {}) });
      } catch (error) {
        options.reportError({
          domain: 'memory',
          severity: 'error',
          code: 'memory-runtime-projection-observer-failed',
          message: 'Memory Runtime projection observer failed.',
          context: { operation: 'runtime-projection-observer' },
          error,
        });
      }
    },
    initialize: lifecycle.initialize,
    close: lifecycle.close,
  };
}
