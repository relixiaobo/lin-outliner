import type { AgentTool } from '@earendil-works/pi-agent-core';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, realpathSync, statSync } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
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
import { resolveRipgrepCommand, type ResolvedRipgrepCommand } from './agentRipgrep';

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

interface BashStopParams {
  task_id: string;
}

export interface BashStopData {
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
  process: BashProcessHandle;
  outputPath: string;
  stdoutPath?: string;
  stderrPath?: string;
  outputBytes: number;
  startedAt: number;
  status: BackgroundTaskStatus;
  exitCode?: number | null;
  returnCodeInterpretation?: string;
  errorMessage?: string;
  outputLimitExceeded?: boolean;
  outputLimitBytes?: number;
  completedAt?: number;
  outputWriteChain?: Promise<void>;
  outputClosed?: Promise<void>;
  outputWatchdog?: ReturnType<typeof setInterval>;
}

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

interface BashProcessHandle {
  child: ChildProcess;
  killEscalationTimer?: ReturnType<typeof setTimeout>;
}

interface ForegroundOutputCapture {
  id: string;
  stdoutPath: string;
  stderrPath: string;
  outputClosed?: Promise<void>;
}

interface OutputWatchdogHandle {
  timer: ReturnType<typeof setInterval>;
  stopped: boolean;
}

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

