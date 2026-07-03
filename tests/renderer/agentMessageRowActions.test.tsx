import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AssistantMessage, Usage } from '../../src/core/agentTypes';
import type { AgentMessageEntry } from '../../src/renderer/agent/runtime';
import { AgentMessageRow } from '../../src/renderer/ui/agent/AgentMessageRow';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('AgentMessageRow actions', () => {
  test('shows copy and details actions for sealed assistant messages without node ids', () => {
    const rendered = render(
      <AgentMessageRow
        entry={messageEntry({ nodeId: null })}
        index={0}
        isLastInTurn
        onRegenerate={() => {}}
        pendingToolCallIds={new Set()}
        toolResults={new Map()}
      />,
    );

    const actions = rendered.document.querySelector('.agent-message-actions.is-assistant');

    expect(actions).not.toBeNull();
    expect(actions?.querySelector('[aria-label="Copy message"]')).not.toBeNull();
    expect(actions?.querySelector('[aria-label="Details"]')).not.toBeNull();
    expect(actions?.querySelector('[aria-label="Regenerate response"]')).toBeNull();
  });
});

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    api: 'responses',
    provider: 'openai',
    model: 'gpt',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    content: [{ type: 'text', text }],
    timestamp: 2,
  };
}

function messageEntry({ nodeId }: { nodeId: string | null }): AgentMessageEntry {
  return {
    branches: null,
    id: 'assistant-message',
    kind: 'message',
    message: assistantMessage('Background run result.'),
    nodeId,
    actor: null,
    runDurationMs: null,
    runId: null,
    runStartedAtMs: null,
    streaming: false,
    turnInterrupted: false,
  };
}

function render(node: React.ReactNode): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window) {
  (window as unknown as { getComputedStyle: (element: Element) => Pick<CSSStyleDeclaration, 'lineHeight'> })
    .getComputedStyle = () => ({ lineHeight: '26px' });
  Object.assign(globalThis, {
    document: window.document,
    window,
    CustomEvent: window.CustomEvent,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
