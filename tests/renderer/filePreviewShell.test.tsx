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

function render(node: React.ReactNode): { document: Document; window: Window } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
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
