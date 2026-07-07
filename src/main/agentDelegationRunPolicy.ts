import { parsePositiveInteger } from '../core/agentMarkdown';
import type { AgentRunBudget, AgentRunScope } from '../core/agentEventLog';
import type { AgentMessage } from '../core/agentTypes';
import {
  agentToolNamesForActionKindScope,
  isReadOnlyActionKind,
  normalizeAgentToolActionKinds,
  readOnlyAgentToolNames,
} from '../core/agentPermissionModel';

export const DEFAULT_CHILD_WALL_CLOCK_MINUTES = 30;

export interface BudgetedRunState {
  budget?: AgentRunBudget;
  parentBudgetRef?: AgentRunBudget;
  budgetSettled?: boolean;
  messages: readonly AgentMessage[];
}

export function normalizeRunScope(value: unknown): AgentRunScope | undefined {
  if (!isPlainRecord(value)) return undefined;
  const capabilities = normalizeAgentToolActionKinds(coerceStringArray(value.capabilities));
  const resources = isPlainRecord(value.resources) ? {
    docs: coerceStringArray(value.resources.docs),
    paths: coerceStringArray(value.resources.paths),
    nodes: coerceStringArray(value.resources.nodes),
  } : undefined;
  const compactResources = resources && (resources.docs?.length || resources.paths?.length || resources.nodes?.length)
    ? resources
    : undefined;
  return capabilities?.length || compactResources
    ? { capabilities, resources: compactResources }
    : undefined;
}

export function normalizeRunBudgetInput(value: unknown): AgentRunBudget | undefined {
  if (!isPlainRecord(value)) return undefined;
  const tokens = parsePositiveInteger(value.tokens);
  const wallClockMinutes = parsePositiveInteger(value.wallClockMinutes);
  return tokens || wallClockMinutes ? { tokens, wallClockMinutes } : undefined;
}

export function normalizeRunBudget(
  next: AgentRunBudget | undefined,
  existing: AgentRunBudget | undefined,
  now: number,
): AgentRunBudget | undefined {
  // Merge field-by-field, not by spread: `normalizeRunBudgetInput` yields explicit
  // `undefined` for the field a partial amend did not touch, and `{...existing,
  // ...next}` would let that `undefined` wipe the untouched limit (e.g. amending
  // only wallClockMinutes would erase the token cap, leaking its reservation).
  const budget: AgentRunBudget = { ...existing };
  if (next?.tokens !== undefined) budget.tokens = next.tokens;
  if (next?.wallClockMinutes !== undefined) budget.wallClockMinutes = next.wallClockMinutes;
  if (!budget.tokens && !budget.wallClockMinutes && !budget.reservedTokens && !budget.spentTokens) return undefined;
  budget.startedAt ??= now;
  if (budget.wallClockMinutes) {
    budget.deadlineAt = budget.startedAt + budget.wallClockMinutes * 60_000;
  }
  return budget;
}

export function admitRunBudget(
  parent: AgentRunBudget | undefined,
  requested: AgentRunBudget | undefined,
  now: number,
  detached: boolean,
): AgentRunBudget | undefined {
  const parentRemainingWallClockMinutes = parent?.deadlineAt && parent.deadlineAt > now
    ? Math.max(1, Math.ceil((parent.deadlineAt - now) / 60_000))
    : undefined;
  if (
    parentRemainingWallClockMinutes !== undefined
    && requested?.wallClockMinutes
    && requested.wallClockMinutes > parentRemainingWallClockMinutes
  ) {
    throw new Error('Run budget exceeds parent remaining wall-clock budget.');
  }
  const fallback = requested
    ?? (parentRemainingWallClockMinutes ? { wallClockMinutes: parentRemainingWallClockMinutes } : undefined)
    ?? (detached ? { wallClockMinutes: DEFAULT_CHILD_WALL_CLOCK_MINUTES } : undefined);
  const budget = normalizeRunBudget(fallback, undefined, now);
  if (!budget) return undefined;
  if (parent?.deadlineAt && budget.deadlineAt && budget.deadlineAt > parent.deadlineAt) {
    budget.deadlineAt = parent.deadlineAt;
    if (parentRemainingWallClockMinutes !== undefined) budget.wallClockMinutes = parentRemainingWallClockMinutes;
  }
  if (parent?.tokens && budget.tokens) {
    const parentHeadroom = Math.max(0, parent.tokens - (parent.reservedTokens ?? 0) - (parent.spentTokens ?? 0));
    if (budget.tokens > parentHeadroom) throw new Error('Run budget exceeds parent remaining token budget.');
    parent.reservedTokens = (parent.reservedTokens ?? 0) + budget.tokens;
  }
  return budget;
}

// Reverse admitRunBudget's parent token reservation for a run that never came to
// exist (e.g. the harness build threw), so a setup failure cannot permanently
// inflate the parent's reservedTokens.
export function releaseAdmittedRunBudget(parent: AgentRunBudget | undefined, budget: AgentRunBudget | undefined): void {
  if (parent?.tokens && budget?.tokens) {
    parent.reservedTokens = Math.max(0, (parent.reservedTokens ?? 0) - budget.tokens);
  }
}

export function settleRunBudget(run: BudgetedRunState): void {
  if (run.budgetSettled) return;
  if (!run.parentBudgetRef || !run.budget?.tokens) return;
  const reserved = run.parentBudgetRef.reservedTokens ?? 0;
  run.parentBudgetRef.reservedTokens = Math.max(0, reserved - run.budget.tokens);
  const spent = Math.min(run.budget.tokens, runUsageTokens(run));
  run.parentBudgetRef.spentTokens = (run.parentBudgetRef.spentTokens ?? 0) + spent;
  run.budgetSettled = true;
}

