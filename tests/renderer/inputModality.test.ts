import { afterEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { installInputModalityTracking } from '../../src/renderer/ui/focus/inputModality';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('input modality tracking', () => {
  test('starts in pointer modality and switches on keyboard navigation', () => {
    const rendered = renderDocument();
    expect(rendered.document.documentElement.dataset.inputModality).toBe('pointer');

    keydown(rendered, rendered.document.body, 'Tab');
    expect(rendered.document.documentElement.dataset.inputModality).toBe('keyboard');

    pointerdown(rendered, rendered.document.body);
    expect(rendered.document.documentElement.dataset.inputModality).toBe('pointer');
  });

  test('does not treat caret movement inside text controls as keyboard focus navigation', () => {
    const rendered = renderDocument('<input id="name" value="alpha"><textarea id="body">beta</textarea>');
    const input = rendered.document.getElementById('name');
    const textarea = rendered.document.getElementById('body');
    if (!input || !textarea) throw new Error('Missing text controls');

    keydown(rendered, input, 'ArrowLeft');
    expect(rendered.document.documentElement.dataset.inputModality).toBe('pointer');

    keydown(rendered, textarea, 'Home');
    expect(rendered.document.documentElement.dataset.inputModality).toBe('pointer');

    keydown(rendered, input, 'a');
    expect(rendered.document.documentElement.dataset.inputModality).toBe('pointer');
  });

  test('treats arrow navigation on non-text controls as keyboard modality', () => {
    const rendered = renderDocument('<button id="move">Move</button>');
    const button = rendered.document.getElementById('move');
    if (!button) throw new Error('Missing button');

    keydown(rendered, button, 'ArrowDown');
    expect(rendered.document.documentElement.dataset.inputModality).toBe('keyboard');
  });

  test('treats control activation keys as keyboard modality before programmatic focus', () => {
    const rendered = renderDocument('<button id="open">Open</button>');
    const button = rendered.document.getElementById('open');
    if (!button) throw new Error('Missing button');

    keydown(rendered, button, 'Enter');
    expect(rendered.document.documentElement.dataset.inputModality).toBe('keyboard');
  });

  test('treats number input steppers as keyboard modality', () => {
    const rendered = renderDocument('<input id="count" type="number" value="1">');
    const input = rendered.document.getElementById('count');
    if (!input) throw new Error('Missing number input');

    keydown(rendered, input, 'ArrowUp');
    expect(rendered.document.documentElement.dataset.inputModality).toBe('keyboard');
  });
});

function renderDocument(body = '') {
  const { document, window } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  installDomGlobals(window);
  cleanups.push(installInputModalityTracking(document));
  return { document, window };
}

function keydown(rendered: { window: Window }, target: Element, key: string) {
  const event = new rendered.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string };
  event.key = key;
  target.dispatchEvent(event);
}

function pointerdown(rendered: { window: Window }, target: Element) {
  target.dispatchEvent(new rendered.window.Event('pointerdown', { bubbles: true, cancelable: true }));
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    window,
  });
}
