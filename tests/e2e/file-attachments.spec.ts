import { expect, test, type Locator } from '@playwright/test';
import {
  commandCalls,
  emitDocumentEvent,
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

async function contrastAgainstWhitePreview(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const parseColor = (value: string): [number, number, number, number] => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) throw new Error(`Unsupported color ${value}`);
      const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const composite = (
      top: [number, number, number, number],
      bottom: [number, number, number, number],
    ): [number, number, number, number] => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      return [
        (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
        (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
        (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
        alpha,
      ];
    };
    const luminance = ([r, g, b]: [number, number, number, number]) => {
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const style = getComputedStyle(element);
    const white: [number, number, number, number] = [255, 255, 255, 1];
    const background = composite(parseColor(style.backgroundColor), white);
    const foreground = composite(parseColor(style.color), background);
    const low = Math.min(luminance(background), luminance(foreground));
    const high = Math.max(luminance(background), luminance(foreground));
    return (high + 0.05) / (low + 0.05);
  });
}

type ExternalFileDropPosition = 'before' | 'inside' | 'after';

async function startExternalFileDrag(page: Parameters<typeof trailingEditor>[0], file: { name: string; mimeType: string; text: string }) {
  await page.evaluate((input) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([input.text], input.name, { type: input.mimeType }));
    (window as Window & { __LIN_E2E_EXTERNAL_FILE_DRAG__?: DataTransfer }).__LIN_E2E_EXTERNAL_FILE_DRAG__ = dataTransfer;
  }, file);
}

async function pasteClipboardFile(page: Parameters<typeof trailingEditor>[0], file: { name: string; mimeType: string; text: string }) {
  await page.evaluate((input) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([input.text], input.name, { type: input.mimeType }));
    const target = document.activeElement;
    if (!target) throw new Error('No active paste target');
    target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    }));
  }, file);
}

