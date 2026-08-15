import remend, { isWordChar, type RemendOptions } from 'remend';

// Emphasis behavior is derived from remend@1.3.0.
// The differential suite is the compatibility guard for the semver-ranged
// dependency: an upstream behavior change must fail before this copy can drift.
// Copyright 2023 Vercel, Inc. Licensed under Apache-2.0:
// https://www.apache.org/licenses/LICENSE-2.0
// The implementation replaces repeated prefix scans with linear context maps.

const INCOMPLETE_LINK_SUFFIX = '](streamdown:incomplete-link)';
const WHITESPACE_OR_MARKERS_PATTERN = /^[\s_~*`]*$/;
const LIST_ITEM_PATTERN = /^[\s]*[-*+][\s]+$/;
const FOUR_OR_MORE_ASTERISKS_PATTERN = /^\*{4,}$/;
const BOLD_ITALIC_PATTERN = /(\*\*\*)([^*]*?)$/;
const BOLD_PATTERN = /(\*\*)([^*]*\*?)$/;
const DOUBLE_UNDERSCORE_PATTERN = /(__)([^_]*?)$/;
const HALF_COMPLETE_UNDERSCORE_PATTERN = /(__)([^_]+)_$/;
const SINGLE_ASTERISK_PATTERN = /(\*)([^*]*?)$/;
const SINGLE_UNDERSCORE_PATTERN = /(_)([^_]*?)$/;

const BEFORE_EMPHASIS_OPTIONS: RemendOptions = {
  bold: false,
  boldItalic: false,
  inlineCode: false,
  inlineKatex: false,
  italic: false,
  katex: false,
  strikethrough: false,
};

const AFTER_EMPHASIS_OPTIONS: RemendOptions = {
  bold: false,
  boldItalic: false,
  comparisonOperators: false,
  htmlTags: false,
  images: false,
  inlineCode: true,
  inlineKatex: false,
  italic: false,
  katex: true,
  links: false,
  setextHeadings: false,
  singleTilde: false,
  strikethrough: true,
};

interface RepairContext {
  readonly completeInlineCode: Uint8Array;
  readonly endHtmlTag: boolean;
  readonly endInsideCode: boolean;
  readonly endMath: boolean;
  readonly htmlTag: Uint8Array;
  readonly insideCode: Uint8Array;
  readonly linkUrl: Uint8Array;
  readonly math: Uint8Array;
}

export function repairStreamingMarkdown(text: string): string {
  if (!text.includes('*') && !text.includes('_')) {
    return remend(text);
  }

  const beforeEmphasis = remend(text, BEFORE_EMPHASIS_OPTIONS);
  if (beforeEmphasis.endsWith(INCOMPLETE_LINK_SUFFIX)) return beforeEmphasis;

  const emphasized = repairIncompleteEmphasis(beforeEmphasis);
  return repairAfterEmphasis(emphasized);
}

function repairAfterEmphasis(text: string): string {
  if (!text.endsWith(' ') || text.endsWith('  ')) {
    return remend(text, AFTER_EMPHASIS_OPTIONS);
  }

  // A removed incomplete image can expose one trailing space after remend's
  // one-time trim already ran. Protect it from the second staged call.
  const protectedText = `${text} `;
  const repaired = remend(protectedText, AFTER_EMPHASIS_OPTIONS);
  if (!repaired.startsWith(protectedText)) {
    return remend(text, AFTER_EMPHASIS_OPTIONS);
  }
  return repaired.slice(0, text.length) + repaired.slice(text.length + 1);
}

function repairIncompleteEmphasis(text: string): string {
  let value = text;
  const context = createRepairContext(value);

  const apply = (handler: (input: string, current: RepairContext) => string) => {
    value = handler(value, context);
  };

  apply(handleIncompleteBoldItalic);
  apply(handleIncompleteBold);
  apply(handleIncompleteDoubleUnderscoreItalic);
  apply(handleIncompleteSingleAsteriskItalic);
  apply(handleIncompleteSingleUnderscoreItalic);
  return value;
}

function handleIncompleteBoldItalic(text: string, context: RepairContext): string {
  if (FOUR_OR_MORE_ASTERISKS_PATTERN.test(text)) return text;
  const match = text.match(BOLD_ITALIC_PATTERN);
  if (!match) return text;

  const content = match[2] ?? '';
  const markerIndex = text.lastIndexOf(match[1]!);
  if (
    !content
    || WHITESPACE_OR_MARKERS_PATTERN.test(content)
    || isInsideCode(context, markerIndex)
    || isInsideCompleteInlineCode(context, markerIndex)
    || isHorizontalRule(text, markerIndex, '*')
  ) return text;

  if (countTripleAsterisks(text) % 2 === 0) return text;
  if (
    countDoubleAsterisksOutsideCodeBlocks(text) % 2 === 0
    && countSingleAsterisks(text, context) % 2 === 0
  ) return text;
  return `${text}***`;
}

function handleIncompleteBold(text: string, context: RepairContext): string {
  const match = text.match(BOLD_PATTERN);
  if (!match) return text;

  const content = match[2] ?? '';
  const markerIndex = text.lastIndexOf(match[1]!);
  if (
    isInsideCode(context, markerIndex)
    || isInsideCompleteInlineCode(context, markerIndex)
    || shouldSkipPairedMarker(text, content, markerIndex, '*')
  ) return text;

  if (countDoubleAsterisksOutsideCodeBlocks(text) % 2 === 0) return text;
  return content.endsWith('*') ? `${text}*` : `${text}**`;
}

function handleIncompleteDoubleUnderscoreItalic(
  text: string,
  context: RepairContext,
): string {
  const match = text.match(DOUBLE_UNDERSCORE_PATTERN);
  if (!match) {
    const halfComplete = text.match(HALF_COMPLETE_UNDERSCORE_PATTERN);
    if (!halfComplete) return text;
    const markerIndex = text.lastIndexOf(halfComplete[1]!);
    if (isInsideCode(context, markerIndex) || isInsideCompleteInlineCode(context, markerIndex)) {
      return text;
    }
    return countDoubleUnderscoresOutsideCodeBlocks(text) % 2 === 1
      ? `${text}_`
      : text;
  }

  const content = match[2] ?? '';
  const markerIndex = text.lastIndexOf(match[1]!);
  if (
    isInsideCode(context, markerIndex)
    || isInsideCompleteInlineCode(context, markerIndex)
    || shouldSkipPairedMarker(text, content, markerIndex, '_')
  ) return text;

  return countDoubleUnderscoresOutsideCodeBlocks(text) % 2 === 1
    ? `${text}__`
    : text;
}

function handleIncompleteSingleAsteriskItalic(
  text: string,
  context: RepairContext,
): string {
  if (!SINGLE_ASTERISK_PATTERN.test(text)) return text;
  const markerIndex = findFirstSingleAsteriskIndex(text, context);
  if (markerIndex < 0) return text;
  if (isInsideCode(context, markerIndex) || isInsideCompleteInlineCode(context, markerIndex)) {
    return text;
  }

  const content = text.slice(markerIndex + 1);
  if (!content || WHITESPACE_OR_MARKERS_PATTERN.test(content)) return text;
  return countSingleAsterisks(text, context) % 2 === 1 ? `${text}*` : text;
}

function handleIncompleteSingleUnderscoreItalic(
  text: string,
  context: RepairContext,
): string {
  if (!SINGLE_UNDERSCORE_PATTERN.test(text)) return text;
  const markerIndex = findFirstSingleUnderscoreIndex(text, context);
  if (markerIndex < 0) return text;

  const content = text.slice(markerIndex + 1);
  if (!content || WHITESPACE_OR_MARKERS_PATTERN.test(content)) return text;
  if (isInsideCode(context, markerIndex) || isInsideCompleteInlineCode(context, markerIndex)) {
    return text;
  }
  if (countSingleUnderscores(text, context) % 2 === 0) return text;

  const nested = closeUnderscoreBeforeTrailingBold(text, context);
  return nested ?? insertClosingUnderscore(text);
}

function shouldSkipPairedMarker(
  text: string,
  content: string,
  markerIndex: number,
  marker: '*' | '_',
): boolean {
  if (!content || WHITESPACE_OR_MARKERS_PATTERN.test(content)) return true;

  const lineStart = text.lastIndexOf('\n', markerIndex - 1) + 1;
  if (LIST_ITEM_PATTERN.test(text.slice(lineStart, markerIndex)) && content.includes('\n')) {
    return true;
  }
  return isHorizontalRule(text, markerIndex, marker);
}

function closeUnderscoreBeforeTrailingBold(
  text: string,
  context: RepairContext,
): string | null {
  if (!text.endsWith('**')) return null;
  const withoutTrailingBold = text.slice(0, -2);
  if (countDoubleAsterisksOutsideCodeBlocks(withoutTrailingBold) % 2 !== 1) return null;

  const markerIndex = withoutTrailingBold.indexOf('**');
  const underscoreIndex = findFirstSingleUnderscoreIndex(withoutTrailingBold, context);
  return markerIndex >= 0 && underscoreIndex >= 0 && markerIndex < underscoreIndex
    ? `${withoutTrailingBold}_**`
    : null;
}

function insertClosingUnderscore(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end -= 1;
  return text.slice(0, end) + '_' + text.slice(end);
}

function findFirstSingleAsteriskIndex(text: string, context: RepairContext): number {
  let inCodeBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.slice(index, index + 3) === '```') {
      inCodeBlock = !inCodeBlock;
      index += 2;
      continue;
    }
    if (inCodeBlock || text[index] !== '*') continue;

    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (
      previous === '*'
      || next === '*'
      || previous === '\\'
      || isInsideMath(context, index)
      || isWhitespace(previous) && isWhitespace(next)
      || previous && next && isWordChar(previous) && isWordChar(next)
    ) continue;
    return index;
  }
  return -1;
}

