export interface OutlineDocument {
  roots: OutlineNode[];
}

export interface OutlineNode {
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
  name: string;
  values: OutlineValue[];
  clear: boolean;
}

export interface OutlineValue {
  text: string;
  targetId?: string;
}

export interface OutlineParseError {
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
}

type StackFrame =
  | { kind: 'node'; level: number; node: OutlineNode }
  | { kind: 'field'; level: number; field: OutlineField };

export function parseLinOutline(input: string): OutlineParseResult | OutlineParseFailure {
  const normalized = input.replace(/\r\n?/g, '\n');
  const parsedLines: ParsedLine[] = [];
  const warnings: string[] = [];

  for (const [index, rawLine] of normalized.split('\n').entries()) {
    if (rawLine.trim().length === 0) continue;
    const line = index + 1;
    const leading = rawLine.match(/^ */)?.[0].length ?? 0;
    if (rawLine.includes('\t')) {
      return { ok: false, error: { message: 'Tabs are not allowed in Lin Outline Format.', line, column: rawLine.indexOf('\t') + 1 } };
    }
    if (leading % 2 !== 0) {
      return { ok: false, error: { message: 'Indentation must use exactly 2 spaces per level.', line, column: leading + 1 } };
    }
    const rest = rawLine.slice(leading);
    if (!rest.startsWith('- ')) {
      return { ok: false, error: { message: 'Every non-empty line must start with "- ".', line, column: leading + 1 } };
    }
    parsedLines.push({ level: leading / 2, text: rest.slice(2).trim(), line });
  }

  const roots: OutlineNode[] = [];
  const stack: StackFrame[] = [];

  for (const line of parsedLines) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= line.level) stack.pop();
    const parent = stack[stack.length - 1];
    const fieldHeader = parseFieldHeader(line.text);

    if (fieldHeader && parent?.kind === 'node') {
      const field: OutlineField = {
        name: fieldHeader.name,
        values: fieldHeader.value ? [parseOutlineValue(fieldHeader.value)] : [],
        clear: !fieldHeader.value,
      };
      parent.node.fields.push(field);
      stack.push({ kind: 'field', level: line.level, field });
      continue;
    }

    if (parent?.kind === 'field') {
      parent.field.values.push(parseOutlineValue(line.text));
      parent.field.clear = false;
      stack.push({ kind: 'field', level: line.level, field: parent.field });
      continue;
    }

    const node = parseOutlineNode(line.text);
    if (!parent) roots.push(node);
    else parent.node.children.push(node);
    stack.push({ kind: 'node', level: line.level, node });
  }

  if (roots.length === 0) {
    return { ok: false, error: { message: 'Outline must contain at least one node.', line: 1, column: 1 } };
  }

  return { ok: true, document: { roots }, warnings };
}

function parseOutlineNode(input: string): OutlineNode {
  let text = input.trim();
  const search = text.includes('%%search%%');
  text = text.replace(/%%search%%/g, '').trim();
  const viewMatch = text.match(/%%view:([a-zA-Z0-9_-]+)%%/);
  const view = viewMatch?.[1];
  text = text.replace(/%%view:[a-zA-Z0-9_-]+%%/g, '').trim();

  let checked: boolean | null | undefined;
  if (/^\[[ xX]\]\s*/.test(text)) {
    checked = /^\[[xX]\]/.test(text);
    text = text.replace(/^\[[ xX]\]\s*/, '').trim();
  }

  const tags = extractTags(text);
  text = removeTags(text).trim();

  const reference = parseReference(text);
  if (reference && reference.full) {
    return {
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

function parseOutlineValue(text: string): OutlineValue {
  const reference = parseReference(text.trim());
  if (reference?.full) return { text: reference.display, targetId: reference.targetId };
  return { text: text.trim() };
}

function parseReference(text: string): { display: string; targetId: string; full: boolean } | null {
  const match = /^\[\[(.+?)\^(.+?)\]\]$/.exec(text);
  if (!match) return null;
  return { display: match[1]!.trim(), targetId: match[2]!.trim(), full: true };
}

function splitDescription(text: string): [string, string?] {
  const separator = text.indexOf(' - ');
  if (separator < 0) return [text];
  return [text.slice(0, separator), text.slice(separator + 3)];
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(/\[\[#([^\]]+)\]\]|#\[\[([^\]]+)\]\]|#([\p{L}\p{N}_-]+)/gu)) {
    const tag = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (tag) tags.push(tag);
  }
  return [...new Set(tags)];
}

function removeTags(text: string): string {
  return text.replace(/\[\[#([^\]]+)\]\]|#\[\[([^\]]+)\]\]|#([\p{L}\p{N}_-]+)/gu, '').replace(/\s+/g, ' ').trim();
}
