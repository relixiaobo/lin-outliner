import { useCallback, useEffect, useRef, useState } from 'react';
import type { Automation, AutomationRun } from '../../../core/agent/automation';
import type { Thread } from '../../../core/agent/protocol';
import type { AgentProviderSettingsView } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import {
  AddIcon,
  ClockIcon,
  CloseIcon,
  MoreIcon,
  PlayIcon,
  SearchIcon,
  ScheduledIcon,
} from '../../ui/icons';
import { AnchoredActionMenu } from '../../ui/primitives/AnchoredActionMenu';
import { Button } from '../../ui/primitives/Button';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { Dialog } from '../../ui/primitives/Dialog';
import { IconButton } from '../../ui/primitives/IconButton';
import { Input } from '../../ui/primitives/Input';
import { SegmentedControl } from '../../ui/primitives/SegmentedControl';
import {
  AutomationDrawerResizeHandle,
  useAutomationDrawerHeight,
} from './AutomationDrawerResize';
import { AutomationEditor } from './AutomationEditor';
import { AutomationRunsView } from './AutomationRunsView';
import { automationStore, useAutomationStore } from './automationStore';

interface AutomationsViewProps {
  readonly threads: readonly Thread[];
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly providerSettings: AgentProviderSettingsView | null;
}

type DrawerState = { readonly kind: 'create' } | { readonly kind: 'automation'; readonly id: string };

