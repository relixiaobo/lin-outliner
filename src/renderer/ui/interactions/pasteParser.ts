import type { CreateNodeTree, RichText, TextMark, TextMarkKind } from '../../api/types';
import {
  applyHeadingMark,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  parsePlainTextOutlinerPaste,
  type ParsedPasteNode,
} from '../../../core/markdownPaste';
import { normalizeCodeLanguage } from '../editor/codeLanguages';
import {
  scanMarkdownInline,
  scanRichTextInline,
} from '../../../core/semanticIngest/inlineScanner';
export {
  applyHeadingMark,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  parsePlainTextOutlinerPaste,
  type ParsedPasteNode,
} from '../../../core/markdownPaste';

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
  return roots.map(applyHtmlSemantics);
}

function applyHtmlSemantics(tree: CreateNodeTree): CreateNodeTree {
  const children = tree.children.map(applyHtmlSemantics);
  if (tree.type === 'codeBlock') return { ...tree, children };
  const scanned = scanRichTextInline(tree.content, {
    metadata: 'tags-and-fields',
    linkifyBareUrls: true,
  });
  const tags = [...(tree.tags ?? []), ...scanned.tags.map((tag) => tag.name)];
  const fields = [
    ...(tree.fields ?? []),
    ...scanned.fields.map((field) => ({ name: field.name, value: field.value })),
  ];
  return {
    ...tree,
    content: scanned.content,
    children,
    ...(tags.length > 0 ? { tags: [...new Set(tags)] } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  };
}

// ---------------------------------------------------------------------------
// Routing + public entry points
// ---------------------------------------------------------------------------

const RICH_HTML_TAG = /<(p|div|h[1-6]|ul|ol|li|pre|table|blockquote|strong|b|em|i|s|del|mark|code|a)\b/iu;

function htmlHasRichStructure(html: string): boolean {
  return RICH_HTML_TAG.test(html);
}

// Real list elements mean the HTML carries the hierarchy itself (and its marks);
// flat `<div>`/`<p>` that merely kept literal `-`/`[x]` markers does not. This
// is what separates a rich web-list paste (trust the HTML, keep bold/links) from
// an editor copy whose indentation was whitespace-folded (prefer the plain text).
function htmlHasList(html: string): boolean {
  return /<(ul|ol|li)\b/iu.test(html);
}

function looksLikeStrongMarkdown(text: string): boolean {
  if (/(^|\n)\s*(```|~~~)/u.test(text)) return true;
  if (/(^|\n)#{1,6}\s+\S/u.test(text)) return true;
  // A multi-line bullet / task / numbered list is a Markdown outline whose
  // indentation carries the hierarchy. HTML whitespace-folds that indentation
  // away and never strips the `-`/`[x]` markers, so when the clipboard also
  // carries HTML the plain-text parser is the faithful one — prefer it.
  const listLines = text.match(/(^|\n)[ \t]*(?:[-*+]|\d+[.)]|[•◦▪‣·●])[ \t]+\S/gu);
  return (listLines?.length ?? 0) >= 2;
}

function treeHasContent(node: CreateNodeTree): boolean {
  return node.content.text.trim().length > 0
    || node.content.inlineRefs.length > 0
    || node.children.length > 0
    || (node.tags?.length ?? 0) > 0
    || (node.fields?.length ?? 0) > 0
    || node.checkbox === true
    || node.type !== undefined;
}

export function parseClipboardPaste(plain: string, html?: string | null): CreateNodeTree[] {
  const text = plain ?? '';
  const canUseHtml =
    typeof DOMParser !== 'undefined' &&
    typeof html === 'string' &&
    html.trim().length > 0 &&
    htmlHasRichStructure(html) &&
    // A Markdown-looking plain text only wins over the HTML when the HTML is the
    // lossy side — flat blocks with no real list. Genuine `<ul>/<ol>/<li>` keeps
    // both the structure and its marks, so trust it.
    (htmlHasList(html) || !looksLikeStrongMarkdown(text));
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
    trees[0].content.marks.length === 0 &&
    trees[0].content.inlineRefs.length === 0 &&
    (trees[0].tags?.length ?? 0) === 0 &&
    (trees[0].fields?.length ?? 0) === 0 &&
    trees[0].checkbox !== true
  );
}

/** Returns a normalized href for a single-line URL paste, or null. */
export function detectSingleLineUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/u.test(trimmed)) return null;
  const scanned = scanMarkdownInline(trimmed, {
    metadata: 'none',
    linkifyBareUrls: true,
    references: false,
  });
  const link = scanned.content.marks.length === 1 && scanned.content.marks[0]?.type === 'link'
    ? scanned.content.marks[0]
    : null;
  if (!link || link.start !== 0 || link.end !== scanned.content.text.length || scanned.content.text !== trimmed) return null;
  return typeof link.attrs?.href === 'string' ? link.attrs.href : null;
}
