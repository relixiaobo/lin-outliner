import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeGitReviewEvidence, GIT_REVIEW_MAX_BYTES } from '../../src/core/agent/gitReview';
import { captureReview } from '../../src/main/agent/gitReview/gitReviewGit';
import { prepareGitReviewProcess, prepareGitReviewStdin, type GitReviewRuntime } from '../../src/main/agent/gitReview/GitReviewRuntime';

test('the helper consumes a near-limit manifest and large Unicode input, but rejects altered stdin before mutation', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'tenon-git-transport-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('config', 'commit.gpgSign', 'false');
    await writeFile(path.join(cwd, 'selected.txt'), 'reviewed');
    const captured = await captureReview(cwd);
    // A valid evidence resource may devote almost its entire budget to another
    // path's excerpt. Transport must not depend on display truncation or selection.
    const padding = { ...captured.paths[0]!, path: 'padding.txt', canonicalPath: path.join(cwd, 'padding.txt'), diff: '' };
    const candidate = { ...captured, paths: [...captured.paths, padding] };
    padding.diff = 'x'.repeat(GIT_REVIEW_MAX_BYTES - Buffer.byteLength(JSON.stringify(candidate)));
    const prior = decodeGitReviewEvidence(candidate);
    expect(Buffer.byteLength(JSON.stringify(prior))).toBe(GIT_REVIEW_MAX_BYTES);
    // Limits apply to UTF-8 bytes, not JavaScript code units.
    expect(() => decodeGitReviewEvidence({ ...candidate, message: `${candidate.message}é` })).toThrow('Invalid Git review evidence');
    const review = { id: createHash('sha256').update(JSON.stringify(prior)).digest('hex'), kind: 'gitReviewEvidence',
      mimeType: 'application/vnd.tenon.agent-context+json', schemaVersion: 1, byteLength: GIT_REVIEW_MAX_BYTES };
    const runtime: GitReviewRuntime = { read: async () => prior, persist: async () => { throw new Error('Unused'); } };
    const command = 'git-review commit --input - --output json';
    const stdin = await prepareGitReviewStdin(command, JSON.stringify({ review, paths: ['selected.txt'], message: '✓'.repeat(16_000) }), runtime);
    const prepared = await prepareGitReviewProcess({ taskId: 'fixture', nonce: 'fixture', cwd, command, stdin, env: process.env });
    expect(Buffer.byteLength(stdin)).toBeGreaterThan(GIT_REVIEW_MAX_BYTES);
    expect(prepared.privateControlInput!.byteLength).toBeLessThan(1024);
    if (prepared.process.kind !== 'exec') throw new Error('Expected direct helper');
    const spec = prepared.process;
    const run = (bytes: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(spec.executable, [...spec.args], { cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout!.on('data', (chunk) => { stdout += chunk; }); child.stderr!.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin!.on('error', () => {}); child.stdin!.end(bytes);
      (child.stdio[3] as NodeJS.WritableStream).end(prepared.privateControlInput);
    });
    const tampered = await run(stdin.replace('reviewed', 'tampered'));
    expect(tampered.code).toBe(1); expect(tampered.stdout).toBe('');
    expect(git('log', '--oneline', '--all')).toBe('');
    const result = await run(stdin);
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout).outcome).toBe('succeeded');
    expect(git('show', 'HEAD:selected.txt')).toBe('reviewed');
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 30_000);
