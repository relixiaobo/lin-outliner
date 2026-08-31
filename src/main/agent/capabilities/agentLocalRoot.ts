import path from 'node:path';
import { rm } from 'node:fs/promises';

export const AGENT_WORKSPACES_DIR = 'workspaces';
export const AGENT_SCRATCH_DIR = 'scratch';

export interface ResolveAgentWorkdirInput {
  envLocalRoot?: string;
  userDataPath: string;
}

function explicitAgentLocalRoot(envLocalRoot: string | undefined): string | null {
  if (typeof envLocalRoot !== 'string') return null;
  const root = envLocalRoot.trim();
  return root.length > 0 ? root : null;
}

export function hasExplicitAgentLocalRoot(envLocalRoot: string | undefined): boolean {
  return explicitAgentLocalRoot(envLocalRoot) != null;
}

// The agent workdir. `LIN_AGENT_LOCAL_ROOT` is the explicit opt-in to point the agent
// at a real directory (e.g. a repo clone for dogfooding). With no override the workdir is
// the dedicated `<userData>/agent-workdir` in BOTH dev and packaged — never `process.cwd()`,
// which in dev is the repo clone (the source of stray agent files) and packaged can be `/`.
export function resolveAgentWorkdir(input: ResolveAgentWorkdirInput): string {
  const envLocalRoot = explicitAgentLocalRoot(input.envLocalRoot);
  if (envLocalRoot) {
    return path.resolve(envLocalRoot);
  }
  return path.join(path.resolve(input.userDataPath), 'agent', AGENT_WORKSPACES_DIR);
}

export function resolveAgentConversationWorkspace(input: {
  readonly userDataPath: string;
  readonly threadId: string;
}): string {
  if (!input.threadId.trim() || /[/\\]/u.test(input.threadId)) {
    throw new Error('Invalid Agent workspace Thread id.');
  }
  return path.join(
    path.resolve(input.userDataPath),
    'agent',
    AGENT_WORKSPACES_DIR,
    input.threadId,
  );
}

export async function removeAgentConversationWorkspace(input: {
  readonly userDataPath: string;
  readonly threadId: string;
  readonly cwd: string;
}): Promise<void> {
  const workspace = resolveAgentConversationWorkspace(input);
  if (path.resolve(input.cwd) !== path.resolve(workspace)) {
    throw new Error(`Refusing mismatched managed workspace cleanup for ${input.threadId}`);
  }
  await rm(workspace, { recursive: true, force: true });
}

// The agent scratch root is always app-owned under userData, independent of the workdir, so
// an env-pointed repo workdir never accumulates ephemeral scratch files.
export function resolveAgentScratchRoot(input: { userDataPath: string }): string {
  return path.join(path.resolve(input.userDataPath), 'agent', AGENT_SCRATCH_DIR);
}
