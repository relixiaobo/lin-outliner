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
  /** How many document-level move listeners are currently installed. */
  readonly moveListeners: () => number;
  readonly rerender: (onDismiss: () => void) => void;
  /** A newer failure arriving in the same slot: new message, next sequence. */
  readonly replace: (message: string) => void;
  readonly window: Window;
}

/** The rect the stubbed layout reports for the card, so the tests can aim. */
const CARD_RECT = { bottom: 100, left: 200, right: 500, top: 50 };
/** Mutable so a test can move the card the way the entry animation does. */
let cardRect = { ...CARD_RECT };

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  cardRect = { ...CARD_RECT };
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

  test('drops the countdown rather than resuming its remainder', () => {
    let dismissed = 0;
    const rendered = render(() => { dismissed += 1; });

    pointerMove(rendered, CARD_RECT.left + 20, CARD_RECT.top + 10);
    expect(rendered.timers[0]?.cleared).toBe(true);

    // Reading is not a reason to lose the text: leaving starts a FULL countdown
    // rather than handing back whatever was left of the first one.
    pointerMove(rendered, CARD_RECT.right + 40, CARD_RECT.top + 10);
    const live = rendered.timers.filter((timer) => !timer.cleared);
    expect(live).toHaveLength(1);
    expect(live[0]?.delay).toBe(ACTION_NOTICE_TIMEOUT_MS);
    act(() => live[0]?.fire());
    expect(dismissed).toBe(1);
  });

  test('waits while the pointer rests anywhere over the card, not just its control', () => {
    // The card is click-through, so it receives no hover events of its own and
    // the region has to be tested against its rect. Holding only on the 22px
    // close control would satisfy "hover holds" while making it useless: a
    // reader's pointer rests on the text, and a target that small is one you
    // have to aim for.
    const rendered = render(() => undefined);

    pointerMove(rendered, CARD_RECT.left + 20, CARD_RECT.top + 10);
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(0);

    pointerMove(rendered, CARD_RECT.left - 40, CARD_RECT.top + 10);
    const live = rendered.timers.filter((timer) => !timer.cleared);
    expect(live).toHaveLength(1);
    expect(live[0]?.delay).toBe(ACTION_NOTICE_TIMEOUT_MS);
  });

  test('remeasures when the entry animation stops moving it', () => {
    // The card slides in, and `transform` moves its rect. Measuring once at
    // mount catches it mid-slide, which would leave the hold region offset by
    // the animation's travel for as long as the notice is up.
    const rendered = render(() => undefined);
    const settled = { bottom: 160, left: 200, right: 500, top: 110 };
    cardRect = settled;

    pointerMove(rendered, settled.left + 20, settled.top + 10);
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(1);

    act(() => {
      rendered.document.querySelector('.action-notice')
        ?.dispatchEvent(new rendered.window.Event('animationend', { bubbles: true }));
    });
    pointerMove(rendered, settled.left + 20, settled.top + 10);
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
  });

  test('watches for the pointer only while there is something to hold', () => {
    // The listener is document-level, so one left behind per notice would
    // accumulate silently and keep answering for a card that is gone.
    const rendered = render(() => undefined);
    expect(rendered.moveListeners()).toBe(1);

    rendered.replace('A different failure.');
    expect(rendered.moveListeners()).toBe(1);

    rendered.cleanup();
    expect(rendered.moveListeners()).toBe(0);
    mounted.pop();
  });

  test('holds while its control has focus, so it cannot vanish under a Tab', () => {
    // Pointer-hold does not help a keyboard user: without this the countdown
    // unmounts the focused button and drops them to <body>, unable to reach
    // the control at all and having lost their place by trying.
    const rendered = render(() => undefined);
    const close = rendered.document.querySelector('.action-notice-close');

    focus(rendered, close, true);
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(0);

    focus(rendered, close, false);
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
  });

  test('keeps a hold across a replacement, which does not remount it', () => {
    // A pointer resting on the control does not move when a new failure
    // arrives, so no fresh enter event would re-establish a hold that a
    // remount had thrown away — the hold must outlive the notice it began on.
    const rendered = render(() => undefined);
    pointerMove(rendered, CARD_RECT.left + 20, CARD_RECT.top + 10);
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(0);

    rendered.replace('A different failure.');
    expect(rendered.document.querySelector('.action-notice')?.textContent)
      .toContain('A different failure.');
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
  });

  test('restarts the countdown when a replacement arrives unheld', () => {
    const rendered = render(() => undefined);
    const first = rendered.timers[0];

    rendered.replace('A different failure.');
    expect(first?.cleared).toBe(true);
    expect(rendered.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
  });
});

