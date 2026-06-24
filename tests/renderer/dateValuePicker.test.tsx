import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { DateValuePicker } from '../../src/renderer/ui/outliner/DateValuePicker';

interface RenderedDateField {
  cleanup: () => void;
  commits: string[];
  container: HTMLElement;
  document: Document;
  window: Window;
}

const mounted: RenderedDateField[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

// DateValuePicker is the controlled date overlay summoned by a date value row
// (Space / a calendar affordance). It carries the same calendar logic the old
// whole-field control had, so the popover is rendered open from the start and
// the trigger step is dropped.
describe('DateValuePicker', () => {
  test('commits a single selected date', async () => {
    const rendered = renderDatePicker('2026-05-20');

    await click(rendered, button(rendered, 'Select 2026-05-21'));

    expect(lastCommit(rendered)).toBe('2026-05-21');
  });

  test('commits date ranges and swaps reversed endpoints', async () => {
    const rendered = renderDatePicker('2026-05-20');

    await click(rendered, button(rendered, 'End date'));
    expect(lastCommit(rendered)).toBe('2026-05-20/2026-05-20');

    await click(rendered, button(rendered, 'Select 2026-05-24'));
    expect(lastCommit(rendered)).toBe('2026-05-20/2026-05-24');

    await click(rendered, input(rendered, 'Start date'));
    await click(rendered, button(rendered, 'Select 2026-05-26'));
    expect(lastCommit(rendered)).toBe('2026-05-24/2026-05-26');
  });

  test('edits range dates from the summary inputs', async () => {
    const rendered = renderDatePicker('2026-05-20/2026-05-24');

    await changeInput(rendered, input(rendered, 'Start date'), '2026/05/22');

    expect(lastCommit(rendered)).toBe('2026-05-22/2026-05-24');
  });

  test('adds and edits time for single date values', async () => {
    const rendered = renderDatePicker('2026-05-20');

    await click(rendered, button(rendered, 'Include time'));
    expect(lastCommit(rendered)).toBe('2026-05-20T09:00');

    await changeInput(rendered, input(rendered, 'Start time'), '13:45');
    expect(lastCommit(rendered)).toBe('2026-05-20T13:45');

    await click(rendered, button(rendered, 'Select 2026-05-21'));
    expect(lastCommit(rendered)).toBe('2026-05-21T13:45');
  });

  test('initializes and edits datetime ranges', async () => {
    const rendered = renderDatePicker('2026-05-20T09:30/2026-05-24T17:00');

    expect(button(rendered, 'End date').getAttribute('aria-checked')).toBe('true');
    expect(input(rendered, 'Start time').value).toBe('09:30');
    expect(input(rendered, 'End time').value).toBe('17:00');

    await changeInput(rendered, input(rendered, 'End time'), '18:15');
    expect(lastCommit(rendered)).toBe('2026-05-20T09:30/2026-05-24T18:15');
  });

  test('clears the value', async () => {
    const rendered = renderDatePicker('2026-05-20T09:30');

    await click(rendered, textButton(rendered, 'Clear'));

    expect(lastCommit(rendered)).toBe('');
  });

  test('initializes the repeat control from a recurring value', () => {
    const rendered = renderDatePicker('2026-05-20T09:00 RRULE:FREQ=DAILY');

    const repeat = selectControl(rendered, 'typed-field-date-recurrence-select');
    expect(repeat.value).toBe('daily');
    expect(button(rendered, 'Ends').getAttribute('aria-checked')).toBe('false');
    expect(rendered.document.querySelectorAll('.typed-field-date-summary-row')).toHaveLength(1);
  });

  test('initializes and edits recurrence end dates behind the Ends switch', async () => {
    const rendered = renderDatePicker('2026-05-20T09:00 RRULE:FREQ=DAILY;UNTIL=2026-06-20');

    expect(button(rendered, 'Ends').getAttribute('aria-checked')).toBe('true');
    expect(untilInput(rendered).value).toBe('2026/06/20');

    await changeInput(rendered, untilInput(rendered), '2026/06/21');
    expect(lastCommit(rendered)).toBe('2026-05-20T09:00 RRULE:FREQ=DAILY;UNTIL=2026-06-21');

    await click(rendered, button(rendered, 'Ends'));
    expect(lastCommit(rendered)).toBe('2026-05-20T09:00 RRULE:FREQ=DAILY');
    expect(rendered.document.querySelectorAll('.typed-field-date-summary-row')).toHaveLength(1);
  });

  test('turns recurrence end dates on with a valid default', async () => {
    const rendered = renderDatePicker('2026-05-20 RRULE:FREQ=DAILY');

    await click(rendered, button(rendered, 'Ends'));

    expect(untilInput(rendered).value).toBe('2026/05/20');
    expect(lastCommit(rendered)).toBe('2026-05-20 RRULE:FREQ=DAILY;UNTIL=2026-05-20');
    expect(button(rendered, 'Select 2026-05-19').disabled).toBe(true);

    await changeInput(rendered, untilInput(rendered), '2026/05/19');
    expect(lastCommit(rendered)).toBe('2026-05-20 RRULE:FREQ=DAILY;UNTIL=2026-05-20');

    await click(rendered, button(rendered, 'Select 2026-05-21'));
    expect(lastCommit(rendered)).toBe('2026-05-20 RRULE:FREQ=DAILY;UNTIL=2026-05-21');
  });

  test('hides the repeat control for date ranges (a range never recurs)', () => {
    const rendered = renderDatePicker('2026-05-20/2026-05-24');

    expect(rendered.document.querySelector('.typed-field-date-recurrence')).toBeNull();
  });

  test('keeps the recurrence rule when the anchor date changes', async () => {
    const rendered = renderDatePicker('2026-05-20 RRULE:FREQ=DAILY');

    await click(rendered, button(rendered, 'Select 2026-05-21'));

    expect(lastCommit(rendered)).toBe('2026-05-21 RRULE:FREQ=DAILY');
  });

  test('supports date-only picker mode for bounded launchers', async () => {
    const rendered = renderDatePicker('2026-05-20', {
      allowTime: false,
      allowRecurrence: false,
      maxDate: '2026-05-20',
    });

    expect(rendered.document.querySelectorAll('.typed-field-date-summary-row')).toHaveLength(1);
    expect(textButtonMaybe(rendered, 'Include time')).toBeNull();
    expect(rendered.document.querySelector('.typed-field-date-recurrence-select')).toBeNull();
    expect(button(rendered, 'Select 2026-05-21').disabled).toBe(true);

    await click(rendered, button(rendered, 'Select 2026-05-19'));

    expect(lastCommit(rendered)).toBe('2026-05-19');
  });
});

function renderDatePicker(value: string, props: Partial<ComponentProps<typeof DateValuePicker>> = {}): RenderedDateField {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const commits: string[] = [];
  const root = createRoot(container);
  act(() => {
    root.render(
      <DateValuePicker
        anchorRef={{ current: container }}
        value={value}
        open
        onOpenChange={() => {}}
        onCommit={(nextValue) => commits.push(nextValue)}
        {...props}
      />,
    );
  });

  const rendered = {
    cleanup: () => {
      act(() => root.unmount());
    },
    commits,
    container,
    document,
    window,
  } satisfies RenderedDateField & { root?: Root };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window) {
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

async function click(rendered: RenderedDateField, element: Element | null) {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
}

async function changeInput(rendered: RenderedDateField, element: HTMLInputElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new rendered.window.Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new rendered.window.Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new rendered.window.Event('blur', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new rendered.window.Event('focusout', { bubbles: true, cancelable: true }));
  });
}

