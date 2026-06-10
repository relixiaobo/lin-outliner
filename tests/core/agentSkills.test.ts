import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentSkillRuntime,
  createSlashSkillPrompt,
  parseSkillSlashCommand,
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
    // Before convergence this path bypassed agent.skill.write classification entirely
    // because the detector hardcoded .agents/skills paths and ignored configured dirs.
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
      'description: Agent-authored skill awaiting acceptance',
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

  test('ratification survives a restart through the provenance store', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('authored', 'Follow the authored workflow.');
    const store = createMemoryProvenanceStore();

    const first = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await first.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await first.notifySkillContentWritten([skillFile]);
    expect((await first.getSkill('authored'))?.ratified).toBe(false);

    // "Restart": a fresh runtime sharing only the persisted store still gates it.
    const second = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    expect((await second.getSkill('authored'))?.ratified).toBe(false);
    const invocation = await second.invokeSkill({ skill: 'authored', trigger: 'agent' });
    expect(invocation.ok).toBe(false);

    // Without the store (record lost), the gate fails open to ratified.
    const third = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
    expect((await third.getSkill('authored'))?.ratified).toBe(true);
  });

  test('accepting a skill ratifies exactly those bytes; an agent re-patch drops it back', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('accepted', 'Follow the accepted workflow.');
    const store = createMemoryProvenanceStore();

    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await runtime.notifySkillContentWritten([skillFile]);
    expect((await runtime.getSkill('accepted'))?.ratified).toBe(false);

    await runtime.acceptSkill('accepted');
    const accepted = await runtime.getSkill('accepted');
    expect(accepted?.ratified).toBe(true);
    expect(accepted?.accepted).toBe(true);
    const invocation = await runtime.invokeSkill({ skill: 'accepted', trigger: 'agent' });
    expect(invocation.ok).toBe(true);

    // Acceptance survives a restart through the same store.
    const restarted = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    expect((await restarted.getSkill('accepted'))?.ratified).toBe(true);

    // An agent re-patch records a fresh agentHash; the stale acceptedHash no longer
    // matches, so the skill drops back to unratified with no state machine involved.
    const patched = skillMarkdown('Follow the patched workflow.');
    await writeFile(skillFile, patched, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(patched), { hash: skillContentHash(content), content });
    await runtime.notifySkillContentWritten([skillFile]);
    const afterPatch = await runtime.getSkill('accepted');
    expect(afterPatch?.ratified).toBe(false);
    expect(afterPatch?.accepted).toBe(false);
  });

  test('revoking acceptance returns the skill to unratified', async () => {
    const { root, skillFile, content } = await writeAuthoredSkill('revoked', 'Follow the revoked workflow.');
    const store = createMemoryProvenanceStore();

    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(content));
    await runtime.notifySkillContentWritten([skillFile]);
    await runtime.acceptSkill('revoked');
    expect((await runtime.getSkill('revoked'))?.ratified).toBe(true);

    await runtime.revokeSkillAcceptance('revoked');
    const revoked = await runtime.getSkill('revoked');
    expect(revoked?.ratified).toBe(false);
    expect(revoked?.accepted).toBe(false);
    const invocation = await runtime.invokeSkill({ skill: 'revoked', trigger: 'agent' });
    expect(invocation.ok).toBe(false);
  });

  test('undo restores the user original and self-ratifies; the slot is consumed', async () => {
    const { root, skillFile, content: original } = await writeAuthoredSkill('undone', 'The user-authored original.');
    const store = createMemoryProvenanceStore();
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false, provenanceStore: store });

    // An agent edit over user-authored bytes: previous version carries no agentHash.
    const edited = skillMarkdown('The agent-edited replacement.');
    await writeFile(skillFile, edited, 'utf8');
    await runtime.recordAgentSkillWrite(skillFile, skillContentHash(edited), { hash: skillContentHash(original), content: original });
    await runtime.notifySkillContentWritten([skillFile]);
    const afterEdit = await runtime.getSkill('undone');
    expect(afterEdit?.ratified).toBe(false);
    expect(afterEdit?.canUndoLastAgentEdit).toBe(true);

    await runtime.undoLastAgentSkillEdit('undone');
    const restored = await runtime.getSkill('undone');
    expect(restored?.body).toContain('The user-authored original.');
    // Restored bytes are human-produced -> ratification re-derives to true.
    expect(restored?.ratified).toBe(true);
    expect(restored?.canUndoLastAgentEdit).toBe(false);
    await expect(runtime.undoLastAgentSkillEdit('undone')).rejects.toThrow('no recorded previous version');
  });

  test('undo back to an earlier agent version re-derives unratified', async () => {
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
    // v1 was itself agent-written, so the restored skill is unratified again.
    expect(restored?.ratified).toBe(false);
  });
});

