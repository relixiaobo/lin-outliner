import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { PreviewFileSource, PreviewTarget, PreviewUrlSource } from '../../src/core/preview';
import { MoreIcon } from '../../src/renderer/ui/icons';
import type { FilePreviewMenuAction } from '../../src/renderer/ui/preview/FilePreviewPill';
import { FilePreviewShell, usePreviewSource } from '../../src/renderer/ui/preview/previewRenderers';
import {
  PREVIEW_TARGET_OPEN_EVENT,
  type PreviewTargetOpenDetail,
} from '../../src/renderer/ui/preview/previewEvents';

const mounted: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('FilePreviewShell type-specific chrome', () => {
  test('renders images directly with only an ellipsis action menu', () => {
    const rendered = render(
      <FilePreviewShell
        accessibleName="Release cover"
        state={{ status: 'ready', source: imageSource() }}
        onOpenTarget={() => undefined}
        primaryOpen={{ label: 'Open with default app', run: () => undefined }}
        menuActions={[menuAction('reveal')]}
      />,
    );

    expect(rendered.document.querySelector('.file-node-body--image')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--image')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-image img')?.getAttribute('alt')).toBe('Release cover');
    expect(rendered.document.querySelector('.file-preview-pill--image .file-preview-pill-more')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill-primary')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-resize-handle')).toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--image.collapsed')).toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--image.expanded')).toBeNull();
  });

  test('keeps Expand and resize chrome for document previews', () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: htmlSource() }}
        onOpenTarget={() => undefined}
        primaryOpen={{ label: 'Open with default app', run: () => undefined }}
        menuActions={[menuAction('reveal')]}
      />,
      {
        lin: {
          invoke: () => new Promise(() => undefined),
        },
      },
    );

    expect(rendered.document.querySelector('.file-node-preview--html.collapsed')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill-primary')?.textContent).toBe('Expand');
    expect(rendered.document.querySelector('.file-preview-resize-handle')).not.toBeNull();
  });
});

describe('FilePreviewShell media controls', () => {
  test('renders video with one shared transport and video-only fullscreen', () => {
    const rendered = render(
      <FilePreviewShell
        accessibleName="Launch walkthrough"
        state={{ status: 'ready', source: mediaSource('video/mp4') }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('reveal')]}
      />,
    );

    expect(rendered.document.querySelector('.file-preview-video[data-preserve-selection]')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-player--video')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-controls .file-preview-pill--media-control')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-info')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-name')?.textContent).toBe('Launch walkthrough');
    expect(rendered.document.querySelector('.file-preview-media-info[slot="top-chrome"]')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-time')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-duration')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-progress-row')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-timeline')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-command-row')).not.toBeNull();
    expect(rendered.document.querySelectorAll('media-play-button')).toHaveLength(1);
    expect(rendered.document.querySelector('.file-preview-media-center-play')).toBeNull();
    expect(rendered.document.querySelector('media-fullscreen-button.file-preview-media-button')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-body--media')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media-video')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--image')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--footer')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill-primary')).toBeNull();
    const video = rendered.document.querySelector('.file-preview-video');
    expect(video?.hasAttribute('controls')).toBe(false);
    expect(video?.getAttribute('slot')).toBe('media');
    expect(video?.getAttribute('controlsList')).toBe('nodownload noplaybackrate noremoteplayback');
    expect(video?.hasAttribute('disableRemotePlayback')).toBe(true);
    expect(video?.hasAttribute('disablePictureInPicture')).toBe(true);
  });

  test('renders audio with the shared HUD without video-only controls', () => {
    const rendered = render(
      <FilePreviewShell
        accessibleName="Product interview"
        state={{ status: 'ready', source: mediaSource('audio/mpeg') }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('reveal')]}
      />,
    );

    expect(rendered.document.querySelector('.file-preview-audio[data-preserve-selection]')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-player--audio[data-preserve-selection]')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-controls .file-preview-pill--media-control')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-info')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-name')?.textContent).toBe('Product interview');
    expect(rendered.document.querySelector('.file-preview-media-info[slot]')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-time')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-duration')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-progress-row')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-timeline')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-command-row')).not.toBeNull();
    expect(rendered.document.querySelectorAll('media-play-button')).toHaveLength(1);
    expect(rendered.document.querySelector('.file-preview-media-center-play')).toBeNull();
    expect(rendered.document.querySelector('media-fullscreen-button')).toBeNull();
    expect(rendered.document.querySelector('.file-node-body--media')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-body--media-audio')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media-audio')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--image')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--footer')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill-primary')).toBeNull();
    const audio = rendered.document.querySelector('.file-preview-audio');
    expect(audio?.hasAttribute('controls')).toBe(false);
    expect(audio?.getAttribute('slot')).toBe('media');
    expect(audio?.getAttribute('controlsList')).toBe('nodownload noplaybackrate noremoteplayback');
    expect((audio as HTMLMediaElement | null)?.disableRemotePlayback).toBe(true);
  });

  test('delegates media shortcuts to the keyboard-enabled Media Chrome controller', async () => {
    const source = await Bun.file(new URL(
      '../../src/renderer/ui/preview/previewRenderers.tsx',
      import.meta.url,
    )).text();
    const mediaSection = source.slice(
      source.indexOf('function useMediaSourceUrl'),
      source.indexOf('function HtmlPreview'),
    );

    expect(mediaSection).toContain('keyboardControl');
    expect(mediaSection).not.toContain('useMediaKeyboardShortcuts');
    expect(mediaSection).not.toContain("addEventListener('keydown'");
  });
});

