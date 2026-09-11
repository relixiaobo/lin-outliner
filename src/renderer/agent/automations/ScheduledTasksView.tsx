import { basenameForPath } from '../../../core/referenceMarkup';
import type { ToolTaskProjection } from '../../../core/agent/protocol';
import { ToolTaskStrip } from '../components/ToolTaskStrip';
import type { PendingComposerContext } from '../agentReveal';
import { useDocumentIndexSnapshot, type DocumentIndexStore } from '../../state/documentIndexStore';
import { textOf } from '../../ui/shared';
import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Automation } from '../../../core/agent/automation';
import type { ScheduledRunResult } from '../../../core/agent/scheduledResult';
import { userInputKey } from '../../../core/agent/userInput';
import { api } from '../../api/client';
import type { AgentProviderSettingsView } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../../ui/primitives/Button';
import { IconButton } from '../../ui/primitives/IconButton';
import { AnchoredActionMenu } from '../../ui/primitives/AnchoredActionMenu';
import { EmptyState, ErrorState } from '../../ui/primitives/FeedbackState';
import { AddIcon, BackIcon, ChevronRightIcon, MoreIcon, SearchIcon, CloseIcon, WarningIcon, ICON_SIZE } from '../../ui/icons';
import { Dialog } from '../../ui/primitives/Dialog';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { ThreadMarkdown } from '../components/ThreadMarkdown';
import { UserInputRequest } from '../components/UserInputRequest';
import { UserInputRecovery } from '../components/UserInputRecovery';
import { threadStore } from '../store/threadStore';
import { AutomationEditor } from './AutomationEditor';
import { automationStore, useAutomationStore } from './automationStore';

const subscribeToInputs = (listener: () => void) => threadStore.subscribe(listener);
const readInputs = () => threadStore.userInputs.getSnapshot();
const noSubscription = () => () => undefined;

/** Session-local Agent navigation; never part of the Outline layout or task data. */
export interface ScheduledTasksViewState {
  filter?: 'all' | 'attention' | 'archived';
  search?: string;
  automationId?: string;
  automationRunId?: string;
  listScrollTop?: number;
  detailScrollTop?: number;
  detailVisible?: boolean;
}

export interface ScheduledTasksViewProps {
  readonly indexStore: DocumentIndexStore;
  readonly projectCatalog: import('../../../core/agent/project').ProjectCatalogView;
  readonly active: boolean;
  readonly view: ScheduledTasksViewState;
  readonly onViewChange: (view: ScheduledTasksViewState) => void;
  readonly onOpenNode: import('../threadReferences').ThreadNodeReferenceOpenHandler;
  readonly onOpenProcess: (threadId: string, turnId: string) => void;
  readonly onBackToConversations: () => void;
  readonly onDiscussResult: (name: string, context: PendingComposerContext) => Promise<void>;
}

