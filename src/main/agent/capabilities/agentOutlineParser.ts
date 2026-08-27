import { parseCheckboxMarker } from '../../../core/textSyntax';
import { parseReferenceMarkers } from '../../../core/referenceMarkup';
import { normalizeCodeLanguage } from '../../../core/codeLanguages';
import { canonicalMarkdownProtectedRanges } from '../../../core/semanticIngest/canonicalMarkdown';
import {
  decodeSemanticEscapes,
  isEscapedSemanticAt,
  markdownInlineProtectedRanges,
  scanMarkdownInline,
} from '../../../core/semanticIngest/inlineScanner';
import type { SourceSpan } from '../../../core/semanticIngest/types';

export interface OutlineDocument {
  roots: OutlineNode[];
  fields: OutlineField[];
}

export interface OutlineNode {
  nodeId?: string;
  title: string;
  description?: string | null;
  tags: string[];
  checked?: boolean | null;
  fields: OutlineField[];
  children: OutlineNode[];
  referenceTargetId?: string;
  codeBlock?: boolean;
  codeLanguage?: string;
  search?: boolean;
  view?: string;
  viewConfig?: OutlineViewConfigLine[];
}

export type OutlineViewConfigKind = 'sort' | 'filter' | 'group' | 'display';

export interface OutlineViewConfigLine {
  nodeId?: string;
  directive: string;
  kind?: OutlineViewConfigKind;
  hasUnsupportedHeaderSyntax?: boolean;
  fields: OutlineField[];
  children: OutlineNode[];
}

export interface OutlineField {
  nodeId?: string;
  name: string;
  values: OutlineValue[];
  clear: boolean;
}

export interface OutlineValue {
  nodeId?: string;
  text: string;
  outlineSource?: string;
  targetId?: string;
}

export interface OutlineParseError {
  code?: string;
  message: string;
  line: number;
  column: number;
}

export interface OutlineParseResult {
  ok: true;
  document: OutlineDocument;
  warnings: string[];
}

export interface OutlineParseFailure {
  ok: false;
  error: OutlineParseError;
}

interface ParsedLine {
  level: number;
  text: string;
  line: number;
  column: number;
  codeBlock?: {
    language?: string;
    text: string;
  };
}

type StackFrame =
  | { kind: 'node'; level: number; node: OutlineNode }
  | { kind: 'field'; level: number; field: OutlineField };

