import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ThreadMemoryMode } from '../../../core/agent/memory';
import type { Thread, Turn } from '../../../core/agent/protocol';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { threadStore } from '../store/threadStore';
import { CloseIcon, TrashIcon } from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';
import { IconButton } from '../../ui/primitives/IconButton';
import { Dialog } from '../../ui/primitives/Dialog';
import { SwitchControl } from '../../ui/primitives/SwitchControl';
import { SwitchMark } from '../../ui/primitives/SwitchMark';

interface ThreadDetailsDialogProps {
  readonly thread: Thread;
  readonly turns: readonly Turn[];
  readonly onClose: () => void;
  readonly onOpenThread: (threadId: string) => Promise<void>;
}

export function ThreadDetailsDialog({ thread, turns, onClose, onOpenThread }: ThreadDetailsDialogProps) {
  const t = useT();
  const titleId = useId();
  const [descendants, setDescendants] = useState<readonly Thread[]>([]);
  const [descendantsError, setDescendantsError] = useState<string | null>(null);
  const descendantsRequestRef = useRef(0);
  const [memoryMode, setMemoryMode] = useState<ThreadMemoryMode | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const memoryBusyRef = useRef(false);
  const memoryRequestGenerationRef = useRef(0);
  const supportsMemory = !thread.ephemeral && thread.parentThreadId === null && thread.threadSource === 'user';

  useEffect(() => {
    const generation = ++memoryRequestGenerationRef.current;
    memoryBusyRef.current = false;
    setMemoryBusy(false);
    setMemoryMode(null);
    setMemoryError(null);
    if (!supportsMemory) return;
    let active = true;
    void api.memorySettings(thread.id)
      .then((settings) => {
        if (active && generation === memoryRequestGenerationRef.current) {
          setMemoryMode(settings.thread?.mode ?? null);
        }
      })
      .catch((error) => {
        if (active && generation === memoryRequestGenerationRef.current) setMemoryError(errorMessage(error));
      });
    return () => { active = false; };
  }, [supportsMemory, thread.id]);

  async function changeMemoryMode(enabled: boolean) {
    if (memoryBusyRef.current) return;
    memoryBusyRef.current = true;
    setMemoryBusy(true);
    setMemoryError(null);
    const generation = ++memoryRequestGenerationRef.current;
    try {
      const settings = await api.memorySetThreadMode(thread.id, enabled ? 'enabled' : 'disabled');
      if (generation === memoryRequestGenerationRef.current) setMemoryMode(settings.thread?.mode ?? null);
    } catch (error) {
      if (generation === memoryRequestGenerationRef.current) setMemoryError(errorMessage(error));
    } finally {
      if (generation === memoryRequestGenerationRef.current) {
        memoryBusyRef.current = false;
        setMemoryBusy(false);
      }
    }
  }
  const refreshDescendants = useCallback(async () => {
    const generation = ++descendantsRequestRef.current;
    try {
      const data = await threadStore.listDescendants(thread.id);
      if (generation === descendantsRequestRef.current) {
        setDescendants(data);
        setDescendantsError(null);
      }
    } catch (error) {
      if (generation === descendantsRequestRef.current) setDescendantsError(errorMessage(error));
    }
  }, [thread.id]);

  useEffect(() => {
    void refreshDescendants();
    return () => { descendantsRequestRef.current += 1; };
  }, [refreshDescendants]);

  async function removeDescendants(targets: readonly Thread[]) {
    setDescendantsError(null);
    try {
      for (const target of targets) await threadStore.deleteThread(target.id);
    } catch (error) {
      setDescendantsError(errorMessage(error));
    } finally {
      await refreshDescendants();
    }
  }

  const finishedRoots = deletableFinishedRoots(descendants);
  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      labelledBy={titleId}
      onBackdropMouseDown={onClose}
      onEscapeKeyDown={onClose}
      surfaceClassName="thread-details-dialog"
    >
      <header className="thread-details-header">
        <h2 id={titleId}>{t.agent.thread.detailsTitle}</h2>
        <IconButton icon={CloseIcon} label={t.agent.thread.closeDetails} onClick={onClose} variant="panel" />
      </header>
      <div className="thread-details-scroll">
        <dl className="thread-details-metadata">
          <Detail label={t.agent.thread.threadId} value={thread.id} />
          <Detail label={t.agent.thread.status} value={thread.status.type} />
          <Detail label={t.agent.thread.source} value={thread.threadSource} />
          <Detail label={t.agent.thread.parentThreadId} value={thread.parentThreadId ?? t.agent.thread.none} />
          <Detail label={t.agent.thread.forkedFromId} value={thread.forkedFromId ?? t.agent.thread.none} />
          {supportsMemory ? (
            <div>
              <dt>{t.agent.thread.memory}</dt>
              <dd className="thread-details-memory-control">
                <SwitchControl
                  checked={memoryMode === 'enabled'}
                  disabled={memoryBusy || memoryMode === null}
                  label={t.agent.thread.memory}
                  onCheckedChange={(enabled) => void changeMemoryMode(enabled)}
                >
                  <SwitchMark checked={memoryMode === 'enabled'} />
                </SwitchControl>
                {memoryError ? (
                  <span className="thread-details-memory-error" role="alert">{memoryError}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
        {thread.parentThreadId === null ? (
          <section className="thread-details-subagents">
            <div className="thread-details-subagents-heading">
              <h3>{t.agent.thread.subagents}</h3>
              {finishedRoots.length > 0 ? (
                <Button onClick={() => void removeDescendants(finishedRoots)} variant="ghost">
                  {t.agent.thread.deleteFinishedSubagents}
                </Button>
              ) : null}
            </div>
            {descendantsError ? (
              <p className="thread-details-memory-error" role="alert">{descendantsError}</p>
            ) : null}
            {descendants.length === 0 ? (
              <p className="thread-details-empty">{t.agent.thread.noSubagents}</p>
            ) : (
              <ul className="thread-details-subagent-list">
                {descendants.map((descendant) => {
                  const name = descendantName(descendant, t.agent.thread.untitled);
                  return (
                    <li className="thread-details-subagent" key={descendant.id}>
                      <button
                        aria-label={t.agent.thread.openSubagent({ name })}
                        className="thread-details-subagent-open"
                        onClick={() => { void onOpenThread(descendant.id); onClose(); }}
                        type="button"
                      >
                        <span className="thread-details-subagent-name">{name}</span>
                        <small>
                          {descendantStatusLabel(descendant, t.agent.thread)}
                          {' · '}
                          {formatRelativeTime(descendant.updatedAt)}
                        </small>
                      </button>
                      <IconButton
                        icon={TrashIcon}
                        label={t.agent.thread.deleteSubagent({ name })}
                        onClick={() => void removeDescendants([descendant])}
                        variant="message"
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}
        <div className="thread-details-history">
          {turns.map((turn) => (
            <section className="thread-details-turn" key={turn.id}>
              <div className="thread-details-turn-heading">
                <strong>{t.agent.thread.turn}</strong>
                <code>{turn.id}</code>
                <small>{turn.status}</small>
              </div>
              <ol>
                {turn.items.map((item) => (
                  <li key={item.id}>
                    <span>{t.agent.thread.itemLabel}</span>
                    <code>{item.id}</code>
                    <small>{item.type}</small>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {turns.length === 0 ? <p className="thread-details-empty">{t.agent.thread.noTurns}</p> : null}
        </div>
      </div>
    </Dialog>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The highest Threads whose whole subtree has stopped. Deleting cascades, so
 * bulk cleanup must never take a still-running grandchild down with a finished
 * parent — "delete finished" means finished, including everything under it.
 */
function deletableFinishedRoots(descendants: readonly Thread[]): readonly Thread[] {
  const settled = new Set<string>();
  for (const candidate of descendants) {
    if (candidate.status.type === 'active') continue;
    const hasActiveDescendant = descendants.some((other) => (
      other.status.type === 'active' && isDescendantOf(other, candidate.id, descendants)
    ));
    if (!hasActiveDescendant) settled.add(candidate.id);
  }
  return descendants.filter((candidate) => (
    settled.has(candidate.id)
    && !(candidate.parentThreadId !== null && settled.has(candidate.parentThreadId))
  ));
}

function isDescendantOf(thread: Thread, ancestorId: string, threads: readonly Thread[]): boolean {
  const seen = new Set<string>([thread.id]);
  let current = thread.parentThreadId;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = threads.find((candidate) => candidate.id === current)?.parentThreadId ?? null;
  }
  return false;
}

function descendantName(thread: Thread, untitled: string): string {
  return thread.name || thread.agentNickname || thread.agentRole || thread.preview || untitled;
}

function descendantStatusLabel(
  thread: Thread,
  labels: { readonly subagentRunning: string; readonly subagentIdle: string; readonly subagentFailed: string },
): string {
  if (thread.status.type === 'active') return labels.subagentRunning;
  if (thread.status.type === 'systemError') return labels.subagentFailed;
  return labels.subagentIdle;
}

function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, 'second');
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, 'minute');
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, 'hour');
  return formatter.format(Math.round(elapsedHours / 24), 'day');
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><code>{value}</code></dd>
    </div>
  );
}