describe('Notice sequencing', () => {
  test('carries the caller\'s number rather than deriving one from the slot', () => {
    // The slot is empty far more often than not, so a sequence derived from it
    // would restart at 1 nearly every time. A repeat of the message already on
    // screen would then be identical to it in both fields, and the countdown
    // it is supposed to restart would simply carry on from where it was.
    const first = nextActionNotice('That did not work.', 7);
    const second = nextActionNotice('That did not work.', 8);

    expect(second?.message).toBe(first?.message ?? '');
    expect(second?.seq).not.toBe(first?.seq ?? -1);
  });

  test('says nothing when there is nothing to say', () => {
    // `new Error()` has an empty message, and both catch paths pass it through
    // verbatim; a blank card with a lone close button is worse than silence.
    expect(nextActionNotice(null, 1)).toBeNull();
    expect(nextActionNotice('', 2)).toBeNull();
    expect(nextActionNotice('   ', 3)).toBeNull();
  });
});

function render(onDismiss: () => void): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const timers: Rendered['timers'] = [];
  const moveListeners = new Set<EventListenerOrEventListenerObject>();
  const restoreTimers = installDomGlobals(window, timers, moveListeners);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  let message = 'That did not work.';
  let seq = 1;
  const draw = (dismiss: () => void) => {
    act(() => {
      root.render(<ActionNotice message={message} onDismiss={dismiss} seq={seq} />);
    });
  };
  let dismiss = onDismiss;
  draw(dismiss);
  const rendered: Rendered = {
    cleanup: () => {
      act(() => root.unmount());
      restoreTimers();
    },
    document,
    moveListeners: () => moveListeners.size,
    replace: (next: string) => {
      message = next;
      seq += 1;
      draw(dismiss);
    },
    rerender: (next: () => void) => {
      dismiss = next;
      draw(next);
    },
    timers,
    window,
  };
  mounted.push(rendered);
  return rendered;
}

/** A document-level move, which is where the hold is decided. */
function pointerMove(rendered: Rendered, clientX: number, clientY: number) {
  act(() => {
    const event = new rendered.window.Event('pointermove', { bubbles: true });
    Object.assign(event, { clientX, clientY });
    rendered.document.dispatchEvent(event);
  });
}

/**
 * Returns the undo, which the caller MUST run. The suite shares one process and
 * `globalThis.window` outlives this file, so a stub left behind would leave
 * every later test's timer waiting on a clock that never ticks — the suite goes
 * from 4s to 5 minutes and fails in places that have nothing to do with this.
 */
/** React derives focus/blur from the delegated focusin/focusout pair. */
function focus(rendered: Rendered, element: Element | null, entering: boolean) {
  if (!element) throw new Error('Missing control');
  act(() => {
    element.dispatchEvent(new rendered.window.Event(entering ? 'focusin' : 'focusout', {
      bubbles: true,
      cancelable: true,
    }));
  });
}

function installDomGlobals(
  window: Window,
  timers: Rendered['timers'],
  moveListeners: Set<EventListenerOrEventListenerObject>,
): () => void {
  // Stubbed rather than faked wholesale: the assertions are about how MANY
  // timers the component sets and with what delay, which a clock that only
  // advances time cannot see.
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  // linkedom has no layout, and the hold is a hit test against the card's rect,
  // so the rect has to come from somewhere. Restored with the timers below —
  // the same reason: this window outlives the file.
  const { document } = window;
  const realAdd = document.addEventListener.bind(document);
  const realRemove = document.removeEventListener.bind(document);
  document.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    if (type === 'pointermove') moveListeners.add(listener);
    realAdd(type, listener, options as never);
  };
  document.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    if (type === 'pointermove') moveListeners.delete(listener);
    realRemove(type, listener, options as never);
  };
  const realRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function rect(this: Element) {
    return this.classList?.contains('action-notice')
      ? { ...cardRect, height: 50, width: 300, x: cardRect.left, y: cardRect.top, toJSON: () => cardRect } as DOMRect
      : ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  };
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
    window.Element.prototype.getBoundingClientRect = realRect;
    Object.assign(document, { addEventListener: realAdd, removeEventListener: realRemove });
  };
}
