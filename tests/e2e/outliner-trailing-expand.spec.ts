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

async function delayCreateAndUpdate(page: Parameters<typeof trailingEditor>[0], delayMs = 80) {
  await page.evaluate((delay) => {
    const win = window as unknown as {
      lin?: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
    const originalInvoke = win.lin?.invoke;
    if (!win.lin || !originalInvoke) return;
    win.lin.invoke = async <T,>(cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'create_node' || cmd === 'create_nodes_from_tree' || cmd === 'apply_node_text_patch') {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
      return originalInvoke<T>(cmd, args);
    };
  }, delayMs);
}

async function watchTrailingFocus(page: Parameters<typeof trailingEditor>[0], parentId = ids.today) {
  await page.evaluate((targetParentId) => {
    const win = window as unknown as {
      __linTrailingRefocusSeen?: boolean;
      __linTrailingRefocusCleanup?: () => void;
    };
    win.__linTrailingRefocusSeen = false;
    win.__linTrailingRefocusCleanup?.();
    const activeElement = document.activeElement;
    const handler = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const trailing = target.closest(`[data-trailing-parent-id="${targetParentId}"]`);
      if (trailing && target !== activeElement) win.__linTrailingRefocusSeen = true;
    };
    document.addEventListener('focusin', handler, true);
    win.__linTrailingRefocusCleanup = () => document.removeEventListener('focusin', handler, true);
  }, parentId);
}

