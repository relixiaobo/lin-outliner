import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAgentCoreRequest } from '../../src/core/agent/codec';
import { modelToolContract } from '../../src/core/agent/tools';
import { createLocalTools, type BashData } from '../../src/main/agent/capabilities/agentLocalTools';
import type { ToolEnvelope } from '../../src/main/agent/capabilities/agentToolEnvelope';
import { pendingExecutionContext, resolveExecutionAddress } from '../../src/main/agent/tasks/ExecutionContext';
import { ToolTaskService } from '../../src/main/agent/tasks/ToolTaskService';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

const owner = '00000000-0000-7000-8000-000000000001';
const sourceTurnId = '00000000-0000-7000-8000-000000000002';
const otherOwner = '00000000-0000-7000-8000-000000000003';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-native-workflow-')));
  const repo = join(root, 'repo');
  await mkdir(repo);
  const database = new Database(':memory:');
  const store = new ToolTaskStore(database as unknown as SqliteDatabase);
  const service = new ToolTaskService(store, join(root, 'tasks'));
  service.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
    startCompletionTurn: async () => false, taskChanged: () => {} });
  await service.initialize();
  const tools = (threadId = owner) => createLocalTools({ workspace: { root: repo, scratchRoot: join(root, 'scratch'),
    readFileState: new Map(), threadId }, toolTaskService: service, turnId: sourceTurnId });
  const execute = async (command: string, threadId = owner) => {
    const result = await tools(threadId).find((tool) => tool.name === 'bash')!.execute('command', { command, cwd: repo });
    const envelope = result.details as ToolEnvelope<BashData>;
    expect(envelope.ok).toBe(true);
    return envelope.data!;
  };
  const run = async (command: string) => {
    const result = await execute(command);
    expect(result.exitCode).toBe(0);
    return result.stdout;
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Workflow Test'); git('config', 'user.email', 'workflow@example.test');
  git('config', 'commit.gpgsign', 'false');
  return { root, repo, store, service, tools, execute, run, git,
    close: async () => { await service.close(2_000); database.close(); await rm(root, { recursive: true, force: true }); } };
}

test('native selected-file commits preserve unrelated staging and reconcile an explicit local push', async () => {
  const f = await fixture();
  try {
    for (const name of ['selected', 'unrelated', 'old-name', 'deleted']) await writeFile(join(f.repo, name), 'initial\n');
    f.git('add', '.'); f.git('commit', '-qm', 'Initial');
    await writeFile(join(f.repo, 'selected'), 'selected change\n');
    await writeFile(join(f.repo, 'unrelated'), 'unrelated staged\n'); f.git('add', 'unrelated');
    await writeFile(join(f.repo, 'unrelated'), 'unrelated working\n');
    const indexBefore = f.git('show', ':unrelated');
    f.git('mv', 'old-name', 'new-name'); await rm(join(f.repo, 'deleted'));
    const literal = ':(glob)*';
    await writeFile(join(f.repo, literal), new Uint8Array([0, 1, 2, 255]));
    await f.run('git diff --no-ext-diff --no-textconv -- selected deleted');
    await f.run(`git --literal-pathspecs add -- ${quote(literal)}`);
    await f.run(`git --literal-pathspecs commit --only -m 'Selected work' -- selected old-name new-name deleted ${quote(literal)}`);
    expect(f.git('show', ':unrelated')).toBe(indexBefore);
    expect(await readFile(join(f.repo, 'unrelated'), 'utf8')).toBe('unrelated working\n');
    expect(f.git('show', 'HEAD:unrelated')).toBe('initial');
    expect(f.git('show', 'HEAD:selected')).toBe('selected change');
    expect(f.git('ls-tree', '--name-only', 'HEAD')).not.toContain('old-name');
    expect(f.git('ls-tree', '--name-only', 'HEAD')).not.toContain('deleted');
    expect(execFileSync('git', ['-C', f.repo, 'show', `HEAD:${literal}`])).toEqual(Buffer.from([0, 1, 2, 255]));
    const remote = join(f.root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    f.git('remote', 'add', 'fixture', remote);
    const intended = f.git('rev-parse', 'HEAD');
    await f.run('git push fixture HEAD:refs/heads/reviewed');
    expect(await f.run('git ls-remote fixture refs/heads/reviewed')).toContain(intended);
    // Lost output can be reconciled by querying native state without another push.
    expect(f.git('ls-remote', 'fixture', 'refs/heads/reviewed').split(/\s/u)[0]).toBe(intended);
    expect(f.store.listAll(owner).every((task) => task.isolation.state === 'unsandboxed')).toBe(true);
  } finally { await f.close(); }
}, 30_000);

test('a background process permits same-cwd reads, writes and checks without a proprietary profile', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'AGENTS.md'), 'x'.repeat(33 * 1024));
    await mkdir(join(f.repo, '.tenon')); await writeFile(join(f.repo, '.tenon/checks.json'), 'invalid old profile');
    const background = await f.service.start({ ownerThreadId: owner, sourceTurnId, sourceItemId: 'server',
      producer: 'bash', command: 'while :; do sleep 1; done', description: 'Owned background process',
      cwd: f.repo, env: process.env, timeoutMs: 20_000 });
    await f.run('git status --short');
    expect((await f.execute('pwd', otherOwner)).stdout).toContain(f.repo);
    const write = await f.tools().find((tool) => tool.name === 'file_write')!.execute('write', { file_path: 'result', content: 'fixed' });
    expect(write.details).toMatchObject({ ok: true });
    expect((await f.execute('test -f missing')).exitCode).toBe(1);
    await f.run('test -f result'); await f.run('test -f result ');
    expect(f.store.read(background.taskId)?.state).toBe('running');
    const denied = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: f.repo }), {
      capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
    });
    await expect(f.service.runHostOperation({ ownerThreadId: otherOwner, sourceTurnId, sourceItemId: 'forged-child',
      producer: 'file_write', executionContext: denied, parentTaskId: background.taskId,
      onAdmitted: async () => {}, execute: async () => { throw new Error('Must not execute'); } })).rejects.toThrow('does not belong');
    await f.service.stop(background.taskId, owner);
    expect((await f.service.waitForTerminal(background.taskId, owner, 5_000))?.state).toBe('cancelled');
  } finally { await f.close(); }
}, 30_000);

test('Goal and Project model contracts contain no proprietary verification or organization surface', () => {
  expect(modelToolContract('project_inspect')).toBeNull();
  expect(modelToolContract('project_manage')).toBeNull();
  expect(decodeAgentCoreRequest('goal/create', { threadId: owner, objective: 'Verify native work', tokenBudget: 1000 }))
    .toEqual({ threadId: owner, objective: 'Verify native work', tokenBudget: 1000 });
  expect(() => decodeAgentCoreRequest('goal/create', { threadId: owner, objective: 'Verify native work',
    verification: { roots: ['/repo'], maxAttempts: 3 } })).toThrow();
});
