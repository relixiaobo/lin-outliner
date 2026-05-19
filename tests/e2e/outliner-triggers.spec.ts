import { expect, test } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  ids,
  openMockedApp,
  row,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

async function lastTodayChildId(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children.at(-1);
}

async function todayChildren(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

function priorityValueEditor(page: import('@playwright/test').Page) {
  return row(page, ids.priorityEntry).locator('.field-option-picker-row').first();
}

async function placeCursor(page: import('@playwright/test').Page, nodeId: string, placement: 'start' | 'end') {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await editor.evaluate((element, targetPlacement) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(targetPlacement === 'start');
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, placement);
  await page.waitForTimeout(25);
}

async function activeCaretRect(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) throw new Error('missing selection');
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      top: rect.top,
    };
  });
}

async function expectTriggerPopoverAnchoredToCaret(page: import('@playwright/test').Page, label: string) {
  const listbox = page.getByRole('listbox', { name: label });
  await expect(listbox).toBeVisible();
  await expect(page.locator('body > .trigger-popover')).toHaveCount(1);

  const [popoverBox, caret] = await Promise.all([
    listbox.boundingBox(),
    activeCaretRect(page),
  ]);
  expect(popoverBox).toBeTruthy();
  expect(caret.height).toBeGreaterThan(0);
  expect(Math.abs(popoverBox!.x - caret.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(popoverBox!.y - (caret.bottom + 6))).toBeLessThanOrEqual(2);
}

async function invokeMockCommand(page: import('@playwright/test').Page, cmd: string, args: Record<string, unknown>) {
  await page.evaluate(async ({ cmd, args }) => {
    const win = window as unknown as {
      lin?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
    };
    const result = await win.lin?.invoke(cmd, args);
    const projection = result && typeof result === 'object' && 'projection' in result
      ? (result as { projection: unknown }).projection
      : result;
    if (projection) {
      win.__LIN_E2E__?.emitDocumentEvent({
        type: 'projection_changed',
        origin: 'user',
        projection,
        timestamp: Date.now(),
      });
    }
  }, { cmd, args });
}

async function delayMockCommands(
  page: import('@playwright/test').Page,
  delayedCommands: string[],
  delayMs = 160,
) {
  await page.evaluate(({ delayedCommands, delayMs }) => {
    const win = window as unknown as {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    const originalInvoke = win.lin?.invoke;
    if (!win.lin || !originalInvoke) return;
    const delayed = new Set(delayedCommands);
    win.lin.invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => {
      if (delayed.has(cmd)) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
      return originalInvoke<T>(cmd, args);
    };
  }, { delayedCommands, delayMs });
}

test.describe('outliner trigger parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('# in trailing input opens tag selector without creating a temporary row', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('#project');

    const listbox = page.getByRole('listbox', { name: 'Tag suggestions' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('option', { name: 'project' })).toBeVisible();
    expect(await todayChildren(page)).toEqual(beforeChildren);

    const beforeCalls = (await commandCalls(page)).length;
    await page.keyboard.press('Enter');

    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect(row(page, createdRowId!).locator('.tag-badge-label')).toContainText('project');
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
    await expect(page.locator(`[data-trailing-parent-id="${ids.today}"]`)).toBeHidden();
    await page.keyboard.type('Task');
    await expect(rowEditor(page, createdRowId!)).toHaveText('Task');
    await expect(page.locator(`[data-trailing-parent-id="${ids.today}"]`)).toBeVisible();
    expect(await todayChildren(page)).toEqual([...beforeChildren, createdRowId]);
    const calls = (await commandCalls(page)).slice(beforeCalls);
    expect(calls.map((call) => call.cmd)).toContain('create_tagged_node');
    expect(calls.map((call) => call.cmd)).not.toContain('create_node');
    expect(calls.map((call) => call.cmd)).not.toContain('apply_tag');
  });

  test('# in trailing input can create and apply a new tag atomically', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('#brand-new-tag');

    const listbox = page.getByRole('listbox', { name: 'Tag suggestions' });
    await expect(listbox).toBeVisible();
    await expect(page.getByRole('option', { name: 'Create brand-new-tag' })).toBeVisible();

    const beforeCalls = (await commandCalls(page)).length;
    await page.keyboard.press('Enter');

    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect(row(page, createdRowId!).locator('.tag-badge-label')).toContainText('brand-new-tag');
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
    const calls = (await commandCalls(page)).slice(beforeCalls);
    expect(calls.map((call) => call.cmd)).toEqual(['create_tag_and_tagged_node']);
  });

  test('# in trailing input keeps the draft visible until the tagged node materializes', async ({ page }) => {
    await delayMockCommands(page, ['create_tagged_node']);
    const beforeChildren = await todayChildren(page);

    await trailingEditor(page).click();
    await page.keyboard.type('#project');
    await page.keyboard.press('Enter');

    await page.waitForTimeout(40);
    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).toHaveText('#project');
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect(row(page, createdRowId!).locator('.tag-badge-label')).toContainText('project');
  });

  test('@ in trailing input creates the final reference row without a temporary row', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('@Zeta');

    const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('option', { name: /Create "Zeta"/ })).toBeVisible();
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.id === createdRowId)?.type;
    }).toBe('reference');
    await expect(row(page, createdRowId!)).toContainText('Zeta');
  });

  test('@ in trailing input keeps the draft visible until the reference row materializes', async ({ page }) => {
    await delayMockCommands(page, ['add_reference']);
    const beforeChildren = await todayChildren(page);

    await trailingEditor(page).click();
    await page.keyboard.type('@Alpha');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Enter');

    await page.waitForTimeout(40);
    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).toHaveText('@Alpha');
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.id === createdRowId)?.type;
    }).toBe('reference');
    await expect(row(page, createdRowId!)).toContainText('Alpha');
  });

  test('@ inline trigger creates one rich text node and keeps the draft visible while pending', async ({ page }) => {
    await delayMockCommands(page, ['create_rich_text_node']);
    const beforeChildren = await todayChildren(page);
    const beforeCalls = (await commandCalls(page)).length;

    await trailingEditor(page).click();
    await page.keyboard.type('See @Alpha');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Enter');

    await page.waitForTimeout(40);
    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).toHaveText('See @Alpha');
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect(row(page, createdRowId!)).toContainText('See');
    await expect(row(page, createdRowId!)).toContainText('Alpha');
    const calls = (await commandCalls(page)).slice(beforeCalls);
    expect(calls.map((call) => call.cmd)).toContain('create_rich_text_node');
    expect(calls.map((call) => call.cmd)).not.toContain('create_node');
    expect(calls.map((call) => call.cmd)).not.toContain('apply_node_text_patch');
  });

  test('@ in an empty row creates a tree reference and immediately enters inline conversion', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: '',
    });
    const emptyRowId = await lastTodayChildId(page);
    expect(emptyRowId).toBeTruthy();

    await rowEditor(page, emptyRowId!).click();
    await page.keyboard.type('@Zeta');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Meta+Enter');

    let inlineRowId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const zeta = projection.nodes.find((node) => node.content.text === 'Zeta');
      inlineRowId = projection.nodes.find((node) => (
        node.id !== emptyRowId
        && !node.type
        && node.content.inlineRefs.some((ref) => ref.targetNodeId === zeta?.id)
      ))?.id ?? '';
      return inlineRowId;
    }).not.toBe('');
    await expect(rowEditor(page, inlineRowId)).toBeFocused();

    const calls = await commandCalls(page);
    expect(calls.map((call) => call.cmd)).toContain('replace_node_with_reference');
    expect(calls.map((call) => call.cmd)).toContain('convert_reference_to_inline_node');
  });

  test('/ in trailing input opens slash commands without creating a temporary row', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/');

    const listbox = page.getByRole('listbox', { name: 'Slash commands' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('option', { name: /Field/ })).toBeVisible();
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'create_inline_field');
    }).toBe(true);
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  });

  test('/ Reference in trailing input switches to local @ suggestions without a temporary row', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/ref');

    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await page.keyboard.press('Enter');

    const referenceListbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(referenceListbox).toBeVisible();
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await page.keyboard.type('Zeta');
    await expect(page.getByRole('option', { name: /Create "Zeta"/ })).toBeVisible();
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.id === createdRowId)?.type;
    }).toBe('reference');
    await expect(row(page, createdRowId!)).toContainText('Zeta');
  });

  test('@ and # suggestion popovers anchor to the caret inside transformed outliner rows', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.type('@');
    await expectTriggerPopoverAnchoredToCaret(page, 'Reference suggestions');

    await page.keyboard.press('Escape');
    await expect(page.locator('.trigger-popover')).toHaveCount(0);

    await placeCursor(page, ids.beta, 'end');
    await page.keyboard.type('#');
    await expectTriggerPopoverAnchoredToCaret(page, 'Tag suggestions');
  });

  test('suggestion popovers scroll when more candidates exist than visible rows', async ({ page }) => {
    for (let index = 0; index < 18; index += 1) {
      await invokeMockCommand(page, 'create_tag', { name: `topic-${String(index).padStart(2, '0')}` });
    }

    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.type('#');

    const listbox = page.getByRole('listbox', { name: 'Tag suggestions' });
    await expect(listbox).toBeVisible();
    await expect.poll(async () => listbox.evaluate((element) => ({
      clientHeight: element.clientHeight,
      optionCount: element.querySelectorAll('[role="option"]').length,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
    }))).toMatchObject({
      overflowY: 'auto',
    });

    const metrics = await listbox.evaluate((element) => ({
      clientHeight: element.clientHeight,
      optionCount: element.querySelectorAll('[role="option"]').length,
      scrollHeight: element.scrollHeight,
    }));
    expect(metrics.optionCount).toBeGreaterThan(6);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  });

  test('floating text toolbar is portaled and stays anchored to transformed row selections', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Shift+ArrowLeft');

    const toolbar = page.locator('body > .floating-editor-toolbar');
    await expect(toolbar).toBeVisible();

    const [toolbarBox, selectionBox] = await Promise.all([
      toolbar.boundingBox(),
      page.evaluate(() => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) throw new Error('missing selection');
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        return {
          centerX: rect.left + rect.width / 2,
          top: rect.top,
        };
      }),
    ]);

    expect(toolbarBox).toBeTruthy();
    expect(Math.abs((toolbarBox!.x + toolbarBox!.width / 2) - selectionBox.centerX)).toBeLessThanOrEqual(2);
    expect(Math.abs(toolbarBox!.y + toolbarBox!.height + 8 - selectionBox.top)).toBeLessThanOrEqual(2);
  });

  test('> in trailing input directly creates an inline field without leaving a trigger row', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('>');

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'create_inline_field');
    }).toBe(true);
    const fieldId = await lastTodayChildId(page);
    expect(fieldId).toBeTruthy();
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.id === fieldId)?.type;
    }).toBe('fieldEntry');
    expect(await todayChildren(page)).toEqual([...beforeChildren, fieldId]);
    await expect(page.locator('.trigger-popover')).toHaveCount(0);
  });

});