function button(rendered: RenderedDateField, ariaLabel: string): HTMLButtonElement {
  const found = rendered.document.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`);
  if (!found) throw new Error(`Missing button: ${ariaLabel}`);
  return found;
}

function textButton(rendered: RenderedDateField, text: string): HTMLButtonElement {
  const found = textButtonMaybe(rendered, text);
  if (!found) throw new Error(`Missing text button: ${text}`);
  return found;
}

function textButtonMaybe(rendered: RenderedDateField, text: string): HTMLButtonElement | null {
  return Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text) ?? null;
}

function input(rendered: RenderedDateField, ariaLabel: string): HTMLInputElement {
  const found = rendered.document.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
  if (!found) throw new Error(`Missing input: ${ariaLabel}`);
  return found;
}

function selectControl(rendered: RenderedDateField, className: string): HTMLSelectElement {
  const found = rendered.document.querySelector<HTMLSelectElement>(`select.${className}`);
  if (!found) throw new Error(`Missing select: ${className}`);
  return found;
}

function untilInput(rendered: RenderedDateField): HTMLInputElement {
  const found = rendered.document.querySelector<HTMLInputElement>('input[aria-label="Ends"]');
  if (!found) throw new Error('Missing recurrence until input');
  return found;
}

function lastCommit(rendered: RenderedDateField): string | undefined {
  return rendered.commits.at(-1);
}
