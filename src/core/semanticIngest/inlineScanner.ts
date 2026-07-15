import { Lexer } from 'marked';
import { parseReferenceMarkers } from '../referenceMarkup';
import {
  matchTagTokens,
  parseTagTokenMatch,
} from '../textSyntax';
import type { InlineRef, ReferenceTarget, RichText, TextMark, TextMarkKind } from '../types';
import type {
  InlineFieldToken,
  InlineMetadataMode,
  InlineScanOptions,
  MarkdownInlineScanResult,
  RichTextInlineScanResult,
  SourceSpan,
  TagDraft,
} from './types';

const MARKDOWN_INLINE_MARK_TOKEN =
  /\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|==([^=\n]+)==|\*([^*\n]+)\*|`([^`\n]+)`/gu;
const FIELD_START_TOKEN = /(^|\s)([A-Za-z][\w-]*)::[ \t]+/gu;
const BARE_URL_TOKEN = new RegExp(String.raw`(?:https?:\/\/|www\.)[^\s<>"'\u0060]+`, 'giu');
const ASCII_WORD = /[A-Za-z0-9_]/u;
const WHITESPACE = /\s/u;
const ESCAPABLE = new Set(['\\', '*', '~', '=', '`', '[', ']', '#', ':', '%', '-', '.']);
const TRAILING_URL_PUNCTUATION = new Set([
  '.', ',', '!', '?', ';', ':',
  '\u3002', '\uff0c', '\uff01', '\uff1f', '\uff1b', '\uff1a', '\u2019', '\u201d', '\u00bb', '\u2026',
]);

interface Range {
  start: number;
  end: number;
}

interface MetadataExtraction {
  fields: InlineFieldToken[];
  removals: Range[];
  tags: TagDraft[];
}

interface ParsedMarkdown {
  content: RichText;
  escapedOffsets: Set<number>;
}

interface InlineToken extends Range {
  type: TextMarkKind;
  inner: string;
  attrs?: Record<string, string>;
}

export interface SemanticEscapeOptions {
  escapeBareUrls?: boolean;
  prefix?: string;
  suffix?: string;
}

export function scanMarkdownInline(
  input: string,
  options: InlineScanOptions = {},
): MarkdownInlineScanResult {
  const metadata = options.metadata ?? 'none';
  const extraction = extractMetadata(input, metadata, markdownInlineProtectedRanges(input));
  const source = removeTextRanges(input, extraction.removals);
  const parsed = parseMarkdown(source);
  const withLinks = options.linkifyBareUrls === false
    ? parsed.content
    : linkifyBareUrls(parsed.content, parsed.escapedOffsets);
  const content = options.references
    ? materializeReferenceMarkers(withLinks, parsed.escapedOffsets)
    : withLinks;
  return {
    source,
    content,
    tags: extraction.tags,
    fields: extraction.fields,
  };
}

export function scanRichTextInline(
  input: RichText,
  options: InlineScanOptions = {},
): RichTextInlineScanResult {
  const protectedRanges = richTextMetadataProtectedRanges(input);
  const extraction = extractMetadata(input.text, options.metadata ?? 'none', protectedRanges);
  const withoutMetadata = removeRichTextRanges(input, extraction.removals, { trim: true });
  const literalRanges = normalizeRanges([
    ...linkAndCodeRanges(withoutMetadata),
    ...referenceMarkerRanges(withoutMetadata.text),
    ...bareUrlRanges(withoutMetadata.text),
  ]);
  const escapeRemovals = escapeBackslashRanges(withoutMetadata.text)
    .filter((range) => !positionInRanges(range.start, literalRanges));
  const decoded = removeRichTextRanges(withoutMetadata, escapeRemovals);
  const escapedOffsets = mappedRemovalStarts(escapeRemovals);
  const withLinks = options.linkifyBareUrls === false
    ? decoded
    : linkifyBareUrls(decoded, escapedOffsets);
  const content = options.references
    ? materializeReferenceMarkers(withLinks, escapedOffsets)
    : withLinks;
  return {
    content,
    tags: extraction.tags,
    fields: extraction.fields,
  };
}

export function parseInlineMarkdownWithLinks(input: string): RichText {
  return scanMarkdownInline(input, {
    metadata: 'none',
    linkifyBareUrls: true,
    references: true,
  }).content;
}

export function parseMarkdownReferenceRichText(input: string): RichText {
  return scanMarkdownInline(input, {
    metadata: 'none',
    linkifyBareUrls: true,
    references: true,
  }).content;
}

export function isEscapedSemanticAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

export function escapeSemanticTextChar(
  text: string,
  index: number,
  options: SemanticEscapeOptions = {},
): string {
  const char = text[index] ?? '';
  if (!char) return '';
  const previous = contextualSlice(text, index - 1, index, options);
  const next = contextualSlice(text, index + 1, index + 2, options);
  if (ESCAPABLE.has(char) && char !== ':' && char !== '-' && char !== '.') return `\\${char}`;
  if (
    options.escapeBareUrls !== false
    && char === ':'
    && isHttpSchemeSeparator(text, index, options)
  ) return '\\:';
  if (char === ':' && (previous === ':' || next === ':')) return '\\:';
  if (
    options.escapeBareUrls !== false
    && char === '.'
    && contextualSlice(text, index - 3, index, options).toLowerCase() === 'www'
  ) return '\\.';
  if (char === '-' && WHITESPACE.test(previous) && WHITESPACE.test(next)) return '\\-';
  return char;
}

export function escapeSemanticText(text: string, options: SemanticEscapeOptions = {}): string {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    output += escapeSemanticTextChar(text, index, options);
  }
  return output;
}

