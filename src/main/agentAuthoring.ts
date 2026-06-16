// User-driven agent-definition authoring: the file-write surface behind the
// settings editor. Pure filesystem operations — no registry/runtime state — so
// they are trivially testable and reusable. The hot-reload (cache invalidation)
// is orchestrated by the caller (AgentRuntime) after a successful write.
//
// Security (A2/A3): every settings write target is forced inside one of the known agents
// directories (`~/.agents/agents` or `<workspace>/.agents/agents`). Names are
// slugged to a filesystem-safe segment and path containment is asserted, so a
// renderer-supplied name can never escape via traversal. Built-in agents
// (`rootDir === 'built-in'`) are never writable.

import { existsSync, realpathSync } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { coerceString, parseAgentMarkdownDocument, parseBoolean, parseStringList, serializeAgentMarkdown } from '../core/agentMarkdown';
import type { AgentAuthoringInput, AgentStorageLocation } from '../core/agentTypes';
import { AGENT_REASONING_LADDER, type AgentDefinition } from '../core/types';
import { containsSecretLikeContent } from './agentSecretRedaction';
import { atomicWriteFile } from './jsonFileStore';

export const AGENT_FILE_NAME = 'AGENT.md';
const MAX_AGENT_MARKDOWN_BYTES = 256 * 1024;
const AGENT_DIR_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_AGENT_NAMES = new Set(['assistant', 'fork', 'neva']);
const MAX_AGENT_LIST_ITEMS = 32;
const MAX_AGENT_FRONTMATTER_STRING = 160;
const MAX_CHAT_AUTHORED_MAX_TURNS = 50;
const AGENT_FRONTMATTER_ITEM_PATTERN = /^[A-Za-z0-9._:/@()[\]*-]+$/;
const AGENT_SKILL_ITEM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type SelfDefinitionSurface = 'skill' | 'agent';
export type SelfDefinitionScope = 'user' | 'project';

export interface SelfDefinitionRootEntry {
  dir: string;
  surface: SelfDefinitionSurface;
  scope: SelfDefinitionScope;
}

export interface AgentDefinitionContentTarget {
  agentName: string;
  source: AgentDefinition['source'];
  agentsDir: string;
  agentRoot: string;
  agentFile: string;
  relativePath: string;
  isAgentFile: boolean;
}

export interface AgentDefinitionWriteAudit {
  agentName: string;
  source: AgentDefinition['source'];
  agentRoot: string;
  relativePath: string;
  changeType: 'create' | 'patch' | 'replace';
  previousBytes: number;
  nextBytes: number;
  warnings: string[];
}

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

export function selfDefinitionRootEntries(localRoot: string): SelfDefinitionRootEntry[] {
  const root = path.resolve(localRoot);
  return [
    { dir: path.join(homedir(), '.agents', 'skills'), surface: 'skill', scope: 'user' },
    { dir: agentsDirForStorage('user', root), surface: 'agent', scope: 'user' },
    { dir: path.join(root, '.agents', 'skills'), surface: 'skill', scope: 'project' },
    { dir: agentsDirForStorage('project', root), surface: 'agent', scope: 'project' },
  ];
}

export function defaultAgentDefinitionDirs(localRoot: string): Array<{ dir: string; source: AgentDefinition['source'] }> {
  return selfDefinitionRootEntries(localRoot)
    .filter((entry) => entry.surface === 'agent')
    .map((entry) => ({ dir: entry.dir, source: entry.scope }));
}

