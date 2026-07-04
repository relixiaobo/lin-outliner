import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
import {
  e2eProjection,
  emitAgentProjection,
  installElectronMock,
  ids,
  multiSelect,
  nodeById,
  openMockRunDetailsFromAssistantDetailsButton,
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
  options?: Parameters<typeof installElectronMock>[1];
  beforeInstall?: (page: Page) => Promise<void>;
  beforeProbe?: (page: Page) => Promise<void>;
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

async function todayChildren(page: Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
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

async function showAgentChannelPicker(page: Page) {
  await page.getByRole('button', { name: 'Show conversations' }).click();
  const dialog = page.getByRole('dialog', { name: 'Channels' });
  await dialog.waitFor({ state: 'visible' });
  await expect(dialog.getByRole('button', { name: /Neva/ })).toBeVisible();
}

async function showAgentChannelOptionsMenu(page: Page) {
  await page.getByRole('button', { name: 'Show conversations' }).click();
  const dialog = page.getByRole('dialog', { name: 'Channels' });
  await dialog.waitFor({ state: 'visible' });
  const channelRow = dialog.locator('.agent-conversation-row', { hasText: 'Planning Channel' }).first();
  await channelRow.hover();
  await channelRow.getByRole('button', { name: 'Channel options' }).click();
  const menu = page.getByRole('menu', { name: 'Channel options' });
  await menu.waitFor({ state: 'visible' });
  await expect(menu.getByRole('menuitem', { name: 'Configure channel' })).toBeVisible();
}

async function showAgentMentionSuggestions(page: Page) {
  const input = page.getByLabel('Agent message');
  await input.click();
  await page.keyboard.type('@');
  const listbox = page.getByRole('listbox', { name: 'Agent mention suggestions' });
  await listbox.waitFor({ state: 'visible' });
  await expect(listbox.locator('.agent-composer-mention-section').first()).toBeVisible();
}

async function showAgentModelMenu(page: Page) {
  await page.getByRole('button', { name: 'Model and reasoning' }).click();
  const menu = page.getByRole('menu', { name: 'Model and reasoning' });
  await menu.waitFor({ state: 'visible' });
  await expect(menu.getByRole('menuitem', { name: /Reasoning/ })).toBeVisible();
}

async function showAgentReasoningMenu(page: Page) {
  await page.getByRole('button', { name: 'Model and reasoning' }).click();
  const parentMenu = page.getByRole('menu', { name: 'Model and reasoning' });
  await parentMenu.waitFor({ state: 'visible' });
  await parentMenu.getByRole('menuitem', { name: /Reasoning/ }).hover();
  const reasoningMenu = page.getByRole('menu', { name: 'Reasoning', exact: true });
  await reasoningMenu.waitFor({ state: 'visible' });
  await expect(reasoningMenu.getByRole('menuitemradio').first()).toBeVisible();
}

async function showRowContextMenu(page: Page) {
  await rowBody(page, ids.alpha).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Node actions' }).waitFor({ state: 'visible' });
  await expect(page.getByRole('menuitem', { name: 'Trash' })).toBeVisible();
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

async function createAttachmentRowPreview(page: Page) {
  const beforeChildren = await todayChildren(page);
  await trailingEditor(page).click();
  await page.keyboard.type('/attachment');
  await expect(page.getByRole('option', { name: /Attachment/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  const attachmentId = (await todayChildren(page)).at(-1);
  if (!attachmentId) throw new Error('Missing attachment node');
  const attachmentRow = row(page, attachmentId);
  await attachmentRow.locator('> .row').first().hover();
  await attachmentRow.locator('.row-chevron-button').first().click();
  await attachmentRow.locator('.file-node-row-preview .file-node-preview.collapsed').waitFor({ state: 'visible' });
}

async function showFilePreviewPillMenu(page: Page) {
  await createAttachmentRowPreview(page);
  await page.locator('.file-node-row-preview .file-preview-pill-more').click();
  await page.getByRole('menu', { name: 'Preview actions' }).waitFor({ state: 'visible' });
}

async function showImageRowActionMenu(page: Page) {
  const beforeChildren = await todayChildren(page);
  await trailingEditor(page).click();
  await page.keyboard.type('/image');
  await expect(page.getByRole('option', { name: /Image/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  const imageId = (await todayChildren(page)).at(-1);
  if (!imageId) throw new Error('Missing image node');
  const imageRow = row(page, imageId);
  await imageRow.locator('.file-node-image-button img').waitFor({ state: 'visible' });
  await imageRow.locator('.file-node-image-actions .file-node-card-menu-trigger').click();
  await page.getByRole('menu', { name: 'File actions' }).waitFor({ state: 'visible' });
  await expect(page.getByRole('menuitem', { name: 'Maximize' })).toBeVisible();
}

async function createImagePreviewPage(page: Page) {
  const beforeChildren = await todayChildren(page);
  await trailingEditor(page).click();
  await page.keyboard.type('/image');
  await expect(page.getByRole('option', { name: /Image/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await todayChildren(page)).length).toBe(beforeChildren.length + 1);
  const imageId = (await todayChildren(page)).at(-1);
  if (!imageId) throw new Error('Missing image node');
  const imageRow = row(page, imageId);
  await imageRow.locator('.file-node-image-button img').waitFor({ state: 'visible' });
  await imageRow.locator('.file-node-image-actions .file-node-card-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Maximize' }).click();
  await page.locator('.outline-panel-surface.active-panel .file-node-body').waitFor({ state: 'visible' });
}

async function showCompletedAgentProcess(page: Page) {
  const assistant = {
    role: 'assistant',
    api: 'responses',
    provider: 'openai',
    model: 'gpt-5.4',
    usage,
    stopReason: 'stop',
    timestamp: 1_800_000_000_100,
    content: [
      {
        type: 'thinking',
        thinking: [
          'Identify relevant outline nodes and tag patterns.',
          'Compare current Agent rules with the existing tag layout decision before answering.',
        ].join('\n'),
      },
      {
        type: 'toolCall',
        id: 'tool-read',
        name: 'node_read',
        arguments: { node_id: 'node-alpha' },
      },
      {
        type: 'text',
        text: 'Current outline focuses on design-system inventory.',
      },
    ],
  };

  await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
    conversationTitle: 'Agent System',
    systemPrompt: '',
    model: { id: 'gpt-5.4', provider: 'openai' },
    thinkingLevel: 'medium',
    messages: [
      assistant,
      {
        role: 'toolResult',
        toolCallId: 'tool-read',
        toolName: 'node_read',
        content: [{ type: 'text', text: 'Alpha node content' }],
        isError: false,
        timestamp: 1_800_000_000_101,
      },
    ],
    conversation: [{
      nodeId: 'assistant-node',
      message: assistant,
      branches: null,
    }],
    streamingMessage: null,
    isStreaming: false,
    pendingToolCallIds: [],
    errorMessage: null,
  });

  const process = page.locator('.agent-process-block').first();
  await process.locator('.agent-process-summary-row').waitFor({ state: 'visible' });
  const reasoningToggle = process.locator('.agent-reasoning-toggle').first();
  if (await reasoningToggle.count() > 0) await reasoningToggle.click();
  const activityToggle = process.locator('.agent-tool-activity-toggle').first();
  if (await activityToggle.count() > 0) await activityToggle.click();
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
    name: 'main app no-provider onboarding',
    path: '/',
    waitFor: '.agent-empty-state',
    options: { noProvider: true },
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
    name: 'settings providers',
    path: '/?surface=settings',
    waitFor: '.settings-window .inset-row',
  },
  {
    name: 'settings security',
    path: '/?surface=settings',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: /^Security/ }).click();
      await page.getByRole('list', { name: 'Default' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'settings memory',
    path: '/?surface=settings',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: /^Memory/ }).click();
      await page.getByRole('list', { name: 'Dream controls' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'settings skills',
    path: '/?surface=settings',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: 'Skills', exact: true }).click();
      await page.locator('.inset-row', { hasText: '/workspace-review' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'settings agent profiles',
    path: '/?surface=settings',
    waitFor: '.settings-window .inset-row',
    beforeProbe: async (page) => {
      await page.getByRole('button', { name: 'Agent Profiles', exact: true }).click();
      await page.getByRole('list', { name: 'Agent profiles' }).waitFor({ state: 'visible' });
    },
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
    name: 'agent config',
    path: '/?surface=agent-config&agent=built-in%3Atenon%3Aassistant',
    waitFor: '.agent-config-window .agent-editor-actions',
  },
  {
    name: 'channel config',
    path: '/?surface=channel-config&conversation=lin-agent-channel-planning&mode=configure',
    waitFor: '.channel-config-window .settings-sheet-actions',
  },
  {
    name: 'command palette overlay',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: async (page) => {
      await page.keyboard.press('Meta+K');
      await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'agent channel picker',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showAgentChannelPicker,
  },
  {
    name: 'agent channel options menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showAgentChannelOptionsMenu,
  },
  {
    name: 'agent mention suggestions',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showAgentMentionSuggestions,
  },
  {
    name: 'agent model menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showAgentModelMenu,
  },
  {
    name: 'agent reasoning menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showAgentReasoningMenu,
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
    name: 'date picker overlay',
    path: '/',
    waitFor: `[data-node-id="${ids.dueEntry}"]`,
    options: { dateField: true },
    beforeInstall: async (page) => {
      await page.clock.setFixedTime(new Date('2026-05-13T09:00:00'));
    },
    beforeProbe: async (page) => {
      const draft = page.locator(`[data-trailing-parent-id="${ids.dueEntry}"] .row-editor`);
      await draft.click();
      await page.keyboard.press('Space');
      await page.getByRole('dialog', { name: 'Date picker' }).waitFor({ state: 'visible' });
    },
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
    name: 'file row preview',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: createAttachmentRowPreview,
  },
  {
    name: 'file preview pill menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showFilePreviewPillMenu,
  },
  {
    name: 'image row action menu',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showImageRowActionMenu,
  },
  {
    name: 'image preview page',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: createImagePreviewPage,
  },
  {
    name: 'agent process details',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: showCompletedAgentProcess,
  },
  {
    name: 'agent debug run details',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: async (page) => {
      await openMockRunDetailsFromAssistantDetailsButton(page);
      await page.locator('.outline-panel-surface.is-agent-debug').waitFor({ state: 'visible' });
    },
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

    const root = document.documentElement;
    return {
      bodyTextLength: document.body.innerText.trim().length,
      bodyHorizontalOverflow: root.scrollWidth - root.clientWidth,
      colorScheme: getComputedStyle(root).colorScheme,
      hasRendererThemeBridge: Boolean(document.querySelector('[data-theme]')),
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
        await installElectronMock(page, surface.options ?? {});
        await page.goto(surface.path);
        await page.locator(surface.waitFor).first().waitFor({ state: 'visible' });
        await surface.beforeProbe?.(page);

        const probe = await probeSurface(page);
        expect(probe.bodyTextLength).toBeGreaterThan(0);
        expect(probe.bodyHorizontalOverflow).toBe(0);
        expect(probe.visibleOutOfViewport).toEqual([]);
        expect(probe.hasRendererThemeBridge).toBe(false);
        expect(probe.colorScheme).toContain(colorScheme);
      });
    }
  }
});
