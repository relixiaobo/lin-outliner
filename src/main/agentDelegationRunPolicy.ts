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
  const resourcesValue = isPlainRecord(value.resources) ? value.resources : undefined;
  const docs = resourcesValue ? coerceResourceArray(resourcesValue, 'docs') : undefined;
  const paths = resourcesValue ? coerceResourceArray(resourcesValue, 'paths') : undefined;
  const nodes = resourcesValue ? coerceResourceArray(resourcesValue, 'nodes') : undefined;
  const writableNodes = resourcesValue ? coerceResourceArray(resourcesValue, 'writableNodes') : undefined;
  const creatableNodeParents = resourcesValue ? coerceResourceArray(resourcesValue, 'creatableNodeParents') : undefined;
  const compactResources = docs !== undefined
    || paths !== undefined
    || nodes !== undefined
    || writableNodes !== undefined
    || creatableNodeParents !== undefined
    ? {
        ...(docs !== undefined ? { docs } : {}),
        ...(paths !== undefined ? { paths } : {}),
        ...(nodes !== undefined ? { nodes } : {}),
        ...(writableNodes !== undefined ? { writableNodes } : {}),
        ...(creatableNodeParents !== undefined ? { creatableNodeParents } : {}),
      }
    : undefined;
  return capabilities?.length || compactResources
    ? { capabilities, resources: compactResources }
    : undefined;
}

export function normalizeRunBudgetInput(value: unknown): AgentRunBudget | undefined {
  if (!isPlainRecord(value)) return undefined;
  const tokens = parsePositiveInteger(value.tokens);
  const wallClockMinutes = parsePositiveInteger(value.wallClockMinutes);
  const deadlineAt = parsePositiveInteger(value.deadlineAt);
  return tokens || wallClockMinutes || deadlineAt ? { tokens, wallClockMinutes, deadlineAt } : undefined;
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
  if (next?.deadlineAt !== undefined) budget.deadlineAt = next.deadlineAt;
  if (!budget.tokens && !budget.wallClockMinutes && !budget.deadlineAt && !budget.reservedTokens && !budget.spentTokens) return undefined;
  budget.startedAt ??= now;
  if (budget.wallClockMinutes) {
    const wallClockDeadlineAt = budget.startedAt + budget.wallClockMinutes * 60_000;
    budget.deadlineAt = next?.deadlineAt !== undefined
      ? Math.min(next.deadlineAt, wallClockDeadlineAt)
      : wallClockDeadlineAt;
  }
  return budget;
}

