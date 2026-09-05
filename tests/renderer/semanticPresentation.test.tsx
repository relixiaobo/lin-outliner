import { describe, expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Core } from '../../src/core/core';
import { nodeObjectForRow, presentObject } from '../../src/core/actions/objects';
import { stableObjectsFor } from '../../src/core/actions/surfaceObjects';
import {
  ACTION_IDS, type ActionArguments, type ActionId, type ActionPresentation,
  type ActionPresentationFor, type ActionProjection, type ObjectPresentation, type ObjectRef,
} from '../../src/core/actions/types';
import { ActionGlyph, iconForAction } from '../../src/renderer/ui/presentation/actionIcons';
import { ObjectGlyph } from '../../src/renderer/ui/presentation/ObjectGlyph';
import { previewOpenAction } from '../../src/renderer/ui/preview/previewOpenAction';

const ref = 'opaque-ref' as ObjectRef;
const names = { en: 'Same title', 'zh-Hans': 'Same title' };
const common = { objectRef: ref, name: { source: 'localized' as const, values: names }, typeLabel: names };

function action<K extends ActionId>(actionId: K, args: ActionArguments[K]): ActionPresentationFor<K> {
  return {
    actionId, subjectRef: ref, names, aliases: [], surfaces: ['contextMenu'],
    evaluation: { status: 'applicable' }, binding: { state: 'ready', arguments: args },
  };
}

const cases = [
  [action('open', {}), 'Navigate'], [action('openInSplitPane', {}), 'SplitPane'],
  [action('setPinned', { pinned: true }), 'Pin'], [action('setPinned', { pinned: false }), 'Unpin'],
  [action('sendToAgent', {}), 'Agent'], [action('duplicate', {}), 'Duplicate'],
  [action('move', { relative: 'up' }), 'MoveUp'], [action('move', { relative: 'down' }), 'MoveDown'],
  [action('move', { destination: ref }), 'MoveTo'],
  [action('setDone', { done: true }), 'MarkDone'], [action('setDone', { done: false }), 'Checkbox'],
  [action('addTag', { tag: ref }), 'Supertag'],
  [action('setViewMode', { mode: 'outline' }), 'Outline'], [action('setViewMode', { mode: 'table' }), 'Table'],
  [action('setViewToolbarVisible', { visible: true }), 'ShowToolbar'],
  [action('setViewToolbarVisible', { visible: false }), 'HideToolbar'],
  [action('editViewSection', { section: 'filter' }), 'Filter'],
  [action('editViewSection', { section: 'sort' }), 'SortAsc'],
  [action('editViewSection', { section: 'group' }), 'Group'],
  [action('editViewSection', { section: 'display' }), 'Field'],
  [action('editDescription', {}), 'Description'], [action('copy', { representation: 'text' }), 'Copy'],
  [action('remove', {}), 'Trash'], [action('restore', {}), 'Restore'],
  [action('deleteForever', {}), 'Trash'], [action('emptyTrash', {}), 'Trash'],
  [action('capture', { destination: ref }), 'AddChild'], [action('create', { destination: ref }), 'AddChild'],
  [action('indent', {}), 'Indent'], [action('outdent', {}), 'Outdent'],
] as const;

describe('action glyphs follow desired effects', () => {
  test('covers every live action family', () => {
    expect([...new Set(cases.map(([item]) => item.actionId))].sort()).toEqual([...ACTION_IDS].sort());
    for (const [item, expected] of cases) {
      expect(renderToStaticMarkup(<ActionGlyph action={item} />)).toContain(`data-icon="${expected}"`);
    }
  });

  test('rejection retains the action meaning', () => {
    const item = action('openInSplitPane', {});
    expect(iconForAction({ ...item, evaluation: { status: 'rejected', reason: names } } as ActionPresentation)).toBe(iconForAction(item));
  });

  test('parameter selection retains the family without assuming a completed binding', () => {
    const parameter = { parameterId: 'destination' as const, objectKinds: ['node'] as const, title: names, inputLabel: names, placeholder: names };
    const move: ActionPresentation = { ...action('move', { destination: ref }), binding: { state: 'needsParameter', seed: {}, parameter } };
    expect(renderToStaticMarkup(<ActionGlyph action={move} />)).toContain('data-icon="MoveTo"');
    const tag: ActionPresentation = {
      ...action('addTag', { tag: ref }),
      binding: { state: 'needsParameter', seed: {}, parameter: { ...parameter, parameterId: 'tag' } },
    };
    expect(renderToStaticMarkup(<ActionGlyph action={tag} />)).toContain('data-icon="Supertag"');
  });
});

