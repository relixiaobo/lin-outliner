/**
 * Reproducible macOS experiment; uses fresh data and private sockets only.
 * bun scripts/probe-tmux-tasks.ts /absolute/path/to/tmux [report.json]
 * The --host worker is killed/reopened to measure actual Host crash recovery.
 */
import { Database } from 'bun:sqlite';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { resolveToolTaskSupervisorRuntime } from '../src/main/agent/tasks/toolTaskRuntime';
import { ToolTaskStore } from '../src/main/agent/tasks/ToolTaskStore';
import { ToolTaskService } from '../src/main/agent/tasks/ToolTaskService';
import type { SqliteDatabase } from '../src/main/agent/persistence/sqlite';
import type { ToolTaskRecord } from '../src/main/agent/tasks/toolTaskTypes';

const owner = '00000000-0000-7000-8000-000000000001';
const turn = '00000000-0000-7000-8000-000000000002';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[2] === '--host') {
  const root = process.argv[3]!;
  const db = new Database(path.join(root, 'tasks.sqlite'));
  const store = new ToolTaskStore(db as unknown as SqliteDatabase);
  const runtime = process.env.TENON_PROBE_ELECTRON ? resolveToolTaskSupervisorRuntime({
    isPackaged: true, moduleDir: '', resourcesPath: path.resolve(import.meta.dir, '../build/generated'),
    processExecPath: process.env.TENON_PROBE_ELECTRON,
  }) : undefined;
  const service = new ToolTaskService(store, path.join(root, 'tasks'), runtime);
  service.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
    startCompletionTurn: async () => false, taskChanged: () => {} });
  await service.initialize();
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    try {
      let result: unknown;
      if (request.op === 'start') result = await service.start({
        ownerThreadId: owner, sourceTurnId: turn, sourceItemId: request.id.toString(),
        producer: 'bash', description: request.description ?? 'tmux experiment',
        command: request.command, cwd: path.join(root, request.control ? 'control' : 'work'), env: process.env,
        timeoutMs: 90_000, backgroundEnabled: Boolean(request.background),
        ...(request.sandbox ? { sandbox: { writablePaths: [path.join(root, 'work')] } } : {}),
      });
      else if (request.op === 'read') result = store.read(request.taskId);
      else if (request.op === 'output') result = await service.output(request.taskId, owner, 4096);
      else if (request.op === 'stop') result = await service.stop(request.taskId, owner);
      else if (request.op === 'terminal') result = await service.waitForTerminal(request.taskId, owner, 10_000);
      else if (request.op === 'close') { await service.close(2500); db.close(); result = true; }
      else throw new Error('Unknown probe operation');
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
      if (request.op === 'close') process.exit(0);
    } catch (error) { process.stdout.write(JSON.stringify({ id: request.id, error: String(error) }) + '\n'); }
  }
  process.exit(0);
}

const tmux = await realpath(process.argv[2] ?? '');
if (process.platform !== 'darwin') throw new Error('This experiment records the macOS backend only');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tenon-tmux-')));
await mkdir(path.join(root, 'work'));
await mkdir(path.join(root, 'control'));
const reportPath = path.resolve(process.argv[3] ?? path.join(root, 'report.json'));
let serial = 0;
let control = false;
let host: ChildProcessWithoutNullStreams;
let ready: Promise<void>;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const sockets: string[] = [];
const commands: unknown[] = [];
const observations: Record<string, unknown> = { platform: process.platform, root, binary: tmux,
  supervisorRuntime: process.env.TENON_PROBE_ELECTRON ?? 'bun source runtime',
  binarySha256: createHash('sha256').update(await readFile(tmux)).digest('hex') };
