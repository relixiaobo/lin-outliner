import { expect, test, type Page } from '@playwright/test';
import {
  appliedOutlineOperations,
  commandCalls,
  e2eProjection,
  emitDocumentEvent,
  holdOutlineMutation,
  ids,
  nodeById,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

async function todayChildren(page: Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

async function emitCurrentProjection(page: Page) {
  await emitDocumentEvent(page, {
    type: 'projection_changed',
    origin: 'test',
    projection: await e2eProjection(page),
    timestamp: Date.now(),
  });
}

async function createOnlyEmptyContentRowFixture(page: Page) {
  await page.evaluate(async (ids) => {
    const win = window as Window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    await win.lin?.invoke('apply_node_text_patch', {
      nodeId: ids.alpha,
      patch: {
        ops: [{
          type: 'replace_all',
          content: { text: '', marks: [], inlineRefs: [] },
        }],
      },
    });
    await win.lin?.invoke('batch_trash_nodes', { nodeIds: [ids.beta, ids.gamma] });
  }, ids);
  await emitCurrentProjection(page);
}

async function placeCursor(page: Page, nodeId: string, placement: 'start' | 'end') {
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

async function waitForRowMoveAnimation(page: Page, id: string) {
  await expect.poll(async () => rowBody(page, id).evaluate((element) => (
    element.classList.contains('row-move-animating')
  )), { timeout: 1000 }).toBe(true);
}

async function waitForRowMoveAnimationToSettle(page: Page, id: string) {
  await expect.poll(async () => rowBody(page, id).evaluate((element) => (
    element.classList.contains('row-move-animating')
  ))).toBe(false);
}

async function placeCursorAtTextOffset(page: Page, nodeId: string, offset: number) {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await editor.evaluate((element, targetOffset) => {
    const selection = window.getSelection();
    const range = document.createRange();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = targetOffset;
    let target: Node | null = null;
    let targetNodeOffset = 0;

    while (true) {
      const next = walker.nextNode();
      if (!next) break;
      const length = next.textContent?.length ?? 0;
      if (remaining <= length) {
        target = next;
        targetNodeOffset = remaining;
        break;
      }
      remaining -= length;
    }

    if (target) {
      range.setStart(target, targetNodeOffset);
      range.collapse(true);
    } else {
      range.selectNodeContents(element);
      range.collapse(false);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, offset);
  await page.waitForTimeout(25);
}

async function selectEditorContents(page: Page, nodeId: string) {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await page.keyboard.press('Meta+A');
  await page.waitForTimeout(25);
}

async function pasteIntoFocusedEditor(page: Page, text: string) {
  await page.evaluate((pasteText) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasteText);
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }));
  }, text);
}

async function delayTextPatchCommands(page: Page, delayMs = 80) {
  await page.evaluate((delay) => {
    const bridge = window.lin?.outline;
    if (!bridge) throw new Error('Missing Outline bridge');
    const originalRequest = bridge.request;
    bridge.request = async (request) => {
      const input = request.input && typeof request.input === 'object'
        ? request.input as Record<string, unknown>
        : {};
      const changeSet = input.changeSet && typeof input.changeSet === 'object'
        ? input.changeSet as { operations?: Array<Record<string, unknown>> }
        : undefined;
      const isTextPatch = request.command === 'commit' && changeSet?.operations?.some((operation) => (
        operation.op === 'update'
        && Array.isArray(operation.changes)
        && operation.changes.some((change) => (
          change && typeof change === 'object' && (change as { kind?: unknown }).kind === 'text-patch'
        ))
      ));
      if (isTextPatch) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
      return originalRequest(request);
    };
  }, delayMs);
}

