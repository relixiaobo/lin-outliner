import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentConfigurationLoader,
  projectConfigurationPath,
  userConfigurationPath,
} from '../../src/main/agent/AgentConfigurationLoader';
import { AgentConfigurationWriter } from '../../src/main/agent/AgentConfigurationWriter';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentConfigurationWriter', () => {
  test('writes a Role the loader then resolves as an Agent type', async () => {
    const { writer, loader, cwd } = await fixture();

    writer.writeRole('project', cwd, {
      name: 'reviewer',
      description: 'Reviews a diff.',
      developerInstructions: 'Read the diff and report what is wrong.',
      persona: 'Wren',
      color: 'violet',
    });

    expect(loader.listEditableRoles(cwd)).toEqual([{
      name: 'reviewer',
      layer: 'project',
      description: 'Reviews a diff.',
      developerInstructions: 'Read the diff and report what is wrong.',
      persona: 'Wren',
      color: 'violet',
      model: null,
      reasoningEffort: null,
      tools: null,
    }]);
    expect(loader.resolveIdentityCatalog(cwd)).toContainEqual({
      agentType: 'reviewer',
      persona: 'Wren',
      color: 'violet',
      source: 'project',
    });
  });

  test('refuses a Role named `main`, which would own two different identities', async () => {
    const { writer, cwd } = await fixture();

    expect(() => writer.writeRole('user', cwd, {
      name: 'main',
      description: 'Impostor.',
      developerInstructions: 'Take the conversation.',
    })).toThrow(/reserved/);
  });

  test('refuses an unknown colour without touching the file', async () => {
    const { writer, cwd, userData } = await fixture();
    writer.writeRole('user', cwd, {
      name: 'keeper',
      description: 'Kept.',
      developerInstructions: 'Stay.',
      color: 'teal',
    });
    const before = await readFile(userConfigurationPath(userData), 'utf8');

    expect(() => writer.writeRole('user', cwd, {
      name: 'intruder',
      description: 'Rejected.',
      developerInstructions: 'Never lands.',
      color: 'chartreuse',
    })).toThrow(/chartreuse/);

    // The rejected write must not be half-applied: `intruder` is refused BEFORE
    // serialization, so the previous file is still byte-identical.
    expect(await readFile(userConfigurationPath(userData), 'utf8')).toBe(before);
  });

  test('restores the previous bytes when the candidate does not survive the loader', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    writer.writeRole('user', cwd, {
      name: 'keeper',
      description: 'Kept.',
      developerInstructions: 'Stay.',
    });
    const before = await readFile(userConfigurationPath(userData), 'utf8');

    // A loader that rejects everything stands in for any future validation the
    // writer does not know about: whatever the reason, a candidate the reader
    // cannot read must leave the file as the user had it.
    const hostile = new AgentConfigurationWriter(userData, {
      resolveIdentityCatalog: () => { throw new Error('unreadable layer'); },
    } as unknown as AgentConfigurationLoader);

    expect(() => hostile.writeRole('user', cwd, {
      name: 'doomed',
      description: 'Rejected.',
      developerInstructions: 'Never lands.',
    })).toThrow(/Refused: unreadable layer/);

    expect(await readFile(userConfigurationPath(userData), 'utf8')).toBe(before);
    expect(loader.listEditableRoles(cwd).map((role) => role.name)).toEqual(['keeper']);
  });

  test('refuses to rewrite a layer it could not parse, rather than replacing it', async () => {
    const { writer, cwd } = await fixture();
    const path = projectConfigurationPath(cwd);
    await mkdir(join(cwd, '.tenon'), { recursive: true }).catch(() => undefined);
    await writeFile(path, '{ this is not JSON', 'utf8');

    expect(() => writer.writeRole('project', cwd, {
      name: 'reviewer',
      description: 'Reviews.',
      developerInstructions: 'Review.',
    })).toThrow(/Cannot edit/);

    // The user's hand-written file is still theirs.
    expect(await readFile(path, 'utf8')).toBe('{ this is not JSON');
  });

  test('deleting a Role removes the key, and the last one removes the section', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    writer.writeRole('user', cwd, { name: 'a', description: 'A.', developerInstructions: 'A.' });
    writer.writeRole('user', cwd, { name: 'b', description: 'B.', developerInstructions: 'B.' });

    writer.deleteRole('user', cwd, 'a');
    expect(loader.listEditableRoles(cwd).map((role) => role.name)).toEqual(['b']);

    writer.deleteRole('user', cwd, 'b');
    expect(loader.listEditableRoles(cwd)).toEqual([]);
    // An empty `roles: {}` left behind would read as "the user has an empty
    // collection" instead of "the user has none".
    expect(JSON.parse(await readFile(userConfigurationPath(userData), 'utf8'))).toEqual({});
  });

  test('deleting a Role that is not there says so instead of writing a no-op', async () => {
    const { writer, cwd } = await fixture();

    expect(() => writer.deleteRole('user', cwd, 'ghost')).toThrow(/No Agent Role named 'ghost'/);
  });

  test('a presentation override renames a built-in type without redefining it', async () => {
    const { writer, loader, cwd } = await fixture();

    writer.writePresentation('user', cwd, 'explore', { persona: 'Juniper', color: 'pink' });

    // `source` stays `built-in`: it says where the TYPE comes from, not where
    // its skin was written. A re-skinned built-in that reported itself as a
    // user Role would invite an editor to offer Delete on something it cannot
    // delete.
    expect(loader.resolveIdentityCatalog(cwd)).toContainEqual({
      agentType: 'explore',
      persona: 'Juniper',
      color: 'pink',
      source: 'built-in',
    });
    // Re-skinning is not redefining: `explore` is still a built-in, so it must
    // not appear among the Roles the user may edit or delete.
    expect(loader.listEditableRoles(cwd)).toEqual([]);
  });

  test('clearing a presentation removes the override so the default shows through', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    writer.writePresentation('user', cwd, 'explore', { persona: 'Juniper', color: 'pink' });

    writer.writePresentation('user', cwd, 'explore', { persona: '', color: '' });

    const entry = loader.resolveIdentityCatalog(cwd).find((row) => row.agentType === 'explore');
    expect(entry).toMatchObject({ persona: 'Rena', color: 'orange' });
    // Reset is the ABSENCE of an override, not a second copy of the default —
    // otherwise a later change to the built-in name would not reach the user.
    expect(JSON.parse(await readFile(userConfigurationPath(userData), 'utf8'))).toEqual({});
  });

  test('the project layer wins over the user layer for the same Agent type', async () => {
    const { writer, loader, cwd } = await fixture();
    writer.writePresentation('user', cwd, 'plan', { persona: 'User Ada' });

    writer.writePresentation('project', cwd, 'plan', { persona: 'Project Ada' });

    expect(loader.resolveIdentityCatalog(cwd)).toContainEqual({
      agentType: 'plan',
      persona: 'Project Ada',
      color: 'blue',
      source: 'built-in',
    });
  });
});

async function fixture(): Promise<{
  writer: AgentConfigurationWriter;
  loader: AgentConfigurationLoader;
  userData: string;
  cwd: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-agent-writer-'));
  roots.push(root);
  const userData = join(root, 'user-data');
  const cwd = join(root, 'project');
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(cwd, { recursive: true })]);
  const loader = new AgentConfigurationLoader(userData);
  return { writer: new AgentConfigurationWriter(userData, loader), loader, userData, cwd };
}
