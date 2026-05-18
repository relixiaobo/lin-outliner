import { expect, test, type Locator } from '@playwright/test';
import { emitAgentEvent, openMockedApp } from './outlinerMock';

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

test.describe('agent process disclosure', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await expect.poll(async () => page.evaluate(() => {
      const win = window as Window & {
        __LIN_E2E__?: { calls: Array<{ cmd: string }> };
      };
      return win.__LIN_E2E__?.calls.some((call) => call.cmd === 'agent_restore_latest_session') ?? false;
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

    await emitAgentEvent(page, {
      type: 'snapshot',
      sessionId: 'mock-agent-session',
      state: {
        sessionTitle: 'Agent System',
        systemPrompt: '',
        model: { id: 'gpt-5.4', provider: 'openai' },
        thinkingLevel: 'medium',
        messages: [user],
        conversation: [{ nodeId: 'user-node', message: user, branches: null }],
        streamingMessage: null,
        isStreaming: true,
        pendingToolCallIds: [],
        errorMessage: null,
      },
    });

    const assistantRows = page.locator('.agent-message-row.assistant');
    await expect(assistantRows).toHaveCount(1);
    const row = assistantRows.last();
    const indicator = row.getByLabel('Assistant is responding');
    await expect(indicator).toBeVisible();
    const before = await indicator.boundingBox();
    expect(before).toBeTruthy();

    await emitAgentEvent(page, {
      type: 'snapshot',
      sessionId: 'mock-agent-session',
      state: {
        sessionTitle: 'Agent System',
        systemPrompt: '',
        model: { id: 'gpt-5.4', provider: 'openai' },
        thinkingLevel: 'medium',
        messages: [user],
        conversation: [{ nodeId: 'user-node', message: user, branches: null }],
        streamingMessage: assistant,
        isStreaming: true,
        pendingToolCallIds: [],
        errorMessage: null,
      },
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

    await emitAgentEvent(page, {
      type: 'snapshot',
      sessionId: 'mock-agent-session',
      state: {
        sessionTitle: 'Agent System',
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
      },
    });

    const row = page.locator('.agent-message-row.user').last();
    const bubble = row.locator('.agent-user-bubble');
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

    await emitAgentEvent(page, {
      type: 'snapshot',
      sessionId: 'mock-agent-session',
      state: {
        sessionTitle: 'Agent System',
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
      },
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
});
