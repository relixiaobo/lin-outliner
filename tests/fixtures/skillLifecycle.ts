import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSkillRuntime } from '../../src/main/agent/capabilities/agentSkills';
import { createAgentSkillProvenanceStore } from '../../src/main/agent/capabilities/agentSkillProvenanceStore';
import { ManagedSkillService } from '../../src/main/managedSkillService';
import { ManagedSkillStore } from '../../src/main/managedSkillStore';
import type { ManagedSkillGitHubClient, ManagedSkillGitHubDiscovery } from '../../src/main/managedSkillGitHub';
import { validateManagedSkillFiles } from '../../src/main/managedSkillValidation';
import { createSkillLifecycle, type ReviewSkillOperation, type SkillOperationCaller } from '../../src/main/hostDomain/skillLifecycle';

export async function skillLifecycleFixture(review: ReviewSkillOperation = async () => true) {
  const root = await mkdtemp(join(tmpdir(), 'tenon-skill-lifecycle-'));
  const workspace = join(root, 'workspace');
  const config = join(root, 'config', 'settings.jsonc');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(config, '{"agent":{"skills":{"disabled":["demo"]}}}\n');
  const store = new ManagedSkillStore(root);
  const github = new LifecycleGitHub();
  const provenance = createAgentSkillProvenanceStore(root);
  let runtime: AgentSkillRuntime;
  const service = new ManagedSkillService({ store, github: github as unknown as ManagedSkillGitHubClient,
    appVersion: '0.1.0', onChanged: () => runtime.notifySkillContentWritten([]) });
  runtime = new AgentSkillRuntime({ localRoot: workspace, includeUserSkills: false,
    builtInSkillDirectories: [], builtInSkills: [],
    provenanceStore: provenance, managedSkillContentRoot: store.contentRoot,
    managedSkillRoots: () => service.activeRuntimeRoots(),
    assertManagedSkillInvocable: (id, hash) => service.assertInvocable(id, hash),
  });
  runtime.updateDisabledSkills(['demo']);
  const lifecycle = createSkillLifecycle({ service, review,
    refreshProvenance: () => runtime.refreshProvenanceRecords(), changed: () => {} });
  const caller: SkillOperationCaller = {
    runtime,
    origin: { kind: 'window', windowId: 1 },
    authorize: async (_name, _args, signal) => { signal?.throwIfAborted(); },
  };
  const manage = (request: unknown, override: Partial<SkillOperationCaller> = {}) => lifecycle.manage({ request }, { ...caller, ...override }) as Promise<any>;
  return { root, workspace, config, store, service, github, runtime, lifecycle, caller, manage, provenance,
    originalConfig: await readFile(config, 'utf8'),
    close: async () => {
      for (const entry of (await store.readIndex()).skills) await store.removeSkill(entry.id);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export class LifecycleGitHub {
  version = 1;
  downloadGate: Promise<void> | null = null;
  skill(version = this.version) {
    return validateManagedSkillFiles({ appVersion: '0.1.0', selectedDirectoryName: 'demo', files: [{
      relativePath: 'SKILL.md', bytes: Buffer.from(`---\nname: demo\ndescription: Fixture skill\n---\nVersion ${version} instructions.\n`),
    }] });
  }
  async discover(): Promise<ManagedSkillGitHubDiscovery> {
    const skill = this.skill();
    return { origin: { owner: 'public', repo: 'skills', repository: 'https://github.com/public/skills',
      subdirectory: 'demo', trackingRef: 'main', commit: String(this.version).repeat(40) },
      candidates: [{ view: { id: 'demo-candidate', name: 'demo', description: skill.description,
        subdirectory: 'demo', scripts: [], compatibility: skill.compatibility,
        skillBody: Buffer.from(skill.files[0]!.bytes).toString('utf8') }, repositoryTree: [] }],
    };
  }
  async downloadCandidate(input: { origin: { commit: string } }) {
    await this.downloadGate;
    return this.skill(Number(input.origin.commit[0]));
  }
  async resolveTrackingCommit() { return String(this.version).repeat(40); }
  async fetchJsonFromRaw() {
    return { schemaVersion: 1, entries: [{ id: 'demo', name: 'demo', description: 'Fixture skill',
      repository: 'https://github.com/public/skills', subdirectory: 'demo', trackingRef: 'main' }] };
  }
}
