import type { ProjectCheckDeclaration } from './executionContext';
import type { ThreadContextPayloadReference } from './protocol';

export interface VerificationConfiguration {
  readonly roots: readonly string[];
  readonly maxAttempts: number;
}
export interface VerificationSourceEntry {
  readonly root: string;
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'missing';
  readonly mode: number;
  readonly bytes: number;
  readonly digest: string | null;
  readonly target: string | null;
}
export interface VerificationSourceRoot {
  readonly path: string;
  readonly identity: string;
  readonly worktree: string | null;
  readonly gitDirectory: string | null;
  readonly head: string | null;
  readonly ref: string | null;
  readonly indexDigest: string | null;
}
export interface VerificationSourceManifest {
  readonly roots: readonly VerificationSourceRoot[];
  readonly entries: readonly VerificationSourceEntry[];
  readonly definitionDigest: string;
  readonly digest: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly limitations: readonly string[];
}
export interface VerificationCheckDefinition extends ProjectCheckDeclaration {
  readonly key: string;
}
export type VerificationCheckState = 'running' | 'passed' | 'failed' | 'stopped' | 'lost' | 'unavailable';
export type VerificationApplicability = 'current' | 'stale' | 'unavailable';
export interface VerificationCheckView {
  readonly checkId: string;
  readonly command: string;
  readonly cwd: string;
  readonly required: boolean;
  readonly toolTaskId: string | null;
  readonly state: VerificationCheckState;
  readonly applicability: VerificationApplicability;
  readonly exitCode: number | null;
  readonly output: string | null;
  readonly reason: string | null;
}
export interface VerificationView {
  readonly verificationRunId: string;
  readonly revision: number | null;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly state: 'pending' | 'running' | 'passed' | 'failed' | 'stopped' | 'unavailable';
  readonly stopReason: string | null;
  readonly changedPaths: readonly string[];
  readonly checks: readonly VerificationCheckView[];
  readonly sourceStateRef: ThreadContextPayloadReference | null;
  readonly limitations: readonly string[];
}

export function decodeVerificationConfiguration(value: unknown): VerificationConfiguration {
  const record = object(value, ['roots', 'maxAttempts']);
  const roots = strings(record.roots, 8);
  if (!roots.length || new Set(roots).size !== roots.length || roots.some((root) => !root.startsWith('/'))) {
    throw new Error('Verification requires one to eight distinct absolute directory roots.');
  }
  const maxAttempts = integer(record.maxAttempts);
  if (maxAttempts < 1 || maxAttempts > 20) throw new Error('Verification attempts must be between 1 and 20.');
  return { roots, maxAttempts };
}

export function decodeVerificationManifest(value: unknown): VerificationSourceManifest {
  const record = object(value, ['roots', 'entries', 'definitionDigest', 'digest', 'startedAt', 'finishedAt', 'limitations']);
  const roots = array(record.roots, 32).map((value) => {
    const root = object(value, ['path', 'identity', 'worktree', 'gitDirectory', 'head', 'ref', 'indexDigest']);
    return { path: text(root.path), identity: text(root.identity), worktree: nullable(root.worktree),
      gitDirectory: nullable(root.gitDirectory), head: nullable(root.head), ref: nullable(root.ref), indexDigest: nullable(root.indexDigest) };
  });
  const rootPaths = new Set(roots.map((root) => root.path));
  if (rootPaths.size !== roots.length || roots.some((root) => !root.path.startsWith('/'))) throw new Error('Invalid source roots.');
  const entryKeys = new Set<string>();
  const entries = array(record.entries, 20_000).map((value): VerificationSourceEntry => {
    const entry = object(value, ['root', 'path', 'kind', 'mode', 'bytes', 'digest', 'target']);
    const kind = text(entry.kind);
    if (!['file', 'directory', 'symlink', 'missing'].includes(kind)) throw new Error('Invalid source entry kind.');
    const root = text(entry.root), path = text(entry.path), key = JSON.stringify([root, path]);
    if (!rootPaths.has(root) || path.startsWith('/') || path.split('/').includes('..') || entryKeys.has(key)
      || (['file', 'symlink'].includes(kind) ? typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.digest) : entry.digest !== null)
      || (kind === 'symlink' && (typeof entry.target !== 'string' || !entry.target.startsWith('/')))
      || (['missing', 'directory'].includes(kind) && (entry.bytes !== 0 || entry.target !== null))) throw new Error('Invalid source entry binding.');
    entryKeys.add(key);
    return { root, path, kind: kind as VerificationSourceEntry['kind'],
      mode: integer(entry.mode), bytes: integer(entry.bytes), digest: nullable(entry.digest), target: nullable(entry.target) };
  });
  const startedAt = integer(record.startedAt), finishedAt = integer(record.finishedAt);
  if (finishedAt < startedAt || !roots.length) throw new Error('Invalid source capture interval or roots.');
  const digest = text(record.digest), definitionDigest = text(record.definitionDigest);
  if (![digest, definitionDigest].every((value) => /^[a-f0-9]{64}$/u.test(value))) throw new Error('Invalid source manifest digest.');
  return { roots, entries, digest, definitionDigest, startedAt, finishedAt, limitations: strings(record.limitations, 128) };
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected verification object.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new Error('Invalid verification fields.');
  return record;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 16_384) throw new Error('Invalid verification text.');
  return value;
}
function nullable(value: unknown): string | null { return value === null ? null : text(value); }
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid verification integer.');
  return value as number;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid verification array.');
  return value;
}
function strings(value: unknown, max: number): string[] { return array(value, max).map(text); }
