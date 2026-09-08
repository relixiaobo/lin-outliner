import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentConfigurationLoader,
  projectConfigurationSchemaPath,
  userConfigurationPath,
} from '../../src/main/agent/AgentConfigurationLoader';
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

  test('refuses to rewrite a source with duplicate JSONC keys', async () => {
    const { writer, userData, cwd } = await fixture();
    const path = userConfigurationPath(userData);
    await mkdir(dirname(path), { recursive: true });
    const original = '{ "profiles": {}, "profiles": {} }\n';
    await writeFile(path, original, 'utf8');
    await expect(writer.writeProfile('user', cwd, 'default', { model: 'inherit' }))
      .rejects.toThrow(/duplicated/);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  test('preserves JSONC comments and unrelated fields during structural edits', async () => {
    const { writer, loader, userData, cwd } = await fixture();
    const path = userConfigurationPath(userData);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `{
      // Keep this user-maintained note.
      "profiles": { "default": { "developerInstructions": "Before" } },
      "defaultProfile": "default"
    }\n`, 'utf8');

    await writer.writeProfile('user', cwd, 'default', { developerInstructions: 'After' });

    const source = await readFile(path, 'utf8');
    expect(source).toContain('// Keep this user-maintained note.');
    expect(source).toContain('"defaultProfile": "default"');
    expect(loader.resolveProfile(undefined, cwd).developerInstructions).toEqual(['After']);
  });

  test('preserves comments inside unchanged profile fields and writes a project schema', async () => {
    const { writer, userData, cwd } = await fixture();
    const path = userConfigurationPath(userData);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `{
      "profiles": { "default": {
        // Keep this profile note.
        "developerInstructions": "Before",
        "model": "inherit"
      } }
    }\n`, 'utf8');
    await writer.writeProfile('user', cwd, 'default', { developerInstructions: 'After' });
    const userSource = await readFile(path, 'utf8');
    expect(userSource).toContain('// Keep this profile note.');
    await writer.writeProfile('project', cwd, 'default', { developerInstructions: 'Project.' });
    const projectPath = join(cwd, '.tenon', 'agent.json');
    const projectSource = await readFile(projectPath, 'utf8');
    expect(projectSource).toContain('Project.');
    expect(await readFile(projectConfigurationSchemaPath(cwd), 'utf8')).toContain('Tenon Root Agent Configuration');
  });

  test('rejects stale editor observations without changing newer source bytes', async () => {
    const { writer, userData, cwd } = await fixture();
    await writer.writeProfile('user', cwd, 'default', { developerInstructions: 'Before' });
    const path = userConfigurationPath(userData);
    const observed = await readFile(path, 'utf8');
    const digest = createHash('sha256').update(observed).digest('hex');
    const external = observed.replace('Before', 'External');
    await writeFile(path, external);
    await expect(writer.writeProfile('user', cwd, 'default', { developerInstructions: 'Stale' }, undefined, digest)).rejects.toThrow('source changed');
    expect(await readFile(path, 'utf8')).toBe(external);
  });

  test('an empty rejected source cannot be overwritten through the structural editor', async () => {
    const { writer, userData, cwd } = await fixture();
    const path = userConfigurationPath(userData);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '  ');
    await expect(writer.writeProfile('user', cwd, 'default', {})).rejects.toThrow('Cannot edit');
    expect(await readFile(path, 'utf8')).toBe('  ');
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
