import { createHash } from 'node:crypto';
import path from 'node:path';
import { satisfies, valid, validRange } from 'semver';
import { parseDocument } from 'yaml';
import type { ManagedSkillCompatibilityView } from '../core/types';

export const MANAGED_SKILL_LIMITS = {
  catalogBytes: 512 * 1024,
  treeBytes: 8 * 1024 * 1024,
  treeEntries: 20_000,
  candidateCount: 100,
  fileCount: 512,
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
} as const;

const SOURCE_METADATA_NAMES = new Set(['.DS_Store', '.gitattributes', '.gitignore']);
const SCRIPT_EXTENSIONS = new Set(['.bash', '.cjs', '.js', '.mjs', '.py', '.sh', '.ts', '.zsh']);
const BINARY_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.pdf', '.png', '.webp']);
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type ManagedSkillValidationCode =
  | 'invalid_path'
  | 'hidden_file'
  | 'nested_git_data'
  | 'symlink'
  | 'submodule'
  | 'executable_file'
  | 'unsupported_entry'
  | 'file_count_exceeded'
  | 'file_size_exceeded'
  | 'total_size_exceeded'
  | 'missing_skill_file'
  | 'duplicate_skill_file'
  | 'invalid_frontmatter'
  | 'invalid_skill_name'
  | 'invalid_description'
  | 'embedded_shell'
  | 'invalid_text'
  | 'unsupported_binary'
  | 'secret_content'
  | 'invalid_compatibility'
  | 'incompatible_tenon';

export class ManagedSkillValidationError extends Error {
  constructor(
    readonly code: ManagedSkillValidationCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ManagedSkillValidationError';
  }
}

export interface ManagedSkillTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit' | string;
  sha: string;
  size?: number;
}

export interface ManagedSkillSelectedEntry extends ManagedSkillTreeEntry {
  relativePath: string;
}

export interface ManagedSkillFile {
  relativePath: string;
  bytes: Uint8Array;
}

export interface ValidatedManagedSkill {
  name: string;
  description: string;
  version?: string;
  compatibility: ManagedSkillCompatibilityView;
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  scripts: string[];
  skillContent: string;
  files: ManagedSkillFile[];
}

export interface ManagedSkillFrontmatterSummary {
  name: string;
  description: string;
  version?: string;
  compatibility: ManagedSkillCompatibilityView;
}

export function normalizeRepositorySubdirectory(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';
  validateRelativePath(normalized);
  return normalized;
}

