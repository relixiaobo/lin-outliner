import { expect, test, type Locator } from '@playwright/test';
import {
  commandCalls,
  configurePreviewTranslationMock,
  emitDocumentEvent,
  e2eProjection,
  ids,
  openMockedApp,
  row,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

async function todayChildren(page: Parameters<typeof trailingEditor>[0]) {
  const projection = await e2eProjection(page);
  return (projection.nodes.find((node) => node.id === ids.today)?.children ?? [])
    .filter((nodeId) => nodeId !== `${ids.today}::source`);
}

async function appliedSourceCreates(page: Parameters<typeof trailingEditor>[0]) {
  const calls = await commandCalls(page);
  return calls.flatMap((call) => {
    const input = call.args as {
      diff?: { normalizedChangeSet?: { operations?: Array<{
        op?: string;
        placement?: {
          kind?: string;
          parent?: { target?: { selector?: { by?: string; id?: string } } };
          index?: number;
        };
        nodes?: Array<Record<string, unknown>>;
        bind?: string;
        targets?: { binding?: string };
        changes?: Array<Record<string, unknown>>;
      }> } };
      changeSet?: { operations?: Array<{
        op?: string;
        placement?: {
          kind?: string;
          parent?: { target?: { selector?: { by?: string; id?: string } } };
          index?: number;
        };
        nodes?: Array<Record<string, unknown>>;
        bind?: string;
        targets?: { binding?: string };
        changes?: Array<Record<string, unknown>>;
      }> };
    };
    const operations = call.cmd === 'outline/apply'
      ? input.diff?.normalizedChangeSet?.operations ?? []
      : call.cmd === 'outline/commit' ? input.changeSet?.operations ?? [] : [];
    return operations.flatMap((operation) => {
      if (operation.op !== 'create' || !operation.bind) return [];
      const sourceAdds = operations.flatMap((candidate) => (
        candidate.op === 'update' && candidate.targets?.binding === operation.bind
          ? (candidate.changes ?? []).filter((change) => change.kind === 'source' && change.action === 'add')
          : []
      ));
      if (sourceAdds.length === 0) return [];
      return (operation.nodes ?? []).map((draft) => ({
        draft,
        index: operation.placement?.index,
        parentId: operation.placement?.parent?.target?.selector?.by === 'id'
          ? operation.placement.parent.target.selector.id
          : undefined,
        sourceText: sourceAdds[0]?.sourceText,
      }));
    });
  });
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

async function pasteClipboardFileAndOpenPreview(
  page: Parameters<typeof trailingEditor>[0],
  file: { name: string; mimeType: string; text: string },
) {
  const activePanel = page.locator('.outline-panel-surface.active-panel');
  if (!(await trailingEditor(page).isVisible())) {
    const backButton = activePanel.locator('.panel-page-back-button');
    await expect(backButton).toBeEnabled();
    await backButton.click();
    await expect(trailingEditor(page)).toBeVisible();
  }
  const beforeChildren = await todayChildren(page);
  await trailingEditor(page).click();
  await pasteClipboardFile(page, file);
  await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  const pastedId = (await todayChildren(page)).at(-1);
  if (!pastedId) throw new Error(`No pasted Source-backed node for ${file.name}`);
  const pastedRow = row(page, pastedId);
  await pastedRow.locator('> .row').first().hover();
  await pastedRow.locator('> .row .row-bullet-button').first().click();
  const previewFrame = page.locator('.outline-panel-surface.active-panel .node-source-preview .file-node-preview.collapsed');
  await expect(previewFrame).toBeVisible();
  return previewFrame;
}

type StoredPdfReadingPosition = {
  pageNumber: number;
  pageOffsetRatio: number;
  updatedAt: number;
};

async function readStoredPdfReadingPosition(
  page: Parameters<typeof trailingEditor>[0],
): Promise<StoredPdfReadingPosition | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('lin-outliner:pdf-reading-position:v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      positions?: Record<string, Partial<StoredPdfReadingPosition>>;
    };
    const entries = Object.entries(parsed.positions ?? {});
    if (entries.length === 0) return null;
    if (entries.length !== 1) {
      throw new Error(`Expected one PDF reading-position key, found: ${entries.map(([key]) => key).join(', ')}`);
    }
    const [, position] = entries[0];
    if (
      typeof position.pageNumber !== 'number'
      || typeof position.pageOffsetRatio !== 'number'
      || typeof position.updatedAt !== 'number'
    ) {
      return null;
    }
    return position as StoredPdfReadingPosition;
  });
}

async function readPdfReaderPosition(reader: Locator): Promise<Omit<StoredPdfReadingPosition, 'updatedAt'> | null> {
  return reader.evaluate((element) => {
    const pages = Array.from(element.querySelectorAll<HTMLElement>('.file-preview-pdf-page'));
    if (pages.length === 0) return null;
    const rootRect = element.getBoundingClientRect();
    const viewportTop = rootRect.top + 1;
    const currentPage = pages.find((page) => page.getBoundingClientRect().bottom > viewportTop)
      ?? pages[pages.length - 1];
    const pageNumber = Number(currentPage.dataset.pdfPageNumber);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;
    const pageRect = currentPage.getBoundingClientRect();
    const pageOffset = Math.max(0, Math.min(pageRect.height, viewportTop - pageRect.top));
    return {
      pageNumber,
      pageOffsetRatio: pageRect.height > 0 ? pageOffset / pageRect.height : 0,
    };
  });
}

function pdfReadingPositionsMatch(
  left: Pick<StoredPdfReadingPosition, 'pageNumber' | 'pageOffsetRatio'>,
  right: Pick<StoredPdfReadingPosition, 'pageNumber' | 'pageOffsetRatio'>,
  tolerance = 0.04,
): boolean {
  return left.pageNumber === right.pageNumber
    && Math.abs(left.pageOffsetRatio - right.pageOffsetRatio) < tolerance;
}

async function waitForPdfReaderLayout(reader: Locator): Promise<void> {
  await expect.poll(async () => reader.evaluate(async (element) => {
    const snapshot = () => {
      const pages = Array.from(element.querySelectorAll<HTMLElement>('.file-preview-pdf-page'));
      return {
        ready: element.clientHeight > 0
          && element.scrollHeight > element.clientHeight
          && pages.length > 0
          && pages.every((page) => {
            const rect = page.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }),
        pageRects: pages.map((page) => {
          const rect = page.getBoundingClientRect();
          return { height: rect.height, top: rect.top };
        }),
        scrollTop: element.scrollTop,
      };
    };
    const before = snapshot();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const after = snapshot();
    return before.ready
      && after.ready
      && before.pageRects.length === after.pageRects.length
      && before.pageRects.every((rect, index) => {
        const next = after.pageRects[index];
        return Boolean(next)
          && Math.abs(rect.height - next.height) < 0.5
          && Math.abs(rect.top - next.top) < 0.5;
      })
      && Math.abs(before.scrollTop - after.scrollTop) < 0.5;
  })).toBe(true);
}

async function scrollPdfReaderToPosition(
  page: Parameters<typeof trailingEditor>[0],
  reader: Locator,
  pageNumber: number,
  pageOffsetRatio: number,
): Promise<StoredPdfReadingPosition> {
  await waitForPdfReaderLayout(reader);
  const previousPosition = await readStoredPdfReadingPosition(page);
  const maximumScrollTop = await reader.evaluate((element, target) => {
    const maximum = element.scrollHeight - element.clientHeight;
    const pageElement = element.querySelector<HTMLElement>(
      `.file-preview-pdf-page[data-pdf-page-number="${target.pageNumber}"]`,
    );
    if (!pageElement) throw new Error(`Missing PDF page ${target.pageNumber}`);
    const rootRect = element.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const pageTop = element.scrollTop + pageRect.top - rootRect.top;
    element.scrollTo({
      top: Math.round(pageTop + pageRect.height * target.pageOffsetRatio),
      behavior: 'auto',
    });
    return maximum;
  }, { pageNumber, pageOffsetRatio });
  expect(maximumScrollTop).toBeGreaterThan(0);
  await expect.poll(async () => {
    const [readerPosition, storedPosition] = await Promise.all([
      readPdfReaderPosition(reader),
      readStoredPdfReadingPosition(page),
    ]);
    if (!readerPosition || !storedPosition) return false;
    const changed = !previousPosition || !pdfReadingPositionsMatch(storedPosition, previousPosition);
    return changed && pdfReadingPositionsMatch(storedPosition, readerPosition);
  }).toBe(true);
  await waitForPdfReaderLayout(reader);
  const [readerPosition, storedPosition] = await Promise.all([
    readPdfReaderPosition(reader),
    readStoredPdfReadingPosition(page),
  ]);
  if (!readerPosition || !storedPosition || !pdfReadingPositionsMatch(storedPosition, readerPosition)) {
    throw new Error('Persisted PDF position does not belong to the scrolled reader');
  }
  return storedPosition;
}

