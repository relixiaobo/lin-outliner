import { useEffect, useState } from 'react';
import type { Automation, AutomationRun } from '../../../core/agent/automation';
import type { Thread } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, BackIcon, ClockIcon, PencilIcon, PlayIcon, TrashIcon } from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { IconButton } from '../../ui/primitives/IconButton';
import { SegmentedControl } from '../../ui/primitives/SegmentedControl';
import { automationStore, useAutomationStore } from './automationStore';
import { AutomationEditor } from './AutomationEditor';
import { AutomationRunsView } from './AutomationRunsView';

interface AutomationsViewProps {
  readonly threads: readonly Thread[];
  readonly onOpenThread: (threadId: string) => Promise<void>;
}

type Surface = 'list' | 'detail' | 'create' | 'edit';

export function AutomationsView(props: AutomationsViewProps) {
  const t = useT().agent.automations;
  const snapshot = useAutomationStore();
  const [surface, setSurface] = useState<Surface>('list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const selected = snapshot.automations.find((automation) => automation.id === snapshot.selectedAutomationId) ?? null;
  const filtered = snapshot.statusFilter === 'all'
    ? snapshot.automations
    : snapshot.automations.filter((automation) => automation.status === snapshot.statusFilter);
  const runs = selected
    ? snapshot.runs.filter((run) => run.automationId === selected.id)
    : [];

  useEffect(() => {
    void automationStore.initialize().catch(() => undefined);
    return () => automationStore.dispose();
  }, []);

  useEffect(() => {
    if (surface !== 'detail' || !selected) return;
    void automationStore.loadRunsForAutomation(selected.id).catch(() => undefined);
  }, [surface, selected?.id]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusy(false);
    }
  }

  if (surface === 'create' || surface === 'edit') {
    return (
      <AutomationsSurfaceHeader backLabel={t.back} title={surface === 'create' ? t.new : selected?.name ?? t.edit} onBack={() => setSurface(surface === 'edit' ? 'detail' : 'list')}>
        <AutomationEditor
          automation={surface === 'edit' ? selected : null}
          busy={busy}
          onCancel={() => setSurface(surface === 'edit' ? 'detail' : 'list')}
          onCreate={(input) => run(async () => {
            await automationStore.create(input);
            setSurface('detail');
          })}
          onUpdate={(input) => run(async () => {
            await automationStore.update(input);
            setSurface('detail');
          })}
          threads={props.threads}
        />
      </AutomationsSurfaceHeader>
    );
  }

  if (surface === 'detail' && selected) {
    return (
      <AutomationsSurfaceHeader backLabel={t.back} title={selected.name} onBack={() => setSurface('list')}>
        <div className="automation-detail-scroll">
          <div className="automation-detail-actions">
            {selected.status !== 'completed' ? (
              <>
                {selected.status === 'active' ? (
                  <Button disabled={busy} onClick={() => void run(async () => { await automationStore.startNow(selected); })} size="sm" variant="primary">
                    <PlayIcon size={12} />{t.startNow}
                  </Button>
                ) : null}
                <Button disabled={busy} onClick={() => void run(async () => {
                  if (selected.status === 'paused') await automationStore.resume(selected);
                  else await automationStore.pause(selected);
                })} size="sm" variant="secondary">
                  {selected.status === 'paused' ? t.resume : t.pause}
                </Button>
              </>
            ) : null}
            <IconButton disabled={busy} icon={PencilIcon} label={t.edit} onClick={() => setSurface('edit')} variant="message" />
            <IconButton disabled={busy} icon={TrashIcon} label={t.delete} onClick={() => setDeleteTarget(selected)} variant="message" />
          </div>
          <p className="automation-detail-prompt">{selected.prompt}</p>
          <dl className="automation-detail-metadata">
            <div><dt>{t.schedule}</dt><dd>{selected.nextOccurrenceAt === null ? t.noNext : `${formatDate(selected.nextOccurrenceAt)} · ${selected.schedule.timezone}`}</dd></div>
            <div><dt>{t.destination}</dt><dd>{selected.destination.kind === 'standalone' ? t.destinations.standalone : t.destinations.existingThread}</dd></div>
            <div>
              <dt>{t.project}</dt>
              <dd className="automation-detail-projects">
                {selected.projectBindings.length === 0 ? t.projects.none : selected.projectBindings.map((binding) => (
                  <span key={binding.id}>{binding.cwd} · {t.projects[binding.executionMode]}</span>
                ))}
              </dd>
            </div>
          </dl>
          <section className="automation-runs-section">
            <h3>{t.recentRuns}</h3>
            <AutomationRunsView
              onMarkRead={(runItem) => run(async () => { await automationStore.markRunRead(runItem); })}
              onOpenThread={(runItem) => run(async () => openRunThread(runItem, props.onOpenThread))}
              onPin={(runItem, pinned) => run(async () => { await automationStore.pinRun(runItem, pinned); })}
              runs={runs}
            />
          </section>
          {error ? <p className="automation-error" role="alert">{error}</p> : null}
        </div>
        {deleteTarget ? (
          <ConfirmDialog
            cancelLabel={t.cancel}
            confirmLabel={t.delete}
            danger
            message={t.deleteConfirm({ name: deleteTarget.name })}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => void run(async () => {
              await automationStore.delete(deleteTarget);
              setDeleteTarget(null);
              setSurface('list');
            })}
            title={t.delete}
          />
        ) : null}
      </AutomationsSurfaceHeader>
    );
  }

  return (
    <div className="automations-view">
      <div className="automations-toolbar">
        <SegmentedControl
          className="automations-filter"
          label={t.title}
          onChange={(value) => automationStore.setStatusFilter(value)}
          options={(['all', 'active', 'paused', 'completed'] as const).map((value) => ({
            value,
            label: t.filters[value],
          }))}
          value={snapshot.statusFilter}
        />
        <IconButton icon={AddIcon} label={t.new} onClick={() => setSurface('create')} variant="message" />
      </div>
      <div className="automations-list" role="list">
        {snapshot.loading ? <p className="automation-empty-copy">{t.loading}</p> : null}
        {!snapshot.loading && filtered.length === 0 ? <p className="automation-empty-copy">{t.empty}</p> : null}
        {filtered.map((automation) => {
          const unread = snapshot.unreadAutomationIds.includes(automation.id);
          return (
            <button
              className="automation-list-row"
              key={automation.id}
              onClick={() => {
                automationStore.select(automation.id);
                setSurface('detail');
              }}
              role="listitem"
              type="button"
            >
              <span className="automation-list-icon"><ClockIcon size={14} /></span>
              <span className="automation-list-copy">
                <strong>{automation.name}</strong>
                <small>{automation.nextOccurrenceAt === null
                  ? t.noNext
                  : t.next({ value: formatRelative(automation.nextOccurrenceAt) })}</small>
              </span>
              <span className={`automation-status is-${automation.status}`}>{t.filters[automation.status]}</span>
              {unread ? <span className="automation-unread" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      {snapshot.error || error ? <p className="automation-error" role="alert">{snapshot.error ?? error}</p> : null}
    </div>
  );
}

function AutomationsSurfaceHeader(props: {
  readonly backLabel: string;
  readonly title: string;
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="automation-subview">
      <header className="automation-subview-header">
        <IconButton icon={BackIcon} label={props.backLabel} onClick={props.onBack} variant="message" />
        <h2>{props.title}</h2>
      </header>
      {props.children}
    </div>
  );
}

async function openRunThread(run: AutomationRun, open: (threadId: string) => Promise<void>): Promise<void> {
  if (!run.threadId) return;
  await open(run.threadId);
  if (run.readAt === null) await automationStore.markRunRead(run);
}

function formatRelative(timestamp: number): string {
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