test.describe('outliner option picker parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { optionsField: true });
  });

  test('options field picker exposes listbox state and creates a selected option', async ({ page }) => {
    const valuePreview = row(page, ids.priorityEntry).locator('.field-value-node-preview');
    await priorityValueEditor(page).click();

    const listbox = page.getByRole('listbox', { name: 'Field options' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(listbox.getByRole('option', { name: 'High' })).toBeVisible();

    await page.keyboard.type('Urgent');
    await expect(listbox.getByRole('option', { name: 'Create "Urgent"' })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('listbox', { name: 'Field options' })).toHaveCount(0);
    await expect(valuePreview).toHaveText(/Urgent/);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === ids.priorityEntry);
      const valueNode = projection.nodes.find((node) => node.parentId === ids.priorityEntry);
      const collectedRef = projection.nodes.find((node) => (
        node.parentId === ids.priorityField
        && node.type === 'reference'
        && node.targetId === valueNode?.id
      ));
      return {
        entryChildren: entry?.children.length,
        collected: Boolean(collectedRef),
        value: valueNode?.content.text,
        valueType: valueNode?.type ?? 'content',
      };
    }).toEqual({
      collected: true,
      entryChildren: 1,
      value: 'Urgent',
      valueType: 'content',
    });
  });

  test('options field picker opens when a single value slot exists but is empty', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.priorityEntry,
      index: null,
      text: '',
    });

    const valuePreview = row(page, ids.priorityEntry).locator('.field-value-node-preview');
    await expect(valuePreview).toHaveText(/Select option/);

    await priorityValueEditor(page).click();
    const listbox = page.getByRole('listbox', { name: 'Field options' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'High' })).toBeVisible();

    await listbox.getByRole('option', { name: 'Low' }).click();
    await expect(valuePreview).toHaveText(/Low/);
  });

  test('options field picker reopens on an existing value and can replace or clear it', async ({ page }) => {
    await priorityValueEditor(page).click();
    await page.getByRole('option', { name: 'High' }).click();
    await expect(row(page, ids.priorityEntry).locator('.field-value-node-preview')).toHaveText(/High/);

    await priorityValueEditor(page).click();
    const listbox = page.getByRole('listbox', { name: 'Field options' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'Clear selection' })).toBeVisible();
    await listbox.getByRole('option', { name: 'Low' }).click();
    await expect(row(page, ids.priorityEntry).locator('.field-value-node-preview')).toHaveText(/Low/);

    await priorityValueEditor(page).click();
    await page.getByRole('option', { name: 'Clear selection' }).click();
    await expect(row(page, ids.priorityEntry).locator('.field-value-node-preview')).toHaveText(/Select option/);
  });

  test('clearing a created auto-collected option removes the local value and collected reference', async ({ page }) => {
    await priorityValueEditor(page).click();
    await page.keyboard.type('Temporary');
    await page.keyboard.press('Enter');
    await expect(row(page, ids.priorityEntry).locator('.field-value-node-preview')).toHaveText(/Temporary/);

    await priorityValueEditor(page).click();
    await page.getByRole('option', { name: 'Clear selection' }).click();

    await expect(row(page, ids.priorityEntry).locator('.field-value-node-preview')).toHaveText(/Select option/);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === ids.priorityEntry);
      const collectedTemporary = projection.nodes.filter((node) => (
        node.parentId === ids.priorityField
        && node.type === 'reference'
        && node.content.text === 'Temporary'
      ));
      return {
        entryChildren: entry?.children.length,
        collectedTemporary: collectedTemporary.length,
      };
    }).toEqual({
      entryChildren: 0,
      collectedTemporary: 0,
    });
  });

  test('options picker stays inside a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 620 });
    await page.getByRole('button', { name: 'Close panel' }).nth(1).click();
    await expect(page.locator('.outline-panel-surface')).toHaveCount(1);

    await priorityValueEditor(page).click();

    const listbox = page.getByRole('listbox', { name: 'Field options' });
    await expect(listbox).toBeVisible();

    const box = await listbox.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(972);
  });
});
