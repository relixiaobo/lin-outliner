import { expect, test, type Locator } from '@playwright/test';
import {
  commandCalls,
  e2eInlineRefNodeId,
  e2eNodeInlineRef,
  e2eProjection,
  holdOutlineMutation,
  ids,
  nodeById,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
  sourceFieldEntries,
  trailingEditor,
} from './outlinerMock';

async function lastTodayChildId(page: import('@playwright/test').Page) {
  return (await todayChildren(page)).at(-1);
}

async function todayChildren(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

async function appliedOperations(page: import('@playwright/test').Page, fromCall = 0) {
  const calls = (await commandCalls(page)).slice(fromCall);
  return calls.flatMap((call) => {
    const input = call.args as {
      diff?: { normalizedChangeSet?: { operations?: Array<Record<string, unknown>> } };
      changeSet?: { operations?: Array<Record<string, unknown>> };
    };
    if (call.cmd === 'outline/apply') return input.diff?.normalizedChangeSet?.operations ?? [];
    if (call.cmd === 'outline/transact') return input.changeSet?.operations ?? [];
    return [];
  });
}

async function appliedInstructions(page: import('@playwright/test').Page, fromCall = 0) {
  return (await appliedOperations(page, fromCall)).flatMap((operation) => (
    Array.isArray(operation.changes) ? operation.changes as Array<Record<string, unknown>> : []
  ));
}

async function appliedTextPatchCount(page: import('@playwright/test').Page) {
  return (await appliedInstructions(page)).filter((instruction) => instruction.kind === 'text-patch').length;
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
    if (element instanceof HTMLElement) element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    const paragraph = element.querySelector('p') ?? element;
    range.selectNodeContents(paragraph);
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

async function chooseSelectedReferenceSuggestion(page: import('@playwright/test').Page) {
  const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
  await expect(listbox).toBeVisible();
  await expect(listbox.locator('[role="option"][data-selected="true"]'))
    .not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
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
    const projection = result && typeof result === 'object' && 'update' in result
      ? (result as { update: { projection: unknown } }).update.projection
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

function projectedFieldSlotId(ownerId: string, fieldDefId: string) {
  return `slot:${encodeURIComponent(ownerId)}:${encodeURIComponent(fieldDefId)}`;
}

async function projectFieldFromTag(
  page: import('@playwright/test').Page,
  ownerId: string,
  fieldDefId: string,
  fieldType: string,
) {
  await invokeMockCommand(page, 'create_inline_field', {
    parentId: ids.projectTag,
    index: null,
    name: '',
    fieldType,
    targetDefId: fieldDefId,
  });
  await invokeMockCommand(page, 'apply_tag', { nodeId: ownerId, tagId: ids.projectTag });
  await rowBody(page, ownerId).hover();
  const expand = row(page, ownerId).getByRole('button', { name: 'Expand' });
  await expect(expand).toBeVisible();
  await expand.click();
  const slotId = projectedFieldSlotId(ownerId, fieldDefId);
  await expect(row(page, slotId)).toBeVisible();
  return slotId;
}

async function storedFieldEntryId(
  page: import('@playwright/test').Page,
  ownerId: string,
  fieldDefId: string,
) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => (
    node.parentId === ownerId
    && node.type === 'fieldEntry'
    && (node as { fieldDefId?: string }).fieldDefId === fieldDefId
  ))?.id;
}

async function pasteClipboardFile(
  page: import('@playwright/test').Page,
  file: { name: string; mimeType: string; text: string },
) {
  await page.evaluate((input) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([input.text], input.name, { type: input.mimeType }));
    const target = document.activeElement;
    if (!target) throw new Error('No active paste target');
    target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    }));
  }, file);
}