async function expectPdfReaderPosition(
  reader: Locator,
  expectedPosition: Pick<StoredPdfReadingPosition, 'pageNumber' | 'pageOffsetRatio'>,
): Promise<void> {
  await waitForPdfReaderLayout(reader);
  try {
    await expect.poll(async () => {
      const position = await readPdfReaderPosition(reader);
      return position ? pdfReadingPositionsMatch(position, expectedPosition, 0.08) : false;
    }).toBe(true);
  } catch (error) {
    const actualPosition = await readPdfReaderPosition(reader);
    throw new Error(
      `Expected PDF position ${JSON.stringify(expectedPosition)}, received ${JSON.stringify(actualPosition)}`,
      { cause: error },
    );
  }
}

type StoredEpubReadingPosition = {
  sectionIndex: number;
  sectionOffsetRatio: number;
  updatedAt: number;
};

async function readStoredEpubReadingPosition(
  page: Parameters<typeof trailingEditor>[0],
): Promise<StoredEpubReadingPosition | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('lin-outliner:epub-reading-position:v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      positions?: Record<string, Partial<StoredEpubReadingPosition>>;
    };
    const entries = Object.entries(parsed.positions ?? {});
    if (entries.length === 0) return null;
    if (entries.length !== 1) {
      throw new Error(`Expected one EPUB reading-position key, found: ${entries.map(([key]) => key).join(', ')}`);
    }
    const [, position] = entries[0];
    if (
      typeof position.sectionIndex !== 'number'
      || typeof position.sectionOffsetRatio !== 'number'
      || typeof position.updatedAt !== 'number'
    ) {
      return null;
    }
    return position as StoredEpubReadingPosition;
  });
}

async function readEpubReaderPosition(reader: Locator): Promise<Omit<StoredEpubReadingPosition, 'updatedAt'> | null> {
  return reader.evaluate((element) => {
    const sections = Array.from(element.querySelectorAll<HTMLElement>('.file-preview-epub-section'));
    if (sections.length === 0) return null;
    const rootRect = element.getBoundingClientRect();
    const viewportTop = rootRect.top + 1;
    const currentSection = sections.find((section) => section.getBoundingClientRect().bottom > viewportTop)
      ?? sections[sections.length - 1];
    const sectionIndex = Number(currentSection.dataset.epubSectionIndex);
    if (!Number.isFinite(sectionIndex) || sectionIndex < 0) return null;
    const sectionRect = currentSection.getBoundingClientRect();
    const sectionOffset = Math.max(0, Math.min(sectionRect.height, viewportTop - sectionRect.top));
    return {
      sectionIndex,
      sectionOffsetRatio: sectionRect.height > 0 ? sectionOffset / sectionRect.height : 0,
    };
  });
}

function epubReadingPositionsMatch(
  left: Pick<StoredEpubReadingPosition, 'sectionIndex' | 'sectionOffsetRatio'>,
  right: Pick<StoredEpubReadingPosition, 'sectionIndex' | 'sectionOffsetRatio'>,
  tolerance = 0.04,
): boolean {
  return left.sectionIndex === right.sectionIndex
    && Math.abs(left.sectionOffsetRatio - right.sectionOffsetRatio) < tolerance;
}

async function waitForEpubReaderLayout(reader: Locator): Promise<void> {
  await expect.poll(async () => reader.evaluate(async (element) => {
    const snapshot = () => {
      const sections = Array.from(element.querySelectorAll<HTMLElement>('.file-preview-epub-section'));
      return {
        ready: sections.length > 0 && sections.every((section) => {
          const frame = section.querySelector<HTMLIFrameElement>('.file-preview-epub-iframe');
          return Boolean(frame?.style.height);
        }),
        heights: sections.map((section) => section.getBoundingClientRect().height),
        scrollTop: element.scrollTop,
      };
    };
    const before = snapshot();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const after = snapshot();
    return before.ready
      && after.ready
      && before.heights.length === after.heights.length
      && before.heights.every((height, index) => Math.abs(height - (after.heights[index] ?? -1)) < 0.5)
      && Math.abs(before.scrollTop - after.scrollTop) < 0.5;
  })).toBe(true);
}

async function scrollEpubReaderToPosition(
  page: Parameters<typeof trailingEditor>[0],
  reader: Locator,
  sectionIndex: number,
  sectionOffsetRatio: number,
): Promise<StoredEpubReadingPosition> {
  await waitForEpubReaderLayout(reader);
  const previousPosition = await readStoredEpubReadingPosition(page);
  const maximumScrollTop = await reader.evaluate((element, target) => {
    const maximum = element.scrollHeight - element.clientHeight;
    const section = element.querySelector<HTMLElement>(
      `.file-preview-epub-section[data-epub-section-index="${target.sectionIndex}"]`,
    );
    if (!section) throw new Error(`Missing EPUB section ${target.sectionIndex}`);
    const rootRect = element.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    const sectionTop = element.scrollTop + sectionRect.top - rootRect.top;
    element.scrollTo({
      top: Math.round(sectionTop + sectionRect.height * target.sectionOffsetRatio),
      behavior: 'auto',
    });
    return maximum;
  }, { sectionIndex, sectionOffsetRatio });
  expect(maximumScrollTop).toBeGreaterThan(0);
  await expect.poll(async () => {
    const [readerPosition, storedPosition] = await Promise.all([
      readEpubReaderPosition(reader),
      readStoredEpubReadingPosition(page),
    ]);
    if (!readerPosition || !storedPosition) return false;
    const changed = !previousPosition || !epubReadingPositionsMatch(storedPosition, previousPosition);
    return changed && epubReadingPositionsMatch(storedPosition, readerPosition);
  }).toBe(true);
  await waitForEpubReaderLayout(reader);
  const [readerPosition, storedPosition] = await Promise.all([
    readEpubReaderPosition(reader),
    readStoredEpubReadingPosition(page),
  ]);
  if (!readerPosition || !storedPosition || !epubReadingPositionsMatch(storedPosition, readerPosition)) {
    throw new Error('Persisted EPUB position does not belong to the scrolled reader');
  }
  return storedPosition;
}

async function expectEpubReaderPosition(
  reader: Locator,
  expectedPosition: Pick<StoredEpubReadingPosition, 'sectionIndex' | 'sectionOffsetRatio'>,
): Promise<void> {
  await waitForEpubReaderLayout(reader);
  try {
    await expect.poll(async () => {
      const position = await readEpubReaderPosition(reader);
      return position ? epubReadingPositionsMatch(position, expectedPosition, 0.08) : false;
    }).toBe(true);
  } catch (error) {
    const actualPosition = await readEpubReaderPosition(reader);
    throw new Error(
      `Expected EPUB position ${JSON.stringify(expectedPosition)}, received ${JSON.stringify(actualPosition)}`,
      { cause: error },
    );
  }
}

async function openSplitPaneFromPreviewPill(
  page: Parameters<typeof trailingEditor>[0],
  previewBody: Locator,
): Promise<Locator> {
  const panelCountBefore = await page.locator('.outline-panel-surface').count();
  await previewBody.locator('.file-preview-pill-more').click();
  await page.getByRole('menu', { name: 'Preview actions' })
    .getByRole('menuitem', { name: 'Open in split pane' })
    .click();
  await expect(page.locator('.outline-panel-surface')).toHaveCount(panelCountBefore + 1);
  const readerPane = page.locator('.outline-panel-surface.active-panel');
  await expect(readerPane.locator('.file-preview-panel--reader')).toBeVisible();
  return readerPane;
}

