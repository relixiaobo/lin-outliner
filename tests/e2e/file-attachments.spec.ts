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

  test('/attachment creates a lightweight file name row whose chevron expands an inline preview and whose bullet drills to the node page', async ({ page }) => {
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

    // Simulate old saved data where the file node has a source filename but an empty
    // node title. The row and preview surface should still render the filename, not
    // "Untitled".
    await page.evaluate((nodeId) => {
      const win = window as typeof window & {
        __LIN_E2E__?: {
          emitDocumentEvent: (event: unknown) => void;
          projection: () => { nodes: Array<{ id: string; content: { text: string; marks?: unknown[]; inlineRefs: unknown[] } }> };
        };
      };
      const projection = win.__LIN_E2E__!.projection();
      const node = projection.nodes.find((entry) => entry.id === nodeId);
      if (!node) throw new Error('missing attachment node');
      node.content = { text: '', marks: [], inlineRefs: [] };
      win.__LIN_E2E__!.emitDocumentEvent({ type: 'projection_changed', projection });
    }, attachmentId);

    // A non-image file is a lightweight name row (no card): the file-type icon serves
    // as the bullet, and the row carries a read-only filename plus a hover-revealed `⋯`
    // menu. The old uniform `.file-node-card` is gone.
    const attachmentRow = row(page, attachmentId!);
    await expect(attachmentRow.locator('.row-bullet-shape.file')).toHaveCount(1);
    await expect(attachmentRow.locator('.file-node-card')).toHaveCount(0);
    const rowMain = attachmentRow.locator('.file-node-row-main');
    await expect(rowMain).toBeVisible();
    await expect(rowMain.locator('.file-node-row-name')).toContainText('picked-report.pdf');
    await expect(rowMain.locator('.file-node-row-name')).not.toContainText('Untitled');
    await expect(attachmentRow.locator('.file-node-row-actions .file-node-card-menu-trigger')).toBeAttached();

    // The filename is display-only: a single click selects the row but does NOT
    // navigate to the node page — the Today outline stays active.
    await attachmentRow.locator('.file-node-row-name').click();
    await expect(page.locator(`.outline-panel-surface.active-panel [data-trailing-parent-id="${ids.today}"]`)).toBeVisible();
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-file-heading')).toHaveCount(0);

    // The chevron expands an INLINE PREVIEW (not children). The chevron is
    // hover-revealed, so hover the row line first, then click it.
    const attachmentRowLine = attachmentRow.locator('> .row').first();
    await attachmentRowLine.hover();
    await attachmentRow.locator('.row-chevron-button').first().click();
    const inlinePreviewCanvas = attachmentRow.locator('.file-node-row-preview .file-node-body .file-preview-pdf-canvas');
    await expect(inlinePreviewCanvas).toBeVisible();

    // Expanding a childless file row must NOT create a phantom editable child draft:
    // the attachment node stays childless and no new node materializes.
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === attachmentId);
      return node?.children.length ?? 0;
    }).toBe(0);
    const childCountAfterExpand = (await todayChildren(page)).length;
    expect(childCountAfterExpand).toBe(beforeChildren.length + 1);

    // The file-type bullet drills to the node page.
    await attachmentRowLine.hover();
    await attachmentRow.locator('.row-bullet-button').first().click();
    const nodePage = page.locator('.outline-panel-surface.active-panel');
    await expect(nodePage.locator('.panel-title-file-heading')).toContainText('picked-report.pdf');
    await expect(nodePage.locator('.panel-title-file-heading')).not.toContainText('Untitled');
    await expect(nodePage.locator('.panel-title-editor .ProseMirror')).toHaveCount(0);

    // The old top meta strip and the actions button row are gone — meta/actions now
    // live on the bottom pill and its `⋯` menu.
    await expect(nodePage.locator('.file-node-meta')).toHaveCount(0);
    await expect(nodePage.locator('.file-node-actions')).toHaveCount(0);

    const pdfCanvas = nodePage.locator('.file-node-body .file-preview-pdf-canvas');
    await expect(pdfCanvas).toBeVisible();
    // The PDF now renders fit-to-width, so the exact pixel size depends on the pane
    // width (it is no longer the fixed 612x792 the old hero used). Assert the page
    // renders real ink at the mock's US-Letter aspect ratio (792/612 ≈ 1.294) instead.
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
      const aspect = canvas.width > 0 ? canvas.height / canvas.width : 0;
      return {
        hasInk,
        rendered: canvas.width > 0 && canvas.height > 0,
        usLetterAspect: Math.abs(aspect - 792 / 612) < 0.02,
      };
    })).toEqual({ hasInk: true, rendered: true, usLetterAspect: true });

    // A single bottom floating pill carries the preview controls: a previewable PDF's
    // primary toggles Expand/Collapse, and the `⋯` menu holds the file-system actions.
    const pill = nodePage.locator('.file-preview-pill');
    await expect(pill).toBeVisible();
    await expect(pill.locator('.file-preview-pill-primary')).toHaveText(/Expand|Collapse/);
    await pill.locator('.file-preview-pill-more').click();
    const pillMenu = page.getByRole('menu', { name: 'Preview actions' });
    await pillMenu.getByRole('menuitem', { name: 'Open with default app' }).click();
    await pill.locator('.file-preview-pill-more').click();
    await pillMenu.getByRole('menuitem', { name: 'Reveal in Finder' }).click();
    await pill.locator('.file-preview-pill-more').click();
    await pillMenu.getByRole('menuitem', { name: 'Copy file' }).click();

    // A file node carries child notes on its node page: an "always" trailing draft in
    // the children outline materializes a child under the attachment when typed into.
    await trailingEditor(page, attachmentId!).click();
    await page.keyboard.type('a note on this file');
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === attachmentId);
      return node?.children.length ?? 0;
    }).toBe(1);
    await expect(nodePage.getByText('a note on this file')).toBeVisible();

    // Back returns to the Today page the file was drilled from.
    await expect(nodePage.locator('.panel-page-back-button')).toBeEnabled();
    await nodePage.locator('.panel-page-back-button').click();
    await expect(attachmentRow.locator('.file-node-row-name')).toContainText('picked-report.pdf');

    // The row's hover `⋯` menu offers Open in split + Reveal in Finder + Copy file.
    await attachmentRowLine.hover();
    await attachmentRow.locator('.file-node-row-actions .file-node-card-menu-trigger').click();
    await expect(page.getByRole('menuitem', { name: 'Open in split' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Copy file' })).toBeVisible();
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
    // file-type icon or filename in the row (the filename is shown in the preview).
    const imageRow = row(page, imageId!);
    await expect(imageRow.locator('.file-node-image-button img')).toBeVisible();
    await expect(imageRow.locator('.file-node-card')).toHaveCount(0);
    // The ⋯ menu lives at the image's top-right (its Maximize/Reveal items share the
    // FileNodeActionMenu exercised by the attachment test above).
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

    // Clicking the image maximizes it; Back returns to the inline image.
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
    const rowName = attachmentRow.locator('.file-node-row-name');
    await expect(rowName).toContainText('picked-report.pdf');

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

    // The name is display-only: typing on the focused file row neither changes the file
    // title nor fires the slash/tag triggers.
    await page.keyboard.type('renamed/#tag');
    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toHaveCount(0);
    await expect(rowName).toContainText('picked-report.pdf');
    await expect(rowName).not.toContainText('renamed');

    // …but structural keyboard nav DOES drive the row. This is the regression we fixed:
    // the old read-only ProseMirror anchor swallowed these (ProseMirror gates
    // handleKeyDown behind view.editable). Enter on the focused file row adds a sibling
    // — guaranteed for file rows regardless of preview state.
    const countBeforeEnter = (await todayChildren(page)).length;
    await anchor.evaluate((element) => (element as HTMLElement).focus());
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await todayChildren(page)).length).toBe(countBeforeEnter + 1);
  });
});
