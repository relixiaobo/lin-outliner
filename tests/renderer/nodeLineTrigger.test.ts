import { describe, expect, test } from 'bun:test';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { pmSchema } from '../../src/renderer/ui/editor/pmSchema';
import { richTextToDoc } from '../../src/renderer/ui/editor/richTextCodec';
import { resolveNodeLineTrigger } from '../../src/renderer/ui/editor/nodeLineTrigger';
import type { RichText } from '../../src/renderer/api/types';

// Minimal fake view: resolveNodeLineTrigger only reads view.state; its one
// layout call (caretAnchor -> coordsAtPos) throws on the fake and is caught,
// yielding an undefined anchor — fine for asserting detection logic.
function viewAt(text: string, cursorOffset: number, inlineRefs: RichText['inlineRefs'] = []): EditorView {
  const doc = richTextToDoc({ text, marks: [], inlineRefs });
  const state = EditorState.create({ schema: pmSchema, doc, selection: TextSelection.create(doc, 1 + cursorOffset) });
  return { state } as unknown as EditorView;
}

function viewSelection(text: string, from: number, to: number): EditorView {
  const doc = richTextToDoc({ text, marks: [], inlineRefs: [] });
  const state = EditorState.create({ schema: pmSchema, doc, selection: TextSelection.create(doc, 1 + from, 1 + to) });
  return { state } as unknown as EditorView;
}

describe('resolveNodeLineTrigger', () => {
  test('detects a # tag trigger at the caret', () => {
    const trigger = resolveNodeLineTrigger(viewAt('#tag', 4));
    expect(trigger?.kind).toBe('#');
    expect(trigger?.query).toBe('tag');
    expect(trigger?.anchor).toBeUndefined();
  });

  test('detects an @ reference trigger at the caret', () => {
    const trigger = resolveNodeLineTrigger(viewAt('@bob', 4));
    expect(trigger?.kind).toBe('@');
    expect(trigger?.query).toBe('bob');
  });

  test('a bare trigger char on its own line opens an empty trigger', () => {
    expect(resolveNodeLineTrigger(viewAt('/', 1))?.kind).toBe('/');
    expect(resolveNodeLineTrigger(viewAt('/', 1))?.query).toBe('');
    expect(resolveNodeLineTrigger(viewAt('#', 1))?.kind).toBe('#');
    expect(resolveNodeLineTrigger(viewAt('@', 1))?.kind).toBe('@');
  });

  test('returns null for plain prose', () => {
    expect(resolveNodeLineTrigger(viewAt('hello world', 11))).toBeNull();
  });

  test('returns null when the selection is not empty (no trigger while selecting)', () => {
    expect(resolveNodeLineTrigger(viewSelection('#tag', 0, 4))).toBeNull();
  });

  test('does not treat a hex color token as a tag trigger', () => {
    // resolveEditorTriggerText rejects #rrggbb-looking tokens.
    expect(resolveNodeLineTrigger(viewAt('#ff0000', 7))).toBeNull();
  });
});