// A verifier reads to confirm the work; its capabilities are the read-only
// subset of the controller's own scope (or all read-only kinds when the
// controller is unrestricted), so narrowing never rejects it as widening.
export function verifierRunScope(inheritedScope: AgentRunScope | undefined): AgentRunScope {
  const parentCapabilities = normalizeAgentToolActionKinds(inheritedScope?.capabilities);
  const capabilities = parentCapabilities?.length
    ? parentCapabilities.filter((kind) => isReadOnlyActionKind(kind))
    : normalizeAgentToolActionKinds(readOnlyAgentToolNames());
  return { capabilities: capabilities ?? [] };
}

// The verifier's wall-clock request must fit the parent run's remaining time
// (its deadline has been counting down since the work started), capped at the
// default, so admission never rejects a budgeted run's verification.
export function verifierBudgetForRun(run: { budget?: AgentRunBudget }): AgentRunBudget {
  const deadlineAt = run.budget?.deadlineAt;
  const remainingMinutes = deadlineAt && deadlineAt > Date.now()
    ? Math.max(1, Math.ceil((deadlineAt - Date.now()) / 60_000))
    : undefined;
  const wallClockMinutes = Math.min(
    DEFAULT_CHILD_WALL_CLOCK_MINUTES,
    run.budget?.wallClockMinutes ?? DEFAULT_CHILD_WALL_CLOCK_MINUTES,
    remainingMinutes ?? DEFAULT_CHILD_WALL_CLOCK_MINUTES,
  );
  return { wallClockMinutes };
}

export function narrowRunScope(parent: AgentRunScope | undefined, requested: AgentRunScope | undefined): AgentRunScope | undefined {
  const parentCapabilities = normalizeAgentToolActionKinds(parent?.capabilities);
  const requestedCapabilities = normalizeAgentToolActionKinds(requested?.capabilities);
  const capabilities = parentCapabilities?.length
    ? (requestedCapabilities?.length ? assertScopeSubset(requestedCapabilities, parentCapabilities, 'capabilities') : parentCapabilities)
    : requestedCapabilities;
  const resources = narrowRunResources(parent?.resources, requested?.resources);
  return capabilities?.length || resources
    ? { capabilities, resources }
    : undefined;
}

export function scopedAllowedToolNames(allowedTools: readonly string[] | undefined, scope: AgentRunScope | undefined): string[] | undefined {
  const scopeTools = agentToolNamesForActionKindScope(scope?.capabilities, allowedTools);
  if (scope?.capabilities?.length) return scopeTools ?? [];
  return allowedTools ? [...allowedTools] : undefined;
}

export function remainingBudgetMs(run: { budget?: AgentRunBudget }): number | null {
  const deadlineAt = run.budget?.deadlineAt;
  if (!deadlineAt) return null;
  return Math.max(0, deadlineAt - Date.now());
}

export function retryBudgetSlice(budget: AgentRunBudget | undefined): AgentRunBudget | undefined {
  if (!budget) return undefined;
  const next: AgentRunBudget = {};
  if (budget.tokens) next.tokens = budget.tokens;
  if (budget.wallClockMinutes) next.wallClockMinutes = budget.wallClockMinutes;
  return next.tokens || next.wallClockMinutes ? next : undefined;
}

export function formatRunBudgetForPrompt(budget: AgentRunBudget | undefined): string | null {
  if (!budget) return null;
  const lines: string[] = [];
  if (budget.tokens) lines.push(`- token budget: ${budget.tokens}`);
  if (budget.wallClockMinutes) lines.push(`- wall-clock budget: ${budget.wallClockMinutes} minutes`);
  return lines.length ? lines.join('\n') : null;
}

export function formatRunScopeForPrompt(scope: AgentRunScope | undefined): string | null {
  if (!scope) return null;
  const lines: string[] = [];
  if (scope.capabilities?.length) lines.push(`- capabilities: ${scope.capabilities.join(', ')}`);
  if (scope.resources?.docs?.length) lines.push(`- docs: ${scope.resources.docs.join(', ')}`);
  if (scope.resources?.paths?.length) lines.push(`- paths: ${scope.resources.paths.join(', ')}`);
  if (scope.resources?.nodes?.length) lines.push(`- nodes: ${scope.resources.nodes.join(', ')}`);
  return lines.length ? lines.join('\n') : null;
}

function runUsageTokens(run: Pick<BudgetedRunState, 'messages'>): number {
  let total = 0;
  for (const message of run.messages) {
    if (message.role === 'assistant') total += message.usage?.totalTokens ?? 0;
  }
  return total;
}

function assertScopeSubset(values: readonly string[], parentValues: readonly string[], label: string): string[] {
  const parentSet = new Set(parentValues);
  const denied = values.filter((value) => !parentSet.has(value));
  if (denied.length > 0) {
    throw new Error(`Run scope cannot widen ${label}: ${denied.join(', ')}`);
  }
  return [...new Set(values)];
}

function narrowRunResources(parent: AgentRunScope['resources'] | undefined, requested: AgentRunScope['resources'] | undefined): AgentRunScope['resources'] | undefined {
  const docs = parent?.docs?.length
    ? (requested?.docs?.length ? assertScopeSubset(requested.docs, parent.docs, 'docs') : parent.docs)
    : requested?.docs;
  const paths = parent?.paths?.length
    ? (requested?.paths?.length ? assertScopeSubset(requested.paths, parent.paths, 'paths') : parent.paths)
    : requested?.paths;
  const nodes = parent?.nodes?.length
    ? (requested?.nodes?.length ? assertScopeSubset(requested.nodes, parent.nodes, 'nodes') : parent.nodes)
    : requested?.nodes;
  return docs?.length || paths?.length || nodes?.length ? { docs, paths, nodes } : undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
