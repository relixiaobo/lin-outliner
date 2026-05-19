import { expect, test } from '@playwright/test';
import {
  clipboardText,
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
    const child = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
      parentId: ids.alpha,
      index: null,
      text: 'Alpha child',
    });
    const reference = await win.lin?.invoke<{ focus?: { nodeId: string } }>('add_reference', {
      parentId: ids.today,
      targetId: ids.alpha,
      index: null,
    });
    return {
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
  });

  test('ArrowRight converts a selected reference row to an unchanged inline reference and blur restores it', async ({ page }) => {
    const { referenceId } = await createReferenceFixture(page);

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
        && node.content.inlineRefs.some((ref) => ref.targetNodeId === ids.alpha)
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
      return projection.nodes.some((node) => node.type === 'reference' && node.targetId === ids.alpha);
    }).toBe(true);
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
    const { referenceId } = await createReferenceFixture(page);

    await rowBody(page, referenceId).click();
    await page.keyboard.press('Backspace');

    await expect(row(page, referenceId)).toHaveCount(0);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.some((node) => node.id === referenceId);
    }).toBe(false);
    await expect(row(page, ids.alpha)).toBeVisible();
  });

  test('Backspace batch-deletes mixed content and reference rows without touching the target', async ({ page }) => {
    const { referenceId } = await createReferenceFixture(page);

    await multiSelect(page, [ids.beta, referenceId]);
    await page.keyboard.press('Backspace');

    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, referenceId)).toHaveCount(0);
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.trash);
    await expect.poll(async () => (await nodeById(page, referenceId))?.parentId).toBe(ids.trash);
    await expect(row(page, ids.alpha)).toBeVisible();
  });
});