async function delayMockApply(
  page: import('@playwright/test').Page,
  matches: { op: string; instructionKind?: string },
  delayMs = 160,
) {
  await page.evaluate(({ matches, delayMs }) => {
    const win = window as unknown as {
      lin?: { outline?: { request: <T>(request: { command: string; input: unknown }) => Promise<T> } };
    };
    const outline = win.lin?.outline;
    const originalRequest = outline?.request;
    if (!outline || !originalRequest) return;
    outline.request = async <T,>(request: { command: string; input: unknown }) => {
      const input = request.input as {
        diff?: { normalizedChangeSet?: { operations?: Array<Record<string, unknown>> } };
        changeSet?: { operations?: Array<Record<string, unknown>> };
      };
      const operations = request.command === 'apply'
        ? input.diff?.normalizedChangeSet?.operations ?? []
        : request.command === 'transact' ? input.changeSet?.operations ?? [] : [];
      const matched = operations.some((operation) => (
        operation.op === matches.op
        && (!matches.instructionKind || (
          Array.isArray(operation.changes)
          && operation.changes.some((change) => (
            typeof change === 'object'
            && change !== null
            && (change as Record<string, unknown>).kind === matches.instructionKind
          ))
        ))
      ));
      if (matched) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
      return originalRequest<T>(request);
    };
  }, { matches, delayMs });
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
    const operations = await appliedOperations(page, beforeCalls);
    expect(operations.filter((operation) => operation.op === 'create')).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      op: 'create',
      nodes: [expect.objectContaining({ tags: [ids.projectTag] })],
    });
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
    expect((await appliedOperations(page, beforeCalls)).map((operation) => operation.op))
      .toEqual(['ensure', 'create', 'update']);
  });

  test('# resolves through the shared structural transaction without remounting the editor', async ({ page }) => {
    const beforeChildren = await todayChildren(page);

    const draftEditor = trailingEditor(page);
    await draftEditor.click();
    await page.keyboard.type('#project');
    const draftId = await draftEditor.evaluate((element) => {
      (window as Window & { __tagDraftEditor?: Element }).__tagDraftEditor = element;
      return element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? '';
    });
    expect(draftId).not.toBe('');
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });
    await page.keyboard.press('Enter');

    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();
    const pendingEditor = rowEditor(page, draftId);
    expect(await pendingEditor.evaluate((element) => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelector('.row-inline-content-slot')?.remove();
      return clone.textContent;
    })).toBe('');
    await expect(pendingEditor).toBeFocused();
    await expect(row(page, draftId).locator('.tag-badge-label')).toContainText('project');
    expect(await pendingEditor.evaluate((element) => (
      (window as Window & { __tagDraftEditor?: Element }).__tagDraftEditor === element
    ))).toBe(true);
    expect(await todayChildren(page)).toEqual(beforeChildren);
    await page.keyboard.type('Task');
    await expect(pendingEditor).toHaveText(/Task/);

    await releaseMutation();
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    expect(await lastTodayChildId(page)).toBe(draftId);
    await expect.poll(async () => (await nodeById(page, draftId))?.content.text).toBe('Task');
    await expect(row(page, draftId).locator('.tag-badge-label')).toContainText('project');
    expect(await rowEditor(page, draftId).evaluate((element) => (
      (window as Window & { __tagDraftEditor?: Element }).__tagDraftEditor === element
    ))).toBe(true);
  });

  test('# on an existing row clears the trigger and shows the tag before Runtime settles', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Task #project');
    await expect(page.getByRole('listbox', { name: 'Tag suggestions' })).toBeVisible();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Task #project');
    const beforeCalls = (await commandCalls(page)).length;
    const releaseMutation = await holdOutlineMutation(page, {
      op: 'update',
      instructionKind: 'tag',
    });

    await page.keyboard.press('Enter');

    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(row(page, ids.alpha).locator('.tag-badge-label')).toContainText('project');
    expect(await rowEditor(page, ids.alpha).evaluate((element) => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelector('.row-inline-content-slot')?.remove();
      return clone.textContent;
    })).toBe('Task ');
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('Task #project');
    expect((await nodeById(page, ids.alpha))?.tags).not.toContain(ids.projectTag);
    expect((await commandCalls(page)).slice(beforeCalls)).toEqual([]);

    await releaseMutation();
    await expect.poll(async () => {
      const target = await nodeById(page, ids.alpha);
      return { content: target?.content.text, tags: target?.tags };
    }).toEqual({ content: 'Task ', tags: [ids.projectTag] });
    const operations = await appliedOperations(page, beforeCalls);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'content' }),
      expect.objectContaining({ kind: 'tag', action: 'add' }),
    ]));
  });

  test('# on a title clears the trigger and shows the tag before Runtime settles', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();
    const panel = page.locator('.outline-panel-surface.active-panel');
    const titleEditor = panel.locator('.panel-title-editor .ProseMirror');
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Title #project');
    await expect(page.getByRole('listbox', { name: 'Tag suggestions' })).toBeVisible();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Title #project');
    const releaseMutation = await holdOutlineMutation(page, {
      op: 'update',
      instructionKind: 'tag',
    });

    await page.keyboard.press('Enter');

    await expect(titleEditor).toHaveText('Title ');
    await expect(panel.locator('.panel-title-toolbar-row .tag-badge-label')).toContainText('project');
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('Title #project');
    expect((await nodeById(page, ids.alpha))?.tags).not.toContain(ids.projectTag);

    await releaseMutation();
    await expect.poll(async () => {
      const target = await nodeById(page, ids.alpha);
      return { content: target?.content.text, tags: target?.tags };
    }).toEqual({ content: 'Title ', tags: [ids.projectTag] });
  });

  test('creating a tag on an existing row shows its stable chip before one ChangeSet settles', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('#brand-new-row-tag');
    await expect(page.getByRole('option', { name: 'Create brand-new-row-tag' })).toBeVisible();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('#brand-new-row-tag');
    const beforeCalls = (await commandCalls(page)).length;
    const releaseMutation = await holdOutlineMutation(page, { op: 'ensure' });

    await page.keyboard.press('Enter');

    const pendingBadge = row(page, ids.alpha).locator('.tag-badge').filter({ hasText: 'brand-new-row-tag' });
    await expect(pendingBadge).toBeVisible();
    const pendingBadgeKey = await pendingBadge.locator('.tag-badge-label').getAttribute('title');
    expect(pendingBadgeKey).toBe('brand-new-row-tag');
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('#brand-new-row-tag');

    await releaseMutation();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('');
    await expect(pendingBadge).toBeVisible();
    expect((await appliedOperations(page, beforeCalls)).map((operation) => operation.op))
      .toEqual(['ensure', 'update']);
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
        && created.content.inlineRefs.some((ref) => e2eInlineRefNodeId(ref) === zetaId),
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

    let referenceCreates = (await appliedOperations(page, beforeCalls)).filter((operation) => (
      operation.op === 'create'
      && (operation.nodes as Array<{ content?: { inlineRefs?: unknown[] } }> | undefined)
        ?.some((draft) => (draft.content?.inlineRefs?.length ?? 0) === 1)
    ));
    expect(referenceCreates).toHaveLength(1);

    await page.keyboard.type('!');
    await expect.poll(async () => nodeById(page, createdRowId!)).toMatchObject({
      content: {
        text: '!',
        inlineRefs: [e2eNodeInlineRef(0, zetaId)],
      },
    });
    await expect(rowEditor(page, createdRowId!)).toBeFocused();

    referenceCreates = (await appliedOperations(page, beforeCalls)).filter((operation) => (
      operation.op === 'create'
      && (operation.nodes as Array<{ content?: { inlineRefs?: unknown[] } }> | undefined)
        ?.some((draft) => (draft.content?.inlineRefs?.length ?? 0) === 1)
    ));
    expect(referenceCreates).toHaveLength(1);
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
        && node.content.inlineRefs.some((ref) => e2eInlineRefNodeId(ref) === zetaId)
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
    expect(await appliedInstructions(page, beforeCalls)).toContainEqual(expect.objectContaining({
      kind: 'reference',
      action: 'restore',
    }));
  });

  test('@ resolves through the shared structural transaction without remounting the editor', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'RemoteTarget',
    });
    const beforeChildren = await todayChildren(page);
    const beforeCalls = (await commandCalls(page)).length;

    const draftEditor = trailingEditor(page);
    await draftEditor.click();
    await page.keyboard.type('@RemoteTarget');
    const draftId = await draftEditor.evaluate((element) => {
      (window as Window & { __referenceDraftEditor?: Element }).__referenceDraftEditor = element;
      return element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? '';
    });
    expect(draftId).not.toBe('');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'RemoteTarget', exact: true })).toBeVisible();
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });
    await page.keyboard.press('Enter');

    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();
    const pendingEditor = rowEditor(page, draftId);
    await expect(pendingEditor).toBeFocused();
    await expect(rowBody(page, draftId)).toHaveClass(/ref-converting/);
    await expect(row(page, draftId).locator('.inline-ref')).toHaveText('RemoteTarget');
    expect(await pendingEditor.evaluate((element) => (
      (window as Window & { __referenceDraftEditor?: Element }).__referenceDraftEditor === element
    ))).toBe(true);
    expect(await todayChildren(page)).toEqual(beforeChildren);
    await page.keyboard.type('!');

    await releaseMutation();
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBe(draftId);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const created = projection.nodes.find((node) => node.id === createdRowId);
      return {
        inlineTargetText: projection.nodes.find((node) => (
          node.id === (created?.content.inlineRefs[0] ? e2eInlineRefNodeId(created.content.inlineRefs[0]) : null)
        ))?.content.text ?? '',
        text: created?.content.text ?? null,
        type: created?.type ?? null,
      };
    }).toEqual({ inlineTargetText: 'RemoteTarget', text: '!', type: null });
    await expect(rowBody(page, createdRowId!)).toHaveClass(/ref-converting/);
    await expect(rowEditor(page, createdRowId!)).toBeFocused();
    await expect(row(page, createdRowId!)).toContainText('RemoteTarget');
    expect(await rowEditor(page, draftId).evaluate((element) => (
      (window as Window & { __referenceDraftEditor?: Element }).__referenceDraftEditor === element
    ))).toBe(true);

    expect((await appliedOperations(page, beforeCalls)).filter((operation) => operation.op === 'create'))
      .toHaveLength(1);
  });

  test('@ replaces an existing empty row before the Runtime mutation settles', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.library,
      index: null,
      text: 'RemoteTarget',
    });
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: '',
    });
    const emptyRowId = await lastTodayChildId(page);
    expect(emptyRowId).toBeTruthy();
    const beforeChildren = await todayChildren(page);

    await rowEditor(page, emptyRowId!).click();
    await page.keyboard.type('@RemoteTarget');
    await expect(page.getByRole('option', { name: 'RemoteTarget', exact: true })).toBeVisible();
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });
    await page.keyboard.press('Enter');

    await expect(row(page, emptyRowId!)).toHaveCount(0);
    const pendingRow = page.locator('[data-node-id]').filter({
      has: page.locator('.inline-ref', { hasText: 'RemoteTarget' }),
    }).first();
    const pendingId = await pendingRow.getAttribute('data-node-id');
    expect(pendingId).toBeTruthy();
    await expect(rowBody(page, pendingId!)).toHaveClass(/ref-converting/);
    await expect(rowEditor(page, pendingId!)).toBeFocused();
    expect(await todayChildren(page)).toEqual(beforeChildren);
    await page.keyboard.type('!');
    await expect(rowEditor(page, pendingId!)).toContainText('RemoteTarget');
    await expect(rowEditor(page, pendingId!)).toContainText('!');

    await releaseMutation();
    await expect.poll(async () => (await todayChildren(page)).at(-1)).toBe(pendingId);
    await expect.poll(async () => (await nodeById(page, pendingId!))?.content.text).toBe('!');
    await expect(rowEditor(page, pendingId!)).toBeFocused();
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
    await chooseSelectedReferenceSuggestion(page);
    await page.keyboard.type('test');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const createdRowId = await lastTodayChildId(page);
    expect(createdRowId).toBeTruthy();
    await expect.poll(async () => nodeById(page, createdRowId!)).toMatchObject({
      content: {
        text: 'test',
        inlineRefs: [e2eNodeInlineRef(0, targetId!)],
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
        inlineRefs: [e2eNodeInlineRef(4, ids.alpha, 'Alpha')],
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
        && node.content.inlineRefs.some((ref) => e2eInlineRefNodeId(ref) === zetaId)
      ))?.id ?? '';
      return Boolean(zetaId && inlineRowId);
    }).toBe(true);
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
    await expect(rowBody(page, inlineRowId)).toHaveClass(/ref-converting/);
    await expect(row(page, inlineRowId).locator('.row-bullet-shape.reference')).toHaveCount(1);

    let replacementCreates = (await appliedOperations(page)).filter((operation) => (
      operation.op === 'create'
      && (operation.nodes as Array<{ content?: { inlineRefs?: unknown[] } }> | undefined)
        ?.some((draft) => (draft.content?.inlineRefs?.length ?? 0) === 1)
    ));
    expect(replacementCreates).toHaveLength(1);

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
      inlineRefs: [e2eNodeInlineRef(0, zetaId)],
    });

    replacementCreates = (await appliedOperations(page)).filter((operation) => (
      operation.op === 'create'
      && (operation.nodes as Array<{ content?: { inlineRefs?: unknown[] } }> | undefined)
        ?.some((draft) => (draft.content?.inlineRefs?.length ?? 0) === 1)
    ));
    expect(replacementCreates).toHaveLength(1);
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
        && node.content.inlineRefs.some((ref) => e2eInlineRefNodeId(ref) === targetId)
      ))?.id ?? '';
      return inlineRowId;
    }).not.toBe('');
    await expect(rowEditor(page, inlineRowId)).toBeFocused();

    await page.keyboard.press('Backspace');
    await expect.poll(async () => nodeById(page, inlineRowId)).toMatchObject({
      content: {
        text: '',
        inlineRefs: [e2eNodeInlineRef(0, targetId!)],
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

    expect((await appliedOperations(page, beforeCalls)).filter((operation) => operation.op === 'create'))
      .toHaveLength(1);
    expect((await appliedInstructions(page, beforeCalls)).filter((instruction) => (
      instruction.kind === 'reference' && instruction.action === 'restore'
    ))).toHaveLength(1);
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
    await chooseSelectedReferenceSuggestion(page);
    await page.keyboard.type('test');

    let inlineRowId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      inlineRowId = projection.nodes.find((node) => (
        node.id !== emptyRowId
        && !node.type
        && node.content.inlineRefs.some((ref) => e2eInlineRefNodeId(ref) === targetId)
      ))?.id ?? '';
      return inlineRowId;
    }).not.toBe('');
    await expect.poll(async () => nodeById(page, inlineRowId)).toMatchObject({
      content: {
        text: 'test',
        inlineRefs: [e2eNodeInlineRef(0, targetId!)],
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
    await trailingEditor(page).click();
    await page.keyboard.type('@RemoteTarget');
    await chooseSelectedReferenceSuggestion(page);

    let inlineRowId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      inlineRowId = projection.nodes.find((node) => (
        !node.type
        && node.content.inlineRefs.some((ref) => e2eInlineRefNodeId(ref) === targetId)
      ))?.id ?? '';
      return inlineRowId;
    }).not.toBe('');
    await expect(rowEditor(page, inlineRowId)).toBeFocused();

    const editor = rowEditor(page, inlineRowId);
    const patchCountBeforeComposition = await appliedTextPatchCount(page);
    await dispatchCompositionEvent(editor, 'compositionstart');
    await page.keyboard.insertText('嗯么');
    await expect.poll(() => appliedTextPatchCount(page)).toBe(patchCountBeforeComposition);
    await dispatchCompositionEvent(editor, 'compositionend', '嗯么');

    await expect.poll(async () => nodeById(page, inlineRowId)).toMatchObject({
      content: {
        text: '嗯么',
        inlineRefs: [e2eNodeInlineRef(0, targetId!)],
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
    await chooseSelectedReferenceSuggestion(page);
    await page.keyboard.type('test');

    await expect.poll(async () => nodeById(page, ids.alpha)).toMatchObject({
      content: { text: 'Alpha' },
    });
    await expect.poll(async () => nodeById(page, emptyRowId!)).toMatchObject({
      content: {
        text: ' test',
        inlineRefs: [e2eNodeInlineRef(0, ids.alpha, 'Alpha')],
      },
    });
    await expect(rowEditor(page, emptyRowId!)).toBeFocused();

    expect((await appliedInstructions(page)).some((instruction) => (
      instruction.kind === 'reference' && instruction.action === 'inline'
    ))).toBe(false);
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
    await chooseSelectedReferenceSuggestion(page);
    await expect(editor).toBeFocused();

    const patchCountBeforeComposition = await appliedTextPatchCount(page);
    await dispatchCompositionEvent(editor, 'compositionstart');
    await page.keyboard.insertText('你好');
    await expect.poll(() => appliedTextPatchCount(page)).toBe(patchCountBeforeComposition);
    await dispatchCompositionEvent(editor, 'compositionend', '你好');

    await expect.poll(async () => nodeById(page, ids.alpha)).toMatchObject({
      content: { text: 'Alpha' },
    });
    await expect.poll(async () => nodeById(page, emptyRowId!)).toMatchObject({
      content: {
        text: ' 你好',
        inlineRefs: [e2eNodeInlineRef(0, ids.alpha, 'Alpha')],
      },
    });
    await expect(row(page, emptyRowId!).locator('.inline-ref')).toHaveText('Alpha');
  });

  test('@ inline reference insertion leaves the caret after the inserted reference', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: '',
    });
    const nodeId = await lastTodayChildId(page);
    expect(nodeId).toBeTruthy();

    await rowEditor(page, nodeId!).click();
    await page.keyboard.type('See @Al');
    await chooseSelectedReferenceSuggestion(page);
    await expect(rowEditor(page, nodeId!)).toBeFocused();

    await page.keyboard.type('!');
    await expect.poll(async () => {
      const node = await nodeById(page, nodeId!);
      return node?.content;
    }).toMatchObject({
      text: 'See  !',
      inlineRefs: [e2eNodeInlineRef(4, ids.alpha, 'Alpha')],
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

    await expect.poll(async () => (await appliedInstructions(page)).some((instruction) => (
      instruction.kind === 'field' && instruction.action === 'convert'
    ))).toBe(true);
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  });

  test('/field switches a trailing draft to the shared field transaction before Runtime settles', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('/field');
    const draftId = await editor.evaluate((element) => (
      element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? ''
    ));
    expect(draftId).not.toBe('');
    const beforeCalls = (await commandCalls(page)).length;
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });

    await page.getByRole('option', { name: /Field/ }).click();

    const firstFrame = await page.evaluate(({ beforeCalls, beforeChildren, draftId, todayId }) => {
      const win = window as Window & {
        __LIN_E2E__?: {
          calls: unknown[];
          projection: () => { nodes: Array<{ id: string; children: string[] }> };
        };
      };
      const fieldName = document.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(draftId)}"] .field-name-input`,
      );
      return {
        fieldVisible: fieldName !== null,
        focused: document.activeElement === fieldName,
        projectedChildren: win.__LIN_E2E__?.projection().nodes
          .find((node) => node.id === todayId)?.children,
        writes: (win.__LIN_E2E__?.calls.slice(beforeCalls) ?? []).filter((call) => {
          const command = (call as { cmd?: string }).cmd;
          return command === 'outline/apply' || command === 'outline/transact';
        }),
        expectedChildren: beforeChildren,
      };
    }, { beforeCalls, beforeChildren, draftId, todayId: ids.today });
    expect(firstFrame).toEqual({
      fieldVisible: true,
      focused: true,
      projectedChildren: beforeChildren,
      writes: [],
      expectedChildren: beforeChildren,
    });
    await releaseMutation();
    await expect.poll(async () => (await nodeById(page, draftId))?.type).toBe('fieldEntry');
  });

  test('/code switches a trailing draft to the shared code transaction before Runtime settles', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('/code');
    const draftId = await editor.evaluate((element) => (
      element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? ''
    ));
    expect(draftId).not.toBe('');
    const beforeCalls = (await commandCalls(page)).length;
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });

    await page.getByRole('option', { name: /Code block/ }).click();

    const firstFrame = await page.evaluate(({ beforeCalls, beforeChildren, draftId, todayId }) => {
      const win = window as Window & {
        __LIN_E2E__?: {
          calls: unknown[];
          projection: () => { nodes: Array<{ id: string; children: string[] }> };
        };
      };
      const textarea = document.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(draftId)}"] .code-block-textarea`,
      );
      return {
        codeVisible: textarea !== null,
        focused: document.activeElement === textarea,
        projectedChildren: win.__LIN_E2E__?.projection().nodes
          .find((node) => node.id === todayId)?.children,
        calls: win.__LIN_E2E__?.calls.slice(beforeCalls),
        expectedChildren: beforeChildren,
      };
    }, { beforeCalls, beforeChildren, draftId, todayId: ids.today });
    expect(firstFrame).toEqual({
      codeVisible: true,
      focused: true,
      projectedChildren: beforeChildren,
      calls: [],
      expectedChildren: beforeChildren,
    });
    await releaseMutation();
    await expect.poll(async () => (await nodeById(page, draftId))?.type).toBe('codeBlock');
  });

  test('/heading clears through the shared transaction without remounting the editor', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('/heading');
    const draftId = await editor.evaluate((element) => {
      (window as Window & { __slashHeadingEditor?: Element }).__slashHeadingEditor = element;
      return element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? '';
    });
    expect(draftId).not.toBe('');
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });

    await page.getByRole('option', { name: /Heading/ }).click();

    const pendingEditor = rowEditor(page, draftId);
    await expect(pendingEditor).toHaveText('');
    await expect(pendingEditor).toBeFocused();
    expect(await pendingEditor.evaluate((element) => (
      (window as Window & { __slashHeadingEditor?: Element }).__slashHeadingEditor === element
    ))).toBe(true);
    expect(await todayChildren(page)).toEqual(beforeChildren);

    await releaseMutation();
    await expect.poll(async () => (await nodeById(page, draftId))?.content.text).toBe('');
    expect(await rowEditor(page, draftId).evaluate((element) => (
      (window as Window & { __slashHeadingEditor?: Element }).__slashHeadingEditor === element
    ))).toBe(true);
  });

  test('/checkbox keeps the trailing editor identity while the checkbox transaction settles', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    const editor = trailingEditor(page);
    await editor.click();
    await page.keyboard.type('/checkbox');
    const draftId = await editor.evaluate((element) => {
      (window as Window & { __slashCheckboxEditor?: Element }).__slashCheckboxEditor = element;
      return element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? '';
    });
    expect(draftId).not.toBe('');
    const beforeCalls = (await commandCalls(page)).length;
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });

    await page.getByRole('option', { name: /Checkbox/ }).click();

    const firstFrame = await page.evaluate(({ beforeCalls, beforeChildren, draftId, todayId }) => {
      const win = window as Window & {
        __slashCheckboxEditor?: Element;
        __LIN_E2E__?: {
          calls: unknown[];
          projection: () => { nodes: Array<{ id: string; children: string[] }> };
        };
      };
      const row = document.querySelector(`[data-node-id="${CSS.escape(draftId)}"]`);
      const checkbox = row?.querySelector<HTMLElement>('[role="checkbox"]');
      const currentEditor = row?.querySelector('.ProseMirror');
      return {
        checkboxVisible: checkbox !== null,
        checked: checkbox?.getAttribute('aria-checked'),
        sameEditor: win.__slashCheckboxEditor?.isConnected === true
          && currentEditor === win.__slashCheckboxEditor,
        projectedChildren: win.__LIN_E2E__?.projection().nodes
          .find((node) => node.id === todayId)?.children,
        calls: win.__LIN_E2E__?.calls.slice(beforeCalls),
        expectedChildren: beforeChildren,
      };
    }, { beforeCalls, beforeChildren, draftId, todayId: ids.today });
    expect(firstFrame).toEqual({
      checkboxVisible: true,
      checked: 'false',
      sameEditor: true,
      projectedChildren: beforeChildren,
      calls: [],
      expectedChildren: beforeChildren,
    });
    await releaseMutation();
    await expect.poll(async () => (await nodeById(page, draftId))?.completedAt).toBe(0);
  });

  test('title /checkbox updates content and checkbox state before Runtime settles', async ({ page }) => {
    await invokeMockCommand(page, 'create_node', {
      parentId: ids.today,
      index: null,
      text: 'Plain title',
    });
    const targetId = await lastTodayChildId(page);
    if (!targetId) throw new Error('missing title checkbox target');
    await row(page, targetId).getByRole('button', { name: 'Open' }).click();
    const panel = page.locator('.outline-panel-surface.active-panel');
    const titleEditor = panel.locator('.panel-title-editor .ProseMirror');
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('/checkbox');
    await titleEditor.evaluate((element) => {
      (window as Window & { __slashTitleEditor?: Element }).__slashTitleEditor = element;
    });
    const beforeCalls = (await commandCalls(page)).length;
    const releaseMutation = await holdOutlineMutation(page, { op: 'update', instructionKind: 'checkbox' });

    await page.getByRole('option', { name: /Checkbox/ }).click();

    const firstFrame = await page.evaluate(({ beforeCalls, nodeId }) => {
      const win = window as Window & {
        __slashTitleEditor?: Element;
        __LIN_E2E__?: {
          calls: unknown[];
          projection: () => { nodes: Array<{ id: string; content: { text: string }; completedAt?: number }> };
        };
      };
      const panel = document.querySelector('.outline-panel-surface.active-panel');
      const currentEditor = panel?.querySelector('.panel-title-editor .ProseMirror');
      const checkbox = panel?.querySelector<HTMLElement>('.panel-title-editor [role="checkbox"]');
      const projected = win.__LIN_E2E__?.projection().nodes.find((node) => node.id === nodeId);
      return {
        title: currentEditor?.textContent,
        checkboxVisible: checkbox !== null,
        checked: checkbox?.getAttribute('aria-checked'),
        sameEditor: win.__slashTitleEditor?.isConnected === true
          && currentEditor === win.__slashTitleEditor,
        projectedTitle: projected?.content.text,
        projectedCompletedAt: projected?.completedAt,
        calls: win.__LIN_E2E__?.calls.slice(beforeCalls),
      };
    }, { beforeCalls, nodeId: targetId });
    expect(firstFrame).toEqual({
      title: '',
      checkboxVisible: true,
      checked: 'false',
      sameEditor: true,
      projectedTitle: '/checkbox',
      projectedCompletedAt: undefined,
      calls: [],
    });
    await releaseMutation();
    await expect.poll(async () => {
      const target = await nodeById(page, targetId);
      return { content: target?.content.text, completedAt: target?.completedAt };
    }).toEqual({ content: '', completedAt: 0 });
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
          node.id === e2eInlineRefNodeId(ref)
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

  test('/ Reference opens local suggestions before an existing-row patch settles', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('/ref');
    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('/ref');
    const releaseMutation = await holdOutlineMutation(page, { op: 'update', instructionKind: 'content' });

    await page.keyboard.press('Enter');

    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await expect(rowEditor(page, ids.alpha)).toHaveText('@');
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('/ref');
    await releaseMutation();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('@');
  });

  test('title / Reference opens local suggestions before its patch settles', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();
    const panel = page.locator('.outline-panel-surface.active-panel');
    const titleEditor = panel.locator('.panel-title-editor .ProseMirror');
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('/ref');
    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('/ref');
    const releaseMutation = await holdOutlineMutation(page, { op: 'update', instructionKind: 'content' });

    await page.keyboard.press('Enter');

    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toBeVisible();
    await expect(titleEditor).toHaveText('@');
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('/ref');
    await releaseMutation();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('@');
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

    await expect.poll(async () => (await appliedInstructions(page)).some((instruction) => (
      instruction.kind === 'field' && instruction.action === 'convert'
    ))).toBe(true);
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

  test('field-name Tab relocation restores unclaimed focus after settlement', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const firstFieldId = await lastTodayChildId(page);
    if (!firstFieldId) throw new Error('missing first field');

    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const secondFieldId = await lastTodayChildId(page);
    if (!secondFieldId || secondFieldId === firstFieldId) throw new Error('missing second field');

    const secondFieldName = row(page, secondFieldId).locator('.field-name-input');
    await expect(secondFieldName).toBeFocused();
    const releaseRelocation = await holdOutlineMutation(page, { op: 'move' });
    await page.keyboard.press('Tab');

    await expect(secondFieldName).toBeFocused();
    await secondFieldName.evaluate((element) => (element as HTMLElement).blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

    await releaseRelocation();
    await expect.poll(async () => (await nodeById(page, secondFieldId))?.parentId).toBe(firstFieldId);
    await expect(page.locator(`[data-focus-node-id="${secondFieldId}"]:focus`)).toHaveCount(1);

    await page.keyboard.press('Shift+Tab');
    await expect.poll(async () => (await nodeById(page, secondFieldId))?.parentId).toBe(ids.today);
    await expect(page.locator(`[data-focus-node-id="${secondFieldId}"]:focus`)).toHaveCount(1);
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

  test('each adjacent field row reveals both separators on hover or focus', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const firstFieldId = await lastTodayChildId(page);
    if (!firstFieldId) throw new Error('missing first field');

    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const secondFieldId = await lastTodayChildId(page);
    if (!secondFieldId || secondFieldId === firstFieldId) throw new Error('missing second field');

    await expect.poll(() => fieldSeparatorContent(page, firstFieldId, '::after')).toBe('""');
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::before')).toBe('0');
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::after')).toBe('0');

    await row(page, firstFieldId).hover();
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::before')).toBe('1');
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::after')).toBe('1');
    await expect.poll(() => fieldSeparatorOpacity(page, secondFieldId, '::before')).toBe('0');
    await expect.poll(() => fieldSeparatorOpacity(page, secondFieldId, '::after')).toBe('0');

    await row(page, firstFieldId).locator('.field-name-input').focus();
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::before')).toBe('1');
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::after')).toBe('1');

    await row(page, secondFieldId).hover();
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::before')).toBe('0');
    await expect.poll(() => fieldSeparatorOpacity(page, firstFieldId, '::after')).toBe('0');
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
      const ordinaryChildren = fieldEntry?.children ?? [];
      nestedFieldId = ordinaryChildren.at(-1);
      const nestedField = projection.nodes.find((node) => node.id === nestedFieldId);
      return {
        childCount: ordinaryChildren.length,
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

    await page.keyboard.press('Escape');
    await expect(rowBody(page, valueId)).toHaveClass(/selected/);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(async () => (await nodeById(page, valueId))?.parentId).toBe(fieldId);
  });

  test('checkbox field values use the shared mark and row keyboard contract', async ({ page }) => {
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

    await checkbox.evaluate((element) => {
      (window as Window & { __checkboxFieldControl?: Element }).__checkboxFieldControl = element;
    });
    const beforeToggleCalls = (await commandCalls(page)).length;
    const releaseMutation = await holdOutlineMutation(page, { op: 'update', instructionKind: 'field-slot' });
    await checkbox.click();
    const firstFrame = await page.evaluate((input) => {
      const win = window as Window & {
        __checkboxFieldControl?: Element;
        __LIN_E2E__?: {
          calls: unknown[];
          projection: () => { nodes: Array<{ id: string; children: string[] }> };
        };
      };
      const element = win.__checkboxFieldControl;
      return {
        checked: element?.querySelector('.checkbox-mark')?.classList.contains('checked') === true,
        sameElement: element?.isConnected === true
          && document.querySelector(`[data-node-id="${CSS.escape(input.fieldId)}"] [role="checkbox"]`) === element,
        children: win.__LIN_E2E__?.projection().nodes.find((node) => node.id === input.fieldId)?.children,
        calls: win.__LIN_E2E__?.calls.slice(input.beforeToggleCalls),
      };
    }, { fieldId, beforeToggleCalls });
    expect(firstFrame).toEqual({
      checked: true,
      sameElement: true,
      children: [],
      calls: [],
    });
    await releaseMutation();
    let valueId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const value = projection.nodes.find((node) => node.parentId === fieldId);
      valueId = value?.id ?? '';
      return value?.content.text;
    }).toBe('true');

    const valueRow = rowBody(page, valueId);
    const storedCheckbox = valueRow.getByRole('checkbox');
    await expect(storedCheckbox).toBeFocused();
    expect(await storedCheckbox.evaluate((element) => (
      (window as Window & { __checkboxFieldControl?: Element }).__checkboxFieldControl === element
    ))).toBe(true);
    await expect(valueRow.locator(':scope > .row-leading')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(valueRow).toHaveClass(/selected/);
    await expect(storedCheckbox).not.toBeFocused();

    await storedCheckbox.focus();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(valueRow).toHaveClass(/selected/);

    const childrenBeforeNextField = await todayChildren(page);
    await invokeMockCommand(page, 'create_inline_field', {
      parentId: ids.today,
      index: null,
      name: 'Next field',
      fieldType: 'plain',
    });
    let nextFieldId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const nextField = projection.nodes.find((node) => (
        node.parentId === ids.today
        && node.type === 'fieldEntry'
        && !childrenBeforeNextField.includes(node.id)
      ));
      nextFieldId = nextField?.id ?? '';
      return nextFieldId;
    }).not.toBe('');

    await storedCheckbox.focus();
    await page.keyboard.press('ArrowUp');
    await expect(row(page, fieldId).locator('.field-name-input')).toBeFocused();

    await storedCheckbox.focus();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, nextFieldId).locator('.field-name-input')).toBeFocused();
    await expect(trailingEditor(page, fieldId)).toHaveCount(0);

    await valueRow.hover();
    await valueRow.locator(':scope > .row-leading > .row-chevron-button').click();
    const childDraft = trailingEditor(page, valueId);
    await expect(childDraft).toBeFocused();
    await childDraft.type('Boolean detail');

    let childId = '';
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const child = projection.nodes.find((node) => node.parentId === valueId);
      childId = child?.id ?? '';
      return child?.content.text;
    }).toBe('Boolean detail');
    await expect(row(page, childId)).toBeVisible();
    await expect(storedCheckbox).toHaveAttribute('aria-checked', 'true');
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
    const editor = priorityValueEditor(page);
    await editor.click();
    const pendingValueId = await editor.evaluate((element) => (
      element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? ''
    ));
    expect(pendingValueId).not.toBe('');
    const beforeChildren = (await nodeById(page, ids.priorityEntry))?.children ?? [];

    const listbox = page.getByRole('listbox', { name: 'Field options' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'High' })).toBeVisible();

    const releaseSelection = await holdOutlineMutation(page, {
      op: 'update',
      instructionKind: 'field-slot',
    });
    await listbox.getByRole('option', { name: 'Low' }).click();
    await expect(valuePreview).toHaveText(/Low/);
    await expect(row(page, pendingValueId).locator('.reference-row')).toBeVisible();
    await expect(priorityValueEditor(page)).toBeFocused();
    expect((await nodeById(page, ids.priorityEntry))?.children ?? []).toEqual(beforeChildren);

    await releaseSelection();
    await expect.poll(async () => (await nodeById(page, ids.priorityEntry))?.children).toContain(pendingValueId);
    await expect(priorityValueEditor(page)).toBeFocused();
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
    const beforeChildren = (await nodeById(page, ids.priorityEntry))?.children ?? [];
    const releaseSelection = await holdOutlineMutation(page, {
      op: 'update',
      instructionKind: 'field-slot',
    });
    await page.keyboard.press('Enter');

    await expect(listbox).toHaveCount(0);
    await expect(valuePreview).toHaveText(/High/);
    const pendingHigh = valuePreview.locator('.row.reference-row').filter({ hasText: 'High' }).last();
    const highValueId = await pendingHigh.evaluate((element) => (
      element.parentElement?.dataset.nodeId ?? ''
    ));
    expect(highValueId).not.toBe('');
    expect((await nodeById(page, ids.priorityEntry))?.children ?? []).toEqual(beforeChildren);
    await expect(rowBody(page, valueId)).toHaveClass(/ref-click-selected/);

    await releaseSelection();
    await expect.poll(async () => (await nodeById(page, ids.priorityEntry))?.children).toContain(highValueId);
    await expect(rowBody(page, valueId)).toHaveClass(/ref-click-selected/);
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
    // The default layout is a single pane.
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
            Promise<{ focus?: { nodeId: string }; update?: { projection?: unknown } }>;
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
      const projection = reused.update?.projection ?? created.update?.projection;
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

