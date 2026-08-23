import { createHash } from 'node:crypto';

export function createDeterministicCoreIdFactory(seed: string): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}:${deterministicUuid(`${seed}:core:${sequence++}:${prefix}`)}`;
}

export function deterministicPublicNodeId(seed: string, path: string): string {
  return `node:${deterministicUuid(`${seed}:public:${path}`)}`;
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