describe('FilePreviewShell URL previews', () => {
  test('renders URL previews as a direct webpage surface without file controls', () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: urlSource() }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('open')]}
      />,
    );

    const webview = rendered.document.querySelector('.file-preview-url-webview');
    expect(webview).not.toBeNull();
    expect(webview?.getAttribute('partition')).toBe('persist:url-preview');
    expect(webview?.getAttribute('src')).toBe('https://example.com/docs');
    expect(webview?.getAttribute('title')).toBe('Example docs');
    expect(rendered.document.querySelector('.file-node-body--url')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--url.expanded')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-message')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-resize-handle')).toBeNull();
  });

  test('renders YouTube as a bounded click-to-play player', () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: youtubeSource() }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('open')]}
      />,
    );

    const webview = rendered.document.querySelector('.file-preview-youtube-webview');
    expect(webview?.getAttribute('src'))
      .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=0&playsinline=1');
    expect(rendered.document.querySelector('.file-preview-youtube')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-body--youtube')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--youtube')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--url')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-resize-handle')).toBeNull();
  });

  test('marks HTML previews so reader panes can fill the available height', async () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: htmlSource() }}
        onOpenTarget={() => undefined}
        readerMode
      />,
      {
        lin: {
          invoke: (command) => {
            if (command === 'preview_read_text') return Promise.resolve({ text: '<main>Hello</main>' });
            return Promise.resolve(null);
          },
        },
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(rendered.document.querySelector('.file-node-body--reader.file-node-body--html')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--reader.file-node-preview--html')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-html--render')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-html-frame')).not.toBeNull();
  });

  test('routes HTML iframe links through preview targets across iframe realms', async () => {
    const opened: PreviewTargetOpenDetail[] = [];
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: htmlSource() }}
        onOpenTarget={() => undefined}
        readerMode
      />,
      {
        lin: {
          invoke: (command) => {
            if (command === 'preview_read_text') {
              return Promise.resolve({ text: '<a href="https://example.com/from-html">Open docs</a>' });
            }
            return Promise.resolve(null);
          },
        },
      },
    );
    rendered.window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, (event) => {
      opened.push((event as CustomEvent<PreviewTargetOpenDetail>).detail);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const iframe = rendered.document.querySelector<HTMLIFrameElement>('.file-preview-html-frame');
    if (!iframe) throw new Error('Missing HTML preview frame');
    const frame = parseHTML('<!doctype html><html><body><a href="https://example.com/from-html">Open docs</a></body></html>');
    const anchor = frame.document.querySelector('a');
    if (!anchor) throw new Error('Missing frame anchor');
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: frame.document });

    const originalElement = globalThis.Element;
    class ParentRealmElement {}
    await act(async () => {
      try {
        Object.defineProperty(globalThis, 'Element', { configurable: true, value: ParentRealmElement });
        expect(anchor instanceof globalThis.Element).toBe(false);
        iframe.dispatchEvent(new rendered.window.Event('load', { bubbles: true }));
        anchor.dispatchEvent(new frame.window.Event('click', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      } finally {
        Object.defineProperty(globalThis, 'Element', { configurable: true, value: originalElement });
      }
    });

    expect(opened).toEqual([{
      newPane: true,
      target: {
        kind: 'url',
        label: 'Open docs',
        url: 'https://example.com/from-html',
      },
    }]);
  });

  test('marks PDF and EPUB readers so document viewports can fill the pane', async () => {
    const previewBytesMock = {
      lin: {
        invoke: (command: string) => {
          if (command === 'preview_read_bytes') return Promise.resolve({ bytes: null, error: 'missing' });
          return Promise.resolve(null);
        },
      },
    };
    const pdf = render(
      <FilePreviewShell
        state={{ status: 'loading' }}
        onOpenTarget={() => undefined}
        readerMode
      />,
    );

    expect(pdf.document.querySelector('.file-node-body--reader')).not.toBeNull();

    const pdfReady = render(
      <FilePreviewShell
        state={{ status: 'ready', source: pdfSource() }}
        onOpenTarget={() => undefined}
        readerMode
      />,
      previewBytesMock,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(pdfReady.document.querySelector('.file-node-body--reader.file-node-body--pdf')).not.toBeNull();
    expect(pdfReady.document.querySelector('.file-node-preview--reader.file-node-preview--pdf')).not.toBeNull();

    const epubReady = render(
      <FilePreviewShell
        state={{ status: 'ready', source: epubSource() }}
        onOpenTarget={() => undefined}
        readerMode
      />,
      previewBytesMock,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(epubReady.document.querySelector('.file-node-body--reader.file-node-body--epub')).not.toBeNull();
    expect(epubReady.document.querySelector('.file-node-preview--reader.file-node-preview--epub')).not.toBeNull();
  });

  test('resolves URL targets synchronously without preview IPC loading', async () => {
    const invocations: string[] = [];
    const rendered = render(
      <PreviewSourceProbe target={{ kind: 'url', url: 'https://example.com/docs', label: 'Example docs' }} />,
      {
        lin: {
          invoke: (command) => {
            invocations.push(command);
            return Promise.resolve({ source: null });
          },
        },
      },
    );

    const output = rendered.document.querySelector('output');
    expect(output?.getAttribute('data-status')).toBe('ready');
    expect(output?.getAttribute('data-kind')).toBe('url');
    expect(output?.getAttribute('data-url')).toBe('https://example.com/docs');

    await act(async () => {
      await Promise.resolve();
    });

    expect(invocations).toEqual([]);
    expect(rendered.document.querySelector('output')?.getAttribute('data-status')).toBe('ready');
  });

  test('keeps a ready preview mounted when an equivalent target object is rendered', async () => {
    const invocations: string[] = [];
    const rendered = render(
      <EquivalentTargetProbe />,
      {
        lin: {
          invoke: (command) => {
            invocations.push(command);
            return Promise.resolve({ source: imageSource() });
          },
        },
      },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.document.querySelector('output')?.getAttribute('data-status')).toBe('ready');
    expect(invocations).toHaveLength(1);

    const rerender = rendered.document.querySelector('button');
    if (!(rerender instanceof rendered.window.HTMLElement)) throw new Error('Missing rerender control');
    await act(async () => {
      rerender.click();
      await Promise.resolve();
    });

    expect(rendered.document.querySelector('output')?.getAttribute('data-status')).toBe('ready');
    expect(invocations).toHaveLength(1);
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

function imageSource(): PreviewFileSource {
  return {
    kind: 'file',
    sourceKind: 'asset',
    id: 'asset:image',
    target: { kind: 'asset', assetId: 'asset-image' },
    name: 'cover.png',
    ext: 'png',
    mimeType: 'image/png',
    entryKind: 'file',
    sizeBytes: 1024,
    streamUrl: 'asset://image',
  };
}

function urlSource(): PreviewUrlSource {
  return {
    kind: 'url',
    id: 'url:https://example.com/docs',
    target: { kind: 'url', url: 'https://example.com/docs', label: 'Example docs' },
    title: 'Example docs',
    url: 'https://example.com/docs',
  };
}

function youtubeSource(): PreviewUrlSource {
  return {
    kind: 'url',
    id: 'url:youtube',
    target: { kind: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&autoplay=1' },
    title: 'YouTube video',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&autoplay=1',
  };
}

function htmlSource(): PreviewFileSource {
  return {
    kind: 'file',
    sourceKind: 'asset',
    id: 'asset:page',
    target: { kind: 'asset', assetId: 'asset-page' },
    name: 'page.html',
    ext: 'html',
    mimeType: 'text/html',
    entryKind: 'file',
    sizeBytes: 1024,
  };
}

function pdfSource(): PreviewFileSource {
  return {
    kind: 'file',
    sourceKind: 'asset',
    id: 'asset:pdf',
    target: { kind: 'asset', assetId: 'asset-pdf' },
    name: 'document.pdf',
    ext: 'pdf',
    mimeType: 'application/pdf',
    entryKind: 'file',
    sizeBytes: 1024,
  };
}

function epubSource(): PreviewFileSource {
  return {
    kind: 'file',
    sourceKind: 'asset',
    id: 'asset:book',
    target: { kind: 'asset', assetId: 'asset-book' },
    name: 'book.epub',
    ext: 'epub',
    mimeType: 'application/epub+zip',
    entryKind: 'file',
    sizeBytes: 1024,
  };
}

function PreviewSourceProbe({ target }: { target: PreviewTarget }) {
  const state = usePreviewSource(target);
  return (
    <output
      data-kind={state.status === 'ready' ? state.source.kind : ''}
      data-status={state.status}
      data-url={state.status === 'ready' && state.source.kind === 'url' ? state.source.url : ''}
    >
      {state.status}
    </output>
  );
}

function EquivalentTargetProbe() {
  const [, setRevision] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setRevision((current) => current + 1)}>Rerender</button>
      <PreviewSourceProbe target={{ kind: 'asset', assetId: 'asset-image', label: 'Cover' }} />
    </>
  );
}

function menuAction(key: string): FilePreviewMenuAction {
  return {
    key,
    label: key,
    icon: MoreIcon,
    run: () => undefined,
  };
}

function render(
  node: React.ReactNode,
  options: {
    lin?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
  } = {},
): { document: Document; window: Window } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  if (options.lin) (window as unknown as { lin: typeof options.lin }).lin = options.lin;
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ cleanup: () => act(() => root.unmount()) });
  return { document, window };
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    CustomEvent: window.CustomEvent,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