function findFirstSingleUnderscoreIndex(text: string, context: RepairContext): number {
  let inCodeBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.slice(index, index + 3) === '```') {
      inCodeBlock = !inCodeBlock;
      index += 2;
      continue;
    }
    if (inCodeBlock || text[index] !== '_') continue;

    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (
      previous === '_'
      || next === '_'
      || previous === '\\'
      || isInsideMath(context, index)
      || isInsideLinkUrl(context, index)
      || previous && next && isWordChar(previous) && isWordChar(next)
    ) continue;
    return index;
  }
  return -1;
}

function countSingleAsterisks(text: string, context: RepairContext): number {
  let count = 0;
  let inCodeBlock = false;
  const hasMath = text.includes('$');

  for (let index = 0; index < text.length; index += 1) {
    if (text.slice(index, index + 3) === '```') {
      inCodeBlock = !inCodeBlock;
      index += 2;
      continue;
    }
    if (inCodeBlock || text[index] !== '*') continue;

    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (previous === '\\' || hasMath && isInsideMath(context, index)) continue;
    if (previous !== '*' && next === '*') {
      if (text[index + 2] !== '*') continue;
    } else if (previous === '*') {
      continue;
    }
    if (previous && next && isWordChar(previous) && isWordChar(next)) continue;
    if (isWhitespace(previous) && isWhitespace(next)) continue;
    count += 1;
  }
  return count;
}

