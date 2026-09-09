import { pruneAgentScratch } from '../agent/capabilities/agentAttachmentMaterialization';
import { createAgentSkillProvenanceStore } from '../agent/capabilities/agentSkillProvenanceStore';
import {
  AgentSkillRuntime,
  skillLifecycleIdentity,
  resolvePreloadedSkillInvocations,
  resolveUserSkillInvocation,
  type SkillLoadOptions,
} from '../agent/capabilities/agentSkills';
import type {
  SkillAdmissionResolution,
  SkillAdmissionResolutionInput,
} from '../agent/ThreadService';
import type { TurnExecutionContext } from '../agent/runtime/types';
import { observedSkillFilePaths } from '../agent/context/SkillContextReducer';
import type { ThreadUserContent } from '../../core/agent/protocol';
import { BROWSER_PILOT_MANAGED_SKILL_ID, BrowserPilotHost } from '../browserPilotHost';
import { DEFAULT_MANAGED_SKILLS } from '../managedSkillDefaults';
import { ManagedSkillService } from '../managedSkillService';
import { ManagedSkillShellEnvironmentRegistry } from '../managedSkillShellEnvironment';
import { ManagedSkillStore } from '../managedSkillStore';
import { createSkillLifecycle, type ReviewSkillOperation, type SkillOperationCaller } from './skillLifecycle';

export interface ManagedSkillsHostOptions {
  readonly userDataDir: string;
  readonly localRoot: string;
  readonly scratchRoot: string;
  readonly appVersion: string;
  readonly reviewSkillOperation: ReviewSkillOperation;
  readonly onLibraryChanged: () => void;
  readonly loadRuntimeSettings: () => Promise<{
    readonly additionalSkillDirectories: readonly string[];
    readonly additionalSkillSourceModes?: Readonly<Record<string, 'skill' | 'container'>>;
    readonly disabledSkills?: readonly string[];
    readonly disabledTools?: readonly string[];
    readonly delegation?: { readonly enabled: boolean };
  }>;
}

interface ManagedSkillsHost {
  manageForWindow(input: unknown, caller: Pick<SkillOperationCaller, 'origin' | 'authorize' | 'signal'>): Promise<unknown>;
  processEnvironment: ManagedSkillShellEnvironmentRegistry['processEnvironment'];
  updateRuntimeSettings(settings: {
    readonly additionalSkillDirectories: readonly string[];
    readonly disabledSkills?: readonly string[];
    readonly delegation?: { readonly enabled: boolean };
  }): void;
  resolveAdmission(
    input: SkillAdmissionResolutionInput,
    options: Omit<
      SkillLoadOptions,
      'provenanceStore' | 'managedSkillRoots' | 'managedSkillContentRoot' | 'assertManagedSkillInvocable'
    >,
  ): Promise<SkillAdmissionResolution>;
  prepareTurnRuntime(
    context: TurnExecutionContext,
    options: Omit<
      SkillLoadOptions,
      'provenanceStore' | 'managedSkillRoots' | 'managedSkillContentRoot' | 'assertManagedSkillInvocable'
    >,
  ): Promise<AgentSkillRuntime>;
  runtimeForTurn(turnId: string): AgentSkillRuntime;
  clearTurn(turnId: string): void;
  listPrimarySkills(userInvocableOnly: boolean): ReturnType<AgentSkillRuntime['listAllSkills']>;
  listPrimaryCurationCandidates(): ReturnType<AgentSkillRuntime['listCurationCandidates']>;
  readonly catalog: {
    load: ManagedSkillService['loadCatalog'];
    discover: ManagedSkillService['discover'];
    list: ManagedSkillService['list'];
    checkUpdates: ManagedSkillService['checkUpdates'];
    previewUpdate: ManagedSkillService['previewUpdate'];
  };
}

