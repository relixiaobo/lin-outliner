import { expect, test, type Page } from '@playwright/test';
import {
  e2eProjection,
  installElectronMock,
  ids,
  multiSelect,
  nodeById,
  row,
  rowBody,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

interface SurfaceProbe {
  bodyTextLength: number;
  bodyHorizontalOverflow: number;
  colorScheme: string;
  hasRendererThemeBridge: boolean;
  popoverItemViolations: string[];
  visibleOutOfViewport: Array<{
    selector: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>;
}

interface SurfaceCase {
  name: string;
  path: string;
  waitFor: string;
  installAppMock?: boolean;
  options?: Parameters<typeof installElectronMock>[1];
  beforeInstall?: (page: Page) => Promise<void>;
  beforeProbe?: (page: Page) => Promise<void>;
}

async function todayChildren(page: Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children
    .filter((nodeId) => nodeId !== `${ids.today}::source`) ?? [];
}

async function invokeDocumentCommand(page: Page, cmd: string, args: Record<string, unknown>) {
  await page.evaluate(async ({ cmd, args }) => {
    const win = window as typeof window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
    };
    const outcome = await win.lin!.invoke<{ update: { projection: unknown } }>(cmd, args);
    win.__LIN_E2E__?.emitDocumentEvent({ type: 'projection_changed', projection: outcome.update.projection });
  }, { cmd, args });
}

async function installLauncherMock(page: Page) {
  await page.addInitScript(() => {
    const win = window as typeof window & {
      lin?: Record<string, unknown>;
    };
    // The launcher's OWN bridge. It cannot reach `lin:invoke`, and it never
    // builds a result list: main pushes the opening it created for the summon.
    const object = (ref: string, name: string, kind: string) => ({
      objectRef: ref,
      kind,
      name: { source: 'localized', values: { en: name, 'zh-Hans': name } },
      iconId: 'node',
      typeLabel: { en: 'App', 'zh-Hans': 'App' },
    });
    const openAction = (ref: string) => ({
      actionId: 'open',
      subjectRef: ref,
      names: { en: 'Open', 'zh-Hans': '打开' },
      aliases: [],
      iconId: 'open',
      surfaces: ['actionPanel'],
      evaluation: { status: 'applicable' },
      binding: { state: 'ready', arguments: {} },
    });
    const opening = {
      invocationRef: 'inv-e2e',
      openSeq: 1,
      ambient: { state: 'pending', revision: 0 },
      fixedItems: [],
      resultItems: [
        { object: object('ref-today', 'Today', 'node'), primaryAction: openAction('ref-today'), actions: [openAction('ref-today')] },
        { object: object('ref-main', 'Main window', 'appSurface'), primaryAction: openAction('ref-main'), actions: [openAction('ref-main')] },
        { object: object('ref-settings', 'Settings', 'appSurface'), primaryAction: openAction('ref-settings'), actions: [openAction('ref-settings')] },
      ],
      menuActions: [],
    };
    win.lin = {
      ...(win.lin ?? {}),
      launcher: {
        getInitialState: async () => ({ hotkey: 'CommandOrControl+Shift+Space' }),
        onShown: () => () => {},
        onRemediation: () => () => {},
        hide: async () => {},
      },
      actions: {
        onOpened: (cb: (next: unknown) => void) => {
          setTimeout(() => cb(opening), 0);
          return () => {};
        },
        onAmbientChanged: () => () => {},
        queryObjects: async () => ({ status: 'superseded' }),
        queryParameters: async () => ({ status: 'superseded' }),
        request: async () => ({ status: 'completed' }),
        event: async () => ({ status: 'spent' }),
      },
    };
  });
}

async function openSchema(page: Page) {
  await page.locator('.sidebar-primary-nav')
    .getByRole('button', { name: 'Schema', exact: true })
    .click();
}

async function showViewToolbar(page: Page, nodeId = ids.today) {
  await invokeDocumentCommand(page, 'set_view_toolbar_visible', { nodeId, visible: true });
  await page.locator('.view-toolbar').first().waitFor({ state: 'visible' });
}

async function showTableView(page: Page) {
  await invokeDocumentCommand(page, 'set_view_toolbar_visible', { nodeId: ids.today, visible: true });
  await invokeDocumentCommand(page, 'add_display_field', { nodeId: ids.today, field: ids.statusField });
  await invokeDocumentCommand(page, 'add_display_field', { nodeId: ids.today, field: ids.dueField });
  await invokeDocumentCommand(page, 'set_view_mode', { nodeId: ids.today, mode: 'table' });

  const grid = page.locator(`[data-table-owner-id="${ids.today}"]`).getByRole('grid');
  await grid.waitFor({ state: 'visible' });
  await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Status', 'Due']);
}

async function showViewToolbarDisplayPopover(page: Page) {
  await showViewToolbar(page);
  const toolbar = page.locator('.view-toolbar').first();
  await toolbar.getByRole('button', { name: 'Display', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Display' });
  await dialog.waitFor({ state: 'visible' });
  await expect(dialog.getByText('Created time')).toBeVisible();
}

async function showViewToolbarGroupPopover(page: Page) {
  await showViewToolbar(page);
  const toolbar = page.locator('.view-toolbar').first();
  await toolbar.getByRole('button', { name: 'Group by', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Group by' });
  await dialog.waitFor({ state: 'visible' });
  await expect(dialog.getByRole('radio', { name: 'Done', exact: true })).toBeVisible();
}

async function showViewToolbarTooltip(page: Page) {
  await showViewToolbar(page);
  const toolbar = page.locator('.view-toolbar').first();
  await toolbar.getByRole('button', { name: 'Display', exact: true }).hover();
  await page.getByRole('tooltip', { name: 'Display' }).waitFor({ state: 'visible' });
}

async function showViewToolbarSortPopover(page: Page) {
  await showViewToolbar(page);
  const toolbar = page.locator('.view-toolbar').first();
  await toolbar.getByRole('button', { name: 'Sort by', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sort by' });
  await dialog.waitFor({ state: 'visible' });
  await expect(dialog.getByText('System fields')).toBeVisible();
}

async function showViewToolbarFilterPopover(page: Page) {
  await showViewToolbar(page);
  const toolbar = page.locator('.view-toolbar').first();
  await toolbar.getByRole('button', { name: 'Filter by', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Filter by' });
  await dialog.waitFor({ state: 'visible' });
  await expect(dialog.getByRole('button', { name: /Created time/ })).toBeVisible();
}

async function showDefinitionConfigPanel(page: Page) {
  await openSchema(page);
  await row(page, ids.projectTag).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('region', { name: 'Definition configuration' }).waitFor({ state: 'visible' });
}

async function showDefinitionConfigPicker(page: Page) {
  await showDefinitionConfigPanel(page);
  await page.getByLabel('Extend from').click();
  await page.getByRole('listbox', { name: 'Extend from options' }).waitFor({ state: 'visible' });
}

async function showPanelDateCalendar(page: Page) {
  await page.getByRole('button', { name: 'Open calendar' }).click();
  const calendar = page.getByRole('dialog', { name: 'Calendar' });
  await calendar.waitFor({ state: 'visible' });
  await expect(calendar.getByRole('gridcell', { name: /Go to 2026-05-13/ })).toBeVisible();
}

async function showTagSuggestions(page: Page) {
  await trailingEditor(page).click();
  await page.keyboard.type('#project');
  const listbox = page.getByRole('listbox', { name: 'Tag suggestions' });
  await listbox.waitFor({ state: 'visible' });
  await expect(listbox.getByRole('option', { name: 'project' })).toBeVisible();
}

async function showSlashCommands(page: Page) {
  await trailingEditor(page).click();
  await page.keyboard.type('/');
  const listbox = page.getByRole('listbox', { name: 'Slash commands' });
  await listbox.waitFor({ state: 'visible' });
  await expect(listbox.getByRole('option', { name: /Field/ })).toBeVisible();
}

async function showReferenceSuggestions(page: Page) {
  await trailingEditor(page).click();
  await page.keyboard.type('@Alpha');
  const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
  await listbox.waitFor({ state: 'visible' });
  await expect(listbox.getByRole('option', { name: /Alpha/ }).first()).toBeVisible();
}

async function showFieldNameReusePopover(page: Page) {
  await trailingEditor(page).click();
  await page.keyboard.type('>');
  const fieldId = (await todayChildren(page)).at(-1);
  if (!fieldId) throw new Error('missing field row for reuse popover surface');
  await expect(row(page, fieldId).locator('.field-name-input')).toBeFocused();
  await page.keyboard.type('Crea');
  const listbox = page.getByRole('listbox', { name: 'Reuse field' });
  await listbox.waitFor({ state: 'visible' });
  await expect(listbox.getByRole('option', { name: 'Created' })).toBeVisible();
}

async function showOptionsFieldValuePopover(page: Page) {
  await trailingEditor(page, ids.priorityEntry).click();
  const listbox = page.getByRole('listbox', { name: 'Field options' });
  await listbox.waitFor({ state: 'visible' });
  await expect(listbox.getByRole('option', { name: 'High' })).toBeVisible();
}

async function showPlainFieldReferencePopover(page: Page) {
  await trailingEditor(page, ids.referencesEntry).click();
  await page.keyboard.type('@Alpha');
  const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
  await listbox.waitFor({ state: 'visible' });
  await expect(listbox.getByRole('option', { name: 'Alpha', exact: true })).toBeVisible();
}

async function showSelectedFieldOptionsPopover(page: Page) {
  await invokeDocumentCommand(page, 'select_field_option', {
    fieldEntryId: ids.priorityEntry,
    optionNodeId: ids.priorityLow,
  });
  const projection = await e2eProjection(page);
  const valueId = projection.nodes.find((node) => node.parentId === ids.priorityEntry)?.id;
  if (!valueId) throw new Error('missing selected option value row');
  await rowBody(page, valueId).click();
  const listbox = page.getByRole('listbox', { name: 'Selected field options' });
  await listbox.waitFor({ state: 'visible' });
  await expect(listbox.getByRole('option', { name: 'Low' })).toHaveAttribute('aria-selected', 'true');
}


async function showCodeBlockLanguageMenu(page: Page) {
  const beforeChildren = await todayChildren(page);
  await trailingEditor(page).click();
  await page.keyboard.type('/code');
  await expect(page.getByRole('option', { name: /Code block/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  const codeRowId = (await todayChildren(page)).at(-1);
  if (!codeRowId) throw new Error('Missing code block node');
  await expect.poll(async () => (await nodeById(page, codeRowId))?.type ?? null).toBe('codeBlock');
  const codeRow = row(page, codeRowId);
  await codeRow.locator('.code-block-textarea').waitFor({ state: 'visible' });
  await codeRow.locator('.code-block-language').click();
  await page.getByRole('menuitemradio', { name: 'Plain text', exact: true }).waitFor({ state: 'visible' });
}


async function showRowContextMenu(page: Page) {
  await rowBody(page, ids.alpha).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Node actions' }).waitFor({ state: 'visible' });
  await expect(page.getByRole('menuitem', { name: 'Move to Trash' })).toBeVisible();
}

async function showTagContextMenu(page: Page) {
  await invokeDocumentCommand(page, 'apply_tag', { nodeId: ids.alpha, tagId: ids.projectTag });
  const tag = row(page, ids.alpha).locator('.tag-badge', { hasText: 'project' }).first();
  await tag.waitFor({ state: 'visible' });
  await tag.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'project tag actions' });
  await menu.waitFor({ state: 'visible' });
  await expect(menu.getByRole('menuitem', { name: 'Configure tag' })).toBeVisible();
}


async function showSidebarContextMenu(page: Page) {
  await page.getByRole('button', { name: 'Open Root' }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Node actions' }).waitFor({ state: 'visible' });
  await expect(page.getByRole('menuitem', { name: 'Open in split pane' })).toBeVisible();
}

async function showBatchTagSelector(page: Page) {
  await multiSelect(page, [ids.alpha, ids.beta]);
  await page.keyboard.type('#');
  await page.locator('.batch-tag-selector').waitFor({ state: 'visible' });
}

async function placeCursor(page: Page, nodeId: string, placement: 'start' | 'end') {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await editor.evaluate((element, targetPlacement) => {
    if (element instanceof HTMLElement) element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    const paragraph = element.querySelector('p') ?? element;
    range.selectNodeContents(paragraph);
    range.collapse(targetPlacement === 'start');
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, placement);
}

async function showFloatingTextToolbar(page: Page) {
  await placeCursor(page, ids.alpha, 'end');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.locator('body > .floating-editor-toolbar').waitFor({ state: 'visible' });
}

async function createNodeSourcePreview(page: Page) {
  const beforeChildren = await todayChildren(page);
  await trailingEditor(page).click();
  await page.keyboard.type('/attachment');
  await expect(page.getByRole('option', { name: /Attachment/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  const attachmentId = (await todayChildren(page)).at(-1);
  if (!attachmentId) throw new Error('Missing Source-backed Node');
  const attachmentRow = row(page, attachmentId);
  await attachmentRow.locator('> .row').first().hover();
  await attachmentRow.locator('.row-bullet-button').first().click();
  await page.locator('.outline-panel-surface.active-panel .node-source-preview .file-node-preview.collapsed')
    .waitFor({ state: 'visible' });
}

async function showComposerAttachmentError(page: Page) {
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })
    .click();
  await page.evaluate(() => {
    const win = window as typeof window & {
      lin?: {
        pickLocalFiles?: () => Promise<{
          canceled: boolean;
          files: Array<{
            path: string;
            name: string;
            mimeType: string;
            sizeBytes: number;
            lastModified: number;
          }>;
          rejectedFiles?: Array<{
            reason: string;
            name: string;
            suggestedName: string | null;
          }>;
        }>;
      };
    };
    if (!win.lin) return;
    win.lin.pickLocalFiles = async () => ({
      canceled: false,
      files: [],
      rejectedFiles: [{
        reason: 'officeOwnershipFile',
        name: '~$Report.docx',
        suggestedName: 'Report.docx',
      }],
    });
  });
  await page.getByRole('button', { name: 'Add attachment' }).click();
  await expect(page.getByRole('status'))
    .toContainText('~$Report.docx is a temporary Office ownership file. Choose Report.docx instead.');
}

async function pasteClipboardFile(page: Page, file: { name: string; mimeType: string; text: string }) {
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

async function pasteClipboardFileAndOpenPreview(page: Page, file: { name: string; mimeType: string; text: string }) {
  const beforeChildren = await todayChildren(page);
  await trailingEditor(page).click();
  await pasteClipboardFile(page, file);
  await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  const pastedId = (await todayChildren(page)).at(-1);
  if (!pastedId) throw new Error(`No pasted Source-backed Node for ${file.name}`);
  const pastedRow = row(page, pastedId);
  await pastedRow.locator('> .row').first().hover();
  await pastedRow.locator('.row-bullet-button').first().click();
  const previewFrame = page.locator('.outline-panel-surface.active-panel .node-source-preview .file-node-preview.collapsed');
  await previewFrame.waitFor({ state: 'visible' });
  return previewFrame;
}

async function showFilePreviewPillMenu(page: Page) {
  await createNodeSourcePreview(page);
  await page.locator('.node-source-preview .file-preview-pill-more').click();
  await page.getByRole('menu', { name: 'Preview actions' }).waitFor({ state: 'visible' });
}

async function showFilePreviewHeaderMenu(page: Page) {
  await pasteClipboardFileAndOpenPreview(page, {
    name: 'runtime-reader.md',
    mimeType: 'text/markdown',
    text: '# Runtime reader\n\nHeader actions surface.',
  });
  await page.locator('.node-source-preview .file-preview-pill-more').click();
  await page.getByRole('menuitem', { name: 'Open in split pane' }).click();
  const readerPane = page.locator('.outline-panel-surface.active-panel');
  await readerPane.locator('.file-preview-panel--reader').waitFor({ state: 'visible' });
  await readerPane.getByRole('button', { name: 'Preview actions' }).click();
  const readerMenu = page.getByRole('menu', { name: 'Preview actions' });
  await readerMenu.waitFor({ state: 'visible' });
  await expect(readerMenu.getByRole('menuitem', { name: 'Open with default app' })).toBeVisible();
}

async function showDocumentOutlineRail(page: Page) {
  await pasteClipboardFileAndOpenPreview(page, {
    name: 'runtime-book.epub',
    mimeType: 'application/epub+zip',
    text: 'epub bytes',
  });
  const epubBody = page.locator('.node-source-preview > .file-node-body').last();
  await epubBody.locator('.file-preview-pill-primary').click();
  const fullPreview = epubBody.locator('.file-node-preview.expanded .file-preview-epub--full');
  const outlineRail = fullPreview.locator('.document-outline-rail');
  await outlineRail.waitFor({ state: 'visible' });
  await outlineRail.locator('.document-outline-rail-track').hover();
  await expect(outlineRail.locator('.document-outline-item-title')).toHaveText(['Start', 'Continue']);
}

async function createImageSourcePreview(page: Page) {
  const beforeChildren = await todayChildren(page);
  await trailingEditor(page).click();
  await page.keyboard.type('/image');
  await expect(page.getByRole('option', { name: /Image/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  const imageId = (await todayChildren(page)).at(-1);
  if (!imageId) throw new Error('Missing image Source-backed Node');
  const imageRow = row(page, imageId);
  await imageRow.locator('> .row').first().hover();
  await imageRow.locator('.row-bullet-button').first().click();
  await page.locator('.outline-panel-surface.active-panel .node-source-preview .file-preview-image img')
    .waitFor({ state: 'visible' });
}


const surfaces: SurfaceCase[] = [
  {
    name: 'main app',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: async (page) => {
      await page.locator('.agent-dock').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'table view',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    options: { dateField: true },
    beforeProbe: showTableView,
  },
  {
    name: 'global launcher renderer',
    path: '/launcher.html',
    waitFor: '.launcher',
    installAppMock: false,
    beforeInstall: installLauncherMock,
    beforeProbe: async (page) => {
      await page.getByRole('dialog', { name: 'Tenon Launcher' }).waitFor({ state: 'visible' });
      const results = page.getByRole('listbox', { name: 'Results' });
      await results.waitFor({ state: 'visible' });
      // The row is the OBJECT — *Main window* — and its activation lives in the
      // action bar. A row named "Open main window" fused the two (D6/D8).
      await expect(results.getByRole('option', { name: /Main window/ })).toBeVisible();
      await expect(results.getByRole('option', { name: /Open main window/ })).toHaveCount(0);
    },
  },
  {
    name: 'settings general',
    path: '/?surface=settings',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: 'General', exact: true }).click();
      await page.getByRole('list', { name: 'Diagnostics' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'settings model services',
    path: '/?surface=settings&category=agent/services',
    waitFor: '.settings-window .inset-row',
  },
  {
    name: 'settings provider row menu',
    path: '/?surface=settings&category=agent/services',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: 'OpenAI actions' }).click();
      const menu = page.getByRole('menu', { name: 'Provider actions' });
      await menu.waitFor({ state: 'visible' });
      await expect(menu.getByRole('menuitem', { name: /Configure/ })).toBeVisible();
    },
  },
  {
    name: 'settings agent',
    path: '/?surface=settings',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      await page.getByRole('list', { name: 'Agent access' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'settings preview',
    path: '/?surface=settings',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await page.getByRole('list', { name: 'Translation preferences' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'settings skills',
    path: '/?surface=settings&category=agent/skills',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.locator('.inset-row', { hasText: '/workspace-review' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'settings about',
    path: '/?surface=settings&category=general/about',
    waitFor: '.settings-window .inset-row',
  },
  {
    name: 'provider config',
    path: '/?surface=provider-config&provider=anthropic&mode=configure',
    waitFor: '.provider-config-window',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'search query builder',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: async (page) => {
      await page.locator('.sidebar-primary-nav')
        .getByRole('button', { name: 'Recents', exact: true })
        .click();
      await page.getByRole('button', { name: 'Show query' }).click();
      await page.locator('[data-search-query-builder]').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'view toolbar display popover',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showViewToolbarDisplayPopover,
  },
  {
    name: 'view toolbar group popover',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showViewToolbarGroupPopover,
  },
  {
    name: 'view toolbar tooltip',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showViewToolbarTooltip,
  },
  {
    name: 'view toolbar sort popover',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showViewToolbarSortPopover,
  },
  {
    name: 'view toolbar filter popover',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showViewToolbarFilterPopover,
  },
  {
    name: 'definition config panel',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showDefinitionConfigPanel,
  },
  {
    name: 'definition config picker',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showDefinitionConfigPicker,
  },
  {
    name: 'date picker overlay',
    path: '/',
    waitFor: `[data-node-id="${ids.dueEntry}"]`,
    options: { dateField: true },
    beforeInstall: async (page) => {
      await page.clock.setFixedTime(new Date('2026-05-13T09:00:00'));
    },
    beforeProbe: async (page) => {
      const draft = page.locator(`[data-trailing-parent-id="${ids.dueEntry}"] .row-editor .ProseMirror`);
      await draft.press('Space');
      await page.getByRole('dialog', { name: 'Date picker' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'panel date calendar',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showPanelDateCalendar,
  },
  {
    name: 'tag suggestions overlay',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showTagSuggestions,
  },
  {
    name: 'slash command overlay',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showSlashCommands,
  },
  {
    name: 'reference suggestions overlay',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showReferenceSuggestions,
  },
  {
    name: 'field name reuse popover',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showFieldNameReusePopover,
  },
  {
    name: 'options field value popover',
    path: '/',
    waitFor: `[data-node-id="${ids.priorityEntry}"]`,
    options: { optionsField: true },
    beforeProbe: showOptionsFieldValuePopover,
  },
  {
    name: 'plain field reference suggestions overlay',
    path: '/',
    waitFor: `[data-node-id="${ids.referencesEntry}"]`,
    options: { relatedField: true },
    beforeProbe: showPlainFieldReferencePopover,
  },
  {
    name: 'selected field options popover',
    path: '/',
    waitFor: `[data-node-id="${ids.priorityEntry}"]`,
    options: { optionsField: true },
    beforeProbe: showSelectedFieldOptionsPopover,
  },
  {
    name: 'code block language menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showCodeBlockLanguageMenu,
  },
  {
    name: 'row context menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showRowContextMenu,
  },
  {
    name: 'tag context menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showTagContextMenu,
  },
  // REMOVED: 'delete forever confirm dialog'. The outliner's permanent-delete
  // confirmation is outside Cmd+Z's reach and is now nameable by a second,
  // locked-down renderer, so it became main's OWN native sheet — which no
  // page-level probe can render or measure. The `ConfirmDialog` primitive is
  // still shipped and used by Settings, the Thread dock and Automations, but it
  // no longer has a runtime token probe here. That is a deliberate narrowing of
  // this guard's exception set, not a relaxation to make a test pass: re-add a
  // probe when one of those consumers gets a deterministic path in this fixture.
  {
    name: 'sidebar context menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showSidebarContextMenu,
  },
  {
    name: 'batch tag selector',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showBatchTagSelector,
  },
  {
    name: 'floating text toolbar',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showFloatingTextToolbar,
  },
  {
    name: 'Node Source preview',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: createNodeSourcePreview,
  },
  {
    name: 'composer attachment error',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showComposerAttachmentError,
  },
  {
    name: 'file preview pill menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showFilePreviewPillMenu,
  },
  {
    name: 'file preview header menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showFilePreviewHeaderMenu,
  },
  {
    name: 'document outline rail',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showDocumentOutlineRail,
  },
  {
    name: 'image Source preview',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: createImageSourcePreview,
  },
];

async function probeSurface(page: Page): Promise<SurfaceProbe> {
  return page.evaluate(() => {
    const isVisible = (element: Element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    };

    const visibleOutOfViewport = Array.from(document.querySelectorAll('body *'))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: element instanceof HTMLElement
            ? [
              element.tagName.toLowerCase(),
              element.id ? `#${element.id}` : '',
              ...Array.from(element.classList).slice(0, 3).map((name) => `.${name}`),
            ].join('')
            : element.tagName.toLowerCase(),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        };
      })
      .filter((rect) => rect.right > window.innerWidth + 2 || rect.left < -2)
      .slice(0, 20);

    const visiblePopoverItems = Array.from(document.querySelectorAll<HTMLElement>('.popover-item'))
      .filter(isVisible);
    const popoverItemViolations = visiblePopoverItems.flatMap((item) => {
      const violations: string[] = [];
      const style = getComputedStyle(item);
      const parent = item.parentElement;
      const label = item.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 40) || '(unlabelled)';

      if (style.display !== 'flex') violations.push(`${label}: display=${style.display}`);
      if (!item.classList.contains('disabled') && Number.parseFloat(style.opacity) < 0.99) {
        violations.push(`${label}: opacity=${style.opacity}`);
      }
      if (item.classList.contains('active') && !item.classList.contains('disabled')) {
        const background = style.backgroundColor;
        if (background === 'transparent' || background === 'rgba(0, 0, 0, 0)') {
          violations.push(`${label}: active background is transparent`);
        }
      }
      if (parent) {
        const parentStyle = getComputedStyle(parent);
        const parentContentWidth = parent.clientWidth
          - Number.parseFloat(parentStyle.paddingLeft)
          - Number.parseFloat(parentStyle.paddingRight);
        const itemWidth = item.getBoundingClientRect().width;
        if (Math.abs(parentContentWidth - itemWidth) > 1) {
          violations.push(`${label}: width=${itemWidth.toFixed(1)}, parent=${parentContentWidth.toFixed(1)}`);
        }
      }

      return violations;
    });

    const itemGroups = new Map<HTMLElement, HTMLElement[]>();
    for (const item of visiblePopoverItems) {
      const owner = item.closest<HTMLElement>('[role="listbox"], [role="menu"], .batch-tag-list');
      if (!owner) continue;
      const group = itemGroups.get(owner) ?? [];
      group.push(item);
      itemGroups.set(owner, group);
    }
    for (const items of itemGroups.values()) {
      for (let index = 1; index < items.length; index += 1) {
        const previous = items[index - 1].getBoundingClientRect();
        const current = items[index].getBoundingClientRect();
        if (current.top < previous.bottom - 1) {
          popoverItemViolations.push(`popover rows overlap at item ${index + 1}`);
        }
      }
    }

    for (const bullet of document.querySelectorAll<HTMLElement>('.popover-item-bullet')) {
      const item = bullet.closest<HTMLElement>('.popover-item');
      if (!item || !isVisible(item)) continue;
      const box = bullet.getBoundingClientRect();
      const marker = getComputedStyle(bullet, '::before');
      const width = Number.parseFloat(marker.width);
      const height = Number.parseFloat(marker.height);
      if (
        box.width < 1
        || box.height < 1
        || !Number.isFinite(width)
        || !Number.isFinite(height)
        || width < 5
        || height < 5
      ) {
        popoverItemViolations.push(
          `popover bullet: box=${box.width.toFixed(1)}x${box.height.toFixed(1)}, marker=${marker.width}x${marker.height}`,
        );
      }
    }

    const root = document.documentElement;
    return {
      bodyTextLength: document.body.innerText.trim().length,
      bodyHorizontalOverflow: root.scrollWidth - root.clientWidth,
      colorScheme: getComputedStyle(root).colorScheme,
      hasRendererThemeBridge: Boolean(document.querySelector('[data-theme]')),
      popoverItemViolations,
      visibleOutOfViewport,
    };
  });
}

test.describe('design-system runtime surfaces', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const surface of surfaces) {
      test(`${surface.name} stays bounded and theme-native in ${colorScheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme });
        await surface.beforeInstall?.(page);
        if (surface.installAppMock !== false) {
          await installElectronMock(page, surface.options ?? {});
        }
        await page.goto(surface.path);
        await page.locator(surface.waitFor).first().waitFor({ state: 'visible' });
        await surface.beforeProbe?.(page);

        const probe = await probeSurface(page);
        expect(probe.bodyTextLength).toBeGreaterThan(0);
        expect(probe.bodyHorizontalOverflow).toBe(0);
        expect(probe.visibleOutOfViewport).toEqual([]);
        expect(probe.popoverItemViolations).toEqual([]);
        expect(probe.hasRendererThemeBridge).toBe(false);
        expect(probe.colorScheme).toContain(colorScheme);
      });
    }
  }
});
