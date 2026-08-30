import { join } from 'node:path';
import type { EffectiveThreadConfiguration } from '../../core/agent/configuration';
import type { AutomationConfiguration } from '../../core/agent/automation';
import type { ErrorReport } from '../../core/errorObservability';
import type { DocumentProjection, ProjectionUpdate } from '../../core/types';
import type { Operation } from '../../outline/contract';
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
import { AgentWorktree } from '../agent/worktree/AgentWorktree';
import { AttachmentResolver, type AttachmentResolverOptions } from '../agent/tools/attachments';
import { createManagedSkillsHost, type ManagedSkillsHost } from './managedSkillsHost';
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
>;

export interface AgentHostComposition {
  readonly configurationLoader: AgentConfigurationLoader;
  readonly configurationWriter: AgentConfigurationWriter;
  readonly worktree: AgentWorktree;
  readonly memory: MemoryExtension;
  readonly extensions: ExtensionRegistry;
  readonly threadService: () => ThreadService;
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
  readonly prepareImageArtifact: AttachmentResolverOptions['prepareImageArtifact'];
  readonly createTurnExecutorOptions: (
    composition: AgentHostComposition,
  ) => Omit<PiTurnExecutorOptions, 'createTools' | 'beforeProviderContext'>;
  readonly createThreadOptions: (composition: AgentHostComposition) => ThreadHostOptions;
  readonly createToolOptions: (composition: AgentHostComposition) => Omit<ToolRuntimeOptions, 'dynamicTools'>;
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
  readonly configurationLoader: AgentConfigurationLoader;
  readonly configurationWriter: AgentConfigurationWriter;
  readonly worktree: AgentWorktree;
  readonly memory: MemoryExtension;
  readonly threadService: ThreadService;
  readonly automationService: AutomationService;
  readonly toolRuntime: ToolRuntime;
  readonly managedSkills: ManagedSkillsHost;
  projectionChanged(update: ProjectionUpdate, operation?: Operation): void;
  initialize(projection: DocumentProjection): Promise<void>;
  close(): Promise<void>;
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
  const toolReference = assignOnce<ToolRuntime>('ToolRuntime');
  const composition: AgentHostComposition = {
    configurationLoader,
    configurationWriter,
    worktree,
    memory,
    extensions,
    threadService: threadReference.get,
  };
  const attachmentResolver = new AttachmentResolver({
    useResourcePath: (threadId, ref, use) => threadReference.get().useThreadResourcePath(threadId, ref, use),
    prepareImageArtifact: options.prepareImageArtifact,
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
  });
  threadReference.set(threadService);
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
  const toolRuntime = new ToolRuntime(threadService, {
    ...options.createToolOptions(composition),
    dynamicTools: () => [createAutomationTool(automationService)],
  });
  toolReference.set(toolRuntime);
  const lifecycle = createAgentHostLifecycle({
    memory,
    threads: threadService,
    automations: automationService,
  });

  return {
    configurationLoader,
    configurationWriter,
    worktree,
    memory,
    threadService,
    automationService,
    toolRuntime,
    managedSkills,
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
