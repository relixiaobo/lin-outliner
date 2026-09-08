import { expect, test } from 'bun:test';
import { PreviewContext } from '../../src/renderer/ui/preview/previewContext';
import { previewOperationsBridge } from '../helpers/previewOperationsBridge';
import type { PreviewView } from '../../src/core/previewOperations';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function mount(pane: string, bridge: ReturnType<typeof previewOperationsBridge>['bridge']) {
  const context = new PreviewContext(pane, 'en');
  let locale: 'en' | 'zh-Hans' = 'en';
  context.observe({ kind: 'page', sourceId: 'same-source' });
  context.bindControls((controls) => ({
    effectiveLanguage: controls.language ?? locale,
    status: controls.display === 'translated' ? 'starting' : 'off',
  }));
  const disconnect = context.connect(bridge);
  return {
    context,
    disconnect,
    language: (next: typeof locale) => {
      locale = next;
      context.observe({ effectiveLanguage: context.read().controls.language ?? locale });
    },
  };
}

test('same-source previews have independent intent, navigation retains it, and reopening resets it', async () => {
  const { bridge } = previewOperationsBridge();
  const a = mount('a', bridge);
  const b = mount('b', bridge);
  await a.context.configure({ language: 'ja', automatic: true, display: 'translated' });
  expect(b.context.read().controls).toEqual({
    language: null,
    model: null,
    automatic: false,
    display: 'automatic',
  });
  a.context.observe({ sourceId: 'next-source' }, true);
  expect(a.context.read().controls).toMatchObject({
    language: 'ja',
    automatic: true,
    display: 'translated',
  });
  const before = (await bridge.previewOperation('preview_inspect', { request: {} })) as {
    previews: PreviewView[];
  };
  a.disconnect();
  const reopened = mount('a', bridge);
  await settle();
  const after = (await bridge.previewOperation('preview_inspect', { request: {} })) as {
    previews: PreviewView[];
  };
  expect(after.previews.find((preview) => preview.paneId === 'a')?.previewId).not.toBe(
    before.previews.find((preview) => preview.paneId === 'a')?.previewId,
  );
  expect(reopened.context.read().controls.language).toBeNull();
  b.disconnect();
  reopened.disconnect();
  await settle();
});

test('Follow UI is dynamic until pinned and can be restored explicitly', async () => {
  const { bridge } = previewOperationsBridge();
  const preview = mount('a', bridge);
  preview.language('zh-Hans');
  expect(preview.context.read().effectiveLanguage).toBe('zh-Hans');
  await preview.context.configure({ language: 'ja' });
  preview.language('en');
  expect(preview.context.read().effectiveLanguage).toBe('ja');
  await preview.context.configure({ language: null });
  expect(preview.context.read().effectiveLanguage).toBe('en');
  preview.disconnect();
});

test('rapid control patches serialize on acknowledged revisions without losing fields', async () => {
  const { bridge, controls } = previewOperationsBridge();
  const preview = mount('a', bridge);
  await Promise.all([
    preview.context.configure({ language: 'ja' }),
    preview.context.configure({ model: 'openai/gpt-4o' }),
    preview.context.configure({ automatic: true }),
  ]);
  expect(controls).toHaveLength(3);
  expect(preview.context.read().controls).toMatchObject({
    language: 'ja',
    model: 'openai/gpt-4o',
    automatic: true,
  });
  preview.disconnect();
});

test('rapid toggles evaluate against the preceding acknowledged state', async () => {
  const { bridge } = previewOperationsBridge();
  const preview = mount('a', bridge);
  const toggleAutomatic = () =>
    preview.context.configure((current) => ({ automatic: !current.controls.automatic }));
  await Promise.all([toggleAutomatic(), toggleAutomatic()]);
  expect(preview.context.read().controls.automatic).toBe(false);
  const toggleDisplay = () =>
    preview.context.configure((current) => ({
      display: current.status === 'off' ? 'translated' : 'original',
    }));
  await Promise.all([toggleDisplay(), toggleDisplay()]);
  expect(preview.context.read().controls.display).toBe('original');
  preview.disconnect();
});

test('queued controls do not apply to a different resource after navigation', async () => {
  const { bridge } = previewOperationsBridge();
  const preview = mount('a', bridge);
  const pending = preview.context.configure({ language: 'ja' });
  preview.context.observe({ sourceId: 'navigated' }, true);
  await expect(pending).rejects.toThrow('unavailable');
  expect(preview.context.read().controls.language).toBeNull();
  preview.disconnect();
});

test('missing acknowledgements report unknown without optimistic control state', async () => {
  const { bridge } = previewOperationsBridge();
  const preview = mount('a', { ...bridge, onPreviewAction: () => () => {} });
  await expect(preview.context.configure({ language: 'ja' })).rejects.toThrow('not acknowledged');
  expect(preview.context.read().controls.language).toBeNull();
  preview.disconnect();
});

test('disconnect during registration and StrictMode reconnect leave exactly one live identity', async () => {
  const { bridge } = previewOperationsBridge();
  const preview = mount('a', bridge);
  preview.disconnect();
  const disconnect = preview.context.connect(bridge);
  await settle();
  expect(await bridge.previewOperation('preview_inspect', { request: {} })).toMatchObject({
    previews: [{ paneId: 'a' }],
  });
  await preview.context.configure({ language: 'ja' });
  disconnect();
  await settle();
  expect(await bridge.previewOperation('preview_inspect', { request: {} })).toEqual({
    previews: [],
  });
});
