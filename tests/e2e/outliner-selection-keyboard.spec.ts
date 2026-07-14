import { expect, test } from '@playwright/test';
import {
  clipboardText,
  commandCalls,
  e2eInlineRefNodeId,
  e2eNodeInlineRef,
  e2eProjection,
  emitDocumentEvent,
  ids,
  multiSelect,
  nodeById,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

async function emitCurrentProjection(page: import('@playwright/test').Page) {
  await emitDocumentEvent(page, {
    type: 'projection_changed',
    origin: 'test',
    projection: await e2eProjection(page),
    timestamp: Date.now(),
  });
}

async function todayChildren(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

async function waitForRowMoveAnimation(page: import('@playwright/test').Page, id: string) {
  await expect.poll(async () => rowBody(page, id).evaluate((element) => (
    element.classList.contains('row-move-animating')
  )), { timeout: 1000 }).toBe(true);
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

async function createLeadingFieldValueFixture(page: import('@playwright/test').Page) {
  const result = await page.evaluate(async (ids) => {
    const win = window as Window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    const field = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_inline_field', {
      parentId: ids.today,
      index: 0,
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

async function createOnlyFieldFixture(page: import('@playwright/test').Page) {
  const result = await page.evaluate(async (ids) => {
    const win = window as Window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    const field = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_inline_field', {
      parentId: ids.today,
      index: 0,
      name: 'Notes',
      fieldType: 'plain',
    });
    await win.lin?.invoke('batch_trash_nodes', { nodeIds: [ids.alpha, ids.beta, ids.gamma] });
    return {
      entryId: field?.focus?.nodeId ?? '',
    };
  }, ids);
  await emitCurrentProjection(page);
  return result;
}

async function createOwnerSystemFieldFixture(page: import('@playwright/test').Page) {
  const result = await page.evaluate(async (ids) => {
    const win = window as Window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    const field = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_inline_field', {
      parentId: ids.today,
      index: 1,
      name: 'Owner',
      fieldType: 'plain',
    });
    const entryId = field?.focus?.nodeId ?? '';
    await win.lin?.invoke('reuse_field_definition', {
      entryId,
      targetDefId: 'sys:owner',
    });
    return {
      entryId,
      sysrefId: `sysref:${entryId}:${ids.daily}`,
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

  test('Cmd+A selects visible rows from an empty selection', async ({ page }) => {
    await multiSelect(page, [ids.beta]);
    await page.keyboard.press('Escape');
    await expect(rowBody(page, ids.beta)).not.toHaveClass(/selected/);

    await page.keyboard.press('Meta+A');

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('Cmd+A escalates from row text selection to visible row selection', async ({ page }) => {
    await rowEditor(page, ids.beta).click();

    await page.keyboard.press('Meta+A');
    await expect(rowBody(page, ids.beta)).not.toHaveClass(/selected/);
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Beta');

    await page.keyboard.press('Meta+A');
    await expect(rowEditor(page, ids.beta)).not.toBeFocused();
    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('Cmd+A selects field values in the panel selection scope', async ({ page }) => {
    const { entryId, firstValueId, secondValueId } = await createFieldValueFixture(page);

    await expect(row(page, entryId)).toBeVisible();
    await rowEditor(page, firstValueId).click();
    await page.keyboard.press('Escape');
    await expect(rowBody(page, firstValueId)).toHaveClass(/selected/);

    await page.keyboard.press('Meta+A');

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, entryId)).toHaveClass(/selected/);
    await expect(rowBody(page, firstValueId)).toHaveClass(/selected/);
    await expect(rowBody(page, secondValueId)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('selected field values can indent but cannot outdent past their field entry', async ({ page }) => {
    const { entryId, firstValueId, secondValueId } = await createFieldValueFixture(page);

    await multiSelect(page, [secondValueId]);
    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeById(page, secondValueId))?.parentId).toBe(firstValueId);
    await expect(rowBody(page, secondValueId)).toHaveClass(/selected/);

    await page.keyboard.press('Shift+Tab');
    await expect.poll(async () => (await nodeById(page, secondValueId))?.parentId).toBe(entryId);
    await expect(rowBody(page, secondValueId)).toHaveClass(/selected/);

    await page.keyboard.press('Shift+Tab');
    await expect.poll(async () => (await nodeById(page, secondValueId))?.parentId).toBe(entryId);
  });

  test('Cmd+A escalates from a field name to visible row selection', async ({ page }) => {
    const { entryId, firstValueId, secondValueId } = await createFieldValueFixture(page);
    const nameInput = row(page, entryId).locator('.field-name-input');

    await nameInput.click();
    await page.keyboard.press('Meta+A');
    await expect(rowBody(page, entryId)).not.toHaveClass(/selected/);
    await expect.poll(async () => nameInput.evaluate((input) => (
      input instanceof HTMLInputElement
        ? input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)
        : ''
    ))).toBe('Notes');

    await page.keyboard.press('Meta+A');
    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, entryId)).toHaveClass(/selected/);
    await expect(rowBody(page, firstValueId)).toHaveClass(/selected/);
    await expect(rowBody(page, secondValueId)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('Shift click can span body rows and field value rows', async ({ page }) => {
    const { entryId, firstValueId, secondValueId } = await createFieldValueFixture(page);

    await row(page, ids.alpha).click({ modifiers: ['Meta'] });
    await row(page, secondValueId).click({ modifiers: ['Shift'] });

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, entryId)).toHaveClass(/selected/);
    await expect(rowBody(page, firstValueId)).toHaveClass(/selected/);
    await expect(rowBody(page, secondValueId)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).not.toHaveClass(/selected/);
  });

  test('delete below field values focuses the previous field value row', async ({ page }) => {
    const { secondValueId } = await createFieldValueFixture(page);

    await multiSelect(page, [ids.beta]);
    await page.keyboard.press('Backspace');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.trash);
    await expect(rowEditor(page, secondValueId)).toBeFocused();
  });

  test('Backspace at the start of a field name deletes the field row', async ({ page }) => {
    const { entryId } = await createFieldValueFixture(page);
    const nameInput = row(page, entryId).locator('.field-name-input');

    await nameInput.click();
    await nameInput.evaluate((input) => {
      if (input instanceof HTMLInputElement) input.setSelectionRange(0, 0);
    });
    await page.keyboard.press('Backspace');

    await expect.poll(async () => (await nodeById(page, entryId))?.parentId).toBe(ids.trash);
    await expect(row(page, entryId)).toHaveCount(0);
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
  });

  test('Backspace at the first field name with values focuses the next surviving row', async ({ page }) => {
    const { entryId, firstValueId, secondValueId } = await createLeadingFieldValueFixture(page);
    const nameInput = row(page, entryId).locator('.field-name-input');

    await nameInput.click();
    await nameInput.evaluate((input) => {
      if (input instanceof HTMLInputElement) input.setSelectionRange(0, 0);
    });
    await page.keyboard.press('Backspace');

    await expect.poll(async () => (await nodeById(page, entryId))?.parentId).toBe(ids.trash);
    await expect(row(page, entryId)).toHaveCount(0);
    await expect(row(page, firstValueId)).toHaveCount(0);
    await expect(row(page, secondValueId)).toHaveCount(0);
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
  });

  test('Backspace at the only field name keeps focus on the trailing draft', async ({ page }) => {
    const { entryId } = await createOnlyFieldFixture(page);
    const nameInput = row(page, entryId).locator('.field-name-input');

    await expect(trailingEditor(page)).toBeVisible();
    await nameInput.click();
    await nameInput.evaluate((input) => {
      if (input instanceof HTMLInputElement) input.setSelectionRange(0, 0);
    });
    await page.keyboard.press('Backspace');

    await expect.poll(async () => (await nodeById(page, entryId))?.parentId).toBe(ids.trash);
    await expect(row(page, entryId)).toHaveCount(0);
    await expect(trailingEditor(page)).toBeFocused();
  });

  test('Cmd+A keeps synthetic system reference rows in the panel selection scope', async ({ page }) => {
    const { entryId, sysrefId } = await createOwnerSystemFieldFixture(page);

    await expect(row(page, sysrefId)).toBeVisible();
    await rowBody(page, sysrefId).click();
    await page.keyboard.press('Meta+A');

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, entryId)).toHaveClass(/selected/);
    await expect(rowBody(page, sysrefId)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('Shift click on an inline reference chip extends the row range', async ({ page }) => {
    const inlineRefPayload = e2eNodeInlineRef(4, ids.gamma, 'Gamma');
    await page.evaluate(async ({ ids, inlineRefPayload }) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('apply_node_text_patch', {
        nodeId: ids.beta,
        patch: {
          ops: [{
            type: 'replace_all',
            content: {
              text: 'See ',
              marks: [],
              inlineRefs: [inlineRefPayload],
            },
          }],
        },
      });
    }, { ids, inlineRefPayload });
    await emitCurrentProjection(page);

    await row(page, ids.alpha).click({ modifiers: ['Meta'] });
    await row(page, ids.beta).locator('.inline-ref').first().click({ modifiers: ['Shift'] });

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).not.toHaveClass(/selected/);
  });

  test('Tab indents selected rows under the previous sibling and keeps them selected', async ({ page }) => {
    await multiSelect(page, [ids.beta]);

    await page.keyboard.press('Tab');

    await waitForRowMoveAnimation(page, ids.beta);
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);
    await expect(row(page, ids.beta)).toBeVisible();
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowEditor(page, ids.beta)).not.toBeFocused();
  });

  test('Tab on the first selected child run is a no-op', async ({ page }) => {
    await rowEditor(page, ids.beta).click();
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);

    await rowEditor(page, ids.gamma).click();
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await nodeById(page, ids.gamma))?.parentId).toBe(ids.alpha);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.children).toEqual([ids.beta, ids.gamma]);

    await page.keyboard.press('Escape');
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
    await row(page, ids.beta).click({ modifiers: ['Meta'] });
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);

    const beforeCalls = (await commandCalls(page)).length;
    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);
    await expect.poll(async () => (await nodeById(page, ids.gamma))?.parentId).toBe(ids.alpha);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.children).toEqual([ids.beta, ids.gamma]);
    const calls = (await commandCalls(page)).slice(beforeCalls).map((call) => call.cmd);
    expect(calls).not.toContain('batch_indent_nodes');
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('Shift+Tab outdents selected rows back to the parent scope and keeps them selected', async ({ page }) => {
    await multiSelect(page, [ids.beta]);
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect.poll(async () => rowBody(page, ids.beta).evaluate((element) => (
      element.classList.contains('row-move-animating')
    ))).toBe(false);

    await page.keyboard.press('Shift+Tab');

    await waitForRowMoveAnimation(page, ids.beta);
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowEditor(page, ids.beta)).not.toBeFocused();
  });

  test('Shift+Tab on selected panel-root rows is a no-op', async ({ page }) => {
    await multiSelect(page, [ids.beta, ids.gamma]);

    const beforeCalls = (await commandCalls(page)).length;
    await page.keyboard.press('Shift+Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
    await expect.poll(async () => (await nodeById(page, ids.gamma))?.parentId).toBe(ids.today);
    const calls = (await commandCalls(page)).slice(beforeCalls).map((call) => call.cmd);
    expect(calls).not.toContain('batch_outdent_nodes');
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('Shift+Tab on multiple selected children removes the emptied parent trailing draft', async ({ page }) => {
    await rowEditor(page, ids.beta).click();
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);

    await rowEditor(page, ids.gamma).click();
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await nodeById(page, ids.gamma))?.parentId).toBe(ids.alpha);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.children).toEqual([ids.beta, ids.gamma]);
    await expect(trailingEditor(page, ids.alpha)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
    await row(page, ids.beta).click({ modifiers: ['Meta'] });
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
    await page.keyboard.press('Shift+Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
    await expect.poll(async () => (await nodeById(page, ids.gamma))?.parentId).toBe(ids.today);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.children).toEqual([]);
    await expect.poll(async () => (await todayChildren(page))).toEqual([ids.alpha, ids.beta, ids.gamma]);
    await expect(row(page, ids.beta)).toBeVisible();
    await expect(row(page, ids.gamma)).toBeVisible();
    await expect(trailingEditor(page, ids.alpha)).toHaveCount(0);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
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

    const guideLine = page.locator([
      `.indent-guide[data-guide-node-id="${referenceId}"] .indent-guide-line`,
      `[data-node-id="${referenceId}"] > .indent-guide .indent-guide-line`,
    ].join(', ')).first();
    const guideStyle = await guideLine.evaluate((element) => ({
      backgroundImage: getComputedStyle(element).backgroundImage,
      className: element.parentElement?.className ?? '',
    }));
    expect(guideStyle.className).toContain('indent-guide--reference');
    expect(guideStyle.backgroundImage).toContain('repeating-linear-gradient');
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
        && node.content.inlineRefs.some((ref) => e2eInlineRefNodeId(ref) === targetId)
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
    const inlineRefPayload = e2eNodeInlineRef(4, ids.beta, 'Beta');
    const referenceId = await page.evaluate(async ({ ids, inlineRefPayload }) => {
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
              inlineRefs: [inlineRefPayload],
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
    }, { ids, inlineRefPayload });
    await emitCurrentProjection(page);

    const inlineRef = row(page, referenceId).locator('.inline-ref').first();
    await expect(inlineRef).toHaveText('Beta');
    const panelCount = await page.locator('.outline-panel-surface').count();

    // Meta/Ctrl+click opens the referenced node in a new split pane.
    await inlineRef.click({ modifiers: ['Meta'] });
    await expect(page.locator('.outline-panel-surface')).toHaveCount(panelCount + 1);
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Beta');

    // The original (first) pane still shows the reference row; a plain click on
    // its inline reference navigates that pane in place — no new pane, no stolen
    // editor focus.
    const firstPane = page.locator('.outline-panel-surface').first();
    const originalPaneInlineRef = firstPane.locator('.inline-ref').first();
    await expect(originalPaneInlineRef).toHaveText('Beta');
    const titleEditor = firstPane.locator('.panel-title-editor .ProseMirror').first();
    await originalPaneInlineRef.click();

    await expect(page.locator('.outline-panel-surface')).toHaveCount(panelCount + 1);
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
        && node.content.inlineRefs.some((ref) => e2eInlineRefNodeId(ref) === targetId)
      ))?.id ?? '';
      return inlineRowId;
    }).not.toBe('');
    await expect(rowEditor(page, inlineRowId)).toBeFocused();
    await page.keyboard.insertText('你好');
    await expect.poll(async () => nodeById(page, inlineRowId)).toMatchObject({
      content: {
        text: '你好',
        inlineRefs: [e2eNodeInlineRef(0, targetId, 'Reference Alpha')],
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