export function resolveAgentDefinitionContentTarget(filePath: string, localRoot: string): AgentDefinitionContentTarget | null {
  const resolved = path.resolve(filePath);
  for (const { dir, source } of defaultAgentDefinitionDirs(localRoot)) {
    const agentsDir = path.resolve(dir);
    const relative = path.relative(agentsDir, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length < 2) continue;
    const agentName = parts[0] ?? '';
    const relativePath = parts.slice(1).join('/');
    const isCaseVariantAgentFile = parts.length === 2 && parts[1]?.toLowerCase() === AGENT_FILE_NAME.toLowerCase() && parts[1] !== AGENT_FILE_NAME;
    return {
      agentName,
      source,
      agentsDir,
      agentRoot: path.join(agentsDir, agentName),
      agentFile: path.join(agentsDir, agentName, AGENT_FILE_NAME),
      relativePath: isCaseVariantAgentFile ? parts.slice(1).join('/') : relativePath,
      isAgentFile: parts.length === 2 && parts[1] === AGENT_FILE_NAME,
    };
  }
  return null;
}

export function validateAgentDefinitionContentWrite(input: {
  target: AgentDefinitionContentTarget;
  content: string;
  previousContent: string | null;
  operation: 'file_edit' | 'file_write';
}): AgentDefinitionWriteAudit {
  const { target } = input;
  if (!target.isAgentFile) {
    if (target.relativePath.toLowerCase() === AGENT_FILE_NAME.toLowerCase()) {
      throw new AgentDefinitionAuthoringError(
        'invalid_agent_definition_filename',
        `Agent definition files must be named exactly ${AGENT_FILE_NAME}.`,
        `Rename the file to ${AGENT_FILE_NAME}; lowercase or mixed-case variants are not accepted.`,
      );
    }
    throw new AgentDefinitionAuthoringError(
      'unsupported_agent_definition_file',
      `Only ${AGENT_FILE_NAME} is writable inside agent definition directories.`,
      `Write a complete ${AGENT_FILE_NAME} at .agents/agents/<agent-name>/${AGENT_FILE_NAME}. Agent support files are not part of this authoring surface.`,
    );
  }
  if (!AGENT_DIR_NAME_PATTERN.test(target.agentName)) {
    throw new AgentDefinitionAuthoringError(
      'invalid_agent_directory_name',
      `Invalid agent directory name: ${target.agentName}`,
      'Use a simple lowercase directory name with letters, numbers, dots, underscores, or hyphens.',
    );
  }
  if (input.operation === 'file_edit' && input.previousContent === null) {
    throw new AgentDefinitionAuthoringError(
      'agent_definition_edit_missing_previous_content',
      'Agent definition edits require existing AGENT.md content.',
      `Create a new agent with file_write, or read the existing ${AGENT_FILE_NAME} before editing it.`,
    );
  }
  validateAgentMarkdownForModelWrite(input.content);
  const previousBytes = Buffer.byteLength(input.previousContent ?? '', 'utf8');
  const changeType = input.previousContent === null
    ? 'create'
    : input.operation === 'file_edit'
      ? 'patch'
      : 'replace';
  return {
    agentName: target.agentName,
    source: target.source,
    agentRoot: target.agentRoot,
    relativePath: target.relativePath,
    changeType,
    previousBytes,
    nextBytes: Buffer.byteLength(input.content, 'utf8'),
    warnings: ['Chat-authored agents must remain restricted and still pass through the global permission gate. Delete agents in Settings.'],
  };
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

export function isAgentDefinitionWritable(agent: AgentDefinition, localRoot: string): boolean {
  try {
    assertWritableSource(agent);
    assertContainedInAgentsDir(path.resolve(agent.rootDir), localRoot);
    return true;
  } catch {
    return false;
  }
}

async function writeAgentFile(rootDir: string, input: AgentAuthoringInput): Promise<WrittenAgentLocation> {
  const agentFile = path.join(rootDir, AGENT_FILE_NAME);
  await atomicWriteFile(agentFile, serializeAgentMarkdown(input));
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

export class AgentDefinitionAuthoringError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instructions: string,
  ) {
    super(message);
    this.name = 'AgentDefinitionAuthoringError';
  }
}

