import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import {
  markdownReferenceOccurrences,
  transformMarkdownReferenceTextNodes,
  type MarkdownReferenceAstNode,
} from './markdownReferenceAst';
import type { ParsedReferenceMarker } from './referenceMarkup';

const markdownParser = unified().use(remarkParse).use(remarkGfm);

export function renderedMarkdownNodeReferenceIds(markdown: string): readonly string[] {
  const nodeIds: string[] = [];
  visitRenderedMarkdownReferences(markdown, (marker) => {
    if (marker.target.kind === 'node') nodeIds.push(marker.target.nodeId);
  });
  return Object.freeze(nodeIds);
}

export function renderedMarkdownHasReference(markdown: string): boolean {
  let found = false;
  const indeterminate = visitRenderedMarkdownReferences(markdown, () => { found = true; });
  return found || indeterminate;
}

function visitRenderedMarkdownReferences(
  markdown: string,
  visit: (marker: ParsedReferenceMarker) => void,
): boolean {
  let indeterminate = false;
  try {
    const tree = markdownParser.parse(markdown) as MarkdownReferenceAstNode;
    transformMarkdownReferenceTextNodes(tree, (value, node) => {
      const result = markdownReferenceOccurrences(markdown, value, node);
      indeterminate ||= result.indeterminate;
      for (const occurrence of result.occurrences) {
        if (!occurrence.escaped) visit(occurrence.marker);
      }
      return [{ type: 'text', value }];
    });
  } catch {
    return true;
  }
  return indeterminate;
}
