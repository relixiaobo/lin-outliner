import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentSkillRuntime,
  createSlashSkillPrompt,
  createUserSkillPrompt,
  parseNaturalLanguageSkillifyRequest,
  parseSkillSlashCommand,
  resolveBuiltInSkillResourceRoot,
  resolveSkillContentTarget,
  skillContentHash,
  type AgentSkillProvenanceRecord,
  type AgentSkillProvenanceStore,
} from '../../src/main/agentSkills';

const execFile = promisify(execFileCallback);

describe('resolveSkillContentTarget (single skill-path source of truth)', () => {
  const root = path.join(path.sep, 'work', 'project');

  test('recognizes the default project skills dir', () => {
    const target = resolveSkillContentTarget(
      path.join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
      { root, includeUserSkills: false, additionalSkillDirectories: [] },
    );
    expect(target).toMatchObject({ skillName: 'demo', source: 'project', isSkillFile: true });
  });

  test('recognizes a nested .agents/skills under root as project, even for a new dir', () => {
    const target = resolveSkillContentTarget(
      path.join(root, 'packages', 'a', '.agents', 'skills', 'nested', 'SKILL.md'),
      { root, includeUserSkills: false, additionalSkillDirectories: [] },
    );
    expect(target).toMatchObject({ skillName: 'nested', source: 'project', isSkillFile: true });
  });

  test('recognizes an additional dir OUTSIDE root (the closed governance hole)', () => {
    // The loader and file-tool gateway share this resolver so configured skill dirs
    // get the same validation, provenance, and hot-reload handling as defaults.
    const teamSkills = path.join(path.sep, 'home', 'x', 'team-skills');
    const target = resolveSkillContentTarget(
      path.join(teamSkills, 'shared', 'SKILL.md'),
      { root, includeUserSkills: false, additionalSkillDirectories: [teamSkills] },
    );
    expect(target).toMatchObject({ skillName: 'shared', source: 'user', isSkillFile: true });
  });

  test('returns null for a non-skill file', () => {
    expect(
      resolveSkillContentTarget(path.join(root, 'notes.txt'), {
        root,
        includeUserSkills: false,
        additionalSkillDirectories: [],
      }),
    ).toBeNull();
  });
});