describe('agent skills', () => {
  test('lists model-invocable skills once per session', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: [
        'description: Demo skill',
        'when_to_use: Use for demo work',
      ],
      body: 'Follow demo instructions.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

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
    // skillify guidance instead of ad-hoc file writes. The written skill is still
    // born unratified, so this widens discovery, not trust.
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
    expect(text).toContain('Skill authoring workflow');
    expect(text).toContain('start unratified');
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

    const invocation = await runtime.invokeSkill({
      skill: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    expect(runtime.getActivePermissionRules()).toEqual(['Bash(git diff:*)', 'file_read']);
    runtime.resetRunPermissionRules();
    expect(runtime.getActivePermissionRules()).toEqual([]);
  });

  test('lists fork-context skills and routes them through a fork executor', async () => {
    const root = await createSkillFixture('forked', {
      frontmatter: [
        'description: Forked skill',
        'context: fork',
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
      executeForkedSkill: async ({ skill, renderedContent }) => ({
        agentId: 'subagent-test',
        subagentType: skill.agent ?? 'general',
        status: 'completed',
        result: `fork result: ${renderedContent}`,
      }),
    });

    expect(await runtime.buildSkillListingReminderText(200_000)).toContain('- forked: Forked skill');
    const invocation = await runtime.invokeSkill({
      skill: 'forked',
      args: 'demo',
      trigger: 'agent',
    });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.execution).toBe('fork');
    expect(invocation.forked?.agentId).toBe('subagent-test');
    expect(invocation.renderedContent).toContain('Requires isolated execution for demo.');
    expect(runtime.getActivePermissionRules()).toEqual([]);
    expect(runtime.consumePendingTurnEffect()).toBeNull();
    const messageText = invocation.message.content[0]?.type === 'text'
      ? invocation.message.content[0].text
      : '';
    expect(messageText).toContain('fork result:');
  });

  test('rejects fork-context skills when no fork executor is available', async () => {
    const root = await createSkillFixture('forked', {
      frontmatter: [
        'description: Forked skill',
        'context: fork',
      ],
      body: 'Requires isolated execution.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    const invocation = await runtime.invokeSkill({ skill: 'forked', trigger: 'agent' });

    expect(invocation.ok).toBe(false);
    if (invocation.ok) return;
    expect(invocation.code).toBe('fork_not_supported');
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
  });

  test('persists listed skill names across compact restore without relisting them', async () => {
    const root = await createSkillFixture('demo', {
      frontmatter: ['description: Demo skill'],
      body: 'Follow demo instructions.',
    });
    const runtime = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });

    expect(await runtime.buildSkillListingReminderText(200_000)).toContain('demo');
    const listingState = runtime.createSkillListingStateReminder();
    const restored = new AgentSkillRuntime({ localRoot: root, includeUserSkills: false });
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

    await createSkillInRoot(root, 'late-dynamic', {
      frontmatter: ['description: Late dynamic skill'],
      body: 'Use late dynamic instructions.',
    }, nestedSkillsDir);
    await runtime.notifyFileTouched([touchedFile]);
    const [message] = runtime.drainSteeringMessages();
    const text = message?.content[0]?.type === 'text' ? message.content[0].text : '';

    expect(text).toContain('late-dynamic');
  });
});

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
