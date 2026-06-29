import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { PreviewFileSource } from '../../src/core/preview';
import { MoreIcon } from '../../src/renderer/ui/icons';
import type { FilePreviewMenuAction } from '../../src/renderer/ui/preview/FilePreviewPill';
import { FilePreviewShell } from '../../src/renderer/ui/preview/previewRenderers';

const mounted: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('FilePreviewShell media controls', () => {
  test('renders media action menu below the player so native scrub controls stay interactive', () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: mediaSource('video/mp4') }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('reveal')]}
      />,
    );

    expect(rendered.document.querySelector('.file-preview-video[data-preserve-selection]')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--footer')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill-primary')).toBeNull();
  });
});

function mediaSource(mimeType: string): PreviewFileSource {
  return {
    kind: 'file',
    sourceKind: 'asset',
    id: 'asset:clip',
    target: { kind: 'asset', assetId: 'asset-clip' },
    name: 'clip.mp4',
    ext: 'mp4',
    mimeType,
    entryKind: 'file',
    sizeBytes: 1024,
    streamUrl: 'asset://clip',
  };
}

function menuAction(key: string): FilePreviewMenuAction {
  return {
    key,
    label: key,
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
