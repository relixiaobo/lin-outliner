import type { CreateNodeTree, RichText } from './types';
import { parseCheckboxMarker } from './textSyntax';
import { normalizeCodeLanguage } from './codeLanguages';
import {
  parseInlineMarkdownWithLinks,
  scanMarkdownInline,
} from './semanticIngest/inlineScanner';

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

export function parseInlineMarkdown(rawText: string): RichText {
  return parseInlineMarkdownWithLinks(rawText);
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

function lineToTree(rawText: string): CreateNodeTree {
  const heading = rawText.match(/^(#{1,6})\s+(.*)$/u);
  let body = heading ? (heading[2] ?? '') : rawText;
  const task = parseCheckboxMarker(body);
  if (task) body = task.rest;
  const scanned = scanMarkdownInline(body, {
    metadata: 'tags-and-fields',
    linkifyBareUrls: true,
    references: false,
  });
  const tree: CreateNodeTree = {
    content: heading ? applyHeadingMark(scanned.content) : scanned.content,
    children: [],
  };
  if (scanned.tags.length > 0) tree.tags = scanned.tags.map((tag) => tag.name);
  if (scanned.fields.length > 0) {
    tree.fields = scanned.fields.map((field) => ({ name: field.name, value: field.value }));
  }
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