async function dispatchExternalFileDrag(
  page: Parameters<typeof trailingEditor>[0],
  targetId: string,
  position: ExternalFileDropPosition,
  eventType: 'dragover' | 'drop',
) {
  await page.evaluate(({ nodeId, position: nextPosition, eventType: nextEventType }) => {
    const target = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] > .row`);
    const dataTransfer = (window as Window & { __LIN_E2E_EXTERNAL_FILE_DRAG__?: DataTransfer }).__LIN_E2E_EXTERNAL_FILE_DRAG__;
    if (!target || !dataTransfer) throw new Error(`Missing external file drag target ${nodeId}`);
    const rect = target.getBoundingClientRect();
    const yRatio = nextPosition === 'before' ? 0.1 : nextPosition === 'after' ? 0.9 : 0.5;
    target.dispatchEvent(new DragEvent(nextEventType, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(48, rect.width / 2),
      clientY: rect.top + rect.height * yRatio,
      dataTransfer,
    }));
    if (nextEventType === 'drop') {
      delete (window as Window & { __LIN_E2E_EXTERNAL_FILE_DRAG__?: DataTransfer }).__LIN_E2E_EXTERNAL_FILE_DRAG__;
    }
  }, { nodeId: targetId, position, eventType });
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

    const longFilename = '01KRONS5VGWKCMGEN42FKHVS26-diffs_from_pierre_unbroken_review_bundle_for_wrap_regression.pdf';
    // Simulate old saved data where the file node has a source filename but an empty
    // node title. The row and preview surface should still render the filename, not
    // "Untitled"; long filenames wrap like read-only reference rows instead of
    // truncating behind an ellipsis.
    await page.evaluate(({ nodeId, longFilename, tagId }) => {
      const win = window as typeof window & {
        __LIN_E2E__?: {
          emitDocumentEvent: (event: unknown) => void;
          projection: () => {
            nodes: Array<{
              id: string;
              content: { text: string; marks?: unknown[]; inlineRefs: unknown[] };
              originalFilename?: string;
              tags?: string[];
            }>;
          };
        };
      };
      const projection = win.__LIN_E2E__!.projection();
      const node = projection.nodes.find((entry) => entry.id === nodeId);
      if (!node) throw new Error('missing attachment node');
      node.content = { text: '', marks: [], inlineRefs: [] };
      node.originalFilename = longFilename;
      node.tags = [tagId];
      win.__LIN_E2E__!.emitDocumentEvent({ type: 'projection_changed', projection });
    }, { nodeId: attachmentId, longFilename, tagId: ids.projectTag });

    // A non-image file is a lightweight name row (no card): the file-type icon serves
    // as the bullet, and the row carries a read-only filename. The old uniform
    // `.file-node-card` and the old row-level `⋯` menu are gone; file actions live in
    // the preview pill.
    const attachmentRow = row(page, attachmentId!);
    await expect(attachmentRow.locator('.row-bullet-shape.file')).toHaveCount(1);
    await expect(attachmentRow.locator('.file-node-card')).toHaveCount(0);
    const rowMain = attachmentRow.locator('.file-node-row-main');
    await expect(rowMain).toBeVisible();
    await expect(rowMain.locator('.file-node-row-name')).toContainText(longFilename);
    await expect(rowMain.locator('.file-node-row-name')).not.toContainText('Untitled');
    await expect(rowMain.locator('.file-node-row-labels > .tag-bar .tag-badge-label')).toHaveText('project');
    await expect(attachmentRow.locator('> .row .row-content-line > .tag-bar')).toHaveCount(0);
    await expect(rowMain.locator('.file-node-card-menu-trigger')).toHaveCount(0);
    await expect(attachmentRow.locator('.file-node-row-actions')).toHaveCount(0);
    await expect.poll(async () => rowMain.locator('.file-node-row-labels').evaluate((element) => {
      const style = getComputedStyle(element);
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      range.detach();
      return {
        wraps: rects.length > 1,
        whiteSpace: style.whiteSpace,
        overflows: element.scrollWidth > element.clientWidth + 1,
      };
    })).toEqual({ wraps: true, whiteSpace: 'normal', overflows: false });
    await expect.poll(async () => attachmentRow.evaluate((element) => {
      const icon = element.querySelector('.row-bullet-shape.file');
      const name = element.querySelector('.file-node-row-name');
      if (!icon || !name) return null;
      const range = document.createRange();
      range.selectNodeContents(name);
      const firstLine = Array.from(range.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0);
      range.detach();
      if (!firstLine) return null;
      const iconRect = icon.getBoundingClientRect();
      const firstLineCenter = firstLine.top + firstLine.height / 2;
      const iconCenter = iconRect.top + iconRect.height / 2;
      return Math.round(Math.abs(firstLineCenter - iconCenter));
    })).toBeLessThanOrEqual(3);
    await expect.poll(async () => attachmentRow.evaluate((element, contentNodeId) => {
      const contentButton = document.querySelector(`[data-node-id="${contentNodeId}"] .row-bullet-button`);
      const button = element.querySelector('.row-bullet-button');
      const marker = element.querySelector('.row-bullet-shape.file');
      const icon = marker?.querySelector('.inline-ref-file-icon');
      if (!contentButton || !button || !marker || !icon) return null;
      const centerX = (rect: DOMRect) => rect.left + rect.width / 2;
      const contentButtonRect = contentButton.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const iconStyle = getComputedStyle(icon);
      return {
        buttonWidth: Math.round(buttonRect.width),
        contentButtonWidth: Math.round(contentButtonRect.width),
        iconHeight: Math.round(iconRect.height),
        iconCentered: Math.abs(centerX(iconRect) - centerX(buttonRect)) <= 0.5,
        iconWidth: Math.round(iconRect.width),
        iconMarginRight: iconStyle.marginRight,
        markerHeight: Math.round(markerRect.height),
        markerCentered: Math.abs(centerX(markerRect) - centerX(buttonRect)) <= 0.5,
        markerWidth: Math.round(markerRect.width),
        sameHitHeight: Math.abs(buttonRect.height - contentButtonRect.height) <= 0.5,
        sameHitWidth: Math.abs(buttonRect.width - contentButtonRect.width) <= 0.5,
      };
    }, ids.alpha)).toEqual({
      buttonWidth: 15,
      contentButtonWidth: 15,
      iconHeight: 15,
      iconCentered: true,
      iconWidth: 15,
      iconMarginRight: '0px',
      markerHeight: 15,
      markerCentered: true,
      markerWidth: 15,
      sameHitHeight: true,
      sameHitWidth: true,
    });

    // The filename is display-only: a single click selects the row but does NOT
    // navigate to the node page — the Today outline stays active.
    await attachmentRow.locator('.file-node-row-name').click();
    await expect(page.locator(`.outline-panel-surface.active-panel [data-trailing-parent-id="${ids.today}"]`)).toBeVisible();
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-file-heading')).toHaveCount(0);

    // The chevron expands an INLINE PREVIEW (not children). The chevron is
    // hover-revealed, so hover the row line first, then click it.
    const attachmentRowLine = attachmentRow.locator('> .row').first();
    const attachmentChevron = attachmentRow.locator('.row-chevron-button').first();
    await page.mouse.move(5, 5);
    await expect.poll(async () => attachmentChevron.evaluate((element) =>
      Number(getComputedStyle(element).opacity))).toBe(0);
    await attachmentRowLine.hover();
    await expect.poll(async () => attachmentChevron.evaluate((element) =>
      Number(getComputedStyle(element).opacity))).toBeGreaterThan(0.9);
    await attachmentChevron.click();
    const inlinePreviewFrame = attachmentRow.locator('.file-node-row-preview .file-node-preview.collapsed');
    await expect(inlinePreviewFrame).toBeVisible();
    await expect.poll(async () => inlinePreviewFrame.evaluate((element) => {
      const style = getComputedStyle(element);
      const summaryStrip = element.querySelector<HTMLElement>('.file-preview-pdf--summary');
      const summaryStyle = summaryStrip ? getComputedStyle(summaryStrip) : null;
      const summaryRect = summaryStrip?.getBoundingClientRect();
      const canvases = Array.from(element.querySelectorAll<HTMLElement>('.file-preview-pdf-canvas'));
      const firstCanvas = canvases[0];
      const secondCanvas = canvases[1];
      const frameRect = element.getBoundingClientRect();
      const firstRect = firstCanvas?.getBoundingClientRect();
      const secondRect = secondCanvas?.getBoundingClientRect();
      const frameRadius = Number.parseFloat(style.borderTopLeftRadius);
      const paddingLeft = Number.parseFloat(style.paddingLeft);
      const paddingTop = Number.parseFloat(style.paddingTop);
      const canvasRadius = firstCanvas ? Number.parseFloat(getComputedStyle(firstCanvas).borderTopLeftRadius) : 0;
      const measuredGap = firstRect && secondRect ? Math.round(secondRect.left - firstRect.right) : Number.POSITIVE_INFINITY;
      const scrollbarGutter = summaryStyle ? Number.parseFloat(summaryStyle.paddingBottom) : 0;
      if (summaryStrip && summaryStrip.scrollWidth > summaryStrip.clientWidth) {
        summaryStrip.scrollLeft = Math.min(48, summaryStrip.scrollWidth - summaryStrip.clientWidth);
      }
      const edgeHit = firstRect
        ? document.elementFromPoint(frameRect.left + paddingLeft / 2, firstRect.top + Math.min(24, firstRect.height / 2))
        : null;
      const topInset = firstRect ? firstRect.top - frameRect.top : 0;
      const bottomInset = firstRect ? frameRect.bottom - firstRect.bottom : 0;
      return {
        bottomInsetMatchesTop: firstRect ? Math.abs(bottomInset - topInset) <= 1 : false,
        compactGap: measuredGap <= 6,
        compactHeight: element.getBoundingClientRect().height <= 260,
        edgeInset: firstRect ? firstRect.left - frameRect.left >= 7 && firstRect.top - frameRect.top >= 7 : false,
        frameRadius: frameRadius >= 10 && frameRadius <= 14,
        horizontalSummary: style.overflowX === 'hidden' && summaryStyle?.overflowX === 'auto',
        noScrollBleed: edgeHit ? !edgeHit.closest('.file-preview-pdf-page, .file-preview-pdf-stage, .file-preview-pdf-canvas') : false,
        pageRadius: canvasRadius >= 6 && canvasRadius <= frameRadius,
        scrollbarBelowPage: firstRect && summaryRect ? summaryRect.bottom - firstRect.bottom >= scrollbarGutter - 1 : false,
        symmetricInset: firstRect ? Math.abs((firstRect.left - frameRect.left) - (firstRect.top - frameRect.top)) <= 1 : false,
      };
    })).toEqual({
      bottomInsetMatchesTop: true,
      compactGap: true,
      compactHeight: true,
      edgeInset: true,
      frameRadius: true,
      horizontalSummary: true,
      noScrollBleed: true,
      pageRadius: true,
      scrollbarBelowPage: true,
      symmetricInset: true,
    });
    await expect.poll(async () => attachmentRow.evaluate((element) => {
      const rowElement = element.querySelector(':scope > .row');
      const previewElement = element.querySelector('.file-node-row-preview');
      if (!rowElement || !previewElement) return 0;
      const rowRect = rowElement.getBoundingClientRect();
      const previewRect = previewElement.getBoundingClientRect();
      return Math.round(previewRect.top - rowRect.bottom);
    })).toBeGreaterThanOrEqual(8);
    const inlinePreviewCanvas = attachmentRow.locator('.file-node-row-preview .file-preview-pdf--summary .file-preview-pdf-canvas');
    await expect(inlinePreviewCanvas).toHaveCount(3);
    await expect(inlinePreviewCanvas.first()).toBeVisible();
    await expect.poll(async () => attachmentRow.evaluate((element) => {
      const frameElement = element.querySelector('.file-node-row-preview .file-node-preview.collapsed');
      const canvasElement = element.querySelector('.file-node-row-preview .file-preview-pdf-canvas');
      if (!frameElement || !canvasElement) return null;
      const frameRect = frameElement.getBoundingClientRect();
      const canvasRect = canvasElement.getBoundingClientRect();
      return Math.round(frameRect.bottom - canvasRect.bottom);
    })).toBeLessThanOrEqual(36);
    await expect.poll(async () => attachmentRow.evaluate((element) => {
      const frameElement = element.querySelector('.file-node-row-preview .file-node-preview.collapsed');
      const summaryElement = element.querySelector<HTMLElement>('.file-node-row-preview .file-preview-pdf--summary');
      const canvasElement = element.querySelector('.file-node-row-preview .file-preview-pdf-canvas');
      const pillElement = element.querySelector('.file-node-row-preview .file-preview-pill');
      if (!frameElement || !summaryElement || !canvasElement || !pillElement) return null;
      const summaryStyle = getComputedStyle(summaryElement);
      const summaryRect = summaryElement.getBoundingClientRect();
      const canvasRect = canvasElement.getBoundingClientRect();
      const pillRect = pillElement.getBoundingClientRect();
      const scrollbarGutter = Number.parseFloat(summaryStyle.paddingBottom);
      const availablePageHeight = summaryElement.clientHeight - scrollbarGutter;
      return {
        pageFitsViewport: canvasRect.height >= availablePageHeight - 3,
        pillOverlaysPage: pillRect.top < canvasRect.bottom && pillRect.bottom > canvasRect.top,
        scrollbarBelowPage: summaryRect.bottom - canvasRect.bottom >= scrollbarGutter - 1,
      };
    })).toEqual({ pageFitsViewport: true, pillOverlaysPage: true, scrollbarBelowPage: true });
    const resizeHandle = attachmentRow.locator('.file-node-row-preview .file-preview-resize-handle');
    await expect(resizeHandle).toBeVisible();
    const beforeResizeHeight = await inlinePreviewFrame.evaluate((element) => element.getBoundingClientRect().height);
    const handleBox = await resizeHandle.boundingBox();
    expect(handleBox).not.toBeNull();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2 + 56, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => inlinePreviewFrame.evaluate((element) => Math.round(element.getBoundingClientRect().height)))
      .toBeGreaterThanOrEqual(Math.round(beforeResizeHeight + 48));

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
    await expect(nodePage.locator('.panel-title-file-heading')).toContainText(longFilename);
    await expect(nodePage.locator('.panel-title-file-heading')).not.toContainText('Untitled');
    await expect(nodePage.locator('.panel-title-editor .ProseMirror')).toHaveCount(0);

    // The old top meta strip and the actions button row are gone — meta/actions now
    // live on the bottom pill and its `⋯` menu.
    await expect(nodePage.locator('.file-node-meta')).toHaveCount(0);
    await expect(nodePage.locator('.file-node-actions')).toHaveCount(0);

    const previewStage = nodePage.locator('.file-node-body .file-node-preview');
    await expect(previewStage).toHaveClass(/collapsed/);
    await expect(nodePage.locator('.file-node-preview.collapsed .file-preview-pdf--summary .file-preview-pdf-canvas')).toHaveCount(3);

    // A summary PDF page is itself an expand target: clicking page 2 switches to the
    // full reader and scrolls that internally-scrolling preview to page 2.
    const pill = nodePage.locator('.file-preview-pill');
    await expect(pill).toBeVisible();
    await expect(pill.locator('.file-preview-pill-primary')).toHaveText('Expand');
    await expect.poll(async () => pill.evaluate((element) => {
      const primary = element.querySelector('.file-preview-pill-primary');
      const more = element.querySelector('.file-preview-pill-more');
      if (!primary || !more) return null;
      return Math.round(Math.abs(
        primary.getBoundingClientRect().height - more.getBoundingClientRect().height,
      ));
    })).toBe(0);
    await pill.locator('.file-preview-pill-primary').hover();
    expect(await contrastAgainstWhitePreview(pill.locator('.file-preview-pill-primary'))).toBeGreaterThanOrEqual(4.5);
    await pill.locator('.file-preview-pill-more').hover();
    expect(await contrastAgainstWhitePreview(pill.locator('.file-preview-pill-more'))).toBeGreaterThanOrEqual(4.5);
    const expandButtonWidth = await pill.locator('.file-preview-pill-primary').evaluate((element) =>
      Math.round(element.getBoundingClientRect().width));
    await nodePage.locator('.file-node-preview.collapsed .file-preview-pdf-page').nth(1).click();
    await expect(previewStage).toHaveClass(/expanded/);
    await expect(pill.locator('.file-preview-pill-primary')).toHaveText('Collapse');
    const collapseButtonWidth = await pill.locator('.file-preview-pill-primary').evaluate((element) =>
      Math.round(element.getBoundingClientRect().width));
    expect(collapseButtonWidth).toBe(expandButtonWidth);
    await expect(pill.locator('.file-preview-pill-divider')).toHaveCount(0);
    await expect.poll(async () => previewStage.evaluate((element) => {
      const page = element.querySelector<HTMLElement>('[data-pdf-page-number="2"]');
      if (!page) return false;
      const frame = element.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      return Math.abs(pageRect.top - frame.top) <= 16;
    })).toBe(true);
    const pdfCanvas = nodePage.locator('.file-node-preview.expanded .file-preview-pdf--full [data-pdf-page-number="2"] .file-preview-pdf-canvas').first();
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
    await expect.poll(async () => previewStage.evaluate((element) => {
      const fullReader = element.querySelector<HTMLElement>('.file-preview-pdf--full');
      const page = element.querySelector<HTMLElement>('.file-preview-pdf--full .file-preview-pdf-page');
      const canvas = element.querySelector<HTMLElement>('.file-preview-pdf--full .file-preview-pdf-canvas');
      if (!fullReader || !page || !canvas) return null;
      fullReader.scrollTop = Math.min(160, Math.max(0, fullReader.scrollHeight - fullReader.clientHeight));
      const frameStyle = getComputedStyle(element);
      const readerStyle = getComputedStyle(fullReader);
      const frameRect = element.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const pill = document.querySelector<HTMLElement>('.file-preview-pill');
      const pillRect = pill?.getBoundingClientRect();
      const paddingTop = Number.parseFloat(frameStyle.paddingTop);
      const paddingBottom = Number.parseFloat(frameStyle.paddingBottom);
      const sampleX = canvasRect.left + canvasRect.width * 0.25;
      const topHit = document.elementFromPoint(sampleX, frameRect.top + paddingTop / 2);
      const bottomHit = document.elementFromPoint(sampleX, frameRect.bottom - Math.min(12, paddingBottom / 2));
      const isPdfHit = (target: Element | null) => Boolean(target?.closest(
        '.file-preview-pdf-page, .file-preview-pdf-stage, .file-preview-pdf-canvas',
      ));
      return {
        bottomInsetClear: !isPdfHit(bottomHit),
        frameDoesNotScroll: frameStyle.overflowY === 'hidden',
        pillOverlaysPage: pillRect ? pillRect.top < canvasRect.bottom && pillRect.bottom > canvasRect.top : false,
        readerScrolls: readerStyle.overflowY === 'auto',
        topInsetClear: !isPdfHit(topHit),
      };
    })).toEqual({
      bottomInsetClear: true,
      frameDoesNotScroll: true,
      pillOverlaysPage: true,
      readerScrolls: true,
      topInsetClear: true,
    });

    await pill.locator('.file-preview-pill-primary').click();
    await expect(previewStage).toHaveClass(/collapsed/);
    await expect(pill.locator('.file-preview-pill-primary')).toHaveText('Expand');
    await expect.poll(async () => previewStage.evaluate((element) => {
      const summaryElement = element.querySelector<HTMLElement>('.file-preview-pdf--summary');
      const canvas = element.querySelector<HTMLCanvasElement>('.file-preview-pdf--summary .file-preview-pdf-canvas');
      if (!summaryElement || !canvas) return null;
      const summaryStyle = getComputedStyle(summaryElement);
      const frameRect = element.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const scrollbarGutter = Number.parseFloat(summaryStyle.paddingBottom);
      const availablePageHeight = summaryElement.clientHeight - scrollbarGutter;
      const pixelRatio = window.devicePixelRatio || 1;
      return {
        bitmapMatchesCss: Math.abs(canvas.width / pixelRatio - canvasRect.width) <= 2
          && Math.abs(canvas.height / pixelRatio - canvasRect.height) <= 2,
        bottomInsetMatchesTop: Math.abs((frameRect.bottom - canvasRect.bottom) - (canvasRect.top - frameRect.top)) <= 1,
        fitsSummaryHeight: Math.abs(canvasRect.height - availablePageHeight) <= 3,
        rendered: canvas.width > 0 && canvas.height > 0,
      };
    })).toEqual({
      bitmapMatchesCss: true,
      bottomInsetMatchesTop: true,
      fitsSummaryHeight: true,
      rendered: true,
    });

    const pillMoreButton = pill.locator('.file-preview-pill-more');
    await pillMoreButton.click();
    const pillMenu = page.getByRole('menu', { name: 'Preview actions' });
    const openWithDefaultAppItem = pillMenu.getByRole('menuitem', { name: 'Open with default app' });
    await expect(openWithDefaultAppItem).toBeVisible();
    await expect.poll(async () => openWithDefaultAppItem.evaluate((element) =>
      document.activeElement === element)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(pillMenu).toBeHidden();
    await pillMoreButton.press('Enter');
    await expect.poll(async () => openWithDefaultAppItem.evaluate((element) =>
      document.activeElement === element)).toBe(true);
    await openWithDefaultAppItem.click();
    await pillMoreButton.click();
    await pillMenu.getByRole('menuitem', { name: 'Reveal in Finder' }).click();
    await pillMoreButton.click();
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

    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'pick_attachment_files')).toBe(true);
    expect(calls.some((call) => call.cmd === 'create_attachment_node')).toBe(true);
    expect(calls.some((call) => call.cmd === 'open_asset')).toBe(true);
    expect(calls.some((call) => call.cmd === 'reveal_asset')).toBe(true);
    expect(calls.some((call) => call.cmd === 'copy_asset_file')).toBe(true);
  });

  test('file marker guides use the shared transparent marker slot geometry', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/attachment');
    await expect(page.getByRole('option', { name: /Attachment/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const attachmentId = (await todayChildren(page)).at(-1)!;
    const attachmentRow = row(page, attachmentId);

    await attachmentRow.locator('> .row').first().hover();
    await attachmentRow.locator('.row-chevron-button').first().click();
    await page.evaluate(async ({ parentId }) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('create_node', { parentId, index: null, text: 'Child note' });
    }, { parentId: attachmentId });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    await expect.poll(async () => page.evaluate((nodeId) => {
      const markerButton = document.querySelector(`[data-node-id="${nodeId}"] > .row .row-bullet-button`);
      const markerSlot = document.querySelector(`[data-node-id="${nodeId}"] > .row .row-bullet-shape.file`);
      const guide = document.querySelector(
        `.outliner-flat-guides .indent-guide[data-guide-node-id="${nodeId}"], `
          + `[data-node-id="${nodeId}"] > .indent-guide`,
      );
      const guideLine = document.querySelector(
        `.outliner-flat-guides .indent-guide[data-guide-node-id="${nodeId}"] .indent-guide-line, `
          + `[data-node-id="${nodeId}"] > .indent-guide .indent-guide-line`,
      );
      if (!markerButton || !markerSlot || !guide || !guideLine) return null;
      const markerButtonRect = markerButton.getBoundingClientRect();
      const guideRect = guide.getBoundingClientRect();
      const guideLineRect = guideLine.getBoundingClientRect();
      const centerX = (rect: DOMRect) => rect.left + rect.width / 2;
      return {
        hitBandOutsideSlot: guideRect.right <= markerButtonRect.left + 0.5,
        lineOnSlotLeadingEdge: Math.abs(centerX(guideLineRect) - markerButtonRect.left) <= 1,
        startsBelowSlot: guideLineRect.top - markerButtonRect.bottom >= 3
          && guideLineRect.top - markerButtonRect.bottom <= 5,
      };
    }, attachmentId)).toEqual({
      hitBandOutsideSlot: true,
      lineOnSlotLeadingEdge: true,
      startsBelowSlot: true,
    });
  });

  test('/image creates a file node rendered as the image itself inline (no card, no filename), selecting on click', async ({ page }) => {
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
    // The ⋯ menu lives at the image's top-right (image rows keep their own inline
    // maximize/reveal menu, unlike non-image file name rows).
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

    // Plain-clicking the image is a row interaction: it selects the image row
    // instead of drilling into a different page.
    await imageRow.locator('.file-node-image-button').click();
    await expect(imageRow).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.outline-panel-surface.active-panel .file-node-body')).toHaveCount(0);

    // Maximize remains available from the row's explicit file action menu.
    await imageRow.locator('.file-node-image-actions .file-node-card-menu-trigger').click();
    await page.getByRole('menuitem', { name: 'Maximize' }).click();
    await expect(page.locator('.outline-panel-surface.active-panel .file-node-body')).toBeVisible();
    await expect(page.locator('.outline-panel-surface.active-panel .panel-page-back-button')).toBeEnabled();
    await page.locator('.outline-panel-surface.active-panel .panel-page-back-button').click();
    await expect(imageRow.locator('.file-node-image-button img')).toBeVisible();
  });

  test('external file drag shows outliner insertion guides and drops at the indicated row position', async ({ page }) => {
    await startExternalFileDrag(page, {
      name: 'drop-guide.md',
      mimeType: 'text/markdown',
      text: '# Drop guide',
    });

    await dispatchExternalFileDrag(page, ids.beta, 'before', 'dragover');
    await expect(row(page, ids.beta).locator('> .row')).toHaveClass(/drop-before/);
    await expect(page.locator('.row.drop-before, .row.drop-after, .row.drop-inside')).toHaveCount(1);

    await dispatchExternalFileDrag(page, ids.gamma, 'inside', 'dragover');
    await expect(row(page, ids.gamma).locator('> .row')).toHaveClass(/drop-inside/);
    await expect(page.locator('.row.drop-before, .row.drop-after, .row.drop-inside')).toHaveCount(1);

    await dispatchExternalFileDrag(page, ids.gamma, 'inside', 'drop');
    await expect(page.locator('.row.drop-before, .row.drop-after, .row.drop-inside')).toHaveCount(0);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const gamma = projection.nodes.find((node) => node.id === ids.gamma);
      const child = projection.nodes.find((node) => node.id === gamma?.children[0]);
      return {
        childCount: gamma?.children.length ?? 0,
        childName: child?.originalFilename ?? child?.content.text ?? null,
        childType: child?.type ?? null,
      };
    }).toEqual({ childCount: 1, childName: 'drop-guide.md', childType: 'attachment' });

    const calls = await commandCalls(page);
    expect(calls).toContainEqual(expect.objectContaining({
      cmd: 'create_attachment_node',
      args: expect.objectContaining({ parentId: ids.gamma, index: 0, originalFilename: 'drop-guide.md' }),
    }));
  });

  test('Cmd+V pastes clipboard files into the outline as file nodes', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();

    await pasteClipboardFile(page, {
      name: 'clipboard-report.pdf',
      mimeType: 'application/pdf',
      text: '%PDF clipboard report',
    });

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const pastedId = (await todayChildren(page)).at(-1);
    expect(pastedId).toBeTruthy();
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const pasted = projection.nodes.find((node) => node.id === pastedId);
      return {
        name: pasted?.originalFilename ?? pasted?.content.text ?? null,
        type: pasted?.type ?? null,
      };
    }).toEqual({ name: 'clipboard-report.pdf', type: 'attachment' });
    const pastedRow = row(page, pastedId!);
    await expect(pastedRow.locator('.file-node-row-name')).toContainText('clipboard-report.pdf');
    await expect.poll(async () => pastedRow.locator('.file-node-row-main').evaluate((element) => {
      return getComputedStyle(element).boxShadow;
    })).toBe('none');
    await expect.poll(async () => page.evaluate(() => {
      return document.activeElement?.classList.contains('file-node-keyboard-anchor') ?? false;
    })).toBe(false);

    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'ingest_asset')).toBe(true);
    expect(calls).toContainEqual(expect.objectContaining({
      cmd: 'create_attachment_node',
      args: expect.objectContaining({ originalFilename: 'clipboard-report.pdf' }),
    }));
  });

  test('unsupported file previews keep the same bottom action location as previewable files', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();

    await pasteClipboardFile(page, {
      name: 'archive.zip',
      mimeType: 'application/zip',
      text: 'zip bytes',
    });

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const pastedId = (await todayChildren(page)).at(-1)!;
    const attachmentRow = row(page, pastedId);
    await expect(attachmentRow.locator('.file-node-row-name')).toContainText('archive.zip');

    await attachmentRow.locator('> .row').first().hover();
    await attachmentRow.locator('.row-chevron-button').first().click();
    const metadataPreview = attachmentRow.locator('.file-node-row-preview .file-node-preview--metadata');
    await expect(metadataPreview).toBeVisible();
    const metadataKindRow = metadataPreview.locator('.file-preview-metadata-kind-row');
    await expect(metadataKindRow.locator('h2')).toHaveText('zip');
    await expect(metadataKindRow.locator('span')).toHaveText('9 B');
    await expect(metadataPreview.locator('.file-preview-metadata p')).toContainText('Modified');
    await expect.poll(async () => metadataPreview.evaluate((element) => {
      const kindRow = element.querySelector('.file-preview-metadata-kind-row');
      const modified = element.querySelector('.file-preview-metadata p');
      if (!kindRow || !modified) return null;
      const kindRect = kindRow.getBoundingClientRect();
      const modifiedRect = modified.getBoundingClientRect();
      return modifiedRect.top > kindRect.bottom;
    })).toBe(true);
    await expect(metadataPreview.locator('.file-preview-metadata [data-file-icon-kind]')).toHaveCount(0);
    await expect(metadataPreview.locator('.file-preview-metadata')).not.toContainText('Type');
    await expect(metadataPreview.locator('.file-preview-metadata')).not.toContainText('Size');

    const pill = metadataPreview.locator('.file-preview-pill');
    await expect(pill.locator('.file-preview-pill-primary')).toHaveText('Open');
    await expect(pill.getByRole('button', { name: 'Open with default app' })).toBeVisible();
    await expect(pill.locator('.file-preview-pill-divider')).toHaveCount(0);
    await expect.poll(async () => pill.evaluate((element) => {
      const primary = element.querySelector('.file-preview-pill-primary');
      const more = element.querySelector('.file-preview-pill-more');
      if (!primary || !more) return null;
      return Math.round(Math.abs(
        primary.getBoundingClientRect().height - more.getBoundingClientRect().height,
      ));
    })).toBe(0);
    await expect(attachmentRow.locator('.file-node-row-preview > .file-node-body > .file-preview-pill')).toHaveCount(0);
    await expect.poll(async () => pill.evaluate((element) => getComputedStyle(element).position)).toBe('static');
    await expect.poll(async () => attachmentRow.evaluate((element) => {
      const frame = element.querySelector('.file-node-preview--metadata');
      const pill = element.querySelector('.file-preview-pill');
      const metadata = element.querySelector('.file-preview-metadata');
      if (!frame || !pill || !metadata) return null;
      const frameRect = frame.getBoundingClientRect();
      const pillRect = pill.getBoundingClientRect();
      const metadataRect = metadata.getBoundingClientRect();
      return {
        bottomAction: pillRect.top > metadataRect.bottom,
        centeredInFrame: Math.abs(
          (pillRect.left + pillRect.width / 2) - (frameRect.left + frameRect.width / 2),
        ) <= 1,
        compactWidth: frameRect.width <= 520,
      };
    })).toEqual({ bottomAction: true, centeredInFrame: true, compactWidth: true });
  });

  test('a file row has a read-only caret surface: display-only name, but tag/Enter nav works', async ({ page }) => {
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

    // A non-image file row uses a read-only editor surface, not the image-row
    // hidden anchor, so users can place a caret in the filename while the stored
    // filename remains immutable.
    const anchor = attachmentRow.locator('.file-node-keyboard-anchor');
    await expect(anchor).toHaveCount(0);
    const titleEditor = attachmentRow.locator('.file-node-row-name .ProseMirror');
    await expect(titleEditor).toHaveCount(1);
    await titleEditor.click();
    const focused = await titleEditor.evaluate((element) => {
      return element === document.activeElement;
    });
    expect(focused).toBe(true);
    await expect.poll(async () => attachmentRow.locator('.file-node-row-main').evaluate((element) =>
      getComputedStyle(element).boxShadow)).toBe('none');

    // The name is display-only: ordinary typing on the focused file title never
    // renames it or fires slash commands.
    await page.keyboard.type('renamed/');
    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toHaveCount(0);
    await expect(rowName).toContainText('picked-report.pdf');
    await expect(rowName).not.toContainText('renamed');

    // But # is still a node-level command surface for the file node itself.
    await page.keyboard.type('#project');
    const tagListbox = page.getByRole('listbox', { name: 'Tag suggestions' });
    await expect(tagListbox).toBeVisible();
    await expect(page.getByRole('option', { name: 'project' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(tagListbox).toHaveCount(0);
    await expect(attachmentRow.locator('.file-node-row-labels > .tag-bar .tag-badge-label')).toHaveText('project');
    await expect(rowName).toContainText('picked-report.pdf');

    // ...but structural keyboard nav DOES drive the row. Enter on the focused
    // read-only title adds a sibling, matching locked-node behavior.
    const countBeforeEnter = (await todayChildren(page)).length;
    await titleEditor.click();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await todayChildren(page)).length).toBe(countBeforeEnter + 1);
  });
});