const FENCE_START_RE = /^(`{3,}|~{3,})[ \t]*([^\n]*?)[ \t]*$/u;
const ORDINARY_INLINE_REFERENCE_DIRECTIVE = '%%inline-reference%%';

export function parseLinOutline(
  input: string,
  options: { annotations?: 'allow' | 'forbid' } = {},
): OutlineParseResult | OutlineParseFailure {
  const normalized = input.replace(/\r\n?/g, '\n');
  const parsedLines: ParsedLine[] = [];
  const warnings: string[] = [];
  const annotations = options.annotations ?? 'forbid';

  const rawLines = normalized.split('\n');
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? '';
    if (rawLine.trim().length === 0) continue;
    const line = index + 1;
    const leading = rawLine.match(/^ */)?.[0].length ?? 0;
    if (rawLine.includes('\t')) {
      return { ok: false, error: { message: 'Tabs are not allowed in outline format.', line, column: rawLine.indexOf('\t') + 1 } };
    }
    if (leading % 2 !== 0) {
      return { ok: false, error: { message: 'Indentation must use exactly 2 spaces per level.', line, column: leading + 1 } };
    }
    const rest = rawLine.slice(leading);
    if (!rest.startsWith('- ')) {
      return { ok: false, error: { message: 'Every non-empty line must start with "- ".', line, column: leading + 1 } };
    }
    const text = rest.slice(2).trim();
    const fence = stripNodeMarker(text).text.match(FENCE_START_RE);
    if (!fence) {
      parsedLines.push({ level: leading / 2, text, line, column: leading + 3 });
      continue;
    }

    const marker = fence[1] ?? '```';
    const language = normalizeCodeLanguage((fence[2] ?? '').trim().split(/\s+/u)[0] ?? '') || undefined;
    const fenceIndent = ' '.repeat(leading);
    const body: string[] = [];
    index += 1;
    while (index < rawLines.length) {
      const codeLine = rawLines[index] ?? '';
      if (isClosingFenceLine(codeLine, marker)) break;
      body.push(codeLine.startsWith(fenceIndent) ? codeLine.slice(fenceIndent.length) : codeLine);
      index += 1;
    }
    if (index >= rawLines.length) {
      return {
        ok: false,
        error: {
          code: 'unclosed_code_fence',
          message: `Code fence starting on line ${line} is missing a closing ${marker} fence.`,
          line,
          column: leading + 3,
        },
      };
    }
    parsedLines.push({
      level: leading / 2,
      text,
      line,
      column: leading + 3,
      codeBlock: { language, text: body.join('\n') },
    });
  }

  const roots: OutlineNode[] = [];
  const documentFields: OutlineField[] = [];
  const stack: StackFrame[] = [];

  for (const line of parsedLines) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= line.level) stack.pop();
    const parent = stack[stack.length - 1];
    const forbiddenAnnotationIndex = annotations === 'forbid'
      ? unprotectedIndexOf(line.text, '%%node:')
      : -1;
    if (forbiddenAnnotationIndex >= 0) {
      return {
        ok: false,
        error: {
          code: 'invalid_annotation',
          message: 'Node annotations are not allowed in this outline.',
          line: line.line,
          column: line.column + forbiddenAnnotationIndex,
        },
      };
    }
    const annotated = stripNodeMarker(line.text);
    const fieldHeader = line.codeBlock ? null : parseFieldHeader(annotated.text);

    if (fieldHeader && (!parent || parent.kind === 'node')) {
      const field: OutlineField = {
        ...(annotated.nodeId ? { nodeId: annotated.nodeId } : {}),
        name: fieldHeader.name,
        values: fieldHeader.value ? [parseOutlineValue(fieldHeader.value)] : [],
        clear: !fieldHeader.value,
      };
      if (parent?.kind === 'node') parent.node.fields.push(field);
      else documentFields.push(field);
      stack.push({ kind: 'field', level: line.level, field });
      continue;
    }

    if (parent?.kind === 'field') {
      parent.field.values.push(parseOutlineValue(annotated.text, annotated.nodeId));
      parent.field.clear = false;
      stack.push({ kind: 'field', level: line.level, field: parent.field });
      continue;
    }

    const node = line.codeBlock
      ? parseCodeBlockNode(line.codeBlock, annotated.nodeId)
      : parseOutlineNode(annotated.text, annotated.nodeId);
    if (!parent) roots.push(node);
    else parent.node.children.push(node);
    stack.push({ kind: 'node', level: line.level, node });
  }

  if (roots.length === 0 && documentFields.length === 0) {
    return { ok: false, error: { message: 'Outline must contain at least one node or field.', line: 1, column: 1 } };
  }

  for (const root of roots) extractViewConfigLines(root);

  return { ok: true, document: { roots, fields: documentFields }, warnings };
}

const VIEW_CONFIG_DIRECTIVES = new Map<string, OutlineViewConfigKind>([
  ['%%view-sort%%', 'sort'],
  ['%%view-filter%%', 'filter'],
  ['%%view-group%%', 'group'],
  ['%%view-display%%', 'display'],
]);

function extractViewConfigLines(node: OutlineNode): void {
  const children: OutlineNode[] = [];
  const viewConfig: OutlineViewConfigLine[] = [];
  for (const child of node.children) {
    const directive = child.title.trim();
    const kind = VIEW_CONFIG_DIRECTIVES.get(directive);
    const isViewConfigDirective = kind !== undefined || directive.startsWith('%%view-');
    if (isViewConfigDirective) {
      const hasUnsupportedHeaderSyntax = child.tags.length > 0
        || child.checked !== undefined
        || (child.description !== undefined && child.description !== null)
        || child.search === true
        || child.view !== undefined
        || child.referenceTargetId !== undefined
        || child.codeBlock === true;
      viewConfig.push({
        ...(child.nodeId ? { nodeId: child.nodeId } : {}),
        directive,
        ...(kind ? { kind } : {}),
        ...(hasUnsupportedHeaderSyntax ? { hasUnsupportedHeaderSyntax: true } : {}),
        fields: child.fields,
        children: child.children,
      });
      continue;
    }
    extractViewConfigLines(child);
    children.push(child);
  }
  node.children = children;
  if (viewConfig.length > 0) node.viewConfig = viewConfig;
}

