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

  test('/attachment creates a file node (icon row, child notes) that opens as a node page with a preview hero + actions', async ({ page }) => {
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

    // A file node is a normal node: expanding it reveals its children area, NOT a
    // preview inline (the full preview lives on the node page). The chevron is
    // hover-revealed, so hover the row line before clicking it.
    const attachmentRowLine = attachmentRow.locator('> .row').first();
    await attachmentRowLine.hover();
    await attachmentRow.locator('.row-chevron-button').first().click();
    await expect(attachmentRow.locator('.file-node-body')).toHaveCount(0);

    // Because it is a normal node, a file node carries child notes: typing into its
    // trailing child draft materializes a child under the attachment.
    await trailingEditor(page, attachmentId!).click();
    await page.keyboard.type('a note on this file');
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === attachmentId);
      return node?.children.length ?? 0;
    }).toBe(1);

    // Drilling the bullet opens the file as a node page: the preview is the page
    // hero, with the child-notes outline below it.
    await attachmentRow.locator('.row-bullet-button').first().click();
    const nodePage = page.locator('.outline-panel-surface.active-panel');
    await expect(nodePage.locator('.file-node-meta')).toContainText('PDF');
    await expect(nodePage.locator('.file-node-meta')).toContainText('1 page');
    await expect(nodePage.getByText('a note on this file')).toBeVisible();

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

  test('/image creates an image node that renders a row-level thumbnail', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/image');

    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    await expect(page.getByRole('option', { name: /Image/ })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const imageId = (await todayChildren(page)).at(-1);
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === imageId);
      return node?.type ?? null;
    }).toBe('image');

    // An image is the one file kind that renders inline — a bounded row-level
    // thumbnail under the filename (part of the row, not a child block). The bullet
    // is still the file glyph, and the chevron stays free for children.
    const imageRow = row(page, imageId!);
    await expect(imageRow.locator('.row-bullet-shape.file')).toBeVisible();
    await expect(imageRow.locator('.row-content-line > .row-image-thumb img')).toBeVisible();
  });
});
