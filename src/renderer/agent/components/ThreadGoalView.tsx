import type { ThreadGoal } from '../../../core/agent/goal';
import { useT } from '../../i18n/I18nProvider';

interface ThreadGoalViewProps {
  readonly goal: ThreadGoal;
}

export function ThreadGoalView({ goal }: ThreadGoalViewProps) {
  const t = useT();
  const ratio = goal.tokenBudget === null
    ? null
    : Math.min(1, goal.tokensUsed / Math.max(1, goal.tokenBudget));
  const usage = goal.tokenBudget === null
    ? t.agent.thread.goalUnboundedUsage({ used: formatNumber(goal.tokensUsed) })
    : t.agent.thread.goalUsage({
        used: formatNumber(goal.tokensUsed),
        budget: formatNumber(goal.tokenBudget),
      });

  return (
    <section className="thread-goal" aria-label={t.agent.thread.goal}>
      <div className="thread-goal-heading">
        <span>{t.agent.thread.goal}</span>
        <span className={`thread-goal-status thread-goal-status-${goal.status}`}>
          {t.agent.thread.goalStatuses[goal.status]}
        </span>
      </div>
      <p>{goal.objective}</p>
      <div className="thread-goal-usage">
        {ratio === null ? null : (
          <span className="thread-goal-meter" aria-hidden>
            <span style={{ width: `${ratio * 100}%` }} />
          </span>
        )}
        <span>{usage}</span>
      </div>
    </section>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}
