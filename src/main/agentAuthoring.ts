// User-driven agent-definition authoring: the file-write surface behind the
// settings editor. Pure filesystem operations — no registry/runtime state — so
// they are trivially testable and reusable. The hot-reload (cache invalidation)
// is orchestrated by the caller (AgentRuntime) after a successful write.
//
// Security (A2/A3): every write target is forced inside one of the known agents
// directories (`~/.agents/agents` or `<workspace>/.agents/agents`). Names are
// slugged to a filesystem-safe segment and path containment is asserted, so a
// renderer-supplied name can never escape via traversal. Built-in agents
// (`rootDir === 'built-in'`) are never writable. The *model* never reaches this
// surface — only the user, through the settings UI (see [[agent-authoring]]).

import { existsSync, realpathSync } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { serializeAgentMarkdown } from '../core/agentMarkdown';
import type { AgentAuthoringInput, AgentStorageLocation } from '../core/agentTypes';
import type { AgentDefinition } from '../core/types';

const AGENT_FILE_NAME = 'AGENT.md';

export interface WrittenAgentLocation {
  rootDir: string;
  agentFile: string;
}

/** Resolve the writable agents directory for a storage location. */
export function agentsDirForStorage(storage: AgentStorageLocation, localRoot: string): string {
  return storage === 'project'
    ? path.join(path.resolve(localRoot), '.agents', 'agents')
    : path.join(homedir(), '.agents', 'agents');
}

/** Filesystem-safe agent folder slug. Rejects empty / pure-dot names (traversal). */
export function normalizeAgentSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!slug || slug === '.' || slug === '..') return '';
  return slug;
}

/** Create a brand-new user/project agent. Rejects if the target already exists. */
export async function createAgentDefinitionFile(opts: {
  input: AgentAuthoringInput;
  storage: AgentStorageLocation;
  localRoot: string;
}): Promise<WrittenAgentLocation> {
  const slug = normalizeAgentSlug(opts.input.name);
  if (!slug) throw new Error('Agent name is empty or contains no usable characters.');
  const rootDir = path.join(agentsDirForStorage(opts.storage, opts.localRoot), slug);
  assertContainedInAgentsDir(rootDir, opts.localRoot);
  if (await pathExists(path.join(rootDir, AGENT_FILE_NAME))) {
    throw new Error(`An agent named "${slug}" already exists in this location.`);
  }
  return writeAgentFile(rootDir, opts.input);
}

/**
 * Overwrite an existing user/project agent in place. The folder name is kept
 * (only the frontmatter `name` changes on a rename), avoiding a directory move.
 */
export async function updateAgentDefinitionFile(opts: {
  existing: AgentDefinition;
  input: AgentAuthoringInput;
  localRoot: string;
}): Promise<WrittenAgentLocation> {
  assertWritableSource(opts.existing);
  const rootDir = path.resolve(opts.existing.rootDir);
  assertContainedInAgentsDir(rootDir, opts.localRoot);
  return writeAgentFile(rootDir, opts.input);
}

/** Delete a user/project agent (its whole directory). Built-ins are refused. */
export async function deleteAgentDefinitionFile(opts: {
  existing: AgentDefinition;
  localRoot: string;
}): Promise<void> {
  assertWritableSource(opts.existing);
  const rootDir = path.resolve(opts.existing.rootDir);
  assertContainedInAgentsDir(rootDir, opts.localRoot);
  await rm(rootDir, { recursive: true, force: true });
}

/** Copy any definition (including a built-in) into a new editable user/project agent. */
export async function duplicateAgentDefinitionFile(opts: {
  source: AgentDefinition;
  newName: string;
  storage: AgentStorageLocation;
  localRoot: string;
}): Promise<WrittenAgentLocation> {
  const input: AgentAuthoringInput = {
    name: opts.newName,
    description: opts.source.description,
    body: opts.source.body,
    model: opts.source.model,
    effort: typeof opts.source.effort === 'string' ? opts.source.effort : undefined,
    permissionMode: opts.source.permissionMode,
    maxTurns: opts.source.maxTurns,
    tools: opts.source.tools,
    disallowedTools: opts.source.disallowedTools,
    skills: opts.source.skills,
    background: opts.source.background,
  };
  return createAgentDefinitionFile({ input, storage: opts.storage, localRoot: opts.localRoot });
}

async function writeAgentFile(rootDir: string, input: AgentAuthoringInput): Promise<WrittenAgentLocation> {
  await mkdir(rootDir, { recursive: true });
  const agentFile = path.join(rootDir, AGENT_FILE_NAME);
  // Atomic write: stage to a sibling temp file, then rename over the target so a
  // reader never sees a half-written AGENT.md.
  const tmpFile = path.join(rootDir, `.${AGENT_FILE_NAME}.tmp-${process.pid}`);
  await writeFile(tmpFile, serializeAgentMarkdown(input), 'utf8');
  await rename(tmpFile, agentFile);
  return { rootDir, agentFile };
}

function assertWritableSource(agent: AgentDefinition): void {
  if (agent.source === 'built-in' || agent.rootDir === 'built-in') {
    throw new Error('Built-in agents cannot be edited or deleted — duplicate to your agents first.');
  }
}

function assertContainedInAgentsDir(targetDir: string, localRoot: string): void {
  // Containment must resolve symlinks, not just normalize lexically: the registry
  // scan follows symlinks (agentDelegation.ts), so a symlink committed inside a
  // `project` `.agents/agents/` dir (git-trackable, shippable in a hostile
  // workspace) that points elsewhere would pass a lexical `path.relative` check
  // yet redirect the write THROUGH the link to an arbitrary file. Resolve the real
  // path of both target and roots (via the nearest existing ancestor, since the
  // target dir may not exist yet on create) before comparing — mirrors
  // resolveWorkspacePath in agentLocalTools.ts.
  const resolvedTarget = realResolve(targetDir);
  const writableDirs = [
    agentsDirForStorage('user', localRoot),
    agentsDirForStorage('project', localRoot),
  ].map(realResolve);
  // The target must be a strict child of an agents dir (not the dir itself).
  const ok = writableDirs.some((dir) => isStrictChild(resolvedTarget, dir));
  if (!ok) {
    throw new Error('Refusing to write an agent definition outside the agents directories.');
  }
}

/**
 * Resolve a path with symlinks followed, tolerating a not-yet-created leaf:
 * realpath the nearest existing ancestor, then re-append the remaining
 * (not-yet-existing) segments. So a symlinked ancestor is dereferenced, but
 * creating a brand-new agent dir still resolves to its real intended location.
 */
function realResolve(target: string): string {
  const requested = path.resolve(target);
  const existing = nearestExistingPath(requested);
  const existingReal = realpathSync.native(existing);
  const suffix = path.relative(existing, requested);
  return suffix ? path.resolve(existingReal, suffix) : existingReal;
}

function nearestExistingPath(input: string): string {
  let current = path.resolve(input);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isStrictChild(target: string, parent: string): boolean {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