describe('skill ratification provenance', () => {
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

  test('mutable skills are ratified by default while accepted hashes persist separately', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('authored', 'Follow the authored workflow.');
    const store = createMemoryProvenanceStore();

    const first = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await first.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await first.notifySkillContentWritten([skillFile]);
    expect((await first.getSkill('authored'))).toMatchObject({ ratified: true, accepted: false });

    // "Restart": a fresh runtime sharing the persisted store keeps the default-allow
    // ratification policy without manufacturing an acceptedHash record.
    const second = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    expect((await second.getSkill('authored'))).toMatchObject({ ratified: true, accepted: false });
    const invocation = await second.invokeSkill({ skill: 'authored', trigger: 'agent' });
    expect(invocation.ok).toBe(true);
    expect((await second.getSkill('authored'))).toMatchObject({ ratified: true, accepted: false });

    const third = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    expect((await third.getSkill('authored'))).toMatchObject({ ratified: true, accepted: false });
  });

  test('accepting a skill records exactly those bytes; an agent re-patch clears accepted state', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('accepted', 'Follow the accepted workflow.');
    const store = createMemoryProvenanceStore();

    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await runtime.notifySkillContentWritten([skillFile]);
    expect((await runtime.getSkill('accepted'))).toMatchObject({ ratified: true, accepted: false });

    // Accept carries the hash of the bytes the user saw; a mismatch is refused
    // (TOCTOU guard), the matching hash records acceptance.
    await expect(runtime.acceptSkill('accepted', 'not-the-displayed-hash')).rejects.toThrow('changed since it was displayed');
    await runtime.acceptSkill('accepted', skillContentHash(content));
    const accepted = await runtime.getSkill('accepted');
    expect(accepted?.ratified).toBe(true);
    expect(accepted?.accepted).toBe(true);
    const invocation = await runtime.invokeSkill({ skill: 'accepted', trigger: 'agent' });
    expect(invocation.ok).toBe(true);

    // Acceptance survives a restart through the same store.
    const restarted = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    expect((await restarted.getSkill('accepted'))?.ratified).toBe(true);

    // An agent re-patch records a fresh agentHash; the stale acceptedHash no longer
    // matches, so accepted state clears while default ratification remains true.
    const patched = skillMarkdown('Follow the patched workflow.');
    await writeFile(skillFile, patched, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(patched), { hash: skillContentHash(content), content });
    await runtime.notifySkillContentWritten([skillFile]);
    const afterPatch = await runtime.getSkill('accepted');
    expect(afterPatch?.ratified).toBe(true);
    expect(afterPatch?.accepted).toBe(false);
  });

  test('revoking acceptance clears accepted state without disabling the skill', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('revoked', 'Follow the revoked workflow.');
    const store = createMemoryProvenanceStore();

    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await runtime.notifySkillContentWritten([skillFile]);
    await runtime.acceptSkill('revoked', skillContentHash(content));
    expect((await runtime.getSkill('revoked'))?.ratified).toBe(true);

    await runtime.revokeSkillAcceptance('revoked');
    const revoked = await runtime.getSkill('revoked');
    expect(revoked?.ratified).toBe(true);
    expect(revoked?.accepted).toBe(false);
    const invocation = await runtime.invokeSkill({ skill: 'revoked', trigger: 'agent' });
    expect(invocation.ok).toBe(true);
    expect((await runtime.getSkill('revoked'))?.ratified).toBe(true);
  });

  test('undo restores the project original without self-ratifying; the slot is consumed', async () => {
    const { root, skillFile, content: original } = await writeAuthoredSkill('undone', 'The user-authored original.');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });

    // An agent edit over user-authored bytes: previous version carries no agentHash.
    const edited = skillMarkdown('The agent-edited replacement.');
    await writeFile(skillFile, edited, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(edited), { hash: skillContentHash(original), content: original });
    await runtime.notifySkillContentWritten([skillFile]);
    const afterEdit = await runtime.getSkill('undone');
    expect(afterEdit?.ratified).toBe(true);
    expect(afterEdit?.canUndoLastAgentEdit).toBe(true);

    await runtime.undoLastAgentSkillEdit('undone');
    const restored = await runtime.getSkill('undone');
    expect(restored?.body).toContain('The user-authored original.');
    expect(restored?.ratified).toBe(true);
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
    expect(afterHandEdit?.ratified).toBe(true);
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
    expect(restored?.ratified).toBe(true);
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

  test('a project hand-edit after acceptance clears accepted state but stays usable', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('hand-after-accept', 'Agent draft.');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await runtime.notifySkillContentWritten([skillFile]);
    await runtime.acceptSkill('hand-after-accept', skillContentHash(content));

    const handEdited = skillMarkdown('User tuned the accepted draft.');
    await writeFile(skillFile, handEdited, 'utf8');
    await runtime.notifySkillContentWritten([skillFile]);
    const skill = await runtime.getSkill('hand-after-accept');
    expect(skill?.ratified).toBe(true);
    expect(skill?.accepted).toBe(false);
  });

  test('user-source hand-edits keep the original self-ratification rule', async () => {
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
    expect((await runtime.getSkill('user-edited'))).toMatchObject({ ratified: true, accepted: false });

    const handEdited = skillMarkdown('User tuned the accepted draft.');
    await writeFile(skillFile, handEdited, 'utf8');
    await runtime.notifySkillContentWritten([skillFile]);
    const skill = await runtime.getSkill('user-edited');
    expect(skill?.source).toBe('user');
    expect(skill?.ratified).toBe(true);
    expect(skill?.accepted).toBe(false);
  });

  test('trust actions resolve paths:-conditional skills the panel lists', async () => {
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

    // Inactive conditional skills appear in the Skills panel (listAllSkills) with
    // default-allow trust derivation, while Accept still records an optional hash.
    const listed = (await runtime.listAllSkills()).find((skill) => skill.name === 'conditional');
    expect(listed?.ratified).toBe(true);
    await runtime.acceptSkill('conditional', skillContentHash(content));
    const accepted = (await runtime.listAllSkills()).find((skill) => skill.name === 'conditional');
    expect(accepted?.ratified).toBe(true);
    expect(accepted?.accepted).toBe(true);
  });

  test('refreshTrustRecords propagates a trust change made through another runtime', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('shared', 'Shared workflow.');
    const store = createMemoryProvenanceStore();
    const settingsRuntime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    const conversationRuntime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });

    await settingsRuntime.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await settingsRuntime.notifySkillContentWritten([skillFile]);
    expect((await conversationRuntime.getSkill('shared'))).toMatchObject({ ratified: true, accepted: false });

    // The conversationless Settings runtime accepts; the live conversation's own registry only
    // sees acceptedHash after a trust refresh (its in-memory snapshot is otherwise stale).
    await settingsRuntime.acceptSkill('shared', skillContentHash(content));
    expect((await conversationRuntime.getSkill('shared'))).toMatchObject({ ratified: true, accepted: false });
    await conversationRuntime.refreshTrustRecords();
    expect((await conversationRuntime.getSkill('shared'))).toMatchObject({ ratified: true, accepted: true });
  });

  test('undo back to an earlier agent version keeps default ratification', async () => {
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
    expect(restored?.ratified).toBe(true);
  });
});

