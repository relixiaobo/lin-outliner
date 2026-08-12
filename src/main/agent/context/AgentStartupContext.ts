import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SqliteDatabase } from '../persistence/sqlite';

const execFileAsync = promisify(execFile);
const MAX_GIT_STATUS_CHARS = 2_000;
const MAX_REPOSITORY_INSTRUCTION_BYTES = 256 * 1_024;
const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'AGENT.md', 'CLAUDE.md'] as const;

export interface AgentStartupContextSnapshot {
  readonly repositoryInstructions: readonly string[];
  readonly gitStatus: string | null;
}

export interface AgentStartupContextSubject {
  readonly sessionId: string;
  readonly cwd: string;
}

export type AgentStartupContextCollector = (
  cwd: string,
) => AgentStartupContextSnapshot | Promise<AgentStartupContextSnapshot>;

interface SessionContextRow {
  snapshot_json: string;
}

export class AgentStartupContextStore {
  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_session_startup_context (
        session_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  read(sessionId: string): AgentStartupContextSnapshot | null {
    const row = this.db.prepare(`
      SELECT snapshot_json FROM agent_session_startup_context WHERE session_id = ?
    `).get(sessionId) as SessionContextRow | undefined;
    return row ? decodeAgentStartupContextSnapshot(JSON.parse(row.snapshot_json)) : null;
  }

  writeOnce(
    sessionId: string,
    snapshot: AgentStartupContextSnapshot,
    createdAt: number,
  ): AgentStartupContextSnapshot {
    const frozen = decodeAgentStartupContextSnapshot(snapshot);
    this.db.prepare(`
      INSERT INTO agent_session_startup_context(session_id, snapshot_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, JSON.stringify(frozen), createdAt);
    return this.read(sessionId)!;
  }

  delete(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.db.prepare('DELETE FROM agent_session_startup_context WHERE session_id = ?').run(sessionId);
    }
  }
}

/**
 * Resolves one immutable repository snapshot per root session. Concurrent
 * resolution shares the same collection promise, while the SQLite row carries
 * the snapshot across host restarts.
 */
export class AgentStartupContextResolver {
  private readonly pending = new Map<string, Promise<AgentStartupContextSnapshot | null>>();

  constructor(
    private readonly store: AgentStartupContextStore,
    private readonly collect: AgentStartupContextCollector = collectAgentStartupContext,
    private readonly now: () => number = Date.now,
    private readonly reportError: (error: unknown, sessionId: string) => void = (error, sessionId) => {
      console.warn(`[agent] startup context unavailable for session ${sessionId}`, error);
    },
  ) {}

  async resolve(subject: AgentStartupContextSubject): Promise<AgentStartupContextSnapshot | null> {
    try {
      const stored = this.store.read(subject.sessionId);
      if (stored) return stored;
    } catch (error) {
      this.reportError(error, subject.sessionId);
      // The snapshot is optional inspection input. Remove a malformed row so
      // the next resolution can rebuild it instead of permanently suppressing
      // startup context for the session.
      try {
        this.store.delete([subject.sessionId]);
      } catch (deleteError) {
        // Cleanup is best-effort. Startup context is optional inspection
        // input; a failed delete must not turn an Agent spawn into a hard
        // failure or suppress the fresh collection attempt below.
        this.reportError(deleteError, subject.sessionId);
      }
    }

    const existing = this.pending.get(subject.sessionId);
    if (existing) return existing;

    const resolution = Promise.resolve()
      .then(async () => this.store.writeOnce(
        subject.sessionId,
        await this.collect(subject.cwd),
        this.now(),
      ))
      .catch((error) => {
        this.reportError(error, subject.sessionId);
        return null;
      })
      .finally(() => {
        if (this.pending.get(subject.sessionId) === resolution) {
          this.pending.delete(subject.sessionId);
        }
      });
    this.pending.set(subject.sessionId, resolution);
    return resolution;
  }

  delete(sessionIds: readonly string[]): void {
    this.store.delete(sessionIds);
  }
}

export async function collectAgentStartupContext(cwdInput: string): Promise<AgentStartupContextSnapshot> {
  const cwd = resolve(cwdInput);
  const [repositoryInstructions, gitStatus] = await Promise.all([
    collectRepositoryInstructions(cwd),
    collectGitStatus(cwd),
  ]);
  return { repositoryInstructions, gitStatus };
}

export async function collectRepositoryInstructions(cwd: string): Promise<readonly string[]> {
  const lexicalCwd = resolve(cwd);
  const repositoryRoot = await lexicalRepositoryRoot(lexicalCwd);
  const directories = hierarchyDirectories(repositoryRoot, lexicalCwd);
  const seenFiles = new Set<string>();
  const instructions: string[] = [];
  let remainingBytes = MAX_REPOSITORY_INSTRUCTION_BYTES;

  for (const directory of directories) {
    const source = await firstInstructionFile(directory);
    if (!source) continue;
    const canonical = await realpath(source).catch(() => source);
    if (seenFiles.has(canonical)) continue;
    seenFiles.add(canonical);
    const bytes = await readFile(source).catch(() => null);
    if (!bytes || remainingBytes === 0) continue;
    const retained = bytes.subarray(0, remainingBytes);
    remainingBytes -= retained.byteLength;
    const text = retained.toString('utf8').trim();
    if (!text) continue;
    instructions.push([
      `# AGENTS.md instructions for ${directory}`,
      '',
      '<INSTRUCTIONS>',
      text,
      '</INSTRUCTIONS>',
    ].join('\n'));
  }
  return Object.freeze(instructions);
}

