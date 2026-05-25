import { expect, test, type Locator } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  ids,
  nodeById,
  openMockedApp,
  row,
  rowBody,
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

async function fieldSeparatorOpacity(
  page: import('@playwright/test').Page,
  fieldId: string,
  pseudo: '::before' | '::after',
) {
  return row(page, fieldId).locator(':scope > .row > .outliner-field-grid').evaluate((element, targetPseudo) =>
    getComputedStyle(element, targetPseudo).opacity,
  pseudo);
}

async function fieldSeparatorContent(
  page: import('@playwright/test').Page,
  fieldId: string,
  pseudo: '::before' | '::after',
) {
  return row(page, fieldId).locator(':scope > .row > .outliner-field-grid').evaluate((element, targetPseudo) =>
    getComputedStyle(element, targetPseudo).content,
  pseudo);
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

async function dispatchCompositionEvent(locator: Locator, type: 'compositionstart' | 'compositionend', data = '') {
  await locator.evaluate((element, eventInit) => {
    element.dispatchEvent(new CompositionEvent(eventInit.type, {
      bubbles: true,
      cancelable: true,
      data: eventInit.data,
    }));
  }, { type, data });
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

async function rejectEmptyInlineFieldNames(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const win = window as unknown as {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    const originalInvoke = win.lin?.invoke;
    if (!win.lin || !originalInvoke) return;
    win.lin.invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => {
      if (
        (cmd === 'create_inline_field' || cmd === 'create_inline_field_after_node')
        && !String(args?.name ?? '').trim()
      ) {
        throw new Error("Error invoking remote method 'lin:invoke': CoreError: invalid operation: field name cannot be empty");
      }
      return originalInvoke<T>(cmd, args);
    };
  });
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
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).not.toBeFocused();
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

  test('# trigger in trailing input closes when navigating to Recents', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('#project');
    await expect(page.getByRole('listbox', { name: 'Tag suggestions' })).toBeVisible();

    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();

    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Recents');
    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(trailingEditor(page, ids.recents)).toHaveText('');
  });

  test('@ in trailing input creates a focused reference conversion row', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    const beforeCalls = (await commandCalls(page)).length;
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
    let zetaId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      zetaId = projection.nodes.find((node) => (
        node.id !== createdRowId
        && node.parentId === ids.library
        && node.type !== 'reference'
        && node.content.text === 'Zeta'
      ))?.id ?? '';
      const created = projection.nodes.find((node) => node.id === createdRowId);
      return Boolean(
        zetaId
        && !created?.type
        && created?.content.text === ''
        && created.content.inlineRefs.some((ref) => ref.targetNodeId === zetaId),
      );
    }).toBe(true);
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
    await expect(rowBody(page, createdRowId!)).toHaveClass(/ref-converting/);
    await expect(row(page, createdRowId!).locator('.row-bullet-shape.reference')).toHaveCount(1);

    const conversionInlineRef = row(page, createdRowId!).locator('.inline-ref').first();
    await conversionInlineRef.hover();
    await expect.poll(async () => conversionInlineRef.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        cursor: computed.cursor,
        textDecorationLine: computed.textDecorationLine,
      };
    })).toEqual({
      cursor: 'text',
      textDecorationLine: 'none',
    });

    let calls = (await commandCalls(page)).slice(beforeCalls).map((call) => call.cmd);
    expect(calls).toContain('create_node');
    expect(calls).toContain('add_reference_conversion');
    expect(calls).not.toContain('add_reference');
    expect(calls).not.toContain('convert_reference_to_inline_node');
    expect(calls).not.toContain('create_rich_text_node');

    await page.keyboard.type('!');
    await expect.poll(async () => nodeById(page, createdRowId!)).toMatchObject({
      content: {
        text: '!',
        inlineRefs: [{ offset: 0, targetNodeId: zetaId, displayName: 'Zeta' }],
      },
    });
    await expect(rowEditor(page, createdRowId!)).toBeFocused();

    calls = (await commandCalls(page)).slice(beforeCalls).map((call) => call.cmd);
    expect(calls.filter((cmd) => cmd === 'add_reference_conversion')).toHaveLength(1);
  });

  test('@ reference conversion clicks restore and select like a reference row', async ({ page }) => {
    const beforeCalls = (await commandCalls(page)).length;
    await trailingEditor(page).click();
    await page.keyboard.type('@Zeta');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Meta+Enter');

    let zetaId = '';
    let inlineRowId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      zetaId = projection.nodes.find((node) => (
        node.parentId === ids.library
        && node.type !== 'reference'
        && node.content.text === 'Zeta'
      ))?.id ?? '';
      inlineRowId = projection.nodes.find((node) => (
        !node.type
        && node.content.text === ''
        && node.content.inlineRefs.some((ref) => ref.targetNodeId === zetaId)
      ))?.id ?? '';
      return Boolean(zetaId && inlineRowId);
    }).toBe(true);
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
    await expect(rowBody(page, inlineRowId)).toHaveClass(/ref-converting/);

    await row(page, inlineRowId).locator('.inline-ref').click();

    let restoredReferenceId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      restoredReferenceId = projection.nodes.find((node) => (
        node.type === 'reference'
        && node.targetId === zetaId
        && node.parentId === ids.today
      ))?.id ?? '';
      return Boolean(
        restoredReferenceId
        && !projection.nodes.some((node) => node.id === inlineRowId),
      );
    }).toBe(true);
    await expect(rowBody(page, restoredReferenceId)).toHaveClass(/ref-click-selected/);
    await expect(rowBody(page, restoredReferenceId)).not.toHaveClass(/ref-converting/);
    await expect(rowEditor(page, restoredReferenceId)).not.toBeFocused();
    const calls = (await commandCalls(page)).slice(beforeCalls).map((call) => call.cmd);
    expect(calls).toContain('restore_inline_reference_node_to_reference');
  });

  test('@ in trailing input keeps the draft visible until the conversion row materializes', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'RemoteTarget',
    });
    await delayMockCommands(page, ['add_reference_conversion']);
    const beforeChildren = await todayChildren(page);
    const beforeCalls = (await commandCalls(page)).length;

    await trailingEditor(page).click();
    await page.keyboard.type('@RemoteTarget');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'RemoteTarget', exact: true })).toBeVisible();
    await page.keyboard.press('Enter');

    await page.waitForTimeout(40);
    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();
    await expect(trailingEditor(page)).toHaveText('@RemoteTarget');
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const created = projection.nodes.find((node) => node.id === createdRowId);
      return {
        inlineTargetText: projection.nodes.find((node) => (
          node.id === created?.content.inlineRefs[0]?.targetNodeId
        ))?.content.text ?? '',
        text: created?.content.text ?? null,
        type: created?.type ?? null,
      };
    }).toEqual({ inlineTargetText: 'RemoteTarget', text: '', type: null });
    await expect(rowBody(page, createdRowId!)).toHaveClass(/ref-converting/);
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
    await expect(row(page, createdRowId!)).toContainText('RemoteTarget');

    const calls = (await commandCalls(page)).slice(beforeCalls).map((call) => call.cmd);
    expect(calls).toContain('add_reference_conversion');
    expect(calls).not.toContain('add_reference');
    expect(calls).not.toContain('convert_reference_to_inline_node');
    expect(calls).not.toContain('create_rich_text_node');
  });

  test('@ existing different-parent reference in trailing input can continue as inline text', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'RemoteTarget',
    });
    const targetId = (await e2eProjection(page)).nodes.find((node) => node.content.text === 'RemoteTarget')?.id;
    expect(targetId).toBeTruthy();
    const beforeChildren = await todayChildren(page);

    await trailingEditor(page).click();
    await page.keyboard.type('@RemoteTarget');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type('test');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect.poll(async () => nodeById(page, createdRowId!)).toMatchObject({
      content: {
        text: 'test',
        inlineRefs: [{ offset: 0, targetNodeId: targetId, displayName: 'RemoteTarget' }],
      },
    });
    await expect.poll(async () => (await nodeById(page, createdRowId!))?.type ?? null).toBe(null);
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
  });

  test('@ inline trigger in trailing text commits one rich text row with the inline reference', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    const beforeCalls = (await commandCalls(page)).length;

    await trailingEditor(page).click();
    await page.keyboard.type('See @Alpha');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await page.keyboard.press('Enter');

    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect(row(page, createdRowId!)).toContainText('See');
    await expect(row(page, createdRowId!)).toContainText('Alpha');
    await expect.poll(async () => nodeById(page, createdRowId!)).toMatchObject({
      content: {
        text: 'See ',
        inlineRefs: [{ offset: 4, targetNodeId: ids.alpha, displayName: 'Alpha' }],
      },
    });
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
    const calls = (await commandCalls(page)).slice(beforeCalls);
    expect(calls.map((call) => call.cmd)).toContain('create_rich_text_node');
    expect(calls.map((call) => call.cmd)).not.toContain('create_node');
  });

  test('@ in an empty row creates an inline reference conversion row', async ({ page }) => {
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

    let zetaId = '';
    let inlineRowId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const zeta = projection.nodes.find((node) => (
        node.id !== emptyRowId
        && node.parentId === ids.library
        && node.type !== 'reference'
        && node.content.text === 'Zeta'
      ));
      zetaId = zeta?.id ?? '';
      inlineRowId = projection.nodes.find((node) => (
        node.id !== emptyRowId
        && !node.type
        && node.content.text === ''
        && node.content.inlineRefs.some((ref) => ref.targetNodeId === zetaId)
      ))?.id ?? '';
      return Boolean(zetaId && inlineRowId);
    }).toBe(true);
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
    await expect(rowBody(page, inlineRowId)).toHaveClass(/ref-converting/);
    await expect(row(page, inlineRowId).locator('.row-bullet-shape.reference')).toHaveCount(1);

    let calls = await commandCalls(page);
    expect(calls.map((call) => call.cmd)).toContain('replace_node_with_reference_conversion');
    expect(calls.map((call) => call.cmd)).not.toContain('replace_node_with_reference');
    expect(calls.map((call) => call.cmd)).not.toContain('convert_reference_to_inline_node');
    expect(calls.map((call) => call.cmd)).not.toContain('replace_node_with_inline_reference');

    await page.keyboard.type('!');
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
    await expect(rowBody(page, inlineRowId)).toHaveClass(/ref-converting/);
    await expect(row(page, inlineRowId).locator('.inline-ref')).toHaveCSS('animation-name', 'reference-conversion-pulse');

    await rowEditor(page, ids.beta).click();
    await expect.poll(async () => {
      const node = await nodeById(page, inlineRowId);
      return node?.content;
    }).toMatchObject({
      text: '!',
      inlineRefs: [{ offset: 0, targetNodeId: zetaId, displayName: 'Zeta' }],
    });

    calls = await commandCalls(page);
    expect(calls.map((call) => call.cmd)).toContain('replace_node_with_reference_conversion');
    expect(calls.map((call) => call.cmd)).not.toContain('replace_node_with_reference');
    expect(calls.map((call) => call.cmd)).not.toContain('convert_reference_to_inline_node');
    expect(calls.map((call) => call.cmd)).not.toContain('replace_node_with_inline_reference');
  });

  test('@ reference conversion restores the reference node when continued text is deleted', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'RemoteTarget',
    });
    const targetId = (await e2eProjection(page)).nodes.find((node) => node.content.text === 'RemoteTarget')?.id;
    expect(targetId).toBeTruthy();
    const beforeCalls = (await commandCalls(page)).length;

    await trailingEditor(page).click();
    await page.keyboard.type('@RemoteTarget');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'RemoteTarget', exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type('!');

    let inlineRowId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      inlineRowId = projection.nodes.find((node) => (
        !node.type
        && node.content.text === '!'
        && node.content.inlineRefs.some((ref) => ref.targetNodeId === targetId)
      ))?.id ?? '';
      return inlineRowId;
    }).not.toBe('');
    await expect(rowEditor(page, inlineRowId)).toBeFocused();

    await page.keyboard.press('Backspace');
    await expect.poll(async () => nodeById(page, inlineRowId)).toMatchObject({
      content: {
        text: '',
        inlineRefs: [{ offset: 0, targetNodeId: targetId, displayName: 'RemoteTarget' }],
      },
    });
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
    await expect(rowBody(page, inlineRowId)).toHaveClass(/ref-converting/);

    await rowEditor(page, ids.beta).click();

    let restoredReferenceId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      restoredReferenceId = projection.nodes.find((node) => (
        node.type === 'reference'
        && node.targetId === targetId
        && node.parentId === ids.today
      ))?.id ?? '';
      return Boolean(
        restoredReferenceId
        && !projection.nodes.some((node) => node.id === inlineRowId),
      );
    }).toBe(true);
    await expect(rowBody(page, restoredReferenceId)).toHaveClass(/reference-row/);
    await expect(rowBody(page, restoredReferenceId)).not.toHaveClass(/ref-converting/);
    await expect(rowEditor(page, restoredReferenceId)).not.toBeFocused();

    const calls = (await commandCalls(page)).slice(beforeCalls).map((call) => call.cmd);
    expect(calls).toContain('add_reference_conversion');
    expect(calls).not.toContain('add_reference');
    expect(calls).not.toContain('convert_reference_to_inline_node');
    expect(calls).not.toContain('create_rich_text_node');
    expect(calls).toContain('restore_inline_reference_node_to_reference');
    expect(calls.filter((cmd) => cmd === 'restore_inline_reference_node_to_reference')).toHaveLength(1);
  });

  test('@ existing different-parent reference keeps continued typing on the inline conversion row', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'RemoteTarget',
    });
    const projectionWithTarget = await e2eProjection(page);
    const targetId = projectionWithTarget.nodes.find((node) => node.content.text === 'RemoteTarget')?.id;
    expect(targetId).toBeTruthy();
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: '',
    });
    const emptyRowId = await lastTodayChildId(page);
    expect(emptyRowId).toBeTruthy();

    await rowEditor(page, emptyRowId!).click();
    await page.keyboard.type('@RemoteTarget');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type('test');

    let inlineRowId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      inlineRowId = projection.nodes.find((node) => (
        node.id !== emptyRowId
        && !node.type
        && node.content.inlineRefs.some((ref) => ref.targetNodeId === targetId)
      ))?.id ?? '';
      return inlineRowId;
    }).not.toBe('');
    await expect.poll(async () => nodeById(page, inlineRowId)).toMatchObject({
      content: {
        text: 'test',
        inlineRefs: [{ offset: 0, targetNodeId: targetId, displayName: 'RemoteTarget' }],
      },
    });
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
  });

  test('@ existing different-parent reference focuses a real inline editor for IME continuation', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'RemoteTarget',
    });
    const projectionWithTarget = await e2eProjection(page);
    const targetId = projectionWithTarget.nodes.find((node) => node.content.text === 'RemoteTarget')?.id;
    expect(targetId).toBeTruthy();
    await delayMockCommands(page, ['add_reference_conversion'], 220);

    await trailingEditor(page).click();
    await page.keyboard.type('@RemoteTarget');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Enter');

    let inlineRowId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      inlineRowId = projection.nodes.find((node) => (
        !node.type
        && node.content.inlineRefs.some((ref) => ref.targetNodeId === targetId)
      ))?.id ?? '';
      return inlineRowId;
    }).not.toBe('');
    await expect(rowEditor(page, inlineRowId)).toBeFocused();

    const editor = rowEditor(page, inlineRowId);
    const patchCountBeforeComposition = (await commandCalls(page))
      .filter((call) => call.cmd === 'apply_node_text_patch').length;
    await dispatchCompositionEvent(editor, 'compositionstart');
    await page.keyboard.insertText('嗯么');
    await expect.poll(async () => (await commandCalls(page))
      .filter((call) => call.cmd === 'apply_node_text_patch').length).toBe(patchCountBeforeComposition);
    await dispatchCompositionEvent(editor, 'compositionend', '嗯么');

    await expect.poll(async () => nodeById(page, inlineRowId)).toMatchObject({
      content: {
        text: '嗯么',
        inlineRefs: [{ offset: 0, targetNodeId: targetId, displayName: 'RemoteTarget' }],
      },
    });
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
  });

  test('@ same-parent reference keeps continued typing on the inline row', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: '',
    });
    const emptyRowId = await lastTodayChildId(page);
    expect(emptyRowId).toBeTruthy();

    await rowEditor(page, emptyRowId!).click();
    await page.keyboard.type('@Al');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type('test');

    await expect.poll(async () => nodeById(page, ids.alpha)).toMatchObject({
      content: { text: 'Alpha' },
    });
    await expect.poll(async () => nodeById(page, emptyRowId!)).toMatchObject({
      content: {
        text: 'test',
        inlineRefs: [{ offset: 0, targetNodeId: ids.alpha, displayName: 'Alpha' }],
      },
    });
    await expect(rowEditor(page, emptyRowId!)).toBeFocused();

    const calls = await commandCalls(page);
    expect(calls.map((call) => call.cmd)).not.toContain('replace_node_with_reference');
    expect(calls.map((call) => call.cmd)).not.toContain('replace_node_with_inline_reference');
    expect(calls.map((call) => call.cmd)).not.toContain('convert_reference_to_inline_node');
  });

  test('@ same-parent reference keeps IME text after the inline reference', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: '',
    });
    const emptyRowId = await lastTodayChildId(page);
    expect(emptyRowId).toBeTruthy();

    const editor = rowEditor(page, emptyRowId!);
    await editor.click();
    await page.keyboard.type('@Al');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(editor).toBeFocused();

    const patchCountBeforeComposition = (await commandCalls(page))
      .filter((call) => call.cmd === 'apply_node_text_patch').length;
    await dispatchCompositionEvent(editor, 'compositionstart');
    await page.keyboard.insertText('你好');
    await expect.poll(async () => (await commandCalls(page))
      .filter((call) => call.cmd === 'apply_node_text_patch').length).toBe(patchCountBeforeComposition);
    await dispatchCompositionEvent(editor, 'compositionend', '你好');

    await expect.poll(async () => nodeById(page, ids.alpha)).toMatchObject({
      content: { text: 'Alpha' },
    });
    await expect.poll(async () => nodeById(page, emptyRowId!)).toMatchObject({
      content: {
        text: '你好',
        inlineRefs: [{ offset: 0, targetNodeId: ids.alpha, displayName: 'Alpha' }],
      },
    });
    await expect(row(page, emptyRowId!).locator('.inline-ref')).toHaveText('Alpha');
  });

  test('@ inline reference insertion leaves the caret after the inserted reference', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: 'See ',
    });
    const nodeId = await lastTodayChildId(page);
    expect(nodeId).toBeTruthy();

    await placeCursor(page, nodeId!, 'end');
    await page.keyboard.type('@Al');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(rowEditor(page, nodeId!)).toBeFocused();

    await page.keyboard.type('!');
    await expect.poll(async () => {
      const node = await nodeById(page, nodeId!);
      return node?.content;
    }).toMatchObject({
      text: 'See !',
      inlineRefs: [{ offset: 4, targetNodeId: ids.alpha, displayName: 'Alpha' }],
    });
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
      const created = projection.nodes.find((node) => node.id === createdRowId);
      return Boolean(
        !created?.type
        && created?.content.inlineRefs.some((ref) => (
          projection.nodes.some((node) => (
          node.id === ref.targetNodeId
          && node.parentId === ids.library
          && node.type !== 'reference'
          && node.content.text === 'Zeta'
          ))
        )),
      );
    }).toBe(true);
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
    await expect(rowBody(page, createdRowId!)).toHaveClass(/ref-converting/);
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

  test('new field name is a placeholder and Enter creates a sibling content row', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing created field');
    const fieldName = row(page, fieldId).locator('.field-name-input');
    await expect(fieldName).toBeFocused();
    await expect(fieldName).toHaveValue('');
    await expect(fieldName).toHaveAttribute('placeholder', 'Field name');
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const fieldEntry = projection.nodes.find((node) => node.id === fieldId);
      const fieldDef = projection.nodes.find((node) => node.id === fieldEntry?.fieldDefId);
      return fieldDef?.content.text;
    }).toBe('');

    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const children = await todayChildren(page);
      return children.length;
    }).toBe(beforeChildren.length + 2);
    const children = await todayChildren(page);
    const newNodeId = children[children.indexOf(fieldId) + 1];
    if (!newNodeId) throw new Error('missing created sibling');
    await expect.poll(async () => (await nodeById(page, newNodeId))?.type ?? null).toBe(null);
    await expect(rowEditor(page, newNodeId)).toBeFocused();
  });

  test('field separators appear only on field hover or focus', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing created field');
    const fieldName = row(page, fieldId).locator('.field-name-input');
    await expect(fieldName).toBeFocused();
    await expect.poll(() => fieldSeparatorOpacity(page, fieldId, '::before')).toBe('1');
    await expect.poll(() => fieldSeparatorOpacity(page, fieldId, '::after')).toBe('1');

    await rowEditor(page, ids.alpha).click();
    await expect.poll(() => fieldSeparatorOpacity(page, fieldId, '::before')).toBe('0');
    await expect.poll(() => fieldSeparatorOpacity(page, fieldId, '::after')).toBe('0');

    await row(page, fieldId).hover();
    await expect.poll(() => fieldSeparatorOpacity(page, fieldId, '::before')).toBe('1');
    await expect.poll(() => fieldSeparatorOpacity(page, fieldId, '::after')).toBe('1');
  });

  test('adjacent field rows do not double-draw their shared separator', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const firstFieldId = await lastTodayChildId(page);
    if (!firstFieldId) throw new Error('missing first field');

    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const secondFieldId = await lastTodayChildId(page);
    if (!secondFieldId || secondFieldId === firstFieldId) throw new Error('missing second field');

    await row(page, firstFieldId).hover();
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::before')).toBe('1');
    await expect.poll(() => fieldSeparatorContent(page, firstFieldId, '::after')).toBe('none');

    await row(page, secondFieldId).hover();
    await expect.poll(() => fieldSeparatorOpacity(page, secondFieldId, '::before')).toBe('1');
    await expect.poll(() => fieldSeparatorOpacity(page, secondFieldId, '::after')).toBe('1');
  });

  test('nested field value separators own the active field scope', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');
    await trailingEditor(page, fieldId).click();
    await page.keyboard.type('>');

    let nestedFieldId: string | undefined;
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      nestedFieldId = projection.nodes.find((node) => node.id === fieldId)?.children.at(-1);
      return nestedFieldId;
    }).not.toBeUndefined();
    if (!nestedFieldId) throw new Error('missing nested field');
    const nestedId = String(nestedFieldId);

    await expect(row(page, nestedId).locator('.field-name-input')).toBeFocused();
    await expect.poll(() => fieldSeparatorOpacity(page, fieldId, '::before')).toBe('0');
    await expect.poll(() => fieldSeparatorOpacity(page, fieldId, '::after')).toBe('0');
    await expect.poll(() => fieldSeparatorOpacity(page, nestedId, '::before')).toBe('1');
    await expect.poll(() => fieldSeparatorOpacity(page, nestedId, '::after')).toBe('1');
  });

  test('> in field value creates a nested field row', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing created field');
    const valueEditor = trailingEditor(page, fieldId);
    await expect(valueEditor).toBeVisible();
    await valueEditor.click();
    await page.keyboard.type('>');

    let nestedFieldId: string | undefined;
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const fieldEntry = projection.nodes.find((node) => node.id === fieldId);
      nestedFieldId = fieldEntry?.children.at(-1);
      const nestedField = projection.nodes.find((node) => node.id === nestedFieldId);
      return {
        childCount: fieldEntry?.children.length ?? 0,
        nestedParentId: nestedField?.parentId,
        nestedType: nestedField?.type,
      };
    }).toEqual({
      childCount: 1,
      nestedParentId: fieldId,
      nestedType: 'fieldEntry',
    });
    if (!nestedFieldId) throw new Error('missing nested field');
    await expect(row(page, nestedFieldId).locator('.field-name-input')).toBeFocused();
  });

  test('> in field value falls back cleanly when the backend still rejects empty field names', async ({ page }) => {
    await rejectEmptyInlineFieldNames(page);

    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing created field');
    const valueEditor = trailingEditor(page, fieldId);
    await expect(valueEditor).toBeVisible();
    await valueEditor.click();
    await page.keyboard.type('>');

    let nestedFieldId: string | undefined;
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const fieldEntry = projection.nodes.find((node) => node.id === fieldId);
      nestedFieldId = fieldEntry?.children.at(-1);
      const nestedField = projection.nodes.find((node) => node.id === nestedFieldId);
      const nestedFieldDef = projection.nodes.find((node) => node.id === nestedField?.fieldDefId);
      return {
        fieldDefName: nestedFieldDef?.content.text,
        nestedParentId: nestedField?.parentId,
        nestedType: nestedField?.type,
      };
    }).toEqual({
      fieldDefName: '',
      nestedParentId: fieldId,
      nestedType: 'fieldEntry',
    });
    if (!nestedFieldId) throw new Error('missing nested field');
    await expect(row(page, nestedFieldId).locator('.field-name-input')).toBeFocused();
    await expect(page.locator('.error')).toHaveCount(0);
  });

  test('> in an existing field value row converts that value row into a nested field', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');

    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing created field');
    await invokeMockCommand(page, 'create_node', {
      parentId: fieldId,
      index: null,
      text: '',
    });
    let valueNodeId: string | undefined;
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      valueNodeId = projection.nodes.find((node) => node.parentId === fieldId)?.id;
      return valueNodeId;
    }).not.toBeUndefined();

    if (!valueNodeId) throw new Error('missing value node');
    const valueId = String(valueNodeId);
    await rowEditor(page, valueId).click();
    await page.keyboard.type('>');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const valueNode = projection.nodes.find((node) => node.id === valueId);
      return {
        content: valueNode?.content.text,
        parentId: valueNode?.parentId,
        type: valueNode?.type,
      };
    }).toEqual({
      content: '',
      parentId: fieldId,
      type: 'fieldEntry',
    });
    await expect(row(page, valueId).locator('.field-name-input')).toBeFocused();
  });

  test('checkbox field values use the shared checkbox mark', async ({ page }) => {
    await invokeMockCommand(page, 'create_inline_field', {
      parentId: ids.today,
      index: null,
      name: 'Done',
      fieldType: 'checkbox',
    });

    let fieldId: string | undefined;
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      fieldId = projection.nodes.find((node) => (
        node.parentId === ids.today
        && node.type === 'fieldEntry'
        && node.fieldType === 'checkbox'
      ))?.id;
      return fieldId;
    }).not.toBeUndefined();
    if (!fieldId) throw new Error('missing checkbox field');

    const fieldTypeIcon = row(page, fieldId).locator(':scope > .row .row-bullet-shape.field svg');
    await expect(row(page, fieldId).locator(':scope > .row .row-bullet-shape.field .checkbox-mark')).toHaveCount(0);
    await expect(fieldTypeIcon).toHaveCount(1);
    await expect(fieldTypeIcon).toHaveCSS('width', '12px');
    await expect(fieldTypeIcon).toHaveCSS('height', '12px');

    const checkbox = row(page, fieldId).getByRole('checkbox');
    const mark = checkbox.locator('.checkbox-mark');
    await expect(mark).toHaveCount(1);
    await expect(checkbox.locator('.typed-field-boolean-box')).toHaveCount(0);
    await expect(mark).not.toHaveClass(/checked/);
    await expect(mark).toHaveCSS('width', '16px');
    await expect(mark).toHaveCSS('height', '16px');
    await expect(mark).toHaveCSS('border-radius', '3px');

    await checkbox.click();
    await expect(mark).toHaveClass(/checked/);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.parentId === fieldId)?.content.text;
    }).toBe('true');
  });

  test('boolean field values use the shared switch mark', async ({ page }) => {
    await invokeMockCommand(page, 'create_inline_field', {
      parentId: ids.today,
      index: null,
      name: 'Enabled',
      fieldType: 'boolean',
    });

    let fieldId: string | undefined;
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      fieldId = projection.nodes.find((node) => (
        node.parentId === ids.today
        && node.type === 'fieldEntry'
        && node.fieldType === 'boolean'
      ))?.id;
      return fieldId;
    }).not.toBeUndefined();
    if (!fieldId) throw new Error('missing boolean field');

    const fieldValueSwitch = row(page, fieldId).getByRole('switch');
    const mark = fieldValueSwitch.locator('.switch-mark');
    await expect(mark).toHaveCount(1);
    await expect(fieldValueSwitch.locator('.checkbox-mark')).toHaveCount(0);
    await expect(mark).not.toHaveClass(/checked/);
    await expect(mark).toHaveCSS('width', '30px');
    await expect(mark).toHaveCSS('height', '18px');
    await expect(fieldValueSwitch.locator('.switch-mark-thumb')).toHaveCSS('width', '14px');

    await fieldValueSwitch.click();
    await expect(mark).toHaveClass(/checked/);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.parentId === fieldId)?.content.text;
    }).toBe('true');
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
