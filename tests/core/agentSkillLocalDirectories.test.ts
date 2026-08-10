import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

  test('only admitted bound skills own support paths', async () => {
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
      expect(await runtime.resolveSkillTarget(skill.skillFile)).toMatchObject({
        skillName: skill.name,
        isSkillFile: true,
      });
    }
    expect(await runtime.resolveSkillTarget(
      path.join(bound, 'nested-resources', 'references', 'notes.md'),
    )).toMatchObject({ skillName: 'nested-resources', isSkillFile: false });
    expect(await runtime.resolveSkillTarget(path.join(bound, 'taxes', '2025.md'))).toBeNull();
    expect(await runtime.resolveSkillTarget(path.join(bound, 'Research Notes', 'summary.md'))).toBeNull();
    expect(await runtime.resolveSkillTarget(path.join(bound, 'taxes', 'SKILL.md'))).toMatchObject({
      skillName: 'taxes',
      isSkillFile: true,
    });
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
    expect(await runtime.resolveSkillTarget(path.join(bound, 'My Skill', 'notes.md'))).toBeNull();
    expect(await runtime.resolveSkillTarget(path.join(bound, 'My Skill', 'SKILL.md'))).toMatchObject({
      skillName: 'My Skill',
      isSkillFile: true,
    });
  });

  test('path-conditional skills own their bound roots before activation', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    const skillRoot = path.join(bound, 'conditional');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'description: Conditional bound workflow',
      'paths:',
      '  - src/**/*.ts',
      '---',
      '',
      'Use the conditional workflow.',
      '',
    ].join('\n'), 'utf8');

    const runtime = runtimeFor(workspace, [bound]);

    expect((await runtime.listAllSkills()).map((skill) => skill.name)).toEqual(['conditional']);
    expect(await runtime.resolveSkillTarget(path.join(skillRoot, 'references', 'notes.md'))).toMatchObject({
      skillName: 'conditional',
      isSkillFile: false,
    });
  });

  test('same-name physical skills each own their bound root', async () => {
    const workspace = await temporaryRoot();
    const firstBound = await temporaryRoot();
    const secondBound = await temporaryRoot();
    await writeSkill(path.join(firstBound, 'shared'), 'shared', 'First shared workflow.');
    await writeSkill(path.join(secondBound, 'shared'), 'shared', 'Second shared workflow.');

    const runtime = runtimeFor(workspace, [firstBound, secondBound]);
    await runtime.listAllSkills();

    expect(await runtime.resolveSkillTarget(path.join(firstBound, 'shared', 'first.md'))).toMatchObject({
      skillName: 'shared',
      skillsDir: firstBound,
    });
    expect(await runtime.resolveSkillTarget(path.join(secondBound, 'shared', 'second.md'))).toMatchObject({
      skillName: 'shared',
      skillsDir: secondBound,
    });
  });

  test('logical aliases to one physical Skill retain their own attribution', async () => {
    const workspace = await temporaryRoot();
    const firstBound = await temporaryRoot();
    const secondBound = await temporaryRoot();
    const physicalRoot = path.join(await temporaryRoot(), 'physical-skill');
    await writeSkill(physicalRoot, 'alpha', 'Shared physical workflow.');
    await symlink(physicalRoot, path.join(firstBound, 'alpha'));
    await symlink(physicalRoot, path.join(secondBound, 'alpha'));

    const runtime = runtimeFor(workspace, [firstBound, secondBound]);
    await runtime.listAllSkills();

    expect(await runtime.resolveSkillTarget(path.join(secondBound, 'alpha', 'notes.md'))).toMatchObject({
      skillName: 'alpha',
      skillRoot: path.join(secondBound, 'alpha'),
      skillsDir: secondBound,
    });

    runtime.updateAdditionalSkillDirectories([secondBound]);
    expect(await runtime.resolveSkillTarget(path.join(secondBound, 'alpha', 'notes.md'))).toMatchObject({
      skillsDir: secondBound,
    });
  });

  test('the most specific admitted root wins when a bound container overlaps a convention Skill', async () => {
    const workspace = await temporaryRoot();
    const conventionSkillRoot = path.join(workspace, '.agents', 'skills', 'team');
    await writeSkill(conventionSkillRoot, 'team', 'Team convention workflow.');
    await writeSkill(path.join(conventionSkillRoot, 'alpha'), 'alpha', 'Nested explicitly bound workflow.');

    const runtime = runtimeFor(workspace, [conventionSkillRoot]);
    await runtime.listAllSkills();

    expect(await runtime.resolveSkillTarget(path.join(conventionSkillRoot, 'team-notes.md'))).toMatchObject({
      skillName: 'team',
    });
    expect(await runtime.resolveSkillTarget(path.join(conventionSkillRoot, 'alpha', 'notes.md'))).toMatchObject({
      skillName: 'alpha',
      skillRoot: path.join(conventionSkillRoot, 'alpha'),
    });
  });

  test('logical depth wins when the nested bound Skill is a symlink to a shallow physical root', async () => {
    const workspace = await temporaryRoot();
    const conventionSkillRoot = path.join(workspace, '.agents', 'skills', 'team');
    const physicalRoot = path.join(await temporaryRoot(), 'alpha-physical');
    await writeSkill(conventionSkillRoot, 'team', 'Team convention workflow.');
    await writeSkill(physicalRoot, 'alpha', 'Symlinked nested workflow.');
    await symlink(physicalRoot, path.join(conventionSkillRoot, 'alpha'));

    const runtime = runtimeFor(workspace, [conventionSkillRoot]);
    await runtime.listAllSkills();

    expect(await runtime.resolveSkillTarget(path.join(conventionSkillRoot, 'alpha', 'SKILL.md'))).toMatchObject({
      skillName: 'alpha',
      skillRoot: path.join(conventionSkillRoot, 'alpha'),
      isSkillFile: true,
    });
  });

  test('a successful reload publishes new ownership and unbinding removes it immediately', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    const skillRoot = path.join(bound, 'new-skill');
    const skillFile = path.join(skillRoot, 'SKILL.md');
    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();

    expect(await runtime.resolveSkillTarget(path.join(skillRoot, 'notes.md'))).toBeNull();
    expect(await runtime.resolveSkillTarget(skillFile)).toMatchObject({ skillName: 'new-skill', isSkillFile: true });

    await writeSkill(skillRoot, 'new-skill', 'Newly admitted workflow.');
    await runtime.notifySkillContentWritten([skillFile]);
    expect(await runtime.resolveSkillTarget(path.join(skillRoot, 'notes.md'))).toMatchObject({
      skillName: 'new-skill',
      isSkillFile: false,
    });

    runtime.updateAdditionalSkillDirectories([]);
    expect(await runtime.resolveSkillTarget(path.join(skillRoot, 'notes.md'))).toBeNull();
  });

  test('a newly bound directory is loaded before its first path resolution', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    const skillRoot = path.join(bound, 'alpha');
    await writeSkill(skillRoot, 'alpha', 'Newly bound workflow.');
    const runtime = runtimeFor(workspace, []);
    await runtime.listAllSkills();

    const inFlightResolution = runtime.resolveSkillTarget(path.join(skillRoot, 'notes.md'));
    runtime.updateAdditionalSkillDirectories([bound]);

    expect(await inFlightResolution).toMatchObject({
      skillName: 'alpha',
      ownership: 'loaded-bound',
    });
  });

  test('an admitted root stays governed while its definition is temporarily invalid', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    const skillRoot = path.join(bound, 'alpha');
    const skillFile = path.join(skillRoot, 'SKILL.md');
    await writeSkill(skillRoot, 'alpha', 'Temporarily invalid workflow.');
    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();

    await writeFile(skillFile, 'temporarily invalid\n', 'utf8');
    await runtime.notifySkillContentWritten([skillFile]);

    expect(await runtime.resolveSkillTarget(path.join(skillRoot, 'run.sh'))).toMatchObject({
      skillName: 'alpha',
      ownership: 'loaded-bound',
    });
  });

  test('bound ownership follows a symlinked physical root but not an escaping child', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    const physicalRoot = path.join(await temporaryRoot(), 'physical-skill');
    const outside = await temporaryRoot();
    await writeSkill(physicalRoot, 'alias', 'Symlinked workflow.');
    await symlink(physicalRoot, path.join(bound, 'alias'));
    await symlink(outside, path.join(physicalRoot, 'escape'));

    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();

    expect(await runtime.resolveSkillTarget(path.join(bound, 'alias', 'notes.md'))).toMatchObject({ skillName: 'alias' });
    expect(await runtime.resolveSkillTarget(path.join(physicalRoot, 'notes.md'))).toMatchObject({ skillName: 'alias' });
    expect(await runtime.resolveSkillTarget(path.join(bound, 'alias', 'escape', 'notes.md'))).toBeNull();
  });

  test('a bound alias of a convention directory keeps convention ownership', async () => {
    const workspace = await temporaryRoot();
    const conventionDir = path.join(workspace, '.agents', 'skills');
    await writeSkill(path.join(conventionDir, 'alpha'), 'alpha', 'Convention alias workflow.');
    const aliasParent = await temporaryRoot();
    const aliasDir = path.join(aliasParent, 'skills-alias');
    await symlink(conventionDir, aliasDir);

    const runtime = runtimeFor(workspace, [aliasDir]);
    expect((await runtime.listAllSkills()).map((skill) => skill.name)).toEqual(['alpha']);
    expect(await runtime.resolveSkillTarget(path.join(aliasDir, 'alpha', 'notes.md'))).toMatchObject({
      skillName: 'alpha',
      ownership: 'convention',
      skillsDir: aliasDir,
    });
  });

  test('a mutable root shadowed by a built-in does not publish support ownership', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    const shadowRoot = path.join(bound, 'dataviz');
    await writeSkill(shadowRoot, 'dataviz', 'Mutable shadow workflow.');
    const runtime = new AgentSkillRuntime({
      localRoot: workspace,
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: [{
        name: 'dataviz',
        description: 'Built-in data visualization workflow',
        body: 'Use the built-in workflow.',
      }],
      additionalSkillDirectories: [bound],
    });

    expect((await runtime.getSkill('dataviz'))?.source).toBe('built-in');
    expect(await runtime.resolveSkillTarget(path.join(shadowRoot, 'notes.md'))).toBeNull();
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
