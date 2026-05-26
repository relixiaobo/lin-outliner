import { expect, test } from '@playwright/test';
import {
  clipboardText,
  commandCalls,
  e2eProjection,
  emitDocumentEvent,
  ids,
  multiSelect,
  nodeById,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
} from './outlinerMock';

async function emitCurrentProjection(page: import('@playwright/test').Page) {
  await emitDocumentEvent(page, {
    type: 'projection_changed',
    origin: 'test',
    projection: await e2eProjection(page),
    timestamp: Date.now(),
  });
}

async function createReferenceFixture(page: import('@playwright/test').Page) {
  const result = await page.evaluate(async (ids) => {
    const win = window as Window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    const target = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
      parentId: ids.root,
      index: null,
      text: 'Reference Alpha',
    });
    const targetId = target?.focus?.nodeId ?? '';
    const child = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
      parentId: targetId,
      index: null,
      text: 'Alpha child',
    });
    const reference = await win.lin?.invoke<{ focus?: { nodeId: string } }>('add_reference', {
      parentId: ids.today,
      targetId,
      index: null,
    });
    return {
      targetId,
      childId: child?.focus?.nodeId ?? '',
      referenceId: reference?.focus?.nodeId ?? '',
    };
  }, ids);
  await emitCurrentProjection(page);
  return result;
}

