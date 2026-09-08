/** Immutable evidence, never an authorization to mutate a repository. */
export interface GitBaseline {
  readonly root: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly identity: string;
  readonly head: string | null;
  readonly ref: string | null;
}
export interface GitReviewPath {
  readonly path: string;
  readonly canonicalPath: string;
  readonly status: string;
  readonly previousPath: string | null;
  readonly kind: 'file' | 'symlink' | 'deleted' | 'directory';
  readonly bytes: number;
  readonly mode: number;
  readonly digest: string;
  readonly index: string;
  readonly diffDigest: string;
  readonly binary: boolean;
  readonly diff: string;
}
export interface GitPublicationPreview {
  readonly remote: string;
  readonly url: string;
  readonly branch: string;
  readonly upstream: string | null;
  readonly remoteHead: string | null;
  readonly commits: readonly string[];
  readonly base: string;
  readonly baseOid: string;
  readonly provider: 'github' | 'git';
  readonly repository: string | null;
}
export interface GitReviewEvidence {
  readonly version: 1;
  readonly operation: 'capture' | 'commit' | 'preview' | 'push' | 'create-pr';
  readonly outcome: 'reviewed' | 'previewed' | 'succeeded' | 'reconciled' | 'rejected' | 'uncertain';
  readonly cwd: string;
  readonly observedAt: number;
  readonly baseline: GitBaseline | null;
  readonly paths: readonly GitReviewPath[];
  readonly preview: GitPublicationPreview | null;
  readonly commit: string | null;
  readonly parent: string | null;
  readonly pullRequest: string | null;
  readonly message: string;
}
export const GIT_REVIEW_MAX_PATHS = 256;
export const GIT_REVIEW_MAX_BYTES = 1024 * 1024;
export const GIT_REVIEW_COMMAND = /^git-review (capture|commit|preview|push|create-pr) --input - --output json$/u;
export function gitReviewOperation(command: string): GitReviewEvidence['operation'] | null {
  return (GIT_REVIEW_COMMAND.exec(command)?.[1] as GitReviewEvidence['operation']) ?? null;
}

/** Persistence boundary: refuse malformed/oversized evidence, including unknown fields. */
export function decodeGitReviewEvidence(value: unknown): GitReviewEvidence {
  const record = object(value, ['version', 'operation', 'outcome', 'cwd', 'observedAt', 'baseline', 'paths', 'preview', 'commit', 'parent', 'pullRequest', 'message']);
  if (record.version !== 1 || JSON.stringify(value).length > GIT_REVIEW_MAX_BYTES) fail();
  member(record.operation, ['capture', 'commit', 'preview', 'push', 'create-pr']);
  member(record.outcome, ['reviewed', 'previewed', 'succeeded', 'reconciled', 'rejected', 'uncertain']);
  absolute(record.cwd); number(record.observedAt); string(record.message);
  for (const key of ['commit', 'parent']) if (record[key] !== null) oid(record[key]);
  if (record.pullRequest !== null && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(string(record.pullRequest))) fail();
  if (record.baseline !== null) {
    const baseline = object(record.baseline, ['root', 'gitDirectory', 'commonDirectory', 'identity', 'head', 'ref']);
    for (const key of ['root', 'gitDirectory', 'commonDirectory']) absolute(baseline[key]);
    digest(baseline.identity);
    if (baseline.head !== null) oid(baseline.head);
    if (baseline.ref !== null && !string(baseline.ref).startsWith('refs/heads/')) fail();
    if (baseline.head === null && baseline.ref === null) fail();
  }
  if (!Array.isArray(record.paths) || record.paths.length > GIT_REVIEW_MAX_PATHS) fail();
  const names = new Set<string>();
  for (const value of record.paths) {
    const entry = object(value, ['path', 'canonicalPath', 'status', 'previousPath', 'kind', 'bytes', 'mode', 'digest', 'index', 'diffDigest', 'binary', 'diff']);
    const name = relative(entry.path);
    if (names.has(name)) fail();
    names.add(name); absolute(entry.canonicalPath); string(entry.status);
    if (entry.previousPath !== null) relative(entry.previousPath);
    member(entry.kind, ['file', 'symlink', 'deleted', 'directory']);
    number(entry.bytes); number(entry.mode); digest(entry.digest); digest(entry.diffDigest);
    if (typeof entry.index !== 'string') fail();
    string(entry.diff);
    if (typeof entry.binary !== 'boolean') fail();
  }
  if (record.preview !== null) {
    const preview = object(record.preview, ['remote', 'url', 'branch', 'upstream', 'remoteHead', 'commits', 'base', 'baseOid', 'provider', 'repository']);
    for (const key of ['remote', 'url', 'branch', 'base']) string(preview[key]);
    for (const key of ['upstream', 'repository']) if (preview[key] !== null) string(preview[key]);
    if (preview.remoteHead !== null) oid(preview.remoteHead);
    oid(preview.baseOid); member(preview.provider, ['github', 'git']);
    if (!Array.isArray(preview.commits) || preview.commits.length > 256) fail();
    preview.commits.forEach(oid);
  }
  return value as GitReviewEvidence;
}
function fail(): never { throw new Error('Invalid Git review evidence'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) fail();
  return result;
}
function string(value: unknown): string { if (typeof value !== 'string' || value.includes('\0')) fail(); return value as string; }
function absolute(value: unknown): void { if (!string(value).startsWith('/')) fail(); }
function relative(value: unknown): string {
  const path = string(value);
  if (!path || path.startsWith('/') || path.split('/').some((part) => ['', '.', '..', '.git'].includes(part))) fail();
  return path;
}
function number(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(); }
function digest(value: unknown): void { if (!/^[a-f0-9]{64}$/u.test(string(value))) fail(); }
function oid(value: unknown): void { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(string(value))) fail(); }
function member(value: unknown, values: string[]): void { if (!values.includes(string(value))) fail(); }
