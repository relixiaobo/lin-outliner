import { useMemo, useState } from 'react';
import type { Messages } from '../../../core/i18n';
import type { AgentTaskEntry } from '../../agent/runtime';
import { api } from '../../api/client';
import { useI18n } from '../../i18n/I18nProvider';
import {
  AgentIcon,
  BrainIcon,
  CloseIcon,
  ICON_SIZE,
  OpenIcon,
  StopIcon,
  UsedToolsIcon,
  WarningIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';

interface AgentTaskPanelProps {
  conversationId: string | null;
  tasks: readonly AgentTaskEntry[];
  onClose: () => void;
  onOpenSubagent: (subagentId: string) => void;
}

function formatTaskTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function taskStatusLabel(task: AgentTaskEntry, labels: Messages['agent']['task']): string {
  return labels.status[task.status];
}

function taskKindLabel(task: AgentTaskEntry, labels: Messages['agent']['task']): string {
  if (task.kind === 'dream') return labels.kindDream;
  return labels.kindSubagent;
}

function taskTitle(task: AgentTaskEntry, labels: Messages['agent']['task']): string {
  if (task.kind === 'dream') return labels.dreamTitle;
  return task.title;
}

function taskMetaParts(task: AgentTaskEntry, labels: Messages['agent']['task'], locale: string): string[] {
  if (task.kind === 'dream') {
    return [
      // Whose pool this Dream maintains (run anchor subject): the user profile or an agent
      // self-model — one pass runs several Dreams, so the panel labels them apart.
      task.principal.type === 'user' ? labels.dreamPoolUser : labels.dreamPoolAgent,
      task.trigger === 'schedule' ? labels.triggerSchedule : labels.triggerManual,
      task.processed ? labels.messages({ count: task.processed.totalMessageCount }) : null,
      task.changes ? labels.memoryChanges({ count: task.changes.added + task.changes.updated + task.changes.forgotten }) : null,
      formatTaskTime(task.updatedAt, locale),
    ].filter((part): part is string => Boolean(part));
  }
  return [
    task.subtitle,
    labels.messages({ count: task.subagent.transcriptMessageCount }),
    formatTaskTime(task.updatedAt, locale),
  ];
}

export function AgentTaskPanel({
  conversationId,
  tasks,
  onClose,
  onOpenSubagent,
}: AgentTaskPanelProps) {
  const { locale, t } = useI18n();
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const runningCount = useMemo(() => tasks.filter((task) => task.status === 'running').length, [tasks]);

  async function stopTask(task: AgentTaskEntry) {
    if (!conversationId || task.kind !== 'subagent' || task.status !== 'running' || stoppingTaskId) return;
    setStoppingTaskId(task.id);
    setActionError(null);
    try {
      await api.agentSubagentStop(conversationId, task.subagentId);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStoppingTaskId(null);
    }
  }

  return (
    <aside className="agent-task-panel" aria-label={t.agent.task.panelAriaLabel}>
      <header className="agent-task-header">
        <div className="agent-task-title-block">
          <div className="agent-task-title-line">
            <UsedToolsIcon size={ICON_SIZE.menu} />
            <span>{t.agent.task.heading}</span>
          </div>
          <p aria-live="polite">{runningCount > 0 ? t.agent.task.runningSummary({ count: runningCount }) : t.agent.task.idleSummary}</p>
        </div>
        <IconButton
          className="agent-task-close"
          icon={CloseIcon}
          label={t.agent.task.closePanel}
          onClick={onClose}
          title={t.agent.task.close}
          variant="panel"
        />
      </header>
      {actionError ? (
        <div className="agent-task-action-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{actionError}</span>
        </div>
      ) : null}
      {tasks.length === 0 ? (
        <div className="agent-task-empty">{t.agent.task.empty}</div>
      ) : (
        <div className="agent-task-list">
          {tasks.map((task) => {
            const canStop = task.kind === 'subagent' && task.status === 'running';
            const stopping = stoppingTaskId === task.id;
            const kindIcon = task.kind === 'dream' ? BrainIcon : AgentIcon;
            const KindIcon = kindIcon;
            const meta = taskMetaParts(task, t.agent.task, locale).join(' · ');
            const mainContent = (
              <>
                <span className="agent-task-kind">
                  <KindIcon size={ICON_SIZE.menu} />
                  <span>{taskKindLabel(task, t.agent.task)}</span>
                  <span className={`agent-task-status is-${task.status}`}>{taskStatusLabel(task, t.agent.task)}</span>
                </span>
                <span className="agent-task-title">{taskTitle(task, t.agent.task)}</span>
                <span className="agent-task-meta">{meta}</span>
              </>
            );
            return (
              <article className={`agent-task-row is-${task.status}${task.kind === 'dream' ? ' is-readonly' : ''}`} key={task.id}>
                {task.kind === 'subagent' ? (
                  <ButtonControl
                    className="agent-task-main"
                    onClick={() => onOpenSubagent(task.subagentId)}
                  >
                    {mainContent}
                  </ButtonControl>
                ) : (
                  <div className="agent-task-main">
                    {mainContent}
                  </div>
                )}
                <div className="agent-task-row-actions">
                  {task.kind === 'subagent' ? (
                    <IconButton
                      className="agent-task-icon-button"
                      icon={OpenIcon}
                      label={t.agent.task.openTask}
                      onClick={() => onOpenSubagent(task.subagentId)}
                      title={t.agent.task.openTask}
                      variant="message"
                    />
                  ) : null}
                  {canStop ? (
                    <IconButton
                      className="agent-task-icon-button is-danger"
                      disabled={stoppingTaskId !== null}
                      icon={StopIcon}
                      label={stopping ? t.agent.task.stopping : t.agent.task.stopTask}
                      onClick={() => void stopTask(task)}
                      title={stopping ? t.agent.task.stopping : t.agent.task.stopTask}
                      variant="message"
                    />
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </aside>
  );
}
