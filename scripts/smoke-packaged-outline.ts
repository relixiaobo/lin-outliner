import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, readFile, readdir, rm, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Operation, OutlineResponse, RuntimeDescriptor, RuntimeStatus } from '../src/outline/contract';
import { readOutlineRuntimeDescriptor } from '../src/outline/client';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dir, '..');
const appBundle = path.resolve(process.argv[2] ?? path.join(repoRoot, 'release', 'mac-arm64', 'Tenon.app'));
const contentsRoot = path.join(appBundle, 'Contents');
const resourcesRoot = path.join(contentsRoot, 'Resources');
const appExecutable = path.join(contentsRoot, 'MacOS', 'Tenon');
const outlineRoot = path.join(resourcesRoot, 'outline');
const outlineLauncher = path.join(outlineRoot, 'bin', 'outline');
const cliBundle = path.join(outlineRoot, 'outline.mjs');
const runtimeBundle = path.join(outlineRoot, 'outline-runtime.mjs');
const skillPaths = [
  path.join(resourcesRoot, 'built-in-skills', 'outline', 'SKILL.md'),
] as const;
const userData = mkdtempSync(path.join(tmpdir(), 'outline-packaged-lifecycle-'));
const runtimeRoot = path.join(userData, 'outline-runtime');
const environment = packagedEnvironment(userData);

let firstDesktop: PackagedDesktop | null = null;
let secondDesktop: PackagedDesktop | null = null;
let report: Record<string, unknown> | null = null;

