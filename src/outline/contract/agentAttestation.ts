import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { RuntimeDescriptor } from './schemas';

export const OUTLINE_AGENT_ATTESTATION_ENV = 'TENON_OUTLINE_AGENT_ATTESTATION';
export const OUTLINE_AGENT_ATTESTATION_HEADER = 'x-outline-agent-attestation';
export const OUTLINE_ORIGIN_HEADER = 'x-outline-origin';
export const OUTLINE_AGENT_ATTESTATION_TTL_MS = 60_000;

interface OutlineAgentAttestationPayload {
  readonly version: 1;
  readonly instanceId: string;
  readonly workspaceHash: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

export interface IssueOutlineAgentAttestationInput {
  readonly descriptor: RuntimeDescriptor;
  readonly runtimeRoot: string;
  readonly causation: {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
  };
  readonly now?: number;
  readonly nonce?: string;
}

export interface VerifiedOutlineAgentAttestation {
  readonly causation: {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
  };
  readonly expiresAt: number;
  readonly nonce: string;
}

export function issueOutlineAgentAttestation(input: IssueOutlineAgentAttestationInput): string {
  const issuedAt = input.now ?? Date.now();
  const payload: OutlineAgentAttestationPayload = {
    version: 1,
    instanceId: input.descriptor.instanceId,
    workspaceHash: outlineWorkspaceHash(input.runtimeRoot),
    threadId: input.causation.threadId,
    turnId: input.causation.turnId,
    itemId: input.causation.itemId,
    issuedAt,
    expiresAt: issuedAt + OUTLINE_AGENT_ATTESTATION_TTL_MS,
    nonce: input.nonce ?? crypto.randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded, input.descriptor.bearerToken)}`;
}

export function verifyOutlineAgentAttestation(input: {
  readonly token: string;
  readonly descriptor: RuntimeDescriptor;
  readonly runtimeRoot: string;
  readonly now?: number;
}): VerifiedOutlineAgentAttestation | null {
  if (input.token.length > 8_192) return null;
  const separator = input.token.indexOf('.');
  if (separator < 1 || separator !== input.token.lastIndexOf('.')) return null;
  const encoded = input.token.slice(0, separator);
  const suppliedSignature = input.token.slice(separator + 1);
  const expectedSignature = signature(encoded, input.descriptor.bearerToken);
  if (!safeEqual(suppliedSignature, expectedSignature)) return null;
  let payload: unknown;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return null;
    payload = JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isPayload(payload)) return null;
  const now = input.now ?? Date.now();
  if (payload.instanceId !== input.descriptor.instanceId
    || payload.workspaceHash !== outlineWorkspaceHash(input.runtimeRoot)
    || payload.issuedAt > now
    || payload.expiresAt <= now
    || payload.expiresAt - payload.issuedAt !== OUTLINE_AGENT_ATTESTATION_TTL_MS) {
    return null;
  }
  return {
    causation: {
      threadId: payload.threadId,
      turnId: payload.turnId,
      itemId: payload.itemId,
    },
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  };
}

function outlineWorkspaceHash(runtimeRoot: string): string {
  return createHash('sha256').update(path.resolve(runtimeRoot)).digest('hex');
}

function signature(payload: string, bearerToken: string): string {
  return createHmac('sha256', bearerToken).update(payload).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isPayload(value: unknown): value is OutlineAgentAttestationPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<OutlineAgentAttestationPayload>;
  return payload.version === 1
    && validIdentity(payload.instanceId)
    && typeof payload.workspaceHash === 'string'
    && /^[a-f0-9]{64}$/.test(payload.workspaceHash)
    && validIdentity(payload.threadId)
    && validIdentity(payload.turnId)
    && validIdentity(payload.itemId)
    && Number.isSafeInteger(payload.issuedAt)
    && Number.isSafeInteger(payload.expiresAt)
    && validIdentity(payload.nonce);
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1_024;
}
