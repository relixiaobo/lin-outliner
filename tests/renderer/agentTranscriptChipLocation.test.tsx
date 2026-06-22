import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { formatChatSourceReferenceMarker } from '../../src/core/referenceMarkup';
import { AgentInlineReferenceText } from '../../src/renderer/ui/agent/AgentInlineReferenceText';
import { AgentAssistantContent } from '../../src/renderer/ui/agent/AgentMessageFrame';
import { AgentMarkdown } from '../../src/renderer/ui/agent/AgentMarkdown';

// The agent-vs-outliner file-chip split is by LOCATION, and that location is decided in
// exactly ONE place: the live assistant message body (AgentAssistantContent) carries
// `data-agent-transcript-chips`, so every chip a live turn renders — answer prose,
// interim narration, file_write/file_edit result chips — inherits it via the app-wide
// InlineFilePreviewLayer's `closest()` and opens with the OS default app. The SAME
// components on meta surfaces (compaction/child-run summaries, the child-run-details and
// PoV-inspector panels) have no such ancestor and keep the in-app preview. These guards
// lock that single source: if a future change re-scatters the marker onto AgentMarkdown
// or a result chip, meta surfaces would leak external-open again (the round-2 regression).

interface Rendered {
  cleanup: () => void;
  document: Document;
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
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document };
  mounted.push(rendered);
  return rendered;
}

describe('transcript file-chip location marker', () => {
  test('the live assistant message body is the single source of the transcript marker', () => {
    const rendered = render(
      <AgentAssistantContent>
        <span className="probe-child">chip</span>
      </AgentAssistantContent>,
    );
    const marked = rendered.document.querySelectorAll('[data-agent-transcript-chips]');
    // Exactly one marker, and it wraps the message content so any chip inside inherits it.
    expect(marked).toHaveLength(1);
    expect(marked[0]?.classList.contains('agent-assistant-content')).toBe(true);
    expect(marked[0]?.querySelector('.probe-child')).not.toBeNull();
  });

  test('AgentMarkdown never marks itself — meta surfaces (no transcript ancestor) stay in-app', () => {
    // The same markdown renders in both the live transcript and meta panels; it must be
    // neutral so its chips inherit the marker only when an AgentAssistantContent ancestor
    // is present (live), never on its own (compaction summary, inspector, child-run details).
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

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
