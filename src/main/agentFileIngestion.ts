import { existsSync } from 'node:fs';
import path from 'node:path';
import { agentDerivedFileCache, derivedFileCacheKey } from './agentFileIngestionCache';
import type { ToolStatus } from './agentToolEnvelope';
import { runAgentToolProcess } from './agentToolProcess';
import type { FolderCapabilitySnapshot } from './agentFolderCapabilities';

export type FileIngestionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface FileIngestionOutput<TData> {
  data: TData;
  content?: FileIngestionContentPart[];
  status?: ToolStatus;
  instructions?: string;
}

export interface MarkdownIngestionResult {
  content: string;
  converter: 'markitdown';
  contentChars: number;
  truncated: boolean;
}

interface MarkitdownCommand {
  command: string;
  argsPrefix: string[];
  label: string;
}

const MARKITDOWN_COMMAND_ENV = 'LIN_AGENT_MARKITDOWN_COMMAND';
const MARKITDOWN_TIMEOUT_MS = 120_000;
const MARKITDOWN_PROBE_TIMEOUT_MS = 10_000;
const MARKITDOWN_MAX_CHARS = 80_000;
const MARKITDOWN_TRUNCATION_MARKER = '\n\n[Markdown output truncated]';
const MARKITDOWN_STDOUT_CAPTURE_CHARS = MARKITDOWN_MAX_CHARS + MARKITDOWN_TRUNCATION_MARKER.length + 1;
const MARKITDOWN_STDERR_CAPTURE_CHARS = 20_000;
const MARKITDOWN_CACHE_EXTRACTOR = 'markitdown:v1';

export const MARKITDOWN_RICH_DOCUMENT_EXTENSIONS = new Set([
  '.docx',
  '.epub',
  '.pptx',
  '.xls',
  '.xlsx',
]);

export const MARKITDOWN_RECOVERY_INSTRUCTIONS = [
  'MarkItDown is required to read this rich document as Markdown.',
  'Use bash to inspect the local Python tooling, then install a minimal local backend with `python3 -m pip install --user \'markitdown[docx,pptx,xlsx,xls]\'` or `uv tool install \'markitdown[docx,pptx,xlsx,xls]\'` when uv is available.',
  'Do not assume Homebrew is available.',
  'If MarkItDown is installed in a custom location, set LIN_AGENT_MARKITDOWN_COMMAND to the executable path or command, for example `python3 -m markitdown`.',
  'After installation, retry the same file_read call.',
].join(' ');

const markitdownCommandCache = new Map<string, Promise<MarkitdownCommand>>();

export class AgentFileIngestionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instructions?: string,
  ) {
    super(message);
    this.name = 'AgentFileIngestionFailure';
  }
}

