import type { CreateNodeTree, RichText, TextMark, TextMarkKind } from '../../api/types';
import { normalizeCodeLanguage } from '../editor/codeLanguages';

export interface ParsedPasteNode {
  text: string;
  children: ParsedPasteNode[];
}

// ---------------------------------------------------------------------------
// Shared line helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Structural plain-text parser (hierarchy only, no marks). Kept stable for the
// `parsePlainTextOutlinerPaste` contract.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Inline markdown → RichText marks
//
// Conforms to the app's TextMarkKind set. Underscore variants (`_italic_`,
// `__bold__`) are intentionally excluded to avoid mangling snake_case text.
// ---------------------------------------------------------------------------

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

function applyHeadingMark(content: RichText): RichText {
  if (content.text.length === 0) return content;
  return {
    ...content,
    marks: [{ start: 0, end: content.text.length, type: 'headingMark' }, ...content.marks],
  };
}

// ---------------------------------------------------------------------------
// Block-level markdown parser → CreateNodeTree[]
// ---------------------------------------------------------------------------

// A fence is any line that is just an indent + ``` (or ~~~) + an optional info
// string. Per CommonMark the info string may contain spaces; only its first
// token is the language (e.g. ```tool node_create -> "tool"). Capturing the
// whole info string here is what keeps a fence with a multi-word info string
// from leaking as plain text and desyncing every later open/close pairing.
const FENCE_RE = /^(\s*)(```|~~~)[ \t]*([^\n]*?)[ \t]*$/u;

function fenceLanguage(info: string): string {
  return normalizeCodeLanguage(info.trim().split(/\s+/u)[0] ?? '');
}

function lineToTree(rawText: string): CreateNodeTree {
  const heading = rawText.match(/^(#{1,6})\s+(.*)$/u);
  if (heading) {
    return { content: applyHeadingMark(parseInlineMarkdown(heading[2] ?? '')), children: [] };
  }
  return { content: parseInlineMarkdown(rawText), children: [] };
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
      if (i < lines.length) i += 1; // consume the closing fence
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

// ---------------------------------------------------------------------------
// HTML → CreateNodeTree[] (only when a DOM is available, i.e. the renderer)
// ---------------------------------------------------------------------------

const INLINE_MARK_TAGS: Record<string, TextMarkKind> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  code: 'code',
  mark: 'highlight',
};

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'ul', 'ol', 'table',
]);

interface ActiveMark {
  type: TextMarkKind;
  attrs?: Record<string, string>;
}

interface InlineBuilder {
  text: string;
  marks: TextMark[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function trimRichText(text: string, marks: TextMark[]): RichText {
  const leading = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const total = trimmed.length;
  const next = marks
    .map((mark) => ({ ...mark, start: clamp(mark.start - leading, 0, total), end: clamp(mark.end - leading, 0, total) }))
    .filter((mark) => mark.end > mark.start);
  return { text: trimmed, marks: next, inlineRefs: [] };
}

// Accumulates inline content into one or more builders. When `splitOnBreak` is
// set a `<br>` starts a new builder (so a `<div>a<br>b</div>` block becomes
// sibling rows rather than one space-joined row); otherwise `<br>` is a space.
interface InlineCollector {
  builders: InlineBuilder[];
  splitOnBreak: boolean;
}

function currentBuilder(collector: InlineCollector): InlineBuilder {
  const last = collector.builders[collector.builders.length - 1];
  if (last) return last;
  const fresh: InlineBuilder = { text: '', marks: [] };
  collector.builders.push(fresh);
  return fresh;
}

function appendInline(collector: InlineCollector, node: ChildNode, active: ActiveMark[]): void {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const value = (node.textContent ?? '').replace(/\s+/gu, ' ');
    if (!value) return;
    const builder = currentBuilder(collector);
    const start = builder.text.length;
    builder.text += value;
    const end = builder.text.length;
    for (const mark of active) {
      builder.marks.push({ start, end, type: mark.type, ...(mark.attrs ? { attrs: mark.attrs } : {}) });
    }
    return;
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') {
    if (collector.splitOnBreak) collector.builders.push({ text: '', marks: [] });
    else currentBuilder(collector).text += ' ';
    return;
  }
  const next = [...active];
  const markType = INLINE_MARK_TAGS[tag];
  if (markType) {
    next.push({ type: markType });
  } else if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    if (href) next.push({ type: 'link', attrs: { href } });
  } else {
    const style = el.getAttribute('style') ?? '';
    if (/font-weight\s*:\s*(bold|[6-9]00)/u.test(style)) next.push({ type: 'bold' });
    if (/font-style\s*:\s*italic/u.test(style)) next.push({ type: 'italic' });
    if (/text-decoration[^;]*line-through/u.test(style)) next.push({ type: 'strike' });
  }
  for (const child of Array.from(el.childNodes)) appendInline(collector, child, next);
}

function collectBuilders(el: Element, splitOnBreak: boolean): InlineBuilder[] {
  const collector: InlineCollector = { builders: [{ text: '', marks: [] }], splitOnBreak };
  for (const child of Array.from(el.childNodes)) appendInline(collector, child, []);
  return collector.builders;
}

// A single row (no `<br>` split) — used by headings, list items, and inline
// wrappers where a line break stays an inline space.
function inlineTreeFromElement(el: Element): CreateNodeTree | null {
  const [builder] = collectBuilders(el, false);
  const content = trimRichText(builder.text, builder.marks);
  if (content.text.length === 0) return null;
  return { content, children: [] };
}

// One row per `<br>`-delimited segment — used for block elements so soft line
// breaks inside a paragraph become sibling rows.
function inlineTreesFromElement(el: Element): CreateNodeTree[] {
  return collectBuilders(el, true)
    .map((builder) => trimRichText(builder.text, builder.marks))
    .filter((content) => content.text.length > 0)
    .map((content) => ({ content, children: [] }));
}

function headingTreeFromElement(el: Element): CreateNodeTree | null {
  const node = inlineTreeFromElement(el);
  if (!node) return null;
  node.content = applyHeadingMark(node.content);
  return node;
}

function codeTreeFromPre(el: Element): CreateNodeTree {
  const codeEl = el.querySelector('code');
  const raw = (codeEl ?? el).textContent ?? '';
  const className = `${codeEl?.getAttribute('class') ?? ''} ${el.getAttribute('class') ?? ''}`;
  const lang = className.match(/(?:language|lang)-([\w+#.-]+)/u)?.[1];
  return {
    content: { text: raw.replace(/\n$/u, ''), marks: [], inlineRefs: [] },
    children: [],
    type: 'codeBlock',
    codeLanguage: normalizeCodeLanguage(lang) || undefined,
  };
}

function walkList(listEl: Element, out: CreateNodeTree[]): void {
  for (const item of Array.from(listEl.children)) {
    if (item.tagName.toLowerCase() !== 'li') continue;
    const collector: InlineCollector = { builders: [{ text: '', marks: [] }], splitOnBreak: false };
    const nestedLists: Element[] = [];
    for (const child of Array.from(item.childNodes)) {
      if (child.nodeType === 1 && /^(ul|ol)$/u.test((child as Element).tagName.toLowerCase())) {
        nestedLists.push(child as Element);
      } else {
        appendInline(collector, child, []);
      }
    }
    const builder = collector.builders[0];
    const node: CreateNodeTree = { content: trimRichText(builder.text, builder.marks), children: [] };
    for (const nested of nestedLists) walkList(nested, node.children);
    if (node.content.text.length > 0 || node.children.length > 0) out.push(node);
  }
}

function walkTable(tableEl: Element, out: CreateNodeTree[]): void {
  for (const rowEl of Array.from(tableEl.querySelectorAll('tr'))) {
    const cells = Array.from(rowEl.querySelectorAll('th,td')).map((cell) => (cell.textContent ?? '').trim());
    const text = cells.join(' | ').trim();
    if (text) out.push({ content: parseInlineMarkdown(text), children: [] });
  }
}

function isBlockElement(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName.toLowerCase());
}

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some(isBlockElement);
}

function walkBlocks(container: Element, out: CreateNodeTree[]): void {
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === 3) {
      const text = (child.textContent ?? '').trim();
      if (text) out.push({ content: parseInlineMarkdown(text), children: [] });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'pre') {
      out.push(codeTreeFromPre(el));
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      walkList(el, out);
      continue;
    }
    if (tag === 'table') {
      walkTable(el, out);
      continue;
    }
    if (/^h[1-6]$/u.test(tag)) {
      const node = headingTreeFromElement(el);
      if (node) out.push(node);
      continue;
    }
    // Recurse into ANY element that wraps block children — not just block tags.
    // This unwraps Google-Docs' `<b style="font-weight:normal"><p>…</p></b>`
    // inline wrappers instead of flattening their paragraphs into one row.
    if (hasBlockChild(el)) {
      walkBlocks(el, out);
      continue;
    }
    for (const node of inlineTreesFromElement(el)) out.push(node);
  }
}

function htmlToTrees(html: string): CreateNodeTree[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const roots: CreateNodeTree[] = [];
  walkBlocks(doc.body, roots);
  return roots;
}

// ---------------------------------------------------------------------------
// Routing + public entry points
// ---------------------------------------------------------------------------

const RICH_HTML_TAG = /<(p|div|h[1-6]|ul|ol|li|pre|table|blockquote|strong|b|em|i|s|del|mark|code|a)\b/iu;

function htmlHasRichStructure(html: string): boolean {
  return RICH_HTML_TAG.test(html);
}

function looksLikeStrongMarkdown(text: string): boolean {
  if (/(^|\n)\s*(```|~~~)/u.test(text)) return true;
  return /(^|\n)#{1,6}\s+\S/u.test(text);
}

