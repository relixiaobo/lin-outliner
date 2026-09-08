import type { AutomationDispatcher } from '../automations/AutomationDispatcher';
import type { AutomationScheduler } from '../automations/AutomationScheduler';
import type { AutomationStore } from '../automations/AutomationStore';
import type { ProjectAutomationLifecycle } from './ProjectService';

/** The same scheduler lock protects live hints, immutable claims, and deletion. */
export function projectAutomationLifecycle(store: AutomationStore, scheduler: AutomationScheduler,
  dispatcher: AutomationDispatcher,
): ProjectAutomationLifecycle {
  return {
    runExclusive: (operation) => scheduler.runExclusive(operation),
    reconcileAcceptedClaims: async () => {
      for (const id of new Set(store.pendingRuns().map((run) => run.automationId))) {
        await dispatcher.recoverPendingRuns(id);
      }
    },
    references: (projectId) => [
      ...store.list({ statuses: ['active', 'paused'] }).filter((automation) =>
        automation.contextHints.some((hint) => hint.source.kind === 'project' && hint.source.projectId === projectId))
        .map((automation) => `${automation.name} (${automation.id})`),
      ...store.pendingRuns().filter((run) => run.snapshot.contextHint?.source.kind === 'project'
        && run.snapshot.contextHint.source.projectId === projectId).map((run) => run.id),
    ],
  };
}
