import path from 'node:path';

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

// `LIN_AGENT_LOCAL_ROOT` explicitly points the agent at a real directory (for example,
// a repo clone for dogfooding). Otherwise all calls use this Host-owned default
// directory unless they provide cwd. It is never allocated per conversation.
export function resolveAgentWorkdir(input: ResolveAgentWorkdirInput): string {
  const envLocalRoot = explicitAgentLocalRoot(input.envLocalRoot);
  if (envLocalRoot) {
    return path.resolve(envLocalRoot);
  }
  return path.join(path.resolve(input.userDataPath), 'agent', AGENT_WORKSPACES_DIR);
}

// The agent scratch root is always app-owned under userData, independent of the workdir, so
// an env-pointed repo workdir never accumulates ephemeral scratch files.
export function resolveAgentScratchRoot(input: { userDataPath: string }): string {
  return path.join(path.resolve(input.userDataPath), 'agent', AGENT_SCRATCH_DIR);
}
