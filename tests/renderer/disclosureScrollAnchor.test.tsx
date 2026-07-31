import { afterEach, describe, expect, test } from 'bun:test';
import { useLayoutEffect } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  captureDisclosureScrollAnchor,
  restoreDisclosureScrollAnchor,
  usePendingDisclosureAnchor,
  type DisclosureScrollAnchorHold,
  type DisclosureScrollAnchorSnapshot,
} from '../../src/renderer/ui/interactions/disclosureScrollAnchor';

interface Rendered {
  cleanup: () => void;
  dispatchScroll: () => void;
  flushFrame: () => void;
  hasPendingAnchor: () => boolean;
  holdAnchor: () => DisclosureScrollAnchorHold | null;
  pendingFrameCount: () => number;
}

const GLOBAL_KEYS = [
  'cancelAnimationFrame',
  'document',
  'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT',
  'Node',
  'requestAnimationFrame',
  'window',
] as const;
const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('usePendingDisclosureAnchor', () => {
  test('keeps restoring the disclosure anchor across delayed layout corrections', () => {
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let layoutTop = 600;
    const rendered = render(
      (win) => {
        (win as unknown as { __frames: Map<number, FrameRequestCallback> }).__frames = frameCallbacks;
        win.requestAnimationFrame = (callback: FrameRequestCallback) => {
          const handle = nextFrame;
          nextFrame += 1;
          frameCallbacks.set(handle, callback);
          return handle;
        };
        win.cancelAnimationFrame = (handle: number) => {
          frameCallbacks.delete(handle);
        };
      },
      (document) => {
        const scroller = document.createElement('div');
        scroller.scrollTop = 100;
        const anchor = document.createElement('button');
        scroller.appendChild(anchor);
        document.body.appendChild(scroller);
        anchor.getBoundingClientRect = () => ({
          bottom: layoutTop - scroller.scrollTop + 12,
          height: 12,
          left: 0,
          right: 12,
          top: layoutTop - scroller.scrollTop,
          width: 12,
          x: 0,
          y: layoutTop - scroller.scrollTop,
          toJSON: () => ({}),
        });
        const snapshot = captureDisclosureScrollAnchor(anchor, scroller);
        if (!snapshot) throw new Error('Missing disclosure anchor snapshot');
        return { anchor, scroller, snapshot };
      },
    );

    expect(rendered.scroller.scrollTop).toBe(100);
    expect(rendered.hasPendingAnchor()).toBe(true);

    layoutTop = 570;
    rendered.flushFrame();
    expect(rendered.scroller.scrollTop).toBe(70);
    expect(rendered.anchor.getBoundingClientRect().top).toBe(500);

    layoutTop = 550;
    rendered.flushFrame();
    expect(rendered.scroller.scrollTop).toBe(50);
    expect(rendered.anchor.getBoundingClientRect().top).toBe(500);

    for (let frame = 0; frame < 10; frame += 1) rendered.flushFrame();
    expect(rendered.hasPendingAnchor()).toBe(false);
  });

  test('releases the disclosure anchor when the user scrolls before delayed corrections', () => {
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let layoutTop = 600;
    const rendered = render(
      (win) => {
        (win as unknown as { __frames: Map<number, FrameRequestCallback> }).__frames = frameCallbacks;
        win.requestAnimationFrame = (callback: FrameRequestCallback) => {
          const handle = nextFrame;
          nextFrame += 1;
          frameCallbacks.set(handle, callback);
          return handle;
        };
        win.cancelAnimationFrame = (handle: number) => {
          frameCallbacks.delete(handle);
        };
      },
      (document) => {
        const scroller = document.createElement('div');
        scroller.scrollTop = 100;
        const anchor = document.createElement('button');
        scroller.appendChild(anchor);
        document.body.appendChild(scroller);
        anchor.getBoundingClientRect = () => ({
          bottom: layoutTop - scroller.scrollTop + 12,
          height: 12,
          left: 0,
          right: 12,
          top: layoutTop - scroller.scrollTop,
          width: 12,
          x: 0,
          y: layoutTop - scroller.scrollTop,
          toJSON: () => ({}),
        });
        const snapshot = captureDisclosureScrollAnchor(anchor, scroller);
        if (!snapshot) throw new Error('Missing disclosure anchor snapshot');
        return { anchor, scroller, snapshot };
      },
    );

    expect(rendered.scroller.scrollTop).toBe(100);
    expect(rendered.pendingFrameCount()).toBe(1);

    rendered.scroller.scrollTop = 160;
    rendered.dispatchScroll();
    expect(rendered.pendingFrameCount()).toBe(0);
    expect(rendered.hasPendingAnchor()).toBe(false);

    layoutTop = 570;
    rendered.flushFrame();
    expect(rendered.scroller.scrollTop).toBe(160);
  });

  test('keeps a settled-frame anchor alive until asynchronous content lands', () => {
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let layoutTop = 600;
    const rendered = render(
      (win) => {
        (win as unknown as { __frames: Map<number, FrameRequestCallback> }).__frames = frameCallbacks;
        win.requestAnimationFrame = (callback: FrameRequestCallback) => {
          const handle = nextFrame;
          nextFrame += 1;
          frameCallbacks.set(handle, callback);
          return handle;
        };
        win.cancelAnimationFrame = (handle: number) => {
          frameCallbacks.delete(handle);
        };
      },
      (document) => {
        const scroller = document.createElement('div');
        scroller.scrollTop = 100;
        const anchor = document.createElement('button');
        scroller.appendChild(anchor);
        document.body.appendChild(scroller);
        anchor.getBoundingClientRect = () => ({
          bottom: layoutTop - scroller.scrollTop + 12,
          height: 12,
          left: 0,
          right: 12,
          top: layoutTop - scroller.scrollTop,
          width: 12,
          x: 0,
          y: layoutTop - scroller.scrollTop,
          toJSON: () => ({}),
        });
        const snapshot = captureDisclosureScrollAnchor(anchor, scroller);
        if (!snapshot) throw new Error('Missing disclosure anchor snapshot');
        return { anchor, scroller, snapshot };
      },
    );

    const hold = rendered.holdAnchor();
    expect(hold).not.toBeNull();
    for (let frame = 0; frame < 12; frame += 1) rendered.flushFrame();
    expect(rendered.pendingFrameCount()).toBe(0);
    expect(rendered.hasPendingAnchor()).toBe(true);

    layoutTop = 540;
    hold?.settle();
    expect(rendered.pendingFrameCount()).toBe(1);
    rendered.flushFrame();
    expect(rendered.scroller.scrollTop).toBe(40);
    for (let frame = 0; frame < 11; frame += 1) rendered.flushFrame();
    expect(rendered.hasPendingAnchor()).toBe(false);
  });

  test('releases an anchor whose owning disclosure never runs its layout restore', () => {
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let releaseCount = 0;
    const rendered = render(
      (win) => {
        (win as unknown as { __frames: Map<number, FrameRequestCallback> }).__frames = frameCallbacks;
        win.requestAnimationFrame = (callback: FrameRequestCallback) => {
          const handle = nextFrame;
          nextFrame += 1;
          frameCallbacks.set(handle, callback);
          return handle;
        };
        win.cancelAnimationFrame = (handle: number) => {
          frameCallbacks.delete(handle);
        };
      },
      (document) => {
        const scroller = document.createElement('div');
        const anchor = document.createElement('button');
        scroller.appendChild(anchor);
        document.body.appendChild(scroller);
        const snapshot = captureDisclosureScrollAnchor(anchor, scroller);
        if (!snapshot) throw new Error('Missing disclosure anchor snapshot');
        return { anchor, scroller, snapshot };
      },
      {
        onRelease: () => {
          releaseCount += 1;
        },
        restoreAfterCapture: false,
      },
    );

    expect(rendered.pendingFrameCount()).toBe(1);
    for (let frame = 0; frame < 12; frame += 1) rendered.flushFrame();
    expect(rendered.hasPendingAnchor()).toBe(false);
    expect(releaseCount).toBe(1);
  });

  test('bounds an asynchronous hold and notifies deferred work when it expires', () => {
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    const timeoutCallbacks = new Map<number, () => void>();
    let nextFrame = 1;
    let nextTimeout = 1;
    let releaseCount = 0;
    let testWindow: Window | null = null;
    const rendered = render(
      (win) => {
        testWindow = win;
        (win as unknown as { __frames: Map<number, FrameRequestCallback> }).__frames = frameCallbacks;
        Object.assign(win, {
          cancelAnimationFrame: (handle: number) => {
            frameCallbacks.delete(handle);
          },
          requestAnimationFrame: (callback: FrameRequestCallback) => {
            const handle = nextFrame;
            nextFrame += 1;
            frameCallbacks.set(handle, callback);
            return handle;
          },
        });
      },
      (document) => {
        const scroller = document.createElement('div');
        const anchor = document.createElement('button');
        scroller.appendChild(anchor);
        document.body.appendChild(scroller);
        const snapshot = captureDisclosureScrollAnchor(anchor, scroller);
        if (!snapshot) throw new Error('Missing disclosure anchor snapshot');
        return { anchor, scroller, snapshot };
      },
      {
        onRelease: () => {
          releaseCount += 1;
        },
      },
    );

    const win = testWindow;
    if (!win) throw new Error('Missing test window');
    const originalClearTimeout = win.clearTimeout;
    const originalSetTimeout = win.setTimeout;
    Object.assign(win, {
      clearTimeout: (handle: number) => {
        timeoutCallbacks.delete(handle);
      },
      setTimeout: (callback: () => void) => {
        const handle = nextTimeout;
        nextTimeout += 1;
        timeoutCallbacks.set(handle, callback);
        return handle;
      },
    });
    let hold: DisclosureScrollAnchorHold | null = null;
    try {
      hold = rendered.holdAnchor();
    } finally {
      Object.assign(win, {
        clearTimeout: originalClearTimeout,
        setTimeout: originalSetTimeout,
      });
    }
    expect(hold).not.toBeNull();
    for (let frame = 0; frame < 12; frame += 1) rendered.flushFrame();
    expect(rendered.hasPendingAnchor()).toBe(true);
    expect(timeoutCallbacks.size).toBe(1);

    const timeout = timeoutCallbacks.values().next().value;
    Object.assign(win, {
      clearTimeout: (handle: number) => {
        timeoutCallbacks.delete(handle);
      },
    });
    try {
      timeout?.();
    } finally {
      Object.assign(win, { clearTimeout: originalClearTimeout });
    }
    expect(rendered.pendingFrameCount()).toBe(1);
    for (let frame = 0; frame < 12; frame += 1) rendered.flushFrame();
    expect(rendered.hasPendingAnchor()).toBe(false);
    expect(releaseCount).toBe(1);
  });
});