function validateAgentMarkdownForModelWrite(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_AGENT_MARKDOWN_BYTES) {
    throw new AgentDefinitionAuthoringError(
      'agent_definition_too_large',
      `${AGENT_FILE_NAME} is too large: ${bytes} bytes.`,
      `Keep ${AGENT_FILE_NAME} under ${MAX_AGENT_MARKDOWN_BYTES} bytes and keep long references in the agent instructions, not adjacent support files.`,
    );
  }
  if (containsSecretLikeContent(content)) {
    throw new AgentDefinitionAuthoringError(
      'secret_like_agent_definition_content',
      'Agent definition content appears to contain a secret.',
      'Remove credentials or secret-looking values from the agent definition and describe placeholders instead.',
    );
  }
  const { frontmatter, body } = parseStrictAgentMarkdown(content);
  const name = coerceString(frontmatter.name);
  const description = coerceString(frontmatter.description);
  if (!name) {
    throw new AgentDefinitionAuthoringError(
      'missing_agent_name',
      `${AGENT_FILE_NAME} requires a frontmatter name.`,
      'Add a concise name field to the AGENT.md frontmatter.',
    );
  }
  if (!description || description.length < 10) {
    throw new AgentDefinitionAuthoringError(
      'missing_agent_description',
      `${AGENT_FILE_NAME} requires a frontmatter description of at least 10 characters.`,
      'Add a routing-grade description that explains when this agent should be used.',
    );
  }
  const normalizedName = normalizeAgentSlug(name);
  if (RESERVED_AGENT_NAMES.has(normalizedName)) {
    throw new AgentDefinitionAuthoringError(
      'reserved_agent_name',
      `${AGENT_FILE_NAME} cannot use reserved built-in agent name: ${name}`,
      'Choose a project-specific agent name that does not collide with built-in agents.',
    );
  }
  const permissionMode = frontmatter['permission-mode'] ?? frontmatter.permissionMode;
  if (permissionMode !== 'restricted') {
    throw new AgentDefinitionAuthoringError(
      'agent_definition_must_be_restricted',
      `${AGENT_FILE_NAME} written through chat must set permission-mode: restricted.`,
      'Set permission-mode: restricted. Chat-authored agents do not receive trusted authority.',
    );
  }
  validateBoundedAgentFrontmatter(frontmatter);
  if (!body.trim()) {
    throw new AgentDefinitionAuthoringError(
      'missing_agent_body',
      `${AGENT_FILE_NAME} requires instruction body content after the frontmatter.`,
      'Add focused Markdown instructions describing the agent role, workflow, constraints, and reporting style.',
    );
  }
}

function parseStrictAgentMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatterText = strictFrontmatterText(content);
  try {
    const parsed = parseYaml(frontmatterText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('frontmatter is not an object');
    }
  } catch (error) {
    throw new AgentDefinitionAuthoringError(
      'invalid_agent_frontmatter',
      `${AGENT_FILE_NAME} frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      'Fix the YAML frontmatter and show the corrected AGENT.md before writing again.',
    );
  }
  return parseAgentMarkdownDocument(content);
}

function strictFrontmatterText(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    throw new AgentDefinitionAuthoringError(
      'missing_agent_frontmatter',
      `${AGENT_FILE_NAME} must start with YAML frontmatter.`,
      'Use the stable AGENT.md shape: frontmatter, a closing marker, then Markdown instructions.',
    );
  }
  const lineEnd = normalized.startsWith('---\r\n') ? '\r\n' : '\n';
  const endMarker = `${lineEnd}---${lineEnd}`;
  const end = normalized.indexOf(endMarker, 3);
  if (end < 0) {
    throw new AgentDefinitionAuthoringError(
      'missing_agent_frontmatter',
      `${AGENT_FILE_NAME} must include a closing YAML frontmatter marker.`,
      'Use the stable AGENT.md shape: frontmatter, a closing marker, then Markdown instructions.',
    );
  }
  return normalized.slice(3 + lineEnd.length, end).trim();
}

function validateBoundedAgentFrontmatter(frontmatter: Record<string, unknown>): void {
  if (frontmatter.background !== undefined && parseBoolean(frontmatter.background) !== false) {
    throw new AgentDefinitionAuthoringError(
      'unsupported_agent_background_mode',
      `${AGENT_FILE_NAME} written through chat cannot enable background mode.`,
      'Remove background, or set background: false. Configure background behavior outside the chat authoring surface.',
    );
  }

  const maxTurns = frontmatter['max-turns'] ?? frontmatter.maxTurns;
  if (maxTurns !== undefined) {
    const parsed = typeof maxTurns === 'number'
      ? maxTurns
      : typeof maxTurns === 'string' && /^\d+$/.test(maxTurns.trim())
        ? Number(maxTurns.trim())
        : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CHAT_AUTHORED_MAX_TURNS) {
      throw new AgentDefinitionAuthoringError(
        'invalid_agent_max_turns',
        `${AGENT_FILE_NAME} max-turns must be an integer between 1 and ${MAX_CHAT_AUTHORED_MAX_TURNS}.`,
        `Use a bounded max-turns value from 1 to ${MAX_CHAT_AUTHORED_MAX_TURNS}, or omit it.`,
      );
    }
  }

  const model = coerceString(frontmatter.model);
  if (model !== undefined) {
    validateBoundedScalarField('model', model, /^[A-Za-z0-9._:/-]+$/);
  }

  const effort = coerceString(frontmatter.effort);
  if (effort !== undefined && !AGENT_REASONING_LADDER.includes(effort as (typeof AGENT_REASONING_LADDER)[number])) {
    throw new AgentDefinitionAuthoringError(
      'invalid_agent_effort',
      `${AGENT_FILE_NAME} effort must be one of: ${AGENT_REASONING_LADDER.join(', ')}.`,
      'Use a supported effort value or omit effort.',
    );
  }

  validateBoundedStringList('tools', frontmatter.tools, AGENT_FRONTMATTER_ITEM_PATTERN, { disallowWildcardOnly: true });
  validateBoundedStringList('disallowed-tools', frontmatter['disallowed-tools'] ?? frontmatter.disallowedTools, AGENT_FRONTMATTER_ITEM_PATTERN);
  validateBoundedStringList('skills', frontmatter.skills, AGENT_SKILL_ITEM_PATTERN);
}

function validateBoundedScalarField(field: string, value: string, pattern: RegExp): void {
  if (value.length > MAX_AGENT_FRONTMATTER_STRING || !pattern.test(value)) {
    throw new AgentDefinitionAuthoringError(
      `invalid_agent_${field.replace(/-/g, '_')}`,
      `${AGENT_FILE_NAME} ${field} contains an unsupported value.`,
      `Use a simple ${field} value under ${MAX_AGENT_FRONTMATTER_STRING} characters, or omit the field.`,
    );
  }
}

function validateBoundedStringList(
  field: string,
  rawValue: unknown,
  itemPattern: RegExp,
  opts: { disallowWildcardOnly?: boolean } = {},
): void {
  if (rawValue === undefined) return;
  const items = parseStringList(rawValue);
  if (!items?.length || items.length > MAX_AGENT_LIST_ITEMS) {
    throw new AgentDefinitionAuthoringError(
      `invalid_agent_${field.replace(/-/g, '_')}`,
      `${AGENT_FILE_NAME} ${field} must contain 1-${MAX_AGENT_LIST_ITEMS} items.`,
      `Use a bounded ${field} list or omit the field.`,
    );
  }
  for (const item of items) {
    if (
      item.length > MAX_AGENT_FRONTMATTER_STRING
      || !itemPattern.test(item)
      || (opts.disallowWildcardOnly && item === '*')
    ) {
      throw new AgentDefinitionAuthoringError(
        `invalid_agent_${field.replace(/-/g, '_')}`,
        `${AGENT_FILE_NAME} ${field} contains an unsupported item: ${item}`,
        `Use simple bounded ${field} entries; do not use broad wildcards in chat-authored agent definitions.`,
      );
    }
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
