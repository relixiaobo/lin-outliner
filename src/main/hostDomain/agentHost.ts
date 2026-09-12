import { ScheduledRunOwnership } from '../agent/automations/ScheduledRunOwnership';
import { UNRESTRICTED_RESTORED_WORK, type RestoredWorkAdmission } from '../agent/restoredWork';
import { ScheduleCliService, SCHEDULE_CLI_CONFIGURATION_REVISION, scheduleCliScheduling } from '../agent/automations/ScheduleCliService';
import { ProfileFileStore } from '../agent/profile/ProfileFileStore';
import { ProjectCliService, PROJECT_CLI_CONFIGURATION_REVISION, projectCliScheduling } from '../agent/projects/ProjectCliService';
import { ResourceScope } from '../resourceScope';
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
import type { SkillOperationCaller } from './skillLifecycle';
import { createMemoryOperations, type MemoryOperations, type OpenMemory, type ReviewMemoryReset } from './memoryOperations';
import { projectAutomationLifecycle } from '../agent/projects/projectAutomationLifecycle';
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
  createDelegationRunnerRegistry,
  delegationSettingsRevision,
  resolveConfiguredInternalModel,
  schedulingPolicyDigest,
  type DelegationRunnerReadiness,
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
  | 'recordRoot'
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
  readonly restoredWork?: RestoredWorkAdmission;
  readonly onScheduledAttention?: (notice: import('../agent/automations/AutomationService').ScheduledAttentionNotice) => void;
  readonly readMemoryEnabled?: () => boolean;
  readonly reviewMemoryReset: ReviewMemoryReset;
  readonly openMemory: OpenMemory;
  readonly onMemoryChanged: () => void;
  readonly reviewSkillOperation: import('./skillLifecycle').ReviewSkillOperation;
  readonly onSkillLibraryChanged: () => void;
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
  readonly delegationRunners: () => Promise<readonly DelegationRunnerReadiness[]>;
  projectionChanged(update: ProjectionUpdate, operation?: Operation): void;
  initialize(projection: DocumentProjection, assertActive?: () => void): Promise<void>;
  initializeRecoveryOnly(): Promise<void>;
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
  inspectSources: AgentConfigurationLoader['inspectSources'];
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
  conversationRecovery: ThreadService['conversationRecovery'];
  subscribeRecovery: ThreadService['subscribeRecovery'];
  startupIssues: ThreadService['startupIssues'];
  startupThreadAvailability: ThreadService['startupThreadAvailability'];
  request: ThreadService['request'];
  subscribe: ThreadService['subscribe'];
  subscribeRenderer: ThreadService['subscribeRenderer'];
  writeThreadResourceWithStatus: ThreadService['writeThreadResourceWithStatus'];
  waitForIdle: ThreadService['waitForIdle'];
  reconcileUserInputsOnResume: ThreadService['reconcileUserInputsOnResume'];
  readThread: ThreadService['readThread'];
  threadRecordPath: ThreadService['threadRecordPath'];
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
  view: MemoryExtension['view'];
  setFeatureMode: MemoryExtension['setFeatureMode'];
  operations: MemoryOperations;
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
    readonly additionalSkillSourceModes?: Readonly<Record<string, 'skill' | 'container'>>;
    readonly disabledSkills?: readonly string[];
    readonly delegation?: { readonly enabled: boolean };
  }): void;
  list(userInvocableOnly: boolean): ReturnType<ReturnType<typeof createManagedSkillsHost>['listPrimarySkills']>;
  listCurationCandidates(): ReturnType<ReturnType<typeof createManagedSkillsHost>['listPrimaryCurationCandidates']>;
  manage(input: unknown, caller: Pick<SkillOperationCaller, 'origin' | 'authorize' | 'signal'>): Promise<unknown>;
  readonly catalog: {
    load: ManagedSkillService['loadCatalog'];
    discover: ManagedSkillService['discover'];
    list: ManagedSkillService['list'];
    checkUpdates: ManagedSkillService['checkUpdates'];
    previewUpdate: ManagedSkillService['previewUpdate'];
  };
}

export async function createAgentHost(options: AgentHostOptions): Promise<AgentHost> {
  const acquisition = new ResourceScope('agent-host-construction');
  try {
    return await composeAgentHost(options, acquisition);
  } catch (error) {
    return acquisition.fail(error);
  }
}

