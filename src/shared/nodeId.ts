// Canonical client-authored Node IDs are shared by Core admission and the
// public Outline contract. Keep this module free of process-specific imports.

export const CLIENT_NODE_ID_PATTERN =
  '^node:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

const CLIENT_NODE_ID_REGEXP = new RegExp(CLIENT_NODE_ID_PATTERN);

export function freshNodeId(): string {
  return `node:${crypto.randomUUID()}`;
}

export function isClientNodeId(id: string): boolean {
  return CLIENT_NODE_ID_REGEXP.test(id);
}
