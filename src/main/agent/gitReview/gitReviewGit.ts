import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitBaseline, GitReviewEvidence, GitReviewPath, GitPublicationPreview } from '../../../core/agent/gitReview';
import { decodeGitReviewEvidence, GIT_REVIEW_MAX_PATHS } from '../../../core/agent/gitReview';
import { redactSecretLikeContent } from '../capabilities/agentSecretStringScanner';
import { assertNoExecutableGitFilters, GIT_FILTER_CONFIG_ARGS, GIT_INSPECTION_ARGS } from '../tasks/gitInspectionPolicy';

const LIMIT = 8 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export type GitCli = (executable: 'git' | 'gh', args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: Buffer }>;

/** Every subprocess belongs to the supervised helper's process group. Never shell-expand inputs. */
export function gitCli(cwd: string): GitCli {
  const run: GitCli = (executable, args, input, extraEnv) => new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C', GH_PROMPT_DISABLED: '1' };
    // Ambient Git overrides must not silently redirect an admitted address.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
      delete (env as NodeJS.ProcessEnv)[key];
    }
    if (extraEnv?.GIT_INDEX_FILE) (env as NodeJS.ProcessEnv).GIT_INDEX_FILE = extraEnv.GIT_INDEX_FILE;
    const child = execFile(executable, executable === 'git' ? ['--literal-pathspecs', ...GIT_INSPECTION_ARGS, ...args] : args, {
      cwd, env, encoding: 'buffer', maxBuffer: LIMIT, timeout: 30_000,
    }, (error, stdout) => {
      if (error && (typeof error.code !== 'number' || error.killed)) { reject(new Error(`${executable} did not produce a bounded, settled result`)); return; }
      resolve({ code: error ? Number(error.code) : 0, stdout });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
  return async (executable, args, input, extraEnv) => {
    if (executable === 'git' && ['status', 'diff', 'ls-files', 'read-tree', 'update-index', 'write-tree'].includes(args[0]!)) {
      // --no-ext-diff/--no-textconv do not prevent clean/process filters during
      // status, index refresh, or worktree diff. Inspect effective configuration
      // (including includes and environment) before each such command. Filtered
      // repositories require an explicitly authorized ordinary Bash workflow.
      const filters = await run('git', GIT_FILTER_CONFIG_ARGS, undefined, extraEnv);
      if (![0, 1].includes(filters.code)) throw new Error('Git filter configuration is unavailable');
      assertNoExecutableGitFilters(filters.stdout.toString('utf8'));
    }
    return run(executable, args, input, extraEnv);
  };
}
async function checked(cli: GitCli, args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv): Promise<Buffer> {
  const result = await cli('git', args, input, env);
  if (result.code !== 0) throw new Error(`Git ${args[0]} failed; inspect the repository before retrying`);
  return result.stdout;
}
const text = (value: Buffer) => value.toString('utf8').trim();
const validOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
async function optionalRef(cli: GitCli, ref: string): Promise<string | null> {
  const value = await cli('git', ['rev-parse', '--verify', '--quiet', ref]);
  if (value.code === 1 && !value.stdout.length) return null;
  const oid = text(value.stdout);
  if (value.code || !validOid(oid)) throw new Error('Git baseline OID is unavailable');
  return oid;
}
export async function readGitBaseline(cwd: string, cli: GitCli): Promise<GitBaseline | null> {
  const probe = await cli('git', ['rev-parse', '--show-toplevel']);
  if (probe.code !== 0) {
    // Only a genuinely absent repository is a non-Git root. Corrupt .git is not.
    let directory = await realpath(cwd);
    for (;;) {
      if (await lstat(path.join(directory, '.git')).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false; throw error;
      })) throw new Error('Git baseline is unavailable');
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
    if (probe.code !== 128) throw new Error('Git baseline query failed');
    return null;
  }
  const root = await realpath(text(probe.stdout));
  const address = await realpath(cwd);
  if (address !== root && !address.startsWith(`${root}/`)) throw new Error('Git worktree does not contain the admitted directory');
  const gitDirectory = await realpath(text(await checked(cli, ['rev-parse', '--absolute-git-dir'])));
  const commonDirectory = await realpath(path.resolve(cwd, text(await checked(cli, ['rev-parse', '--git-common-dir']))));
  const attachment = await cli('git', ['symbolic-ref', '-q', 'HEAD']);
  if (![0, 1].includes(attachment.code)) throw new Error('Git HEAD attachment is unavailable');
  const ref = attachment.code === 0 ? text(attachment.stdout) : null;
  if (ref !== null && !/^refs\/heads\/[^\s\x00-\x1f]+$/u.test(ref)) throw new Error('Unsupported Git HEAD attachment');
  const head = await optionalRef(cli, 'HEAD');
  if (!head && !ref) throw new Error('Detached HEAD has no commit');
  if (head) await checked(cli, ['cat-file', '-e', `${head}^{commit}`]);
  const identities = await Promise.all([root, gitDirectory, commonDirectory, path.join(root, '.git')].map(async (entry) => {
    const stat = await lstat(entry);
    return [entry, stat.dev, stat.ino, stat.isFile() ? hash(await readFile(entry)) : stat.isSymbolicLink() ? await readlink(entry) : 'directory'];
  }));
  return { root, gitDirectory, commonDirectory, identity: hash(JSON.stringify(identities)), head, ref };
}

