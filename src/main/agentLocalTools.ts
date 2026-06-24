import type { AgentTool } from '@earendil-works/pi-agent-core';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  AgentFileIngestionFailure,
  ingestRichDocumentAsMarkdown,
  MARKITDOWN_RICH_DOCUMENT_EXTENSIONS,
  type FileIngestionOutput,
} from './agentFileIngestion';
import { agentDerivedFileCache, derivedFileCacheKey } from './agentFileIngestionCache';
import { sha256Buffer, sha256File } from './fileHashing';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import type { AgentSkillRuntime } from './agentSkills';
import {
  AgentSkillAuthoringError,
  validateAgentSkillContentWrite,
  type AgentSkillWriteAudit,
} from './agentSkillAuthoring';
import {
  selfDefinitionRootEntries,
} from './agentAuthoring';
import {
  optionalNormalizedString,
  requiredNormalizedString,
} from './agentToolParams';
import { buildAgentLocalToolProcessEnv, runAgentToolProcess } from './agentToolProcess';

export { buildAgentLocalToolProcessEnv } from './agentToolProcess';

interface LocalToolOptions {
  localRoot?: string;
  scratchRoot?: string;
  workspace?: AgentLocalWorkspaceContext;
  skillRuntime?: AgentSkillRuntime;
}

export interface AgentLocalWorkspaceContext {
  // The agent's file area (cwd + file_* root + relative-path base). Its own outputs land here.
  root: string;
  // App-owned ephemeral area for materialized attachments / web-fetch / tool-outputs / PDF
  // pages. A sibling of `root`, so it never appears in the file area's default listings, yet
  // it is a co-trusted read root (see `resolveWorkspacePath`) so the agent can read what the
  // app places there. Defaults to `<root>/tmp` when no explicit scratch root is supplied.
  scratchRoot: string;
  // User-handed folders from remembered `Scope(read|write:...)` permission grants.
  // These widen file-tool containment without changing the relative-path base.
  permissionRoots: ResolvedAgentLocalPermissionRoot[];
  readFileState: Map<string, ReadFileState>;
  skillRuntime?: AgentSkillRuntime;
}

export interface AgentLocalPermissionRoot {
  access: 'read' | 'write';
  root: string;
}

interface ResolvedAgentLocalPermissionRoot extends AgentLocalPermissionRoot {
  realRoot: string;
  isDirectory: boolean;
}

type WorkspaceContext = AgentLocalWorkspaceContext;

interface FileReadParams {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

type FileReadData =
  | FileReadTextData
  | FileReadImageData
  | FileReadPdfData
  | FileReadMarkdownData
  | FileReadNotebookData
  | FileReadUnchangedData;

interface FileReadTextData {
  type: 'text';
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}

interface FileReadImageData {
  type: 'image';
  file: {
    filePath: string;
    base64: string;
    type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    originalSize: number;
    dimensions?: ImageDimensions;
  };
}

interface FileReadPdfData {
  type: 'pdf';
  file: {
    filePath: string;
    originalSize: number;
    totalPages: number;
    representation: 'text' | 'images' | 'text_and_images' | 'metadata';
    pages: PdfPageRange;
    extractedText?: {
      chars: number;
      truncated: boolean;
    };
    renderedImages?: {
      count: number;
      outputDir: string;
    };
  };
}

interface FileReadMarkdownData {
  type: 'markdown';
  file: {
    filePath: string;
    content: string;
    converter: 'markitdown';
    contentChars: number;
    truncated: boolean;
    originalSize: number;
  };
}

interface FileReadNotebookData {
  type: 'notebook';
  file: {
    filePath: string;
    cells: NotebookCell[];
    content: string;
    totalCells: number;
    originalSize: number;
  };
}

interface FileReadUnchangedData {
  type: 'file_unchanged';
  file: {
    filePath: string;
  };
}

interface FileGlobParams {
  pattern: string;
  path?: string;
}

export interface FileGlobData {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}

interface FileGrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-B'?: number;
  '-A'?: number;
  '-C'?: number;
  context?: number;
  '-n'?: boolean;
  '-i'?: boolean;
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

export interface FileGrepData {
  mode?: 'content' | 'files_with_matches' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
}

interface FileEditParams {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface FileEditData {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch: Hunk[];
  userModified: boolean;
  replaceAll: boolean;
  skillWrite?: AgentSkillWriteAudit;
}

interface FileWriteParams {
  file_path: string;
  content: string;
}

interface FileWriteData {
  type: 'create' | 'update';
  filePath: string;
  content: string;
  structuredPatch: Hunk[];
  originalFile: string | null;
  skillWrite?: AgentSkillWriteAudit;
}

interface FileDeleteParams {
  file_path: string;
}

interface FileDeleteData {
  filePath: string;
  trashPath: string;
  kind: 'file' | 'directory' | 'other';
}

type FileConvertOutputFormat = 'pdf' | 'png' | 'jpeg';

interface FileConvertParams {
  input_path: string;
  output_format: FileConvertOutputFormat;
  output_path?: string;
  output_dir?: string;
  pages?: string;
}

interface FileConvertOutput {
  filePath: string;
  format: FileConvertOutputFormat;
  mimeType: string;
  sizeBytes: number;
}

interface FileConvertData {
  inputPath: string;
  outputFormat: FileConvertOutputFormat;
  outputs: FileConvertOutput[];
  command: {
    executable: string;
    args: string[];
    cwd: string;
    shell: false;
    exitCode: number | null;
  };
  stdout: string;
  stderr: string;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface BashParams {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean;
}

export interface BashData {
  stdout: string;
  stderr: string;
  rawOutputPath?: string;
  interrupted: boolean;
  isImage?: boolean;
  backgroundTaskId?: string;
  backgroundedByUser?: boolean;
  assistantAutoBackgrounded?: boolean;
  dangerouslyDisableSandbox?: boolean;
  returnCodeInterpretation?: string;
  noOutputExpected?: boolean;
  structuredContent?: unknown[];
  persistedOutputPath?: string;
  persistedOutputSize?: number;
  command?: string;
  taskStatus?: BackgroundTaskStatus;
  exitCode?: number | null;
  startedAt?: string;
  completedAt?: string;
}

export interface LocalBashRunResult {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isError: boolean;
  errorMessage?: string;
  rawOutputPath?: string;
  isImage?: boolean;
  backgroundTaskId?: string;
  backgroundedByUser?: boolean;
  assistantAutoBackgrounded?: boolean;
  dangerouslyDisableSandbox?: boolean;
  returnCodeInterpretation?: string;
  noOutputExpected?: boolean;
  structuredContent?: unknown[];
  persistedOutputPath?: string;
  persistedOutputSize?: number;
  command?: string;
  taskStatus?: BackgroundTaskStatus;
  exitCode?: number | null;
  startedAt?: string;
  completedAt?: string;
}

interface TaskStopParams {
  task_id: string;
}

export interface TaskStopData {
  message: string;
  task_id: string;
  task_type: string;
  command?: string;
  status: BackgroundTaskStatus;
  outputPath: string;
}

export interface PostCompactRestoredFile {
  filePath: string;
  content: string;
  totalChars: number;
  truncated: boolean;
}

export interface ReadFileState {
  content: string;
  mtimeMs: number;
  isPartialView: boolean;
  accessedAt: number;
  offset?: number;
  limit?: number;
  encoding?: TextEncoding;
  lineEndings?: LineEndingType;
  hasBom?: boolean;
}

type TextEncoding = 'utf8' | 'utf16le';
type LineEndingType = 'LF' | 'CRLF';

interface TextFileRead {
  content: string;
  mtimeMs: number;
  encoding: TextEncoding;
  lineEndings: LineEndingType;
  hasBom: boolean;
}

interface BackgroundTask {
  taskId: string;
  command: string;
  process: ChildProcessWithoutNullStreams;
  outputPath: string;
  stdout: string;
  stderr: string;
  startedAt: number;
  status: BackgroundTaskStatus;
  exitCode?: number | null;
  returnCodeInterpretation?: string;
  completedAt?: number;
  outputWriteChain?: Promise<void>;
}

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

interface ImageDimensions {
  width: number;
  height: number;
}

interface NotebookCell {
  cellType: 'code' | 'markdown' | 'raw' | 'unknown';
  source: string;
  outputs?: string[];
  executionCount?: number | null;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  stdoutChars: number;
  stderrChars: number;
  exitCode: number | null;
  error?: Error;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

interface ProcessOptions {
  maxStdoutChars?: number;
  maxStderrChars?: number;
}

interface ProcessItemsResult {
  items: string[];
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  error?: Error;
}

interface PdfPageRange {
  firstPage: number;
  lastPage: number;
}

class LocalToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instructions?: string,
  ) {
    super(message);
    this.name = 'LocalToolFailure';
  }
}

const backgroundTasks = new Map<string, BackgroundTask>();

const DEFAULT_FILE_READ_LIMIT = 2000;
const MAX_FILE_READ_LIMIT = 20000;
const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MARKDOWN_SOURCE_BYTES = 50 * 1024 * 1024;
const DEFAULT_GLOB_LIMIT = 100;
const FILE_GLOB_CANDIDATE_LIMIT = 5000;
const DEFAULT_GREP_HEAD_LIMIT = 250;
const HARD_GREP_OUTPUT_LIMIT = 5000;
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const BASH_AUTO_BACKGROUND_MS = 15_000;
const BASH_INLINE_OUTPUT_LIMIT = 30_000;
const BACKGROUND_TASK_HISTORY_LIMIT = 20;
const BACKGROUND_TASK_TTL_MS = 30 * 60_000;
const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024;
const PDF_MAX_PAGES_PER_READ = 20;
const PDF_INLINE_PAGE_THRESHOLD = 10;
const PDF_TEXT_MAX_CHARS = 60_000;
const PDF_TEXT_TRUNCATION_MARKER = '\n[PDF text truncated]';
const PDF_TEXT_CAPTURE_CHARS = PDF_TEXT_MAX_CHARS + 1;
const PDF_INFO_CACHE_EXTRACTOR = 'pdfinfo:v1';
const PDF_TEXT_CACHE_EXTRACTOR = 'pdftotext-layout:v1';
const CONVERT_TIMEOUT_MS = 180_000;
export const POPPLER_RECOVERY_INSTRUCTIONS = [
  'Poppler is required for PDF metadata, text extraction, page rendering, and conversion.',
  'Run bash to detect an available package manager and install Poppler.',
  'Do not assume Homebrew is available: use an installed manager such as `brew install poppler`, `sudo port install poppler`, `sudo apt-get update && sudo apt-get install -y poppler-utils`, `sudo dnf install -y poppler-utils`, or `sudo pacman -S --noconfirm poppler`.',
  'If no supported package manager is available, report that Poppler must be installed so pdfinfo, pdftotext, and pdftoppm are on PATH.',
  'After installation, retry the same file_read or file_convert call.',
].join(' ');
const IGNORED_DIRECTORIES = new Set(['.agent-trash', '.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', 'dist', 'out', 'release', 'target']);
const IMAGE_MEDIA_TYPES = new Map<string, FileReadImageData['file']['type']>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);
const OFFICE_CONVERTIBLE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.odp',
  '.ods',
  '.odt',
  '.ppt',
  '.pptx',
  '.rtf',
  '.xls',
  '.xlsx',
]);
const CONVERT_FORMAT_EXTENSIONS: Record<FileConvertOutputFormat, string> = {
  pdf: '.pdf',
  png: '.png',
  jpeg: '.jpg',
};
const CONVERT_FORMAT_MIME_TYPES: Record<FileConvertOutputFormat, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
};
const SILENT_COMMANDS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'ln', 'cd', 'export', 'unset', 'wait']);
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = new Set(['sleep']);

const FILE_READ_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['file_path'],
  properties: {
    file_path: { type: 'string', minLength: 1, description: 'The absolute path to the file to read.' },
    offset: { type: 'integer', minimum: 0, description: 'The line number to start reading from. Only provide if the file is too large to read at once.' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_FILE_READ_LIMIT, description: 'The number of lines to read. Only provide if the file is too large to read at once.' },
    pages: { type: 'string', description: `Page range for PDF files, for example "1-5", "3", or "10-20". Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.` },
  },
};

const FILE_GLOB_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', minLength: 1, description: 'The glob pattern to match files against.' },
    path: { type: 'string', minLength: 1, description: 'The directory to search in. If not specified, the default file area will be used. Omit this field for the default behavior.' },
  },
};

const FILE_GREP_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', minLength: 1, description: 'The regular expression pattern to search for in file contents.' },
    path: { type: 'string', minLength: 1, description: 'File or directory to search in. Defaults to the default file area.' },
    glob: { type: 'string', minLength: 1, description: 'Glob pattern to filter files, for example "*.js" or "*.{ts,tsx}".' },
    output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts. Defaults to "files_with_matches".' },
    '-B': { type: 'integer', minimum: 0, description: 'Number of lines to show before each match. Requires output_mode: "content", ignored otherwise.' },
    '-A': { type: 'integer', minimum: 0, description: 'Number of lines to show after each match. Requires output_mode: "content", ignored otherwise.' },
    '-C': { type: 'integer', minimum: 0, description: 'Alias for context.' },
    context: { type: 'integer', minimum: 0, description: 'Number of lines to show before and after each match. Requires output_mode: "content", ignored otherwise.' },
    '-n': { type: 'boolean', description: 'Show line numbers in output. Requires output_mode: "content", ignored otherwise. Defaults to true.' },
    '-i': { type: 'boolean', description: 'Case insensitive search.' },
    type: { type: 'string', minLength: 1, description: 'File type to search, such as js, py, rust, go, java, ts, md, or json.' },
    head_limit: { type: 'integer', minimum: 0, description: 'Limit output to first N lines or entries, equivalent to "| head -N". Works across all output modes. Defaults to 250. Pass 0 for unlimited within tool hard caps.' },
    offset: { type: 'integer', minimum: 0, description: 'Skip first N lines or entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.' },
    multiline: { type: 'boolean', description: 'Enable multiline mode where patterns can span lines. Default false.' },
  },
};

const FILE_EDIT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['file_path', 'old_string', 'new_string'],
  properties: {
    file_path: { type: 'string', minLength: 1, description: 'The absolute path to the file to modify.' },
    old_string: { type: 'string', description: 'The exact text to replace.' },
    new_string: { type: 'string', description: 'The text to replace it with. Must be different from old_string.' },
    replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string. Defaults to false.' },
  },
};

const FILE_WRITE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['file_path', 'content'],
  properties: {
    file_path: { type: 'string', minLength: 1, description: 'The absolute path to the file to write.' },
    content: { type: 'string', description: 'The content to write to the file.' },
  },
};

const FILE_DELETE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['file_path'],
  properties: {
    file_path: { type: 'string', minLength: 1, description: 'The absolute path to the file or directory to move to agent trash.' },
  },
};

