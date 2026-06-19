import { expect, test, type Page } from '@playwright/test';
import {
  e2eProjection,
  ids,
  nodeById,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

async function createCodeBlockViaTrailing(page: Page) {
  await trailingEditor(page).click();
  await page.keyboard.type('/code');
  await expect(page.getByRole('option', { name: /Code block/ })).toBeVisible();
  await page.keyboard.press('Enter');
  const rowId = (await todayChildren(page)).at(-1);
  if (!rowId) throw new Error('code block row not created');
  await expect.poll(async () => (await nodeById(page, rowId))?.type ?? null).toBe('codeBlock');
  return rowId;
}

async function todayChildren(page: Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

async function lastTodayChildId(page: Page) {
  return (await todayChildren(page)).at(-1);
}

async function placeCursorAtEnd(page: Page, nodeId: string) {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await editor.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.waitForTimeout(25);
}

test.describe('code block editor', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('/code in trailing input creates a syntax-highlighted code block row', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/code');

    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    await expect(page.getByRole('option', { name: /Code block/ })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const rowId = await lastTodayChildId(page);
    expect(rowId).toBeTruthy();
    await expect.poll(async () => (await nodeById(page, rowId!))?.type ?? null).toBe('codeBlock');

    const textarea = row(page, rowId!).locator('.code-block-textarea');
    await expect(textarea).toBeVisible();
    await expect(row(page, rowId!).locator('.code-block-highlight .shiki')).toHaveCount(1);

    await textarea.click();
    await page.keyboard.type('const x = 1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('const y = 2');

    await expect
      .poll(async () => (await nodeById(page, rowId!))?.content.text)
      .toBe('const x = 1\nconst y = 2');
    // Enter inserts a code newline instead of splitting into a sibling row.
    expect(await todayChildren(page)).toHaveLength(beforeChildren.length + 1);
  });

  test('in-row /code conversion picks a language and Cmd+Enter exits to a new row', async ({ page }) => {
    await placeCursorAtEnd(page, ids.gamma);
    await page.keyboard.press('Enter');

    const codeRowId = await lastTodayChildId(page);
    expect(codeRowId).toBeTruthy();
    await expect(rowEditor(page, codeRowId!)).toBeFocused();

    await page.keyboard.type('/code');
    await expect(page.getByRole('option', { name: /Code block/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await nodeById(page, codeRowId!))?.type ?? null).toBe('codeBlock');

    await row(page, codeRowId!).locator('.code-block-language').click();
    await page.getByRole('menuitemradio', { name: 'Python', exact: true }).click();
    await expect.poll(async () => (await nodeById(page, codeRowId!))?.codeLanguage ?? null).toBe('python');

    const childrenBeforeExit = await todayChildren(page);
    const textarea = row(page, codeRowId!).locator('.code-block-textarea');
    await textarea.click();
    await page.keyboard.type('print(1)');
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(childrenBeforeExit.length + 1);
    const newRowId = await lastTodayChildId(page);
    expect(newRowId).not.toBe(codeRowId);
    await expect.poll(async () => (await nodeById(page, newRowId!))?.type ?? null).toBe(null);
    await expect(rowEditor(page, newRowId!)).toBeFocused();
    await expect.poll(async () => (await nodeById(page, codeRowId!))?.content.text).toBe('print(1)');
  });

  test('typing ``` in an empty row converts it into a code block', async ({ page }) => {
    await placeCursorAtEnd(page, ids.gamma);
    await page.keyboard.press('Enter');

    const codeRowId = await lastTodayChildId(page);
    expect(codeRowId).toBeTruthy();
    await expect(rowEditor(page, codeRowId!)).toBeFocused();

    await page.keyboard.type('```');
    await expect.poll(async () => (await nodeById(page, codeRowId!))?.type ?? null).toBe('codeBlock');
    // The fence text is dropped; the new code block starts empty.
    await expect.poll(async () => (await nodeById(page, codeRowId!))?.content.text).toBe('');

    const textarea = row(page, codeRowId!).locator('.code-block-textarea');
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeFocused();
  });

  test('long lines scroll horizontally instead of wrapping', async ({ page }) => {
    const rowId = await createCodeBlockViaTrailing(page);
    const textarea = row(page, rowId).locator('.code-block-textarea');
    await textarea.click();
    await page.keyboard.type(`const value = "${'x'.repeat(220)}";`);

    const metrics = await textarea.evaluate((element) => {
      const ta = element as HTMLTextAreaElement;
      const block = ta.closest('.code-block');
      const sizer = block?.querySelector<HTMLElement>('.code-block-sizer');
      const textareaRect = ta.getBoundingClientRect();
      const blockRect = block?.getBoundingClientRect();
      return {
        bottomInset: blockRect ? blockRect.bottom - textareaRect.bottom : Number.POSITIVE_INFINITY,
        insetLeft: blockRect ? textareaRect.left - blockRect.left : 0,
        lines: ta.value.split('\n').length,
        scrollbarGutter: sizer ? Number.parseFloat(getComputedStyle(sizer).paddingBottom) : 0,
        scrollWidth: ta.scrollWidth,
        clientWidth: ta.clientWidth,
        whiteSpace: getComputedStyle(ta).whiteSpace,
      };
    });
    expect(metrics.bottomInset).toBeLessThanOrEqual(4);
    expect(metrics.insetLeft).toBeGreaterThanOrEqual(8);
    expect(metrics.lines).toBe(1);
    expect(metrics.scrollbarGutter).toBeGreaterThanOrEqual(7);
    expect(metrics.whiteSpace).toBe('pre');
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  });

  test('tall code blocks cap height and scroll internally', async ({ page }) => {
    const rowId = await createCodeBlockViaTrailing(page);
    const textarea = row(page, rowId).locator('.code-block-textarea');
    await textarea.click();
    await textarea.fill(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'));

    const metrics = await textarea.evaluate((element) => {
      const ta = element as HTMLTextAreaElement;
      const editor = ta.closest<HTMLElement>('.code-block-editor');
      const highlight = editor?.querySelector<HTMLElement>('.code-block-highlight');
      if (!editor || !highlight) return null;
      ta.scrollTop = ta.scrollHeight;
      ta.dispatchEvent(new Event('scroll', { bubbles: true }));
      const editorStyle = getComputedStyle(editor);
      const textareaStyle = getComputedStyle(ta);
      const parsedMaxHeight = Number.parseFloat(editorStyle.maxHeight);
      const highlightRect = highlight.getBoundingClientRect();
      const textareaRect = ta.getBoundingClientRect();
      return {
        editorHeight: Math.round(editor.getBoundingClientRect().height),
        highlightSynced: Math.abs(highlight.scrollTop - ta.scrollTop) <= 1,
        viewportBottomAligned: Math.abs(highlightRect.bottom - textareaRect.bottom) <= 1,
        viewportHeightAligned: Math.abs(highlightRect.height - textareaRect.height) <= 1,
        maxHeight: Number.isFinite(parsedMaxHeight) ? Math.round(parsedMaxHeight) : 420,
        textareaScrolls: ta.scrollHeight > ta.clientHeight,
        textareaOverflowY: textareaStyle.overflowY,
      };
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.editorHeight).toBeLessThanOrEqual(metrics!.maxHeight + 1);
    expect(metrics!.editorHeight).toBeGreaterThan(240);
    expect(metrics!.highlightSynced).toBe(true);
    expect(metrics!.viewportBottomAligned).toBe(true);
    expect(metrics!.viewportHeightAligned).toBe(true);
    expect(metrics!.textareaScrolls).toBe(true);
    expect(metrics!.textareaOverflowY).toBe('auto');
  });

  test('Shift+Arrow exits a code block into a cross-row block selection', async ({ page }) => {
    const codeRowId = await createCodeBlockViaTrailing(page);
    const textarea = row(page, codeRowId).locator('.code-block-textarea');
    await textarea.click();
    await page.keyboard.type('value = 1');

    // First Shift+ArrowUp leaves the block and selects the code row.
    await page.keyboard.press('Shift+ArrowUp');
    await expect(rowBody(page, codeRowId)).toHaveClass(/selected/);
    await expect(textarea).not.toBeFocused();

    // The next Shift+ArrowUp extends the block selection into the row above.
    await page.keyboard.press('Shift+ArrowUp');
    await expect(rowBody(page, codeRowId)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });
});
