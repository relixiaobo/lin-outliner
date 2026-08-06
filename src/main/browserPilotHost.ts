import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentShellProcessEnvironment } from './agent/capabilities/agentLocalTools';
import { loadOrCreateInstallationId } from './installationIdentity';

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
  private installationId: Promise<string> | null = null;

  constructor(options: BrowserPilotHostOptions) {
    this.userDataRoot = path.resolve(options.userDataRoot);
    this.scratchRoot = path.resolve(options.scratchRoot);
    this.installRoot = path.join(this.userDataRoot, 'browser-pilot');
    this.binDirectory = path.join(this.installRoot, 'bin');
    this.loadInstallationId = options.loadInstallationId ?? loadOrCreateInstallationId;
  }

  async processEnvironment(threadId: string, turnId: string): Promise<AgentShellProcessEnvironment> {
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

  private installationIdentity(): Promise<string> {
    this.installationId ??= this.loadInstallationId(this.userDataRoot);
    return this.installationId;
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
  const relative = path.relative(canonicalRoot, canonicalOutput);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
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

function assertSafeExecutionId(value: string, label: string): void {
  if (!SAFE_EXECUTION_ID.test(value)) throw new Error(`${label} identity is unsafe for Browser Pilot output: ${value}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
