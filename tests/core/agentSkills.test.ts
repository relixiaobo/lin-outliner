import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentSkillRuntime,
  createSkillTool,
  parseNaturalLanguageSkillifyRequest,
  parseSkillSlashCommand,
  resolvePreloadedSkillInvocations,
  resolveUserSkillInvocation,
  resolveBuiltInSkillResourceRoot,
  resolveSkillContentTarget,
  skillContentHash,
  type AgentSkillProvenanceRecord,
  type AgentSkillProvenanceStore,
} from '../../src/main/agent/capabilities/agentSkills';
const execFile = promisify(execFileCallback);

function acknowledgePendingCatalogRefresh(runtime: AgentSkillRuntime): boolean {
  const checkpoint = runtime.catalogRefreshCheckpoint();
  if (checkpoint === null) return false;
  runtime.acknowledgeCatalogRefresh(checkpoint);
  return true;
}

describe('resolveSkillContentTarget (single skill-path source of truth)', () => {
  const root = path.join(path.sep, 'work', 'project');

  test('recognizes the default project skills dir', async () => {
    const target = await resolveSkillContentTarget(
      path.join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
      { root, includeUserSkills: false, additionalSkillDirectories: [] },
    );
    expect(target).toMatchObject({ skillName: 'demo', source: 'project', isSkillFile: true });
  });

  test('recognizes a nested .agents/skills under root as project, even for a new dir', async () => {
    const target = await resolveSkillContentTarget(
      path.join(root, 'packages', 'a', '.agents', 'skills', 'nested', 'SKILL.md'),
      { root, includeUserSkills: false, additionalSkillDirectories: [] },
    );
    expect(target).toMatchObject({ skillName: 'nested', source: 'project', isSkillFile: true });
  });

  test('recognizes an additional dir OUTSIDE root (the closed governance hole)', async () => {
    // An exact definition is an admission attempt even before the Skill loads.
    const teamSkills = path.join(path.sep, 'home', 'x', 'team-skills');
    const target = await resolveSkillContentTarget(
      path.join(teamSkills, 'shared', 'SKILL.md'),
      { root, includeUserSkills: false, additionalSkillDirectories: [teamSkills] },
    );
    expect(target).toMatchObject({ skillName: 'shared', source: 'user', isSkillFile: true });
  });

  test('requires admitted ownership for support content in an additional dir', async () => {
    const teamSkills = path.join(path.sep, 'home', 'x', 'team-skills');
    const supportFile = path.join(teamSkills, 'shared', 'references', 'notes.md');
    const baseConfig = { root, includeUserSkills: false, additionalSkillDirectories: [teamSkills] };

    expect(await resolveSkillContentTarget(supportFile, baseConfig)).toBeNull();
    expect(await resolveSkillContentTarget(supportFile, {
      ...baseConfig,
      loadedBoundSkillRoots: [{
        skillName: 'shared',
        skillRoot: path.join(teamSkills, 'shared'),
        skillsDir: teamSkills,
        source: 'user',
      }],
    })).toMatchObject({
      skillName: 'shared',
      relativePath: 'references/notes.md',
      isSkillFile: false,
    });
  });

  test('returns null for a non-skill file', async () => {
    expect(
      await resolveSkillContentTarget(path.join(root, 'notes.txt'), {
        root,
        includeUserSkills: false,
        additionalSkillDirectories: [],
      }),
    ).toBeNull();
  });
});

