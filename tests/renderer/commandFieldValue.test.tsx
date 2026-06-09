import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  buildScheduleString,
  CommandAgentFieldValue,
  CommandRunButton,
  CommandScheduleFieldValue,
  scheduleChipSummary,
} from '../../src/renderer/ui/outliner/CommandFieldValue';
import type { CommandRunner } from '../../src/renderer/ui/shared';
import { getMessages } from '../../src/core/i18n';

const labels = getMessages('en').outliner.field.command;
// The schedule chip + the date editor draw their recurrence labels from the
// shared date-picker namespace (the editor is now the standard DateValuePicker).
const dateLabels = getMessages('en').outliner.field.datePicker;

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

  test('the custom preset preserves the original interval/byDay (no silent downgrade)', () => {
    // Opening the editor on an agent-proposed "every two weeks on Mon+Wed" and
    // saving (e.g. after tweaking the time) must keep the custom rule intact.
    const rule = { frequency: 'weekly' as const, interval: 2, byDay: ['MO' as const, 'WE' as const] };
    expect(buildScheduleString({ date: '2026-06-09', time: '09:00', preset: 'custom', until: '', rule }))
      .toBe('2026-06-09T09:00 RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  });
});

describe('scheduleChipSummary', () => {
  test('localizes the chip from the recurrence labels (never hardcoded English)', () => {
    expect(scheduleChipSummary('2026-06-09T09:00 RRULE:FREQ=DAILY', dateLabels)).toBe('Daily · 09:00');
    expect(scheduleChipSummary('2026-06-09T09:00 RRULE:FREQ=MONTHLY;UNTIL=2026-12-31', dateLabels))
      .toBe('Monthly · 09:00 · Ends 2026-12-31');
    expect(scheduleChipSummary('2026-06-09T09:00', dateLabels)).toBe('2026-06-09 09:00');
  });

  test('an interval reads as ×N — no "Every 2 weekday" grammar bug', () => {
    expect(scheduleChipSummary('2026-06-09T09:00 RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR', dateLabels))
      .toBe('Every weekday ×2 · 09:00');
  });

  test('localizes under zh-Hans (chip matches the dropdown locale)', () => {
    const zh = getMessages('zh-Hans').outliner.field.datePicker;
    expect(scheduleChipSummary('2026-06-09T09:00 RRULE:FREQ=DAILY', zh)).toBe('每天 · 09:00');
  });
});

// A stub bridge: every command the field editors fire (set_command_schedule /
// set_command_agent / the run flow) is recorded so writes are observable, and the
// agent listing resolves to a fixed registry for the picker.
const AGENT_DEFS = [
  { name: 'research', displayName: 'Research' },
  { name: 'writer', displayName: 'Writer' },
];

interface Rendered {
  cleanup: () => void;
  invokes: { name: string; args: Record<string, unknown> | undefined }[];
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];

beforeEach(() => {
  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  installDomGlobals(window);
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

const fieldLabels = getMessages('en').outliner.field;

describe('CommandScheduleFieldValue', () => {
  test('is blank with the standard date placeholder when empty, and shows the summary when armed', () => {
    const manual = render(CommandScheduleFieldValue, { schedule: null });
    // Empty reuses the standard date field's "Press Space to pick a date…" hint,
    // not a bespoke "Enable schedule…" control.
    expect(textButton(manual, fieldLabels.datePlaceholder)).toBeTruthy();
    const armed = render(CommandScheduleFieldValue, { schedule: '2026-06-09T09:00 RRULE:FREQ=DAILY' });
    // The Schedule value renders as a standard date value — plain summary text +
    // a calendar glyph — not a pill chip. (Both renders share one document body,
    // so match the armed summary by content.)
    const summaries = Array.from(armed.document.querySelectorAll('.command-field-value-label'))
      .map((node) => node.textContent);
    expect(summaries).toContain('Daily · 09:00');
  });

  test('the empty value opens the shared date editor', async () => {
    const rendered = render(CommandScheduleFieldValue, { schedule: null });
    expect(rendered.document.querySelector('.typed-field-date-popover')).toBeNull();
    await click(rendered, textButton(rendered, fieldLabels.datePlaceholder));
    // The schedule editor is the standard DateValuePicker (single-only: it carries
    // the Repeat control but no end-date/range toggle).
    expect(rendered.document.querySelector('.typed-field-date-popover')).toBeTruthy();
    expect(rendered.document.querySelector('.typed-field-date-recurrence-select')).toBeTruthy();
  });

  test('clicking the armed value opens the date editor', async () => {
    const rendered = render(CommandScheduleFieldValue, { schedule: '2026-06-09T09:00 RRULE:FREQ=DAILY' });
    expect(rendered.document.querySelector('.typed-field-date-popover')).toBeNull();
    await click(rendered, rendered.document.querySelector('.command-schedule-value'));
    const popover = rendered.document.querySelector('.typed-field-date-popover');
    expect(popover).toBeTruthy();
    // The armed daily rule is reflected in the Repeat control.
    const repeat = rendered.document.querySelector<HTMLSelectElement>('.typed-field-date-recurrence-select');
    expect(repeat?.value).toBe('daily');
  });

  test('clearing the schedule from the editor writes null via set_command_schedule', async () => {
    const rendered = render(CommandScheduleFieldValue, { schedule: '2026-06-09T09:00 RRULE:FREQ=DAILY' });
    await click(rendered, rendered.document.querySelector('.command-schedule-value'));
    await click(rendered, textButton(rendered, dateLabels.clear));
    const write = rendered.invokes.findLast((call) => call.name === 'set_command_schedule');
    expect(write?.args).toMatchObject({ nodeId: 'cmd', schedule: null });
  });

  // Run no longer lives in the Schedule value — it moved to the command title.
  test('does not render a Run action in the schedule value cell', () => {
    const rendered = render(CommandScheduleFieldValue, { schedule: '2026-06-09T09:00 RRULE:FREQ=DAILY' });
    expect(rendered.document.querySelector('.command-title-run')).toBeNull();
    const runButton = Array.from(rendered.document.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.trim() === labels.runNow);
    expect(runButton).toBeUndefined();
  });
});

// CommandRunButton is the title-start Run action: a labelled text button that
// never reflects the running state (that lives on the command bullet). The full
// attended-run orchestration (ensure → reveal → run) is exercised end-to-end in
// the e2e command-node spec; here we cover the pure button contract.
describe('CommandRunButton', () => {
  test('renders the Run label and fires onRun on click', () => {
    const win = globalThis.window as unknown as Window;
    const doc = win.document;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container);
    let runs = 0;

    act(() => {
      root.render(<CommandRunButton labels={labels} onRun={() => { runs += 1; }} />);
    });
    const button = doc.querySelector<HTMLButtonElement>('.command-title-run');
    expect(button?.querySelector('.command-title-run-label')?.textContent).toBe(labels.runNow);
    // No running/disabled state is reflected on the button.
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute('data-run-state')).toBeNull();
    act(() => {
      button?.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event('click', { bubbles: true }));
    });
    expect(runs).toBe(1);

    act(() => root.unmount());
  });
});

