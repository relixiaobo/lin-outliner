import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { InlineFilePreviewLayer } from '../../src/renderer/ui/editor/InlineFilePreviewLayer';
import {
  PREVIEW_TARGET_OPEN_EVENT,
  type PreviewTargetOpenDetail,
} from '../../src/renderer/ui/preview/previewEvents';
import { getMessages } from '../../src/core/i18n';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

interface LinStub {
  openLocalFile?: (options: { path: string }) => Promise<unknown>;
}

const labels = getMessages('en').agent.filePreview;
const mounted: Rendered[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('InlineFilePreviewLayer routing', () => {
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

  test('non-transcript file chips open the inline file menu on right-click', async () => {
    const rendered = render({});
    const chip = localFileChip(rendered.document);
    rendered.document.body.appendChild(chip);

    await contextMenu(rendered, chip);

    expect(menuLabels(rendered)).toEqual([
      labels.previewInTenon,
      labels.addToToday,
      labels.openWithDefaultApp,
      labels.showInFinder,
    ]);
  });

  test('non-transcript menu preview action keeps the standard preview-pane route', async () => {
    const rendered = render({});
    const workspacePreviews: PreviewTargetOpenDetail[] = [];
    rendered.window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, (event) => {
      workspacePreviews.push((event as CustomEvent<PreviewTargetOpenDetail>).detail);
    });
    const chip = localFileChip(rendered.document);
    rendered.document.body.appendChild(chip);

    await contextMenu(rendered, chip);
    await clickMenuItem(rendered, labels.previewInTenon);

    expect(workspacePreviews).toEqual([{
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

async function contextMenu(rendered: Rendered, target: Element | null) {
  if (!target) throw new Error('Missing file chip');
  await act(async () => {
    const event = new rendered.window.Event('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: 24 },
      clientY: { value: 28 },
    });
    target.dispatchEvent(event);
  });
}

async function clickMenuItem(rendered: Rendered, label: string) {
  const item = Array.from(rendered.document.body.querySelectorAll('.node-context-item'))
    .find((node) => node.textContent === label);
  if (!item) throw new Error(`Missing menu item: ${label}`);
  await act(async () => {
    item.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
}

function menuLabels(rendered: Rendered): string[] {
  return Array.from(rendered.document.body.querySelectorAll('.node-context-item'))
    .map((item) => item.textContent ?? '');
}

function installDomGlobals(window: Window) {
  (window as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame = (cb) => { cb(0); return 0; };
  (window as unknown as { cancelAnimationFrame: (handle: number) => void })
    .cancelAnimationFrame = () => { /* synchronous frame: nothing to cancel */ };
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
