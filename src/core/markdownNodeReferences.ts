import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import {
  transformMarkdownReferenceTextNodes,
  type MarkdownReferenceAstNode,
} from './markdownReferenceAst';
import { splitReferenceMarkers } from './referenceMarkup';

const markdownParser = unified().use(remarkParse).use(remarkGfm);

export function renderedMarkdownNodeReferenceIds(markdown: string): readonly string[] {
  const nodeIds: string[] = [];
  try {
    const tree = markdownParser.parse(markdown) as MarkdownReferenceAstNode;
    transformMarkdownReferenceTextNodes(tree, (value) => {
      for (const segment of splitReferenceMarkers(value)) {
        if (segment.type === 'reference' && segment.target.kind === 'node') {
          nodeIds.push(segment.target.nodeId);
        }
      }
      return [{ type: 'text', value }];
    });
  } catch {
    return Object.freeze([]);
  }
  return Object.freeze(nodeIds);
}
