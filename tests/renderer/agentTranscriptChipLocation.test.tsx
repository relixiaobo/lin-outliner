import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AgentMessageEntry } from '../../src/renderer/agent/runtime';
import { serializeAgentAttachmentMarker } from '../../src/core/agentAttachments';
import { formatChatSourceReferenceMarker, formatFileReferenceMarker } from '../../src/core/referenceMarkup';
import { AgentInlineReferenceText } from '../../src/renderer/ui/agent/AgentInlineReferenceText';
import { AgentMessageRow } from '../../src/renderer/ui/agent/AgentMessageRow';
import { AgentMarkdown } from '../../src/renderer/ui/agent/AgentMarkdown';
import {
  PREVIEW_TARGET_OPEN_EVENT,
  type PreviewTargetOpenDetail,
} from '../../src/renderer/ui/preview/previewEvents';

// The agent-vs-outliner file-chip split is by LOCATION, and that location is decided in
// exactly ONE place: the live transcript message frame carries `data-agent-transcript-chips`
// when its caller asks for reader presentation. Every chip in that live user/assistant
// turn — user attachments, answer prose, interim narration, file_write/file_edit result
// chips — inherits it via the app-wide InlineFilePreviewLayer's `closest()` and opens in
// the workspace file-only reader. The SAME components on meta surfaces (compaction/child-run
// summaries, the child-run-details and PoV-inspector panels) have no such ancestor and keep
// the workspace preview. These guards lock that single source: if a future change re-scatters
// the marker onto AgentMarkdown or a result chip, meta surfaces would leak reader routing again.

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

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

describe('transcript file-chip location marker', () => {
  test('live user message attachments inherit the transcript marker from the row frame', () => {
    const marker = serializeAgentAttachmentMarker([{
      kind: 'file',
      mimeType: 'text/markdown',
      name: 'report.md',
      path: '/workdir/report.md',
      ref: 'report.md',
      sizeBytes: 1234,
    }]);
    if (!marker) throw new Error('Missing attachment marker');
    const rendered = render(
      <AgentMessageRow
        entry={messageEntry({
          id: 'user-with-file',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: marker },
              { type: 'text', text: 'Please read it.' },
            ],
            timestamp: 1,
          },
        })}
        filePreviewPresentation="reader"
        index={0}
        pendingToolCallIds={new Set()}
        toolResults={new Map()}
      />,
    );
    const marked = rendered.document.querySelectorAll('[data-agent-transcript-chips]');
    const chip = rendered.document.querySelector('[data-inline-ref-kind="local-file"]');

    expect(marked).toHaveLength(1);
    expect(marked[0]?.classList.contains('agent-message-row')).toBe(true);
    expect(marked[0]?.classList.contains('user')).toBe(true);
    expect(chip).not.toBeNull();
    expect(marked[0]?.contains(chip)).toBe(true);
  });

  test('live assistant message prose inherits the transcript marker from the row frame', () => {
    const rendered = render(
      <AgentMessageRow
        entry={messageEntry({
          id: 'assistant-with-file',
          message: {
            role: 'assistant',
            api: 'responses',
            provider: 'openai',
            model: 'gpt',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [{ type: 'text', text: `See ${formatFileReferenceMarker('report.md', '/workdir/report.md')}.` }],
            timestamp: 2,
          },
        })}
        filePreviewPresentation="reader"
        index={0}
        pendingToolCallIds={new Set()}
        toolResults={new Map()}
      />,
    );
    const marked = rendered.document.querySelectorAll('[data-agent-transcript-chips]');
    const chip = rendered.document.querySelector('[data-inline-ref-kind="local-file"]');

    expect(marked).toHaveLength(1);
    expect(marked[0]?.classList.contains('agent-message-row')).toBe(true);
    expect(marked[0]?.classList.contains('assistant')).toBe(true);
    expect(chip).not.toBeNull();
    expect(marked[0]?.contains(chip)).toBe(true);
  });

  test('AgentMarkdown never marks itself — meta surfaces (no transcript ancestor) stay in-app', () => {
    // The same markdown renders in both the live transcript and meta panels; it must be
    // neutral so its chips inherit the marker only when a live transcript row ancestor
    // opts into reader mode, never on its own (compaction summary, inspector, child-run details).
    const rendered = render(
      <AgentMarkdown index={0} keyPrefix="probe" text="See [report.md](file:report.md) for details." />,
    );
    expect(rendered.document.querySelectorAll('[data-agent-transcript-chips]')).toHaveLength(0);
    expect(rendered.document.querySelector('.agent-markdown')).not.toBeNull();
  });

  test('AgentMarkdown renders chat-source markers with the shared chat icon and label spans', () => {
    const marker = formatChatSourceReferenceMarker('when the user asked in Chinese', {
      kind: 'chat-source',
      stream: 'conversation',
      streamId: 'general',
      range: { fromSeqExclusive: 1, throughSeq: 2 },
    });
    const rendered = render(
      <AgentMarkdown index={0} keyPrefix="probe" text={`Remember ${marker}.`} />,
    );
    const ref = rendered.document.querySelector('[data-inline-ref-kind="chat-source"]');

    expect(ref).not.toBeNull();
    expect(ref?.querySelector('.inline-ref-chat-icon')).not.toBeNull();
    expect(ref?.querySelector('.inline-ref-chat-label')?.textContent).toBe('when the user asked in Chinese');
  });

  test('AgentMarkdown routes ordinary http links to Tenon split-pane preview events', () => {
    const rendered = render(
      <AgentMarkdown index={0} keyPrefix="probe" text="Read [the docs](https://example.com/docs)." />,
    );
    const opened: PreviewTargetOpenDetail[] = [];
    rendered.window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, (event) => {
      opened.push((event as CustomEvent<PreviewTargetOpenDetail>).detail);
    });
    const link = rendered.document.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]');
    expect(link).not.toBeNull();

    act(() => {
      const event = new rendered.window.Event('click', { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        ctrlKey: { value: false },
        metaKey: { value: false },
      });
      link?.dispatchEvent(event);
    });

    expect(opened).toEqual([{
      newPane: true,
      target: {
        kind: 'url',
        url: 'https://example.com/docs',
        label: 'the docs',
      },
    }]);
  });

  test('AgentInlineReferenceText renders chat-source markers with the shared chat icon and label spans', () => {
    const marker = formatChatSourceReferenceMarker('in the weather chat', {
      kind: 'chat-source',
      stream: 'conversation',
      streamId: 'general',
      range: { fromSeqExclusive: 1, throughSeq: 2 },
    });
    const rendered = render(
      <AgentInlineReferenceText index={0} text={`Remember ${marker}.`} />,
    );
    const ref = rendered.document.querySelector('[data-inline-ref-kind="chat-source"]');

    expect(ref).not.toBeNull();
    expect(ref?.querySelector('.inline-ref-chat-icon')).not.toBeNull();
    expect(ref?.querySelector('.inline-ref-chat-label')?.textContent).toBe('in the weather chat');
  });
});

function messageEntry(overrides: Pick<AgentMessageEntry, 'id' | 'message'>): AgentMessageEntry {
  return {
    branches: null,
    id: overrides.id,
    kind: 'message',
    message: overrides.message,
    nodeId: overrides.id,
    actor: null,
    runDurationMs: null,
    runId: null,
    runStartedAtMs: null,
    streaming: false,
    turnInterrupted: false,
  };
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