async function createFieldValueFixture(page: import('@playwright/test').Page) {
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

test.describe('outliner selection keyboard parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('typing in selection mode edits the first selected row and appends the character', async ({ page }) => {
    await multiSelect(page, [ids.beta]);

    await page.keyboard.type('x');

    await expect(row(page, ids.beta)).toContainText('Betax');
    await expect(rowEditor(page, ids.beta)).toBeFocused();
    await expect(rowBody(page, ids.beta)).not.toHaveClass(/selected/);
  });

  test('ArrowUp and ArrowDown leave selection mode and focus adjacent rows', async ({ page }) => {
    await multiSelect(page, [ids.beta]);

    await page.keyboard.press('ArrowUp');
    await expect(rowEditor(page, ids.alpha)).toBeFocused();

    await row(page, ids.beta).click({ modifiers: ['Meta'] });
    await page.keyboard.press('ArrowDown');
    await expect(rowEditor(page, ids.gamma)).toBeFocused();
  });

  test('Shift click and Cmd+A select visible rows in root scope', async ({ page }) => {
    await row(page, ids.alpha).click({ modifiers: ['Meta'] });
    await row(page, ids.gamma).click({ modifiers: ['Shift'] });

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);

    await page.keyboard.press('Escape');
    await row(page, ids.beta).click({ modifiers: ['Meta'] });
    await page.keyboard.press('Meta+A');

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('Cmd+A selects visible field value rows in their own value scope', async ({ page }) => {
    const { entryId, firstValueId, secondValueId } = await createFieldValueFixture(page);

    await expect(row(page, entryId)).toBeVisible();
    await rowEditor(page, firstValueId).click();
    await page.keyboard.press('Escape');
    await expect(rowBody(page, firstValueId)).toHaveClass(/selected/);

    await page.keyboard.press('Meta+A');

    await expect(rowBody(page, firstValueId)).toHaveClass(/selected/);
    await expect(rowBody(page, secondValueId)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.alpha)).not.toHaveClass(/selected/);
  });

  test('Tab indents selected rows under the previous sibling and keeps the target expanded', async ({ page }) => {
    await multiSelect(page, [ids.beta]);

    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);
    await expect(row(page, ids.beta)).toBeVisible();
    await expect(rowEditor(page, ids.beta)).toBeFocused();
  });

  test('Shift+Tab outdents selected rows back to the parent scope', async ({ page }) => {
    await multiSelect(page, [ids.beta]);
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);

    await page.keyboard.press('Escape');
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await page.keyboard.press('Shift+Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
  });

  test('Cmd+Enter cycles checkbox state for all selected target rows', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(true);
    await expect.poll(async () => Boolean((await nodeById(page, ids.beta))?.completedAt)).toBe(true);

    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(false);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(false);
    await expect.poll(async () => Boolean((await nodeById(page, ids.beta))?.completedAt)).toBe(false);
    await expect.poll(async () => (await nodeById(page, ids.beta))?.showCheckbox).toBe(false);
  });

  test('Cmd+Shift+D duplicates all selected rows after their sources', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.keyboard.press('Meta+Shift+D');

    await expect(page.getByText('Alpha')).toHaveCount(2);
    await expect(page.getByText('Beta')).toHaveCount(2);
  });

  test('Cmd+C copies selected rows and Cmd+X cuts them as a batch', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.keyboard.press('Meta+C');
    await expect.poll(() => clipboardText(page)).toContain('Alpha');
    await expect.poll(() => clipboardText(page)).toContain('Beta');

    await page.keyboard.press('Meta+X');

    await expect(row(page, ids.alpha)).toHaveCount(0);
    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, ids.gamma)).toContainText('Gamma');
  });

  test('expanded reference rows render the target children', async ({ page }) => {
    const { childId, referenceId } = await createReferenceFixture(page);

    await row(page, referenceId).locator('.row-chevron-button').click({ force: true });

    await expect(row(page, childId)).toBeVisible();
    await expect(row(page, childId)).toContainText('Alpha child');

    const guideBackground = await row(page, referenceId).locator('> .indent-guide .indent-guide-line').evaluate((element) =>
      getComputedStyle(element).backgroundImage,
    );
    expect(guideBackground).toContain('repeating-linear-gradient');
  });

  test('ArrowRight converts a selected reference row to an unchanged inline reference and blur restores it', async ({ page }) => {
    const { referenceId, targetId } = await createReferenceFixture(page);

    await rowBody(page, referenceId).click();
    await expect(rowBody(page, referenceId)).toHaveClass(/ref-click-selected/);
    await expect(rowEditor(page, referenceId)).not.toBeFocused();

    let inlineId = '';
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      inlineId = projection.nodes.find((node) => (
        node.id !== referenceId
        && !node.type
        && node.content.inlineRefs.some((ref) => ref.targetNodeId === targetId)
      ))?.id ?? '';
      return inlineId;
    }).not.toBe('');
    await expect(rowEditor(page, inlineId)).toBeFocused();

    await rowBody(page, ids.beta).click();

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.some((node) => node.id === inlineId);
    }).toBe(false);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.some((node) => node.type === 'reference' && node.targetId === targetId);
    }).toBe(true);
  });

  test('double-clicking a reference row edits the target node in place', async ({ page }) => {
    const { referenceId, targetId } = await createReferenceFixture(page);
    const beforeCalls = (await commandCalls(page)).length;

    await rowBody(page, referenceId).locator('.row-content-line').dblclick({ position: { x: 140, y: 12 } });

    await expect(rowEditor(page, referenceId)).toBeFocused();
    await expect(rowBody(page, referenceId)).not.toHaveClass(/ref-converting/);

    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await rowEditor(page, ids.beta).click();

    await expect.poll(async () => nodeById(page, targetId)).toMatchObject({
      content: { text: 'Reference Alpha!' },
    });
    await expect.poll(async () => nodeById(page, referenceId)).toMatchObject({
      type: 'reference',
      targetId,
    });
    const calls = (await commandCalls(page)).slice(beforeCalls).map((call) => call.cmd);
    expect(calls).not.toContain('convert_reference_to_inline_node');
  });

  test('clicking inside an editing reference row keeps the reference editor active', async ({ page }) => {
    const { referenceId } = await createReferenceFixture(page);
    const contentLine = rowBody(page, referenceId).locator('.row-content-line');

    await contentLine.dblclick({ position: { x: 140, y: 12 } });
    await expect(rowEditor(page, referenceId)).toBeFocused();
    await expect(rowBody(page, referenceId)).toHaveClass(/focused/);

    await rowEditor(page, referenceId).click({ position: { x: 12, y: 8 } });

    await expect(rowEditor(page, referenceId)).toBeFocused();
    await expect(rowBody(page, referenceId)).toHaveClass(/focused/);
    await expect(rowBody(page, referenceId)).not.toHaveClass(/ref-click-selected/);

    const lineBox = await contentLine.boundingBox();
    if (!lineBox) throw new Error('Expected reference content line to be visible');
    await contentLine.click({ position: { x: lineBox.width - 12, y: 12 } });

    await expect(rowEditor(page, referenceId)).toBeFocused();
    await expect(rowBody(page, referenceId)).toHaveClass(/focused/);
    await expect(rowBody(page, referenceId)).not.toHaveClass(/ref-click-selected/);

    await rowEditor(page, ids.beta).click({ position: { x: 8, y: 8 } });

    await expect(rowEditor(page, referenceId)).not.toBeFocused();
    await expect(rowEditor(page, ids.beta)).toBeFocused();
  });

  test('reference selection and edit affordances frame the whole reference row', async ({ page }) => {
    const { referenceId } = await createReferenceFixture(page);

    await rowBody(page, referenceId).click();
    await expect(rowBody(page, referenceId)).toHaveClass(/ref-click-selected/);
    const selectedFrame = await rowBody(page, referenceId).evaluate((element) => {
      const rowRect = element.getBoundingClientRect();
      const editorRect = element.querySelector('.row-editor')?.getBoundingClientRect();
      const frameStyle = getComputedStyle(element, '::before');
      return {
        content: frameStyle.content,
        borderStyle: frameStyle.borderTopStyle,
        frameLeft: Number.parseFloat(frameStyle.left),
        editorLeft: editorRect ? editorRect.left - rowRect.left : 0,
        rowWidth: rowRect.width,
      };
    });
    expect(selectedFrame.content).not.toBe('none');
    expect(selectedFrame.borderStyle).toBe('solid');
    expect(selectedFrame.frameLeft).toBeLessThan(selectedFrame.editorLeft);

    await rowBody(page, referenceId).locator('.row-content-line').dblclick({ position: { x: 80, y: 12 } });
    await expect(rowEditor(page, referenceId)).toBeFocused();
    const editingFrame = await rowBody(page, referenceId).evaluate((element) => {
      const frameStyle = getComputedStyle(element, '::before');
      return {
        content: frameStyle.content,
        borderStyle: frameStyle.borderTopStyle,
        rowWidth: element.getBoundingClientRect().width,
      };
    });
    expect(editingFrame.content).not.toBe('none');
    expect(editingFrame.borderStyle).toBe('solid');
    expect(editingFrame.rowWidth).toBeGreaterThan(selectedFrame.rowWidth);
  });

  test('inline references inside reference rows navigate to the referenced node', async ({ page }) => {
    const referenceId = await page.evaluate(async (ids) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('apply_node_text_patch', {
        nodeId: ids.alpha,
        patch: {
          ops: [{
            type: 'replace_all',
            content: {
              text: 'See ',
              marks: [],
              inlineRefs: [{ offset: 4, targetNodeId: ids.beta, displayName: 'Beta' }],
            },
          }],
        },
      });
      const reference = await win.lin?.invoke<{ focus?: { nodeId: string } }>('add_reference', {
        parentId: ids.today,
        targetId: ids.alpha,
        index: null,
      });
      return reference?.focus?.nodeId ?? '';
    }, ids);
    await emitCurrentProjection(page);

    const inlineRef = row(page, referenceId).locator('.inline-ref').first();
    await expect(inlineRef).toHaveText('Beta');
    const tabCount = await page.locator('.workspace-tab').count();
    const panelCount = await page.locator('.outline-panel-surface').count();

    await inlineRef.click({ modifiers: ['Meta'] });
    await expect(page.locator('.workspace-tab')).toHaveCount(tabCount + 1);
    await expect(page.locator('.workspace-tab.active')).toContainText('Beta');

    await page.locator('.workspace-tab').first().click();
    await expect(page.locator('.outline-panel-surface')).toHaveCount(panelCount);

    const originalTabInlineRef = row(page, referenceId).locator('.inline-ref').first();
    await expect(originalTabInlineRef).toHaveText('Beta');
    const titleEditor = page.locator('.panel-title-editor .ProseMirror').first();
    await originalTabInlineRef.click();

    await expect(page.locator('.workspace-tab')).toHaveCount(tabCount + 1);
    await expect(titleEditor).toHaveText('Beta');
    await expect(titleEditor).not.toBeFocused();
  });

  test('IME typing after a selected reference continues in the real inline editor', async ({ page }) => {
    const { targetId, referenceId } = await createReferenceFixture(page);

    await row(page, referenceId).click();
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Process',
        keyCode: 229,
        which: 229,
      }));
    });

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
    await page.keyboard.insertText('你好');
    await expect.poll(async () => nodeById(page, inlineRowId)).toMatchObject({
      content: {
        text: '你好',
        inlineRefs: [{ offset: 0, targetNodeId: targetId, displayName: 'Reference Alpha' }],
      },
    });
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
  });

  test('Escape clears a clicked reference selection without entering edit mode', async ({ page }) => {
    const { referenceId } = await createReferenceFixture(page);

    await rowBody(page, referenceId).click();
    await expect(rowBody(page, referenceId)).toHaveClass(/ref-click-selected/);

    await page.keyboard.press('Escape');

    await expect(rowBody(page, referenceId)).not.toHaveClass(/ref-click-selected|selected/);
    await expect(rowEditor(page, referenceId)).not.toBeFocused();
  });

  test('Backspace removes a selected reference row instead of trashing the target', async ({ page }) => {
    const { referenceId, targetId } = await createReferenceFixture(page);

    await rowBody(page, referenceId).click();
    await page.keyboard.press('Backspace');

    await expect(row(page, referenceId)).toHaveCount(0);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.some((node) => node.id === referenceId);
    }).toBe(false);
    await expect.poll(async () => (await nodeById(page, targetId))?.parentId).not.toBe(ids.trash);
  });

  test('Backspace batch-deletes mixed content and reference rows without touching the target', async ({ page }) => {
    const { referenceId, targetId } = await createReferenceFixture(page);

    await multiSelect(page, [ids.beta, referenceId]);
    await page.keyboard.press('Backspace');

    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, referenceId)).toHaveCount(0);
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.trash);
    await expect.poll(async () => (await nodeById(page, referenceId))?.parentId).toBe(ids.trash);
    await expect.poll(async () => (await nodeById(page, targetId))?.parentId).not.toBe(ids.trash);
  });
});
