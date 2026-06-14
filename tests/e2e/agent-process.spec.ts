import { expect, test, type Locator } from '@playwright/test';
import { clipboardText, commandCalls, emitAgentProjection, openMockedApp } from './outlinerMock';

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
      return win.__LIN_E2E__?.calls.some((call) => call.cmd === 'agent_restore_latest_conversation') ?? false;
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
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
    const indicator = row.getByLabel('Assistant is responding');
    await expect(indicator).toBeVisible();
    const before = await indicator.boundingBox();
    expect(before).toBeTruthy();

    await emitAgentProjection(page, 'mock-agent-conversation', {
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
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
    const panel = page.locator('.outline-panel-surface.active-panel.is-file-preview');
    await expect(panel.locator('.file-preview-heading')).toContainText('diagram.png');
    await expect(panel.locator('.file-preview-content')).toContainText('Mock preview text.');

    // Add to outline: copy the previewed non-node file into the outline as a node and
    // navigate the pane to its node page (the same body, now backed by a real node).
    await panel.getByRole('button', { name: 'Add to outline' }).click();
    const nodePage = page.locator('.outline-panel-surface.active-panel');
    await expect(nodePage.locator('.file-node-body')).toBeVisible();
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
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
    const processToggle = process.locator('.agent-process-toggle');
    await expect(process.locator('.agent-process-title')).toHaveText('Thought · used 2 tools');
    await expect(processToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Current outline focuses on design-system inventory')).toBeVisible();

    await processToggle.click();
    await expect(processToggle).toHaveAttribute('aria-expanded', 'true');

    const thinkingToggle = page.locator('.agent-thinking-row.is-toggle').first();
    await expect(thinkingToggle).toContainText('Identify relevant outline nodes and tag patterns.');
    await expect(thinkingToggle).not.toContainText('Compare current Agent rules');

    await thinkingToggle.click();
    await expect(thinkingToggle).toContainText('Compare current Agent rules with the existing tag layout decision');
    await expectIconCenteredOnFirstLine(thinkingToggle, '.agent-thinking-icon', '.agent-thinking-text');

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

    await emitAgentProjection(page, 'mock-agent-conversation', {
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
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
              scope: { type: 'run', conversationId: 'mock-agent-conversation', runId: 'run-payload-output' },
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

    await row.locator('.agent-tool-call-toggle').click();
    await row.getByRole('button', { name: 'Preview output' }).click();
    const panel = page.locator('.outline-panel-surface.active-panel.is-file-preview');
    await expect(panel.locator('.file-preview-heading')).toContainText('large.log output');
    await expect(panel.locator('.file-preview-content')).toContainText('Full persisted tool output from payload');
  });
});