export function selectManagedSkillEntries(
  tree: readonly ManagedSkillTreeEntry[],
  subdirectoryInput: string,
): ManagedSkillSelectedEntry[] {
  const subdirectory = normalizeRepositorySubdirectory(subdirectoryInput);
  const prefix = subdirectory ? `${subdirectory}/` : '';
  const selected: ManagedSkillSelectedEntry[] = [];
  let declaredBytes = 0;
  let skillFileCount = 0;

  for (const entry of tree) {
    if (subdirectory && entry.path !== subdirectory && !entry.path.startsWith(prefix)) continue;
    validateRelativePath(entry.path);
    const relativePath = subdirectory ? entry.path.slice(prefix.length) : entry.path;
    if (!relativePath || relativePath === entry.path && entry.path === subdirectory) continue;
    validateRelativePath(relativePath);

    const parts = relativePath.split('/');
    if (parts.some((part) => part === '.git')) {
      throw new ManagedSkillValidationError('nested_git_data', `Managed skills cannot contain nested .git data: ${relativePath}`, relativePath);
    }
    if (SOURCE_METADATA_NAMES.has(parts.at(-1) ?? '')) continue;
    if (parts.some((part) => part.startsWith('.'))) {
      throw new ManagedSkillValidationError('hidden_file', `Managed skills cannot contain hidden support paths: ${relativePath}`, relativePath);
    }
    if (entry.mode === '120000') {
      throw new ManagedSkillValidationError('symlink', `Managed skills cannot contain symlinks: ${relativePath}`, relativePath);
    }
    if (entry.mode === '160000' || entry.type === 'commit') {
      throw new ManagedSkillValidationError('submodule', `Managed skills cannot contain submodules: ${relativePath}`, relativePath);
    }
    if (entry.type === 'tree') continue;
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
      throw new ManagedSkillValidationError('unsupported_entry', `Unsupported Git entry for managed skill: ${relativePath}`, relativePath);
    }
    if (entry.mode === '100755') {
      throw new ManagedSkillValidationError('executable_file', `Managed skill files must not be executable: ${relativePath}`, relativePath);
    }
    if (relativePath === 'SKILL.md') skillFileCount += 1;
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new ManagedSkillValidationError('unsupported_entry', `GitHub did not report a safe size for ${relativePath}.`, relativePath);
    }
    if (entry.size > MANAGED_SKILL_LIMITS.fileBytes) {
      throw new ManagedSkillValidationError('file_size_exceeded', `${relativePath} exceeds the 1 MiB managed-skill file limit.`, relativePath);
    }
    declaredBytes += entry.size;
    if (declaredBytes > MANAGED_SKILL_LIMITS.totalBytes) {
      throw new ManagedSkillValidationError('total_size_exceeded', 'The selected skill exceeds the 16 MiB managed-skill limit.');
    }
    selected.push({ ...entry, relativePath });
    if (selected.length > MANAGED_SKILL_LIMITS.fileCount) {
      throw new ManagedSkillValidationError('file_count_exceeded', 'The selected skill exceeds the 512-file managed-skill limit.');
    }
  }

  if (skillFileCount === 0) {
    throw new ManagedSkillValidationError('missing_skill_file', `No SKILL.md exists directly under ${subdirectory || 'the selected repository root'}.`);
  }
  if (skillFileCount > 1) {
    throw new ManagedSkillValidationError('duplicate_skill_file', `More than one root SKILL.md was found under ${subdirectory || 'the selected repository root'}.`);
  }
  return selected.sort((left, right) => compareManagedSkillPaths(left.relativePath, right.relativePath));
}

export function validateManagedSkillFiles(input: {
  files: readonly ManagedSkillFile[];
  selectedDirectoryName: string;
  appVersion: string;
  catalogCompatibilityRange?: string;
}): ValidatedManagedSkill {
  if (input.files.length === 0) {
    throw new ManagedSkillValidationError('missing_skill_file', 'The selected skill contains no files.');
  }
  if (input.files.length > MANAGED_SKILL_LIMITS.fileCount) {
    throw new ManagedSkillValidationError('file_count_exceeded', 'The selected skill exceeds the 512-file managed-skill limit.');
  }

  const seen = new Set<string>();
  const normalizedFiles = input.files.map((file): ManagedSkillFile => {
    validateRelativePath(file.relativePath);
    if (seen.has(file.relativePath)) {
      throw new ManagedSkillValidationError('invalid_path', `Duplicate managed-skill path: ${file.relativePath}`, file.relativePath);
    }
    seen.add(file.relativePath);
    if (file.bytes.byteLength > MANAGED_SKILL_LIMITS.fileBytes) {
      throw new ManagedSkillValidationError('file_size_exceeded', `${file.relativePath} exceeds the 1 MiB managed-skill file limit.`, file.relativePath);
    }
    return { relativePath: file.relativePath, bytes: Uint8Array.from(file.bytes) };
  }).sort((left, right) => compareManagedSkillPaths(left.relativePath, right.relativePath));

  const totalBytes = normalizedFiles.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (totalBytes > MANAGED_SKILL_LIMITS.totalBytes) {
    throw new ManagedSkillValidationError('total_size_exceeded', 'The selected skill exceeds the 16 MiB managed-skill limit.');
  }

  const texts = new Map<string, string>();
  for (const file of normalizedFiles) {
    const extension = path.posix.extname(file.relativePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) {
      validateBinarySignature(file.relativePath, file.bytes);
      continue;
    }
    const text = decodeManagedSkillText(file.relativePath, file.bytes);
    scanSecretLookingContent(file.relativePath, text);
    texts.set(file.relativePath, text);
  }

  const skillContent = texts.get('SKILL.md');
  if (skillContent === undefined) {
    throw new ManagedSkillValidationError('missing_skill_file', 'The selected skill must contain a UTF-8 SKILL.md at its root.');
  }
  rejectEmbeddedShell(skillContent);
  const frontmatter = parseManagedSkillFrontmatter({
    skillContent,
    selectedDirectoryName: input.selectedDirectoryName,
    appVersion: input.appVersion,
    catalogCompatibilityRange: input.catalogCompatibilityRange,
  });

  return {
    ...frontmatter,
    contentHash: hashManagedSkillFiles(normalizedFiles),
    fileCount: normalizedFiles.length,
    totalBytes,
    scripts: normalizedFiles
      .map((file) => file.relativePath)
      .filter((filePath) => SCRIPT_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase())),
    skillContent,
    files: normalizedFiles,
  };
}

