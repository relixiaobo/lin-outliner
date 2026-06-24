import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { CalendarMonthGrid } from '../../src/renderer/ui/primitives/CalendarMonthGrid';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
  moves: number[];
  selects: string[];
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

// May 2026, today the 15th, the 20th selected.
function renderGrid(opts: { isDateDisabled?: (isoDate: string) => boolean; multiselectable?: boolean } = {}): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  const moves: number[] = [];
  const selects: string[] = [];
  act(() => {
    root.render(
      <CalendarMonthGrid
        year={2026}
        month={4}
        isDateDisabled={opts.isDateDisabled}
        multiselectable={opts.multiselectable}
        todayIsoDate="2026-05-15"
        selectedIsoDates={['2026-05-20']}
        onMoveMonth={(delta) => moves.push(delta)}
        onSelectDate={(iso) => selects.push(iso)}
      />,
    );
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window, moves, selects };
  mounted.push(rendered);
  return rendered;
}

describe('CalendarMonthGrid ARIA + roving', () => {
  test('exposes grid / row / gridcell structure', () => {
    const r = renderGrid();
    expect(r.document.querySelector('.calendar-month-grid')?.getAttribute('role')).toBe('grid');
    expect(r.document.querySelectorAll('[role="row"]')).toHaveLength(6);
    expect(r.document.querySelectorAll('[role="gridcell"]')).toHaveLength(42);
  });

  test('marks today (aria-current) and the selected day (aria-selected)', () => {
    const r = renderGrid();
    expect(cell(r, '2026-05-15')?.getAttribute('aria-current')).toBe('date');
    expect(cell(r, '2026-05-20')?.getAttribute('aria-selected')).toBe('true');
    expect(cell(r, '2026-05-21')?.getAttribute('aria-selected')).toBe('false');
  });

  test('roving tabindex: exactly one tab stop, defaulting to the selected day', () => {
    const r = renderGrid();
    const tabbable = [...r.document.querySelectorAll('.calendar-month-day')]
      .filter((day) => day.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.getAttribute('data-iso')).toBe('2026-05-20');
  });

  test('ArrowRight moves the roving tab stop to the next day', () => {
    const r = renderGrid();
    pressKey(r, '2026-05-20', 'ArrowRight');
    expect(cell(r, '2026-05-20')?.getAttribute('tabindex')).toBe('-1');
    expect(cell(r, '2026-05-21')?.getAttribute('tabindex')).toBe('0');
  });

  test('PageUp navigates off the grid and shifts the month', () => {
    const r = renderGrid();
    pressKey(r, '2026-05-20', 'PageUp');
    expect(r.moves).toEqual([-1]);
  });

  test('Page from an overflow cell shifts to the target month, not a fixed ±1', () => {
    // June 1 shows as an overflow cell in May's grid; PageDown targets July 1,
    // two months from the May view. The shift must be 2 (so July renders and keeps
    // the roving cell), not a fixed 1 that would strand focus on a stale grid.
    const r = renderGrid();
    pressKey(r, '2026-06-01', 'PageDown');
    expect(r.moves).toEqual([2]);
  });

  test('keyboard navigation falls back to the nearest enabled date at a disabled boundary', () => {
    const r = renderGrid({ isDateDisabled: (isoDate) => isoDate > '2026-05-20' });

    pressKey(r, '2026-05-20', 'ArrowRight');
    expect(cell(r, '2026-05-20')?.getAttribute('tabindex')).toBe('0');

    pressKey(r, '2026-05-20', 'PageDown');
    expect(cell(r, '2026-05-20')?.getAttribute('tabindex')).toBe('0');
    expect(r.moves).toEqual([]);
  });

  test('advertises aria-multiselectable only when the grid can hold multiple', () => {
    expect(renderGrid().document.querySelector('.calendar-month-grid')?.getAttribute('aria-multiselectable'))
      .toBeNull();
    expect(renderGrid({ multiselectable: true }).document.querySelector('.calendar-month-grid')
      ?.getAttribute('aria-multiselectable')).toBe('true');
  });
});

function cell(r: Rendered, iso: string): Element | null {
  return r.document.querySelector(`[data-iso="${iso}"]`);
}

function pressKey(r: Rendered, iso: string, key: string) {
  const target = cell(r, iso);
  if (!target) throw new Error(`Missing day cell: ${iso}`);
  const event = new r.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string };
  event.key = key;
  act(() => {
    target.dispatchEvent(event);
  });
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
