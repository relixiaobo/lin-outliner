import { describe, expect, test } from 'bun:test';
import { EditorState } from 'prosemirror-state';
import { richTextPatchFromTransaction } from '../../src/renderer/ui/editor/editorTextPatch';
import { pmSchema } from '../../src/renderer/ui/editor/pmSchema';
import {
  docToRichText,
  INLINE_REF_TEXT_SENTINEL,
  replaceRichTextRangeWithInlineRef,
  richTextToDoc,
  textOffsetToDocPos,
} from '../../src/renderer/ui/editor/richTextCodec';
import { nodeReferenceTarget, plainText } from '../../src/renderer/api/types';

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
      inlineRefs: [{ offset: 2, target: nodeReferenceTarget('target'), displayName: 'Target' }],
    });

    expect(textOffsetToDocPos(trailingRefDoc, 2, { inlineRefBias: 'before' })).toBe(3);
    expect(textOffsetToDocPos(trailingRefDoc, 2, { inlineRefBias: 'after' })).toBe(4);

    const leadingRefDoc = richTextToDoc({
      text: 'Hi',
      marks: [],
      inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target'), displayName: 'Target' }],
    });

    expect(textOffsetToDocPos(leadingRefDoc, 0, { inlineRefBias: 'before' })).toBe(2);
    expect(textOffsetToDocPos(leadingRefDoc, 0, { inlineRefBias: 'after' })).toBe(3);
  });

  test('adds a text gap after inserted inline references', () => {
    const content = replaceRichTextRangeWithInlineRef(
      plainText('See @Alnext'),
      4,
      7,
      { target: nodeReferenceTarget('target'), displayName: 'Alpha' },
    );

    expect(content).toEqual({
      text: 'See  next',
      marks: [],
      inlineRefs: [{ offset: 4, target: nodeReferenceTarget('target'), displayName: 'Alpha' }],
    });
  });

  test('does not duplicate existing whitespace after inserted inline references', () => {
    const content = replaceRichTextRangeWithInlineRef(
      plainText('See @Al next'),
      4,
      7,
      { target: nodeReferenceTarget('target'), displayName: 'Alpha' },
    );

    expect(content).toEqual({
      text: 'See  next',
      marks: [],
      inlineRefs: [{ offset: 4, target: nodeReferenceTarget('target'), displayName: 'Alpha' }],
    });
  });

  test('uses full replacement for text insertion at an inline reference boundary', () => {
    const content = {
      text: 'See ',
      marks: [],
      inlineRefs: [{ offset: 4, target: nodeReferenceTarget('target'), displayName: 'Target' }],
    };
    const doc = richTextToDoc(content);
    const state = EditorState.create({ schema: pmSchema, doc });
    const insertAfterRef = textOffsetToDocPos(doc, 4, { inlineRefBias: 'after' });
    const tr = state.tr.insertText('!', insertAfterRef);

    expect(richTextPatchFromTransaction(tr)).toEqual({
      ops: [{
        type: 'replace_all',
        content: {
          text: 'See !',
          marks: [],
          inlineRefs: [{ offset: 4, target: nodeReferenceTarget('target'), displayName: 'Target' }],
        },
      }],
    });
  });

  test('ignores internal IME composition anchors around inline references', () => {
    const content = {
      text: '',
      marks: [],
      inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target'), displayName: 'Target' }],
    };
    const doc = richTextToDoc(content);
    const state = EditorState.create({ schema: pmSchema, doc });
    const insertAfterRef = textOffsetToDocPos(doc, 0, { inlineRefBias: 'after' });
    const tr = state.tr.insertText(INLINE_REF_TEXT_SENTINEL, insertAfterRef);

    expect(richTextPatchFromTransaction(tr)).toEqual({ ops: [] });
    expect(docToRichText(tr.doc)).toEqual(content);
  });
});
