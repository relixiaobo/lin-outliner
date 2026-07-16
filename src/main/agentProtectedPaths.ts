import path from 'node:path';

export const AGENT_PROTECTED_STORE_FILE_NAMES = [
  'agent-providers.json',
  'agent-secrets.json',
  'agent-tool-permissions.json',
] as const;

const PROTECTED_STORE_FILE_NAME_SET = new Set<string>(AGENT_PROTECTED_STORE_FILE_NAMES);

export function agentProtectedStorePaths(protectedStoreRoot: string): string[] {
  return AGENT_PROTECTED_STORE_FILE_NAMES.map((name) => path.join(protectedStoreRoot, name));
}

export function isAgentProtectedStorePath(filePath: string, protectedStoreRoot?: string): boolean {
  if (!protectedStoreRoot || !PROTECTED_STORE_FILE_NAME_SET.has(path.basename(filePath))) return false;
  return path.dirname(path.resolve(filePath)) === path.resolve(protectedStoreRoot);
}