export function decodeSemanticEscapes(text: string): string {
  return decodeEscapes(text, 0, new Set());
}

function isHttpSchemeSeparator(text: string, index: number, options: SemanticEscapeOptions): boolean {
  if (contextualSlice(text, index, index + 3, options) !== '://') return false;
  const prefix = contextualSlice(text, index - 5, index, options).toLowerCase();
  return prefix.endsWith('http') || prefix.endsWith('https');
}

function contextualSlice(
  text: string,
  start: number,
  end: number,
  options: Pick<SemanticEscapeOptions, 'prefix' | 'suffix'>,
): string {
  const prefix = options.prefix ?? '';
  const suffix = options.suffix ?? '';
  let output = '';
  for (let index = start; index < end; index += 1) {
    if (index < 0) output += prefix[prefix.length + index] ?? '';
    else if (index >= text.length) output += suffix[index - text.length] ?? '';
    else output += text[index] ?? '';
  }
  return output;
}

function classifyInlineMark(match: RegExpMatchArray, start: number): InlineToken {
  const range = { start, end: start + match[0].length };
  if (match[1] !== undefined) return { ...range, type: 'bold', inner: match[1] };
  if (match[2] !== undefined) return { ...range, type: 'strike', inner: match[2] };
  if (match[3] !== undefined) return { ...range, type: 'highlight', inner: match[3] };
  if (match[4] !== undefined) return { ...range, type: 'italic', inner: match[4] };
  return { ...range, type: 'code', inner: match[5] ?? '' };
}

function markdownInlineTokens(input: string): InlineToken[] {
  const candidates: InlineToken[] = [];
  let offset = 0;
  for (const token of Lexer.lexInline(input)) {
    const start = offset;
    offset += token.raw.length;
    if (token.type !== 'link' || !token.raw.startsWith('[') || !token.href) continue;
    if (isEscapedSemanticAt(input, start)) continue;
    candidates.push({
      start,
      end: offset,
      type: 'link',
      inner: token.text,
      attrs: { href: token.href },
    });
  }
  for (const match of input.matchAll(MARKDOWN_INLINE_MARK_TOKEN)) {
    const start = match.index ?? 0;
    if (isEscapedSemanticAt(input, start)) continue;
    candidates.push(classifyInlineMark(match, start));
  }

  const accepted: InlineToken[] = [];
  for (const candidate of candidates.sort((left, right) => (
    left.start - right.start
    || (left.type === 'link' ? -1 : right.type === 'link' ? 1 : 0)
    || right.end - left.end
  ))) {
    const previous = accepted[accepted.length - 1];
    if (!previous || !rangesOverlap(previous, candidate)) accepted.push(candidate);
  }
  return accepted;
}

function parseMarkdown(input: string): ParsedMarkdown {
  const marks: TextMark[] = [];
  const escapedOffsets = new Set<number>();
  let text = '';
  let cursor = 0;
  for (const token of markdownInlineTokens(input)) {
    text += decodeEscapes(input.slice(cursor, token.start), text.length, escapedOffsets);
    const markStart = text.length;
    if (token.type === 'code') {
      text += token.inner;
    } else {
      text += decodeEscapes(token.inner, text.length, escapedOffsets);
    }
    if (text.length > markStart) {
      marks.push({
        start: markStart,
        end: text.length,
        type: token.type,
        ...(token.attrs ? { attrs: token.attrs } : {}),
      });
    }
    cursor = token.end;
  }
  text += decodeEscapes(input.slice(cursor), text.length, escapedOffsets);
  return { content: { text, marks, inlineRefs: [] }, escapedOffsets };
}

