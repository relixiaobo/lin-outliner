import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  emitDocumentEvent,
  ids,
  multiSelect,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
} from './outlinerMock';

async function dragBulletTo(page: Page, sourceId: string, target: Locator) {
  const source = row(page, sourceId).locator('.row-bullet-button').first();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Missing drag source or target');

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + Math.min(48, targetBox.width / 2), targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function dispatchNodeDragStart(page: Page, sourceId: string) {
  await page.evaluate((nodeId) => {
    const source = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] .row-bullet-button`);
    if (!source) throw new Error(`Missing drag source ${nodeId}`);
    const rect = source.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    (window as Window & { __LIN_E2E_DRAG_DATA__?: DataTransfer }).__LIN_E2E_DRAG_DATA__ = dataTransfer;
    source.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    }));
  }, sourceId);
}

async function dispatchNodeDragOver(page: Page, targetId: string) {
  await page.evaluate((nodeId) => {
    const target = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] > .row`);
    const dataTransfer = (window as Window & { __LIN_E2E_DRAG_DATA__?: DataTransfer }).__LIN_E2E_DRAG_DATA__;
    if (!target || !dataTransfer) throw new Error(`Missing drag target ${nodeId}`);
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(48, rect.width / 2),
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    }));
  }, targetId);
}

async function dispatchNodeDragEnd(page: Page, sourceId: string) {
  await page.evaluate((nodeId) => {
    const source = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] .row-bullet-button`);
    const dataTransfer = (window as Window & { __LIN_E2E_DRAG_DATA__?: DataTransfer }).__LIN_E2E_DRAG_DATA__;
    if (!source || !dataTransfer) throw new Error(`Missing drag source ${nodeId}`);
    source.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
    delete (window as Window & { __LIN_E2E_DRAG_DATA__?: DataTransfer }).__LIN_E2E_DRAG_DATA__;
  }, sourceId);
}

async function todayChildren(page: Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

async function expectNoDropIndicator(page: Page) {
  await expect(page.locator('.row.drop-before, .row.drop-after, .row.drop-inside')).toHaveCount(0);
}

test.describe('outliner drag and drop', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('dragging a selected block to the trailing draft appends the whole block', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    const trailingRow = page.locator(`[data-trailing-parent-id="${ids.today}"] > .row`).first();
    await dragBulletTo(page, ids.alpha, trailingRow);

    await expectNoDropIndicator(page);
    await expect.poll(() => todayChildren(page)).toEqual([ids.gamma, ids.alpha, ids.beta]);
    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowEditor(page, ids.alpha)).not.toBeFocused();
    await expect(rowEditor(page, ids.beta)).not.toBeFocused();

    const moveCalls = (await commandCalls(page))
      .filter((call) => call.cmd === 'batch_move_nodes')
      .map((call) => call.args);
    expect(moveCalls).toEqual([
      {
        moves: [
          { nodeId: ids.beta, parentId: ids.today, index: 2 },
          { nodeId: ids.alpha, parentId: ids.today, index: 1 },
        ],
      },
    ]);
  });

  test('invalid drops on the selected block leave no guide line or stray focus', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await dragBulletTo(page, ids.alpha, rowBody(page, ids.beta));

    await expectNoDropIndicator(page);
    await expect.poll(() => todayChildren(page)).toEqual([ids.alpha, ids.beta, ids.gamma]);
    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowEditor(page, ids.alpha)).not.toBeFocused();
    await expect(rowEditor(page, ids.beta)).not.toBeFocused();

    const moveCalls = (await commandCalls(page))
      .filter((call) => call.cmd === 'move_node' || call.cmd === 'batch_move_nodes');
    expect(moveCalls).toHaveLength(0);
  });

  test('nested drag hover keeps a single active guide line', async ({ page }) => {
    await page.evaluate(async ({ alphaId, betaId }) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('move_node', { nodeId: betaId, parentId: alphaId, index: null });
    }, { alphaId: ids.alpha, betaId: ids.beta });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    await row(page, ids.alpha).locator('.row-chevron-button').click({ force: true });
    await expect(row(page, ids.beta)).toBeVisible();

    await dispatchNodeDragStart(page, ids.gamma);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/dragging/);
    await dispatchNodeDragOver(page, ids.alpha);
    await expect(page.locator('.row.drop-before, .row.drop-after, .row.drop-inside')).toHaveCount(1);

    await dispatchNodeDragOver(page, ids.beta);
    await expect(page.locator('.row.drop-before, .row.drop-after, .row.drop-inside')).toHaveCount(1);
    await dispatchNodeDragEnd(page, ids.gamma);
    await expectNoDropIndicator(page);
  });
});