async function expectNoTrailingRefocus(page: Parameters<typeof trailingEditor>[0]) {
  expect(await page.evaluate(() => {
    const win = window as unknown as {
      __linTrailingRefocusSeen?: boolean;
      __linTrailingRefocusCleanup?: () => void;
    };
    win.__linTrailingRefocusCleanup?.();
    win.__linTrailingRefocusCleanup = undefined;
    return Boolean(win.__linTrailingRefocusSeen);
  })).toBe(false);
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

async function nodesWithText(page: Parameters<typeof trailingEditor>[0], text: string) {
  const projection = await e2eProjection(page);
  return projection.nodes.filter((node) => node.content.text === text);
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

  test('typing in the panel trailing input materializes a real node and keeps the panel trailing input', async ({ page }) => {
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('Delta');

    await expect.poll(async () => (await nodeByText(page, 'Delta'))?.parentId).toBe(ids.today);
    const created = await nodeByText(page, 'Delta');
    expect(created?.id).toBeTruthy();
    await expect(rowEditor(page, created!.id)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).not.toBeFocused();

    await page.keyboard.press('Enter');

    const projection = await e2eProjection(page);
    const today = projection.nodes.find((node) => node.id === ids.today)!;
    expect(today.children).toHaveLength(5);
    const continuationId = today.children.at(-1)!;
    const continuation = projection.nodes.find((node) => node.id === continuationId)!;
    expect(continuation.content.text).toBe('');
    await expect(rowEditor(page, continuationId)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
  });

  test('plain trailing input materializes from the first key without rendering transient text', async ({ page }) => {
    await delayCreateNode(page);
    const text = 'Pending visual';
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type(text);

    await expect(editor).toHaveText('');

    await expect.poll(async () => (await nodeByText(page, text))?.parentId).toBe(ids.today);
    const created = await nodeByText(page, text);
    expect(created?.id).toBeTruthy();
    await expect(rowEditor(page, created!.id)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).not.toBeFocused();
  });

  test('fast typing in the panel trailing input stays on one materialized node', async ({ page }) => {
    await delayCreateAndUpdate(page);
    const text = 'helo';
    const editor = trailingEditor(page);
    await editor.click();
    await watchTrailingFocus(page);
    await page.keyboard.type(text, { delay: 0 });

    await expect.poll(async () => (await nodeByText(page, text))?.parentId).toBe(ids.today);
    const created = await nodeByText(page, text);
    expect(created?.id).toBeTruthy();
    const projection = await e2eProjection(page);
    const typedTexts = ['h', 'he', 'hel', text, 'e', 'el', 'elo', 'l', 'lo', 'o'];
    const typedFragments = projection.nodes.filter((node) => (
      typedTexts.includes(node.content.text)
    ));
    expect(typedFragments.map((node) => node.content.text)).toEqual([text]);
    expect(created!.children).toEqual([]);
    await expect(rowEditor(page, created!.id)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).not.toBeFocused();
    await expectNoTrailingRefocus(page);
  });

  test('duplicate trailing input text materializes into a second real node', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('Repeat');
    await expect.poll(async () => (await nodesWithText(page, 'Repeat')).length).toBe(1);

    await delayCreateNode(page);
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('Repeat');
    await expect(editor).toHaveText('');

    await expect.poll(async () => (await nodesWithText(page, 'Repeat')).length).toBe(2);
    const repeated = await nodesWithText(page, 'Repeat');
    await expect(rowEditor(page, repeated.at(-1)!.id)).toBeFocused();
  });

  test('blur during trailing materialization does not steal focus back from the clicked row', async ({ page }) => {
    await delayCreateNode(page);
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('Focus stable');
    await rowEditor(page, ids.alpha).click();

    await expect.poll(async () => (await nodeByText(page, 'Focus stable'))?.parentId).toBe(ids.today);
    const created = await nodeByText(page, 'Focus stable');
    expect(created?.id).toBeTruthy();
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
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

    await expect.poll(async () => (await nodeByText(page, text))?.parentId).toBe(ids.today);
    await expectNoTextGap(page);
  });

  test('IME committed text materializes and Enter on the created row creates a real empty continuation', async ({ page }) => {
    const editor = trailingEditor(page);
    const text = '中文真实行';

    await editor.click();
    await dispatchCompositionEvent(editor, 'compositionstart');
    await page.keyboard.insertText(text);
    await dispatchCompositionEvent(editor, 'compositionend', text);

    await expect.poll(async () => (await nodeByText(page, text))?.parentId).toBe(ids.today);
    const created = await nodeByText(page, text);
    expect(created?.id).toBeTruthy();
    await expect(rowEditor(page, created!.id)).toBeFocused();
    await page.keyboard.press('Enter');

    const projection = await e2eProjection(page);
    const today = projection.nodes.find((node) => node.id === ids.today)!;
    expect(today.children).toHaveLength(5);
    const continuationId = today.children.at(-1)!;
    await expect(rowEditor(page, continuationId)).toBeFocused();
  });

  test('field value text stays visible while immediate materialization is pending', async ({ page }) => {
    await delayCreateNode(page);
    const text = '字段中文';

    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const valueEditor = page.locator('[data-field-value] .trailing-editor .ProseMirror').first();
    await expect(valueEditor).toBeVisible();
    await valueEditor.click();
    await page.keyboard.insertText(text);
    await expect(valueEditor).toHaveText(text);

    await expect(valueEditor).toHaveText(text);
    await expect.poll(async () => (await nodeByText(page, text))?.content.text).toBe(text);
    const projection = await e2eProjection(page);
    const valueNode = projection.nodes.find((node) => node.content.text === text)!;
    const fieldEntry = projection.nodes.find((node) => node.id === valueNode.parentId)!;
    expect(fieldEntry.children).toEqual([valueNode.id]);
  });

  test('IME committed field value materializes without Enter', async ({ page }) => {
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
    await expect(trailingEditor(page)).toBeVisible();
  });

  test('Tab and Shift+Tab in trailing input choose the parent for the next node without collapsing state', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Tab');
    await page.keyboard.type('Nested');

    await expect.poll(async () => (await nodeByText(page, 'Nested'))?.parentId).toBe(ids.gamma);
    const nested = await nodeByText(page, 'Nested');
    expect(nested?.id).toBeTruthy();
    await expect(rowEditor(page, nested!.id)).toBeFocused();
    await expect(page.getByText('Nested')).toBeVisible();
    await expect(row(page, ids.gamma).getByRole('button', { name: 'Collapse' })).toBeVisible();

    await trailingEditor(page).click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('topagain');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const full = projection.nodes.find((node) => node.content.text === 'topagain');
      return full?.parentId === ids.today;
    }).toBe(true);
    const topAgain = await nodeByText(page, 'topagain');
    expect(topAgain?.id).toBeTruthy();
    await expect(rowEditor(page, topAgain!.id)).toBeFocused();
  });

  test('Enter then Tab after trailing materialization creates a child from the real empty sibling', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('Fresh parent');
    await expect.poll(async () => (await nodeByText(page, 'Fresh parent'))?.parentId).toBe(ids.today);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Fresh child');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const parent = projection.nodes.find((node) => node.content.text === 'Fresh parent');
      const child = projection.nodes.find((node) => node.content.text === 'Fresh child');
      return Boolean(parent && child && child.parentId === parent.id);
    }).toBe(true);
    const child = await nodeByText(page, 'Fresh child');
    expect(child?.id).toBeTruthy();
    await expect(rowEditor(page, child!.id)).toBeFocused();
  });

  test('Tab with trailing text commits it directly as a child node', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('你好');
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodesWithText(page, '你好')).length).toBe(1);
    const parentId = (await nodesWithText(page, '你好'))[0]!.id;

    await page.keyboard.type('你好');
    await page.keyboard.press('Tab');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const parent = projection.nodes.find((node) => node.id === parentId);
      const child = projection.nodes.find((node) => (
        node.parentId === parentId
        && node.content.text === '你好'
      ));
      return Boolean(parent && child);
    }).toBe(true);

    const parent = (await e2eProjection(page)).nodes.find((node) => node.id === parentId)!;
    const childId = parent.children[0]!;
    await expect(rowEditor(page, childId)).toBeFocused();
    await expect(page.locator(`[data-trailing-parent-id="${parentId}"] .ProseMirror:focus`)).toHaveCount(0);
  });

  test('Tab while trailing input is materializing indents the created real node', async ({ page }) => {
    await delayCreateNode(page);
    await trailingEditor(page).click();
    await page.keyboard.type('Buffered child');
    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeByText(page, 'Buffered child'))?.parentId).toBe(ids.gamma);
    const child = await nodeByText(page, 'Buffered child');
    expect(child?.id).toBeTruthy();
    await expect(rowEditor(page, child!.id)).toBeFocused();
    await expect(trailingEditor(page, ids.gamma)).toHaveCount(0);
  });

  test('Backspace in an empty trailing input focuses the last visible node above it', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Backspace');

    await expect(rowEditor(page, ids.gamma)).toBeFocused();
  });

  test('expanding a leaf with the chevron shows its empty child trailing input', async ({ page }) => {
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();

    await expect(trailingEditor(page, ids.gamma)).toBeFocused();

    await page.keyboard.press('Backspace');

    await expect(rowEditor(page, ids.gamma)).toBeFocused();
    await expect(trailingEditor(page, ids.gamma)).toHaveCount(0);
  });

  test('typing in an empty child trailing input materializes the first real child without adding another child trailing input', async ({ page }) => {
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();

    await expect(trailingEditor(page, ids.gamma)).toBeFocused();
    await page.keyboard.type('Leaf child');

    await expect.poll(async () => (await nodeByText(page, 'Leaf child'))?.parentId).toBe(ids.gamma);
    const child = await nodeByText(page, 'Leaf child');
    expect(child?.id).toBeTruthy();
    await expect(rowEditor(page, child!.id)).toBeFocused();
    await expect(trailingEditor(page, ids.gamma)).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();
  });
});
