import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import {
  transformMarkdownReferenceTextNodes,
  type MarkdownReferenceAstNode,
} from './markdownReferenceAst';
import { parseReferenceMarkers } from './referenceMarkup';

const markdownParser = unified().use(remarkParse).use(remarkGfm);

export function renderedMarkdownNodeReferenceIds(markdown: string): readonly string[] {
  const nodeIds: string[] = [];
  try {
    const tree = markdownParser.parse(markdown) as MarkdownReferenceAstNode;
    transformMarkdownReferenceTextNodes(tree, (value, node) => {
      const source = markdownSourceForNode(markdown, node);
      let sourceCursor = 0;
      for (const marker of parseReferenceMarkers(value, ['node'], { includeEscaped: true })) {
        const sourceMatch = source.indexOf(marker.raw, sourceCursor);
        const escaped = sourceMatch >= 0 && isEscapedAt(source, sourceMatch);
        if (sourceMatch >= 0) sourceCursor = sourceMatch + marker.raw.length;
        if (!escaped && marker.target.kind === 'node') nodeIds.push(marker.target.nodeId);
      }
      return [{ type: 'text', value }];
    });
  } catch {
    return Object.freeze([]);
  }
  return Object.freeze(nodeIds);
}

function markdownSourceForNode(markdown: string, node: MarkdownReferenceAstNode): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === 'number' && typeof end === 'number' ? markdown.slice(start, end) : '';
}

function isEscapedAt(text: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && text[index] === '\\'; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}
