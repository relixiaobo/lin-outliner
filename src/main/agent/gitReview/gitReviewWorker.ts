import { createReadStream } from 'node:fs';
import { executeGitReview } from './gitReviewGit';
import { decodeGitReviewEvidence, GIT_REVIEW_MAX_BYTES, gitReviewOperation } from '../../../core/agent/gitReview';

async function main(): Promise<void> {
  process.stdin.resume();
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of createReadStream('', { fd: 3, autoClose: true })) {
    bytes += (chunk as Buffer).length;
    if (bytes > GIT_REVIEW_MAX_BYTES * 2) throw new Error('Git review input exceeds its bound');
    chunks.push(chunk as Buffer);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const operation = gitReviewOperation(request.command);
  if (!operation || typeof request.cwd !== 'string' || !request.input || typeof request.input !== 'object') throw new Error('Invalid prepared Git review command');
  const prior = request.prior === null ? null : decodeGitReviewEvidence(request.prior);
  const result = await executeGitReview(operation, request.cwd, request.input, prior);
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > GIT_REVIEW_MAX_BYTES) throw new Error('Git review output exceeds its bound');
  process.stdout.write(output);
  if (result.outcome === 'uncertain' || result.outcome === 'rejected') process.exitCode = 1;
}
void main().catch(() => {
  // Never persist raw Git/hosting stderr, credentials, or unbounded process errors.
  process.stderr.write('Git review did not produce complete evidence. Inspect the canonical task and reconcile before retrying.\n');
  process.exitCode = 1;
});