describe('agent skills', () => {
  test('lists model-invocable skills once per conversation', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'when_to_use: Use for demo work',
      ],
      body: 'Follow demo instructions.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    await acceptSkillForTest(runtime, 'demo');

    const first = await runtime.buildSkillListingReminderText(200_000);
    const second = await runtime.buildSkillListingReminderText(200_000);

    expect(first).toContain('The following skills are available');
    expect(first).toContain('- demo: Demo skill - Use for demo work');
    expect(second).toBeNull();
  });

  test('can release reserved skill listings that were not sent', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Demo skill'],
      body: 'Follow demo instructions.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    await acceptSkillForTest(runtime, 'demo');

    const reserved = await runtime.reserveSkillListingReminderText(200_000);
    expect(reserved?.text).toContain('demo');
    expect(await runtime.buildSkillListingReminderText(200_000)).toBeNull();

    if (reserved) runtime.releaseSkillListingReservation(reserved);

    expect(await runtime.buildSkillListingReminderText(200_000)).toContain('demo');
  });

  test('parses YAML frontmatter block scalars and arrays', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: |',
        '  Demo skill',
        '  with wrapped text',
        'allowed-tools:',
        '  - Bash(git status:*)',
        '  - file_read',
        'paths:',
        '  - src/**',
        '  - docs/**/*.md',
      ],
      body: 'Follow demo instructions.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    await acceptSkillForTest(runtime, 'demo');

    await runtime.notifyFileTouched([path.join(root, 'src', 'file.ts')]);
    const skill = await runtime.getSkill('demo');
    const listing = runtime.drainSteeringMessages()
      .map((message) => message.content[0]?.type === 'text' ? message.content[0].text : '')
      .join('\n');

    expect(skill?.description).toBe('Demo skill with wrapped text');
    expect(skill?.allowedTools).toEqual(['Bash(git status:*)', 'file_read']);
    expect(skill?.paths).toEqual(['src/**', 'docs/**/*.md']);
    expect(listing).toContain('Demo skill');
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
    await acceptSkillForTest(runtime, 'demo');
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
    const messageText = invocation.message.content[0]?.type === 'text'
      ? invocation.message.content[0].text
      : '';
    expect(messageText).not.toContain('<skill-name>');
  });

  test('executes embedded shell blocks and inline commands during skill invocation', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'shell: bash',
      ],
      body: [
        'Before block.',
        '```!',
        'echo block',
        '```',
        'Inline !`echo inline` done.',
      ].join('\n'),
    });
    const calls: Array<{ skill: string; command: string; shell: string }> = [];
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      executeSkillShell: async ({ skill, command, shell }) => {
        calls.push({ skill: skill.name, command, shell });
        return command.includes('block') ? 'BLOCK_OUTPUT' : 'INLINE_OUTPUT';
      },
    });
    await acceptSkillForTest(runtime, 'demo');

    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.renderedContent).toContain('Before block.\nBLOCK_OUTPUT\nInline INLINE_OUTPUT done.');
    expect(calls).toEqual([
      { skill: 'demo', command: 'echo block', shell: 'bash' },
      { skill: 'demo', command: 'echo inline', shell: 'bash' },
    ]);
  });

  test('rejects unsupported skill shell frontmatter before recording invocation state', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'shell: powershell',
      ],
      body: 'Inline !`Write-Output nope`.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      executeSkillShell: async () => 'NOPE',
    });
    await acceptSkillForTest(runtime, 'demo');

    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(false);
    if (invocation.ok) return;
    expect(invocation.code).toBe('skill_shell_failed');
    expect(invocation.message).toContain('unsupported shell');
    expect(runtime.createInvokedSkillsReminder()).toBeNull();
  });

  test('supports composer slash adapter for user-invocable skills', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Demo skill'],
      body: 'Loaded by slash.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    expect(parseSkillSlashCommand('/demo arg one')).toEqual({ skill: 'demo', args: 'arg one' });
    const prompt = await createSlashSkillPrompt(runtime, '/demo arg one', '<turn-context>visible node</turn-context>');
    const text = prompt?.content[0]?.type === 'text' ? prompt.content[0].text : '';
    const reminderText = prompt?.content[1]?.type === 'text' ? prompt.content[1].text : '';

    expect(prompt).not.toBeNull();
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('<skill-name>demo</skill-name>');
    expect(text).toContain('Loaded by slash.');
    expect(reminderText).toContain('<turn-context>visible node</turn-context>');
  });

  test('ships skillify as a built-in model-invocable authoring workflow', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-skillify-'));
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    // Model-invocable: a conversational "save this as a skill" picks up the curated
    // skillify guidance instead of ad-hoc file writes.
    const automaticListing = await runtime.buildSkillListingReminderText(200_000);
    const skill = await runtime.getSkill('skillify');
    const prompt = await createSlashSkillPrompt(runtime, '/skillify turn this workflow into a reusable skill', null);

    expect(automaticListing).toContain('- skillify:');
    expect(skill).toMatchObject({
      name: 'skillify',
      source: 'built-in',
      modelInvocable: true,
      userInvocable: true,
      ratified: true,
    });
    const text = prompt?.content[0]?.type === 'text' ? prompt.content[0].text : '';
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

    await expect(createSlashSkillPrompt(runtime, '/skillify this workflow', null)).rejects.toThrow('currently disabled');
    expect(await createUserSkillPrompt(runtime, 'Save this workflow as a skill', null)).toBeNull();
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
    expect(body).toContain('Show the complete `SKILL.md`');
    expect(body).toContain('focused diff for updates');
    expect(body).toContain('ask_user_question');
    expect(body).toContain('Save, revise, or cancel choices');

    expect(body).toContain('Separate authoring tools from runtime tools');
    expect(body).toContain('Omit `allowed-tools` when the future workflow does not need preapproval');
    expect(body).toContain('Flag broad `allowed-tools` in the preview summary');
    expect(body).toContain('Default to `execution: inline`');
    expect(body).toContain('Use `execution: isolated` only for self-contained work');

    expect(body).toContain('available immediately');
    expect(body).toContain('slash invocation works immediately');
    expect(body).toContain('without a separate trust prompt');
    expect(body).toContain('Do not write executable or binary support files');
  });

  test('ships create-agent as a built-in restricted authoring workflow', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-create-agent-'));
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    const automaticListing = await runtime.buildSkillListingReminderText(200_000);
    const skill = await runtime.getSkill('create-agent');
    const prompt = await createSlashSkillPrompt(runtime, '/create-agent make a reviewer agent', null);

    expect(automaticListing).toContain('- create-agent:');
    expect(skill).toMatchObject({
      name: 'create-agent',
      source: 'built-in',
      modelInvocable: true,
      userInvocable: true,
      ratified: true,
    });
    const text = prompt?.content[0]?.type === 'text' ? prompt.content[0].text : '';
    expect(text).toContain('Create-agent workflow');
    expect(text).toContain('~/.agents/agents/<agent-name>/AGENT.md');
    expect(text).toContain('<workspace>/.agents/agents/<agent-name>/AGENT.md');
    expect(text).toContain('permission-mode: restricted');
    expect(text).toContain('For an existing agent, resolve and read the current `AGENT.md` first');
    expect(text).toContain('Prefer a focused `file_edit` patch');
    expect(text).toContain('Do not delete, move, rename, or create support files');
    expect(text).toContain('Use `file_write` or `file_edit` only after confirmation');
    expect(text).toContain('rejects support files/deletes/trusted permission mode');
    expect(text).not.toContain('.claude');
  });

  test('records built-in skill invocations without surfacing pseudo file paths', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const invocation = await runtime.invokeSkill({ skill: 'skillify', trigger: 'agent' });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.renderedContent).toContain('Skillify v2 workflow');
    expect(invocation.renderedContent).not.toContain('Base directory for this skill:');
    expect(invocation.renderedContent).not.toContain('built-in/skillify/SKILL.md');

    const reminder = runtime.createInvokedSkillsReminder();
    const text = reminder?.content[0]?.type === 'text' ? reminder.content[0].text : '';

    expect(text).toContain('### Skill: skillify');
    expect(text).toContain('Path: built-in:skillify');
    expect(text).not.toContain('built-in/skillify/SKILL.md');
  });

  test('persists built-in skill listing state without pseudo file paths', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });

    expect(await runtime.buildSkillListingReminderText(200_000)).toContain('- skillify:');
    const reminder = runtime.createSkillListingStateReminder();
    const text = reminder?.content[0]?.type === 'text' ? reminder.content[0].text : '';

    expect(text).toContain('- skillify [skill-file: built-in:skillify]');
    expect(text).not.toContain('built-in/skillify/SKILL.md');
  });

  test('ships goal-oriented resource-backed built-in skills', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const listing = await runtime.buildSkillListingReminderText(200_000);
    const expected = ['presentation', 'document', 'data-analysis'];

    for (const name of expected) {
      const skill = await runtime.getSkill(name);
      expect(skill).toMatchObject({
        name,
        source: 'built-in',
        modelInvocable: true,
        userInvocable: true,
        ratified: true,
        accepted: false,
        canUndoLastAgentEdit: false,
        allowedTools: [],
      });
      expect(skill?.rootDir).toContain(path.join('src', 'main', 'builtInSkills', name));
      expect(skill?.skillFile).toBe(path.join(skill?.rootDir ?? '', 'SKILL.md'));
      expect(typeof skill?.contentHash).toBe('string');
      expect(listing).toContain(`- ${name}:`);

      const invocation = await runtime.invokeSkill({ skill: name, trigger: 'agent' });
      expect(invocation.ok).toBe(true);
      if (!invocation.ok || !skill) continue;
      expect(invocation.renderedContent).toContain(`Base directory for this skill: ${skill.rootDir}`);
      expect(invocation.renderedContent).not.toContain('${AGENT_SKILL_DIR}');
      expect(invocation.renderedContent).toContain('portable baseline tools');
    }
  });

  test('loads bundled built-in skills with real resource directories', async () => {
    const { skillsDir, skillDir } = await createBundledBuiltInSkillFixture('bundled-demo', {
      frontmatter: [
        'description: Bundled demo skill',
        'when_to_use: Use for bundled resource tests',
        'allowed-tools: file_read',
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
    const listing = await runtime.buildSkillListingReminderText(200_000);
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
      ratified: true,
      accepted: false,
      canUndoLastAgentEdit: false,
      allowedTools: ['file_read'],
    });
    expect(typeof skill?.contentHash).toBe('string');
    expect(listing).toContain('- bundled-demo: Bundled demo skill - Use for bundled resource tests');
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.renderedContent).toContain(`Base directory for this skill: ${skillDir}`);
    expect(invocation.renderedContent).toContain(`Read ${skillDir}/references/details.md for deck.md.`);
    expect(await runtime.getActiveSkillReadRoots()).toEqual([skillDir]);

    const reminder = runtime.createInvokedSkillsReminder();
    const reminderText = reminder?.content[0]?.type === 'text' ? reminder.content[0].text : '';
    expect(reminderText).toContain('### Skill: bundled-demo');
    expect(reminderText).toContain('Path: built-in:bundled-demo');
    expect(reminderText).toContain(`Base directory for this skill: ${skillDir}`);
    expect(reminderText).not.toContain(path.join(skillDir, 'SKILL.md'));
  });

  test('restores resource-backed built-in skill identity from loaded messages', async () => {
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
    restored.restoreInvokedSkillsFromMessages([invocation.message]);
    const reminder = restored.createInvokedSkillsReminder();
    const reminderText = reminder?.content[0]?.type === 'text' ? reminder.content[0].text : '';

    expect(reminderText).toContain('Path: built-in:bundled-demo');
    expect(reminderText).toContain(`Base directory for this skill: ${skillDir}`);
    expect(await restored.getActiveSkillReadRoots()).toEqual([skillDir]);
    expect(reminderText).not.toContain(`Path: ${skillDir}`);
  });

  test('does not resolve bundled built-in files as writable skill targets', async () => {
    const { skillsDir, skillDir } = await createBundledBuiltInSkillFixture('bundled-demo', {
      frontmatter: ['description: Bundled demo skill'],
      body: 'Use bundled instructions.',
    });

    expect(
      resolveSkillContentTarget(path.join(skillDir, 'SKILL.md'), {
        root: path.dirname(path.dirname(skillDir)),
        includeUserSkills: false,
        additionalSkillDirectories: [],
        builtInSkillDirectories: [skillsDir],
      }),
    ).toBeNull();
  });

  test('keeps built-in resource directories immutable even if also configured as additional skill dirs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-root-'));
    const { skillsDir, skillDir } = await createBundledBuiltInSkillFixture('bundled-demo', {
      frontmatter: ['description: Bundled demo skill'],
      body: 'Use bundled instructions.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      builtInSkillDirectories: [skillsDir],
      additionalSkillDirectories: [skillsDir],
    });

    expect(runtime.resolveSkillTarget(path.join(skillDir, 'SKILL.md'))).toBeNull();
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
    const listing = await runtime.buildSkillListingReminderText(200_000);

    expect(skill).toMatchObject({
      name: 'floor-skill',
      source: 'built-in',
    });
    expect(skill?.body).toContain('Use bundled instructions.');
    expect(listing).toContain('Bundled floor skill');
    expect(listing).not.toContain('Mutable shadow skill');
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
    const listing = await runtime.buildSkillListingReminderText(200_000);

    expect(skill).toMatchObject({
      name: 'path-built-in',
      source: 'built-in',
      paths: ['docs/**/*.md'],
    });
    expect(listing).toContain('path-built-in');
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
    await expect(runtime.buildSkillListingReminderText(200_000)).rejects.toThrow('Duplicate built-in skill "skillify"');
  });

  test('shares the first skill load across concurrent callers', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    const results = await Promise.allSettled([
      runtime.getSkill('skillify'),
      runtime.getSkill('research'),
      runtime.listAllSkills(),
      runtime.buildSkillListingReminderText(200_000),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { name: 'skillify', source: 'built-in' } });
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { name: 'research', source: 'built-in' } });
    const allSkills = results[2].status === 'fulfilled' ? results[2].value : [];
    expect(allSkills.map((skill) => skill.name).sort()).toEqual(['create-agent', 'data-analysis', 'document', 'presentation', 'research', 'skillify']);
  });

  test('resolves bundled built-in resource roots for dev and packaged modes', () => {
    const repoRoot = path.join(path.sep, 'repo');
    const moduleDir = path.join(repoRoot, 'out', 'main');
    const resourcesPath = path.join(path.sep, 'Applications', 'Tenon.app', 'Contents', 'Resources');

    expect(resolveBuiltInSkillResourceRoot({ isPackaged: false, moduleDir }))
      .toBe(path.join(repoRoot, 'src', 'main', 'builtInSkills'));
    expect(resolveBuiltInSkillResourceRoot({ isPackaged: true, resourcesPath }))
      .toBe(path.join(resourcesPath, 'built-in-skills'));
  });

  test('ships research as a built-in read-only isolated skill', async () => {
    const runtime = new AgentSkillRuntime({
      includeUserSkills: false,
      executeIsolatedSkill: async ({ skill, renderedContent, readOnlyIsolated }) => ({
        agentId: 'research-child',
        agentType: skill.agent ?? 'fork',
        status: readOnlyIsolated ? 'completed' : 'failed',
        result: renderedContent,
      }),
    });

    const automaticListing = await runtime.buildSkillListingReminderText(200_000);
    const skill = await runtime.getSkill('research');

    expect(automaticListing).toContain('- research:');
    expect(skill).toMatchObject({
      name: 'research',
      source: 'built-in',
      execution: 'isolated',
      modelInvocable: true,
      userInvocable: true,
      ratified: true,
      argumentHint: '<question or area to research>',
      argumentNames: ['question'],
    });
    expect(skill?.allowedTools).toEqual([
      'node_search',
      'node_read',
      'file_read',
      'file_glob',
      'file_grep',
      'web_search',
      'web_fetch',
      'recall',
    ]);
    expect(skill?.body).toContain('codebase research specialist');
    expect(skill?.body).toContain('READ-ONLY MODE - NO MODIFICATIONS');
    expect(skill?.body).toContain('file_glob for broad file pattern matching');
    expect(skill?.body).toContain('file_grep for content and regex search');
    expect(skill?.body).toContain('Adapt thoroughness to the caller');
    expect(skill?.body).toContain('issue them in parallel');

    const invocation = await runtime.invokeSkill({
      skill: 'research',
      args: 'map the current spec',
      trigger: 'agent',
    });
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.execution).toBe('isolated');
    expect(invocation.isolated?.status).toBe('completed');
  });

  test('disabled skill gates apply to built-in research', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    runtime.updateDisabledSkills(['research']);

    expect(await runtime.buildSkillListingReminderText(200_000)).not.toContain('- research:');
    const invocation = await runtime.invokeSkill({ skill: 'research', trigger: 'agent' });

    expect(invocation.ok).toBe(false);
    if (invocation.ok) return;
    expect(invocation.code).toBe('skill_disabled');
  });

  test('records model and effort effects for slash and agent-invoked skills', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'model: openai/gpt-5.2',
        'effort: high',
      ],
      body: 'Use a stronger model.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    await acceptSkillForTest(runtime, 'demo');

    await createSlashSkillPrompt(runtime, '/demo');
    expect(runtime.consumePendingTurnEffect()).toEqual({
      skill: 'demo',
      model: 'openai/gpt-5.2',
      effort: 'high',
    });

    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    expect(runtime.consumePendingTurnEffect()).toEqual({
      skill: 'demo',
      model: 'openai/gpt-5.2',
      effort: 'high',
    });
    expect(runtime.consumePendingTurnEffect()).toBeNull();
  });

  test('records allowed-tools as active run permission rules', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'allowed-tools: Bash(git diff:*), file_read',
      ],
      body: 'Use preapproved tools.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    await acceptSkillForTest(runtime, 'demo');

    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    expect(runtime.getActivePermissionRules()).toEqual(['Bash(git diff:*)', 'file_read']);
    runtime.resetRunPermissionRules();
    expect(runtime.getActivePermissionRules()).toEqual([]);
  });

  test('scopes active permission rules by run when a scope provider is configured', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'allowed-tools: Bash(git diff:*), file_read',
      ],
      body: 'Use preapproved tools.',
    });
    let scope: string | null = 'run-a';
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      permissionScopeProvider: () => scope,
    });
    await acceptSkillForTest(runtime, 'demo');

    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    expect(runtime.getActivePermissionRules()).toEqual(['Bash(git diff:*)', 'file_read']);
    scope = 'run-b';
    expect(runtime.getActivePermissionRules()).toEqual([]);
    scope = 'run-a';
    runtime.resetRunPermissionRules('run-a');
    expect(runtime.getActivePermissionRules()).toEqual([]);
  });

  test('lists isolated-execution skills and routes them through an isolated executor', async () => {
    const root = await createSkillFixture('isolated', {
      frontmatter: [
        'description: Isolated skill',
        'execution: isolated',
        'agent: specialist',
        'model: gpt-5.2',
        'effort: high',
        'allowed-tools: Bash(git status:*)',
      ],
      body: 'Requires isolated execution for $ARGUMENTS.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      executeIsolatedSkill: async ({ skill, renderedContent }) => ({
        agentId: 'child-run-test',
        agentType: skill.agent ?? 'isolated',
        status: 'completed',
        result: `isolated result: ${renderedContent}`,
      }),
    });
    await acceptSkillForTest(runtime, 'isolated');

    expect(await runtime.buildSkillListingReminderText(200_000)).toContain('- isolated: Isolated skill');
    const invocation = await runtime.invokeSkill({
      skill: 'isolated',
      args: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.execution).toBe('isolated');
    expect(invocation.isolated?.agentId).toBe('child-run-test');
    expect(invocation.renderedContent).toContain('Requires isolated execution for demo.');
    expect(runtime.getActivePermissionRules()).toEqual([]);
    expect(runtime.consumePendingTurnEffect()).toBeNull();
    const messageText = invocation.message.content[0]?.type === 'text'
      ? invocation.message.content[0].text
      : '';
    expect(messageText).toContain('isolated result:');
  });

  test('maps legacy context-fork skills to isolated execution', async () => {
    const root = await createSkillFixture('forked', {
      frontmatter: [
        'description: Legacy fork skill',
        'context: fork',
      ],
      body: 'Requires isolated execution.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      executeIsolatedSkill: async ({ skill, renderedContent }) => ({
        agentId: 'child-run-test',
        agentType: skill.agent ?? 'general',
        status: 'completed',
        result: renderedContent,
      }),
    });
    await acceptSkillForTest(runtime, 'forked');

    const skill = await runtime.getSkill('forked');
    expect(skill?.execution).toBe('isolated');
    const invocation = await runtime.invokeSkill({ skill: 'forked', trigger: 'agent' });
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.execution).toBe('isolated');
  });

  test('does not restore slash isolated skill results as reusable skill guidance', async () => {
    const root = await createSkillFixture('isolated', {
      frontmatter: [
        'description: Isolated skill',
        'execution: isolated',
      ],
      body: 'Requires isolated execution.',
    });
    const runtime = new AgentSkillRuntime({
      localRoot: root,
      includeUserSkills: false,
      executeIsolatedSkill: async ({ skill }) => ({
        agentId: 'child-run-test',
        agentType: skill.agent ?? 'general',
        status: 'completed',
        result: 'one-shot isolated result',
      }),
    });
    await acceptSkillForTest(runtime, 'isolated');

    const prompt = await createSlashSkillPrompt(runtime, '/isolated demo', null);
    const restored = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    if (prompt) restored.restoreInvokedSkillsFromMessages([prompt]);

    expect(restored.createInvokedSkillsReminder()).toBeNull();
  });

  test('rejects isolated-execution skills when no isolated executor is available', async () => {
    const root = await createSkillFixture('isolated', {
      frontmatter: [
        'description: Isolated skill',
        'execution: isolated',
      ],
      body: 'Requires isolated execution.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    await acceptSkillForTest(runtime, 'isolated');

    const invocation = await runtime.invokeSkill({ skill: 'isolated', trigger: 'agent' });

    expect(invocation.ok).toBe(false);
    if (invocation.ok) return;
    expect(invocation.code).toBe('isolated_execution_not_supported');
  });

  test('skips skills with invalid execution frontmatter instead of loading them inline', async () => {
    const root = await createSkillFixture('bad-execution', {
      frontmatter: [
        'description: Invalid execution skill',
        'execution: fork',
      ],
      body: 'This must not load inline.',
    });
    await createSkillInRoot(root, 'good-skill', {
      frontmatter: [
        'description: Good skill',
        'execution: Isolated',
      ],
      body: 'This should load isolated.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    expect(await runtime.getSkill('bad-execution')).toBeNull();
    expect((await runtime.getSkill('good-skill'))?.execution).toBe('isolated');
    const invocation = await runtime.invokeSkill({ skill: 'bad-execution', trigger: 'agent' });
    expect(invocation).toMatchObject({ ok: false, code: 'unknown_skill' });
  });

  test('restores invoked skills from post-compact reminders', async () => {
    const runtime = new AgentSkillRuntime({ includeUserSkills: false });
    runtime.restoreInvokedSkillsFromMessages([{
      role: 'user',
      timestamp: 1,
      content: [{
        type: 'text',
        text: [
          '<system-reminder>',
          'The following skills were invoked in this session. Continue to follow these guidelines:',
          '',
          '### Skill: demo',
          'Path: project:demo',
          '',
          'Base directory for this skill: /tmp/demo',
          '',
          'Follow demo instructions.',
          '</system-reminder>',
        ].join('\n'),
      }],
    }]);

    const reminder = runtime.createInvokedSkillsReminder();
    const text = reminder?.content[0]?.type === 'text' ? reminder.content[0].text : '';

    expect(text).toContain('### Skill: demo');
    expect(text).toContain('Follow demo instructions.');
    expect(await runtime.getActiveSkillReadRoots()).toEqual([]);
  });

  test('persists listed skill names across compact restore without relisting them', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Demo skill'],
      body: 'Follow demo instructions.',
    });
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await acceptSkillForTest(runtime, 'demo');

    expect(await runtime.buildSkillListingReminderText(200_000)).toContain('demo');
    const listingState = runtime.createSkillListingStateReminder();
    const restored = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    restored.restoreInvokedSkillsFromMessages([listingState!]);

    expect(await restored.buildSkillListingReminderText(200_000)).toBeNull();
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

    const listing = await runtime.buildSkillListingReminderText(200_000);
    expect(listing).toContain('external-demo');
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
    const listing = await runtime.buildSkillListingReminderText(200_000);

    expect(skill).toMatchObject({
      name: 'floor-skill',
      source: 'built-in',
      skillFile: 'built-in/floor-skill/SKILL.md',
    });
    expect(skill?.body).toBe('Use built-in instructions.');
    expect(listing).toContain('Built-in floor skill');
    expect(listing).not.toContain('Mutable shadow skill');
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
    await acceptSkillForTest(runtime, 'demo');

    const projectListing = await runtime.buildSkillListingReminderText(200_000);
    runtime.updateAdditionalSkillDirectories([extraDir]);
    const externalListing = await runtime.buildSkillListingReminderText(200_000);

    expect(projectListing).toContain('Project demo skill');
    expect(externalListing).toContain('External demo skill');
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
    await acceptSkillForTest(runtime, 'demo');

    const listing = await runtime.buildSkillListingReminderText(200_000);

    expect(listing).toContain('demo');
    expect(listing).not.toContain('alias');
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
    await acceptSkillForTest(runtime, 'typescript-review');

    // Drain the initial listing (built-in skillify) so only activation remains.
    expect(await runtime.buildSkillListingReminderText(200_000)).not.toContain('typescript-review');
    await runtime.notifyFileTouched([path.join(root, 'src', 'main.ts')]);
    const [message] = runtime.drainSteeringMessages();
    const text = message?.content[0]?.type === 'text' ? message.content[0].text : '';

    expect(text).toContain('typescript-review');
    expect(await runtime.buildSkillListingReminderText(200_000)).toBeNull();
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
    await acceptSkillForTest(runtime, 'src-directory');
    await acceptSkillForTest(runtime, 'src-globstar');

    // Drain the initial listing (built-in skillify) so only activation remains.
    expect(await runtime.buildSkillListingReminderText(200_000)).not.toContain('src-directory');
    await runtime.notifyFileTouched([path.join(root, 'src')]);
    const [directoryMessage] = runtime.drainSteeringMessages();
    const directoryText = directoryMessage?.content[0]?.type === 'text' ? directoryMessage.content[0].text : '';

    expect(directoryText).toContain('src-directory');
    expect(directoryText).toContain('src-globstar');

    await runtime.notifyFileTouched([path.join(root, 'src', 'app', 'main.ts')]);
    expect(runtime.drainSteeringMessages()).toEqual([]);
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

    expect(runtime.drainSteeringMessages()).toEqual([]);
  });

  test('discovers dynamic skill directories created after an earlier miss', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skills-dynamic-miss-'));
    const nestedSkillsDir = path.join(root, 'packages', 'app', '.agents', 'skills');
    const touchedFile = path.join(root, 'packages', 'app', 'src', 'main.ts');
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    await runtime.notifyFileTouched([touchedFile]);
    expect(runtime.drainSteeringMessages()).toEqual([]);
    expect(await runtime.buildSkillListingReminderText(200_000)).not.toContain('late-dynamic');

    await createSkillInRoot(root, 'late-dynamic', {
      frontmatter: ['description: Late dynamic skill'],
      body: 'Use late dynamic instructions.',
    }, nestedSkillsDir);
    await runtime.notifyFileTouched([touchedFile]);
    const [message] = runtime.drainSteeringMessages();
    const text = message?.content[0]?.type === 'text' ? message.content[0].text : '';

    expect((await runtime.getSkill('late-dynamic'))?.ratified).toBe(true);
    expect(text).toContain('late-dynamic');
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

async function acceptSkillForTest(runtime: AgentSkillRuntime, name: string): Promise<void> {
  const skill = (await runtime.listAllSkills()).find((candidate) => candidate.name === name);
  if (!skill?.contentHash) throw new Error(`Missing test skill hash for ${name}`);
  await runtime.acceptSkill(name, skill.contentHash);
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
