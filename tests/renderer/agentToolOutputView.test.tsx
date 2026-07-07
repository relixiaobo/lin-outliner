import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AgentToolResultWithPayloads, ToolCall } from '../../src/core/agentTypes';
import type { AgentPayloadRef } from '../../src/core/agentEventLog';
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

  test('renders generated image payloads as inline previews', async () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'tool-output-generate-image-0',
      storage: 'file',
      mimeType: 'image/png',
      byteLength: 68,
      sha256: 'b'.repeat(64),
      role: 'tool_output',
      scope: { type: 'run', conversationId: 'conversation-1', runId: 'run-1' },
      summary: 'Generated puppy image',
      display: { width: 1, height: 1 },
    };
    const result: AgentToolResultWithPayloads = {
      role: 'toolResult',
      toolCallId: 'tool-generate-image',
      toolName: 'generate_image',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: 'Generated puppy image' }],
      payloadRefs: [{ contentIndex: 0, payload, label: 'Generated puppy image' }],
      details: {
        ok: true,
        tool: 'generate_image',
        version: 1,
        status: 'success',
        data: {
          providerId: 'openai',
          modelId: 'gpt-image-2',
          modelName: 'GPT Image 2',
        },
      },
    };

    const opened: PreviewTargetOpenDetail[] = [];
    const rendered = renderComponent(
      <AgentToolCallBlock
        defaultExpanded
        pendingToolCallIds={new Set()}
        result={result}
        conversationId="conversation-1"
        toolCall={{ type: 'toolCall', id: 'tool-generate-image', name: 'generate_image', arguments: { prompt: 'a puppy' } } satisfies ToolCall}
        turnActive={false}
      />,
      (window) => {
        window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, (event) => {
          opened.push((event as CustomEvent<PreviewTargetOpenDetail>).detail);
        });
        Object.assign(window, {
          lin: {
            invoke: async (command: string) => {
              if (command === 'preview_read_bytes') {
                return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, mimeType: 'image/png' };
              }
              throw new Error(`Unexpected command: ${command}`);
            },
          },
        });
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        Object.assign(URL, {
          createObjectURL: () => 'blob:generated-image',
          revokeObjectURL: () => undefined,
        });
        return () => {
          Object.assign(URL, {
            createObjectURL: originalCreateObjectURL,
            revokeObjectURL: originalRevokeObjectURL,
          });
        };
      },
    );
    await act(async () => {
      await flushMicrotasks();
    });

    const image = rendered.container.querySelector('.agent-tool-image-preview img');
    expect(image?.getAttribute('src')).toBe('blob:generated-image');
    expect(image?.getAttribute('alt')).toBe('Generated puppy image');

    const previewButton = rendered.container.querySelector('.agent-tool-image-preview');
    if (!(previewButton instanceof rendered.window.HTMLButtonElement)) throw new Error('Image preview button not found');
    act(() => {
      previewButton.dispatchEvent(new rendered.window.Event('click', { bubbles: true }));
    });
    expect(opened).toEqual([{
      target: {
        kind: 'agent-payload',
        conversationId: 'conversation-1',
        runId: 'run-1',
        payloadId: payload.id,
        label: 'Generated puppy image',
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

  test('keeps isolated skill calls on the standard input and output disclosure path', () => {
    const result: AgentToolResultWithPayloads = {
      role: 'toolResult',
      toolCallId: 'tool-skill-isolated',
      toolName: 'skill',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: 'Isolated skill result.' }],
      details: {
        ok: true,
        tool: 'skill',
        version: 1,
        status: 'success',
        data: {
          success: true,
          skill: 'investigate',
          status: 'isolated',
          result: 'Isolated skill result.',
        },
      },
    };

    const rendered = renderComponent(
      <AgentToolCallBlock
        defaultExpanded
        pendingToolCallIds={new Set()}
        result={result}
        conversationId="conversation-1"
        toolCall={{ type: 'toolCall', id: 'tool-skill-isolated', name: 'skill', arguments: { skill: 'investigate', args: 'regression' } } satisfies ToolCall}
        turnActive={false}
      />,
    );

    const text = rendered.container.textContent ?? '';
    expect(rendered.container.querySelector('.agent-loaded-skill')).toBeNull();
    expect(rendered.container.querySelector('.agent-tool-call-toggle')).not.toBeNull();
    expect(rendered.container.querySelector('.agent-tool-call-panel')).not.toBeNull();
    expect(text).toContain('Input');
    expect(text).toContain('Output');
    expect(text).toContain('Isolated skill result.');
  });

  // F1: a successful file_write must render the produced file as a previewable
  // local-file chip (basename), never the raw model-visible JSON envelope.
  test('renders a successful file_write as a local-file chip, not raw JSON', () => {
    const path = '/home/agent-workdir/reports/report.md';
    const modelVisible = {
      ok: true,
      data: { type: 'create', filePath: path, structuredPatch: [] },
    };
    const result: AgentToolResultWithPayloads = {
      role: 'toolResult',
      toolCallId: 'tool-file-write-1',
      toolName: 'file_write',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(modelVisible, null, 2) }],
    };

    const rendered = renderComponent(
      <AgentToolCallBlock
        defaultExpanded
        pendingToolCallIds={new Set()}
        result={result}
        conversationId="conversation-1"
        toolCall={{ type: 'toolCall', id: 'tool-file-write-1', name: 'file_write', arguments: { file_path: path, content: '# Report' } } satisfies ToolCall}
        turnActive={false}
      />,
    );

    const chip = rendered.container.querySelector('[data-inline-ref-kind="local-file"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-inline-ref-path')).toBe(path);
    expect(chip?.textContent).toContain('report.md');
    // The reported bug: no raw-JSON envelope leaks into the conversation.
    const text = rendered.container.textContent ?? '';
    expect(text).not.toContain('filePath');
    expect(text).not.toContain('structuredPatch');
    expect(text).not.toContain('"ok"');
  });

  // F1: a file_edit keeps its diff inspectable (as a unified diff, not JSON)
  // alongside the file chip.
  test('renders a file_edit as a chip plus an inspectable diff', () => {
    const path = '/home/agent-workdir/notes.md';
    const modelVisible = {
      ok: true,
      data: {
        filePath: path,
        structuredPatch: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-stale heading', '+fresh heading'],
        }],
      },
    };
    const result: AgentToolResultWithPayloads = {
      role: 'toolResult',
      toolCallId: 'tool-file-edit-1',
      toolName: 'file_edit',
      timestamp: 1,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(modelVisible, null, 2) }],
    };

    const rendered = renderComponent(
      <AgentToolCallBlock
        defaultExpanded
        pendingToolCallIds={new Set()}
        result={result}
        conversationId="conversation-1"
        toolCall={{ type: 'toolCall', id: 'tool-file-edit-1', name: 'file_edit', arguments: { file_path: path, old_string: 'stale heading', new_string: 'fresh heading' } } satisfies ToolCall}
        turnActive={false}
      />,
    );

    const chip = rendered.container.querySelector('[data-inline-ref-kind="local-file"]');
    expect(chip?.getAttribute('data-inline-ref-path')).toBe(path);
    expect(chip?.textContent).toContain('notes.md');
    const text = rendered.container.textContent ?? '';
    // The diff content stays inspectable; the raw envelope does not appear.
    expect(text).toContain('stale heading');
    expect(text).toContain('fresh heading');
    expect(text).not.toContain('filePath');
    expect(text).not.toContain('structuredPatch');
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

function renderComponent(element: ReactNode, setupWindow?: (window: Window) => void | (() => void)): RenderedComponent {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const cleanupWindow = setupWindow?.(window);

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });

  const rendered: RenderedComponent = {
    cleanup: () => {
      act(() => root.unmount());
      cleanupWindow?.();
    },
    container,
    window,
  };
  mounted.push(rendered);
  return rendered;
}

async function flushMicrotasks() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
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
