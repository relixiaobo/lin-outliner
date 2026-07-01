import { afterEach, describe, expect, test } from 'bun:test';
import { useLayoutEffect } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  captureDisclosureScrollAnchor,
  usePendingDisclosureAnchor,
  type DisclosureScrollAnchorSnapshot,
} from '../../src/renderer/ui/interactions/disclosureScrollAnchor';

interface Rendered {
  cleanup: () => void;
  dispatchScroll: () => void;
  flushFrame: () => void;
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

    layoutTop = 570;
    rendered.flushFrame();
    expect(rendered.scroller.scrollTop).toBe(70);
    expect(rendered.anchor.getBoundingClientRect().top).toBe(500);

    layoutTop = 550;
    rendered.flushFrame();
    expect(rendered.scroller.scrollTop).toBe(50);
    expect(rendered.anchor.getBoundingClientRect().top).toBe(500);
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

    layoutTop = 570;
    rendered.flushFrame();
    expect(rendered.scroller.scrollTop).toBe(160);
  });
});

function Probe({ snapshot }: { snapshot: DisclosureScrollAnchorSnapshot }) {
  const { capturePendingAnchor, restorePendingAnchor } = usePendingDisclosureAnchor();
  useLayoutEffect(() => {
    capturePendingAnchor(snapshot);
  }, [capturePendingAnchor, snapshot]);
  useLayoutEffect(() => restorePendingAnchor(), [restorePendingAnchor, snapshot]);
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
  const root = createRoot(document.getElementById('root')!);
  act(() => {
    root.render(<Probe snapshot={snapshot} />);
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
    pendingFrameCount: () => (
      (window as unknown as { __frames?: Map<number, FrameRequestCallback> }).__frames?.size ?? 0
    ),
    scroller,
  };
  mounted.push(rendered);
  return rendered;
}
