import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentSkillRuntime } from '../../src/main/agent/capabilities/agentSkills';

/**
 * A bound directory is a **container** of Skills, pointed at and never copied.
 * "The bound directory is itself a Skill" is a separate seam and is deliberately
 * not part of this one: resolving it meant deciding, per write, whether a path
 * belonged to the bound root or to something nested under it, and that ambiguity
 * kept producing ungoverned or wrongly-attributed writes.
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

  test('a bound folder is a container, not a Skill itself', async () => {
    const workspace = await temporaryRoot();
    const bound = path.join(await temporaryRoot(), 'my-pdf-skill');
    await writeSkill(bound, 'my-pdf-skill', 'Handle PDFs.');

    const runtime = runtimeFor(workspace, [bound]);

    // Its own SKILL.md is one segment below the bound root, which is the
    // container's own level — not a Skill's. The picker is what makes this a
    // usable rule: it binds the parent when the chosen folder is a Skill.
    expect(await runtime.listAllSkills()).toEqual([]);
  });

  test('binding the parent is what makes a Skill folder load', async () => {
    const workspace = await temporaryRoot();
    const parent = await temporaryRoot();
    await writeSkill(path.join(parent, 'my-pdf-skill'), 'my-pdf-skill', 'Handle PDFs.');

    const runtime = runtimeFor(workspace, [parent]);

    expect(await runtime.getSkill('my-pdf-skill')).toMatchObject({
      name: 'my-pdf-skill',
      rootDir: path.join(parent, 'my-pdf-skill'),
    });
  });

  test('every loaded skill resolves to a governed write target', async () => {
    // The invariant that matters: loader and resolver must agree. A Skill that
    // loads but resolves to no target is an ungoverned write — no content
    // validation, no audit, no provenance, no "Undo agent edit".
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    await writeSkill(path.join(bound, 'alpha'), 'alpha', 'The alpha workflow.');
    await writeSkill(path.join(bound, 'nested-resources'), 'nested-resources', 'Has resources.');
    await mkdir(path.join(bound, 'nested-resources', 'references'), { recursive: true });

    const runtime = runtimeFor(workspace, [bound]);

    for (const skill of await runtime.listAllSkills()) {
      expect(runtime.resolveSkillTarget(skill.skillFile)).toMatchObject({
        skillName: skill.name,
        isSkillFile: true,
      });
    }
    expect(runtime.resolveSkillTarget(
      path.join(bound, 'nested-resources', 'references', 'notes.md'),
    )).toMatchObject({ skillName: 'nested-resources', isSkillFile: false });
  });

  test('a directory whose name cannot be a Skill name is never admitted', async () => {
    // Admission, not resolution. Admitting it and refusing at write time is what
    // produced a Skill that listed and ran while its own SKILL.md resolved to
    // nothing — an ordinary, ungoverned file write.
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    await writeSkill(path.join(bound, 'My Skill'), 'my-skill', 'Has a space in its folder name.');

    const runtime = runtimeFor(workspace, [bound]);

    expect(await runtime.listAllSkills()).toEqual([]);
  });

  test('the same rule applies to the convention directories', async () => {
    const workspace = await temporaryRoot();
    await writeSkill(path.join(workspace, '.agents', 'skills', 'Bad Name'), 'bad', 'Invalid folder name.');
    await writeSkill(path.join(workspace, '.agents', 'skills', 'good-name'), 'good-name', 'Valid folder name.');

    const runtime = runtimeFor(workspace, []);

    expect((await runtime.listAllSkills()).map((skill) => skill.name)).toEqual(['good-name']);
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
