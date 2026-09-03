import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadId, ToolTaskProjection, ToolTaskReadResponse } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { ICON_SIZE, LoaderIcon, StopIcon, TerminalIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { Button } from '../../ui/primitives/Button';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { useDismissibleOverlay } from '../../ui/primitives/useDismissibleOverlay';

export const TOOL_TASK_STRIP_LINGER_MS = 8_000;

export function ToolTaskStrip({
  ownerThreadId,
  tasks,
  onRead,
  onClearDetails,
  onStop,
  now,
}: {
  readonly ownerThreadId: ThreadId;
  readonly tasks: readonly ToolTaskProjection[];
  readonly onRead: (threadId: ThreadId, taskId: string) => Promise<ToolTaskReadResponse>;
  readonly onClearDetails: (threadId: ThreadId) => Promise<number>;
  readonly onStop: (threadId: ThreadId, taskId: string) => Promise<void>;
  readonly now?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ToolTaskReadResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingTaskId, setLoadingTaskId] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearResult, setClearResult] = useState<string | null>(null);
  const clock = useTaskClock(tasks, now);
  const rows = useMemo(() => taskStripRows(tasks, clock), [tasks, clock]);
  const runningCount = rows.filter((task) => task.state === 'running' || task.state === 'settling').length;
  const root = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissibleOverlay(root, dismiss, { disabled: !open });

  useEffect(() => {
    if (rows.length === 0) setOpen(false);
  }, [rows.length]);
  const toggleDetail = useCallback(async (taskId: string) => {
    if (detail?.task.taskId === taskId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setLoadingTaskId(taskId);
    setDetailError(null);
    try {
      setDetail(await onRead(ownerThreadId, taskId));
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTaskId(null);
    }
  }, [detail?.task.taskId, onRead, ownerThreadId]);
  const clearEligibleDetails = useCallback(async () => {
    setConfirmingClear(false);
    setDetailError(null);
    try {
      const bytes = await onClearDetails(ownerThreadId);
      setClearResult(bytes > 0 ? t.agent.thread.tasks.cleared({ size: formatBytes(bytes) }) : t.agent.thread.tasks.nothingCleared);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    }
  }, [onClearDetails, ownerThreadId, t]);

  if (rows.length === 0) return null;
  return (
    <div className="thread-work-strip" ref={root}>
      <button
        aria-expanded={open}
        className="thread-work-strip-pill"
        onClick={() => setOpen((current) => !current)}
        title={t.agent.thread.tasks.backgroundWork}
        type="button"
      >
        {runningCount > 0
          ? <LoaderIcon aria-hidden className="thread-work-strip-spinner" size={ICON_SIZE.tiny} />
          : <TerminalIcon aria-hidden size={ICON_SIZE.tiny} />}
        <span>{runningCount > 0
          ? t.agent.thread.tasks.running({ count: runningCount })
          : t.agent.thread.tasks.justFinished}</span>
      </button>
      {open ? (
        <div className="thread-work-strip-list" role="group" aria-label={t.agent.thread.tasks.backgroundWork}>
          {rows.map((task) => {
            const running = task.state === 'running' || task.state === 'settling';
            const status = running && task.progress?.message
              ? task.progress.message
              : t.agent.thread.tasks.states[task.state];
            return (
              <div className={`thread-work-strip-row thread-tool-task-row thread-tool-task-${task.state}`} key={task.taskId}>
                <button
                  aria-expanded={detail?.task.taskId === task.taskId}
                  className="thread-work-strip-open"
                  onClick={() => void toggleDetail(task.taskId)}
                  title={`${task.description} · ${status}`}
                  type="button"
                >
                  <TerminalIcon aria-hidden size={ICON_SIZE.rowGlyph} />
                  <span className="thread-work-strip-name">{task.description}</span>
                  <span className="thread-work-strip-type">{task.producer}</span>
                  <span className="thread-work-strip-meta">{loadingTaskId === task.taskId ? t.agent.thread.tasks.loading : status}</span>
                </button>
                {running ? (
                  <IconButton
                    className="thread-work-strip-stop"
                    icon={StopIcon}
                    iconSize={ICON_SIZE.tiny}
                    label={t.agent.thread.tasks.stop({ name: task.description })}
                    onClick={() => void onStop(ownerThreadId, task.taskId)}
                    variant="message"
                  />
                ) : null}
                {detail?.task.taskId === task.taskId ? (
                  <TaskDetail detail={detail} onRequestClear={() => setConfirmingClear(true)} clearResult={clearResult} />
                ) : null}
              </div>
            );
          })}
          {detailError && loadingTaskId === null ? (
            <div className="thread-tool-task-error" role="status">{detailError}</div>
          ) : null}
        </div>
      ) : null}
      {confirmingClear ? (
        <ConfirmDialog
          danger
          confirmLabel={t.agent.thread.tasks.clearDetails}
          message={t.agent.thread.tasks.clearDetailsMessage}
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => void clearEligibleDetails()}
          title={t.agent.thread.tasks.clearDetailsTitle}
        />
      ) : null}
    </div>
  );
}

