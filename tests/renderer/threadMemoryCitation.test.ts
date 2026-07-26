import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import {
  groupTurnContent,
  isThreadProcessItem,
} from '../../src/renderer/agent/components/ThreadView';
import { ThreadItemView } from '../../src/renderer/agent/components/items/ThreadItemView';

describe('Thread Memory citations', () => {
  test('renders citations after the final response instead of inside the process disclosure', () => {
    const commentary = agentMessage('commentary', 'Working', null);
    const response = agentMessage('final_answer', 'Done', null);
    const citation = agentMessage('commentary', '', {
      entries: [{ nodeId: 'node:018f0f24-7b2e-7a3f-8a4b-123456789abc', note: 'Relevant belief' }],
      threadIds: [],
    });
    const turn: Turn = {
      id: '018f0f24-7b2e-7a3f-8a4b-123456789abd',
      items: [commentary, response, citation],
      itemsView: 'full',
      provenance: {
        originThreadId: '018f0f24-7b2e-7a3f-8a4b-123456789abe',
        originTurnId: '018f0f24-7b2e-7a3f-8a4b-123456789abd',
        trigger: { kind: 'user' },
      },
      status: 'completed',
      error: null,
      execution: {
        modelProvider: 'test',
        model: 'test',
        reasoningEffort: 'medium',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
      },
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };

    expect(isThreadProcessItem(commentary)).toBe(true);
    expect(isThreadProcessItem(citation)).toBe(false);
    expect(groupTurnContent(turn).map((block) => (
      block.kind === 'process' ? 'process' : block.item.id
    ))).toEqual(['process', response.id, citation.id]);
  });

  test('renders one neutral collapsed disclosure and reveals links only when expanded', () => {
    const citation = agentMessage('commentary', '', {
      entries: [{ nodeId: 'node:018f0f24-7b2e-7a3f-8a4b-123456789abc', note: 'Relevant belief' }],
      threadIds: ['018f0f24-7b2e-7a3f-8a4b-123456789abe'],
    });
    const renderCitation = (expanded: boolean) => renderToStaticMarkup(createElement(ThreadItemView, {
      agentResponseTail: null,
      canEditUserMessage: false,
      defaultReasoningExpanded: false,
      expandState: {
        isExpanded: () => expanded,
        toggle: () => undefined,
      },
      index: {} as never,
      item: citation,
      showMessageActions: false,
      streaming: false,
      onDisclosureToggle: () => undefined,
      onEditUserMessage: async () => undefined,
      onOpenNodeReference: () => undefined,
      onOpenThread: async () => undefined,
      onReadToolOutput: async () => null,
    }));

    const collapsed = renderCitation(false);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('Used memory');
    expect(collapsed).not.toContain('Relevant belief');
    expect(collapsed).not.toContain('Source Thread 1');

    const expanded = renderCitation(true);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('Relevant belief');
    expect(expanded).toContain('Source Thread 1');
    expect(expanded).not.toContain('style=');
  });
});

function agentMessage(
  phase: 'commentary' | 'final_answer',
  text: string,
  memoryCitation: Extract<ThreadItem, { type: 'agentMessage' }>['memoryCitation'],
): Extract<ThreadItem, { type: 'agentMessage' }> {
  const id = phase === 'final_answer'
    ? '018f0f24-7b2e-7a3f-8a4b-123456789abf'
    : memoryCitation
      ? '018f0f24-7b2e-7a3f-8a4b-123456789ac0'
      : '018f0f24-7b2e-7a3f-8a4b-123456789ac1';
  return {
    type: 'agentMessage',
    id,
    provenance: {
      originThreadId: '018f0f24-7b2e-7a3f-8a4b-123456789abe',
      originTurnId: '018f0f24-7b2e-7a3f-8a4b-123456789abd',
      originItemId: id,
    },
    text,
    phase,
    memoryCitation,
  };
}
