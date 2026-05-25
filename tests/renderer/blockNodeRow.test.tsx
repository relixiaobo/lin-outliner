import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { BlockNodeRow, isBlockNodeType, type BlockNodeRowProps } from '../../src/renderer/ui/outliner/BlockNodeRow';
import { cursorEnd, rowFocusTarget } from '../../src/renderer/ui/focus/focusModel';
import type { NodeProjection } from '../../src/renderer/api/types';
import type { FocusRequest } from '../../src/renderer/state/document';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window & typeof globalThis;
}

const mounted: Rendered[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

function imageNode(overrides: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id: 'img1',
    type: 'image',
    assetId: 'abc123',
    imageWidth: 200,
    imageHeight: 100,
    ...overrides,
  } as unknown as NodeProjection;
}

function render(props: Partial<BlockNodeRowProps> & { node?: NodeProjection } = {}): {
  rendered: Rendered;
  calls: Record<string, number>;
  consumed: FocusRequest[];
} {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // linkedom elements have no real focus(); make it a no-op so the focus-request
  // effect can run without throwing.
  (window.HTMLElement.prototype as { focus?: () => void }).focus = () => {};

  const calls: Record<string, number> = {};
  const bump = (name: string) => () => { calls[name] = (calls[name] ?? 0) + 1; };
  const consumed: FocusRequest[] = [];

  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  act(() => {
    root.render(
      <BlockNodeRow
        node={props.node ?? imageNode()}
        onFocus={bump('focus')}
        onArrowUp={bump('arrowUp')}
        onArrowDown={bump('arrowDown')}
        onEnter={bump('enter')}
        onBackspace={bump('backspace')}
        onEscape={bump('escape')}
        onShiftArrow={bump('shiftArrow')}
        onTab={bump('tab')}
        onAddCaption={bump('addCaption')}
        focusTarget={rowFocusTarget('img1', null, null)}
        focusRequest={null}
        onFocusRequestConsumed={(request) => consumed.push(request)}
        {...props}
      />,
    );
  });

  const rendered: Rendered = {
    cleanup: () => act(() => root.unmount()),
    document,
    window: window as Window & typeof globalThis,
  };
  mounted.push(rendered);
  return { rendered, calls, consumed };
}

function keydown(rendered: Rendered, element: Element, key: string, init: Partial<KeyboardEventInit> = {}) {
  act(() => {
    // linkedom has no KeyboardEvent constructor; React reads these fields off
    // the native event, so a plain Event with them assigned is enough.
    const event = new rendered.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key, shiftKey: false, metaKey: false, ctrlKey: false, ...init });
    element.dispatchEvent(event);
  });
}

function shell(rendered: Rendered): HTMLElement {
  const el = rendered.document.querySelector<HTMLElement>('.block-node-row');
  if (!el) throw new Error('missing block-node-row');
  return el;
}

describe('isBlockNodeType', () => {
  test('an image with an assetId is a block node; without one it is not', () => {
    expect(isBlockNodeType({ type: 'image', assetId: 'a' })).toBe(true);
    expect(isBlockNodeType({ type: 'image', assetId: undefined })).toBe(false);
    expect(isBlockNodeType({ type: undefined, assetId: undefined })).toBe(false);
    expect(isBlockNodeType({ type: 'codeBlock', assetId: undefined })).toBe(false);
  });
});

describe('BlockNodeRow', () => {
  test('renders the image body and a caption affordance', () => {
    const { rendered } = render();
    const img = rendered.document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('lin-asset://abc123');
    expect(rendered.document.querySelector('button[aria-label="Add caption"]')).not.toBeNull();
  });

  test('labels the caption button "Edit caption" when a description exists', () => {
    const { rendered } = render({ node: imageNode({ description: 'a cat' }) });
    expect(rendered.document.querySelector('button[aria-label="Edit caption"]')).not.toBeNull();
  });

  test('arrow / enter / backspace / escape on the shell drive navigation', () => {
    const { rendered, calls } = render();
    const el = shell(rendered);
    keydown(rendered, el, 'ArrowDown');
    keydown(rendered, el, 'ArrowUp');
    keydown(rendered, el, 'Enter');
    keydown(rendered, el, 'Backspace');
    keydown(rendered, el, 'Escape');
    keydown(rendered, el, 'ArrowUp', { shiftKey: true });
    keydown(rendered, el, 'Tab');
    expect(calls).toMatchObject({
      arrowDown: 1,
      arrowUp: 1,
      enter: 1,
      backspace: 1,
      escape: 1,
      shiftArrow: 1,
      tab: 1,
    });
  });

  test('ignores keys bubbling up from a toolbar button', () => {
    const { rendered, calls } = render();
    const button = rendered.document.querySelector<HTMLElement>('button[aria-label="Add caption"]');
    if (!button) throw new Error('missing caption button');
    keydown(rendered, button, 'Enter');
    keydown(rendered, button, 'Backspace');
    expect(calls.enter ?? 0).toBe(0);
    expect(calls.backspace ?? 0).toBe(0);
  });

  test('does not mutate when read-only, but still navigates', () => {
    const { rendered, calls } = render({ readOnly: true });
    const el = shell(rendered);
    keydown(rendered, el, 'Enter');
    keydown(rendered, el, 'Backspace');
    keydown(rendered, el, 'Tab');
    keydown(rendered, el, 'ArrowDown');
    expect(calls.enter ?? 0).toBe(0);
    expect(calls.backspace ?? 0).toBe(0);
    expect(calls.tab ?? 0).toBe(0);
    expect(calls.arrowDown).toBe(1);
  });

  test('consumes a focus request aimed at its target', () => {
    const target = rowFocusTarget('img1', null, null);
    const request: FocusRequest = { target, placement: cursorEnd() };
    const { consumed } = render({ focusRequest: request });
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toBe(request);
  });

  test('ignores a focus request for a different node', () => {
    const request: FocusRequest = { target: rowFocusTarget('other', null, null), placement: cursorEnd() };
    const { consumed } = render({ focusRequest: request });
    expect(consumed).toHaveLength(0);
  });
});