function decodeEscapes(input: string, outputStart: number, escapedOffsets: Set<number>): string {
  let output = '';
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? '';
    const next = input[index + 1] ?? '';
    if (char === '\\' && ESCAPABLE.has(next)) {
      escapedOffsets.add(outputStart + output.length);
      output += next;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function materializeReferenceMarkers(content: RichText, escapedOffsets: ReadonlySet<number>): RichText {
  const protectedRanges = linkAndCodeRanges(content);
  const markers = parseReferenceMarkers(content.text)
    .filter((marker) => (
      !escapedOffsets.has(marker.start)
      && !protectedRanges.some((range) => rangesOverlap(range, marker))
    ));
  if (markers.length === 0) return content;

  const inlineRefs: InlineRef[] = [];
  const removals: Range[] = [];
  let removedLength = 0;
  for (const marker of markers) {
    const displayName = marker.label || referenceDisplayFallback(marker.target);
    inlineRefs.push({
      offset: marker.start - removedLength,
      target: marker.target,
      ...(displayName ? { displayName } : {}),
    });
    removals.push({ start: marker.start, end: marker.end });
    removedLength += marker.end - marker.start;
  }
  const normalizedRemovals = normalizeRanges(removals);
  const stripped = removeRichTextRanges(content, normalizedRemovals);
  const existingInlineRefs = content.inlineRefs.map((ref) => ({
    ...ref,
    offset: remapOffsetAfterRemovals(ref.offset, content.text.length, normalizedRemovals),
  }));
  return {
    ...stripped,
    inlineRefs: [...existingInlineRefs, ...inlineRefs]
      .sort((left, right) => left.offset - right.offset),
  };
}

export function markdownInlineProtectedRanges(text: string): SourceSpan[] {
  const ranges: Range[] = [];
  for (const token of markdownInlineTokens(text)) {
    if (token.type === 'link' || token.type === 'code') ranges.push(token);
  }
  for (const marker of parseReferenceMarkers(text)) {
    if (!isEscapedSemanticAt(text, marker.start)) ranges.push({ start: marker.start, end: marker.end });
  }
  ranges.push(...escapeTokenRanges(text));
  ranges.push(...bareUrlRanges(text));
  return normalizeRanges(ranges);
}

function richTextMetadataProtectedRanges(content: RichText): Range[] {
  return normalizeRanges([
    ...linkAndCodeRanges(content),
    ...referenceMarkerRanges(content.text),
    ...escapeTokenRanges(content.text),
    ...bareUrlRanges(content.text),
  ]);
}

function linkAndCodeRanges(content: RichText): Range[] {
  return content.marks
    .filter((mark) => mark.type === 'link' || mark.type === 'code')
    .map((mark) => ({ start: mark.start, end: mark.end }));
}

function referenceMarkerRanges(text: string): Range[] {
  return parseReferenceMarkers(text)
    .map((marker) => ({ start: marker.start, end: marker.end }));
}

function escapeTokenRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] === '\\' && ESCAPABLE.has(text[index + 1] ?? '')) {
      ranges.push({ start: index, end: index + 2 });
      index += 1;
    }
  }
  return ranges;
}

function escapeBackslashRanges(text: string): Range[] {
  return escapeTokenRanges(text).map((range) => ({ start: range.start, end: range.start + 1 }));
}

