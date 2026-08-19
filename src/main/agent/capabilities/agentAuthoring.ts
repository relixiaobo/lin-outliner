// Self-definition roots for the `file_write` skill-authoring gate.
//
// After the single-agent collapse there are no file-backed agents for the MODEL
// to create, load, edit, or delete: the conversation agent is built in, and the
// Roles a user defines are written by the Agents settings page through the
// configuration writer — never by the agent through file tools. So the agent
// authoring file-ops and the `.agents/agents/` content gate are gone; what remains
// is only the skill self-definition root map, shared with the `file_write` gate in
// agentLocalTools and the ownership boundary in agentCapabilities.

import { homedir } from 'node:os';
import path from 'node:path';

export type SelfDefinitionScope = 'user' | 'project';

export interface SelfDefinitionRootEntry {
  dir: string;
  scope: SelfDefinitionScope;
}

// User- and project-scoped skill self-definition roots. A write under one of these
// is governed (validated + hot-reloaded) by the skill runtime; a write under any
// other path is an ordinary workspace file.
export function selfDefinitionRootEntries(localRoot: string): SelfDefinitionRootEntry[] {
  const root = path.resolve(localRoot);
  return [
    { dir: path.join(homedir(), '.agents', 'skills'), scope: 'user' },
    { dir: path.join(root, '.agents', 'skills'), scope: 'project' },
  ];
}
