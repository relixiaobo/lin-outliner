import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skillLifecycleFixture } from '../fixtures/skillLifecycle';
import { AgentToolFailure } from '../../src/main/agent/AgentToolFailure';
import { createLocalTools } from '../../src/main/agent/capabilities/agentLocalTools';
import { AgentSkillRuntime, skillContentHash, skillLifecycleIdentity } from '../../src/main/agent/capabilities/agentSkills';
import { acquireSkillWriteGuard } from '../../src/main/agent/capabilities/agentSkillWriteGuard';
import { SKILL_INSPECT_SCHEMA, SKILL_MANAGE_SCHEMA } from '../../src/core/agent/skillOperations';
import { compileToolParameters } from '../../src/main/agent/runtime/kernel/exactToolArguments';
import { evaluateAgentToolCapability } from '../../src/main/agent/capabilities/agentCapabilities';

const fixtures: Awaited<ReturnType<typeof skillLifecycleFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture(review?: Parameters<typeof skillLifecycleFixture>[0]) {
  const result = await skillLifecycleFixture(review); fixtures.push(result); return result;
}
function target(skill: any) { return { skillId: skill.skillId, expectedRevision: skill.revision, expectedActiveHash: skill.contentHash }; }
async function discover(f: Awaited<ReturnType<typeof fixture>>) {
  const found = await f.inspect({ operation: 'discover', sourceUrl: 'https://github.com/public/skills' });
  return { operation: 'install', discoveryId: found.discoveryId, candidateId: found.candidates[0].id, expectedCommit: found.commit };
}