export function ScheduledTasksView({ onOpenProcess, onDiscussResult, onBackToConversations, indexStore, projectCatalog, onOpenNode, view, onViewChange, active }: ScheduledTasksViewProps) {
  const index = useDocumentIndexSnapshot(indexStore, null, active);
  const messages = useT();
  const t = messages.agent.automations;
  const w = t.work;
  const snapshot = useAutomationStore(active);
  const threadSnapshot = useSyncExternalStore(active ? subscribeToInputs : noSubscription, readInputs, readInputs);
  const notes = useMemo(() => index?.projection.nodes.map((node) => ({ id: node.id, title: textOf(node) || t.name })), [index, t.name]);
  const [filter, setFilter] = useState<'all' | 'attention' | 'archived'>(view.filter ?? 'all');
  const [search, setSearch] = useState(view.search ?? '');
  const [searchOpen, setSearchOpen] = useState(Boolean(view.search));
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const [detailVisible, setDetailVisible] = useState(view.detailVisible ?? Boolean(view.automationId));
  const [editor, setEditor] = useState<'create' | string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentProviderSettingsView | null>(null);
  const [results, setResults] = useState<readonly ScheduledRunResult[]>([]);
  const [missed, setMissed] = useState<readonly { contextHintId: string; scheduledFor: number }[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(view.automationRunId ?? null);
  const [loadedTask, setLoadedTask] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, { attentionCount: number; latest: ScheduledRunResult | null; current: ScheduledRunResult | null }>>(new Map());
  const [processes, setProcesses] = useState<readonly ToolTaskProjection[]>([]);
  const pageTask = useRef<string | null>(null);
  const pageHead = useRef<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const selected = snapshot.automations.find((task) => task.id === (view.automationId ?? snapshot.selectedAutomationId)) ?? null;
  const edited = editor && editor !== 'create' ? snapshot.automations.find((task) => task.id === editor) ?? null : null;
  const taskResults = selected ? results.filter((item) => item.run.automationId === selected.id) : [];
  const current = selected ? summaries.get(selected.id)?.current ?? taskResults.find((item) => ['running', 'waiting', 'stopping'].includes(item.state)) ?? null : null;
  const result = selectedRunId ? taskResults.find((item) => item.run.id === selectedRunId) ?? null : current ?? taskResults[0] ?? null;
  const lastDelivery = taskResults.find((item) => Boolean(item.answer)) ?? (selected ? summaries.get(selected.id)?.latest : null);
  const questionThreadId = current?.run.threadId ?? result?.run.threadId;
  const request = questionThreadId ? threadSnapshot.userInputByThread.get(questionThreadId) : null;
  const draft = request ? threadSnapshot.userInputDrafts.get(userInputKey(request)) : null;

  useLayoutEffect(() => {
    if (active && !editor) backRef.current?.focus({ preventScroll: true });
    // Navigation owns focus here; closing an editor uses the dialog's opener.
  }, [active, detailVisible, view.automationId]);

  useEffect(() => { setMenuOpen(false); }, [active, detailVisible, view.automationId]);

  useEffect(() => {
    setSelectedRunId(view.automationRunId ?? null);
    setDetailVisible(view.detailVisible ?? Boolean(view.automationId));
  }, [view.automationId, view.automationRunId, view.detailVisible]);

  useLayoutEffect(() => {
    if (!active) return;
    if (listRef.current && !detailVisible) listRef.current.scrollTop = view.listScrollTop ?? 0;
    if (detailRef.current && detailVisible && loadedTask === selected?.id) detailRef.current.scrollTop = view.detailScrollTop ?? 0;
  }, [active, view.automationId, view.automationRunId, detailVisible, loadedTask]);

  function remember(automationId = selected?.id, automationRunId = selectedRunId, detail = detailVisible, preserveScroll = false): void {
    onViewChange({ filter, search, ...(automationId ? { automationId } : {}), ...(automationRunId ? { automationRunId } : {}),
      detailVisible: detail,
      listScrollTop: listRef.current?.offsetParent ? listRef.current.scrollTop : view.listScrollTop,
      detailScrollTop: !preserveScroll && (automationId !== selected?.id || automationRunId !== selectedRunId) ? 0
        : detailRef.current?.offsetParent ? detailRef.current.scrollTop : view.detailScrollTop,
    });
  }
  const openNode: import('../threadReferences').ThreadNodeReferenceOpenHandler = (nodeId, options) => {
    remember(selected?.id, result?.run.id ?? selectedRunId, detailVisible, true); onOpenNode?.(nodeId, options);
  };
  function openProcess(threadId: string, turnId: string): void { remember(selected?.id, result?.run.id ?? selectedRunId, detailVisible, true); onOpenProcess(threadId, turnId); }

  useEffect(() => {
    if (!active) return;
    const subscription = automationStore.acquire();
    void subscription.ready.catch((reason) => setError(String(reason)));
    void api.agentGetProviderSettings().then(setProvider).catch((reason) => setError(String(reason)));
    const unsubscribe = api.onAgentCoreNotification((event) => {
      if (event.type === 'turn/completed' || event.type === 'thread/status/changed'
        || event.type === 'userInput/requested' || event.type === 'userInput/resolved' || event.type === 'toolTask/changed') setRefresh((value) => value + 1);
    });
    return () => { unsubscribe(); subscription.release(); };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let stale = false;
    void Promise.all(snapshot.automations.map(async (task) => [task.id, await api.automationRequest('summary', { id: task.id })] as const))
      .then((entries) => { if (!stale) setSummaries(new Map(entries)); })
      .catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [active, snapshot.automations, snapshot.runs, refresh, threadSnapshot.userInputByThread]);

  useEffect(() => {
    if (!active) return;
    if (!selected) { setResults([]); setMissed([]); return; }
    let stale = false;
    const id = selected.id;
    void Promise.all([
      api.automationRequest('runs', { automationId: id, limit: 50 }).then(async ({ data }) => {
        const references = data.map((run) => run.id);
        if (view.automationRunId && !references.includes(view.automationRunId)) references.push(view.automationRunId);
        const results = await Promise.all(references.map((id) => api.automationRequest('result', { id })));
        if (results.some((item) => item.run.automationId !== id)) throw new Error('The selected run does not belong to this task');
        return { results, head: data[0]?.id ?? null, nextBefore: data.length === 50 ? data.at(-1)!.id : null };
      }),
      api.automationRequest('timing', { id }),
    ]).then(([next, timing]) => {
      if (stale) return;
      setResults((previous) => [...next.results, ...previous.filter((item) => item.run.automationId === id && !next.results.some((entry) => entry.run.id === item.run.id))]
        .sort((left, right) => right.run.createdSequence - left.run.createdSequence));
      if (pageTask.current !== id || pageHead.current !== next.head) {
        pageTask.current = id; pageHead.current = next.head; setNextBefore(next.nextBefore);
      }
      setMissed(timing.missed);
      setLoadedTask(id);
      for (const item of next.results.filter((item) => item.state === 'running')) {
        if (item.run.threadId) void threadStore.userInputs.reconcile(item.run.threadId);
      }
    }).catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [active, selected?.id, selected?.revision, view.automationRunId, snapshot.runs, refresh]);

  useEffect(() => {
    if (!active) return;
    if (!result) { setProcesses([]); return; }
    let stale = false;
    void api.automationRequest('processes', { id: result.run.id }).then(({ data }) => { if (!stale) setProcesses(data); })
      .catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [active, result?.run.id, refresh]);

  useEffect(() => {
    if (active && detailVisible && result && result.run.readAt === null && !['waiting', 'running', 'stopping'].includes(result.state)) {
      void api.automationRequest('runMarkRead', { id: result.run.id }).catch((reason) => setError(String(reason)));
    }
  }, [active, detailVisible, result?.run.id, result?.state, result?.run.readAt]);

  const perform = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (busyRef.current) throw new Error(t.busy);
    busyRef.current = true; setBusy(true); setError(null);
    try { const value = await operation(); setRefresh((count) => count + 1); return value; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
    finally { busyRef.current = false; setBusy(false); }
  }, [t.busy]);
  const act = (operation: () => Promise<unknown>) => { void perform(operation).catch(() => undefined); };
  const closeEditor = () => { if (busyRef.current) return; if (dirty) setDiscard(true); else setEditor(null); };
  const openEditor = (id: string, origin: HTMLElement) => { opener.current = origin; setDirty(false); setEditor(id); };
  const switchTiming = (task: Automation) => task.status === 'paused' ? automationStore.resume(task) : automationStore.pause(task);
  const attentionCount = snapshot.automations.filter((task) => task.archivedAt === null && (summaries.get(task.id)?.attentionCount ?? 0) > 0).length;
  const otherIssues = taskResults.filter((item) => item.run.id !== result?.run.id && item.issues.some((issue) => !issue.acknowledged));
  const unloadedIssues = Math.max(0, (selected ? summaries.get(selected.id)?.attentionCount ?? 0 : 0)
    - missed.length - (request ? 1 : 0) - taskResults.reduce((count, item) => count + item.issues.filter((issue) => !issue.acknowledged).length, 0));
  const liveHint = (state: ScheduledRunResult['state']) => state === 'running' ? w.runningHint
    : state === 'waiting' ? w.waitingHint : state === 'stopping' ? w.stoppingHint : w.noAnswer;
  const source = selected?.contextHints[0]?.source;
  const location = source?.kind === 'directory' ? source.rootHint : source?.kind === 'project'
    ? projectCatalog.projects.find((project) => project.id === source.projectId)?.name ?? messages.agent.projects.unavailable
    : projectCatalog.applicationDefault.path ?? t.inherited;
  const timing = (task: Automation) => task.archivedAt !== null ? w.archived
    : task.status === 'paused' ? t.filters.paused
    : task.nextOccurrenceAt === null ? t.noNext : t.next({ value: formatTime(task.nextOccurrenceAt, task.schedule.timezone) });
  function back(): void {
    setMenuOpen(false);
    if (detailVisible) { remember(selected?.id, selectedRunId, false); setDetailVisible(false); }
    else onBackToConversations();
  }
  function chooseRun(item: ScheduledRunResult): void {
    setSelectedRunId(item.run.id); remember(selected?.id, item.run.id, true);
  }
  async function loadOlderRuns(): Promise<void> {
    if (!selected || !nextBefore) return;
    const ownerId = selected.id;
    const page = await api.automationRequest('runs', { automationId: ownerId, limit: 50, before: nextBefore });
    const more = await Promise.all(page.data.map((run) => api.automationRequest('result', { id: run.id })));
    if (pageTask.current !== ownerId) return;
    setResults((previous) => [...previous, ...more.filter((item) => !previous.some((existing) => existing.run.id === item.run.id))]
      .sort((left, right) => right.run.createdSequence - left.run.createdSequence));
    setNextBefore(page.data.length === 50 ? page.data.at(-1)!.id : null);
  }
  const visible = snapshot.automations.filter((task) => {
    if ((task.archivedAt !== null) !== (filter === 'archived')) return false;
    if (!`${task.name} ${task.prompt}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) return false;
    return filter !== 'attention' || (summaries.get(task.id)?.attentionCount ?? 0) > 0;
  });

  return <section className="scheduled-surface" aria-label={w.workspace} onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !detailVisible && !editor) {
      event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus());
    }
  }}>
    <header className="thread-dock-header scheduled-header">
      <IconButton icon={BackIcon} ref={backRef} label={detailVisible ? w.back : t.backToThreads} onClick={back} />
      <h2 className="thread-dock-title">{detailVisible ? selected?.name ?? t.name : filter === 'archived' ? w.archivedTasks : w.workspace}</h2>
      <div className="scheduled-header-actions">
        {!detailVisible ? <>
          <IconButton icon={SearchIcon} label={t.search} ref={searchButtonRef} aria-expanded={searchOpen}
            onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setSearch(''); if (!searchOpen) requestAnimationFrame(() => searchRef.current?.focus()); }} />
          <IconButton icon={AddIcon} label={t.new} onClick={(event) => openEditor('create', event.currentTarget)} />
        </> : null}
        <IconButton icon={MoreIcon} label={detailVisible ? w.actions : w.listActions} ref={menuRef}
          aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((value) => !value)} />
      </div>
    </header>
    {active && menuOpen ? <AnchoredActionMenu anchorRef={menuRef} onClose={() => setMenuOpen(false)}
      ariaLabel={detailVisible ? w.actions : w.listActions} className="thread-action-menu"
      actions={detailVisible && selected ? selected.archivedAt !== null ? [
        { label: w.restore, disabled: busy, onSelect: () => act(() => api.automationRequest('restore', { id: selected.id, expectedRevision: selected.revision, requestId: crypto.randomUUID() })) },
      ] : [
        { label: w.edit, disabled: busy, onSelect: () => openEditor(selected.id, menuRef.current!) },
        ...(selected.status === 'completed' ? [] : [{ label: selected.status === 'paused' ? w.resume : w.pause, disabled: busy, onSelect: () => act(() => switchTiming(selected)) }]),
        { label: w.archive, disabled: busy, onSelect: () => act(() => api.automationRequest('archive', { id: selected.id, expectedRevision: selected.revision, requestId: crypto.randomUUID() })) },
      ] : [{ label: filter === 'archived' ? w.showAll : w.showArchived, onSelect: () => { setFilter(filter === 'archived' ? 'all' : 'archived'); setSearch(''); setSearchOpen(false); } }]} /> : null}
    <div className={`scheduled-workspace${detailVisible ? ' is-detail' : ''}`}>
    {error || snapshot.error ? <ErrorState size="inline" className="scheduled-error" message={error ?? snapshot.error}
      retryLabel={w.reloadTasks} onRetry={() => act(() => automationStore.reload())} /> : null}
    <div className="scheduled-task-list" hidden={detailVisible} ref={listRef} onScroll={() => { if (active) remember(selected?.id, selectedRunId, detailVisible, true); }}>
      {searchOpen ? <div className="scheduled-search-row">
        <input ref={searchRef} aria-label={t.search} className="scheduled-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.searchPlaceholder}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setSearch(''); setSearchOpen(false); searchButtonRef.current?.focus(); } }} />
        <IconButton icon={CloseIcon} label={w.clearSearch} onClick={() => { setSearch(''); setSearchOpen(false); searchButtonRef.current?.focus(); }} />
      </div> : null}
      {filter !== 'archived' && (attentionCount > 0 || filter === 'attention') ? <Button className="scheduled-attention-filter" size="sm" variant="ghost"
        aria-pressed={filter === 'attention'} onClick={() => setFilter(filter === 'attention' ? 'all' : 'attention')}>
        <WarningIcon size={ICON_SIZE.menu} /> {w.attention} · {attentionCount}
      </Button> : null}
      <div className="scheduled-task-rows">
        {visible.map((task) => {
          const summary = summaries.get(task.id);
          return <button type="button" key={task.id} className="scheduled-task-row"
            onClick={() => { const selectedRun = task.id === selected?.id ? selectedRunId : null; automationStore.select(task.id); setSelectedRunId(selectedRun); setDetailVisible(true); remember(task.id, selectedRun, true); }}>
            <span className="scheduled-task-row-copy"><strong>{task.name}</strong>
              <small title={task.schedule.timezone}>{timing(task)}</small>
              {(summary?.attentionCount ?? 0) > 0 ? <small className="scheduled-row-attention"><WarningIcon size={ICON_SIZE.tiny} />{w.attentionHint}</small>
                : summary?.current ? <small>{w.results[summary.current.state]}</small>
                  : summary?.latest?.answer && summary.latest.run.readAt === null ? <small>{w.newResult}</small> : null}
            </span>
            <ChevronRightIcon size={ICON_SIZE.menu} className="scheduled-row-chevron" />
          </button>;
        })}
        {snapshot.loading ? <EmptyState size="inline" loading title={t.loading} /> : visible.length === 0 && !snapshot.error ?
          <EmptyState size="inline" title={search || filter === 'attention' ? t.noMatches : filter === 'archived' ? w.noArchived : t.empty}
            body={search || filter === 'attention' ? t.noMatchesDescription : filter === 'archived' ? undefined : t.emptyDescription} /> : null}
      </div>
    </div>
    <div className="scheduled-task-detail" hidden={!detailVisible} ref={detailRef} onScroll={() => { if (active) remember(selected?.id, selectedRunId, detailVisible, true); }}>
      {selected ? <>
        <div className="scheduled-plan-row">
          {selected.archivedAt === null ? <button className="scheduled-plan-link" type="button" title={selected.schedule.timezone} aria-label={w.edit}
            onClick={(event) => openEditor(selected.id, event.currentTarget)}>{timing(selected)}</button> : <span className="scheduled-plan-link">{w.archived}</span>}
          {selected.archivedAt !== null ? <Button disabled={busy} size="sm" onClick={() => act(() => api.automationRequest('restore', {
            id: selected.id, expectedRevision: selected.revision, requestId: crypto.randomUUID(),
          }))}>{w.restore}</Button> : current ? <Button size="sm" disabled={busy || current.state === 'stopping'}
            onClick={() => act(() => api.automationRequest('runStop', { id: current.run.id, requestId: crypto.randomUUID() }))}>{current.state === 'stopping' ? w.results.stopping : w.stop}</Button>
            : <Button size="sm" disabled={busy} onClick={() => act(() => automationStore.startNow(selected))}>{w.run}</Button>}
        </div>
        {missed.map((time) => <section className="scheduled-issue" key={`${time.contextHintId}:${time.scheduledFor}`}>
          <p>{w.missed} {formatTime(time.scheduledFor, selected.schedule.timezone)}</p>
          <div className="scheduled-actions">{(['fulfilled', 'skipped'] as const).map((resolution) => <Button key={resolution} disabled={busy || selected.archivedAt !== null} size="sm"
            onClick={() => act(() => api.automationRequest('resolveMissed', { ...time, resolution, id: selected.id,
              expectedRevision: selected.revision, requestId: crypto.randomUUID() }))}>{resolution === 'fulfilled' ? w.fulfill : w.skip}</Button>)}</div>
        </section>)}
        {current && current.run.id !== result?.run.id ? <section className="scheduled-current-execution">
          <p>{w.results[current.state]}</p><Button size="sm" variant="ghost" onClick={() => chooseRun(current)}>{w.latestResult}</Button>
        </section> : null}
        {request && draft ? <UserInputRequest key={userInputKey(request)} request={request} draft={draft}
          onDraftChange={(update) => threadStore.userInputs.updateDraft(request, update)}
          onExpired={() => { void threadStore.userInputs.reconcile(request.threadId, true); }}
          onSubmit={(answers, intent) => threadStore.respondToUserInput(request, answers, { intent }).then(() => undefined)} onEditingFinished={() => undefined} /> : null}
        {otherIssues.length || unloadedIssues ? <details className="scheduled-disclosure scheduled-attention-history">
          <summary><WarningIcon size={ICON_SIZE.menu} />{w.attentionHistory}</summary>
          {otherIssues.map((item) => <Button key={item.run.id} size="sm" variant="ghost" onClick={() => chooseRun(item)}>
            {formatTime(item.run.scheduledFor, selected.schedule.timezone)} · {w.results[item.state]}
          </Button>)}
          {unloadedIssues ? nextBefore ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(loadOlderRuns)}>{t.previousRuns}</Button>
            : <p className="scheduled-empty-copy">{w.unavailableHint}</p> : null}
        </details> : null}
        {result ? <article className="scheduled-result" data-run-id={result.run.id}>
          <header className="scheduled-result-heading"><h3>{w.results[result.state]}</h3>
            <time title={selected.schedule.timezone}>{formatTime(result.run.scheduledFor, selected.schedule.timezone)}</time></header>
          {[...threadSnapshot.userInputDrafts.values()].filter((item) => item.request.threadId === result.run.threadId && item.outcome !== 'pending')
            .map((item) => <UserInputRecovery key={userInputKey(item.request)} draft={item} />)}
          {result.issues.map((issue) => <section className="scheduled-issue" key={issue.key}>
            <p>{issue.text}</p>
            {issue.terminal && !issue.acknowledged ? <Button disabled={busy} size="sm" variant="ghost" onClick={() => act(() => api.automationRequest('acknowledge', {
              id: result.run.id, issueKey: issue.key, requestId: crypto.randomUUID(),
            }))}>{w.acknowledge}</Button> : null}
          </section>)}
          {result.answer ? <div className="scheduled-prose">{result.parts.map((part) => <ThreadMarkdown key={`${part.turnId}:${part.itemId}`} text={part.text} finalCitations={part.finalCitations}
            index={index} onNodeReferenceOpen={openNode} threadId={result.run.threadId ?? undefined} />)}</div>
            : !result.issues.length ? <p className="scheduled-empty-copy">{liveHint(result.state)}</p> : null}
          {result.answerTruncated ? <p>{w.clipped}</p> : null}
          {result.run.threadId && processes.length ? <ToolTaskStrip ownerThreadId={result.run.threadId} tasks={processes}
            onRead={(_threadId, taskId) => api.automationRequest('processRead', { id: result.run.id, taskId })}
            onStop={(_threadId, taskId) => perform(() => api.automationRequest('runStop', { id: result.run.id, taskId, requestId: crypto.randomUUID() })).then(() => undefined)} /> : null}
          <div className="scheduled-actions scheduled-result-actions">
            <Button disabled={busy} size="sm" variant="ghost" onClick={() => act(async () => {
              await onDiscussResult(selected.name, { key: `scheduled-result:${result.run.id}`, label: `${selected.name} · ${formatTime(result.run.scheduledFor, selected.schedule.timezone)}`,
                value: JSON.stringify({ taskId: selected.id, automationRunId: result.run.id, threadId: result.run.threadId, turnId: result.resultTurnId,
                  recordPath: result.recordPath, availability: result.state === 'unavailable' ? 'unavailable' : 'available',
                  instructionScope: 'Discuss this exact result. Future assignment instructions are unchanged unless the user explicitly requests a task edit.' }) });
            })}>{w.discuss}</Button>
            {result.run.threadId && result.run.turnId ? <Button size="sm" variant="ghost"
              onClick={() => openProcess(result.run.threadId!, result.resultTurnId ?? result.run.turnId!)}>{w.process}</Button> : null}
          </div>
        </article> : <EmptyState size="inline" loading={!error && loadedTask !== selected.id}
          title={!error && loadedTask !== selected.id ? t.loading : selectedRunId ? w.results.unavailable : w.emptyResult}
          body={!error && loadedTask !== selected.id ? undefined : selectedRunId ? w.unavailableHint : selected.status === 'paused' ? w.pausedHint : w.awaitingRun} />}
        {result && !result.answer && lastDelivery?.answer && lastDelivery.run.id !== result.run.id ? <section className="scheduled-previous-delivery">
          <h3>{w.latestResult}</h3>
          <div className="scheduled-prose">{lastDelivery.parts.map((part) => <ThreadMarkdown key={`${part.turnId}:${part.itemId}`} text={part.text} finalCitations={part.finalCitations}
            index={index} onNodeReferenceOpen={openNode} threadId={lastDelivery.run.threadId ?? undefined} />)}</div>
        </section> : null}
        {taskResults.length > 1 || nextBefore ? <details className="scheduled-disclosure scheduled-history">
          <summary>{w.history}</summary>
          <div className="scheduled-earlier-runs">{taskResults.map((item) => <Button key={item.run.id} size="sm" variant="ghost" aria-pressed={result?.run.id === item.run.id}
            onClick={() => chooseRun(item)}>{formatTime(item.run.scheduledFor, selected.schedule.timezone)} · {w.results[item.state]}</Button>)}</div>
          {nextBefore ? <Button disabled={busy} size="sm" variant="ghost" onClick={() => act(loadOlderRuns)}>{t.previousRuns}</Button> : null}
        </details> : null}
        <details className="scheduled-disclosure scheduled-task-info">
          <summary>{w.taskInfo}</summary>
          <div className="scheduled-task-info-content">
            <div className="scheduled-prose"><ThreadMarkdown text={selected.prompt} index={index} onNodeReferenceOpen={openNode} /></div>
            <dl><dt>{t.timezone}</dt><dd>{selected.schedule.timezone}</dd>
              <dt>{w.location}</dt><dd>{location}</dd>
              {selected.materials.length ? <><dt>{w.materials}</dt><dd>{selected.materials.map((material) => <p key={`${material.kind}:${material.reference}`} title={material.reference}>{material.kind === 'note'
                ? notes?.some((note) => note.id === material.reference) ? <button type="button" className="scheduled-material-reference" onClick={() => openNode(material.reference)}>{notes.find((note) => note.id === material.reference)!.title}</button> : messages.agent.projects.unavailable
                : material.kind === 'file' ? basenameForPath(material.reference) : <a href={material.reference} target="_blank" rel="noreferrer">{material.reference}</a>}</p>)}</dd></> : null}
            </dl>
            <p className="scheduled-local-note">{w.local}</p>
            {selected.origin ? <Button size="sm" variant="ghost" onClick={() => openProcess(selected.origin!.threadId, selected.origin!.turnId)}>{w.origin}</Button> : null}
          </div>
        </details>
      </> : <EmptyState size="inline" loading={snapshot.loading} title={snapshot.loading ? t.loading : w.results.unavailable} />}
    </div>
    {editor !== null ? <Dialog backdropClassName="confirm-dialog-backdrop" surfaceClassName="scheduled-editor-sheet" label={editor === 'create' ? t.new : w.edit} focusKey={Number(active)}
      onEscapeKeyDown={closeEditor} onBackdropMouseDown={closeEditor} restoreFocus={() => opener.current}>
      <header className="scheduled-task-heading"><h2>{editor === 'create' ? t.new : w.edit}</h2></header>
      <AutomationEditor notes={notes} onPause={edited ? (expectedRevision) => perform(async () => (await api.automationRequest('pause', { id: edited.id, expectedRevision, requestId: crypto.randomUUID() })).automation) : undefined} key={editor} automation={edited} actionError={error} busy={busy} providerSettings={provider}
        onDirtyChange={setDirty} onCancel={closeEditor}
        onCreate={async (input) => { const task = await perform(() => automationStore.create(input)); setDirty(false); setEditor(null); setDetailVisible(true); remember(task.id, null, true); return task; }}
        onUpdate={async (input) => { const task = await perform(() => automationStore.update(input)); setDirty(false); setEditor(null); return task; }} />
    </Dialog> : null}
    {discard ? <ConfirmDialog title={t.discardTitle} message={t.discardConfirm} confirmLabel={t.discard} cancelLabel={t.keepEditing}
      onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setDirty(false); setEditor(null); }} /> : null}
    </div>
  </section>;
}
function formatTime(time: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(time);
}
