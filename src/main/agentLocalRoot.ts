import path from 'node:path';

// Two app-owned roots, both leaf directories under userData (per clone in dev):
//   workdir — the agent's default cwd + file_* root; the place its own outputs land.
//   scratch — ephemeral materialized attachments / web-fetch / tool-outputs / PDF pages.
// They are siblings, never nested, so scratch never pollutes the (possibly repo) workdir.
export const AGENT_WORKDIR_DIR = 'agent-workdir';
export const AGENT_SCRATCH_DIR = 'agent-scratch';

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
  return path.join(path.resolve(input.userDataPath), AGENT_WORKDIR_DIR);
}

// The agent scratch root is always app-owned under userData, independent of the workdir, so
// an env-pointed repo workdir never accumulates ephemeral scratch files.
export function resolveAgentScratchRoot(input: { userDataPath: string }): string {
  return path.join(path.resolve(input.userDataPath), AGENT_SCRATCH_DIR);
}