const FILE_CONVERT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['input_path', 'output_format'],
  properties: {
    input_path: { type: 'string', minLength: 1, description: 'The absolute path to the source file to convert.' },
    output_format: { type: 'string', enum: ['pdf', 'png', 'jpg', 'jpeg'], description: 'Target format. Office documents and images can become pdf; PDFs can become png or jpeg page images; images can become png, jpeg, or pdf.' },
    output_path: { type: 'string', minLength: 1, description: 'Exact output file path for single-file conversions. Defaults to the workdir with the source basename and target extension.' },
    output_dir: { type: 'string', minLength: 1, description: 'Output directory for PDF page-image conversions. Defaults to a new directory in the workdir. Do not combine with output_path.' },
    pages: { type: 'string', description: 'Page range for PDF-to-image conversion, for example "1-5", "3", or "10-20". Omit it to convert every page.' },
  },
};

const BASH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: { type: 'string', minLength: 1, description: 'The command to execute.' },
    description: {
      type: 'string',
      description: [
        'Clear, concise description of what this command does in active voice.',
        'Do not use vague words like "complex" or "risk"; describe the concrete action.',
        'For simple commands such as git, npm, or standard CLI tools, keep it brief.',
        'For piped commands or obscure flags, add enough context to clarify what the command does.',
      ].join('\n'),
    },
    timeout: { type: 'integer', minimum: 1, maximum: BASH_MAX_TIMEOUT_MS, description: `Optional timeout in milliseconds. Maximum ${BASH_MAX_TIMEOUT_MS}.` },
    run_in_background: { type: 'boolean', description: 'Set to true to run this command in the background. You do not need to append "&"; use file_read on the returned output path later if needed.' },
  },
};

const TASK_STOP_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', minLength: 1, description: 'The ID of the background task to stop. Use the task_id returned by bash when a command runs in the background.' },
  },
};

export function createLocalTools(options: LocalToolOptions = {}): AgentTool<any>[] {
  const workspace = options.workspace ?? createWorkspaceContext(options.localRoot, options.scratchRoot, options.skillRuntime);
  return [
    createFileReadTool(workspace),
    createFileGlobTool(workspace),
    createFileGrepTool(workspace),
    createFileEditTool(workspace),
    createFileWriteTool(workspace),
    createFileConvertTool(workspace),
    createFileDeleteTool(workspace),
    createBashTool(workspace),
    createTaskStopTool(),
  ];
}

export async function runLocalBashCommand(
  options: { localRoot?: string; scratchRoot?: string; command: string; timeout?: number; signal?: AbortSignal },
): Promise<LocalBashRunResult> {
  const workspace = createWorkspaceContext(options.localRoot, options.scratchRoot);
  const params = normalizeBashParams({
    command: options.command,
    timeout: options.timeout,
    run_in_background: false,
  });
  const result = await runForegroundCommand(workspace, params, options.signal);
  const interpretation = interpretCommandResult(result.command ?? params.command, result.exitCode);
  const interrupted = result.interrupted;
  const isError = interrupted || interpretation.isError;
  return {
    ...result,
    interrupted,
    isError,
    errorMessage: isError
      ? (result.returnCodeInterpretation ?? interpretation.message ?? 'Command failed.')
      : undefined,
    returnCodeInterpretation: result.returnCodeInterpretation ?? interpretation.message,
  };
}

// Resolve the agent scratch root for a workdir. Production passes the explicit app-owned
// `<userData>/agent-scratch`; when none is supplied (internal callers, tests) the fallback is
// `<workdir>/tmp`, which keeps the legacy in-workdir layout and is always a sibling-or-child of
// the workdir, so containment stays well-defined. Single source of this default so the four
// callers that need scratch before a WorkspaceContext exists cannot drift.
export function scratchRootForWorkdir(workdir: string | undefined, scratchRoot: string | undefined): string {
  const root = path.resolve(nonBlank(workdir) ?? process.cwd());
  const explicit = nonBlank(scratchRoot);
  return path.resolve(explicit ?? path.join(root, 'tmp'));
}

// Treat a blank/whitespace path as unset (mirrors agentLocalRoot's env handling). Without this,
// `path.resolve('')` is `process.cwd()`, which would silently make the whole cwd a scratch root.
function nonBlank(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createWorkspaceContext(
  localRoot?: string,
  scratchRoot?: string,
  skillRuntime?: AgentSkillRuntime,
): WorkspaceContext {
  return {
    root: path.resolve(localRoot ?? process.cwd()),
    scratchRoot: scratchRootForWorkdir(localRoot, scratchRoot),
    permissionRoots: [],
    readFileState: new Map<string, ReadFileState>(),
    skillRuntime,
  };
}

export function createAgentLocalWorkspaceContext(
  localRoot?: string,
  scratchRoot?: string,
  skillRuntime?: AgentSkillRuntime,
): AgentLocalWorkspaceContext {
  return createWorkspaceContext(localRoot, scratchRoot, skillRuntime);
}

export function setAgentLocalPermissionRoots(
  workspace: AgentLocalWorkspaceContext,
  roots: readonly AgentLocalPermissionRoot[],
): void {
  workspace.permissionRoots = roots
    .flatMap((entry): ResolvedAgentLocalPermissionRoot[] => {
      const root = path.resolve(entry.root);
      const resolved = resolveCanonicalPath(root);
      if (!resolved) return [];
      return [{
        access: entry.access,
        root,
        realRoot: resolved.realPath,
        isDirectory: isDirectoryPath(resolved.realPath),
      }];
    });
}

export async function restorePostCompactReadFiles(
  workspace: AgentLocalWorkspaceContext,
  options: {
    maxFiles: number;
    maxCharsPerFile: number;
    maxTotalChars: number;
    preservedFilePaths?: ReadonlySet<string>;
  },
): Promise<PostCompactRestoredFile[]> {
  const preservedFilePaths = options.preservedFilePaths ?? new Set<string>();
  const candidates = [...workspace.readFileState.entries()]
    .filter(([filePath, state]) => !state.isPartialView && !preservedFilePaths.has(filePath))
    .sort((left, right) => right[1].accessedAt - left[1].accessedAt)
    .slice(0, Math.max(0, options.maxFiles));

  workspace.readFileState.clear();
  const restored: PostCompactRestoredFile[] = [];
  let usedChars = 0;
  for (const [filePath] of candidates) {
    if (usedChars >= options.maxTotalChars) break;
    try {
      const current = await readWorkspaceText(filePath);
      const remaining = options.maxTotalChars - usedChars;
      const limit = Math.max(0, Math.min(options.maxCharsPerFile, remaining));
      if (limit <= 0) break;
      const content = current.content.slice(0, limit);
      const truncated = content.length < current.content.length;
      workspace.readFileState.set(filePath, {
        content: current.content,
        mtimeMs: current.mtimeMs,
        isPartialView: false,
        accessedAt: Date.now(),
        encoding: current.encoding,
        lineEndings: current.lineEndings,
        hasBom: current.hasBom,
      });
      restored.push({
        filePath,
        content,
        totalChars: current.content.length,
        truncated,
      });
      usedChars += content.length;
    } catch {
      // Missing, binary, oversized, or otherwise unreadable files are skipped.
    }
  }
  return restored;
}

async function notifySuccessfulFileTouch(workspace: WorkspaceContext, filePath: string): Promise<void> {
  await workspace.skillRuntime?.notifyFileTouched([filePath]);
}

async function notifySuccessfulSkillContentWrite(
  workspace: WorkspaceContext,
  filePath: string,
  skillWrite: AgentSkillWriteAudit,
  previousContent: string | null,
): Promise<void> {
  // Record provenance BEFORE the registry reload so the reloaded skill carries
  // current trust metadata. Only SKILL.md defines the skill's identity; support
  // files don't affect trust. The previous content rides along as the
  // single-step undo version.
  if (skillWrite.changeType !== 'support-file-write') {
    await workspace.skillRuntime?.recordAgentSkillWrite(
      filePath,
      skillWrite.nextHash,
      previousContent !== null && skillWrite.previousHash
        ? { hash: skillWrite.previousHash, content: previousContent }
        : null,
    );
  }
  await workspace.skillRuntime?.notifySkillContentWritten([filePath]);
}

type SelfDefinitionWrite = { kind: 'skill'; skillWrite: AgentSkillWriteAudit };

function validateSelfDefinitionContentWriteOrThrow(input: {
  workspace: WorkspaceContext;
  filePath: string;
  content: string;
  previousContent: string | null;
  operation: 'file_edit' | 'file_write';
}): SelfDefinitionWrite | null {
  // One source of truth for "is this a skill write": the live skill registry. Without a
  // skill runtime there are no skills to govern, so a write under the skill self-dir is refused.
  const target = input.workspace.skillRuntime?.resolveSkillTarget(input.filePath) ?? null;
  if (target) {
    try {
      return {
        kind: 'skill',
        skillWrite: validateAgentSkillContentWrite({
          target,
          content: input.content,
          previousContent: input.previousContent,
          operation: input.operation,
        }),
      };
    } catch (error) {
      if (error instanceof AgentSkillAuthoringError) {
        throw new LocalToolFailure(error.code, error.message, error.instructions);
      }
      throw error;
    }
  }

  if (isSelfDefinitionWritePath(input.workspace, input.filePath)) {
    throw new LocalToolFailure(
      'ungoverned_self_definition_write',
      'Self-definition writes must target a governed skill definition file.',
      'Write a SKILL.md or visible support file under .agents/skills/<skill-name>/ with the skill runtime enabled.',
    );
  }

  return null;
}

function skillWriteInstructions(skillWrite: AgentSkillWriteAudit): string {
  return `Skill content write validated for ${skillWrite.skillName}; the skill registry has been reloaded. Previous content metadata is retained in tool details for rollback. The skill is slash-invocable now, and model-invocable skills can appear in the automatic model skill listing without a separate trust prompt.`;
}

// The skill self-definition outcome maps onto a file-write the same way for both
// file_edit and file_write: extra `data` fields, a registry-reload notify, and the
// success `instructions`. These three helpers own that mapping once so the two
// tools stay in lockstep.
function selfDefinitionWriteData(
  write: SelfDefinitionWrite | null,
): { skillWrite?: AgentSkillWriteAudit } {
  if (write?.kind === 'skill') return { skillWrite: write.skillWrite };
  return {};
}

async function notifySelfDefinitionContentWrite(
  workspace: WorkspaceContext,
  filePath: string,
  write: SelfDefinitionWrite | null,
  previousContent: string | null,
): Promise<void> {
  if (write?.kind === 'skill') {
    await notifySuccessfulSkillContentWrite(workspace, filePath, write.skillWrite, previousContent);
  }
}

function selfDefinitionWriteInstructions(write: SelfDefinitionWrite | null): string | undefined {
  if (write?.kind === 'skill') return skillWriteInstructions(write.skillWrite);
  return undefined;
}

function createFileReadTool(workspace: WorkspaceContext): AgentTool<any, ToolEnvelope<FileReadData>> {
  return {
    name: 'file_read',
    label: 'File Read',
    description: [
      'Reads a local file.',
      'The file_path parameter must be an absolute path.',
      `By default, it reads up to ${DEFAULT_FILE_READ_LIMIT} lines starting from the beginning of the file.`,
      'You can optionally specify a line offset and limit, especially for long files.',
      'This tool can read text files, images, PDFs, rich documents converted to Markdown, and Jupyter notebooks. PDFs are read as extracted text by default; use pages when page images or layout inspection are needed. It can only read files, not directories.',
      'Use this before file_edit or before rewriting an existing file with file_write.',
    ].join('\n'),
    parameters: FILE_READ_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeFileReadParams(rawParams);
        const filePath = resolveWorkspacePath(workspace, params.file_path, 'read');
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) {
          throw new LocalToolFailure('is_directory', `Path is a directory: ${filePath}`, 'Use file_glob to discover files under a directory.');
        }
        const ext = path.extname(filePath).toLowerCase();
        if (params.pages !== undefined && ext !== '.pdf') {
          throw new LocalToolFailure('invalid_args', 'The pages parameter is only valid for PDF files.', 'Remove pages or pass a .pdf file path.');
        }
        const imageType = IMAGE_MEDIA_TYPES.get(ext);
        if (imageType) {
          const buffer = await readFile(filePath);
          const data: FileReadImageData = {
            type: 'image',
            file: {
              filePath,
              base64: buffer.toString('base64'),
              type: imageType,
              originalSize: buffer.byteLength,
              dimensions: readImageDimensions(buffer, imageType),
            },
          };
          await notifySuccessfulFileTouch(workspace, filePath);
          const visible = visibleFileRead(data);
          return agentToolResult(successEnvelope('file_read', data, { metrics: metrics(started, data) }), visible, [{
            type: 'image',
            data: data.file.base64,
            mimeType: imageType,
          }]);
        }
        if (ext === '.pdf') {
          const buffer = await readFile(filePath);
          const read = await ingestPdfFile(workspace, filePath, buffer, params.pages);
          await notifySuccessfulFileTouch(workspace, filePath);
          const visible = visibleFileRead(read.data);
          return agentToolResult(successEnvelope('file_read', read.data, {
            status: read.status,
            instructions: read.instructions,
            metrics: metrics(started, read.data),
          }), visible, read.content);
        }
        if (ext === '.ipynb') {
          const buffer = await readFile(filePath);
          if (fileStat.size > MAX_TEXT_FILE_BYTES) {
            throw new LocalToolFailure('file_too_large', `Notebook is too large to read: ${filePath}`, 'Use file_grep to locate relevant content or read a smaller file.');
          }
          const decoded = decodeTextBuffer(buffer);
          const content = decoded.content;
          workspace.readFileState.set(filePath, {
            content,
            mtimeMs: fileStat.mtimeMs,
            isPartialView: false,
            accessedAt: Date.now(),
            encoding: decoded.encoding,
            lineEndings: decoded.lineEndings,
            hasBom: decoded.hasBom,
          });
          const cells = parseNotebook(content);
          const rendered = renderNotebookCells(cells);
          const data: FileReadNotebookData = {
            type: 'notebook',
            file: {
              filePath,
              cells,
              content: rendered,
              totalCells: cells.length,
              originalSize: buffer.byteLength,
            },
          };
          await notifySuccessfulFileTouch(workspace, filePath);
          const visible = visibleFileRead(data);
          return agentToolResult(successEnvelope('file_read', data, { metrics: metrics(started, data) }), visible);
        }
        if (MARKITDOWN_RICH_DOCUMENT_EXTENSIONS.has(ext)) {
          if (fileStat.size > MAX_MARKDOWN_SOURCE_BYTES) {
            throw new LocalToolFailure('file_too_large', `File is too large to convert to Markdown: ${filePath}`, `Use a smaller document, split it first, or convert it manually to Markdown. Maximum source size is ${formatBytes(MAX_MARKDOWN_SOURCE_BYTES)}.`);
          }
          const sourceHash = await sha256File(filePath);
          const read = await ingestRichDocumentFile(filePath, fileStat.size, sourceHash);
          await notifySuccessfulFileTouch(workspace, filePath);
          const visible = visibleFileRead(read.data);
          return agentToolResult(successEnvelope('file_read', read.data, {
            status: read.status,
            instructions: read.instructions,
            metrics: metrics(started, read.data),
          }), visible, read.content);
        }
        if (fileStat.size > MAX_TEXT_FILE_BYTES) {
          throw new LocalToolFailure('file_too_large', `File is too large to read as text: ${filePath}`, 'Use file_grep to locate relevant content or read a smaller file.');
        }
        const buffer = await readFile(filePath);
        if (looksBinary(buffer)) {
          throw new LocalToolFailure('binary_unsupported', `Binary file is not supported by file_read: ${filePath}`, 'Use a text, image, PDF, notebook, or supported rich document file path.');
        }
        const decoded = decodeTextBuffer(buffer);
        const content = decoded.content;
        const lines = splitLines(content);
        const requestedOffset = clampInteger(params.offset, 0, Number.MAX_SAFE_INTEGER, 1);
        const lineOffset = requestedOffset === 0 ? 0 : requestedOffset - 1;
        const limit = clampInteger(params.limit, 1, MAX_FILE_READ_LIMIT, DEFAULT_FILE_READ_LIMIT);
        const previousRead = workspace.readFileState.get(filePath);
        if (
          previousRead &&
          !previousRead.isPartialView &&
          previousRead.offset === requestedOffset &&
          previousRead.limit === limit &&
          previousRead.mtimeMs === fileStat.mtimeMs
        ) {
          previousRead.accessedAt = Date.now();
          const data: FileReadUnchangedData = {
            type: 'file_unchanged',
            file: { filePath },
          };
          await notifySuccessfulFileTouch(workspace, filePath);
          const visible = visibleFileRead(data);
          return agentToolResult(successEnvelope('file_read', data, {
            status: 'unchanged',
            instructions: 'The file is unchanged since the previous full file_read result. Use the earlier content already in context instead of reading it again.',
            metrics: metrics(started, data),
          }), visible);
        }
        const selected = lines.slice(lineOffset, lineOffset + limit);
        const partial = lineOffset > 0 || selected.length < lines.length;
        const startLine = selected.length ? (requestedOffset === 0 ? 1 : requestedOffset) : 0;
        workspace.readFileState.set(filePath, {
          content,
          mtimeMs: fileStat.mtimeMs,
          isPartialView: partial,
          accessedAt: Date.now(),
          offset: requestedOffset,
          limit,
          encoding: decoded.encoding,
          lineEndings: decoded.lineEndings,
          hasBom: decoded.hasBom,
        });
        const data: FileReadTextData = {
          type: 'text',
          file: {
            filePath,
            content: selected.join('\n'),
            numLines: selected.length,
            startLine,
            totalLines: lines.length,
          },
        };
        const nextOffset = startLine + selected.length;
        await notifySuccessfulFileTouch(workspace, filePath);
        const visible = visibleFileRead(data);
        return agentToolResult(successEnvelope('file_read', data, {
          // A partial read is `status: 'partial'` so the model gets a structured
          // truncation signal, not just prose it might skip.
          status: partial ? 'partial' : undefined,
          instructions: partial ? `Call file_read with offset ${nextOffset} to continue, or read the whole file before editing it.` : undefined,
          metrics: { ...metrics(started, data), truncated: partial },
        }), visible);
      } catch (error) {
        return localErrorResult('file_read', error, started);
      }
    },
  };
}

