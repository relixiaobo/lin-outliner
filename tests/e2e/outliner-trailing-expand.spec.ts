import { expect, test } from '@playwright/test';
import {
  e2eProjection,
  emitDocumentEvent,
  ids,
  nodeByText,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

async function delayCreateNode(page: Parameters<typeof trailingEditor>[0], delayMs = 120) {
  await page.evaluate((delay) => {
    const win = window as unknown as {
      lin?: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
    const originalInvoke = win.lin?.invoke;
    if (!win.lin || !originalInvoke) return;
    win.lin.invoke = async <T,>(cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'create_node' || cmd === 'create_nodes_from_tree') {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
      return originalInvoke<T>(cmd, args);
    };
  }, delayMs);
}

async function nodesWithText(page: Parameters<typeof trailingEditor>[0], text: string) {
  const projection = await e2eProjection(page);
  return projection.nodes.filter((node) => node.content.text === text);
}

async function dispatchCompositionEvent(
  locator: ReturnType<typeof trailingEditor>,
  type: 'compositionstart' | 'compositionend',
  data = '',
) {
  await locator.evaluate((element, eventInit) => {
    const target = element.querySelector('.ProseMirror') ?? element;
    target.dispatchEvent(new CompositionEvent(eventInit.type, {
      bubbles: true,
      cancelable: true,
      data: eventInit.data,
    }));
  }, { data, type });
}

async function clickIndentGuideLine(page: Parameters<typeof trailingEditor>[0], rowId: string) {
  const guide = row(page, rowId).locator('> .indent-guide');
  const box = await guide.boundingBox();
  if (!box) throw new Error(`Missing indent guide for ${rowId}`);
  await page.mouse.click(box.x + box.width - 1, box.y + Math.min(10, box.height / 2));
}

test.describe('outliner trailing input and expansion parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('clicking an expanded row guide toggles direct children expansion', async ({ page }) => {
    await page.evaluate(async ({ alphaId, betaId, gammaId }) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('move_node', { nodeId: betaId, parentId: alphaId, index: null });
      await win.lin?.invoke('move_node', { nodeId: gammaId, parentId: betaId, index: null });
    }, { alphaId: ids.alpha, betaId: ids.beta, gammaId: ids.gamma });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    await row(page, ids.alpha).locator('.row-chevron-button').click({ force: true });
    await expect(row(page, ids.beta)).toBeVisible();
    await expect(row(page, ids.gamma)).toHaveCount(0);

    await clickIndentGuideLine(page, ids.alpha);
    await expect(row(page, ids.gamma)).toBeVisible();

    await clickIndentGuideLine(page, ids.alpha);
    await expect(row(page, ids.gamma)).toHaveCount(0);
  });

  test('typing in the panel trailing input eagerly commits a real node', async ({ page }) => {
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('Delta');

    // Eager materialization: a body trailing draft turns into a real node on the
    // first keystroke (carrying the typed text), and a fresh empty trailing draft
    // replaces it. (Field values stay lazy — they buffer until Enter.)
    await expect.poll(async () => (await nodeByText(page, 'Delta'))?.parentId).toBe(ids.today);
    await expect(trailingEditor(page)).toHaveText('');

    await page.keyboard.press('Enter');

    const projection = await e2eProjection(page);
    const today = projection.nodes.find((node) => node.id === ids.today)!;
    expect(today.children).toHaveLength(5);
    const contentId = today.children.at(-2)!;
    const continuationId = today.children.at(-1)!;
    expect(projection.nodes.find((node) => node.id === contentId)?.content.text).toBe('Delta');
    expect(projection.nodes.find((node) => node.id === continuationId)?.content.text).toBe('');
    await expect(rowEditor(page, continuationId)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).not.toBeFocused();
  });

  test('fast panel trailing typing does not create partial sibling nodes before commit', async ({ page }) => {
    await delayCreateNode(page);
    const text = 'helo';
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type(text, { delay: 0 });

    await expect(editor).toHaveText(text);
    expect(await nodeByText(page, text)).toBeUndefined();

    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodeByText(page, text))?.parentId).toBe(ids.today);
    const projection = await e2eProjection(page);
    const typedFragments = ['h', 'he', 'hel', text, 'e', 'el', 'elo', 'l', 'lo', 'o'];
    const newTextRows = projection.nodes.filter((node) => (
      node.parentId === ids.today
      && typedFragments.includes(node.content.text)
    ));
    expect(newTextRows.map((node) => node.content.text)).toEqual([text]);
  });

  test('blur commits trailing text without stealing focus from the clicked row', async ({ page }) => {
    await delayCreateNode(page);
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('Focus stable');
    await rowEditor(page, ids.alpha).click();

    await expect.poll(async () => (await nodeByText(page, 'Focus stable'))?.parentId).toBe(ids.today);
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
  });

  test('IME committed trailing text stays local until Enter commits it', async ({ page }) => {
    await delayCreateNode(page);
    const editor = trailingEditor(page);
    const text = '中文提交';

    await editor.click();
    await dispatchCompositionEvent(editor, 'compositionstart');
    await page.keyboard.insertText(text);
    await dispatchCompositionEvent(editor, 'compositionend', text);

    await expect(editor).toHaveText(text);
    expect(await nodeByText(page, text)).toBeUndefined();

    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodeByText(page, text))?.parentId).toBe(ids.today);
  });

  test('field value trailing input stays local until Enter commits the value node', async ({ page }) => {
    await delayCreateNode(page);
    const text = '字段中文';

    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const valueEditor = page.locator('[data-field-value] [data-trailing-parent-id] .ProseMirror').first();
    await expect(valueEditor).toBeVisible();
    await valueEditor.click();
    await page.keyboard.insertText(text);

    await expect(valueEditor).toHaveText(text);
    expect(await nodeByText(page, text)).toBeUndefined();

    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodeByText(page, text))?.content.text).toBe(text);
    const projection = await e2eProjection(page);
    const valueNode = projection.nodes.find((node) => node.content.text === text)!;
    const fieldEntry = projection.nodes.find((node) => node.id === valueNode.parentId)!;
    expect(fieldEntry.children).toEqual([valueNode.id]);
  });

  test('BUG1 field value Enter leaves no duplicate value row in the DOM', async ({ page }) => {
    const text = 'zzdupcheck';

    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const valueEditor = page.locator('[data-field-value] [data-trailing-parent-id] .ProseMirror').first();
    await expect(valueEditor).toBeVisible();
    await valueEditor.click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');

    // The value node materialized exactly once in the projection.
    await expect.poll(async () => (await nodesWithText(page, text)).length).toBe(1);

    // ...and the DOM must not show a second editor still carrying the text
    // (the reported "duplicate sibling that vanishes on focus change"). Count
    // BEFORE moving focus away, since that is when the user sees the duplicate.
    const domCount = await page.evaluate((needle) => {
      const editors = Array.from(document.querySelectorAll('[data-field-value] .ProseMirror'));
      return editors.filter((el) => (el.textContent ?? '').trim() === needle).length;
    }, text);
    expect(domCount).toBe(1);

    // The freshly minted trailing draft is empty, not echoing the typed text.
    const trailingText = await page.evaluate(() => {
      const drafts = Array.from(document.querySelectorAll('[data-field-value] [data-trailing-parent-id] .ProseMirror'));
      return drafts.map((el) => (el.textContent ?? '').trim());
    });
    expect(trailingText.every((value) => value === '')).toBe(true);
  });

  test('empty trailing input does not show default placeholder text', async ({ page }) => {
    const editor = page.locator(`[data-trailing-parent-id="${ids.today}"] .row-editor`).first();
    await expect(editor).toHaveClass(/is-empty/);

    await expect.poll(async () => editor.evaluate((element) =>
      getComputedStyle(element, '::before').content,
    )).toBe('""');

    const paragraphPlaceholder = await editor.locator('.ProseMirror p').evaluate((element) =>
      getComputedStyle(element, '::before').content,
    );
    expect(paragraphPlaceholder).toBe('none');
  });

  test('empty Enter in trailing input creates an empty real node in the current scope', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.id === ids.today)?.children.length;
    }).toBe(4);

    const projection = await e2eProjection(page);
    const today = projection.nodes.find((node) => node.id === ids.today)!;
    const createdId = today.children.at(-1)!;
    const created = projection.nodes.find((node) => node.id === createdId)!;
    expect(created.content.text).toBe('');
    // Enter on the trailing draft materializes it (the empty node above) and drops
    // to a fresh trailing line below — focus moves there, not back onto the just
    // committed node. Pressing Enter again keeps committing empty nodes and
    // advancing, matching the "every Enter creates a node and moves down" model.
    await expect(trailingEditor(page)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
  });

  test('Tab and Shift+Tab in an empty trailing input relocate the draft without materializing', async ({ page }) => {
    await trailingEditor(page).click();
    // Relocate (not materialize): Tab moves the empty trailing draft under the
    // previous sibling (gamma) and expands gamma — the cursor stays in the draft,
    // and nothing is created until text is typed.
    await page.keyboard.press('Tab');
    await expect(trailingEditor(page, ids.gamma)).toBeFocused();
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.id === ids.gamma)?.children.length;
    }).toBe(0);

    // The first keystroke materializes the node under the relocated parent.
    await page.keyboard.type('Nested');
    await expect.poll(async () => (await nodeByText(page, 'Nested'))?.parentId).toBe(ids.gamma);
    await expect(page.getByText('Nested')).toBeVisible();
    await expect(row(page, ids.gamma).getByRole('button', { name: 'Collapse' })).toBeVisible();

    // From today's trailing draft, Tab then Shift+Tab nets back to the today level,
    // so the typed node lands under today.
    await trailingEditor(page).click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('topagain');

    await expect.poll(async () => (await nodeByText(page, 'topagain'))?.parentId).toBe(ids.today);
  });

  test('Enter then Tab creates a child from the real empty sibling', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('Fresh parent');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await nodeByText(page, 'Fresh parent'))?.parentId).toBe(ids.today);

    await page.keyboard.press('Tab');
    await page.keyboard.type('Fresh child');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const parent = projection.nodes.find((node) => node.content.text === 'Fresh parent');
      const child = projection.nodes.find((node) => node.content.text === 'Fresh child');
      return Boolean(parent && child && child.parentId === parent.id);
    }).toBe(true);
    const child = await nodeByText(page, 'Fresh child');
    await expect(rowEditor(page, child!.id)).toBeFocused();
  });

  test('Tab with trailing text commits it directly as a child of the last visible node', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('Buffered child');
    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeByText(page, 'Buffered child'))?.parentId).toBe(ids.gamma);
    const child = await nodeByText(page, 'Buffered child');
    await expect(rowEditor(page, child!.id)).toBeFocused();
    await expect(trailingEditor(page, ids.gamma)).toHaveCount(0);
  });

  test('Backspace in an empty trailing input focuses the last visible node above it', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Backspace');

    await expect(rowEditor(page, ids.gamma)).toBeFocused();
  });

  test('expanding a leaf shows its child trailing input and Backspace returns to the leaf', async ({ page }) => {
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();

    await expect(trailingEditor(page, ids.gamma)).toBeFocused();

    await page.keyboard.press('Backspace');

    await expect(rowEditor(page, ids.gamma)).toBeFocused();
    await expect(trailingEditor(page, ids.gamma)).toHaveCount(0);
  });

  test('typing in an empty child trailing input stays local until Enter creates real child nodes', async ({ page }) => {
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();

    const childTrailing = trailingEditor(page, ids.gamma);
    await expect(childTrailing).toBeFocused();
    await page.keyboard.type('Leaf child');

    // Eager: the child trailing draft commits to a real child of gamma on the
    // first keystroke; a fresh empty child trailing draft replaces it.
    await expect.poll(async () => (await nodeByText(page, 'Leaf child'))?.parentId).toBe(ids.gamma);

    await page.keyboard.press('Enter');

    const projection = await e2eProjection(page);
    const gamma = projection.nodes.find((node) => node.id === ids.gamma)!;
    expect(gamma.children).toHaveLength(2);
    const leaf = projection.nodes.find((node) => node.content.text === 'Leaf child')!;
    const continuation = projection.nodes.find((node) => node.id === gamma.children.at(-1))!;
    expect(continuation.content.text).toBe('');
    expect(continuation.id).not.toBe(leaf.id);
    await expect(rowEditor(page, continuation.id)).toBeFocused();
  });

  test('switching between trailing inputs commits each editor once without replaying partial text', async ({ page }) => {
    await delayCreateNode(page, 160);
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();
    await expect(trailingEditor(page, ids.gamma)).toBeFocused();

    const firstText = 'xqvrapidtext';
    const secondText = 'childrapidtext';

    await trailingEditor(page).click();
    await page.keyboard.type(firstText, { delay: 0 });
    await expect(trailingEditor(page)).toHaveText(firstText);

    await trailingEditor(page, ids.gamma).click();
    await page.keyboard.type(secondText, { delay: 0 });
    await expect(trailingEditor(page, ids.gamma)).toHaveText(secondText);

    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodeByText(page, firstText))?.parentId).toBe(ids.today);
    await expect.poll(async () => (await nodeByText(page, secondText))?.parentId).toBe(ids.gamma);
    expect(await nodesWithText(page, firstText)).toHaveLength(1);
    expect(await nodesWithText(page, secondText)).toHaveLength(1);
  });
});
