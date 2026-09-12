import { ThreadMarkdown } from '../components/ThreadMarkdown';
import { CheckboxControl } from '../../ui/primitives/CheckboxControl';
import type { ScheduledMaterial } from '../../../core/agent/scheduledMaterial';
import { api } from '../../api/client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  Automation,
  AutomationCreateInput,
  AutomationContextHintInput,
  AutomationUpdateInput,
} from '../../../core/agent/automation';
import { composeProviderQualifiedModel, parseProviderQualifiedModel } from '../../../core/agentModelId';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../../core/agent/configuration';
import type { AgentProviderSettingsView } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { formatProviderName } from '../../ui/agent/providerNames';
import { buildModelChoices, flattenModelChoices, type ModelChoiceGroup } from '../../ui/agent/modelChoices';
import { Button } from '../../ui/primitives/Button';
import { Field } from '../../ui/primitives/Field';
import { IconButton } from '../../ui/primitives/IconButton';
import { Input } from '../../ui/primitives/Input';
import { SelectControl } from '../../ui/primitives/SelectControl';
import { ScheduledBriefInput } from './ScheduledBriefInput';
import type { DocumentIndexStore } from '../../state/documentIndexStore';
import { scheduledBriefMaterials, scheduledInlineMaterials, scheduledMaterialKey } from '../../../core/agent/scheduledBrief';
import { splitReferenceMarkers, basenameForPath } from '../../../core/referenceMarkup';
import { textOf } from '../../ui/shared';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { MoreIcon } from '../../ui/icons';
import { AnchoredActionMenu } from '../../ui/primitives/AnchoredActionMenu';
import { AutomationScheduleEditor } from './AutomationScheduleEditor';
import { useProjectCatalog } from '../projects/useProjectCatalog';
import {
  automationScheduleRrule,
  canEditAutomationSchedule,
  createAutomationScheduleDraft,
  isAutomationScheduleDraftValid,
  type AutomationScheduleDraft,
} from './AutomationScheduleDraft';

type ContextHintDraft = {
  readonly projectId?: string;
  readonly id: string;
  readonly contextHintId?: string;
  readonly cwd: string;
  readonly executionMode: AutomationContextHintInput['executionMode'];
};

interface AutomationEditorProps {
  readonly indexStore: DocumentIndexStore;
  readonly active: boolean;
  readonly readOnly?: boolean;
  readonly onEdit?: () => void;
  readonly runHistory?: ReactNode;
  readonly runningRunId?: string;
  readonly onSaved: (task: Automation) => void;
  readonly onRun: (task: Automation, requestId: string) => Promise<string>;
  readonly onShowRun: (task: Automation, runId: string, preserveDraft?: boolean) => void;
  readonly actionError: string | null;
  readonly onPause?: (expectedRevision: number) => Promise<Automation>;
  readonly automation: Automation | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onCreate: (input: AutomationCreateInput) => Promise<Automation>;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onUpdate: (input: AutomationUpdateInput) => Promise<Automation>;
  readonly providerSettings: AgentProviderSettingsView | null;
}