function countSingleUnderscores(text: string, context: RepairContext): number {
  let count = 0;
  let inCodeBlock = false;

  for (let index = 0; index < text.length; index += 1) {
    if (text.slice(index, index + 3) === '```') {
      inCodeBlock = !inCodeBlock;
      index += 2;
      continue;
    }
    if (inCodeBlock || text[index] !== '_') continue;

    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (
      previous === '\\'
      || isInsideMath(context, index)
      || isInsideLinkUrl(context, index)
      || isInsideHtmlTag(context, index)
      || previous === '_'
      || next === '_'
      || previous && next && isWordChar(previous) && isWordChar(next)
    ) continue;
    count += 1;
  }
  return count;
}

function countDoubleAsterisksOutsideCodeBlocks(text: string): number {
  let count = 0;
  let inCodeBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.slice(index, index + 3) === '```') {
      inCodeBlock = !inCodeBlock;
      index += 2;
    } else if (!inCodeBlock && text.slice(index, index + 2) === '**') {
      count += 1;
      index += 1;
    }
  }
  return count;
}

function countDoubleUnderscoresOutsideCodeBlocks(text: string): number {
  let count = 0;
  let inCodeBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.slice(index, index + 3) === '```') {
      inCodeBlock = !inCodeBlock;
      index += 2;
    } else if (!inCodeBlock && text.slice(index, index + 2) === '__') {
      count += 1;
      index += 1;
    }
  }
  return count;
}

function countTripleAsterisks(text: string): number {
  let count = 0;
  let run = 0;
  let inCodeBlock = false;

  const flush = () => {
    if (run >= 3) count += Math.floor(run / 3);
    run = 0;
  };

  for (let index = 0; index < text.length; index += 1) {
    if (text.slice(index, index + 3) === '```') {
      flush();
      inCodeBlock = !inCodeBlock;
      index += 2;
    } else if (!inCodeBlock && text[index] === '*') {
      run += 1;
    } else if (!inCodeBlock) {
      flush();
    }
  }
  flush();
  return count;
}

function isHorizontalRule(text: string, markerIndex: number, marker: '*' | '_'): boolean {
  const lineStart = text.lastIndexOf('\n', markerIndex - 1) + 1;
  const nextLine = text.indexOf('\n', markerIndex);
  const lineEnd = nextLine < 0 ? text.length : nextLine;
  let markerCount = 0;

  for (const character of text.slice(lineStart, lineEnd)) {
    if (character === marker) markerCount += 1;
    else if (character !== ' ' && character !== '\t') return false;
  }
  return markerCount >= 3;
}

