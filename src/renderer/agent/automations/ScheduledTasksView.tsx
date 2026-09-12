import { ScheduledRunStop } from './ScheduledRunStop';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Automation, AutomationCreateInput, AutomationUpdateInput } from '../../../core/agent/automation';
import type { ScheduledRunResult } from '../../../core/agent/scheduledResult';
import type { DocumentIndexStore } from '../../state/documentIndexStore';
import type { AgentProviderSettingsView } from '../../api/types';
import type { ProjectCatalogView } from '../../../core/agent/project';
import type { PendingComposerContext } from '../agentReveal';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import type { ScheduledConversationTarget } from './ScheduledRunConversation';
import { useT } from '../../i18n/I18nProvider';
import { api } from '../../api/client';
import { automationStore, useAutomationStore } from './automationStore';
import { AutomationEditor } from './AutomationEditor';
import { Button } from '../../ui/primitives/Button';
import { IconButton } from '../../ui/primitives/IconButton';
import { Dialog } from '../../ui/primitives/Dialog';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { AnchoredActionMenu } from '../../ui/primitives/AnchoredActionMenu';
import { EmptyState, ErrorState } from '../../ui/primitives/FeedbackState';
import { AddIcon, BackIcon, ChevronRightIcon, CloseIcon, MoreIcon, SearchIcon, WarningIcon, ICON_SIZE } from '../../ui/icons';

export interface ScheduledTasksViewState {
  filter?: 'all' | 'attention' | 'archived';
  search?: string;
  automationId?: string;
  automationRunId?: string;
  listScrollTop?: number;
  detailScrollTop?: number;
  windowOpen?: boolean;
}
export interface ScheduledTasksViewProps {
  indexStore: DocumentIndexStore;
  projectCatalog: ProjectCatalogView;
  active: boolean;
  view: ScheduledTasksViewState;
  onViewChange: (view: ScheduledTasksViewState) => void;
  onOpenNode: ThreadNodeReferenceOpenHandler;
  onOpenProcess: (threadId: string, turnId: string) => void;
  onOpenConversation: (target: Omit<ScheduledConversationTarget, 'token'>) => Promise<void>;
  onDiscussResult: (name: string, context: PendingComposerContext) => Promise<void>;
  onBackToConversations: () => void;
}