export function AutomationEditor(props: AutomationEditorProps) {
  const messages = useT();
  const t = messages.agent.automations;
  const e = t.editor;
  const projectLabels = messages.agent.projects;
  const projects = useProjectCatalog();
  const [state, setState] = useState(() => editorState(props.automation));
  const [baseline, setBaseline] = useState(state);
  const [revision, setRevision] = useState(props.automation?.revision ?? null);
  const [error, setError] = useState<string | null>(null);
  const [taskError, setTaskError] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const runRequest = useRef<{ taskId: string; revision: number; requestId: string } | null>(null);
  const [savedRunError, setSavedRunError] = useState(false);
  const disabled = props.busy || working;
  const [briefValid, setBriefValid] = useState(true);
  const [briefPending, setBriefPending] = useState(false);
  const [preview, setPreview] = useState<{ key: string; nextOccurrenceAt: number | null; defaultWorkLocation: string } | null>(null);
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [replaceSchedule, setReplaceSchedule] = useState(false);
  const [referenceOptionsOpen, setReferenceOptionsOpen] = useState(false);
  const [review, setReview] = useState<Automation | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const alive = useRef(true);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [picking, setPicking] = useState(false);
  const operationRef = useRef({ signature: '', requestId: crypto.randomUUID() });
  // Retain source policies through deletion/undo, but never submit an orphaned
  // inline policy as newly attached context.
  const inlineKeys = useRef(new Set(scheduledInlineMaterials(state.prompt).map(scheduledMaterialKey)));
  const attachedKeys = useRef(new Set(state.materials.filter((item) => !inlineKeys.current.has(scheduledMaterialKey(item))).map(scheduledMaterialKey)));
  const effectiveExplicit = (value: EditorState) => {
    const present = new Set(scheduledInlineMaterials(value.prompt).map(scheduledMaterialKey));
    return value.materials.filter((item) => !inlineKeys.current.has(scheduledMaterialKey(item)) || attachedKeys.current.has(scheduledMaterialKey(item)) || present.has(scheduledMaterialKey(item)));
  };
  const dirty = stateSignature({ ...state, materials: effectiveExplicit(state) }) !== stateSignature(baseline);
  const conflict = Boolean(props.automation && dirty && revision !== props.automation.revision);
  const choices = useMemo(() => buildModelChoices(props.providerSettings, { modelProvider: state.modelProvider, model: state.model }), [props.providerSettings, state.model, state.modelProvider]);
  const modelChoices = useMemo(() => flattenModelChoices(choices), [choices]);
  const showProviderLabel = choices.showProviderLabel;
  const reasoningChoices = choices.resolvedOption ? REASONING_EFFORTS.filter((effort) => choices.resolvedOption!.supportedThinkingLevels.includes(effort)) : [];
  const showReasoning = Boolean(state.reasoningEffort) || Boolean(choices.resolvedOption?.reasoning);

  const selectedModel = useMemo(() => automationModelValue(state.modelProvider, state.model, choices.groups), [choices.groups, state.model, state.modelProvider]);
  const knownModelValues = useMemo(() => new Set(modelChoices.map((choice) => choice.value)), [modelChoices]);
  const timezones = useMemo(() => automationTimezones(state.timezone), [state.timezone]);
  const binding = state.contextHints[0];
  const folderLabel = binding?.projectId ? projects.view.projects.find((item) => item.id === binding.projectId)?.name ?? projectLabels.unavailable : binding?.cwd ? basenameForPath(binding.cwd) : e.defaultFolder;
  const optionsSummary = [binding?.executionMode === 'worktree' ? e.copy : null, state.model || (state.modelProvider ? formatProviderName(state.modelProvider) : null), state.reasoningEffort ? `${e.reasoning}: ${messages.agent.composer.reasoningLevels[state.reasoningEffort]}` : null].filter(Boolean).join(' · ') || e.defaults;
  const preservedSchedule = !canEditAutomationSchedule(state.schedule);
  const scheduleKey = JSON.stringify([state.schedule, state.timezone]);
  const previewPending = preview?.key !== scheduleKey && previewError?.key !== scheduleKey;
  const noFuture = preview?.key === scheduleKey && preview.nextOccurrenceAt === null;
  let timingChanged = true;
  try { timingChanged = !props.automation || automationScheduleRrule(state.schedule) !== props.automation.schedule.rrule || state.timezone !== props.automation.schedule.timezone; } catch { /* The preview owns invalid-time feedback. */ }
  let materials: readonly ScheduledMaterial[] = [];
  let materialError = '';
  try { materials = scheduledBriefMaterials(state.prompt, effectiveExplicit(state)); } catch { materialError = e.sourceLimit; }

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!props.active) setMenuOpen(false); }, [props.active]);
  useEffect(() => { props.onDirtyChange(dirty); }, [dirty, props.onDirtyChange]);
  useEffect(() => {
    if (!props.automation || dirty) return;
    const incoming = editorState(props.automation);
    if (stateSignature(incoming) !== stateSignature(baseline)) { setState(incoming); setBaseline(incoming); }
    setRevision(props.automation.revision);
  }, [props.automation, dirty, baseline]);
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      try {
        void api.automationRequest('preview', { rrule: automationScheduleRrule(state.schedule), timezone: state.timezone })
          .then((value) => { if (!stale) { setPreview({ key: scheduleKey, nextOccurrenceAt: value.nextOccurrenceAt, defaultWorkLocation: value.defaultWorkLocation }); setPreviewError(null); } })
          .catch((reason) => { if (!stale) setPreviewError({ key: scheduleKey, message: errorMessage(reason) }); });
      } catch (reason) { if (!stale) setPreviewError({ key: scheduleKey, message: errorMessage(reason) }); }
    }, 150);
    return () => { stale = true; clearTimeout(timer); };
  }, [scheduleKey]);

  function sourceLabel(item: ScheduledMaterial): string {
    return item.kind === 'note' ? textOf(props.indexStore.getCurrent().byId.get(item.reference)) || e.unavailableReference
      : item.kind === 'file' ? basenameForPath(item.reference) : item.reference;
  }
  function briefChanged(prompt: string) {
    for (const item of scheduledInlineMaterials(prompt)) inlineKeys.current.add(scheduledMaterialKey(item));
    setTaskError(false);
    setState((previous) => ({ ...previous, prompt }));
  }
  async function chooseFolder() {
    if (picking || disabled) return;
    setPicking(true);
    try {
      const { paths } = await api.agentCoreRequest('project/pickFolders', {});
      if (!alive.current || !paths[0]) return;
      setState((value) => ({ ...value, contextHints: [{ id: value.contextHints[0]?.id ?? crypto.randomUUID(), contextHintId: value.contextHints[0]?.contextHintId,
        cwd: paths[0]!, executionMode: value.contextHints[0]?.executionMode ?? 'local' }] }));
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setPicking(false); }
  }
  async function submit(intent: 'save' | 'run') {
    if (workingRef.current || props.busy) return;
    if (intent === 'run' && props.runningRunId && props.automation) {
      runRequest.current = null; setSavedRunError(false); setError(null);
      props.onShowRun(props.automation, props.runningRunId, true); return;
    }
    setError(null); setSavedRunError(false);
    if (!state.name.trim()) { setNameError(true); nameRef.current?.focus(); return; }
    const instructions = splitReferenceMarkers(state.prompt).filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
    if (!instructions) { setTaskError(true); formRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus(); return; }
    const needsSave = !props.automation || dirty;
    if (!briefValid || briefPending || picking || materialError || conflict || (needsSave && (previewPending || previewError?.key === scheduleKey || (timingChanged && noFuture)))) return;
    workingRef.current = true; setWorking(true);
    let saved: Automation | null = null;
    try {
      if (needsSave) {
        if (!isAutomationScheduleDraftValid(state.schedule)) throw new Error(e.previewInvalid);
        const definition: AutomationCreateInput = {
          name: state.name.trim(), prompt: state.prompt,
          materials: effectiveExplicit(state), schedule: { rrule: automationScheduleRrule(state.schedule), timezone: state.timezone },
          destination: { kind: 'standalone' }, contextHints: state.contextHints.map((hint) => toAutomationContextHintInput(hint, hint.projectId ? '' : required(hint.cwd, e.folderMissing))),
          configuration: { modelProvider: nullable(state.modelProvider), model: nullable(state.model), reasoningEffort: state.reasoningEffort || null },
        };
        const signature = JSON.stringify([definition, revision]);
        if (operationRef.current.signature !== signature) operationRef.current = { signature, requestId: crypto.randomUUID() };
        saved = props.automation ? await props.onUpdate({ ...definition, id: props.automation.id, expectedRevision: revision!, requestId: operationRef.current.requestId })
          : await props.onCreate({ ...definition, requestId: operationRef.current.requestId });
        const accepted = editorState(saved);
        setState(accepted); setRevision(saved.revision); setBaseline(accepted); props.onDirtyChange(false);
      } else saved = props.automation!;
      if (intent === 'save') { props.onSaved(saved); return; }
      if (!runRequest.current || runRequest.current.taskId !== saved.id || runRequest.current.revision !== saved.revision) {
        runRequest.current = { taskId: saved.id, revision: saved.revision, requestId: crypto.randomUUID() };
      }
      const runId = await props.onRun(saved, runRequest.current.requestId);
      // A confirmed run completes this operation. A later explicit Run once is
      // a new invocation; only an uncertain reply reuses the old request.
      runRequest.current = null;
      props.onShowRun(saved, runId);
    } catch (reason) {
      if (saved && intent === 'run') setSavedRunError(true);
      const message = errorMessage(reason);
      const source = message.startsWith('Material unavailable') ? materials.find((item) => message.includes(item.reference)) : undefined;
      if (source) { setReferenceOptionsOpen(true); setError(`${sourceLabel(source)}: ${e.unavailableReference}`); }
      else setError(message);
    } finally { workingRef.current = false; if (alive.current) setWorking(false); }
  }
  function describe(value: EditorState): Record<string, string> {
    const source = value.contextHints[0];
    const project = projects.view.projects.find((item) => item.id === source?.projectId);
    const folder = source?.projectId ? project ? `${project.name} · ${project.primaryFolder ?? projectLabels.unavailable}` : projectLabels.unavailable : source?.cwd ?? e.defaultFolder;
    const brief = splitReferenceMarkers(value.prompt).map((part) => part.type === 'text' ? part.text : sourceLabel(part.target.kind === 'node' ? { kind: 'note', reference: part.target.nodeId, required: true } : { kind: 'file', reference: part.target.path, required: true })).join('');
    return { [e.task]: brief, [e.name]: value.name,
      [e.when]: `${!canEditAutomationSchedule(value.schedule) ? e.custom : value.schedule.mode === 'custom' ? `${t.every} ${value.schedule.interval} ${t.intervalUnit({ frequency: value.schedule.customFrequency, count: value.schedule.interval })}` : t.frequencies[value.schedule.mode]} · ${value.schedule.startAt.replace('T', ' ')} · ${value.timezone}${value.schedule.mode === 'weekly' || value.schedule.customFrequency === 'weekly' ? ` · ${value.schedule.weekdays.map((day) => t.weekdayShort[day]).join(', ')}` : ''}${value.schedule.mode === 'custom' && ['monthly', 'yearly'].includes(value.schedule.customFrequency) ? ` · ${value.schedule.monthDays.join(', ')}${value.schedule.customFrequency === 'yearly' ? ` ${t.months[value.schedule.month - 1]}` : ''}` : ''}`,
      [e.referenceSettings]: value.materials.map((item) => `${sourceLabel(item)}${item.required ? '' : ` (${e.continueMissing})`}`).join(', ') || e.emptyReferences,
      [e.folder]: `${folder}${source?.executionMode === 'worktree' ? ` · ${e.copy}` : ''}`,
      [e.model]: `${value.model || e.defaults}${value.modelProvider ? ` · ${formatProviderName(value.modelProvider)}` : ''}${value.reasoningEffort ? ` · ${value.reasoningEffort}` : ''}` };
  }
  const savedState = review ? editorState(review) : props.automation ? editorState(props.automation) : null;
  const localDescription = describe(state);
  const remoteDescription = savedState ? describe(savedState) : {};
  const differences = savedState ? [[e.task, state.prompt, savedState.prompt], [e.name, state.name, savedState.name],
    [e.when, [state.schedule, state.timezone], [savedState.schedule, savedState.timezone]], [e.referenceSettings, state.materials, savedState.materials],
    [e.folder, state.contextHints, savedState.contextHints], [e.model, [state.modelProvider, state.model, state.reasoningEffort], [savedState.modelProvider, savedState.model, savedState.reasoningEffort]]]
    .filter(([, local, remote]) => JSON.stringify(local) !== JSON.stringify(remote)).map(([label]) => label as string) : [];

  if (props.readOnly && props.automation) return <div className="automation-editor scheduled-editor-v2 scheduled-task-read">
    <div className="automation-editor-scroll">
      <section className="automation-editor-section"><h3>{e.task}</h3><div className="scheduled-prose"><ThreadMarkdown text={props.automation.prompt} index={props.indexStore.getCurrent()} /></div></section>
      <section className="automation-editor-section"><h3>{e.when}</h3>
        <p>{state.schedule.mode === 'once' || !canEditAutomationSchedule(state.schedule) ? describe(state)[e.when]
          : describe(state)[e.when].replace(state.schedule.startAt.replace('T', ' '), state.schedule.startAt.slice(11, 16))}</p><p className="scheduled-setting-note">{props.automation.status === 'paused' ? t.filters.paused : props.automation.nextOccurrenceAt === null ? t.noNext : `${e.next}${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: state.timezone }).format(props.automation.nextOccurrenceAt)}`}</p>
        {binding ? <p className="scheduled-setting-note">{t.project}: {folderLabel}</p> : null}
        <p className="scheduled-setting-note">{e.model}: {state.model || e.defaults}</p>
        {state.reasoningEffort ? <p className="scheduled-setting-note">{e.reasoning}: {messages.agent.composer.reasoningLevels[state.reasoningEffort]}</p> : null}
        {binding?.executionMode === 'worktree' ? <p className="scheduled-setting-note">{e.copy}</p> : null}
      </section>
      {props.automation.materials.length ? <details className="scheduled-editor-options"><summary>{e.attached}</summary>
        {props.automation.materials.map((item) => <p key={scheduledMaterialKey(item)} title={item.reference} className="scheduled-setting-note">{sourceLabel(item)}{!item.required ? ` · ${e.continueMissing}` : ''}</p>)}
      </details> : null}
      {props.runHistory}
      {error || props.actionError ? <p role="alert" className="automation-error">{error ?? props.actionError}</p> : null}
    </div>
    <footer className="automation-editor-actions"><div className="scheduled-editor-buttons">
      <Button variant="ghost" onClick={props.onCancel} disabled={disabled}>{e.closeTask}</Button>
      <Button onClick={() => void submit('run')} disabled={disabled || props.automation.archivedAt !== null}>{props.runningRunId ? e.viewRun : e.runOnce}</Button>
      <Button data-task-edit variant="primary" onClick={props.onEdit} disabled={disabled || props.automation.archivedAt !== null}>{e.editTask}</Button>
    </div></footer>
  </div>;

  return <form className="automation-editor scheduled-editor-v2" ref={formRef} onSubmit={(event) => { event.preventDefault(); void submit('save'); }}>
    <div className="scheduled-edit-status">
      {props.automation ? <span>{props.automation.status === 'paused' ? e.paused : e.future}</span> : null}
      {props.automation?.status === 'active' && props.onPause ? <>
        <IconButton icon={MoreIcon} label={e.actions} ref={menuRef} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)} />
        {menuOpen ? <AnchoredActionMenu anchorRef={menuRef} onClose={() => setMenuOpen(false)} ariaLabel={e.actions}
          className="thread-action-menu scheduled-editor-menu" surfaceProps={{ 'data-dialog-nested-overlay': 'true' }} actions={[{ label: e.pauseSaved, disabled,
            onSelect: () => { void props.onPause!(revision!).then((task) => setRevision(task.revision)).catch((reason) => setError(errorMessage(reason))); } }]} /> : null}
      </> : null}
    </div>
    <div className="automation-editor-scroll">
      <Field className="scheduled-name-field" label={e.name}>
        <Input ref={nameRef} label={e.name} value={state.name} placeholder={e.namePlaceholder} maxLength={200} disabled={disabled}
          aria-invalid={nameError || undefined} onChange={(event) => { setNameError(false); setState({ ...state, name: event.target.value }); }} />
        {nameError ? <p className="automation-error" role="alert">{e.nameRequired}</p> : null}
      </Field>
      <section className="automation-editor-intro">
        <h3>{e.task}</h3>
        <ScheduledBriefInput active={props.active} projectContext={{ ...projects, onChooseProject: () => undefined }}
          projectSelection={{ selectedId: binding?.projectId ?? null, selectedLabel: binding ? folderLabel : undefined,
            onChooseFolder: () => { void chooseFolder(); }, onSelect: (project) => {
              if (!project && binding?.executionMode === 'worktree') throw new Error(e.isolationChange);
              setState((value) => ({ ...value, contextHints: project ? [{ id: binding?.id ?? crypto.randomUUID(), contextHintId: binding?.contextHintId,
                projectId: project.id, cwd: '', executionMode: binding?.executionMode ?? 'local' }] : [] }));
            } }} indexStore={props.indexStore} value={state.prompt} disabled={disabled} onChange={briefChanged} onValidityChange={setBriefValid} onPendingChange={setBriefPending} onError={setError} />
        {taskError ? <p className="automation-error" role="alert">{e.taskRequired}</p> : null}
      </section>
      <section className="automation-editor-section">
        <h3>{e.when}</h3>
        {preservedSchedule ? <div className="scheduled-saved-rule"><span>{e.custom}</span><p>{e.customHelp}</p>
          <Button size="sm" variant="ghost" onClick={() => setReplaceSchedule(true)}>{e.replaceSchedule}</Button></div> : null}
        <AutomationScheduleEditor disabled={disabled || preservedSchedule} schedule={state.schedule} timezone={state.timezone} timezones={timezones}
          onChange={(schedule) => setState({ ...state, schedule })} onTimezoneChange={(timezone) => setState({ ...state, timezone })} />
        <p className="scheduled-preview" aria-live="polite">{previewPending ? e.previewLoading : previewError?.key === scheduleKey ? previewError.message
          : noFuture ? t.noNext : `${props.automation?.status === 'paused' ? e.ifResumed : e.next}${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: state.timezone }).format(preview!.nextOccurrenceAt!)}`}</p>
        {timingChanged && noFuture ? <p className="automation-error" role="alert">{e.previewInvalid}</p> : null}
      </section>
      <details className="scheduled-editor-options" open={optionsOpen} onToggle={(event) => setOptionsOpen(event.currentTarget.open)}>
        <summary>{e.options}<span>{optionsSummary}</span></summary>
        <div className="automation-editor-section">
          {binding ? <><CheckboxControl checked={binding.executionMode === 'worktree'} disabled={disabled} onCheckedChange={(enabled) => setState({ ...state, contextHints: [{ ...binding, executionMode: enabled ? 'worktree' : 'local' }] })}>{e.separateCopy}</CheckboxControl><p className="scheduled-setting-note">{e.copyHelp}</p></> : null}
            <Field className="automation-setting-row" label={t.model} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={disabled}
                label={t.model}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) {
                    setState({ ...state, modelProvider: '', model: '' });
                    return;
                  }
                  const parsed = parseProviderQualifiedModel(value, () => true);
                  if (!parsed) return;
                  setState({ ...state, modelProvider: parsed.providerId, model: value });
                }}
                value={selectedModel}
                variant="popup"
              >
                {/* Default overrides nothing — it stores null for BOTH provider and
                    model. It is not the composer's "always newest", which pins a
                    provider; keep the two distinct. */}
                <option value="">{e.defaults}</option>
                {selectedModel && !knownModelValues.has(selectedModel) ? (
                  <option value={selectedModel}>{state.model}</option>
                ) : null}
                {modelChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {showProviderLabel
                      ? `${choice.option.name || choice.option.id} · ${formatProviderName(choice.providerId)}`
                      : choice.option.name || choice.option.id}
                  </option>
                ))}
              </SelectControl>
            </Field>
            {showReasoning ? <Field className="automation-setting-row" label={e.reasoning} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={disabled}
                label={e.reasoning}
                onChange={(event) => setState({ ...state, reasoningEffort: event.target.value as ReasoningEffort | '' })}
                value={state.reasoningEffort}
                variant="popup"
              >
                <option value="">{e.defaults}</option>
                {state.reasoningEffort && !reasoningChoices.includes(state.reasoningEffort) ? <option value={state.reasoningEffort}>{messages.agent.composer.reasoningLevels[state.reasoningEffort]} · {projectLabels.unavailable}</option> : null}
                {reasoningChoices.map((effort) => <option key={effort} value={effort}>{choices.resolvedOption?.thinkingLevelLabels?.[effort] ?? messages.agent.composer.reasoningLevels[effort]}</option>)}
              </SelectControl>
            </Field> : null}

        </div>
      </details>
      {materials.length ? <details className="scheduled-editor-options" open={referenceOptionsOpen} onToggle={(event) => setReferenceOptionsOpen(event.currentTarget.open)}><summary>{e.referenceSettings}</summary>
        <p className="scheduled-setting-note">{e.requiredHelp}</p>
        {materials.map((item) => {
          const key = scheduledMaterialKey(item);
          const inline = scheduledInlineMaterials(state.prompt).some((value) => scheduledMaterialKey(value) === key);
          return <div className="scheduled-reference-policy" key={key}>
            <span title={item.reference}>{sourceLabel(item)}{inline ? '' : ` · ${e.attached}`}</span>
            <CheckboxControl checked={!item.required} disabled={disabled} onCheckedChange={(optional) => setState({ ...state, materials: [...state.materials.filter((value) => scheduledMaterialKey(value) !== key), { ...item, required: !optional }] })}>{e.continueMissing}</CheckboxControl>
            {!inline ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setState({ ...state, materials: state.materials.filter((value) => scheduledMaterialKey(value) !== key) })}>{e.remove}</Button> : null}
          </div>;
        })}
      </details> : null}
      {conflict ? <section className="scheduled-revision-conflict" role="alert"><p>{e.changed}</p>
        <Button size="sm" variant="ghost" onClick={() => setReview((value) => value ? null : props.automation)}>{e.reviewSaved}</Button>
        {review ? <><div className="scheduled-conflict-fields">{differences.map((label) => <section key={label}><h3>{label}</h3><p>{e.yours}: {localDescription[label]}</p><p>{e.saved}: {remoteDescription[label]}</p></section>)}</div>
          <Button size="sm" variant="ghost" onClick={() => { const saved = editorState(props.automation); setState(saved); setBaseline(saved); setRevision(props.automation!.revision); setError(null); setReview(null); }}>{t.work.reload}</Button>
          <p className="scheduled-setting-note">{e.applyHelp}</p><Button size="sm" variant="ghost" onClick={() => { setRevision(review!.revision); setBaseline(editorState(review)); setError(null); setReview(null); }}>{e.applyDraft}</Button>
        </> : null}
      </section> : null}
      {savedRunError ? <p role="status" className="scheduled-setting-note">{e.savedRunFailed}</p> : null}
      {error || props.actionError || materialError ? <p className="automation-error" role="alert">{error ?? props.actionError ?? materialError}</p> : null}
    </div>
    <footer className="automation-editor-actions">
      <p>{e.local}</p><div className="scheduled-editor-buttons">
        <Button disabled={disabled} onClick={props.onCancel} variant="ghost">{t.cancel}</Button>
        <Button disabled={disabled || (!props.runningRunId && (!state.name.trim() || !state.prompt.trim() || !briefValid || briefPending || picking || Boolean(materialError) || conflict || ((!props.automation || dirty) && (previewPending || previewError?.key === scheduleKey || (timingChanged && noFuture)))))}
          onClick={() => void submit('run')}>{props.runningRunId ? e.viewRun : !props.automation || dirty ? e.saveRun : e.runOnce}</Button>
        <Button disabled={disabled || !state.name.trim() || !state.prompt.trim() || !briefValid || briefPending || picking || previewPending || previewError?.key === scheduleKey || Boolean(materialError) || (timingChanged && noFuture) || conflict || (Boolean(props.automation) && !dirty)} type="submit" variant="primary">{props.automation ? e.save : t.create}</Button>
      </div>
    </footer>
    {replaceSchedule ? <ConfirmDialog title={e.replaceTitle} message={e.replaceHelp} confirmLabel={e.replace} cancelLabel={e.keepSchedule}
      onCancel={() => setReplaceSchedule(false)} onConfirm={() => { setState({ ...state, schedule: { ...state.schedule, sourceRrule: null } }); setReplaceSchedule(false); }} /> : null}
  </form>;
}

