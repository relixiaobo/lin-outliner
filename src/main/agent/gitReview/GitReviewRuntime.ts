/// <reference types="electron-vite/node" />
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { GitReviewEvidence } from '../../../core/agent/gitReview';
import { decodeGitReviewEvidence, GIT_REVIEW_MAX_BYTES, gitReviewOperation } from '../../../core/agent/gitReview';
import type { ThreadContextPayloadReference } from '../../../core/agent/protocol';
import { decodeThreadContextPayloadReference } from '../../../core/agent/codec';
import type { ToolTaskRecord } from '../tasks/toolTaskTypes';
import type { PreparedToolTaskProcess, ToolTaskProcessPreparationContext, ToolTaskService } from '../tasks/ToolTaskService';

export interface GitReviewRuntime {
  read(ref: ThreadContextPayloadReference): Promise<GitReviewEvidence>;
  persist(evidence: GitReviewEvidence, task: ToolTaskRecord, priorRef: ThreadContextPayloadReference | null): Promise<ThreadContextPayloadReference>;
}
export function parseGitReviewInput(command: string, stdin: string | undefined): { input: Record<string, unknown>; priorRef: ThreadContextPayloadReference | null } {
  const operation = gitReviewOperation(command);
  if (!operation || stdin === undefined || Buffer.byteLength(stdin) > 128_000) throw new Error('Git review requires bounded literal JSON stdin');
  const input: unknown = JSON.parse(stdin);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Git review stdin must be an object');
  const record = input as Record<string, unknown>;
  const keys = operation === 'capture' ? ['paths'] : operation === 'commit' ? ['review', 'paths', 'message']
    : operation === 'preview' ? ['remote', 'base'] : operation === 'push' ? ['review'] : ['review', 'title', 'body'];
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error('Unexpected Git review input field');
  const priorRef = record.review === undefined ? null : decodeThreadContextPayloadReference(record.review);
  if (priorRef && priorRef.kind !== 'gitReviewEvidence') throw new Error('Expected a Git review evidence reference');
  if (['commit', 'push', 'create-pr'].includes(operation) && !priorRef) throw new Error('Git operation requires its immutable review reference');
  return { input: record, priorRef };
}
/** Historical evidence is data: use the Task's bounded, file-backed stdin. */
export async function prepareGitReviewStdin(command: string, stdin: string | undefined, runtime: GitReviewRuntime): Promise<string> {
  const parsed = parseGitReviewInput(command, stdin);
  const prior = parsed.priorRef ? decodeGitReviewEvidence(await runtime.read(parsed.priorRef)) : null;
  return JSON.stringify({ input: parsed.input, prior });
}
export async function prepareGitReviewProcess(input: ToolTaskProcessPreparationContext & {
  command: string; env: NodeJS.ProcessEnv;
}): Promise<PreparedToolTaskProcess> {
  const bytes = Buffer.from(input.stdin);
  if (bytes.length > GIT_REVIEW_MAX_BYTES + 128_064) throw new Error('Prepared Git review input exceeds its bound');
  const entry = process.versions.bun ? path.join(import.meta.dirname, 'gitReviewWorker.ts')
    : (await import('./gitReviewWorker?modulePath')).default;
  return { process: { kind: 'exec', executable: process.execPath, args: [entry],
    env: { ...input.env, ELECTRON_RUN_AS_NODE: '1' }, privateControl: true },
    // Only this Host-created binding crosses the 64 KiB private channel. The
    // worker verifies the complete stdin before inspecting Git or mutating it.
    privateControlInput: Buffer.from(JSON.stringify({ command: input.command, cwd: input.cwd,
      stdinBytes: bytes.length, stdinSha256: createHash('sha256').update(bytes).digest('hex') })) };
}
export async function collectGitReviewResult(service: ToolTaskService, runtime: GitReviewRuntime, task: ToolTaskRecord, command: string, stdin: string | undefined): Promise<string> {
  const output = await service.output(task.taskId, task.ownerThreadId, GIT_REVIEW_MAX_BYTES);
  if (!output || output.stdoutTruncated || output.stderrTruncated) throw new Error(`Git review evidence is incomplete for Task ${task.taskId}; reconcile before retrying`);
  let evidence: GitReviewEvidence;
  try { evidence = decodeGitReviewEvidence(JSON.parse(output.stdout)); }
  catch { throw new Error(`Git review Task ${task.taskId} has no complete result (${task.state}); inspect Git and reconcile before retrying`); }
  if (evidence.operation !== gitReviewOperation(command) || evidence.cwd !== task.cwd) throw new Error('Git review evidence does not match its admitted Task');
  if (!['succeeded', 'failed'].includes(task.state) || (['reviewed', 'previewed', 'succeeded', 'reconciled'].includes(evidence.outcome) && task.state !== 'succeeded')) {
    throw new Error('Git review process has no successful settlement; reconcile before retrying');
  }
  const { priorRef } = parseGitReviewInput(command, stdin);
  const ref = await runtime.persist(evidence, task, priorRef);
  // The manifest lives in a context resource. Never repeat index/blob manifests in model input.
  const paths: Array<Omit<GitReviewEvidence['paths'][number], 'index' | 'diffDigest' | 'digest' | 'mode' | 'canonicalPath'>> = [];
  let budget = 12_000;
  for (const { index: _index, diffDigest: _diffDigest, digest: _digest, mode: _mode, canonicalPath: _canonicalPath, ...entry } of evidence.paths) {
    const bounded = { ...entry, diff: entry.diff.slice(0, 512) };
    const size = JSON.stringify(bounded).length;
    if (paths.length >= 64 || size > budget) break;
    paths.push(bounded); budget -= size;
  }
  return JSON.stringify({ gitReview: { ...evidence, paths, truncatedPaths: evidence.paths.length - paths.length,
    review: ref, taskId: task.taskId, contextRef: task.executionContext.snapshotRef, addressRef: task.executionContext.addressRef } });
}