function extractMetadata(
  text: string,
  mode: InlineMetadataMode,
  protectedRanges: readonly Range[],
): MetadataExtraction {
  if (mode === 'none') return { fields: [], removals: [], tags: [] };

  const fieldMatches = mode === 'tags-and-fields'
    ? [...text.matchAll(FIELD_START_TOKEN)].flatMap((match) => {
      const matchStart = match.index ?? 0;
      const lead = (match[1] ?? '').length;
      const tokenStart = matchStart + lead;
      if (positionInRanges(tokenStart, protectedRanges)) return [];
      return [{
        match,
        tokenStart,
        removalStart: metadataLeadStart(text, tokenStart),
        valueStart: matchStart + match[0].length,
      }];
    })
    : [];
  const tagMatches = [...matchTagTokens(text)].flatMap((match) => {
    const tokenStart = match.index ?? 0;
    const parsed = parseTagTokenMatch(match);
    if (!parsed || positionInRanges(tokenStart, protectedRanges)) return [];
    const removalStart = metadataLeadStart(text, tokenStart);
    if (removalStart === null) return [];
    return [{ match, parsed, tokenStart, removalStart }];
  });
  const boundaries = [...new Set([
    ...fieldMatches.map((item) => item.removalStart ?? item.tokenStart),
    ...tagMatches.map((item) => item.removalStart),
  ])].sort((left, right) => left - right);

  const fields: InlineFieldToken[] = [];
  const removals: Range[] = [];
  for (const item of fieldMatches) {
    if (removals.some((range) => item.tokenStart >= range.start && item.tokenStart < range.end)) continue;
    const end = nextBoundary(boundaries, item.valueStart, text.length);
    const rawValue = text.slice(item.valueStart, end);
    const value = rawValue.trim();
    if (!value) continue;
    const valueEnd = end - (rawValue.length - rawValue.trimEnd().length);
    fields.push({
      name: item.match[2] ?? '',
      value,
      source: { start: item.tokenStart, end: valueEnd },
    });
    removals.push({ start: item.removalStart ?? item.tokenStart, end });
  }

  const tags: TagDraft[] = [];
  const seenTags = new Set<string>();
  for (const item of tagMatches) {
    if (removals.some((range) => item.tokenStart >= range.start && item.tokenStart < range.end)) continue;
    const end = item.tokenStart + item.match[0].length;
    if (!seenTags.has(item.parsed.name)) {
      seenTags.add(item.parsed.name);
      tags.push({ name: item.parsed.name, source: { start: item.tokenStart, end } });
    }
    removals.push({ start: item.removalStart, end });
  }
  return { fields, removals: normalizeRanges(removals), tags };
}

function metadataLeadStart(text: string, tokenStart: number): number | null {
  if (tokenStart === 0) return 0;
  return WHITESPACE.test(text[tokenStart - 1] ?? '') ? tokenStart - 1 : null;
}

function nextBoundary(boundaries: readonly number[], valueStart: number, fallback: number): number {
  for (const boundary of boundaries) {
    if (boundary >= valueStart) return boundary;
  }
  return fallback;
}

function linkifyBareUrls(
  content: RichText,
  escapedOffsets: ReadonlySet<number> = new Set(),
): RichText {
  const marks = [...content.marks];
  const protectedRanges = referenceMarkerRanges(content.text);
  for (const range of bareUrlRanges(content.text)) {
    if (isEscapedBareUrl(content.text, range, escapedOffsets)) continue;
    if (protectedRanges.some((protectedRange) => rangesOverlap(range, protectedRange))) continue;
    if (marks.some((mark) => (
      (mark.type === 'link' || mark.type === 'code')
      && rangesOverlap(range, mark)
    ))) continue;
    const display = content.text.slice(range.start, range.end);
    marks.push({
      start: range.start,
      end: range.end,
      type: 'link',
      attrs: { href: /^www\./iu.test(display) ? `https://${display}` : display },
    });
  }
  marks.sort((left, right) => left.start - right.start || right.end - left.end);
  return { ...content, marks };
}

function isEscapedBareUrl(
  text: string,
  range: Range,
  escapedOffsets: ReadonlySet<number>,
): boolean {
  const display = text.slice(range.start, range.end);
  const schemeSeparator = display.indexOf('://');
  if (schemeSeparator >= 0 && escapedOffsets.has(range.start + schemeSeparator)) return true;
  return /^www\./iu.test(display) && escapedOffsets.has(range.start + 3);
}

function bareUrlRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const match of text.matchAll(BARE_URL_TOKEN)) {
    const start = match.index ?? 0;
    if (start > 0 && ASCII_WORD.test(text[start - 1] ?? '')) continue;
    let end = start + match[0].length;
    while (end > start) {
      const char = text[end - 1] ?? '';
      if (TRAILING_URL_PUNCTUATION.has(char)) {
        end -= 1;
        continue;
      }
      if (char === ')' && unmatchedClosing(text.slice(start, end), '(', ')')) {
        end -= 1;
        continue;
      }
      if (char === ']' && unmatchedClosing(text.slice(start, end), '[', ']')) {
        end -= 1;
        continue;
      }
      if (char === '}' && unmatchedClosing(text.slice(start, end), '{', '}')) {
        end -= 1;
        continue;
      }
      break;
    }
    if (end > start && isSupportedBareUrlText(text.slice(start, end))) ranges.push({ start, end });
  }
  return ranges;
}

function isSupportedBareUrlText(value: string): boolean {
  if (/^www\./iu.test(value)) return /^www\.[^\s.]+\.[^\s]+$/iu.test(value);
  return /^https?:\/\/\S+$/iu.test(value);
}

