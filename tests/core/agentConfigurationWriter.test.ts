import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentConfigurationLoader,
  projectConfigurationPath,
  userConfigurationPath,
} from '../../src/main/agent/AgentConfigurationLoader';
import { AgentConfigurationWriter } from '../../src/main/agent/AgentConfigurationWriter';
import { resolveChildConfiguration } from '../../src/core/agent/configuration';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentConfigurationWriter', () => {
  test('writes a Role the loader then resolves as an Agent type', async () => {
    const { writer, loader, cwd } = await fixture();

    await writer.writeRole('project', cwd, {
      name: 'reviewer',
      description: 'Reviews a diff.',
      developerInstructions: 'Read the diff and report what is wrong.',
      persona: 'Wren',
      color: 'violet',
    }, 'create');

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
      skills: null,
    }]);
    expect(loader.resolveIdentityCatalog(cwd)).toContainEqual({
      agentType: 'reviewer',
      persona: 'Wren',
      color: 'violet',
      source: 'project',
    });
  });

  test('a capability narrowing round-trips, and clearing it restores inherit', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    await writer.writeRole('user', cwd, {
      name: 'auditor',
      description: 'Audits.',
      developerInstructions: 'Read the diff.',
      tools: ['file_read'],
      skills: ['review'],
    }, 'create');

    expect(loader.listEditableRoles(cwd)[0]).toMatchObject({
      tools: ['file_read'],
      skills: ['review'],
    });

    // `null` is the editor saying "everything is checked" — which must clear the
    // narrowing rather than write today's catalogue out, or a tool added to
    // Tenon later would be excluded by a list nobody meant as final.
    await writer.writeRole('user', cwd, {
      name: 'auditor',
      description: 'Audits.',
      developerInstructions: 'Read the diff.',
      tools: null,
      skills: null,
    }, 'update');

    expect(loader.listEditableRoles(cwd)[0]).toMatchObject({ tools: null, skills: null });
    expect(JSON.parse(await readFile(userConfigurationPath(userData), 'utf8')).roles.auditor.overrides)
      .toBeUndefined();
  });

  test('an empty capability list is a ban, not a shorthand for inherit', async () => {
    const { writer, loader, cwd } = await fixture();

    await writer.writeRole('user', cwd, {
      name: 'reviewer',
      description: 'Reads only.',
      developerInstructions: 'Read, never act.',
      tools: [],
    }, 'create');

    // A user who unchecks every tool means none. Collapsing that to "no
    // narrowing" would hand the Role its parent's ENTIRE tool set on the next
    // spawn — the exact opposite of what they asked for.
    expect(loader.listEditableRoles(cwd)[0]).toMatchObject({ tools: [] });
    const child = resolveChildConfiguration(
      loader.resolveProfile(undefined, cwd),
      { role: loader.resolveRole('reviewer', cwd) },
    );
    expect(child.tools).toEqual([]);
  });

  test('a new Role with nothing unchecked inherits the parent, it is not stripped', async () => {
    const { writer, loader, cwd } = await fixture();

    // Exactly what the editor builds for a brand-new Role whose every box is
    // checked. `null`, not `[]` — folding the two together handed a new Role
    // zero tools and zero Skills on its first spawn, which is the default
    // create path and so the likeliest thing anyone does here.
    await writer.writeRole('project', cwd, {
      name: 'reviewer',
      description: 'Reviews a diff.',
      developerInstructions: 'Read the diff.',
      tools: null,
      skills: null,
    }, 'create');

    const child = resolveChildConfiguration(
      loader.resolveProfile(undefined, cwd),
      { role: loader.resolveRole('reviewer', cwd) },
    );
    expect(child.tools.length).toBeGreaterThan(0);
    expect(child.tools).toEqual(loader.resolveProfile(undefined, cwd).tools);
    expect(child.skills).toEqual(loader.resolveProfile(undefined, cwd).skills);
  });

  test('a Profile save keeps the model the editor has no field for', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    await writeJson(userConfigurationPath(userData), {
      profiles: { default: { model: 'gpt-5', reasoningEffort: 'high', developerInstructions: 'Old.' } },
    });

    // What the editor sends: instructions and the two capability lists. It has
    // no box for model or reasoning, so a Save must not remove them.
    await writer.writeProfile('user', cwd, 'default', {
      developerInstructions: 'New.',
      tools: null,
      skills: null,
    });

    expect(loader.resolveEditableProfile(cwd)).toMatchObject({
      developerInstructions: 'New.',
      model: 'gpt-5',
      reasoningEffort: 'high',
    });
  });

  test('the conversation agent\'s identity and Profile land in one edit', async () => {
    const { writer, loader, cwd } = await fixture();

    await writer.writeProfile('user', cwd, 'default', { developerInstructions: 'Answer in Chinese.' }, {
      agentType: 'main',
      draft: { persona: 'Juniper' },
    });

    // One Save, one validated edit: a refused half must not leave the other half
    // on disk.
    expect(loader.resolveEditableProfile(cwd)).toMatchObject({ developerInstructions: 'Answer in Chinese.' });
    expect(loader.listPresentationOverrides(cwd))
      .toEqual([{ agentType: 'main', layer: 'user', persona: 'Juniper', color: null }]);
  });

  test('a refused Profile write leaves the paired identity change unwritten too', async () => {
    const { writer, loader, cwd } = await fixture();

    await expect(writer.writeProfile('user', cwd, 'default', { developerInstructions: 'Kept?' }, {
      agentType: 'main',
      draft: { persona: 'Juniper', color: 'chartreuse' },
    })).rejects.toThrow(/chartreuse/);

    expect(loader.resolveEditableProfile(cwd)).toMatchObject({ layer: null });
    expect(loader.listPresentationOverrides(cwd)).toEqual([]);
  });

  test('the conversation agent\'s Profile carries instructions and the ceiling', async () => {
    const { writer, loader, cwd } = await fixture();

    await writer.writeProfile('user', cwd, 'default', {
      developerInstructions: 'Always answer in Chinese.',
      tools: ['file_read'],
    });

    const profile = loader.resolveEditableProfile(cwd);
    expect(profile).toMatchObject({
      name: 'default',
      layer: 'user',
      developerInstructions: 'Always answer in Chinese.',
      tools: ['file_read'],
      // Untouched fields stay absent so the built-in default keeps showing
      // through — the same rule presentation follows.
      model: null,
      skills: null,
    });
    // And it is the configuration the root Thread actually runs on.
    expect(loader.resolveProfile(undefined, cwd)).toMatchObject({
      developerInstructions: ['Always answer in Chinese.'],
      tools: ['file_read'],
    });
  });

  test('a Profile emptied of every field removes itself rather than sitting there blank', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    await writer.writeProfile('user', cwd, 'default', { developerInstructions: 'Temporary.' });

    // What clearing looks like from the editor: instructions emptied, every box
    // checked. An empty DRAFT means "mentioned nothing", which changes nothing.
    await writer.writeProfile('user', cwd, 'default', {
      developerInstructions: '',
      tools: null,
      skills: null,
    });

    expect(loader.resolveEditableProfile(cwd)).toMatchObject({ layer: null, developerInstructions: null });
    expect(JSON.parse(await readFile(userConfigurationPath(userData), 'utf8'))).toEqual({});
  });

  test('a draft that mentions nothing changes nothing', async () => {
    const { writer, loader, cwd } = await fixture();
    await writer.writeProfile('user', cwd, 'default', {
      developerInstructions: 'Kept.',
      tools: ['file_read'],
    });

    await writer.writeProfile('user', cwd, 'default', {});

    expect(loader.resolveEditableProfile(cwd)).toMatchObject({
      developerInstructions: 'Kept.',
      tools: ['file_read'],
    });
  });

  test('a save keeps the overrides the editor never shows', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    // Hand-written: a model, a narrowed tool set, and a narrowed Skill set —
    // none of which the editor renders a field for.
    await writeJson(userConfigurationPath(userData), {
      roles: {
        auditor: {
          description: 'Audits.',
          developerInstructions: 'Read the diff.',
          overrides: { model: 'gpt-5', tools: ['file_read'], skills: ['review'] },
        },
      },
    });

    // The editor's save: identity and definition only.
    await writer.writeRole('user', cwd, {
      name: 'auditor',
      description: 'Audits.',
      developerInstructions: 'Read the diff.',
      color: 'pink',
    }, 'update');

    const written = JSON.parse(await readFile(userConfigurationPath(userData), 'utf8'));
    // Editing a colour must not silently reset the model and hand the Role the
    // full tool catalogue on its next spawn.
    expect(written.roles.auditor.overrides).toEqual({
      model: 'gpt-5',
      tools: ['file_read'],
      skills: ['review'],
    });
    expect(loader.listEditableRoles(cwd)[0]).toMatchObject({ model: 'gpt-5', color: 'pink' });
  });

  test('creating over an existing name is refused instead of replacing it', async () => {
    const { writer, cwd, userData } = await fixture();
    await writer.writeRole('user', cwd, {
      name: 'auditor',
      description: 'The original.',
      developerInstructions: 'A long definition the user wrote.',
    }, 'create');
    const before = await readFile(userConfigurationPath(userData), 'utf8');

    await expect(writer.writeRole('user', cwd, {
      name: 'auditor',
      description: 'One line.',
      developerInstructions: 'Oops.',
    }, 'create')).rejects.toThrow(/already exists/);

    expect(await readFile(userConfigurationPath(userData), 'utf8')).toBe(before);
  });

  test('refuses a Role named `main` or after a built-in agent type', async () => {
    const { writer, cwd } = await fixture();
    const draft = { description: 'Impostor.', developerInstructions: 'Take the work.' };

    // Including the BACKING names: every spawn that names no role asks for
    // `default`, and `resolveRole` prefers a configured entry over the built-in.
    for (const name of ['main', 'general-purpose', 'explore', 'plan', 'default', 'explorer']) {
      // `main` names the conversation's own agent; a built-in canonical type is
      // dropped by `agentTypeCandidates` yet preferred by `resolveRole`, so a
      // Role by that name would never dispatch while shadowing the built-in's
      // row in the editor.
      await expect(writer.writeRole('user', cwd, { name, ...draft }, 'create'))
        .rejects.toThrow(/built-in agent name|reserved/);
    }
  });

  test('refuses an unknown colour without creating the file', async () => {
    const { writer, cwd, userData } = await fixture();

    await expect(writer.writeRole('user', cwd, {
      name: 'intruder',
      description: 'Rejected.',
      developerInstructions: 'Never lands.',
      color: 'chartreuse',
    }, 'create')).rejects.toThrow(/chartreuse/);

    // Nothing is written before the candidate is known to be readable, so a
    // refused edit leaves neither a file nor the directory it would have sat in.
    expect(existsSync(userConfigurationPath(userData))).toBe(false);
    expect(existsSync(dirname(userConfigurationPath(userData)))).toBe(false);
  });

  test('a candidate the loader would reject never reaches disk', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    await writer.writeRole('user', cwd, {
      name: 'keeper',
      description: 'Kept.',
      developerInstructions: 'Stay.',
    }, 'create');
    const before = await readFile(userConfigurationPath(userData), 'utf8');

    // An empty description is valid JSON and rejected by the loader's
    // `nonEmptyString`. The old design wrote first and restored afterwards, so
    // a crash between the two left the unreadable file as the live config.
    await expect(writer.writeRole('user', cwd, {
      name: 'doomed',
      description: '   ',
      developerInstructions: 'Never lands.',
    }, 'create')).rejects.toThrow(/Refused:/);

    expect(await readFile(userConfigurationPath(userData), 'utf8')).toBe(before);
    expect(loader.listEditableRoles(cwd).map((role) => role.name)).toEqual(['keeper']);
  });

  test('refuses to rewrite a layer it could not parse, rather than replacing it', async () => {
    const { writer, cwd } = await fixture();
    const path = projectConfigurationPath(cwd);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ this is not JSON', 'utf8');

    await expect(writer.writeRole('project', cwd, {
      name: 'reviewer',
      description: 'Reviews.',
      developerInstructions: 'Review.',
    }, 'create')).rejects.toThrow(/Cannot edit/);

    expect(await readFile(path, 'utf8')).toBe('{ this is not JSON');
  });

  test('refuses a layer that parses as JSON but not as configuration', async () => {
    const { writer, cwd, userData } = await fixture();
    // Valid JSON, rejected by the loader's `objectValue`. Treating it as "no
    // roles" would drop the user's array and report success.
    await writeJson(userConfigurationPath(userData), { roles: ['auditor'] });

    await expect(writer.writeRole('user', cwd, {
      name: 'reviewer',
      description: 'Reviews.',
      developerInstructions: 'Review.',
    }, 'create')).rejects.toThrow(/Cannot edit/);

    expect(JSON.parse(await readFile(userConfigurationPath(userData), 'utf8')))
      .toEqual({ roles: ['auditor'] });
  });

  test('a broken OTHER layer does not make this one uneditable', async () => {
    const { writer, loader, cwd } = await fixture();
    // The project file is wrong. Editing a USER-layer agent must still work:
    // rolling this back would strand the user with an error naming a file the
    // editor never said it was reading.
    await writeJson(projectConfigurationPath(cwd), {
      roles: { broken: { description: '', developerInstructions: 'x' } },
    });

    await writer.writeRole('user', cwd, {
      name: 'reviewer',
      description: 'Reviews.',
      developerInstructions: 'Review.',
    }, 'create');

    expect(() => loader.listEditableRoles(cwd)).toThrow();
    // The user layer alone is readable and holds the write.
    const solo = new AgentConfigurationLoader(writerUserData(writer));
    expect(solo.listEditableRoles(join(cwd, 'empty')).map((role) => role.name)).toEqual(['reviewer']);
  });

  test('deleting a Role removes the key, and the last one removes the section', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    await writer.writeRole('user', cwd, { name: 'a', description: 'A.', developerInstructions: 'A.' }, 'create');
    await writer.writeRole('user', cwd, { name: 'b', description: 'B.', developerInstructions: 'B.' }, 'create');

    await writer.deleteRole('user', cwd, 'a');
    expect(loader.listEditableRoles(cwd).map((role) => role.name)).toEqual(['b']);

    await writer.deleteRole('user', cwd, 'b');
    expect(loader.listEditableRoles(cwd)).toEqual([]);
    // An empty `roles: {}` left behind would read as "the user has an empty
    // collection" instead of "the user has none".
    expect(JSON.parse(await readFile(userConfigurationPath(userData), 'utf8'))).toEqual({});
  });

  test('names a Thread by its type, and an isolated Skill by its own name', async () => {
    const { writer, loader, cwd } = await fixture();
    const thread = { parentThreadId: 'parent', agentRole: 'explorer', agentNickname: null, cwd };

    // A child records its BACKING Role while identity keys on the canonical
    // type, so this has to hop `explorer` → `explore` or it would be told a
    // name the reader never sees.
    expect(loader.resolveThreadPersona(thread)).toBe('Rena');
    expect(loader.resolveThreadPersona({ ...thread, parentThreadId: null })).toBe('Aspen');

    // An isolated Skill is spawned with `role: 'default'` and the Skill's name
    // as its nickname. Resolving by type would tell it it is Bruno.
    expect(loader.resolveThreadPersona({
      ...thread, agentRole: 'default', agentNickname: 'code-review',
    })).toBe('code-review');

    await writer.writePresentation('user', cwd, 'explore', { persona: 'Juniper' });
    // And it follows configuration, so a rename reaches the next Turn.
    expect(loader.resolveThreadPersona(thread)).toBe('Juniper');
  });

  test('a broken config degrades the name but still fails the paths that must', async () => {
    const { loader, cwd } = await fixture();
    await mkdir(dirname(projectConfigurationPath(cwd)), { recursive: true });
    await writeFile(projectConfigurationPath(cwd), '{ oops', 'utf8');
    const thread = { parentThreadId: 'parent', agentRole: 'explorer', agentNickname: null, cwd };

    // USER path — every Turn of every Thread. A12: a typo in the user's own file
    // must not end the answer they are waiting for, so the participant is named
    // after its type instead.
    // Falls through to the built-in default rather than the raw key, so the
    // conversation agent is still `Aspen` and not "You are main".
    expect(loader.resolveThreadPersona(thread)).toBe('Rena');
    expect(loader.resolveThreadPersona({ ...thread, parentThreadId: null })).toBe('Aspen');
    // A type the defaults do not know is named after itself.
    expect(loader.resolveThreadPersona({ ...thread, agentRole: 'auditor' })).toBe('auditor');

    // SPAWN path stays fail-closed: a Thread must not start on a configuration
    // nobody could read, because everything it does afterwards is decided by it.
    expect(() => loader.resolveProfile(undefined, cwd)).toThrow(/Invalid Agent configuration/);
    expect(() => loader.resolveAgentType('explore', cwd)).toThrow(/Invalid Agent configuration/);

    // EDITOR path stays fail-closed too: the Agents page is where a broken file
    // is actionable, so it has to say so rather than render a healthy-looking
    // list of what happens to parse.
    expect(() => loader.resolveIdentityCatalog(cwd)).toThrow(/Invalid Agent configuration/);
    expect(() => loader.listEditableRoles(cwd)).toThrow(/Invalid Agent configuration/);
  });

  test('a repaired config is picked up on the next Turn, not cached past the fix', async () => {
    const { writer, loader, cwd } = await fixture();
    await mkdir(dirname(projectConfigurationPath(cwd)), { recursive: true });
    await writeFile(projectConfigurationPath(cwd), '{ oops', 'utf8');
    const thread = { parentThreadId: 'parent', agentRole: 'explorer', agentNickname: null, cwd };
    expect(loader.resolveThreadPersona(thread)).toBe('Rena');

    await writeFile(projectConfigurationPath(cwd), '{}', 'utf8');
    expect(loader.resolveThreadPersona(thread)).toBe('Rena');

    // And a rename still reaches the very next Turn — the reason this resolves
    // live rather than being recorded at spawn.
    await writer.writePresentation('project', cwd, 'explore', { persona: 'Juniper' });
    expect(loader.resolveThreadPersona(thread)).toBe('Juniper');
  });

  test('deleting a Role that is not there says so instead of writing a no-op', async () => {
    const { writer, cwd } = await fixture();

    await expect(writer.deleteRole('user', cwd, 'ghost')).rejects.toThrow(/No Agent Role named 'ghost'/);
  });

  test('a presentation override renames a built-in type without redefining it', async () => {
    const { writer, loader, cwd } = await fixture();

    await writer.writePresentation('user', cwd, 'explore', { persona: 'Juniper', color: 'pink' });

    // `source` stays `built-in`: it says where the TYPE comes from, not where
    // its skin was written.
    expect(loader.resolveIdentityCatalog(cwd)).toContainEqual({
      agentType: 'explore',
      persona: 'Juniper',
      color: 'pink',
      source: 'built-in',
    });
    expect(loader.listEditableRoles(cwd)).toEqual([]);
    // What is WRITTEN, as opposed to what resolves — the editor seeds from this.
    expect(loader.listPresentationOverrides(cwd)).toEqual([
      { agentType: 'explore', layer: 'user', persona: 'Juniper', color: 'pink' },
    ]);
  });

  test('a colour-only re-skin does not write the default persona in beside it', async () => {
    const { writer, loader, cwd } = await fixture();

    await writer.writePresentation('user', cwd, 'explore', { color: 'pink' });

    // Only the colour is overridden, so a later change to the built-in's name
    // still reaches this user.
    expect(loader.listPresentationOverrides(cwd)).toEqual([
      { agentType: 'explore', layer: 'user', persona: null, color: 'pink' },
    ]);
    expect(loader.resolveIdentityCatalog(cwd))
      .toContainEqual({ agentType: 'explore', persona: 'Rena', color: 'pink', source: 'built-in' });
  });

  test('clearing a presentation removes the override so the default shows through', async () => {
    const { writer, loader, cwd, userData } = await fixture();
    await writer.writePresentation('user', cwd, 'explore', { persona: 'Juniper', color: 'pink' });

    await writer.writePresentation('user', cwd, 'explore', { persona: '', color: '' });

    expect(loader.resolveIdentityCatalog(cwd).find((row) => row.agentType === 'explore'))
      .toMatchObject({ persona: 'Rena', color: 'orange' });
    expect(loader.listPresentationOverrides(cwd)).toEqual([]);
    expect(JSON.parse(await readFile(userConfigurationPath(userData), 'utf8'))).toEqual({});
  });

  test('the project layer wins over the user layer for the same Agent type', async () => {
    const { writer, loader, cwd } = await fixture();
    await writer.writePresentation('user', cwd, 'plan', { persona: 'User Ada' });

    await writer.writePresentation('project', cwd, 'plan', { persona: 'Project Ada' });

    expect(loader.resolveIdentityCatalog(cwd)).toContainEqual({
      agentType: 'plan',
      persona: 'Project Ada',
      color: 'blue',
      source: 'built-in',
    });
  });

  test('leaves the rest of the file alone', async () => {
    const { writer, cwd, userData } = await fixture();
    await writeJson(userConfigurationPath(userData), {
      defaultProfile: 'focused',
      profiles: { focused: { description: 'Focused.', model: 'gpt-5' } },
    });

    await writer.writeRole('user', cwd, {
      name: 'reviewer',
      description: 'Reviews.',
      developerInstructions: 'Review.',
    }, 'create');

    const written = JSON.parse(await readFile(userConfigurationPath(userData), 'utf8'));
    // Profiles are not the editor's business, and a read-modify-write that
    // dropped them would silently reconfigure the root Thread.
    expect(written.defaultProfile).toBe('focused');
    expect(written.profiles.focused).toEqual({ description: 'Focused.', model: 'gpt-5' });
  });
});

function writerUserData(writer: AgentConfigurationWriter): string {
  return (writer as unknown as { userDataPath: string }).userDataPath;
}

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
  return {
    writer: new AgentConfigurationWriter(userData),
    loader: new AgentConfigurationLoader(userData),
    userData,
    cwd,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}
