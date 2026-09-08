import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionContextFact, ExecutionContextSource, ExecutionContextScopeObservation,
  ProjectCheckDeclaration, TaskExecutionContext } from '../../../core/agent/executionContext';
import { redactSecretLikeContent } from '../capabilities/agentSecretRedaction';
import { executionDigest, validateExecutionContext } from './ExecutionContext';

const run = promisify(execFile);
const SOURCE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'AGENT.md', '.tenon/checks.json'] as const;
const MAX_SOURCE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_CANDIDATES = 384;
const MAX_SCOPES = 32;
const MAX_DEPTH = 64;

export interface ExecutionContextDiscoveryOptions {
  readonly maxSourceBytes?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface ExecutionContextDiscoveryResult {
  readonly context: TaskExecutionContext;
  readonly sources: readonly ExecutionContextSource[];
  readonly scopes: readonly ExecutionContextScopeObservation[];
  readonly checks: readonly ProjectCheckDeclaration[];
}

/** Discovery captures later observations, never edits the original admission. */
export async function discoverExecutionContext(
  input: TaskExecutionContext, options: ExecutionContextDiscoveryOptions = {},
): Promise<ExecutionContextDiscoveryResult> {
  const admitted = validateExecutionContext(input);
  const now = options.now ?? Date.now;
  const capturedAt = now();
  const deadline = Date.now() + 2_000;
  const maxSourceBytes = Math.max(1, Math.min(MAX_SOURCE_BYTES, options.maxSourceBytes ?? MAX_SOURCE_BYTES));
  const facts: ExecutionContextFact[] = [];
  const sources = new Map<string, ExecutionContextSource>();
  const scopes: ExecutionContextScopeObservation[] = [];
  const checks: ProjectCheckDeclaration[] = [];
  const reasons = new Set<string>();
  const bodies = new Set<string>();
  let totalBytes = 0;
  const withinBudget = () => !options.signal?.aborted && Date.now() < deadline
    && sources.size < MAX_CANDIDATES && totalBytes < MAX_TOTAL_BYTES;
  for (const anchor of admitted.address.scopes.slice(0, MAX_SCOPES)) {
    const applicable: string[] = [];
    let complete = true;
    const ancestors = ancestorDirectories(anchor.directory);
    if (ancestors.length > MAX_DEPTH) { complete = false; reasons.add('Ancestor depth exceeded the discovery limit.'); }
    for (const directory of ancestors.slice(0, MAX_DEPTH)) {
      for (const name of SOURCE_NAMES) {
        const filePath = path.join(directory, name);
        if (!sources.has(filePath)) {
          if (!withinBudget()) { complete = false; reasons.add('Discovery budget exhausted or collection cancelled.'); continue; }
          const source = await inspectSource(filePath, Math.min(maxSourceBytes, MAX_TOTAL_BYTES - totalBytes));
          sources.set(filePath, source.observation);
          if (source.error) reasons.add(source.error);
          if (source.text !== null) {
            totalBytes += Buffer.byteLength(source.text);
            const key = JSON.stringify([source.observation.canonicalPath, directory]);
            if (!bodies.has(key)) {
              bodies.add(key);
              if (name === '.tenon/checks.json') {
                try {
                  const declarations = decodeCheckProfile(source.text, filePath, directory);
                  checks.push(...declarations);
                  facts.push(fact(filePath, 'profile', directory, source.observation.digest!,
                    `Project check declarations (not execution results):\n${JSON.stringify(declarations)}`));
                } catch {
                  complete = false;
                  reasons.add(`Invalid check profile: ${filePath}`);
                  facts.push(fact(filePath, 'profile', directory, 'unavailable', 'Check declarations are unavailable; do not rely on the previous profile.', true));
                }
              } else {
                const text = await redactSecretLikeContent(source.text);
                facts.push(fact(source.observation.canonicalPath!, 'instruction', directory,
                  source.observation.digest!, text || 'This instruction source is explicitly empty.'));
              }
            }
          }
        }
        const observed = sources.get(filePath);
        if (observed?.state === 'present') applicable.push(observed.canonicalPath!);
        else if (observed?.state === 'unavailable') complete = false;
      }
    }
    scopes.push({ directory: anchor.directory, sources: [...new Set(applicable)], complete });
    const git = withinBudget() ? await inspectGit(anchor.directory, anchor.worktree, options.signal) : null;
    if (!git) reasons.add(`Git observations unavailable: ${anchor.directory}`);
    facts.push({ source: 'host:git', kind: 'git', authority: 'host', purpose: 'observation',
      scope: anchor.directory, version: executionDigest(git), text: git ?? 'Git observations are unavailable.', invalidated: git === null });
    facts.push({ source: 'host:execution-discovery', kind: 'discovery', authority: 'host', purpose: 'observation',
      scope: anchor.directory, version: complete ? 'inspected' : 'incomplete',
      text: complete ? 'Enclosing instruction and check sources were inspected after task admission. Descendant scopes remain uninspected until addressed.'
        : 'Some enclosing instruction or check sources could not be inspected. Re-inspect before relying on earlier guidance.', invalidated: false });
  }
  if (admitted.address.scopes.length > MAX_SCOPES) reasons.add('Additional target scopes were not inspected at the discovery limit.');
  // A removed/unreadable source must revoke its previous body, including a retargeted alias.
  for (const previous of admitted.snapshot.facts) {
    if (previous.authority !== 'repository' || facts.some((current) => factIdentity(current) === factIdentity(previous))) continue;
    facts.push({ ...previous, invalidated: true, version: 'unavailable', text: 'This previously observed source is absent or unavailable; its earlier guidance no longer applies.' });
  }
  const snapshot = { seriesId: admitted.snapshot.seriesId, capturedAt,
    generation: admitted.snapshot.generation + 1, predecessorRef: admitted.snapshotRef,
    discovery: reasons.size ? 'unavailable' as const : 'complete' as const,
    degradation: reasons.size ? [...reasons].slice(0, 12).join(' ') : null,
    facts: facts.map((fact) => ({ ...fact, observedAt: capturedAt })) };
  return { context: validateExecutionContext({ ...admitted, snapshotRef: executionDigest(snapshot), snapshot }),
    sources: [...sources.values()], scopes, checks };
}

export async function validateDiscoveredSources(result: ExecutionContextDiscoveryResult): Promise<boolean> {
  if (result.context.snapshot.discovery !== 'complete' || Date.now() - result.context.snapshot.capturedAt > 5_000) return false;
  for (const source of result.sources) {
    const current = (await inspectSource(source.path, MAX_SOURCE_BYTES)).observation;
    if (JSON.stringify(current) !== JSON.stringify(source)) return false;
  }
  return true;
}

async function inspectSource(filePath: string, limit: number): Promise<{
  observation: ExecutionContextSource; text: string | null; error: string | null;
}> {
  const unavailable = (error: string) => ({ observation: { path: filePath, canonicalPath: null, digest: null, state: 'unavailable' as const }, text: null, error });
  let handle;
  try {
    const canonicalPath = await realpath(filePath);
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) return unavailable(`Not a regular instruction source: ${filePath}`);
    if (before.size > limit) return unavailable(`Source exceeded the discovery byte limit: ${filePath}`);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > limit || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || await realpath(filePath) !== canonicalPath) return unavailable(`Source changed during inspection: ${filePath}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    if (text.includes('\0')) return unavailable(`Invalid instruction source: ${filePath}`);
    return { observation: { path: filePath, canonicalPath, digest: executionDigest(text), state: 'present' }, text, error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { observation: { path: filePath, canonicalPath: null, digest: null, state: 'missing' }, text: null, error: null };
    return unavailable(`Could not inspect source: ${filePath}`);
  } finally { await handle?.close(); }
}

async function inspectGit(directory: string, worktree: string | null, signal?: AbortSignal): Promise<string | null> {
  if (!worktree) return 'No Git worktree was detected at admission.';
  try {
    const git = async (args: string[]) => (await run('git', ['-C', worktree, ...args], {
      timeout: 400, maxBuffer: 16 * 1024, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })).stdout.trim();
    const head = await git(['rev-parse', '--verify', 'HEAD']).catch(() => 'unborn or unavailable');
    const ref = await git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => 'detached or unavailable');
    const status = await git(['status', '--porcelain=v1', '--untracked-files=normal']);
    return `Observed Git worktree: ${worktree}\nScope: ${directory}\nHEAD: ${head}\nRef: ${ref}\nStatus:\n${status || '(clean)'}`;
  } catch { return null; }
}

function decodeCheckProfile(text: string, source: string, scope: string): ProjectCheckDeclaration[] {
  const profile = JSON.parse(text) as { schemaVersion: unknown; checks: unknown };
  if (!profile || Object.keys(profile).sort().join(',') !== 'checks,schemaVersion' || profile.schemaVersion !== 1
    || !Array.isArray(profile.checks) || profile.checks.length > 32) throw new Error('Invalid check profile');
  const ids = new Set<string>();
  return profile.checks.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid check');
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !['id', 'command', 'required', 'inputs', 'exclude'].includes(key))) throw new Error('Unknown check field');
    const string = (input: unknown) => { if (typeof input !== 'string' || !input.trim() || input.includes('\0') || input.length > 4_096) throw new Error('Invalid check text'); return input; };
    const strings = (input: unknown) => { if (!Array.isArray(input) || input.length > 64) throw new Error('Invalid check scope'); return input.map(string); };
    const id = string(entry.id);
    if (ids.has(id) || typeof entry.required !== 'boolean') throw new Error('Invalid check identity');
    ids.add(id);
    return { id, command: string(entry.command), required: entry.required, inputs: strings(entry.inputs), exclude: strings(entry.exclude), source, scope };
  });
}

function ancestorDirectories(directory: string): string[] {
  const ancestors = [directory];
  while (path.dirname(directory) !== directory) { directory = path.dirname(directory); ancestors.push(directory); }
  return ancestors.reverse();
}
function fact(source: string, kind: ExecutionContextFact['kind'], scope: string, version: string, text: string, invalidated = false): ExecutionContextFact {
  return { source, kind, authority: 'repository', purpose: 'guidance', scope, version, text, invalidated };
}
function factIdentity(value: ExecutionContextFact): string { return JSON.stringify([value.source, value.kind, value.authority, value.purpose, value.scope]); }