describe('skill provenance and undo', () => {
  // A trivial in-memory store standing in for the userData-backed file store.
  function createMemoryProvenanceStore(): AgentSkillProvenanceStore & { records: Record<string, AgentSkillProvenanceRecord> } {
    const records: Record<string, AgentSkillProvenanceRecord> = {};
    return {
      records,
      load: async () => JSON.parse(JSON.stringify(records)),
      save: async (file, record) => {
        if (record === null) {
          delete records[file];
        } else {
          records[file] = JSON.parse(JSON.stringify(record));
        }
      },
    };
  }

  function skillMarkdown(body: string): string {
    return [
      '---',
      'description: Agent-authored skill',
      '---',
      body,
      '',
    ].join('\n');
  }

  async function writeAuthoredSkill(name: string, body: string): Promise<{ root: string; skillFile: string; content: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-provenance-'));
    const skillFile = path.join(root, '.agents', 'skills', name, 'SKILL.md');
    const content = skillMarkdown(body);
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, content, 'utf8');
    return { root, skillFile, content };
  }

  // The two tests that stood here exercised the trust model: ratification (a
  // permission gate hardcoded open) and acceptance (a claim whose only writer was
  // a button gated behind that gate). Both are deleted — a per-Skill
  // accept-before-use gate is an approval policy, which Tenon does not have. What
  // provenance still owes the product is Undo, covered in agentLocalTools.

  test('an agent write stays invocable without any acceptance step', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('authored', 'Follow the authored workflow.');
    const store = createMemoryProvenanceStore();

    const first = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await first.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await first.notifySkillContentWritten([skillFile]);
    expect(await first.getSkill('authored')).toBeDefined();

    // A fresh runtime over the same store behaves identically — there is no
    // acceptance record to rehydrate and nothing gated on one.
    const second = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    const invocation = await second.invokeSkill({ skill: 'authored', trigger: 'agent' });
    expect(invocation.ok).toBe(true);
  });

  test('undo restores the project original, and the slot is consumed', async () => {
    const { root, skillFile, content: original } = await writeAuthoredSkill('undone', 'The user-authored original.');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });

    // An agent edit over user-authored bytes: previous version carries no agentHash.
    const edited = skillMarkdown('The agent-edited replacement.');
    await writeFile(skillFile, edited, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(edited), { hash: skillContentHash(original), content: original });
    await runtime.notifySkillContentWritten([skillFile]);
    const afterEdit = await runtime.getSkill('undone');
    expect(afterEdit?.canUndoLastAgentEdit).toBe(true);

    await runtime.undoLastAgentSkillEdit('undone');
    const restored = await runtime.getSkill('undone');
    expect(restored?.body).toContain('The user-authored original.');
    expect(restored?.canUndoLastAgentEdit).toBe(false);
    await expect(runtime.undoLastAgentSkillEdit('undone')).rejects.toThrow('no recorded previous version');
  });

  test('undo is refused once a user hand-edit follows the agent write', async () => {
    const { root, skillFile, content: original } = await writeAuthoredSkill('guard-undo', 'The user-authored original.');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });

    const edited = skillMarkdown('The agent-edited replacement.');
    await writeFile(skillFile, edited, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(edited), { hash: skillContentHash(original), content: original });
    await runtime.notifySkillContentWritten([skillFile]);
    expect((await runtime.getSkill('guard-undo'))?.canUndoLastAgentEdit).toBe(true);

    // The user hand-edits over the agent's bytes: the previous-version record
    // lingers, but undo must neither be offered nor executable — restoring would
    // silently destroy the user's edit with no way back.
    const handEdited = skillMarkdown('The user hand-tuned the agent edit.');
    await writeFile(skillFile, handEdited, 'utf8');
    await runtime.notifySkillContentWritten([skillFile]);
    const afterHandEdit = await runtime.getSkill('guard-undo');
    expect(afterHandEdit?.canUndoLastAgentEdit).toBe(false);
    await expect(runtime.undoLastAgentSkillEdit('guard-undo')).rejects.toThrow('edited after the last agent write');
    expect((await runtime.getSkill('guard-undo'))?.body).toContain('hand-tuned');

    // A later agent write re-arms undo with the user's bytes as the new previous
    // version, so undo then restores the user's content, never skips over it.
    const repatched = skillMarkdown('The agent re-patched after the user.');
    await writeFile(skillFile, repatched, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(repatched), { hash: skillContentHash(handEdited), content: handEdited });
    await runtime.notifySkillContentWritten([skillFile]);
    expect((await runtime.getSkill('guard-undo'))?.canUndoLastAgentEdit).toBe(true);
    await runtime.undoLastAgentSkillEdit('guard-undo');
    const restored = await runtime.getSkill('guard-undo');
    expect(restored?.body).toContain('hand-tuned');
  });

  test('the undo slot holds only the version preceding the LAST agent write', async () => {
    const { root, skillFile, content: v1 } = await writeAuthoredSkill('slot', 'Version one.');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });

    const v2 = skillMarkdown('Version two.');
    await writeFile(skillFile, v2, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(v2), { hash: skillContentHash(v1), content: v1 });
    const v3 = skillMarkdown('Version three.');
    await writeFile(skillFile, v3, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(v3), { hash: skillContentHash(v2), content: v2 });
    await runtime.notifySkillContentWritten([skillFile]);

    await runtime.undoLastAgentSkillEdit('slot');
    const restored = await runtime.getSkill('slot');
    expect(restored?.body).toContain('Version two.');
    expect(restored?.body).not.toContain('Version one.');
    // One slot, consumed: no chained undo back to v1.
    expect(restored?.canUndoLastAgentEdit).toBe(false);
  });

  test('a hand-edit over an agent draft stays usable', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('hand-after-agent', 'Agent draft.');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await runtime.notifySkillContentWritten([skillFile]);

    const handEdited = skillMarkdown('User tuned the draft.');
    await writeFile(skillFile, handEdited, 'utf8');
    await runtime.notifySkillContentWritten([skillFile]);
    const invocation = await runtime.invokeSkill({ skill: 'hand-after-agent', trigger: 'agent' });
    expect(invocation.ok).toBe(true);
  });

  test('a user-source hand-edit stays usable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-user-root-'));
    const userRoot = await mkdtemp(path.join(tmpdir(), 'lin-skills-user-dir-'));
    const skillsDir = path.join(userRoot, 'skills');
    const skillDir = await createSkillInRoot(root, 'user-edited', {
      frontmatter: ['description: User-source skill'],
      body: 'Agent draft.',
    }, skillsDir);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      additionalSkillDirectories: [skillsDir],
      provenanceStore: store,
    });

    const authored = await runtime.getSkill('user-edited');
    await runtime.recordAgentSkillWrite(skillFile, authored?.contentHash ?? '');
    await runtime.notifySkillContentWritten([skillFile]);
    expect((await runtime.getSkill('user-edited'))).toMatchObject({});

    const handEdited = skillMarkdown('User tuned the agent draft.');
    await writeFile(skillFile, handEdited, 'utf8');
    await runtime.notifySkillContentWritten([skillFile]);
    const skill = await runtime.getSkill('user-edited');
    expect(skill?.source).toBe('user');
  });

  test('Undo provenance resolves paths:-conditional skills the panel lists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-provenance-'));
    const skillFile = path.join(root, '.agents', 'skills', 'conditional', 'SKILL.md');
    const content = [
      '---',
      'description: Conditional agent-authored skill',
      'paths:',
      '  - src/**/*.ts',
      '---',
      'Conditional workflow.',
      '',
    ].join('\n');
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, content, 'utf8');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await runtime.notifySkillContentWritten([skillFile]);

    // A conditional skill that has not matched anything yet still appears in the
    // library, so the user can see and manage it before it ever activates.
    const listed = (await runtime.listAllSkills()).find((skill) => skill.name === 'conditional');
    expect(listed).toBeDefined();
  });

  // The acceptance-propagation case that stood here is gone with acceptance. The
  // surviving reason a second runtime must re-read the store is Undo, which
  // rewrites the file — covered by the test below.

  test('refreshProvenanceRecords reloads externally restored Skill bytes and schedules a catalog delta', async () => {
    const { root, skillFile, content: firstContent } = await writeAuthoredSkill('shared-undo', 'First workflow.');
    const store = createMemoryProvenanceStore();
    const settingsRuntime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    const conversationRuntime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await settingsRuntime.recordAgentSkillWrite(skillFile, skillContentHash(firstContent), null);
    await settingsRuntime.notifySkillContentWritten([skillFile]);

    const secondContent = skillMarkdown('Second workflow.');
    await writeFile(skillFile, secondContent, 'utf8');
    await settingsRuntime.recordAgentSkillWrite(
      skillFile,
      skillContentHash(secondContent),
      { hash: skillContentHash(firstContent), content: firstContent },
    );
    await settingsRuntime.notifySkillContentWritten([skillFile]);
    const before = await conversationRuntime.buildSkillCatalogSnapshot();
    expect(before.entries.find((entry) => entry.name === 'shared-undo'))
      .toMatchObject({ contentHash: skillContentHash(secondContent) });

    await settingsRuntime.undoLastAgentSkillEdit('shared-undo');
    await conversationRuntime.refreshProvenanceRecords();
    expect(acknowledgePendingCatalogRefresh(conversationRuntime)).toBe(true);
    const after = await conversationRuntime.buildSkillCatalogSnapshot();
    expect(after.entries.find((entry) => entry.name === 'shared-undo'))
      .toMatchObject({ contentHash: skillContentHash(firstContent) });
  });

  test('undo back to an earlier agent version restores those bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-provenance-'));
    const skillFile = path.join(root, '.agents', 'skills', 'agent-born', 'SKILL.md');
    await mkdir(path.dirname(skillFile), { recursive: true });
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });

    // Agent creates v1 (no previous -> no undo), then patches to v2.
    const v1 = skillMarkdown('Agent version one.');
    await writeFile(skillFile, v1, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(v1), null);
    await runtime.notifySkillContentWritten([skillFile]);
    expect((await runtime.getSkill('agent-born'))?.canUndoLastAgentEdit).toBe(false);

    const v2 = skillMarkdown('Agent version two.');
    await writeFile(skillFile, v2, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(v2), { hash: skillContentHash(v1), content: v1 });
    await runtime.notifySkillContentWritten([skillFile]);

    await runtime.undoLastAgentSkillEdit('agent-born');
    const restored = await runtime.getSkill('agent-born');
    expect(restored?.body).toContain('Agent version one.');
  });
});

