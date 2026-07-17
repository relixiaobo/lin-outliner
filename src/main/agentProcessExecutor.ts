import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  createFolderCapabilitySnapshot,
  isPathInside,
  snapshotFromRoots,
  type FolderCapabilityProtectedRoot,
  type FolderCapabilitySnapshot,
} from './agentFolderCapabilities';
import type { FolderCapabilityService } from './agentFolderCapabilities';

export interface AgentProcessSpawnInput {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  privateEnvKeys?: readonly string[];
  capabilities: FolderCapabilitySnapshot;
  detached?: boolean;
  stdio?: SpawnOptions['stdio'];
  windowsHide?: boolean;
}

interface ActiveAgentProcess {
  child: ChildProcess;
  capabilities: FolderCapabilitySnapshot;
}

export interface AgentProcessSandboxAdapter {
  prepare(input: Required<Pick<AgentProcessSpawnInput, 'command' | 'cwd'>> & {
    args: readonly string[];
    capabilities: FolderCapabilitySnapshot;
  }): Promise<{ command: string; args: string[] }>;
}

export class MacOSFileSandboxAdapter implements AgentProcessSandboxAdapter {
  private probe: Promise<void> | null = null;

  async prepare(input: Required<Pick<AgentProcessSpawnInput, 'command' | 'cwd'>> & {
    args: readonly string[];
    capabilities: FolderCapabilitySnapshot;
  }): Promise<{ command: string; args: string[] }> {
    if (process.platform !== 'darwin') return { command: input.command, args: [...input.args] };
    await this.ensureAvailable(input.cwd);
    const profile = macOSSeatbeltProfile(input.capabilities);
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', profile, input.command, ...input.args],
    };
  }

  private async ensureAvailable(cwd: string): Promise<void> {
    this.probe ??= probeMacOSSandbox(cwd).catch((error) => {
      this.probe = null;
      throw error;
    });
    return this.probe;
  }
}

export class AgentProcessExecutor {
  private readonly active = new Map<number, ActiveAgentProcess>();
  private revocationGenerationProvider: (() => number) | null = null;
  private controlPlaneProtections: readonly FolderCapabilityProtectedRoot[] = [];

  constructor(private readonly sandbox: AgentProcessSandboxAdapter = new MacOSFileSandboxAdapter()) {}

  async spawn(input: AgentProcessSpawnInput): Promise<ChildProcess> {
    const cwd = path.resolve(input.cwd);
    const capabilities = input.capabilities.filesystemMode === 'restricted'
      ? this.withControlPlaneProtection(input.capabilities)
      : input.capabilities;
    this.assertCurrentSnapshot(capabilities);
    const prepared = capabilities.filesystemMode === 'restricted'
      ? await this.sandbox.prepare({
          command: input.command,
          args: input.args ?? [],
          cwd,
          capabilities,
        })
      : { command: input.command, args: [...(input.args ?? [])] };
    this.assertCurrentSnapshot(capabilities);
    const child = spawn(prepared.command, prepared.args, {
      cwd,
      env: sanitizeAgentProcessEnv(input.env ?? process.env, input.privateEnvKeys),
      shell: false,
      stdio: input.stdio ?? ['ignore', 'pipe', 'pipe'],
      detached: input.detached,
      windowsHide: input.windowsHide,
    });
    if (child.pid) {
      this.active.set(child.pid, { child, capabilities });
      const release = () => {
        if (child.pid) this.active.delete(child.pid);
      };
      child.once('close', release);
      child.once('error', release);
    }
    return child;
  }

