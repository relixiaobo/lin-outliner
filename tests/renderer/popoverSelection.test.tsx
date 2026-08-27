import { afterEach, describe, expect, test } from 'bun:test';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  normalizedPopoverIndex,
  usePopoverSelection,
} from '../../src/renderer/ui/outliner/usePopoverSelection';

interface FixtureProps {
  initialIndex?: number;
  itemCount: number;
  mode?: 'clamp' | 'reset';
  selectionKey: string;
}

interface Rendered {
  cleanup: () => void;
  document: Document;
  render: (props: FixtureProps) => void;
  scrolled: string[];
  window: Window;
}

const mounted: Rendered[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.cleanup();
});

describe('normalizedPopoverIndex', () => {
  test('clamps to the available range while preserving a negative no-selection sentinel', () => {
    expect(normalizedPopoverIndex(4, 3)).toBe(2);
    expect(normalizedPopoverIndex(-1, 3)).toBe(0);
    expect(normalizedPopoverIndex(-1, 3, -1)).toBe(-1);
    expect(normalizedPopoverIndex(2, 0, -1)).toBe(-1);
  });
});

describe('usePopoverSelection', () => {
  test('resets a same-length replacement list and scrolls its first item before paint', () => {
    const rendered = renderFixture({ itemCount: 3, selectionKey: 'a' });
    click(rendered, '[data-select-last]');
    expect(selectedLabel(rendered)).toBe('a:2');

    rendered.render({ itemCount: 3, selectionKey: 'b' });

    expect(selectedLabel(rendered)).toBe('b:0');
    expect(rendered.scrolled.at(-1)).toBe('b:0');
  });

  test('clamps a preserved selection when a filtered list becomes shorter', () => {
    const rendered = renderFixture({ itemCount: 3, mode: 'clamp', selectionKey: 'a' });
    click(rendered, '[data-select-last]');
    expect(selectedLabel(rendered)).toBe('a:2');

    rendered.render({ itemCount: 1, mode: 'clamp', selectionKey: 'b' });

    expect(selectedLabel(rendered)).toBe('b:0');
    expect(rendered.scrolled.at(-1)).toBe('b:0');
  });

  test('supports a deliberate no-selection initial state', () => {
    const rendered = renderFixture({ initialIndex: -1, itemCount: 2, selectionKey: 'fields' });
    expect(selectedLabel(rendered)).toBeNull();
  });
});

function Fixture(props: FixtureProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = usePopoverSelection({
    initialIndex: props.initialIndex,
    itemCount: props.itemCount,
    listRef,
    mode: props.mode,
    selectionKey: props.selectionKey,
  });
  return (
    <>
      <button data-select-last onClick={() => setSelectedIndex(props.itemCount - 1)} type="button">
        Select last
      </button>
      <div ref={listRef}>
        {Array.from({ length: props.itemCount }, (_, index) => (
          <div data-selected={selectedIndex === index ? 'true' : undefined} key={`${props.selectionKey}:${index}`}>
            {props.selectionKey}:{index}
          </div>
        ))}
      </div>
    </>
  );
}

function renderFixture(initialProps: FixtureProps): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const scrolled: string[] = [];
  (window.HTMLElement.prototype as HTMLElement & { scrollIntoView: () => void }).scrollIntoView = function scrollIntoView() {
    scrolled.push(this.textContent ?? '');
  };
  const root: Root = createRoot(document.getElementById('root')!);
  const render = (props: FixtureProps) => act(() => root.render(<Fixture {...props} />));
  render(initialProps);
  const rendered = {
    cleanup: () => act(() => root.unmount()),
    document,
    render,
    scrolled,
    window,
  } satisfies Rendered;
  mounted.push(rendered);
  return rendered;
}

function click(rendered: Rendered, selector: string): void {
  const target = rendered.document.querySelector(selector);
  if (!target) throw new Error(`Missing target: ${selector}`);
  act(() => target.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true })));
}

function selectedLabel(rendered: Rendered): string | null {
  return rendered.document.querySelector('[data-selected="true"]')?.textContent ?? null;
}
