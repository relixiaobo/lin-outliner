import { useEffect, useId, useRef, useState } from 'react';
import type { ThreadMemoryMode } from '../../../core/agent/memory';
import type { Thread, Turn } from '../projectionTypes';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { CloseIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { Dialog } from '../../ui/primitives/Dialog';
import { SwitchControl } from '../../ui/primitives/SwitchControl';
import { SwitchMark } from '../../ui/primitives/SwitchMark';

interface ThreadDetailsDialogProps {
  readonly thread: Thread;
  readonly turns: readonly Turn[];
  readonly onClose: () => void;
}

export function ThreadDetailsDialog({ thread, turns, onClose }: ThreadDetailsDialogProps) {
  const t = useT();
  const titleId = useId();
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

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><code>{value}</code></dd>
    </div>
  );
}
