import { decodeAgentCoreNotification } from '../../src/core/agent/codec';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { defaultToolTaskSupervisorRuntime } from '../../src/main/agent/tasks/toolTaskRuntime';
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolTaskService } from '../../src/main/agent/tasks/ToolTaskService';
import { projectToolTask, ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { pendingExecutionContext, resolveExecutionAddress } from '../../src/main/agent/tasks/ExecutionContext';
import { decodeProcessIsolationEvidence } from '../../src/core/agent/processIsolation';
import { prepareAgentProcessIsolation } from '../../src/main/agent/capabilities/agentProcessExecutor';

const owner = '00000000-0000-7000-8000-000000000001'; const turn = '00000000-0000-7000-8000-000000000002';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tenon-isolation-')));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const db = new Database(path.join(root, 'tasks.sqlite'));
  const store = new ToolTaskStore(db as unknown as SqliteDatabase);
  const service = new ToolTaskService(store, path.join(root, 'tasks'));
  service.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
    startCompletionTurn: async () => false, taskChanged: () => {} });
  await service.initialize();
  cleanups.push(async () => { await service.close(2000); db.close(); await rm(root, { recursive: true, force: true }); });
  const input = { ownerThreadId: owner, sourceTurnId: turn, sourceItemId: 'isolation-test', producer: 'bash', description: 'Isolation test',
    cwd, timeoutMs: 5000, env: process.env, backgroundEnabled: false };
  return { root, cwd, db, store, service, input };
}

test('Full Access records unsandboxed execution and retains it after restart and detail expiry', async () => {
  const f = await fixture(); const outside = path.join(f.root, 'outside.txt');
  const task = await f.service.start({ ...f.input, command: `printf allowed > ${quote(outside)}` });
  const terminal = await f.service.waitForTerminal(task.taskId, owner, 7000);
  expect(terminal?.state).toBe('succeeded'); expect(terminal?.isolation).toMatchObject({ state: 'unsandboxed', requested: 'unsandboxed', network: 'unrestricted', backend: null });
  expect(await readFile(outside, 'utf8')).toBe('allowed');
  const notification = decodeAgentCoreNotification({ type: 'toolTask/changed', threadId: owner, task: projectToolTask(terminal!) });
  expect(notification.type === 'toolTask/changed' && notification.task.isolation).toEqual(terminal!.isolation);
  await f.service.close(2000); await f.service.initialize();
  expect(f.store.read(task.taskId)?.isolation).toEqual(terminal!.isolation);
  f.store.expireDetail(task.taskId, 'expired', Date.now());
  expect(await f.service.output(task.taskId, owner)).toBeNull();
  expect(f.store.read(task.taskId)?.isolation).toEqual(terminal!.isolation);
}, 15_000);

test('sandboxed command can write its root but cannot write outside or forge Task progress', async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture(); const outside = path.join(f.root, 'outside.txt');
  const command = `printf inside > inside.txt; printf outside > ${quote(outside)}; printf forged > "$TENON_TOOL_TASK_PROGRESS_FILE"`;
  const task = await f.service.start({ ...f.input, command, sandbox: { writablePaths: [f.cwd] } });
  const terminal = await f.service.waitForTerminal(task.taskId, owner, 7000);
  expect({ state: terminal?.state, error: terminal?.error }).toMatchObject({ state: 'failed' });
  expect(terminal?.isolation).toMatchObject({ requested: 'macos-write-sandbox', state: 'sandboxed', backend: 'macos-sandbox-exec', dependency: 'available', writablePaths: [f.cwd], network: 'unrestricted' });
  expect(terminal?.isolation.profileDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(await readFile(path.join(f.cwd, 'inside.txt'), 'utf8')).toBe('inside');
  expect(await access(outside).then(() => true, () => false)).toBe(false);
  expect(terminal?.progress).toBeNull();
  expect((await f.service.output(task.taskId, owner))?.stderr.toLowerCase()).toContain('operation not permitted');
}, 15_000);

test('required isolation without a backend request fails before command activation', async () => {
  const f = await fixture();
  const context = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: f.cwd }), {
    capability: 'full-access', isolation: 'macos-write-sandbox', writablePaths: [f.cwd],
  });
  const task = await f.service.start({ ...f.input, command: 'touch must-not-start', executionContext: context });
  expect(task).toMatchObject({ state: 'failed', childPid: null, supervisorPid: null, outcomeReason: 'isolation_unavailable' });
  expect(task.isolation.state).toBe('unavailable');
  expect(await access(path.join(f.cwd, 'must-not-start')).then(() => true, () => false)).toBe(false);
});

