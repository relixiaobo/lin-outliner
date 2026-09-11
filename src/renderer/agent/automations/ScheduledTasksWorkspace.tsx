import { PanelStickyBreadcrumb, type PanelDragHandle } from '../../ui/PanelShared';
import type { ToolTaskProjection } from '../../../core/agent/protocol';
import { ToolTaskStrip } from '../components/ToolTaskStrip';
import { requestSendContextToThreadComposer } from '../agentReveal';
import type { DocumentIndex } from '../../state/document';
import { textOf } from '../../ui/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Automation } from '../../../core/agent/automation';
import type { ScheduledRunResult } from '../../../core/agent/scheduledResult';
import { userInputKey } from '../../../core/agent/userInput';
import { api } from '../../api/client';
import type { AgentProviderSettingsView } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../../ui/primitives/Button';
import { Dialog } from '../../ui/primitives/Dialog';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { ThreadMarkdown } from '../components/ThreadMarkdown';
import { UserInputRequest } from '../components/UserInputRequest';
import { UserInputRecovery } from '../components/UserInputRecovery';
import { threadStore, useThreadStore } from '../store/threadStore';
import { AutomationEditor } from './AutomationEditor';
import { automationStore, useAutomationStore } from './automationStore';

export interface ScheduledTasksWorkspaceProps {
  readonly index?: DocumentIndex;
  readonly onOpenNode?: import("../threadReferences").ThreadNodeReferenceOpenHandler;
  readonly panelDragHandle?: PanelDragHandle;
  readonly showClose?: boolean;
  readonly onClose?: () => void;
  readonly onOpenProcess: (threadId: string, turnId: string) => void;
  readonly onBack?: () => void;
}

