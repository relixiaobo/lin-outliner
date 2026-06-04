import { expect, test, type Page } from '@playwright/test';
import { e2eProjection, ids, nodeById, openMockedApp, row, rowEditor } from './outlinerMock';

async function todayChildren(page: Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

// Sibling / child rows materialize through the same async paste command as the
// merged row, but each is read via a separate projection round-trip — so every
// read of them must poll until they land. A single un-polled read races the
// materialization under a loaded test file (the cause of the earlier flake).
async function siblingNodeAfter(page: Page, nodeId: string, offset = 1) {
  const children = await todayChildren(page);
  const index = children.indexOf(nodeId);
  const id = index >= 0 ? children[index + offset] : undefined;
  return id ? await nodeById(page, id) : undefined;
}

async function siblingTextsAfter(page: Page, nodeId: string, count: number) {
  const texts: Array<string | undefined> = [];
  for (let offset = 1; offset <= count; offset += 1) {
    texts.push((await siblingNodeAfter(page, nodeId, offset))?.content.text);
  }
  return texts;
}

async function childNodesOf(page: Page, parentId: string) {
  const parent = await nodeById(page, parentId);
  return Promise.all((parent?.children ?? []).map((cid) => nodeById(page, cid)));
}

async function selectEditorContents(page: Page, nodeId: string) {
  // Triple-click selects the whole row through ProseMirror's own mouse handling,
  // which updates the editor selection synchronously (a dispatched transaction).
  // A programmatic DOM Range does not: its sync into the editor lags, and under
  // cold-start load a paste then lands at the stale click caret and inserts into
  // the middle of the row instead of replacing it (the source of the flake).
  await rowEditor(page, nodeId).click({ clickCount: 3 });
}

async function pasteRich(page: Page, payload: { plain: string; html?: string }) {
  await page.evaluate(({ plain, html }) => {
    const data = new DataTransfer();
    data.setData('text/plain', plain);
    if (html) data.setData('text/html', html);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, payload);
}

test.describe('paste format support', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('parses inline markdown marks across pasted rows', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    await pasteRich(page, { plain: '**bold** and *italic*\n~~gone~~ then [site](https://example.com)' });

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('bold and italic');
    const alpha = await nodeById(page, ids.alpha);
    expect(alpha?.content.marks).toEqual([
      { start: 0, end: 4, type: 'bold' },
      { start: 9, end: 15, type: 'italic' },
    ]);

    await expect.poll(async () => (await siblingNodeAfter(page, ids.alpha))?.content.text).toBe('gone then site');
    const sibling = await siblingNodeAfter(page, ids.alpha);
    expect(sibling?.content.marks).toEqual([
      { start: 0, end: 4, type: 'strike' },
      { start: 10, end: 14, type: 'link', attrs: { href: 'https://example.com' } },
    ]);
  });

  test('turns a pasted fenced block into a code block row', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    await pasteRich(page, { plain: 'intro\n```ts\nconst x = 1\nconst y = 2\n```' });

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('intro');
    await expect.poll(async () => (await siblingNodeAfter(page, ids.alpha))?.type ?? null).toBe('codeBlock');
    const codeNode = await siblingNodeAfter(page, ids.alpha);
    expect(codeNode?.codeLanguage).toBe('typescript');
    expect(codeNode?.content.text).toBe('const x = 1\nconst y = 2');

    const children = await todayChildren(page);
    const codeRowId = children[children.indexOf(ids.alpha) + 1];
    await expect(row(page, codeRowId).locator('.code-block-textarea')).toBeVisible();
  });

  test('routes rich HTML clipboard into structured rows', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    await pasteRich(page, {
      plain: 'Hello world\none\ntwo',
      html: '<p>Hello <strong>world</strong></p><ul><li>one</li><li>two</li></ul>',
    });

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Hello world');
    const alpha = await nodeById(page, ids.alpha);
    expect(alpha?.content.marks).toEqual([{ start: 6, end: 11, type: 'bold' }]);

    await expect.poll(() => siblingTextsAfter(page, ids.alpha, 2)).toEqual(['one', 'two']);
  });

  test('splits a <br>-separated block into one row per line', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    // Gmail / Apple Notes / many contenteditable sources wrap soft line breaks
    // in a single block with <br>s; this must become rows, not one space-joined row.
    await pasteRich(page, {
      plain: 'first\nsecond\nthird',
      html: '<div>first<br>second<br>third</div>',
    });

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('first');
    await expect.poll(() => siblingTextsAfter(page, ids.alpha, 2)).toEqual(['second', 'third']);
  });

  test('prefers a Markdown outline over flat HTML, keeping nesting and checkboxes', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    // The clipboard carries the raw Markdown in text/plain and flat <div>s in
    // text/html (the common editor-copy shape). The <div>s lost the indentation
    // and keep the literal `- `/`[x]` markers, so the text/plain outline must win.
    await pasteRich(page, {
      plain: 'parent\n  - [x] done child\n  - [ ] todo child',
      html: '<div>parent</div><div>- [x] done child</div><div>- [ ] todo child</div>',
    });

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('parent');
    // Markers stripped, hierarchy preserved (nested under the merged row), and
    // the checkboxes carry their checked / unchecked state.
    await expect
      .poll(async () => (await childNodesOf(page, ids.alpha)).map((k) => k?.content.text))
      .toEqual(['done child', 'todo child']);
    const kids = await childNodesOf(page, ids.alpha);
    expect(kids[0]?.completedAt).toBeGreaterThan(0);
    expect(kids[1]?.completedAt).toBe(0);
  });

  test('keeps a rich HTML list with marks even when the plain text is a bullet list', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    // The clipboard carries real <ul><li> structure with a bold mark AND a plain
    // bullet fallback. The HTML is the lossless side, so it must win — without it
    // the bold would be dropped by the Markdown path.
    await pasteRich(page, {
      plain: '- one\n- two',
      html: '<ul><li><strong>one</strong></li><li>two</li></ul>',
    });

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('one');
    const alpha = await nodeById(page, ids.alpha);
    expect(alpha?.content.marks).toEqual([{ start: 0, end: 3, type: 'bold' }]);
    await expect.poll(async () => (await siblingNodeAfter(page, ids.alpha))?.content.text).toBe('two');
  });

  test('merging a task line into a non-empty row does not silently check it', async ({ page }) => {
    // Alpha is a non-empty row (a shown-but-unchecked checkbox, completedAt 0).
    await selectEditorContents(page, ids.alpha);
    await pasteRich(page, { plain: '[x] done\nmore' });

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('done');
    // The row had content, so the pasted `[x]` is NOT imposed — it stays unchecked.
    const alpha = await nodeById(page, ids.alpha);
    expect(alpha?.completedAt).toBe(0);
    await expect.poll(async () => (await siblingNodeAfter(page, ids.alpha))?.content.text).toBe('more');
  });

  test('pasting a single-line URL wraps the selection as a link', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    await pasteRich(page, { plain: 'https://anthropic.com' });

    await expect
      .poll(async () => (await nodeById(page, ids.alpha))?.content.marks.length)
      .toBeGreaterThan(0);
    const alpha = await nodeById(page, ids.alpha);
    expect(alpha?.content.text).toBe('Alpha');
    expect(alpha?.content.marks).toEqual([
      { start: 0, end: 5, type: 'link', attrs: { href: 'https://anthropic.com' } },
    ]);
  });
});
