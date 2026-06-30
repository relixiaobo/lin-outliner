import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { DocumentOutlineRail, type DocumentOutlineItem } from '../../src/renderer/ui/preview/DocumentOutlineRail';

const mounted: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('DocumentOutlineRail', () => {
  test('keeps the active marker centered inside the short marker rail', async () => {
    const rendered = renderRail();
    const scrollRoot = rendered.document.getElementById('scroll-root');
    if (!scrollRoot) throw new Error('Missing scroll root');

    await act(async () => {
      await Promise.resolve();
    });

    const track = rendered.document.querySelector<HTMLElement>('.document-outline-rail-track');
    if (!track) throw new Error('Missing outline track');

    installTrackGeometry(track);
    scrollRoot.scrollTop = 250;
    await act(async () => {
      scrollRoot.dispatchEvent(new rendered.window.Event('scroll'));
      await Promise.resolve();
    });

    expect(track.scrollTop).toBe(40);
    expect(rendered.document.querySelectorAll('.document-outline-rail-marker.active')).toHaveLength(1);
  });

  test('scrolls the popover to the active outline item on hover', async () => {
    const rendered = renderRail();
    const scrollRoot = rendered.document.getElementById('scroll-root');
    if (!scrollRoot) throw new Error('Missing scroll root');

    await act(async () => {
      await Promise.resolve();
    });

    const rail = rendered.document.querySelector<HTMLElement>('.document-outline-rail');
    const popover = rendered.document.querySelector<HTMLElement>('.document-outline-popover');
    if (!rail || !popover) throw new Error('Missing outline rail');

    installPopoverGeometry(popover);
    scrollRoot.scrollTop = 350;
    await act(async () => {
      scrollRoot.dispatchEvent(new rendered.window.Event('scroll'));
      rail.dispatchEvent(new rendered.window.Event('mouseover', { bubbles: true }));
      await Promise.resolve();
    });

    expect(popover.scrollTop).toBe(96);
    expect(rendered.document.querySelector('.document-outline-item.active')?.textContent).toBe('Section 4');
  });
});

function renderRail(): { document: Document; window: Window } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="scroll-root"></div></body></html>');
  installDomGlobals(window);
  const scrollRoot = document.getElementById('scroll-root');
  if (!scrollRoot) throw new Error('Missing scroll root');
  Object.defineProperty(scrollRoot, 'children', { configurable: true, value: [] });
  const scrollRootRef = { current: scrollRoot };
  const items: DocumentOutlineItem[] = Array.from({ length: 5 }, (_, index) => ({
    id: `item-${index}`,
    level: 0,
    target: { top: index * 100 },
    title: `Section ${index + 1}`,
  }));
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(
      <DocumentOutlineRail
        items={items}
        resolveItemTop={(item) => (item.target as { top: number }).top}
        scrollRootRef={scrollRootRef}
      />,
    );
  });
  mounted.push({ cleanup: () => act(() => root.unmount()) });
  return { document, window };
}

function installTrackGeometry(track: HTMLElement) {
  Object.defineProperty(track, 'scrollTop', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(track, 'clientHeight', { configurable: true, value: 100 });
  Array.from(track.children).forEach((child, index) => {
    Object.defineProperty(child, 'offsetTop', { configurable: true, value: index * 40 });
    Object.defineProperty(child, 'offsetHeight', { configurable: true, value: 20 });
  });
}

function installPopoverGeometry(popover: HTMLElement) {
  Object.defineProperty(popover, 'scrollTop', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(popover, 'clientHeight', { configurable: true, value: 120 });
  Array.from(popover.children).forEach((child, index) => {
    Object.defineProperty(child, 'offsetTop', { configurable: true, value: index * 48 });
    Object.defineProperty(child, 'offsetHeight', { configurable: true, value: 24 });
  });
}

function installDomGlobals(window: Window) {
  (window as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame = (cb) => { cb(0); return 0; };
  (window as unknown as { cancelAnimationFrame: (handle: number) => void })
    .cancelAnimationFrame = () => undefined;
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    ResizeObserver: ResizeObserverStub,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
