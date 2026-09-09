import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAgentCoreRequest } from '../../src/core/agent/codec';
import { modelToolContract } from '../../src/core/agent/tools';
import { createLocalTools, type BashData } from '../../src/main/agent/capabilities/agentLocalTools';
import { evaluateAgentToolCapability } from '../../src/main/agent/capabilities/agentCapabilities';
import type { ToolEnvelope } from '../../src/main/agent/capabilities/agentToolEnvelope';
import { delegatedBashExecutionAllowed } from '../../src/main/agent/delegation/delegatedToolPolicy';
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
  const tools = (threadId = owner, capability: 'full-access' | 'read-only' = 'full-access') => createLocalTools({
    workspace: { root: repo, scratchRoot: join(root, 'scratch'), readFileState: new Map(), threadId, capability },
    toolTaskService: service, turnId: sourceTurnId });
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

test('native selected-file commits preserve unrelated staging', async () => {
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
    expect(f.store.listAll(owner).every((task) => task.isolation.state === 'unsandboxed')).toBe(true);
  } finally { await f.close(); }
}, 30_000);

for (const scenario of [
  { name: 'a separate push URL', targetCount: 1, rejectLast: false },
  { name: 'multiple push URLs', targetCount: 2, rejectLast: false },
  { name: 'partial success across push URLs', targetCount: 2, rejectLast: true },
]) {
  test(`native publication reconciles ${scenario.name} without consulting the fetch URL`, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.repo, 'selected'), 'publish this commit\n');
      f.git('add', 'selected'); f.git('commit', '-qm', 'Initial');
      const fetchUrl = join(f.root, 'fetch.git');
      execFileSync('git', ['init', '--bare', '-q', fetchUrl]);
      f.git('remote', 'add', 'fixture', fetchUrl);
      const authorizedUrls = Array.from({ length: scenario.targetCount }, (_, index) => join(f.root, `push ${index}.git`));
      for (const url of authorizedUrls) {
        execFileSync('git', ['init', '--bare', '-q', url]);
        f.git('remote', 'set-url', '--add', '--push', 'fixture', url);
      }
      if (scenario.rejectLast) {
        await writeFile(join(authorizedUrls.at(-1)!, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      }
      const destinations = (await f.run('git remote get-url --push --all fixture')).trim().split('\n');
      expect(destinations).toEqual(authorizedUrls);
      const ref = 'refs/heads/reviewed';
      for (const url of destinations) expect((await f.run(`git ls-remote ${quote(url)} ${ref}`)).trim()).toBe('');
      const intended = f.git('rev-parse', 'HEAD');
      expect((await f.run('git remote get-url --push --all fixture')).trim().split('\n')).toEqual(destinations);
      const push = (await f.tools().find((tool) => tool.name === 'bash')!.execute('publish', {
        command: `git push fixture HEAD:${ref}`, cwd: f.repo,
      })).details as ToolEnvelope<BashData>;
      expect(push).toMatchObject({ ok: !scenario.rejectLast, data: { exitCode: scenario.rejectLast ? 1 : 0 } });
      if (scenario.rejectLast) expect(push.data!.stderr).toContain('pre-receive hook declined');
      // A successful push and a partial push are both reconciled without replaying the mutation.
      for (const [index, url] of destinations.entries()) {
        const expected = scenario.rejectLast && index === destinations.length - 1 ? '' : `${intended}\t${ref}`;
        expect((await f.run(`git ls-remote ${quote(url)} ${ref}`)).trim()).toBe(expected);
      }
      expect((await f.run(`git ls-remote fixture ${ref}`)).trim()).toBe('');
      expect(f.git('remote', 'get-url', 'fixture')).toBe(fetchUrl);
    } finally { await f.close(); }
  }, 30_000);
}

test('native review passes read-only delegation and inspects HEAD and only the selected staged and working file', async () => {
  const f = await fixture();
  try {
    const selected = 'selected[1].txt';
    const unrelated = 'selected1.txt';
    for (const name of [selected, unrelated]) await writeFile(join(f.repo, name), 'initial\n');
    f.git('add', '.'); f.git('commit', '-qm', 'Initial');
    await writeFile(join(f.repo, selected), 'selected staged\n');
    await writeFile(join(f.repo, unrelated), 'unrelated staged\n'); f.git('add', '.');
    await writeFile(join(f.repo, selected), 'selected working\n');
    await writeFile(join(f.repo, unrelated), 'unrelated working\n');
    const before = f.git('status', '--porcelain');
    const bash = f.tools(owner, 'read-only').find((tool) => tool.name === 'bash')!;
    const policy = { profile: 'explore', access: 'read-only' } as const;
    const inspections = [
      { command: 'git show --no-patch --format=%H HEAD', expected: f.git('rev-parse', 'HEAD') },
      ...[false, true].map((staged) => ({
        command: `git diff --no-ext-diff --no-textconv ${staged ? '--cached ' : ''}-- ${quote(`:(literal)${selected}`)}`,
        expected: staged ? '+selected staged' : '+selected working',
      })),
    ];
    for (const { command, expected } of inspections) {
      const capability = evaluateAgentToolCapability({ toolName: 'bash', args: { command }, policy: { workspaceRoot: f.repo } });
      expect(capability.behavior).toBe('allow');
      expect(delegatedBashExecutionAllowed(policy, capability.descriptors.map((entry) => entry.actionKind),
        capability.bashStdinConsumer ?? 'absent', false)).toBe(true);
      const result = (await bash.execute('literal-inspection', { command, cwd: f.repo })).details as ToolEnvelope<BashData>;
      expect(result).toMatchObject({ ok: true, data: { exitCode: 0 } });
      expect(result.data!.stdout).toContain(expected);
      expect(result.data!.stdout).not.toContain('unrelated');
    }
    expect(f.store.listAll(owner)).toHaveLength(inspections.length);
    expect(f.store.listAll(owner).every((task) => task.executionContext.policy.capability === 'read-only')).toBe(true);
    expect(f.git('status', '--porcelain')).toBe(before);
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