function isClosingFenceLine(line: string, marker: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith(marker) && /^[ \t]*$/u.test(trimmed.slice(marker.length));
}

function parseCodeBlockNode(
  codeBlock: { language?: string; text: string },
  nodeId?: string,
): OutlineNode {
  return {
    ...(nodeId ? { nodeId } : {}),
    title: codeBlock.text,
    description: null,
    tags: [],
    fields: [],
    children: [],
    codeBlock: true,
    codeLanguage: codeBlock.language,
  };
}

function parseOutlineNode(input: string, nodeId?: string): OutlineNode {
  let text = input.trim();
  const searchDirective = removeUnprotectedLiteral(text, '%%search%%');
  const search = searchDirective.removed;
  text = searchDirective.text.trim();
  const viewDirective = removeViewDirectives(text);
  const view = viewDirective.view;
  text = viewDirective.text.trim();

  let checked: boolean | null | undefined;
  const checkbox = parseCheckboxMarker(text);
  if (checkbox) {
    checked = checkbox.checked;
    text = checkbox.rest.trim();
  }

  const scanned = scanMarkdownInline(text, {
    metadata: 'tags',
    linkifyBareUrls: true,
    references: true,
  });
  const tags = scanned.tags.map((tag) => tag.name);
  text = scanned.source.trim();

  const hasOrdinaryReferenceDirective = text.startsWith(ORDINARY_INLINE_REFERENCE_DIRECTIVE);
  const reference = hasOrdinaryReferenceDirective ? null : parseReference(text);
  if (reference && reference.full) {
    return {
      ...(nodeId ? { nodeId } : {}),
      title: reference.display,
      description: null,
      tags,
      checked,
      fields: [],
      children: [],
      referenceTargetId: reference.targetId,
      search,
      view,
    };
  }

  const [wireTitlePart, descriptionPart] = splitDescription(text);
  const ordinaryReferenceSource = stripOrdinaryInlineReferenceDirective(wireTitlePart.trim());
  const titlePart = ordinaryReferenceSource ?? wireTitlePart;
  return {
    ...(nodeId ? { nodeId } : {}),
    title: titlePart.trim() || '(untitled)',
    description: descriptionPart ? decodeSemanticEscapes(descriptionPart.trim()) || null : null,
    tags,
    checked,
    fields: [],
    children: [],
    search,
    view,
  };
}

function parseFieldHeader(text: string): { name: string; value: string } | null {
  const separator = unprotectedIndexOf(text, '::');
  if (separator < 0) return null;
  const name = decodeSemanticEscapes(text.slice(0, separator).trim());
  if (!name) return null;
  return { name, value: text.slice(separator + 2).trim() };
}

function parseOutlineValue(text: string, lineNodeId?: string): OutlineValue {
  const annotated = stripNodeMarker(text.trim());
  const nodeId = lineNodeId ?? annotated.nodeId;
  const wireSource = annotated.text.trim();
  const ordinaryReferenceSource = stripOrdinaryInlineReferenceDirective(wireSource);
  const source = ordinaryReferenceSource ?? wireSource;
  const reference = ordinaryReferenceSource === null ? parseReference(source) : null;
  if (reference?.full) {
    return {
      ...(nodeId ? { nodeId } : {}),
      text: reference.display,
      targetId: reference.targetId,
    };
  }
  const visibleText = scanMarkdownInline(source, {
    metadata: 'none',
    linkifyBareUrls: true,
    references: true,
  }).content.text;
  return {
    ...(nodeId ? { nodeId } : {}),
    text: visibleText,
    ...(source !== visibleText ? { outlineSource: source } : {}),
  };
}

function stripNodeMarker(text: string): { nodeId?: string; text: string } {
  const match = /^%%node:([^\s%]+)(?:\s+[^%]*)?%%\s*/.exec(text.trim());
  if (!match) return { text };
  return {
    nodeId: match[1]!.trim(),
    text: text.trim().slice(match[0].length).trim(),
  };
}

