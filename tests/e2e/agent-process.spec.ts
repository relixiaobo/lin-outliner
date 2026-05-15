import { expect, test } from '@playwright/test';
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

    const searchTool = page.locator('.agent-tool-call-toggle').filter({ hasText: 'Searched nodes "design system"' });
    await expect(searchTool).toHaveAttribute('aria-expanded', 'false');
    await searchTool.click();
    await expect(searchTool).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.agent-tool-call-section-title').filter({ hasText: 'Input' })).toBeVisible();
    await expect(page.locator('.agent-tool-call-section-title').filter({ hasText: 'Output' })).toBeVisible();
    await expect(page.getByText('"query": "design system"')).toBeVisible();
    await expect(page.getByText('3 matches: Agent System')).toBeVisible();
  });
});
