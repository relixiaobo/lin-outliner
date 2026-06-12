import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AgentToolResultWithPayloads, ToolCall } from '../../src/core/agentTypes';
import { AgentToolCallBlock } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { PREVIEW_TARGET_OPEN_EVENT, type PreviewTargetOpenDetail } from '../../src/renderer/ui/preview/previewEvents';

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
        conversationId="conversation-1"
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

  test('opens persisted tool output previews with the payload run scope', () => {
    const result: AgentToolResultWithPayloads = {
      role: 'toolResult',
      toolCallId: 'tool-run-scoped-output',
      toolName: 'file_read',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: '<persisted-output>\nPreview only\n</persisted-output>' }],
      payloadRefs: [{
        contentIndex: 0,
        payload: {
          kind: 'payload_ref',
          id: 'payload-run-scoped-output',
          storage: 'file',
          mimeType: 'text/plain',
          byteLength: 38,
          sha256: 'a'.repeat(64),
          role: 'tool_output',
          scope: { type: 'run', conversationId: 'conversation-1', runId: 'run-1' },
          summary: 'large.log output',
          truncated: true,
        },
      }],
    };

    const rendered = renderComponent(
      <AgentToolCallBlock
        defaultExpanded
        pendingToolCallIds={new Set()}
        result={result}
        conversationId="conversation-1"
        toolCall={{ type: 'toolCall', id: 'tool-run-scoped-output', name: 'file_read', arguments: { path: 'large.log' } } satisfies ToolCall}
        turnActive={false}
      />,
    );
    const opened: PreviewTargetOpenDetail[] = [];
    rendered.window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, (event) => {
      opened.push((event as CustomEvent<PreviewTargetOpenDetail>).detail);
    });

    const previewButton = textButton(rendered, 'Preview output');
    act(() => {
      previewButton.dispatchEvent(new rendered.window.Event('click', { bubbles: true }));
    });

    expect(opened).toEqual([{
      target: {
        kind: 'agent-payload',
        conversationId: 'conversation-1',
        runId: 'run-1',
        payloadId: 'payload-run-scoped-output',
        label: 'large.log output',
      },
    }]);
  });

  test('renders loaded skill calls as a compact affordance without input or output panels', () => {
    const result: AgentToolResultWithPayloads = {
      role: 'toolResult',
      toolCallId: 'tool-skill-loaded',
      toolName: 'skill',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: 'Launching skill: review-pr' }],
      details: {
        ok: true,
        tool: 'skill',
        version: 1,
        status: 'success',
        data: {
          success: true,
          skill: 'review-pr',
          status: 'loaded',
        },
      },
    };

    const rendered = renderComponent(
      <AgentToolCallBlock
        defaultExpanded
        pendingToolCallIds={new Set()}
        result={result}
        conversationId="conversation-1"
        toolCall={{ type: 'toolCall', id: 'tool-skill-loaded', name: 'skill', arguments: { skill: 'review-pr', args: '123 --diff' } } satisfies ToolCall}
        turnActive={false}
      />,
    );

    const text = rendered.container.textContent ?? '';
    expect(rendered.container.querySelector('.agent-loaded-skill')).not.toBeNull();
    expect(rendered.container.querySelector('.agent-tool-call-toggle')).toBeNull();
    expect(rendered.container.querySelector('.agent-tool-call-panel')).toBeNull();
    expect(text).toContain('/review-pr');
    expect(text).toContain('123 --diff');
    expect(text).not.toContain('Input');
    expect(text).not.toContain('Output');
    expect(text).not.toContain('Launching skill: review-pr');
    // Truncated name/args stay inspectable via a hover tooltip.
    expect(rendered.container.querySelector('.agent-loaded-skill-name')?.getAttribute('title')).toBe('/review-pr');
    expect(rendered.container.querySelector('.agent-loaded-skill-args')?.getAttribute('title')).toBe('123 --diff');
  });

  test('keeps forked skill calls on the standard input and output disclosure path', () => {
    const result: AgentToolResultWithPayloads = {
      role: 'toolResult',
      toolCallId: 'tool-skill-forked',
      toolName: 'skill',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: 'Forked skill result.' }],
      details: {
        ok: true,
        tool: 'skill',
        version: 1,
        status: 'success',
        data: {
          success: true,
          skill: 'investigate',
          status: 'forked',
          result: 'Forked skill result.',
        },
      },
    };

    const rendered = renderComponent(
      <AgentToolCallBlock
        defaultExpanded
        pendingToolCallIds={new Set()}
        result={result}
        conversationId="conversation-1"
        toolCall={{ type: 'toolCall', id: 'tool-skill-forked', name: 'skill', arguments: { skill: 'investigate', args: 'regression' } } satisfies ToolCall}
        turnActive={false}
      />,
    );

    const text = rendered.container.textContent ?? '';
    expect(rendered.container.querySelector('.agent-loaded-skill')).toBeNull();
    expect(rendered.container.querySelector('.agent-tool-call-toggle')).not.toBeNull();
    expect(rendered.container.querySelector('.agent-tool-call-panel')).not.toBeNull();
    expect(text).toContain('Input');
    expect(text).toContain('Output');
    expect(text).toContain('Forked skill result.');
  });
});

function textButton(rendered: RenderedComponent, text: string): HTMLButtonElement {
  const button = Array.from(rendered.container.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').includes(text));
  if (!(button instanceof rendered.window.HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

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
    CustomEvent: window.CustomEvent,
    HTMLButtonElement: window.HTMLButtonElement,
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
