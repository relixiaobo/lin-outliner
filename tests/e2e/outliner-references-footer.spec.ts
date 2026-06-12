import { expect, test, type Page } from '@playwright/test';
import {
  e2eProjection,
  emitDocumentEvent,
  ids,
  nodeById,
  openMockedApp,
  row,
} from './outlinerMock';

const LONG_UNLINKED_TEXT = 'Discuss Alpha soon with a deliberately long first line that should run underneath the Link action when the backlink row is narrow enough to force the action to float above the title text instead of reserving layout space';
const SOURCE_DESCRIPTION = 'Stored context appears as the secondary line beneath this source node.';

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
          content: { text: fixtureIds.longUnlinkedText, marks: [], inlineRefs: [] },
        }],
      },
    });
    await win.lin?.invoke('update_node_description', {
      nodeId: fixtureIds.beta,
      description: fixtureIds.sourceDescription,
    });
    const referenceResult = await win.lin?.invoke<{ focus?: { nodeId: string } }>('add_reference', {
      parentId: fixtureIds.today,
      targetId: fixtureIds.alpha,
      index: null,
    });
    await win.lin?.invoke('create_node', {
      parentId: fixtureIds.beta,
      index: null,
      text: 'Beta child',
      id: 'reference-source-child',
    });
    await win.lin?.invoke('add_field_reference', {
      fieldEntryId: fixtureIds.referencesEntry,
      targetNodeId: fixtureIds.alpha,
      id: 'reference-value-alpha',
    });
    return referenceResult?.focus?.nodeId ?? '';
  }, { ...ids, longUnlinkedText: LONG_UNLINKED_TEXT, sourceDescription: SOURCE_DESCRIPTION });
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
  await expect(section).toContainText(LONG_UNLINKED_TEXT);
  await expect(section).toContainText(SOURCE_DESCRIPTION);
  const alignment = await page.evaluate((alphaId) => {
    const link = document.querySelector('.backlinks-link-action');
    const linkRow = link?.closest('.backlinks-row');
    const linkRowOpen = linkRow?.querySelector('.backlinks-row-open');
    const sourceMarker = linkRow?.querySelector('.row-bullet-button');
    const sourceTitle = linkRow?.querySelector('.backlinks-row-title');
    const sourceDescription = linkRow?.querySelector('.backlinks-row-description');
    if (!link || !linkRowOpen || !sourceMarker || !sourceTitle || !sourceDescription) {
      throw new Error('missing unlinked row alignment target');
    }
    const linkRect = link.getBoundingClientRect();
    const rowRect = linkRowOpen.getBoundingClientRect();
    const linkStyle = getComputedStyle(link);
    const titleRect = sourceTitle.getBoundingClientRect();
    const titleStyle = getComputedStyle(sourceTitle);
    const titleLineHeight = Number.parseFloat(titleStyle.lineHeight);
    const left = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`missing alignment target: ${selector}`);
      return element.getBoundingClientRect().left;
    };
    return {
      bodyBulletLeft: left(`[data-trailing-parent-id="${alphaId}"] .row-bullet-button`),
      bodyTextLeft: left(`[data-trailing-parent-id="${alphaId}"] .ProseMirror`),
      rowRight: rowRect.right,
      linkLeft: linkRect.left,
      linkRight: linkRect.right,
      linkHeight: linkRect.height,
      linkBackgroundColor: linkStyle.backgroundColor,
      sourceMarkerLeft: sourceMarker.getBoundingClientRect().left,
      sourceTitleHeight: titleRect.height,
      sourceTitleLeft: titleRect.left,
      sourceTitleRight: titleRect.right,
      sourceTitleLineHeight: titleLineHeight,
      sourceTitleWhiteSpace: titleStyle.whiteSpace,
      sourceDescriptionLeft: sourceDescription.getBoundingClientRect().left,
    };
  }, ids.alpha);
  expect(Math.abs(alignment.sourceMarkerLeft - alignment.bodyBulletLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(alignment.sourceTitleLeft - alignment.bodyTextLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(alignment.sourceDescriptionLeft - alignment.bodyTextLeft)).toBeLessThanOrEqual(1);
  expect(alignment.sourceTitleWhiteSpace).toBe('normal');
  expect(alignment.sourceTitleHeight).toBeGreaterThan(alignment.sourceTitleLineHeight * 1.5);
  expect(alignment.linkLeft).toBeGreaterThan(alignment.sourceTitleLeft);
  expect(alignment.sourceTitleRight).toBeLessThanOrEqual(alignment.linkLeft + 1);
  expect(alignment.linkRight).toBeLessThanOrEqual(alignment.rowRight + 1);
  expect(alignment.rowRight - alignment.linkRight).toBeLessThanOrEqual(10);
  expect(alignment.linkHeight).toBeGreaterThan(18);
  expect(alignment.linkBackgroundColor).not.toBe('rgba(0, 0, 0, 0)');

  const linkedGroup = section.locator('.backlinks-group').filter({ hasText: '1 Mentioned in...' }).first();
  const linkedRow = linkedGroup.locator(':scope > .backlinks-list > .backlinks-row').first();
  await linkedRow.locator('.backlinks-row-open').hover();
  await linkedRow.locator('.row-chevron-button').click();
  await expect(linkedRow.locator('.backlinks-row-children')).toContainText('Alpha');
  await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');

  const unlinkedGroup = section.locator('.backlinks-group').filter({ hasText: '1 Unlinked mention' }).first();
  const unlinkedRow = unlinkedGroup.locator(':scope > .backlinks-list > .backlinks-row').first();
  await unlinkedRow.locator('.backlinks-row-open').hover();
  await unlinkedRow.locator('.row-chevron-button').click();
  await expect(unlinkedRow).toContainText('Beta child');
  await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
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
