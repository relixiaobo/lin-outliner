import { pruneAgentScratch } from '../agent/capabilities/agentAttachmentMaterialization';
import { createAgentSkillProvenanceStore } from '../agent/capabilities/agentSkillProvenanceStore';
import { AgentSkillRuntime, type SkillLoadOptions } from '../agent/capabilities/agentSkills';
import { executeAgentSkillShellCommand } from '../agent/capabilities/agentSkillShell';
import { BROWSER_PILOT_MANAGED_SKILL_ID, BrowserPilotHost } from '../browserPilotHost';
import { DEFAULT_MANAGED_SKILLS } from '../managedSkillDefaults';
import { ManagedSkillService } from '../managedSkillService';
import { ManagedSkillShellEnvironmentRegistry } from '../managedSkillShellEnvironment';
import { ManagedSkillStore } from '../managedSkillStore';

export interface ManagedSkillsHostOptions {
  readonly userDataDir: string;
  readonly localRoot: string;
  readonly scratchRoot: string;
  readonly appVersion: string;
  readonly loadRuntimeSettings: () => Promise<{
    readonly additionalSkillDirectories: readonly string[];
    readonly disabledSkills?: readonly string[];
  }>;
}

export interface ManagedSkillsHost {
  readonly browserPilot: BrowserPilotHost;
  readonly service: ManagedSkillService;
  readonly shellEnvironment: ManagedSkillShellEnvironmentRegistry;
  readonly primaryRuntime: AgentSkillRuntime;
  readonly turnRuntimes: Map<string, AgentSkillRuntime>;
  readonly turnRuntimeInitializations: Map<string, Promise<AgentSkillRuntime>>;
  createRuntime(options: Omit<
    SkillLoadOptions,
    'provenanceStore' | 'managedSkillRoots' | 'managedSkillContentRoot' | 'assertManagedSkillInvocable'
  >): AgentSkillRuntime;
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
    activeSkillIds: async () => new Set(
      (await service.activeRuntimeRoots()).map((root) => root.id),
    ),
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
    provenanceStore: createAgentSkillProvenanceStore(),
    managedSkillRoots: () => service.activeRuntimeRoots(),
    managedSkillContentRoot: service.contentRoot,
    assertManagedSkillInvocable: (skillId, expectedContentHash) => (
      service.assertInvocable(skillId, expectedContentHash)
    ),
    executeSkillShell: ({ skill, command, signal }) => executeAgentSkillShellCommand({
      skill,
      command,
      localRoot: options.localRoot,
      scratchRoot: options.scratchRoot,
      signal,
    }),
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
      runtime.updateAdditionalSkillDirectories([...settings.additionalSkillDirectories]);
      runtime.updateDisabledSkills([...(settings.disabledSkills ?? [])]);
    }
  }).catch((error) => console.error('[agent] failed to load skill settings', error));

  return {
    browserPilot,
    service,
    shellEnvironment,
    primaryRuntime,
    turnRuntimes,
    turnRuntimeInitializations,
    createRuntime: (runtimeOptions) => new AgentSkillRuntime({
      ...runtimeOptions,
      provenanceStore: createAgentSkillProvenanceStore(),
      managedSkillRoots: () => service.activeRuntimeRoots(),
      managedSkillContentRoot: service.contentRoot,
      assertManagedSkillInvocable: (skillId, expectedContentHash) => (
        service.assertInvocable(skillId, expectedContentHash)
      ),
    }),
  };
}

async function findUnmanagedSkillNameConflict(name: string, options: ManagedSkillsHostOptions) {
  const normalized = name.trim();
  if (!normalized) return null;
  const settings = await options.loadRuntimeSettings();
  const runtime = new AgentSkillRuntime({
    localRoot: options.localRoot,
    additionalSkillDirectories: [...settings.additionalSkillDirectories],
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