function unmatchedClosing(value: string, open: string, close: string): boolean {
  let balance = 0;
  for (const char of value) {
    if (char === open) balance += 1;
    else if (char === close) balance -= 1;
  }
  return balance < 0;
}

function removeTextRanges(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text;
  const removed = removalMask(text.length, ranges);
  trimMask(text, removed);
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    if (removed[index] === 0) output += text[index];
  }
  return output;
}

function removeRichTextRanges(
  content: RichText,
  ranges: readonly Range[],
  options: { trim?: boolean } = {},
): RichText {
  if (ranges.length === 0) return content;
  const removed = removalMask(content.text.length, normalizeRanges(ranges));
  if (options.trim) trimMask(content.text, removed);
  const offsets = new Uint32Array(content.text.length + 1);
  let text = '';
  for (let index = 0; index < content.text.length; index += 1) {
    offsets[index] = text.length;
    if (removed[index] === 0) text += content.text[index];
  }
  offsets[content.text.length] = text.length;

  const marks: TextMark[] = [];
  for (const mark of content.marks) {
    let segmentStart: number | null = null;
    const start = clampOffset(mark.start, content.text.length);
    const end = clampOffset(mark.end, content.text.length);
    for (let index = start; index < end; index += 1) {
      if (removed[index] === 0 && segmentStart === null) segmentStart = index;
      const closes = segmentStart !== null && (removed[index] !== 0 || index === end - 1);
      if (!closes || segmentStart === null) continue;
      const segmentEnd = removed[index] === 0 && index === end - 1 ? index + 1 : index;
      const mappedStart = offsets[segmentStart] ?? 0;
      const mappedEnd = offsets[segmentEnd] ?? text.length;
      if (mappedEnd > mappedStart) marks.push({ ...mark, start: mappedStart, end: mappedEnd });
      segmentStart = null;
    }
  }
  const inlineRefs = content.inlineRefs.flatMap((ref) => {
    const offset = clampOffset(ref.offset, content.text.length);
    if (offset < removed.length && removed[offset] !== 0) return [];
    return [{ ...ref, offset: offsets[offset] ?? text.length }];
  });
  return { text, marks, inlineRefs };
}

function removalMask(length: number, ranges: readonly Range[]): Uint8Array {
  const removed = new Uint8Array(length);
  for (const range of ranges) {
    const start = clampOffset(range.start, length);
    const end = clampOffset(range.end, length);
    for (let index = start; index < end; index += 1) removed[index] = 1;
  }
  return removed;
}

function trimMask(text: string, removed: Uint8Array): void {
  let start = 0;
  while (start < text.length && (removed[start] !== 0 || WHITESPACE.test(text[start] ?? ''))) {
    if (removed[start] === 0) removed[start] = 1;
    start += 1;
  }
  let end = text.length - 1;
  while (end >= 0 && (removed[end] !== 0 || WHITESPACE.test(text[end] ?? ''))) {
    if (removed[end] === 0) removed[end] = 1;
    end -= 1;
  }
}

function normalizeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const result: Range[] = [];
  for (const range of sorted) {
    const last = result[result.length - 1];
    if (!last || range.start > last.end) {
      result.push(range);
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }
  return result;
}

function positionInRanges(position: number, ranges: readonly Range[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle]!;
    if (position < range.start) high = middle - 1;
    else if (position >= range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function rangesOverlap(left: Range, right: Range): boolean {
  return left.start < right.end && right.start < left.end;
}

function clampOffset(value: number, length: number): number {
  return Math.min(Math.max(0, Math.trunc(value)), length);
}

function remapOffsetAfterRemovals(offset: number, length: number, ranges: readonly Range[]): number {
  const safeOffset = clampOffset(offset, length);
  let removedBefore = 0;
  for (const range of ranges) {
    const start = clampOffset(range.start, length);
    const end = clampOffset(range.end, length);
    if (safeOffset <= start) break;
    removedBefore += Math.max(0, Math.min(safeOffset, end) - start);
    if (safeOffset < end) break;
  }
  return safeOffset - removedBefore;
}

function mappedRemovalStarts(removals: readonly Range[]): Set<number> {
  const offsets = new Set<number>();
  let removedLength = 0;
  for (const range of normalizeRanges(removals)) {
    offsets.add(range.start - removedLength);
    removedLength += range.end - range.start;
  }
  return offsets;
}

function referenceDisplayFallback(target: ReferenceTarget): string {
  if (target.kind === 'node') return target.nodeId;
  if (target.kind === 'local-file') return target.path.split('/').filter(Boolean).at(-1) ?? target.path;
  return 'Referenced source';
}
