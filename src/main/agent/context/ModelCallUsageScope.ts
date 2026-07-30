import { AsyncLocalStorage } from 'node:async_hooks';

type ModelCallUsageObserver = (tokens: number) => void;

const modelCallUsageScope = new AsyncLocalStorage<ModelCallUsageObserver>();

export function withModelCallUsageObserver<T>(
  observer: ModelCallUsageObserver,
  run: () => Promise<T>,
): Promise<T> {
  return modelCallUsageScope.run(observer, run);
}

export function recordModelCallUsage(tokens: number): void {
  try {
    modelCallUsageScope.getStore()?.(tokens);
  } catch (error) {
    console.error('[agent][subagent-budget-audit] model-call usage observation failed', error);
  }
}
