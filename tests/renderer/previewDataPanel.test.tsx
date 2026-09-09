import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { PreviewDataPanel } from '../../src/renderer/ui/agent/PreviewDataPanel';
import type { DataOperationView, PreviewDataStatus } from '../../src/core/previewOperations';

const originals = new Map<string, PropertyDescriptor | undefined>();
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  originals.clear();
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const status = (): PreviewDataStatus => ({
  translations: {
    entries: { page: 3, caption: 2, document: 1 },
    logicalBytes: 200,
    maxBytes: 1000,
    maxEntries: 100,
  },
  websites: { available: true, cacheBytes: 100, activeGuests: 2 },
  operations: [],
});
const outcome = (
  state: DataOperationView['state'],
  extra: Partial<DataOperationView> = {},
): DataOperationView => ({
  operationId: 'operation',
  scope: 'translations',
  state,
  liveDisplays: 'retained',
  steps: [],
  ...extra,
});

async function mount(
  options: {
    clear?: () => Promise<DataOperationView>;
    read?: () => Promise<PreviewDataStatus>;
  } = {},
) {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Event',
    'Node',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === 'window'
          ? window
          : key === 'document'
            ? document
            : key === 'IS_REACT_ACT_ENVIRONMENT'
              ? true
              : window[key],
    });
  }
  let changed: (() => void) | undefined;
  let subscribed = true;
  Object.assign(window, {
    lin: {
      previewOperation: async (name: string) =>
        name === 'data_inspect'
          ? (options.read?.() ?? status())
          : (options.clear?.() ?? outcome('cleared')),
      onPreviewDataChanged: (listener: () => void) => {
        changed = listener;
        return () => {
          subscribed = false;
        };
      },
    },
  });
  const root = createRoot(document.getElementById('root')!);
  unmount = () => act(() => root.unmount());
  await act(async () => {
    root.render(<PreviewDataPanel />);
    await settle();
  });
  return {
    document,
    changed: async () =>
      act(async () => {
        changed?.();
        await settle();
      }),
    subscribed: () => subscribed,
  };
}

test('reports usage and keeps stable busy rows through a completed clear', async () => {
  let complete!: (value: DataOperationView) => void;
  const rendered = await mount({
    clear: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  expect(rendered.document.body.textContent).toContain('6 saved passages · 200 B');
  expect(rendered.document.body.textContent).toContain('100 B cached · 2 open previews');
  const button = rendered.document.querySelector<HTMLButtonElement>('button')!;
  const rows = [...rendered.document.querySelectorAll('.inset-row')];
  await act(async () => {
    button.click();
    await settle();
  });
  expect(button.disabled).toBe(true);
  const websiteButton = rendered.document.querySelectorAll('button')[1]!;
  expect(websiteButton.textContent).toBe('Clear…');
  expect(button.textContent).toBe('Clearing…');
  expect([...rendered.document.querySelectorAll('.inset-row')]).toEqual(rows);
  await act(async () => {
    complete(outcome('cleared'));
    await settle();
  });
  expect(button.disabled).toBe(false);
  expect(rendered.document.querySelector('[role="status"]')?.textContent).toBe(
    'Saved translations cleared.',
  );
  expect(rows[0]!.querySelector('[role="status"]')?.textContent).toBe('Saved translations cleared.');
  expect(rows[1]!.querySelector('[role="status"]') === null).toBe(true);
});

test('native cancellation is inert and partial failure is not reported as success', async () => {
  let result = outcome('canceled');
  const rendered = await mount({ clear: async () => result });
  const button = rendered.document.querySelector<HTMLButtonElement>('button')!;
  await act(async () => {
    button.click();
    await settle();
  });
  expect(rendered.document.querySelector('[role="status"], [role="alert"]')).toBeNull();
  result = outcome('failed', { steps: [{ name: 'saved_translations', state: 'failed' }] });
  await act(async () => {
    button.click();
    await settle();
  });
  expect(rendered.document.querySelector('[role="alert"]')?.textContent).toBe(
    'Could not clear saved translations.',
  );
});

test('narrow notifications expose Agent operations and distinguish deletion from reload failure', async () => {
  const current = status();
  const rendered = await mount({ read: async () => structuredClone(current) });
  current.operations = [outcome('running', { scope: 'websites' })];
  await rendered.changed();
  expect(rendered.document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  current.operations = [outcome('cleared', { scope: 'websites', liveDisplays: 'reload_failed' })];
  current.websites.cacheBytes = 0;
  await rendered.changed();
  expect(rendered.document.querySelector('[role="alert"]')?.textContent).toBe(
    'Website data cleared, but a preview could not be reloaded.',
  );
  expect(rendered.document.body.textContent).toContain('0 B cached');
});

test('retains separate translation and website outcomes across owner notifications', async () => {
  const current = status();
  const rendered = await mount({ read: async () => structuredClone(current) });
  current.operations = [outcome('failed', { operationId: 'translations:first' })];
  await rendered.changed();
  current.operations.push(outcome('cleared', { operationId: 'websites:second', scope: 'websites' }));
  await rendered.changed();
  const rows = [...rendered.document.querySelectorAll('.inset-row')];
  expect(rows[0]!.querySelector('[role="alert"]')?.textContent).toBe('Could not clear saved translations.');
  expect(rows[1]!.querySelector('[role="status"]')?.textContent).toBe('Website data cleared.');
  current.operations.push(outcome('running', { operationId: 'content:third', scope: 'content' }));
  await rendered.changed();
  expect([...rendered.document.querySelectorAll('button')].every((button) => !button.disabled)).toBe(true);
  expect(rows[0]!.querySelector('[role="alert"]')?.textContent).toBe('Could not clear saved translations.');
});

test('failed inspection can retry without exposing raw errors, and unmount unsubscribes', async () => {
  let failed = true;
  const rendered = await mount({
    read: async () => {
      if (failed) throw new Error('/private/secret');
      return status();
    },
  });
  expect(rendered.document.body.textContent).not.toContain('/private/secret');
  failed = false;
  await act(async () => {
    rendered.document.querySelector<HTMLButtonElement>('[aria-label="Retry"]')!.click();
    await settle();
  });
  expect(rendered.document.querySelector('[role="alert"]')).toBeNull();
  expect(rendered.document.body.textContent).toContain('6 saved passages');
  unmount?.();
  unmount = undefined;
  expect(rendered.subscribed()).toBe(false);
});

test('late inspection cannot replace a newer notification or update an unmounted panel', async () => {
  let finish!: (value: PreviewDataStatus) => void;
  let reads = 0;
  const rendered = await mount({
    read: () =>
      ++reads === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(status()),
  });
  await rendered.changed();
  await act(async () => {
    finish({ ...status(), translations: { ...status().translations, logicalBytes: 999 } });
    await settle();
  });
  expect(rendered.document.body.textContent).toContain('200 B');
  expect(rendered.document.body.textContent).not.toContain('999');
  unmount?.();
  unmount = undefined;
  await rendered.changed();
  expect(rendered.document.querySelector('.agent-settings-section')).toBeNull();
});
