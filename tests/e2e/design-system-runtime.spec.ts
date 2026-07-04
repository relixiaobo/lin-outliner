import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
import {
  e2eProjection,
  emitAgentProjection,
  installElectronMock,
  ids,
  openMockRunDetailsFromAssistantDetailsButton,
  row,
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
    name: 'file row preview',
    path: '/',
    waitFor: `[data-node-id="${ids.alpha}"]`,
    beforeProbe: createAttachmentRowPreview,
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
