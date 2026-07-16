const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LORO_RESERVED_PEER_ID = (1n << 64n) - 1n;

export function createPersistenceId(): string {
  return crypto.randomUUID();
}

export function isPersistenceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function loroPeerIdForReplica(replicaId: string): string {
  if (!isPersistenceId(replicaId)) throw new Error('Invalid replica id');
  const hex = replicaId.replaceAll('-', '');
  const folded = BigInt(`0x${hex.slice(0, 16)}`) ^ BigInt(`0x${hex.slice(16)}`);
  return (folded === LORO_RESERVED_PEER_ID ? 0n : folded).toString();
}

export function isLoroPeerId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return false;
  try {
    return BigInt(value) < LORO_RESERVED_PEER_ID;
  } catch {
    return false;
  }
}