async function openEpubSplitReader(
  page: Parameters<typeof trailingEditor>[0],
  name: string,
) {
  const inlinePreview = await pasteClipboardFileAndOpenPreview(page, {
    name,
    mimeType: 'application/epub+zip',
    text: 'epub bytes',
  });
  await expect(inlinePreview.locator('.file-preview-translation-toggle')).toHaveCount(0);
  const inlineChapter = inlinePreview.locator('.file-preview-epub-iframe').first().contentFrame();
  await expect(inlineChapter.locator('[data-tenon-epub-translation-style]')).toHaveCount(0);

  const readerPane = await openSplitPaneFromPreviewPill(page, inlinePreview.locator('..'));
  const chapter = readerPane.locator('.file-preview-epub-iframe').first().contentFrame();
  return { chapter, readerPane };
}

async function expectConcentricPreviewCorners(previewFrame: Locator, contentSelector: string) {
  await expect.poll(async () => previewFrame.evaluate((element, selector) => {
    const content = element.querySelector<HTMLElement>(selector);
    if (!content) return null;
    const frameStyle = getComputedStyle(element);
    const contentStyle = getComputedStyle(content);
    const frameRadius = Number.parseFloat(frameStyle.borderTopLeftRadius);
    const contentRadius = Number.parseFloat(contentStyle.borderTopLeftRadius);
    const paddingTop = Number.parseFloat(frameStyle.paddingTop);
    const paddingLeft = Number.parseFloat(frameStyle.paddingLeft);
    return {
      frameHasHairlineEdge: frameStyle.borderTopWidth === '0px' && frameStyle.boxShadow !== 'none',
      contentClipPath: contentStyle.clipPath,
      contentHasRadius: contentRadius > 0,
      inlinePaddingMatchesBlock: Math.abs(paddingLeft - paddingTop) <= 1,
      innerRadiusFromOuter: Math.abs(contentRadius - Math.max(2, frameRadius - paddingTop)) <= 1,
    };
  }, contentSelector)).toEqual({
    frameHasHairlineEdge: true,
    contentClipPath: 'inset(0px round 8px)',
    contentHasRadius: true,
    inlinePaddingMatchesBlock: true,
    innerRadiusFromOuter: true,
  });
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

  test('/attachment creates an ordinary editable Node with a managed Source and a full PDF preview', async ({ page }) => {
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
      const projection = await e2eProjection(page);
      const node = projection.nodes.find((entry) => entry.id === attachmentId);
      const sourceEntry = projection.nodes.find((entry) => entry.id === `${attachmentId}::source`);
      const source = projection.nodes.find((entry) => entry.id === sourceEntry?.children[0]);
      return {
        content: node?.content.text ?? null,
        sourceCount: sourceEntry?.children.length ?? 0,
        sourceEntryField: sourceEntry?.fieldDefId ?? null,
        sourceText: source?.sourceText ?? null,
        sourceType: source?.type ?? null,
        type: node?.type ?? null,
      };
    }).toEqual({
      content: 'picked-report.pdf',
      sourceCount: 1,
      sourceEntryField: 'field:source',
      sourceText: expect.stringMatching(/^asset:\/\/local\//),
      sourceType: 'sourceValue',
      type: null,
    });

    const attachmentRow = row(page, attachmentId!);
    await expect(attachmentRow.locator('.row-bullet-shape.file')).toHaveCount(0);
    const titleEditor = rowEditor(page, attachmentId!);
    await expect(titleEditor).toContainText('picked-report.pdf');
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Quarterly report');
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === attachmentId);
      return node?.content.text ?? null;
    }).toBe('Quarterly report');
    // The ordinary bullet drills to the node page; the chevron remains reserved
    // for child disclosure and never owns preview state.
    const attachmentRowLine = attachmentRow.locator('> .row').first();
    await attachmentRowLine.hover();
    await attachmentRow.locator('> .row .row-bullet-button').first().click();
    const nodePage = page.locator('.outline-panel-surface.active-panel');
    await expect(nodePage.locator('.panel-title-editor .ProseMirror')).toContainText('Quarterly report');
    const sourceRow = nodePage.locator('.node-source-row');
    await expect(sourceRow).toHaveCount(1);
    await expect(sourceRow.locator('input')).toHaveValue(/^asset:\/\/local\//);
    await expect(sourceRow).toHaveAttribute('data-availability', 'ready');

    const inlinePreviewFrame = nodePage.locator('.node-source-preview .file-node-preview.collapsed');
    await expect(inlinePreviewFrame).toBeVisible();
    await expectConcentricPreviewCorners(inlinePreviewFrame, '.file-preview-pdf--summary');
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
      horizontalSummary: true,
      noScrollBleed: true,
      pageRadius: true,
      scrollbarBelowPage: true,
      symmetricInset: true,
    });
    const inlinePreviewCanvas = inlinePreviewFrame.locator('.file-preview-pdf--summary .file-preview-pdf-canvas');
    await expect(inlinePreviewCanvas).toHaveCount(3);
    await expect(inlinePreviewCanvas.first()).toBeVisible();
    await expect.poll(async () => inlinePreviewFrame.evaluate((frameElement) => {
      const canvasElement = frameElement.querySelector('.file-preview-pdf-canvas');
      if (!canvasElement) return null;
      const frameRect = frameElement.getBoundingClientRect();
      const canvasRect = canvasElement.getBoundingClientRect();
      return Math.round(frameRect.bottom - canvasRect.bottom);
    })).toBeLessThanOrEqual(36);
    await expect.poll(async () => inlinePreviewFrame.evaluate((frameElement) => {
      const summaryElement = frameElement.querySelector<HTMLElement>('.file-preview-pdf--summary');
      const canvasElement = frameElement.querySelector('.file-preview-pdf-canvas');
      const pillElement = frameElement.parentElement?.querySelector('.file-preview-pill');
      if (!summaryElement || !canvasElement || !pillElement) return null;
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
    const resizeHandle = inlinePreviewFrame.locator('xpath=..').locator('.file-preview-resize-handle');
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

    // Preview visibility is independent from the ordinary child outline. A
    // childless Source-backed Node still exposes its trailing draft below Sources.
    await expect(trailingEditor(page, attachmentId!)).toBeVisible();
    await expect.poll(async () => trailingEditor(page, attachmentId!).evaluate((editor, nodeId) => {
      const preview = document.querySelector<HTMLElement>('.outline-panel-surface.active-panel .node-source-preview');
      if (!preview) return false;
      return editor.getBoundingClientRect().top > preview.getBoundingClientRect().bottom;
    }, attachmentId!)).toBe(true);
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === attachmentId);
      return node?.children.filter((childId) => childId !== `${attachmentId}::source`).length ?? 0;
    }).toBe(0);

    const previewStage = nodePage.locator('.node-source-preview .file-node-preview');
    await expect(previewStage).toHaveClass(/collapsed/);
    await expect(nodePage.locator('.file-node-preview.collapsed .file-preview-pdf--summary .file-preview-pdf-canvas')).toHaveCount(3);
    await expect(nodePage.locator('.file-node-preview.collapsed .file-preview-pdf-text-layer')).toHaveCount(0);

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
    await expectConcentricPreviewCorners(previewStage, '.file-preview-pdf--full');
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
    await expect(nodePage.locator('.file-node-preview.expanded .file-preview-pdf-shell--full .document-outline-rail')).toHaveCount(0);
    const pageTwoTextLayer = nodePage.locator(
      '.file-node-preview.expanded .file-preview-pdf--full [data-pdf-page-number="2"] .file-preview-pdf-text-layer.ready',
    ).first();
    await expect(pageTwoTextLayer).toHaveAttribute('data-preserve-selection', 'true');
    await expect.poll(async () => pageTwoTextLayer.evaluate((layer) => (
      Array.from(layer.querySelectorAll('span')).some((span) =>
        span.textContent?.includes('Preview PDF Page 2'))
    ))).toBe(true);
    const pageTwoTextRect = await pageTwoTextLayer.evaluate((layer) => {
      const span = Array.from(layer.querySelectorAll<HTMLElement>('span'))
        .find((candidate) => candidate.textContent?.includes('Preview PDF Page 2'));
      if (!span) return null;
      const rect = span.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (!pageTwoTextRect) throw new Error('Missing page 2 text layer span');
    await expect.poll(async () => pageTwoTextLayer.evaluate((layer) => {
      const span = Array.from(layer.querySelectorAll<HTMLElement>('span'))
        .find((candidate) => candidate.textContent?.includes('Preview PDF Page 2'));
      if (!span) return false;
      const background = getComputedStyle(span, '::selection').backgroundColor;
      return Boolean(background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)');
    })).toBe(true);
    await page.mouse.move(pageTwoTextRect.x + 2, pageTwoTextRect.y + pageTwoTextRect.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      pageTwoTextRect.x + Math.max(4, pageTwoTextRect.width - 2),
      pageTwoTextRect.y + pageTwoTextRect.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('Preview PDF Page 2');
    await expect.poll(async () => page.evaluate(() => document.body.classList.contains('drag-selecting')))
      .toBe(false);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
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
    await previewStage.evaluate((element) => {
      const fullReader = element.querySelector<HTMLElement>('.file-preview-pdf--full');
      if (fullReader) {
        fullReader.scrollTop = fullReader.scrollHeight;
        fullReader.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    });
    await expect.poll(async () => page.evaluate(() => {
      const raw = window.localStorage.getItem('lin-outliner:pdf-reading-position:v1');
      if (!raw) return false;
      const parsed = JSON.parse(raw) as {
        positions?: Record<string, { pageNumber?: number; pageOffsetRatio?: number }>;
      };
      return Object.values(parsed.positions ?? {}).some((position) => (
        typeof position.pageNumber === 'number'
        && position.pageNumber >= 2
        && typeof position.pageOffsetRatio === 'number'
      ));
    })).toBe(true);
    await page.setViewportSize({ width: 1360, height: 820 });
    await expect.poll(async () => previewStage.evaluate((element) => {
      const fullReader = element.querySelector<HTMLElement>('.file-preview-pdf--full');
      const page = element.querySelector<HTMLElement>('[data-pdf-page-number="2"]');
      if (!fullReader || !page) return null;
      const readerRect = fullReader.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      return Math.round(Math.abs(pageRect.top - readerRect.top));
    })).toBeGreaterThan(40);

    await pill.locator('.file-preview-pill-primary').click();
    await expect(previewStage).toHaveClass(/collapsed/);
    await expect(pill.locator('.file-preview-pill-primary')).toHaveText('Expand');
    await pill.locator('.file-preview-pill-primary').click();
    await expect(previewStage).toHaveClass(/expanded/);
    await expect(pill.locator('.file-preview-pill-primary')).toHaveText('Collapse');
    await expect.poll(async () => previewStage.evaluate((element) => {
      const fullReader = element.querySelector<HTMLElement>('.file-preview-pdf--full');
      if (!fullReader) return false;
      return fullReader.scrollTop > Math.max(120, fullReader.clientHeight * 0.5);
    })).toBe(true);
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

    // The Source-backed Node keeps the ordinary children outline.
    await trailingEditor(page, attachmentId!).click();
    await page.keyboard.type('a note on this file');
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === attachmentId);
      return node?.children.filter((childId) => childId !== `${attachmentId}::source`).length ?? 0;
    }).toBe(1);
    await expect(nodePage.getByText('a note on this file')).toBeVisible();

    // Back returns to the Today page the Node was drilled from.
    await expect(nodePage.locator('.panel-page-back-button')).toBeEnabled();
    await nodePage.locator('.panel-page-back-button').click();
    await expect(rowEditor(page, attachmentId!)).toContainText('Quarterly report');

    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'pick_attachment_files')).toBe(true);
    expect(await appliedSourceCreates(page)).toHaveLength(1);
    expect(calls.some((call) => call.cmd === 'open_asset')).toBe(true);
    expect(calls.some((call) => call.cmd === 'reveal_asset')).toBe(true);
    expect(calls.some((call) => call.cmd === 'copy_asset_file')).toBe(true);
  });

  test('Source preview menu opens a split pane as a file-only reader', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await openMockedApp(page);
    await pasteClipboardFileAndOpenPreview(page, {
      name: 'reader-note.md',
      mimeType: 'text/markdown',
      text: '# Reader note\n\nThis is a split reader.',
    });
    const attachmentId = (await todayChildren(page)).at(-1);
    if (!attachmentId) throw new Error('missing pasted attachment');

    const panelCountBefore = await page.locator('.outline-panel-surface').count();
    await page.locator('.node-source-preview .file-preview-pill-more').click();
    const inlineMenu = page.getByRole('menu', { name: 'Preview actions' });
    await inlineMenu.getByRole('menuitem', { name: 'Open in split pane' }).click();

    await expect(page.locator('.outline-panel-surface')).toHaveCount(panelCountBefore + 1);
    const readerPane = page.locator('.outline-panel-surface.active-panel');
    await expect(readerPane.locator('.file-preview-panel--reader')).toBeVisible();
    await expect(readerPane.locator('.panel-breadcrumb-current-label')).toHaveText('reader-note.md');
    await expect(readerPane.locator('.panel-title-file-heading')).toHaveCount(0);
    await expect(readerPane.locator('.file-preview-pill')).toHaveCount(0);
    await expect(readerPane.locator('.file-preview-resize-handle')).toHaveCount(0);
    await expect(readerPane.locator('.file-preview-markdown h1')).toBeVisible();
    await expect(readerPane.locator(`[data-trailing-parent-id="${attachmentId}"]`)).toHaveCount(0);
    await expect(readerPane.locator('.backlinks-section')).toHaveCount(0);

    await expect.poll(async () => page.evaluate(() => {
      const raw = window.localStorage.getItem('lin-outliner:workspace-layout:v7');
      if (!raw) return null;
      const layout = JSON.parse(raw) as {
        activePanelId?: string;
        panels?: Array<{ id: string; view?: { kind?: string; nodeId?: string; presentation?: string } }>;
      };
      return layout.panels?.find((panel) => panel.id === layout.activePanelId)?.view ?? null;
    })).toMatchObject({
      kind: 'file-preview',
      nodeId: attachmentId,
      presentation: 'reader',
    });

    const headerActions = readerPane.locator('.file-preview-reader-actions');
    await expect(headerActions).toBeVisible();
    await headerActions.click();
    const readerMenu = page.getByRole('menu', { name: 'Preview actions' });
    await expect(readerMenu.getByRole('menuitem', { name: 'Open with default app' })).toBeVisible();
    await expect(readerMenu.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeVisible();
    await expect(readerMenu.getByRole('menuitem', { name: 'Copy file' })).toBeVisible();
    await expect(readerMenu.getByRole('menuitem', { name: 'Open in split pane' })).toHaveCount(0);
  });

  test('Source-backed rows use their chevron only for ordinary child disclosure', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/attachment');
    await expect(page.getByRole('option', { name: /Attachment/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const attachmentId = (await todayChildren(page)).at(-1)!;
    const attachmentRow = row(page, attachmentId);

    await attachmentRow.locator('> .row').first().hover();
    await attachmentRow.locator('> .row .row-chevron-button').first().click();
    await expect(attachmentRow.locator('.node-source-preview, .file-node-row-preview')).toHaveCount(0);
    const inlineDraft = trailingEditor(page, attachmentId);
    await expect(inlineDraft).toBeVisible();

    await inlineDraft.click();
    await page.keyboard.type('inline note on this Source');
    await expect.poll(async () => {
      const node = (await e2eProjection(page)).nodes.find((entry) => entry.id === attachmentId);
      return node?.children.filter((childId) => childId !== `${attachmentId}::source`).length ?? 0;
    }).toBe(1);
    const inlineChildId = (await e2eProjection(page)).nodes
      .find((entry) => entry.id === attachmentId)
      ?.children.find((childId) => childId !== `${attachmentId}::source`);
    expect(inlineChildId).toBeTruthy();
    await expect(row(page, inlineChildId!)).toContainText('inline note on this Source');
    expect(await todayChildren(page)).toHaveLength(beforeChildren.length + 1);
  });

  test('Source-backed Nodes keep the ordinary marker and indent-guide geometry', async ({ page }) => {
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
      const markerSlot = document.querySelector(`[data-node-id="${nodeId}"] > .row .row-bullet-shape.content`);
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
        lineOnSlotCenter: Math.abs(centerX(guideLineRect) - centerX(markerButtonRect)) <= 1,
        measuredFromSlot: guideRect.left < centerX(markerButtonRect) && guideRect.right > centerX(markerButtonRect),
        startsBelowSlot: guideLineRect.top - markerButtonRect.bottom >= 3
          && guideLineRect.top - markerButtonRect.bottom <= 5,
      };
    }, attachmentId)).toEqual({
      lineOnSlotCenter: true,
      measuredFromSlot: true,
      startsBelowSlot: true,
    });
  });

  test('/image creates an ordinary editable Node whose Source preview renders the image', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/image');

    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    await expect(page.getByRole('option', { name: /Image/ })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const imageId = (await todayChildren(page)).at(-1);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const node = projection.nodes.find((entry) => entry.id === imageId);
      const sourceEntry = projection.nodes.find((entry) => entry.id === `${imageId}::source`);
      const source = projection.nodes.find((entry) => entry.id === sourceEntry?.children[0]);
      return {
        content: node?.content.text ?? null,
        sourceText: source?.sourceText ?? null,
        sourceType: source?.type ?? null,
        type: node?.type ?? null,
      };
    }).toEqual({
      content: 'picked-image.png',
      sourceText: expect.stringMatching(/^asset:\/\/local\//),
      sourceType: 'sourceValue',
      type: null,
    });

    const imageRow = row(page, imageId!);
    const imageTitle = rowEditor(page, imageId!);
    await expect(imageTitle).toContainText('picked-image.png');
    await expect(imageRow.locator('.file-node-image, .file-node-card')).toHaveCount(0);
    await page.evaluate(({ nodeId, tagId }) => {
      const win = window as typeof window & {
        __LIN_E2E__?: {
          emitDocumentEvent: (event: unknown) => void;
          projection: () => {
            nodes: Array<{ id: string; tags?: string[] }>;
          };
        };
      };
      const projection = win.__LIN_E2E__!.projection();
      const node = projection.nodes.find((entry) => entry.id === nodeId);
      if (!node) throw new Error('missing Source-backed image Node');
      node.tags = [tagId];
      win.__LIN_E2E__!.emitDocumentEvent({ type: 'projection_changed', projection });
    }, { nodeId: imageId, tagId: ids.projectTag });
    await expect(imageRow.locator('.tag-badge-label')).toHaveText('project');

    await imageRow.locator('> .row').first().hover();
    await imageRow.locator('> .row .row-bullet-button').first().click();
    const nodePage = page.locator('.outline-panel-surface.active-panel');
    const imagePreview = nodePage.locator('.node-source-preview .file-preview-image img');
    await expect(imagePreview).toBeVisible();
    await expect(imagePreview).toHaveAttribute('alt', /picked-image\.png/i);
    await expect(nodePage.locator('.node-source-row')).toHaveAttribute('data-availability', 'ready');
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
      const childIds = gamma?.children.filter((childId) => childId !== `${ids.gamma}::source`) ?? [];
      const child = projection.nodes.find((node) => node.id === childIds[0]);
      const sourceEntry = projection.nodes.find((node) => node.id === `${child?.id}::source`);
      const source = projection.nodes.find((node) => node.id === sourceEntry?.children[0]);
      return {
        childCount: childIds.length,
        childName: child?.content.text ?? null,
        childSource: source?.sourceText ?? null,
        childType: child?.type ?? null,
      };
    }).toEqual({
      childCount: 1,
      childName: 'drop-guide.md',
      childSource: expect.stringMatching(/^asset:\/\/local\//),
      childType: null,
    });

    expect(await appliedSourceCreates(page)).toContainEqual(expect.objectContaining({
      parentId: ids.gamma,
      index: 0,
      draft: expect.objectContaining({
        content: expect.objectContaining({ text: 'drop-guide.md' }),
      }),
      sourceText: expect.stringMatching(/^asset:\/\/local\//),
    }));
  });

  test('Cmd+V pastes clipboard files as ordinary Source-backed Nodes', async ({ page }) => {
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
      const sourceEntry = projection.nodes.find((node) => node.id === `${pastedId}::source`);
      const source = projection.nodes.find((node) => node.id === sourceEntry?.children[0]);
      return {
        name: pasted?.content.text ?? null,
        sourceText: source?.sourceText ?? null,
        type: pasted?.type ?? null,
      };
    }).toEqual({
      name: 'clipboard-report.pdf',
      sourceText: expect.stringMatching(/^asset:\/\/local\//),
      type: null,
    });
    const pastedRow = row(page, pastedId!);
    await expect(rowEditor(page, pastedId!)).toContainText('clipboard-report.pdf');
    await expect(pastedRow.locator('.file-node-keyboard-anchor, .file-node-row-main')).toHaveCount(0);

    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'outline/asset ingest')).toBe(true);
    expect(await appliedSourceCreates(page)).toContainEqual(expect.objectContaining({
      draft: expect.objectContaining({
        content: expect.objectContaining({ text: 'clipboard-report.pdf' }),
      }),
      sourceText: expect.stringMatching(/^asset:\/\/local\//),
    }));
  });

  test('text-like file previews keep content and horizontal scrollbars inside the preview inset', async ({ page }) => {
    const markdownPreview = await pasteClipboardFileAndOpenPreview(page, {
      name: 'edge-notes.md',
      mimeType: 'text/markdown',
      text: '# Edge notes',
    });
    await expect(markdownPreview.locator('.file-preview-markdown pre code')).toBeVisible();
    const markdownHeading = markdownPreview.locator('.file-preview-markdown h1');
    await expect(markdownHeading).toBeVisible();
    const headingBox = await markdownHeading.boundingBox();
    if (!headingBox) throw new Error('Missing markdown heading bounds');
    await page.mouse.move(headingBox.x + 2, headingBox.y + headingBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(headingBox.x + Math.max(4, headingBox.width - 2), headingBox.y + headingBox.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('Markdown edge preview');
    await expect.poll(async () => page.evaluate(() => document.body.classList.contains('drag-selecting')))
      .toBe(false);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect.poll(async () => markdownPreview.evaluate((frame) => {
      const markdown = frame.querySelector<HTMLElement>('.file-preview-markdown');
      const codeFrame = frame.querySelector<HTMLElement>('.file-preview-markdown pre');
      const codeScroll = frame.querySelector<HTMLElement>('.file-preview-markdown pre code');
      if (!markdown || !codeFrame || !codeScroll) return null;
      codeScroll.scrollLeft = Math.min(48, codeScroll.scrollWidth - codeScroll.clientWidth);
      const frameRect = frame.getBoundingClientRect();
      const markdownRect = markdown.getBoundingClientRect();
      const codeFrameRect = codeFrame.getBoundingClientRect();
      const codeScrollRect = codeScroll.getBoundingClientRect();
      const codeStyle = getComputedStyle(codeScroll);
      const markdownStyle = getComputedStyle(markdown);
      return {
        codeFrameInset: codeFrameRect.left - frameRect.left >= 15,
        codeScrollbarGutter: Number.parseFloat(codeStyle.paddingBottom) >= 15,
        codeScrollInset: codeScrollRect.left - codeFrameRect.left >= 15,
        codeScrollsHorizontally: codeScroll.scrollWidth > codeScroll.clientWidth,
        markdownInset: markdownRect.left - frameRect.left >= 15,
        markdownPreservesSelection: markdown.hasAttribute('data-preserve-selection'),
        markdownSelectable: markdownStyle.userSelect === 'text',
        markdownTextPreview: markdown.hasAttribute('data-preview-text'),
      };
    })).toEqual({
      codeFrameInset: true,
      codeScrollbarGutter: true,
      codeScrollInset: true,
      codeScrollsHorizontally: true,
      markdownInset: true,
      markdownPreservesSelection: true,
      markdownSelectable: true,
      markdownTextPreview: true,
    });

    const textPreview = await pasteClipboardFileAndOpenPreview(page, {
      name: 'edge-log.txt',
      mimeType: 'text/plain',
      text: 'edge log',
    });
    await expect(textPreview.locator('.file-preview-code pre.shiki')).toBeVisible();
    await expect.poll(async () => textPreview.evaluate((frame) => {
      const codeFrame = frame.querySelector<HTMLElement>('.file-preview-code');
      const codeScroll = frame.querySelector<HTMLElement>('.file-preview-code pre.shiki');
      if (!codeFrame || !codeScroll) return null;
      codeScroll.scrollLeft = Math.min(48, codeScroll.scrollWidth - codeScroll.clientWidth);
      const frameRect = frame.getBoundingClientRect();
      const codeFrameRect = codeFrame.getBoundingClientRect();
      const codeScrollRect = codeScroll.getBoundingClientRect();
      const codeStyle = getComputedStyle(codeScroll);
      const codeFrameStyle = getComputedStyle(codeFrame);
      return {
        codeFrameInset: codeFrameRect.left - frameRect.left >= 15,
        codeFramePreservesSelection: codeFrame.hasAttribute('data-preserve-selection'),
        codeFrameSelectable: codeFrameStyle.userSelect === 'text',
        codeFrameTextPreview: codeFrame.hasAttribute('data-preview-text'),
        codeScrollbarGutter: Number.parseFloat(codeStyle.paddingBottom) >= 15,
        codeScrollInset: codeScrollRect.left - frameRect.left >= 15,
        codeScrollsHorizontally: codeScroll.scrollWidth > codeScroll.clientWidth,
      };
    })).toEqual({
      codeFrameInset: true,
      codeFramePreservesSelection: true,
      codeFrameSelectable: true,
      codeFrameTextPreview: true,
      codeScrollbarGutter: true,
      codeScrollInset: true,
      codeScrollsHorizontally: true,
    });

    const tablePreview = await pasteClipboardFileAndOpenPreview(page, {
      name: 'edge-table.csv',
      mimeType: 'text/csv',
      text: 'name,value',
    });
    await expect(tablePreview.locator('.file-preview-table-wrap .file-preview-table')).toBeVisible();
    await expect.poll(async () => tablePreview.evaluate((frame) => {
      const tableFrame = frame.querySelector<HTMLElement>('.file-preview-table-wrap');
      const tableScroll = frame.querySelector<HTMLElement>('.file-preview-table-scroll');
      if (!tableFrame || !tableScroll) return null;
      tableScroll.scrollLeft = Math.min(48, tableScroll.scrollWidth - tableScroll.clientWidth);
      const frameRect = frame.getBoundingClientRect();
      const tableFrameRect = tableFrame.getBoundingClientRect();
      const tableScrollRect = tableScroll.getBoundingClientRect();
      const tableStyle = getComputedStyle(tableScroll);
      const tableFrameStyle = getComputedStyle(tableFrame);
      return {
        tableFrameInset: tableFrameRect.left - frameRect.left >= 15,
        tableFramePreservesSelection: tableFrame.hasAttribute('data-preserve-selection'),
        tableFrameSelectable: tableFrameStyle.userSelect === 'text',
        tableFrameTextPreview: tableFrame.hasAttribute('data-preview-text'),
        tableScrollbarGutter: Number.parseFloat(tableStyle.paddingBottom) >= 15,
        tableScrollInset: tableScrollRect.left - frameRect.left >= 15,
        tableScrollsHorizontally: tableScroll.scrollWidth > tableScroll.clientWidth,
      };
    })).toEqual({
      tableFrameInset: true,
      tableFramePreservesSelection: true,
      tableFrameSelectable: true,
      tableFrameTextPreview: true,
      tableScrollbarGutter: true,
      tableScrollInset: true,
      tableScrollsHorizontally: true,
    });
  });

  test('EPUB Sources render through the embedded reader instead of metadata fallback', async ({ page }) => {
    const epubPreview = await pasteClipboardFileAndOpenPreview(page, {
      name: 'preview-book.epub',
      mimeType: 'application/epub+zip',
      text: 'epub bytes',
    });

    await expect(epubPreview.locator('.file-preview-epub--summary')).toBeVisible();
    await expect(epubPreview.locator('.file-preview-epub-host')).toHaveAttribute('aria-label', 'preview-book.epub EPUB reader');
    await expect(epubPreview.locator('.file-preview-epub-host')).toHaveAttribute('aria-hidden', 'false');
    await expect(epubPreview.locator('.file-preview-epub-section')).toHaveCount(1);
    await expect(epubPreview.locator('.file-preview-metadata')).toHaveCount(0);
    const previewCalls = await commandCalls(page);
    expect(previewCalls.some((call) => call.cmd === 'preview_read_bytes')).toBe(false);

    const epubBody = page.locator('.node-source-preview > .file-node-body').last();
    await expectConcentricPreviewCorners(epubPreview, '.file-preview-epub-host');
    await epubBody.locator('.file-preview-pill-primary').click();
    const fullPreview = epubBody.locator('.file-node-preview.expanded .file-preview-epub--full');
    const fullReader = fullPreview.locator('.file-preview-epub-host');
    await expectConcentricPreviewCorners(epubBody.locator('.file-node-preview.expanded'), '.file-preview-epub-host');
    await expect(fullReader).toHaveAttribute('data-epub-continuous-reader', 'true');
    await expect(fullReader).toHaveAttribute('data-epub-section-count', '2');
    await expect(fullReader.locator('.file-preview-epub-section')).toHaveCount(2);
    await expect(fullReader.locator('.file-preview-epub-iframe')).toHaveCount(2);
    const outlineRail = fullPreview.locator('.document-outline-rail');
    const outlineMarkers = outlineRail.locator('.document-outline-rail-marker');
    await expect(outlineMarkers).toHaveCount(2);
    await expect.poll(async () => outlineMarkers.evaluateAll((markers) => {
      const [first, second] = markers.map((marker) => marker.getBoundingClientRect());
      return first && second ? Math.round(second.top - first.bottom) : null;
    })).toBe(8);
    await expect.poll(async () => outlineMarkers.evaluateAll((markers) => (
      markers.map((marker) => Math.round(marker.getBoundingClientRect().width))
    ))).toEqual([10, 10]);
    await expect.poll(async () => outlineMarkers.evaluateAll((markers) => (
      markers.map((marker) => getComputedStyle(marker).opacity)
    ))).toEqual(['0.86', '0.34']);
    await expect.poll(async () => outlineRail.evaluate((rail) => Math.round(rail.getBoundingClientRect().height)))
      .toBeLessThan(60);
    await outlineRail.locator('.document-outline-rail-track').hover();
    await expect(outlineRail.locator('.document-outline-item-title')).toHaveText(['Start', 'Continue']);

    const readerBox = await fullReader.boundingBox();
    if (!readerBox) throw new Error('Missing EPUB reader bounds');
    const sectionGap = await fullReader.evaluate((element) => {
      const sections = Array.from(element.querySelectorAll<HTMLElement>('.file-preview-epub-section'));
      const first = sections[0]?.getBoundingClientRect();
      const second = sections[1]?.getBoundingClientRect();
      return first && second ? second.top - first.bottom : 0;
    });
    expect(sectionGap).toBeGreaterThan(0);
    await expect.poll(async () => fullReader.locator('.file-preview-epub-frame').first().evaluate((frame) => {
      const style = getComputedStyle(frame);
      const host = frame.closest<HTMLElement>('.file-preview-epub-host');
      const hostStyle = host ? getComputedStyle(host) : null;
      const readerStyle = getComputedStyle(frame.closest('.file-preview-epub') as HTMLElement);
      const iframe = frame.querySelector<HTMLElement>('.file-preview-epub-iframe');
      const iframeStyle = iframe ? getComputedStyle(iframe) : null;
      return {
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        hostBackgroundColor: readerStyle.backgroundColor,
        hostRadius: hostStyle?.borderTopLeftRadius ?? '',
        iframeRadius: iframeStyle?.borderTopLeftRadius ?? '',
        minHeight: style.minHeight,
        pageRadius: style.borderTopLeftRadius,
      };
    })).toEqual({
      backgroundColor: 'rgb(255, 255, 255)',
      boxShadow: 'none',
      hostBackgroundColor: 'rgba(0, 0, 0, 0)',
      hostRadius: '8px',
      iframeRadius: '8px',
      minHeight: '0px',
      pageRadius: '8px',
    });

    await outlineMarkers.nth(1).click();
    await expect.poll(async () => fullReader.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await page.mouse.move(readerBox.x + readerBox.width / 2, readerBox.y + readerBox.height / 2);
    await page.mouse.wheel(0, 20000);
    await expect.poll(async () => fullReader.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect.poll(async () => Boolean(await readStoredEpubReadingPosition(page))).toBe(true);

    await epubBody.locator('.file-preview-pill-primary').click();
    await expect(epubBody.locator('.file-node-preview.collapsed .file-preview-epub--summary')).toBeVisible();
    await epubBody.locator('.file-preview-pill-primary').click();
    const restoredReader = epubBody.locator('.file-node-preview.expanded .file-preview-epub-host');
    await expect(restoredReader).toHaveAttribute('data-epub-continuous-reader', 'true');
    await expect.poll(async () => restoredReader.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });

  test('PDF readers refresh the shared position only when a new full session starts', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await pasteClipboardFileAndOpenPreview(page, {
      name: 'shared-position.pdf',
      mimeType: 'application/pdf',
      text: 'pdf bytes',
    });
    const pdfBody = page.locator('.node-source-preview > .file-node-body').last();
    await pdfBody.locator('.file-preview-pill-primary').click();
    const inlineReader = pdfBody.locator('.file-node-preview.expanded .file-preview-pdf--full');
    await expect(inlineReader).toBeVisible();
    const inlinePosition = await scrollPdfReaderToPosition(page, inlineReader, 1, 0.25);

    const splitPane = await openSplitPaneFromPreviewPill(page, pdfBody);
    const splitReader = splitPane.locator('.file-preview-pdf--full');
    await expect(splitReader).toBeVisible();
    await expectPdfReaderPosition(splitReader, inlinePosition);
    const firstSplitPosition = await scrollPdfReaderToPosition(page, splitReader, 2, 0.2);
    expect(firstSplitPosition.pageNumber).toBeGreaterThan(inlinePosition.pageNumber);

    const resizeHandle = pdfBody.locator('.file-preview-resize-handle');
    await resizeHandle.focus();
    await resizeHandle.press('ArrowDown');
    await waitForPdfReaderLayout(inlineReader);

    const latestSplitPosition = await scrollPdfReaderToPosition(page, splitReader, 3, 0.04);
    await pdfBody.locator('.file-preview-pill-primary').click();
    await expect(pdfBody.locator('.file-node-preview.collapsed .file-preview-pdf--summary')).toBeVisible();
    await pdfBody.locator('.file-preview-pill-primary').click();
    const restoredReader = pdfBody.locator('.file-node-preview.expanded .file-preview-pdf--full');
    await expect(restoredReader).toBeVisible();
    await expectPdfReaderPosition(restoredReader, latestSplitPosition);
    await expect.poll(async () => {
      const [restoredPosition, storedPosition] = await Promise.all([
        readPdfReaderPosition(restoredReader),
        readStoredPdfReadingPosition(page),
      ]);
      return restoredPosition && storedPosition
        ? pdfReadingPositionsMatch(restoredPosition, storedPosition, 0.08)
        : false;
    }).toBe(true);
  });

  test('EPUB readers refresh the shared position only when a new full session starts', async ({ page }) => {
    await pasteClipboardFileAndOpenPreview(page, {
      name: 'shared-position.epub',
      mimeType: 'application/epub+zip',
      text: 'epub bytes',
    });
    const epubBody = page.locator('.node-source-preview > .file-node-body').last();
    await epubBody.locator('.file-preview-pill-primary').click();
    const inlineReader = epubBody.locator('.file-node-preview.expanded .file-preview-epub-host');
    await expect(inlineReader).toHaveAttribute('data-epub-continuous-reader', 'true');
    const inlinePosition = await scrollEpubReaderToPosition(page, inlineReader, 0, 0.25);

    const splitPane = await openSplitPaneFromPreviewPill(page, epubBody);
    const splitReader = splitPane.locator('.file-preview-epub-host');
    await expect(splitReader).toHaveAttribute('data-epub-continuous-reader', 'true');
    await expectEpubReaderPosition(splitReader, inlinePosition);
    const firstSplitPosition = await scrollEpubReaderToPosition(page, splitReader, 1, 0.2);
    expect(firstSplitPosition.sectionIndex).toBeGreaterThan(inlinePosition.sectionIndex);

    const resizeHandle = epubBody.locator('.file-preview-resize-handle');
    await resizeHandle.focus();
    await resizeHandle.press('ArrowDown');
    await waitForEpubReaderLayout(inlineReader);
    await expect.poll(async () => (await readEpubReaderPosition(inlineReader))?.sectionIndex ?? -1)
      .toBe(inlinePosition.sectionIndex);

    const latestSplitPosition = await scrollEpubReaderToPosition(page, splitReader, 1, 0.55);
    await epubBody.locator('.file-preview-pill-primary').click();
    await expect(epubBody.locator('.file-node-preview.collapsed .file-preview-epub--summary')).toBeVisible();
    await epubBody.locator('.file-preview-pill-primary').click();
    const restoredReader = epubBody.locator('.file-node-preview.expanded .file-preview-epub-host');
    await expect(restoredReader).toHaveAttribute('data-epub-continuous-reader', 'true');
    await expectEpubReaderPosition(restoredReader, latestSplitPosition);
    await expect.poll(async () => {
      const [restoredPosition, storedPosition] = await Promise.all([
        readEpubReaderPosition(restoredReader),
        readStoredEpubReadingPosition(page),
      ]);
      return restoredPosition && storedPosition
        ? epubReadingPositionsMatch(restoredPosition, storedPosition, 0.08)
        : false;
    }).toBe(true);
  });

  test('EPUB readers translate in place without inheriting website automatic consent', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await configurePreviewTranslationMock(page, {
      delayMs: 150,
      language: 'zh-Hans',
      preferences: {
        translationModel: null,
        autoTranslateEpubs: false,
        autoTranslateUrls: true,
      },
    });
    const { chapter, readerPane } = await openEpubSplitReader(page, 'translated-book.epub');
    const translationToggle = readerPane.locator('.file-preview-translation-toggle');
    await expect(translationToggle).toHaveAttribute('aria-label', 'Translation settings: Translation off');
    const headerActions = readerPane.locator('.panel-breadcrumb-actions .file-preview-reader-actions');
    await expect(headerActions).toHaveCount(2);
    const headerActionPositions = await readerPane.locator('.panel-sticky-breadcrumb').evaluate((header) => {
      const actions = [...header.querySelectorAll<HTMLElement>('.file-preview-reader-actions')];
      const close = header.querySelector<HTMLElement>('.panel-breadcrumb-close');
      const trailing = header.querySelector<HTMLElement>('.panel-breadcrumb-trailing');
      if (actions.length !== 2 || !close || !trailing) throw new Error('Missing reader header actions');
      const translationRect = actions[0].getBoundingClientRect();
      const moreRect = actions[1].getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      return {
        translationLeft: translationRect.left,
        moreLeft: moreRect.left,
        closeLeft: closeRect.left,
        actualGap: closeRect.left - moreRect.right,
        expectedGap: Number.parseFloat(getComputedStyle(trailing).columnGap),
        trailingAppRegion: getComputedStyle(trailing).getPropertyValue('-webkit-app-region').trim(),
      };
    });
    expect(headerActionPositions.translationLeft).toBeLessThan(headerActionPositions.moreLeft);
    expect(headerActionPositions.moreLeft).toBeLessThan(headerActionPositions.closeLeft);
    expect(headerActionPositions.actualGap).toBeCloseTo(headerActionPositions.expectedGap, 1);
    expect(headerActionPositions.trailingAppRegion).toBe('no-drag');
    await page.waitForTimeout(200);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'url_page_translate_blocks')).toHaveLength(0);

    await translationToggle.click();
    await page.getByRole('dialog', { name: 'Translation settings' })
      .locator('.file-preview-translation-command')
      .click();
    await expect(chapter.locator('[data-tenon-epub-translation-status="loading"]').first()).toBeVisible();

    const firstTranslation = chapter.locator('[data-tenon-epub-translation="true"]').first();
    await expect(firstTranslation).toContainText('Translated:');
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => (
        call.cmd === 'url_page_translate_blocks'
        && call.args.contentKind === 'document'
      ));
    }).toBe(true);
    const callsBeforeOriginal = (await commandCalls(page))
      .filter((call) => call.cmd === 'url_page_translate_blocks');
    const firstRequestIds = new Set(
      (Array.isArray(callsBeforeOriginal[0]?.args.blocks) ? callsBeforeOriginal[0].args.blocks : [])
        .flatMap((block) => (
          block && typeof block === 'object' && typeof (block as { id?: unknown }).id === 'string'
            ? [(block as { id: string }).id]
            : []
        )),
    );
    expect(firstRequestIds.size).toBeGreaterThan(0);

    await translationToggle.click();
    await page.getByRole('dialog', { name: 'Translation settings' })
      .locator('.file-preview-translation-command')
      .click();
    await expect(firstTranslation).toBeHidden();

    const callCountBeforeRestore = callsBeforeOriginal.length;
    await translationToggle.click();
    await page.getByRole('dialog', { name: 'Translation settings' })
      .locator('.file-preview-translation-command')
      .click();
    await expect(firstTranslation).toBeVisible();
    await page.waitForTimeout(250);
    const restoreCalls = (await commandCalls(page))
      .filter((call) => call.cmd === 'url_page_translate_blocks')
      .slice(callCountBeforeRestore);
    const restoredIds = restoreCalls.flatMap((call) => (
      Array.isArray(call.args.blocks)
        ? call.args.blocks.flatMap((block) => (
            block && typeof block === 'object' && typeof (block as { id?: unknown }).id === 'string'
              ? [(block as { id: string }).id]
              : []
          ))
        : []
    ));
    expect(restoredIds.some((id) => firstRequestIds.has(id))).toBe(false);
  });

  test('same-language EPUB readers stay idle without provider requests', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await configurePreviewTranslationMock(page, {
      delayMs: 30,
      language: 'en',
      preferences: {
        translationModel: null,
        autoTranslateEpubs: false,
        autoTranslateUrls: false,
      },
    });
    const { chapter, readerPane } = await openEpubSplitReader(page, 'same-language-book.epub');
    const translationToggle = readerPane.locator('.file-preview-translation-toggle');
    await translationToggle.click();
    await page.getByRole('dialog', { name: 'Translation settings' })
      .locator('.file-preview-translation-command')
      .click();
    await expect(translationToggle).toHaveAttribute('aria-label', 'Translation settings: Translation on');
    await page.waitForTimeout(250);

    expect((await commandCalls(page)).filter((call) => call.cmd === 'url_page_translate_blocks')).toHaveLength(0);
    await expect(chapter.locator('[data-tenon-epub-translation-status]')).toHaveCount(0);
    await expect(chapter.locator('[data-tenon-epub-translation]')).toHaveCount(0);
  });

  test('long EPUB readers mount sections lazily as they scroll into view', async ({ page }) => {
    await pasteClipboardFileAndOpenPreview(page, {
      name: 'preview-long-book.epub',
      mimeType: 'application/epub+zip',
      text: 'epub bytes',
    });

    const epubBody = page.locator('.node-source-preview > .file-node-body').last();
    await epubBody.locator('.file-preview-pill-primary').click();
    const fullReader = epubBody.locator('.file-node-preview.expanded .file-preview-epub-host');
    await expect(fullReader).toHaveAttribute('data-epub-continuous-reader', 'true');
    await expect(fullReader).toHaveAttribute('data-epub-section-count', '12');
    // Every section reserves an always-rendered wrapper so navigation/restore can resolve
    // any section, mounted or not.
    await expect(fullReader.locator('.file-preview-epub-section')).toHaveCount(12);

    const firstSectionIframe = fullReader.locator(
      '.file-preview-epub-section[data-epub-section-index="0"] .file-preview-epub-iframe',
    );
    const lastSectionIframe = fullReader.locator(
      '.file-preview-epub-section[data-epub-section-index="11"] .file-preview-epub-iframe',
    );
    // The near section mounts its iframe; the far last section does not, and the reader
    // never mounts all 12 documents at once.
    await expect(firstSectionIframe).toHaveCount(1);
    await expect(lastSectionIframe).toHaveCount(0);
    await expect.poll(async () => fullReader.locator('.file-preview-epub-iframe').count())
      .toBeLessThan(12);

    // Scrolling to the bottom brings the last section into view, which mounts it.
    await fullReader.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(lastSectionIframe).toHaveCount(1);
  });

  test('unsupported Source previews keep the same bottom action location as previewable Sources', async ({ page }) => {
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
    await expect(rowEditor(page, pastedId)).toContainText('archive.zip');

    await attachmentRow.locator('> .row').first().hover();
    await attachmentRow.locator('> .row .row-bullet-button').first().click();
    const metadataPreview = page.locator('.outline-panel-surface.active-panel .node-source-preview .file-node-preview--metadata');
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
    await expect(page.locator('.node-source-preview > .file-node-body > .file-preview-pill')).toHaveCount(0);
    await expect.poll(async () => pill.evaluate((element) => getComputedStyle(element).position)).toBe('static');
    await expect.poll(async () => metadataPreview.evaluate((frame) => {
      const pill = frame.querySelector('.file-preview-pill');
      const metadata = frame.querySelector('.file-preview-metadata');
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

  test('Source preview action menus dismiss on outside clicks without a surface focus outline', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await pasteClipboardFile(page, {
      name: 'dismiss-menu.zip',
      mimeType: 'application/zip',
      text: 'zip bytes',
    });
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const pastedId = (await todayChildren(page)).at(-1)!;
    const attachmentRow = row(page, pastedId);
    await attachmentRow.locator('> .row').first().hover();
    await attachmentRow.locator('> .row .row-bullet-button').first().click();
    const metadataPreview = page.locator('.outline-panel-surface.active-panel .node-source-preview .file-node-preview--metadata');
    await expect(metadataPreview).toBeVisible();

    await metadataPreview.locator('.file-preview-pill-more').click();
    const menu = page.getByRole('menu', { name: 'Preview actions' });
    await expect(menu).toBeVisible();
    await expect.poll(async () => menu.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');

    await page.locator('.outline-panel-surface.active-panel .panel-title-editor').click();
    await expect(menu).toBeHidden();
  });

  test('a Source-backed row keeps ordinary editable content and keyboard behavior', async ({ page }) => {
    const beforeChildren = await todayChildren(page);
    await trailingEditor(page).click();
    await page.keyboard.type('/attachment');
    await expect(page.getByRole('option', { name: /Attachment/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
    const attachmentId = (await todayChildren(page)).at(-1)!;
    const attachmentRow = row(page, attachmentId);
    const titleEditor = rowEditor(page, attachmentId);
    await expect(titleEditor).toContainText('picked-report.pdf');

    // Source-backed rows use the same real editor as every other ordinary Node.
    const anchor = attachmentRow.locator('.file-node-keyboard-anchor');
    await expect(anchor).toHaveCount(0);
    await expect(titleEditor).toHaveCount(1);
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Renamed report');
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const node = projection.nodes.find((entry) => entry.id === attachmentId);
      const sourceEntry = projection.nodes.find((entry) => entry.id === `${attachmentId}::source`);
      return {
        content: node?.content.text ?? null,
        sourceCount: sourceEntry?.children.length ?? 0,
      };
    }).toEqual({ content: 'Renamed report', sourceCount: 1 });

    const countBeforeFilePaste = (await todayChildren(page)).length;
    await titleEditor.click();
    await pasteClipboardFile(page, {
      name: 'file-title-paste.pdf',
      mimeType: 'application/pdf',
      text: '%PDF pasted from a read-only file title',
    });
    await expect.poll(async () => (await todayChildren(page)).length).toBe(countBeforeFilePaste + 1);
    const pastedFromTitleId = (await todayChildren(page))[countBeforeFilePaste];
    expect(pastedFromTitleId).toBeTruthy();
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const pasted = projection.nodes.find((node) => node.id === pastedFromTitleId);
      const sourceEntry = projection.nodes.find((node) => node.id === `${pastedFromTitleId}::source`);
      return {
        name: pasted?.content.text ?? null,
        sourceCount: sourceEntry?.children.length ?? 0,
        type: pasted?.type ?? null,
      };
    }).toEqual({ name: 'file-title-paste.pdf', sourceCount: 1, type: null });
    await expect.poll(async () => (
      (await e2eProjection(page)).nodes.find((node) => node.id === attachmentId)?.content.text
    )).toBe('Renamed report');
    await expect(titleEditor).toContainText('Renamed report');

    // Tags and structural navigation remain the ordinary Node command surface.
    await titleEditor.click();
    await page.keyboard.press('Meta+ArrowRight');
    await page.keyboard.type(' #project');
    await expect(titleEditor).toContainText('Renamed report #project');
    const tagListbox = page.getByRole('listbox', { name: 'Tag suggestions' });
    await expect(tagListbox).toBeVisible();
    await expect(page.getByRole('option', { name: 'project' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(tagListbox).toHaveCount(0);
    await expect(attachmentRow.locator('.tag-badge-label')).toHaveText('project');
    await expect(titleEditor).toContainText('Renamed report');

    const countBeforeEnter = (await todayChildren(page)).length;
    await titleEditor.click();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await todayChildren(page)).length).toBe(countBeforeEnter + 1);
  });
});
