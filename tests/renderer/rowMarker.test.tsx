import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { RowMarker } from '../../src/renderer/ui/outliner/RowMarker';

// The command bullet doubles as the attended-run indicator: while a run is in
// flight the glyph is swapped for a spinner (an `.is-processing` class drives the
// CSS animation). This locks that toggle — the e2e command-node spec can't observe
// the transient running state reliably.
describe('RowMarker command bullet', () => {
  beforeEach(() => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, { document: window.document, window });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  const roots: Array<() => void> = [];
  afterEach(() => { while (roots.length) roots.pop()?.(); });

  function renderMarker(processing: boolean): Element {
    const doc = globalThis.document;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<RowMarker hasChildren={false} expanded={false} variant="command" processing={processing} />);
    });
    roots.push(() => act(() => root.unmount()));
    const marker = container.querySelector('.row-bullet-shape.command');
    if (!marker) throw new Error('Missing command bullet');
    return marker;
  }

  test('idle bullet is not processing', () => {
    const marker = renderMarker(false);
    expect(marker.classList.contains('is-processing')).toBe(false);
    expect(marker.querySelector('svg')).toBeTruthy();
  });

  test('running bullet carries the is-processing spinner class', () => {
    const marker = renderMarker(true);
    expect(marker.classList.contains('is-processing')).toBe(true);
    expect(marker.querySelector('svg')).toBeTruthy();
  });
});