test('does not report a blocked correction for a sub-pixel anchor delta', () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const scroller = document.createElement('div');
  const anchor = document.createElement('button');
  let layoutTop = 600;
  scroller.scrollTop = 100;
  anchor.getBoundingClientRect = () => ({
    bottom: layoutTop - scroller.scrollTop + 12,
    height: 12,
    left: 0,
    right: 12,
    top: layoutTop - scroller.scrollTop,
    width: 12,
    x: 0,
    y: layoutTop - scroller.scrollTop,
    toJSON: () => ({}),
  });
  scroller.append(anchor);
  document.body.append(scroller);
  const snapshot = captureDisclosureScrollAnchor(anchor, scroller);
  if (!snapshot) throw new Error('Missing disclosure anchor snapshot');

  layoutTop += 0.75;
  expect(restoreDisclosureScrollAnchor(snapshot)).toEqual({
    moved: false,
    remainingDelta: 0,
    restored: true,
  });
  expect(scroller.scrollTop).toBe(100);
});

test('reports anchor movement that remains after the scroller reaches its limit', () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const scroller = document.createElement('div');
  const anchor = document.createElement('button');
  let scrollTop = 100;
  let layoutTop = 600;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(130, value);
    },
  });
  anchor.getBoundingClientRect = () => ({
    bottom: layoutTop - scrollTop + 12,
    height: 12,
    left: 0,
    right: 12,
    top: layoutTop - scrollTop,
    width: 12,
    x: 0,
    y: layoutTop - scrollTop,
    toJSON: () => ({}),
  });
  scroller.append(anchor);
  document.body.append(scroller);
  const snapshot = captureDisclosureScrollAnchor(anchor, scroller);
  if (!snapshot) throw new Error('Missing disclosure anchor snapshot');

  layoutTop = 650;
  expect(restoreDisclosureScrollAnchor(snapshot)).toEqual({
    moved: true,
    remainingDelta: 20,
    restored: true,
  });
});