async function watchRowTextReplay(page: Page, nodeId: string, expectedText: string) {
  await page.evaluate(({ expected, id }) => {
    const win = window as unknown as {
      __linRowTextReplays?: string[];
      __linRowTextReplayCleanup?: () => void;
    };
    win.__linRowTextReplays = [];
    win.__linRowTextReplayCleanup?.();
    const target = document.querySelector(`[data-node-id="${id}"] .ProseMirror`);
    if (!target) throw new Error('Missing row editor');
    let sawExpected = false;
    const scan = () => {
      const text = target.textContent ?? '';
      if (text === expected) {
        sawExpected = true;
        return;
      }
      if (
        sawExpected
        && text !== expected
      ) {
        win.__linRowTextReplays?.push(text);
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(target, { childList: true, characterData: true, subtree: true });
    scan();
    win.__linRowTextReplayCleanup = () => observer.disconnect();
  }, { expected: expectedText, id: nodeId });
}

async function expectNoRowTextReplay(page: Page) {
  expect(await page.evaluate(() => {
    const win = window as unknown as {
      __linRowTextReplays?: string[];
      __linRowTextReplayCleanup?: () => void;
    };
    win.__linRowTextReplayCleanup?.();
    win.__linRowTextReplayCleanup = undefined;
    return win.__linRowTextReplays ?? [];
  })).toEqual([]);
}

async function createFieldValueChildrenFixture(page: Page) {
  const result = await page.evaluate(async (ids) => {
    const win = window as Window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    const field = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_inline_field', {
      parentId: ids.today,
      index: 1,
      name: 'Notes',
      fieldType: 'plain',
    });
    const entryId = field?.focus?.nodeId ?? '';
    const first = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
      parentId: entryId,
      index: null,
      text: 'First value',
    });
    const second = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
      parentId: entryId,
      index: null,
      text: 'Second value',
    });
    return {
      entryId,
      firstValueId: first?.focus?.nodeId ?? '',
      secondValueId: second?.focus?.nodeId ?? '',
    };
  }, ids);
  await emitCurrentProjection(page);
  return result;
}

async function createFieldReferenceChildrenFixture(page: Page) {
  const result = await page.evaluate(async (ids) => {
    const win = window as Window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    const target = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
      parentId: ids.library,
      index: null,
      text: 'Referenced value',
    });
    const targetId = target?.focus?.nodeId ?? '';
    const child = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
      parentId: targetId,
      index: null,
      text: 'Referenced child',
    });
    const field = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_inline_field', {
      parentId: ids.today,
      index: 1,
      name: 'Source',
      fieldType: 'plain',
    });
    const entryId = field?.focus?.nodeId ?? '';
    const reference = await win.lin?.invoke<{ focus?: { nodeId: string } }>('add_reference', {
      parentId: entryId,
      targetId,
      index: null,
    });
    return {
      childId: child?.focus?.nodeId ?? '',
      entryId,
      referenceId: reference?.focus?.nodeId ?? '',
      targetId,
    };
  }, ids);
  await emitCurrentProjection(page);
  return result;
}

