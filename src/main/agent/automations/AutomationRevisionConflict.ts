import { AgentToolFailure } from '../AgentToolFailure';

export class AutomationRevisionConflict extends AgentToolFailure {
  constructor(readonly currentRevision: number) {
    super('automation_revision_conflict', `Scheduled task revision conflict; current revision is ${currentRevision}`,
      'Read the saved task, compare the intended changes, and retry deliberately against its current revision.');
  }
}
