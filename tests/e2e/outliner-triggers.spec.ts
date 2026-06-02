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
  return trailingEditor(page, ids.priorityEntry);
}

async function selectedPriorityValueId(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.parentId === ids.priorityEntry)?.id ?? '';
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
    // The applied tag renders as an inline chip widget inside the row editor (the
    // design-system inline tag slot), so the editor's text content is "Task#project".
    // Assert the node's own body text instead — the chip is not part of it.
    await expect.poll(async () => (await nodeById(page, createdRowId!))?.content.text).toBe('Task');
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
    await delayMockCommands(page, ['create_tagged_node'], 800);
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
    await expect(page.locator('.outline-panel-surface.active-panel [data-trailing-parent-id]')).toHaveCount(0);
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

  test('@ suggestions exclude nodes moved to Trash', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'Visible TrashCandidate',
    });
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'Deleted TrashCandidate',
    });
    const deletedId = (await e2eProjection(page)).nodes.find((node) => (
      node.content.text === 'Deleted TrashCandidate'
    ))?.id;
    expect(deletedId).toBeTruthy();
    await invokeMockCommand(page, 'trash_node', { nodeId: deletedId });

    await placeCursor(page, ids.gamma, 'start');
    await page.keyboard.type('@TrashCandidate');

    const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: /Visible TrashCandidate/ })).toBeVisible();
    await expect(listbox.getByRole('option', { name: /Deleted TrashCandidate/ })).toHaveCount(0);
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
    await delayMockCommands(page, ['add_reference_conversion'], 800);
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

    await trailingEditor(page).click();
    await page.keyboard.type('See @Alpha');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    // Eager body materialization: leading text ("See ") turns the trailing draft into
    // a real node as it is typed, so exactly one new child already exists while the @
    // suggestion popover is open. (A leading #/@ trigger, with no text before it, still
    // buffers and resolves atomically — see the other trigger cases.)
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();

    await page.keyboard.press('Enter');

    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    // Selecting the suggestion resolves the query into an inline reference on that same
    // node — it does not spawn a second row.
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    expect(await lastTodayChildId(page)).toBe(createdRowId);
    await expect(row(page, createdRowId!)).toContainText('See');
    await expect(row(page, createdRowId!)).toContainText('Alpha');
    await expect.poll(async () => nodeById(page, createdRowId!)).toMatchObject({
      content: {
        text: 'See  ',
        inlineRefs: [{ offset: 4, targetNodeId: ids.alpha, displayName: 'Alpha' }],
      },
    });
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
    await expect(trailingEditor(page)).toBeVisible();
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
        text: ' test',
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
        text: ' 你好',
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
      text: 'See  !',
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

  test('typing a field name offers an existing field to reuse and relinks on select', async ({ page }) => {
    // Author one field named "Milestone" on `today` (a name the fixture does not
    // seed), then commit it so its definition is a reuse candidate.
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const firstId = await lastTodayChildId(page);
    if (!firstId) throw new Error('missing first field');
    await page.keyboard.type('Milestone');
    // The entry's def id is fixed at creation; committing only writes its text.
    const sharedDefId = (await nodeById(page, firstId))?.fieldDefId;
    expect(sharedDefId).toBeTruthy();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (sharedDefId ? await nodeById(page, sharedDefId) : null)?.content.text).toBe('Milestone');

    // Reuse it on a DIFFERENT node (gamma): a node may not carry the same field
    // twice, so reuse is a cross-node gesture. Expand gamma to surface its child
    // trailing input, then `>` mints a throwaway draft there.
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();
    await expect(trailingEditor(page, ids.gamma)).toBeFocused();
    await page.keyboard.type('>');
    const secondId = (await nodeById(page, ids.gamma))?.children.at(-1);
    if (!secondId || secondId === firstId) throw new Error('missing second field');
    const secondName = row(page, secondId).locator('.field-name-input');
    await expect(secondName).toBeFocused();
    const draftDefId = (await nodeById(page, secondId))?.fieldDefId;
    expect(draftDefId).toBeTruthy();
    expect(draftDefId).not.toBe(sharedDefId);

    await page.keyboard.type('Mile');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByText('Milestone', { exact: true })).toBeVisible();
    await popover.getByText('Milestone', { exact: true }).click();

    // The second entry now reuses the shared definition; its throwaway draft def
    // is cleaned up and the popover closes.
    await expect.poll(async () => (await nodeById(page, secondId))?.fieldDefId).toBe(sharedDefId);
    await expect(secondName).toHaveValue('Milestone');
    await expect.poll(async () => Boolean(await nodeById(page, draftDefId!))).toBe(false);
    await expect(popover).toHaveCount(0);
  });

  test('Space on an empty field name summons the full reuse picker', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');
    const fieldName = row(page, fieldId).locator('.field-name-input');
    await expect(fieldName).toBeFocused();
    await expect(fieldName).toHaveValue('');

    // An empty name offers nothing on its own — the picker is opt-in.
    await expect(page.locator('.field-name-reuse-popover')).toHaveCount(0);

    // Space summons the full picker (existing fields + system fields) instead of
    // typing a leading space into the name.
    await page.keyboard.press('Space');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByText('Status', { exact: true })).toBeVisible();
    await expect(popover.getByText('System fields')).toBeVisible();
    await expect(popover.getByText('Created', { exact: true })).toBeVisible();
    // The space was swallowed by the summon, not inserted into the name.
    await expect(fieldName).toHaveValue('');
  });

  test('a field already on the node is not offered again (no duplicate fields per node)', async ({ page }) => {
    // Put the built-in "Created" system field on `today`.
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const firstId = await lastTodayChildId(page);
    if (!firstId) throw new Error('missing first field');
    await page.keyboard.type('Crea');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover.getByText('Created', { exact: true })).toBeVisible();
    await popover.getByText('Created', { exact: true }).click();
    await expect.poll(async () => (await nodeById(page, firstId))?.fieldDefId).toBe('sys:createdAt');

    // A second field on the SAME node must not offer "Created" again — it is
    // already present, so the only "Crea" match is excluded and nothing opens.
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const secondId = await lastTodayChildId(page);
    if (!secondId || secondId === firstId) throw new Error('missing second field');
    await expect(row(page, secondId).locator('.field-name-input')).toBeFocused();
    await page.keyboard.type('Crea');
    await expect(page.locator('.field-name-reuse-popover')).toHaveCount(0);
  });

  test('a system field can be reused and renders a read-only computed value', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');
    const fieldName = row(page, fieldId).locator('.field-name-input');
    await expect(fieldName).toBeFocused();

    // Typing surfaces the built-in "Created" system field under its own section.
    await page.keyboard.type('Crea');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover.getByText('System fields')).toBeVisible();
    await expect(popover.getByText('Created', { exact: true })).toBeVisible();
    await popover.getByText('Created', { exact: true }).click();

    // The entry points at the sys field id; its name is fixed/read-only and its
    // value is a read-only computed cell (not an editable value outliner).
    await expect.poll(async () => (await nodeById(page, fieldId))?.fieldDefId).toBe('sys:createdAt');
    await expect(fieldName).toHaveValue('Created');
    await expect(fieldName).toHaveJSProperty('readOnly', true);
    await expect(row(page, fieldId).locator('.field-value-system')).toBeVisible();
  });

  test('the Done system field toggles the owner node\'s done state on an editable node', async ({ page }) => {
    // Reuse Done on a normal, editable node — `gamma`, a child of the (locked) day
    // page. Expand it to surface its child trailing input, then `>` mints a draft.
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();
    await expect(trailingEditor(page, ids.gamma)).toBeFocused();
    await page.keyboard.type('>');
    const fieldId = (await nodeById(page, ids.gamma))?.children.at(-1);
    if (!fieldId) throw new Error('missing field');
    await page.keyboard.type('Done');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover.getByText('Done', { exact: true })).toBeVisible();
    await popover.getByText('Done', { exact: true }).click();
    await expect.poll(async () => (await nodeById(page, fieldId))?.fieldDefId).toBe('sys:done');

    // The value is a checkbox (not the read-only text cell), reflecting the owner
    // node's done state — `gamma` starts undone (completedAt 0).
    const checkbox = row(page, fieldId).locator('.field-value-cell [role="checkbox"]');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
    await expect(row(page, fieldId).locator('.field-value-system')).toHaveCount(0);

    // Clicking it writes back: the owner node becomes done and the box checks.
    await checkbox.click();
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => Boolean((await nodeById(page, ids.gamma))?.completedAt)).toBe(true);

    // Toggling again clears it.
    await checkbox.click();
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
  });

  test('the Done system field is read-only on a locked owner (daily-note date page)', async ({ page }) => {
    // The day page (`today`) is locked, like a real `date:` page. A Done field whose
    // owner is the page reflects state but must not toggle it: core rejects
    // `toggle_done` on a locked node ("operation is not allowed on locked node"), so
    // the checkbox renders read-only instead of crashing on click.
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');
    await page.keyboard.type('Done');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover.getByText('Done', { exact: true })).toBeVisible();
    await popover.getByText('Done', { exact: true }).click();
    await expect.poll(async () => (await nodeById(page, fieldId))?.fieldDefId).toBe('sys:done');

    const checkbox = row(page, fieldId).locator('.field-value-cell [role="checkbox"]');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toHaveClass(/is-readonly/);
    await expect(checkbox).toHaveAttribute('aria-readonly', 'true');
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');

    // The control is inert (aria-disabled) — Playwright won't click an enabled
    // element here, so force the click to prove it still changes nothing.
    await checkbox.click({ force: true });
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => Boolean((await nodeById(page, ids.today))?.completedAt)).toBe(false);
  });

  test('the Tags system field renders the owner\'s tags as colored badges', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');
    await page.keyboard.type('Tags');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover.getByText('Tags', { exact: true })).toBeVisible();
    await popover.getByText('Tags', { exact: true }).click();
    await expect.poll(async () => (await nodeById(page, fieldId))?.fieldDefId).toBe('sys:tags');

    // `today` carries the "day" tag, so the value renders a colored tag badge —
    // not comma-joined plain text.
    const valueCell = row(page, fieldId).locator('.field-value-cell');
    const badge = valueCell.locator('.tag-badge');
    await expect(badge).toHaveCount(1);
    await expect(badge).toContainText('day');
    await expect(valueCell.locator('.field-value-system-empty')).toHaveCount(0);
  });

  test('date system fields (Created) render the value with a calendar glyph', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');
    await page.keyboard.type('Crea');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover.getByText('Created', { exact: true })).toBeVisible();
    await popover.getByText('Created', { exact: true }).click();
    await expect.poll(async () => (await nodeById(page, fieldId))?.fieldDefId).toBe('sys:createdAt');

    // The date renders with its value text plus a (read-only) calendar glyph, so
    // it reads like a date rather than bare text.
    const dateCell = row(page, fieldId).locator('.field-value-system-date');
    await expect(dateCell).toBeVisible();
    await expect(dateCell).toContainText(/\d{4}-\d{2}-\d{2}/);
    await expect(dateCell.locator('svg')).toHaveCount(1);
  });

  test('the Owner system field links to the node\'s parent', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');
    await page.keyboard.type('Owner');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover.getByText('Owner', { exact: true })).toBeVisible();
    await popover.getByText('Owner', { exact: true }).click();
    await expect.poll(async () => (await nodeById(page, fieldId))?.fieldDefId).toBe('sys:owner');

    // The field is a child of `today`, whose parent is the "Daily Notes" page —
    // Owner renders it as a read-only reference row (the shared reference
    // presentation), not bare text or a bespoke link.
    const valueCell = row(page, fieldId).locator('.field-value-cell');
    await expect(valueCell.locator('.row.reference-row')).toHaveCount(1);
    await expect(valueCell).toContainText('Daily Notes');
    // Layout regression guard: the value rows sit inside the shared value-column
    // outliner container (one full-width flex child of the cell), so they stack
    // top-to-bottom like every outline — NOT as bare rows dropped straight into the
    // flex `.field-value-cell`, which squished them side-by-side (vertical CJK).
    await expect(valueCell.locator(':scope > .field-value-outliner .row.reference-row')).toHaveCount(1);
    // Read-only value set: no trailing draft to add another value.
    await expect(valueCell.locator('[data-trailing-parent-id]')).toHaveCount(0);
  });

  test('the Day system field links to the containing day node\'s date', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');
    await page.keyboard.type('Day');
    const popover = page.locator('.field-name-reuse-popover');
    await expect(popover.getByText('Day', { exact: true })).toBeVisible();
    await popover.getByText('Day', { exact: true }).click();
    await expect.poll(async () => (await nodeById(page, fieldId))?.fieldDefId).toBe('sys:day');

    // `today` itself is the day node (tagged "day"); Day renders it as a read-only
    // reference row to that day node.
    const valueCell = row(page, fieldId).locator('.field-value-cell');
    await expect(valueCell.locator('.row.reference-row')).toHaveCount(1);
    await expect(valueCell).toContainText('2026-05-13');
  });

  test('field entry rows are not expandable (children are the value, shown in the value column)', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');

    // The leaf-expand chevron is suppressed on field rows, so there is no
    // affordance to open a separate child scope beyond the field's value.
    const chevronDisplay = await row(page, fieldId)
      .locator(':scope > .row > .row-leading > .row-chevron-button')
      .evaluate((el) => getComputedStyle(el).display);
    expect(chevronDisplay).toBe('none');
  });

  test('a fresh field name does not reuse: Enter keeps the user\'s own new field', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing created field');
    const draftDefId = (await nodeById(page, fieldId))?.fieldDefId;

    // A unique name has no reuse candidate, so Enter falls through to the name
    // editor and commits the user's own field (creating a sibling row).
    await page.keyboard.type('Milestone');
    await expect(page.locator('.field-name-reuse-popover')).toHaveCount(0);
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await nodeById(page, fieldId))?.fieldDefId).toBe(draftDefId);
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 2);
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

});

