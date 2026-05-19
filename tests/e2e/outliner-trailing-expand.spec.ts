import { expect, test } from '@playwright/test';
import {
  e2eProjection,
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

async function watchTextGap(page: Parameters<typeof trailingEditor>[0], text: string) {
  await page.evaluate((expectedText) => {
    const win = window as unknown as {
      __linTextGapSeen?: boolean;
      __linTextGapActive?: boolean;
    };
    win.__linTextGapSeen = false;
    win.__linTextGapActive = true;
    const target = document.querySelector('.main-panel');
    if (!target) throw new Error('Missing main panel');
    const tick = () => {
      if (!win.__linTextGapActive) return;
      if (!target.textContent?.includes(expectedText)) win.__linTextGapSeen = true;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, text);
}

async function expectNoTextGap(page: Parameters<typeof trailingEditor>[0]) {
  expect(await page.evaluate(() => {
    const win = window as unknown as {
      __linTextGapSeen?: boolean;
      __linTextGapActive?: boolean;
    };
    win.__linTextGapActive = false;
    return Boolean(win.__linTextGapSeen);
  })).toBe(false);
}

async function dispatchCompositionEvent(locator: ReturnType<typeof trailingEditor>, type: 'compositionstart' | 'compositionend', data = '') {
  await locator.evaluate((element, eventInit) => {
    const target = element.querySelector('.ProseMirror') ?? element;
    target.dispatchEvent(new CompositionEvent(eventInit.type, {
      bubbles: true,
      cancelable: true,
      data: eventInit.data,
    }));
  }, { data, type });
}

test.describe('outliner trailing input and expansion parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('plain typing stays in trailing input until Enter commits it', async ({ page }) => {
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('Delta');

    await expect(editor).toHaveText('Delta');
    expect(await nodeByText(page, 'Delta')).toBeUndefined();
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodeByText(page, 'Delta'))?.parentId).toBe(ids.today);
    await expect(editor).toBeFocused();

    const projection = await e2eProjection(page);
    const today = projection.nodes.find((node) => node.id === ids.today)!;
    expect(today.children).toHaveLength(4);
  });

  test('blur-committed trailing text keeps the next trailing input stable when the row is focused again', async ({ page }) => {
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('Focus stable');
    await rowEditor(page, ids.alpha).click();

    await expect.poll(async () => (await nodeByText(page, 'Focus stable'))?.parentId).toBe(ids.today);
    const created = await nodeByText(page, 'Focus stable');
    expect(created?.id).toBeTruthy();
    await expect(trailingEditor(page)).toBeVisible();

    await rowEditor(page, created!.id).click();

    await expect(rowEditor(page, created!.id)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
  });

  test('IME committed text stays visible while trailing commit is pending', async ({ page }) => {
    await delayCreateNode(page);
    const editor = trailingEditor(page);
    const text = '中文提交';

    await editor.click();
    await page.keyboard.insertText(text);
    await expect(editor).toHaveText(text);
    await watchTextGap(page, text);

    await page.keyboard.press('Enter');
    await expect(editor).toHaveText(text);
    await expect.poll(async () => (await nodeByText(page, text))?.parentId).toBe(ids.today);
    await expectNoTextGap(page);
  });

  test('IME committed text stays in trailing input until Enter commits it', async ({ page }) => {
    const editor = trailingEditor(page);
    const text = '中文真实行';

    await editor.click();
    await dispatchCompositionEvent(editor, 'compositionstart');
    await page.keyboard.insertText(text);
    await dispatchCompositionEvent(editor, 'compositionend', text);

    await expect(editor).toHaveText(text);
    expect(await nodeByText(page, text)).toBeUndefined();
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodeByText(page, text))?.parentId).toBe(ids.today);
    await expect(editor).toBeFocused();
    const projection = await e2eProjection(page);
    const today = projection.nodes.find((node) => node.id === ids.today)!;
    expect(today.children).toHaveLength(4);
  });

  test('IME committed text stays visible while empty field value commit is pending', async ({ page }) => {
    await delayCreateNode(page);
    const text = '字段中文';

    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const valueEditor = page.locator('[data-field-value] .trailing-editor .ProseMirror').first();
    await expect(valueEditor).toBeVisible();
    await valueEditor.click();
    await page.keyboard.insertText(text);
    await expect(valueEditor).toHaveText(text);

    await page.keyboard.press('Enter');
    await expect(valueEditor).toHaveText(text);
    await expect.poll(async () => (await nodeByText(page, text))?.content.text).toBe(text);
    const projection = await e2eProjection(page);
    const valueNode = projection.nodes.find((node) => node.content.text === text)!;
    const fieldEntry = projection.nodes.find((node) => node.id === valueNode.parentId)!;
    expect(fieldEntry.children).toEqual([valueNode.id]);
  });

  test('IME committed field value stays in trailing input until Enter commits it', async ({ page }) => {
    const text = '字段真实值';

    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const valueEditor = page.locator('[data-field-value] .trailing-editor').first();
    await expect(valueEditor).toBeVisible();
    await valueEditor.click();
    await dispatchCompositionEvent(valueEditor, 'compositionstart');
    await page.keyboard.insertText(text);
    await watchTextGap(page, text);
    await dispatchCompositionEvent(valueEditor, 'compositionend', text);

    await expect(valueEditor).toHaveText(text);
    expect(await nodeByText(page, text)).toBeUndefined();
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodeByText(page, text))?.content.text).toBe(text);
    await expectNoTextGap(page);
    const projection = await e2eProjection(page);
    const valueNode = projection.nodes.find((node) => node.content.text === text)!;
    const fieldEntry = projection.nodes.find((node) => node.id === valueNode.parentId)!;
    expect(fieldEntry.children).toEqual([valueNode.id]);
  });

  test('empty trailing input does not show default placeholder text', async ({ page }) => {
    const editor = page.locator(`[data-trailing-parent-id="${ids.today}"] .trailing-editor`).first();
    await expect(editor).toHaveClass(/is-empty/);

    await expect.poll(async () => editor.evaluate((element) =>
      getComputedStyle(element, '::before').content,
    )).toBe('""');

    const paragraphPlaceholder = await editor.locator('.ProseMirror p').evaluate((element) =>
      getComputedStyle(element, '::before').content,
    );
    expect(paragraphPlaceholder).toBe('none');
  });

  test('empty Enter in trailing input creates an empty node in the current scope', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const today = projection.nodes.find((node) => node.id === ids.today);
      return today?.children.length;
    }).toBe(4);

    const projection = await e2eProjection(page);
    const today = projection.nodes.find((node) => node.id === ids.today)!;
    const createdId = today.children.at(-1)!;
    const created = projection.nodes.find((node) => node.id === createdId)!;
    expect(created.content.text).toBe('');
    await expect(rowEditor(page, createdId)).toBeFocused();
  });

  test('Tab and Shift+Tab in trailing input choose the parent for the next node without collapsing state', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Tab');
    await page.keyboard.type('Nested');

    await expect(page.locator('.trailing-editor .ProseMirror:focus')).toHaveText('Nested');
    expect(await nodeByText(page, 'Nested')).toBeUndefined();
    await page.locator('.main-panel').first().click({ position: { x: 120, y: 520 } });
    await expect.poll(async () => (await nodeByText(page, 'Nested'))?.parentId).toBe(ids.gamma);
    await expect(page.getByText('Nested')).toBeVisible();
    await expect.poll(async () => (await nodeByText(page, 'Nested'))?.parentId).toBe(ids.gamma);
    await expect(row(page, ids.gamma).getByRole('button', { name: 'Collapse' })).toBeVisible();
    await expect(page.getByText('Nested')).toBeVisible();

    await trailingEditor(page).click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('topagain');

    await expect(trailingEditor(page)).toHaveText('topagain');
    await page.locator('.main-panel').first().click({ position: { x: 120, y: 520 } });
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const full = projection.nodes.find((node) => node.content.text === 'topagain');
      return full?.parentId === ids.today;
    }).toBe(true);
  });

  test('Backspace in an empty trailing input focuses the last visible node above it', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Backspace');

    await expect(rowEditor(page, ids.gamma)).toBeFocused();
  });

  test('expanding a leaf with the chevron focuses its child trailing input and Backspace collapses back to the leaf', async ({ page }) => {
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();

    await expect(trailingEditor(page, ids.gamma)).toBeFocused();

    await page.keyboard.press('Backspace');

    await expect(rowEditor(page, ids.gamma)).toBeFocused();
    await expect(trailingEditor(page, ids.gamma)).toHaveCount(0);
  });
});
