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
  onReady,
  snapshot,
}: {
  readonly onReady: (controls: {
    hasPendingAnchor: () => boolean;
    holdAnchor: () => DisclosureScrollAnchorHold | null;
  }) => void;
  readonly snapshot: DisclosureScrollAnchorSnapshot;
}) {
  const {
    capturePendingAnchor,
    hasPendingAnchor,
    holdUntilSettled,
    restorePendingAnchor,
  } = usePendingDisclosureAnchor();
  useLayoutEffect(() => {
    capturePendingAnchor(snapshot);
  }, [capturePendingAnchor, snapshot]);
  useLayoutEffect(() => restorePendingAnchor(), [restorePendingAnchor, snapshot]);
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
) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installWindow(window);
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
      onReady={(controls) => {
        hasPendingAnchor = controls.hasPendingAnchor;
        holdAnchor = controls.holdAnchor;
      }}
      snapshot={snapshot}
    />);
  });
  const rendered = {
    anchor,
    cleanup: () => act(() => root.unmount()),
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