function openHost() {
  host = spawn(process.execPath, [import.meta.path, '--host', root], { stdio: 'pipe' });
  const child = host;
  ready = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Probe Host readiness deadline')), 15_000);
    const failed = () => {
      clearTimeout(deadline);
      reject(new Error('Probe Host exited'));
      for (const waiter of pending.values()) waiter.reject(new Error('Probe Host exited'));
      pending.clear();
    };
    child.once('error', failed);
    child.once('close', failed);
    createInterface({ input: host.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.ready) { clearTimeout(deadline); resolve(); return; }
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.result);
    });
  });
  host.stdin.on('error', () => {});
  host.stderr.on('data', (data) => process.stderr.write(data));
}
async function rpc(op: string, data: Record<string, unknown> = {}): Promise<any> {
  await ready;
  if (host.exitCode !== null || host.signalCode !== null) throw new Error('Probe Host exited');
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Probe RPC deadline: ' + op)); }, 15_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); } });
    host.stdin.write(JSON.stringify({ op, id, ...data }) + '\n');
  });
}
async function run(command: string, extra: Record<string, unknown> = {}) {
  const task = await rpc('start', { command, control: control && !extra.background, ...extra }) as ToolTaskRecord;
  commands.push({ command, taskId: task.taskId, cwd: task.cwd, owner: task.ownerThreadId,
    context: task.executionContext, isolation: task.isolation, ...extra });
  if (extra.background) return { task, stdout: '', stderr: '' };
  const terminal = await rpc('terminal', { taskId: task.taskId });
  if (!terminal || terminal.state === 'running' || terminal.state === 'settling') throw new Error('Command did not settle');
  const output = await rpc('output', { taskId: task.taskId });
  return { task: terminal as ToolTaskRecord, ...output };
}
const client = (socket: string, args: string) => quote(tmux) + ' -N -S ' + quote(socket) + ' ' + args;
const exists = (pid: number) => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const socketFor = (name: string) => { const socket = path.join(root, 'work', name + '.sock'); sockets.push(socket); return socket; };
async function foreground(socket: string, sandbox = false) {
  const result = await run('exec ' + quote(tmux) + ' -D -S ' + quote(socket) + ' -f /dev/null', { background: true, sandbox });
  for (let i = 0; i < 40; i++) {
    let check;
    try { check = await run(client(socket, 'show-options -g exit-empty')); }
    catch (error) {
      if (!String(error).includes('Execution scope is busy')) throw error;
      observations.sameDirectoryControl = { admitted: false, reason: String(error),
        diagnosticContinuation: 'Remaining clients use a separate control cwd in this Full Access fixture. No capability or worktree boundary is relaxed.' };
      control = true;
      check = await run(client(socket, 'show-options -g exit-empty'));
    }
    if (check.task.state === 'succeeded') return result.task;
    if ((await rpc('read', { taskId: result.task.taskId })).state !== 'running') throw new Error('tmux server failed to start');
    await delay(50);
  }
  throw new Error('tmux server readiness deadline');
}
openHost();
try {
  const version = await run(quote(tmux) + ' -V');
  if (version.task.state !== 'succeeded') throw new Error('tmux version probe failed: ' + version.stderr);
  observations.version = version.stdout.trim();
  const detached = socketFor('detached');
  const detachedTask = await run(quote(tmux) + ' -S ' + quote(detached) + ' -f /dev/null new-session -d -s detached ' + quote('sleep 90'));
  if (detachedTask.task.state !== 'succeeded') throw new Error('Detached tmux launch failed: ' + detachedTask.stderr);
  const detachedStatus = await run(client(detached, "display-message -p '#{pid}'"));
  await rpc('stop', { taskId: detachedTask.task.taskId });
  observations.detachedLifecycle = { taskState: detachedTask.task.state,
    serverPid: Number(detachedStatus.stdout.trim()),
    stoppedWithTask: !exists(Number(detachedStatus.stdout.trim())) };
  await run(client(detached, 'kill-server'));

  const socket = socketFor('owned');
  const name = 'tenon-' + createHash('sha256').update(JSON.stringify([owner, path.join(root, 'work'), null])).digest('hex').slice(0, 16);
  const server = await foreground(socket);
  const session = 'new-session -d -c ' + quote(path.join(root, 'work')) + ' -s ' + quote(name) + ' ' + quote('/bin/sh -c \'printf "READY\\n"; while IFS= read -r line; do printf "REPLY:%s\\n" "$line"; done\'');
  await run(client(socket, session));
  const duplicate = await run(client(socket, session));
  const identity = (await run(client(socket, "display-message -p '#{pid}:#{pane_pid}:#{session_name}'"))).stdout.trim();
  observations.duplicate = { rejected: duplicate.task.state === 'failed', identity,
    sessionCount: (await run(client(socket, 'list-sessions -F "#{session_name}"'))).stdout.trim().split('\n').length };
  const before = await run(client(socket, 'capture-pane -p -S -20'));
  await run(client(socket, 'send-keys -t ' + quote(name) + " -l 'alpha'"));
  await run(client(socket, 'send-keys -t ' + quote(name) + ' Enter'));
  const after = await run(client(socket, 'capture-pane -p -S -20'));
  observations.inputCapture = { accepted: after.stdout.includes('REPLY:alpha'),
    frozenEarlierCapture: (await rpc('output', { taskId: before.task.taskId })).stdout === before.stdout,
    beforeTaskId: before.task.taskId, afterTaskId: after.task.taskId,
    captureBytes: Buffer.byteLength(after.stdout), bounded: Buffer.byteLength(after.stdout) <= 4096 };

  await run(client(socket, 'new-window -d -n flood ' + quote('seq 1 10000; printf FLOOD-END; sleep 90')));
  await delay(150);
  const bounded = await run(client(socket, 'capture-pane -p -t ' + quote(name + ':flood') + ' -S -20'));
  observations.highVolumeCapture = { generated: bounded.stdout.includes('FLOOD-END'),
    bytes: Buffer.byteLength(bounded.stdout), bounded: Buffer.byteLength(bounded.stdout) <= 4096,
    frozenEarlierCapture: (await rpc('output', { taskId: before.task.taskId })).stdout === before.stdout,
    paneOutputInSupervisorCapture: (await readFile(path.join(server.detailPath, 'stdout.log'), 'utf8')).includes('REPLY:alpha') };
  const originalPid = server.childPid;
  host.kill('SIGKILL');
  await new Promise<void>((resolve) => host.once('close', () => resolve()));
  openHost(); await ready;
  const recovered = await rpc('read', { taskId: server.taskId });
  const identityAfter = (await run(client(socket, "display-message -p '#{pid}:#{pane_pid}:#{session_name}'"))).stdout.trim();
  observations.crashRecovery = { taskId: recovered.taskId, state: recovered.state,
    sameTaskAndProcess: recovered.taskId === server.taskId && recovered.childPid === originalPid && identity === identityAfter,
    priorCaptureRetained: (await rpc('output', { taskId: before.task.taskId })).stdout === before.stdout };
  await rpc('stop', { taskId: server.taskId });
  const stopped = await rpc('terminal', { taskId: server.taskId });
  await delay(200);
  const absent = await run(client(socket, 'has-session -t ' + quote(name)));
  observations.stop = { state: stopped.state, serverAbsent: absent.task.state === 'failed',
    paneAbsent: !exists(Number(identity.split(':')[1])), clientDidNotRestartServer: !exists(Number(identity.split(':')[0])) };
  const reopened = await foreground(socket);
  await run(client(socket, session));
  observations.explicitReopen = { newTask: reopened.taskId !== server.taskId,
    oneSession: (await run(client(socket, 'list-sessions -F "#{session_name}"'))).stdout.trim() === name };
  await run(client(socket, 'kill-server'));
  await rpc('terminal', { taskId: reopened.taskId });

  const isolatedSocket = socketFor('isolated');
  const isolated = await foreground(isolatedSocket, true);
  const outside = path.join(root, 'denied.txt');
  const inner = 'printf allowed > inside.txt; printf denied > ' + quote(outside) + '; sleep 5';
  const isolatedCreation = await run(client(isolatedSocket, 'new-session -d -c ' + quote(path.join(root, 'work')) + ' -s isolated ' + quote(inner)));
  if (isolatedCreation.task.state === 'succeeded') {
    await delay(150);
    const denied = await run(client(isolatedSocket, 'capture-pane -p -S -20'));
    observations.isolatedPane = { created: true, isolation: isolated.isolation,
      insideAllowed: await readFile(path.join(root, 'work', 'inside.txt'), 'utf8').then((value) => value === 'allowed', () => false),
      outsideDenied: await readFile(outside).then(() => false, () => true), capture: denied.stdout };
  } else {
    observations.isolatedPane = { created: false, isolation: isolated.isolation, error: isolatedCreation.stderr,
      containmentMeasurement: 'Pane creation failed under the required profile; pane writes could not be exercised. The profile was not widened and no unrestricted fallback ran.' };
  }
  await rpc('stop', { taskId: isolated.taskId });
  observations.isolatedStop = (await rpc('terminal', { taskId: isolated.taskId })).state;
} catch (error) {
  observations.error = String(error);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) {
    const cleanup = spawn(tmux, ['-N', '-S', socket, 'kill-server'], { stdio: 'ignore' });
    await new Promise((resolve) => { cleanup.once('error', resolve); cleanup.once('close', resolve); });
  }
  await rpc('close').catch(() => host.kill('SIGKILL'));
  await writeFile(reportPath, JSON.stringify({ observations, commands }, null, 2) + '\n');
  console.log(JSON.stringify({ reportPath, observations }, null, 2));
}