  async spawnShell(input: Omit<AgentProcessSpawnInput, 'command' | 'args'> & { command: string }): Promise<ChildProcess> {
    if (process.platform === 'win32') {
      return this.spawn({ ...input, command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', input.command] });
    }
    const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    return this.spawn({ ...input, command: shell, args: ['-c', input.command] });
  }

  terminate(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    terminateProcessTree(child, signal);
  }

  bindRevocationGeneration(provider: () => number): () => void {
    this.revocationGenerationProvider = provider;
    return () => {
      if (this.revocationGenerationProvider === provider) this.revocationGenerationProvider = null;
    };
  }

  bindControlPlaneProtections(protections: readonly FolderCapabilityProtectedRoot[]): () => void {
    const boundProtections = snapshotFromRoots([], [], protections).protectedRoots;
    this.controlPlaneProtections = boundProtections;
    return () => {
      if (this.controlPlaneProtections === boundProtections) this.controlPlaneProtections = [];
    };
  }

  async terminateProcessesUsingFolder(folderInput: string): Promise<void> {
    const folder = path.resolve(folderInput);
    const matches = [...this.active.values()].filter(({ capabilities }) => (
      capabilities.filesystemMode === 'restricted'
      && capabilities.roots.some((entry) => entry.origin === 'user' && (
        isPathInside(folder, entry.root) || isPathInside(entry.root, folder)
      ))
    ));
    await this.terminateActiveProcesses(matches);
  }

  async terminateAllProcesses(): Promise<void> {
    await this.terminateActiveProcesses([...this.active.values()]);
  }

  private async terminateActiveProcesses(processes: readonly ActiveAgentProcess[]): Promise<void> {
    await Promise.allSettled(processes.map(async ({ child }) => {
      terminateProcessTree(child, 'SIGTERM');
      await waitForExit(child, 1_000);
      if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child, 'SIGKILL');
    }));
  }

  private currentRevocationGeneration(): number {
    return this.revocationGenerationProvider?.() ?? 0;
  }

  private withControlPlaneProtection(capabilities: FolderCapabilitySnapshot): FolderCapabilitySnapshot {
    if (this.controlPlaneProtections.length === 0) return capabilities;
    const normalized = snapshotFromRoots(
      capabilities.roots,
      capabilities.deniedWrites,
      capabilities.protectedRoots,
      capabilities.revocationGeneration,
      capabilities.filesystemMode,
    );
    const controlPlaneProtections = this.controlPlaneProtections.map((protection) => {
      const declared = normalized.protectedRoots.find((entry) => path.resolve(entry.root) === path.resolve(protection.root));
      if (!declared) return protection;
      return {
        root: protection.root,
        readExceptions: intersectPathRoots(protection.readExceptions, declared.readExceptions),
        writeExceptions: intersectPathRoots(protection.writeExceptions, declared.writeExceptions),
      };
    });
    return {
      ...normalized,
      // Keep the application policy as the final Seatbelt rules. Combining it
      // through ordinary root compaction would let a broader caller root replace it.
      protectedRoots: [...normalized.protectedRoots, ...controlPlaneProtections],
    };
  }

  private assertCurrentSnapshot(capabilities: FolderCapabilitySnapshot): void {
    const current = this.currentRevocationGeneration();
    if (capabilities.revocationGeneration === current) return;
    throw new StaleFolderCapabilitySnapshotError(capabilities.revocationGeneration, current);
  }
}

function intersectPathRoots(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set(left.flatMap((leftRoot) => right.flatMap((rightRoot) => {
    if (isPathInside(leftRoot, rightRoot)) return [path.resolve(rightRoot)];
    if (isPathInside(rightRoot, leftRoot)) return [path.resolve(leftRoot)];
    return [];
  })))];
}

export class StaleFolderCapabilitySnapshotError extends Error {
  readonly code = 'stale_folder_capability_snapshot';

  constructor(readonly snapshotGeneration: number, readonly currentGeneration: number) {
    super('Folder capabilities changed before the process started. Retry the command with the current capability state.');
    this.name = 'StaleFolderCapabilitySnapshotError';
  }
}

let executor: AgentProcessExecutor | null = null;

export function getAgentProcessExecutor(): AgentProcessExecutor {
  executor ??= new AgentProcessExecutor();
  return executor;
}

