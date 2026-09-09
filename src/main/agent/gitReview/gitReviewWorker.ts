import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { executeGitReview } from './gitReviewGit';
import { decodeGitReviewEvidence, GIT_REVIEW_MAX_BYTES, gitReviewOperation } from '../../../core/agent/gitReview';

async function readBounded(stream: AsyncIterable<Buffer>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Git review input exceeds its bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function main(): Promise<void> {
  const [controlBytes, stdin] = await Promise.all([
    readBounded(createReadStream('', { fd: 3, autoClose: true }), 65_536),
    readBounded(process.stdin, GIT_REVIEW_MAX_BYTES + 128_064),
  ]);
  const control = JSON.parse(controlBytes.toString('utf8'));
  if (stdin.length !== control.stdinBytes || createHash('sha256').update(stdin).digest('hex') !== control.stdinSha256) throw new Error('Git review input does not match its Host binding');
  const request = JSON.parse(stdin.toString('utf8'));
  const operation = gitReviewOperation(control.command);
  if (!operation || typeof control.cwd !== 'string' || !request.input || typeof request.input !== 'object') throw new Error('Invalid prepared Git review command');
  const prior = request.prior === null ? null : decodeGitReviewEvidence(request.prior);
  const result = await executeGitReview(operation, control.cwd, request.input, prior);
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
