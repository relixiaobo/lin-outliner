import { canonicalSha256 } from './canonical';
import { OutlineContractError, outlineError } from './errors';
import type { Projection, Selector, TargetSpec } from './schemas';

export function readTargetSpec(selector: Selector): TargetSpec {
  if (selector.by === 'ids') {
    return { selector, cardinality: 'many', max: selector.ids.length };
  }
  if (selector.by === 'query' || selector.by === 'search') {
    return { selector, cardinality: 'many', max: selector.limit };
  }
  return { selector, cardinality: 'one' };
}

export function reconcileReadSelector(
  command: 'show' | 'export',
  selector: Selector | undefined,
  projection: Projection | undefined,
): Selector {
  const projectionTargets = projection && isRecord(projection.targets)
    ? projection.targets
    : undefined;
  const projectionSelector = projectionTargets && 'target' in projectionTargets
    && isRecord(projectionTargets.target)
    ? projectionTargets.target.selector as Selector | undefined
    : undefined;
  if (projection && !projectionSelector) {
    throw usageError(
      `${command} Projection targets must use a concrete Selector; ChangeSet bindings are unavailable to standalone reads.`,
    );
  }
  if (selector && projectionSelector
    && canonicalSha256(selector) !== canonicalSha256(projectionSelector)) {
    throw usageError(`${command} Selector conflicts with the Selector declared by --projection.`);
  }
  const resolved = projectionSelector ?? selector;
  if (!resolved) throw usageError(`${command} requires at least one Selector or one complete --projection.`);
  return resolved;
}

function usageError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('invalid_input', 'usage', message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