export function bindAgentProcessCapabilities(
  service: FolderCapabilityService,
  controlPlaneProtections: readonly FolderCapabilityProtectedRoot[],
): () => void {
  const processExecutor = getAgentProcessExecutor();
  const unbindGeneration = processExecutor.bindRevocationGeneration(() => service.currentRevocationGeneration());
  const unbindControlPlaneProtections = processExecutor.bindControlPlaneProtections(controlPlaneProtections);
  const unsubscribeRevoked = service.onRevoked((folder) => processExecutor.terminateProcessesUsingFolder(folder));
  const unsubscribeMode = service.onFilesystemModeChanged(() => processExecutor.terminateAllProcesses());
  return () => {
    unsubscribeMode();
    unsubscribeRevoked();
    unbindControlPlaneProtections();
    unbindGeneration();
  };
}

export function resetAgentProcessExecutorForTests(): void {
  executor = null;
}

export function sanitizeAgentProcessEnv(
  input: NodeJS.ProcessEnv,
  privateEnvKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const privateKeys = new Set(privateEnvKeys.map((key) => key.toUpperCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || privateKeys.has(key.toUpperCase())) continue;
    result[key] = value;
  }
  return result;
}

export function macOSSeatbeltProfile(snapshot: FolderCapabilitySnapshot): string {
  const writeRules = snapshot.writeRoots.map((root) => `(subpath ${seatbeltString(root)})`).join(' ');
  const deniedWrites = snapshot.deniedWrites.map((entry) => (
    `(${entry.recursive ? 'subpath' : 'literal'} ${seatbeltString(entry.path)})`
  )).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    ...macOSReadDenyRules(snapshot.readRoots),
    ...protectedRootRules(snapshot, 'read'),
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") ${writeRules})`,
    ...protectedRootRules(snapshot, 'write'),
    ...(deniedWrites ? [`(deny file-write* ${deniedWrites})`] : []),
  ].join('\n');
}

async function probeMacOSSandbox(cwd: string): Promise<void> {
  if (!existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('macOS process sandbox is unavailable; agent processes are disabled.');
  }
  const capabilities = createFolderCapabilitySnapshot({
    filesystemMode: 'restricted',
    workspaceRoot: cwd,
    includeSystemRoots: true,
  }, []);
  const profile = macOSSeatbeltProfile(capabilities);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], {
      cwd,
      env: sanitizeAgentProcessEnv(process.env),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`macOS process sandbox health probe failed${stderr.trim() ? `: ${stderr.trim()}` : ` with exit code ${code}`}.`));
    });
  });
}

function seatbeltString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function macOSReadDenyRules(allowedRoots: readonly string[]): string[] {
  const containers = macOSUserDataContainers();
  const rules = containers.map((container) => `(deny file-read* (subpath ${seatbeltString(container)}))`);
  const exceptions = [...new Set(containers.flatMap((container) => allowedRoots.flatMap((root) => {
    if (isPathInside(container, root)) return [path.resolve(root)];
    if (isPathInside(root, container)) return [container];
    return [];
  })))];
  if (exceptions.length > 0) {
    rules.push(`(allow file-read* ${exceptions.map((root) => `(subpath ${seatbeltString(root)})`).join(' ')})`);
  }
  return rules;
}

function macOSUserDataContainers(): string[] {
  const result: string[] = [];
  for (const candidate of ['/Users', '/Volumes', homedir()]
    .filter(existsSync)
    .map((entry) => path.resolve(entry))
    .sort((left, right) => left.length - right.length)) {
    if (!result.some((root) => isPathInside(root, candidate))) result.push(candidate);
  }
  return result;
}

function protectedRootRules(
  snapshot: FolderCapabilitySnapshot,
  access: 'read' | 'write',
): string[] {
  const operation = access === 'read' ? 'file-read*' : 'file-write*';
  const rules: string[] = [];
  for (const protection of snapshot.protectedRoots) {
    rules.push(`(deny ${operation} (subpath ${seatbeltString(protection.root)}))`);
    const exceptions = access === 'read' ? protection.readExceptions : protection.writeExceptions;
    if (exceptions.length > 0) {
      rules.push(`(allow ${operation} ${exceptions.map((root) => `(subpath ${seatbeltString(root)})`).join(' ')})`);
    }
  }
  return rules;
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through when the process is not a group leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process can exit between lookup and termination.
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
