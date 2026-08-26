const REFERENCE_OPAQUE_NODE_TYPES = new Set([
  'code',
  'image',
  'imageReference',
  'inlineCode',
  'link',
  'linkReference',
]);

export interface MarkdownReferenceAstNode {
  children?: MarkdownReferenceAstNode[];
  position?: {
    end?: { offset?: number };
    start?: { offset?: number };
  };
  title?: string | null;
  type: string;
  url?: string;
  value?: string;
}

export function transformMarkdownReferenceTextNodes(
  node: MarkdownReferenceAstNode,
  transformText: (value: string, node: MarkdownReferenceAstNode) => readonly MarkdownReferenceAstNode[],
): void {
  if (!node.children || REFERENCE_OPAQUE_NODE_TYPES.has(node.type)) return;
  const nextChildren: MarkdownReferenceAstNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      nextChildren.push(...transformText(child.value, child));
      continue;
    }
    transformMarkdownReferenceTextNodes(child, transformText);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}