function createFileGlobTool(workspace: WorkspaceContext): AgentTool<any, ToolEnvelope<FileGlobData>> {
  return {
    name: 'file_glob',
    label: 'File Glob',
    description: [
      'Fast file pattern matching tool that works with large file trees.',
      'Supports glob patterns like "**/*.js" or "src/**/*.ts".',
      'Returns matching file paths sorted by modification time.',
      'Use this tool when you need to find files by name patterns.',
    ].join('\n'),
    parameters: FILE_GLOB_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeFileGlobParams(rawParams);
        const searchRoot = params.path ? resolveWorkspacePath(workspace, params.path, 'read') : workspace.root;
        const matcher = createGlobMatcher(params.pattern, searchRoot);
        const candidates = await collectFileGlobCandidates(searchRoot, params.pattern);
        const matched = candidates.files.filter((file) => matcher(file));
        const withStats = (await Promise.all(matched.map(statFileForGlob))).filter((item): item is { filePath: string; mtimeMs: number } => item !== null);
        withStats.sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath));
        const selected = withStats.slice(0, DEFAULT_GLOB_LIMIT).map((item) => relativeToWorkspace(workspace, item.filePath));
        const data: FileGlobData = {
          durationMs: elapsed(started),
          numFiles: selected.length,
          filenames: selected,
          truncated: candidates.truncated || matched.length > selected.length,
        };
        return agentToolResult(successEnvelope('file_glob', data, {
          instructions: data.truncated ? 'Results were truncated. Use a more specific pattern or path.' : undefined,
          metrics: { durationMs: elapsed(started), truncated: data.truncated, outputBytes: jsonByteLength(data) },
        }), visibleFileGlob(data));
      } catch (error) {
        return localErrorResult('file_glob', error, started);
      }
    },
  };
}

function createFileGrepTool(workspace: WorkspaceContext): AgentTool<any, ToolEnvelope<FileGrepData>> {
  return {
    name: 'file_grep',
    label: 'File Grep',
    description: [
      'Search file contents with a regular expression.',
      'Always use file_grep for search tasks instead of invoking grep or rg through bash.',
      'Supports regex syntax, glob filtering, type filtering, output modes, context lines, pagination, and explicit multiline matching.',
      'Default output mode is files_with_matches so broad searches stay cheap.',
    ].join('\n'),
    parameters: FILE_GREP_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeFileGrepParams(rawParams);
        const data = await runGrep(workspace, params);
        return agentToolResult(successEnvelope('file_grep', data, {
          instructions: data.appliedLimit !== undefined ? `More results may be available. Call file_grep again with offset ${(data.appliedOffset ?? 0) + data.appliedLimit}.` : undefined,
          metrics: metrics(started, data),
        }), visibleFileGrep(data));
      } catch (error) {
        return localErrorResult('file_grep', error, started);
      }
    },
  };
}

function createFileEditTool(workspace: WorkspaceContext): AgentTool<any, ToolEnvelope<FileEditData>> {
  return {
    name: 'file_edit',
    label: 'File Edit',
    description: [
      'Performs exact string replacements in files.',
      'You must use file_read before editing. This tool will error if you attempt an edit without reading the file.',
      'The edit will fail if old_string is not unique in the file. Provide more surrounding context or use replace_all to change every instance.',
      'old_string must not be empty. Use file_write to create files or rewrite an empty file.',
      'This tool does not edit Jupyter notebooks (.ipynb). There is currently no notebook cell edit tool.',
      'Use replace_all for replacing or renaming strings across the file.',
    ].join('\n'),
    parameters: FILE_EDIT_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeFileEditParams(rawParams);
        const filePath = resolveWorkspacePath(workspace, params.file_path, 'write');
        if (path.extname(filePath).toLowerCase() === '.ipynb') {
          throw new LocalToolFailure(
            'notebook_edit_required',
            'File is a Jupyter Notebook. file_edit does not edit .ipynb files.',
            'Use file_read to inspect notebook cells. Rewrite the notebook with file_write only if the user explicitly asks for a complete notebook rewrite.',
          );
        }
        if (params.old_string === params.new_string) {
          throw new LocalToolFailure('no_change', 'old_string and new_string are identical.', 'Change new_string or skip the edit.');
        }
        if (params.old_string === '') {
          throw new LocalToolFailure('empty_old_string', 'old_string must not be empty for file_edit.', 'Use file_write to create a new file or rewrite an empty file.');
        }
        const current = await readWorkspaceText(filePath);
        await assertFreshFullRead(workspace, filePath, current.content);
        const occurrences = countOccurrences(current.content, params.old_string);
        if (occurrences === 0) {
          if (current.content.includes(params.new_string)) {
            const data: FileEditData = {
              filePath,
              oldString: params.old_string,
              newString: params.new_string,
              originalFile: current.content,
              structuredPatch: [],
              userModified: false,
              replaceAll: params.replace_all === true,
            };
            await notifySuccessfulFileTouch(workspace, filePath);
            return agentToolResult(successEnvelope('file_edit', data, {
              status: 'unchanged',
              instructions: 'The requested replacement already appears to be present.',
              metrics: metrics(started, data),
            }), visibleFileEdit(data));
          }
          throw new LocalToolFailure('old_string_not_found', 'old_string was not found in the current file.', 'Call file_read again and copy an exact current fragment.');
        }
        if (occurrences > 1 && params.replace_all !== true) {
          throw new LocalToolFailure('multiple_matches', `old_string appears ${occurrences} times.`, 'Add more surrounding context or set replace_all true.');
        }
        const nextContent = params.replace_all
          ? current.content.split(params.old_string).join(params.new_string)
          : current.content.replace(params.old_string, params.new_string);
        const selfDefinitionWrite = validateSelfDefinitionContentWriteOrThrow({
          workspace,
          filePath,
          content: nextContent,
          previousContent: current.content,
          operation: 'file_edit',
        });
        await writeTextFile(filePath, nextContent, current);
        const nextStat = await stat(filePath);
        workspace.readFileState.set(filePath, {
          content: nextContent,
          mtimeMs: nextStat.mtimeMs,
          isPartialView: false,
          accessedAt: Date.now(),
          encoding: current.encoding,
          lineEndings: current.lineEndings,
          hasBom: current.hasBom,
        });
        const data: FileEditData = {
          filePath,
          oldString: params.old_string,
          newString: params.new_string,
          originalFile: current.content,
          structuredPatch: structuredPatch(current.content, nextContent),
          userModified: false,
          replaceAll: params.replace_all === true,
          ...selfDefinitionWriteData(selfDefinitionWrite),
        };
        await notifySuccessfulFileTouch(workspace, filePath);
        await notifySelfDefinitionContentWrite(workspace, filePath, selfDefinitionWrite, current.content);
        return agentToolResult(successEnvelope('file_edit', data, {
          instructions: selfDefinitionWriteInstructions(selfDefinitionWrite),
          metrics: metrics(started, data),
        }), visibleFileEdit(data));
      } catch (error) {
        return localErrorResult('file_edit', error, started);
      }
    },
  };
}

function createFileWriteTool(workspace: WorkspaceContext): AgentTool<any, ToolEnvelope<FileWriteData>> {
  return {
    name: 'file_write',
    label: 'File Write',
    description: [
      'Writes a local file.',
      'This tool overwrites the existing file if there is one at the provided path.',
      'If this is an existing file, you must use file_read first to read the file contents.',
      'Prefer file_edit for modifying existing files because it only sends the diff. Use file_write to create new files or for complete rewrites.',
    ].join('\n'),
    parameters: FILE_WRITE_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeFileWriteParams(rawParams);
        const filePath = resolveWorkspacePath(workspace, params.file_path, 'write');
        let original: TextFileRead | null = null;
        try {
          original = await readWorkspaceText(filePath);
          await assertFreshFullRead(workspace, filePath, original.content);
        } catch (error) {
          if (!(error instanceof LocalToolFailure && error.code === 'file_not_found')) throw error;
        }
        const originalContent = original?.content ?? null;
        if (originalContent === params.content) {
          const data: FileWriteData = { type: 'update', filePath, content: params.content, structuredPatch: [], originalFile: originalContent };
          await notifySuccessfulFileTouch(workspace, filePath);
          return agentToolResult(successEnvelope('file_write', data, {
            status: 'unchanged',
            instructions: 'The file already has the requested content.',
            metrics: metrics(started, data),
          }), visibleFileWrite(data));
        }
        const selfDefinitionWrite = validateSelfDefinitionContentWriteOrThrow({
          workspace,
          filePath,
          content: params.content,
          previousContent: originalContent,
          operation: 'file_write',
        });
        await mkdir(path.dirname(filePath), { recursive: true });
        const metadata = { encoding: original?.encoding ?? 'utf8' as const, lineEndings: 'LF' as const, hasBom: false };
        await writeTextFile(filePath, params.content, metadata);
        const nextStat = await stat(filePath);
        workspace.readFileState.set(filePath, {
          content: params.content,
          mtimeMs: nextStat.mtimeMs,
          isPartialView: false,
          accessedAt: Date.now(),
          encoding: metadata.encoding,
          lineEndings: metadata.lineEndings,
          hasBom: metadata.hasBom,
        });
        const data: FileWriteData = {
          type: originalContent === null ? 'create' : 'update',
          filePath,
          content: params.content,
          structuredPatch: originalContent === null ? [] : structuredPatch(originalContent, params.content),
          originalFile: originalContent,
          ...selfDefinitionWriteData(selfDefinitionWrite),
        };
        await notifySuccessfulFileTouch(workspace, filePath);
        await notifySelfDefinitionContentWrite(workspace, filePath, selfDefinitionWrite, originalContent);
        return agentToolResult(successEnvelope('file_write', data, {
          instructions: selfDefinitionWriteInstructions(selfDefinitionWrite),
          metrics: metrics(started, data),
        }), visibleFileWrite(data));
      } catch (error) {
        return localErrorResult('file_write', error, started);
      }
    },
  };
}

function createFileConvertTool(workspace: WorkspaceContext): AgentTool<any, ToolEnvelope<FileConvertData>> {
  return {
    name: 'file_convert',
    label: 'File Convert',
    description: [
      'Converts local files with typed, non-shell converters.',
      'Use this instead of bash for common document and image conversions.',
      'Supported conversions: office documents and presentations to PDF, PDF pages to PNG/JPEG images, and images to PDF/PNG/JPEG.',
      'Input and output paths must be inside the allowed file area or an explicitly handed scope.',
      'The tool refuses to overwrite existing outputs.',
    ].join('\n'),
    parameters: FILE_CONVERT_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeFileConvertParams(rawParams);
        const inputPath = resolveWorkspacePath(workspace, params.input_path, 'read');
        const inputStat = await stat(inputPath).catch((error: unknown) => {
          throw localFsError(error, inputPath);
        });
        if (inputStat.isDirectory()) {
          throw new LocalToolFailure('is_directory', `Path is a directory: ${inputPath}`, 'Pass a file path to file_convert.');
        }

        const data = await convertFile(workspace, inputPath, params);
        await notifySuccessfulFileTouch(workspace, inputPath);
        for (const output of data.outputs) {
          await notifySuccessfulFileTouch(workspace, output.filePath);
        }
        return agentToolResult(successEnvelope('file_convert', data, {
          instructions: `Converted ${path.basename(inputPath)} to ${data.outputs.map((output) => output.filePath).join(', ')}.`,
          metrics: metrics(started, data),
        }), visibleFileConvert(data));
      } catch (error) {
        return localErrorResult('file_convert', error, started);
      }
    },
  };
}