describe('agent skills', () => {
  test('builds deterministic admission-time catalogs and refreshes existing Threads', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Demo skill', 'when_to_use: Use for demo work'],
      body: 'Follow demo instructions.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    const first = await runtime.buildSkillCatalogSnapshot();
    const replay = await runtime.buildSkillCatalogSnapshot();
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      kind: 'skillCatalog',
      mode: 'baseline',
      previousCatalogHash: null,
    });
    expect(first.entries.find((entry) => entry.name === 'demo')).toMatchObject({
      change: 'available',
      description: 'Demo skill - Use for demo work Invoke without args.',
      source: 'project',
    });
    expect(first.catalogHash).toBe(createHash('sha256').update(JSON.stringify(first.entries.map((entry) => ({
      name: entry.name,
      displayName: entry.displayName,
      source: entry.source,
      identity: entry.identity,
      contentHash: entry.contentHash,
      description: entry.description,
    })))).digest('hex'));

    const skillFile = path.join(root, '.agents', 'skills', 'demo', 'SKILL.md');
    await writeFile(skillFile, [
      '---',
      'description: Updated demo skill',
      '---',
      'Follow updated instructions.',
    ].join('\n'), 'utf8');
    const changed = await runtime.buildSkillCatalogSnapshot();
    expect(changed.catalogHash).not.toBe(first.catalogHash);
    expect(changed.entries.find((entry) => entry.name === 'demo')?.contentHash)
      .not.toBe(first.entries.find((entry) => entry.name === 'demo')?.contentHash);

    await createSkillInRoot(root, 'late-skill', {
      frontmatter: ['description: Added after the first admission'],
      body: 'Follow late instructions.',
    });
    const withLateSkill = await runtime.buildSkillCatalogSnapshot();
    expect(withLateSkill.entries.find((entry) => entry.name === 'late-skill')).toMatchObject({
      change: 'available',
      description: 'Added after the first admission Invoke without args.',
    });
  });

  test('keeps Skill args optional and describes their catalog-governed use', () => {
    const tool = createSkillTool(new AgentSkillRuntime({ includeUserSkills: false }));
    const parameters = tool.parameters as {
      required: string[];
      properties: { args: { description: string } };
    };

    expect(parameters.required).toEqual(['skill']);
    expect(parameters.properties.args.description).toContain('Omit for load-only Skills');
    expect(parameters.properties.args.description).toContain('parameterized Skills');
    expect(tool.description).toContain('The canonical user message already carries the task.');
    expect(tool.description).toContain('an entry without an input label is load-only');
    expect(tool.description).toContain('`[A]` means the Skill accepts parameterized `args`');
    expect(tool.description).toContain('pass only the declared variable input');
  });

  test('applies the Thread Skill ceiling to catalogs, slash choices, and invocation', async () => {
    const root = await createSkillFixture('enabled', {
      frontmatter: ['description: Enabled integration Skill'],
      body: 'Follow enabled instructions.',
    });
    await createSkillInRoot(root, 'blocked', {
      frontmatter: ['description: Blocked integration Skill'],
      body: 'Follow blocked instructions.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: [],
      enabledSkills: ['enabled'],
    });

    expect((await runtime.buildSkillCatalogSnapshot()).entries.map((entry) => entry.name))
      .toEqual(['enabled']);
    expect((await runtime.listUserInvocableSkills()).map((skill) => skill.name)).toEqual(['enabled']);
    expect(await runtime.invokeSkill({ skill: 'blocked', trigger: 'agent' })).toMatchObject({
      ok: false,
      code: 'skill_not_enabled',
    });
    await expect(resolveUserSkillInvocation(runtime, '/blocked')).rejects.toThrow(
      "outside this Thread's configured Skill ceiling",
    );
  });

  test('parses YAML frontmatter block scalars and arrays', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: |',
        '  Demo skill',
        '  with wrapped text',
        'paths:',
        '  - src/**',
        '  - docs/**/*.md',
      ],
      body: 'Follow demo instructions.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    await runtime.notifyFileTouched([path.join(root, 'src', 'file.ts')]);
    const skill = await runtime.getSkill('demo');
    const listing = await runtime.buildSkillCatalogSnapshot();

    expect(skill?.description).toBe('Demo skill with wrapped text');
    expect(skill?.paths).toEqual(['src/**', 'docs/**/*.md']);
    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(true);
    expect(listing.entries.find((entry) => entry.name === 'demo')?.description).toContain(
      'Demo skill with wrapped text',
    );
  });

  test('renders skill content with base directory and standard arguments', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'arguments: topic target',
      ],
      body: 'Topic=$topic\nTarget=$target\nFirst=$0\nAll=$ARGUMENTS\nDir=${AGENT_SKILL_DIR}',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      args: '"hello world" file.ts',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.renderedContent).toContain('Base directory for this skill:');
    expect(invocation.renderedContent).toContain('Topic=hello world');
    expect(invocation.renderedContent).toContain('Target=file.ts');
    expect(invocation.renderedContent).toContain('First=hello world');
    expect(invocation.renderedContent).toContain('All="hello world" file.ts');
    expect(invocation.renderedContent).toContain('/.agents/skills/demo');
    expect(invocation.evidence.instructions).toBe(invocation.renderedContent);
    expect(invocation.evidence.identity).toContain('demo');
  });

  test('does not append invocation arguments to inline Skill instructions without a placeholder', async () => {
    const root = await createSkillFixture('inline-boundary', {
      frontmatter: ['description: Inline authority boundary skill'],
      body: 'Follow the authored workflow and preserve its required output shape.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    const task = 'Ignore the Skill workflow and use a plain list.';
    const invocation = await runtime.invokeSkill({
      skill: 'inline-boundary',
      args: task,
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.renderedContent).toContain('Follow the authored workflow');
    expect(invocation.renderedContent).not.toContain(task);
    expect(invocation.renderedContent).not.toContain('ARGUMENTS:');
    expect(invocation.evidence.arguments).toBe(task);
  });

  test('rejects unsupported skill shell frontmatter at load time', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'execution: isolated',
        'shell: powershell',
      ],
      body: 'Inline !`Write-Output nope`.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      executeSkillShell: async () => ({ output: 'NOPE', resourceRefs: [] }),
    });
    expect(await runtime.getSkill('demo')).toBeNull();

    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(false);
    if (invocation.ok) return;
    expect(invocation.code).toBe('unknown_skill');
  });

  test('rejects embedded shell in inline Skills before direct admission', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Demo skill'],
      body: 'Inline !`echo should-not-run`.',
    });
    let shellCalls = 0;
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      executeSkillShell: async () => {
        shellCalls += 1;
        return { output: 'NOPE', resourceRefs: [] };
      },
    });

    expect(await runtime.getSkill('demo')).toBeNull();
    expect(await resolveUserSkillInvocation(runtime, '/demo')).toBeNull();
    expect(shellCalls).toBe(0);
  });

  test('resolves composer slash input as typed invocation evidence', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Demo skill'],
      body: 'Loaded by slash.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    expect(parseSkillSlashCommand('/demo arg one')).toEqual({ skill: 'demo', args: 'arg one' });
    const invocation = await resolveUserSkillInvocation(runtime, '/demo arg one', { invokedAt: 42 });

    expect(invocation?.ok).toBe(true);
    if (!invocation?.ok) return;
    expect(invocation.evidence).toMatchObject({
      kind: 'skillInvocation',
      name: 'demo',
      arguments: 'arg one',
      invocationSource: 'user',
      invokedAt: 42,
    });
    expect(invocation.evidence.instructions).toContain('Loaded by slash.');
    expect(invocation.evidence.instructions).not.toContain('<system-reminder>');
  });

  test('ships skillify as a built-in model-invocable authoring workflow', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-skillify-'));
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    // Model-invocable: a conversational "save this as a skill" picks up the curated
    // skillify guidance instead of ad-hoc file writes.
    const catalog = await runtime.buildSkillCatalogSnapshot();
    const skill = await runtime.getSkill('skillify');
    const invocation = await resolveUserSkillInvocation(
      runtime,
      '/skillify turn this workflow into a reusable skill',
    );

    expect(catalog.entries.some((entry) => entry.name === 'skillify')).toBe(true);
    expect(skill).toMatchObject({
      name: 'skillify',
      source: 'built-in',
      modelInvocable: true,
      userInvocable: true,
    });
    const text = invocation?.ok ? invocation.evidence.instructions : '';
    expect(text).not.toContain('Base directory for this skill:');
    expect(text).not.toContain('built-in/skillify/SKILL.md');
    expect(text).toContain('Skillify v2 workflow');
    expect(text).toContain('available immediately');
  });

  test('recognizes only explicit natural-language skillify requests', () => {
    expect(parseNaturalLanguageSkillifyRequest('Save this as a skill')).toEqual({
      skill: 'skillify',
      args: 'Save this as a skill',
    });
    expect(parseNaturalLanguageSkillifyRequest('Please update the importer skill with what we just learned')).toEqual({
      skill: 'skillify',
      args: 'Please update the importer skill with what we just learned',
    });
    expect(parseNaturalLanguageSkillifyRequest('Fix the skill that failed')).toEqual({
      skill: 'skillify',
      args: 'Fix the skill that failed',
    });
    expect(parseNaturalLanguageSkillifyRequest('Skillify this debugging workflow')).toEqual({
      skill: 'skillify',
      args: 'Skillify this debugging workflow',
    });
    expect(parseNaturalLanguageSkillifyRequest('Do we have a skill for this?')).toBeNull();
    expect(parseNaturalLanguageSkillifyRequest('How do I save this as a skill?')).toBeNull();
    expect(parseNaturalLanguageSkillifyRequest('/skillify this workflow')).toBeNull();
    expect(parseNaturalLanguageSkillifyRequest('update the skills list in my outline')).toBeNull();
    expect(parseNaturalLanguageSkillifyRequest('I want to improve my coding skills')).toBeNull();
    expect(parseNaturalLanguageSkillifyRequest('make a skill tree for the game')).toBeNull();
    expect(parseNaturalLanguageSkillifyRequest('Can you fix the skill check in my D&D sheet?')).toBeNull();
    expect(parseNaturalLanguageSkillifyRequest('Tell me about skillify / explain skillify to me')).toBeNull();
  });

  test('natural-language skillify falls back to normal chat when the skill is disabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-skillify-disabled-'));
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    runtime.updateDisabledSkills(['skillify']);

    await expect(resolveUserSkillInvocation(runtime, '/skillify this workflow')).rejects.toThrow('currently disabled');
    expect(await resolveUserSkillInvocation(runtime, 'Save this workflow as a skill')).toBeNull();
  });

  test('pins skillify v2 Tenon authoring invariants', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-skillify-v2-'));
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    const skill = await runtime.getSkill('skillify');
    const body = skill?.body ?? '';

    expect(body).toContain('Skillify v2 workflow');
    expect(body).toContain('~/.agents/skills/<skill-name>/SKILL.md');
    expect(body).toContain('<workspace>/.agents/skills/<skill-name>/SKILL.md');
    expect(body).toContain('lowercase `skill` tool semantics');
    expect(body).toContain('Do not write `name:` frontmatter');
    expect(body).not.toContain('.claude');
    expect(body).not.toContain('Teammate');

    expect(body).toContain('resolve and read the current `SKILL.md` first');
    expect(body).toContain('Prefer a focused `file_edit` patch');
    expect(body).toContain('write it directly without a second confirmation');
    expect(body).toContain('Ask only for a missing identity');
    expect(body).toContain('show the complete `SKILL.md`');
    expect(body).toContain('only when that preview is needed');
    expect(body).toContain('request_user_input');
    expect(body).not.toContain('Save, revise, or cancel choices');

    expect(body).toContain('A Skill loads instructions into the current Turn');
    expect(body).toContain('does not select a model, run embedded shell, or create another Agent');

    expect(body).toContain('available immediately');
    expect(body).toContain('slash invocation works immediately');
    expect(body).toContain('without a separate approval prompt');
    expect(body).toContain('Do not write executable or binary support files');
  });

  test('records built-in skill invocations without surfacing pseudo file paths', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const invocation = await runtime.invokeSkill({ skill: 'skillify', trigger: 'agent' });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.renderedContent).toContain('Skillify v2 workflow');
    expect(invocation.renderedContent).not.toContain('Base directory for this skill:');
    expect(invocation.renderedContent).not.toContain('built-in/skillify/SKILL.md');

    expect(invocation.evidence).toMatchObject({
      kind: 'skillInvocation',
      name: 'skillify',
      source: 'built-in',
      identity: 'built-in:skillify',
      resourceRoot: null,
    });
    expect(invocation.evidence.instructions).not.toContain('built-in/skillify/SKILL.md');
  });

  test('represents built-in Skills in the catalog without pseudo file paths', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const catalog = await runtime.buildSkillCatalogSnapshot();
    const skillify = catalog.entries.find((entry) => entry.name === 'skillify');

    expect(skillify).toMatchObject({ identity: 'built-in:skillify', source: 'built-in' });
    expect(JSON.stringify(skillify)).not.toContain('built-in/skillify/SKILL.md');
  });

  test('keeps optional general-purpose skills outside the built-in floor', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const catalog = await runtime.buildSkillCatalogSnapshot();

    for (const name of ['data-analysis', 'document', 'feed-processing', 'pdf', 'presentation', 'spreadsheet']) {
      expect(await runtime.getSkill(name)).toBeNull();
      expect(catalog.entries.some((entry) => entry.name === name)).toBe(false);
    }
    for (const name of ['skillify', 'outline']) {
      expect(await runtime.getSkill(name)).not.toBeNull();
    }
    expect(await runtime.getSkill('research')).toBeNull();
  });

  test('teaches the built-in outline Skill to use the agent-first model without shell choreography', async () => {
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
    });
    const invocation = await runtime.invokeSkill({ skill: 'outline', trigger: 'agent' });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    const instructions = invocation.renderedContent.replace(/\s+/gu, ' ');
    expect(instructions).toContain('A **Node** is the only content and tree identity');
    expect(instructions).toContain('A **Field** is a reusable typed definition');
    expect(instructions).toContain('A **View** projects Nodes as `outline`, `table`, `cards`, or `calendar`');
    expect(instructions).toContain('| Create a complete Node tree and optional View | `outline create ...` |');
    expect(instructions).toContain('| Multi-resource work with dependencies | `outline transact --input -` |');
    expect(instructions).toContain('bind resources inside its ChangeSet instead of querying intermediate IDs');
    expect(instructions).toContain('Request-local field keys');
    expect(instructions).toContain('outline example edit complete');
    expect(instructions).toContain('outline example edit bounded-query');
    expect(instructions).toContain('outline daily ensure YYYY-MM-DD');
    expect(instructions).toContain('outline trash TARGET');
    expect(instructions).toContain('outline restore TARGET');
    expect(instructions).toContain('outline export TARGET --format markdown --output FILE');
    expect(instructions).toContain('outline search edit TARGET --title "TITLE" --match "TEXT" --view cards');
    expect(instructions).toContain('outline example transact dependent-change');
    expect(instructions).toContain('outline import verify OPERATION_ID --diff DIFF --evidence EVIDENCE');
    expect(instructions).toContain('An export receipt already proves its path, byte count, and SHA-256');
    expect(instructions).toContain('explicit `max`');
    expect(instructions).toContain('When the task fits the Common Create shape above, run it directly');
    expect(instructions).toContain('Do not issue a separate verification read');
    expect(instructions).toContain('Bash\'s separate `stdin` field');
    expect(instructions).toContain('outline view get|set');
    expect(instructions).toContain('Do not read the current View before a fully specified `view set`');
  });

  test('loads bundled built-in skills with real resource directories', async () => {
    const { skillsDir, skillDir } = await createBundledBuiltInSkillFixture('bundled-demo', {
      frontmatter: [
        'description: Bundled demo skill',
        'when_to_use: Use for bundled resource tests',
        'arguments: target',
      ],
      body: 'Read ${AGENT_SKILL_DIR}/references/details.md for $target.',
    });
    await mkdir(path.join(skillDir, 'references'), { recursive: true });
    await writeFile(path.join(skillDir, 'references', 'details.md'), 'Bundled reference.', 'utf8');
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
    });

    const skill = await runtime.getSkill('bundled-demo');
    const catalog = await runtime.buildSkillCatalogSnapshot();
    const invocation = await runtime.invokeSkill({
      skill: 'bundled-demo',
      args: 'deck.md',
      trigger: 'agent',
    });

    expect(skill).toMatchObject({
      name: 'bundled-demo',
      source: 'built-in',
      rootDir: skillDir,
      skillFile: path.join(skillDir, 'SKILL.md'),
      modelInvocable: true,
      userInvocable: true,
      canUndoLastAgentEdit: false,
    });
    expect(typeof skill?.contentHash).toBe('string');
    expect(catalog.entries.find((entry) => entry.name === 'bundled-demo')?.description)
      .toBe('Bundled demo skill - Use for bundled resource tests Args: target.');
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.renderedContent).toContain(`Base directory for this skill: ${skillDir}`);
    expect(invocation.renderedContent).toContain(`Read ${skillDir}/references/details.md for deck.md.`);
    expect(invocation.evidence).toMatchObject({
      identity: 'built-in:bundled-demo',
      resourceRoot: skillDir,
      instructions: invocation.renderedContent,
    });
    expect(invocation.evidence.instructions).not.toContain(path.join(skillDir, 'SKILL.md'));
  });

  test('resolves stable resource-backed built-in identity after runtime restart', async () => {
    const { skillsDir, skillDir } = await createBundledBuiltInSkillFixture('bundled-demo', {
      frontmatter: ['description: Bundled demo skill'],
      body: 'Use bundled instructions from ${AGENT_SKILL_DIR}.',
    });
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
    });
    const invocation = await runtime.invokeSkill({ skill: 'bundled-demo', trigger: 'agent' });
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;

    const restored = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
    });
    const replay = await restored.invokeSkill({ skill: 'bundled-demo', trigger: 'agent' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;

    expect(replay.evidence.identity).toBe(invocation.evidence.identity);
    expect(replay.evidence.contentHash).toBe(invocation.evidence.contentHash);
    expect(replay.evidence.resourceRoot).toBe(skillDir);
    expect(replay.evidence.instructions).toContain(`Base directory for this skill: ${skillDir}`);
  });

  test('does not resolve bundled built-in files as writable skill targets', async () => {
    const { skillsDir, skillDir } = await createBundledBuiltInSkillFixture('bundled-demo', {
      frontmatter: ['description: Bundled demo skill'],
      body: 'Use bundled instructions.',
    });

    expect(
      await resolveSkillContentTarget(path.join(skillDir, 'SKILL.md'), {
        root: path.dirname(path.dirname(skillDir)),
        includeUserSkills: false,
        additionalSkillDirectories: [],
        builtInSkillDirectories: [skillsDir],
      }),
    ).toBeNull();
  });

  test('does not resolve explicit built-in skill root files as writable skill targets', async () => {
    const { skillDir } = await createBundledBuiltInSkillFixture('root-built-in', {
      frontmatter: ['description: Root built-in skill'],
      body: 'Use explicit root instructions.',
    });

    expect(
      await resolveSkillContentTarget(path.join(skillDir, 'SKILL.md'), {
        root: path.dirname(path.dirname(skillDir)),
        includeUserSkills: false,
        additionalSkillDirectories: [path.dirname(skillDir)],
        builtInSkillDirectories: [],
        builtInSkillRoots: [skillDir],
      }),
    ).toBeNull();
  });

  test('keeps built-in resource directories immutable even if also configured as additional skill dirs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-root-'));
    const { skillsDir, skillDir } = await createBundledBuiltInSkillFixture('bundled-demo', {
      frontmatter: ['description: Bundled demo skill'],
      body: 'Use bundled instructions.',
    });
    const aliasParent = await mkdtemp(path.join(tmpdir(), 'lin-skills-built-in-alias-'));
    const aliasSkillsDir = path.join(aliasParent, 'skills');
    await symlink(skillsDir, aliasSkillsDir);
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
      additionalSkillDirectories: [skillsDir, aliasSkillsDir],
    });

    expect(await runtime.resolveSkillTarget(path.join(skillDir, 'SKILL.md'))).toBeNull();
    expect(await runtime.resolveSkillTarget(path.join(aliasSkillsDir, 'bundled-demo', 'new-notes.md'))).toBeNull();
    expect((await runtime.getSkill('bundled-demo'))?.source).toBe('built-in');
  });

  test('loads bundled built-in skills before mutable local skills', async () => {
    const root = await createSkillFixture('floor-skill', {
      frontmatter: ['description: Mutable shadow skill'],
      body: 'Use mutable instructions.',
    });
    const { skillsDir } = await createBundledBuiltInSkillFixture('floor-skill', {
      frontmatter: ['description: Bundled floor skill'],
      body: 'Use bundled instructions.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
    });

    const skill = await runtime.getSkill('floor-skill');
    const catalog = await runtime.buildSkillCatalogSnapshot();

    expect(skill).toMatchObject({
      name: 'floor-skill',
      source: 'built-in',
    });
    expect(skill?.body).toContain('Use bundled instructions.');
    expect(catalog.entries.find((entry) => entry.name === 'floor-skill')?.description)
      .toBe('Bundled floor skill Invoke without args.');
  });

  test('keeps path-scoped bundled built-ins available as the immutable floor', async () => {
    const { skillsDir } = await createBundledBuiltInSkillFixture('path-built-in', {
      frontmatter: [
        'description: Path built-in skill',
        'paths:',
        '  - docs/**/*.md',
      ],
      body: 'Use bundled path instructions.',
    });
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
    });

    const skill = await runtime.getSkill('path-built-in');
    const catalog = await runtime.buildSkillCatalogSnapshot();

    expect(skill).toMatchObject({
      name: 'path-built-in',
      source: 'built-in',
      paths: ['docs/**/*.md'],
    });
    expect(catalog.entries.some((entry) => entry.name === 'path-built-in')).toBe(true);
  });

  test('ignores name frontmatter aliases for bundled built-ins', async () => {
    const { skillsDir } = await createBundledBuiltInSkillFixture('canonical-name', {
      frontmatter: [
        'name: alias-name',
        'description: Bundled canonical skill',
      ],
      body: 'Use canonical instructions.',
    });
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
    });

    const skill = await runtime.getSkill('canonical-name');
    const alias = await runtime.getSkill('alias-name');

    expect(skill).toMatchObject({
      name: 'canonical-name',
      source: 'built-in',
      displayName: undefined,
    });
    expect(alias).toBeNull();
  });

  test('fails loudly when bundled and inline built-ins share a name', async () => {
    const { skillsDir } = await createBundledBuiltInSkillFixture('skillify', {
      frontmatter: ['description: Bundled duplicate skill'],
      body: 'This duplicate must not be silently ignored.',
    });
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
    });

    await expect(runtime.getSkill('skillify')).rejects.toThrow('Duplicate built-in skill "skillify"');
    await expect(runtime.buildSkillCatalogSnapshot()).rejects.toThrow('Duplicate built-in skill "skillify"');
  });

  test('shares the first skill load across concurrent callers', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const results = await Promise.allSettled([
      runtime.getSkill('skillify'),
      runtime.getSkill('outline'),
      runtime.listAllSkills(),
      runtime.buildSkillCatalogSnapshot(),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { name: 'skillify', source: 'built-in' } });
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { name: 'outline', source: 'built-in' } });
    const allSkills = results[2].status === 'fulfilled' ? results[2].value : [];
    expect(allSkills.map((skill) => skill.name).sort()).toEqual([
      'delegate',
      'outline',
      'skillify',
    ]);
  });

  test('ships public outline workflows without legacy document authorities', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const outline = await runtime.getSkill('outline');
    const outlineCatalogEntry = (await runtime.buildSkillCatalogSnapshot()).entries
      .find((entry) => entry.name === 'outline');

    expect(await runtime.getSkill('data-cleanup')).toBeNull();
    expect(await runtime.getSkill('outline-import')).toBeNull();
    expect(outlineCatalogEntry?.description).toContain('Invoke without args.');
    expect(outline?.body).toContain('# Outline');
    expect(outline?.body).toContain('## Model');
    expect(outline?.body).toContain('## Route');
    expect(outline?.body).toContain('## Common Create');
    expect(outline?.body).toContain('## Disclosure And Recovery');
    expect(outline?.body).toContain('children are the actual items');
    expect(outline?.body).toContain('Public Field types are');
    expect(outline?.body).toContain('`[[node://UUID]]`');
    expect(outline?.body).toContain('outline example edit complete');
    expect(outline?.body).not.toContain('references/');
    expect(outline?.body).not.toContain(['table-view', 'changeset.json'].join('-'));
    const toolResult = await createSkillTool(runtime).execute('outline-skill-call', {
      skill: 'outline',
      args: 'Create a native table view in today\'s note.',
    });
    expect(toolResult.details).toMatchObject({
      ok: true,
      data: {
        success: true,
        skill: 'outline',
        status: 'loaded',
        invocationEvidence: {
          arguments: 'Create a native table view in today\'s note.',
        },
      },
    });
    expect(outline?.body).not.toContain(['outline import', 'helper tana SOURCE'].join('-'));
    const retiredToolPattern = new RegExp(`\\b(?:${[
      ['node', 'search'],
      ['node', 'read'],
      ['node', 'create'],
      ['node', 'edit'],
      ['node', 'delete'],
      ['outline', 'undo', 'stack'],
    ].map((parts) => parts.join('_')).join('|')})\\b`);
    for (const skill of [outline]) {
      expect(skill).not.toBeNull();
      expect(skill?.body).not.toMatch(retiredToolPattern);
      expect(skill?.body).not.toMatch(/outline\s+(?:show|find|diff|apply|log|revert)[^\n]*\s--json\b/);
      expect(skill?.body).not.toMatch(/outline\b[^\n]*(?:--file|--operation-id)\b/);
      expect(skill?.body).not.toContain(['tenon', 'import'].join('-'));
      expect(skill?.body).not.toContain(['Agent', 'Import', 'Service'].join(''));
      expect(skill?.body).not.toContain(['Agent', 'Import', 'Api', 'Server'].join(''));
    }
  });

  test('loads delegate as a model-only built-in Skill', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const delegate = await runtime.getSkill('delegate');

    expect(delegate).toMatchObject({
      name: 'delegate',
      source: 'built-in',
      userInvocable: false,
      modelInvocable: true,
    });
    expect(delegate?.body).toContain('delegate run --input - --output json');
    expect(delegate?.body).toContain('Completion is pushed; do not poll');
    expect(delegate?.body).toContain('After user cancellation');
    expect(delegate?.body).toContain('without a new user request.');

    runtime.updateDisabledSkills(['delegate']);
    expect((await runtime.buildSkillCatalogSnapshot()).entries.some((entry) => entry.name === 'delegate')).toBe(false);
    expect(await runtime.invokeSkill({ skill: 'delegate', trigger: 'agent' })).toMatchObject({
      ok: false,
      code: 'skill_disabled',
    });
  });

  test('resolves bundled built-in resource roots for dev and packaged modes', () => {
    const repoRoot = path.join(path.sep, 'repo');
    const resourcesPath = path.join(path.sep, 'Applications', 'Tenon.app', 'Contents', 'Resources');

    expect(resolveBuiltInSkillResourceRoot({ isPackaged: false, appPath: repoRoot }))
      .toBe(path.join(repoRoot, 'src', 'main', 'builtInSkills'));
    expect(resolveBuiltInSkillResourceRoot({ isPackaged: true, resourcesPath }))
      .toBe(path.join(resourcesPath, 'built-in-skills'));
  });

  test('elides repeated load-only contracts before they exceed the catalog budget', async () => {
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: Array.from({ length: 300 }, (_, index) => ({
        name: `s-${String(index).padStart(3, '0')}`,
        description: `Load-only catalog entry ${index}`,
        body: 'Follow the loaded workflow.',
        modelInvocable: true,
      })),
    });

    const catalog = await runtime.buildSkillCatalogSnapshot();
    const pressureEntries = catalog.entries.filter((entry) => entry.name.startsWith('s-'));

    expect(pressureEntries).toHaveLength(300);
    expect(pressureEntries.every((entry) => entry.description === '')).toBe(true);
    expect(catalog.entries.reduce((total, entry) => (
      total + entry.name.length + entry.description.length + 4
    ), 0)).toBeLessThanOrEqual(8_000);
  });

  test('uses compact argument labels before fixed contracts exceed the catalog budget', async () => {
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: [
        ...Array.from({ length: 400 }, (_, index) => ({
          name: `param-${String(index).padStart(3, '0')}`,
          description: `Parameterized catalog entry ${index}`,
          body: 'Process $target.',
          argumentNames: ['target'],
          modelInvocable: true,
        })),
        {
          name: 'z-load-only-one',
          description: 'Load-only reference one',
          body: 'Complete the task.',
          modelInvocable: true,
        },
        {
          name: 'z-load-only-two',
          description: 'Load-only reference two',
          body: 'Complete the task.',
          modelInvocable: true,
        },
      ],
    });

    const catalog = await runtime.buildSkillCatalogSnapshot();
    const parameterized = catalog.entries.filter((entry) => entry.name.startsWith('param-'));

    expect(parameterized).toHaveLength(400);
    expect(parameterized.every((entry) => entry.description === '[A]')).toBe(true);
    expect(catalog.entries.find((entry) => entry.name === 'z-load-only-one')?.description).toBe('');
    expect(catalog.entries.find((entry) => entry.name === 'z-load-only-two')?.description).toBe('');
    expect(catalog.entries.reduce((total, entry) => (
      total + entry.name.length + entry.description.length + 4
    ), 0)).toBeLessThanOrEqual(8_000);
  });

  test('keeps a deterministic catalog prefix when names and compact labels exceed the budget', async () => {
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: Array.from({ length: 600 }, (_, index) => ({
        name: `param-${String(index).padStart(3, '0')}`,
        description: `Parameterized overflow entry ${index}`,
        body: 'Process $target.',
        argumentNames: ['target'],
        modelInvocable: true,
      })),
    });

    const catalog = await runtime.buildSkillCatalogSnapshot();

    expect(catalog.entries).toHaveLength(500);
    expect(catalog.entries[0]?.name).toBe('param-000');
    expect(catalog.entries.at(-1)?.name).toBe('param-499');
    expect(catalog.entries.every((entry) => entry.description === '[A]')).toBe(true);
    expect(catalog.entries.reduce((total, entry) => (
      total + entry.name.length + entry.description.length + 4
    ), 0)).toBe(8_000);
  });

  test('disabled skill gates apply to built-in Skills', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    runtime.updateDisabledSkills(['skillify']);
    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(true);
    runtime.updateDisabledSkills(['skillify']);
    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(false);

    expect((await runtime.buildSkillCatalogSnapshot()).entries.some((entry) => entry.name === 'skillify')).toBe(false);
    const invocation = await runtime.invokeSkill({ skill: 'skillify', trigger: 'agent' });

    expect(invocation.ok).toBe(false);
    if (invocation.ok) return;
    expect(invocation.code).toBe('skill_disabled');
  });

  test('rejects execution overrides on inline Skills', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'model: openai/gpt-5.2',
        'effort: high',
      ],
      body: 'Use a stronger model.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    expect(await runtime.getSkill('demo')).toBeNull();

    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      trigger: 'agent',
    });

    expect(invocation).toMatchObject({ ok: false, code: 'unknown_skill' });
  });

  test('loads skills from configured additional directories after default dirs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-root-'));
    const extraRoot = await mkdtemp(path.join(tmpdir(), 'lin-skills-extra-'));
    const extraDir = path.join(extraRoot, 'skills');
    const skillDir = path.join(extraDir, 'external-demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: External demo skill\n---\nUse external instructions.\n',
      'utf8',
    );

    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      additionalSkillDirectories: [extraDir],
    });

    const catalog = await runtime.buildSkillCatalogSnapshot();
    expect(catalog.entries.some((entry) => entry.name === 'external-demo')).toBe(true);
  });

  test('loads code-registered built-in skills before mutable local skills', async () => {
    const root = await createSkillFixture('floor-skill', {
      frontmatter: ['description: Mutable shadow skill'],
      body: 'Use mutable instructions.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      builtInSkills: [{
        name: 'floor-skill',
        description: 'Built-in floor skill',
        body: 'Use built-in instructions.',
      }],
    });

    const skill = await runtime.getSkill('floor-skill');
    const catalog = await runtime.buildSkillCatalogSnapshot();

    expect(skill).toMatchObject({
      name: 'floor-skill',
      source: 'built-in',
      skillFile: 'built-in/floor-skill/SKILL.md',
    });
    expect(skill?.body).toBe('Use built-in instructions.');
    expect(catalog.entries.find((entry) => entry.name === 'floor-skill')?.description)
      .toBe('Built-in floor skill Invoke without args.');
  });

  test('re-lists a same-name skill when its resolved file identity changes', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Project demo skill'],
      body: 'Use project instructions.',
    });
    const extraRoot = await mkdtemp(path.join(tmpdir(), 'lin-skills-extra-same-name-'));
    const extraDir = path.join(extraRoot, 'skills');
    await createSkillInRoot(extraRoot, 'demo', {
      frontmatter: ['description: External demo skill'],
      body: 'Use external instructions.',
    }, extraDir);
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    const projectCatalog = await runtime.buildSkillCatalogSnapshot();
    runtime.updateAdditionalSkillDirectories([extraDir]);
    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(true);
    runtime.updateAdditionalSkillDirectories([extraDir]);
    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(false);
    const externalCatalog = await runtime.buildSkillCatalogSnapshot();

    expect(projectCatalog.entries.find((entry) => entry.name === 'demo')?.description)
      .toBe('Project demo skill Invoke without args.');
    expect(externalCatalog.entries.find((entry) => entry.name === 'demo')?.description)
      .toBe('External demo skill Invoke without args.');
  });

  test('deduplicates the same skill file loaded through symlinked directories', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Demo skill'],
      body: 'Follow demo instructions.',
    });
    const extraRoot = await mkdtemp(path.join(tmpdir(), 'lin-skills-symlink-'));
    const extraDir = path.join(extraRoot, 'skills');
    await mkdir(extraDir, { recursive: true });
    await symlink(path.join(root, '.agents', 'skills', 'demo'), path.join(extraDir, 'alias'));
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      additionalSkillDirectories: [extraDir],
    });

    const catalog = await runtime.buildSkillCatalogSnapshot();

    expect(catalog.entries.filter((entry) => entry.name === 'demo')).toHaveLength(1);
    expect(catalog.entries.some((entry) => entry.name === 'alias')).toBe(false);
  });

  test('activates path-conditional skills after matching file paths are touched', async () => {
    const root = await createSkillFixture('typescript-review', {
      frontmatter: [
        'description: TypeScript review',
        'paths:',
        '  - src/**/*.ts',
      ],
      body: 'Use TS conventions.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    expect((await runtime.buildSkillCatalogSnapshot()).entries.some((entry) => (
      entry.name === 'typescript-review'
    ))).toBe(false);
    await runtime.notifyFileTouched([path.join(root, 'src', 'main.ts')]);

    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(true);
    expect((await runtime.buildSkillCatalogSnapshot()).entries.some((entry) => (
      entry.name === 'typescript-review'
    ))).toBe(true);
  });

  test('matches directory path-conditional patterns', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-paths-'));
    await createSkillInRoot(root, 'src-directory', {
      frontmatter: [
        'description: Source directory skill',
        'paths:',
        '  - src',
      ],
      body: 'Use source directory conventions.',
    });
    await createSkillInRoot(root, 'src-globstar', {
      frontmatter: [
        'description: Source globstar skill',
        'paths:',
        '  - src/**',
      ],
      body: 'Use source globstar conventions.',
    });

    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    expect((await runtime.buildSkillCatalogSnapshot()).entries.some((entry) => (
      entry.name === 'src-directory'
    ))).toBe(false);
    await runtime.notifyFileTouched([path.join(root, 'src')]);

    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(true);
    const active = await runtime.buildSkillCatalogSnapshot();
    expect(active.entries.some((entry) => entry.name === 'src-directory')).toBe(true);
    expect(active.entries.some((entry) => entry.name === 'src-globstar')).toBe(true);

    await runtime.notifyFileTouched([path.join(root, 'src', 'app', 'main.ts')]);
    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(false);
  });

  test('skips dynamically discovered skill directories ignored by git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-gitignore-'));
    await execFile('git', ['-C', root, 'init']);
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n', 'utf8');
    await createSkillInRoot(root, 'ignored-dynamic', {
      frontmatter: ['description: Ignored dynamic skill'],
      body: 'Do not load from ignored directories.',
    }, path.join(root, 'ignored', 'pkg', '.agents', 'skills'));

    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    await runtime.notifyFileTouched([path.join(root, 'ignored', 'pkg', 'file.ts')]);

    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(false);
  });

  test('discovers dynamic skill directories created after an earlier miss', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-dynamic-miss-'));
    const nestedSkillsDir = path.join(root, 'packages', 'app', '.agents', 'skills');
    const touchedFile = path.join(root, 'packages', 'app', 'src', 'main.ts');
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    await runtime.notifyFileTouched([touchedFile]);
    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(false);
    expect((await runtime.buildSkillCatalogSnapshot()).entries.some((entry) => (
      entry.name === 'late-dynamic'
    ))).toBe(false);

    await createSkillInRoot(root, 'late-dynamic', {
      frontmatter: ['description: Late dynamic skill'],
      body: 'Use late dynamic instructions.',
    }, nestedSkillsDir);
    await runtime.notifyFileTouched([touchedFile]);

    expect(acknowledgePendingCatalogRefresh(runtime)).toBe(true);
    expect((await runtime.buildSkillCatalogSnapshot()).entries.some((entry) => (
      entry.name === 'late-dynamic'
    ))).toBe(true);
  });
});