describe('CommandAgentFieldValue', () => {
  test('reflects the stored choice and lists Main agent plus every definition', async () => {
    const rendered = await renderAsync(CommandAgentFieldValue, { agent: 'research' });
    // The stored agent renders as plain value text (its displayName), standard
    // outliner style — not a pill <select>.
    const value = rendered.document.querySelector('.command-field-value-label');
    expect(value?.textContent).toBe('Research');

    await click(rendered, rendered.document.querySelector('.command-agent-value'));
    const popover = rendered.document.querySelector('.command-agent-popover');
    if (!popover) throw new Error('Missing agent popover');
    const items = Array.from(popover.querySelectorAll<HTMLButtonElement>('.popover-item'));
    expect(items.map((item) => item.textContent?.trim())).toEqual([labels.mainAgent, 'Research', 'Writer']);
    // The stored agent is marked selected in the listbox.
    const selected = items.find((item) => item.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent?.trim()).toBe('Research');
  });

  test('selecting an agent writes set_command_agent', async () => {
    const rendered = await renderAsync(CommandAgentFieldValue, { agent: null });
    await click(rendered, rendered.document.querySelector('.command-agent-value'));
    const popover = rendered.document.querySelector('.command-agent-popover');
    const writer = Array.from(popover?.querySelectorAll<HTMLButtonElement>('.popover-item') ?? [])
      .find((item) => item.textContent?.trim() === 'Writer');
    await click(rendered, writer ?? null);
    const write = rendered.invokes.findLast((call) => call.name === 'set_command_agent');
    expect(write?.args).toMatchObject({ nodeId: 'cmd', agent: 'writer' });
  });
});

type ScheduleProps = { schedule: string | null };
type AgentProps = { agent: string | null };

function render(
  Component: typeof CommandScheduleFieldValue,
  props: ScheduleProps,
): Rendered;
function render(
  Component: typeof CommandAgentFieldValue,
  props: AgentProps,
): Rendered;
function render(Component: (props: never) => JSX.Element, props: ScheduleProps | AgentProps): Rendered {
  const win = globalThis.window as unknown as Window;
  const doc = win.document;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const invokes: Rendered['invokes'] = [];
  installBridge(win, invokes);
  const run: CommandRunner = async (operation) => operation();
  const root = createRoot(container);
  act(() => {
    root.render(<Component {...({ nodeId: 'cmd', labels, run, ...props } as never)} />);
  });
  const rendered: Rendered = {
    cleanup: () => act(() => root.unmount()),
    invokes,
    document: doc,
    window: win,
  };
  mounted.push(rendered);
  return rendered;
}

// The agent picker fetches its options asynchronously (a cached IPC listing), so
// flush microtasks after mount before asserting the rendered <option>s.
async function renderAsync(
  Component: typeof CommandAgentFieldValue,
  props: AgentProps,
): Promise<Rendered> {
  const rendered = render(Component, props);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return rendered;
}

function installBridge(win: Window, invokes: Rendered['invokes']) {
  (win as unknown as { lin: unknown }).lin = {
    invoke: (name: string, args?: Record<string, unknown>) => {
      invokes.push({ name, args });
      if (name === 'agent_list_all_definitions') return Promise.resolve(AGENT_DEFS);
      if (name === 'agent_ensure_command_conversation' || name === 'agent_run_command_now') {
        return Promise.resolve({ conversationId: 'conv-cmd' });
      }
      return Promise.resolve({ ok: true });
    },
  };
  // The same bridge backs `api` (module reads the global `window`).
  (globalThis as unknown as { lin: unknown }).lin = (win as unknown as { lin: unknown }).lin;
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
    CustomEvent: window.CustomEvent,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

async function click(rendered: Rendered, element: Element | null) {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
  // Let any awaited write/run flow settle.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function textButton(rendered: Rendered, text: string): HTMLButtonElement {
  const found = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