function selectedPaths(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > GIT_REVIEW_MAX_PATHS || (!allowEmpty && !value.length)) throw new Error('Select between 1 and 256 explicit paths');
  const paths = value.map((entry: unknown) => {
    if (typeof entry !== 'string' || !entry || entry.includes('\0') || path.isAbsolute(entry)
      || entry.split('/').some((part) => ['', '.', '..', '.git'].includes(part))) throw new Error('Use exact repository-relative file paths');
    return entry;
  });
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate selected paths');
  return paths.sort();
}
async function canonicalEntry(root: string, name: string): Promise<string> {
  let parent = path.dirname(path.join(root, name));
  const missing: string[] = [];
  for (;;) {
    try { parent = await realpath(parent); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.unshift(path.basename(parent)); parent = path.dirname(parent); }
  }
  const canonical = path.join(parent, ...missing, path.basename(name));
  if (!canonical.startsWith(`${root}/`)) throw new Error('A reviewed path escapes its worktree');
  return canonical;
}
async function worktreeEntry(root: string, name: string): Promise<Pick<GitReviewPath, 'canonicalPath' | 'kind' | 'bytes' | 'mode' | 'digest' | 'binary'>> {
  const canonicalPath = await canonicalEntry(root, name);
  const stat = await lstat(canonicalPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return { canonicalPath, kind: 'deleted', bytes: 0, mode: 0, digest: hash(''), binary: false };
  const kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'directory';
  if (stat.size > LIMIT) throw new Error('A reviewed file exceeds the 8 MiB evidence limit');
  const bytes = kind === 'symlink' ? await readlink(canonicalPath, { encoding: 'buffer' }) : kind === 'file' ? await readFile(canonicalPath) : Buffer.alloc(0);
  return { canonicalPath, kind, bytes: bytes.length, mode: stat.mode & 0o777, digest: hash(bytes), binary: bytes.includes(0) };
}
async function gitStatus(cli: GitCli): Promise<Map<string, { status: string; previousPath: string | null }>> {
  // Report changed gitlinks, but never recurse into submodule worktree status:
  // that would inspect a different repository's executable filter configuration.
  const output = await checked(cli, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty']);
  if (!Buffer.from(output.toString('utf8')).equals(output)) throw new Error('Non-UTF-8 Git paths require ordinary Bash review');
  const parts = output.toString('utf8').split('\0');
  const result = new Map<string, { status: string; previousPath: string | null }>();
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const status = parts[i]!.slice(0, 2); const name = parts[i]!.slice(3);
    const previousPath = /[RC]/u.test(status) ? parts[++i] ?? null : null;
    result.set(name, { status, previousPath });
    if (previousPath) result.set(previousPath, { status: 'D ', previousPath: null });
  }
  return result;
}
async function inspectPaths(root: string, cli: GitCli, baseline: GitBaseline | null, names: string[]): Promise<GitReviewPath[]> {
  const statuses = baseline ? await gitStatus(cli) : new Map();
  const results: GitReviewPath[] = [];
  for (const name of names) {
    const entry = await worktreeEntry(root, name);
    const index = baseline ? (await checked(cli, ['ls-files', '--stage', '-z', '--', name])).toString('utf8') : '';
    const diff = baseline ? Buffer.concat([
      await checked(cli, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--submodule=short', '--binary', '--', name]),
      await checked(cli, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--submodule=short', '--binary', '--', name]),
    ]) : Buffer.alloc(0);
    let snippet = diff.toString('utf8');
    const binary = entry.binary || /(?:^|\n)GIT binary patch(?:\n|$)/u.test(snippet);
    if (!snippet && entry.kind === 'file' && !entry.binary && (!baseline || !index)) snippet = (await readFile(entry.canonicalPath)).toString('utf8');
    results.push({ path: name, ...entry, binary, status: statuses.get(name)?.status ?? (baseline ? '  ' : '??'),
      previousPath: statuses.get(name)?.previousPath ?? null, index, diffDigest: hash(diff),
      diff: binary ? '' : redactSecretLikeContent(snippet).slice(0, 2048) });
  }
  return results;
}
export async function captureReview(cwd: string, paths?: unknown, cli = gitCli(cwd)): Promise<GitReviewEvidence> {
  cwd = await realpath(cwd);
  const baseline = await readGitBaseline(cwd, cli);
  const root = baseline?.root ?? await realpath(cwd);
  // All file paths are relative to the worktree root, including calls from subdirectories.
  const rootCli = root === cwd ? cli : gitCli(root);
  const names = selectedPaths(paths ?? (baseline ? [...(await gitStatus(rootCli)).keys()] : []), !!baseline);
  const first = await inspectPaths(root, rootCli, baseline, names);
  const second = await inspectPaths(root, rootCli, baseline, names);
  if (!same(baseline, await readGitBaseline(cwd, cli)) || !same(first, second)) throw new Error('Review changed during capture; refresh the review');
  return evidence('capture', 'reviewed', cwd, baseline, { paths: first,
    message: baseline ? 'Historical review only. Commit requires explicit paths and live revalidation.' : 'Non-Git file review. Commit and publication are unavailable.' });
}
function evidence(operation: GitReviewEvidence['operation'], outcome: GitReviewEvidence['outcome'], cwd: string, baseline: GitBaseline | null,
  fields: Partial<GitReviewEvidence> = {}): GitReviewEvidence {
  return decodeGitReviewEvidence({ version: 1, operation, outcome, cwd, observedAt: Date.now(), baseline,
    paths: [], preview: null, commit: null, parent: null, pullRequest: null, message: '', ...fields });
}

export async function commitReview(cwd: string, review: GitReviewEvidence, paths: unknown, message: unknown, cli = gitCli(cwd)): Promise<GitReviewEvidence> {
  cwd = await realpath(cwd);
  const names = selectedPaths(paths);
  if (typeof message !== 'string' || !message.trim() || message.length > 16_384 || message.includes('\0')) throw new Error('A bounded nonempty commit message is required');
  if (review.operation !== 'capture' || review.outcome !== 'reviewed' || !review.baseline) throw new Error('A Git review snapshot is required');
  const baseline = review.baseline; const root = baseline.root;
  if (await realpath(cwd) !== review.cwd) throw new Error('Review belongs to a different execution address');
  const rootCli = cwd === root ? cli : gitCli(root);
  const expected = names.map((name) => { const entry = review.paths.find((item) => item.path === name); if (!entry) throw new Error('Selected path was not reviewed'); return entry; });
  for (const entry of expected) {
    if (entry.kind === 'directory' || / [123]\t/u.test(entry.index) || /^160000 /mu.test(entry.index)) throw new Error('Resolve unmerged entries or submodules with ordinary Git before committing');
    if (entry.previousPath && !names.includes(entry.previousPath)) throw new Error('Select both sides of a reviewed rename');
  }
  const validate = async () => {
    if (!same(await readGitBaseline(cwd, cli), baseline)
      || !same(await inspectPaths(root, rootCli, baseline, names), expected)) throw new Error('Reviewed HEAD, branch, index, or files changed; refresh the review');
  };
  await validate();
  const index = path.join(baseline.gitDirectory, 'index');
  const indexLock = `${index}.lock`;
  const lock = await open(indexLock, 'wx', 0o600);
  const temporary = path.join(baseline.gitDirectory, `tenon-review-${randomUUID()}`);
  const commitIndex = path.join(temporary, 'commit-index'); const nextIndex = path.join(temporary, 'next-index');
  const env = { GIT_INDEX_FILE: commitIndex };
  let refMayHaveChanged = false;
  let sha: string | null = null;
  try {
    await mkdir(temporary, { mode: 0o700 });
    await validate();
    const originalIndex = await readFile(index).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    await checked(rootCli, baseline.head ? ['read-tree', baseline.head] : ['read-tree', '--empty'], undefined, env);
    // Write precisely the reviewed bytes. Repository clean filters must not
    // transform an untracked/binary file after the user reviewed its digest.
    const objectFormat = text(await checked(rootCli, ['rev-parse', '--show-object-format']));
    const zeroObject = '0'.repeat(objectFormat === 'sha256' ? 64 : 40);
    const updates: string[] = [];
    for (const entry of expected) {
      if (entry.kind === 'deleted') { updates.push(`0 ${zeroObject}\t${entry.path}\0`); continue; }
      const bytes = entry.kind === 'symlink' ? await readlink(entry.canonicalPath, { encoding: 'buffer' }) : await readFile(entry.canonicalPath);
      if (hash(bytes) !== entry.digest) throw new Error('Reviewed bytes changed during commit preparation');
      const blob = text(await checked(rootCli, ['hash-object', '-w', '--stdin', '--no-filters'], bytes));
      const mode = entry.kind === 'symlink' ? '120000' : entry.mode & 0o111 ? '100755' : '100644';
      updates.push(`${mode} ${blob}\t${entry.path}\0`);
    }
    await checked(rootCli, ['update-index', '-z', '--index-info'], updates.join(''), env);
    const tree = text(await checked(rootCli, ['write-tree'], undefined, env));
    if (baseline.head && text(await checked(rootCli, ['rev-parse', `${baseline.head}^{tree}`])) === tree) throw new Error('Selected files contain no changes');
    try { await copyFile(index, nextIndex); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await checked(rootCli, ['read-tree', '--empty'], undefined, { GIT_INDEX_FILE: nextIndex }); }
    const selectedIndex = await checked(rootCli, ['ls-files', '--stage', '-z', '--', ...names], undefined, env);
    const zeros = '0'.repeat(baseline.head?.length ?? tree.length);
    const removals = names.map((name) => `0 ${zeros}\t${name}\0`).join('');
    await checked(rootCli, ['update-index', '-z', '--index-info'], Buffer.concat([Buffer.from(removals), selectedIndex]), { GIT_INDEX_FILE: nextIndex });
    const signing = await rootCli('git', ['config', '--type=bool', '--get', 'commit.gpgSign']);
    if (![0, 1].includes(signing.code)) throw new Error('Git signing configuration is unavailable');
    sha = text(await checked(rootCli, ['commit-tree', tree, ...(baseline.head ? ['-p', baseline.head] : []), ...(text(signing.stdout) === 'true' ? ['-S'] : []), '-F', '-'], message));
    if (!validOid(sha)) throw new Error('Git did not return a commit OID');
    await lock.writeFile(await readFile(nextIndex)); await lock.sync();
    // Signing can execute a configured signer. Recheck after all preparation.
    await validate();
    const currentIndex = await readFile(index).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!same(originalIndex ? hash(originalIndex) : null, currentIndex ? hash(currentIndex) : null)) throw new Error('Git index changed outside its lock; refresh the review');
    refMayHaveChanged = true;
    // Address the reviewed ref explicitly: a racing checkout must never redirect
    // this update to a different branch. Git compares the old OID under its ref
    // lock; attachment is validated immediately before and after settlement.
    await checked(rootCli, ['update-ref', '--no-deref', '-m', 'Tenon reviewed commit', baseline.ref ?? 'HEAD', sha, baseline.head ?? zeros]);
    await lock.close(); await rename(indexLock, index);
    const after = await readGitBaseline(cwd, cli);
    const parents = text(await checked(rootCli, ['rev-list', '--parents', '-n', '1', sha])).split(' ');
    if (!same(after, { ...baseline, head: sha }) || !same(parents, [sha, ...(baseline.head ? [baseline.head] : [])])) throw new Error('Git changed concurrently after the ref transaction');
    for (const entry of expected) {
      const current = await worktreeEntry(root, entry.path);
      if (current.digest !== entry.digest || current.kind !== entry.kind || current.mode !== entry.mode) throw new Error('Working files changed while committing');
    }
    return evidence('commit', 'succeeded', cwd, after, { paths: expected, commit: sha, parent: baseline.head,
      message: 'Committed the selected reviewed working files. Unrelated index and working files were retained.' });
  } catch (error) {
    return evidence('commit', refMayHaveChanged ? 'uncertain' : 'rejected', cwd, baseline, { paths: expected, commit: sha, parent: baseline.head,
      message: `${(error as Error).message}${refMayHaveChanged ? '. Inspect HEAD, the commit, and index before any further commit; do not retry automatically.' : ''}` });
  } finally {
    await lock.close().catch(() => {});
    // A ref/index interruption leaves its lock as reconciliation evidence.
    if (!refMayHaveChanged) await rm(indexLock, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)) throw new Error(`An explicit ${label} is required`);
  return value;
}
async function remoteOid(cli: GitCli, url: string, branch: string): Promise<string | null> {
  const lines = text(await checked(cli, ['ls-remote', '--refs', '--', url, `refs/heads/${branch}`]));
  if (!lines) return null;
  const entries = lines.split('\n').map((line) => line.split('\t'));
  if (entries.length !== 1 || entries[0]?.[1] !== `refs/heads/${branch}` || !validOid(entries[0][0]!)) throw new Error('Remote branch evidence is ambiguous');
  return entries[0]![0]!;
}
async function remoteConfiguration(cli: GitCli, remote: string): Promise<string> {
  const urls = text(await checked(cli, ['remote', 'get-url', '--push', '--all', remote])).split('\n');
  if (urls.length !== 1 || !urls[0]) throw new Error('Select a remote with exactly one push URL');
  const url = urls[0];
  if (url.length > 4096 || url.includes('::') || /[\x00-\x20]/u.test(url)) throw new Error('Unsupported remote URL');
  if (url.includes('://')) {
    const parsed = new URL(url);
    if (!['https:', 'ssh:', 'file:'].includes(parsed.protocol) || parsed.password || (parsed.username && parsed.username !== 'git') || parsed.search || parsed.hash) {
      throw new Error('Remote URLs must not contain credentials, query strings, or unsupported transports');
    }
  }
  if (!url.includes('://') && !path.isAbsolute(url) && !/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(url)) throw new Error('Use an absolute local remote or a supported HTTPS/SSH URL');
  if (redactSecretLikeContent(url) !== url) throw new Error('Remote URL contains secret-like content');
  return url;
}
function githubRepository(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(url);
  return match?.[1] ?? null;
}
export async function previewPublication(cwd: string, input: Record<string, unknown>, cli = gitCli(cwd)): Promise<GitReviewEvidence> {
  cwd = await realpath(cwd);
  const baseline = await readGitBaseline(cwd, cli);
  if (!baseline?.head || !baseline.ref) throw new Error('Publication requires a Git branch with a commit');
  const remote = name(input.remote, 'remote name'); const base = name(input.base, 'PR base branch');
  const branch = baseline.ref.slice('refs/heads/'.length);
  await checked(cli, ['check-ref-format', `refs/heads/${base}`]);
  const url = await remoteConfiguration(cli, remote);
  const remoteHead = await remoteOid(cli, url, branch); const baseOid = await remoteOid(cli, url, base);
  if (!baseOid) throw new Error('Remote base branch is absent');
  // Never silently fetch or change refs to construct a preview.
  await checked(cli, ['cat-file', '-e', `${baseOid}^{commit}`]);
  const commits = text(await checked(cli, ['rev-list', '--reverse', '--max-count=257', `${baseOid}..${baseline.head}`])).split('\n').filter(Boolean);
  if (commits.length > 256) throw new Error('Publication range exceeds 256 commits');
  const upstreamResult = await cli('git', ['for-each-ref', '--format=%(upstream)', baseline.ref]);
  if (upstreamResult.code !== 0) throw new Error('Upstream observation failed');
  const repository = githubRepository(url);
  if (!same(baseline, await readGitBaseline(cwd, cli))) throw new Error('Git baseline changed during preview');
  return evidence('preview', 'previewed', cwd, baseline, { preview: { remote, url, branch,
    upstream: text(upstreamResult.stdout) || null, remoteHead, commits, base, baseOid,
    provider: repository ? 'github' : 'git', repository },
    message: 'Historical publication preview. Push and PR creation require separate explicit requests; merge is unavailable.' });
}
async function validatePreview(cwd: string, prior: GitReviewEvidence, cli: GitCli): Promise<GitPublicationPreview> {
  if (prior.operation !== 'preview' || prior.outcome !== 'previewed' || !prior.preview || !prior.baseline?.head || !prior.baseline.ref) throw new Error('A publication preview reference is required');
  if (await realpath(cwd) !== prior.cwd || !same(await readGitBaseline(cwd, cli), prior.baseline)
    || await remoteConfiguration(cli, prior.preview.remote) !== prior.preview.url) throw new Error('Local branch, HEAD, address, or remote changed; refresh the preview');
  const upstream = text(await checked(cli, ['for-each-ref', '--format=%(upstream)', prior.baseline.ref])) || null;
  if (upstream !== prior.preview.upstream) throw new Error('Upstream changed; refresh the preview');
  return prior.preview;
}
export async function pushPublication(cwd: string, prior: GitReviewEvidence, cli = gitCli(cwd)): Promise<GitReviewEvidence> {
  cwd = await realpath(cwd);
  const preview = await validatePreview(cwd, prior, cli);
  const fields = { preview, commit: prior.baseline!.head };
  let attempted = false;
  try {
    // Always reconcile before a new attempt, including after Host restart.
    const current = await remoteOid(cli, preview.url, preview.branch);
    if (current === prior.baseline!.head) return evidence('push', 'reconciled', cwd, prior.baseline, { ...fields, message: 'Remote branch already points to the previewed commit; no push was repeated.' });
    if (current !== preview.remoteHead || await remoteOid(cli, preview.url, preview.base) !== preview.baseOid) throw new Error('Remote branch or base changed; refresh the preview');
    await validatePreview(cwd, prior, cli);
    attempted = true;
    // An exact OID avoids publishing an externally moved local branch. No force option.
    const result = await cli('git', ['push', '--porcelain', '--', preview.url, `${prior.baseline!.head}:refs/heads/${preview.branch}`]);
    const observed = await remoteOid(cli, preview.url, preview.branch);
    if (observed !== prior.baseline!.head) throw new Error('Remote ref does not confirm the previewed commit');
    return evidence('push', result.code === 0 ? 'succeeded' : 'reconciled', cwd, prior.baseline, { ...fields, message: 'Remote ref confirms the exact previewed commit.' });
  } catch (error) {
    return evidence('push', attempted ? 'uncertain' : 'rejected', cwd, prior.baseline, { ...fields,
      message: `${(error as Error).message}. Query the remote with this preview before another attempt; never force push.` });
  }
}
interface PullRequest { number: number; url: string; headRefOid: string; headRefName: string; baseRefName: string; state: string; isCrossRepository: boolean; }
async function findPullRequest(cli: GitCli, preview: GitPublicationPreview, head: string): Promise<PullRequest | null> {
  const result = await cli('gh', ['pr', 'list', '--repo', `github.com/${preview.repository!}`, '--state', 'all', '--head', preview.branch,
    '--base', preview.base, '--limit', '100', '--json', 'number,url,headRefOid,headRefName,baseRefName,state,isCrossRepository']);
  if (result.code) throw new Error('GitHub PR reconciliation is unavailable');
  const values: unknown = JSON.parse(result.stdout.toString('utf8'));
  if (!Array.isArray(values) || values.length >= 100) throw new Error('GitHub PR query is incomplete');
  const found: PullRequest[] = [];
  for (const value of values) {
    const pr = value as PullRequest;
    if (!pr || !Number.isSafeInteger(pr.number) || typeof pr.url !== 'string'
      || pr.url !== `https://github.com/${preview.repository}/pull/${pr.number}` || pr.headRefName !== preview.branch || pr.baseRefName !== preview.base) throw new Error('GitHub returned unexpected PR evidence');
    if (typeof pr.isCrossRepository !== 'boolean') throw new Error('GitHub head repository evidence is unavailable');
    if (pr.isCrossRepository) continue;
    if (pr.headRefOid === head) found.push(pr);
    else if (pr.state === 'OPEN') throw new Error('An open PR has different head evidence; inspect it before continuing');
  }
  if (found.length > 1) throw new Error('More than one PR matches the preview');
  return found[0] ?? null;
}
export async function createPublicationPr(cwd: string, prior: GitReviewEvidence, input: Record<string, unknown>, cli = gitCli(cwd)): Promise<GitReviewEvidence> {
  cwd = await realpath(cwd);
  const preview = await validatePreview(cwd, prior, cli);
  if (preview.provider !== 'github' || !preview.repository) throw new Error('PR creation requires the GitHub CLI profile');
  if (preview.branch === preview.base || !preview.commits.length) throw new Error('PR preview has no independent head range');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256 || typeof input.body !== 'string' || input.body.length > 64_000
    || input.title.includes('\0') || input.body.includes('\0')) throw new Error('Provide a bounded PR title and body');
  const head = prior.baseline!.head!; const fields = { preview, commit: head };
  let attempted = false;
  try {
    if (await remoteOid(cli, preview.url, preview.branch) !== head) throw new Error('Push the exact previewed head before PR creation');
    const existing = await findPullRequest(cli, preview, head);
    if (existing) return evidence('create-pr', 'reconciled', cwd, prior.baseline, { ...fields, pullRequest: existing.url, message: `Existing ${existing.state.toLowerCase()} PR matches this preview; no PR was created.` });
    if (await remoteOid(cli, preview.url, preview.base) !== preview.baseOid) throw new Error('Remote base changed; refresh the preview');
    await validatePreview(cwd, prior, cli);
    attempted = true;
    await cli('gh', ['pr', 'create', '--repo', `github.com/${preview.repository}`, '--head', `${preview.repository.split('/')[0]}:${preview.branch}`,
      '--base', preview.base, '--title', input.title, '--body-file', '-'], input.body);
    const observed = await findPullRequest(cli, preview, head);
    if (!observed) throw new Error('GitHub has not confirmed the PR result');
    return evidence('create-pr', 'succeeded', cwd, prior.baseline, { ...fields, pullRequest: observed.url, message: 'GitHub query confirms the exact PR head and base.' });
  } catch (error) {
    return evidence('create-pr', attempted ? 'uncertain' : 'rejected', cwd, prior.baseline, { ...fields,
      message: `${(error as Error).message}. Reconcile this exact head/base before another creation attempt.` });
  }
}

export async function executeGitReview(operation: GitReviewEvidence['operation'], cwd: string, input: Record<string, unknown>, prior: GitReviewEvidence | null): Promise<GitReviewEvidence> {
  try {
    switch (operation) {
      case 'capture': return await captureReview(cwd, input.paths);
      case 'preview': return await previewPublication(cwd, input);
      case 'commit': if (prior) return await commitReview(cwd, prior, input.paths, input.message); break;
      case 'push': if (prior) return await pushPublication(cwd, prior); break;
      case 'create-pr': if (prior) return await createPublicationPr(cwd, prior, input); break;
    }
    throw new Error('An immutable evidence reference is required');
  } catch (error) {
    return evidence(operation, 'rejected', cwd, prior?.baseline ?? null, { message: redactSecretLikeContent((error as Error).message) });
  }
}
