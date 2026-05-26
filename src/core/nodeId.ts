// Shared client-node id helpers. A plain content node's id is `node:` followed
// by a v4 UUID — exactly what core mints for an untyped node. Both the renderer
// (which proposes a draft row's id so it survives eager materialization) and
// core (which mints ids and validates client proposals) import these, so the id
// shape has a single source of truth.

export function freshNodeId(): string {
  return `node:${crypto.randomUUID()}`;
}

/**
 * A client-minted plain-node id: `node:` + a v4 UUID, exactly what
 * `freshNodeId()` produces. The renderer may propose such an id (so a draft row
 * keeps its React identity through materialization); core validates it before
 * accepting. Reserved/structural ids (workspace, trash, …) and forged strings
 * are rejected by the strict shape.
 */
export function isClientNodeId(id: string): boolean {
  return /^node:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
