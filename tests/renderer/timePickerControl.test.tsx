import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TimePickerControl } from '../../src/renderer/ui/primitives/TimePickerControl';

interface RenderedTimePicker {
  cleanup: () => void;
  document: Document;
  values: string[];
  window: Window;
}

const mounted: RenderedTimePicker[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('TimePickerControl', () => {
  test('accepts and normalizes direct HH:mm entry', async () => {
    const rendered = renderTimePicker('09:05');
    const input = timeInput(rendered);

    await changeInput(rendered, input, '9:17');

    expect(rendered.values.at(-1)).toBe('09:17');
    expect(input.value).toBe('09:17');
  });

  test('selects any hour and minute from the nested tokenized popover', async () => {
    const rendered = renderTimePicker('09:05');

    await click(rendered, rendered.document.querySelector('button[aria-label="Choose time"]'));

    const dialog = rendered.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Time picker"]');
    expect(dialog?.getAttribute('data-dialog-nested-overlay')).toBe('true');
    const listboxes = dialog?.querySelectorAll<HTMLElement>('[role="listbox"]');
    expect(listboxes).toHaveLength(2);

    await click(rendered, findOption(listboxes?.[0], '10'));
    await click(rendered, findOption(listboxes?.[1], '17'));

    expect(rendered.values.slice(-2)).toEqual(['10:05', '10:17']);
    expect(timeInput(rendered).value).toBe('10:17');
    expect(rendered.document.querySelector('[role="dialog"][aria-label="Time picker"]')).toBeNull();
  });

  test('supports keyboard changes in both columns', async () => {
    const rendered = renderTimePicker('09:05');
    await click(rendered, rendered.document.querySelector('button[aria-label="Choose time"]'));
    const listboxes = rendered.document.querySelectorAll<HTMLElement>('.time-picker-list');

    await keyDown(rendered, listboxes[0], 'ArrowDown');
    await keyDown(rendered, listboxes[1], 'ArrowUp');

    expect(rendered.values.slice(-2)).toEqual(['10:05', '10:04']);
  });

  test('uses wheel input to change a focused column without a visible scrollbar', async () => {
    const rendered = renderTimePicker('09:05');
    await click(rendered, rendered.document.querySelector('button[aria-label="Choose time"]'));
    const listboxes = rendered.document.querySelectorAll<HTMLElement>('.time-picker-list');

    await wheel(rendered, listboxes[0], 28);
    await wheel(rendered, listboxes[1], -28);

    expect(rendered.values.slice(-2)).toEqual(['10:05', '10:04']);
  });
});

function renderTimePicker(initialValue: string): RenderedTimePicker {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const values: string[] = [];
  const root: Root = createRoot(container);

  function Harness() {
    const [value, setValue] = useState(initialValue);
    return (
      <TimePickerControl
        label="At"
        onValueChange={(nextValue) => {
          values.push(nextValue);
          setValue(nextValue);
        }}
        value={value}
      />
    );
  }

  act(() => root.render(<Harness />));
  const rendered = {
    cleanup: () => act(() => root.unmount()),
    document,
    values,
    window,
  } satisfies RenderedTimePicker;
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window): void {
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

async function click(rendered: RenderedTimePicker, element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
}

async function changeInput(
  rendered: RenderedTimePicker,
  element: HTMLInputElement,
  value: string,
): Promise<void> {
  await inputValue(rendered, element, value);
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('blur', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new rendered.window.Event('focusout', { bubbles: true, cancelable: true }));
  });
}

async function inputValue(
  rendered: RenderedTimePicker,
  element: HTMLInputElement,
  value: string,
): Promise<void> {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new rendered.window.Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new rendered.window.Event('change', { bubbles: true, cancelable: true }));
  });
}

async function keyDown(
  rendered: RenderedTimePicker,
  element: Element | undefined,
  key: string,
): Promise<void> {
  if (!element) throw new Error('Missing keyboard target');
  await act(async () => {
    const event = new rendered.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: key });
    element.dispatchEvent(event);
  });
}

async function wheel(
  rendered: RenderedTimePicker,
  element: Element | undefined,
  deltaY: number,
): Promise<void> {
  if (!element) throw new Error('Missing wheel target');
  await act(async () => {
    const event = new rendered.window.Event('wheel', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      deltaMode: { value: 0 },
      deltaY: { value: deltaY },
    });
    element.dispatchEvent(event);
  });
}

function timeInput(rendered: RenderedTimePicker): HTMLInputElement {
  const found = rendered.document.querySelector<HTMLInputElement>('input[aria-label="At"]');
  if (!found) throw new Error('Missing time input');
  return found;
}

function findOption(listbox: Element | null | undefined, label: string): Element | null {
  return Array.from(listbox?.querySelectorAll('[role="option"]') ?? [])
    .find((option) => option.textContent === label) ?? null;
}