test.describe('outliner options field inline value', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { optionsField: true });
  });

  test('options field value accepts a typed value inline and auto-collects it', async ({ page }) => {
    const valuePreview = row(page, ids.priorityEntry).locator('.field-value-node-preview');
    await priorityValueEditor(page).click();

    const listbox = page.getByRole('listbox', { name: 'Field options' });
    await expect(listbox).toBeVisible();
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

  test('options field value selects an existing option from the inline listbox', async ({ page }) => {
    const valuePreview = row(page, ids.priorityEntry).locator('.field-value-node-preview');
    await priorityValueEditor(page).click();

    const listbox = page.getByRole('listbox', { name: 'Field options' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'High' })).toBeVisible();

    await listbox.getByRole('option', { name: 'Low' }).click();
    await expect(valuePreview).toHaveText(/Low/);
  });

  test('options field appends multiple selected values instead of replacing', async ({ page }) => {
    // Everything is a node: selecting a second option appends it (no cardinality gate),
    // so the field ends holding both values in selection order.
    await invokeMockCommand(page, 'select_field_option', {
      fieldEntryId: ids.priorityEntry,
      optionNodeId: ids.priorityLow,
    });
    await invokeMockCommand(page, 'select_field_option', {
      fieldEntryId: ids.priorityEntry,
      optionNodeId: ids.priorityHigh,
    });

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === ids.priorityEntry);
      return (entry?.children ?? []).map((childId) =>
        projection.nodes.find((node) => node.id === childId)?.content.text);
    }).toEqual(['Low', 'High']);
  });

  test('selected option reference values can be changed with Arrow and Enter', async ({ page }) => {
    const valuePreview = row(page, ids.priorityEntry).locator('.field-value-node-preview');
    await invokeMockCommand(page, 'select_field_option', {
      fieldEntryId: ids.priorityEntry,
      optionNodeId: ids.priorityLow,
    });
    await expect(valuePreview).toHaveText(/Low/);
    const valueId = await selectedPriorityValueId(page);

    await rowBody(page, valueId).click();
    const listbox = page.getByRole('listbox', { name: 'Selected field options' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'Low' })).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowUp');
    await expect(listbox.getByRole('option', { name: 'High' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');

    await expect(listbox).toHaveCount(0);
    await expect(valuePreview).toHaveText(/High/);
  });

  test('Escape closes selected option list before clearing row selection', async ({ page }) => {
    await invokeMockCommand(page, 'select_field_option', {
      fieldEntryId: ids.priorityEntry,
      optionNodeId: ids.priorityLow,
    });
    const valueId = await selectedPriorityValueId(page);

    await rowBody(page, valueId).click();
    await expect(page.getByRole('listbox', { name: 'Selected field options' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: 'Selected field options' })).toHaveCount(0);
    await expect(rowBody(page, valueId)).toHaveClass(/ref-click-selected/);

    await page.keyboard.press('Escape');
    await expect(rowBody(page, valueId)).not.toHaveClass(/ref-click-selected|selected/);
  });

  test('clearing an inline-created auto-collected value removes the local value and collected reference', async ({ page }) => {
    await priorityValueEditor(page).click();
    await page.keyboard.type('Temporary');
    await page.keyboard.press('Enter');
    await expect(row(page, ids.priorityEntry).locator('.field-value-node-preview')).toHaveText(/Temporary/);

    // No picker "Clear selection" affordance any more — clearing the field value
    // is the same node-level command the rest of the outliner uses.
    await invokeMockCommand(page, 'clear_field_value', { fieldEntryId: ids.priorityEntry });

    await expect(row(page, ids.priorityEntry).locator('.field-value-node-preview'))
      .toHaveAttribute('aria-label', 'Select option');
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

  test('options field listbox stays inside a narrow viewport', async ({ page }) => {
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

  test('a node carrying a Done field shows a synced checkbox on its own row', async ({ page }) => {
    // A freshly created plain node has no checkbox.
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: 'Wash dishes',
      id: 'fu2-task',
    });
    await expect(row(page, 'fu2-task')).toContainText('Wash dishes');
    await expect(rowBody(page, 'fu2-task').locator('.done-checkbox')).toHaveCount(0);

    // Attaching the built-in Done system field (a sys:done field entry) makes the
    // node's own row show a checkbox — derived from the same completedAt the field
    // reads, so the two stay in sync without extra wiring.
    await page.evaluate(async (parentId) => {
      const win = window as unknown as {
        lin?: {
          invoke: (cmd: string, args?: Record<string, unknown>) =>
            Promise<{ focus?: { nodeId: string }; projection?: unknown }>;
        };
        __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
      };
      const created = await win.lin!.invoke('create_inline_field', {
        parentId,
        index: null,
        name: 'Done',
        fieldType: 'plain',
      });
      const entryId = created.focus!.nodeId;
      const reused = await win.lin!.invoke('reuse_field_definition', { entryId, targetDefId: 'sys:done' });
      const projection = reused.projection ?? created.projection;
      if (projection) {
        win.__LIN_E2E__?.emitDocumentEvent({
          type: 'projection_changed',
          origin: 'user',
          projection,
          timestamp: Date.now(),
        });
      }
    }, 'fu2-task');

    // The owner is editable, so it is an interactive checkbox button (not the
    // read-only span used for locked owners).
    await expect(rowBody(page, 'fu2-task').locator('button.done-checkbox')).toHaveCount(1);
  });
});

test.describe('outliner reference field inline value', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { referenceField: true });
  });

  test('reference field value references an existing node picked from the inline node search', async ({ page }) => {
    // The reference field's trailing draft is a node-search box: focusing it opens
    // the picker over the whole document, typing filters it.
    await trailingEditor(page, ids.referencesEntry).click();
    const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(listbox).toBeVisible();

    await page.keyboard.type('Alpha');
    await expect(listbox.getByRole('option', { name: 'Alpha' })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toHaveCount(0);

    // The picked node renders as a reference row in the value cell (the shared
    // reference presentation), and the value is a real reference targeting it.
    const valueCell = row(page, ids.referencesEntry).locator('.field-value-cell');
    await expect(valueCell.locator('.row.reference-row')).toHaveCount(1);
    await expect(valueCell).toContainText('Alpha');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === ids.referencesEntry);
      const valueNode = projection.nodes.find((node) => node.parentId === ids.referencesEntry);
      return {
        children: entry?.children.length,
        type: valueNode?.type ?? 'content',
        targetId: valueNode?.targetId,
      };
    }).toEqual({ children: 1, type: 'reference', targetId: ids.alpha });

    const calls = await commandCalls(page);
    expect(calls.some((call) => (
      call.cmd === 'add_field_reference'
      && call.args.fieldEntryId === ids.referencesEntry
      && call.args.targetNodeId === ids.alpha
    ))).toBe(true);
  });

  test('reference field value references a node clicked in the listbox', async ({ page }) => {
    await trailingEditor(page, ids.referencesEntry).click();
    const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(listbox).toBeVisible();

    await page.keyboard.type('Beta');
    await listbox.getByRole('option', { name: 'Beta' }).click();

    const valueCell = row(page, ids.referencesEntry).locator('.field-value-cell');
    await expect(valueCell.locator('.row.reference-row')).toHaveCount(1);
    await expect(valueCell).toContainText('Beta');
  });

  test('a query with no node match never materializes a free-text value', async ({ page }) => {
    await trailingEditor(page, ids.referencesEntry).click();
    const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(listbox).toBeVisible();

    await page.keyboard.type('zzz-no-such-node');
    await expect(listbox.getByRole('option')).toHaveCount(0);
    // The open picker owns Enter and swallows it; a reference value only comes from
    // a picked node, so the typed query must not become a value.
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.id === ids.referencesEntry)?.children.length;
    }).toBe(0);
  });
});
