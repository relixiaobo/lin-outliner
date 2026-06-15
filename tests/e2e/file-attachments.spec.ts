import { expect, test } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  ids,
  openMockedApp,
  row,
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

  test('/attachment creates a click-to-open file card (icon · filename · meta · ⋯ menu) that opens as a node page', async ({ page }) => {
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

    // A non-image file renders a uniform card: a file-type icon, the display-only
    // filename (a single truncated line — renamed on the node page, not inline), and a
    // meta line. The bullet stays a plain node handle (the file-type icon is on the card).
    const attachmentRow = row(page, attachmentId!);
    const card = attachmentRow.locator('.file-node-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.file-node-card-icon')).toBeVisible();
    await expect(card.locator('.file-node-card-name')).toContainText('picked-report.pdf');
    await expect(card.locator('.file-node-card-meta')).toContainText('PDF');

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

    // Clicking the card opens the file as a node page: the preview is the page hero,
    // with the child-notes outline below it.
    await card.locator('.file-node-card-name').click();
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

    // Back returns to the previous node (the Today page the file was drilled from).
    await expect(nodePage.locator('.panel-page-back-button')).toBeEnabled();
    await nodePage.locator('.panel-page-back-button').click();
    await expect(card.locator('.file-node-card-name')).toContainText('picked-report.pdf');

    // The card's ⋯ menu offers Open in split + Reveal in Finder.
    await card.hover();
    await card.locator('.file-node-card-menu-trigger').click();
    await expect(page.getByRole('menuitem', { name: 'Open in split' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeVisible();
    await page.keyboard.press('Escape');

    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'pick_attachment_files')).toBe(true);
    expect(calls.some((call) => call.cmd === 'create_attachment_node')).toBe(true);
    expect(calls.some((call) => call.cmd === 'open_asset')).toBe(true);
    expect(calls.some((call) => call.cmd === 'reveal_asset')).toBe(true);
    expect(calls.some((call) => call.cmd === 'copy_asset_file')).toBe(true);
  });

  test('/image creates a file node rendered as the image itself inline (no card, no filename), maximizing on click', async ({ page }) => {
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

    // An image is the one file kind that renders inline as the image itself — an
    // image's content is its identity. It does NOT use the file card and shows no
    // file-type icon or filename in the row (the filename is edited on the node page).
    const imageRow = row(page, imageId!);
    await expect(imageRow.locator('.file-node-image-button img')).toBeVisible();
    await expect(imageRow.locator('.file-node-card')).toHaveCount(0);
    // The ⋯ menu lives at the image's top-right (its Maximize/Reveal items share the
    // FileNodeActionMenu exercised by the card test above).
    await expect(imageRow.locator('.file-node-image-actions .file-node-card-menu-trigger')).toBeAttached();

    // …and it is pinned to the image's REAL top-right corner. The mock image is wider
    // than the inline cap, so it renders at the capped width; the positioning wrapper
    // must hug that rendered box, not grow to the row width — otherwise the overlay
    // floats in the empty gap to the right of the image (a regression we hit and fixed).
    const overlayGeometry = await imageRow.evaluate((rowEl) => {
      const imgEl = rowEl.querySelector('.file-node-image-button img');
      const triggerEl = rowEl.querySelector('.file-node-image-actions .file-node-card-menu-trigger');
      if (!imgEl || !triggerEl) return null;
      const img = imgEl.getBoundingClientRect();
      const trigger = triggerEl.getBoundingClientRect();
      return { rightGap: Math.round(img.right - trigger.right), topGap: Math.round(trigger.top - img.top) };
    });
    expect(overlayGeometry).not.toBeNull();
    // Inset from the corner is small and positive (the overlay sits just inside the image).
    expect(overlayGeometry!.rightGap).toBeGreaterThanOrEqual(0);
    expect(overlayGeometry!.rightGap).toBeLessThanOrEqual(12);
    expect(overlayGeometry!.topGap).toBeGreaterThanOrEqual(0);
    expect(overlayGeometry!.topGap).toBeLessThanOrEqual(12);

    // Clicking the image maximizes it (its node page); Back returns to the inline image.
    await imageRow.locator('.file-node-image-button').click();
    await expect(page.locator('.outline-panel-surface.active-panel .file-node-body')).toBeVisible();
    await expect(page.locator('.outline-panel-surface.active-panel .panel-page-back-button')).toBeEnabled();
    await page.locator('.outline-panel-surface.active-panel .panel-page-back-button').click();
    await expect(imageRow.locator('.file-node-image-button img')).toBeVisible();
  });

  test('a file row is a focusable keyboard anchor: display-only name, but arrow/Enter nav works', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/attachment');
    await expect(page.getByRole('option', { name: /Attachment/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const attachmentId = (await todayChildren(page)).at(-1)!;
    const attachmentRow = row(page, attachmentId);
    const cardName = attachmentRow.locator('.file-node-card-name');
    await expect(cardName).toContainText('picked-report.pdf');

    // A file row carries no inline editor — just a visually hidden, focusable anchor
    // (a lightweight div, NOT a ProseMirror) that drives the row by keyboard.
    const anchor = attachmentRow.locator('.file-node-keyboard-anchor');
    await expect(anchor).toHaveCount(1);
    await expect(anchor.locator('.ProseMirror')).toHaveCount(0);
    const focused = await anchor.evaluate((element) => {
      (element as HTMLElement).focus();
      return element === document.activeElement;
    });
    expect(focused).toBe(true);

    // The name is display-only: typing on the focused file row neither renames the file
    // nor fires the slash/tag triggers (rename happens on the node page).
    await page.keyboard.type('renamed/#tag');
    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toHaveCount(0);
    await expect(cardName).toContainText('picked-report.pdf');
    await expect(cardName).not.toContainText('renamed');

    // …but structural keyboard nav DOES drive the row. This is the regression we fixed:
    // the old read-only ProseMirror anchor swallowed these (ProseMirror gates
    // handleKeyDown behind view.editable). Enter on the focused file row adds a sibling.
    const countBeforeEnter = (await todayChildren(page)).length;
    await anchor.evaluate((element) => (element as HTMLElement).focus());
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await todayChildren(page)).length).toBe(countBeforeEnter + 1);
  });
});