interface ProcessLinesPageResult {
  lines: string[];
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

export class LocalToolFailure extends Error {
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
const GREP_STDERR_CAPTURE_CHARS = 60_000;
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const BASH_AUTO_BACKGROUND_MS = 15_000;
const BASH_INLINE_OUTPUT_LIMIT = 30_000;
const BASH_MAX_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
const BASH_OUTPUT_WATCHDOG_INTERVAL_MS = 5_000;
const BASH_MAX_OUTPUT_BYTES_ENV = 'LIN_AGENT_BASH_MAX_OUTPUT_BYTES';
const BASH_OUTPUT_WATCHDOG_INTERVAL_ENV = 'LIN_AGENT_BASH_OUTPUT_WATCHDOG_INTERVAL_MS';
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
export const POPPLER_RECOVERY_INSTRUCTIONS = [
  'Poppler is required for PDF metadata, text extraction, page rendering, and conversion.',
  'Run bash to detect an available package manager and install Poppler.',
  'Do not assume Homebrew is available: use an installed manager such as `brew install poppler`, `sudo port install poppler`, `sudo apt-get update && sudo apt-get install -y poppler-utils`, `sudo dnf install -y poppler-utils`, or `sudo pacman -S --noconfirm poppler`.',
  'If no supported package manager is available, report that Poppler must be installed so pdfinfo, pdftotext, and pdftoppm are on PATH.',
  'After installation, retry the same file_read call.',
].join(' ');
export const RIPGREP_RECOVERY_INSTRUCTIONS = [
  'Tenon provides ripgrep for file_grep through its bundled ripgrep provider.',
  'If ripgrep_unavailable appears, the app resource or configured LIN_AGENT_RIPGREP_COMMAND is broken or inaccessible.',
  'Check the provider mode and source in the error, then report the packaging/runtime issue.',
  'For path discovery, retry with file_glob because it has a TypeScript fallback.',
  'For content search, do not install ripgrep as the primary remediation; the packaged app should include it.',
].join(' ');
const IGNORED_DIRECTORIES = new Set(['.agent-trash', '.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', 'dist', 'out', 'release', 'target']);
const IMAGE_MEDIA_TYPES = new Map<string, FileReadImageData['file']['type']>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);
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

const BASH_STOP_PARAMETERS = {
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
    createFileDeleteTool(workspace),
    createBashTool(workspace),
    createBashStopTool(),
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
      'Use file_read, file_edit, file_write, file_delete, file_glob, and file_grep for filesystem operations when possible.',
      'For document and image conversion, run the installed converters directly: soffice/libreoffice (office to PDF), pdftoppm (PDF to PNG/JPEG pages), and sips (image format conversion on macOS).',
      'Use run_in_background for long-running commands. You do not need to append "&"; use bash_stop if the task needs to be stopped.',
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
            instructions: `Command is running in the background as ${data.backgroundTaskId}. Use bash_stop with task_id if it needs to be stopped.`,
            metrics: metrics(started, data),
          }), visibleBash(data));
        }
        const result = await runForegroundCommand(workspace, params, signal);
        const interpretation = interpretCommandResult(result.command ?? params.command, result.exitCode);
        const ok = result.backgroundTaskId !== undefined || (!result.interrupted && !interpretation.isError);
        const envelope = ok
          ? successEnvelope('bash', result, {
            instructions: result.backgroundTaskId
              ? `Command is still running in the background as ${result.backgroundTaskId}. Read ${result.persistedOutputPath} with file_read to check output, or use bash_stop with task_id if it needs to be stopped.`
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

function createBashStopTool(): AgentTool<any, ToolEnvelope<BashStopData>> {
  return {
    name: 'bash_stop',
    label: 'Bash Stop',
    description: [
      'Stops a running background task by its ID.',
      'Use this tool when you need to terminate a long-running task created by bash.',
      'Only task_id is supported; shell_id is not accepted.',
    ].join('\n'),
    parameters: BASH_STOP_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      try {
        const params = normalizeBashStopParams(rawParams);
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
        clearBackgroundOutputWatchdog(task);
        killBashProcessTree(task.process, 'SIGKILL');
        await waitForOutputClosed(task.outputClosed);
        await finalizeBackgroundTaskOutput(task);
        pruneBackgroundTasks();
        const data: BashStopData = {
          message: `Successfully stopped bash task: ${task.taskId} (${task.command})`,
          task_id: task.taskId,
          task_type: 'bash',
          command: task.command,
          status: task.status,
          outputPath: task.outputPath,
        };
        return agentToolResult(successEnvelope('bash_stop', data, { metrics: metrics(started, data) }), visibleBashStop(data));
      } catch (error) {
        return localErrorResult('bash_stop', error, started);
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

function normalizeBashStopParams(rawParams: unknown): BashStopParams {
  const input = asRecord(rawParams);
  return { task_id: requiredLocalString(input.task_id, 'task_id') };
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
  const page = grepPageParams(params.head_limit, params.offset);
  const ripgrep = await resolveRipgrepForTool();
  const result = await runProcessLinesPage(ripgrep.command, [...ripgrep.argsPrefix, ...args], workspace.root, page.offset, page.limit, 60_000);
  if (result.error) {
    const detail = `${ripgrep.mode} provider at ${ripgrep.source} failed to start: ${result.error.message}`;
    throw new LocalToolFailure('ripgrep_unavailable', detail, ripgrepRecoveryInstructions(detail));
  }
  if (result.exitCode !== 0 && result.exitCode !== 1 && !result.truncated) {
    const message = result.stderr.trim() || `rg exited with code ${result.exitCode}.`;
    throw new LocalToolFailure('ripgrep_failed', message, 'Fix the regular expression, path, glob, or type filter and retry.');
  }

  const rawLines = result.lines.slice(0, page.limit);
  const appliedLimit = result.truncated || result.lines.length > page.limit ? page.limit : undefined;
  const appliedOffset = page.offset > 0 ? page.offset : undefined;

  if (mode === 'content') {
    const items = rawLines.map((line) => relativizeRipgrepLine(workspace, line, 'content'));
    return {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: items.join('\n'),
      numLines: items.length,
      ...(appliedLimit !== undefined ? { appliedLimit } : {}),
      ...(appliedOffset !== undefined ? { appliedOffset } : {}),
    };
  }

  if (mode === 'count') {
    const items = rawLines.map((line) => relativizeRipgrepLine(workspace, line, 'count'));
    const numMatches = items.reduce((sum, line) => {
      const colonIndex = line.lastIndexOf(':');
      const parsed = colonIndex >= 0 ? Number(line.slice(colonIndex + 1)) : Number.NaN;
      return Number.isFinite(parsed) ? sum + parsed : sum;
    }, 0);
    return {
      mode: 'count',
      numFiles: items.length,
      filenames: [],
      content: items.join('\n'),
      numMatches,
      ...(appliedLimit !== undefined ? { appliedLimit } : {}),
      ...(appliedOffset !== undefined ? { appliedOffset } : {}),
    };
  }

  const filenames = rawLines.map((line) => relativeToWorkspace(workspace, path.resolve(workspace.root, line)));
  return {
    mode: 'files_with_matches',
    numFiles: filenames.length,
    filenames,
    ...(appliedLimit !== undefined ? { appliedLimit } : {}),
    ...(appliedOffset !== undefined ? { appliedOffset } : {}),
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

function grepPageParams(rawLimit: number | undefined, rawOffset: number | undefined): { limit: number; offset: number } {
  return {
    limit: rawLimit === 0 ? HARD_GREP_OUTPUT_LIMIT : clampInteger(rawLimit, 1, HARD_GREP_OUTPUT_LIMIT, DEFAULT_GREP_HEAD_LIMIT),
    offset: clampInteger(rawOffset, 0, Number.MAX_SAFE_INTEGER, 0),
  };
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

async function resolveRipgrepForTool(): Promise<ResolvedRipgrepCommand> {
  try {
    return await resolveRipgrepCommand();
  } catch (error) {
    const detail = errorMessage(error);
    throw new LocalToolFailure('ripgrep_unavailable', detail, ripgrepRecoveryInstructions(detail));
  }
}

function ripgrepRecoveryInstructions(detail: string): string {
  return `${RIPGREP_RECOVERY_INSTRUCTIONS} Provider failure: ${detail}`;
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
      safeKillChildProcess(child, 'SIGTERM');
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
      safeKillChildProcess(child, 'SIGTERM');
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

async function runProcessLinesPage(
  command: string,
  args: string[],
  cwd: string,
  offset: number,
  limit: number,
  timeoutMs: number,
): Promise<ProcessLinesPageResult> {
  return await new Promise<ProcessLinesPageResult>((resolve) => {
    const child = spawn(command, args, { cwd, env: buildAgentLocalToolProcessEnv(), shell: false });
    const lines: string[] = [];
    let stderr = '';
    let pending = '';
    let seen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const maxLines = limit + 1;
    const finish = (result: ProcessLinesPageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stopForLimit = () => {
      if (truncated) return;
      truncated = true;
      safeKillChildProcess(child, 'SIGTERM');
    };
    const pushLine = (line: string) => {
      if (seen < offset) {
        seen += 1;
        return;
      }
      if (lines.length >= maxLines) {
        stopForLimit();
        return;
      }
      lines.push(line);
      seen += 1;
      if (lines.length >= maxLines) stopForLimit();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      safeKillChildProcess(child, 'SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const parts = normalizeLineEndings(`${pending}${chunk}`).split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        pushLine(part);
        if (truncated) break;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBoundedText(stderr, chunk, GREP_STDERR_CAPTURE_CHARS);
    });
    child.once('error', (error) => {
      finish({ lines, stderr, exitCode: null, truncated, timedOut, error });
    });
    child.once('close', (code) => {
      if (pending && !truncated && !timedOut) pushLine(pending);
      finish({ lines, stderr, exitCode: code, truncated, timedOut });
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
  const capture = await createForegroundOutputCapture(workspace);
  let processHandle: BashProcessHandle;
  try {
    const child = spawn(params.command, {
      cwd: workspace.root,
      shell: true,
      env: buildAgentLocalToolProcessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    processHandle = { child };
    attachSplitOutputCapture(child, capture);
  } catch (error) {
    await cleanupForegroundOutputCapture(capture);
    throw error;
  }

  let interrupted = false;
  let timedOut = false;
  let outputLimitExceededBytes: number | undefined;
  let resolved = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    interrupted = true;
    requestBashProcessStop(processHandle);
  }, timeoutMs);
  const onAbort = () => {
    interrupted = true;
    requestBashProcessStop(processHandle);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const foregroundOutputWatchdog = startForegroundOutputWatchdog(capture, processHandle, (limitBytes) => {
    outputLimitExceededBytes = limitBytes;
    interrupted = true;
  });

  return await new Promise<BashData>((resolve, reject) => {
    const autoBackgroundTimer = setTimeout(() => {
      if (resolved || interrupted || !shouldAutoBackground(params.command)) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      clearOutputWatchdog(foregroundOutputWatchdog);
      signal?.removeEventListener('abort', onAbort);
      void registerBackgroundTask(workspace, params, {
        process: processHandle,
        foregroundCapture: capture,
        assistantAutoBackgrounded: true,
      }).then((data) => resolve(data), reject);
    }, BASH_AUTO_BACKGROUND_MS);

    processHandle.child.once('error', (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      clearTimeout(autoBackgroundTimer);
      clearOutputWatchdog(foregroundOutputWatchdog);
      clearBashKillEscalation(processHandle);
      signal?.removeEventListener('abort', onAbort);
      void cleanupForegroundOutputCapture(capture).finally(() => reject(error));
    });
    processHandle.child.once('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      clearTimeout(autoBackgroundTimer);
      clearOutputWatchdog(foregroundOutputWatchdog);
      clearBashKillEscalation(processHandle);
      signal?.removeEventListener('abort', onAbort);
      void (async () => {
        await waitForOutputClosed(capture.outputClosed);
        const output = await finalizeForegroundOutput(workspace, capture);
        const interpretation = outputLimitExceededBytes !== undefined
          ? { isError: true, message: `Command killed: output exceeded ${formatBytes(outputLimitExceededBytes)}.` }
          : timedOut
            ? { isError: true, message: `Command timed out after ${timeoutMs}ms.` }
            : interpretCommandResult(params.command, code);
        resolve({
          stdout: output.stdout,
          stderr: output.stderr,
          interrupted,
          exitCode: code,
          command: params.command,
          returnCodeInterpretation: interpretation.message,
          noOutputExpected: isSilentCommand(params.command),
          dangerouslyDisableSandbox: params.dangerouslyDisableSandbox,
          persistedOutputPath: output.persistedOutputPath,
          persistedOutputSize: output.persistedOutputSize,
        });
      })().catch(reject);
    });
  });
}

async function startBackgroundCommand(workspace: WorkspaceContext, params: BashParams): Promise<BashData> {
  return registerBackgroundTask(workspace, params, { backgroundedByUser: true });
}

async function registerBackgroundTask(
  workspace: WorkspaceContext,
  params: BashParams,
  options: {
    process?: BashProcessHandle;
    foregroundCapture?: ForegroundOutputCapture;
    backgroundedByUser?: boolean;
    assistantAutoBackgrounded?: boolean;
  } = {},
): Promise<BashData> {
  pruneBackgroundTasks();
  const taskId = `task_${randomUUID()}`;
  const outputPath = taskOutputPath(workspace, taskId);
  const startedAt = Date.now();
  await mkdir(path.dirname(outputPath), { recursive: true });

  let processHandle = options.process;
  let stdoutPath: string | undefined;
  let stderrPath: string | undefined;
  let outputClosed: Promise<void> | undefined;

  if (options.foregroundCapture) {
    if (!processHandle) {
      await cleanupForegroundOutputCapture(options.foregroundCapture);
      throw new Error('Cannot background a foreground capture without a child process.');
    }
    stdoutPath = options.foregroundCapture.stdoutPath;
    stderrPath = options.foregroundCapture.stderrPath;
    outputClosed = options.foregroundCapture.outputClosed;
  } else {
    const capture = await createForegroundOutputCapture(workspace);
    stdoutPath = capture.stdoutPath;
    stderrPath = capture.stderrPath;
    try {
      const child = spawn(params.command, {
        cwd: workspace.root,
        shell: true,
        env: buildAgentLocalToolProcessEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      processHandle = { child };
      attachSplitOutputCapture(child, capture);
      outputClosed = capture.outputClosed;
    } catch (error) {
      await cleanupForegroundOutputCapture(capture);
      throw error;
    }
  }

  if (!processHandle) throw new Error('Background task did not create a child process.');

  const task: BackgroundTask = {
    taskId,
    command: params.command,
    process: processHandle,
    outputPath,
    stdoutPath,
    stderrPath,
    outputBytes: 0,
    startedAt,
    status: 'running',
    outputClosed,
  };
  backgroundTasks.set(taskId, task);

  await writeSplitBackgroundInitialOutput(task);

  attachBackgroundTaskHandlers(task, params);
  startBackgroundOutputWatchdog(task);
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
    void completeBackgroundTask(task, params, processHandle.child.exitCode);
  }

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
    persistedOutputSize: task.outputBytes,
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
  const ripgrep = await resolveRipgrepCommand().catch(() => null);
  if (!ripgrep) return null;
  const args = ['--files', '--hidden', '--null'];
  const positiveGlob = ripgrepGlobForFileGlob(pattern, searchRoot);
  if (positiveGlob) args.push('--glob', positiveGlob);
  for (const dir of IGNORED_DIRECTORIES) {
    args.push('--glob', `!**/${dir}/**`);
  }

  const result = await runProcessItems(ripgrep.command, [...ripgrep.argsPrefix, ...args], searchRoot, '\0', FILE_GLOB_CANDIDATE_LIMIT, 30_000);
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

async function createForegroundOutputCapture(workspace: WorkspaceContext): Promise<ForegroundOutputCapture> {
  const id = `fg_${randomUUID()}`;
  const outputDir = toolOutputDir(workspace);
  await mkdir(outputDir, { recursive: true });
  const stdoutPath = path.join(outputDir, `${id}.stdout.log`);
  const stderrPath = path.join(outputDir, `${id}.stderr.log`);
  return { id, stdoutPath, stderrPath };
}

async function cleanupForegroundOutputCapture(capture: ForegroundOutputCapture) {
  await Promise.allSettled([
    rm(capture.stdoutPath, { force: true }),
    rm(capture.stderrPath, { force: true }),
  ]);
}

function attachSplitOutputCapture(child: ChildProcess, capture: ForegroundOutputCapture) {
  const writes = [
    child.stdout
      ? pipeline(child.stdout, createWriteStream(capture.stdoutPath, { flags: 'w' }))
      : writeFile(capture.stdoutPath, '', 'utf8'),
    child.stderr
      ? pipeline(child.stderr, createWriteStream(capture.stderrPath, { flags: 'w' }))
      : writeFile(capture.stderrPath, '', 'utf8'),
  ];
  capture.outputClosed = Promise.allSettled(writes).then(() => {});
}

async function waitForOutputClosed(outputClosed: Promise<void> | undefined) {
  if (!outputClosed) return;
  await outputClosed;
}

function startForegroundOutputWatchdog(
  capture: ForegroundOutputCapture,
  processHandle: BashProcessHandle,
  onLimitExceeded: (limitBytes: number) => void,
): OutputWatchdogHandle {
  const maxBytes = bashMaxOutputBytes();
  const intervalMs = bashOutputWatchdogIntervalMs();
  const watchdog: OutputWatchdogHandle = {
    timer: setInterval(() => {
      if (watchdog.stopped) return;
      void foregroundCaptureOutputSize(capture).then((size) => {
        if (watchdog.stopped || size <= maxBytes) return;
        watchdog.stopped = true;
        clearInterval(watchdog.timer);
        onLimitExceeded(maxBytes);
        killBashProcessTree(processHandle, 'SIGKILL');
      }, () => {});
    }, intervalMs),
    stopped: false,
  };
  watchdog.timer.unref?.();
  return watchdog;
}

function clearOutputWatchdog(watchdog: OutputWatchdogHandle) {
  if (watchdog.stopped) return;
  watchdog.stopped = true;
  clearInterval(watchdog.timer);
}

async function foregroundCaptureOutputSize(capture: ForegroundOutputCapture): Promise<number> {
  const sizes = await Promise.all([
    fileSizeOrZero(capture.stdoutPath),
    fileSizeOrZero(capture.stderrPath),
  ]);
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function finalizeForegroundOutput(
  workspace: WorkspaceContext,
  capture: ForegroundOutputCapture,
): Promise<{ stdout: string; stderr: string; persistedOutputPath?: string; persistedOutputSize?: number }> {
  const [stdoutSize, stderrSize] = await Promise.all([
    fileSizeOrZero(capture.stdoutPath),
    fileSizeOrZero(capture.stderrPath),
  ]);
  const totalSize = stdoutSize + stderrSize;
  if (totalSize <= BASH_INLINE_OUTPUT_LIMIT) {
    const [stdout, stderr] = await Promise.all([
      readTextPreview(capture.stdoutPath, stdoutSize, stdoutSize),
      readTextPreview(capture.stderrPath, stderrSize, stderrSize),
    ]);
    await cleanupForegroundOutputCapture(capture);
    return { stdout, stderr };
  }

  const outputPath = taskOutputPath(workspace, capture.id);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, '', 'utf8');
  await appendFileFromPath(outputPath, capture.stdoutPath);
  await appendFileFromPath(outputPath, capture.stderrPath);

  const stdoutBudget = Math.floor(BASH_INLINE_OUTPUT_LIMIT * 0.7);
  const stderrBudget = BASH_INLINE_OUTPUT_LIMIT - stdoutBudget;
  const [stdout, stderr] = await Promise.all([
    readTextPreview(capture.stdoutPath, stdoutSize, stdoutBudget),
    readTextPreview(capture.stderrPath, stderrSize, stderrBudget),
  ]);
  await cleanupForegroundOutputCapture(capture);
  return {
    stdout,
    stderr,
    persistedOutputPath: outputPath,
    persistedOutputSize: totalSize,
  };
}

function attachBackgroundTaskHandlers(task: BackgroundTask, params: BashParams) {
  task.process.child.once('close', (code) => {
    void completeBackgroundTask(task, params, code);
  });
  task.process.child.once('error', (error) => {
    void failBackgroundTask(task, error);
  });
}

async function completeBackgroundTask(task: BackgroundTask, params: BashParams, code: number | null) {
  if (task.completedAt) return;
  await waitForOutputClosed(task.outputClosed);
  clearBackgroundOutputWatchdog(task);
  clearBashKillEscalation(task.process);
  const interpretation = interpretCommandResult(params.command, code);
  if (task.outputLimitExceeded) {
    task.status = 'failed';
    task.returnCodeInterpretation = `Background command killed: output exceeded ${formatBytes(task.outputLimitBytes ?? bashMaxOutputBytes())}.`;
  } else if (task.status === 'running') {
    task.status = interpretation.isError ? 'failed' : 'completed';
    task.returnCodeInterpretation = interpretation.message;
  }
  task.exitCode = code;
  task.completedAt = Date.now();
  await finalizeBackgroundTaskOutput(task);
  pruneBackgroundTasks();
}

async function failBackgroundTask(task: BackgroundTask, error: unknown) {
  if (task.completedAt) return;
  await waitForOutputClosed(task.outputClosed);
  clearBackgroundOutputWatchdog(task);
  clearBashKillEscalation(task.process);
  task.status = 'failed';
  task.errorMessage = errorMessage(error);
  task.completedAt = Date.now();
  await finalizeBackgroundTaskOutput(task);
  pruneBackgroundTasks();
}

function startBackgroundOutputWatchdog(task: BackgroundTask) {
  const maxBytes = bashMaxOutputBytes();
  const intervalMs = bashOutputWatchdogIntervalMs();
  task.outputWatchdog = setInterval(() => {
    void backgroundTaskOutputSize(task).then((size) => {
      if (task.completedAt || task.outputWatchdog === undefined || size <= maxBytes) return;
      task.outputLimitExceeded = true;
      task.outputLimitBytes = maxBytes;
      task.status = 'failed';
      task.returnCodeInterpretation = `Background command killed: output exceeded ${formatBytes(maxBytes)}.`;
      clearBackgroundOutputWatchdog(task);
      killBashProcessTree(task.process, 'SIGKILL');
    }, () => {});
  }, intervalMs);
  task.outputWatchdog.unref?.();
}

function clearBackgroundOutputWatchdog(task: BackgroundTask) {
  if (!task.outputWatchdog) return;
  clearInterval(task.outputWatchdog);
  task.outputWatchdog = undefined;
}

async function backgroundTaskOutputSize(task: BackgroundTask): Promise<number> {
  const sizes = await Promise.all([
    fileSizeOrZero(task.outputPath),
    task.stdoutPath ? fileSizeOrZero(task.stdoutPath) : 0,
    task.stderrPath ? fileSizeOrZero(task.stderrPath) : 0,
  ]);
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function writeSplitBackgroundInitialOutput(task: BackgroundTask) {
  await queueTaskOutputWrite(task, async () => {
    await mkdir(path.dirname(task.outputPath), { recursive: true });
    await writeFile(task.outputPath, [
      ...backgroundTaskMetadataLines(task),
      ...(task.stdoutPath ? [`stdout_path: ${task.stdoutPath}`] : []),
      ...(task.stderrPath ? [`stderr_path: ${task.stderrPath}`] : []),
      '',
      '[output]',
      'The command is still running. Output is being captured directly into the stdout_path and stderr_path files above.',
      'This file will contain the combined output when the task finishes.',
      '',
    ].join('\n'), 'utf8');
  });
}

async function finalizeBackgroundTaskOutput(task: BackgroundTask) {
  await composeSplitBackgroundOutput(task);
}

async function composeSplitBackgroundOutput(task: BackgroundTask) {
  await queueTaskOutputWrite(task, async () => {
    await mkdir(path.dirname(task.outputPath), { recursive: true });
    await writeFile(task.outputPath, `${[
      ...backgroundTaskMetadataLines(task),
      '',
      '[stdout]',
    ].join('\n')}\n`, 'utf8');
    if (task.stdoutPath) await appendFileFromPath(task.outputPath, task.stdoutPath);
    await appendFile(task.outputPath, '\n\n[stderr]\n', 'utf8');
    if (task.stderrPath) await appendFileFromPath(task.outputPath, task.stderrPath);
    await appendFile(task.outputPath, backgroundTaskStatusFooter(task), 'utf8');
    await cleanupBackgroundSplitFiles(task);
  });
}

async function cleanupBackgroundSplitFiles(task: BackgroundTask) {
  await Promise.allSettled([
    task.stdoutPath ? rm(task.stdoutPath, { force: true }) : Promise.resolve(),
    task.stderrPath ? rm(task.stderrPath, { force: true }) : Promise.resolve(),
  ]);
}

function backgroundTaskMetadataLines(task: BackgroundTask): string[] {
  return [
    `task_id: ${task.taskId}`,
    `status: ${task.status}`,
    ...(task.exitCode !== undefined ? [`exit_code: ${task.exitCode}`] : []),
    ...(task.returnCodeInterpretation ? [`return_code_interpretation: ${task.returnCodeInterpretation}`] : []),
    ...(task.errorMessage ? [`error: ${task.errorMessage}`] : []),
    `command: ${task.command}`,
    `started_at: ${new Date(task.startedAt).toISOString()}`,
    ...(task.completedAt ? [`completed_at: ${new Date(task.completedAt).toISOString()}`] : []),
  ];
}

function backgroundTaskStatusFooter(task: BackgroundTask): string {
  return `\n\n${[
    '[task_status]',
    ...backgroundTaskMetadataLines(task),
  ].join('\n')}\n`;
}

async function queueTaskOutputWrite(task: BackgroundTask, write: () => Promise<void>) {
  task.outputWriteChain = (task.outputWriteChain ?? Promise.resolve())
    .catch(() => {})
    .then(write)
    .then(async () => {
      task.outputBytes = await fileSizeOrZero(task.outputPath);
    })
    .catch(() => {});
  await task.outputWriteChain;
}

function requestBashProcessStop(processHandle: BashProcessHandle) {
  killBashProcessTree(processHandle, 'SIGTERM');
  clearBashKillEscalation(processHandle);
  processHandle.killEscalationTimer = setTimeout(() => {
    killBashProcessTree(processHandle, 'SIGKILL');
    processHandle.killEscalationTimer = undefined;
  }, 1_000);
  processHandle.killEscalationTimer.unref?.();
}

function clearBashKillEscalation(processHandle: BashProcessHandle) {
  if (!processHandle.killEscalationTimer) return;
  clearTimeout(processHandle.killEscalationTimer);
  processHandle.killEscalationTimer = undefined;
}

function killBashProcessTree(processHandle: BashProcessHandle, signal: NodeJS.Signals) {
  clearBashKillEscalation(processHandle);
  const pid = processHandle.child.pid;
  if (!pid) {
    safeKillChildProcess(processHandle.child, signal);
    return;
  }
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    try {
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.unref();
    } catch {
      safeKillChildProcess(processHandle.child, signal);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    safeKillChildProcess(processHandle.child, signal);
  }
}

function safeKillChildProcess(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited between the watchdog/timeout and kill.
  }
}

function bashMaxOutputBytes(): number {
  return positiveIntegerEnv(BASH_MAX_OUTPUT_BYTES_ENV, BASH_MAX_OUTPUT_BYTES, 1);
}

function bashOutputWatchdogIntervalMs(): number {
  return positiveIntegerEnv(BASH_OUTPUT_WATCHDOG_INTERVAL_ENV, BASH_OUTPUT_WATCHDOG_INTERVAL_MS, 20);
}

function positiveIntegerEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function appendBoundedText(current: string, chunk: string, maxChars: number): string {
  if (current.length >= maxChars) return current;
  const remaining = maxChars - current.length;
  return chunk.length <= remaining ? `${current}${chunk}` : `${current}${chunk.slice(0, remaining)}`;
}

async function fileSizeOrZero(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function appendFileFromPath(targetPath: string, sourcePath: string) {
  if (await fileSizeOrZero(sourcePath) === 0) return;
  await pipeline(
    createReadStream(sourcePath),
    createWriteStream(targetPath, { flags: 'a' }),
  );
}

async function readTextPreview(filePath: string, size: number, maxBytes: number): Promise<string> {
  if (size <= 0 || maxBytes <= 0) return '';
  if (size <= maxBytes) return readFile(filePath, 'utf8');

  const marker = `\n...[${size - maxBytes} bytes omitted; full output saved to file]...\n`;
  const markerBytes = Buffer.byteLength(marker);
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  if (contentBudget <= 0) return marker.slice(0, maxBytes);

  const headBytes = Math.ceil(contentBudget / 2);
  const tailBytes = contentBudget - headBytes;
  const [head, tail] = await Promise.all([
    readFileSliceText(filePath, 0, headBytes),
    readFileSliceText(filePath, Math.max(0, size - tailBytes), tailBytes),
  ]);
  return `${head}${marker}${tail}`;
}

async function readFileSliceText(filePath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return '';
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
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

export function visibleBashStop(data: BashStopData) {
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

export function resolveAgentLocalReadPath(workspace: AgentLocalWorkspaceContext, inputPath: string): string {
  return resolveWorkspacePath(workspace, inputPath, 'read');
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

function isSilentCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  return first ? SILENT_COMMANDS.has(first) : false;
}

function shouldAutoBackground(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  return Boolean(first && !DISALLOWED_AUTO_BACKGROUND_COMMANDS.has(first));
}
