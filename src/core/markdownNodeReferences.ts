import { Lexer, type Token } from 'marked';
import { parseNodeReferenceMarkers } from './referenceMarkup';

const NON_RENDERED_REFERENCE_TOKEN_TYPES = new Set([
  'code',
  'codespan',
  'def',
  'image',
  'link',
]);

export function renderedMarkdownNodeReferenceIds(markdown: string): readonly string[] {
  const nodeIds: string[] = [];
  try {
    collectNodeReferenceIds(Lexer.lex(markdown), nodeIds);
  } catch {
    return Object.freeze([]);
  }
  return Object.freeze(nodeIds);
}

function collectNodeReferenceIds(tokens: readonly Token[], nodeIds: string[]): void {
  for (const token of tokens) {
    if (NON_RENDERED_REFERENCE_TOKEN_TYPES.has(token.type)) continue;
    const nested = 'tokens' in token ? token.tokens : undefined;
    if (Array.isArray(nested) && nested.length > 0) {
      collectNodeReferenceIds(nested, nodeIds);
      continue;
    }
    if (token.type === 'list' && Array.isArray(token.items)) {
      for (const item of token.items) collectNodeReferenceIds(item.tokens, nodeIds);
      continue;
    }
    if (token.type === 'table') {
      for (const cell of [...token.header, ...token.rows.flat()]) {
        collectNodeReferenceIds(cell.tokens, nodeIds);
      }
      continue;
    }
    if (token.type !== 'text') continue;
    for (const marker of parseNodeReferenceMarkers(token.text)) nodeIds.push(marker.nodeId);
  }
}
