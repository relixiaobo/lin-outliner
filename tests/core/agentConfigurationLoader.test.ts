import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentConfigurationLoader,
  projectConfigurationPath,
  userConfigurationPath,
} from '../../src/main/agent/AgentConfigurationLoader';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentConfigurationLoader', () => {
  test('resolves the default root Profile and main identity', async () => {
    const { loader, cwd } = await fixture();
    const profile = loader.resolveProfile(undefined, cwd);
    expect(profile.profileName).toBe('default');
    expect(profile.model).toBe('inherit');
    expect(profile.tools).toContain('bash');
    expect(loader.resolveIdentityCatalog(cwd)).toEqual([{
      agentType: 'main',
      persona: 'Aspen',
      color: 'teal',
      source: 'built-in',
    }]);
  });

  test('layers project Profile and main presentation entries over user entries', async () => {
    const { loader, userData, cwd } = await fixture();
    await writeJson(userConfigurationPath(userData), {
      profiles: { default: { developerInstructions: 'User instructions.' } },
      presentationOverrides: { main: { persona: 'User Aspen', color: 'pink' } },
    });
    await writeJson(projectConfigurationPath(cwd), {
      profiles: { default: { developerInstructions: 'Project instructions.' } },
      presentationOverrides: { main: { persona: 'Project Aspen', color: 'blue' } },
    });
    expect(loader.resolveProfile(undefined, cwd).developerInstructions).toEqual(['Project instructions.']);
    expect(loader.resolveIdentityCatalog(cwd)[0]).toMatchObject({ persona: 'Project Aspen', color: 'blue' });
    expect(loader.resolveEditableProfile(cwd).layer).toBe('project');
    expect(loader.listPresentationOverrides(cwd)).toHaveLength(2);
  });

  test('rejects retired Role and per-Agent execution configuration', async () => {
    const { loader, userData, cwd } = await fixture();
    for (const invalid of [
      { roles: { reviewer: { description: 'Review.', developerInstructions: 'Review.' } } },
      { agentExecution: { explore: { model: 'provider/model', modelProvider: 'provider' } } },
      { presentationOverrides: { explore: { persona: 'Scout' } } },
    ]) {
      await writeJson(userConfigurationPath(userData), invalid);
      expect(() => loader.resolveProfile(undefined, cwd)).toThrow(/Invalid Agent configuration/);
    }
  });

  test('degrades an unreadable user-path identity read and reports one failure episode', async () => {
    const { loader, userData, cwd } = await fixture();
    await writeJson(userConfigurationPath(userData), { roles: {} });
    const reports: unknown[] = [];
    const report = (value: unknown) => reports.push(value);
    expect(loader.resolveIdentityCatalogForUserPath(cwd, report)[0]?.persona).toBe('Aspen');
    expect(loader.resolveIdentityCatalogForUserPath(cwd, report)[0]?.persona).toBe('Aspen');
    expect(reports).toHaveLength(1);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-agent-configuration-'));
  roots.push(root);
  const userData = join(root, 'user-data');
  const cwd = join(root, 'workspace');
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(cwd, { recursive: true })]);
  return { loader: new AgentConfigurationLoader(userData), userData, cwd };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}