function createFileDeleteTool(workspace: WorkspaceContext): AgentTool<any, ToolEnvelope<FileDeleteData>> {
  return {
    name: 'file_delete',
    label: 'File Delete',
    description: [
      'Moves a local file or directory to agent trash instead of permanently deleting it.',
      'Use this for reversible cleanup inside the allowed file area. It cannot delete the file area root.',
      'The result includes the trash path so the item can be recovered if needed.',
    ].join('\n'),
    parameters: FILE_DELETE_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeFileDeleteParams(rawParams);
        const filePath = resolveWorkspacePath(workspace, params.file_path, 'write');
        if (isSelfDefinitionWritePath(workspace, filePath)) {
          throw new LocalToolFailure(
            'self_definition_delete_not_supported',
            'Deleting skills or agents through file_delete is not supported.',
            'Edit or create self-definition files through file_write/file_edit. Delete agents in Settings.',
          );
        }
        if (isFileAreaRoot(workspace, filePath)) {
          throw new LocalToolFailure('root_delete_forbidden', 'Cannot delete the allowed file area root.', 'Delete a specific file or subdirectory instead.');
        }
        const trashRoot = agentTrashRoot(workspace);
        if (isResolvedPathInside(trashRoot, path.resolve(filePath))) {
          throw new LocalToolFailure('trash_delete_forbidden', 'Cannot delete the agent trash directory with file_delete.', 'Leave trash cleanup to the app or delete a specific non-trash path.');
        }
        const fileStat = await stat(filePath).catch((error: unknown) => {
          throw localFsError(error, filePath);
        });
        const trashPath = await nextTrashPath(workspace, filePath);
        await mkdir(path.dirname(trashPath), { recursive: true });
        await rename(filePath, trashPath);
        clearReadStateForDeletedPath(workspace, filePath);
        const data: FileDeleteData = {
          filePath,
          trashPath,
          kind: fileStat.isFile() ? 'file' : fileStat.isDirectory() ? 'directory' : 'other',
        };
        await notifySuccessfulFileTouch(workspace, filePath);
        return agentToolResult(successEnvelope('file_delete', data, {
          instructions: `Moved to agent trash at ${trashPath}. Move it back from trash to recover it.`,
          metrics: metrics(started, data),
        }), visibleFileDelete(data));
      } catch (error) {
        return localErrorResult('file_delete', error, started);
      }
    },
  };
}

function createBashTool(workspace: WorkspaceContext): AgentTool<any, ToolEnvelope<BashData>> {
  return {
    name: 'bash',
    label: 'Bash',
    description: [
      'Executes a shell command in the default file area.',
      'Use file_read, file_edit, file_write, file_convert, file_delete, file_glob, and file_grep for filesystem operations when possible.',
      'Use run_in_background for long-running commands. You do not need to append "&"; use task_stop if the task needs to be stopped.',
      'Commands should include a clear description of what they do in active voice.',
    ].join('\n'),
    parameters: BASH_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown, signal?: AbortSignal) => {
      const started = Date.now();
      try {
        const params = normalizeBashParams(rawParams);
        if (params.run_in_background) {
          const data = await startBackgroundCommand(workspace, params);
          return agentToolResult(successEnvelope('bash', data, {
            instructions: `Command is running in the background as ${data.backgroundTaskId}. Use task_stop with task_id if it needs to be stopped.`,
            metrics: metrics(started, data),
          }), visibleBash(data));
        }
        const result = await runForegroundCommand(workspace, params, signal);
        const interpretation = interpretCommandResult(result.command ?? params.command, result.exitCode);
        const ok = result.backgroundTaskId !== undefined || (!result.interrupted && !interpretation.isError);
        const envelope = ok
          ? successEnvelope('bash', result, {
            instructions: result.backgroundTaskId
              ? `Command is still running in the background as ${result.backgroundTaskId}. Read ${result.persistedOutputPath} with file_read to check output, or use task_stop with task_id if it needs to be stopped.`
              : undefined,
            metrics: metrics(started, result),
          })
          : errorEnvelope<BashData>('bash', result.interrupted ? 'command_interrupted' : 'command_failed', result.returnCodeInterpretation ?? interpretation.message ?? 'Command was interrupted.', {
            data: result,
            instructions: 'Inspect stdout and stderr. Fix the command or inputs, then retry if appropriate.',
            metrics: metrics(started, result),
          });
        return agentToolResult(envelope, visibleBash(result));
      } catch (error) {
        return localErrorResult('bash', error, started);
      }
    },
  };
}

function createTaskStopTool(): AgentTool<any, ToolEnvelope<TaskStopData>> {
  return {
    name: 'task_stop',
    label: 'Task Stop',
    description: [
      'Stops a running background task by its ID.',
      'Use this tool when you need to terminate a long-running task created by bash.',
      'Only task_id is supported; shell_id is not accepted.',
    ].join('\n'),
    parameters: TASK_STOP_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeTaskStopParams(rawParams);
        pruneBackgroundTasks();
        const task = backgroundTasks.get(params.task_id);
        if (!task) {
          throw new LocalToolFailure('task_not_found', `No background task found with id: ${params.task_id}`, 'Use the task_id returned by a recent bash run_in_background call.');
        }
        if (task.status !== 'running') {
          throw new LocalToolFailure('task_not_running', `Task ${params.task_id} is not running.`, 'No stop is needed for completed, failed, or already stopped tasks.');
        }
        task.status = 'stopped';
        task.completedAt = Date.now();
        task.process.kill('SIGTERM');
        await appendTaskOutput(task);
        pruneBackgroundTasks();
        const data: TaskStopData = {
          message: `Successfully stopped task: ${task.taskId} (${task.command})`,
          task_id: task.taskId,
          task_type: 'bash',
          command: task.command,
          status: task.status,
          outputPath: task.outputPath,
        };
        return agentToolResult(successEnvelope('task_stop', data, { metrics: metrics(started, data) }), visibleTaskStop(data));
      } catch (error) {
        return localErrorResult('task_stop', error, started);
      }
    },
  };
}

function normalizeFileReadParams(rawParams: unknown): FileReadParams {
  const input = asRecord(rawParams);
  const filePath = requiredLocalString(input.file_path, 'file_path');
  return {
    file_path: filePath,
    offset: input.offset === undefined ? undefined : clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0),
    limit: input.limit === undefined ? undefined : clampInteger(input.limit, 1, MAX_FILE_READ_LIMIT, DEFAULT_FILE_READ_LIMIT),
    pages: typeof input.pages === 'string' ? input.pages : undefined,
  };
}

function normalizeFileGlobParams(rawParams: unknown): FileGlobParams {
  const input = asRecord(rawParams);
  return {
    pattern: requiredLocalString(input.pattern, 'pattern'),
    path: optionalNormalizedString(input.path),
  };
}

function normalizeFileGrepParams(rawParams: unknown): FileGrepParams {
  const input = asRecord(rawParams);
  return {
    pattern: requiredLocalString(input.pattern, 'pattern'),
    path: optionalNormalizedString(input.path),
    glob: optionalNormalizedString(input.glob),
    output_mode: input.output_mode === 'content' || input.output_mode === 'count' || input.output_mode === 'files_with_matches' ? input.output_mode : 'files_with_matches',
    '-B': optionalInteger(input['-B'], 0, 1000),
    '-A': optionalInteger(input['-A'], 0, 1000),
    '-C': optionalInteger(input['-C'], 0, 1000),
    context: optionalInteger(input.context, 0, 1000),
    '-n': input['-n'] === false ? false : true,
    '-i': input['-i'] === true,
    type: optionalNormalizedString(input.type),
    head_limit: optionalInteger(input.head_limit, 0, HARD_GREP_OUTPUT_LIMIT),
    offset: optionalInteger(input.offset, 0, Number.MAX_SAFE_INTEGER),
    multiline: input.multiline === true,
  };
}

function normalizeFileEditParams(rawParams: unknown): FileEditParams {
  const input = asRecord(rawParams);
  if (typeof input.old_string !== 'string') throw new LocalToolFailure('invalid_args', 'old_string is required.');
  if (typeof input.new_string !== 'string') throw new LocalToolFailure('invalid_args', 'new_string is required.');
  return {
    file_path: requiredLocalString(input.file_path, 'file_path'),
    old_string: normalizeLineEndings(input.old_string),
    new_string: normalizeLineEndings(input.new_string),
    replace_all: input.replace_all === true,
  };
}

function normalizeFileWriteParams(rawParams: unknown): FileWriteParams {
  const input = asRecord(rawParams);
  if (typeof input.content !== 'string') throw new LocalToolFailure('invalid_args', 'content is required.');
  return {
    file_path: requiredLocalString(input.file_path, 'file_path'),
    content: normalizeLineEndings(input.content),
  };
}

function normalizeFileConvertParams(rawParams: unknown): FileConvertParams {
  const input = asRecord(rawParams);
  const inputPath = requiredLocalString(input.input_path, 'input_path');
  const outputFormat = normalizeConvertOutputFormat(input.output_format);
  const outputPath = optionalNormalizedString(input.output_path);
  const outputDir = optionalNormalizedString(input.output_dir);
  const pages = typeof input.pages === 'string' ? input.pages : undefined;
  const extension = path.extname(inputPath).toLowerCase();
  const isPdfToImage = (outputFormat === 'png' || outputFormat === 'jpeg') && extension === '.pdf';
  if (outputPath && outputDir) {
    throw new LocalToolFailure('invalid_args', 'output_path and output_dir cannot be used together.', 'Use output_path for one output file, or output_dir for PDF page images.');
  }
  if (pages !== undefined && !isPdfToImage) {
    throw new LocalToolFailure('invalid_args', 'pages is only valid when converting PDF pages to images.', 'Remove pages or convert a PDF to png/jpeg.');
  }
  if (outputDir && !isPdfToImage) {
    throw new LocalToolFailure('invalid_args', 'output_dir is only valid for PDF page-image conversions.', 'Use output_path for single-file output.');
  }
  if (outputPath && isPdfToImage) {
    throw new LocalToolFailure('invalid_args', 'output_path is not supported for PDF page-image conversions.', 'Use output_dir so multiple page outputs can be returned.');
  }
  return {
    input_path: inputPath,
    output_format: outputFormat,
    output_path: outputPath,
    output_dir: outputDir,
    pages,
  };
}

function normalizeFileDeleteParams(rawParams: unknown): FileDeleteParams {
  const input = asRecord(rawParams);
  return {
    file_path: requiredLocalString(input.file_path, 'file_path'),
  };
}

function normalizeBashParams(rawParams: unknown): BashParams {
  const input = asRecord(rawParams);
  const command = requiredLocalString(input.command, 'command');
  return {
    command,
    description: optionalNormalizedString(input.description),
    timeout: clampInteger(input.timeout, 1, BASH_MAX_TIMEOUT_MS, BASH_DEFAULT_TIMEOUT_MS),
    run_in_background: input.run_in_background === true,
    dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
  };
}

function normalizeTaskStopParams(rawParams: unknown): TaskStopParams {
  const input = asRecord(rawParams);
  return { task_id: requiredLocalString(input.task_id, 'task_id') };
}

function normalizeConvertOutputFormat(value: unknown): FileConvertOutputFormat {
  if (typeof value !== 'string') {
    throw new LocalToolFailure('invalid_args', 'output_format is required.');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'jpg') return 'jpeg';
  if (normalized === 'pdf' || normalized === 'png' || normalized === 'jpeg') return normalized;
  throw new LocalToolFailure('unsupported_conversion', `Unsupported output_format: ${value}`, 'Use pdf, png, jpg, or jpeg.');
}

async function convertFile(
  workspace: WorkspaceContext,
  inputPath: string,
  params: FileConvertParams,
): Promise<FileConvertData> {
  const extension = path.extname(inputPath).toLowerCase();
  if (params.output_format === 'pdf') {
    const outputPath = resolveSingleConvertOutputPath(workspace, inputPath, params);
    await assertOutputPathAvailable(outputPath, inputPath);
    if (IMAGE_MEDIA_TYPES.has(extension)) {
      return await convertImageWithSips(inputPath, outputPath, params.output_format);
    }
    if (OFFICE_CONVERTIBLE_EXTENSIONS.has(extension)) {
      return await convertOfficeToPdf(workspace, inputPath, outputPath);
    }
  }

  if ((params.output_format === 'png' || params.output_format === 'jpeg') && extension === '.pdf') {
    return await convertPdfToImages(workspace, inputPath, params);
  }

  if ((params.output_format === 'png' || params.output_format === 'jpeg') && IMAGE_MEDIA_TYPES.has(extension)) {
    const outputPath = resolveSingleConvertOutputPath(workspace, inputPath, params);
    await assertOutputPathAvailable(outputPath, inputPath);
    return await convertImageWithSips(inputPath, outputPath, params.output_format);
  }

  throw new LocalToolFailure(
    'unsupported_conversion',
    `Unsupported conversion from ${extension || 'unknown file type'} to ${params.output_format}.`,
    'Use office/presentation files to PDF, PDF to PNG/JPEG pages, or images to PDF/PNG/JPEG.',
  );
}

function resolveSingleConvertOutputPath(
  workspace: WorkspaceContext,
  inputPath: string,
  params: FileConvertParams,
): string {
  const fallback = path.join(
    workspace.root,
    `${path.basename(inputPath, path.extname(inputPath))}${CONVERT_FORMAT_EXTENSIONS[params.output_format]}`,
  );
  const outputPath = resolveWorkspacePath(workspace, params.output_path ?? fallback, 'write');
  assertNotSelfDefinitionConvertOutput(workspace, outputPath);
  return outputPath;
}

function assertNotSelfDefinitionConvertOutput(workspace: WorkspaceContext, outputPath: string): void {
  if (!isSelfDefinitionWritePath(workspace, outputPath)) return;
  throw new LocalToolFailure(
    'self_definition_convert_output_not_supported',
    'file_convert cannot write skill or agent definition content.',
    'Use file_write or file_edit so self-definition content is validated and hot-reloaded.',
  );
}

