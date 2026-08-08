import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  ACTION_NOTICE_TIMEOUT_MS,
  ActionNotice,
  nextActionNotice,
} from '../../src/renderer/ui/ActionNotice';

interface Rendered {
  readonly cleanup: () => void;
  readonly document: Document;
  /** Every pending timer the component asked for, in order. */
  readonly timers: { readonly fire: () => void; readonly delay: number; cleared: boolean }[];
  readonly rerender: (onDismiss: () => void) => void;
  readonly window: Window;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('The app-wide action notice', () => {
  test('leaves on its own, so an event is not left standing as furniture', () => {
    let dismissed = 0;
    const rendered = render(() => { dismissed += 1; });

    expect(rendered.timers).toHaveLength(1);
    expect(rendered.timers[0]?.delay).toBe(ACTION_NOTICE_TIMEOUT_MS);
    act(() => rendered.timers[0]?.fire());
    expect(dismissed).toBe(1);
  });

  test('keeps counting across host re-renders that hand it a new callback', () => {
    // The shell re-renders on every keystroke in the outliner. An effect that
    // depended on the callback's identity would restart the countdown each
    // time and the notice would never leave — so the timer is set ONCE, and
    // firing it still reaches the newest callback.
    let dismissedBy = '';
    const rendered = render(() => { dismissedBy = 'first'; });
    for (const label of ['second', 'third']) {
      rendered.rerender(() => { dismissedBy = label; });
    }

    expect(rendered.timers).toHaveLength(1);
    act(() => rendered.timers[0]?.fire());
    expect(dismissedBy).toBe('third');
  });

  test('waits while the pointer is on it, and restarts once the pointer leaves', () => {
    let dismissed = 0;
    const rendered = render(() => { dismissed += 1; });
    const notice = rendered.document.querySelector('.action-notice');

    hover(rendered, notice, true);
    // Reading is not a reason to lose the text: the countdown is dropped, not
    // paused-then-resumed, so the reader is never left with a sliver of it.
    expect(rendered.timers[0]?.cleared).toBe(true);
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(0);

    hover(rendered, notice, false);
    const live = rendered.timers.filter((timer) => !timer.cleared);
    expect(live).toHaveLength(1);
    expect(live[0]?.delay).toBe(ACTION_NOTICE_TIMEOUT_MS);
    act(() => live[0]?.fire());
    expect(dismissed).toBe(1);
  });
});

describe('Notice sequencing', () => {
  test('restarts the countdown when the same failure is repeated', () => {
    const first = nextActionNotice(null, 'That did not work.');
    const second = nextActionNotice(first, 'That did not work.');

    // Same text, so only the sequence can tell React this is a new notice
    // rather than the one already on screen with its countdown half spent.
    expect(second?.message).toBe(first?.message ?? '');
    expect(second?.seq).not.toBe(first?.seq ?? -1);
  });

  test('clears on null, the signal an action sends before it starts', () => {
    expect(nextActionNotice(nextActionNotice(null, 'stale'), null)).toBeNull();
  });
});

function render(onDismiss: () => void): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const timers: Rendered['timers'] = [];
  const restoreTimers = installDomGlobals(window, timers);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  const draw = (dismiss: () => void) => {
    act(() => {
      root.render(<ActionNotice message="That did not work." onDismiss={dismiss} />);
    });
  };
  draw(onDismiss);
  const rendered: Rendered = {
    cleanup: () => {
      act(() => root.unmount());
      restoreTimers();
    },
    document,
    rerender: draw,
    timers,
    window,
  };
  mounted.push(rendered);
  return rendered;
}

/**
 * React synthesises enter/leave from delegated over/out events, so the raw
 * `mouseenter` a test would reach for never reaches the handler. With no
 * relatedTarget, React reads the pair as crossing the boundary — which is
 * exactly the case being tested.
 */
function hover(rendered: Rendered, element: Element | null, entering: boolean) {
  if (!element) throw new Error('Missing notice');
  act(() => {
    element.dispatchEvent(new rendered.window.Event(entering ? 'mouseover' : 'mouseout', {
      bubbles: true,
      cancelable: true,
    }));
  });
}

/**
 * Returns the undo, which the caller MUST run. The suite shares one process and
 * `globalThis.window` outlives this file, so a stub left behind would leave
 * every later test's timer waiting on a clock that never ticks — the suite goes
 * from 4s to 5 minutes and fails in places that have nothing to do with this.
 */
function installDomGlobals(window: Window, timers: Rendered['timers']): () => void {
  // Stubbed rather than faked wholesale: the assertions are about how MANY
  // timers the component sets and with what delay, which a clock that only
  // advances time cannot see.
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  const setTimeoutStub = (handler: () => void, delay: number) => {
    const timer = { cleared: false, delay, fire: handler };
    timers.push(timer);
    return timers.length;
  };
  const clearTimeoutStub = (id: number) => {
    const timer = timers[id - 1];
    if (timer) timer.cleared = true;
  };
  Object.assign(window, { clearTimeout: clearTimeoutStub, setTimeout: setTimeoutStub });
  Object.assign(globalThis, {
    document: window.document,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    Object.assign(window, { clearTimeout: realClearTimeout, setTimeout: realSetTimeout });
  };
}
