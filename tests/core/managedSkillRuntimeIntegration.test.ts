import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentSkillRuntime, resolveSkillContentTarget } from '../../src/main/agentSkills';
import type { ManagedSkillGitHubClient } from '../../src/main/managedSkillGitHub';
import { ManagedSkillService } from '../../src/main/managedSkillService';
import { ManagedSkillStore, storedVersionFromValidated } from '../../src/main/managedSkillStore';
import { validateManagedSkillFiles } from '../../src/main/managedSkillValidation';
import {
  createFolderCapabilitySnapshot,
  protectedRootForPath,
} from '../../src/main/agentFolderCapabilities';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed skill runtime integration', () => {
  test('loads only the pinned managed root and revalidates it before invocation', async () => {
    const fixture = await managedFixture('runtime-skill');
    const assertions: Array<{ id: string; hash: string }> = [];
    const runtime = new AgentSkillRuntime({
      localRoot: fixture.workspace,
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: [],
      managedSkillContentRoot: fixture.contentRoot,
      managedSkillRoots: async () => [{
        id: 'runtime-skill',
        name: 'runtime-skill',
        rootDir: fixture.versionRoot,
        contentHash: fixture.hash,
      }],
      assertManagedSkillInvocable: async (id, hash) => { assertions.push({ id, hash }); },
    });

    expect(await runtime.getSkill('runtime-skill')).toMatchObject({
      name: 'runtime-skill',
      source: 'managed',
      rootDir: fixture.versionRoot,
      managedContentHash: fixture.hash,
    });
    expect(await runtime.getActiveSkillReadRoots()).toEqual([]);

    runtime.updateDisabledSkills(['runtime-skill']);
    expect(await runtime.buildSkillListingReminderText()).toContain('runtime-skill');
    const invocation = await runtime.invokeSkill({ skill: 'runtime-skill', trigger: 'agent' });
    expect(invocation.ok).toBe(true);
    expect(assertions).toEqual([{ id: 'runtime-skill', hash: fixture.hash }]);
    expect(await runtime.getActiveSkillReadRoots()).toEqual([fixture.versionRoot]);
    expect(runtime.resolveSkillTarget(path.join(fixture.versionRoot, 'SKILL.md'))).toBeNull();
  });

  test('fails closed when invocation integrity validation rejects the active hash', async () => {
    const fixture = await managedFixture('blocked-skill');
    const runtime = new AgentSkillRuntime({
      localRoot: fixture.workspace,
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: [],
      managedSkillRoots: async () => [{
        id: 'blocked-skill',
        name: 'blocked-skill',
        rootDir: fixture.versionRoot,
        contentHash: fixture.hash,
      }],
      assertManagedSkillInvocable: async () => { throw new Error('Managed content changed locally.'); },
    });

    const invocation = await runtime.invokeSkill({ skill: 'blocked-skill', trigger: 'slash' });
    expect(invocation).toMatchObject({
      ok: false,
      code: 'managed_skill_unavailable',
      message: 'Managed content changed locally.',
    });
    expect(await runtime.getActiveSkillReadRoots()).toEqual([]);
  });

  test('lets a project skill win if a later local skill takes the managed name', async () => {
    const fixture = await managedFixture('same-name');
    const projectRoot = path.join(fixture.workspace, '.agents', 'skills', 'same-name');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'SKILL.md'), skillMarkdown('same-name', 'Project version.'), 'utf8');
    const runtime = new AgentSkillRuntime({
      localRoot: fixture.workspace,
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: [],
      managedSkillRoots: async () => [{
        id: 'same-name',
        name: 'same-name',
        rootDir: fixture.versionRoot,
        contentHash: fixture.hash,
      }],
      assertManagedSkillInvocable: async () => undefined,
    });

    expect(await runtime.getSkill('same-name')).toMatchObject({ source: 'project', rootDir: projectRoot });
  });

  test('opens only an invoked managed hash for reads inside protected userData', async () => {
    const fixture = await managedFixture('capability-skill');
    const siblingVersion = path.join(fixture.contentRoot, 'capability-skill', 'e'.repeat(64));
    await mkdir(siblingVersion, { recursive: true });
    const snapshot = createFolderCapabilitySnapshot({
      workspaceRoot: fixture.workspace,
      activeSkillReadRoots: [fixture.versionRoot],
      protectedRoots: [fixture.userData],
    }, [fixture.userData]);
    const protectedRoot = snapshot.protectedRoots[0]!.root;

    expect(protectedRootForPath(snapshot, fixture.versionRoot, 'read')).toBeNull();
    expect(protectedRootForPath(snapshot, siblingVersion, 'read')).toBe(protectedRoot);
    expect(protectedRootForPath(snapshot, fixture.versionRoot, 'write')).toBe(protectedRoot);
  });

  test('never resolves managed content through the mutable authoring path', async () => {
    const fixture = await managedFixture('authoring-blocked');

    expect(resolveSkillContentTarget(path.join(fixture.versionRoot, 'SKILL.md'), {
      root: fixture.workspace,
      includeUserSkills: false,
      additionalSkillDirectories: [fixture.contentRoot],
      managedSkillContentRoot: fixture.contentRoot,
    })).toBeNull();
  });

  test('does not deadlock registry loading when integrity diagnostics trigger a reload', async () => {
    const fixture = await managedFixture('modified-during-load');
    const store = new ManagedSkillStore(fixture.userData);
    const validated = validateManagedSkillFiles({
      files: [{ relativePath: 'SKILL.md', bytes: new TextEncoder().encode(skillMarkdown('modified-during-load', 'Managed runtime fixture.')) }],
      selectedDirectoryName: 'modified-during-load',
      appVersion: '0.1.0',
    });
    const version = storedVersionFromValidated('a'.repeat(40), 1, validated);
    await store.installValidatedContent('modified-during-load', validated);
    await store.replaceIndex({
      schemaVersion: 1,
      skills: [{
        id: 'modified-during-load',
        name: 'modified-during-load',
        origin: {
          owner: 'public',
          repo: 'repo',
          repository: 'https://github.com/public/repo',
          subdirectory: 'modified-during-load',
          trackingRef: 'main',
        },
        recommended: false,
        enabled: true,
        active: version,
      }],
    });
    const skillFile = path.join(store.contentPath('modified-during-load', validated.contentHash), 'SKILL.md');
    if (process.platform !== 'win32') await chmod(skillFile, 0o600);
    await writeFile(skillFile, 'locally modified\n', 'utf8');

    let runtime: AgentSkillRuntime;
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store,
      github: {} as ManagedSkillGitHubClient,
      onChanged: () => runtime.notifySkillContentWritten([]),
    });
    runtime = new AgentSkillRuntime({
      localRoot: fixture.workspace,
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: [],
      managedSkillRoots: () => service.activeRuntimeRoots(),
      managedSkillContentRoot: store.contentRoot,
      assertManagedSkillInvocable: (id, hash) => service.assertInvocable(id, hash),
    });

    const skills = await Promise.race([
      runtime.listAllSkills(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('registry load timed out')), 1_000)),
    ]);
    expect(skills).toEqual([]);
    expect((await service.list())[0]?.status).toBe('modified');
    await service.uninstall({
      skillId: 'modified-during-load',
      expectedActiveHash: validated.contentHash,
    });
  });
});

async function managedFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-managed-runtime-'));
  roots.push(root);
  const userData = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  const contentRoot = path.join(userData, 'managed-skill-content');
  const hash = 'd'.repeat(64);
  const versionRoot = path.join(contentRoot, name, hash);
  await mkdir(versionRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(versionRoot, 'SKILL.md'), skillMarkdown(name, 'Managed runtime fixture.'), 'utf8');
  return { root, userData, workspace, contentRoot, hash, versionRoot };
}

function skillMarkdown(name: string, description: string): string {
  return ['---', `name: ${name}`, `description: ${description}`, '---', `# ${name}`].join('\n');
}
