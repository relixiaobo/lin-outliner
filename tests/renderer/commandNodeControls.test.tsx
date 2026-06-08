import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { buildScheduleString, CommandNodeControls } from '../../src/renderer/ui/outliner/CommandNodeControls';
import { getMessages } from '../../src/core/i18n';

const labels = getMessages('en').outliner.field.command;

// The editor form → canonical schedule string. This is the load-bearing logic
// (it feeds the user-only set_command_schedule write); driving the controlled
// <input>/<select> through linkedom doesn't reliably propagate React's value
// tracker, so the form mapping is asserted directly here and the button wiring
// below covers the component.
describe('buildScheduleString', () => {
  test('a one-off uses the date (+ time) with no rule', () => {
    expect(buildScheduleString({ date: '2026-06-09', time: '', preset: 'none', until: '' })).toBe('2026-06-09');
    expect(buildScheduleString({ date: '2026-06-09', time: '09:00', preset: 'none', until: '' }))
      .toBe('2026-06-09T09:00');
  });

  test('presets map to the canonical RRULE subset', () => {
    expect(buildScheduleString({ date: '2026-06-09', time: '09:00', preset: 'daily', until: '' }))
      .toBe('2026-06-09T09:00 RRULE:FREQ=DAILY');
    expect(buildScheduleString({ date: '2026-06-09', time: '09:00', preset: 'weekdays', until: '' }))
      .toBe('2026-06-09T09:00 RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(buildScheduleString({ date: '2026-06-09', time: '09:00', preset: 'monthly', until: '2026-12-31' }))
      .toBe('2026-06-09T09:00 RRULE:FREQ=MONTHLY;UNTIL=2026-12-31');
  });

  test('returns null without a date', () => {
    expect(buildScheduleString({ date: '', time: '09:00', preset: 'daily', until: '' })).toBeNull();
  });
});

interface Rendered {
  cleanup: () => void;
  scheduleWrites: (string | null)[];
  runs: number;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('CommandNodeControls', () => {
  test('shows "Enable schedule" when manual-only and the human summary when armed', () => {
    const manual = render(null);
    expect(textButton(manual, labels.enableSchedule)).toBeTruthy();

    const armed = render('2026-06-09T09:00 RRULE:FREQ=DAILY');
    expect(textButton(armed, 'Every day at 09:00')).toBeTruthy();
  });

  test('opening the editor reveals the schedule form', async () => {
    const rendered = render(null);
    expect(rendered.document.querySelector('.command-schedule-editor')).toBeNull();
    await click(rendered, textButton(rendered, labels.enableSchedule));
    expect(rendered.document.querySelector('.command-schedule-editor')).toBeTruthy();
    expect(rendered.document.querySelector('input[type="date"]')).toBeTruthy();
  });

  test('clearing an armed schedule writes null (manual-only)', async () => {
    const rendered = render('2026-06-09T09:00 RRULE:FREQ=DAILY');
    await click(rendered, textButton(rendered, 'Every day at 09:00'));
    await click(rendered, textButton(rendered, labels.clear));
    expect(rendered.scheduleWrites.at(-1)).toBeNull();
  });

  test('Run now fires the attended run without touching the schedule', async () => {
    const rendered = render('2026-06-09T09:00 RRULE:FREQ=DAILY');
    await click(rendered, textButton(rendered, labels.runNow));
    expect(rendered.runs).toBe(1);
    expect(rendered.scheduleWrites).toHaveLength(0);
  });
});

function render(schedule: string | null): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root')!;
  const scheduleWrites: (string | null)[] = [];
  let runs = 0;
  const root = createRoot(container);
  act(() => {
    root.render(
      <CommandNodeControls
        schedule={schedule}
        labels={labels}
        onSetSchedule={(next) => scheduleWrites.push(next)}
        onRunNow={() => { runs += 1; }}
      />,
    );
  });
  const rendered: Rendered = {
    cleanup: () => act(() => root.unmount()),
    get scheduleWrites() { return scheduleWrites; },
    get runs() { return runs; },
    document,
    window,
  };
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

async function click(rendered: Rendered, element: Element | null) {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
}

function textButton(rendered: Rendered, text: string): HTMLButtonElement {
  const found = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
