import { useId } from 'react';
import type { Thread, Turn } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { CloseIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { Dialog } from '../../ui/primitives/Dialog';

interface ThreadDetailsDialogProps {
  readonly thread: Thread;
  readonly turns: readonly Turn[];
  readonly onClose: () => void;
}

export function ThreadDetailsDialog({ thread, turns, onClose }: ThreadDetailsDialogProps) {
  const t = useT();
  const titleId = useId();
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

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><code>{value}</code></dd>
    </div>
  );
}