interface EditorState {
  readonly materials: readonly ScheduledMaterial[];
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationScheduleDraft;
  readonly timezone: string;
  readonly contextHints: readonly ContextHintDraft[];
  readonly modelProvider: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | '';
}

function automationModelValue(
  providerId: string,
  model: string,
  groups: readonly ModelChoiceGroup[],
): string {
  if (!model.trim()) return '';
  const knownProviderIds = new Set(groups.map((group) => group.providerId));
  const parsed = parseProviderQualifiedModel(model, (candidate) => knownProviderIds.has(candidate));
  return composeProviderQualifiedModel(parsed?.providerId ?? providerId, parsed?.modelId ?? model);
}

const SYSTEM_TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
})();

function automationTimezones(current: string): readonly string[] {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([current, system, 'UTC', ...SYSTEM_TIMEZONES].filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function editorState(automation: Automation | null): EditorState {
  return {
    materials: automation?.materials ?? [],
    name: automation?.name ?? '',
    prompt: automation?.prompt ?? '',
    schedule: createAutomationScheduleDraft(automation?.schedule.rrule),
    timezone: automation?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    contextHints: automation?.contextHints.slice(0, 1).map((binding) => ({
      id: binding.contextHintId, contextHintId: binding.contextHintId,
      cwd: binding.source.kind === 'directory' ? binding.source.rootHint : '',
      ...(binding.source.kind === 'project' ? { projectId: binding.source.projectId } : {}),
      executionMode: binding.executionMode,
    })) ?? [],
    modelProvider: automation?.configuration.modelProvider ?? '',
    model: automation?.configuration.model ?? '',
    reasoningEffort: automation?.configuration.reasoningEffort ?? '',
  };
}

function stateSignature(state: EditorState): string {
  return JSON.stringify(state);
}

/** Convert editor state to the closed Core contract; UI row ids never cross this boundary. */
export function toAutomationContextHintInput(
  binding: Pick<ContextHintDraft, 'id' | 'contextHintId' | 'executionMode' | 'projectId'>,
  rootHint: string,
): AutomationContextHintInput {
  return {
    ...(binding.contextHintId ? { contextHintId: binding.contextHintId } : {}),
    source: binding.projectId ? { kind: 'project', projectId: binding.projectId } : { kind: 'directory', rootHint },
    executionMode: binding.executionMode,
  };
}

function nullable(value: string): string | null {
  return value.trim() || null;
}

function required(value: string, message: string): string {
  if (!value.trim()) throw new Error(message);
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