export function createManagedSkillsHost(options: ManagedSkillsHostOptions): ManagedSkillsHost {
  const browserPilot = new BrowserPilotHost({
    userDataRoot: options.userDataDir,
    scratchRoot: options.scratchRoot,
  });
  const store = new ManagedSkillStore(options.userDataDir);
  const runtimeReference = assignOnce<AgentSkillRuntime>('primary AgentSkillRuntime');
  const shellReference = assignOnce<ManagedSkillShellEnvironmentRegistry>('ManagedSkillShellEnvironmentRegistry');
  const turnRuntimes = new Map<string, AgentSkillRuntime>();
  const skillInvocationTurns = new Set<string>();
  const turnRuntimeInitializations = new Map<string, Promise<AgentSkillRuntime>>();
  const service = new ManagedSkillService({
    appVersion: options.appVersion,
    store,
    onChanged: async (): Promise<void> => {
      shellReference.get().invalidate();
      await Promise.all(
        [runtimeReference.get(), ...turnRuntimes.values()].map((runtime) => runtime.notifySkillContentWritten([])),
      );
    },
    findNameConflict: async (name, excludingManagedSkillId) => {
      const normalized = name.trim();
      if (!normalized) return null;
      const skills = await runtimeReference.get().listAllSkills();
      const conflict = skills.find((skill) => (
        skill.name === normalized
        && !(skill.source === 'managed' && skill.name === excludingManagedSkillId)
      ));
      return conflict ? { source: conflict.source, location: conflict.skillFile } : null;
    },
  });
  const shellEnvironment = new ManagedSkillShellEnvironmentRegistry({
    activeSkillIds: async (_threadId, turnId) => {
      const settings = await options.loadRuntimeSettings();
      const runtime = turnRuntimes.get(turnId);
      if (!runtime || !skillInvocationTurns.has(turnId) || settings.disabledTools?.includes('skill')) return new Set();
      const eligible = await Promise.all((await service.activeRuntimeRoots()).map(async (root) => {
        const definition = await runtime.getSkill(root.name);
        return definition?.source === 'managed' && (await runtime.lifecycleAvailability(definition)).available
          && !settings.disabledSkills?.includes(root.name) ? root.id : null;
      }));
      return new Set(eligible.filter((id): id is string => id !== null));
    },
    outputRootBoundary: options.scratchRoot,
    contributors: [{
      skillId: BROWSER_PILOT_MANAGED_SKILL_ID,
      processEnvironment: ({ threadId, turnId, executionId }) => (
        browserPilot.processEnvironment(threadId, turnId, executionId)
      ),
    }],
  });
  shellReference.set(shellEnvironment);
  const primaryRuntime = new AgentSkillRuntime({
    localRoot: options.localRoot,
    provenanceStore: createAgentSkillProvenanceStore(options.userDataDir),
    managedSkillRoots: () => service.activeRuntimeRoots(),
    managedSkillContentRoot: service.contentRoot,
    assertManagedSkillInvocable: (skillId, expectedContentHash) => (
      service.assertInvocable(skillId, expectedContentHash)
    ),
  });
  runtimeReference.set(primaryRuntime);

  void pruneAgentScratch(options.scratchRoot).catch((error) => {
    console.error('[agent] failed to prune scratch root at startup', error);
  });
  void service.bootstrapDefaults(DEFAULT_MANAGED_SKILLS, {
    findNameConflict: async (name) => findUnmanagedSkillNameConflict(name, options),
  }).then((results) => {
    for (const result of results) {
      if (result.status === 'failed') {
        console.warn(`[managed-skills] default acquisition failed for ${result.id}: ${result.error?.code ?? 'unexpected_error'}`);
      }
    }
  });
  void options.loadRuntimeSettings().then((settings) => {
    for (const runtime of [primaryRuntime, ...turnRuntimes.values()]) {
      applyRuntimeSettings(runtime, settings);
    }
  }).catch((error) => console.error('[agent] failed to load skill settings', error));

  const lifecycle = createSkillLifecycle({ service, review: options.reviewSkillOperation,
      refreshProvenance: async () => {
        await Promise.all([primaryRuntime, ...turnRuntimes.values()].map((runtime) => runtime.refreshProvenanceRecords()));
      }, changed: options.onLibraryChanged });
  return {
    manageForWindow: (input, caller) => lifecycle.manage(input, {
      ...caller, runtime: primaryRuntime,
    }),
    processEnvironment: (threadId, turnId, context) => (
      shellEnvironment.processEnvironment(threadId, turnId, context)
    ),
    updateRuntimeSettings: (settings) => {
      shellEnvironment.invalidate();
      for (const runtime of [primaryRuntime, ...turnRuntimes.values()]) {
        applyRuntimeSettings(runtime, settings);
      }
    },
    resolveAdmission: async (input, runtimeOptions) => {
      const settings = await options.loadRuntimeSettings();
      const hasSkillTool = input.configuration.tools.includes('skill') && !settings.disabledTools?.includes('skill');
      if (!hasSkillTool) {
        return { catalogSnapshot: null, preloadedInvocations: [], invocation: null };
      }
      const runtime = createRuntime(runtimeOptions);
      applyRuntimeSettings(runtime, settings);
      await runtime.notifyFileTouched([...input.observedFilePaths]);
      const preloaded = await resolvePreloadedSkillInvocations(
        runtime,
        input.preloadedSkills,
        input.acceptedAt,
        true,
      );
      for (const diagnostic of preloaded.diagnostics) {
        console.warn(`[agent][skill-preload] ${diagnostic}`);
      }
      const directInput = directSkillAdmissionInput(input.content);
      const invocation = directInput
        ? await resolveUserSkillInvocation(runtime, directInput, { invokedAt: input.acceptedAt })
        : null;
      return {
        catalogSnapshot: await runtime.buildSkillCatalogSnapshot(),
        preloadedInvocations: preloaded.invocations,
        invocation: invocation?.ok ? invocation.evidence : null,
      };
    },
    prepareTurnRuntime: async (context, runtimeOptions) => {
      const turnId = context.turn.id;
      if (context.configuration.tools.includes('skill')) skillInvocationTurns.add(turnId);
      const existingInitialization = turnRuntimeInitializations.get(turnId);
      if (existingInitialization) return existingInitialization;
      const runtime = turnRuntimes.get(turnId) ?? createRuntime(runtimeOptions);
      turnRuntimes.set(turnId, runtime);
      const initialization = (async () => {
        applyRuntimeSettings(runtime, await options.loadRuntimeSettings());
        await runtime.notifyFileTouched(observedSkillFilePaths([
          ...context.historyBeforeTurn,
          { ...context.turn, items: context.recorder.orderedItems() },
        ]));
        return runtime;
      })();
      turnRuntimeInitializations.set(turnId, initialization);
      try {
        return await initialization;
      } catch (error) {
        if (turnRuntimeInitializations.get(turnId) === initialization) {
          turnRuntimeInitializations.delete(turnId);
          turnRuntimes.delete(turnId);
          skillInvocationTurns.delete(turnId);
          shellEnvironment.clearTurn(turnId);
        }
        throw error;
      }
    },
    runtimeForTurn: (turnId) => {
      const runtime = turnRuntimes.get(turnId);
      if (!runtime) throw new Error(`Turn Skill Runtime is unavailable before initialization: ${turnId}`);
      return runtime;
    },
    clearTurn: (turnId) => {
      turnRuntimes.delete(turnId);
      skillInvocationTurns.delete(turnId);
      turnRuntimeInitializations.delete(turnId);
      shellEnvironment.clearTurn(turnId);
    },
    listPrimarySkills: async (userInvocableOnly) => {
      const skills = await (userInvocableOnly ? primaryRuntime.listUserInvocableSkills() : primaryRuntime.listAllSkills());
      return Promise.all(skills.map(async (skill) => ({ ...skill,
        undoTarget: skill.canUndoLastAgentEdit
          ? await primaryRuntime.inspectUndoTarget(skillLifecycleIdentity(skill)).catch(() => undefined) : undefined,
      })));
    },
    listPrimaryCurationCandidates: () => primaryRuntime.listCurationCandidates(),
    catalog: {
      load: () => service.loadCatalog(),
      discover: (input) => service.discover(input),
      list: () => service.list(),
      checkUpdates: (skillId, checkOptions) => service.checkUpdates(skillId, checkOptions),
      previewUpdate: (input) => service.previewUpdate(input),
    },
  };

  function createRuntime(
    runtimeOptions: Omit<
      SkillLoadOptions,
      'provenanceStore' | 'managedSkillRoots' | 'managedSkillContentRoot' | 'assertManagedSkillInvocable'
    >,
  ): AgentSkillRuntime {
    return new AgentSkillRuntime({
      ...runtimeOptions,
      provenanceStore: createAgentSkillProvenanceStore(options.userDataDir),
      managedSkillRoots: () => service.activeRuntimeRoots(),
      managedSkillContentRoot: service.contentRoot,
      assertManagedSkillInvocable: (skillId, expectedContentHash) => (
        service.assertInvocable(skillId, expectedContentHash)
      ),
    });
  }
}

