import { describe, expect, test } from 'bun:test';
import { EditorState } from 'prosemirror-state';
import { richTextPatchFromTransaction } from '../../src/renderer/ui/editor/editorTextPatch';
import { pmSchema } from '../../src/renderer/ui/editor/pmSchema';
import { richTextToDoc, textOffsetToDocPos } from '../../src/renderer/ui/editor/richTextCodec';
import { plainText } from '../../src/renderer/api/types';

describe('editor text patch', () => {
  test('converts text insert transactions into rich text patches', () => {
    const state = EditorState.create({
      schema: pmSchema,
      doc: richTextToDoc(plainText('Hello')),
    });
    const tr = state.tr.insertText('!', 6);

    expect(richTextPatchFromTransaction(tr)).toEqual({
      ops: [{
        type: 'replace',
        from: 5,
        to: 5,
        content: { text: '!', marks: [], inlineRefs: [] },
      }],
    });
  });

  test('converts mark transactions into rich text mark patches', () => {
    const state = EditorState.create({
      schema: pmSchema,
      doc: richTextToDoc(plainText('Hello')),
    });
    const tr = state.tr.addMark(1, 6, pmSchema.marks.bold.create());

    expect(richTextPatchFromTransaction(tr)).toEqual({
      ops: [{
        type: 'add_mark',
        from: 0,
        to: 5,
        markType: 'bold',
      }],
    });
  });

  test('maps cursor bias around inline references at the same text offset', () => {
    const trailingRefDoc = richTextToDoc({
      text: 'Hi',
      marks: [],
      inlineRefs: [{ offset: 2, targetNodeId: 'target', displayName: 'Target' }],
    });

    expect(textOffsetToDocPos(trailingRefDoc, 2, { inlineRefBias: 'before' })).toBe(3);
    expect(textOffsetToDocPos(trailingRefDoc, 2, { inlineRefBias: 'after' })).toBe(4);

    const leadingRefDoc = richTextToDoc({
      text: 'Hi',
      marks: [],
      inlineRefs: [{ offset: 0, targetNodeId: 'target', displayName: 'Target' }],
    });

    expect(textOffsetToDocPos(leadingRefDoc, 0, { inlineRefBias: 'before' })).toBe(1);
    expect(textOffsetToDocPos(leadingRefDoc, 0, { inlineRefBias: 'after' })).toBe(2);
  });
});
