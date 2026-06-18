// Self-definition roots for the `file_write` skill-authoring gate.
//
// After the single-agent collapse there are no file-backed agents to create,
// load, edit, or delete — the product has exactly one agent, the built-in Neva,
// who is edited in place through the settings overlay (not a file). So the agent
// authoring file-ops and the `.agents/agents/` content gate are gone; what remains
// is only the skill self-definition root map, shared with the `file_write` gate in
// agentLocalTools and the permission guard in agentPermissions.

import { homedir } from 'node:os';
import path from 'node:path';

export type SelfDefinitionSurface = 'skill';
export type SelfDefinitionScope = 'user' | 'project';

export interface SelfDefinitionRootEntry {
  dir: string;
  surface: SelfDefinitionSurface;
  scope: SelfDefinitionScope;
}

// User- and project-scoped skill self-definition roots. A write under one of these
// is governed (validated + hot-reloaded) by the skill runtime; a write under any
// other path is an ordinary workspace file.
export function selfDefinitionRootEntries(localRoot: string): SelfDefinitionRootEntry[] {
  const root = path.resolve(localRoot);
  return [
    { dir: path.join(homedir(), '.agents', 'skills'), surface: 'skill', scope: 'user' },
    { dir: path.join(root, '.agents', 'skills'), surface: 'skill', scope: 'project' },
  ];
}
