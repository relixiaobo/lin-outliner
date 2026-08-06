import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from './agent/capabilities/agentAttachmentMaterialization';
import type { AgentShellProcessEnvironment } from './agent/capabilities/agentLocalTools';
import { loadOrCreateInstallationId } from './installationIdentity';

export const BROWSER_PILOT_MANAGED_SKILL_ID = 'browser-pilot';
export const BROWSER_PILOT_INSTALL_ROOT_ENV = 'BROWSER_PILOT_INSTALL_ROOT';
export const BROWSER_PILOT_BIN_DIR_ENV = 'BROWSER_PILOT_BIN_DIR';
export const BROWSER_PILOT_CLIENT_KEY_ENV = 'BROWSER_PILOT_CLIENT_KEY';
export const BROWSER_PILOT_OUTPUT_DIR_ENV = 'BROWSER_PILOT_OUTPUT_DIR';

const PRIVATE_DIRECTORY_MODE = process.platform === 'win32' ? undefined : 0o700;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

export interface BrowserPilotHostOptions {
  userDataRoot: string;
  scratchRoot: string;
  loadInstallationId?: (userDataRoot: string) => Promise<string>;
}

export class BrowserPilotHost {
  readonly installRoot: string;
  readonly binDirectory: string;
  private readonly scratchRoot: string;
  private readonly userDataRoot: string;
  private readonly loadInstallationId: (userDataRoot: string) => Promise<string>;
  private installationId: string | null = null;
  private installationIdLoad: Promise<string> | null = null;

  constructor(options: BrowserPilotHostOptions) {
    this.userDataRoot = path.resolve(options.userDataRoot);
    this.scratchRoot = path.resolve(options.scratchRoot);
    this.installRoot = path.join(this.userDataRoot, 'browser-pilot');
    this.binDirectory = path.join(this.installRoot, 'bin');
    this.loadInstallationId = options.loadInstallationId ?? loadOrCreateInstallationId;
  }

  async processEnvironment(threadId: string, turnId: string): Promise<AgentShellProcessEnvironment> {
    await assertManagedCommandDirectory(this.installRoot, this.binDirectory);
    const [installationId, outputDirectory] = await Promise.all([
      this.installationIdentity(),
      prepareBrowserPilotOutputDirectory(this.scratchRoot, threadId, turnId),
    ]);
    return {
      env: {
        [BROWSER_PILOT_INSTALL_ROOT_ENV]: this.installRoot,
        [BROWSER_PILOT_BIN_DIR_ENV]: this.binDirectory,
        [BROWSER_PILOT_CLIENT_KEY_ENV]: browserPilotClientKey(installationId, threadId),
        [BROWSER_PILOT_OUTPUT_DIR_ENV]: outputDirectory,
      },
      leadingToolPathSegments: [this.binDirectory],
    };
  }

  private async installationIdentity(): Promise<string> {
    if (this.installationId !== null) return this.installationId;
    if (this.installationIdLoad) return this.installationIdLoad;
    const pending = this.loadInstallationId(this.userDataRoot).then((installationId) => {
      if (!installationId.trim()) throw new Error('Browser Pilot installation identity is empty.');
      this.installationId = installationId;
      return installationId;
    });
    this.installationIdLoad = pending;
    try {
      return await pending;
    } finally {
      if (this.installationIdLoad === pending) this.installationIdLoad = null;
    }
  }
}

export function browserPilotClientKey(installationId: string, threadId: string): string {
  if (!installationId.trim()) throw new Error('Browser Pilot installation identity is empty.');
  assertSafeExecutionId(threadId, 'Thread');
  const digest = createHash('sha256')
    .update(installationId)
    .update(':')
    .update(threadId)
    .digest('base64url');
  return `tenon.${digest}`;
}