function applyRuntimeSettings(
  runtime: AgentSkillRuntime,
  settings: {
    readonly additionalSkillDirectories: readonly string[];
    readonly additionalSkillSourceModes?: Readonly<Record<string, 'skill' | 'container'>>;
    readonly disabledSkills?: readonly string[];
    readonly delegation?: { readonly enabled: boolean };
  },
): void {
  runtime.updateAdditionalSkillDirectories([...settings.additionalSkillDirectories]);
  runtime.updateAdditionalSkillSourceModes({ ...(settings.additionalSkillSourceModes ?? {}) });
  runtime.updateDisabledSkills([
    ...(settings.disabledSkills ?? []),
    ...(settings.delegation?.enabled === true ? [] : ['delegate']),
  ]);
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

async function findUnmanagedSkillNameConflict(name: string, options: ManagedSkillsHostOptions) {
  const normalized = name.trim();
  if (!normalized) return null;
  const settings = await options.loadRuntimeSettings();
  const runtime = new AgentSkillRuntime({
    localRoot: options.localRoot,
    additionalSkillDirectories: [...settings.additionalSkillDirectories],
    additionalSkillSourceModes: { ...(settings.additionalSkillSourceModes ?? {}) },
  });
  const conflict = (await runtime.listAllSkills()).find((skill) => skill.name === normalized);
  return conflict ? { source: conflict.source, location: conflict.skillFile } : null;
}

function assignOnce<T>(name: string): { readonly get: () => T; readonly set: (value: T) => void } {
  let assigned = false;
  let value: T;
  return {
    get: () => {
      if (!assigned) throw new Error(`${name} is unavailable before managed Skill composition completes.`);
      return value;
    },
    set: (next) => {
      if (assigned) throw new Error(`${name} is already assigned.`);
      value = next;
      assigned = true;
    },
  };
}
