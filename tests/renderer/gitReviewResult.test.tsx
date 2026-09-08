import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { GitReviewResult, parseGitReviewOutput } from '../../src/renderer/agent/components/items/GitReviewResult';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function output(extra = {}) {
  return { gitReview: { version: 1, operation: 'capture', outcome: 'reviewed', cwd: '/repo', observedAt: 1,
    baseline: { root: '/repo', gitDirectory: '/repo/.git', commonDirectory: '/repo/.git', identity: 'd'.repeat(64), head: 'a'.repeat(40), ref: 'refs/heads/feature' },
    paths: [{ path: 'new.txt', status: '??', kind: 'file', bytes: 3, binary: false, diff: 'new', previousPath: null }],
    preview: null, commit: null, parent: null, pullRequest: null, message: 'Review only.', truncatedPaths: 0,
    review: { id: 'a'.repeat(64), schemaVersion: 1, byteLength: 100, kind: 'gitReviewEvidence', mimeType: 'application/vnd.tenon.agent-context+json' }, ...extra } };
}
function mount(value: ReturnType<typeof output>) {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const saved = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let copied = '';
  for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true, navigator: { clipboard: { writeText: async (text: string) => { copied = text; } } } })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  const review = parseGitReviewOutput(`git-review ${value.gitReview.operation} --input - --output json`, JSON.stringify(value));
  expect(review).not.toBeNull(); act(() => root.render(<GitReviewResult review={review!} />));
  cleanups.push(() => { act(() => root.unmount()); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; } });
  return { document, window, copied: () => copied };
}
test('saved review starts with no selected files and cannot commit by rendering', () => {
  const { document, copied } = mount(output());
  const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(checkbox.checked).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('.button')?.disabled).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input[type=text]')?.getAttribute('aria-label')).toBe('Commit message');
  expect(copied()).toBe(''); expect(document.body.textContent).toContain('new.txt');
});
test('publication preview exposes exact remote, upstream, head/base and commit range', () => {
  const { document } = mount(output({ operation: 'preview', outcome: 'previewed', paths: [], preview: {
    remote: 'origin', url: 'https://github.com/example/repo.git', branch: 'feature', upstream: 'origin/feature', remoteHead: null,
    commits: ['a'.repeat(40)], base: 'main', baseOid: 'b'.repeat(40), provider: 'github', repository: 'example/repo',
  } }));
  expect(document.body.textContent).toContain('https://github.com/example/repo.git'); expect(document.body.textContent).toContain('feature → main');
  expect(document.body.textContent).toContain('origin/feature'); expect(document.body.textContent).toContain(`${'b'.repeat(40)}..${'a'.repeat(40)}`);
  expect(document.querySelector('button')).toBeNull();
});
test('non-Git results expose review with no commit controls', () => {
  const { document } = mount(output({ baseline: null }));
  expect(document.body.textContent).toContain('File review only'); expect(document.querySelector('input')).toBeNull();
});
test('ordinary Bash and malformed output do not enter the review renderer', () => {
  expect(parseGitReviewOutput('echo test', JSON.stringify(output()))).toBeNull();
  expect(parseGitReviewOutput('git-review capture --input - --output json', '{')).toBeNull();
  expect(parseGitReviewOutput('git-review capture --input - --output json', JSON.stringify({ stdout: JSON.stringify(output()) }))).not.toBeNull();
});