try {
  stage('verify packaged resources');
  await verifyPackagedResources();

  stage('verify local CLI commands without Runtime');
  const version = await runCli(['--json', 'version']);
  const schema = await runCli(['--json', 'schema', 'Selector']);
  const capabilities = await runCli(['--json', 'capabilities']);
  const help = await runCli(['--json', 'search', 'create', '--help']);
  if (await readOutlineRuntimeDescriptor(runtimeRoot)) {
    throw new Error('Local-only CLI commands unexpectedly started Outline Runtime.');
  }
  assertRecord(parseCliData(version.stdout, 'version'), 'version result');
  const selectorSchema = parseCliData(schema.stdout, 'schema') as {
    $defs?: { Selector?: { $id?: unknown } };
  };
  if (selectorSchema.$defs?.Selector?.$id !== 'Selector') {
    throw new Error('The packaged CLI did not return the public Selector schema.');
  }
  const capabilityData = parseCliData(capabilities.stdout, 'capabilities');
  if (!Array.isArray(capabilityData)
    || !['find', 'apply', 'watch'].every((name) => capabilityData.some((entry) => (
      isRecord(entry) && entry.name === name
    )))) {
    throw new Error('The packaged CLI capability registry is incomplete.');
  }
  if (!help.stdout.includes('--match TEXT')
    || !help.stdout.includes('--input FILE|-')
    || !help.stdout.includes('outline search create --title "Modules" --match "module"')
    || help.stdout.trimStart().startsWith('{')) {
    throw new Error('The packaged CLI did not preserve exact plain-text command help.');
  }

  stage('launch first desktop');
  const first = await launchDesktop();
  firstDesktop = first;
  stage('inspect first desktop Runtime identity');
  const firstDescriptor = await waitForDescriptor();
  const firstMain = await packagedMainConfiguration(first.inspector);
  assertPackagedMainConfiguration(firstMain);
  if (firstDescriptor.pid === firstMain.pid) {
    throw new Error('Packaged desktop owns Outline Runtime in-process instead of as a standalone writer.');
  }

  const firstCliStatus = cliStatus(await runCli(['--json', 'status']));
  stage('request first desktop status');
  assertRuntimeIdentity(firstCliStatus, firstDescriptor, 'initial CLI status');
  const firstDesktopStatus = desktopStatus(await desktopRequest(first.renderer, 'status', {}));
  assertSameRuntimeStatus(firstCliStatus, firstDesktopStatus, 'desktop and CLI initial status');

  stage('settle shared CLI mutation');
  const mutation = await runCli([
    '--json', 'add', '--parent', '@today', 'Packaged lifecycle shared mutation',
  ]);
  const operation = parseCliData(mutation.stdout, 'add') as Operation;
  if (operation.kind !== 'outline.operation') {
    throw new Error('The packaged CLI mutation did not settle as one public Operation.');
  }
  stage('compare post-mutation desktop and CLI status');
  const cliStatusAfterMutation = cliStatus(await runCli(['--json', 'status']));
  const desktopStatusAfterMutation = desktopStatus(await desktopRequest(first.renderer, 'status', {}));
  assertSameRuntimeStatus(
    cliStatusAfterMutation,
    desktopStatusAfterMutation,
    'desktop and CLI status after mutation',
  );
  if (runtimeRevision(cliStatusAfterMutation) !== operation.revisionAfter) {
    throw new Error('Packaged CLI Operation and live Runtime revision diverged.');
  }
  stage('verify first desktop sees CLI mutation');
  await assertDesktopSeesMutation(first.renderer);

  stage('quit first desktop without stopping Runtime');
  await quitDesktop(first);
  firstDesktop = null;
  const afterFirstClose = await waitForDescriptor();
  assertSameDescriptor(firstDescriptor, afterFirstClose, 'desktop close');

  stage('reopen desktop against existing Runtime');
  const second = await launchDesktop();
  secondDesktop = second;
  stage('inspect reopened desktop Runtime identity');
  const reopenedDescriptor = await waitForDescriptor();
  assertSameDescriptor(firstDescriptor, reopenedDescriptor, 'desktop reopen');
  const secondMain = await packagedMainConfiguration(second.inspector);
  assertPackagedMainConfiguration(secondMain);
  stage('compare reopened desktop and CLI status');
  const reopenedDesktopStatus = desktopStatus(await desktopRequest(second.renderer, 'status', {}));
  const reopenedCliStatus = cliStatus(await runCli(['--json', 'status']));
  assertSameRuntimeStatus(reopenedCliStatus, reopenedDesktopStatus, 'reopened desktop and CLI status');
  assertRuntimeIdentity(reopenedCliStatus, firstDescriptor, 'reopened CLI status');
  stage('verify reopened desktop sees persisted mutation');
  await assertDesktopSeesMutation(second.renderer);

  stage('quit reopened desktop without stopping Runtime');
  await quitDesktop(second);
  secondDesktop = null;
  const afterSecondClose = await waitForDescriptor();
  assertSameDescriptor(firstDescriptor, afterSecondClose, 'second desktop close');

  stage('stop owned standalone Runtime');
  await stopOwnedRuntime(firstDescriptor);

  report = {
    smoke: 'packaged-outline-lifecycle',
    generatedAt: new Date().toISOString(),
    appBundle,
    resources: {
      launcher: outlineLauncher,
      cliBundle,
      runtimeBundle,
    },
    localCommandsWithoutRuntime: ['version', 'schema Selector', 'capabilities'],
    runtime: {
      pid: firstDescriptor.pid,
      instanceId: firstDescriptor.instanceId,
      revision: runtimeRevision(reopenedCliStatus),
      transactionSequence: runtimeSequence(reopenedCliStatus),
      separateFromDesktop: true,
      survivedDesktopRestart: true,
      stoppedCleanly: true,
    },
    desktop: {
      firstPid: firstMain.pid,
      reopenedPid: secondMain.pid,
      sharedMutationOperationId: operation.operationId,
    },
    skills: skillPaths.map((skillPath) => ({
      name: path.basename(path.dirname(skillPath)),
      execution: 'isolated',
      cliLauncher: outlineLauncher,
    })),
  };
} finally {
  if (firstDesktop) await exitDesktopForCleanup(firstDesktop).catch(() => undefined);
  if (secondDesktop) await exitDesktopForCleanup(secondDesktop).catch(() => undefined);
  const descriptor = await readOutlineRuntimeDescriptor(runtimeRoot).catch(() => null);
  if (descriptor) await stopOwnedRuntime(descriptor).catch(() => undefined);
  await makeTreeWritable(userData).catch(() => undefined);
  await rm(userData, { recursive: true, force: true });
}

