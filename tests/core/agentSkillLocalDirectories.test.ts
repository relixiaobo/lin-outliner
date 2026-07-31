import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentSkillRuntime } from '../../src/main/agent/capabilities/agentSkills';

/**
 * A bound directory is pointed at, never copied. The picker lets a user choose
 * any folder, and both shapes are natural: a folder that holds several Skills,
 * and a folder that IS one. Loading only the first left the second silently
 * empty, with nothing saying the picker wanted the parent.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-local-skills-'));
  roots.push(root);
  return root;
}

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the ${name} thing.\n`,
    'utf8',
  );
}

function runtimeFor(workspace: string, directories: string[]): AgentSkillRuntime {
  return new AgentSkillRuntime({
    localRoot: workspace,
    includeUserSkills: false,
    builtInSkillDirectories: [],
    builtInSkills: [],
    additionalSkillDirectories: directories,
  });
}

describe('bound local skill directories', () => {
  test('loads the skills inside a bound folder', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    await writeSkill(path.join(bound, 'alpha'), 'alpha', 'The alpha workflow.');
    await writeSkill(path.join(bound, 'beta'), 'beta', 'The beta workflow.');

    const runtime = runtimeFor(workspace, [bound]);

    expect((await runtime.listAllSkills()).map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
  });

  test('loads a bound folder that is itself a skill', async () => {
    const workspace = await temporaryRoot();
    // The natural pick for a user whose Skill lives at ~/work/my-pdf-skill.
    // Canonical identity stays the directory name, as it is for every source.
    const bound = path.join(await temporaryRoot(), 'my-pdf-skill');
    await writeSkill(bound, 'my-pdf-skill', 'Handle PDFs.');

    const runtime = runtimeFor(workspace, [bound]);

    expect(await runtime.getSkill('my-pdf-skill')).toMatchObject({
      name: 'my-pdf-skill',
      rootDir: bound,
    });
  });

  test('loads both when a bound folder is a skill and contains skills', async () => {
    const workspace = await temporaryRoot();
    const bound = path.join(await temporaryRoot(), 'outer');
    await writeSkill(bound, 'outer', 'The outer workflow.');
    await writeSkill(path.join(bound, 'inner'), 'inner', 'The inner workflow.');

    const runtime = runtimeFor(workspace, [bound]);

    expect((await runtime.listAllSkills()).map((skill) => skill.name).sort()).toEqual(['inner', 'outer']);
  });

  test('a bound folder with no SKILL.md anywhere contributes nothing', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    await mkdir(path.join(bound, 'notes'), { recursive: true });
    await writeFile(path.join(bound, 'notes', 'readme.txt'), 'not a skill', 'utf8');

    const runtime = runtimeFor(workspace, [bound]);

    expect(await runtime.listAllSkills()).toEqual([]);
  });

  test('the convention directories are containers, never a skill themselves', async () => {
    const workspace = await temporaryRoot();
    // A SKILL.md directly in .agents/skills is not a Skill named "skills".
    await writeSkill(path.join(workspace, '.agents', 'skills'), 'skills', 'Not a skill root.');

    const runtime = runtimeFor(workspace, []);

    expect(await runtime.listAllSkills()).toEqual([]);
  });
});
