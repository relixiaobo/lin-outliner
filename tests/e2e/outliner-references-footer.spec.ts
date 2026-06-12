import { expect, test, type Page } from '@playwright/test';
import {
  e2eProjection,
  emitDocumentEvent,
  ids,
  nodeById,
  openMockedApp,
  row,
} from './outlinerMock';

async function emitCurrentProjection(page: Page) {
  await emitDocumentEvent(page, {
    type: 'projection_changed',
    origin: 'test',
    projection: await e2eProjection(page),
    timestamp: Date.now(),
  });
}

async function createReferencesFixture(page: Page) {
  await page.evaluate(async (fixtureIds) => {
    const win = window as Window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    };
    await win.lin?.invoke('apply_node_text_patch', {
      nodeId: fixtureIds.beta,
      patch: {
        ops: [{
          type: 'replace_all',
          content: { text: 'Discuss Alpha soon', marks: [], inlineRefs: [] },
        }],
      },
    });
    await win.lin?.invoke('add_reference', {
      parentId: fixtureIds.today,
      targetId: fixtureIds.alpha,
      index: null,
    });
    await win.lin?.invoke('add_field_reference', {
      fieldEntryId: fixtureIds.referencesEntry,
      targetNodeId: fixtureIds.alpha,
      id: 'reference-value-alpha',
    });
  }, ids);
  await emitCurrentProjection(page);
}

test('NodePanel references footer shows linked and unlinked sources, and Link converts a mention', async ({ page }) => {
  await openMockedApp(page, { referenceField: true });
  await createReferencesFixture(page);

  await expect(row(page, ids.alpha).locator('.row-reference-counter')).toHaveText('3');
  await row(page, ids.alpha).locator('.row-reference-counter').click();

  const section = page.locator('.backlinks-section');
  await expect(section).toContainText('References');
  await expect(section.locator('.backlinks-section-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(section).toContainText('3 references');
  await expect(section).toContainText('Mentioned in');
  await expect(section).toContainText('Appears as Related in');
  await expect(section).toContainText('Unlinked mentions');
  await expect(section).toContainText('Discuss Alpha soon');

  await section.getByRole('button', { name: 'Link', exact: true }).click();

  await expect.poll(async () => {
    const beta = await nodeById(page, ids.beta);
    return beta?.content.inlineRefs.at(0)?.target.kind === 'node'
      ? beta.content.inlineRefs[0].target.nodeId
      : null;
  }).toBe(ids.alpha);
  await expect(section.getByRole('button', { name: 'Link', exact: true })).toHaveCount(0);
  await expect(section).toContainText('3 references');
});
