import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { CommandRunButton } from '../../src/renderer/ui/outliner/CommandFieldValue';
import { getMessages } from '../../src/core/i18n';

const labels = getMessages('en').outliner.field.command;

describe('CommandRunButton', () => {
  test('renders the Run label and fires onRun on click', () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    installDomGlobals(window);
    const doc = window.document;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container);
    let runs = 0;

    act(() => {
      root.render(<CommandRunButton labels={labels} onRun={() => { runs += 1; }} />);
    });
    const button = doc.querySelector<HTMLButtonElement>('.command-title-run');
    expect(button?.querySelector('.command-title-run-label')?.textContent).toBe(labels.runNow);
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute('data-run-state')).toBeNull();
    act(() => {
      button?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(runs).toBe(1);

    act(() => root.unmount());
  });
});

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
