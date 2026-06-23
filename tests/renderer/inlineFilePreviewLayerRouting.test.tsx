import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { PreviewTarget } from '../../src/core/preview';
import { InlineFilePreviewLayer } from '../../src/renderer/ui/editor/InlineFilePreviewLayer';
import {
  AGENT_DOCK_FILE_PREVIEW_EVENT,
  type AgentDockFilePreviewDetail,
} from '../../src/renderer/ui/agent/agentDockFilePreviewEvents';
import {
  PREVIEW_TARGET_OPEN_EVENT,
  type PreviewTargetOpenDetail,
} from '../../src/renderer/ui/preview/previewEvents';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

interface LinStub {
  openLocalFile?: (options: { path: string }) => Promise<unknown>;
}

const mounted: Rendered[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('InlineFilePreviewLayer routing', () => {
  test('live transcript file chips open the agent dock reader instead of the OS default app', async () => {
    const openedExternal: Array<{ path: string }> = [];
    const rendered = render({
      openLocalFile: (options) => {
        openedExternal.push(options);
        return Promise.resolve();
      },
    });
    const dockPreviews: PreviewTarget[] = [];
    rendered.window.addEventListener(AGENT_DOCK_FILE_PREVIEW_EVENT, (event) => {
      dockPreviews.push((event as CustomEvent<AgentDockFilePreviewDetail>).detail.target);
    });
    const transcriptRoot = rendered.document.createElement('div');
    transcriptRoot.setAttribute('data-agent-transcript-chips', 'true');
    transcriptRoot.appendChild(localFileChip(rendered.document));
    rendered.document.body.appendChild(transcriptRoot);

    await click(rendered, transcriptRoot.querySelector('[data-inline-ref-kind="local-file"]'));

    expect(openedExternal).toEqual([]);
    expect(dockPreviews).toEqual([{
      kind: 'local-file',
      path: '/workdir/report.md',
      entryKind: 'file',
      label: 'report.md',
    }]);
  });

  test('non-transcript file chips keep the workspace preview route', async () => {
    const rendered = render({});
    const workspacePreviews: PreviewTargetOpenDetail[] = [];
    rendered.window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, (event) => {
      workspacePreviews.push((event as CustomEvent<PreviewTargetOpenDetail>).detail);
    });
    const chip = localFileChip(rendered.document);
    rendered.document.body.appendChild(chip);

    await click(rendered, chip);

    expect(workspacePreviews).toEqual([{
      newPane: false,
      target: {
        kind: 'local-file',
        path: '/workdir/report.md',
        entryKind: 'file',
        label: 'report.md',
      },
    }]);
  });
});

function render(lin: LinStub): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  (window as unknown as { lin: LinStub }).lin = lin;
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(<InlineFilePreviewLayer />);
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window };
  mounted.push(rendered);
  return rendered;
}

function localFileChip(document: Document): HTMLElement {
  const chip = document.createElement('button');
  chip.setAttribute('data-inline-ref-kind', 'local-file');
  chip.setAttribute('data-inline-ref-entry-kind', 'file');
  chip.setAttribute('data-inline-ref-name', 'report.md');
  chip.setAttribute('data-inline-ref-path', '/workdir/report.md');
  chip.textContent = 'report.md';
  return chip;
}

async function click(rendered: Rendered, target: Element | null) {
  if (!target) throw new Error('Missing file chip');
  await act(async () => {
    const event = new rendered.window.Event('click', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      ctrlKey: { value: false },
      metaKey: { value: false },
    });
    target.dispatchEvent(event);
  });
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    CustomEvent: window.CustomEvent,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