async function assertOutputPathAvailable(outputPath: string, inputPath: string): Promise<void> {
  if (path.resolve(outputPath) === path.resolve(inputPath)) {
    throw new LocalToolFailure('output_overwrites_input', 'Output path must differ from the input path.', 'Choose a distinct output_path.');
  }
  try {
    await stat(outputPath);
    throw new LocalToolFailure('output_exists', `Output path already exists: ${outputPath}`, 'Choose a new output_path or delete the existing output first.');
  } catch (error) {
    if (error instanceof LocalToolFailure) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw localFsError(error, outputPath);
  }
}

async function convertOfficeToPdf(
  workspace: WorkspaceContext,
  inputPath: string,
  outputPath: string,
): Promise<FileConvertData> {
  const tempDir = path.join(toolOutputDir(workspace), `convert-office-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, inputPath];
  const attempted: string[] = [];
  try {
    for (const executable of ['soffice', 'libreoffice']) {
      attempted.push(executable);
      const result = await runProcess(executable, args, path.dirname(inputPath), CONVERT_TIMEOUT_MS);
      if (result.error && isNodeError(result.error) && result.error.code === 'ENOENT') continue;
      if (result.error) {
        throw new LocalToolFailure('converter_failed', result.error.message, 'Check that LibreOffice can run on this system.');
      }
      if (result.exitCode !== 0) {
        throw new LocalToolFailure('converter_failed', result.stderr.trim() || 'LibreOffice conversion failed.', 'Check that the source file is valid and supported.');
      }
      const generatedPath = await findSingleConvertedFile(tempDir, '.pdf');
      await moveFile(generatedPath, outputPath);
      await rm(tempDir, { recursive: true, force: true });
      return await convertedData(inputPath, 'pdf', [outputPath], executable, args, path.dirname(inputPath), result);
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  await rm(tempDir, { recursive: true, force: true });
  throw new LocalToolFailure(
    'converter_unavailable',
    `Could not find LibreOffice converter (${attempted.join(', ')}).`,
    'Install LibreOffice so soffice or libreoffice is available on PATH.',
  );
}

async function convertPdfToImages(
  workspace: WorkspaceContext,
  inputPath: string,
  params: FileConvertParams,
): Promise<FileConvertData> {
  const totalPages = await getPdfPageCount(inputPath);
  const range = selectPdfConversionPageRange(totalPages, params.pages);
  const outputDir = resolveWorkspacePath(
    workspace,
    params.output_dir ?? path.join(workspace.root, `${path.basename(inputPath, path.extname(inputPath))}-pages-${randomUUID().slice(0, 8)}`),
    'write',
  );
  assertNotSelfDefinitionConvertOutput(workspace, outputDir);
  await ensureDirectoryOutput(outputDir);

  const formatFlag = params.output_format === 'png' ? '-png' : '-jpeg';
  const extension = params.output_format === 'png' ? '.png' : '.jpg';
  const basename = path.basename(inputPath, path.extname(inputPath));
  const prefix = path.join(outputDir, basename);
  await assertNoPageOutputs(outputDir, basename, extension);
  const args = [
    formatFlag,
    '-r',
    '144',
    '-f',
    String(range.firstPage),
    '-l',
    String(range.lastPage),
    inputPath,
    prefix,
  ];
  const result = await runProcess('pdftoppm', args, path.dirname(inputPath), CONVERT_TIMEOUT_MS);
  if (result.error) {
    throw new LocalToolFailure('converter_unavailable', result.error.message, POPPLER_RECOVERY_INSTRUCTIONS);
  }
  if (result.exitCode !== 0) {
    throw pdfPageRenderFailure(
      result.stderr,
      'converter_failed',
      'pdftoppm conversion failed.',
      'Check that the PDF and page range are valid.',
    );
  }
  const outputs = (await readdir(outputDir))
    .filter((entry) => entry.startsWith(`${basename}-`) && entry.endsWith(extension))
    .sort(naturalCompare)
    .map((entry) => path.join(outputDir, entry));
  if (!outputs.length) {
    throw new LocalToolFailure('converter_failed', 'pdftoppm produced no page images.', 'Check that the PDF is valid and retry.');
  }
  return await convertedData(inputPath, params.output_format, outputs, 'pdftoppm', args, path.dirname(inputPath), result);
}

async function convertImageWithSips(
  inputPath: string,
  outputPath: string,
  outputFormat: FileConvertOutputFormat,
): Promise<FileConvertData> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = ['-s', 'format', outputFormat, inputPath, '--out', outputPath];
  const result = await runProcess('sips', args, path.dirname(inputPath), CONVERT_TIMEOUT_MS);
  if (result.error) {
    throw new LocalToolFailure('converter_unavailable', result.error.message, 'Use macOS sips or convert this file through an installed image converter.');
  }
  if (result.exitCode !== 0) {
    throw new LocalToolFailure('converter_failed', result.stderr.trim() || 'sips conversion failed.', 'Check that the source image is valid and supported.');
  }
  return await convertedData(inputPath, outputFormat, [outputPath], 'sips', args, path.dirname(inputPath), result);
}

async function ensureDirectoryOutput(outputDir: string): Promise<void> {
  try {
    const outputStat = await stat(outputDir);
    if (!outputStat.isDirectory()) {
      throw new LocalToolFailure('not_directory', `Output path is not a directory: ${outputDir}`, 'Choose another output_dir.');
    }
  } catch (error) {
    if (error instanceof LocalToolFailure) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      await mkdir(outputDir, { recursive: true });
      return;
    }
    throw localFsError(error, outputDir);
  }
}

async function assertNoPageOutputs(outputDir: string, basename: string, extension: string): Promise<void> {
  const existing = (await readdir(outputDir)).find((entry) => entry.startsWith(`${basename}-`) && entry.endsWith(extension));
  if (existing) {
    throw new LocalToolFailure('output_exists', `Output page already exists: ${path.join(outputDir, existing)}`, 'Choose an empty output_dir or remove existing page images first.');
  }
}

async function findSingleConvertedFile(tempDir: string, extension: string): Promise<string> {
  const files = (await readdir(tempDir)).filter((entry) => entry.toLowerCase().endsWith(extension));
  if (files.length !== 1) {
    throw new LocalToolFailure('converter_failed', `Expected one ${extension} output, found ${files.length}.`, 'Check the converter output and retry with an explicit output_path.');
  }
  return path.join(tempDir, files[0]!);
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EXDEV') {
      await copyFile(source, destination);
      await unlink(source);
      return;
    }
    throw localFsError(error, destination);
  }
}

async function convertedData(
  inputPath: string,
  outputFormat: FileConvertOutputFormat,
  outputPaths: readonly string[],
  executable: string,
  args: string[],
  cwd: string,
  result: ProcessResult,
): Promise<FileConvertData> {
  const outputs = await Promise.all(outputPaths.map(async (filePath): Promise<FileConvertOutput> => ({
    filePath,
    format: outputFormat,
    mimeType: CONVERT_FORMAT_MIME_TYPES[outputFormat],
    sizeBytes: (await stat(filePath)).size,
  })));
  return {
    inputPath,
    outputFormat,
    outputs,
    command: {
      executable,
      args,
      cwd,
      shell: false,
      exitCode: result.exitCode,
    },
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runGrep(workspace: WorkspaceContext, params: FileGrepParams): Promise<FileGrepData> {
  const target = params.path ? resolveWorkspacePath(workspace, params.path, 'read') : workspace.root;
  const targetStat = await stat(target).catch((error: unknown) => {
    throw localFsError(error, target);
  });
  if (!targetStat.isDirectory() && !targetStat.isFile()) {
    throw new LocalToolFailure('invalid_path', `Path is not a regular file or directory: ${target}`, 'Use file_glob to find a searchable file or directory.');
  }

  const mode = params.output_mode ?? 'files_with_matches';
  const args = buildRipgrepArgs(workspace, target, params);
  const result = await runProcess('rg', args, workspace.root);
  if (result.error) {
    throw new LocalToolFailure('ripgrep_unavailable', result.error.message, 'Install ripgrep or make sure rg is available on PATH.');
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const message = result.stderr.trim() || `rg exited with code ${result.exitCode}.`;
    throw new LocalToolFailure('ripgrep_failed', message, 'Fix the regular expression, path, glob, or type filter and retry.');
  }

  const rawLines = splitProcessLines(result.stdout);

  if (mode === 'content') {
    const page = applyHeadLimit(rawLines.map((line) => relativizeRipgrepLine(workspace, line, 'content')), params.head_limit, params.offset);
    return {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: page.items.join('\n'),
      numLines: page.items.length,
      ...(page.appliedLimit !== undefined ? { appliedLimit: page.appliedLimit } : {}),
      ...(page.appliedOffset !== undefined ? { appliedOffset: page.appliedOffset } : {}),
    };
  }

  if (mode === 'count') {
    const countLines = rawLines.map((line) => relativizeRipgrepLine(workspace, line, 'count'));
    const page = applyHeadLimit(countLines, params.head_limit, params.offset);
    const numMatches = page.items.reduce((sum, line) => {
      const colonIndex = line.lastIndexOf(':');
      const parsed = colonIndex >= 0 ? Number(line.slice(colonIndex + 1)) : Number.NaN;
      return Number.isFinite(parsed) ? sum + parsed : sum;
    }, 0);
    return {
      mode: 'count',
      numFiles: page.items.length,
      filenames: [],
      content: page.items.join('\n'),
      numMatches,
      ...(page.appliedLimit !== undefined ? { appliedLimit: page.appliedLimit } : {}),
      ...(page.appliedOffset !== undefined ? { appliedOffset: page.appliedOffset } : {}),
    };
  }

  const filenames = rawLines.map((line) => relativeToWorkspace(workspace, path.resolve(workspace.root, line)));
  const page = applyHeadLimit(filenames, params.head_limit, params.offset);
  return {
    mode: 'files_with_matches',
    numFiles: page.items.length,
    filenames: page.items,
    ...(page.appliedLimit !== undefined ? { appliedLimit: page.appliedLimit } : {}),
    ...(page.appliedOffset !== undefined ? { appliedOffset: page.appliedOffset } : {}),
  };
}

function buildRipgrepArgs(workspace: WorkspaceContext, target: string, params: FileGrepParams): string[] {
  const mode = params.output_mode ?? 'files_with_matches';
  const args = ['--hidden', '--max-columns', '500'];
  for (const dir of ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules']) {
    args.push('--glob', `!**/${dir}/**`);
  }
  if (params.multiline) args.push('-U', '--multiline-dotall');
  if (params['-i']) args.push('-i');
  if (mode === 'files_with_matches') args.push('-l');
  if (mode === 'count') args.push('-c');
  if (mode === 'content') {
    args.push('--no-heading');
    if (params['-n'] !== false) args.push('-n');
    if (params.context !== undefined) {
      args.push('-C', String(params.context));
    } else if (params['-C'] !== undefined) {
      args.push('-C', String(params['-C']));
    } else {
      if (params['-B'] !== undefined) args.push('-B', String(params['-B']));
      if (params['-A'] !== undefined) args.push('-A', String(params['-A']));
    }
  }
  if (params.type) args.push('--type', params.type);
  if (params.glob) {
    for (const globPattern of splitGlobPatterns(params.glob)) {
      args.push('--glob', globPattern);
    }
  }
  if (params.pattern.startsWith('-')) {
    args.push('-e', params.pattern);
  } else {
    args.push(params.pattern);
  }
  args.push(relativeTarget(workspace, target));
  return args;
}

function splitGlobPatterns(glob: string): string[] {
  const patterns: string[] = [];
  for (const raw of glob.split(/\s+/)) {
    if (!raw) continue;
    if (raw.includes('{') && raw.includes('}')) {
      patterns.push(raw);
    } else {
      patterns.push(...raw.split(',').filter(Boolean));
    }
  }
  return patterns;
}

function splitProcessLines(stdout: string): string[] {
  const normalized = normalizeLineEndings(stdout);
  if (!normalized.trim()) return [];
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
}

function relativizeRipgrepLine(workspace: WorkspaceContext, line: string, mode: 'content' | 'count'): string {
  const colonIndex = mode === 'count' ? line.lastIndexOf(':') : line.indexOf(':');
  if (colonIndex <= 0) return line;
  const filePart = line.slice(0, colonIndex);
  const rest = line.slice(colonIndex);
  const filePath = path.isAbsolute(filePart) ? filePart : path.resolve(workspace.root, filePart);
  return `${relativeToWorkspace(workspace, filePath)}${rest}`;
}

function relativeTarget(workspace: WorkspaceContext, target: string): string {
  const relative = path.relative(workspace.root, target);
  return relative ? normalizePathSeparators(relative) : '.';
}

function relativeToWorkspace(workspace: WorkspaceContext, filePath: string): string {
  const relative = path.relative(workspace.root, filePath);
  return normalizePathSeparators(relative || path.basename(filePath));
}

function agentTrashRoot(workspace: WorkspaceContext): string {
  return path.join(path.resolve(workspace.root), '.agent-trash');
}

async function nextTrashPath(workspace: WorkspaceContext, filePath: string): Promise<string> {
  const root = path.resolve(workspace.root);
  const relative = path.relative(root, filePath);
  const normalizedRelative = !relative || relative.startsWith('..') || path.isAbsolute(relative)
    ? path.basename(filePath)
    : relative;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(agentTrashRoot(workspace), `${stamp}-${randomUUID()}`, normalizedRelative);
}

function clearReadStateForDeletedPath(workspace: WorkspaceContext, filePath: string): void {
  const resolved = path.resolve(filePath);
  for (const cachedPath of [...workspace.readFileState.keys()]) {
    if (isResolvedPathInside(resolved, path.resolve(cachedPath))) {
      workspace.readFileState.delete(cachedPath);
    }
  }
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs = 60_000, options: ProcessOptions = {}): Promise<ProcessResult> {
  return await runAgentToolProcess(command, args, cwd, timeoutMs, options);
}

async function runProcessItems(
  command: string,
  args: string[],
  cwd: string,
  separator: string,
  maxItems: number,
  timeoutMs: number,
): Promise<ProcessItemsResult> {
  return await new Promise<ProcessItemsResult>((resolve) => {
    const child = spawn(command, args, { cwd, env: buildAgentLocalToolProcessEnv(), shell: false });
    const items: string[] = [];
    let stderr = '';
    let pending = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (result: ProcessItemsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stopForLimit = () => {
      if (truncated) return;
      truncated = true;
      child.kill('SIGTERM');
    };
    const pushItem = (item: string) => {
      if (!item) return;
      if (items.length >= maxItems) {
        stopForLimit();
        return;
      }
      items.push(item);
      if (items.length >= maxItems) stopForLimit();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const parts = `${pending}${chunk}`.split(separator);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        pushItem(part);
        if (truncated) break;
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      finish({ items, stderr, exitCode: null, truncated, timedOut, error });
    });
    child.once('close', (code) => {
      if (pending && !truncated && !timedOut) pushItem(pending);
      finish({ items, stderr, exitCode: code, truncated, timedOut });
    });
  });
}

interface CommandInterpretation {
  isError: boolean;
  message?: string;
}

function interpretCommandResult(command: string, exitCode: number | null | undefined): CommandInterpretation {
  if (exitCode === undefined || exitCode === 0) return { isError: false };
  if (exitCode === null) return { isError: true, message: 'Command failed to start.' };

  const baseCommand = extractBaseCommand(command);
  if (baseCommand === 'grep' || baseCommand === 'egrep' || baseCommand === 'fgrep' || baseCommand === 'rg') {
    return exitCode === 1
      ? { isError: false, message: 'No matches found' }
      : { isError: true, message: `Search command failed with exit code ${exitCode}` };
  }
  if (baseCommand === 'find') {
    return exitCode === 1
      ? { isError: false, message: 'Some directories were inaccessible' }
      : { isError: true, message: `Find command failed with exit code ${exitCode}` };
  }
  if (baseCommand === 'diff') {
    return exitCode === 1
      ? { isError: false, message: 'Files differ' }
      : { isError: true, message: `Diff command failed with exit code ${exitCode}` };
  }
  if (baseCommand === 'test' || baseCommand === '[' || baseCommand === '[[') {
    return exitCode === 1
      ? { isError: false, message: 'Condition is false' }
      : { isError: true, message: `Test command failed with exit code ${exitCode}` };
  }
  return { isError: true, message: `Command failed with exit code ${exitCode}` };
}

function extractBaseCommand(command: string): string {
  const segments = command
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  let segment = segments.at(-1) ?? command.trim();
  segment = segment.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '').trim();
  const [rawCommand] = segment.match(/(?:"[^"]+"|'[^']+'|\S+)/) ?? [];
  return (rawCommand ?? '').replace(/^["']|["']$/g, '').split('/').at(-1) ?? '';
}

async function runForegroundCommand(workspace: WorkspaceContext, params: BashParams, signal?: AbortSignal): Promise<BashData> {
  const timeoutMs = clampInteger(params.timeout, 1, BASH_MAX_TIMEOUT_MS, BASH_DEFAULT_TIMEOUT_MS);
  const child = spawn(params.command, {
    cwd: workspace.root,
    shell: true,
    env: buildAgentLocalToolProcessEnv(),
  });
  let stdout = '';
  let stderr = '';
  let interrupted = false;
  let timedOut = false;
  let resolved = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    interrupted = true;
    child.kill('SIGTERM');
  }, timeoutMs);
  const onAbort = () => {
    interrupted = true;
    child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  return await new Promise<BashData>((resolve, reject) => {
    const autoBackgroundTimer = setTimeout(() => {
      if (resolved || interrupted || !shouldAutoBackground(params.command)) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      void registerBackgroundTask(workspace, params, child, {
        initialStdout: stdout,
        initialStderr: stderr,
        assistantAutoBackgrounded: true,
      }).then((data) => resolve(data), reject);
    }, BASH_AUTO_BACKGROUND_MS);

    child.once('error', (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      clearTimeout(autoBackgroundTimer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      clearTimeout(autoBackgroundTimer);
      signal?.removeEventListener('abort', onAbort);
      void (async () => {
        const persisted = await persistLargeOutput(workspace, stdout, stderr);
        const display = persisted
          ? truncateShellOutput(stdout, stderr)
          : { stdout, stderr };
        const interpretation = timedOut
          ? { isError: true, message: `Command timed out after ${timeoutMs}ms.` }
          : interpretCommandResult(params.command, code);
        resolve({
          stdout: display.stdout,
          stderr: display.stderr,
          interrupted,
          exitCode: code,
          command: params.command,
          returnCodeInterpretation: interpretation.message,
          noOutputExpected: isSilentCommand(params.command),
          dangerouslyDisableSandbox: params.dangerouslyDisableSandbox,
          persistedOutputPath: persisted?.path,
          persistedOutputSize: persisted?.size,
        });
      })().catch(reject);
    });
  });
}

async function startBackgroundCommand(workspace: WorkspaceContext, params: BashParams): Promise<BashData> {
  const child = spawn(params.command, {
    cwd: workspace.root,
    shell: true,
    env: buildAgentLocalToolProcessEnv(),
  });
  return registerBackgroundTask(workspace, params, child, { backgroundedByUser: true });
}

async function registerBackgroundTask(
  workspace: WorkspaceContext,
  params: BashParams,
  child: ChildProcessWithoutNullStreams,
  options: {
    initialStdout?: string;
    initialStderr?: string;
    backgroundedByUser?: boolean;
    assistantAutoBackgrounded?: boolean;
  } = {},
): Promise<BashData> {
  pruneBackgroundTasks();
  const taskId = `task_${randomUUID()}`;
  const outputPath = taskOutputPath(workspace, taskId);
  const task: BackgroundTask = {
    taskId,
    command: params.command,
    process: child,
    outputPath,
    stdout: options.initialStdout ?? '',
    stderr: options.initialStderr ?? '',
    startedAt: Date.now(),
    status: 'running',
  };
  backgroundTasks.set(taskId, task);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    task.stdout += chunk;
    void appendTaskOutput(task);
  });
  child.stderr.on('data', (chunk: string) => {
    task.stderr += chunk;
    void appendTaskOutput(task);
  });
  child.once('close', (code) => {
    const interpretation = interpretCommandResult(params.command, code);
    if (task.status === 'running') task.status = interpretation.isError ? 'failed' : 'completed';
    task.exitCode = code;
    task.returnCodeInterpretation = interpretation.message;
    task.completedAt = Date.now();
    void appendTaskOutput(task).finally(() => pruneBackgroundTasks());
  });
  child.once('error', (error) => {
    task.status = 'failed';
    task.completedAt = Date.now();
    task.stderr += `\n${errorMessage(error)}`;
    void appendTaskOutput(task).finally(() => pruneBackgroundTasks());
  });
  await appendTaskOutput(task);
  return {
    stdout: '',
    stderr: '',
    interrupted: false,
    backgroundTaskId: taskId,
    backgroundedByUser: options.backgroundedByUser,
    assistantAutoBackgrounded: options.assistantAutoBackgrounded,
    command: params.command,
    taskStatus: task.status,
    startedAt: new Date(task.startedAt).toISOString(),
    noOutputExpected: isSilentCommand(params.command),
    dangerouslyDisableSandbox: params.dangerouslyDisableSandbox,
    persistedOutputPath: outputPath,
    persistedOutputSize: new TextEncoder().encode(task.stdout + task.stderr).byteLength,
  };
}

interface FileGlobCandidates {
  files: string[];
  truncated: boolean;
}

async function collectFileGlobCandidates(searchRoot: string, pattern: string): Promise<FileGlobCandidates> {
  const ripgrep = await collectFilesWithRipgrep(searchRoot, pattern);
  if (ripgrep) return ripgrep;
  return collectFilesFallback(searchRoot, FILE_GLOB_CANDIDATE_LIMIT);
}

async function collectFilesWithRipgrep(searchRoot: string, pattern: string): Promise<FileGlobCandidates | null> {
  const args = ['--files', '--hidden', '--null'];
  const positiveGlob = ripgrepGlobForFileGlob(pattern, searchRoot);
  if (positiveGlob) args.push('--glob', positiveGlob);
  for (const dir of IGNORED_DIRECTORIES) {
    args.push('--glob', `!**/${dir}/**`);
  }

  const result = await runProcessItems('rg', args, searchRoot, '\0', FILE_GLOB_CANDIDATE_LIMIT, 30_000);
  if (result.error || result.timedOut) return null;
  if (result.exitCode !== 0 && result.exitCode !== 1 && !result.truncated) return null;
  return {
    files: result.items.map((item) => path.resolve(searchRoot, item)),
    truncated: result.truncated,
  };
}

function ripgrepGlobForFileGlob(pattern: string, searchRoot: string): string | null {
  if (pattern.startsWith('!')) return null;
  if (!path.isAbsolute(pattern)) return normalizeRipgrepFileGlob(pattern);
  const relativePattern = path.relative(searchRoot, pattern);
  if (relativePattern.startsWith('..') || path.isAbsolute(relativePattern)) return null;
  return normalizeRipgrepFileGlob(relativePattern || path.basename(pattern));
}

function normalizeRipgrepFileGlob(pattern: string): string {
  const normalized = normalizePathSeparators(pattern);
  return !normalized.includes('/') && !normalized.includes('**') ? `/${normalized}` : normalized;
}

async function collectFilesFallback(root: string, limit: number): Promise<FileGlobCandidates> {
  const out: string[] = [];
  let truncated = false;
  async function visit(dir: string) {
    if (out.length >= limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await visit(full);
      } else if (entry.isFile()) {
        if (out.length >= limit) {
          truncated = true;
          return;
        }
        out.push(full);
      }
    }
  }
  await visit(root);
  return { files: out, truncated };
}

async function statFileForGlob(filePath: string): Promise<{ filePath: string; mtimeMs: number } | null> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? { filePath, mtimeMs: fileStat.mtimeMs } : null;
  } catch {
    return null;
  }
}

function createGlobMatcher(pattern: string, root: string): (filePath: string) => boolean {
  const normalizedPattern = normalizePathSeparators(pattern);
  const absolutePattern = path.isAbsolute(pattern);
  const regex = globToRegex(normalizedPattern);
  return (filePath) => {
    const target = absolutePattern
      ? normalizePathSeparators(filePath)
      : normalizePathSeparators(path.relative(root, filePath));
    return regex.test(target);
  };
}

function globToRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === '*') {
      if (next === '*') {
        const after = pattern[index + 2];
        if (after === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end > index) {
        const alternatives = pattern.slice(index + 1, end).split(',').map(escapeRegExp).join('|');
        source += `(?:${alternatives})`;
        index = end;
      } else {
        source += escapeRegExp(char);
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  source += '$';
  return new RegExp(source);
}

function readImageDimensions(buffer: Buffer, mediaType: FileReadImageData['file']['type']): ImageDimensions | undefined {
  try {
    if (mediaType === 'image/png') {
      if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      }
    }
    if (mediaType === 'image/gif') {
      if (buffer.length >= 10 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
      }
    }
    if (mediaType === 'image/jpeg') return readJpegDimensions(buffer);
    if (mediaType === 'image/webp') return readWebpDimensions(buffer);
  } catch {
    return undefined;
  }
  return undefined;
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return undefined;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (chunkType === 'VP8X' && dataOffset + 10 <= buffer.length) {
      return {
        width: 1 + readUInt24LE(buffer, dataOffset + 4),
        height: 1 + readUInt24LE(buffer, dataOffset + 7),
      };
    }
    if (chunkType === 'VP8 ' && dataOffset + 10 <= buffer.length) {
      return {
        width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    }
    if (chunkType === 'VP8L' && dataOffset + 5 <= buffer.length && buffer[dataOffset] === 0x2f) {
      const b1 = buffer[dataOffset + 1]!;
      const b2 = buffer[dataOffset + 2]!;
      const b3 = buffer[dataOffset + 3]!;
      const b4 = buffer[dataOffset + 4]!;
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return undefined;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

async function getPdfPageCount(filePath: string, sourceHash?: string): Promise<number> {
  const cacheKey = sourceHash
    ? derivedFileCacheKey(PDF_INFO_CACHE_EXTRACTOR, sourceHash, pdfToolCacheOptions({}))
    : null;
  const cached = cacheKey ? agentDerivedFileCache.get<number>(cacheKey) : undefined;
  if (cached !== undefined) return cached;

  const result = await runProcess('pdfinfo', [filePath], path.dirname(filePath), 30_000);
  if (result.error) {
    throw new LocalToolFailure('pdf_reader_unavailable', result.error.message, POPPLER_RECOVERY_INSTRUCTIONS);
  }
  if (result.exitCode !== 0) {
    throw new LocalToolFailure('pdf_read_failed', result.stderr.trim() || 'pdfinfo failed.', 'Check that the PDF is valid and readable.');
  }
  const match = result.stdout.match(/^Pages:\s+(\d+)$/m);
  const pages = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(pages) || pages < 1) {
    throw new LocalToolFailure('pdf_read_failed', 'Could not determine the PDF page count.', 'Check that the PDF is valid and readable.');
  }
  if (cacheKey) agentDerivedFileCache.set(cacheKey, pages);
  return pages;
}

async function ingestPdfFile(
  workspace: WorkspaceContext,
  filePath: string,
  buffer: Buffer,
  requestedPages: string | undefined,
): Promise<FileIngestionOutput<FileReadPdfData>> {
  const originalSize = buffer.byteLength;
  if (originalSize === 0) {
    throw new LocalToolFailure('pdf_empty', `PDF file is empty: ${filePath}`, 'Use a valid PDF file.');
  }
  if (!isPdfBuffer(buffer)) {
    throw new LocalToolFailure('pdf_corrupted', `File is not a valid PDF: ${filePath}`, 'Use a valid PDF file, or read the file with its actual extension.');
  }
  if (originalSize > PDF_MAX_EXTRACT_SIZE) {
    throw new LocalToolFailure('pdf_too_large', `PDF file exceeds maximum extraction size of ${formatBytes(PDF_MAX_EXTRACT_SIZE)}.`, 'Use a smaller PDF or split it first.');
  }

  const sourceHash = sha256Buffer(buffer);
  const totalPages = await getPdfPageCount(filePath, sourceHash);
  const range = selectPdfPageRange(totalPages, requestedPages);
  const requestedPageImages = requestedPages !== undefined;
  const requestedRendered = requestedPageImages ? await renderPdfPages(workspace, filePath, range) : null;
  const extractedText = await extractPdfText(filePath, range, { ignoreUnavailableReader: requestedPageImages, sourceHash });
  const shouldRenderInlineFallback = !requestedRendered && !extractedText && totalPages <= PDF_INLINE_PAGE_THRESHOLD;
  const rendered = requestedRendered ?? (shouldRenderInlineFallback ? await renderPdfPages(workspace, filePath, range) : null);
  const imageContent = rendered ? await readPdfPartImages(rendered.outputDir) : [];
  const textContent = extractedText
    ? [{
        type: 'text' as const,
        text: `Extracted text from PDF pages ${range.firstPage}-${range.lastPage} of ${filePath}${extractedText.truncated ? ' (truncated)' : ''}:\n\n${extractedText.text}`,
      }]
    : [];
  const data: FileReadPdfData = {
    type: 'pdf',
    file: {
      filePath,
      originalSize,
      totalPages,
      representation: extractedText && rendered
        ? 'text_and_images'
        : extractedText ? 'text' : rendered ? 'images' : 'metadata',
      pages: range,
      ...(extractedText ? {
        extractedText: {
          chars: extractedText.chars,
          truncated: extractedText.truncated,
        },
      } : {}),
      ...(rendered ? {
        renderedImages: {
          count: rendered.count,
          outputDir: rendered.outputDir,
        },
      } : {}),
    },
  };

  if (extractedText && rendered) {
    return {
      data,
      content: [...textContent, ...imageContent],
      instructions: 'PDF text was extracted for searchable content, and selected pages were rendered as images for visual layout inspection.',
    };
  }
  if (extractedText) {
    return {
      data,
      content: textContent,
      instructions: 'PDF text was extracted locally and attached as text. Use the pages parameter only when you need page images or layout inspection.',
    };
  }
  if (rendered) {
    return {
      data,
      content: imageContent,
      instructions: 'No embedded PDF text was extracted. PDF pages were rendered as images and attached so the model can inspect them visually.',
      status: 'partial',
    };
  }
  return {
    data,
    content: [{
      type: 'text',
      text: `PDF metadata for ${filePath}: ${totalPages} pages. No embedded text was extracted in the default read.`,
    }],
    instructions: `No embedded PDF text was extracted, and the PDF has too many pages to render inline. Call file_read again with pages, for example "1-5". Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
    status: 'partial',
  };
}

async function ingestRichDocumentFile(filePath: string, originalSize: number, sourceHash: string): Promise<FileIngestionOutput<FileReadMarkdownData>> {
  const markdown = await ingestRichDocumentAsMarkdown(filePath, sourceHash);
  const textContent = {
    type: 'text' as const,
    text: `Converted Markdown from ${filePath}${markdown.truncated ? ' (truncated)' : ''}:\n\n${markdown.content}`,
  };
  const data: FileReadMarkdownData = {
    type: 'markdown',
    file: {
      filePath,
      content: markdown.content,
      converter: markdown.converter,
      contentChars: markdown.contentChars,
      truncated: markdown.truncated,
      originalSize,
    },
  };
  const instructions = markdown.truncated
    ? 'The document was converted to Markdown locally and truncated to fit the file_read output cap. Convert the document manually or split it if more content is needed.'
    : 'The document was converted to Markdown locally.';
  return {
    data,
    content: [textContent],
    status: markdown.truncated ? 'partial' : undefined,
    instructions,
  };
}

async function renderPdfPages(workspace: WorkspaceContext, filePath: string, range: PdfPageRange): Promise<{ count: number; outputDir: string }> {
  const outputDir = path.join(toolOutputDir(workspace), `pdf-${randomUUID()}`);
  await mkdir(outputDir, { recursive: true });
  const prefix = path.join(outputDir, 'page');
  const args = ['-jpeg', '-r', '100', '-f', String(range.firstPage), '-l', String(range.lastPage), filePath, prefix];
  const result = await runProcess('pdftoppm', args, path.dirname(filePath), 120_000);
  if (result.error) {
    throw new LocalToolFailure('pdf_reader_unavailable', result.error.message, POPPLER_RECOVERY_INSTRUCTIONS);
  }
  if (result.exitCode !== 0) {
    throw pdfPageRenderFailure(
      result.stderr,
      'pdf_read_failed',
      'pdftoppm failed.',
      'Check the PDF file and page range, then retry.',
    );
  }

  const imageFiles = (await readdir(outputDir)).filter((entry) => entry.endsWith('.jpg')).sort(naturalCompare);
  if (!imageFiles.length) {
    throw new LocalToolFailure('pdf_corrupted', 'pdftoppm produced no output pages. The PDF may be invalid.', 'Check the PDF file or convert it to images manually.');
  }
  return {
    count: imageFiles.length,
    outputDir,
  };
}

function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.byteLength >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-';
}

async function extractPdfText(
  filePath: string,
  range: PdfPageRange,
  options: { ignoreUnavailableReader?: boolean; sourceHash?: string } = {},
): Promise<{ text: string; chars: number; truncated: boolean } | null> {
  const cacheKey = options.sourceHash
    ? derivedFileCacheKey(PDF_TEXT_CACHE_EXTRACTOR, options.sourceHash, pdfToolCacheOptions({
        firstPage: range.firstPage,
        lastPage: range.lastPage,
        maxChars: PDF_TEXT_MAX_CHARS,
      }))
    : null;
  const cached = cacheKey ? agentDerivedFileCache.get<{ text: string; chars: number; truncated: boolean }>(cacheKey) : undefined;
  if (cached) return cached;

  const result = await runProcess('pdftotext', [
    '-layout',
    '-f',
    String(range.firstPage),
    '-l',
    String(range.lastPage),
    filePath,
    '-',
  ], path.dirname(filePath), 60_000, { maxStdoutChars: PDF_TEXT_CAPTURE_CHARS });
  if (result.error || result.exitCode === 127) {
    if (options.ignoreUnavailableReader) return null;
    throw new LocalToolFailure(
      'pdf_reader_unavailable',
      result.error?.message ?? (result.stderr.trim() || 'pdftotext is not available.'),
      POPPLER_RECOVERY_INSTRUCTIONS,
    );
  }
  if (result.exitCode !== 0) return null;
  const normalized = normalizeLineEndings(stripBom(result.stdout)).trim();
  if (!normalized) return null;
  const truncated = result.stdoutTruncated === true || normalized.length > PDF_TEXT_MAX_CHARS;
  const chars = truncated ? Math.max(result.stdoutChars, normalized.length) : normalized.length;
  const extracted = {
    text: truncated ? `${normalized.slice(0, PDF_TEXT_MAX_CHARS)}${PDF_TEXT_TRUNCATION_MARKER}` : normalized,
    chars,
    truncated,
  };
  if (cacheKey) agentDerivedFileCache.set(cacheKey, extracted);
  return extracted;
}

function pdfToolCacheOptions(options: Record<string, string | number | boolean | null | undefined>): Record<string, string | number | boolean | null | undefined> {
  return {
    ...options,
    path: process.env.PATH ?? '',
    extraPath: process.env.LIN_AGENT_EXTRA_TOOL_PATH ?? '',
  };
}

function selectPdfPageRange(totalPages: number, requestedPages: string | undefined): PdfPageRange {
  if (!requestedPages) {
    return { firstPage: 1, lastPage: totalPages };
  }
  const range = parsePdfPageRange(requestedPages);
  if (!range) {
    throw new LocalToolFailure('invalid_pdf_pages', `Invalid PDF page range: ${requestedPages}`, 'Use page ranges like "3", "1-5", or "10-20".');
  }
  const pageCount = range.lastPage - range.firstPage + 1;
  if (pageCount > PDF_MAX_PAGES_PER_READ) {
    throw new LocalToolFailure('pdf_page_limit_exceeded', `Page range "${requestedPages}" exceeds ${PDF_MAX_PAGES_PER_READ} pages.`, 'Use a smaller pages range.');
  }
  if (range.firstPage > totalPages) {
    throw new LocalToolFailure('pdf_page_range_empty', `Page range "${requestedPages}" starts after the PDF ends.`, `Use pages between 1 and ${totalPages}.`);
  }
  return { firstPage: range.firstPage, lastPage: Math.min(range.lastPage, totalPages) };
}

function selectPdfConversionPageRange(totalPages: number, requestedPages: string | undefined): PdfPageRange {
  if (!requestedPages) return { firstPage: 1, lastPage: totalPages };
  const range = parsePdfPageRange(requestedPages);
  if (!range) {
    throw new LocalToolFailure('invalid_pdf_pages', `Invalid PDF page range: ${requestedPages}`, 'Use page ranges like "3", "1-5", or "10-20".');
  }
  if (range.firstPage > totalPages) {
    throw new LocalToolFailure('pdf_page_range_empty', `Page range "${requestedPages}" starts after the PDF ends.`, `Use pages between 1 and ${totalPages}.`);
  }
  return { firstPage: range.firstPage, lastPage: Math.min(range.lastPage, totalPages) };
}

function pdfPageRenderFailure(
  stderrInput: string,
  fallbackCode: string,
  fallbackMessage: string,
  fallbackInstructions: string,
): LocalToolFailure {
  const stderr = stderrInput.trim();
  if (/password/i.test(stderr)) {
    return new LocalToolFailure('pdf_password_protected', 'PDF is password-protected.', 'Provide an unprotected version or extract the pages manually.');
  }
  if (/damaged|corrupt|invalid/i.test(stderr)) {
    return new LocalToolFailure('pdf_corrupted', 'PDF file is corrupted or invalid.', 'Check the PDF file or convert it to images manually.');
  }
  return new LocalToolFailure(fallbackCode, stderr || fallbackMessage, fallbackInstructions);
}

function parsePdfPageRange(pages: string): PdfPageRange | null {
  const trimmed = pages.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const page = Number(trimmed);
    return page >= 1 ? { firstPage: page, lastPage: page } : null;
  }
  const match = trimmed.match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  const firstPage = Number(match[1]);
  const lastPage = Number(match[2]);
  if (firstPage < 1 || lastPage < 1 || lastPage < firstPage) return null;
  return { firstPage, lastPage };
}

async function readPdfPartImages(outputDir: string): Promise<Array<{ type: 'image'; data: string; mimeType: string }>> {
  const imageFiles = (await readdir(outputDir)).filter((entry) => entry.endsWith('.jpg')).sort(naturalCompare);
  return await Promise.all(imageFiles.map(async (fileName) => ({
    type: 'image' as const,
    data: (await readFile(path.join(outputDir, fileName))).toString('base64'),
    mimeType: 'image/jpeg',
  })));
}

function parseNotebook(content: string): NotebookCell[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new LocalToolFailure('invalid_notebook', errorMessage(error), 'Check that this .ipynb file is valid JSON.');
  }
  const record = asRecord(parsed);
  const cells = Array.isArray(record.cells) ? record.cells : [];
  return cells.map((rawCell) => {
    const cell = asRecord(rawCell);
    const rawType = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown';
    const cellType: NotebookCell['cellType'] = rawType === 'code' || rawType === 'markdown' || rawType === 'raw' ? rawType : 'unknown';
    return {
      cellType,
      source: normalizeNotebookText(cell.source),
      outputs: parseNotebookOutputs(cell.outputs),
      executionCount: typeof cell.execution_count === 'number' || cell.execution_count === null ? cell.execution_count : undefined,
    };
  });
}

function normalizeNotebookText(value: unknown): string {
  if (Array.isArray(value)) return value.map((part) => String(part)).join('');
  return typeof value === 'string' ? value : '';
}

function parseNotebookOutputs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const outputs = value.map((output) => {
    const record = asRecord(output);
    if (record.text !== undefined) return normalizeNotebookText(record.text);
    const data = asRecord(record.data);
    if (data['text/plain'] !== undefined) return normalizeNotebookText(data['text/plain']);
    if (record.ename || record.evalue) return [record.ename, record.evalue].filter(Boolean).join(': ');
    return '';
  }).filter((text) => text.trim().length > 0);
  return outputs.length ? outputs : undefined;
}

function renderNotebookCells(cells: NotebookCell[]): string {
  return cells.map((cell, index) => {
    const header = `--- Cell ${index + 1} (${cell.cellType}) ---`;
    const outputs = cell.outputs?.length ? `\n[output]\n${cell.outputs.join('\n')}` : '';
    return `${header}\n${cell.source}${outputs}`;
  }).join('\n\n');
}

async function readWorkspaceText(filePath: string): Promise<TextFileRead> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    throw localFsError(error, filePath);
  }
  if (fileStat.isDirectory()) throw new LocalToolFailure('is_directory', `Path is a directory: ${filePath}`);
  if (fileStat.size > MAX_TEXT_FILE_BYTES) throw new LocalToolFailure('file_too_large', `File is too large to edit: ${filePath}`);
  const buffer = await readFile(filePath);
  if (looksBinary(buffer)) throw new LocalToolFailure('binary_unsupported', `Binary file is not editable as text: ${filePath}`);
  return { ...decodeTextBuffer(buffer), mtimeMs: fileStat.mtimeMs };
}

async function assertFreshFullRead(workspace: WorkspaceContext, filePath: string, currentContent: string) {
  const state = workspace.readFileState.get(filePath);
  if (!state || state.isPartialView) {
    throw new LocalToolFailure('file_not_read', 'File has not been fully read yet.', 'Call file_read on the file before editing or rewriting it.');
  }
  const fileStat = await stat(filePath);
  if (fileStat.mtimeMs > state.mtimeMs && currentContent !== state.content) {
    throw new LocalToolFailure('user_modified', 'File has changed since it was read.', 'Call file_read again before editing this file.');
  }
}

async function writeTextFile(
  filePath: string,
  content: string,
  metadata: Pick<TextFileRead, 'encoding' | 'lineEndings' | 'hasBom'>,
) {
  const normalized = normalizeLineEndings(content);
  const withLineEndings = metadata.lineEndings === 'CRLF'
    ? normalized.replace(/\n/g, '\r\n')
    : normalized;
  const withBom = metadata.hasBom ? `\ufeff${withLineEndings}` : withLineEndings;
  await writeFile(filePath, Buffer.from(withBom, metadata.encoding));
}

function applyHeadLimit<T>(items: T[], rawLimit: number | undefined, rawOffset: number | undefined): { items: T[]; appliedLimit?: number; appliedOffset?: number } {
  const offset = clampInteger(rawOffset, 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = rawLimit === 0 ? HARD_GREP_OUTPUT_LIMIT : clampInteger(rawLimit, 1, HARD_GREP_OUTPUT_LIMIT, DEFAULT_GREP_HEAD_LIMIT);
  const sliced = items.slice(offset, offset + limit);
  const wasTruncated = items.length - offset > limit;
  return {
    items: sliced,
    ...(wasTruncated ? { appliedLimit: limit } : {}),
    ...(offset > 0 ? { appliedOffset: offset } : {}),
  };
}

async function persistLargeOutput(workspace: WorkspaceContext, stdout: string, stderr: string): Promise<{ path: string; size: number } | null> {
  const combined = `${stdout}${stderr}`;
  const size = new TextEncoder().encode(combined).byteLength;
  if (size <= BASH_INLINE_OUTPUT_LIMIT) return null;
  const outputPath = taskOutputPath(workspace, randomUUID());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, combined, 'utf8');
  return { path: outputPath, size };
}

function truncateShellOutput(stdout: string, stderr: string): { stdout: string; stderr: string } {
  const stdoutBudget = Math.floor(BASH_INLINE_OUTPUT_LIMIT * 0.7);
  const stderrBudget = BASH_INLINE_OUTPUT_LIMIT - stdoutBudget;
  return {
    stdout: truncateMiddle(stdout, stdoutBudget),
    stderr: truncateMiddle(stderr, stderrBudget),
  };
}

function taskOutputPath(workspace: WorkspaceContext, id: string): string {
  return path.join(toolOutputDir(workspace), `${id}.log`);
}

function toolOutputDir(workspace: WorkspaceContext): string {
  return path.join(workspace.scratchRoot, 'agent-tool-outputs');
}

function pruneBackgroundTasks(now = Date.now()) {
  const finished = Array.from(backgroundTasks.values())
    .filter((task) => task.status !== 'running')
    .sort((left, right) => (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt));

  const expiredBefore = now - BACKGROUND_TASK_TTL_MS;
  const keep = new Set<string>();
  finished.forEach((task, index) => {
    const finishedAt = task.completedAt ?? task.startedAt;
    if (index < BACKGROUND_TASK_HISTORY_LIMIT && finishedAt >= expiredBefore) {
      keep.add(task.taskId);
    }
  });

  for (const task of finished) {
    if (!keep.has(task.taskId)) backgroundTasks.delete(task.taskId);
  }
}

async function appendTaskOutput(task: BackgroundTask) {
  const write = async () => {
    const header = [
      `task_id: ${task.taskId}`,
      `status: ${task.status}`,
      ...(task.exitCode !== undefined ? [`exit_code: ${task.exitCode}`] : []),
      ...(task.returnCodeInterpretation ? [`return_code_interpretation: ${task.returnCodeInterpretation}`] : []),
      `command: ${task.command}`,
      `started_at: ${new Date(task.startedAt).toISOString()}`,
      ...(task.completedAt ? [`completed_at: ${new Date(task.completedAt).toISOString()}`] : []),
      '',
      '[stdout]',
      task.stdout,
      '',
      '[stderr]',
      task.stderr,
    ].join('\n');
    await mkdir(path.dirname(task.outputPath), { recursive: true });
    await writeFile(task.outputPath, header, 'utf8');
  };
  task.outputWriteChain = (task.outputWriteChain ?? Promise.resolve())
    .catch(() => {})
    .then(write)
    .catch(() => {});
  await task.outputWriteChain;
}

function visibleFileEdit(data: FileEditData) {
  // `replaceAll` echoes the model's own arg; `userModified` is a constant false.
  return {
    filePath: data.filePath,
    structuredPatch: data.structuredPatch,
    ...(data.skillWrite ? { skillWrite: visibleSkillWrite(data.skillWrite) } : {}),
  };
}

// Model-visible projection for every file_read shape. `type` is dropped (the
// model derives the kind from the path extension it passed + the payload shape /
// attached content); derivable counts (`numLines`, `totalCells`, `count`,
// `extractedText.chars`), the internal pdf `outputDir`, the image mime (`type`,
// also on the attached image block), converted rich-document Markdown
// (`content`, attached as a text part), and the notebook `cells` (a duplicate of
// the rendered `content`) are all stripped. The full data stays on the envelope.
function visibleFileRead(data: FileReadData): { file: Record<string, unknown> } {
  switch (data.type) {
    case 'image':
      return { file: { filePath: data.file.filePath, originalSize: data.file.originalSize, dimensions: data.file.dimensions } };
    case 'pdf':
      return {
        file: {
          filePath: data.file.filePath,
          originalSize: data.file.originalSize,
          totalPages: data.file.totalPages,
          pages: data.file.pages,
          ...(data.file.extractedText ? { extractedText: { truncated: data.file.extractedText.truncated } } : {}),
          ...(data.file.renderedImages ? { renderedImages: { count: data.file.renderedImages.count } } : {}),
        },
      };
    case 'text':
      return { file: { filePath: data.file.filePath, content: data.file.content, startLine: data.file.startLine, totalLines: data.file.totalLines } };
    case 'markdown':
      return {
        file: {
          filePath: data.file.filePath,
          converter: data.file.converter,
          truncated: data.file.truncated,
          originalSize: data.file.originalSize,
        },
      };
    case 'notebook':
      return { file: { filePath: data.file.filePath, content: data.file.content, originalSize: data.file.originalSize } };
    case 'file_unchanged':
      return { file: { filePath: data.file.filePath } };
    default: {
      // Exhaustiveness guard: a new FileReadData variant must add a case above,
      // otherwise this fails to compile instead of silently dropping content.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}

function visibleFileWrite(data: FileWriteData) {
  return {
    type: data.type,
    filePath: data.filePath,
    structuredPatch: data.structuredPatch,
    ...(data.skillWrite ? { skillWrite: visibleSkillWrite(data.skillWrite) } : {}),
  };
}

function visibleFileConvert(data: FileConvertData) {
  return {
    inputPath: data.inputPath,
    outputFormat: data.outputFormat,
    outputs: data.outputs,
  };
}

function visibleSkillWrite(skillWrite: AgentSkillWriteAudit) {
  return {
    skillName: skillWrite.skillName,
    source: skillWrite.source,
    relativePath: skillWrite.relativePath,
    changeType: skillWrite.changeType,
    warnings: skillWrite.warnings,
  };
}

// Model-visible projections for tools whose full data carries echoed arguments
// or telemetry. The complete data object stays on the envelope (details); the
// model only sees what it needs to read output and decide the next step.
export function visibleFileGlob(data: FileGlobData) {
  return {
    filenames: data.filenames,
    ...(data.truncated ? { truncated: true } : {}),
  };
}

export function visibleFileGrep(data: FileGrepData): unknown {
  // `mode` echoes the model's arg and is already implied by the payload shape
  // (`content` vs `filenames`).
  const mode = data.mode ?? 'files_with_matches';
  if (mode === 'content') {
    return { content: data.content ?? '' };
  }
  if (mode === 'count') {
    return { content: data.content ?? '', numMatches: data.numMatches ?? 0 };
  }
  return { filenames: data.filenames };
}

export function visibleBash(data: BashData): unknown {
  const visible: Record<string, unknown> = {
    stdout: data.stdout,
    stderr: data.stderr,
  };
  if (data.interrupted) visible.interrupted = true;
  if (typeof data.exitCode === 'number' && data.exitCode !== 0) visible.exitCode = data.exitCode;
  if (data.isImage) visible.isImage = true;
  if (data.backgroundTaskId) visible.backgroundTaskId = data.backgroundTaskId;
  if (data.taskStatus) visible.taskStatus = data.taskStatus;
  if (data.persistedOutputPath) visible.persistedOutputPath = data.persistedOutputPath;
  return visible;
}

export function visibleFileDelete(data: FileDeleteData): unknown {
  return {
    trashPath: data.trashPath,
    kind: data.kind,
  };
}

export function visibleTaskStop(data: TaskStopData) {
  // `task_id` echoes the sole arg; `status` is a constant 'stopped' beside the
  // envelope status. `outputPath` (where to read captured output) is the new bit.
  return {
    outputPath: data.outputPath,
  };
}

function structuredPatch(oldContent: string, newContent: string): Hunk[] {
  if (oldContent === newContent) return [];
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const removed = oldLines.slice(start, oldEnd + 1);
  const added = newLines.slice(start, newEnd + 1);
  return [{
    oldStart: start + 1,
    oldLines: removed.length,
    newStart: start + 1,
    newLines: added.length,
    lines: [
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
    ],
  }];
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

// The allowed file area is asymmetric: the agent may WRITE under the workdir and handed
// write-scope roots, but may READ the workdir, handed read/write roots, and the app-owned
// scratch root (materialized attachments, fetched binaries, overflow logs the app places
// there). `access` selects which rule applies, so both this layer and the permission engine
// (`agentPermissions.ts`) enforce the same boundary.
type FileAccess = 'read' | 'write';

function resolveWorkspacePath(workspace: WorkspaceContext, inputPath: string, access: FileAccess): string {
  // Relative paths always resolve against the workdir (`root`); the agent only ever targets
  // scratch with the absolute paths the app hands it, so scratch is an additional *read* root,
  // never the base for relative resolution.
  const root = path.resolve(workspace.root);
  const rootRealPath = realpathSync.native(root);
  const allowedRoots = allowedRealRoots(workspace, rootRealPath, access);
  const expanded = expandHome(inputPath);
  const requestedPath = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(root, expanded));
  const resolved = resolveCanonicalPath(requestedPath);
  if (!resolved || !isInsideAnyRoot(allowedRoots, resolved.realPath)) {
    throw new LocalToolFailure('path_outside_local_root', `Path is outside the allowed file area: ${requestedPath}`, 'Use a path under the allowed file area.');
  }
  return requestedPath;
}

// The real paths a file tool may touch for the given access: the workdir always, handed
// permission roots whose access covers the requested operation, plus — for reads — the
// scratch root when it resolves to a distinct, existing location (scratch is `<root>/tmp`
// by default, already covered by the workdir).
function allowedRealRoots(workspace: WorkspaceContext, rootRealPath: string, access: FileAccess): string[] {
  const roots = [rootRealPath];
  for (const entry of workspace.permissionRoots) {
    if (access === 'write' && entry.access !== 'write') continue;
    if (!roots.some((root) => isResolvedPathInside(root, entry.realRoot))) {
      roots.push(entry.realRoot);
    }
  }
  if (access === 'read') {
    const scratchReal = safeRealPath(workspace.scratchRoot);
    if (scratchReal && !isResolvedPathInside(rootRealPath, scratchReal)) {
      roots.push(scratchReal);
    }
  }
  return roots;
}

function isSelfDefinitionWritePath(workspace: WorkspaceContext, filePath: string): boolean {
  const lexicalPath = path.resolve(filePath);
  const canonicalPath = resolveCanonicalPath(filePath)?.realPath ?? null;
  for (const { dir } of selfDefinitionRootEntries(workspace.root)) {
    const lexicalRoot = path.resolve(dir);
    if (isSelfDefinitionContentPath(lexicalRoot, lexicalPath)) return true;
    const canonicalRoot = resolveCanonicalPath(dir)?.realPath ?? null;
    if (canonicalPath && canonicalRoot && isSelfDefinitionContentPath(canonicalRoot, canonicalPath)) return true;
  }
  return false;
}

function isSelfDefinitionContentPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  if (relative === '') return true;
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length >= 2) return true;
  // Root-level docs such as `.agents/skills/README.md` are ordinary workspace
  // files. Existing direct child directories are definition roots and stay guarded.
  return isDirectoryPath(candidate);
}

function isInsideAnyRoot(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isResolvedPathInside(root, candidate));
}

function isFileAreaRoot(workspace: WorkspaceContext, filePath: string): boolean {
  const rootRealPath = safeRealPath(workspace.root);
  const candidate = resolveCanonicalPath(filePath);
  if (!rootRealPath || !candidate) return false;
  if (rootRealPath === candidate.realPath) return true;
  return workspace.permissionRoots.some((entry) => {
    if (entry.access !== 'write') return false;
    return entry.realRoot === candidate.realPath && (entry.isDirectory || isDirectoryPath(entry.realRoot));
  });
}

function safeRealPath(target: string): string | null {
  try {
    const resolved = realpathSync.native(path.resolve(target));
    // A root that resolves to the filesystem root would make the whole disk "inside" it; treat
    // it as no root (mirrors localFileReferenceSecurity.trustedRootRealPath).
    if (path.parse(resolved).root === resolved) return null;
    return resolved;
  } catch {
    return null;
  }
}

interface CanonicalPathResolution {
  realPath: string;
}

function resolveCanonicalPath(target: string): CanonicalPathResolution | null {
  const requestedPath = path.resolve(target);
  const existingPath = nearestExistingPath(requestedPath);
  const existingRealPath = safeRealPath(existingPath);
  if (!existingRealPath) return null;
  const suffix = path.relative(existingPath, requestedPath);
  const realPath = suffix ? path.resolve(existingRealPath, suffix) : existingRealPath;
  if (path.parse(realPath).root === realPath) return null;
  return { realPath };
}

function isDirectoryPath(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function nearestExistingPath(inputPath: string): string {
  let current = path.resolve(inputPath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isResolvedPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function localFsError(error: unknown, filePath: string): LocalToolFailure {
  if (isNodeError(error) && error.code === 'ENOENT') {
    return new LocalToolFailure('file_not_found', `File not found: ${filePath}`, 'Use file_glob to find the current path, or file_write if you need to create a new file.');
  }
  if (isNodeError(error) && error.code === 'EACCES') {
    return new LocalToolFailure('permission_denied', `Permission denied: ${filePath}`, 'Choose another path or update file access settings.');
  }
  return new LocalToolFailure('filesystem_error', errorMessage(error));
}

function localErrorResult<TData>(tool: string, error: unknown, started: number) {
  const failure = error instanceof LocalToolFailure
    ? error
    : error instanceof AgentFileIngestionFailure
      ? new LocalToolFailure(error.code, error.message, error.instructions)
    : new LocalToolFailure('unexpected_error', errorMessage(error), 'Retry if this looks transient; otherwise inspect the input and tool state.');
  return agentToolResult(errorEnvelope<TData>(tool, failure.code, failure.message, {
    instructions: failure.instructions,
    metrics: { durationMs: elapsed(started) },
  }));
}

function requiredLocalString(value: unknown, name: string): string {
  return requiredNormalizedString(
    value,
    name,
    (field) => new LocalToolFailure('invalid_args', `${field} is required.`),
  );
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  return clampInteger(value, min, max, min);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metrics(started: number, data: unknown) {
  return { durationMs: elapsed(started), outputBytes: jsonByteLength(data) };
}

function elapsed(started: number): number {
  return Date.now() - started;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function decodeTextBuffer(buffer: Buffer): Pick<TextFileRead, 'content' | 'encoding' | 'lineEndings' | 'hasBom'> {
  const encoding = detectTextEncoding(buffer);
  const raw = buffer.toString(encoding);
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const withoutBom = hasBom ? raw.slice(1) : raw;
  return {
    content: normalizeLineEndings(withoutBom),
    encoding,
    lineEndings: detectLineEndings(withoutBom),
    hasBom,
  };
}

function detectTextEncoding(buffer: Buffer): TextEncoding {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
  return 'utf8';
}

function detectLineEndings(value: string): LineEndingType {
  let crlf = 0;
  let lf = 0;
  const sample = value.slice(0, 4096);
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== '\n') continue;
    if (index > 0 && sample[index - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? 'CRLF' : 'LF';
}

function looksBinary(buffer: Buffer): boolean {
  if (detectTextEncoding(buffer) === 'utf16le') return false;
  const sampleLength = Math.min(buffer.length, 8000);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const normalized = normalizeLineEndings(content);
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return value;
}

function normalizePathSeparators(value: string): string {
  return value.split(path.sep).join('/');
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.max(0, Math.floor(maxChars * 0.6));
  const tail = Math.max(0, maxChars - head - 80);
  return `${value.slice(0, head)}\n...[truncated ${value.length - head - tail} chars]...\n${value.slice(value.length - tail)}`;
}

function isSilentCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  return first ? SILENT_COMMANDS.has(first) : false;
}

function shouldAutoBackground(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  return Boolean(first && !DISALLOWED_AUTO_BACKGROUND_COMMANDS.has(first));
}