export function parseManagedSkillFrontmatter(input: {
  skillContent: string;
  selectedDirectoryName: string;
  appVersion: string;
  catalogCompatibilityRange?: string;
}): ManagedSkillFrontmatterSummary {
  const match = input.skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new ManagedSkillValidationError('invalid_frontmatter', 'Managed SKILL.md must begin with complete YAML frontmatter.');
  }
  const document = parseDocument(match[1] ?? '', {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new ManagedSkillValidationError('invalid_frontmatter', `Invalid SKILL.md frontmatter: ${document.errors[0]?.message ?? 'YAML parse failed'}.`);
  }
  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new ManagedSkillValidationError('invalid_frontmatter', `Invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (!isRecord(parsed)) {
    throw new ManagedSkillValidationError('invalid_frontmatter', 'Managed SKILL.md frontmatter must be a YAML mapping.');
  }

  const fallbackName = path.posix.basename(normalizeRepositorySubdirectory(input.selectedDirectoryName));
  const nameValue = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : fallbackName;
  if (!SKILL_NAME_PATTERN.test(nameValue)) {
    throw new ManagedSkillValidationError('invalid_skill_name', `Invalid managed skill name "${nameValue}". Use lowercase letters, numbers, and hyphens.`, 'name');
  }
  const description = typeof parsed.description === 'string' ? parsed.description.trim().replace(/\s+/g, ' ') : '';
  if (!description || description.length > 2_000) {
    throw new ManagedSkillValidationError('invalid_description', 'Managed SKILL.md frontmatter requires a description of at most 2,000 characters.', 'description');
  }
  if (
    parsed.execution !== undefined
    && (
      typeof parsed.execution !== 'string'
      || (parsed.execution.toLowerCase() !== 'inline' && parsed.execution.toLowerCase() !== 'isolated')
    )
  ) {
    throw new ManagedSkillValidationError(
      'invalid_frontmatter',
      'Managed SKILL.md execution must be "inline" or "isolated".',
      'execution',
    );
  }

  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  if (metadata.tenon !== undefined && !isRecord(metadata.tenon)) {
    throw new ManagedSkillValidationError('invalid_compatibility', 'SKILL.md metadata.tenon must be a mapping.', 'metadata.tenon');
  }
  const tenonMetadata = isRecord(metadata.tenon) ? metadata.tenon : {};
  let skillRange: string | undefined;
  if (tenonMetadata.version !== undefined) {
    if (typeof tenonMetadata.version !== 'string' || !tenonMetadata.version.trim() || tenonMetadata.version.length > 256) {
      throw new ManagedSkillValidationError(
        'invalid_compatibility',
        'SKILL.md metadata.tenon.version must be a non-empty SemVer range of at most 256 characters.',
        'metadata.tenon.version',
      );
    }
    skillRange = tenonMetadata.version.trim();
  }
  const versionValue = typeof metadata.version === 'string' || typeof metadata.version === 'number'
    ? String(metadata.version).trim()
    : typeof parsed.version === 'string' || typeof parsed.version === 'number'
      ? String(parsed.version).trim()
      : '';
  return {
    name: nameValue,
    description,
    ...(versionValue ? { version: versionValue } : {}),
    compatibility: resolveManagedSkillCompatibility({
      appVersion: input.appVersion,
      catalogRange: input.catalogCompatibilityRange,
      skillRange,
    }),
  };
}

export function resolveManagedSkillCompatibility(input: {
  appVersion: string;
  catalogRange?: string;
  skillRange?: string;
}): ManagedSkillCompatibilityView {
  if (!valid(input.appVersion)) {
    throw new ManagedSkillValidationError('invalid_compatibility', `Tenon version "${input.appVersion}" is not valid SemVer.`);
  }
  const ranges = [input.catalogRange, input.skillRange].filter((range): range is string => Boolean(range?.trim()));
  for (const range of ranges) {
    if (!validRange(range)) {
      throw new ManagedSkillValidationError('invalid_compatibility', `Invalid Tenon compatibility range "${range}".`);
    }
    if (!satisfies(input.appVersion, range, { includePrerelease: true })) {
      throw new ManagedSkillValidationError('incompatible_tenon', `This skill requires Tenon ${range}; the installed version is ${input.appVersion}.`);
    }
  }
  return {
    status: ranges.length > 0 ? 'compatible' : 'unknown',
    appVersion: input.appVersion,
    ...(ranges.length > 0 ? { declaredRange: ranges.join(' and ') } : {}),
    ...(ranges.length > 0 ? { declaredRanges: [...ranges] } : {}),
  };
}

export function hashManagedSkillFiles(files: readonly ManagedSkillFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => compareManagedSkillPaths(left.relativePath, right.relativePath))) {
    const pathBytes = Buffer.from(file.relativePath, 'utf8');
    hash.update(String(pathBytes.byteLength));
    hash.update(':');
    hash.update(pathBytes);
    hash.update('\0');
    hash.update(String(file.bytes.byteLength));
    hash.update(':');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function compareManagedSkillPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function validateRelativePath(relativePath: string): void {
  const parts = relativePath.split('/');
  if (
    !relativePath
    || Buffer.byteLength(relativePath, 'utf8') > 1_024
    || relativePath.startsWith('/')
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || parts.some((part) => (
      !part
      || part === '.'
      || part === '..'
      || Buffer.byteLength(part, 'utf8') > 255
      || /[\x00-\x1f\x7f]/.test(part)
    ))
  ) {
    throw new ManagedSkillValidationError('invalid_path', `Unsafe managed-skill path: ${relativePath || '(empty)'}`, relativePath);
  }
}

function decodeManagedSkillText(relativePath: string, bytes: Uint8Array): string {
  let text: string;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    throw new ManagedSkillValidationError('invalid_text', `Managed skill text must be valid UTF-8: ${relativePath}`, relativePath);
  }
  if (/\0/.test(text) || countDisallowedControls(text) > Math.max(8, Math.floor(text.length * 0.01))) {
    throw new ManagedSkillValidationError('unsupported_binary', `Unsupported binary content: ${relativePath}`, relativePath);
  }
  return text;
}

function countDisallowedControls(text: string): number {
  let count = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) count += 1;
  }
  return count;
}

function validateBinarySignature(relativePath: string, bytes: Uint8Array): void {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const matches = extension === '.png'
    ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : extension === '.jpg' || extension === '.jpeg'
      ? startsWith(bytes, [0xff, 0xd8, 0xff])
      : extension === '.gif'
        ? startsWith(bytes, [...Buffer.from('GIF87a')]) || startsWith(bytes, [...Buffer.from('GIF89a')])
        : extension === '.pdf'
          ? startsWith(bytes, [...Buffer.from('%PDF-')])
          : extension === '.webp'
            ? startsWith(bytes, [...Buffer.from('RIFF')]) && startsWith(bytes.subarray(8), [...Buffer.from('WEBP')])
            : false;
  if (!matches) {
    throw new ManagedSkillValidationError('unsupported_binary', `Binary asset signature does not match ${extension}: ${relativePath}`, relativePath);
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function rejectEmbeddedShell(skillContent: string): void {
  if (/^\s*```!\s*(?:\r?\n|$)/m.test(skillContent) || /(?:^|\s)!`[^`]+`/.test(skillContent) || /`![^`]+`/.test(skillContent)) {
    throw new ManagedSkillValidationError('embedded_shell', 'Managed SKILL.md cannot contain embedded shell commands.', 'SKILL.md');
  }
}

function scanSecretLookingContent(relativePath: string, text: string): void {
  const patterns: readonly RegExp[] = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{24,}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(text))) {
    throw new ManagedSkillValidationError('secret_content', `Secret-looking content is not allowed in managed skills: ${relativePath}`, relativePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