describe('shared object presentation', () => {
  test('identical names cannot change object identity', () => {
    const objects: Array<[ObjectPresentation, string]> = [
      [{ ...common, kind: 'node', node: { kind: 'system', key: 'today' } }, 'Calendar'],
      [{ ...common, kind: 'node', node: { kind: 'document', nodeType: 'tagDef' } }, 'Supertag'],
      [{ ...common, kind: 'nodeSelection' }, 'Outline'],
      [{ ...common, kind: 'draft', purpose: 'tag' }, 'Draft'],
      [{ ...common, kind: 'draft', purpose: 'node' }, 'Draft'],
      [{ ...common, kind: 'appSurface', surface: 'settings' }, 'Settings'],
      [{ ...common, kind: 'appSurface', surface: 'mainWindow' }, 'AppWindow'],
      [{ ...common, kind: 'externalPage', sourceKind: 'web' }, 'WebPage'],
      [{ ...common, kind: 'externalPage', sourceKind: 'application' }, 'AppWindow'],
      [{ ...common, kind: 'externalPage', sourceKind: 'unknown' }, 'AppWindow'],
    ];
    for (const [object, expected] of objects) {
      expect(renderToStaticMarkup(<ObjectGlyph object={object} />)).toContain(`data-icon="${expected}"`);
      expect(renderToStaticMarkup(<ObjectGlyph object={{ ...object, name: { source: 'literal', value: 'Unrelated name' } }} />)).toContain(`data-icon="${expected}"`);
    }
  });

  test('real producers preserve system identity and ordinary documents', () => {
    const core = Core.new();
    const projection = core.projection();
    const snapshot: ActionProjection = { ...projection, byId: new Map(projection.nodes.map(node => [node.id, node])) };
    for (const object of stableObjectsFor({ query: '', mintRef: () => ref })) {
      const presentation = presentObject(object, snapshot, 'Untitled');
      expect(renderToStaticMarkup(<ObjectGlyph object={presentation} />)).toContain('data-icon=');
      expect(presentation).not.toHaveProperty('iconId');
    }
    const missing = presentObject(nodeObjectForRow('missing', snapshot.byId, () => ref), snapshot, 'Untitled');
    expect(missing).toMatchObject({ kind: 'node', node: { kind: 'document', nodeType: null } });
    expect(renderToStaticMarkup(<ObjectGlyph object={missing} />)).toContain('object-glyph-bullet');
    expect(renderToStaticMarkup(<ObjectGlyph object={{ ...missing, emoji: '\u{1F4CC}' }} />)).toContain('object-glyph-emoji');
  });

  test('unexpected inspection data keeps its slot and records a diagnostic', () => {
    const diagnostic = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const markup = renderToStaticMarkup(<ObjectGlyph object={{ ...common, kind: 'node' } as ObjectPresentation} />);
      expect(markup).toContain('object-glyph-empty');
      expect(diagnostic).toHaveBeenCalled();
    } finally { diagnostic.mockRestore(); }
  });
});

test('preview opening resolves the label, glyph and callback together', () => {
  let calls = 0;
  const labels = { openInBrowser: 'Browser', openWithDefault: 'Default app' };
  for (const [kind, label, icon] of [['url', 'Browser', 'OpenInBrowser'], ['file', 'Default app', 'OpenInDefaultApp']] as const) {
    const resolved = previewOpenAction({ kind }, labels, () => { calls++; });
    expect(resolved.label).toBe(label);
    expect(renderToStaticMarkup(<resolved.icon />)).toContain(`data-icon="${icon}"`);
    resolved.run();
  }
  expect(calls).toBe(2);
});
