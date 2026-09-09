import { useState } from 'react';
import { decodeGitReviewEvidence, gitReviewOperation, type GitReviewEvidence, type GitReviewPath } from '../../../../core/agent/gitReview';
import type { ThreadContextPayloadReference } from '../../../../core/agent/protocol';
import { useT } from '../../../i18n/I18nProvider';
import { CheckboxControl } from '../../../ui/primitives/CheckboxControl';
import { Button } from '../../../ui/primitives/Button';
import { Input } from '../../../ui/primitives/Input';
import { ReadOnlyCodeBlock } from '../../../ui/editor/CodeBlockSurface';

type ReviewOutput = Omit<GitReviewEvidence, 'paths'> & {
  readonly paths: readonly Pick<GitReviewPath, 'path' | 'status' | 'kind' | 'bytes' | 'binary' | 'diff' | 'previousPath'>[];
  readonly review: ThreadContextPayloadReference;
  readonly truncatedPaths: number;
};
export function parseGitReviewOutput(command: string, output: string | null): ReviewOutput | null {
  if (!gitReviewOperation(command) || !output || output.length > 64_000) return null;
  try {
    // Saved Bash outputs may be an envelope; the immediate projection is stdout.
    const parsed = JSON.parse(output);
    const data = parsed.gitReview ? parsed : JSON.parse(parsed.data?.stdout ?? parsed.stdout ?? 'null');
    const review = data?.gitReview as ReviewOutput | undefined;
    if (!review || review.operation !== gitReviewOperation(command) || !Array.isArray(review.paths) || review.paths.length > 64
      || !review.review || review.review.kind !== 'gitReviewEvidence' || !/^[a-f0-9]{64}$/u.test(review.review.id)
      || typeof review.cwd !== 'string' || typeof review.message !== 'string') return null;
    if (review.paths.some((entry) => !entry || typeof entry.path !== 'string' || typeof entry.diff !== 'string'
      || typeof entry.status !== 'string' || typeof entry.bytes !== 'number')) return null;
    decodeGitReviewEvidence({ version: review.version, operation: review.operation, outcome: review.outcome,
      cwd: review.cwd, observedAt: review.observedAt, baseline: review.baseline, preview: review.preview,
      commit: review.commit, parent: review.parent, pullRequest: review.pullRequest, message: review.message,
      paths: review.paths.map((entry) => ({ ...entry, canonicalPath: `${review.cwd}/${entry.path}`, mode: 0,
        index: '', digest: '0'.repeat(64), diffDigest: '0'.repeat(64) })) });
    if (!Number.isSafeInteger(review.truncatedPaths) || review.truncatedPaths < 0) return null;
    return review;
  } catch { return null; }
}

/** Historical evidence is inert. Copying a request keeps the composer as the intent boundary. */
export function GitReviewResult({ review }: { readonly review: ReviewOutput }) {
  const t = useT().gitReview;
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const selectable = review.operation === 'capture' && review.outcome === 'reviewed' && review.baseline !== null;
  const renameIncomplete = selected.some((name) => {
    const previous = review.paths.find((entry) => entry.path === name)?.previousPath;
    return previous && !selected.includes(previous);
  });
  const copy = async () => {
    const request = `Commit only the following reviewed files in ${JSON.stringify(review.cwd)}. Use the git-review Skill with this exact immutable review reference and revalidate before committing.\n${JSON.stringify({ review: review.review, paths: selected, message: message.trim() }, null, 2)}`;
    try { await navigator.clipboard.writeText(request); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  };
  return <section className="thread-git-review" aria-label={t.title}>
    <p>{t.historical}</p>
    <p><code>{review.cwd}</code></p>
    {review.baseline ? <p><code>{review.baseline.ref ?? t.detached}</code> · <code>{review.baseline.head ?? t.unborn}</code></p> : <p>{t.nonGit}</p>}
    {review.paths.length ? <ul className="thread-file-changes">
      {review.paths.map((entry) => <li key={entry.path}>
        {selectable ? <CheckboxControl className="thread-git-review-choice" checked={selected.includes(entry.path)} disabled={entry.kind === 'directory'}
          onCheckedChange={(checked) => { setSelected((current) => checked ? [...current, entry.path] : current.filter((name) => name !== entry.path)); setCopyState('idle'); }}>
          <code>{entry.path}</code>
        </CheckboxControl> : <code>{entry.path}</code>}
        <span>{entry.status} · {entry.binary ? t.binary : entry.kind} · {entry.bytes} B</span>
        {entry.diff ? <details><summary>{t.diff}</summary><ReadOnlyCodeBlock code={entry.diff} language="diff" /></details> : null}
      </li>)}
    </ul> : null}
    {review.truncatedPaths > 0 ? <p>{t.omitted({ count: review.truncatedPaths })}</p> : null}
    {selectable ? <>
      <label className="thread-git-review-message">{t.message}<Input label={t.message} value={message} onChange={(event) => { setMessage(event.target.value); setCopyState('idle'); }} /></label>
      {renameIncomplete ? <p>{t.rename}</p> : null}
      <Button size="sm" disabled={!selected.length || !message.trim() || renameIncomplete} onClick={() => void copy()}>{t.copy}</Button>
      <span role="status">{copyState === 'copied' ? t.copied : copyState === 'failed' ? t.copyFailed : ''}</span>
    </> : null}
    {review.preview ? <dl>
      <dt>{t.remote}</dt><dd>{review.preview.remote} · <code>{review.preview.url}</code></dd>
      <dt>{t.upstream}</dt><dd>{review.preview.upstream ?? t.none}</dd>
      <dt>{t.branches}</dt><dd>{review.preview.branch} → {review.preview.base}</dd>
      <dt>{t.provider}</dt><dd>{review.preview.provider}</dd>
      <dt>{t.range}</dt><dd><code>{review.preview.baseOid}..{review.baseline?.head}</code> ({review.preview.commits.length})</dd>
      <dt>{t.commits}</dt><dd>{review.preview.commits.map((oid) => <div key={oid}><code>{oid}</code></div>)}</dd>
    </dl> : null}
    <p>{review.message}</p>
    {review.commit ? <p><code>{review.commit}</code></p> : null}
    {review.pullRequest ? <p><a href={review.pullRequest}>{review.pullRequest}</a></p> : null}
  </section>;
}