export async function ingestRichDocumentAsMarkdown(
  filePath: string,
  sourceHash?: string,
  capabilities?: FolderCapabilitySnapshot,
): Promise<MarkdownIngestionResult> {
  const command = await resolveMarkitdownCommand(path.dirname(filePath));
  const cacheKey = sourceHash
    ? derivedFileCacheKey(MARKITDOWN_CACHE_EXTRACTOR, sourceHash, {
        ext: path.extname(filePath).toLowerCase(),
        command: command.label,
        path: process.env.PATH ?? '',
        extraPath: process.env.LIN_AGENT_EXTRA_TOOL_PATH ?? '',
      })
    : null;
  const cached = cacheKey ? agentDerivedFileCache.get<MarkdownIngestionResult>(cacheKey) : undefined;
  if (cached) return cached;

  const result = await runAgentToolProcess(
    command.command,
    [...command.argsPrefix, filePath],
    path.dirname(filePath),
    MARKITDOWN_TIMEOUT_MS,
    {
      capabilities,
      maxStdoutChars: MARKITDOWN_STDOUT_CAPTURE_CHARS,
      maxStderrChars: MARKITDOWN_STDERR_CAPTURE_CHARS,
    },
  );
  if (result.error) {
    throw new AgentFileIngestionFailure('markitdown_unavailable', result.error.message, MARKITDOWN_RECOVERY_INSTRUCTIONS);
  }
  if (result.timedOut) {
    throw new AgentFileIngestionFailure('markitdown_timeout', 'MarkItDown conversion timed out.', 'Try a smaller file or convert the document manually to Markdown, then retry file_read on the Markdown output.');
  }
  if (result.exitCode !== 0) {
    throw new AgentFileIngestionFailure('markitdown_failed', result.stderr.trim() || `${command.label} failed.`, 'Check that the file is valid and that MarkItDown was installed with the required optional dependencies, then retry.');
  }
  const markdown = normalizeMarkdownOutput(result.stdout);
  if (!markdown) {
    throw new AgentFileIngestionFailure('markitdown_empty', 'MarkItDown produced no Markdown output.', 'Check that the file is valid and contains readable text, or convert it manually to Markdown.');
  }
  const truncated = result.stdoutTruncated === true || markdown.length > MARKITDOWN_MAX_CHARS;
  const converted: MarkdownIngestionResult = {
    content: truncated ? `${markdown.slice(0, MARKITDOWN_MAX_CHARS)}${MARKITDOWN_TRUNCATION_MARKER}` : markdown,
    converter: 'markitdown',
    contentChars: result.stdoutChars,
    truncated,
  };
  if (cacheKey) agentDerivedFileCache.set(cacheKey, converted);
  return converted;
}

async function resolveMarkitdownCommand(cwd: string): Promise<MarkitdownCommand> {
  const cacheKey = markitdownCommandCacheKey(cwd);
  const cached = markitdownCommandCache.get(cacheKey);
  if (cached) return cached;

  const resolution = resolveMarkitdownCommandUncached(cwd);
  markitdownCommandCache.set(cacheKey, resolution);
  try {
    return await resolution;
  } catch (error) {
    markitdownCommandCache.delete(cacheKey);
    throw error;
  }
}

async function resolveMarkitdownCommandUncached(cwd: string): Promise<MarkitdownCommand> {
  const explicit = normalizedEnvCommand(process.env[MARKITDOWN_COMMAND_ENV]);
  if (explicit) {
    const candidate = commandFromEnv(explicit);
    if (await canRunMarkitdown(candidate, cwd)) return candidate;
    throw new AgentFileIngestionFailure('markitdown_unavailable', `${MARKITDOWN_COMMAND_ENV} does not point to a runnable MarkItDown executable.`, MARKITDOWN_RECOVERY_INSTRUCTIONS);
  }

  const candidates: MarkitdownCommand[] = [
    { command: 'markitdown', argsPrefix: [], label: 'markitdown' },
    { command: 'python3', argsPrefix: ['-m', 'markitdown'], label: 'python3 -m markitdown' },
  ];
  for (const candidate of candidates) {
    if (await canRunMarkitdown(candidate, cwd)) return candidate;
  }
  throw new AgentFileIngestionFailure('markitdown_unavailable', 'MarkItDown is not available on PATH.', MARKITDOWN_RECOVERY_INSTRUCTIONS);
}

async function canRunMarkitdown(candidate: MarkitdownCommand, cwd: string): Promise<boolean> {
  const result = await runAgentToolProcess(candidate.command, [...candidate.argsPrefix, '--help'], cwd, MARKITDOWN_PROBE_TIMEOUT_MS);
  return !result.error && result.exitCode === 0;
}

function markitdownCommandCacheKey(cwd: string): string {
  return [
    process.env[MARKITDOWN_COMMAND_ENV] ?? '',
    process.env.PATH ?? '',
    cwd,
  ].join('\0');
}

function commandFromEnv(value: string): MarkitdownCommand {
  if (existsSync(value)) return { command: value, argsPrefix: [], label: value };
  const parts = splitCommandLine(value);
  if (parts.length === 0) return { command: value, argsPrefix: [], label: value };
  const [command, ...argsPrefix] = parts;
  return { command: command!, argsPrefix, label: value };
}

function normalizedEnvCommand(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeMarkdownOutput(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function splitCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  if (current) parts.push(current);
  return parts;
}