test.describe('outliner row editing parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('Enter at the end of a row creates an empty sibling and focuses it', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    const originalTrailingEditor = trailingEditor(page);
    await expect(originalTrailingEditor).toHaveCount(1);
    await originalTrailingEditor.evaluate((element) => {
      (window as Window & { __originalTrailingEditor?: Element }).__originalTrailingEditor = element;
    });
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });
    await page.keyboard.press('Enter');

    const pendingEditor = page.locator('.row.node-pending-structure .ProseMirror:focus');
    await expect(pendingEditor).toHaveCount(1);
    await expect(page.locator('.row.node-draft')).toHaveCount(1);
    await expect(page.locator('.row.node-pending-structure')).toHaveCount(1);
    expect(await trailingEditor(page).evaluate((element) => (
      (window as Window & { __originalTrailingEditor?: Element }).__originalTrailingEditor === element
    ))).toBe(true);
    const pendingColors = await page.evaluate((alphaId) => {
      const pendingBullet = document.querySelector('.row.node-pending-structure .row-bullet-shape.content');
      const trailingBullet = document.querySelector('.row.node-draft .row-bullet-shape.content');
      const alphaBullet = document.querySelector(`[data-node-id="${alphaId}"] .row-bullet-shape.content`);
      if (!pendingBullet || !trailingBullet || !alphaBullet) throw new Error('missing optimistic bullet');
      return {
        alpha: getComputedStyle(alphaBullet).color,
        pending: getComputedStyle(pendingBullet).color,
        trailing: getComputedStyle(trailingBullet).color,
      };
    }, ids.alpha);
    expect(pendingColors.pending).toBe(pendingColors.alpha);
    expect(pendingColors.pending).not.toBe(pendingColors.trailing);
    expect(await todayChildren(page)).toEqual([ids.alpha, ids.beta, ids.gamma]);

    await releaseMutation();
    await expect.poll(async () => (await todayChildren(page)).length).toBe(4);
    const children = await todayChildren(page);
    const createdId = children[1];
    expect(createdId).toBeTruthy();
    expect((await nodeById(page, createdId))?.content.text).toBe('');
    await expect(rowEditor(page, createdId)).toBeFocused();
    await expect(page.locator('.row.node-draft')).toHaveCount(1);
    await expect(page.locator('.row.node-pending-structure')).toHaveCount(0);
    expect(await trailingEditor(page).evaluate((element) => (
      (window as Window & { __originalTrailingEditor?: Element }).__originalTrailingEditor === element
    ))).toBe(true);

    const placeholderStyle = await row(page, createdId).locator('.row-editor').first().evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return {
        display: style.display,
        opacity: Number(style.opacity),
      };
    });
    expect(placeholderStyle.display).not.toBe('none');
    expect(placeholderStyle.opacity).toBe(0);
  });

  test('Enter in the middle immediately shows the split head and keeps it after settlement', async ({ page }) => {
    await placeCursorAtTextOffset(page, ids.alpha, 2);
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });
    await page.keyboard.press('Enter');

    expect(await rowEditor(page, ids.alpha).textContent()).toBe('Al');
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('Alpha');
    const pendingEditor = page.locator('.row.node-pending-structure .ProseMirror').filter({ hasText: 'pha' });
    await expect(pendingEditor).toHaveCount(1);
    await expect(pendingEditor).toBeFocused();
    await releaseMutation();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Al');
    const children = await todayChildren(page);
    const splitId = children[children.indexOf(ids.alpha) + 1];
    expect((await nodeById(page, splitId))?.content.text).toBe('pha');
    await expect(rowEditor(page, ids.alpha)).toHaveText('Al');
    await expect(rowEditor(page, splitId)).toBeFocused();
  });

  test('typing into a pending split row survives settlement without remounting the editor', async ({ page }) => {
    await placeCursorAtTextOffset(page, ids.alpha, 2);
    const releaseMutation = await holdOutlineMutation(page, { op: 'create' });
    await page.keyboard.press('Enter');

    const pendingEditor = page.locator('.row.node-pending-structure .ProseMirror').filter({ hasText: 'pha' });
    await expect(pendingEditor).toBeFocused();
    await pendingEditor.evaluate((element) => {
      (window as Window & { __pendingSplitEditor?: Element }).__pendingSplitEditor = element;
    });
    await page.keyboard.type('x');

    await expect(pendingEditor).toHaveText('xpha');
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('Alpha');

    await releaseMutation();
    await expect.poll(async () => (await todayChildren(page)).length).toBe(4);
    const children = await todayChildren(page);
    const splitId = children[children.indexOf(ids.alpha) + 1];
    const settledEditor = rowEditor(page, splitId);
    await expect(settledEditor).toHaveText('xpha');
    await expect(settledEditor).toBeFocused();
    expect(await settledEditor.evaluate((element) => (
      (window as Window & { __pendingSplitEditor?: Element }).__pendingSplitEditor === element
    ))).toBe(true);
    await expect.poll(async () => (await nodeById(page, splitId))?.content.text).toBe('xpha');
  });

  test('Enter-created empty sibling uses the real node bullet immediately', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(4);
    const children = await todayChildren(page);
    const createdId = children[1];
    expect(createdId).toBeTruthy();
    await expect(rowEditor(page, createdId)).toBeFocused();

    const colors = await page.evaluate(({ createdIdArg, alphaId }) => {
      const createdBullet = document
        .querySelector(`[data-node-id="${createdIdArg}"] .row-bullet-shape.content`);
      const trailingBullet = document
        .querySelector('.row.node-draft .row-bullet-shape.content');
      const alphaBullet = document
        .querySelector(`[data-node-id="${alphaId}"] .row-bullet-shape.content`);
      if (!createdBullet || !trailingBullet || !alphaBullet) throw new Error('missing bullet');
      return {
        alpha: getComputedStyle(alphaBullet).color,
        created: getComputedStyle(createdBullet).color,
        trailing: getComputedStyle(trailingBullet).color,
      };
    }, { alphaId: ids.alpha, createdIdArg: createdId });

    expect(colors.created).toBe(colors.alpha);
    expect(colors.created).not.toBe(colors.trailing);
  });

  test('field value disclosure creates an ordinary child scope', async ({ page }) => {
    const { firstValueId } = await createFieldValueChildrenFixture(page);
    const valueRow = rowBody(page, firstValueId);
    const chevron = valueRow.locator(':scope > .row-leading > .row-chevron-button');

    await valueRow.hover();
    await expect.poll(() => chevron.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0.9);
    await chevron.click();

    const childDraft = trailingEditor(page, firstValueId);
    await expect(childDraft).toBeFocused();
    await childDraft.type('Nested child');

    let childId = '';
    await expect.poll(async () => {
      const value = await nodeById(page, firstValueId);
      childId = value?.children[0] ?? '';
      return childId ? await nodeById(page, childId) : null;
    }).toMatchObject({
      parentId: firstValueId,
      content: { text: 'Nested child' },
    });

    await expect(rowEditor(page, childId)).toBeFocused();
    await expect(page.locator(
      `.outliner-flat-guides .indent-guide[data-guide-node-id="${firstValueId}"]`,
    )).toHaveCount(1);

    await chevron.click({ force: true });
    await expect(row(page, childId)).toHaveCount(0);
    await chevron.click({ force: true });
    await expect(row(page, childId)).toBeVisible();
  });

  test('ArrowDown from an empty field-value child draft focuses the next field', async ({ page }) => {
    const { secondValueId } = await createFieldValueChildrenFixture(page);
    const followingEntryId = await page.evaluate(async (ids) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      const field = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_inline_field', {
        parentId: ids.today,
        index: 2,
        name: 'Following field',
        fieldType: 'plain',
      });
      return field?.focus?.nodeId ?? '';
    }, ids);
    await emitCurrentProjection(page);

    const valueRow = rowBody(page, secondValueId);
    await valueRow.hover();
    await valueRow.locator(':scope > .row-leading > .row-chevron-button').click();

    const childDraft = trailingEditor(page, secondValueId);
    await expect(childDraft).toBeFocused();
    await page.keyboard.press('ArrowDown');

    await expect(row(page, followingEntryId).locator('.field-name-input')).toBeFocused();
    await expect(trailingEditor(page)).not.toBeFocused();
  });

  test('field value Tab indents under the previous value and Shift+Tab promotes it back', async ({ page }) => {
    const { entryId, firstValueId, secondValueId } = await createFieldValueChildrenFixture(page);

    await placeCursor(page, secondValueId, 'end');
    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeById(page, secondValueId))?.parentId).toBe(firstValueId);
    await expect.poll(async () => (await nodeById(page, firstValueId))?.children).toEqual([secondValueId]);
    await expect(rowEditor(page, secondValueId)).toBeFocused();
    await expect(row(page, firstValueId)).toHaveClass(/expanded/);

    await page.keyboard.press('Shift+Tab');

    await expect.poll(async () => (await nodeById(page, secondValueId))?.parentId).toBe(entryId);
    await expect.poll(async () => (await nodeById(page, entryId))?.children).toEqual([firstValueId, secondValueId]);
    await expect(rowEditor(page, secondValueId)).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect.poll(async () => (await nodeById(page, secondValueId))?.parentId).toBe(entryId);
  });

  test('Tab materializes a buffered field value before indenting it', async ({ page }) => {
    const { entryId, secondValueId } = await createFieldValueChildrenFixture(page);

    await placeCursor(page, secondValueId, 'end');
    await page.keyboard.press('Enter');
    const valueDraft = trailingEditor(page, entryId);
    await expect(valueDraft).toBeFocused();
    await valueDraft.type('Buffered child');
    await valueDraft.evaluate((element) => {
      (window as Window & { __bufferedFieldEditor?: Element }).__bufferedFieldEditor = element;
    });
    const releaseMutation = await holdOutlineMutation(page);
    await page.keyboard.press('Tab');

    const optimisticChildEditor = page.locator(
      `[data-parent-id="${secondValueId}"] .ProseMirror`,
    ).filter({ hasText: 'Buffered child' });
    expect(await optimisticChildEditor.count()).toBe(1);
    expect(await optimisticChildEditor.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await optimisticChildEditor.evaluate((element) => (
      (window as Window & { __bufferedFieldEditor?: Element }).__bufferedFieldEditor === element
    ))).toBe(true);
    expect((await nodeById(page, secondValueId))?.children).toEqual([]);

    await releaseMutation();
    let childId = '';
    await expect.poll(async () => {
      const secondValue = await nodeById(page, secondValueId);
      childId = secondValue?.children[0] ?? '';
      return childId ? await nodeById(page, childId) : null;
    }).toMatchObject({
      parentId: secondValueId,
      content: { text: 'Buffered child' },
    });
    await expect(rowEditor(page, childId)).toBeFocused();
    expect(await rowEditor(page, childId).evaluate((element) => (
      (window as Window & { __bufferedFieldEditor?: Element }).__bufferedFieldEditor === element
    ))).toBe(true);
  });

  test('reference field values expand the referenced node children', async ({ page }) => {
    const { childId, referenceId } = await createFieldReferenceChildrenFixture(page);
    const referenceRow = rowBody(page, referenceId);
    const chevron = referenceRow.locator(':scope > .row-leading > .row-chevron-button');

    await referenceRow.hover();
    await chevron.click();

    await expect(row(page, childId)).toBeVisible();
    await expect(row(page, referenceId)).toHaveClass(/expanded/);
  });

  test('Enter at the start of an expanded parent creates a previous sibling without reparenting the subtree', async ({ page }) => {
    const childId = await page.evaluate(async (testIds) => {
      const win = window as Window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
        };
      };
      const outcome = await win.lin!.invoke<{ focus?: { nodeId: string } }>('create_node', {
        parentId: testIds.alpha,
        index: null,
        text: 'Title',
      });
      return outcome.focus!.nodeId;
    }, ids);
    await emitCurrentProjection(page);

    await row(page, ids.alpha).locator('.row-chevron-button').click({ force: true });
    await expect(row(page, childId)).toBeVisible();

    const alphaEditorBox = await rowEditor(page, ids.alpha).boundingBox();
    expect(alphaEditorBox).not.toBeNull();
    await page.mouse.click(alphaEditorBox!.x + 1, alphaEditorBox!.y + (alphaEditorBox!.height / 2));
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(4);
    const children = await todayChildren(page);
    const createdId = children[0];
    expect(createdId).toBeTruthy();
    expect(children).toEqual([createdId, ids.alpha, ids.beta, ids.gamma]);
    expect((await nodeById(page, createdId))?.content.text).toBe('');
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('Alpha');
    expect((await nodeById(page, ids.alpha))?.children).toEqual([childId]);
    expect((await nodeById(page, childId))?.parentId).toBe(ids.alpha);
    await expect(rowEditor(page, createdId)).toBeFocused();
  });

  test('> converts the current empty row to a field row without moving it', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Enter');

    const childrenAfterEnter = await todayChildren(page);
    const createdId = childrenAfterEnter[1];
    expect(createdId).toBeTruthy();
    await expect(rowEditor(page, createdId)).toBeFocused();

    await page.keyboard.type('>');

    await expect.poll(async () => (await nodeById(page, createdId))?.type).toBe('fieldEntry');
    expect((await todayChildren(page))[1]).toBe(createdId);
    await expect(row(page, createdId).locator('.field-name-input')).toBeVisible();
    await expect(rowBody(page, createdId)).toHaveClass(/field-group-start/);
    await expect(rowBody(page, createdId)).toHaveClass(/field-group-end/);

    const fieldVisuals = await row(page, createdId).evaluate((element) => {
      const grid = element.querySelector<HTMLElement>('.outliner-field-grid')!;
      const bullet = element.querySelector<HTMLElement>('.row-bullet-shape.field')!;
      const gridBox = grid.getBoundingClientRect();
      const bulletBox = bullet.getBoundingClientRect();
      const top = getComputedStyle(grid, '::before');
      const bottom = getComputedStyle(grid, '::after');
      const name = getComputedStyle(grid.querySelector('.field-name-input')!);
      return {
        bottomDividerHeight: bottom.height,
        dividerStartX: gridBox.left + Number.parseFloat(top.left),
        fieldIconStartX: bulletBox.left,
        nameBoxShadow: name.boxShadow,
        topDividerHeight: top.height,
      };
    });
    expect(Math.abs(fieldVisuals.dividerStartX - fieldVisuals.fieldIconStartX)).toBeLessThanOrEqual(1);
    expect(fieldVisuals.nameBoxShadow).toBe('none');
    expect(fieldVisuals.topDividerHeight).toBe('1px');
    expect(fieldVisuals.bottomDividerHeight).toBe('1px');

    const alphaBox = await row(page, ids.alpha).boundingBox();
    const fieldBox = await row(page, createdId).boundingBox();
    const betaBox = await row(page, ids.beta).boundingBox();
    expect(alphaBox).toBeTruthy();
    expect(fieldBox).toBeTruthy();
    expect(betaBox).toBeTruthy();
    expect(fieldBox!.y).toBeGreaterThan(alphaBox!.y);
    expect(fieldBox!.y).toBeLessThan(betaBox!.y);
  });

  test('clearing row text keeps the row height stable', async ({ page }) => {
    const rowBody = row(page, ids.alpha).locator('> .row');
    const editorShell = rowBody.locator('.row-editor').first();
    const heightBefore = (await rowBody.boundingBox())?.height ?? 0;

    await selectEditorContents(page, ids.alpha);
    await page.keyboard.press('Backspace');

    await expect(editorShell).toHaveClass(/is-empty/);
    await expect.poll(async () => (await rowBody.boundingBox())?.height ?? 0).toBeLessThanOrEqual(heightBefore + 1);
  });

  test('pending-focus empty rows suppress placeholder before DOM focus lands', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.setAttribute('data-testid', 'pending-focus-placeholder-fixture');
      fixture.innerHTML = `
        <div class="row-editor is-empty is-focus-pending" data-placeholder="Type here">
          <div class="ProseMirror" contenteditable="true"></div>
        </div>
      `;
      document.body.appendChild(fixture);
    });

    const placeholderStyle = await page.locator('[data-testid="pending-focus-placeholder-fixture"] .row-editor').evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return {
        display: style.display,
        opacity: Number(style.opacity),
      };
    });

    expect(placeholderStyle.display).not.toBe('none');
    expect(placeholderStyle.opacity).toBe(0);
  });

  test('clicking row text right-side blank space focuses the editor at the row end', async ({ page }) => {
    const contentLine = row(page, ids.alpha).locator('> .row .row-content-line').first();
    const box = await contentLine.boundingBox();
    expect(box).toBeTruthy();

    await contentLine.click({
      position: {
        x: Math.max(1, (box?.width ?? 1) - 8),
        y: Math.max(1, (box?.height ?? 1) / 2),
      },
    });

    await expect(rowEditor(page, ids.alpha)).toBeFocused();
    await page.keyboard.type('!');

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Alpha!');
  });

  test('typing in the middle of a node preserves the cursor instead of jumping to the end', async ({ page }) => {
    await placeCursorAtTextOffset(page, ids.alpha, 2);

    await page.keyboard.type('X');
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('AlXpha');
    await page.waitForTimeout(50);

    await page.keyboard.type('Y');
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('AlXYpha');
  });

  test('backtick inline code shortcut exits the mark and Arrow keys can cross code boundaries', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    await page.keyboard.type('`nihao`');

    await expect.poll(async () => nodeById(page, ids.alpha)).toMatchObject({
      content: {
        text: 'nihao',
        marks: [{ start: 0, end: 5, type: 'code' }],
      },
    });
    await expect(rowEditor(page, ids.alpha).locator('code.pm-code')).toHaveText('nihao');

    await page.keyboard.type('x');
    await expect.poll(async () => nodeById(page, ids.alpha)).toMatchObject({
      content: {
        text: 'nihaox',
        marks: [{ start: 0, end: 5, type: 'code' }],
      },
    });

    await selectEditorContents(page, ids.alpha);
    await page.keyboard.type('`nihao`');
    await rowEditor(page, ids.alpha).locator('code.pm-code').evaluate((element) => {
      const text = element.firstChild;
      if (!text) throw new Error('missing code text');
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(text, text.textContent?.length ?? 0);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');
    await expect.poll(async () => nodeById(page, ids.alpha)).toMatchObject({
      content: {
        text: 'nihaox',
        marks: [{ start: 0, end: 5, type: 'code' }],
      },
    });

    await selectEditorContents(page, ids.alpha);
    await page.keyboard.type('`nihao`');
    await rowEditor(page, ids.alpha).locator('code.pm-code').evaluate((element) => {
      const text = element.firstChild;
      if (!text) throw new Error('missing code text');
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('x');
    await expect.poll(async () => nodeById(page, ids.alpha)).toMatchObject({
      content: {
        text: 'xnihao',
        marks: [{ start: 1, end: 6, type: 'code' }],
      },
    });
  });

  test('delayed ordinary row text patches do not replay partial text after focus moves away', async ({ page }) => {
    await delayTextPatchCommands(page, 80);
    const text = 'ordinaryfastinputguard';

    await selectEditorContents(page, ids.alpha);
    await watchRowTextReplay(page, ids.alpha, text);
    await page.keyboard.type(text, { delay: 0 });
    await expect(rowEditor(page, ids.alpha)).toHaveText(text);

    await trailingEditor(page).click();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe(text);
    await page.waitForTimeout(120);
    await expectNoRowTextReplay(page);
  });

  test('Cmd+Enter updates checkbox state on the first frame without remounting the editor', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    const editor = rowEditor(page, ids.alpha);
    await editor.evaluate((element) => {
      (window as Window & { __doneEditor?: Element }).__doneEditor = element;
    });

    const releaseDone = await holdOutlineMutation(page, { op: 'update' });
    await page.keyboard.press('Meta+Enter');

    const checkbox = row(page, ids.alpha).locator('.done-checkbox');
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect((await nodeById(page, ids.alpha))?.completedAt).toBe(0);
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((element) => (
      (window as Window & { __doneEditor?: Element }).__doneEditor === element
    ))).toBe(true);

    await releaseDone();
    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(true);
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');

    const releaseHidden = await holdOutlineMutation(page, { op: 'update' });
    await page.keyboard.press('Meta+Enter');

    await expect(checkbox).toHaveCount(0);
    expect(Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(true);
    await releaseHidden();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(false);
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((element) => (
      (window as Window & { __doneEditor?: Element }).__doneEditor === element
    ))).toBe(true);
  });

  test('Backspace at the start of an empty row deletes it and returns focus upward', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Enter');

    const createdId = (await todayChildren(page))[1];
    await expect(rowEditor(page, createdId)).toBeFocused();

    const releaseRemoval = await holdOutlineMutation(page, { op: 'lifecycle' });
    await page.keyboard.press('Backspace');

    await expect(row(page, createdId)).toHaveCount(0);
    expect((await nodeById(page, createdId))?.parentId).toBe(ids.today);
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
    await releaseRemoval();
    await expect.poll(async () => (await nodeById(page, createdId))?.parentId).toBe(ids.trash);
  });

  test('Backspace merge updates the target on the first frame and preserves its editor identity', async ({ page }) => {
    await placeCursor(page, ids.beta, 'start');
    const alphaEditor = rowEditor(page, ids.alpha);
    await alphaEditor.evaluate((element) => {
      (window as Window & { __mergeTargetEditor?: Element }).__mergeTargetEditor = element;
    });
    const releaseMerge = await holdOutlineMutation(page, { op: 'merge' });

    await page.keyboard.press('Backspace');

    expect(await row(page, ids.beta).count()).toBe(0);
    expect(await alphaEditor.textContent()).toBe('AlphaBeta');
    expect(await alphaEditor.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await alphaEditor.evaluate((element) => (
      (window as Window & { __mergeTargetEditor?: Element }).__mergeTargetEditor === element
    ))).toBe(true);
    expect((await nodeById(page, ids.alpha))?.content.text).toBe('Alpha');
    expect((await nodeById(page, ids.beta))?.parentId).toBe(ids.today);

    await releaseMerge();
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('AlphaBeta');
    await expect.poll(async () => await nodeById(page, ids.beta)).toBeUndefined();
    await expect(alphaEditor).toBeFocused();
    expect(await alphaEditor.evaluate((element) => (
      (window as Window & { __mergeTargetEditor?: Element }).__mergeTargetEditor === element
    ))).toBe(true);
  });

  test('Backspace at the only empty row keeps focus on the trailing draft', async ({ page }) => {
    await createOnlyEmptyContentRowFixture(page);

    await expect(trailingEditor(page)).toBeVisible();
    await placeCursor(page, ids.alpha, 'start');
    await page.keyboard.press('Backspace');

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.parentId).toBe(ids.trash);
    await expect(row(page, ids.alpha)).toHaveCount(0);
    await expect(trailingEditor(page)).toBeFocused();
  });

  test('Tab and Shift+Tab while editing move the current row without losing focus', async ({ page }) => {
    await placeCursor(page, ids.beta, 'end');
    const betaEditor = rowEditor(page, ids.beta);
    await betaEditor.evaluate((element) => {
      (window as Window & { __movingEditor?: Element }).__movingEditor = element;
    });
    const releaseRelocation = await holdOutlineMutation(page, { op: 'move' });
    await page.keyboard.press('Tab');

    expect((await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
    await expect(betaEditor).toBeFocused();
    expect(await rowEditor(page, ids.beta).evaluate((element) => (
      (window as Window & { __movingEditor?: Element }).__movingEditor === element
    ))).toBe(true);

    await releaseRelocation();
    await waitForRowMoveAnimation(page, ids.beta);
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);
    await expect(rowEditor(page, ids.beta)).toBeFocused();
    await waitForRowMoveAnimationToSettle(page, ids.beta);

    await page.keyboard.press('Shift+Tab');

    await waitForRowMoveAnimation(page, ids.beta);
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
    await expect(rowEditor(page, ids.beta)).toBeFocused();
  });

  test('Shift+Tab while editing a panel-root row is a no-op', async ({ page }) => {
    await placeCursor(page, ids.beta, 'end');

    const beforeCalls = (await commandCalls(page)).length;
    await page.keyboard.press('Shift+Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
    expect((await appliedOutlineOperations(page, beforeCalls)).filter((operation) => operation.op === 'move')).toHaveLength(0);
    await expect(rowEditor(page, ids.beta)).toBeFocused();
  });

  test('Tab on an Enter-created empty sibling makes it a child without adding child trailing input', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(4);
    const createdId = (await todayChildren(page))[1];
    expect(createdId).toBeTruthy();
    await expect(rowEditor(page, createdId)).toBeFocused();

    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeById(page, createdId))?.parentId).toBe(ids.alpha);
    await expect.poll(async () => (await todayChildren(page))).toEqual([ids.alpha, ids.beta, ids.gamma]);
    await expect(rowEditor(page, createdId)).toBeFocused();
    await expect(trailingEditor(page, ids.alpha)).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();

    const alpha = await nodeById(page, ids.alpha);
    expect(alpha?.children).toEqual([createdId]);
  });

  test('Shift+Tab on an only child removes the emptied parent trailing draft', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(4);
    const createdId = (await todayChildren(page))[1];
    expect(createdId).toBeTruthy();
    await expect(rowEditor(page, createdId)).toBeFocused();

    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeById(page, createdId))?.parentId).toBe(ids.alpha);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.children).toEqual([createdId]);
    await expect(trailingEditor(page, ids.alpha)).toHaveCount(0);

    await page.keyboard.press('Shift+Tab');

    await expect.poll(async () => (await nodeById(page, createdId))?.parentId).toBe(ids.today);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.children).toEqual([]);
    await expect.poll(async () => (await todayChildren(page))).toEqual([ids.alpha, createdId, ids.beta, ids.gamma]);
    await expect(rowEditor(page, createdId)).toBeFocused();
    await expect(trailingEditor(page, ids.alpha)).toHaveCount(0);
    await expect(trailingEditor(page)).toBeVisible();
  });

  test('Arrow navigation at editor boundaries moves focus through visible rows', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('ArrowDown');

    await expect(rowEditor(page, ids.beta)).toBeFocused();

    await placeCursor(page, ids.beta, 'start');
    await page.keyboard.press('ArrowUp');

    await expect(rowEditor(page, ids.alpha)).toBeFocused();
  });

  test('Escape in an editor exits to selected row mode', async ({ page }) => {
    await rowEditor(page, ids.alpha).click();
    await page.keyboard.press('Escape');

    await expect(row(page, ids.alpha).locator('> .row')).toHaveClass(/selected/);
    await expect(rowEditor(page, ids.alpha)).not.toBeFocused();
  });

  test('multiline paste in a row updates the current row and inserts parsed child and sibling rows', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    await pasteIntoFocusedEditor(page, 'Pasted parent\n  Pasted child\nPasted sibling');

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Pasted parent');
    const alpha = await nodeById(page, ids.alpha);
    const childId = alpha?.children[0];
    expect(childId).toBeTruthy();
    expect((await nodeById(page, childId!))?.content.text).toBe('Pasted child');

    const children = await todayChildren(page);
    const alphaIndex = children.indexOf(ids.alpha);
    const siblingId = children[alphaIndex + 1];
    expect((await nodeById(page, siblingId))?.content.text).toBe('Pasted sibling');
    expect(children[alphaIndex + 2]).toBe(ids.beta);
    await expect(rowEditor(page, siblingId)).toBeFocused();
  });

});
