import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AgentToolResultWithPayloads, ToolCall } from '../../src/core/agentTypes';
import { AgentToolCallBlock } from '../../src/renderer/ui/agent/AgentToolCallBlock';

interface RenderedComponent {
  cleanup: () => void;
  container: HTMLElement;
  window: Window;
}

const mounted: RenderedComponent[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('agent tool output view', () => {
  // The Output region must render the model-visible content (what the model
  // actually received), not the full envelope on `details`. This pins the
  // "what you see is what the model got" behavior after PR #17 slimmed the
  // model view: fields kept only on `details` must not leak into the UI.
  test('renders the model-visible content and not the fuller details envelope', () => {
    const modelVisible = {
      ok: true,
      tool: 'web_search',
      status: 'success',
      data: {
        results: [{ title: 'Weather', url: 'https://w.example/w', snippet: 'sunny-snippet' }],
        truncated: true,
        totalResults: 14,
      },
    };
    const result: AgentToolResultWithPayloads = {
      role: 'toolResult',
      toolCallId: 'tool-ws-1',
      toolName: 'web_search',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(modelVisible, null, 2) }],
      // The full envelope carries fields the model never sees; none should render.
      details: {
        ok: true,
        tool: 'web_search',
        version: 1,
        status: 'success',
        data: {
          query: 'SENTINEL_QUERY',
          provider: 'SENTINEL_PROVIDER',
          durationMs: 424242,
          results: [{ title: 'Weather', url: 'https://w.example/w', snippet: 'sunny-snippet', source: 'SENTINEL_SOURCE' }],
          truncated: true,
          totalResults: 14,
        },
        metrics: { durationMs: 424242 },
      },
    };

    const rendered = renderComponent(
      <AgentToolCallBlock
        defaultExpanded
        pendingToolCallIds={new Set()}
        result={result}
        sessionId="session-1"
        toolCall={{ type: 'toolCall', id: 'tool-ws-1', name: 'web_search', arguments: { query: 'chengdu weather' } } satisfies ToolCall}
        turnActive={false}
      />,
    );

    const text = rendered.container.textContent ?? '';
    // Model-visible fields are shown.
    expect(text).toContain('sunny-snippet');
    expect(text).toContain('totalResults');
    expect(text).toContain('14');
    // Details-only fields (echoed args, provider metadata, telemetry, result source) are not.
    expect(text).not.toContain('SENTINEL_QUERY');
    expect(text).not.toContain('SENTINEL_PROVIDER');
    expect(text).not.toContain('SENTINEL_SOURCE');
    expect(text).not.toContain('424242');
  });
});

function renderComponent(element: ReactNode): RenderedComponent {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });

  const rendered: RenderedComponent = {
    cleanup: () => {
      act(() => root.unmount());
    },
    container,
    window,
  };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: window.navigator,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => undefined },
  });
}