function Probe({
  onRelease,
  onReady,
  restoreAfterCapture,
  snapshot,
}: {
  readonly onRelease?: () => void;
  readonly onReady: (controls: {
    hasPendingAnchor: () => boolean;
    holdAnchor: () => DisclosureScrollAnchorHold | null;
  }) => void;
  readonly restoreAfterCapture: boolean;
  readonly snapshot: DisclosureScrollAnchorSnapshot;
}) {
  const {
    capturePendingAnchor,
    hasPendingAnchor,
    holdUntilSettled,
    restorePendingAnchor,
  } = usePendingDisclosureAnchor(undefined, onRelease);
  useLayoutEffect(() => {
    capturePendingAnchor(snapshot);
  }, [capturePendingAnchor, snapshot]);
  useLayoutEffect(() => (
    restoreAfterCapture ? restorePendingAnchor() : undefined
  ), [restoreAfterCapture, restorePendingAnchor, snapshot]);
  useLayoutEffect(() => onReady({
    hasPendingAnchor,
    holdAnchor: holdUntilSettled,
  }), [hasPendingAnchor, holdUntilSettled, onReady]);
  return null;
}

function render(
  installWindow: (window: Window) => void,
  createAnchor: (document: Document) => {
    anchor: HTMLElement;
    scroller: HTMLElement;
    snapshot: DisclosureScrollAnchorSnapshot;
  },
  options: {
    readonly onRelease?: () => void;
    readonly restoreAfterCapture?: boolean;
  } = {},
) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installWindow(window);
  const savedGlobals = GLOBAL_KEYS.map((key) => (
    [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  ));
  Object.assign(globalThis, {
    cancelAnimationFrame: window.cancelAnimationFrame,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame,
    window,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { anchor, scroller, snapshot } = createAnchor(document);
  let hasPendingAnchor = () => false;
  let holdAnchor = (): DisclosureScrollAnchorHold | null => null;
  const root = createRoot(document.getElementById('root')!);
  act(() => {
    root.render(<Probe
      onRelease={options.onRelease}
      onReady={(controls) => {
        hasPendingAnchor = controls.hasPendingAnchor;
        holdAnchor = controls.holdAnchor;
      }}
      restoreAfterCapture={options.restoreAfterCapture ?? true}
      snapshot={snapshot}
    />);
  });
  const rendered = {
    anchor,
    cleanup: () => {
      act(() => root.unmount());
      for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
    dispatchScroll: () => {
      scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }));
    },
    flushFrame: () => {
      const callbacks = (window as unknown as {
        requestAnimationFrame: (callback: FrameRequestCallback) => number;
      });
      void callbacks;
      const frameCallbacks = (window as unknown as { __frames?: Map<number, FrameRequestCallback> }).__frames;
      if (!frameCallbacks) return;
      const first = frameCallbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!first) return;
      frameCallbacks.delete(first[0]);
      first[1](performance.now());
    },
    hasPendingAnchor: () => hasPendingAnchor(),
    holdAnchor: () => holdAnchor(),
    pendingFrameCount: () => (
      (window as unknown as { __frames?: Map<number, FrameRequestCallback> }).__frames?.size ?? 0
    ),
    scroller,
  };
  mounted.push(rendered);
  return rendered;
}
