import { expect, test, type Page } from '@playwright/test';
import { e2eProjection, ids, nodeById, openMockedApp, row, rowEditor } from './outlinerMock';

async function todayChildren(page: Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

async function selectEditorContents(page: Page, nodeId: string) {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await editor.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.waitForTimeout(25);
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
  await page.waitForTimeout(25);
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

    const children = await todayChildren(page);
    const siblingId = children[children.indexOf(ids.alpha) + 1];
    const sibling = await nodeById(page, siblingId);
    expect(sibling?.content.text).toBe('gone then site');
    expect(sibling?.content.marks).toEqual([
      { start: 0, end: 4, type: 'strike' },
      { start: 10, end: 14, type: 'link', attrs: { href: 'https://example.com' } },
    ]);
  });

  test('turns a pasted fenced block into a code block row', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    await pasteRich(page, { plain: 'intro\n```ts\nconst x = 1\nconst y = 2\n```' });

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('intro');
    const children = await todayChildren(page);
    const codeRowId = children[children.indexOf(ids.alpha) + 1];

    await expect.poll(async () => (await nodeById(page, codeRowId))?.type ?? null).toBe('codeBlock');
    const codeNode = await nodeById(page, codeRowId);
    expect(codeNode?.codeLanguage).toBe('typescript');
    expect(codeNode?.content.text).toBe('const x = 1\nconst y = 2');
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

    const children = await todayChildren(page);
    const idx = children.indexOf(ids.alpha);
    expect((await nodeById(page, children[idx + 1]))?.content.text).toBe('one');
    expect((await nodeById(page, children[idx + 2]))?.content.text).toBe('two');
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
    const children = await todayChildren(page);
    const idx = children.indexOf(ids.alpha);
    expect((await nodeById(page, children[idx + 1]))?.content.text).toBe('second');
    expect((await nodeById(page, children[idx + 2]))?.content.text).toBe('third');
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
