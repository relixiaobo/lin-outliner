interface TreeNodeLike {
  parentId?: string;
  children: readonly string[];
}

export function collectDescendantIds(nodes: ReadonlyMap<string, TreeNodeLike>, nodeId: string): string[] {
  const result: string[] = [];
  const stack = [...(nodes.get(nodeId)?.children ?? [])];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    stack.push(...(nodes.get(id)?.children ?? []));
  }
  return result;
}

export function nodeIsInSubtree(nodes: ReadonlyMap<string, TreeNodeLike>, nodeId: string, ancestorId: string): boolean {
  if (nodeId === ancestorId) return true;
  let current = nodes.get(nodeId)?.parentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = nodes.get(current)?.parentId;
  }
  return false;
}
