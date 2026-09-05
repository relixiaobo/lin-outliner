import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  AgentDelegationSettings,
  AgentRuntimeSettings,
  DocumentProjection,
  ProjectionUpdate,
} from '../../core/types';
import type { EffectiveThreadConfiguration } from '../../core/agent/configuration';
import type { AutomationConfiguration } from '../../core/agent/automation';
import type { ErrorReport } from '../../core/errorObservability';
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
import {
  DelegateRuntimeHost,
  DelegationCoordinator,
  DelegationSessionStore,
  InternalDelegationSessionRuntime,
  createInternalDelegationRunnerRegistry,
  delegationSettingsRevision,
  resolveConfiguredInternalModel,
  schedulingPolicyDigest,
} from '../agent/delegation';
import { decodeDelegateRunInput, type DelegateStateCommand } from '../../delegate/contract';
import {
  type DelegateCliRuntimeConfig,
  withDelegateCliShellEnvironment,
} from '../delegateRuntime';
import { openSqlite } from '../agent/persistence/sqlite';
import { uuidV7 } from '../agent/uuid';
import type { TurnExecutionContext } from '../agent/runtime/types';
import { AgentWorktree } from '../agent/worktree/AgentWorktree';
import type { ToolTaskSupervisorRuntime } from '../agent/tasks/toolTaskRuntime';
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
  readonly toolTaskSupervisorRuntime?: ToolTaskSupervisorRuntime;
  readonly delegateCliRuntime: DelegateCliRuntimeConfig;
  readonly loadRuntimeSettings: () => Promise<AgentRuntimeSettings>;
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
  resolveIdentityCatalogForUserPath: AgentConfigurationLoader['resolveIdentityCatalogForUserPath'];
  resolveThreadPersona: AgentConfigurationLoader['resolveThreadPersona'];
}