async function composeAgentHost(options: AgentHostOptions, acquisition: ResourceScope): Promise<AgentHost> {
  let admissionOpen = false;
  let recoveryOnly = false;
  const restoredWork = options.restoredWork ?? UNRESTRICTED_RESTORED_WORK;
  const managedSkills = createManagedSkillsHost({
    userDataDir: options.userDataDir,
    localRoot: options.defaultCwd,
    scratchRoot: options.scratchRoot,
    appVersion: options.appVersion,
    loadRuntimeSettings: options.loadRuntimeSettings,
    reviewSkillOperation: options.reviewSkillOperation,
    onLibraryChanged: options.onSkillLibraryChanged,
  });
  const extensions = new ExtensionRegistry();
  const memoryControl = new MemoryControlStore(join(options.userDataDir, 'agent', 'memories.sqlite'));
  memoryControl.setRestoredJobIds(restoredWork.blockedIdentities('memory-job'));
  acquisition.defer('memory-control', () => memoryControl.close());
  let profiles: ProfileFileStore | undefined;
  try {
    profiles = new ProfileFileStore(options.userDataDir, undefined, Date.now, restoredWork);
    const acquired = profiles;
    acquisition.defer('profile-files', () => acquired.close());
  } catch (error) {
    options.reportError({ domain: 'memory', severity: 'warn', code: 'profile-files-unavailable',
      message: 'Optional Profile context is unavailable; ordinary conversations remain available.', error });
  }
  const memoryTimeline = new TimelineMemoryStore(options.timeline);
  const memory = new MemoryExtension(memoryControl, memoryTimeline, {
    profiles,
    canRun: () => admissionOpen && restoredWork.automaticSchedulingAllowed(),
    restoredGeneration: restoredWork.generation,
    restoredWork,
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
    resolveThreadRecord: (currentThreadId, threadId) => threadReference.get().resolveThreadRecord(currentThreadId, threadId),
    onContextReplaced: (context) => toolReference.get().invalidateFileContext(context),
    beforeProviderContext: (context) => toolReference.get().prepareProviderContext(context),
  });
  const threadService = await ThreadService.open(options.userDataDir, turnExecutor, {
    ...options.createThreadOptions(composition),
    restoredWork,
    attachmentScratchRoot: options.scratchRoot,
    nameGenerator: turnExecutor,
    resolveUserContent: (content, context) => attachmentResolver.resolve(content, context),
    extensions,
    beforeInitialTurnAdmission: () => memory.prepareForTurnAdmission(),
    canStartTurn: () => admissionOpen,
    resolveSkillAdmission: (input) => managedSkills.resolveAdmission(
      input,
      options.createAdmissionSkillRuntimeOptions(input, composition),
    ),
    delegationCoordinator: () => delegationReference.get(),
    ...(options.toolTaskSupervisorRuntime === undefined
      ? {}
      : { toolTaskSupervisorRuntime: options.toolTaskSupervisorRuntime }),
  });
  acquisition.defer('threads', () => threadService.close());
  threadReference.set(threadService);
  const delegationDatabase = openSqlite(join(options.userDataDir, 'agent', 'delegation.sqlite'));
  acquisition.defer('delegation-database', () => delegationDatabase.close());
  const delegationStore = new DelegationSessionStore(delegationDatabase);
  const runnerRegistry = createDelegationRunnerRegistry();
  const delegationRuntime = new InternalDelegationSessionRuntime(
    threadService,
    delegationStore,
    worktree,
    Date.now,
    runnerRegistry,
  );
  const delegationCoordinator = new DelegationCoordinator({
    canRecoverSession: (id) => restoredWork.allows('session', id),
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
  const loadDelegationConfiguration = async () => {
    const settings = (await options.loadRuntimeSettings()).delegation;
    return { settings, revision: delegationSettingsRevision(settings) };
  };
  const projectCli = new ProjectCliService(threadService.projects,
    (execution) => toolReference.get().authorizeHostCliInvocation(execution),
    (request, signal) => threadService.reviewProjectChange(threadService.projects.proposal(request), signal));
  const scheduleCli = new ScheduleCliService(() => automationService, (execution) => toolReference.get().authorizeHostCliInvocation(execution));
  const delegationHost = new DelegateRuntimeHost({
    cli: options.delegateCliRuntime,
    socketPath: join(options.userDataDir, 'agent', 'delegate-broker.sock'),
    currentConfigurationRevision: async (command) => command?.name === 'schedule' ? SCHEDULE_CLI_CONFIGURATION_REVISION : command?.name === 'project' ? PROJECT_CLI_CONFIGURATION_REVISION : (await loadDelegationConfiguration()).revision,
    resolveAdmission: async (input) => {
      if (!admissionOpen) throw new Error('Agent execution is unavailable');
      const source = threadService.delegationAdmissionContext(
        input.source.rootThreadId,
        input.source.sourceTurnId,
      );
      if (input.command.name === 'project' || input.command.name === 'schedule') {
        const context = threadService.projectInvocationContext(input.source.rootThreadId, input.source.sourceTurnId, input.source.sourceItemId);
        if (!context.configuration.tools.includes('bash')) throw new Error('Project commands require Bash capability');
        return { rootUserIntentRevision: context.rootUserIntentRevision, session: { kind: input.command.name }, policy: {
          configurationRevision: input.command.name === 'schedule' ? SCHEDULE_CLI_CONFIGURATION_REVISION : PROJECT_CLI_CONFIGURATION_REVISION,
          capabilityCeilingDigest: digestJson([...context.configuration.tools].sort()),
          runnerId: input.command.name === 'schedule' ? 'schedule-host' : 'project-host', runnerVersion: null, modelProvider: context.thread.modelProvider,
          modelId: context.configuration.model, effort: context.configuration.reasoningEffort,
          profile: 'general', access: 'workspace-write', timeoutMs: 120_000,
          schedulingPolicyDigest: schedulingPolicyDigest((input.command.name === 'schedule' ? scheduleCliScheduling() : projectCliScheduling()).scheduling),
        } };
      }
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
          runnerId: request.runner,
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
    execute: (execution) => execution.admission.command.name === 'schedule' ? scheduleCli.execute(execution) : execution.admission.command.name === 'project' ? projectCli.execute(execution) : delegationCoordinator.execute(execution),
  });
  const threads: AgentThreadCapability = {
    conversationRecovery: () => threadService.conversationRecovery(),
    subscribeRecovery: (listener) => threadService.subscribeRecovery(listener),
    startupIssues: () => threadService.startupIssues(),
    startupThreadAvailability: () => threadService.startupThreadAvailability(),
    request: (...args) => threadService.request(...args),
    subscribe: (...args) => threadService.subscribe(...args),
    subscribeRenderer: (...args) => threadService.subscribeRenderer(...args),
    writeThreadResourceWithStatus: (...args) => threadService.writeThreadResourceWithStatus(...args),
    waitForIdle: (...args) => threadService.waitForIdle(...args),
    reconcileUserInputsOnResume: () => threadService.reconcileUserInputsOnResume(),
    readThread: (...args) => threadService.readThread(...args),
    threadRecordPath: (...args) => threadService.threadRecordPath(...args),
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
  acquisition.defer('memory-subscription', memory.subscribe(options.onMemoryChanged));
  const memoryOperations = createMemoryOperations({ memory, review: options.reviewMemoryReset, open: options.openMemory });
  extensions.register(memory, { applicationInstructions: true });

  const automationStore = new AutomationStore(join(options.userDataDir, 'agent', 'scheduled-tasks.sqlite'));
  automationStore.setRestoredRunIds(restoredWork.blockedIdentities('run'));
  acquisition.defer('automations', () => automationStore.close());
  automationStore.bindProjectResolver((id) => threadService.projects.store.require(id));
  const automationWorktree = new AutomationWorktree(options.userDataDir);
  const automationReference = assignOnce<AutomationService>('AutomationService');
  const scheduledOwnership = new ScheduledRunOwnership(automationStore, threadService);
  const automationDispatcher = new AutomationDispatcher({
    holdsForegroundSlot: (run) => {
      const active = run.threadId ? threadService.activeTurnIdForHost(run.threadId) : null;
      return (!!active && scheduledOwnership.forTurn(run.threadId!, active)?.id === run.id)
        || scheduledOwnership.processes(run).some((task) => task.state === 'settling' && (task.error !== null || task.stopRequestedAt !== null));
    },
    canDispatch: () => admissionOpen && restoredWork.automaticSchedulingAllowed(),
    canRecoverRun: (id) => restoredWork.allows('run', id),
    store: automationStore,
    threads: threadService,
    worktrees: automationWorktree,
    defaultCwd: options.defaultCwd,
    resolveConfiguration: (selection, cwd) => options.resolveAutomationConfiguration(selection, cwd, composition),
    validateEffectiveConfiguration: options.validateAutomationConfiguration,
    onRunChanged: (run) => automationReference.get().runChanged(run),
  });
  const automationScheduler = new AutomationScheduler({
    canSchedule: () => restoredWork.automaticSchedulingAllowed(),
    store: automationStore,
    dispatcher: automationDispatcher,
    onAutomationChanged: (automation) => automationReference.get().automationChanged(automation),
    onRunChanged: (run) => automationReference.get().runChanged(run),
  });
  const automationService = new AutomationService({
    onAttention: options.onScheduledAttention,
    store: automationStore,
    scheduler: automationScheduler,
    dispatcher: automationDispatcher,
    threads: threadService,
    resolveProjectHint: (id) => threadService.projects.store.require(id),
    beforeSchedulerStart: () => threadService.projects.initialize(),
  });
  threadService.projects.attachAutomation(projectAutomationLifecycle(automationStore, automationScheduler, automationDispatcher));
  threadService.bindRecoveryOwners([
    {
      name: 'scheduled-tasks',
      withLock: (_ids, operation) => automationScheduler.runExclusive(operation),
      inspect: async (ids) => {
        const observed = automationStore.recoveryState(ids);
        return { state: observed.state, blockers: observed.runs.flatMap((run) =>
          run.worktree && run.worktree.removedAt === null
            ? [`Scheduled run ${run.id} has a retained workspace that must settle through its owner.`] : []) };
      },
      retain: (_ids, evidence) => automationStore.retainRecovery(evidence),
      remove: async (ids) => { automationStore.removeRecoveryThreads(ids); },
    },
    memory.recoveryParticipant(),
    delegationCoordinator.recoveryParticipant(),
  ]);
  automationReference.set(automationService);
  threadService.bindScheduledCompletionAdmission((threadId, admission, operation) => {
    const owner = scheduledOwnership.forBatch(admission.batchId, threadId);
    if (!owner) return threadService.isScheduledThread(threadId) ? Promise.resolve(false) : operation();
    return automationScheduler.admitContinuation(owner.id, () => {
      if (scheduledOwnership.forBatch(admission.batchId, threadId)?.id !== owner.id) return Promise.resolve(false);
      return operation();
    });
  });

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
    if (delegationSession?.policy.worktreePolicy === 'dedicated' && !delegationMetadata) {
      throw new Error('Delegation execution requires its admitted worktree resource.');
    }
    const processEnvironment = context.thread.threadSource === 'user'
      && context.thread.parentThreadId === null
      ? withDelegateCliEnvironment(workspaceOptions.processEnvironment, options.delegateCliRuntime)
      : workspaceOptions.processEnvironment;
    return {
      ...createAgentLocalWorkspaceContext(
        threadService.defaultExecutionDirectory(),
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
      ),
      writeManagedFile: (input: { path: string; content: string; previousContent: string | null; operationId: string }) => memory.writeProfileFile(input, context.thread, context.turn),
      ...(delegationSession ? {
        parentTaskId: threadService.toolTaskService().store.sessionExecution(delegationSession.sessionId)?.taskId,
      } : {}),
      ...(delegationMetadata ? { validateIsolation: () => worktree.validate(delegationMetadata) } : {}),
    };
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
    delegationPolicy: (threadId) => {
      const session = delegationStore.readSession(threadId);
      return session ? { profile: session.policy.profile, access: session.policy.access } : null;
    },
    delegateCommandRuntime: async (context) => {
      if (context.thread.threadSource !== 'user' || context.thread.parentThreadId !== null) return undefined;
      return delegationHost.commandRuntime(async ({ command, stdin }) => {
        if (command.name === 'schedule') return scheduleCliScheduling();
        if (command.name === 'project') return projectCliScheduling();
        const current = await loadDelegationConfiguration();
        if (!current.settings.enabled) throw new Error('Agent delegation is disabled');
        const resolved = delegationScheduling(
          command,
          current.settings,
          current.revision,
          delegationStore,
          context.thread.id,
          stdin,
        );
        return resolved;
      });
    },
  });
  toolReference.set(toolRuntime);
  acquisition.defer('thread-subscription', threadService.subscribe((notification) => {
    if (notification.type === 'turn/completed') managedSkills.clearTurn(notification.turnId);
    if (notification.type === 'userInput/requested' || (notification.type === 'turn/completed' && notification.turn.status === 'failed')) {
      const turnId = notification.type === 'userInput/requested' ? notification.request.turnId : notification.turnId;
      try {
        const owner = scheduledOwnership.forTurn(notification.threadId, turnId);
        if (owner) options.onScheduledAttention?.({ automationId: owner.automationId, name: owner.snapshot.automationName,
          kind: notification.type === 'userInput/requested' ? 'question' : 'failure',
          key: notification.type === 'userInput/requested' ? `${turnId}:${notification.request.hostGeneration}:${notification.request.itemId}` : `turn:${turnId}` });
      } catch { /* An inspection-only notification cannot interrupt the execution owner. */ }
    }
    if (notification.type === 'turn/completed' || notification.type === 'thread/status/changed') {
      automationService.wake();
    }
  }));
  const lifecycle = createAgentHostLifecycle({
    memory,
    threads: {
      initialize: () => threadService.initialize(),
      close: () => threadService.close(undefined, recoveryOnly ? 'inspection' : 'normal'),
    },
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
      inspectSources: (...args) => configurationLoader.inspectSources(...args),
      writeProfile: (...args) => configurationWriter.writeProfile(...args),
    },
    worktrees: {
      sandboxPaths: (...args) => worktree.sandboxPaths(...args),
    },
    threads,
    memory: {
      view: (...args) => memory.view(...args),
      setFeatureMode: (...args) => memory.setFeatureMode(...args),
      operations: memoryOperations,
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
      listCurationCandidates: () => managedSkills.listPrimaryCurationCandidates(),
      manage: (input, caller) => managedSkills.manageForWindow(input, caller),
      catalog: managedSkills.catalog,
    },
    delegationRunners: async () => {
      const settings = (await options.loadRuntimeSettings()).delegation;
      return runnerRegistry.readiness(settings);
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
    initialize: async (projection, assertActive) => {
      await lifecycle.initialize(projection, assertActive);
      if (options.readMemoryEnabled) {
        const mode = options.readMemoryEnabled() ? 'enabled' : 'disabled';
        if ((await memory.view()).status.featureMode !== mode) await memory.setFeatureMode(mode);
      }
      assertActive?.();
      admissionOpen = true;
      memory.wakeWorker();
      automationService.wake();
      const tasks = threadService.toolTaskService();
      for (const owner of tasks.store.ownersWithPendingDelivery()) tasks.wakeDelivery(owner);
    },
    initializeRecoveryOnly: async () => {
      recoveryOnly = true;
      admissionOpen = false;
      await threadService.initializeRecoveryOnly();
    },
    close: () => {
      admissionOpen = false;
      return lifecycle.close();
    },
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
  stdin?: string,
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
  if (command.name === 'schedule') return scheduleCliScheduling();
        if (command.name === 'project') return projectCliScheduling();
  const targetSessionId = command.name === 'run'
    ? null
    : command.name === 'close'
      ? command.sessionId
      : command.target.kind === 'session'
        ? command.target.id
        : store.settlementForTask(command.target.id)?.sessionId ?? null;
  const targetSession = targetSessionId ? store.readSession(targetSessionId) : null;
  const requestedRunnerId = command.name === 'run' && stdin
    ? readRequestedRunnerId(stdin)
    : undefined;
  const runnerId = targetSession?.ownerThreadId === ownerThreadId
    ? targetSession.policy.runnerId
    : requestedRunnerId ?? settings.defaultRunnerId;
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

function readRequestedRunnerId(stdin: string): string | undefined {
  try {
    const value = JSON.parse(stdin) as { runner?: unknown };
    return typeof value.runner === 'string' ? value.runner : undefined;
  } catch {
    return undefined;
  }
}
