import { expect, test, type Locator } from '@playwright/test';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
import {
  clipboardText,
  commandCalls,
  e2eChatSourceInlineRef,
  e2eProjection,
  emitAgentProjection,
  emitDocumentEvent,
  ids,
  openMockedApp,
  rowEditor,
} from './outlinerMock';

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

async function expectIconCenteredOnFirstLine(row: Locator, iconSelector: string, textSelector: string) {
  const icon = row.locator(iconSelector).first();
  const text = row.locator(textSelector).first();
  await expect(icon).toBeVisible();
  await expect(text).toBeVisible();

  const [iconBox, textMetrics] = await Promise.all([
    icon.boundingBox(),
    text.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        lineHeight: Number.parseFloat(style.lineHeight),
        top: element.getBoundingClientRect().top,
      };
    }),
  ]);

  expect(iconBox).toBeTruthy();
  expect(Math.abs((iconBox!.y + iconBox!.height / 2) - (textMetrics.top + textMetrics.lineHeight / 2))).toBeLessThan(1);
}

async function expectSingleDisclosureSlot(row: Locator, iconSelector: string, textSelector: string) {
  const [iconBox, textBox] = await Promise.all([
    row.locator(iconSelector).first().boundingBox(),
    row.locator(textSelector).first().boundingBox(),
  ]);

  expect(iconBox).toBeTruthy();
  expect(textBox).toBeTruthy();
  expect(iconBox!.width).toBeLessThanOrEqual(15);
  expect(textBox!.x - iconBox!.x).toBeGreaterThanOrEqual(18);
  expect(textBox!.x - iconBox!.x).toBeLessThanOrEqual(22);
}

async function expectSummaryStableOnHover(row: Locator, textSelector: string) {
  const summary = row.locator(textSelector).first();
  const before = await summary.boundingBox();
  expect(before).toBeTruthy();

  await row.hover();
  const after = await summary.boundingBox();
  expect(after).toBeTruthy();
  expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);
}

async function loadedSkillMetrics(row: Locator) {
  return row.evaluate((element) => {
    const args = element.querySelector('.agent-loaded-skill-args');
    const icon = element.querySelector('.agent-loaded-skill-icon');
    const rect = element.getBoundingClientRect();
    return {
      argsColor: args ? getComputedStyle(args).color : '',
      color: getComputedStyle(element).color,
      height: rect.height,
      iconColor: icon ? getComputedStyle(icon).color : '',
      overflowX: element.scrollWidth - element.clientWidth,
      width: rect.width,
    };
  });
}