export async function collectGitStatus(cwd: string): Promise<string | null> {
  const lexicalCwd = resolve(cwd);
  const repositoryRoot = await lexicalRepositoryRoot(lexicalCwd);
  if (repositoryRoot === lexicalCwd && !await isGitRepository(lexicalCwd)) return null;
  try {
    const [branch, mainBranch, status, log, userName] = await Promise.all([
      gitOutput(lexicalCwd, ['branch', '--show-current']),
      resolveMainBranch(lexicalCwd),
      gitOutput(lexicalCwd, ['--no-optional-locks', 'status', '--short']),
      gitOutput(lexicalCwd, ['--no-optional-locks', 'log', '--oneline', '-n', '5']),
      gitOutput(lexicalCwd, ['config', 'user.name']),
    ]);
    const normalizedStatus = status.length > MAX_GIT_STATUS_CHARS
      ? `${status.slice(0, MAX_GIT_STATUS_CHARS)}\n... (truncated because it exceeds 2k characters. Run git status for current details.)`
      : status;
    return [
      'This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
      `Current branch: ${branch || '(detached HEAD)'}`,
      `Main branch (you will usually use this for PRs): ${mainBranch}`,
      ...(userName ? [`Git user: ${userName}`] : []),
      `Status:\n${normalizedStatus || '(clean)'}`,
      `Recent commits:\n${log || '(none)'}`,
    ].join('\n\n');
  } catch {
    return null;
  }
}

export function renderAgentStartupContext(snapshot: AgentStartupContextSnapshot): string | null {
  const blocks = [
    ...snapshot.repositoryInstructions,
    snapshot.gitStatus === null ? null : [
      '# Session-start repository state',
      '',
      '<git-status>',
      snapshot.gitStatus,
      '</git-status>',
    ].join('\n'),
  ].filter((block): block is string => block !== null);
  return blocks.length === 0 ? null : blocks.join('\n\n');
}

function decodeAgentStartupContextSnapshot(value: unknown): AgentStartupContextSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted Agent startup context');
  }
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.repositoryInstructions)
    || record.repositoryInstructions.some((entry) => typeof entry !== 'string')
    || (record.gitStatus !== null && typeof record.gitStatus !== 'string')
    || Object.keys(record).some((key) => !['repositoryInstructions', 'gitStatus'].includes(key))
  ) {
    throw new Error('Invalid persisted Agent startup context');
  }
  return Object.freeze({
    repositoryInstructions: Object.freeze([...(record.repositoryInstructions as string[])]),
    gitStatus: record.gitStatus as string | null,
  });
}

async function resolveRepositoryRoot(cwd: string): Promise<string> {
  try {
    const reported = resolve(await gitOutput(cwd, ['rev-parse', '--show-toplevel']));
    return await realpath(reported).catch(() => reported);
  } catch {
    return cwd;
  }
}

async function lexicalRepositoryRoot(cwd: string): Promise<string> {
  let cursor = cwd;
  while (true) {
    if (await stat(join(cursor, '.git')).then(() => true).catch(() => false)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolveRepositoryRoot(cwd);
}

async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    return (await gitOutput(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

function hierarchyDirectories(root: string, cwd: string): readonly string[] {
  const directories: string[] = [];
  let cursor = cwd;
  while (true) {
    directories.push(cursor);
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor || !isWithin(root, parent)) return [cwd];
    cursor = parent;
  }
  return directories.reverse();
}

async function firstInstructionFile(directory: string): Promise<string | null> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const candidate = join(directory, name);
    const metadata = await stat(candidate).catch(() => null);
    if (metadata?.isFile()) return candidate;
  }
  return null;
}

async function resolveMainBranch(cwd: string): Promise<string> {
  const originHead = await gitOutput(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    .catch(() => '');
  if (originHead.startsWith('origin/')) return originHead.slice('origin/'.length);
  for (const candidate of ['main', 'master']) {
    try {
      await gitOutput(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      // Try the next conventional branch.
    }
  }
  return 'main';
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 1_024 * 1_024,
  });
  return stdout.trim();
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(parse(root).root) ? root : `${root}/`;
  return candidate.startsWith(prefix);
}