export interface AgentConfigurationCapability {
  resolveIdentityCatalog: AgentConfigurationLoader['resolveIdentityCatalog'];
  listPresentationOverrides: AgentConfigurationLoader['listPresentationOverrides'];
  resolveEditableProfile: AgentConfigurationLoader['resolveEditableProfile'];
  writeProfile: AgentConfigurationWriter['writeProfile'];
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
  subscribeRenderer: ThreadService['subscribeRenderer'];
  writeThreadResourceWithStatus: ThreadService['writeThreadResourceWithStatus'];
  waitForIdle: ThreadService['waitForIdle'];
  readThread: ThreadService['readThread'];
  threadTranscriptPath: ThreadService['threadTranscriptPath'];
  resolveAttachmentFile: ThreadService['resolveAttachmentFile'];
  resolveThreadResourceFile: ThreadService['resolveThreadResourceFile'];
  resolveThreadResourceSource: ThreadService['resolveThreadResourceSource'];
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
    readonly delegation?: { readonly enabled: boolean };
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
  const delegationReference = assignOnce<DelegationCoordinator>('DelegationCoordinator');
  const configurationComposition: AgentConfigurationCompositionCapability = {
    resolveProfile: (...args) => configurationLoader.resolveProfile(...args),
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
    captureLocalFile: (threadId, sourcePath, mimeType, fileName) => (
      threadReference.get().captureThreadLocalFile(threadId, sourcePath, mimeType, fileName)
    ),
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
    delegationCoordinator: () => delegationReference.get(),
    ...(options.toolTaskSupervisorRuntime === undefined
      ? {}
      : { toolTaskSupervisorRuntime: options.toolTaskSupervisorRuntime }),
  });
  threadReference.set(threadService);
  const delegationDatabase = openSqlite(join(options.userDataDir, 'agent', 'delegation.sqlite'));
  const delegationStore = new DelegationSessionStore(delegationDatabase);
  const delegationRuntime = new InternalDelegationSessionRuntime(threadService, delegationStore, worktree);
  const delegationCoordinator = new DelegationCoordinator({
    store: delegationStore,
    runtime: delegationRuntime,
    preparedResults: {
      prepare: (taskId, ownerThreadId, bytes) => (
        threadService.toolTaskService().prepareResult(taskId, ownerThreadId, bytes)
      ),
      read: (taskId, ownerThreadId) => (
        threadService.toolTaskService().readPreparedResult(taskId, ownerThreadId)
      ),
    },
  });
  delegationReference.set(delegationCoordinator);
  const runnerRegistry = createInternalDelegationRunnerRegistry();
  const loadDelegationConfiguration = async () => {
    const settings = (await options.loadRuntimeSettings()).delegation;
    return { settings, revision: delegationSettingsRevision(settings) };
  };
  const delegationHost = new DelegateRuntimeHost({
    cli: options.delegateCliRuntime,
    socketPath: join(options.userDataDir, 'agent', 'delegate-broker.sock'),
    currentConfigurationRevision: async () => (await loadDelegationConfiguration()).revision,
    resolveAdmission: async (input) => {
      const source = threadService.delegationAdmissionContext(
        input.source.rootThreadId,
        input.source.sourceTurnId,
      );
      const { settings, revision } = await loadDelegationConfiguration();
      const capabilityCeilingDigest = digestJson([...source.configuration.tools].sort());
      if (input.command.name === 'run') {
        const request = decodeDelegateRunInput(JSON.parse(input.stdin) as unknown);
        const parentModelId = source.configuration.model.includes('/')
          ? source.configuration.model
          : `${source.thread.modelProvider}/${source.configuration.model}`;
        const parentModel = await resolveConfiguredInternalModel(
          parentModelId,
          source.configuration.reasoningEffort,
        );
        if (!parentModel) throw new Error(`Invoking root model is unavailable: ${parentModelId}`);
        const policy = await runnerRegistry.resolve({
          settings,
          configurationRevision: revision,
          parentModel,
          profile: request.profile,
          requestedAccess: request.access,
        });
        const { scheduling, schedulerLimits: _schedulerLimits, ...capabilityPolicy } = policy;
        return {
          rootUserIntentRevision: source.rootUserIntentRevision,
          policy: {
            ...capabilityPolicy,
            capabilityCeilingDigest,
            schedulingPolicyDigest: schedulingPolicyDigest(scheduling),
          },
          session: { kind: 'run', preallocatedSessionId: uuidV7() },
        };
      }
      const sessionId = input.command.name === 'close'
        ? input.command.sessionId
        : input.command.target.kind === 'session'
          ? input.command.target.id
          : delegationStore.settlementForTask(input.command.target.id)?.sessionId;
      if (!sessionId) throw new Error('Delegation Session target is unavailable.');
      const session = delegationStore.readSession(sessionId);
      if (!session || session.ownerThreadId !== source.thread.id) {
        throw new Error('Delegation Session is not owned by the invoking root Thread.');
      }
      if (session.policy.modelProvider === null || session.policy.modelId === null || session.policy.effort === null) {
        throw new Error('Delegation Session has no runnable model policy.');
      }
      const resolvedScheduling = delegationScheduling(input.command, settings, revision, delegationStore, source.thread.id);
      const continuationPolicy = input.command.name === 'send'
        ? await runnerRegistry.resolveContinuation({
            settings,
            configurationRevision: revision,
            runnerId: session.policy.runnerId,
            runnerVersion: session.policy.runnerVersion,
            modelProvider: session.policy.modelProvider,
            modelId: session.policy.modelId,
            effort: session.policy.effort,
            profile: session.policy.profile,
            access: session.policy.access,
          })
        : null;
      return {
        rootUserIntentRevision: source.rootUserIntentRevision,
        policy: continuationPolicy ? {
          configurationRevision: continuationPolicy.configurationRevision,
          capabilityCeilingDigest,
          runnerId: continuationPolicy.runnerId,
          runnerVersion: continuationPolicy.runnerVersion,
          modelProvider: continuationPolicy.modelProvider,
          modelId: continuationPolicy.modelId,
          effort: continuationPolicy.effort,
          profile: continuationPolicy.profile,
          access: continuationPolicy.access,
          timeoutMs: continuationPolicy.timeoutMs,
          schedulingPolicyDigest: schedulingPolicyDigest(continuationPolicy.scheduling),
        } : {
          configurationRevision: revision,
          capabilityCeilingDigest,
          runnerId: session.policy.runnerId,
          runnerVersion: session.policy.runnerVersion,
          modelProvider: session.policy.modelProvider,
          modelId: session.policy.modelId,
          effort: session.policy.effort,
          profile: session.policy.profile,
          access: session.policy.access,
          timeoutMs: resolvedScheduling.timeoutMs,
          schedulingPolicyDigest: schedulingPolicyDigest(resolvedScheduling.scheduling),
        },
        session: input.command.name === 'close'
          ? { kind: 'close', sessionId, sessionRevision: session.revision }
          : {
              kind: 'send',
              sessionId,
              sessionRevision: session.revision,
              minimumResumeRevision: session.stopFence?.minimumResumeRevision ?? null,
            },
      };
    },
    execute: (execution) => delegationCoordinator.execute(execution),
  });
  const threads: AgentThreadCapability = {
    request: (...args) => threadService.request(...args),
    subscribe: (...args) => threadService.subscribe(...args),
    subscribeRenderer: (...args) => threadService.subscribeRenderer(...args),
    writeThreadResourceWithStatus: (...args) => threadService.writeThreadResourceWithStatus(...args),
    waitForIdle: (...args) => threadService.waitForIdle(...args),
    readThread: (...args) => threadService.readThread(...args),
    threadTranscriptPath: (...args) => threadService.threadTranscriptPath(...args),
    resolveAttachmentFile: (...args) => threadService.resolveAttachmentFile(...args),
    resolveThreadResourceFile: (...args) => threadService.resolveThreadResourceFile(...args),
    resolveThreadResourceSource: (...args) => threadService.resolveThreadResourceSource(...args),
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
  extensions.register(memory, { applicationInstructions: true });

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
    const delegationSession = context.thread.threadSource === 'delegation'
      ? delegationStore.readSession(context.thread.id)
      : null;
    const delegationMetadata = delegationSession
      && (delegationSession.worktree.kind === 'active'
        || delegationSession.worktree.kind === 'unchanged'
        || delegationSession.worktree.kind === 'changed'
        || delegationSession.worktree.kind === 'retained')
      ? delegationSession.worktree.metadata
      : null;
    const delegationSandbox = delegationMetadata ? worktree.sandboxPaths(delegationMetadata) : null;
    const processEnvironment = context.thread.threadSource === 'user'
      && context.thread.parentThreadId === null
      ? withDelegateCliEnvironment(workspaceOptions.processEnvironment, options.delegateCliRuntime)
      : workspaceOptions.processEnvironment;
    return createAgentLocalWorkspaceContext(
      context.thread.cwd,
      options.scratchRoot,
      managedSkills.runtimeForTurn(context.turn.id),
      processEnvironment,
      delegationSandbox
        ? {
            root: delegationMetadata!.path,
            shellWritablePaths: delegationSandbox.writablePaths,
            protectedGitObjectStores: delegationSandbox.protectedGitObjectStores,
          }
        : workspaceOptions.writeBoundary,
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
    delegationPolicy: (threadId) => {
      const session = delegationStore.readSession(threadId);
      return session ? { profile: session.policy.profile, access: session.policy.access } : null;
    },
    delegateCommandRuntime: async (context) => {
      if (context.thread.threadSource !== 'user' || context.thread.parentThreadId !== null) return undefined;
      const { settings } = await loadDelegationConfiguration();
      if (!settings.enabled) return undefined;
      return delegationHost.commandRuntime(async (command) => {
        const current = await loadDelegationConfiguration();
        const resolved = delegationScheduling(
          command,
          current.settings,
          current.revision,
          delegationStore,
          context.thread.id,
        );
        return resolved;
      });
    },
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
    delegation: {
      start: () => delegationHost.start(),
      initialize: () => delegationCoordinator.initialize(),
      stop: () => delegationHost.stop(),
      closeStore: () => delegationDatabase.close(),
    },
  });

  return {
    configuration: {
      resolveIdentityCatalog: (...args) => configurationLoader.resolveIdentityCatalog(...args),
      listPresentationOverrides: (...args) => configurationLoader.listPresentationOverrides(...args),
      resolveEditableProfile: (...args) => configurationLoader.resolveEditableProfile(...args),
      writeProfile: (...args) => configurationWriter.writeProfile(...args),
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

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function withDelegateCliEnvironment(
  base: AgentShellProcessEnvironmentProvider,
  runtime: DelegateCliRuntimeConfig,
): AgentShellProcessEnvironmentProvider {
  return async (context: AgentShellProcessEnvironmentContext) => {
    const environment = await base(context);
    return withDelegateCliShellEnvironment(runtime, environment);
  };
}

function delegationScheduling(
  command: DelegateStateCommand,
  settings: AgentDelegationSettings,
  configurationRevision: string,
  store: DelegationSessionStore,
  ownerThreadId: string,
): {
  readonly scheduling: {
    readonly pool: string;
    readonly configurationRevision: string;
    readonly maxConcurrentProducer: number;
    readonly maxConcurrentPool: number;
  };
  readonly schedulerLimits: {
    readonly maxConcurrentGlobal: number;
    readonly maxConcurrentThread: number;
    readonly maxQueuedGlobal: number;
    readonly maxQueuedThread: number;
  };
  readonly timeoutMs: number;
} {
  const targetSessionId = command.name === 'run'
    ? null
    : command.name === 'close'
      ? command.sessionId
      : command.target.kind === 'session'
        ? command.target.id
        : store.settlementForTask(command.target.id)?.sessionId ?? null;
  const targetSession = targetSessionId ? store.readSession(targetSessionId) : null;
  const runnerId = targetSession?.ownerThreadId === ownerThreadId
    ? targetSession.policy.runnerId
    : settings.defaultRunnerId;
  const runner = settings.runners[runnerId];
  return {
    scheduling: {
      pool: runner?.pool ?? runnerId,
      configurationRevision,
      maxConcurrentProducer: runner?.maxConcurrent ?? 1,
      maxConcurrentPool: runner?.maxConcurrentPool ?? 1,
    },
    schedulerLimits: {
      maxConcurrentGlobal: settings.maxConcurrentGlobal,
      maxConcurrentThread: settings.maxConcurrentThread,
      maxQueuedGlobal: settings.maxQueuedGlobal,
      maxQueuedThread: settings.maxQueuedThread,
    },
    timeoutMs: runner?.timeoutMs ?? 60_000,
  };
}
