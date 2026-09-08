import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { VerificationCoordinator } from '../../src/main/agent/verification/VerificationCoordinator';
import { ToolTaskService } from '../../src/main/agent/tasks/ToolTaskService';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import { pendingExecutionContext, resolveExecutionAddress } from '../../src/main/agent/tasks/ExecutionContext';

const OWNER = '00000000-0000-7000-8000-000000000001';
const CHILD = '00000000-0000-7000-8000-000000000002';
const TURN = '00000000-0000-7000-8000-000000000003';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

type Declaration = { id: string; command: string; required: boolean; inputs: string[]; exclude: string[] };
const A: Declaration = { id: 'A', command: 'echo check-A', required: true, inputs: ['.'], exclude: [] };
const B: Declaration = { id: 'B', command: 'test "$(cat source.txt)" = fixed || { echo needs-fix; exit 1; }', required: true, inputs: ['.'], exclude: [] };

async function fixture(checks = [A, B], maxAttempts = 4, configure = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tenon-verification-')));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, '.tenon'), { recursive: true });
  const profile = async (definitions: Declaration[], cwd = source) => {
    await mkdir(path.join(cwd, '.tenon'), { recursive: true });
    await writeFile(path.join(cwd, '.tenon/checks.json'), JSON.stringify({ schemaVersion: 1, checks: definitions }));
  };
  await profile(checks);
  await writeFile(path.join(source, 'source.txt'), 'broken');
  const goalDatabase = new Database(path.join(root, 'goals.sqlite'));
  const taskDatabase = new Database(path.join(root, 'tasks.sqlite'));
  const goals = new GoalStore(':memory:', goalDatabase as unknown as SqliteDatabase);
  const taskStore = new ToolTaskStore(taskDatabase as unknown as SqliteDatabase);
  const payloads = new ToolPayloadStore(path.join(root, 'payloads'));
  let tasks: ToolTaskService;
  let verification: VerificationCoordinator;
  const restart = async () => {
    if (tasks) await tasks.close(2_000);
    tasks = new ToolTaskService(taskStore, path.join(root, 'tasks'));
    verification = new VerificationCoordinator(goals, tasks, {
      write: (owner, payload) => payloads.writeContext(owner, payload),
      read: (owner, ref) => payloads.readContext(owner, ref),
      ancestors: (owner) => owner === CHILD ? [OWNER] : [],
      deleteEvidence: (prefix) => payloads.deleteContextOwnersWithPrefix(prefix),
    });
    tasks.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
      startCompletionTurn: async () => false, taskChanged: () => undefined,
      admissionFailed: (owner, error) => verification.admissionFailed(owner, error),
      beforeTask: (task) => verification.beforeTask(task), afterTask: (task) => verification.afterTask(task) });
    await tasks.initialize();
    await verification.initialize();
  };
  cleanup.push(async () => { await tasks.close(2_000); goals.close(); taskDatabase.close(); await rm(root, { recursive: true, force: true }); });
  await restart();
  goals.create(OWNER, 'Fix the fixture and verify every required check', null);
  if (configure) await verification!.configure(OWNER, { roots: [source], maxAttempts });
  const run = async (command: string, cwd = source, ownerThreadId = OWNER) => {
    const task = await tasks.start({ ownerThreadId, sourceTurnId: TURN, sourceItemId: 'check', producer: 'bash',
      description: 'Verification fixture', command, cwd, timeoutMs: 5_000, env: process.env, backgroundEnabled: false });
    const terminal = await tasks.waitForTerminal(task.taskId, ownerThreadId, 6_000);
    expect(terminal?.state).not.toBe('running');
    return terminal!;
  };
  const edit = async (contents: string, restore = false) => {
    const executionContext = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: source }), {
      capability: 'full-access', mutation: true, isolation: 'unsandboxed', writablePaths: [],
    });
    return tasks.runHostOperation({ ownerThreadId: OWNER, sourceTurnId: TURN, sourceItemId: 'edit', producer: 'file_write',
      executionContext, onAdmitted: async () => undefined, execute: async () => {
        const file = path.join(source, 'source.txt');
        const before = await readFile(file);
        await writeFile(file, contents);
        if (restore) await writeFile(file, before);
        return { result: undefined, success: true };
      } });
  };
  return { root, source, goals, payloads, taskStore, run, edit, profile, restart,
    corruptMetadata: () => goalDatabase.prepare('UPDATE goal_verifications SET state_json = ? WHERE thread_id = ?').run('{}', OWNER),
    verification: () => verification, tasks: () => tasks, view: () => verification.inspect(OWNER) };
}

