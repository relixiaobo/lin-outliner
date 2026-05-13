import type { CreateNodeTree, RichText, TextMark } from '../../api/types';

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

function lineText(rawLine: string): string {
  return rawLine
    .trim()
    .replace(/^[-*]\s+/u, '')
    .replace(/^\d+\.\s+/u, '')
    .replace(/^•\s+/u, '')
    .trim();
}

export function parsePlainTextOutlinerPaste(text: string): ParsedPasteNode[] {
  const roots: ParsedPasteNode[] = [];
  const stack: Array<{ depth: number; children: ParsedPasteNode[] }> = [
    { depth: -1, children: roots },
  ];

  for (const rawLine of text.replace(/\r\n?/gu, '\n').split('\n')) {
    const nextText = lineText(rawLine);
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

function parseInlineMarkdown(rawText: string): RichText {
  const marks: TextMark[] = [];
  let text = '';
  let index = 0;
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`)/gu;
  for (const match of rawText.matchAll(tokenPattern)) {
    const token = match[0];
    const startIndex = match.index ?? 0;
    text += rawText.slice(index, startIndex);
    const markStart = text.length;
    if (token.startsWith('**')) {
      const inner = token.slice(2, -2);
      text += inner;
      marks.push({ start: markStart, end: markStart + inner.length, type: 'bold' });
    } else {
      const inner = token.slice(1, -1);
      text += inner;
      marks.push({ start: markStart, end: markStart + inner.length, type: 'code' });
    }
    index = startIndex + token.length;
  }
  text += rawText.slice(index);

  const heading = text.match(/^#{1,6}\s+(.+)$/u);
  if (heading) {
    const headingText = heading[1] ?? '';
    return {
      text: headingText,
      marks: headingText ? [{ start: 0, end: headingText.length, type: 'headingMark' }] : [],
      inlineRefs: [],
    };
  }

  return { text, marks, inlineRefs: [] };
}

function toCreateNodeTree(node: ParsedPasteNode): CreateNodeTree {
  return {
    content: parseInlineMarkdown(node.text),
    children: node.children.map(toCreateNodeTree),
  };
}

export function parseOutlinerPaste(text: string): CreateNodeTree[] {
  return parsePlainTextOutlinerPaste(text)
    .map(toCreateNodeTree)
    .filter((node) => node.content.text.trim().length > 0);
}
