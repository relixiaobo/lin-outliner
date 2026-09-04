import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { PreviewResolveSourceResult } from '../../src/core/preview';
import {
  sourcePreviewVisibleByDefault,
  type NodeSourceDescriptor,
} from '../../src/renderer/ui/preview/nodeSources';
import { useResolvedNodeSources } from '../../src/renderer/ui/preview/NodeSourcesSection';
import {
  resetNodeSourceViewStateForTests,
  useNodeSourceViewState,
} from '../../src/renderer/ui/preview/sourceViewState';

const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
let savedActEnvironment: PropertyDescriptor | undefined;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  resetNodeSourceViewStateForTests();
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  savedActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: parsed.window[key],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  container = parsed.document.getElementById('root') as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  resetNodeSourceViewStateForTests();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  if (savedActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', savedActEnvironment);
  } else {
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

describe('Node Sources renderer state', () => {
  test('ignores a stale Host resolution after the Source text changes', async () => {
    const oldRequest = deferred<PreviewResolveSourceResult>();
    const newRequest = deferred<PreviewResolveSourceResult>();
    Object.assign(window, {
      lin: {
        invoke: (_command: string, args?: Record<string, unknown>) => {
          const target = args?.target as { sourceText?: string } | undefined;
          return target?.sourceText?.includes('/old') ? oldRequest.promise : newRequest.promise;
        },
      },
    });

    await renderResolution([linkedSource('file:///tmp/old')]);
    expect(container.textContent).toContain('loading:file:///tmp/old');
    await renderResolution([linkedSource('file:///tmp/new')]);

    newRequest.resolve(linkedReady('file:///tmp/new', 'new.txt'));
    await act(async () => { await newRequest.promise; });
    expect(container.textContent).toBe('ready:new.txt:file:///tmp/new');

    oldRequest.resolve(linkedReady('file:///tmp/old', 'old.txt'));
    await act(async () => { await oldRequest.promise; });
    expect(container.textContent).toBe('ready:new.txt:file:///tmp/new');
  });

  test('keeps selection through reorder, falls back after deletion, and preserves preview visibility', async () => {
    let view: ReturnType<typeof useNodeSourceViewState> | null = null;
    const Probe = ({ ids }: { ids: readonly string[] }) => {
      const current = useNodeSourceViewState('owner', ids.map((id) => ({
        id,
        previewVisibleByDefault: true,
      })));
      useEffect(() => { view = current; }, [current]);
      return <output>{`${current.selectedValueId}:${current.previewVisible}`}</output>;
    };

    await act(async () => { root.render(<Probe ids={['source:a', 'source:b']} />); });
    act(() => view?.select('source:b'));
    expect(container.textContent).toBe('source:b:true');

    await act(async () => { root.render(<Probe ids={['source:b', 'source:a']} />); });
    expect(container.textContent).toBe('source:b:true');
    act(() => view?.setPreviewVisible(false));

    await act(async () => { root.render(<Probe ids={['source:a']} />); });
    expect(container.textContent).toBe('source:a:false');
  });

  test('shows the first Source after an owner returns from an empty state', async () => {
    let view: ReturnType<typeof useNodeSourceViewState> | null = null;
    const Probe = ({ ids }: { ids: readonly string[] }) => {
      const current = useNodeSourceViewState('owner', ids.map((id) => ({
        id,
        previewVisibleByDefault: true,
      })));
      useEffect(() => { view = current; }, [current]);
      return <output>{`${current.selectedValueId}:${current.previewVisible}`}</output>;
    };

    await act(async () => { root.render(<Probe ids={['source:a']} />); });
    act(() => view?.setPreviewVisible(false));
    await act(async () => { root.render(<Probe ids={[]} />); });
    expect(container.textContent).toBe('null:true');

    await act(async () => { root.render(<Probe ids={['source:new']} />); });
    expect(container.textContent).toBe('source:new:true');
  });

  test('derives the first visibility from Source strength and preserves an explicit choice', async () => {
    let view: ReturnType<typeof useNodeSourceViewState> | null = null;
    const Probe = ({ visibleByDefault }: { visibleByDefault: boolean }) => {
      const current = useNodeSourceViewState('owner', [{
        id: 'source:web',
        previewVisibleByDefault: visibleByDefault,
      }]);
      useEffect(() => { view = current; }, [current]);
      return <output>{String(current.previewVisible)}</output>;
    };

    await act(async () => { root.render(<Probe visibleByDefault={false} />); });
    expect(container.textContent).toBe('false');
    act(() => view?.show());
    expect(container.textContent).toBe('true');

    await act(async () => { root.render(<Probe visibleByDefault={false} />); });
    expect(container.textContent).toBe('true');
  });

  test('starts assets, linked files, and YouTube visible but generic webpages hidden', () => {
    expect(sourcePreviewVisibleByDefault(source('source:asset', {
      kind: 'asset',
      assetId: 'asset:1',
    }))).toBe(true);
    expect(sourcePreviewVisibleByDefault(source('source:file', {
      kind: 'linked-file',
      sourceValueId: 'source:file',
      sourceText: 'file:///tmp/report.pdf',
    }))).toBe(true);
    expect(sourcePreviewVisibleByDefault(source('source:youtube', {
      kind: 'url',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    }))).toBe(true);
    expect(sourcePreviewVisibleByDefault(source('source:web', {
      kind: 'url',
      url: 'https://example.com/article',
    }))).toBe(false);
  });
});

function ResolutionProbe({ values }: { values: readonly NodeSourceDescriptor[] }) {
  const [resolved] = useResolvedNodeSources(values, 0);
  if (!resolved) return null;
  return <output>{`${resolved.resolving ? 'loading' : resolved.availability}:${resolved.label}:${resolved.sourceText}`}</output>;
}

async function renderResolution(values: readonly NodeSourceDescriptor[]): Promise<void> {
  await act(async () => { root.render(<ResolutionProbe values={values} />); });
}

function linkedSource(sourceText: string): NodeSourceDescriptor {
  return {
    sourceValueId: 'source:value',
    sourceText,
    normalizedUri: sourceText,
    kind: 'file',
    label: sourceText,
    previewTarget: { kind: 'linked-file', sourceValueId: 'source:value', sourceText },
    availability: 'denied',
    reason: 'file-access-denied',
    actions: ['copy-uri', 'edit', 'authorize', 'replace', 'remove'],
  };
}

function source(
  sourceValueId: string,
  previewTarget: NonNullable<NodeSourceDescriptor['previewTarget']>,
): NodeSourceDescriptor {
  return {
    sourceValueId,
    sourceText: previewTarget.kind === 'url' ? previewTarget.url : sourceValueId,
    kind: previewTarget.kind === 'url' ? 'web' : 'file',
    label: sourceValueId,
    previewTarget,
    availability: 'ready',
    actions: ['preview'],
  };
}

function linkedReady(sourceText: string, name: string): PreviewResolveSourceResult {
  return {
    source: {
      kind: 'file',
      sourceKind: 'linked-file',
      id: `linked-file:source:value:${sourceText}`,
      target: { kind: 'linked-file', sourceValueId: 'source:value', sourceText },
      name,
      ext: 'txt',
      mimeType: 'text/plain',
      entryKind: 'file',
      sizeBytes: 1,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