export async function prepareBrowserPilotOutputDirectory(
  scratchRoot: string,
  threadId: string,
  turnId: string,
): Promise<string> {
  assertSafeExecutionId(threadId, 'Thread');
  assertSafeExecutionId(turnId, 'Turn');
  const root = path.resolve(scratchRoot);
  await ensurePrivateDirectory(root, true);
  const browserPilotRoot = path.join(root, 'browser-pilot');
  const threadRoot = path.join(browserPilotRoot, threadId);
  const outputDirectory = path.join(threadRoot, turnId);
  for (const directory of [browserPilotRoot, threadRoot, outputDirectory]) {
    await ensurePrivateDirectory(directory, false);
  }
  const [canonicalRoot, canonicalOutput] = await Promise.all([realpath(root), realpath(outputDirectory)]);
  if (canonicalOutput === canonicalRoot || !isPathInside(canonicalRoot, canonicalOutput)) {
    throw new Error('Browser Pilot output directory escaped Agent scratch.');
  }
  return canonicalOutput;
}

async function ensurePrivateDirectory(target: string, recursive: boolean): Promise<void> {
  try {
    await mkdir(target, {
      recursive,
      ...(PRIVATE_DIRECTORY_MODE === undefined ? {} : { mode: PRIVATE_DIRECTORY_MODE }),
    });
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Browser Pilot host path is not a normal directory: ${target}`);
  }
  if (PRIVATE_DIRECTORY_MODE !== undefined) await chmod(target, PRIVATE_DIRECTORY_MODE);
}

async function assertManagedCommandDirectory(installRoot: string, binDirectory: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(binDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Browser Pilot command path is not a normal directory: ${binDirectory}`);
  }
  const entries = await readdir(binDirectory, { withFileTypes: true });
  let versionsRoot: string | null = null;
  for (const entry of entries) {
    const entryPath = path.join(binDirectory, entry.name);
    if (process.platform === 'win32') {
      if (entry.name !== 'bp.cmd' && entry.name !== 'browser-pilot.cmd') {
        throw new Error(`Browser Pilot command directory contains an unmanaged entry: ${entryPath}`);
      }
      const content = await readFile(entryPath, 'utf8');
      const shimLines = content.replaceAll('\r\n', '\n').trimEnd().split('\n');
      const executableMatch = /^"([^"]+)" %\*$/.exec(shimLines[2] ?? '');
      if (!entry.isFile()
        || shimLines.length !== 3
        || shimLines[0] !== '@rem Browser Pilot managed shim'
        || shimLines[1]?.toLowerCase() !== '@echo off'
        || !executableMatch) {
        throw new Error(`Browser Pilot command directory contains an unmanaged command: ${entryPath}`);
      }
      versionsRoot ??= await resolveManagedVersionsRoot(installRoot);
      await assertManagedCommandTarget(versionsRoot, executableMatch[1]!, 'browser-pilot.exe', entryPath);
      continue;
    }
    if (entry.name !== 'bp' && entry.name !== 'browser-pilot') {
      throw new Error(`Browser Pilot command directory contains an unmanaged entry: ${entryPath}`);
    }
    const entryStat = await lstat(entryPath);
    if (!entry.isSymbolicLink() || !entryStat.isSymbolicLink()) {
      throw new Error(`Browser Pilot command directory contains an unmanaged command: ${entryPath}`);
    }
    versionsRoot ??= await resolveManagedVersionsRoot(installRoot);
    await assertManagedCommandTarget(versionsRoot, entryPath, 'browser-pilot', entryPath);
  }
}

async function resolveManagedVersionsRoot(installRoot: string): Promise<string> {
  const versionsDirectory = path.resolve(installRoot, 'versions');
  const stat = await lstat(versionsDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Browser Pilot versions path is not a normal directory: ${versionsDirectory}`);
  }
  return realpath(versionsDirectory);
}

async function assertManagedCommandTarget(
  versionsRoot: string,
  targetPath: string,
  executableName: string,
  commandPath: string,
): Promise<void> {
  const target = await realpath(targetPath);
  const targetStat = await lstat(target);
  const targetName = path.basename(target);
  const hasExpectedName = process.platform === 'win32'
    ? targetName.toLowerCase() === executableName.toLowerCase()
    : targetName === executableName;
  if (
    !targetStat.isFile()
    || !isPathInside(versionsRoot, target)
    || !hasExpectedName
  ) {
    throw new Error(`Browser Pilot command link escapes the managed install root: ${commandPath}`);
  }
}

function assertSafeExecutionId(value: string, label: string): void {
  if (!SAFE_EXECUTION_ID.test(value)) throw new Error(`${label} identity is unsafe for Browser Pilot output: ${value}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
