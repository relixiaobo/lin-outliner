import type { Mark } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { RichText, TextMarkKind } from '../../api/types';
import { docPosToTextOffset, docToRichText, textOffsetToDocPos } from './richTextCodec';
import { pmSchema } from './pmSchema';

type ShortcutMarkKind = Extract<TextMarkKind, 'bold' | 'strike' | 'code' | 'highlight' | 'link'>;

interface SymmetricInlineRule {
  closePrefix: string;
  delimiter: string;
  markType: Exclude<ShortcutMarkKind, 'link'>;
  trigger: string;
}

const SYMMETRIC_INLINE_RULES: readonly SymmetricInlineRule[] = [
  { delimiter: '`', trigger: '`', closePrefix: '', markType: 'code' },
  { delimiter: '**', trigger: '*', closePrefix: '*', markType: 'bold' },
  { delimiter: '~~', trigger: '~', closePrefix: '~', markType: 'strike' },
  { delimiter: '==', trigger: '=', closePrefix: '=', markType: 'highlight' },
];

export interface InlineMarkShortcut {
  attrs?: Record<string, string>;
  closePrefixOffset: number;
  endOffset: number;
  markType: ShortcutMarkKind;
  openingOffset: number;
  startOffset: number;
}

function overlapsRange(mark: { start: number; end: number }, from: number, to: number): boolean {
  return mark.start < to && mark.end > from;
}

function hasInlineRefInside(content: RichText, from: number, to: number): boolean {
  return content.inlineRefs.some((ref) => ref.offset > from && ref.offset < to);
}

function overlapsBlockingMark(content: RichText, markType: ShortcutMarkKind, from: number, to: number): boolean {
  return content.marks.some((mark) => {
    if (mark.type !== markType && mark.type !== 'code') return false;
    return overlapsRange(mark, from, to);
  });
}

function findSymmetricShortcut(
  content: RichText,
  cursorOffset: number,
  typedText: string,
): InlineMarkShortcut | null {
  for (const rule of SYMMETRIC_INLINE_RULES) {
    if (typedText !== rule.trigger) continue;
    if (cursorOffset < rule.closePrefix.length) continue;
    if (rule.closePrefix && !content.text.slice(cursorOffset - rule.closePrefix.length, cursorOffset).endsWith(rule.closePrefix)) {
      continue;
    }

    const closePrefixOffset = cursorOffset - rule.closePrefix.length;
    const openingOffset = content.text.lastIndexOf(rule.delimiter, closePrefixOffset - 1);
    if (openingOffset < 0) continue;

    const startOffset = openingOffset + rule.delimiter.length;
    const endOffset = closePrefixOffset;
    if (startOffset >= endOffset) continue;

    const inner = content.text.slice(startOffset, endOffset);
    if (inner.includes('\n')) continue;
    if (hasInlineRefInside(content, openingOffset, cursorOffset)) continue;
    if (overlapsBlockingMark(content, rule.markType, openingOffset, cursorOffset)) continue;

    return {
      closePrefixOffset,
      endOffset,
      markType: rule.markType,
      openingOffset,
      startOffset,
    };
  }
  return null;
}

function findLinkShortcut(content: RichText, cursorOffset: number, typedText: string): InlineMarkShortcut | null {
  if (typedText !== ')' || cursorOffset <= 0) return null;

  const separatorOffset = content.text.lastIndexOf('](', cursorOffset - 1);
  if (separatorOffset < 0) return null;

  const openingOffset = content.text.lastIndexOf('[', separatorOffset - 1);
  if (openingOffset < 0) return null;

  const startOffset = openingOffset + 1;
  const endOffset = separatorOffset;
  const urlStartOffset = separatorOffset + 2;
  const href = content.text.slice(urlStartOffset, cursorOffset);
  const label = content.text.slice(startOffset, endOffset);
  if (!label || !href || label.includes('\n') || /[\s\n)]/u.test(href)) return null;
  if (hasInlineRefInside(content, openingOffset, cursorOffset)) return null;
  if (overlapsBlockingMark(content, 'link', openingOffset, cursorOffset)) return null;

  return {
    attrs: { href },
    closePrefixOffset: endOffset,
    endOffset,
    markType: 'link',
    openingOffset,
    startOffset,
  };
}

export function findInlineMarkShortcut(
  content: RichText,
  cursorOffset: number,
  typedText: string,
): InlineMarkShortcut | null {
  if (cursorOffset <= 0 || typedText.length !== 1) return null;
  return findSymmetricShortcut(content, cursorOffset, typedText)
    ?? findLinkShortcut(content, cursorOffset, typedText);
}

export function createInlineMarkShortcutTransaction(
  state: EditorState,
  from: number,
  to: number,
  text: string,
): Transaction | null {
  if (from !== to) return null;

  const cursorOffset = docPosToTextOffset(state.doc, from);
  const shortcut = findInlineMarkShortcut(docToRichText(state.doc), cursorOffset, text);
  if (!shortcut) return null;

  const openingPos = textOffsetToDocPos(state.doc, shortcut.openingOffset);
  const innerStartPos = textOffsetToDocPos(state.doc, shortcut.startOffset);
  const innerEndPos = textOffsetToDocPos(state.doc, shortcut.endOffset);
  const closePrefixEndPos = textOffsetToDocPos(state.doc, cursorOffset);

  let tr = state.tr;
  if (shortcut.closePrefixOffset < cursorOffset) {
    const closePrefixPos = textOffsetToDocPos(state.doc, shortcut.closePrefixOffset);
    tr = tr.delete(closePrefixPos, closePrefixEndPos);
  }
  tr = tr.delete(openingPos, innerStartPos);

  const markFrom = tr.mapping.map(innerStartPos, -1);
  const markTo = tr.mapping.map(innerEndPos, -1);
  if (markTo <= markFrom) return null;

  const markType = pmSchema.marks[shortcut.markType];
  if (!markType) return null;

  tr = tr.addMark(markFrom, markTo, markType.create(shortcut.attrs) as Mark);
  tr = tr.setSelection(TextSelection.create(tr.doc, markTo));
  tr = tr.setStoredMarks([]);
  return tr.scrollIntoView();
}
