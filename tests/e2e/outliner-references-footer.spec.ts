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

async function createReferencesFixture(page: Page): Promise<string> {
  const referenceId = await page.evaluate(async (fixtureIds) => {
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
    const referenceResult = await win.lin?.invoke<{ focus?: { nodeId: string } }>('add_reference', {
      parentId: fixtureIds.today,
      targetId: fixtureIds.alpha,
      index: null,
    });
    await win.lin?.invoke('add_field_reference', {
      fieldEntryId: fixtureIds.referencesEntry,
      targetNodeId: fixtureIds.alpha,
      id: 'reference-value-alpha',
    });
    return referenceResult?.focus?.nodeId ?? '';
  }, ids);
  if (!referenceId) throw new Error('reference fixture did not create a reference row');
  await emitCurrentProjection(page);
  return referenceId;
}

test('NodePanel references footer shows linked and unlinked sources, and Link converts a mention', async ({ page }) => {
  await openMockedApp(page, { referenceField: true });
  await createReferencesFixture(page);

  await expect(page.locator('.row-reference-counter')).toHaveCount(0);
  await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();

  const section = page.locator('.backlinks-section');
  await expect(section.locator('.backlinks-section-count')).toHaveText('3 references');
  await expect(section.locator('.backlinks-section-toggle')).toHaveAttribute('aria-expanded', 'false');
  await section.locator('.backlinks-section-toggle').click();
  await expect(section.locator('.backlinks-section-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(section).toContainText('1 Mentioned in...');
  await expect(section).toContainText('1 Appears as Related in...');
  await expect(section).toContainText('1 Unlinked mention');
  await expect(section).toContainText('Discuss Alpha soon');
  const alignment = await page.evaluate((alphaId) => {
    const left = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`missing alignment target: ${selector}`);
      return element.getBoundingClientRect().left;
    };
    return {
      bodyBulletLeft: left(`[data-trailing-parent-id="${alphaId}"] .row-bullet-button`),
      bodyTextLeft: left(`[data-trailing-parent-id="${alphaId}"] .ProseMirror`),
      sourceMarkerLeft: left('.backlinks-row-open .row-bullet-button'),
      sourceTitleLeft: left('.backlinks-row-title'),
    };
  }, ids.alpha);
  expect(Math.abs(alignment.sourceMarkerLeft - alignment.bodyBulletLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(alignment.sourceTitleLeft - alignment.bodyTextLeft)).toBeLessThanOrEqual(1);
  await expect(section.locator('.backlinks-row-open .row-chevron-shell')).toHaveCount(3);
  await expect(section.locator('.backlinks-row-chevron-slot')).toHaveCount(0);

  await section.getByRole('button', { name: 'Link', exact: true }).click();

  await expect.poll(async () => {
    const beta = await nodeById(page, ids.beta);
    return beta?.content.inlineRefs.at(0)?.target.kind === 'node'
      ? beta.content.inlineRefs[0].target.nodeId
      : null;
  }).toBe(ids.alpha);
  await expect(section.getByRole('button', { name: 'Link', exact: true })).toHaveCount(0);
  await expect(section.locator('.backlinks-section-count')).toHaveText('3 references');
});

test('opening a reference row renders the target node page, not the reference shell', async ({ page }) => {
  await openMockedApp(page, { referenceField: true });
  const referenceId = await createReferencesFixture(page);

  await row(page, referenceId).getByRole('button', { name: 'Open' }).click();

  await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
  await expect(page.locator('.backlinks-section-count')).toHaveText('3 references');
  await expect(page.locator('.row-reference-counter')).toHaveCount(0);
});
