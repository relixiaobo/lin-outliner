import { expect, test } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  ids,
  openMockedApp,
  row,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

async function todayChildren(page: Parameters<typeof trailingEditor>[0]) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

test.describe('file attachments', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('/attachment creates a file row that opens as a node page with a preview + actions', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/attachment');

    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    await expect(page.getByRole('option', { name: /Attachment/ })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const attachmentId = (await todayChildren(page)).at(-1);
    expect(attachmentId).toBeTruthy();
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === attachmentId);
      return node?.type ?? null;
    }).toBe('attachment');

    // A file is an ordinary row now: a file-type bullet + the filename as its text.
    const attachmentRow = row(page, attachmentId!);
    await expect(attachmentRow.locator('.row-bullet-shape.file')).toBeVisible();
    await expect(rowEditor(page, attachmentId!)).toContainText('picked-report.pdf');

    // Expanding the file node (chevron) reveals its preview inline as the child
    // level — the same preview the node page shows, bounded under the row. The
    // chevron is hover-revealed, so hover the row line (not the whole wrap, which
    // grows to include the preview) before clicking.
    const attachmentRowLine = attachmentRow.locator('> .row').first();
    await attachmentRowLine.hover();
    await attachmentRow.locator('.row-chevron-button').first().click();
    const inlineBlock = attachmentRow.locator('.file-node-children .file-node-body--inline');
    await expect(inlineBlock.locator('.file-node-meta')).toContainText('PDF');
    await expect(inlineBlock.locator('.file-node-preview .file-preview-pdf-canvas')).toBeVisible();
    // Collapsing removes the inline preview again.
    await attachmentRowLine.hover();
    await attachmentRow.locator('.row-chevron-button').first().click();
    await expect(attachmentRow.locator('.file-node-children')).toHaveCount(0);

    // Drilling the bullet opens the file as a node page whose body is the preview.
    await attachmentRow.locator('.row-bullet-button').first().click();
    const nodePage = page.locator('.outline-panel-surface.active-panel');
    await expect(nodePage.locator('.file-node-meta')).toContainText('PDF');
    await expect(nodePage.locator('.file-node-meta')).toContainText('1 page');

    const pdfCanvas = nodePage.locator('.file-node-preview .file-preview-pdf-canvas');
    await expect(pdfCanvas).toBeVisible();
    await expect.poll(async () => pdfCanvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      const data = context && canvas.width > 0 && canvas.height > 0
        ? context.getImageData(0, 0, canvas.width, canvas.height).data
        : null;
      let hasInk = false;
      if (data) {
        for (let index = 0; index < data.length; index += 4) {
          const alpha = data[index + 3] ?? 0;
          const red = data[index] ?? 255;
          const green = data[index + 1] ?? 255;
          const blue = data[index + 2] ?? 255;
          if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) {
            hasInk = true;
            break;
          }
        }
      }
      return { height: canvas.height, hasInk, width: canvas.width };
    })).toEqual({ height: 792, hasInk: true, width: 612 });
    await expect(nodePage.locator('.file-node-preview .file-preview-message')).toBeHidden();

    // The node-page header carries the file system actions.
    const actions = nodePage.locator('.file-node-actions');
    await actions.getByRole('button', { name: 'Open' }).click();
    await actions.getByRole('button', { name: 'Reveal in Finder' }).click();
    await actions.getByRole('button', { name: 'Copy file' }).click();

    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'pick_attachment_files')).toBe(true);
    expect(calls.some((call) => call.cmd === 'create_attachment_node')).toBe(true);
    expect(calls.some((call) => call.cmd === 'open_asset')).toBe(true);
    expect(calls.some((call) => call.cmd === 'reveal_asset')).toBe(true);
    expect(calls.some((call) => call.cmd === 'copy_asset_file')).toBe(true);
  });
});