test.describe('agent process disclosure', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await expect.poll(async () => page.evaluate(() => {
      const win = window as Window & {
        __LIN_E2E__?: { calls: Array<{ cmd: string }> };
      };
      return win.__LIN_E2E__?.calls.some((call) => (
        call.cmd === 'agent_restore_conversation' || call.cmd === 'agent_restore_latest_conversation'
      )) ?? false;
    })).toBe(true);
  });

  test('keeps the active assistant indicator at the end of the current assistant turn', async ({ page }) => {
    const user = {
      role: 'user',
      content: [{ type: 'text', text: '你好' }],
      timestamp: 1_800_000_000_200,
    };
    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_000_201,
      content: [{ type: 'text', text: '你好，我在。' }],
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [user],
      conversation: [{ nodeId: 'user-node', message: user, branches: null }],
      streamingMessage: null,
      isStreaming: true,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const assistantRows = page.locator('.agent-message-row.assistant');
    await expect(assistantRows).toHaveCount(1);
    const row = assistantRows.last();
    const liveProcess = row.locator('.agent-process-block').first();
    const liveProcessToggle = liveProcess.locator('.agent-process-toggle').first();
    await expect(liveProcess.locator('.agent-process-title').first()).toHaveText('Working');
    await expect(liveProcessToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(liveProcessToggle).not.toBeDisabled();
    const indicator = row.getByLabel('Assistant is responding');
    await expect(indicator).toBeVisible();
    const before = await indicator.boundingBox();
    expect(before).toBeTruthy();

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [user],
      conversation: [{ nodeId: 'user-node', message: user, branches: null }],
      streamingMessage: assistant,
      isStreaming: true,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    await expect(assistantRows).toHaveCount(1);
    const streamedText = row.getByText('你好，我在。');
    await expect(liveProcess.locator('.agent-process-title').first()).toHaveText('Working');
    await expect(liveProcessToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(streamedText).toBeVisible();
    const textBox = await streamedText.boundingBox();
    const after = await indicator.boundingBox();
    expect(textBox).toBeTruthy();
    expect(after).toBeTruthy();
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);
    expect(after!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height - 1);
  });

  test('keeps user message actions below the message bubble', async ({ page }) => {
    const user = {
      role: 'user',
      content: [{ type: 'text', text: '移除这些标签，我觉得不需要打标签' }],
      timestamp: 1_800_000_000_300,
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [user],
      conversation: [{
        nodeId: 'user-node',
        message: user,
        branches: { ids: ['branch-1', 'branch-2'], currentIndex: 1 },
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const row = page.locator('.agent-message-row.user').last();
    const bubble = row.locator('.agent-user-content-shell');
    const actions = row.locator('.agent-message-actions');
    await row.hover();
    await expect(actions).toHaveCSS('opacity', '1');

    const bubbleBox = await bubble.boundingBox();
    const actionsBox = await actions.boundingBox();
    expect(bubbleBox).toBeTruthy();
    expect(actionsBox).toBeTruthy();
    expect(actionsBox!.y).toBeGreaterThanOrEqual(bubbleBox!.y + bubbleBox!.height - 1);
    expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);
  });

  test('collapses long user message content and expands on demand', async ({ page }) => {
    const marker = {
      version: 1,
      instructions: 'Files and folders are available at local paths.',
      attachments: [{
        kind: 'file',
        ref: 'long-context-file',
        name: 'long-context.md',
        mimeType: 'text/markdown',
        sizeBytes: 4096,
        path: '/Users/test/Documents/long-context.md',
        readPath: '/Users/test/Documents/long-context.md',
      }],
    };
    const longText = [
      'Line 1: summarize this outline.',
      'Line 2: include all open tasks.',
      'Line 3: compare priorities.',
      'Line 4: note blockers.',
      'Line 5: call out stale work.',
      'Line 6: keep the answer concise.',
      'Line 7: preserve links.',
      'Line 8: include follow-up actions.',
      'Line 9 final: this must still copy.',
    ].join('\n');
    const user = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-reminder>\n<user-attachments>\n${JSON.stringify(marker, null, 2)}\n</user-attachments>\n</system-reminder>`,
        },
        { type: 'text', text: longText },
      ],
      timestamp: 1_800_000_000_350,
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [user],
      conversation: [{
        nodeId: 'long-user-node',
        message: user,
        branches: null,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const row = page.locator('.agent-message-row.user').last();
    const shell = row.locator('.agent-user-content-shell');
    const body = row.locator('.agent-user-content-body');
    const expand = row.getByRole('button', { name: 'Show more' });
    await expect(row.locator('.agent-user-file-chip')).toContainText('long-context.md');
    await expect(expand).toBeVisible();
    await expect(body).toHaveClass(/is-collapsed/u);

    const collapsedHeight = await body.evaluate((element) => element.getBoundingClientRect().height);
    expect(collapsedHeight).toBeLessThanOrEqual((26 * 5) + 18);
    await expect(row.locator('.agent-user-collapse-ellipsis')).toHaveCount(0);
    const shellBox = await shell.boundingBox();
    const expandBox = await expand.boundingBox();
    expect(shellBox).toBeTruthy();
    expect(expandBox).toBeTruthy();
    expect(expandBox!.y + expandBox!.height).toBeLessThanOrEqual(shellBox!.y + shellBox!.height + 1);
    expect(expandBox!.x).toBeGreaterThanOrEqual(shellBox!.x - 1);
    expect(expandBox!.x).toBeLessThanOrEqual(shellBox!.x + 16);
    await expand.hover();
    await expect(expand).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    await expand.click();
    await expect(row.getByRole('button', { name: 'Show less' })).toBeVisible();
    await expect(body).not.toHaveClass(/is-collapsed/u);
    const expandedHeight = await body.evaluate((element) => element.getBoundingClientRect().height);
    expect(expandedHeight).toBeGreaterThan(collapsedHeight + 40);

    await row.hover();
    await row.getByRole('button', { name: 'Copy message' }).click();
    await expect.poll(() => clipboardText(page)).toContain('Line 9 final: this must still copy.');
  });

  test('previews and opens assistant local file refs', async ({ page }) => {
    await page.evaluate(() => {
      const thumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPvsZAAAAABJRU5ErkJggg==';
      const win = window as typeof window & {
        __openedLocalFiles?: string[];
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          openLocalFile?: (options: { path: string }) => Promise<{ opened: boolean }>;
          previewLocalFileReference?: (options: { path: string }) => Promise<{
            file: {
              entryKind: 'file' | 'directory';
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              thumbnailDataUrl?: string;
            } | null;
          }>;
        };
      };
      win.__openedLocalFiles = [];
      if (!win.lin) return;
      win.lin.previewLocalFileReference = async (options) => ({
        file: options.path === '/Users/test/Pictures/diagram.png'
          ? {
              entryKind: 'file',
              path: options.path,
              name: 'diagram.png',
              parentPath: '/Users/test/Pictures',
              mimeType: 'image/png',
              sizeBytes: 4096,
              lastModified: 1_800_000_000_000,
              thumbnailDataUrl: thumbnail,
            }
          : null,
      });
      win.lin.openLocalFile = async (options) => {
        win.__openedLocalFiles?.push(options.path);
        return { opened: true };
      };
    });

    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_000_801,
      content: [{
        type: 'text',
        text: 'See [[file:diagram.png^%2FUsers%2Ftest%2FPictures%2Fdiagram.png]] for the layout.',
      }],
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [],
      conversation: [{ nodeId: 'assistant-file-ref-node', message: assistant, branches: null }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const ref = page.locator('.agent-message-row.assistant [data-inline-ref-kind="local-file"]').first();
    await expect(ref).toHaveText('diagram.png');
    await expect(ref.locator('.inline-ref-file-icon')).toHaveAttribute('data-file-icon-kind', 'image');
    await ref.hover();

    const preview = page.locator('[data-inline-file-preview]');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('diagram.png');
    await expect(preview).toContainText('/Users/test/Pictures/diagram.png');
    await expect(preview.locator('.inline-file-preview-image img')).toBeVisible();

    await ref.click();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __openedLocalFiles?: string[] }).__openedLocalFiles ?? []
    ))).toContain('/Users/test/Pictures/diagram.png');

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('lin:preview-target-open', {
        detail: {
          target: {
            kind: 'local-file',
            path: '/Users/test/Pictures/diagram.png',
            entryKind: 'file',
            label: 'diagram.png',
          },
        },
      }));
    });
    const panel = page.locator('.outline-panel-surface.active-panel.is-file-preview');
    await expect(panel.locator('.panel-title-file-heading')).toContainText('diagram.png');
    await expect(panel.locator('.panel-breadcrumb')).toContainText('Users');
    await expect(panel.locator('.file-preview-content')).toContainText('Mock preview text.');
    await expect(panel.locator('.file-preview-content > .outliner')).toHaveCount(0);

    // Add to outline: copy the previewed non-node file into the outline as a node,
    // then bind the same mounted file surface to that node in place. The pane stays
    // a file-preview surface; only its breadcrumb source and children outline change.
    await panel.getByRole('button', { name: 'Preview actions' }).click();
    await page.getByRole('menuitem', { name: 'Add to outline' }).click();
    await expect(panel).toHaveClass(/is-file-preview/);
    await expect(panel.locator('.panel-title-file-heading')).toContainText('diagram.png');
    const todayLabel = await page.evaluate(() => {
      const today = new Date();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      return `${today.getFullYear()}-${month}-${day}`;
    });
    await expect(panel.locator('.panel-breadcrumb')).toContainText(todayLabel);
    await expect(panel.locator('.file-preview-content > .outliner')).toBeVisible();
    await panel.getByRole('button', { name: 'Preview actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Add to outline' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'ingest_local_file')).toBe(true);
    expect(calls.some((call) => call.cmd === 'create_image_node')).toBe(true);
  });

  test('keeps completed process collapsed and expands thinking and tool details on demand', async ({ page }) => {
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
          arguments: { nodeId: 'node-alpha' },
        },
        {
          type: 'toolCall',
          id: 'tool-search',
          name: 'node_search',
          arguments: { query: 'design system', limit: 10 },
        },
        {
          type: 'text',
          text: 'Current outline focuses on design-system inventory, components, and implementation phases.',
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
        {
          role: 'toolResult',
          toolCallId: 'tool-search',
          toolName: 'node_search',
          content: [{ type: 'text', text: '3 matches: Agent System, Tag Layout Pattern, Component Contracts' }],
          isError: false,
          timestamp: 1_800_000_000_102,
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
    const processToggle = process.locator('.agent-process-toggle').first();
    await expect(process.locator('.agent-process-title').first()).toHaveText('Thought · read a node · searched');
    await expect(processToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Current outline focuses on design-system inventory')).toBeVisible();

    await processToggle.click();
    await expect(processToggle).toHaveAttribute('aria-expanded', 'true');

    const processGroupToggle = process.locator('.agent-process-flat .agent-process-toggle').first();
    await expect(processGroupToggle).toHaveAttribute('aria-expanded', 'false');
    await processGroupToggle.click();
    await expect(processGroupToggle).toHaveAttribute('aria-expanded', 'true');

    const thinkingToggle = page.locator('.agent-thinking-row.is-toggle').first();
    await expect(thinkingToggle).toContainText('Identify relevant outline nodes and tag patterns.');
    await expect(thinkingToggle).not.toContainText('Compare current Agent rules');

    await thinkingToggle.click();
    await expect(thinkingToggle).toContainText('Compare current Agent rules with the existing tag layout decision');
    await expectIconCenteredOnFirstLine(thinkingToggle, '.agent-thinking-icon', '.agent-thinking-text');

    const activityToggle = process.locator('.agent-tool-activity-toggle').filter({ hasText: 'Read a node · searched' });
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'false');
    await activityToggle.click();
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');

    const searchTool = page.locator('.agent-tool-call-toggle').filter({ hasText: 'Searched nodes "design system"' });
    await expect(searchTool).toHaveAttribute('aria-expanded', 'false');
    await expectIconCenteredOnFirstLine(searchTool, '.agent-tool-call-icon-slot', '.agent-tool-call-summary');
    await expectSingleDisclosureSlot(searchTool, '.agent-tool-call-icon-slot', '.agent-tool-call-summary');
    await expectSummaryStableOnHover(searchTool, '.agent-tool-call-summary');
    await searchTool.click();
    await expect(searchTool).toHaveAttribute('aria-expanded', 'true');
    await expectSingleDisclosureSlot(searchTool, '.agent-tool-call-icon-slot', '.agent-tool-call-summary');
    await expect(page.locator('.agent-tool-call-section-title').filter({ hasText: 'Input' })).toBeVisible();
    await expect(page.locator('.agent-tool-call-section-title').filter({ hasText: 'Output' })).toBeVisible();
    await expect(page.getByText('"query": "design system"')).toBeVisible();
    await expect(page.getByText('3 matches: Agent System')).toBeVisible();
  });

  test('collapses a sealed turn to a "Worked for {duration}" header when run timing is known', async ({ page }) => {
    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_001_000,
      content: [
        { type: 'thinking', thinking: 'Plan the outline edits.' },
        { type: 'toolCall', id: 'tool-read-dur', name: 'node_read', arguments: { nodeId: 'node-alpha' } },
        { type: 'text', text: 'Done — the outline is updated.' },
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
          toolCallId: 'tool-read-dur',
          toolName: 'node_read',
          content: [{ type: 'text', text: 'Alpha node content' }],
          isError: false,
          timestamp: 1_800_000_001_001,
        },
      ],
      conversation: [{
        nodeId: 'assistant-node-dur',
        message: assistant,
        branches: null,
        // The producing run took 63s of wall-clock (threaded as runDurationMs).
        runDurationMs: 63_000,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const process = page.locator('.agent-process-block').first();
    await expect(process.locator('.agent-process-title').first()).toHaveText('Worked for 1m 3s');
    await expect(process.locator('.agent-process-toggle').first()).toHaveAttribute('aria-expanded', 'false');
    // The final answer renders as prose OUTSIDE the fold.
    await expect(page.getByText('Done — the outline is updated.')).toBeVisible();
  });

  test('updates a collapsed live process header in place when the turn settles', async ({ page }) => {
    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_001_050,
      content: [
        { type: 'thinking', thinking: 'Checking the selected outline node.' },
        { type: 'toolCall', id: 'tool-read-live-collapsed', name: 'node_read', arguments: { nodeId: 'node-alpha' } },
        { type: 'text', text: 'The answer stays outside the process fold.' },
      ],
    };
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'tool-read-live-collapsed',
      toolName: 'node_read',
      content: [{ type: 'text', text: 'Alpha node content' }],
      isError: false,
      timestamp: 1_800_000_001_051,
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [toolResult],
      conversation: [],
      streamingMessage: assistant,
      isStreaming: true,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const process = page.locator('.agent-process-block').first();
    const processToggle = process.locator('.agent-process-toggle').first();
    const beforeBox = await processToggle.boundingBox();
    expect(beforeBox).toBeTruthy();
    await expect(processToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(process.locator('.agent-process-title').first()).toHaveText('Working');

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [toolResult],
      conversation: [{
        nodeId: 'assistant-node-live-collapsed-settled',
        message: assistant,
        branches: null,
        runDurationMs: 9_000,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    }, 2);

    await expect(processToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(process.locator('.agent-process-title').first()).toHaveText('Worked for 9s');
    const afterBox = await processToggle.boundingBox();
    expect(afterBox).toBeTruthy();
    expect(Math.abs(afterBox!.y - beforeBox!.y)).toBeLessThan(1);
    await expect(page.getByText('The answer stays outside the process fold.')).toBeVisible();
  });

  test('keeps live DM process collapsed by default and preserves user expansion after settle', async ({ page }) => {
    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_001_100,
      content: [
        { type: 'thinking', thinking: 'Read the source node before answering.' },
        { type: 'toolCall', id: 'tool-read-live', name: 'node_read', arguments: { nodeId: 'node-alpha' } },
        { type: 'text', text: 'The final answer is now streaming below the process.' },
      ],
    };
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'tool-read-live',
      toolName: 'node_read',
      content: [{ type: 'text', text: 'Alpha node content' }],
      isError: false,
      timestamp: 1_800_000_001_101,
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [toolResult],
      conversation: [],
      streamingMessage: assistant,
      isStreaming: true,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const process = page.locator('.agent-process-block').first();
    const processToggle = process.locator('.agent-process-toggle').first();
    await expect(processToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(processToggle).not.toBeDisabled();
    await expect(process.locator('.agent-process-title').first()).toHaveText('Working');
    await expect(process.locator('.agent-process-flat .agent-process-title')).toHaveCount(0);
    await expect(page.getByText('The final answer is now streaming below the process.')).toBeVisible();

    await processToggle.click();
    await expect(processToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(process.locator('.agent-process-flat .agent-process-title').first()).toHaveText('Working');

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [toolResult],
      conversation: [{
        nodeId: 'assistant-node-live-settled',
        message: assistant,
        branches: null,
        runDurationMs: 63_000,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    }, 2);

    await expect(process.locator('.agent-process-title').first()).toHaveText('Worked for 1m 3s');
    await expect(process.locator('.agent-process-toggle').first()).toHaveAttribute('aria-expanded', 'true');
    await expect(process.locator('.agent-process-toggle').first()).not.toBeDisabled();
    await expect(page.getByText('The final answer is now streaming below the process.')).toBeVisible();
  });

  test('keeps tool-free streaming prose outside the temporary Working fold', async ({ page }) => {
    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_001_300,
      content: [{ type: 'text', text: 'A direct answer is streaming without tools.' }],
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [],
      conversation: [],
      streamingMessage: assistant,
      isStreaming: true,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    await expect(page.locator('.agent-process-title').first()).toHaveText('Working');
    await expect(page.locator('.agent-process-flat-narration')).toHaveCount(0);
    await expect(page.getByText('A direct answer is streaming without tools.')).toBeVisible();

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [],
      conversation: [{
        nodeId: 'assistant-node-direct-settled',
        message: assistant,
        branches: null,
        runDurationMs: 3_000,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    }, 2);

    await expect(page.locator('.agent-process-block')).toHaveCount(0);
    await expect(page.getByText('A direct answer is streaming without tools.')).toBeVisible();
  });

  test('auto-expands a sealed turn that ended on a tool, surfacing its interim text instead of hiding it', async ({ page }) => {
    // Regression: a turn whose last visible block is a tool/thought has NO trailing
    // answer prose. Its interim text must NOT silently fold behind a collapsed
    // "Worked for" header — keying the result on ANY text would do exactly that.
    // With no result the process auto-expands so the interim narration stays read.
    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_002_000,
      content: [
        { type: 'text', text: 'Let me read the alpha node before answering.' },
        { type: 'toolCall', id: 'tool-read-nofinal', name: 'node_read', arguments: { nodeId: 'node-alpha' } },
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
          toolCallId: 'tool-read-nofinal',
          toolName: 'node_read',
          content: [{ type: 'text', text: 'Alpha node content' }],
          isError: false,
          timestamp: 1_800_000_002_001,
        },
      ],
      conversation: [{
        nodeId: 'assistant-node-nofinal',
        message: assistant,
        branches: null,
        runDurationMs: 5_000,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const process = page.locator('.agent-process-block').first();
    // Resultless sealed turn → auto-expanded (not collapsed to "Worked for …").
    await expect(process.locator('.agent-process-toggle').first()).toHaveAttribute('aria-expanded', 'true');
    await expect(process.locator('.agent-process-title').first()).not.toHaveText(/Worked for/);
    // The interim text is visible inside the fold, not hidden.
    await expect(page.getByText('Let me read the alpha node before answering.')).toBeVisible();
  });

  test('renders loaded skill calls as a compact light and dark affordance while isolated skills stay expandable', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const loadedAssistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'toolUse',
      timestamp: 1_800_000_001_100,
      content: [{
        type: 'toolCall',
        id: 'tool-skill-loaded-e2e',
        name: 'skill',
        arguments: { skill: 'review-pr', args: '214 --focus rendering' },
      }],
    };
    const isolatedAssistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'toolUse',
      timestamp: 1_800_000_001_200,
      content: [{
        type: 'toolCall',
        id: 'tool-skill-isolated-e2e',
        name: 'skill',
        arguments: { skill: 'investigate', args: 'render regression' },
      }],
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [
        loadedAssistant,
        {
          role: 'toolResult',
          toolCallId: 'tool-skill-loaded-e2e',
          toolName: 'skill',
          content: [{ type: 'text', text: 'Launching skill: review-pr' }],
          isError: false,
          timestamp: 1_800_000_001_101,
        },
        isolatedAssistant,
        {
          role: 'toolResult',
          toolCallId: 'tool-skill-isolated-e2e',
          toolName: 'skill',
          content: [{ type: 'text', text: 'Isolated skill result.' }],
          isError: false,
          timestamp: 1_800_000_001_201,
        },
      ],
      conversation: [{
        nodeId: 'assistant-node-loaded-skill',
        message: loadedAssistant,
        branches: null,
      }, {
        nodeId: 'assistant-node-isolated-skill',
        message: isolatedAssistant,
        branches: null,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const process = page.locator('.agent-process-block').first();
    const processGroupToggle = process.locator('.agent-process-flat .agent-process-toggle').first();
    await expect(process.locator('.agent-process-toggle').first()).toHaveAttribute('aria-expanded', 'true');
    await expect(processGroupToggle).toHaveAttribute('aria-expanded', 'true');
    const activityToggle = process.locator('.agent-tool-activity-toggle').filter({ hasText: 'Used 2 skills' });
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'false');
    await activityToggle.click();
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');

    const loadedCall = page.locator('.agent-tool-call').filter({ has: page.locator('.agent-loaded-skill') });
    const loaded = loadedCall.locator('.agent-loaded-skill');
    await expect(loaded).toBeVisible();
    await expect(loaded.locator('.agent-loaded-skill-name')).toHaveText('/review-pr');
    await expect(loaded.locator('.agent-loaded-skill-args')).toHaveText('214 --focus rendering');
    await expect(loadedCall.locator('.agent-tool-call-toggle')).toHaveCount(0);
    await expect(loadedCall.locator('.agent-tool-call-panel')).toHaveCount(0);
    await expect(loadedCall).not.toContainText('Launching skill: review-pr');

    const light = await loadedSkillMetrics(loaded);
    expect(light.overflowX).toBeLessThanOrEqual(1);
    expect(light.width).toBeGreaterThan(100);
    expect(light.height).toBeGreaterThan(10);
    expect(light.argsColor).toBe(light.iconColor);
    expect(light.argsColor).not.toBe(light.color);

    const isolatedToggle = page.locator('.agent-tool-call-toggle').filter({ hasText: 'skill' });
    await expect(isolatedToggle).toHaveCount(1);
    await isolatedToggle.click();
    await expect(page.locator('.agent-tool-call-section-title').filter({ hasText: 'Input' })).toBeVisible();
    await expect(page.locator('.agent-tool-call-section-title').filter({ hasText: 'Output' })).toBeVisible();
    await expect(page.getByText('Isolated skill result.')).toBeVisible();

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => (await loadedSkillMetrics(loaded)).color).not.toBe(light.color);
    const dark = await loadedSkillMetrics(loaded);
    expect(dark.overflowX).toBeLessThanOrEqual(1);
    expect(dark.width).toBeGreaterThan(100);
    expect(dark.height).toBe(light.height);
    expect(dark.argsColor).toBe(dark.iconColor);
    expect(dark.argsColor).not.toBe(dark.color);
  });

  test('virtualizes long transcripts and keeps scroll navigation working', async ({ page }) => {
    const conversation = Array.from({ length: 120 }, (_, index) => {
      const isUser = index % 2 === 0;
      const message = isUser
        ? {
            role: 'user',
            content: [{ type: 'text', text: `User message ${index}` }],
            timestamp: 1_800_000_001_000 + index,
          }
        : {
            role: 'assistant',
            api: 'responses',
            provider: 'openai',
            model: 'gpt-5.4',
            usage,
            stopReason: 'stop',
            timestamp: 1_800_000_001_000 + index,
            content: [{ type: 'text', text: `Assistant response ${index}` }],
          };
      return {
        nodeId: `message-${index}`,
        message,
        branches: null,
      };
    });

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Long Agent Conversation',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [],
      conversation,
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    await expect(page.locator('.agent-chat-transcript')).toHaveAttribute('data-virtualized', 'true');
    await expect(page.getByText('Assistant response 119')).toBeVisible();
    await expect.poll(() => page.locator('.agent-message-row').count()).toBeLessThan(80);

    await page.locator('.agent-chat-scroll').evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    await expect(page.getByText('User message 0')).toBeVisible();
    await expect.poll(() => page.locator('.agent-message-row').count()).toBeLessThan(80);
  });

  test('opens and highlights a transcript row from a chat-source inline reference', async ({ page }) => {
    const sourceMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'This is the cited transcript source.' }],
      timestamp: 1_800_000_001_500,
    };
    const mergedTailMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'This is the same rendered assistant row.' }],
      timestamp: 1_800_000_001_600,
    };

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'General',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [],
      conversation: [{
        nodeId: 'source-message-e2e',
        sourceSeq: 5,
        message: sourceMessage,
        branches: null,
      }, {
        nodeId: 'source-message-e2e-tail',
        sourceSeq: 6,
        message: mergedTailMessage,
        branches: null,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    await page.getByTitle('Collapse agent').click();
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'collapsed');

    const content = {
      text: 'Open ',
      marks: [],
      inlineRefs: [e2eChatSourceInlineRef(5, {
        kind: 'chat-source',
        stream: 'conversation',
        streamId: DEFAULT_GENERAL_CHANNEL_ID,
        range: { fromSeqExclusive: 4, throughSeq: 5, throughEventId: 'event-5' },
      }, 'source')],
    };
    await page.evaluate(async ({ content, nodeId }) => {
      const win = window as Window & {
        lin?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      };
      await win.lin?.invoke('apply_node_text_patch', {
        nodeId,
        patch: { ops: [{ type: 'replace_all', content }] },
      });
    }, { content, nodeId: ids.alpha });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    await rowEditor(page, ids.alpha).locator('[data-inline-ref-kind="chat-source"]').click();

    const sourceRow = page.locator('[data-agent-message-id="source-message-e2e-tail"]');
    const sourceShell = sourceRow.locator('xpath=ancestor::*[@data-agent-transcript-row]');
    await expect(sourceShell).toContainText('This is the cited transcript source.');
    await expect(sourceShell).toHaveClass(/is-highlighted/);
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'open');
  });

  test('opens a tool-derived child run panel from a run chat-source inline reference', async ({ page }) => {
    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'General',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [],
      conversation: [{
        nodeId: 'assistant-with-child-run',
        sourceSeq: 5,
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            id: 'tool-agent-source-e2e',
            name: 'Agent',
            arguments: {
              description: 'Inspect jump source run',
              prompt: 'Inspect jump source run.',
            },
          }],
          timestamp: 1_800_000_001_500,
          stopReason: 'toolUse',
        },
        branches: null,
      }],
      childRuns: [{
        id: 'child-run-source-e2e',
        description: 'Inspect jump source run',
        prompt: 'Inspect jump source run.',
        agentType: 'explorer',
        contextMode: 'fork',
        status: 'running',
        startedAt: 1_800_000_001_600,
        updatedAt: 1_800_000_001_700,
        parentToolCallId: 'tool-agent-source-e2e',
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    await expect(page.locator('.agent-child-run-boundary')).toHaveCount(0);
    await page.getByTitle('Collapse agent').click();
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'collapsed');

    const content = {
      text: 'Open ',
      marks: [],
      inlineRefs: [e2eChatSourceInlineRef(5, {
        kind: 'chat-source',
        stream: 'run',
        streamId: 'child-run-source-e2e',
        range: { fromSeqExclusive: 0, throughSeq: 1, throughEventId: 'run-event-1' },
      }, 'run source')],
    };
    await page.evaluate(async ({ content, nodeId }) => {
      const win = window as Window & {
        lin?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      };
      await win.lin?.invoke('apply_node_text_patch', {
        nodeId,
        patch: { ops: [{ type: 'replace_all', content }] },
      });
    }, { content, nodeId: ids.alpha });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    await rowEditor(page, ids.alpha).locator('[data-inline-ref-kind="chat-source"]').click();

    const childRunPanel = page.locator('.agent-child-run-details-panel');
    await expect(childRunPanel).toContainText('Inspect jump source run');
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'open');
  });

  test('copies full persisted tool output from payload refs', async ({ page }) => {
    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_002_000,
      content: [
        {
          type: 'toolCall',
          id: 'tool-read-large',
          name: 'file_read',
          arguments: { path: 'large.log' },
        },
        {
          type: 'text',
          text: 'I read the large log file.',
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
          toolCallId: 'tool-read-large',
          toolName: 'file_read',
          content: [{
            type: 'payload_ref',
            payload: {
              kind: 'payload_ref',
              id: 'payload-full-output',
              storage: 'file',
              mimeType: 'text/plain',
              byteLength: 38,
              sha256: 'payload-sha',
              role: 'tool_output',
              scope: { type: 'run', conversationId: DEFAULT_GENERAL_CHANNEL_ID, runId: 'run-payload-output' },
              summary: 'large.log output',
              truncated: true,
            },
            label: '<persisted-output>\nPreview only\n</persisted-output>',
          }],
          isError: false,
          timestamp: 1_800_000_002_001,
        },
      ],
      conversation: [{
        nodeId: 'assistant-node-large-copy',
        message: assistant,
        branches: null,
      }],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const row = page.locator('.agent-message-row.assistant').last();
    await row.hover();
    await row.getByLabel('Copy message').click();

    await expect.poll(() => clipboardText(page)).toContain('Full persisted tool output from payload');
    expect(await clipboardText(page)).not.toContain('Preview only');

    // The lone tool call now folds into the result-first process block; open the
    // turn fold, then the adjacent tool group, then the tool row inside it.
    await row.locator('.agent-process-toggle').first().click();
    await row.locator('.agent-process-flat .agent-process-toggle').first().click();
    await row.locator('.agent-tool-call-toggle').click();
    await row.getByRole('button', { name: 'Preview output' }).click();
    const panel = page.locator('.outline-panel-surface.active-panel.is-file-preview');
    await expect(panel.locator('.panel-title-file-heading')).toContainText('large.log output');
    await expect(panel.locator('.file-preview-content')).toContainText('Full persisted tool output from payload');
  });
});
