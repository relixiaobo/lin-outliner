import { canonicalJson, canonicalSha256 } from '../contract/canonical';
import type { EventFilter, Projection } from '../contract/schemas';

interface EventCursorPayload {
  readonly version: 1;
  readonly instanceId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly filterHash: string;
  readonly projectionHash: string;
}

export interface EventCursorIdentity {
  readonly instanceId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly filter?: EventFilter;
  readonly projection?: Projection;
}

export function encodeEventCursor(identity: EventCursorIdentity): string {
  const payload: EventCursorPayload = {
    version: 1,
    instanceId: identity.instanceId,
    sequence: identity.sequence,
    revision: identity.revision,
    filterHash: canonicalSha256(identity.filter ?? null),
    projectionHash: canonicalSha256(identity.projection ?? null),
  };
  return Buffer.from(canonicalJson(payload)).toString('base64url');
}

export function decodeEventCursor(
  cursor: string,
  identity: Pick<EventCursorIdentity, 'instanceId' | 'filter' | 'projection'>,
): EventCursorPayload | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(value)
      || value.version !== 1
      || value.instanceId !== identity.instanceId
      || !Number.isSafeInteger(value.sequence)
      || (value.sequence as number) < 0
      || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 0
      || value.filterHash !== canonicalSha256(identity.filter ?? null)
      || value.projectionHash !== canonicalSha256(identity.projection ?? null)) return null;
    return value as unknown as EventCursorPayload;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
