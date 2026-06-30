import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { getMessages } from '../../src/core/i18n';
import { MoreIcon } from '../../src/renderer/ui/icons';
import { FilePreviewPill, type FilePreviewMenuAction } from '../../src/renderer/ui/preview/FilePreviewPill';

const labels = getMessages('en').shell.filePreview;
const mounted: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('FilePreviewPill', () => {
  test('direct-play media previews omit Expand/Collapse and keep the action menu', () => {
    const rendered = render(
      <FilePreviewPill
        expanded={false}
        menuActions={[menuAction('reveal', labels.reveal)]}
        onToggleExpand={() => undefined}
        previewable
        primaryMode="none"
      />,
    );

    expect(rendered.document.querySelector('.file-preview-pill-primary')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill-more')).not.toBeNull();
  });

  test('document previews keep the Expand primary', () => {
    const rendered = render(
      <FilePreviewPill
        expanded={false}
        menuActions={[menuAction('reveal', labels.reveal)]}
        onToggleExpand={() => undefined}
        previewable
      />,
    );

    const primary = rendered.document.querySelector('.file-preview-pill-primary');
    expect(primary?.textContent).toBe(labels.expand);
    expect(rendered.document.querySelector('.file-preview-pill-more')).not.toBeNull();
  });
});

function menuAction(key: string, label: string): FilePreviewMenuAction {
  return {
    key,
    label,
    icon: MoreIcon,
    run: () => undefined,
  };
}

function render(node: React.ReactNode): { document: Document } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ cleanup: () => act(() => root.unmount()) });
  return { document };
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
