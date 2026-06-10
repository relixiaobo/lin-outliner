import { describe, expect, test } from 'bun:test';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { compositionAnchorTransaction } from '../../src/renderer/ui/editor/imeCompositionAnchor';
import { docToRichText, INLINE_REF_TEXT_SENTINEL, richTextToDoc } from '../../src/renderer/ui/editor/richTextCodec';
import { pmSchema } from '../../src/renderer/ui/editor/pmSchema';

const ZWSP = INLINE_REF_TEXT_SENTINEL;

function caretState(doc: PMNode, pos: number): EditorState {
  const state = EditorState.create({ schema: pmSchema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function textDoc(text: string): PMNode {
  return richTextToDoc({ text, marks: [], inlineRefs: [] });
}

function inlineRefNode(): PMNode {
  return pmSchema.nodes.inlineReference.create({ targetNodeId: 'ref-target' });
}

function paragraphDoc(...children: PMNode[]): PMNode {
  return pmSchema.nodes.doc.create(null, pmSchema.nodes.paragraph.create(null, children));
}

describe('compositionAnchorTransaction', () => {
  test('seeds an empty textblock with a zero-width anchor and parks the caret after it', () => {
    // The #176 empty-row variant: no text node → ProseMirror redraws the
    // paragraph on the first composition re-segmentation → the IME session
    // dies. The anchor must exist BEFORE composition text arrives.
    const tr = compositionAnchorTransaction(caretState(textDoc(''), 1));
    expect(tr).not.toBeNull();
    expect(tr!.doc.textContent).toBe(ZWSP);
    expect(tr!.selection.empty).toBe(true);
    expect(tr!.selection.from).toBe(1 + ZWSP.length);
    // The codec strips the anchor: nothing ever reaches RichText.
    expect(docToRichText(tr!.doc).text).toBe('');
  });

  test('leaves a caret in stable text alone', () => {
    const doc = textDoc('hello');
    expect(compositionAnchorTransaction(caretState(doc, 1))).toBeNull(); // start
    expect(compositionAnchorTransaction(caretState(doc, 3))).toBeNull(); // middle
    expect(compositionAnchorTransaction(caretState(doc, 6))).toBeNull(); // end
  });

  test('leaves a range selection alone', () => {
    const doc = textDoc('hello');
    const state = EditorState.create({ schema: pmSchema, doc });
    const ranged = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 4)));
    expect(compositionAnchorTransaction(ranged)).toBeNull();
  });

  test('anchors after a selected inline reference', () => {
    const doc = paragraphDoc(inlineRefNode());
    const state = EditorState.create({ schema: pmSchema, doc });
    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 1)));
    const tr = compositionAnchorTransaction(selected);
    expect(tr).not.toBeNull();
    expect(tr!.doc.firstChild!.childCount).toBe(2);
    expect(tr!.doc.firstChild!.lastChild!.text).toBe(ZWSP);
    expect(tr!.selection.from).toBe(2 + ZWSP.length);
  });

  test('anchors a caret stranded against an inline reference with no text node beside it', () => {
    const doc = paragraphDoc(inlineRefNode());
    const after = compositionAnchorTransaction(caretState(doc, 2));
    expect(after).not.toBeNull();
    expect(after!.doc.firstChild!.lastChild!.text).toBe(ZWSP);
    const before = compositionAnchorTransaction(caretState(doc, 1));
    expect(before).not.toBeNull();
    expect(before!.doc.firstChild!.firstChild!.text).toBe(ZWSP);
  });

  test('does not double-anchor next to the codec\'s own ref sentinels', () => {
    // richTextToDoc already brackets boundary refs with sentinels; a caret
    // between the ref and that sentinel has its text node and needs nothing.
    const doc = richTextToDoc({
      text: '',
      marks: [],
      inlineRefs: [{ offset: 0, target: { kind: 'node', nodeId: 'ref-target' } }],
    });
    expect(compositionAnchorTransaction(caretState(doc, 2))).toBeNull(); // sentinel | ref
    expect(compositionAnchorTransaction(caretState(doc, 3))).toBeNull(); // ref | sentinel
  });
});
