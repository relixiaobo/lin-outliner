import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { PreviewFileSource, PreviewTarget, PreviewUrlSource } from '../../src/core/preview';
import { MoreIcon } from '../../src/renderer/ui/icons';
import type { FilePreviewMenuAction } from '../../src/renderer/ui/preview/FilePreviewPill';
import { FilePreviewShell, usePreviewSource } from '../../src/renderer/ui/preview/previewRenderers';

const mounted: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('FilePreviewShell media controls', () => {
  test('renders video controls in a flat media stage with same-layer actions', () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: mediaSource('video/mp4') }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('reveal')]}
      />,
    );

    expect(rendered.document.querySelector('.file-preview-video[data-preserve-selection]')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-player--video')).not.toBeNull();
    expect(rendered.document.querySelector('media-control-bar .file-preview-pill--media-control')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-body--media')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media-video')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--media')).toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media > .file-preview-pill--media')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--footer')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill-primary')).toBeNull();
    const video = rendered.document.querySelector('.file-preview-video');
    expect(video?.hasAttribute('controls')).toBe(false);
    expect(video?.getAttribute('slot')).toBe('media');
    expect(video?.getAttribute('controlsList')).toBe('nodownload noplaybackrate noremoteplayback');
    expect(video?.hasAttribute('disableRemotePlayback')).toBe(true);
    expect(video?.hasAttribute('disablePictureInPicture')).toBe(true);
  });

  test('renders audio controls with the same flat media stage', () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: mediaSource('audio/mpeg') }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('reveal')]}
      />,
    );

    expect(rendered.document.querySelector('.file-preview-audio[data-preserve-selection]')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-media-player--audio[data-preserve-selection]')).not.toBeNull();
    expect(rendered.document.querySelector('media-control-bar .file-preview-pill--media-control')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-body--media')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-body--media-audio')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media-audio')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--media')).toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--media > .file-preview-pill--media')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill--footer')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-pill-primary')).toBeNull();
    const audio = rendered.document.querySelector('.file-preview-audio');
    expect(audio?.hasAttribute('controls')).toBe(false);
    expect(audio?.getAttribute('slot')).toBe('media');
    expect(audio?.getAttribute('controlsList')).toBe('nodownload noplaybackrate noremoteplayback');
    expect((audio as HTMLMediaElement | null)?.disableRemotePlayback).toBe(true);
  });

  test('media keyboard shortcuts are scoped to the focused media element', async () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: mediaSource('video/mp4') }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('reveal')]}
      />,
    );
    const video = rendered.document.querySelector('.file-preview-video');
    if (!(video instanceof rendered.window.HTMLElement)) throw new Error('Missing video');
    installMediaState(video, { paused: true, currentTime: 20, duration: 120 });

    await keydown(rendered, rendered.document.body, ' ');
    expect(mediaState(video).playCalls).toBe(0);

    video.focus();
    await keydown(rendered, video, ' ');
    expect(mediaState(video).playCalls).toBe(1);
    expect(mediaState(video).paused).toBe(false);

    await keydown(rendered, video, 'k');
    expect(mediaState(video).pauseCalls).toBe(1);
    expect(mediaState(video).paused).toBe(true);

    await keydown(rendered, video, 'ArrowRight');
    expect(mediaState(video).currentTime).toBe(25);
    await keydown(rendered, video, 'l');
    expect(mediaState(video).currentTime).toBe(35);
    await keydown(rendered, video, 'ArrowLeft');
    expect(mediaState(video).currentTime).toBe(30);
    await keydown(rendered, video, 'j');
    expect(mediaState(video).currentTime).toBe(20);

    await keydown(rendered, video, 'm');
    expect(mediaState(video).muted).toBe(true);
  });

  test('video fullscreen shortcut works while the media is already fullscreen', async () => {
    const rendered = render(
      <FilePreviewShell
        state={{ status: 'ready', source: mediaSource('video/mp4') }}
        onOpenTarget={() => undefined}
        menuActions={[menuAction('reveal')]}
      />,
    );
    const video = rendered.document.querySelector('.file-preview-video');
    if (!(video instanceof rendered.window.HTMLElement)) throw new Error('Missing video');
    installMediaState(video, { paused: true, currentTime: 0, duration: 60 });
    installFullscreenState(rendered.document, video);

    await keydown(rendered, rendered.document.body, ' ');
    expect(mediaState(video).playCalls).toBe(1);
    expect(mediaState(video).paused).toBe(false);

    await keydown(rendered, rendered.document.body, 'f');
    expect(fullscreenState(rendered.document).exitCalls).toBe(1);
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
    expect(webview?.getAttribute('partition')).toBe('url-preview');
    expect(webview?.getAttribute('src')).toBe('https://example.com/docs');
    expect(webview?.getAttribute('title')).toBe('Example docs');
    expect(rendered.document.querySelector('.file-node-body--url')).not.toBeNull();
    expect(rendered.document.querySelector('.file-node-preview--url.expanded')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-message')).toBeNull();
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

function urlSource(): PreviewUrlSource {
  return {
    kind: 'url',
    id: 'url:https://example.com/docs',
    target: { kind: 'url', url: 'https://example.com/docs', label: 'Example docs' },
    title: 'Example docs',
    url: 'https://example.com/docs',
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
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

interface TestMediaState {
  currentTime: number;
  duration: number;
  muted: boolean;
  paused: boolean;
  pauseCalls: number;
  playCalls: number;
  requestFullscreenCalls: number;
}

function installMediaState(
  media: Element,
  input: Pick<TestMediaState, 'currentTime' | 'duration' | 'paused'>,
) {
  const state: TestMediaState = {
    ...input,
    muted: false,
    pauseCalls: 0,
    playCalls: 0,
    requestFullscreenCalls: 0,
  };
  Object.defineProperties(media, {
    currentTime: {
      configurable: true,
      get: () => state.currentTime,
      set: (value: number) => {
        state.currentTime = value;
      },
    },
    duration: {
      configurable: true,
      get: () => state.duration,
    },
    muted: {
      configurable: true,
      get: () => state.muted,
      set: (value: boolean) => {
        state.muted = value;
      },
    },
    paused: {
      configurable: true,
      get: () => state.paused,
    },
    __mediaState: {
      configurable: true,
      value: state,
    },
  });
  Object.assign(media, {
    pause: () => {
      state.pauseCalls += 1;
      state.paused = true;
    },
    play: () => {
      state.playCalls += 1;
      state.paused = false;
      return Promise.resolve();
    },
    requestFullscreen: () => {
      state.requestFullscreenCalls += 1;
      return Promise.resolve();
    },
  });
}

function mediaState(media: Element): TestMediaState {
  return (media as Element & { __mediaState: TestMediaState }).__mediaState;
}

interface TestFullscreenState {
  exitCalls: number;
}

function installFullscreenState(document: Document, element: Element) {
  const state: TestFullscreenState = { exitCalls: 0 };
  Object.defineProperties(document, {
    fullscreenElement: {
      configurable: true,
      get: () => element,
    },
    __fullscreenState: {
      configurable: true,
      value: state,
    },
  });
  Object.assign(document, {
    exitFullscreen: () => {
      state.exitCalls += 1;
      return Promise.resolve();
    },
  });
}

function fullscreenState(document: Document): TestFullscreenState {
  return (document as Document & { __fullscreenState: TestFullscreenState }).__fullscreenState;
}

async function keydown(rendered: { window: Window }, target: Element | Document, key: string) {
  const event = new rendered.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string };
  Object.defineProperty(event, 'key', { value: key });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
}