function TaskDetail({
  detail,
  onRequestClear,
  clearResult,
}: {
  readonly detail: ToolTaskReadResponse;
  readonly onRequestClear: () => void;
  readonly clearResult: string | null;
}) {
  const t = useT();
  const output = [detail.output?.stdout, detail.output?.stderr].filter(Boolean).join('\n');
  return (
    <div className="thread-tool-task-detail">
      {output ? <pre className="thread-tool-task-output">{output}</pre> : null}
      {detail.task.artifacts.length > 0 ? (
        <div className="thread-tool-task-artifacts">
          <span>{t.agent.thread.tasks.artifacts}</span>
          <ul>
            {detail.task.artifacts.map((artifact) => (
              <li key={artifact.ref.id}>{artifact.label}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail.task.artifactWarnings.map((warning) => (
        <div className="thread-tool-task-warning" key={warning}>{warning}</div>
      ))}
      {detail.task.storagePressure ? (
        <div className="thread-tool-task-pressure">
          <span>{t.agent.thread.tasks.storagePressure({
            required: formatBytes(detail.task.storagePressure.requiredBytes),
            available: formatBytes(detail.task.storagePressure.reclaimableBytes),
          })}</span>
          <Button onClick={onRequestClear} variant="ghost">{t.agent.thread.tasks.clearDetails}</Button>
          {clearResult ? <span role="status">{clearResult}</span> : null}
        </div>
      ) : null}
      {detail.task.error ? <div className="thread-tool-task-error">{detail.task.error}</div> : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  if (bytes < 1_024 * 1_024 * 1_024) return `${Math.round(bytes / (1_024 * 1_024))} MB`;
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`;
}

export function taskStripRows(
  tasks: readonly ToolTaskProjection[],
  now: number,
): readonly ToolTaskProjection[] {
  return tasks
    .filter((task) => (
      task.state === 'running'
      || task.state === 'settling'
      || (task.completedAt !== null && now - task.completedAt < TOOL_TASK_STRIP_LINGER_MS)
    ))
    .sort((left, right) => {
      const leftRunning = left.state === 'running' || left.state === 'settling';
      const rightRunning = right.state === 'running' || right.state === 'settling';
      return Number(rightRunning) - Number(leftRunning)
        || left.startedAt - right.startedAt
        || left.taskId.localeCompare(right.taskId);
    });
}

function useTaskClock(tasks: readonly ToolTaskProjection[], injected: number | undefined): number {
  const [now, setNow] = useState(() => injected ?? Date.now());
  const clock = injected ?? now;
  const lingering = tasks.some((task) => (
    task.completedAt !== null && clock - task.completedAt < TOOL_TASK_STRIP_LINGER_MS
  ));
  useEffect(() => {
    if (injected !== undefined) {
      setNow(injected);
      return undefined;
    }
    if (!lingering) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [injected, lingering]);
  return clock;
}