describe('shared Skill lifecycle', () => {
  test('completes acquisition, update, rollback and removal without writing configuration', async () => {
    const reviews: string[] = [];
    const f = await fixture(async ({ review }) => { reviews.push(review.kind); return true; });
    const installed = await f.manage(await discover(f));
    expect(installed.committed).toBe(true);
    expect(installed.observed.available).toBe(false);
    expect(installed.version).not.toHaveProperty('enabled');
    f.github.version = 2;
    expect((await f.inspect({ operation: 'check_updates' })).updates).toHaveLength(1);
    const preview = await f.inspect({ operation: 'preview_update', ...target(installed.version) });
    const updated = await f.manage({ operation: 'apply_update', ...target(installed.version),
      previewId: preview.previewId, expectedCandidateHash: preview.candidateHash });
    expect(updated.version.contentHash).not.toBe(installed.version.contentHash);
    const restored = await f.manage({ operation: 'rollback', ...target(updated.version), expectedPreviousHash: installed.version.contentHash });
    expect(restored.version.contentHash).toBe(installed.version.contentHash);
    await f.manage({ operation: 'uninstall', ...target(restored.version) });
    expect(await f.service.list()).toEqual([]);
    const reinstalled = await f.manage(await discover(f));
    expect(reinstalled.observed.available).toBe(false);
    expect(await readFile(f.config, 'utf8')).toBe(f.originalConfig);
    expect(reviews).toEqual(['install', 'update', 'rollback', 'uninstall', 'install']);
  });

  test('rejects cancellation, changed authority, and same-hash reinstalls after review', async () => {
    let allowReview = false;
    let duringReview = async () => {};
    const f = await fixture(async () => { await duringReview(); return allowReview; });
    await expect(f.manage(await discover(f))).rejects.toMatchObject({ code: 'cancelled' });
    expect(await f.service.list()).toEqual([]);
    allowReview = true;
    let permitted = true;
    duringReview = async () => { permitted = false; };
    const authorize = async () => { if (!permitted) throw new AgentToolFailure('operation_unavailable', 'Blocked', 'Stop.'); };
    await expect(f.manage(await discover(f), { authorize })).rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(await f.service.list()).toEqual([]);
    duringReview = async () => {};
    const installed = await f.manage(await discover(f));
    await f.manage({ operation: 'uninstall', ...target(installed.version) });
    const reinstalled = await f.manage(await discover(f));
    expect(reinstalled.version.contentHash).toBe(installed.version.contentHash);
    expect(reinstalled.version.revision).not.toBe(installed.version.revision);
    await expect(f.manage({ operation: 'uninstall', ...target(installed.version) })).rejects.toMatchObject({ code: 'stale_skill_version' });
  });

  test('binds bounded cursors to the caller view and snapshot', async () => {
    const f = await fixture();
    for (const name of ['one', 'two', 'three']) {
      const directory = join(f.workspace, '.agents', 'skills', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'SKILL.md'), `---\ndescription: ${name} fixture\n---\nInstructions.`);
    }
    await f.runtime.notifySkillContentWritten([]);
    const first = await f.inspect({ operation: 'list', limit: 1 });
    expect(first.items).toHaveLength(1);
    expect((await f.inspect({ operation: 'list', limit: 1, cursor: first.nextCursor })).items).toHaveLength(1);
    await expect(f.inspect({ operation: 'list', cursor: first.nextCursor }, { key: 'other-view' })).rejects.toMatchObject({ code: 'stale_cursor' });
    f.runtime.updateDisabledSkills(['one']);
    await expect(f.inspect({ operation: 'list', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'stale_cursor' });
    await expect(f.inspect({ operation: 'list', limit: 51 })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('undo restores only a hash-bound Agent definition edit through the file writer', async () => {
    const f = await fixture();
    const directory = join(f.workspace, '.agents', 'skills', 'editable');
    const file = join(directory, 'SKILL.md');
    await mkdir(directory, { recursive: true });
    const original = '---\ndescription: Editable fixture\n---\nOriginal instructions.\n';
    await writeFile(file, original);
    const tools = createLocalTools({ localFileRoot: f.workspace, skillRuntime: f.runtime });
    await tools.find((tool) => tool.name === 'file_read')!.execute('read', { file_path: file });
    const written = await tools.find((tool) => tool.name === 'file_edit')!.execute('edit', {
      file_path: file, old_string: 'Original', new_string: 'Agent-updated',
    });
    expect(written.details.ok).toBe(true);
    const identity = skillLifecycleIdentity((await f.runtime.getSkill('editable'))!);
    const inspection = await f.inspect({ operation: 'inspect', identity });
    expect(inspection.undo).not.toBeNull();
    await f.manage({ operation: 'undo_edit', ...inspection.undo });
    expect(await readFile(file, 'utf8')).toBe(original);
    await expect(f.manage({ operation: 'undo_edit', ...inspection.undo })).rejects.toMatchObject({ code: 'undo_unavailable' });
  });

  test('accepts only strict operation variants and derives network blocks by operation', () => {
    const inspect = compileToolParameters(SKILL_INSPECT_SCHEMA as never);
    const manage = compileToolParameters(SKILL_MANAGE_SCHEMA as never);
    expect(inspect.Check({ request: { operation: 'list' } })).toBe(true);
    expect(inspect.Check({ request: { operation: 'discover', catalogId: 'demo', sourceUrl: 'https://github.com/public/skills' } })).toBe(false);
    expect(manage.Check({ request: { operation: 'uninstall', skillId: 'demo', expectedRevision: 'revision', expectedActiveHash: 'a'.repeat(64), approved: true } })).toBe(false);
    const evaluate = (operation: string) => evaluateAgentToolCapability({ toolName: 'skill_inspect', args: { request: { operation } },
      policy: { capabilityConfig: { blocks: ['Action(web.fetch)'] } } });
    expect(evaluate('list').behavior).toBe('allow');
    expect(evaluate('discover').behavior).toBe('unavailable');
  });

  test('a committed install reports refresh failure without replaying or reverting the installation', async () => {
    const f = await fixture();
    const failure = spyOn(f.runtime, 'notifySkillContentWritten').mockRejectedValue(new Error('Refresh unavailable '.repeat(20_000)));
    try {
      const result = await f.manage(await discover(f));
      expect(result).toMatchObject({ committed: true, runtimeRefresh: { state: 'failed' } });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
      expect(result.runtimeRefresh.message).toContain('[truncated]');
      expect(await f.service.list()).toHaveLength(1);
    } finally { failure.mockRestore(); }
  });

  test('discovery bounds model text with explicit omissions while retaining full human review', async () => {
    const f = await fixture();
    const original = await f.github.discover();
    const body = 'Full instructions.\n'.repeat(2_000);
    const source = spyOn(f.github, 'discover').mockResolvedValue({ ...original,
      candidates: Array.from({ length: 100 }, (_, index) => ({ ...original.candidates[0]!,
        view: { ...original.candidates[0]!.view, id: `candidate-${index}`, skillBody: body },
      })),
    });
    try {
      const result = await f.inspect({ operation: 'discover', sourceUrl: 'https://github.com/public/skills' });
      expect(result.candidatesOmitted).toBeGreaterThan(0);
      expect(result.candidates.length + result.candidatesOmitted).toBe(100);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
      expect(result.candidates[0].instructionsTruncated).toBe(true);
      const { review } = await f.service.review({ operation: 'install', discoveryId: result.discoveryId,
        candidateId: result.candidates[0].id, expectedCommit: result.commit });
      expect(review).toMatchObject({ kind: 'install', candidate: { skillBody: body } });
    } finally { source.mockRestore(); }
  });

  test('the final commit check rejects authority revoked during content installation', async () => {
    const f = await fixture();
    let authorized = true;
    const installContent = f.store.installValidatedContent.bind(f.store);
    const delayed = spyOn(f.store, 'installValidatedContent').mockImplementation(async (...args) => {
      await installContent(...args); authorized = false;
    });
    try {
      await expect(f.manage(await discover(f), { authorize: async () => {
        if (!authorized) throw new AgentToolFailure('operation_unavailable', 'Revoked', 'Stop.');
      } })).rejects.toMatchObject({ code: 'operation_unavailable' });
      expect(await f.service.list()).toEqual([]);
    } finally { delayed.mockRestore(); }
  });

  test('install refuses a downloaded definition that differs from its human review', async () => {
    const f = await fixture();
    const changed = spyOn(f.github, 'downloadCandidate').mockImplementation(async () => f.github.skill(2));
    try {
      await expect(f.manage(await discover(f))).rejects.toMatchObject({ code: 'candidate_changed' });
      expect(await f.service.list()).toEqual([]);
    } finally { changed.mockRestore(); }
  });

  test('cross-runtime writes retain only the immediately preceding Agent bytes for undo', async () => {
    const f = await fixture();
    const directory = join(f.workspace, '.agents', 'skills', 'shared');
    const file = join(directory, 'SKILL.md');
    await mkdir(directory, { recursive: true });
    await writeFile(file, '---\ndescription: Shared instructions\n---\nOriginal\n');
    const second = new AgentSkillRuntime({ localRoot: f.workspace, includeUserSkills: false,
      builtInSkills: [], builtInSkillDirectories: [], provenanceStore: f.provenance });
    for (const [runtime, from, to] of [[f.runtime, 'Original', 'First'], [second, 'First', 'Second']] as const) {
      const tools = createLocalTools({ localFileRoot: f.workspace, skillRuntime: runtime });
      await tools.find((tool) => tool.name === 'file_read')!.execute('read', { file_path: file });
      const result = await tools.find((tool) => tool.name === 'file_edit')!.execute('write', {
        file_path: file, old_string: from, new_string: to,
      });
      expect(result.details).not.toHaveProperty('error');
      expect(result.details.ok).toBe(true);
    }
    const identity = skillLifecycleIdentity((await f.runtime.getSkill('shared'))!);
    const target = await f.runtime.inspectUndoTarget(identity);
    await f.manage({ operation: 'undo_edit', ...target });
    const restored = await readFile(file, 'utf8');
    expect(restored).toContain('First');
    const records = Object.values(await f.provenance.load());
    expect(records).toEqual([{ agentHash: skillContentHash(restored) }]);
    await expect(second.undoLastAgentSkillEdit(target)).rejects.toMatchObject({ code: 'undo_unavailable' });
  });

  test('queued undo refuses unbound ownership and respects resolved sensitive-path blocks', async () => {
    const f = await fixture();
    const directory = join(f.root, '.ssh', 'bound-skill');
    const file = join(directory, 'SKILL.md');
    await mkdir(directory, { recursive: true });
    const before = '---\ndescription: Bound instructions\n---\nBefore\n';
    const after = before.replace('Before', 'After');
    await writeFile(file, after);
    f.runtime.updateAdditionalSkillDirectories([directory]);
    f.runtime.updateAdditionalSkillSourceModes({ [directory]: 'skill' });
    await f.runtime.recordAgentSkillWrite(file, skillContentHash(after), { hash: skillContentHash(before), content: before });
    const identity = skillLifecycleIdentity((await f.runtime.getSkill('bound-skill'))!);
    const target = await f.runtime.inspectUndoTarget(identity);
    await expect(f.manage({ operation: 'undo_edit', ...target }, { authorize: async (toolName, args, _signal, fileWritePath) => {
      const decision = evaluateAgentToolCapability({ toolName, args, fileWritePath,
        policy: { capabilityConfig: { blocks: ['Action(file.write.sensitive_local_path)'] } } });
      if (decision.behavior === 'unavailable') throw new AgentToolFailure('operation_unavailable', decision.reason, 'Stop.');
    } })).rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(await readFile(file, 'utf8')).toBe(after);
    const release = await acquireSkillWriteGuard(file);
    const undo = f.runtime.undoLastAgentSkillEdit(target);
    const refused = undo.then(() => null, (error: unknown) => error);
    f.runtime.updateAdditionalSkillDirectories([]);
    release();
    expect(await refused).toMatchObject({ code: 'undo_unavailable' });
    expect(await readFile(file, 'utf8')).toBe(after);
  });
});
