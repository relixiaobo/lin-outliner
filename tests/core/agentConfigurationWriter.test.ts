import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentConfigurationLoader, userConfigurationPath } from '../../src/main/agent/AgentConfigurationLoader';
import { AgentConfigurationWriter } from '../../src/main/agent/AgentConfigurationWriter';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentConfigurationWriter', () => {
  test('writes the root Profile and main presentation in one validated edit', async () => {
    const { writer, loader, userData, cwd } = await fixture();
    await writer.writeProfile('user', cwd, 'default', {
      developerInstructions: 'Answer directly.',
      tools: ['bash'],
      skills: [],
    }, { persona: 'Juniper', color: 'pink' });
    expect(loader.resolveProfile(undefined, cwd)).toMatchObject({
      developerInstructions: ['Answer directly.'],
      tools: ['bash'],
      skills: [],
    });
    expect(loader.resolveIdentityCatalog(cwd)[0]).toMatchObject({ persona: 'Juniper', color: 'pink' });
    expect(JSON.parse(await readFile(userConfigurationPath(userData), 'utf8'))).toEqual({
      presentationOverrides: { main: { persona: 'Juniper', color: 'pink' } },
      profiles: {
        default: {
          developerInstructions: 'Answer directly.',
          tools: ['bash'],
          skills: [],
        },
      },
    });
  });

  test('removes cleared values so defaults and inherited capabilities return', async () => {
    const { writer, loader, cwd } = await fixture();
    await writer.writeProfile('user', cwd, 'default', {
      developerInstructions: 'Temporary.',
      tools: ['bash'],
      skills: [],
    }, { persona: 'Temporary', color: 'blue' });
    await writer.writeProfile('user', cwd, 'default', {
      developerInstructions: '',
      tools: null,
      skills: null,
    }, { persona: '', color: '' });
    expect(loader.resolveProfile(undefined, cwd).developerInstructions).toEqual([]);
    expect(loader.resolveProfile(undefined, cwd).tools.length).toBeGreaterThan(1);
    expect(loader.resolveIdentityCatalog(cwd)[0]?.persona).toBe('Aspen');
  });

  test('refuses to rewrite an existing retired configuration', async () => {
    const { writer, userData, cwd } = await fixture();
    const path = userConfigurationPath(userData);
    await mkdir(dirname(path), { recursive: true });
    const original = '{"roles":{}}\n';
    await writeFile(path, original, 'utf8');
    await expect(writer.writeProfile('user', cwd, 'default', { developerInstructions: 'No.' }))
      .rejects.toThrow(/unknown field: roles/);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  test('rejects invalid presentation before changing the file', async () => {
    const { writer, userData, cwd } = await fixture();
    await expect(writer.writeProfile('user', cwd, 'default', {}, { color: 'chartreuse' }))
      .rejects.toThrow(/Unknown identity colour/);
    await expect(readFile(userConfigurationPath(userData), 'utf8')).rejects.toThrow();
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-agent-writer-'));
  roots.push(root);
  const userData = join(root, 'user-data');
  const cwd = join(root, 'workspace');
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(cwd, { recursive: true })]);
  return {
    writer: new AgentConfigurationWriter(userData),
    loader: new AgentConfigurationLoader(userData),
    userData,
    cwd,
  };
}
