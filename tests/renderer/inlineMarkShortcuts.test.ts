import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { EditorState } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { docPosToTextOffset, docToRichText, richTextToDoc, textOffsetToDocPos } from '../../src/renderer/ui/editor/richTextCodec';
import { moveInlineCodeCaretAcrossBoundary } from '../../src/renderer/ui/editor/inlineCodeBoundaryNavigation';
import { createInlineMarkShortcutTransaction, findInlineMarkShortcut } from '../../src/renderer/ui/editor/inlineMarkShortcuts';
import { pmSchema } from '../../src/renderer/ui/editor/pmSchema';

function stateFor(text: string) {
  const doc = richTextToDoc({ text, marks: [], inlineRefs: [] });
  return EditorState.create({ schema: pmSchema, doc });
}

function codeStateFor(text: string) {
  const doc = richTextToDoc({
    text,
    marks: [{ start: 0, end: text.length, type: 'code' }],
    inlineRefs: [],
  });
  return EditorState.create({ schema: pmSchema, doc });
}

function shortcutContent(beforeTypedClose: string, typedText: string) {
  const state = stateFor(beforeTypedClose);
  const from = textOffsetToDocPos(state.doc, beforeTypedClose.length);
  const tr = createInlineMarkShortcutTransaction(state, from, from, typedText);
  expect(tr).not.toBeNull();
  expect(docPosToTextOffset(tr!.doc, tr!.selection.from)).toBe(docToRichText(tr!.doc).text.length);
  expect(tr!.storedMarks).toEqual([]);
  return docToRichText(tr!.doc);
}

function installMinimalDom(html: string) {
  const { document, window } = parseHTML(html);
  Object.assign(globalThis, {
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  return document;
}

function installSelection(document: Document, anchorNode: Node, anchorOffset: number) {
  let collapsedAt: { node: Node; offset: number } | null = null;
  Object.assign(document, {
    getSelection: () => ({
      anchorNode,
      anchorOffset,
      collapse: (node: Node, offset: number) => {
        collapsedAt = { node, offset };
      },
      isCollapsed: true,
    }),
    createRange: () => {
      let endNode: Node | null = null;
      let endOffset = 0;
      return {
        setStart: () => {},
        setEnd: (node: Node, offset: number) => {
          endNode = node;
          endOffset = offset;
        },
        toString: () => (endNode?.textContent ?? '').slice(0, endOffset),
      };
    },
  });
  return () => collapsedAt;
}

describe('inline mark shortcuts', () => {
  test('detects a non-empty backtick shortcut before the closing delimiter is inserted', () => {
    expect(findInlineMarkShortcut({ text: '`nihao', marks: [], inlineRefs: [] }, 6, '`')).toMatchObject({
      markType: 'code',
      openingOffset: 0,
      startOffset: 1,
      endOffset: 6,
    });
    expect(findInlineMarkShortcut({ text: '``', marks: [], inlineRefs: [] }, 1, '`')).toBeNull();
  });

  test('turns typed backtick syntax into an inline code mark with the cursor outside', () => {
    expect(shortcutContent('say `nihao', '`')).toEqual({
      text: 'say nihao',
      marks: [{ start: 4, end: 9, type: 'code' }],
      inlineRefs: [],
    });
  });

  test('turns low-ambiguity paired delimiters into inline marks', () => {
    expect(shortcutContent('say **nihao*', '*')).toEqual({
      text: 'say nihao',
      marks: [{ start: 4, end: 9, type: 'bold' }],
      inlineRefs: [],
    });
    expect(shortcutContent('say ~~gone~', '~')).toEqual({
      text: 'say gone',
      marks: [{ start: 4, end: 8, type: 'strike' }],
      inlineRefs: [],
    });
    expect(shortcutContent('say ==hot=', '=')).toEqual({
      text: 'say hot',
      marks: [{ start: 4, end: 7, type: 'highlight' }],
      inlineRefs: [],
    });
  });

  test('turns markdown link syntax into a link mark', () => {
    expect(shortcutContent('see [Anthropic](https://anthropic.com', ')')).toEqual({
      text: 'see Anthropic',
      marks: [{ start: 4, end: 13, type: 'link', attrs: { href: 'https://anthropic.com' } }],
      inlineRefs: [],
    });
  });

  test('does not create ambiguous italic shortcuts or nested code shortcuts', () => {
    expect(findInlineMarkShortcut({ text: '*italic', marks: [], inlineRefs: [] }, 7, '*')).toBeNull();
    expect(findInlineMarkShortcut({
      text: '`nihao',
      marks: [{ start: 1, end: 6, type: 'code' }],
      inlineRefs: [],
    }, 6, '`')).toBeNull();
  });

  test('does not create inline formatting inside code marks', () => {
    expect(findInlineMarkShortcut({
      text: '**nihao*',
      marks: [{ start: 0, end: 8, type: 'code' }],
      inlineRefs: [],
    }, 8, '*')).toBeNull();
  });

  test('keeps inline code non-inclusive at the boundary', () => {
    expect(pmSchema.marks.code.spec.inclusive).toBe(false);
  });

  test('moves right out of a terminal inline code mark without treating the trailing break as text', async () => {
    const document = installMinimalDom('<p><code class="pm-code">nihao</code><br class="ProseMirror-trailingBreak"></p>');
    const parent = document.querySelector('p');
    const code = document.querySelector('code.pm-code');
    const text = code?.firstChild;
    if (!parent || !code || !text) throw new Error('missing test DOM');
    const collapsedAt = installSelection(document, text, 5);

    const view = {
      dom: parent,
      isDestroyed: false,
      state: codeStateFor('nihao'),
      dispatch(tr: Transaction) {
        this.state = this.state.apply(tr);
      },
      posAtDOM: () => 6,
      domAtPos: () => ({ node: parent, offset: 1 }),
    };

    expect(moveInlineCodeCaretAcrossBoundary(view as unknown as EditorView, 'right')).toBe(true);
    expect(docToRichText(view.state.doc)).toEqual({
      text: 'nihao',
      marks: [{ start: 0, end: 5, type: 'code' }],
      inlineRefs: [],
    });
    expect(view.state.doc.textContent.length).toBe(6);
    expect(docPosToTextOffset(view.state.doc, view.state.selection.from)).toBe(5);

    await Promise.resolve();
    expect(collapsedAt()).toEqual({ node: parent, offset: 1 });
  });
});
