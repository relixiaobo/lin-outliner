import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentSourceKind } from '../core/agentEventLog';
import { parseSkillMarkdown, parseToolListFromFrontmatter } from './agentSkills';

export interface AgentSkillContentTarget {
  skillName: string;
  skillRoot: string;
  skillsDir: string;
  source: AgentSourceKind | 'dynamic';
  relativePath: string;
  isSkillFile: boolean;
}

export interface AgentSkillWriteAudit {
  skillName: string;
  source: AgentSourceKind | 'dynamic';
  skillRoot: string;
  relativePath: string;
  changeType: 'create' | 'patch' | 'replace' | 'support-file-write';
  previousHash?: string;
  nextHash: string;
  previousBytes: number;
  nextBytes: number;
  warnings: string[];
}

export class AgentSkillAuthoringError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instructions: string,
  ) {
    super(message);
    this.name = 'AgentSkillAuthoringError';
  }
}

const SKILL_FILE_NAME = 'SKILL.md';
const MAX_SKILL_MARKDOWN_BYTES = 256 * 1024;
const MAX_SUPPORT_FILE_BYTES = 256 * 1024;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const EXECUTABLE_SUPPORT_EXTENSIONS = new Set([
  '.bat',
  '.cmd',
  '.cjs',
  '.fish',
  '.js',
  '.mjs',
  '.php',
  '.pl',
  '.ps1',
  '.py',
  '.rb',
  '.sh',
  '.ts',
  '.zsh',
]);
const RISKY_ALLOWED_TOOL_NAMES = new Set([
  'agent',
  'agent_send',
  'agent_stop',
  'ask_user_question',
  'bash',
  'config',
  'doctor',
  'file_edit',
  'file_write',
  'node_create',
  'node_delete',
  'node_edit',
  'runtime_status',
  'task_stop',
  'web_fetch',
]);

export function detectAgentSkillContentTarget(
  filePathInput: string,
  workspaceRootInput: string,
): AgentSkillContentTarget | null {
  const filePath = path.resolve(filePathInput);
  const workspaceRoot = path.resolve(workspaceRootInput);
  const userSkillsDir = path.join(homedir(), '.agents', 'skills');
  const workspaceSkillsDir = path.join(workspaceRoot, '.agents', 'skills');
  const userTarget = targetInsideSkillsDir(filePath, userSkillsDir, 'user');
  if (userTarget) return userTarget;
  const workspaceTarget = targetInsideSkillsDir(filePath, workspaceSkillsDir, 'project');
  if (workspaceTarget) return workspaceTarget;
  if (!isPathInside(workspaceRoot, filePath)) return null;

  const parts = filePath.split(path.sep);
  for (let index = parts.length - 3; index >= 0; index -= 1) {
    if (parts[index] !== '.agents' || parts[index + 1] !== 'skills') continue;
    const skillsDir = parts.slice(0, index + 2).join(path.sep) || path.sep;
    const target = targetInsideSkillsDir(filePath, skillsDir, 'dynamic');
    if (target) return target;
  }
  return null;
}

export function validateAgentSkillContentWrite(input: {
  filePath: string;
  workspaceRoot: string;
  content: string;
  previousContent: string | null;
  operation: 'file_edit' | 'file_write';
}): AgentSkillWriteAudit | null {
  const target = detectAgentSkillContentTarget(input.filePath, input.workspaceRoot);
  if (!target) return null;

  assertValidSkillTarget(target);
  const previous = input.previousContent;
  if (target.isSkillFile) {
    validateSkillMarkdown(input.content, previous);
  } else {
    validateSupportFile(target, input.content);
  }

  const previousBytes = previous === null ? 0 : Buffer.byteLength(previous, 'utf8');
  const nextBytes = Buffer.byteLength(input.content, 'utf8');
  return {
    skillName: target.skillName,
    source: target.source,
    skillRoot: target.skillRoot,
    relativePath: target.relativePath,
    changeType: target.isSkillFile
      ? previous === null ? 'create' : input.operation === 'file_edit' ? 'patch' : 'replace'
      : 'support-file-write',
    previousHash: previous === null ? undefined : sha256(previous),
    nextHash: sha256(input.content),
    previousBytes,
    nextBytes,
    warnings: target.isSkillFile
      ? ['Newly authored skills stay user-invocable unless explicitly promoted outside the file tool path.']
      : ['Support files are not loaded automatically; the skill must reference them explicitly.'],
  };
}

function targetInsideSkillsDir(
  filePath: string,
  skillsDirInput: string,
  source: AgentSourceKind | 'dynamic',
): AgentSkillContentTarget | null {
  const skillsDir = path.resolve(skillsDirInput);
  if (!isPathInside(skillsDir, filePath)) return null;
  const relative = path.relative(skillsDir, filePath);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length < 2) return null;
  const skillName = parts[0] ?? '';
  const skillRoot = path.join(skillsDir, skillName);
  return {
    skillName,
    skillRoot,
    skillsDir,
    source,
    relativePath: parts.slice(1).join('/'),
    isSkillFile: parts.length === 2 && parts[1] === SKILL_FILE_NAME,
  };
}