test('unsupported backend and invalid roots cannot produce an unsandboxed fallback', () => {
  const unavailable = prepareAgentProcessIsolation({ writablePaths: ['/tmp'] }, 'macos-write-sandbox', 'linux');
  expect(unavailable).toMatchObject({ profile: null, evidence: { state: 'unavailable', dependency: 'unavailable' } });
  const rejected = prepareAgentProcessIsolation({ writablePaths: [] }, 'macos-write-sandbox');
  expect(rejected).toMatchObject({ profile: null, evidence: { state: 'rejected' } });
  expect(() => decodeProcessIsolationEvidence({ ...unavailable.evidence, state: 'unsandboxed' })).toThrow('fall back');
  expect(() => decodeProcessIsolationEvidence({ ...unavailable.evidence, state: 'sandboxed' })).toThrow('activation evidence');
});

test('isolated direct execution retains private control transport and reports unrestricted local networking', async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('network-ok') });
  cleanups.push(async () => { server.stop(true); });
  const task = await f.service.start({ ...f.input, command: 'private transport and local network',
    sandbox: { writablePaths: [f.cwd] }, privateControlInput: Buffer.from('admitted-control'),
    process: { kind: 'exec', executable: process.execPath,
      args: ['-e', `const fs = require('node:fs'); process.stdout.write(fs.readFileSync(3, 'utf8')); fetch('http://127.0.0.1:${server.port}').then(r => r.text()).then(t => process.stdout.write(t));`],
      env: {}, privateControl: true } });
  const terminal = await f.service.waitForTerminal(task.taskId, owner, 7000);
  expect(terminal).toMatchObject({ state: 'succeeded', isolation: { state: 'sandboxed', network: 'unrestricted' } });
  expect((await f.service.output(task.taskId, owner))?.stdout).toBe('admitted-controlnetwork-ok');
  expect(() => f.store.setIsolation(task.taskId, { ...terminal!.isolation, state: 'unavailable' })).toThrow('immutable');
}, 15_000);

test('a backend profile activation failure produces unavailable evidence and never executes the target', async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  const plan = prepareAgentProcessIsolation({ writablePaths: [f.cwd] }, 'macos-write-sandbox');
  const profile = '(invalid sandbox profile)';
  const config = { version: 3, taskId: 'malformed-backend', nonce: 'private-activation', cwd: f.cwd,
    process: { kind: 'shell', command: 'touch must-not-start' },
    isolation: { ...plan.evidence, profileDigest: createHash('sha256').update(profile).digest('hex') },
    sandboxProfile: profile, startedAt: Date.now(), timeoutMs: 2000, maxOutputBytes: 4096, maxPreparedResultBytes: 1024,
    stdinPath: path.join(f.root, 'stdin'), stdoutPath: path.join(f.root, 'stdout'), stderrPath: path.join(f.root, 'stderr'),
    progressPath: path.join(f.root, 'progress'), identityPath: path.join(f.root, 'identity'), heartbeatPath: path.join(f.root, 'heartbeat'),
    stopRequestPath: path.join(f.root, 'stop'), finalReceiptPath: path.join(f.root, 'receipt'), preparedResultPath: path.join(f.root, 'prepared') };
  for (const file of [config.stdinPath, config.stdoutPath, config.stderrPath]) await writeFile(file, '');
  const configPath = path.join(f.root, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const runtime = defaultToolTaskSupervisorRuntime();
  const child = spawn(runtime.executable, [...runtime.argsPrefix, configPath], { env: { ...process.env, ...runtime.env }, stdio: 'ignore' });
  cleanups.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
  const receipt = JSON.parse(await readFile(config.finalReceiptPath, 'utf8'));
  expect(receipt).toMatchObject({ version: 3, state: 'failed', reason: 'isolation_unavailable', isolation: { state: 'unavailable' } });
  expect(await access(path.join(f.cwd, 'must-not-start')).then(() => true, () => false)).toBe(false);
}, 10_000);

test.each(['task_id TEXT PRIMARY KEY', 'task_id TEXT PRIMARY KEY, isolation_json TEXT, inherited_claim_task_id TEXT'])(
  'unsupported pre-baseline Task storage preserves data and points to recovery (%s)', (columns) => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE tool_tasks(${columns})`);
    db.exec("INSERT INTO tool_tasks(task_id) VALUES ('retained-old-data')");
    expect(() => new ToolTaskStore(db as unknown as SqliteDatabase)).toThrow('data recovery');
    expect(db.query('SELECT task_id FROM tool_tasks').get()).toEqual({ task_id: 'retained-old-data' });
  } finally { db.close(); }
});