function createRepairContext(text: string): RepairContext {
  const length = text.length;
  const completeInlineCode = new Uint8Array(length);
  const htmlTag = new Uint8Array(length);
  const insideCode = new Uint8Array(length);
  const linkUrl = new Uint8Array(length);
  const math = new Uint8Array(length);

  const endInsideCode = fillCodeContext(text, insideCode, completeInlineCode);
  const endMath = fillMathContext(text, math);
  fillLinkUrlContext(text, linkUrl);
  const endHtmlTag = fillHtmlTagContext(text, htmlTag);
  return {
    completeInlineCode,
    endHtmlTag,
    endInsideCode,
    endMath,
    htmlTag,
    insideCode,
    linkUrl,
    math,
  };
}

function fillCodeContext(
  text: string,
  insideCode: Uint8Array,
  completeInlineCode: Uint8Array,
): boolean {
  let inlineStart = -1;
  let inInlineCode = false;
  let inMultilineCode = false;

  for (let index = 0; index < text.length; index += 1) {
    insideCode[index] = inInlineCode || inMultilineCode ? 1 : 0;
    if (text[index] === '\\' && text[index + 1] === '`') {
      insideCode[index + 1] = insideCode[index]!;
      index += 1;
      continue;
    }
    if (text.slice(index, index + 3) === '```') {
      inMultilineCode = !inMultilineCode;
      index += 2;
      continue;
    }
    if (inMultilineCode || text[index] !== '`') continue;

    if (!inInlineCode) {
      inInlineCode = true;
      inlineStart = index;
      continue;
    }
    for (let position = inlineStart + 1; position < index; position += 1) {
      completeInlineCode[position] = 1;
    }
    inInlineCode = false;
    inlineStart = -1;
  }
  return inInlineCode || inMultilineCode;
}

function fillMathContext(text: string, math: Uint8Array): boolean {
  let inBlockMath = false;
  let inInlineMath = false;

  for (let index = 0; index < text.length; index += 1) {
    math[index] = inBlockMath || inInlineMath ? 1 : 0;
    if (text[index] === '\\' && text[index + 1] === '$') {
      math[index + 1] = math[index]!;
      index += 1;
    } else if (text.slice(index, index + 2) === '$$') {
      inBlockMath = !inBlockMath;
      inInlineMath = false;
      index += 1;
    } else if (text[index] === '$' && !inBlockMath) {
      inInlineMath = !inInlineMath;
    }
  }
  return inBlockMath || inInlineMath;
}

function fillLinkUrlContext(text: string, linkUrl: Uint8Array): void {
  const closingParenAhead = new Uint8Array(text.length);
  let hasClosingParen = false;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] === '\n') hasClosingParen = false;
    else if (text[index] === ')') hasClosingParen = true;
    closingParenAhead[index] = hasClosingParen ? 1 : 0;
  }

  let afterLinkParen = false;
  for (let index = 0; index < text.length; index += 1) {
    linkUrl[index] = afterLinkParen && closingParenAhead[index] ? 1 : 0;
    if (text[index] === '\n' || text[index] === ')') {
      afterLinkParen = false;
    } else if (text[index] === '(') {
      afterLinkParen = text[index - 1] === ']';
    }
  }
}

function fillHtmlTagContext(text: string, htmlTag: Uint8Array): boolean {
  let inTag = false;
  for (let index = 0; index < text.length; index += 1) {
    htmlTag[index] = inTag ? 1 : 0;
    if (text[index] === '\n' || text[index] === '>') {
      inTag = false;
    } else if (text[index] === '<') {
      const next = text[index + 1] ?? '';
      inTag = next === '/' || /[A-Za-z]/.test(next);
    }
  }
  return inTag;
}

function isInsideCode(context: RepairContext, index: number): boolean {
  return index < context.insideCode.length
    ? context.insideCode[index] === 1
    : context.endInsideCode;
}

function isInsideCompleteInlineCode(context: RepairContext, index: number): boolean {
  return index < context.completeInlineCode.length
    && context.completeInlineCode[index] === 1;
}

function isInsideMath(context: RepairContext, index: number): boolean {
  return index < context.math.length
    ? context.math[index] === 1
    : context.endMath;
}

function isInsideLinkUrl(context: RepairContext, index: number): boolean {
  return index < context.linkUrl.length && context.linkUrl[index] === 1;
}

function isInsideHtmlTag(context: RepairContext, index: number): boolean {
  return index < context.htmlTag.length
    ? context.htmlTag[index] === 1
    : context.endHtmlTag;
}

function isWhitespace(character: string): boolean {
  return !character || character === ' ' || character === '\t' || character === '\n';
}