export function prepareRunBudgetAmendment(
  next: AgentRunBudget,
  existing: AgentRunBudget | undefined,
  parent: AgentRunBudget | undefined,
  budgetSettled: boolean,
  now: number,
): { budget: AgentRunBudget | undefined; parentReservedTokens?: number } {
  const budget = normalizeRunBudget(next, existing, now);
  if (parent?.deadlineAt && budget) {
    if (budget.deadlineAt !== undefined && budget.deadlineAt > parent.deadlineAt) {
      throw new Error('Amended run budget exceeds parent remaining wall-clock budget.');
    }
    budget.deadlineAt ??= parent.deadlineAt;
  }

  if (!parent?.tokens || budgetSettled) return { budget };
  const previousTokens = existing?.tokens ?? 0;
  const nextTokens = budget?.tokens ?? 0;
  const delta = nextTokens - previousTokens;
  const reservedTokens = parent.reservedTokens ?? 0;
  if (delta > 0) {
    const headroom = Math.max(0, parent.tokens - reservedTokens - (parent.spentTokens ?? 0));
    if (delta > headroom) throw new Error('Amended run budget exceeds parent remaining token budget.');
  }
  return {
    budget,
    parentReservedTokens: Math.max(0, reservedTokens + delta),
  };
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
  if (parent?.deadlineAt) {
    if (!budget.deadlineAt || budget.deadlineAt > parent.deadlineAt) {
      budget.deadlineAt = parent.deadlineAt;
      if (budget.wallClockMinutes && parentRemainingWallClockMinutes !== undefined) {
        budget.wallClockMinutes = Math.min(budget.wallClockMinutes, parentRemainingWallClockMinutes);
      }
    }
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
export function verifierRunScope(runScope: AgentRunScope | undefined): AgentRunScope {
  const parentCapabilities = normalizeAgentToolActionKinds(runScope?.capabilities);
  const capabilities = parentCapabilities?.length
    ? parentCapabilities.filter((kind) => isReadOnlyActionKind(kind))
    : normalizeAgentToolActionKinds(readOnlyAgentToolNames());
  const resources = runScope?.resources;
  const mutationNodes = resources?.writableNodes !== undefined
    || resources?.creatableNodeParents !== undefined
    ? [...new Set([
        ...(resources.writableNodes ?? []),
        ...(resources.creatableNodeParents ?? []),
      ])]
    : undefined;
  const nodes = resources?.nodes ?? mutationNodes;
  const readResources = resources
    ? {
        ...(resources.docs !== undefined ? { docs: [...resources.docs] } : {}),
        ...(resources.paths !== undefined ? { paths: [...resources.paths] } : {}),
        ...(nodes !== undefined ? { nodes: [...nodes] } : {}),
      }
    : undefined;
  return {
    capabilities: capabilities ?? [],
    ...(readResources ? { resources: readResources } : {}),
  };
}

export function verifierAllowedToolNames(
  runScope: AgentRunScope | undefined,
  runAllowedTools?: readonly string[],
): string[] {
  const readOnlyTools = !runAllowedTools || runAllowedTools.includes('*')
    ? readOnlyAgentToolNames()
    : readOnlyAgentToolNames(runAllowedTools);
  const capabilities = normalizeAgentToolActionKinds(runScope?.capabilities);
  if (!capabilities?.length) return readOnlyTools;
  const readCapabilities = capabilities.filter((kind) => isReadOnlyActionKind(kind));
  if (readCapabilities.length === 0) return [];
  return agentToolNamesForActionKindScope(readCapabilities, readOnlyTools) ?? [];
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
  return capabilities?.length || resources !== undefined
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
  if (budget.deadlineAt) next.deadlineAt = budget.deadlineAt;
  return next.tokens || next.wallClockMinutes || next.deadlineAt ? next : undefined;
}

export function formatRunBudgetForPrompt(budget: AgentRunBudget | undefined): string | null {
  if (!budget) return null;
  const lines: string[] = [];
  if (budget.tokens) lines.push(`- token budget: ${budget.tokens}`);
  if (budget.wallClockMinutes) lines.push(`- wall-clock budget: ${budget.wallClockMinutes} minutes`);
  if (budget.deadlineAt) lines.push(`- deadline: ${new Date(budget.deadlineAt).toISOString()}`);
  return lines.length ? lines.join('\n') : null;
}

export function formatRunScopeForPrompt(scope: AgentRunScope | undefined): string | null {
  if (!scope) return null;
  const lines: string[] = [];
  if (scope.capabilities?.length) lines.push(`- capabilities: ${scope.capabilities.join(', ')}`);
  if (scope.resources?.docs !== undefined) lines.push(`- docs: ${scope.resources.docs.join(', ') || 'none (deny all)'}`);
  if (scope.resources?.paths !== undefined) lines.push(`- paths: ${scope.resources.paths.join(', ') || 'none (deny all)'}`);
  if (scope.resources?.nodes !== undefined) lines.push(`- nodes: ${scope.resources.nodes.join(', ') || 'none (deny all)'}`);
  if (scope.resources?.writableNodes !== undefined) lines.push(`- writable nodes: ${scope.resources.writableNodes.join(', ') || 'none (deny all)'}`);
  if (scope.resources?.creatableNodeParents !== undefined) {
    lines.push(`- creatable node parents: ${scope.resources.creatableNodeParents.join(', ') || 'none (deny all)'}`);
  }
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
  const docs = narrowResourceArray(parent?.docs, requested?.docs, 'docs');
  const paths = narrowResourceArray(parent?.paths, requested?.paths, 'paths');
  const nodes = narrowResourceArray(parent?.nodes, requested?.nodes, 'nodes');
  const writableNodes = narrowWritableNodeResources(parent, requested, nodes);
  const creatableNodeParents = narrowCreatableNodeParents(parent, requested, nodes);
  return docs !== undefined
    || paths !== undefined
    || nodes !== undefined
    || writableNodes !== undefined
    || creatableNodeParents !== undefined
    ? {
        ...(docs !== undefined ? { docs } : {}),
        ...(paths !== undefined ? { paths } : {}),
        ...(nodes !== undefined ? { nodes } : {}),
        ...(writableNodes !== undefined ? { writableNodes } : {}),
        ...(creatableNodeParents !== undefined ? { creatableNodeParents } : {}),
      }
    : undefined;
}

function narrowCreatableNodeParents(
  parent: AgentRunScope['resources'] | undefined,
  requested: AgentRunScope['resources'] | undefined,
  narrowedReadableNodes: readonly string[] | undefined,
): string[] | undefined {
  let creatableNodeParents: string[] | undefined;
  if (parent?.creatableNodeParents !== undefined) {
    creatableNodeParents = requested?.creatableNodeParents !== undefined
      ? assertScopeSubset(
          requested.creatableNodeParents,
          parent.creatableNodeParents,
          'creatableNodeParents',
        )
      : [...parent.creatableNodeParents];
  } else if (parent?.writableNodes !== undefined && requested?.creatableNodeParents !== undefined) {
    creatableNodeParents = assertScopeSubset(
      requested.creatableNodeParents,
      parent.writableNodes,
      'creatableNodeParents',
    );
  } else if (parent?.nodes !== undefined && requested?.creatableNodeParents !== undefined) {
    creatableNodeParents = assertScopeSubset(
      requested.creatableNodeParents,
      parent.nodes,
      'creatableNodeParents',
    );
  } else if (requested?.creatableNodeParents !== undefined) {
    creatableNodeParents = [...requested.creatableNodeParents];
  }
  if (creatableNodeParents !== undefined && narrowedReadableNodes !== undefined) {
    return assertScopeSubset(creatableNodeParents, narrowedReadableNodes, 'creatableNodeParents');
  }
  return creatableNodeParents;
}

function narrowWritableNodeResources(
  parent: AgentRunScope['resources'] | undefined,
  requested: AgentRunScope['resources'] | undefined,
  narrowedReadableNodes: readonly string[] | undefined,
): string[] | undefined {
  let writableNodes: string[] | undefined;
  if (parent?.writableNodes !== undefined) {
    writableNodes = requested?.writableNodes !== undefined
      ? assertScopeSubset(requested.writableNodes, parent.writableNodes, 'writableNodes')
      : [...parent.writableNodes];
  } else if (parent?.nodes !== undefined && requested?.writableNodes !== undefined) {
    writableNodes = assertScopeSubset(requested.writableNodes, parent.nodes, 'writableNodes');
  } else if (requested?.writableNodes !== undefined) {
    writableNodes = [...requested.writableNodes];
  }
  if (writableNodes !== undefined && narrowedReadableNodes !== undefined) {
    return assertScopeSubset(writableNodes, narrowedReadableNodes, 'writableNodes');
  }
  return writableNodes;
}

function narrowResourceArray(
  parentValues: readonly string[] | undefined,
  requestedValues: readonly string[] | undefined,
  label: string,
): string[] | undefined {
  if (parentValues !== undefined) {
    return requestedValues !== undefined
      ? assertScopeSubset(requestedValues, parentValues, label)
      : [...parentValues];
  }
  return requestedValues ? [...requestedValues] : undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function coerceResourceArray(value: Record<string, unknown>, key: string): string[] | undefined {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? coerceStringArray(value[key])
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