export function ScheduledTasksWorkspace({ onOpenProcess, onBack, index, panelDragHandle, showClose, onClose, onOpenNode }: ScheduledTasksWorkspaceProps) {
  const messages = useT();
  const t = messages.agent.automations;
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const w = t.work;
  const snapshot = useAutomationStore();
  const threadSnapshot = useThreadStore();
  const [filter, setFilter] = useState<'all' | 'attention' | 'archived'>('all');
  const [search, setSearch] = useState('');
  const [detailVisible, setDetailVisible] = useState(Boolean(snapshot.selectedAutomationId));
  const [editor, setEditor] = useState<'create' | string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentProviderSettingsView | null>(null);
  const [results, setResults] = useState<readonly ScheduledRunResult[]>([]);
  const [missed, setMissed] = useState<readonly { contextHintId: string; scheduledFor: number }[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, { attentionCount: number; latest: ScheduledRunResult | null; current: ScheduledRunResult | null }>>(new Map());
  const [processes, setProcesses] = useState<readonly ToolTaskProjection[]>([]);
  const pageTask = useRef<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const selected = snapshot.automations.find((task) => task.id === snapshot.selectedAutomationId) ?? null;
  const edited = editor && editor !== 'create' ? snapshot.automations.find((task) => task.id === editor) ?? null : null;
  const current = selected ? summaries.get(selected.id)?.current ?? results.find((item) => ['running', 'waiting'].includes(item.state)) ?? null : null;
  const result = results.find((item) => item.run.id === selectedRunId) ?? current ?? results[0] ?? null;
  const lastDelivery = results.find((item) => Boolean(item.answer)) ?? (selected ? summaries.get(selected.id)?.latest : null);
  const questionThreadId = current?.run.threadId ?? result?.run.threadId;
  const request = questionThreadId ? threadSnapshot.userInputByThread.get(questionThreadId) : null;
  const draft = request ? threadSnapshot.userInputDrafts.get(userInputKey(request)) : null;

  useEffect(() => {
    void automationStore.initialize().catch((reason) => setError(String(reason)));
    void api.agentGetProviderSettings().then(setProvider).catch((reason) => setError(String(reason)));
    const openSubscription = api.onAutomationNotification((event) => { if (event.type === 'automation/open') setDetailVisible(true); });
    const unsubscribe = api.onAgentCoreNotification((event) => {
      if (event.type === 'turn/completed' || event.type === 'thread/status/changed'
        || event.type === 'userInput/requested' || event.type === 'userInput/resolved' || event.type === 'toolTask/changed') setRefresh((value) => value + 1);
    });
    return () => { unsubscribe(); openSubscription(); automationStore.dispose(); };
  }, []);

  useEffect(() => {
    let stale = false;
    void Promise.all(snapshot.automations.map(async (task) => [task.id, await api.automationRequest('summary', { id: task.id })] as const))
      .then((entries) => { if (!stale) setSummaries(new Map(entries)); })
      .catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [snapshot.automations, snapshot.runs, refresh, threadSnapshot.userInputByThread]);

  useEffect(() => {
    if (!selected) { setResults([]); setMissed([]); return; }
    let stale = false;
    const id = selected.id;
    void Promise.all([
      api.automationRequest('runs', { automationId: id, limit: 50 }).then(async ({ data }) => ({
        results: await Promise.all(data.map((run) => api.automationRequest('result', { id: run.id }))),
        nextBefore: data.length === 50 ? data.at(-1)!.id : null,
      })),
      api.automationRequest('timing', { id }),
    ]).then(([next, timing]) => {
      if (stale) return;
      setResults((previous) => [...next.results, ...previous.filter((item) => item.run.automationId === id && !next.results.some((entry) => entry.run.id === item.run.id))]);
      if (pageTask.current !== id) { pageTask.current = id; setNextBefore(next.nextBefore); }
      setMissed(timing.missed);
      for (const item of next.results.filter((item) => item.state === 'running')) {
        if (item.run.threadId) void threadStore.userInputs.reconcile(item.run.threadId);
      }
    }).catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [selected?.id, selected?.revision, snapshot.runs, refresh]);

  useEffect(() => {
    if (!result) { setProcesses([]); return; }
    let stale = false;
    void api.automationRequest('processes', { id: result.run.id }).then(({ data }) => { if (!stale) setProcesses(data); })
      .catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [result?.run.id, refresh]);

  useEffect(() => {
    if (detailVisible && result && result.run.readAt === null && !['waiting', 'running'].includes(result.state)) {
      void api.automationRequest('runMarkRead', { id: result.run.id }).catch((reason) => setError(String(reason)));
    }
  }, [detailVisible, result?.run.id, result?.state, result?.run.readAt]);

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
  const visible = snapshot.automations.filter((task) => {
    if ((task.archivedAt !== null) !== (filter === 'archived')) return false;
    if (!`${task.name} ${task.prompt}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) return false;
    return filter !== 'attention' || (summaries.get(task.id)?.attentionCount ?? 0) > 0;
  });

  return <main className="main-panel scheduled-panel">
    <PanelStickyBreadcrumb breadcrumbAriaLabel={messages.nodePanel.breadcrumbAriaLabel} canGoBack={!!onBack}
      closeLabel={messages.nodePanel.closePanel} currentTitle={w.workspace} dragHandle={panelDragHandle} origin={null}
      onBack={() => onBack?.()} onClose={() => onClose?.()} previousPageLabel={messages.nodePanel.previousPage}
      showClose={showClose ?? false} stickyRef={stickyRef} titleDocked={false}>
      <span className="panel-breadcrumb-segment panel-breadcrumb-current"><span className="panel-breadcrumb-current-label" data-current-page-title>{w.workspace}</span></span>
    </PanelStickyBreadcrumb>
    <section className={`scheduled-workspace${detailVisible ? ' is-detail' : ''}`}>
    <div className="scheduled-task-list">
      <header className="scheduled-task-heading"><h2>{w.workspace}</h2>
        <Button size="sm" onClick={(event) => openEditor('create', event.currentTarget)}>{t.new}</Button></header>
      <input aria-label={t.search} className="scheduled-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.searchPlaceholder} />
      <div className="scheduled-filters" aria-label={t.statusFilter}>
        {(['all', 'attention', 'archived'] as const).map((value) => <Button key={value} size="sm" variant="ghost"
          aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? t.filters.all : value === 'attention' ? `${w.attention} (${snapshot.automations.filter((task) => task.archivedAt === null && (summaries.get(task.id)?.attentionCount ?? 0) > 0).length})` : w[value]}</Button>)}
      </div>
      <div className="scheduled-task-rows">
        {visible.map((task) => <button type="button" key={task.id} className="scheduled-task-row"
          aria-pressed={task.id === selected?.id} onClick={() => { automationStore.select(task.id); setSelectedRunId(null); setDetailVisible(true); }}>
          <strong>{task.name}</strong>
          <small>{summaries.get(task.id)?.latest?.issue ?? summaries.get(task.id)?.latest?.answer?.slice(0, 100) ?? w.emptyResult}</small>
          <small>{task.status === 'paused' ? t.filters.paused : task.nextOccurrenceAt === null ? t.noNext : formatTime(task.nextOccurrenceAt, task.schedule.timezone)}</small>
        </button>)}
        {!snapshot.loading && visible.length === 0 ? <p>{t.noMatches}</p> : null}
      </div>
    </div>
    <div className="scheduled-task-detail">
      <Button className="scheduled-list-back" size="sm" variant="ghost" onClick={() => setDetailVisible(false)}>{w.back}</Button>
      {selected ? <>
        <header className="scheduled-task-heading"><div><h2>{selected.name}</h2>
          <p>{selected.nextOccurrenceAt === null ? t.noNext : formatTime(selected.nextOccurrenceAt, selected.schedule.timezone)}</p></div></header>
        <div className="scheduled-actions">
          {selected.archivedAt !== null ? <Button disabled={busy} onClick={() => act(() => api.automationRequest('restore', {
            id: selected.id, expectedRevision: selected.revision, requestId: crypto.randomUUID(),
          }))}>{w.restore}</Button> : <>
            <Button disabled={busy} onClick={() => act(() => automationStore.startNow(selected))}>{w.run}</Button>
            {selected.status !== 'completed' ? <Button disabled={busy} variant="ghost" onClick={() => act(() => switchTiming(selected))}>{selected.status === 'paused' ? w.resume : w.pause}</Button> : null}
            <Button disabled={busy} variant="ghost" onClick={(event) => openEditor(selected.id, event.currentTarget)}>{w.edit}</Button>
            <Button disabled={busy} variant="ghost" onClick={() => act(() => api.automationRequest('archive', {
              id: selected.id, expectedRevision: selected.revision, requestId: crypto.randomUUID(),
            }))}>{w.archive}</Button>
          </>}
        </div>
        <p className="scheduled-local-note">{w.local}</p>
        {selected.origin ? <Button size="sm" variant="ghost" onClick={() => onOpenProcess(selected.origin!.threadId, selected.origin!.turnId)}>{w.origin}</Button> : null}
        {missed.map((time) => <section className="scheduled-issue" key={`${time.contextHintId}:${time.scheduledFor}`}>
          <p>{w.missed} {formatTime(time.scheduledFor, selected.schedule.timezone)}</p>
          {(['fulfilled', 'skipped'] as const).map((resolution) => <Button key={resolution} disabled={busy || selected.archivedAt !== null} size="sm"
            onClick={() => act(() => api.automationRequest('resolveMissed', { ...time, resolution, id: selected.id,
              expectedRevision: selected.revision, requestId: crypto.randomUUID() }))}>{resolution === 'fulfilled' ? w.fulfill : w.skip}</Button>)}
        </section>)}
        {current && current.run.id !== result?.run.id ? <section className="scheduled-current-execution">
          <p>{w.results[current.state]}</p>
          <Button disabled={busy} size="sm" onClick={() => act(() => api.automationRequest('runStop', { id: current.run.id, requestId: crypto.randomUUID() }))}>{w.stop}</Button>
        </section> : null}
          {request && draft ? <UserInputRequest key={userInputKey(request)} request={request} draft={draft}
            onDraftChange={(update) => threadStore.userInputs.updateDraft(request, update)}
            onExpired={() => { void threadStore.userInputs.reconcile(request.threadId, true); }}
            onSubmit={(answers, intent) => threadStore.respondToUserInput(request, answers, { intent }).then(() => undefined)}
            onEditingFinished={() => undefined} /> : null}
        {result ? <article className="scheduled-result">
          <header className="scheduled-task-heading"><h3>{w.results[result.state]}</h3>
            <time>{formatTime(result.run.scheduledFor, selected.schedule.timezone)}</time></header>

          {[...threadSnapshot.userInputDrafts.values()].filter((item) => item.request.threadId === result.run.threadId && item.outcome !== 'pending')
            .map((item) => <UserInputRecovery key={userInputKey(item.request)} draft={item} />)}
          {result.issue ? <p className="scheduled-issue">{result.issue}</p> : null}
          {result.answer ? <>{result.parts.map((part) => <ThreadMarkdown key={`${part.turnId}:${part.itemId}`} text={part.text} finalCitations={part.finalCitations}
            index={index} onNodeReferenceOpen={onOpenNode} threadId={result.run.threadId ?? undefined} />)}</> : <p>{w.noAnswer}</p>}
          {result.answerTruncated ? <p>{w.clipped}</p> : null}
          {result.run.threadId && processes.length ? <ToolTaskStrip ownerThreadId={result.run.threadId} tasks={processes}
            onRead={(_threadId, taskId) => api.automationRequest('processRead', { id: result.run.id, taskId })}
            onStop={(_threadId, taskId) => perform(() => api.automationRequest('runStop', { id: result.run.id, taskId, requestId: crypto.randomUUID() })).then(() => undefined)} /> : null}
          <div className="scheduled-actions">
            <Button disabled={busy} size="sm" variant="ghost" onClick={() => act(async () => {
              await threadStore.createThread({ name: selected.name });
              requestSendContextToThreadComposer({ key: `scheduled-result:${result.run.id}`, label: `${selected.name} · ${formatTime(result.run.scheduledFor, selected.schedule.timezone)}`,
                value: JSON.stringify({ taskId: selected.id, automationRunId: result.run.id, threadId: result.run.threadId, turnId: result.resultTurnId,
                  recordPath: result.recordPath, availability: result.state === 'unavailable' ? 'unavailable' : 'available',
                  instructionScope: 'Discuss this exact result. Future assignment instructions are unchanged unless the user explicitly requests a task edit.' }) });
            })}>{w.discuss}</Button>
            {result.state === 'running' || result.state === 'waiting' ? <Button disabled={busy} size="sm" onClick={() => act(() => api.automationRequest('runStop', { id: result.run.id, requestId: crypto.randomUUID() }))}>{w.stop}</Button> : null}
            {result.run.threadId && result.run.turnId ? <Button size="sm" variant="ghost"
              onClick={() => { void api.automationRequest('runMarkRead', { id: result.run.id }); onOpenProcess(result.run.threadId!, result.resultTurnId ?? result.run.turnId!); }}>{w.process}</Button> : null}
            {result.issueKey && !result.acknowledged && result.state !== 'running' && result.state !== 'waiting' ? <Button disabled={busy} size="sm" variant="ghost"
              onClick={() => act(() => api.automationRequest('acknowledge', { id: result.run.id, issueKey: result.issueKey!, requestId: crypto.randomUUID() }))}>{w.acknowledge}</Button> : null}
          </div>
        </article> : <p>{w.emptyResult}</p>}
        {result && !result.answer && lastDelivery?.answer && lastDelivery.run.id !== result.run.id ? <section className="scheduled-previous-delivery">
          <h3>{w.latestResult}</h3>
          {lastDelivery.parts.map((part) => <ThreadMarkdown key={`${part.turnId}:${part.itemId}`} text={part.text} finalCitations={part.finalCitations}
            index={index} onNodeReferenceOpen={onOpenNode} threadId={lastDelivery.run.threadId ?? undefined} />)}
        </section> : null}
        <h3>{t.previousRuns}</h3>
        <div className="scheduled-earlier-runs">{results.map((item) => <Button key={item.run.id} size="sm" variant="ghost" aria-pressed={result?.run.id === item.run.id}
          onClick={() => { setSelectedRunId(item.run.id); void api.automationRequest('runMarkRead', { id: item.run.id }); }}>
          {formatTime(item.run.scheduledFor, selected.schedule.timezone)} · {w.results[item.state]}
        </Button>)}</div>
        {nextBefore ? <Button disabled={busy} size="sm" variant="ghost" onClick={() => act(async () => {
          const page = await api.automationRequest('runs', { automationId: selected.id, limit: 50, before: nextBefore });
          const more = await Promise.all(page.data.map((run) => api.automationRequest('result', { id: run.id })));
          setResults((previous) => [...previous, ...more.filter((item) => !previous.some((existing) => existing.run.id === item.run.id))]);
          setNextBefore(page.data.length === 50 ? page.data.at(-1)!.id : null);
        })}>{t.previousRuns}</Button> : null}
      </> : <p>{t.emptyDescription}</p>}
      {error || snapshot.error ? <p role="alert">{error ?? snapshot.error}</p> : null}
    </div>
    {editor !== null ? <Dialog backdropClassName="confirm-dialog-backdrop" surfaceClassName="scheduled-editor-sheet" label={editor === 'create' ? t.new : w.edit}
      onEscapeKeyDown={closeEditor} onBackdropMouseDown={closeEditor} restoreFocus={() => opener.current}>
      <header className="scheduled-task-heading"><h2>{editor === 'create' ? t.new : w.edit}</h2></header>
      <AutomationEditor notes={index?.projection.nodes.map((node) => ({ id: node.id, title: textOf(node) || t.name }))} onPause={edited ? (expectedRevision) => perform(async () => (await api.automationRequest('pause', { id: edited.id, expectedRevision, requestId: crypto.randomUUID() })).automation) : undefined} key={editor} automation={edited} actionError={error} busy={busy} providerSettings={provider}
        onDirtyChange={setDirty} onCancel={closeEditor}
        onCreate={async (input) => { const task = await perform(() => automationStore.create(input)); setDirty(false); setEditor(null); setDetailVisible(true); return task; }}
        onUpdate={async (input) => { const task = await perform(() => automationStore.update(input)); setDirty(false); setEditor(null); return task; }} />
    </Dialog> : null}
    {discard ? <ConfirmDialog title={t.discardTitle} message={t.discardConfirm} confirmLabel={t.discard} cancelLabel={t.keepEditing}
      onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setDirty(false); setEditor(null); }} /> : null}
  </section></main>;
}
function formatTime(time: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(time);
}
