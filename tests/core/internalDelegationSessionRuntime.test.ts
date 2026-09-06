import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ThreadId, TurnId } from '../../src/core/agent/protocol';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import {
  DelegationSessionStore,
  InternalDelegationSessionRuntime,
  DelegationRunnerRegistry,
  type DelegationPolicySnapshot,
  type DelegationSessionBinding,
} from '../../src/main/agent/delegation';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { AgentWorktree } from '../../src/main/agent/worktree/AgentWorktree';

const execFileAsync = promisify(execFile);
const OWNER_ID = '00000000-0000-7000-8000-000000000001' as ThreadId;
const roots: string[] = [];
const databases: Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close(false);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('InternalDelegationSessionRuntime', () => {
  test('isolates writable Turns, emits patch evidence, and reuses the Session worktree', async () => {
    const fixture = await runtimeFixture();
    const session = createSession(fixture.store, fixture.source, '00000000-0000-7000-8000-000000000010', true);
    await fixture.runtime.ensureSession(session);
    const active = fixture.store.readSession(session.sessionId)!;
    expect(active.worktree.kind).toBe('active');
    if (active.worktree.kind !== 'active') throw new Error('Expected active worktree');
    const worktreePath = active.worktree.metadata.path;
    expect(fixture.threads.ensuredCwds.at(-1)).toBe(worktreePath);
    expect(fixture.threads.ensured.at(-1)?.worktree).toMatchObject({
      kind: 'active',
      metadata: { path: worktreePath },
    });

    fixture.threads.onStart = async () => {
      await writeFile(join(worktreePath, 'tracked.txt'), 'changed by delegated Turn\n');
      await writeFile(join(worktreePath, 'created.txt'), 'delegated artifact\n');
    };
    const first = await fixture.runtime.run(runInput(active, '00000000-0000-7000-8000-000000000020'));
    expect(first.worktree).toMatchObject({
      disposition: 'changed',
      path: worktreePath,
      changedFiles: ['created.txt', 'tracked.txt'],
    });
    expect(first.artifacts).toHaveLength(1);
    expect(JSON.parse(first.artifacts[0]!.ref)).toEqual(fixture.threads.resources[0]?.ref);
    expect(fixture.threads.resources[0]?.text).toContain('changed by delegated Turn');
    expect(fixture.threads.resources[0]?.text).toContain('delegated artifact');
    expect(await readFile(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('before\n');

    const changed = fixture.store.readSession(session.sessionId)!;
    await fixture.runtime.ensureSession(changed);
    expect(fixture.threads.ensured.at(-1)?.worktree).toMatchObject({
      metadata: { path: worktreePath },
    });
    await fixture.runtime.close(changed);
    expect(fixture.store.readSession(session.sessionId)?.worktree).toMatchObject({
      kind: 'retained',
      metadata: { path: worktreePath },
    });
    expect(await realpath(worktreePath)).toBe(worktreePath);
  });

  test('removes an unchanged writable worktree when the Session closes', async () => {
    const fixture = await runtimeFixture();
    const session = createSession(fixture.store, fixture.source, '00000000-0000-7000-8000-000000000011', true);
    await fixture.runtime.ensureSession(session);
    const active = fixture.store.readSession(session.sessionId)!;
    if (active.worktree.kind !== 'active') throw new Error('Expected active worktree');
    const worktreePath = active.worktree.metadata.path;

    await fixture.runtime.close(active);

    expect(fixture.store.readSession(session.sessionId)?.worktree).toMatchObject({
      kind: 'cleaned',
      baseRevision: active.worktree.metadata.baseCommit,
    });
    await expect(realpath(worktreePath)).rejects.toThrow();
    expect(fixture.threads.closed).toEqual([session.sessionId]);
  });

  test('keeps read-only Sessions in the admitted root cwd without creating a worktree', async () => {
    const fixture = await runtimeFixture();
    const session = createSession(fixture.store, fixture.source, '00000000-0000-7000-8000-000000000012', false);

    await fixture.runtime.ensureSession(session);

    expect(fixture.store.readSession(session.sessionId)?.worktree).toEqual({ kind: 'none' });
    expect(fixture.threads.ensuredCwds.at(-1)).toBe(fixture.source);
    expect(await gitOutput(fixture.source, ['worktree', 'list', '--porcelain'])).not.toContain(fixture.userData);
  });

  test('discards an external read-only worktree after the native launcher returns', async () => {
    const fixture = await runtimeFixture();
    const externalRunner = new DelegationRunnerRegistry([{
      id: 'codex',
      version: 'native',
      detected: true,
      ready: true,
      enabled: true,
      diagnostic: null,
      resolveExplicitModel: async () => ({
        providerId: 'external',
        modelId: 'native',
        effort: 'medium',
        supportedEfforts: ['medium'],
      }),
      run: async (input) => {
        if (input.session.worktree.kind !== 'active') throw new Error('Expected an isolated worktree');
        await writeFile(join(input.session.worktree.metadata.path, 'discarded.txt'), 'must not escape\n');
        return {
          version: 1,
          kind: 'delegate.execution-result' as const,
          sessionId: input.session.sessionId,
          turnId: input.turnId,
          outcome: 'succeeded' as const,
          runner: { id: 'codex', version: 'native' },
          model: 'external/native',
          durationMs: 1,
          text: 'done',
          error: null,
          partialEvidence: false,
          committedMessageSequence: 0,
          continuation: 'available' as const,
          usage: { state: 'unknown' as const },
          artifacts: [],
          worktree: { disposition: 'none' as const },
        };
      },
    }]);
    const runtime = new InternalDelegationSessionRuntime(
      fixture.threads as unknown as ThreadService,
      fixture.store,
      new AgentWorktree(fixture.userData),
      () => 1_000,
      externalRunner,
    );
    const session = fixture.store.createSession({
      sessionId: '00000000-0000-7000-8000-000000000015' as ThreadId,
      ownerThreadId: OWNER_ID,
      policy: {
        ...policy(fixture.source, false),
        runnerId: 'codex',
        runnerVersion: 'native',
        worktreePolicy: 'dedicated',
      },
      now: 1,
    });
    await runtime.ensureSession(session);
    const active = fixture.store.readSession(session.sessionId)!;
    const result = await runtime.run(runInput(active, '00000000-0000-7000-8000-000000000021'));

    expect(result.outcome).toBe('succeeded');
    expect(result.worktree).toEqual({ disposition: 'none' });
    expect(fixture.store.readSession(session.sessionId)?.worktree.kind).toBe('cleaned');
    expect(await readFile(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('before\n');
    expect(await gitOutput(fixture.source, ['status', '--porcelain'])).toBe('');
  });

  test('refuses owner deletion without closing a writable Session that retains changes', async () => {
    const fixture = await runtimeFixture();
    const session = createSession(fixture.store, fixture.source, '00000000-0000-7000-8000-000000000013', true);
    await fixture.runtime.ensureSession(session);
    const active = fixture.store.readSession(session.sessionId)!;
    if (active.worktree.kind !== 'active') throw new Error('Expected active worktree');
    await writeFile(join(active.worktree.metadata.path, 'tracked.txt'), 'unresolved change\n');

    await expect(fixture.runtime.prepareOwnerDeletion(active)).rejects.toThrow('retains changes');

    expect(fixture.store.readSession(session.sessionId)).toMatchObject({
      state: 'open',
      worktree: { kind: 'retained', metadata: { path: active.worktree.metadata.path } },
    });
    expect(fixture.threads.closed).toEqual([]);
  });

  test('cleans an unchanged writable Session before owner deletion', async () => {
    const fixture = await runtimeFixture();
    const session = createSession(fixture.store, fixture.source, '00000000-0000-7000-8000-000000000014', true);
    await fixture.runtime.ensureSession(session);
    const active = fixture.store.readSession(session.sessionId)!;
    if (active.worktree.kind !== 'active') throw new Error('Expected active worktree');
    const worktreePath = active.worktree.metadata.path;

    await fixture.runtime.prepareOwnerDeletion(active);

    expect(fixture.store.readSession(session.sessionId)?.worktree.kind).toBe('cleaned');
    expect(fixture.threads.closed).toEqual([session.sessionId]);
    await expect(realpath(worktreePath)).rejects.toThrow();
  });
});

class FakeThreadService {
  readonly ensured: DelegationSessionBinding[] = [];
  readonly ensuredCwds: string[] = [];
  readonly closed: ThreadId[] = [];
  readonly resources: Array<{ ref: { id: string; mimeType: string; byteLength: number; fileName: string }; text: string }> = [];
  onStart: () => Promise<void> = async () => undefined;

  async ensureDelegationThread(session: DelegationSessionBinding): Promise<Record<string, never>> {
    this.ensured.push(session);
    this.ensuredCwds.push(
      session.worktree.kind === 'active' || session.worktree.kind === 'unchanged'
        || session.worktree.kind === 'changed' || session.worktree.kind === 'retained'
        ? session.worktree.metadata.path
        : session.policy.cwd,
    );
    return {};
  }

  async startPrivilegedTurn(): Promise<void> {
    await this.onStart();
  }

  async waitForIdle(): Promise<void> {}

  readTurnForHost(_threadId: ThreadId, turnId: TurnId): unknown {
    return {
      id: turnId,
      items: [],
      status: 'completed',
      error: null,
      durationMs: 25,
      execution: { usage: { input: 10, output: 5, cost: null } },
    };
  }

  async writeThreadResource(
    _threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<{ id: string; mimeType: string; byteLength: number; fileName: string }> {
    const ref = { id: `resource-${this.resources.length + 1}`, mimeType, byteLength: bytes.byteLength, fileName };
    this.resources.push({ ref, text: Buffer.from(bytes).toString('utf8') });
    return ref;
  }

  async closeDelegationThread(sessionId: ThreadId): Promise<void> {
    this.closed.push(sessionId);
  }

  async interruptDelegationTurn(): Promise<void> {}
}

async function runtimeFixture(): Promise<{
  source: string;
  userData: string;
  store: DelegationSessionStore;
  threads: FakeThreadService;
  runtime: InternalDelegationSessionRuntime;
}> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-delegation-runtime-'));
  roots.push(root);
  const source = join(root, 'source');
  const userData = join(root, 'user-data');
  await mkdir(userData);
  await git(root, ['init', source]);
  await git(source, ['config', 'user.name', 'Delegation Runtime Test']);
  await git(source, ['config', 'user.email', 'delegation-runtime@example.test']);
  await writeFile(join(source, 'tracked.txt'), 'before\n');
  await git(source, ['add', 'tracked.txt']);
  await git(source, ['commit', '-m', 'Initial']);
  const database = new Database(join(root, 'delegation.sqlite'), { create: true });
  databases.push(database);
  const store = new DelegationSessionStore(database as unknown as SqliteDatabase);
  const threads = new FakeThreadService();
  const runtime = new InternalDelegationSessionRuntime(
    threads as unknown as ThreadService,
    store,
    new AgentWorktree(userData),
    () => 1_000,
  );
  return { source: await realpath(source), userData, store, threads, runtime };
}

function createSession(
  store: DelegationSessionStore,
  cwd: string,
  sessionId: string,
  writable: boolean,
): DelegationSessionBinding {
  return store.createSession({
    sessionId: sessionId as ThreadId,
    ownerThreadId: OWNER_ID,
    policy: policy(cwd, writable),
    now: 1,
  });
}

function policy(cwd: string, writable: boolean): DelegationPolicySnapshot {
  return {
    runnerId: 'internal',
    runnerVersion: '1',
    modelProvider: 'openai',
    modelId: 'gpt-test',
    effort: 'medium',
    profile: 'explore',
    access: writable ? 'workspace-write' : 'read-only',
    capabilityCeilingDigest: 'a'.repeat(64),
    schedulingPolicyDigest: 'b'.repeat(64),
    configurationRevision: 'revision-1',
    cwd,
    worktreePolicy: writable ? 'dedicated' : 'none',
  };
}

function runInput(session: DelegationSessionBinding, turnId: string) {
  return {
    session,
    turnId: turnId as TurnId,
    prompt: 'Inspect the workspace.',
    messages: [],
    signal: new AbortController().signal,
  };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}