describe('source-bound verification using real Tool Tasks', () => {
  for (const restart of [false, true]) {
    test(`A pass / B fail / correction / B pass requires A rerun${restart ? ' across restart' : ''}`, async () => {
      const f = await fixture();
      const a = await f.run(A.command);
      const b = await f.run(B.command);
      expect([a.state, b.state]).toEqual(['succeeded', 'failed']);
      expect((await f.view())?.state).toBe('failed');
      await f.edit('fixed');
      expect((await f.view())?.checks.every((check) => check.applicability === 'stale')).toBe(true);
      if (restart) await f.restart();
      await f.run(B.command);
      const partial = await f.view();
      expect(partial).toMatchObject({ revision: 1, attemptsUsed: 2, state: 'pending' });
      expect(partial?.checks.find((check) => check.command === A.command)?.state).toBe('unavailable');
      await expect(f.verification().assertComplete(OWNER)).rejects.toThrow('All required checks');
      await f.run(A.command);
      expect(await f.view()).toMatchObject({ state: 'passed', revision: 1 });
      await f.verification().assertComplete(OWNER);
      expect(await f.verification().completeGoal(OWNER)).toBe(true);
      expect(f.goals.read(OWNER)?.goal.status).toBe('complete');
      expect(f.taskStore.read(a.taskId)?.state).toBe('succeeded');
      expect(f.goals.readVerification(OWNER)?.attempts[1]?.parentFailureTaskIds).toContain(b.taskId);
    }, 20_000);
  }

  test('known write and restoration never revive a pass; other-cwd shell also invalidates', async () => {
    const f = await fixture([A]);
    await f.run(A.command);
    await f.edit('transient', true);
    expect(await f.view()).toMatchObject({ state: 'failed', checks: [{ state: 'passed', applicability: 'stale' }] });
    await f.run(A.command);
    expect((await f.view())?.state).toBe('passed');
    await f.run('echo unrelated-cwd', f.root);
    expect((await f.view())?.checks[0]?.applicability).toBe('stale');
  }, 20_000);

  test('repeated equivalent failures stop without spending the full budget', async () => {
    const f = await fixture([B], 5);
    await f.run(B.command);
    await f.run(B.command);
    const evidence = f.goals.readVerification(OWNER)!.attempts.flatMap((attempt) => attempt.checks);
    expect(evidence.map((check) => ({ fingerprint: check.fingerprint, error: f.taskStore.read(check.toolTaskId)?.error }))[1]).toEqual(evidence.map((check) => ({ fingerprint: check.fingerprint, error: f.taskStore.read(check.toolTaskId)?.error }))[0]);
    expect(await f.view()).toMatchObject({ state: 'stopped', attemptsUsed: 2, stopReason: 'An equivalent check failure repeated.' });
    expect(f.goals.read(OWNER)?.goal.status).toBe('blocked');
    await f.restart();
    expect((await f.view())?.state).toBe('stopped');
  }, 20_000);

  test('attempt exhaustion prevents admission of another check', async () => {
    const f = await fixture([A], 1);
    await f.run(A.command);
    await f.edit('fixed');
    expect(await f.run(A.command)).toMatchObject({ state: 'failed', error: expect.stringContaining('attempt budget exhausted') });
    expect(await f.view()).toMatchObject({ state: 'stopped', attemptsUsed: 1 });
  }, 15_000);

  test('optional failure stays visible while every required check passes', async () => {
    const f = await fixture([A, { ...B, required: false }]);
    await f.run(A.command);
    await f.run(B.command);
    expect((await f.view())?.state).toBe('passed');
    expect((await f.view())?.checks.find((check) => !check.required)).toMatchObject({ state: 'failed', applicability: 'current' });
  }, 15_000);

  test('restart revalidates a valid revision and resumes only missing checks', async () => {
    const f = await fixture([A, { ...B, command: 'echo check-B' }]);
    const a = await f.run(A.command);
    await f.restart();
    await f.run('echo check-B');
    expect(await f.view()).toMatchObject({ state: 'passed', revision: 0, attemptsUsed: 1 });
    expect((await f.view())?.checks.find((check) => check.command === A.command)?.toolTaskId).toBe(a.taskId);
  }, 15_000);

  test('missing terminal source evidence cannot become a recovered pass', async () => {
    const f = await fixture([A]);
    await f.run(A.command);
    await f.payloads.deleteThread(f.verification().evidenceOwner(OWNER)!);
    expect((await f.view())?.state).toBe('stopped');
    await f.restart();
    expect((await f.view())?.checks[0]?.applicability).toBe('unavailable');
    await expect(f.verification().assertComplete(OWNER)).rejects.toThrow();
  }, 15_000);

  test('an unavailable root keeps verification blocked instead of silently creating an ordinary Goal', async () => {
    const f = await fixture([A], 4, false);
    const view = await f.verification().configure(OWNER, { roots: [path.join(f.root, 'missing')], maxAttempts: 4 });
    expect(view.state).toBe('stopped');
    expect(f.goals.read(OWNER)?.goal.status).toBe('blocked');
    await expect(f.verification().assertComplete(OWNER)).rejects.toThrow();
  });

  test('unavailable post-check evidence invalidates an otherwise intact baseline', async () => {
    const f = await fixture([A]);
    await f.run(A.command);
    const attempt = f.goals.readVerification(OWNER)!.attempts[0]!;
    await f.payloads.pruneUnreferencedContexts(f.verification().evidenceOwner(OWNER)!, [attempt.baselineRef, attempt.checks[0]!.beforeRef], []);
    expect((await f.view())?.state).toBe('stopped');
    await expect(f.verification().assertComplete(OWNER)).rejects.toThrow();
  });

  test('damaged workflow metadata degrades inspection and disables continuation', async () => {
    const f = await fixture([A]);
    await f.run(A.command);
    const owner = f.verification().evidenceOwner(OWNER)!;
    const baselineRef = f.goals.readVerification(OWNER)!.attempts[0]!.baselineRef;
    await f.payloads.copyContextToThread(owner, OWNER, baselineRef);
    f.corruptMetadata();
    expect(await f.view()).toMatchObject({ state: 'unavailable', checks: [] });
    expect(f.goals.read(OWNER)?.goal.status).toBe('blocked');
    expect((await f.verification().publication(OWNER))?.facts[0]?.invalidated).toBe(true);
    await expect(f.verification().assertComplete(OWNER)).rejects.toThrow();
    await f.restart();
    expect((await f.view())?.state).toBe('unavailable');
    await f.verification().clearEvidence(OWNER);
    expect(await f.payloads.readContext(owner, baselineRef)).toBeNull();
    expect((await f.payloads.readContext(OWNER, baselineRef))?.kind).toBe('verificationSource');
    expect(f.goals.clear(OWNER)).toBe(true);
  });

  test('worktree collision records an admission stop without running the check', async () => {
    const f = await fixture([A]);
    await f.run(A.command);
    const other = '00000000-0000-7000-8000-000000000099';
    const task = await f.tasks().start({ ownerThreadId: other, sourceTurnId: TURN, sourceItemId: 'other', producer: 'bash',
      command: 'sleep 1', description: 'Collision fixture', cwd: f.source, timeoutMs: 5_000, env: process.env, backgroundEnabled: false });
    await expect(f.run(A.command)).rejects.toMatchObject({ code: 'worktree_busy' });
    expect(await f.view()).toMatchObject({ state: 'stopped', attemptsUsed: 1, stopReason: expect.stringContaining('Host admission failed') });
    await f.tasks().stop(task.taskId, other);
  }, 15_000);

  test('missing Tool Task truth becomes lost and prevents recovered success', async () => {
    const f = await fixture([A]);
    const task = await f.run(A.command);
    f.taskStore.deleteTask(task.taskId);
    await f.restart();
    expect((await f.view())?.checks[0]?.state).toBe('lost');
    expect((await f.view())?.state).toBe('stopped');
  });

  test('settled check bindings cannot be rewritten or removed', async () => {
    const f = await fixture([A]);
    await f.run(A.command);
    const state = f.goals.readVerification(OWNER)!;
    expect(() => f.goals.writeVerification({ ...state, attempts: [] })).toThrow('immutable');
    expect(() => f.goals.writeVerification({ ...state, attempts: state.attempts.map((attempt) => ({ ...attempt,
      checks: attempt.checks.map((check) => ({ ...check, terminalDigest: 'a'.repeat(64) })) })) })).toThrow('immutable');
  });

  test('explicit user resumption revalidates and spends a fresh attempt without resetting budgets', async () => {
    const f = await fixture([A]);
    await f.run(A.command);
    f.verification().stop(OWNER, 'User stop');
    const stopped = f.goals.readVerification(OWNER)!;
    const configuration = { roots: [f.source], maxAttempts: 4 };
    await expect(f.verification().resume(OWNER, configuration, { id: 'old', startedAt: stopped.stopped!.at,
      provenance: { trigger: { kind: 'user' } } })).rejects.toThrow('fresh user Turn');
    await expect(f.verification().resume(OWNER, configuration, { id: 'automatic', startedAt: stopped.stopped!.at + 1,
      provenance: { trigger: { kind: 'feature' } } })).rejects.toThrow('fresh user Turn');
    await f.verification().resume(OWNER, configuration, { id: 'renewed-user', startedAt: stopped.stopped!.at + 1,
      provenance: { trigger: { kind: 'user' } } });
    expect((await f.view())?.checks[0]?.applicability).toBe('stale');
    await f.run(A.command);
    expect(await f.view()).toMatchObject({ state: 'passed', revision: 1, attemptsUsed: 2, maxAttempts: 4 });
    expect(f.goals.readVerification(OWNER)?.resumptions[0]?.stopReason).toBe('User stop');
  }, 15_000);

  test('a check that edits included source invalidates its own passing receipt', async () => {
    const command = 'echo generated > source.txt';
    const f = await fixture([{ ...A, command }]);
    const task = await f.run(command);
    expect(task.state).toBe('succeeded');
    expect((await f.view())?.checks[0]).toMatchObject({ state: 'passed', applicability: 'stale' });
    await expect(f.verification().assertComplete(OWNER)).rejects.toThrow();
  });

  test('profile changes make every previous result stale and add required work', async () => {
    const f = await fixture([A]);
    await f.run(A.command);
    await f.profile([A, B]);
    const view = await f.view();
    expect(view?.checks).toHaveLength(2);
    expect(view?.checks.every((check) => check.applicability === 'stale')).toBe(true);
    expect(view?.state).toBe('failed');
  });

  test('child and multiple-directory checks retain their own execution addresses', async () => {
    const f = await fixture([A], 4, false);
    const second = path.join(f.root, 'second');
    await f.profile([{ ...B, command: 'echo second-root' }], second);
    await f.verification().configure(OWNER, { roots: [f.source, second], maxAttempts: 4 });
    const a = await f.run(A.command, f.source, CHILD);
    const b = await f.run('echo second-root', second);
    expect(await f.view()).toMatchObject({ state: 'passed', revision: 0 });
    expect(a.executionContext.address.cwd).toBe(f.source);
    expect(b.executionContext.address.cwd).toBe(second);
    expect(a.ownerThreadId).toBe(CHILD);
    expect(a.executionContext.snapshotRef).not.toBe(b.executionContext.snapshotRef);
  }, 15_000);
});