describe('built-in skill resource packaging', () => {
  test('stages the complete public workflows into packaged Skills', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..', '..');
    await execFile('bun', ['scripts/sync-built-in-skills.ts'], { cwd: repoRoot });
    const generatedRoot = path.join(repoRoot, 'build', 'generated', 'built-in-skills');
    expect((await readdir(generatedRoot)).sort()).toEqual(['delegate', 'outline']);
    const delegateRoot = path.join(generatedRoot, 'delegate');
    const delegateRaw = await readFile(path.join(delegateRoot, 'SKILL.md'), 'utf8');
    expect(delegateRaw).toContain('delegate run --input - --output json');
    expect(delegateRaw).toContain('run_in_background: true');
    expect(delegateRaw).toContain('After user cancellation');
    expect(delegateRaw).toContain('without a new user request.');
    expect((await readdir(delegateRoot)).sort()).toEqual(['SKILL.md']);
    const outlineRoot = path.join(generatedRoot, 'outline');
    expect(await readFile(path.join(outlineRoot, 'SKILL.md'), 'utf8'))
      .toContain('outline example edit complete');
    expect((await readdir(outlineRoot)).sort()).toEqual(['SKILL.md']);
    for (const name of ['data-analysis', 'document', 'feed-processing', 'pdf', 'presentation', 'spreadsheet']) {
      await expect(readFile(path.join(generatedRoot, name, 'SKILL.md'), 'utf8')).rejects.toThrow();
    }
  });
});