test.describe('outliner plain field reference values', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { relatedField: true });
  });

  test('plain field creates a whole-row reference through the normal @ trigger', async ({ page }) => {
    await trailingEditor(page, ids.referencesEntry).click();
    await page.keyboard.type('@Alpha');
    const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'Alpha', exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Reference suggestions' })).toHaveCount(0);

    // The field slot stores a structural reference directly; leaving the row
    // does not require an inline-reference conversion round trip.
    await rowEditor(page, ids.beta).click();

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

    const slotInstructions = (await appliedInstructions(page)).filter((instruction) => (
      instruction.kind === 'field-slot'
      && (instruction.mutation as Record<string, unknown> | undefined)?.action === 'append-reference'
    ));
    expect(slotInstructions).toHaveLength(1);
    expect(slotInstructions[0]).toMatchObject({
      field: { target: { selector: { by: 'id', id: ids.referencesField } } },
      mutation: {
        action: 'append-reference',
        entryId: ids.referencesEntry,
        target: { target: { selector: { by: 'id', id: ids.alpha } } },
      },
    });
  });

  test('plain field stores an inline reference inside text', async ({ page }) => {
    await trailingEditor(page, ids.referencesEntry).click();
    await page.keyboard.type('See @Beta');
    const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: 'Beta', exact: true }).click();

    await expect.poll(async () => (await appliedInstructions(page)).filter((instruction) => (
      instruction.kind === 'field-slot'
      && (instruction.mutation as Record<string, unknown> | undefined)?.action === 'append-nodes'
    )).map((instruction) => {
      const mutation = instruction.mutation as Record<string, unknown>;
      return {
        entryId: mutation.entryId,
        kind: mutation.action,
        nodes: mutation.nodes,
      };
    })).toEqual([
      {
        entryId: ids.referencesEntry,
        kind: 'append-nodes',
        nodes: [{
          children: [],
          content: {
            inlineRefs: [{
              displayName: 'Beta',
              offset: 4,
              target: { kind: 'node', nodeId: ids.beta },
            }],
            marks: [],
            text: 'See  ',
          },
        }],
      },
    ]);

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const valueNode = projection.nodes.find((node) => node.parentId === ids.referencesEntry);
      return {
        type: valueNode?.type ?? 'content',
        text: valueNode?.content.text,
        targetId: valueNode?.content.inlineRefs[0] ? e2eInlineRefNodeId(valueNode.content.inlineRefs[0]) : undefined,
      };
    }).toEqual({ type: 'content', text: 'See  ', targetId: ids.beta });

    const valueCell = row(page, ids.referencesEntry).locator('.field-value-cell');
    await expect(valueCell.locator('.inline-ref')).toHaveCount(1);
    await expect(valueCell).toContainText('See Beta');
  });
});