function assertValidSkillTarget(target: AgentSkillContentTarget): void {
  if (!SKILL_NAME_PATTERN.test(target.skillName)) {
    throw new AgentSkillAuthoringError(
      'invalid_skill_name',
      `Invalid skill name: ${target.skillName}`,
      'Use a simple skill directory name with letters, numbers, dots, underscores, or hyphens.',
    );
  }
  if (target.source === 'built-in') {
    throw new AgentSkillAuthoringError(
      'built_in_skill_immutable',
      'Built-in skills are immutable.',
      'Write only user or project skills under .agents/skills.',
    );
  }
}

function validateSkillMarkdown(content: string, previousContent: string | null): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SKILL_MARKDOWN_BYTES) {
    throw new AgentSkillAuthoringError(
      'skill_too_large',
      `SKILL.md is too large: ${bytes} bytes.`,
      `Keep SKILL.md under ${MAX_SKILL_MARKDOWN_BYTES} bytes and move large references into explicit support files.`,
    );
  }
  rejectSecretLookingContent(content);
  if (!FRONTMATTER_PATTERN.test(content.replace(/^\uFEFF/, ''))) {
    throw new AgentSkillAuthoringError(
      'missing_skill_frontmatter',
      'SKILL.md must start with YAML frontmatter.',
      'Use the stable SKILL.md shape: frontmatter, a closing marker, then Markdown instructions.',
    );
  }
  const parsed = parseSkillMarkdown(content);
  const description = typeof parsed.frontmatter.description === 'string'
    ? parsed.frontmatter.description.trim()
    : '';
  if (description.length < 10) {
    throw new AgentSkillAuthoringError(
      'missing_skill_description',
      'SKILL.md requires a frontmatter description of at least 10 characters.',
      'Add a concise description field that explains when the skill should be used.',
    );
  }

  if (parsed.frontmatter['disable-model-invocation'] !== true) {
    throw new AgentSkillAuthoringError(
      'model_invocation_requires_promotion',
      'Agent-authored skills must set disable-model-invocation: true.',
      'Keep the skill user-invocable. Promote model invocation only through an explicit later review.',
    );
  }

  const previousTools = previousContent === null
    ? new Set<string>()
    : new Set(parseToolListFromFrontmatter(parseSkillMarkdown(previousContent).frontmatter['allowed-tools']).map(normalizeRule));
  const addedRisky = parseToolListFromFrontmatter(parsed.frontmatter['allowed-tools'])
    .map(normalizeRule)
    .filter((rule) => !previousTools.has(rule))
    .filter(isRiskyAllowedToolRule);
  if (addedRisky.length > 0) {
    throw new AgentSkillAuthoringError(
      'skill_allowed_tools_escalation',
      `SKILL.md adds high-risk allowed-tools rules: ${addedRisky.join(', ')}`,
      'Do not grant mutating, control, wildcard, or broad shell permissions from a self-authored skill.',
    );
  }
}

function validateSupportFile(target: AgentSkillContentTarget, content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SUPPORT_FILE_BYTES) {
    throw new AgentSkillAuthoringError(
      'skill_support_file_too_large',
      `Skill support file is too large: ${bytes} bytes.`,
      `Keep support files under ${MAX_SUPPORT_FILE_BYTES} bytes.`,
    );
  }
  if (target.relativePath.startsWith('.') || target.relativePath.includes('/.')) {
    throw new AgentSkillAuthoringError(
      'hidden_skill_support_file',
      `Hidden skill support files are not writable: ${target.relativePath}`,
      'Use normal visible Markdown, text, or asset files under the skill directory.',
    );
  }
  const ext = path.extname(target.relativePath).toLowerCase();
  if (EXECUTABLE_SUPPORT_EXTENSIONS.has(ext) || content.startsWith('#!')) {
    throw new AgentSkillAuthoringError(
      'executable_skill_support_file',
      `Executable skill support files require a dedicated review path: ${target.relativePath}`,
      'Use Markdown or text support files in M1. Executable scripts are intentionally not writable through the skill authoring file path.',
    );
  }
  rejectSecretLookingContent(content);
}

function isRiskyAllowedToolRule(rule: string): boolean {
  if (!rule || rule === '*' || /\(\s*\*\s*\)$/.test(rule)) return true;
  const toolName = normalizeToolName(rule.split(/[(:]/)[0] ?? '');
  if (toolName === 'bash') return !/^bash\((?:git status|git diff|git log|git show|ls|pwd|echo)(?::|\s|\)|\*)/i.test(rule);
  if (RISKY_ALLOWED_TOOL_NAMES.has(toolName)) return true;
  return false;
}

function rejectSecretLookingContent(content: string): void {
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)
    || /\bsk-[A-Za-z0-9_-]{24,}\b/.test(content)
    || /\b(?:api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{24,}/i.test(content)
  ) {
    throw new AgentSkillAuthoringError(
      'secret_like_skill_content',
      'Skill content appears to contain a secret.',
      'Remove credentials or secret-looking values from the skill and describe placeholders instead.',
    );
  }
}

function normalizeRule(rule: string): string {
  return rule.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeToolName(value: string): string {
  return value.trim().replace(/-/g, '_').toLowerCase();
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isPathInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