export function AutomationsView(props: AutomationsViewProps) {
  const t = useT().agent.automations;
  const snapshot = useAutomationStore();
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const busyRef = useRef(false);
  const drawerRestoreTargetRef = useRef<HTMLElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const selected = drawer?.kind === 'automation'
    ? snapshot.automations.find((automation) => automation.id === drawer.id) ?? null
    : null;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filtered = snapshot.automations.filter((automation) => (
    (snapshot.statusFilter === 'all' || automation.status === snapshot.statusFilter)
    && (
      !normalizedSearch
      || automation.name.toLocaleLowerCase().includes(normalizedSearch)
      || automation.prompt.toLocaleLowerCase().includes(normalizedSearch)
    )
  ));
  const runs = selected
    ? snapshot.runs.filter((run) => run.automationId === selected.id)
    : [];

  useAutomationDrawerHeight(drawer !== null);

  useEffect(() => {
    void automationStore.initialize().catch(() => undefined);
    return () => automationStore.dispose();
  }, []);

  useEffect(() => {
    if (!selected) return;
    void automationStore.loadRunsForAutomation(selected.id).catch(() => undefined);
  }, [selected?.id]);

  const closeDrawer = useCallback(() => {
    setDrawer(null);
    setDirty(false);
    setError(null);
    setMenuOpen(false);
    setDiscardOpen(false);
    setDeleteTarget(null);
  }, []);

  const requestClose = useCallback(() => {
    setMenuOpen(false);
    if (dirty) setDiscardOpen(true);
    else closeDrawer();
  }, [closeDrawer, dirty]);

  useEffect(() => {
    if (drawer?.kind === 'automation' && !snapshot.loading && !selected) closeDrawer();
  }, [closeDrawer, drawer, selected, snapshot.loading]);

  async function perform<T>(action: () => Promise<T>): Promise<T> {
    if (busyRef.current) throw new Error(t.busy);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (actionError) {
      setError(errorMessage(actionError));
      throw actionError;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function openCreate(origin: HTMLElement): void {
    drawerRestoreTargetRef.current = origin;
    setDirty(false);
    setError(null);
    setDrawer({ kind: 'create' });
  }

  function openAutomation(automation: Automation, origin: HTMLElement): void {
    drawerRestoreTargetRef.current = origin;
    automationStore.select(automation.id);
    setDirty(false);
    setError(null);
    setDrawer({ kind: 'automation', id: automation.id });
  }

  const menuActions = selected ? [
    ...(selected.status !== 'completed' ? [{
      id: selected.status === 'paused' ? 'resume' : 'pause',
      label: selected.status === 'paused' ? t.resume : t.pause,
      disabled: busy || dirty,
      onSelect: () => {
        void perform(async () => {
          if (selected.status === 'paused') await automationStore.resume(selected);
          else await automationStore.pause(selected);
        }).catch(() => undefined);
      },
    }] : []),
    {
      id: 'delete',
      label: t.delete,
      disabled: busy,
      danger: true,
      onSelect: () => setDeleteTarget(selected),
    },
  ] : [];

  return (
    <div className="automations-view">
      <div className="automations-controls">
        <div className="automations-toolbar">
          <label className="automations-search">
            <SearchIcon aria-hidden size={14} />
            <Input
              autoComplete="off"
              label={t.search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t.searchPlaceholder}
              size="sm"
              type="search"
              value={search}
              variant="bare"
            />
          </label>
          <IconButton
            className="automations-new-button"
            icon={AddIcon}
            label={t.new}
            onClick={(event) => openCreate(event.currentTarget)}
            variant="message"
          />
        </div>
        <SegmentedControl
          className="automations-filter"
          label={t.statusFilter}
          onChange={(value) => automationStore.setStatusFilter(value)}
          options={(['all', 'active', 'paused', 'completed'] as const).map((value) => ({
            value,
            label: t.filters[value],
          }))}
          value={snapshot.statusFilter}
        />
      </div>

      <div className="automations-list">
        {snapshot.loading ? <p className="automation-empty-copy">{t.loading}</p> : null}
        {!snapshot.loading && filtered.length === 0 ? (
          normalizedSearch || snapshot.statusFilter !== 'all' ? (
            <div className="automation-empty-state">
              <SearchIcon aria-hidden size={20} />
              <strong>{t.noMatches}</strong>
              <p>{t.noMatchesDescription}</p>
            </div>
          ) : (
            <div className="automation-empty-state">
              <ScheduledIcon aria-hidden size={22} />
              <strong>{t.empty}</strong>
              <p>{t.emptyDescription}</p>
              <Button onClick={(event) => openCreate(event.currentTarget)} size="sm" variant="primary">
                <AddIcon size={12} />{t.new}
              </Button>
            </div>
          )
        ) : null}
        {filtered.map((automation) => {
          const unread = snapshot.unreadAutomationIds.includes(automation.id);
          return (
            <button
              aria-label={unread ? `${automation.name}, ${t.unread}` : undefined}
              className="automation-list-row"
              key={automation.id}
              onClick={(event) => openAutomation(automation, event.currentTarget)}
              type="button"
            >
              <span className="automation-list-icon"><ClockIcon size={14} /></span>
              <span className="automation-list-copy">
                <span className="automation-list-heading">
                  <strong>{automation.name}</strong>
                  <span className={`automation-status is-${automation.status}`}>
                    <span className="automation-status-dot" aria-hidden="true" />
                    {t.filters[automation.status]}
                  </span>
                </span>
                <small>{automation.nextOccurrenceAt === null
                  ? t.noNext
                  : t.next({ value: formatRelative(automation.nextOccurrenceAt) })}</small>
              </span>
              <span className={`automation-unread${unread ? ' is-visible' : ''}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {snapshot.error || (error && !drawer) ? (
        <p className="automation-error automation-list-error" role="alert">{snapshot.error ?? error}</p>
      ) : null}

      {drawer ? (
        <Dialog
          backdropClassName="automation-drawer-backdrop"
          focusKey={drawer.kind === 'create' ? 'create' : drawer.id}
          label={drawer.kind === 'create' ? t.new : selected?.name ?? t.details}
          onBackdropMouseDown={requestClose}
          onEscapeKeyDown={requestClose}
          restoreFocus={() => drawerRestoreTargetRef.current}
          surfaceClassName="automation-drawer"
        >
          <AutomationDrawerResizeHandle />
          <header className="automation-drawer-header">
            <div className="automation-drawer-heading">
              <h2 className={selected ? 'automation-drawer-title-accessible' : undefined}>
                {drawer.kind === 'create' ? t.new : selected?.name ?? t.details}
              </h2>
              {selected ? (
                <span className={`automation-drawer-status is-${selected.status}`}>
                  <span aria-hidden="true" />
                  {t.filters[selected.status]}
                </span>
              ) : null}
            </div>
            <div className="automation-drawer-actions">
              {selected?.status === 'active' ? (
                <Button
                  disabled={busy || dirty}
                  onClick={() => void perform(async () => {
                    await automationStore.startNow(selected);
                    await automationStore.loadRunsForAutomation(selected.id);
                  }).catch(() => undefined)}
                  size="sm"
                  variant="primary"
                >
                  <PlayIcon size={12} />{t.startNow}
                </Button>
              ) : null}
              {selected ? (
                <IconButton
                  aria-expanded={menuOpen}
                  disabled={busy}
                  icon={MoreIcon}
                  label={t.moreActions}
                  onClick={() => setMenuOpen((open) => !open)}
                  ref={moreButtonRef}
                  variant="message"
                />
              ) : null}
              <IconButton icon={CloseIcon} label={t.close} onClick={requestClose} variant="message" />
            </div>
          </header>
          {drawer.kind === 'create' || selected ? (
            <AutomationEditor
              actionError={error}
              automation={selected}
              busy={busy}
              key={drawer.kind === 'create' ? 'create' : drawer.id}
              onCancel={requestClose}
              onCreate={async (input) => {
                const created = await perform(() => automationStore.create(input));
                setDirty(false);
                setDrawer({ kind: 'automation', id: created.id });
                return created;
              }}
              onDirtyChange={setDirty}
              onUpdate={(input) => perform(() => automationStore.update(input))}
              providerSettings={props.providerSettings}
              runHistory={selected ? (
                <AutomationRunsView
                  automationName={selected.name}
                  onMarkRead={(run) => perform(() => automationStore.markRunRead(run)).then(() => undefined)}
                  onOpenThread={async (run) => {
                    await perform(() => openRunThread(run, props.onOpenThread));
                    closeDrawer();
                  }}
                  onPin={(run, pinned) => perform(() => automationStore.pinRun(run, pinned)).then(() => undefined)}
                  runs={runs}
                />
              ) : undefined}
              threads={props.threads}
            />
          ) : (
            <p className="automation-empty-copy">{t.loading}</p>
          )}
        </Dialog>
      ) : null}

      {menuOpen && selected ? (
        <AnchoredActionMenu
          actions={menuActions}
          anchorRef={moreButtonRef}
          ariaLabel={t.moreActions}
          className="automation-action-menu"
          onClose={() => setMenuOpen(false)}
          width={180}
        />
      ) : null}

      {discardOpen ? (
        <ConfirmDialog
          cancelLabel={t.keepEditing}
          confirmLabel={t.discard}
          danger
          message={t.discardConfirm}
          onCancel={() => setDiscardOpen(false)}
          onConfirm={closeDrawer}
          title={t.discardTitle}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          cancelLabel={t.cancel}
          confirmLabel={t.delete}
          danger
          message={t.deleteConfirm({ name: deleteTarget.name })}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void perform(async () => {
            await automationStore.delete(deleteTarget);
            closeDrawer();
          }).catch(() => undefined)}
          title={t.delete}
        />
      ) : null}
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
