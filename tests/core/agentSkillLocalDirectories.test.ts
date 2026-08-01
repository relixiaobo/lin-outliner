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

  test('a self-loaded bound skill stays under skill-write governance', async () => {
    // The whole point of loading a bound directory as a Skill is that the user
    // picked it. Its SKILL.md decides what the model executes, so a write to it
    // must resolve to a governed skill target — not fall through as an ordinary
    // file write with no validation, no audit, and no provenance.
    const workspace = await temporaryRoot();
    const bound = path.join(await temporaryRoot(), 'my-pdf-skill');
    await writeSkill(bound, 'my-pdf-skill', 'Handle PDFs.');

    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();

    const target = runtime.resolveSkillTarget(path.join(bound, 'SKILL.md'));
    expect(target).toMatchObject({
      skillName: 'my-pdf-skill',
      skillRoot: bound,
      isSkillFile: true,
    });
  });

  test('a Skill nested under a self-loaded bound Skill owns its own files', async () => {
    // The enclosing root must not swallow it. Claiming inner/SKILL.md for the
    // outer Skill writes it as a support file, which skips frontmatter and
    // execution-contract validation, records no provenance (so "Undo agent
    // edit" never appears), and names the wrong Skill in the audit.
    const workspace = await temporaryRoot();
    const bound = path.join(await temporaryRoot(), 'outer');
    await writeSkill(bound, 'outer', 'The outer workflow.');
    await writeSkill(path.join(bound, 'inner'), 'inner', 'The inner workflow.');

    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();

    expect(runtime.resolveSkillTarget(path.join(bound, 'inner', 'SKILL.md'))).toMatchObject({
      skillName: 'inner',
      relativePath: 'SKILL.md',
      isSkillFile: true,
    });
    // And the outer Skill still owns its own SKILL.md.
    expect(runtime.resolveSkillTarget(path.join(bound, 'SKILL.md'))).toMatchObject({
      skillName: 'outer',
      isSkillFile: true,
    });
  });

  test('a directory whose name cannot be a Skill name is not loaded as one', async () => {
    // Identity is the directory name. Loading it anyway made every write
    // beneath it fail with invalid_skill_name — writes that plainly succeeded
    // before this feature existed.
    const workspace = await temporaryRoot();
    const bound = path.join(await temporaryRoot(), 'My Skills');
    await writeSkill(bound, 'my-skills', 'Has a space in its folder name.');

    const runtime = runtimeFor(workspace, [bound]);

    expect(await runtime.listAllSkills()).toEqual([]);
    // Ungoverned, exactly as it was before — not governed-and-always-failing.
    expect(runtime.resolveSkillTarget(path.join(bound, 'SKILL.md'))).toBeNull();
  });

  test('unbinding stops treating the directory as a Skill root immediately', async () => {
    // A turn already in flight keeps using the same runtime. Leaving the set
    // populated refused ordinary writes under a directory Tenon no longer
    // treats as a Skill at all.
    const workspace = await temporaryRoot();
    const bound = path.join(await temporaryRoot(), 'my-pdf-skill');
    await writeSkill(bound, 'my-pdf-skill', 'Handle PDFs.');

    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();
    expect(runtime.resolveSkillTarget(path.join(bound, 'SKILL.md'))).not.toBeNull();

    runtime.updateAdditionalSkillDirectories([]);

    expect(runtime.resolveSkillTarget(path.join(bound, 'run.sh'))).toBeNull();
  });

  test('a resource under a self-loaded bound skill belongs to that skill', async () => {
    const workspace = await temporaryRoot();
    const bound = path.join(await temporaryRoot(), 'my-pdf-skill');
    await writeSkill(bound, 'my-pdf-skill', 'Handle PDFs.');
    await mkdir(path.join(bound, 'references'), { recursive: true });

    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();

    // Not a sibling Skill called "references" — a resource of my-pdf-skill.
    expect(runtime.resolveSkillTarget(path.join(bound, 'references', 'notes.md'))).toMatchObject({
      skillName: 'my-pdf-skill',
      relativePath: 'references/notes.md',
      isSkillFile: false,
    });
  });

  test('a SKILL.md written into a bound directory is governed before any load', async () => {
    // The first write is the dangerous one: it is what turns the directory into
    // a Skill, so it cannot wait for a load to have recorded it.
    const workspace = await temporaryRoot();
    const bound = path.join(await temporaryRoot(), 'fresh-skill');
    await mkdir(bound, { recursive: true });

    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();

    expect(runtime.resolveSkillTarget(path.join(bound, 'SKILL.md'))).toMatchObject({
      skillName: 'fresh-skill',
      isSkillFile: true,
    });
  });

  test('a bound container still governs its skills the ordinary way', async () => {
    const workspace = await temporaryRoot();
    const bound = await temporaryRoot();
    await writeSkill(path.join(bound, 'alpha'), 'alpha', 'The alpha workflow.');

    const runtime = runtimeFor(workspace, [bound]);
    await runtime.listAllSkills();

    expect(runtime.resolveSkillTarget(path.join(bound, 'alpha', 'SKILL.md'))).toMatchObject({
      skillName: 'alpha',
      isSkillFile: true,
    });
  });

  test('binding a convention directory does not make it load itself', async () => {
    // Binding ~/.agents/skills dedupes onto the convention entry; if the
    // self-load rule keyed off that merged list, a stray SKILL.md there would
    // load as a Skill literally named "skills".
    const workspace = await temporaryRoot();
    const conventionDir = path.join(workspace, '.agents', 'skills');
    await writeSkill(conventionDir, 'skills', 'Not a skill root.');

    const runtime = runtimeFor(workspace, [conventionDir]);

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