function parseReference(text: string): { display: string; targetId: string; full: boolean } | null {
  const shape = terminalNodeReferenceShape(text);
  if (!shape) return null;
  if (shape.delimiterIndex !== null && isEscapedSemanticAt(text, shape.delimiterIndex)) return null;
  const display = shape.displaySource
    ? decodeSemanticEscapes(shape.displaySource)
    : shape.targetId;
  return { display: display || shape.targetId, targetId: shape.targetId, full: true };
}

export function disambiguateOrdinaryOutlineReferenceShape(text: string): string {
  const shape = terminalNodeReferenceShape(text);
  if (!shape) return text;
  if (shape.delimiterIndex === null) return `${ORDINARY_INLINE_REFERENCE_DIRECTIVE} ${text}`;
  if (isEscapedSemanticAt(text, shape.delimiterIndex)) return text;
  return `${text.slice(0, shape.delimiterIndex)}\\${text.slice(shape.delimiterIndex)}`;
}

function stripOrdinaryInlineReferenceDirective(text: string): string | null {
  if (!text.startsWith(`${ORDINARY_INLINE_REFERENCE_DIRECTIVE} `)) return null;
  const source = text.slice(ORDINARY_INLINE_REFERENCE_DIRECTIVE.length).trimStart();
  const shape = terminalNodeReferenceShape(source);
  return shape?.delimiterIndex === null ? source : null;
}

function terminalNodeReferenceShape(text: string): {
  delimiterIndex: number | null;
  displaySource: string;
  targetId: string;
} | null {
  const protectedRanges = canonicalMarkdownProtectedRanges(text);
  const markers = parseReferenceMarkers(text).filter((marker) => (
    !protectedRanges.some((range) => marker.start < range.end && range.start < marker.end)
  ));
  if (markers.length !== 1) return null;
  const marker = markers[0]!;
  if (marker.target.kind !== 'node') return null;
  const after = text.slice(marker.end).trim();
  if (after) return null;
  const before = text.slice(0, marker.start).trimEnd();
  if (!before) {
    return { delimiterIndex: null, displaySource: '', targetId: marker.target.nodeId };
  }
  const delimiterIndex = before.length - 1;
  if (text[delimiterIndex] !== ':') return null;
  return {
    delimiterIndex,
    displaySource: text.slice(0, delimiterIndex).trim(),
    targetId: marker.target.nodeId,
  };
}

function splitDescription(text: string): [string, string?] {
  const separator = unprotectedIndexOf(text, ' - ');
  if (separator < 0) return [text];
  return [text.slice(0, separator), text.slice(separator + 3)];
}

function unprotectedIndexOf(
  text: string,
  token: string,
  fromIndex = 0,
  protectedRanges: readonly SourceSpan[] = markdownInlineProtectedRanges(text),
): number {
  let index = text.indexOf(token, fromIndex);
  while (index >= 0) {
    const end = index + token.length;
    if (!protectedRanges.some((range) => index < range.end && range.start < end)) return index;
    index = text.indexOf(token, index + 1);
  }
  return -1;
}

function removeUnprotectedLiteral(text: string, token: string): { text: string; removed: boolean } {
  const protectedRanges = markdownInlineProtectedRanges(text);
  let output = '';
  let cursor = 0;
  let removed = false;
  while (cursor < text.length) {
    const index = unprotectedIndexOf(text, token, cursor, protectedRanges);
    if (index < 0) break;
    output += text.slice(cursor, index);
    cursor = index + token.length;
    removed = true;
  }
  output += text.slice(cursor);
  return { text: output, removed };
}

function removeViewDirectives(text: string): { text: string; view?: string } {
  const pattern = /%%view:([a-zA-Z0-9_-]+)%%/gu;
  const protectedRanges = markdownInlineProtectedRanges(text);
  let output = '';
  let cursor = 0;
  let view: string | undefined;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (protectedRanges.some((range) => start < range.end && range.start < end)) continue;
    output += text.slice(cursor, start);
    cursor = end;
    view ??= match[1];
  }
  output += text.slice(cursor);
  return { text: output, ...(view ? { view } : {}) };
}
