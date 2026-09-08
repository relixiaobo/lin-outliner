import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { VerificationCheckDefinition, VerificationSourceEntry, VerificationSourceManifest, VerificationSourceRoot } from '../../../core/agent/verification';
import { executionDigest, pendingExecutionContext, resolveExecutionAddress } from '../tasks/ExecutionContext';
import { discoverExecutionContext } from '../tasks/ExecutionContextDiscovery';

const run = promisify(execFile);
export class VerificationUnavailable extends Error {}
export interface CaptureLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export async function resolveVerificationChecks(roots: readonly string[]): Promise<VerificationCheckDefinition[]> {
  const checks = new Map<string, VerificationCheckDefinition>();
  for (const root of roots) {
    const address = await resolveExecutionAddress({ defaultCwd: root });
    const observation = await discoverExecutionContext(pendingExecutionContext(address, {
      capability: 'read-only', mutation: false, isolation: 'unsandboxed', writablePaths: [],
    }));
    if (!observation.scopes.every((scope) => scope.complete)) throw new VerificationUnavailable('Project check discovery is incomplete.');
    for (const check of observation.checks) {
      const key = executionDigest([check.source, check.id]);
      checks.set(key, { ...check, key });
    }
  }
  const result = [...checks.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (result.length > 64) throw new VerificationUnavailable('Verification exceeds the 64-check limit.');
  if (new Set(result.map((check) => JSON.stringify([check.scope, check.command]))).size !== result.length) throw new VerificationUnavailable('Declared checks must have distinct command and cwd pairs.');
  if (!result.some((check) => check.required)) throw new VerificationUnavailable('No required checks are configured in .tenon/checks.json.');
  return result;
}

/** Two complete captures establish an observed stable input, never a partial fingerprint. */
export async function captureSourceManifest(
  directories: readonly string[], checks: readonly VerificationCheckDefinition[],
  previous: VerificationSourceManifest | null = null, limits: CaptureLimits = {},
): Promise<VerificationSourceManifest> {
  const startedAt = Date.now();
  const deadline = startedAt + (limits.timeoutMs ?? 5_000);
  const maxEntries = Math.min(20_000, limits.maxEntries ?? 20_000);
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
  let measuredBytes = 0;
  const budget = () => {
    limits.signal?.throwIfAborted();
    if (Date.now() > deadline || measuredBytes > maxBytes) throw new VerificationUnavailable('Source capture budget exhausted. Declare a measured source scope and explicit exclusions.');
  };
  const declaredRoots = [...new Set([
    ...directories, ...checks.map((check) => check.scope),
    ...await Promise.all(checks.flatMap((check) => check.inputs.filter(path.isAbsolute)).map(inputRoot)),
  ])].sort();
  if (declaredRoots.length > 32) throw new VerificationUnavailable('Source capture exceeds the 32-root limit.');
  const definitionDigest = executionDigest(checks);
  const capture = async (): Promise<Pick<VerificationSourceManifest, 'roots' | 'entries'>> => {
    const roots: VerificationSourceRoot[] = [];
    const entries = new Map<string, VerificationSourceEntry>();
    const administrative = new Set<string>();
    for (const directory of declaredRoots) {
      budget();
      const canonical = await realpath(directory);
      if (canonical !== directory || !(await stat(directory)).isDirectory()) throw new VerificationUnavailable(`Source root is unavailable or redirected: ${directory}`);
      const address = await resolveExecutionAddress({ defaultCwd: directory });
      const scope = address.scopes[0]!;
      const identity = await stat(directory, { bigint: true });
      let head: string | null = null, ref: string | null = null, indexDigest: string | null = null;
      if (scope.gitDirectory && scope.worktree) {
        administrative.add(scope.gitDirectory);
        administrative.add(path.join(scope.worktree, '.git'));
        const git = async (args: string[]) => {
          budget();
          return (await run('git', ['-c', 'core.fsmonitor=false', '-C', directory, ...args], {
            timeout: Math.max(1, deadline - Date.now()), maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, signal: limits.signal,
          })).stdout;
        };
        // Distinguish an unborn branch/detached HEAD from arbitrary Git failures.
        ref = await git(['symbolic-ref', '--quiet', 'HEAD']).then((text) => text.trim()).catch((error) => {
          if (error.code === 1) return null;
          throw error;
        });
        head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).then((text) => text.trim()).catch((error) => {
          if (error.code === 1 && ref !== null) return null;
          throw error;
        });
        const indexPath = path.resolve(directory, (await git(['rev-parse', '--git-path', 'index'])).trim());
        const indexStat = await stat(indexPath, { bigint: true }).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        let indexFileDigest: string | null = null;
        if (indexStat) {
          if (!indexStat.isFile() || indexStat.size > BigInt(maxBytes - measuredBytes)) throw new VerificationUnavailable('Git index capture limit exceeded.');
          const handle = await open(indexPath, constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            if (!sameFile(indexStat, await handle.stat({ bigint: true }))) throw new VerificationUnavailable('Git index changed before capture.');
            const digest = createHash('sha256');
            const buffer = Buffer.alloc(256 * 1024);
            let bytes = 0;
            while (true) {
              budget();
              const read = await handle.read(buffer, 0, buffer.length, null);
              if (!read.bytesRead) break;
              bytes += read.bytesRead;
              measuredBytes += read.bytesRead;
              digest.update(buffer.subarray(0, read.bytesRead));
            }
            if (BigInt(bytes) !== indexStat.size || !sameFile(indexStat, await handle.stat({ bigint: true }))
              || !sameFile(indexStat, await stat(indexPath, { bigint: true }))) throw new VerificationUnavailable('Git index changed during capture.');
            indexFileDigest = digest.digest('hex');
          } finally { await handle.close(); }
        }
        // Raw index state includes flags such as assume-unchanged that --stage omits.
        indexDigest = executionDigest({ entries: await git(['ls-files', '--stage', '-z']), indexFileDigest });
      }
      roots.push({ path: directory, identity: `${identity.dev}:${identity.ino}`, worktree: scope.worktree,
        gitDirectory: scope.gitDirectory, head, ref, indexDigest });
    }
    const put = (entry: VerificationSourceEntry) => {
      if (entries.size >= maxEntries) throw new VerificationUnavailable('Source capture entry limit exceeded.');
      entries.set(JSON.stringify([entry.root, entry.path]), entry);
    };
    const applies = (check: VerificationCheckDefinition, file: string) => contains(check.scope, file) || check.inputs.some((pattern) => path.isAbsolute(pattern) && matches(file, pattern));
    const policies = (_root: string) => checks;
    const excluded = (file: string, root: string) => {
      const applicable = policies(root).filter((check) => applies(check, file));
      return applicable.length > 0 && applicable.every((check) => check.exclude.some((pattern) => matches(path.relative(check.scope, file), pattern)));
    };
    const selected = (file: string, root: string) => {
      const applicable = policies(root).filter((check) => applies(check, file));
      return !applicable.length || applicable.some((check) => !check.inputs.length || check.inputs.some((pattern) =>
        path.isAbsolute(pattern) ? matches(file, pattern) : matches(path.relative(check.scope, file), pattern)));
    };
    for (const root of declaredRoots) {
      const visit = async (file: string, relative: string, ancestors: ReadonlySet<string>): Promise<void> => {
        budget();
        if ([...administrative].some((directory) => contains(directory, file)) || excluded(file, root)) return;
        const before = await lstat(file, { bigint: true });
        const kind = before.isSymbolicLink() ? 'symlink' : before.isDirectory() ? 'directory' : before.isFile() ? 'file' : null;
        if (!kind) throw new VerificationUnavailable(`Unsupported source entry: ${file}`);
        const canonical = await realpath(file);
        if ([...administrative].some((directory) => contains(directory, canonical))) {
          if (kind === 'symlink') throw new VerificationUnavailable(`Source symlink targets Git administration: ${file}`);
          return;
        }
        const include = selected(file, root);
        if (kind === 'symlink') {
          if (!declaredRoots.some((directory) => contains(directory, canonical))) throw new VerificationUnavailable(`External symlink input must be declared explicitly: ${file}`);
          const target = await readlink(file);
          if (include) put({ root, path: relative, kind, mode: Number(before.mode & 0o7777n), bytes: Buffer.byteLength(target), digest: executionDigest(target), target: canonical });
        }
        const targetStat = kind === 'symlink' ? await stat(file, { bigint: true }) : before;
        if (targetStat.isDirectory()) {
          if (ancestors.has(canonical)) throw new VerificationUnavailable(`Source symlink cycle: ${file}`);
          if (include && kind !== 'symlink') put({ root, path: relative, kind: 'directory', mode: Number(before.mode & 0o7777n), bytes: 0, digest: null, target: null });
          const children = (await readdir(file)).sort();
          const next = new Set([...ancestors, canonical]);
          for (const child of children) await visit(path.join(file, child), relative === '.' ? child : `${relative}/${child}`, next);
          if (JSON.stringify(children) !== JSON.stringify((await readdir(file)).sort())) throw new VerificationUnavailable(`Source directory changed during capture: ${file}`);
        } else if (targetStat.isFile() && include) {
          const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            const initial = await handle.stat({ bigint: true });
            if (!initial.isFile() || initial.size > BigInt(maxBytes - measuredBytes)) throw new VerificationUnavailable(`Source byte limit exceeded: ${file}`);
            const digest = createHash('sha256');
            const buffer = Buffer.alloc(256 * 1024);
            let bytes = 0;
            while (true) {
              budget();
              const read = await handle.read(buffer, 0, buffer.length, null);
              if (!read.bytesRead) break;
              digest.update(buffer.subarray(0, read.bytesRead));
              bytes += read.bytesRead;
              measuredBytes += read.bytesRead;
            }
            const after = await handle.stat({ bigint: true });
            if (!sameFile(initial, after) || BigInt(bytes) !== initial.size || await realpath(file) !== canonical) throw new VerificationUnavailable(`Source changed during capture: ${file}`);
            put({ root, path: kind === 'symlink' ? `${relative}/@target` : relative, kind: 'file',
              mode: Number(after.mode & 0o7777n), bytes, digest: digest.digest('hex'), target: kind === 'symlink' ? canonical : null });
          } finally { await handle.close(); }
        } else if (!targetStat.isDirectory() && !targetStat.isFile()) throw new VerificationUnavailable(`Unsupported symlink target: ${file}`);
        if (!sameFile(before, await lstat(file, { bigint: true }))) throw new VerificationUnavailable(`Source entry changed during capture: ${file}`);
      };
      await visit(root, '.', new Set());
    }
    for (const entry of previous?.entries ?? []) {
      const key = JSON.stringify([entry.root, entry.path]);
      if (declaredRoots.includes(entry.root) && !entries.has(key)) put({ ...entry, kind: 'missing', bytes: 0, mode: 0, digest: null, target: null });
    }
    return { roots, entries: [...entries.values()].sort((a, b) => JSON.stringify([a.root, a.path]).localeCompare(JSON.stringify([b.root, b.path]))) };
  };
  try {
    const first = await capture();
    const second = await capture();
    budget();
    if (executionDigest(first) !== executionDigest(second)) throw new VerificationUnavailable('Sources changed between capture passes.');
    const limitations = ['Observed local source state; external services and invisible external write-and-restore races are unmeasured.',
      ...checks.map((check) => `Scope for ${check.source}/${check.id}: inputs ${JSON.stringify(check.inputs)}; exclusions ${JSON.stringify(check.exclude)}. Inputs outside this selection are unmeasured.`)];
    return { ...second, definitionDigest, digest: executionDigest({ ...second, definitionDigest }), startedAt, finishedAt: Date.now(), limitations };
  } catch (error) {
    if (limits.signal?.aborted) throw error;
    throw error instanceof VerificationUnavailable ? error : new VerificationUnavailable(`Source evidence unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function changedSourcePaths(before: VerificationSourceManifest, after: VerificationSourceManifest): string[] {
  const old = new Map(before.entries.map((entry) => [JSON.stringify([entry.root, entry.path]), entry]));
  const changed = after.entries.filter((entry) => executionDigest(old.get(JSON.stringify([entry.root, entry.path]))) !== executionDigest(entry));
  return changed.map((entry) => path.join(entry.root, entry.path));
}
function contains(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}/`); }
function matches(relative: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//u, '').replace(/\/$/u, '');
  return normalized === '.' || normalized === '**' || relative === normalized || relative.startsWith(`${normalized}/`)
    || path.matchesGlob(relative, normalized) || (normalized.endsWith('/**') && relative === normalized.slice(0, -3));
}
function sameFile(a: import('node:fs').BigIntStats, b: import('node:fs').BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function inputRoot(input: string): Promise<string> {
  const segments = input.split('/');
  const glob = segments.findIndex((segment) => /[*?\[\]{}()]/u.test(segment));
  const literal = glob < 0 ? input : segments.slice(0, glob).join('/') || '/';
  try {
    return await realpath((await stat(literal)).isDirectory() ? literal : path.dirname(literal));
  } catch {
    throw new VerificationUnavailable(`Declared source input is unavailable: ${input}`);
  }
}
