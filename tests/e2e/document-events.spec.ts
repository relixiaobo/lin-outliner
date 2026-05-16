import { expect, test } from '@playwright/test';
import { e2eProjection, emitDocumentEvent, ids, openMockedApp } from './outlinerMock';

test.describe('document projection events', () => {
  test('refresh visible outliner content after an external document mutation', async ({ page }) => {
    await openMockedApp(page);

    await page.evaluate(async (parentId) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('create_node', { parentId, index: null, text: 'Agent-created weather' });
    }, ids.today);

    await expect(page.getByText('Agent-created weather')).toHaveCount(0);

    const projection = await e2eProjection(page);
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'agent',
      projection,
      timestamp: Date.now(),
    });

    await expect(page.getByText('Agent-created weather')).toBeVisible();
  });
});