test.describe('tag-projected field slot interactions', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { optionsField: true });
  });

  test('keeps inherited defaults out of the edit target and materializes them only from accept', async ({ page }) => {
    const alphaSlotId = await projectFieldFromTag(page, ids.alpha, ids.statusField, 'plain');
    const beforeDefault = await e2eProjection(page);
    const templateEntryId = beforeDefault.nodes.find((node) => (
      node.parentId === ids.projectTag
      && node.type === 'fieldEntry'
      && node.fieldDefId === ids.statusField
    ))?.id;
    expect(templateEntryId).toBeTruthy();

    await invokeMockCommand(page, 'create_node', {
      parentId: templateEntryId,
      index: null,
      text: 'Inbox',
    });

    const ghost = row(page, alphaSlotId).locator('.field-value-inherited-default');
    const emptyEditor = row(page, alphaSlotId).locator('.row-editor.is-empty').first();
    await expect(ghost).toHaveText('Inbox');
    await expect(ghost).toHaveCSS('pointer-events', 'none');
    await expect(emptyEditor).toHaveAttribute('data-placeholder', 'Empty');
    await expect.poll(() => emptyEditor.evaluate((element) => (
      getComputedStyle(element, '::before').content
    ))).toBe('none');
    await expect.poll(() => storedFieldEntryId(page, ids.alpha, ids.statusField)).toBeUndefined();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const colors = await ghost.evaluate((element) => ({
        actual: getComputedStyle(element).color,
        expected: (() => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--text-tertiary)';
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        })(),
      }));
      expect(colors.actual).toBe(colors.expected);
    }

    const valueEditor = trailingEditor(page, alphaSlotId);
    await valueEditor.click();
    await expect(valueEditor).toBeFocused();
    await expect(ghost).toHaveCSS('visibility', 'hidden');
    await expect.poll(() => emptyEditor.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return {
        content: style.content,
        opacity: style.opacity,
        placeholder: JSON.stringify(element.getAttribute('data-placeholder') ?? ''),
      };
    })).toEqual({ content: '"Empty"', opacity: '1', placeholder: '"Empty"' });
    await expect.poll(() => storedFieldEntryId(page, ids.alpha, ids.statusField)).toBeUndefined();
    await page.keyboard.type('Blocked');
    await expect.poll(() => storedFieldEntryId(page, ids.alpha, ids.statusField)).toBeUndefined();
    const valueId = await valueEditor.evaluate((element) => (
      element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? ''
    ));
    expect(valueId).not.toBe('');
    const releaseMaterialization = await holdOutlineMutation(page, {
      op: 'update',
      instructionKind: 'field-slot',
    });
    await page.keyboard.press('Enter');

    const pendingValueEditor = rowEditor(page, valueId);
    const nextDraftEditor = trailingEditor(page, alphaSlotId);
    await expect(pendingValueEditor).toHaveText('Blocked');
    await expect(nextDraftEditor).toBeFocused();
    await nextDraftEditor.evaluate((element) => {
      (window as Window & { __fieldValueContinuation?: Element }).__fieldValueContinuation = element;
    });
    expect(await storedFieldEntryId(page, ids.alpha, ids.statusField)).toBeUndefined();
    await releaseMaterialization();

    let alphaEntryId = '';
    await expect.poll(async () => {
      alphaEntryId = await storedFieldEntryId(page, ids.alpha, ids.statusField) ?? '';
      return alphaEntryId;
    }).not.toBe('');
    await expect(trailingEditor(page, alphaEntryId)).toBeFocused();
    expect(await trailingEditor(page, alphaEntryId).evaluate((element) => (
      (window as Window & { __fieldValueContinuation?: Element }).__fieldValueContinuation === element
    ))).toBe(true);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === alphaEntryId);
      return entry?.children.map((childId) => projection.nodes.find((node) => node.id === childId)?.content.text);
    }).toEqual(['Blocked']);

    await invokeMockCommand(page, 'apply_tag', { nodeId: ids.beta, tagId: ids.projectTag });
    await rowBody(page, ids.beta).hover();
    await row(page, ids.beta).getByRole('button', { name: 'Expand' }).click();
    const betaSlotId = projectedFieldSlotId(ids.beta, ids.statusField);
    await expect(row(page, betaSlotId).locator('.field-value-inherited-default')).toHaveText('Inbox');

    await row(page, betaSlotId).hover();
    await row(page, betaSlotId)
      .getByRole('button', { name: 'Accept inherited default: Inbox' })
      .click();
    let betaEntryId = '';
    await expect.poll(async () => {
      betaEntryId = await storedFieldEntryId(page, ids.beta, ids.statusField) ?? '';
      return betaEntryId;
    }).not.toBe('');
    await expect(row(page, betaSlotId).locator('.field-value-inherited-default')).toHaveCount(0);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === betaEntryId);
      return entry?.children.map((childId) => projection.nodes.find((node) => node.id === childId)?.content.text);
    }).toEqual(['Inbox']);
  });

  test('renders an inherited checkbox default as an editable checkbox', async ({ page }) => {
    await invokeMockCommand(page, 'create_inline_field', {
      parentId: ids.projectTag,
      index: null,
      name: 'Ready',
      fieldType: 'checkbox',
    });
    const templateProjection = await e2eProjection(page);
    const templateEntry = templateProjection.nodes.find((node) => (
      node.parentId === ids.projectTag
      && node.type === 'fieldEntry'
      && node.fieldDefId !== ids.statusField
    ));
    expect(templateEntry?.fieldDefId).toBeTruthy();
    await invokeMockCommand(page, 'create_node', {
      parentId: templateEntry!.id,
      index: null,
      text: 'true',
    });
    await invokeMockCommand(page, 'apply_tag', { nodeId: ids.alpha, tagId: ids.projectTag });
    await rowBody(page, ids.alpha).hover();
    await row(page, ids.alpha).getByRole('button', { name: 'Expand' }).click();

    const slotId = projectedFieldSlotId(ids.alpha, templateEntry!.fieldDefId!);
    const checkbox = row(page, slotId).getByRole('checkbox');
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, slotId).locator('.field-value-inherited-default')).toHaveCount(0);
    await expect.poll(() => storedFieldEntryId(page, ids.alpha, templateEntry!.fieldDefId!)).toBeUndefined();

    await checkbox.click();
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => {
      const entryId = await storedFieldEntryId(page, ids.alpha, templateEntry!.fieldDefId!);
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === entryId);
      return entry?.children.map((childId) => projection.nodes.find((node) => node.id === childId)?.content.text);
    }).toEqual(['false']);
  });

  test('virtual slots materialize nested fields, tags, and code blocks through field-slot commands', async ({ page }) => {
    const alphaSlot = await projectFieldFromTag(page, ids.alpha, ids.statusField, 'plain');
    const alphaEditor = trailingEditor(page, alphaSlot);
    await alphaEditor.click();
    const pendingNestedFieldId = await alphaEditor.evaluate((element) => (
      element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? ''
    ));
    expect(pendingNestedFieldId).not.toBe('');
    const releaseMaterialization = await holdOutlineMutation(page, {
      op: 'update',
      instructionKind: 'field-slot',
    });
    await page.keyboard.type('>');

    const pendingFieldName = row(page, pendingNestedFieldId).locator('.field-name-input');
    await expect(pendingFieldName).toBeVisible();
    await expect(pendingFieldName).toBeFocused();
    await pendingFieldName.evaluate((element) => {
      (window as Window & { __nestedFieldName?: Element }).__nestedFieldName = element;
    });
    expect(await storedFieldEntryId(page, ids.alpha, ids.statusField)).toBeUndefined();
    await releaseMaterialization();

    let nestedFieldId = '';
    await expect.poll(async () => {
      const entryId = await storedFieldEntryId(page, ids.alpha, ids.statusField);
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === entryId);
      const nested = projection.nodes.find((node) => (
        node.parentId === entryId && node.type === 'fieldEntry'
      ));
      nestedFieldId = nested?.id ?? '';
      return nestedFieldId;
    }).not.toBe('');
    expect(nestedFieldId).toBe(pendingNestedFieldId);
    await expect(row(page, nestedFieldId).locator('.field-name-input')).toBeFocused();
    expect(await row(page, nestedFieldId).locator('.field-name-input').evaluate((element) => (
      (window as Window & { __nestedFieldName?: Element }).__nestedFieldName === element
    ))).toBe(true);
    await page.keyboard.type('Nested');
    await page.keyboard.press('Escape');

    const betaSlot = await projectFieldFromTag(page, ids.beta, ids.statusField, 'plain');
    await trailingEditor(page, betaSlot).click();
    await page.keyboard.type('#project');
    const tags = page.getByRole('listbox', { name: 'Tag suggestions' });
    await expect(tags.getByRole('option', { name: 'project', exact: true })).toBeVisible();
    await tags.getByRole('option', { name: 'project', exact: true }).click();

    await expect.poll(async () => {
      const entryId = await storedFieldEntryId(page, ids.beta, ids.statusField);
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.parentId === entryId)?.tags;
    }).toContain(ids.projectTag);

    const gammaSlot = await projectFieldFromTag(page, ids.gamma, ids.statusField, 'plain');
    await trailingEditor(page, gammaSlot).click();
    await page.keyboard.type('/code');
    const slash = page.getByRole('listbox', { name: 'Slash commands' });
    await expect(slash.getByRole('option', { name: 'Code block' })).toBeVisible();
    await slash.getByRole('option', { name: 'Code block' }).click();

    let codeId = '';
    await expect.poll(async () => {
      const entryId = await storedFieldEntryId(page, ids.gamma, ids.statusField);
      const projection = await e2eProjection(page);
      const code = projection.nodes.find((node) => node.parentId === entryId && node.type === 'codeBlock');
      codeId = code?.id ?? '';
      return codeId;
    }).not.toBe('');
    const codeMutation = (await appliedInstructions(page)).find((instruction) => (
      instruction.kind === 'field-slot'
      && (instruction.mutation as Record<string, unknown> | undefined)?.action === 'append-nodes'
      && (instruction.mutation as Record<string, unknown> | undefined)?.id === codeId
    ));
    expect(codeMutation).toBeTruthy();
    await expect(row(page, codeId).locator('.code-block-textarea')).toBeFocused();

    expect((await appliedInstructions(page)).filter((instruction) => instruction.kind === 'field-slot')
      .map((instruction) => (instruction.mutation as Record<string, unknown>).action))
      .toEqual(expect.arrayContaining(['append-field', 'append-nodes']));
  });

  test('reference and option picks focus the trailing draft under the materialized entry', async ({ page }) => {
    const alphaSlot = await projectFieldFromTag(page, ids.alpha, ids.statusField, 'plain');
    await trailingEditor(page, alphaSlot).click();
    await page.keyboard.type('@Beta');
    const references = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(references.getByRole('option', { name: 'Beta', exact: true })).toBeVisible();
    await references.getByRole('option', { name: 'Beta', exact: true }).click();

    let statusEntryId = '';
    await expect.poll(async () => {
      statusEntryId = await storedFieldEntryId(page, ids.alpha, ids.statusField) ?? '';
      return statusEntryId;
    }).not.toBe('');
    expect((await appliedInstructions(page)).some((instruction) => {
      const field = instruction.field as { target?: { selector?: { id?: string } } } | undefined;
      const mutation = instruction.mutation as {
        action?: string;
        target?: { target?: { selector?: { id?: string } } };
      } | undefined;
      return instruction.kind === 'field-slot'
        && field?.target?.selector?.id === ids.statusField
        && mutation?.action === 'append-reference'
        && mutation.target?.target?.selector?.id === ids.beta;
    })).toBe(true);
    await expect(trailingEditor(page, statusEntryId)).toBeFocused();

    const betaSlot = await projectFieldFromTag(page, ids.beta, ids.priorityField, 'options');
    await trailingEditor(page, betaSlot).click();
    const options = page.getByRole('listbox', { name: 'Field options' });
    await expect(options.getByRole('option', { name: 'Low', exact: true })).toBeVisible();
    await options.getByRole('option', { name: 'Low', exact: true }).click();

    let priorityEntryId = '';
    await expect.poll(async () => {
      priorityEntryId = await storedFieldEntryId(page, ids.beta, ids.priorityField) ?? '';
      return priorityEntryId;
    }).not.toBe('');
    await expect(trailingEditor(page, priorityEntryId)).toBeFocused();
  });

  test('clipboard files preserve typed text and append under the real field entry', async ({ page }) => {
    const alphaSlot = await projectFieldFromTag(page, ids.alpha, ids.statusField, 'plain');
    await trailingEditor(page, alphaSlot).click();
    await page.keyboard.type('Caption');
    await pasteClipboardFile(page, {
      name: 'field-image.png',
      mimeType: 'image/png',
      text: 'mock png bytes',
    });

    let alphaEntryId = '';
    await expect.poll(async () => {
      alphaEntryId = await storedFieldEntryId(page, ids.alpha, ids.statusField) ?? '';
      return alphaEntryId;
    }).not.toBe('');
    await expect.poll(async () => (await appliedInstructions(page)).filter((instruction) => (
      instruction.kind === 'source'
      && instruction.action === 'add'
      && typeof instruction.sourceText === 'string'
      && instruction.sourceText.startsWith('asset://local/')
    )).length).toBe(1);

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === alphaEntryId);
      return (entry?.children ?? []).map((childId) => {
        const child = projection.nodes.find((node) => node.id === childId);
        const sourceEntry = sourceFieldEntries(projection, childId)[0];
        return {
          sourceCount: sourceEntry?.children.length ?? 0,
          text: child?.content.text,
          type: child?.type ?? 'content',
        };
      });
    }).toEqual([
      { sourceCount: 0, text: 'Caption', type: 'content' },
      { sourceCount: 1, text: 'field-image.png', type: 'content' },
    ]);

    const betaSlot = await projectFieldFromTag(page, ids.beta, ids.statusField, 'plain');
    await trailingEditor(page, betaSlot).click();
    await page.keyboard.type('Report');
    await pasteClipboardFile(page, {
      name: 'field-report.pdf',
      mimeType: 'application/pdf',
      text: '%PDF mock report',
    });

    let betaEntryId = '';
    await expect.poll(async () => {
      betaEntryId = await storedFieldEntryId(page, ids.beta, ids.statusField) ?? '';
      return betaEntryId;
    }).not.toBe('');
    await expect.poll(async () => (await appliedInstructions(page)).filter((instruction) => (
      instruction.kind === 'source'
      && instruction.action === 'add'
      && typeof instruction.sourceText === 'string'
      && instruction.sourceText.startsWith('asset://local/')
    )).length).toBe(2);

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === betaEntryId);
      return (entry?.children ?? []).map((childId) => {
        const child = projection.nodes.find((node) => node.id === childId);
        const sourceEntry = sourceFieldEntries(projection, childId)[0];
        return {
          sourceCount: sourceEntry?.children.length ?? 0,
          text: child?.content.text,
          type: child?.type ?? 'content',
        };
      });
    }).toEqual([
      { sourceCount: 0, text: 'Report', type: 'content' },
      { sourceCount: 1, text: 'field-report.pdf', type: 'content' },
    ]);
  });
});
