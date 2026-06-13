import { extractTags, parseCheckboxMarker, removeTagTokens } from '../core/textSyntax';
import { parseNodeReferenceMarkers, parseReferenceMarkers } from '../core/referenceMarkup';

export interface OutlineDocument {
  roots: OutlineNode[];
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
  search?: boolean;
  view?: string;
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
}

type StackFrame =
  | { kind: 'node'; level: number; node: OutlineNode }
  | { kind: 'field'; level: number; field: OutlineField };

export function parseLinOutline(
  input: string,
  options: { annotations?: 'allow' | 'forbid' } = {},
): OutlineParseResult | OutlineParseFailure {
  const normalized = input.replace(/\r\n?/g, '\n');
  const parsedLines: ParsedLine[] = [];
  const warnings: string[] = [];
  const annotations = options.annotations ?? 'forbid';

  for (const [index, rawLine] of normalized.split('\n').entries()) {
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
    parsedLines.push({ level: leading / 2, text: rest.slice(2).trim(), line, column: leading + 3 });
  }

  const roots: OutlineNode[] = [];
  const stack: StackFrame[] = [];

  for (const line of parsedLines) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= line.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (annotations === 'forbid' && line.text.includes('%%node:')) {
      return {
        ok: false,
        error: {
          code: 'invalid_annotation',
          message: 'Node annotations are not allowed in this outline.',
          line: line.line,
          column: line.column + Math.max(0, line.text.indexOf('%%node:')),
        },
      };
    }
    const annotated = stripNodeMarker(line.text);
    const fieldHeader = parseFieldHeader(annotated.text);

    if (fieldHeader && parent?.kind === 'node') {
      const field: OutlineField = {
        ...(annotated.nodeId ? { nodeId: annotated.nodeId } : {}),
        name: fieldHeader.name,
        values: fieldHeader.value ? [parseOutlineValue(fieldHeader.value)] : [],
        clear: !fieldHeader.value,
      };
      parent.node.fields.push(field);
      stack.push({ kind: 'field', level: line.level, field });
      continue;
    }

    if (parent?.kind === 'field') {
      parent.field.values.push(parseOutlineValue(annotated.text, annotated.nodeId));
      parent.field.clear = false;
      stack.push({ kind: 'field', level: line.level, field: parent.field });
      continue;
    }

    const node = parseOutlineNode(annotated.text, annotated.nodeId);
    if (!parent) roots.push(node);
    else parent.node.children.push(node);
    stack.push({ kind: 'node', level: line.level, node });
  }

  if (roots.length === 0) {
    return { ok: false, error: { message: 'Outline must contain at least one node.', line: 1, column: 1 } };
  }

  return { ok: true, document: { roots }, warnings };
}

function parseOutlineNode(input: string, nodeId?: string): OutlineNode {
  let text = input.trim();
  const search = text.includes('%%search%%');
  text = text.replace(/%%search%%/g, '').trim();
  const viewMatch = text.match(/%%view:([a-zA-Z0-9_-]+)%%/);
  const view = viewMatch?.[1];
  text = text.replace(/%%view:[a-zA-Z0-9_-]+%%/g, '').trim();

  let checked: boolean | null | undefined;
  const checkbox = parseCheckboxMarker(text);
  if (checkbox) {
    checked = checkbox.checked;
    text = checkbox.rest.trim();
  }

  const tags = extractTags(maskReferenceMarkers(text)).tags;
  text = removeTagsOutsideReferenceMarkers(text).trim();

  const reference = parseReference(text);
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

  const [titlePart, descriptionPart] = splitDescription(text);
  return {
    ...(nodeId ? { nodeId } : {}),
    title: titlePart.trim() || '(untitled)',
    description: descriptionPart?.trim() || null,
    tags,
    checked,
    fields: [],
    children: [],
    search,
    view,
  };
}

function parseFieldHeader(text: string): { name: string; value: string } | null {
  const match = /^(.+?)::\s*(.*)$/.exec(text);
  if (!match) return null;
  const name = match[1]!.trim();
  if (!name) return null;
  return { name, value: match[2]?.trim() ?? '' };
}

function parseOutlineValue(text: string, lineNodeId?: string): OutlineValue {
  const annotated = stripNodeMarker(text.trim());
  const nodeId = lineNodeId ?? annotated.nodeId;
  const reference = parseReference(annotated.text.trim());
  if (reference?.full) {
    return {
      ...(nodeId ? { nodeId } : {}),
      text: reference.display,
      targetId: reference.targetId,
    };
  }
  return {
    ...(nodeId ? { nodeId } : {}),
    text: annotated.text.trim(),
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
  const marker = parseNodeReferenceMarkers(text)[0];
  if (!marker || marker.start !== 0 || marker.end !== text.length) return null;
  return { display: marker.label || marker.nodeId, targetId: marker.nodeId, full: true };
}

function splitDescription(text: string): [string, string?] {
  const separator = text.indexOf(' - ');
  if (separator < 0) return [text];
  return [text.slice(0, separator), text.slice(separator + 3)];
}

function maskReferenceMarkers(text: string): string {
  const markers = parseReferenceMarkers(text);
  if (markers.length === 0) return text;
  let masked = '';
  let cursor = 0;
  for (const marker of markers) {
    masked += text.slice(cursor, marker.start);
    masked += ' '.repeat(marker.raw.length);
    cursor = marker.end;
  }
  masked += text.slice(cursor);
  return masked;
}

function removeTagsOutsideReferenceMarkers(text: string): string {
  const markers = parseReferenceMarkers(text);
  if (markers.length === 0) return removeTagTokens(text);
  const placeholders = new Map<string, string>();
  let protectedText = '';
  let cursor = 0;
  for (const [index, marker] of markers.entries()) {
    const placeholder = `__LIN_REFERENCE_MARKER_${index}__`;
    placeholders.set(placeholder, marker.raw);
    protectedText += text.slice(cursor, marker.start);
    protectedText += placeholder;
    cursor = marker.end;
  }
  protectedText += text.slice(cursor);
  let next = removeTagTokens(protectedText);
  for (const [placeholder, marker] of placeholders) {
    next = next.replace(placeholder, marker);
  }
  return next;
}