/** One list and one task window. Run content belongs to canonical conversations. */
export function ScheduledTasksView({ active, indexStore, view, onViewChange, onOpenConversation, onOpenProcess, onBackToConversations }: ScheduledTasksViewProps) {
  const messages = useT(); const t = messages.agent.automations; const w = t.work; const e = t.editor;
  const snapshot = useAutomationStore(active);
  const [windowTask, setWindowTask] = useState<string | 'create' | null>(view.windowOpen ? view.automationId ?? null : null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState<'close' | 'edit' | null>(null);
  const [filter, setFilter] = useState(view.filter ?? 'all');
  const [search, setSearch] = useState(view.search ?? '');
  const [searchOpen, setSearchOpen] = useState(Boolean(view.search));
  const [menu, setMenu] = useState(false);
  const [taskMenu, setTaskMenu] = useState(false);
  const [runMenu, setRunMenu] = useState<ScheduledRunResult | null>(null);
  const runMenuRef = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [provider, setProvider] = useState<AgentProviderSettingsView | null>(null);
  const [refresh, setRefresh] = useState(0);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const taskMenuRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const id = windowTask === 'create' ? createdId : windowTask;
  const task = snapshot.automations.find((item) => item.id === id) ?? null;
  const taskView = id ? snapshot.taskViews.get(id) : undefined;
  const taskRuns = (taskView?.runIds ?? []).flatMap((runId) => { const result = snapshot.runResults.get(runId); return result ? [result] : []; });
  const summaries = new Map([...snapshot.taskViews].flatMap(([id, view]) => view.summary ? [[id, {
    attentionCount: view.summary.attentionCount,
    current: view.summary.currentRunId ? snapshot.runResults.get(view.summary.currentRunId) : null,
    latest: view.summary.latestRunId ? snapshot.runResults.get(view.summary.latestRunId) : null,
  }] as const] : []));
  const currentResult = id ? summaries.get(id)?.current : null;
  const current = currentResult && ['waiting', 'running', 'stopping'].includes(currentResult.state) ? currentResult : null;
  const missed = taskView?.missed ?? [];
  const nextBefore = taskView?.nextBefore;
  const runsLoading = taskView?.loading ?? false;
  const attentionCount = snapshot.automations.filter((item) => item.archivedAt === null && (summaries.get(item.id)?.attentionCount ?? 0) > 0).length;

  function remember(automationId = id ?? undefined, windowOpen = Boolean(windowTask), runId = view.automationRunId) {
    onViewChange({ automationId, windowOpen, automationRunId: runId, filter, search,
      listScrollTop: listRef.current?.scrollTop ?? view.listScrollTop,
      detailScrollTop: windowRef.current?.querySelector('.automation-editor-scroll')?.scrollTop ?? view.detailScrollTop });
  }
  useEffect(() => {
    if (view.windowOpen && view.automationId && view.automationId !== id) {
      if (editing && dirty) { remember(id ?? undefined, true); return; }
      setWindowTask(view.automationId); setCreatedId(null); setEditing(false); setSession((value) => value + 1); setDirty(false);
    }
  }, [view.windowOpen, view.automationId]);
  useLayoutEffect(() => {
    if (!active) return;
    if (listRef.current) listRef.current.scrollTop = view.listScrollTop ?? 0;
    const body = windowRef.current?.querySelector('.automation-editor-scroll');
    if (body) body.scrollTop = view.detailScrollTop ?? 0;
  }, [active]);
  useEffect(() => {
    if (!active) { setMenu(false); setTaskMenu(false); setRunMenu(null); return; }
    const lease = automationStore.acquire();
    void lease.ready.catch((reason) => setError(String(reason)));
    void api.agentGetProviderSettings().then(setProvider).catch((reason) => setError(String(reason)));
    const off = api.onAgentCoreNotification((event) => {
      if (['turn/completed', 'thread/status/changed', 'userInput/requested', 'userInput/resolved', 'toolTask/changed'].includes(event.type)) setRefresh((value) => value + 1);
    });
    return () => { off(); lease.release(); };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    void Promise.all(snapshot.automations.map((item) => automationStore.loadTaskSummary(item.id))).catch((reason) => setError(String(reason)));
  }, [active, snapshot.automations, snapshot.runs, refresh]);
  useEffect(() => {
    if (!active || !id) return;
    void automationStore.loadTaskHistory(id).catch(() => undefined);
  }, [active, id, task?.revision, snapshot.runs, refresh]);
  async function perform<T>(operation: () => Promise<T>): Promise<T> {
    if (busyRef.current) throw new Error(t.busy);
    busyRef.current = true; setBusy(true); setError(null);
    try { const result = await operation(); setRefresh((value) => value + 1); return result; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
    finally { busyRef.current = false; setBusy(false); }
  }
  const act = (operation: () => Promise<unknown>) => { void perform(operation).catch(() => undefined); };
  function openTask(taskId: string | 'create', origin: HTMLElement) {
    opener.current = origin; setWindowTask(taskId); setCreatedId(null); setEditing(taskId === 'create'); setSession((value) => value + 1); setDirty(false); setError(null);
    onViewChange({ ...view, automationId: taskId === 'create' ? undefined : taskId, windowOpen: true, automationRunId: undefined, detailScrollTop: 0 });
  }
  function closeWindow() {
    if (busyRef.current) return;
    if (editing && dirty) { setDiscard('close'); return; }
    setWindowTask(null); remember(id ?? undefined, false);
  }
  function cancelEdit() {
    if (busyRef.current) return;
    if (dirty) { setDiscard(windowTask === 'create' && !createdId ? 'close' : 'edit'); return; }
    if (!task) { setWindowTask(null); remember(undefined, false); }
    else { setEditing(false); setSession((value) => value + 1); }
  }
  async function openRun(runId: string, owner: Automation | null = task) {
    const result = await automationStore.readRunResult(runId);
    if (result.run.automationId !== owner?.id) throw new Error(e.runUnavailable);
    const { threadId } = result.run;
    const turnId = result.resultTurnId ?? result.run.turnId;
    if (!threadId || !turnId) { setError(result.issue ?? w.results[result.state]); return; }
    const part = result.parts.find((item) => item.turnId === turnId);
    remember(result.run.automationId, true, result.run.id);
    await onOpenConversation({ taskId: result.run.automationId, taskName: owner?.name ?? result.run.snapshot.automationName,
      runId: result.run.id, threadId, turnId, itemId: part?.itemId, scheduledFor: result.run.scheduledFor, timeZone: result.run.snapshot.schedule.timezone });
    await automationStore.markRunRead(result.run).catch(() => undefined);
  }
  function timing(item: Automation) { return item.archivedAt !== null ? w.archived : item.status === 'paused' ? t.filters.paused : item.nextOccurrenceAt === null ? t.noNext : t.next({ value: formatTime(item.nextOccurrenceAt, item.schedule.timezone) }); }
  const visible = snapshot.automations.filter((item) => (item.archivedAt !== null) === (filter === 'archived')
    && `${item.name} ${item.prompt}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    && (filter !== 'attention' || (summaries.get(item.id)?.attentionCount ?? 0) > 0));

  const history = <section className="scheduled-window-history" aria-label={e.runs}>
    <h3>{e.runs}</h3>
    {id && (summaries.get(id)?.attentionCount ?? 0) > 0 ? <p className="scheduled-setting-note" role="status">{w.attention} · {summaries.get(id)!.attentionCount}</p> : null}
    {(task ? missed : []).map((time) => <section className="scheduled-issue" key={`${time.contextHintId}:${time.scheduledFor}`}><p>{w.missed} {formatTime(time.scheduledFor, task!.schedule.timezone)}</p>
      {(['fulfilled', 'skipped'] as const).map((resolution) => <Button key={resolution} size="sm" disabled={busy || task?.archivedAt !== null} onClick={() => act(() => api.automationRequest('resolveMissed', { ...time, id: id!, resolution, expectedRevision: task!.revision, requestId: crypto.randomUUID() }))}>{resolution === 'fulfilled' ? w.fulfill : w.skip}</Button>)}</section>)}
    {taskRuns.map((result) => <div className="scheduled-run-entry" key={result.run.id} data-run-id={result.run.id}>
      <div className="scheduled-run-entry-main"><button className="scheduled-task-row scheduled-run-row" type="button" disabled={busy || !result.run.threadId || !result.run.turnId} onClick={() => act(() => openRun(result.run.id))}>
        <span className="scheduled-task-row-copy"><strong>{w.results[result.state]}</strong><small>{formatTime(result.run.scheduledFor, task!.schedule.timezone)}</small></span><ChevronRightIcon size={ICON_SIZE.menu} />
      </button>
      {result.run.threadId && result.run.turnId ? <IconButton icon={MoreIcon} label={w.process} disabled={busy} aria-haspopup="menu"
        onClick={(event) => { runMenuRef.current = event.currentTarget; setRunMenu((value) => value?.run.id === result.run.id ? null : result); }} /> : null}</div>
      <ScheduledRunStop runId={result.run.id} active={active} />
      {result.issues.filter((issue) => !issue.acknowledged).map((issue) => <div className="scheduled-issue" key={issue.key}><p>{issue.text}</p>{issue.terminal ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.automationRequest('acknowledge', { id: result.run.id, issueKey: issue.key, requestId: crypto.randomUUID() }))}>{w.acknowledge}</Button> : null}</div>)}
    </div>)}
    {runMenu && active ? <AnchoredActionMenu anchorRef={runMenuRef} className="thread-action-menu scheduled-editor-menu" surfaceProps={{ 'data-dialog-nested-overlay': 'true' }} ariaLabel={w.process}
      onClose={() => setRunMenu(null)} actions={[{ label: w.process, disabled: busy, onSelect: () => act(async () => { await openRun(runMenu.run.id); onOpenProcess(runMenu.run.threadId!, runMenu.resultTurnId ?? runMenu.run.turnId!); }) }]} /> : null}
    {runsLoading && !taskRuns.length ? <EmptyState size="inline" loading title={t.loading} /> : !taskRuns.length ? <EmptyState size="inline" title={e.noRuns} /> : null}
    {taskView?.error ? <ErrorState size="inline" message={taskView.error} retryLabel={w.reloadTasks} onRetry={() => act(() => automationStore.loadTaskHistory(id!))} /> : null}
    {nextBefore ? <Button size="sm" disabled={busy || runsLoading} variant="ghost" onClick={() => act(() => automationStore.loadTaskHistory(id!, nextBefore))}>{t.previousRuns}</Button> : null}
  </section>;

  return <section className="scheduled-surface" aria-label={w.workspace} onKeyDown={(event) => {
    if (!windowTask && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }
  }}>
    <header className="thread-dock-header scheduled-header"><IconButton icon={BackIcon} label={t.backToThreads} onClick={onBackToConversations} />
      <h2 className="thread-dock-title">{filter === 'archived' ? w.archivedTasks : w.workspace}</h2><div className="scheduled-header-actions">
        <IconButton icon={SearchIcon} label={t.search} onClick={() => { setSearchOpen((value) => !value); requestAnimationFrame(() => searchRef.current?.focus()); }} />
        <IconButton icon={AddIcon} label={t.new} onClick={(event) => openTask('create', event.currentTarget)} />
        <IconButton icon={MoreIcon} label={w.listActions} ref={menuRef} aria-expanded={menu} onClick={() => setMenu((value) => !value)} />
      </div></header>
    <div className="scheduled-workspace"><div className="scheduled-task-list" ref={listRef}>
      {searchOpen ? <div className="scheduled-search-row"><input ref={searchRef} className="scheduled-search" type="search" aria-label={t.search} placeholder={t.searchPlaceholder} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setSearch(''); setSearchOpen(false); } }} /><IconButton icon={CloseIcon} label={w.clearSearch} onClick={() => { setSearch(''); setSearchOpen(false); }} /></div> : null}
      {filter !== 'archived' && (attentionCount || filter === 'attention') ? <Button size="sm" variant="ghost" aria-pressed={filter === 'attention'} onClick={() => setFilter(filter === 'attention' ? 'all' : 'attention')}><WarningIcon size={ICON_SIZE.menu} />{w.attention} · {attentionCount}</Button> : null}
      <div className="scheduled-task-rows">{visible.map((item) => <button className="scheduled-task-row" key={item.id} type="button" onClick={(event) => openTask(item.id, event.currentTarget)}><span className="scheduled-task-row-copy"><strong>{item.name}</strong><small>{timing(item)}</small>{summaries.get(item.id)?.attentionCount ? <small>{w.attentionHint}</small> : summaries.get(item.id)?.current ? <small>{w.results[summaries.get(item.id)!.current!.state]}</small> : summaries.get(item.id)?.latest?.answer && summaries.get(item.id)!.latest!.run.readAt === null ? <small>{w.newResult}</small> : null}</span><ChevronRightIcon size={ICON_SIZE.menu} /></button>)}</div>
      {!snapshot.loading && !visible.length ? <EmptyState size="inline" title={search || filter === 'attention' ? t.noMatches : filter === 'archived' ? w.noArchived : t.empty} /> : null}
      {!windowTask && (error || snapshot.error) ? <ErrorState size="inline" message={error ?? snapshot.error} /> : null}
    </div></div>
    {active && menu ? <AnchoredActionMenu anchorRef={menuRef} className="thread-action-menu" ariaLabel={w.listActions} onClose={() => setMenu(false)} actions={[{ label: filter === 'archived' ? w.showAll : w.showArchived, onSelect: () => setFilter(filter === 'archived' ? 'all' : 'archived') }]} /> : null}
    {windowTask ? createPortal(<div hidden={!active} ref={windowRef}><Dialog backdropClassName="confirm-dialog-backdrop" surfaceClassName="scheduled-editor-sheet" label={!task ? t.new : editing ? w.edit : e.viewTask}
      focusKey={`${active}:${editing}`} initialFocus={() => editing ? windowRef.current?.querySelector<HTMLInputElement>('.scheduled-name-field input') ?? null : windowRef.current?.querySelector<HTMLButtonElement>('[data-task-edit]') ?? null}
      restoreFocus={() => opener.current} onEscapeKeyDown={editing ? cancelEdit : closeWindow} onBackdropMouseDown={closeWindow}>
      <header className="scheduled-task-heading"><h2>{task?.name ?? t.new}</h2><div className="scheduled-header-actions">
        {task && !editing ? <IconButton icon={MoreIcon} label={w.actions} ref={taskMenuRef} aria-haspopup="menu" aria-expanded={taskMenu} onClick={() => setTaskMenu((value) => !value)} /> : null}
        <IconButton icon={CloseIcon} label={e.closeTask} disabled={busy} onClick={closeWindow} /></div></header>
      {task && !editing && taskMenu && active ? <AnchoredActionMenu anchorRef={taskMenuRef} className="thread-action-menu scheduled-editor-menu" surfaceProps={{ 'data-dialog-nested-overlay': 'true' }} ariaLabel={w.actions} onClose={() => setTaskMenu(false)}
        actions={task.archivedAt !== null ? [{ label: w.restore, disabled: busy, onSelect: () => act(() => api.automationRequest('restore', { id: task.id, expectedRevision: task.revision, requestId: crypto.randomUUID() })) }]
          : [...(task.status !== 'completed' ? [{ label: task.status === 'paused' ? w.resume : w.pause, disabled: busy, onSelect: () => act(() => task.status === 'paused' ? automationStore.resume(task) : automationStore.pause(task)) }] : []),
            { label: w.archive, disabled: busy, onSelect: () => act(() => api.automationRequest('archive', { id: task.id, expectedRevision: task.revision, requestId: crypto.randomUUID() })) }]} /> : null}
      {task || windowTask === 'create' ? <AutomationEditor key={session} indexStore={indexStore} active={active} readOnly={!editing} onEdit={() => setEditing(true)} runHistory={history}
        automation={task} busy={busy} actionError={error} providerSettings={provider} runningRunId={current?.run.id} onDirtyChange={setDirty}
        onCancel={editing ? cancelEdit : closeWindow} onPause={task ? async (revision) => perform(async () => (await api.automationRequest('pause', { id: task.id, expectedRevision: revision, requestId: crypto.randomUUID() })).automation) : undefined}
        onCreate={async (input: AutomationCreateInput) => { const saved = await perform(() => automationStore.create(input)); setCreatedId(saved.id); return saved; }}
        onUpdate={(input: AutomationUpdateInput) => perform(() => automationStore.update(input))}
        onSaved={(saved) => { setCreatedId(saved.id); setEditing(false); setDirty(false); remember(saved.id, true); }}
        onRun={async (saved, requestId) => { const response = await perform(() => api.automationRequest('startNow', { id: saved.id, expectedRevision: saved.revision, requestId })); if (!response.runs[0]) throw new Error(e.runUnavailable); return response.runs[0].id; }}
        onShowRun={(saved, runId, preserveDraft) => { if (!preserveDraft) setEditing(false); void perform(() => openRun(runId, saved)).catch(() => undefined); }}
        />
        : <EmptyState size="inline" loading={snapshot.loading} title={w.results.unavailable} />}
    </Dialog></div>, document.body) : null}
    {discard && active ? createPortal(<ConfirmDialog title={t.discardTitle} message={t.discardConfirm} cancelLabel={t.keepEditing} confirmLabel={t.discard} onCancel={() => setDiscard(null)} onConfirm={() => {
      if (discard === 'close') { setWindowTask(null); remember(id ?? undefined, false); }
      else { setEditing(false); setSession((value) => value + 1); }
      setDirty(false); setDiscard(null);
    }} />, document.body) : null}
  </section>;
}
function formatTime(time: number, timeZone: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(time); }