if (!report) throw new Error('Packaged Outline lifecycle smoke did not produce a report.');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function verifyPackagedResources(): Promise<void> {
  const [launcherStat, appStat, cliStat, runtimeStat, ...skills] = await Promise.all([
    stat(outlineLauncher),
    stat(appExecutable),
    stat(cliBundle),
    stat(runtimeBundle),
    ...skillPaths.map((skillPath) => readFile(skillPath, 'utf8')),
  ]);
  for (const [label, value] of [
    ['launcher', launcherStat],
    ['app executable', appStat],
    ['CLI bundle', cliStat],
    ['Runtime bundle', runtimeStat],
  ] as const) {
    if (!value.isFile()) throw new Error(`Packaged ${label} is not a regular file.`);
  }
  if (process.platform !== 'win32' && (launcherStat.mode & 0o111) === 0) {
    throw new Error('Packaged outline launcher is not executable.');
  }
  for (const [index, source] of skills.entries()) {
    if (!/^execution:\s*isolated\s*$/m.test(source)) {
      throw new Error(`${skillPaths[index]} does not declare execution: isolated.`);
    }
    if (!/\boutline(?:\s|`)/.test(source)) {
      throw new Error(`${skillPaths[index]} does not invoke the shared outline command.`);
    }
  }
  const [cliSource, runtimeSource] = await Promise.all([
    readFile(cliBundle, 'utf8'),
    readFile(runtimeBundle, 'utf8'),
  ]);
  for (const [label, source] of [['CLI', cliSource], ['Runtime', runtimeSource]] as const) {
    if (/(?:from\s+|require\()["']electron["']/.test(source) || source.includes('src/renderer/')) {
      throw new Error(`Packaged ${label} bundle imports an Electron or renderer surface.`);
    }
  }
}

interface PackagedDesktop {
  readonly child: ChildProcess;
  readonly renderer: RendererClient;
  readonly inspector: CdpClient;
  readonly logs: string[];
}

async function launchDesktop(): Promise<PackagedDesktop> {
  const child = spawn(appExecutable, [
    '--inspect=0',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
  ], {
    cwd: repoRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  captureProcessOutput(child, logs);
  let inspector: CdpClient | null = null;
  let devtools: CdpClient | null = null;
  try {
    const [inspectorUrl, devtoolsUrl] = await Promise.all([
      waitForProcessOutput(child, /^Debugger listening on (ws:\/\/\S+)/m, 'Node inspector'),
      waitForProcessOutput(child, /^DevTools listening on (ws:\/\/\S+)/m, 'Chromium DevTools'),
    ]);
    inspector = await CdpClient.connect(inspectorUrl, 'Node inspector');
    await inspector.request('Runtime.enable', {});
    devtools = await CdpClient.connect(devtoolsUrl, 'Chromium DevTools');
    const renderer = await RendererClient.connect(devtools);
    await waitFor(async () => renderer.evaluate<boolean>(
      'Boolean(document.querySelector("#root") && window.lin?.outline?.request)',
    ), 60_000, 'Packaged main renderer bridge');
    return { child, renderer, inspector, logs };
  } catch (error) {
    if (inspector) {
      await withTimeout(inspector.evaluate(`(() => {
        const electron = require('electron');
        setTimeout(() => electron.app.exit(1), 0);
        return true;
      })()`), 2_000, 'Packaged desktop failed-launch exit dispatch').catch(() => undefined);
      inspector.close();
      await withTimeout(processExitSignal(child), 5_000, 'Packaged desktop failed-launch cleanup').catch(() => undefined);
    }
    devtools?.close();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${logs.slice(-20).join('\n')}`,
      { cause: error },
    );
  }
}

async function quitDesktop(desktop: PackagedDesktop): Promise<void> {
  const exited = processExitSignal(desktop.child);
  await withTimeout(desktop.inspector.evaluate(`(() => {
    const electron = require('electron');
    setTimeout(() => electron.app.quit(), 0);
    return true;
  })()`), 2_000, 'Packaged desktop quit dispatch');
  desktop.inspector.close();
  await withTimeout(exited, 20_000, 'Packaged desktop graceful quit');
  desktop.renderer.close();
}

async function exitDesktopForCleanup(desktop: PackagedDesktop): Promise<void> {
  const exited = processExitSignal(desktop.child);
  await withTimeout(desktop.inspector.evaluate(`(() => {
    const electron = require('electron');
    setTimeout(() => electron.app.exit(1), 0);
    return true;
  })()`), 2_000, 'Packaged desktop cleanup exit dispatch').catch(() => undefined);
  desktop.inspector.close();
  await withTimeout(exited, 5_000, 'Packaged desktop cleanup exit');
  desktop.renderer.close();
}

interface PackagedMainConfiguration {
  pid: number;
  readonly cliEntry?: string;
  readonly runtimeEntry?: string;
  readonly importAdapterEntry?: string;
  readonly cliRuntime?: string;
  readonly runAsNode?: string;
  readonly packaged?: string;
  readonly extraToolPath?: string;
}

async function packagedMainConfiguration(inspector: CdpClient): Promise<PackagedMainConfiguration> {
  const serialized = await withTimeout(inspector.evaluate<string>(`JSON.stringify({
    pid: process.pid,
    cliEntry: process.env.TENON_OUTLINE_CLI_ENTRY,
    runtimeEntry: process.env.TENON_OUTLINE_RUNTIME_ENTRY,
    importAdapterEntry: process.env.TENON_OUTLINE_IMPORT_ADAPTER_ENTRY,
    cliRuntime: process.env.TENON_OUTLINE_CLI_RUNTIME,
    runAsNode: process.env.TENON_OUTLINE_RUN_AS_NODE,
    packaged: process.env.TENON_OUTLINE_PACKAGED,
    extraToolPath: process.env.LIN_AGENT_EXTRA_TOOL_PATH,
  })`), 15_000, 'Packaged main configuration');
  return JSON.parse(serialized) as PackagedMainConfiguration;
}

function assertPackagedMainConfiguration(config: Awaited<ReturnType<typeof packagedMainConfiguration>>): void {
  const expectedImportAdapter = path.join(
    resourcesRoot,
    'built-in-skills',
    'outline',
    'scripts',
    'source-adapters.mjs',
  );
  const toolPath = (config.extraToolPath ?? '').split(path.delimiter).filter(Boolean);
  if (config.cliEntry !== cliBundle
    || config.runtimeEntry !== runtimeBundle
    || config.importAdapterEntry !== expectedImportAdapter
    || config.cliRuntime !== appExecutable
    || config.runAsNode !== '1'
    || config.packaged !== '1'
    || toolPath[0] !== path.dirname(outlineLauncher)) {
    throw new Error(`Packaged main configured a different Outline toolchain: ${JSON.stringify(config)}`);
  }
}

async function runCli(args: readonly string[]) {
  return execFile(outlineLauncher, [...args], {
    cwd: repoRoot,
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
}

async function desktopRequest(
  renderer: RendererClient,
  command: string,
  input: unknown,
): Promise<OutlineResponse> {
  const request = JSON.stringify({
    requestId: `packaged-smoke:${crypto.randomUUID()}`,
    command,
    input,
  });
  return withTimeout(renderer.evaluate<OutlineResponse>(
    `(async () => window.lin.outline.request(${request}))()`,
  ), 15_000, `Desktop ${command} request`);
}

async function assertDesktopSeesMutation(renderer: RendererClient): Promise<void> {
  const selector = {
    by: 'query' as const,
    query: { kind: 'rule' as const, op: 'STRING_MATCH' as const, text: 'Packaged lifecycle shared mutation' },
    order: 'document' as const,
    limit: 1,
  };
  const target = { selector, cardinality: 'many' as const, max: 1 };
  const response = await desktopRequest(renderer, 'find', {
    target,
    projection: {
      kind: 'summary',
      targets: { target },
      page: { limit: 1 },
    },
  });
  if (!response.ok) throw new Error(`Desktop find failed: ${response.error.message}`);
  const result = response.data as { nodes?: Array<{ text?: unknown }> };
  if (result.nodes?.[0]?.text !== 'Packaged lifecycle shared mutation') {
    throw new Error('Desktop did not observe the CLI mutation through the shared Runtime.');
  }
}

function cliStatus(result: Awaited<ReturnType<typeof runCli>>): RuntimeStatus {
  return requireLiveStatus(parseCliData(result.stdout, 'status'), 'CLI status');
}

function desktopStatus(response: OutlineResponse): RuntimeStatus {
  if (!response.ok) throw new Error(`Desktop status failed: ${response.error.message}`);
  return requireLiveStatus(response.data, 'desktop status');
}

function requireLiveStatus(value: unknown, label: string): RuntimeStatus {
  if (!isRecord(value) || value.running !== true || !isRecord(value.runtime)) {
    throw new Error(`${label} did not return a live Runtime status.`);
  }
  return value as RuntimeStatus;
}

function parseCliData(stdout: string, command: string): unknown {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!isRecord(parsed) || parsed.ok !== true || parsed.command !== command || !('data' in parsed)) {
    throw new Error(`outline ${command} returned an unexpected response: ${stdout.trim()}`);
  }
  return parsed.data;
}

function assertRuntimeIdentity(status: RuntimeStatus, descriptor: RuntimeDescriptor, label: string): void {
  if (!status.running || status.runtime.instanceId !== descriptor.instanceId) {
    throw new Error(`${label} does not belong to descriptor ${descriptor.instanceId}.`);
  }
}

function assertSameRuntimeStatus(left: RuntimeStatus, right: RuntimeStatus, label: string): void {
  if (!left.running || !right.running
    || left.runtime.instanceId !== right.runtime.instanceId
    || left.runtime.revision !== right.runtime.revision
    || left.runtime.transactionLog.sequence !== right.runtime.transactionLog.sequence
    || left.runtime.transactionLog.eventSequence !== right.runtime.transactionLog.eventSequence) {
    throw new Error(`${label} diverged: ${JSON.stringify({ left, right })}`);
  }
}

function assertSameDescriptor(expected: RuntimeDescriptor, actual: RuntimeDescriptor, label: string): void {
  if (expected.pid !== actual.pid || expected.instanceId !== actual.instanceId) {
    throw new Error(`${label} replaced the Runtime writer: ${JSON.stringify({ expected, actual })}`);
  }
}

async function waitForDescriptor(): Promise<RuntimeDescriptor> {
  return waitFor(async () => readOutlineRuntimeDescriptor(runtimeRoot), 15_000, 'Runtime descriptor');
}

async function stopOwnedRuntime(expected: RuntimeDescriptor): Promise<void> {
  const current = await readOutlineRuntimeDescriptor(runtimeRoot);
  if (!current) return;
  assertSameDescriptor(expected, current, 'Runtime cleanup identity check');
  process.kill(current.pid, 'SIGTERM');
  await waitFor(async () => {
    const descriptor = await readOutlineRuntimeDescriptor(runtimeRoot);
    return descriptor === null && !processIsAlive(current.pid) ? true : null;
  }, 15_000, 'Runtime shutdown');
}

async function waitFor<T>(
  read: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not become available within ${timeoutMs} ms.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

function runtimeRevision(status: RuntimeStatus): number {
  if (!status.running) throw new Error('Runtime status is not live.');
  return status.runtime.revision;
}

function runtimeSequence(status: RuntimeStatus): number {
  if (!status.running) throw new Error('Runtime status is not live.');
  return status.runtime.transactionLog.sequence;
}

function packagedEnvironment(userDataDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'ELECTRON_RUN_AS_NODE'
      || key === 'ELECTRON_USER_DATA_DIR'
      || key === 'LIN_AGENT_EXTRA_TOOL_PATH'
      || key === 'NODE_OPTIONS'
      || key.startsWith('TENON_OUTLINE_')) continue;
    env[key] = value;
  }
  env.ELECTRON_USER_DATA_DIR = userDataDir;
  env.TENON_OUTLINE_RUNTIME_IDLE_MS = '300000';
  return env;
}

function captureProcessOutput(child: ChildProcess, logs: string[]): void {
  const capture = (label: string, chunk: string | Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) logs.push(`${label}: ${line}`);
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  child.stdout?.on('data', (chunk: string | Buffer) => capture('stdout', chunk));
  child.stderr?.on('data', (chunk: string | Buffer) => capture('stderr', chunk));
}

async function waitForProcessOutput(
  child: ChildProcess,
  pattern: RegExp,
  label: string,
): Promise<string> {
  const stream = child.stderr;
  if (!stream) throw new Error(`Packaged desktop has no stderr for ${label} discovery.`);
  const found = new Promise<string>((resolve, reject) => {
    let buffered = '';
    const cleanup = () => {
      stream.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onData = (chunk: string | Buffer) => {
      buffered += chunk.toString();
      const match = pattern.exec(buffered);
      if (!match?.[1]) return;
      cleanup();
      resolve(match[1]);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Packaged desktop exited before ${label} discovery (${code ?? signal ?? 'unknown'}).`));
    };
    stream.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return withTimeout(found, 30_000, `${label} discovery`);
}

function processExitSignal(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

interface CdpResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  }>();

  private constructor(
    private readonly socket: WebSocket,
    private readonly label: string,
  ) {
    socket.addEventListener('message', (event) => this.receive(event));
    socket.addEventListener('close', () => this.rejectPending(new Error(`${label} disconnected.`)));
    socket.addEventListener('error', () => this.rejectPending(new Error(`${label} transport failed.`)));
  }

  static async connect(url: string, label: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await withTimeout(new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`${label} connection failed.`)), { once: true });
    }), 10_000, `${label} connection`);
    return new CdpClient(socket, label);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.request('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    }) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? 'Node inspector evaluation failed.',
      );
    }
    return response.result?.value as T;
  }

  close(): void {
    this.socket.close();
    this.rejectPending(new Error('Node inspector closed.'));
  }

  request(method: string, params: unknown, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return result;
  }

  private receive(event: MessageEvent): void {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data) as CdpResponse;
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? `${this.label} request failed.`));
    else pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class RendererClient {
  private constructor(
    private readonly devtools: CdpClient,
    private readonly sessionId: string,
  ) {}

  static async connect(devtools: CdpClient): Promise<RendererClient> {
    const targetId = await waitFor(async () => {
      const result = await devtools.request('Target.getTargets', {}) as {
        targetInfos?: Array<{ targetId?: string; type?: string; url?: string }>;
      };
      return result.targetInfos?.find((target) => (
        target.type === 'page'
        && typeof target.targetId === 'string'
        && target.url?.includes('/index.html')
      ))?.targetId ?? null;
    }, 60_000, 'Packaged main renderer target');
    const attached = await devtools.request('Target.attachToTarget', {
      targetId,
      flatten: true,
    }) as { sessionId?: string };
    if (!attached.sessionId) throw new Error('Chromium DevTools did not attach to the main renderer target.');
    return new RendererClient(devtools, attached.sessionId);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.devtools.request('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, this.sessionId) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? 'Renderer evaluation failed.',
      );
    }
    return response.result?.value as T;
  }

  close(): void {
    this.devtools.close();
  }
}

async function makeTreeWritable(root: string): Promise<void> {
  const value = await lstat(root).catch(() => null);
  if (!value) return;
  if (value.isSymbolicLink()) return;
  if (!value.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) await makeTreeWritable(path.join(root, entry.name));
}

function stage(message: string): void {
  process.stderr.write(`packaged-outline-smoke: ${message}\n`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
