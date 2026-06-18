import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentChildRunRecord } from '../core/agentEventLog';
import type { AgentDefinition } from '../core/types';

export function agentDefinitionAgentId(agent: AgentDefinition): string {
  const namespace = agent.source === 'built-in'
    ? 'tenon'
    : stableAgentNamespace(agent.agentFile);
  return `${agent.source}:${namespace}:${normalizeAgentName(agent.name) || 'agent'}`;
}

export function resolveChildRunMemoryOwner(
  run: Pick<AgentChildRunRecord, 'memoryOwnerAgentId'>,
  fallbackMemoryOwnerAgentId: string,
): string {
  // A child run is always a fork — the current agent in an isolated context — so memory
  // ownership falls back to the host agent unless an explicit owner was recorded.
  return run.memoryOwnerAgentId || fallbackMemoryOwnerAgentId;
}

export function memoryWorkspaceIdForRoot(localRoot: string | undefined): string | undefined {
  const root = localRoot?.trim();
  if (!root) return undefined;
  return `workspace:${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)}`;
}

function stableAgentNamespace(value: string): string {
  return createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 16);
}

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
