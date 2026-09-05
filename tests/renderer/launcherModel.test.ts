import { describe, expect, test } from 'bun:test';
import {
  indexOfRef,
  navigableItems,
  objectRowView,
  presentedText,
  primaryActionLabel,
  resolveActiveRef,
  rowKey,
  stepActiveRef,
} from '../../src/renderer/launcher/launcherModel';
import type {
  ObjectRef,
  SurfaceItemPresentation,
} from '../../src/core/actions/types';

// The pure row/activity logic behind the command surface. Everything here is a
// projection of what MAIN resolved: the renderer has no object model of its own,
// which is why there is nothing left to test about "building" a result list.

function item(params: {
  ref: string;
  title: string;
  kind?: 'node' | 'externalPage';
  typeLabel?: string;
  subtitle?: string;
  primary?: string;
}): SurfaceItemPresentation {
  return {
    object: {
      objectRef: params.ref as ObjectRef,
      ...(params.kind === 'externalPage'
        ? { kind: 'externalPage' as const, sourceKind: 'web' as const }
        : { kind: 'node' as const, node: { kind: 'document' as const, nodeType: null } }),
      name: { source: 'literal', value: params.title },
      ...(params.subtitle ? { subtitle: { source: 'literal' as const, value: params.subtitle } } : {}),
      typeLabel: { en: params.typeLabel ?? 'Node', 'zh-Hans': params.typeLabel ?? '节点' },
    },
    ...(params.primary
      ? {
        primaryAction: {
          actionId: 'open',
          subjectRef: params.ref as ObjectRef,
          names: { en: params.primary, 'zh-Hans': `${params.primary}-zh` },
          aliases: [],
          surfaces: ['actionPanel'],
          evaluation: { status: 'applicable' },
          binding: { state: 'ready', arguments: {} },
        } as never,
      }
      : {}),
    actions: [],
  };
}

describe('object row view', () => {
  test('a user-authored title is LITERAL in every locale', () => {
    const row = item({ ref: 'a', title: 'Roadmap' });
    expect(objectRowView(row.object, 'en').title).toBe('Roadmap');
    // Never translated: it is what the user typed.
    expect(objectRowView(row.object, 'zh-Hans').title).toBe('Roadmap');
  });

  test('the type label classifies the NOUN and follows the locale', () => {
    const row = item({ ref: 'a', title: 'Roadmap' });
    expect(objectRowView(row.object, 'en').typeLabel).toBe('Node');
    expect(objectRowView(row.object, 'zh-Hans').typeLabel).toBe('节点');
  });

  test('the subtitle disambiguates same-named nodes', () => {
    const row = item({ ref: 'a', title: 'Notes', subtitle: 'Project Apollo' });
    expect(objectRowView(row.object, 'en').subtitle).toBe('Project Apollo');
  });

  test('a localized object name resolves per locale', () => {
    expect(presentedText({ source: 'localized', values: { en: 'Today', 'zh-Hans': '今天' } }, 'zh-Hans'))
      .toBe('今天');
  });
});

describe('the primary action label', () => {
  test('states the verb, never the row title', () => {
    const row = item({ ref: 'a', title: 'Today', primary: 'Open' });
    expect(primaryActionLabel(row, 'en')).toBe('Open');
  });

  test('is null when the object has no safe blind-Enter action', () => {
    // A multi-selection has no canonical activation, so Enter is inert and the
    // bar shows only the actions control.
    expect(primaryActionLabel(item({ ref: 'a', title: '3 nodes' }), 'en')).toBeNull();
    expect(primaryActionLabel(undefined, 'en')).toBeNull();
  });

  test('follows the active locale', () => {
    const row = item({ ref: 'a', title: 'Today', primary: 'Open' });
    expect(primaryActionLabel(row, 'zh-Hans')).toBe('Open-zh');
  });
});

describe('the navigable sequence', () => {
  const chip = item({ ref: 'chip', title: 'example.com', kind: 'externalPage', primary: 'Capture' });
  const first = item({ ref: 'r1', title: 'Alpha', primary: 'Open' });
  const second = item({ ref: 'r2', title: 'Beta', primary: 'Open' });

  test('the chip leads, then the current generation', () => {
    const items = navigableItems({ fixedItems: [chip], resultItems: [first, second] });
    expect(items.map(rowKey)).toEqual(['chip', 'r1', 'r2']);
  });

  test('a chip present before an explicit choice is active', () => {
    const items = navigableItems({ fixedItems: [chip], resultItems: [first] });
    expect(resolveActiveRef({ items, explicitRef: null })).toBe('chip' as ObjectRef);
  });

  test('with no chip the first current result is active', () => {
    const items = navigableItems({ fixedItems: [], resultItems: [first, second] });
    expect(resolveActiveRef({ items, explicitRef: null })).toBe('r1' as ObjectRef);
  });

  test('an explicitly chosen row survives while it is in the generation', () => {
    const items = navigableItems({ fixedItems: [chip], resultItems: [first, second] });
    expect(resolveActiveRef({ items, explicitRef: 'r2' as ObjectRef })).toBe('r2' as ObjectRef);
  });

  test('a superseded generation cannot leave activity on a vanished row', () => {
    // Refs are generation-scoped, so the old ref simply is not in the list and
    // activity falls back to the rule rather than pointing at nothing.
    const items = navigableItems({ fixedItems: [], resultItems: [first] });
    expect(resolveActiveRef({ items, explicitRef: 'gone' as ObjectRef })).toBe('r1' as ObjectRef);
  });

  test('an empty list has nothing to act on', () => {
    expect(resolveActiveRef({ items: [], explicitRef: null })).toBeNull();
  });
});

describe('stepping activity', () => {
  const first = item({ ref: 'r1', title: 'Alpha' });
  const second = item({ ref: 'r2', title: 'Beta' });
  const items = [first, second];

  test('moves down and clamps at the end', () => {
    expect(stepActiveRef(items, 'r1' as ObjectRef, 1)).toBe('r2' as ObjectRef);
    expect(stepActiveRef(items, 'r2' as ObjectRef, 1)).toBe('r2' as ObjectRef);
  });

  test('moves up and clamps at the start', () => {
    expect(stepActiveRef(items, 'r2' as ObjectRef, -1)).toBe('r1' as ObjectRef);
    expect(stepActiveRef(items, 'r1' as ObjectRef, -1)).toBe('r1' as ObjectRef);
  });

  test('an empty list yields nothing', () => {
    expect(stepActiveRef([], null, 1)).toBeNull();
  });

  test('indexOfRef reports absence rather than guessing', () => {
    expect(indexOfRef(items, 'gone' as ObjectRef)).toBe(-1);
    expect(indexOfRef(items, null)).toBe(-1);
  });
});