function treeHasContent(node: CreateNodeTree): boolean {
  return node.content.text.trim().length > 0 || node.children.length > 0;
}

export function parseClipboardPaste(plain: string, html?: string | null): CreateNodeTree[] {
  const text = plain ?? '';
  const canUseHtml =
    typeof DOMParser !== 'undefined' &&
    typeof html === 'string' &&
    html.trim().length > 0 &&
    htmlHasRichStructure(html) &&
    !looksLikeStrongMarkdown(text);
  const trees = canUseHtml ? htmlToTrees(html as string) : parseMarkdownBlocks(text);
  return trees.filter(treeHasContent);
}

/** Back-compatible plain-text entry point. */
export function parseOutlinerPaste(text: string): CreateNodeTree[] {
  return parseClipboardPaste(text);
}

/** True when intercepting would add nothing over the browser's native paste. */
export function isPlainSingleParagraph(trees: CreateNodeTree[]): boolean {
  return (
    trees.length === 1 &&
    trees[0].children.length === 0 &&
    trees[0].type === undefined &&
    trees[0].content.marks.length === 0
  );
}

/** Returns a normalized href for a single-line URL paste, or null. */
export function detectSingleLineUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/u.test(trimmed)) return null;
  if (/^https?:\/\/\S+$/iu.test(trimmed)) return trimmed;
  if (/^www\.[^\s.]+\.[^\s]+$/iu.test(trimmed)) return `https://${trimmed}`;
  return null;
}
