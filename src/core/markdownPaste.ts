import type { CreateNodeTree, ParsedPasteField, RichText, TextMark, TextMarkKind } from './types';
import {
  matchTagTokens,
  parseCheckboxMarker,
  parseTagTokenMatch,
} from './textSyntax';
import { normalizeCodeLanguage } from './codeLanguages';

export interface ParsedPasteNode {
  text: string;
  children: ParsedPasteNode[];
}

function lineDepth(rawLine: string): number {
  let depth = 0;
  let spaceCount = 0;
  for (const char of rawLine) {
    if (char === '\t') {
      depth += 1;
      spaceCount = 0;
      continue;
    }
    if (char === ' ') {
      spaceCount += 1;
      if (spaceCount === 2) {
        depth += 1;
        spaceCount = 0;
      }
      continue;
    }
    break;
  }
  return depth;
}

function listText(rawLine: string): string {
  return rawLine
    .trim()
    .replace(/^[-*+]\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/^[•◦▪‣·●]\s+/u, '')
    .trim();
}

export function parsePlainTextOutlinerPaste(text: string): ParsedPasteNode[] {
  const roots: ParsedPasteNode[] = [];
  const stack: Array<{ depth: number; children: ParsedPasteNode[] }> = [
    { depth: -1, children: roots },
  ];

  for (const rawLine of text.replace(/\r\n?/gu, '\n').split('\n')) {
    const nextText = listText(rawLine);
    if (!nextText) continue;

    const depth = lineDepth(rawLine);
    while (stack.length > 1 && depth <= stack[stack.length - 1].depth) {
      stack.pop();
    }

    const node: ParsedPasteNode = { text: nextText, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push({ depth, children: node.children });
  }

  return roots;
}

const INLINE_TOKEN =
  /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|==([^=\n]+)==|\*([^*\n]+)\*|`([^`\n]+)`/gu;

interface InlineToken {
  type: TextMarkKind;
  inner: string;
  attrs?: Record<string, string>;
}

function classifyInline(match: RegExpMatchArray): InlineToken {
  if (match[1] !== undefined) return { type: 'link', inner: match[1], attrs: { href: match[2] ?? '' } };
  if (match[3] !== undefined) return { type: 'bold', inner: match[3] };
  if (match[4] !== undefined) return { type: 'strike', inner: match[4] };
  if (match[5] !== undefined) return { type: 'highlight', inner: match[5] };
  if (match[6] !== undefined) return { type: 'italic', inner: match[6] };
  return { type: 'code', inner: match[7] ?? '' };
}

export function parseInlineMarkdown(rawText: string): RichText {
  const marks: TextMark[] = [];
  let text = '';
  let index = 0;
  for (const match of rawText.matchAll(INLINE_TOKEN)) {
    const start = match.index ?? 0;
    text += rawText.slice(index, start);
    const token = classifyInline(match);
    const markStart = text.length;
    text += token.inner;
    if (token.inner.length > 0) {
      const mark: TextMark = { start: markStart, end: text.length, type: token.type };
      if (token.attrs) mark.attrs = token.attrs;
      marks.push(mark);
    }
    index = start + match[0].length;
  }
  text += rawText.slice(index);
  return { text, marks, inlineRefs: [] };
}

export function applyHeadingMark(content: RichText): RichText {
  if (content.text.length === 0) return content;
  return {
    ...content,
    marks: [{ start: 0, end: content.text.length, type: 'headingMark' }, ...content.marks],
  };
}

const FENCE_RE = /^(\s*)(```|~~~)[ \t]*([^\n]*?)[ \t]*$/u;

function fenceLanguage(info: string): string {
  return normalizeCodeLanguage(info.trim().split(/\s+/u)[0] ?? '');
}

const FIELD_START_TOKEN = /(^|\s)([A-Za-z][\w-]*)::[ \t]+/gu;

function harvestProtectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(INLINE_TOKEN)) {
    if (match[1] === undefined && match[7] === undefined) continue;
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

function inAnyRange(pos: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

function metadataLeadStart(text: string, tokenStart: number): number | null {
  if (tokenStart === 0) return 0;
  return /\s/u.test(text[tokenStart - 1] ?? '') ? tokenStart - 1 : null;
}

function fieldBoundaryStart(match: RegExpMatchArray, protectedRanges: ReadonlyArray<readonly [number, number]>): number | null {
  const start = match.index ?? 0;
  const lead = (match[1] ?? '').length;
  const tokenStart = start + lead;
  return inAnyRange(tokenStart, protectedRanges) ? null : start;
}

function tagBoundaryStart(text: string, match: RegExpMatchArray, protectedRanges: ReadonlyArray<readonly [number, number]>): number | null {
  const tokenStart = match.index ?? 0;
  if (!parseTagTokenMatch(match) || inAnyRange(tokenStart, protectedRanges)) return null;
  return metadataLeadStart(text, tokenStart);
}

function metadataBoundaries(text: string, protectedRanges: ReadonlyArray<readonly [number, number]>): number[] {
  const boundaries: number[] = [];
  for (const match of text.matchAll(FIELD_START_TOKEN)) {
    const start = fieldBoundaryStart(match, protectedRanges);
    if (start !== null) boundaries.push(start);
  }
  for (const match of matchTagTokens(text)) {
    const start = tagBoundaryStart(text, match, protectedRanges);
    if (start !== null) boundaries.push(start);
  }
  return [...new Set(boundaries)].sort((left, right) => left - right);
}

function nextMetadataBoundary(boundaries: readonly number[], valueStart: number, fallback: number): number {
  for (const boundary of boundaries) {
    if (boundary >= valueStart) return boundary;
  }
  return fallback;
}

function extractTagsAndFields(text: string): { text: string; tags: string[]; fields: ParsedPasteField[] } {
  const tags: string[] = [];
  const fields: ParsedPasteField[] = [];
  const protectedRanges = harvestProtectedRanges(text);
  const boundaries = metadataBoundaries(text, protectedRanges);
  const removals: Array<{ start: number; end: number; lead: number }> = [];
  for (const match of text.matchAll(FIELD_START_TOKEN)) {
    const start = match.index ?? 0;
    const lead = (match[1] ?? '').length;
    const tokenStart = start + lead;
    if (inAnyRange(tokenStart, protectedRanges)) continue;
    if (removals.some((removal) => tokenStart >= removal.start && tokenStart < removal.end)) continue;
    const valueStart = start + match[0].length;
    const end = nextMetadataBoundary(boundaries, valueStart, text.length);
    const value = text.slice(valueStart, end).trim();
    if (!value) continue;
    fields.push({ name: match[2] ?? '', value });
    removals.push({ start, end, lead });
  }
  for (const match of matchTagTokens(text)) {
    const tokenStart = match.index ?? 0;
    const leadStart = metadataLeadStart(text, tokenStart);
    const parsed = parseTagTokenMatch(match);
    if (leadStart === null || !parsed || inAnyRange(tokenStart, protectedRanges)) continue;
    if (removals.some((removal) => tokenStart >= removal.start && tokenStart < removal.end)) continue;
    tags.push(parsed.name);
    removals.push({ start: leadStart, end: tokenStart + match[0].length, lead: tokenStart - leadStart });
  }
  removals.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const removal of removals) {
    if (removal.start < cursor) continue;
    out += text.slice(cursor, removal.start + removal.lead);
    cursor = removal.end;
  }
  out += text.slice(cursor);
  return { text: out.replace(/\s{2,}/gu, ' ').trim(), tags, fields };
}

function lineToTree(rawText: string): CreateNodeTree {
  const heading = rawText.match(/^(#{1,6})\s+(.*)$/u);
  let body = heading ? (heading[2] ?? '') : rawText;
  const task = parseCheckboxMarker(body);
  if (task) body = task.rest;
  const { text, tags, fields } = extractTagsAndFields(body);
  const parsed = parseInlineMarkdown(text);
  const tree: CreateNodeTree = {
    content: heading ? applyHeadingMark(parsed) : parsed,
    children: [],
  };
  if (tags.length > 0) tree.tags = tags;
  if (fields.length > 0) tree.fields = fields;
  if (task) {
    tree.checkbox = true;
    tree.done = task.checked;
  }
  return tree;
}

export function parseMarkdownBlocks(text: string): CreateNodeTree[] {
  const roots: CreateNodeTree[] = [];
  const stack: Array<{ depth: number; children: CreateNodeTree[] }> = [{ depth: -1, children: roots }];

  const push = (depth: number, node: CreateNodeTree) => {
    while (stack.length > 1 && depth <= stack[stack.length - 1].depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ depth, children: node.children });
  };

  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const fence = rawLine.match(FENCE_RE);
    if (fence) {
      const indent = fence[1] ?? '';
      const marker = fence[2];
      const lang = fenceLanguage(fence[3] ?? '');
      const depth = lineDepth(rawLine);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trimStart().slice(0, marker.length) !== marker) {
        const codeLine = lines[i];
        body.push(codeLine.startsWith(indent) ? codeLine.slice(indent.length) : codeLine);
        i += 1;
      }
      if (i < lines.length) i += 1;
      push(depth, {
        content: { text: body.join('\n'), marks: [], inlineRefs: [] },
        children: [],
        type: 'codeBlock',
        codeLanguage: lang || undefined,
      });
      continue;
    }

    const normalized = listText(rawLine);
    if (!normalized) {
      i += 1;
      continue;
    }
    push(lineDepth(rawLine), lineToTree(normalized));
    i += 1;
  }

  return roots;
}
