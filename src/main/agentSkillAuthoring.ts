import path from 'node:path';
import type { AgentSourceKind } from '../core/agentEventLog';
import { type AgentSkillContentTarget, parseSkillMarkdown, skillContentHash } from './agentSkills';
import { containsSecretLikeContent } from './agentSecretRedaction';

export interface AgentSkillWriteAudit {
  skillName: string;
  source: AgentSourceKind;
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
export function validateAgentSkillContentWrite(input: {
  target: AgentSkillContentTarget;
  content: string;
  previousContent: string | null;
  operation: 'file_edit' | 'file_write';
}): AgentSkillWriteAudit {
  const { target } = input;
  assertValidSkillTarget(target);
  const previous = input.previousContent;
  if (target.isSkillFile) {
    validateSkillMarkdown(input.content);
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
    // Canonical skill hash (shared with the loader) so the provenance record built
    // from nextHash matches what the registry computes from disk after the write.
    previousHash: previous === null ? undefined : skillContentHash(previous),
    nextHash: skillContentHash(input.content),
    previousBytes,
    nextBytes,
    warnings: target.isSkillFile
      ? ['Agent-written skills are available immediately: slash-invocable now, and model-invocable skills can appear in the automatic listing without a separate trust prompt.']
      : ['Support files are not loaded automatically; the skill must reference them explicitly.'],
  };
}

function assertValidSkillTarget(target: AgentSkillContentTarget): void {
  // The resolver never yields a built-in target (built-ins have no writable dir), so the
  // immutable floor needs no check here — only the skill-name shape.
  if (!SKILL_NAME_PATTERN.test(target.skillName)) {
    throw new AgentSkillAuthoringError(
      'invalid_skill_name',
      `Invalid skill name: ${target.skillName}`,
      'Use a simple skill directory name with letters, numbers, dots, underscores, or hyphens.',
    );
  }
}

function validateSkillMarkdown(content: string): void {
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

  // No policy checks here: model-invocability and allowed-tools escalation are
  // enforced by the ratification gate at listing/invocation time, not at write time.
  // The write boundary only validates validity and safety.
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

// Secret scanning is intentionally skill-specific (not generalized to all file writes):
// skills are durable instructions injected into future model contexts, which makes a
// leaked credential an exfiltration amplifier; a global secret block on ordinary file
// writes would false-positive on normal code.
function rejectSecretLookingContent(content: string): void {
  if (containsSecretLikeContent(content)) {
    throw new AgentSkillAuthoringError(
      'secret_like_skill_content',
      'Skill content appears to contain a secret.',
      'Remove credentials or secret-looking values from the skill and describe placeholders instead.',
    );
  }
}