async function createBundledBuiltInSkillFixture(
  name: string,
  options: { frontmatter: string[]; body: string },
): Promise<{ skillsDir: string; skillDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-bundled-skills-'));
  const skillsDir = path.join(root, 'built-in-skills');
  const skillDir = await createSkillInRoot(root, name, options, skillsDir);
  return {
    skillsDir: await realpath(skillsDir),
    skillDir: await realpath(skillDir),
  };
}

async function createSkillFixture(
  name: string,
  options: { frontmatter: string[]; body: string },
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-'));
  await createSkillInRoot(root, name, options);
  return root;
}

async function createSkillInRoot(
  root: string,
  name: string,
  options: { frontmatter: string[]; body: string },
  skillsDir = path.join(root, '.agents', 'skills'),
): Promise<string> {
  const dir = path.join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\n${options.frontmatter.join('\n')}\n---\n${options.body}\n`,
    'utf8',
  );
  return dir;
}


function createMemoryProvenanceStore(): AgentSkillProvenanceStore & { records: Record<string, AgentSkillProvenanceRecord> } {
  const records: Record<string, AgentSkillProvenanceRecord> = {};
  return {
    records,
    load: async () => JSON.parse(JSON.stringify(records)),
    save: async (file, record) => {
      if (record === null) {
        delete records[file];
      } else {
        records[file] = JSON.parse(JSON.stringify(record));
      }
    },
  };
}
