import path from 'node:path';

export const PACKAGED_AGENT_LOCAL_ROOT_DIR = 'agent-local-root';

export interface ResolveAgentLocalFileRootInput {
  envLocalRoot?: string;
  cwd: string;
  isPackaged: boolean;
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

export function resolveAgentLocalFileRoot(input: ResolveAgentLocalFileRootInput): string {
  const envLocalRoot = explicitAgentLocalRoot(input.envLocalRoot);
  if (envLocalRoot) {
    return path.resolve(envLocalRoot);
  }
  if (input.isPackaged) {
    return path.join(path.resolve(input.userDataPath), PACKAGED_AGENT_LOCAL_ROOT_DIR);
  }
  return path.resolve(input.cwd);
}
