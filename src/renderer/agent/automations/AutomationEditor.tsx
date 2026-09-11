import { CheckboxControl } from '../../ui/primitives/CheckboxControl';
import type { ScheduledMaterial } from '../../../core/agent/scheduledMaterial';
import { api } from '../../api/client';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { CloseIcon } from '../../ui/icons';
import { formatProviderName } from '../../ui/agent/providerNames';
import { buildModelChoices, flattenModelChoices, type ModelChoiceGroup } from '../../ui/agent/modelChoices';
import { Button } from '../../ui/primitives/Button';
import { Field } from '../../ui/primitives/Field';
import { IconButton } from '../../ui/primitives/IconButton';
import { Input } from '../../ui/primitives/Input';
import { SelectControl } from '../../ui/primitives/SelectControl';
import { Textarea } from '../../ui/primitives/Textarea';
import { AutomationScheduleEditor } from './AutomationScheduleEditor';
import { useProjectCatalog } from '../projects/useProjectCatalog';
import {
  automationScheduleRrule,
  createAutomationScheduleDraft,
  isAutomationScheduleDraftValid,
  type AutomationScheduleDraft,
} from './AutomationScheduleDraft';

type ProjectMode = 'none' | 'local' | 'worktree';
type ContextHintDraft = {
  readonly projectId?: string;
  readonly id: string;
  readonly contextHintId?: string;
  readonly cwd: string;
  readonly executionMode: Exclude<ProjectMode, 'none'>;
};

interface AutomationEditorProps {
  readonly actionError: string | null;
  readonly notes?: readonly { id: string; title: string }[];
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
  const t = useT().agent.automations;
  const projectLabels = useT().agent.projects;
  const projects = useProjectCatalog();
  const automationKey = props.automation?.id ?? 'create';
  const initial = useMemo(() => editorState(props.automation), [automationKey]);
  const [state, setState] = useState(initial);
  const [baselineSignature, setBaselineSignature] = useState(() => stateSignature(initial));
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ nextOccurrenceAt: number | null; defaultWorkLocation: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [noteSearch, setNoteSearch] = useState('');
  const operationRef = useRef({ signature: '', requestId: crypto.randomUUID() });
  const revisionRef = useRef(props.automation?.revision ?? null);
  const dirty = stateSignature(state) !== baselineSignature;

  useEffect(() => {
    setState(initial);
    setBaselineSignature(stateSignature(initial));
    setError(null);
    revisionRef.current = props.automation?.revision ?? null;
  }, [automationKey, initial]);

  useEffect(() => {
    props.onDirtyChange(dirty);
  }, [dirty, props.onDirtyChange]);

  useEffect(() => {
    if (!props.automation || props.automation.id !== automationKey || dirty) return;
    const incoming = editorState(props.automation);
    const incomingSignature = stateSignature(incoming);
    if (incomingSignature !== baselineSignature) {
      setState(incoming);
      setBaselineSignature(incomingSignature);
    }
    revisionRef.current = props.automation.revision;
  }, [automationKey, baselineSignature, dirty, props.automation]);

  const choices = useMemo(
    () => buildModelChoices(props.providerSettings, { modelProvider: state.modelProvider, model: state.model }),
    [props.providerSettings, state.model, state.modelProvider],
  );
  // A native select cannot truncate, so the provider grouping collapses fully.
  const modelChoices = useMemo(() => flattenModelChoices(choices), [choices]);
  const showProviderLabel = choices.showProviderLabel;
  // Memoized and keyed on the groups, not the flattened models: this only needs
  // the handful of provider ids, and an unmemoized Set over an OpenRouter-sized
  // catalog would be rebuilt on every keystroke in the name/prompt fields.
  const selectedModel = useMemo(
    () => automationModelValue(state.modelProvider, state.model, choices.groups),
    [choices.groups, state.model, state.modelProvider],
  );
  const knownModelValues = useMemo(
    () => new Set(modelChoices.map((choice) => choice.value)),
    [modelChoices],
  );
  const timezones = useMemo(() => automationTimezones(state.timezone), [state.timezone]);

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      try {
        void api.automationRequest('preview', { rrule: automationScheduleRrule(state.schedule), timezone: state.timezone })
          .then((value) => { if (!stale) { setPreview(value); setPreviewError(null); } })
          .catch((reason) => { if (!stale) { setPreview(null); setPreviewError(errorMessage(reason)); } });
      } catch (reason) { if (!stale) { setPreview(null); setPreviewError(errorMessage(reason)); } }
    }, 150);
    return () => { stale = true; clearTimeout(timer); };
  }, [state.schedule, state.timezone]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (
        !state.name.trim()
        || !state.prompt.trim()
        || !isAutomationScheduleDraftValid(state.schedule)
      ) throw new Error(t.required);
      const destination = { kind: 'standalone' as const };
      const contextHints = state.contextHints.map((binding) => toAutomationContextHintInput(
        binding,
        binding.projectId ? '' : required(binding.cwd, t.fieldRequired({ field: t.cwd })),
      ));
      const definition: AutomationCreateInput = {
        name: state.name.trim(),
        prompt: state.prompt.trim(),
        materials: state.materials,
        schedule: {
          rrule: automationScheduleRrule(state.schedule),
          timezone: required(state.timezone, t.fieldRequired({ field: t.timezone })),
        },
        destination,
        contextHints,
        configuration: {
          modelProvider: nullable(state.modelProvider),
          model: nullable(state.model),
          reasoningEffort: state.reasoningEffort || null,
        },
      };
      const signature = JSON.stringify([definition, revisionRef.current]);
      if (operationRef.current.signature !== signature) operationRef.current = { signature, requestId: crypto.randomUUID() };
      const requestId = operationRef.current.requestId;
      let saved: Automation;
      if (props.automation) {
        saved = await props.onUpdate({
          id: props.automation.id,
          expectedRevision: revisionRef.current ?? props.automation.revision,
          ...definition,
          requestId,
        });
      } else {
        saved = await props.onCreate({ ...definition, requestId });
      }
      revisionRef.current = saved.revision;
      setBaselineSignature(stateSignature(state));
      props.onDirtyChange(false);
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  }

  return (
    <form className="automation-editor" onSubmit={(event) => void submit(event)}>
      <div className="automation-editor-scroll">
        <section className="automation-editor-intro">
          <Field className="automation-name-field" label={t.name} labelClassName="automation-field-label">
            <Input
              autoComplete="off"
              className="automation-name-input"
              disabled={props.busy}
              label={t.name}
              onChange={(event) => setState({ ...state, name: event.target.value })}
              placeholder={t.name}
              variant="bare"
              value={state.name}
            />
          </Field>
          <Field className="automation-prompt-field" label={t.prompt} labelClassName="automation-field-label">
            <Textarea ref={promptRef}
              className="automation-prompt-input"
              disabled={props.busy}
              label={t.prompt}
              onChange={(event) => { const prompt = event.target.value; setState({ ...state, prompt, name: state.name === state.prompt.split('\n')[0].slice(0, 80) || !state.name ? prompt.split('\n')[0].slice(0, 80) : state.name }); }}
              rows={5}
              value={state.prompt}
            />
          </Field>
        </section>

        <section className="automation-editor-section">
          <h3>{t.work.materials}</h3>
          {state.materials.map((material, index) => <div className="scheduled-material" key={index}>
            <SelectControl label={t.work.materialKind} value={material.kind} disabled={props.busy}
              onChange={(event) => setState({ ...state, materials: state.materials.map((entry, at) => at === index ? { ...entry, kind: event.target.value as ScheduledMaterial['kind'], reference: '' } : entry) })}>
              <option value="file">{t.work.file}</option><option value="url">{t.work.url}</option><option value="note">{t.work.note}</option>
            </SelectControl>
            {material.kind === 'note' ? <>
              <Input disabled={props.busy} label={t.search} placeholder={t.search} value={noteSearch} onChange={(event) => setNoteSearch(event.target.value)} />
              <SelectControl disabled={props.busy} label={t.work.reference} value={material.reference} onChange={(event) => setState({ ...state, materials: state.materials.map((entry, at) => at === index ? { ...entry, reference: event.target.value } : entry) })}>
                <option value="">{t.work.reference}</option>
                {(props.notes ?? []).filter((note) => note.id === material.reference || note.title.toLocaleLowerCase().includes(noteSearch.toLocaleLowerCase())).slice(0, 100)
                  .map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
                {material.reference && !props.notes?.some((note) => note.id === material.reference) ? <option value={material.reference}>{projectLabels.unavailable}</option> : null}
              </SelectControl>
            </> : <Input label={t.work.reference} value={material.reference} disabled={props.busy}
              onChange={(event) => setState({ ...state, materials: state.materials.map((entry, at) => at === index ? { ...entry, reference: event.target.value } : entry) })} />}
            <CheckboxControl checked={material.required} disabled={props.busy} onCheckedChange={(required) => setState({ ...state,
              materials: state.materials.map((entry, at) => at === index ? { ...entry, required } : entry) })}>{t.work.requiredMaterial}</CheckboxControl>
            <Button size="sm" variant="ghost" onClick={() => setState({ ...state, materials: state.materials.filter((_, at) => at !== index) })}>{t.work.removeMaterial}</Button>
          </div>)}
          <Button size="sm" variant="ghost" disabled={props.busy || state.materials.length >= 32}
            onClick={() => setState({ ...state, materials: [...state.materials, { kind: 'file', reference: '', required: true }] })}>{t.work.addMaterial}</Button>
        </section>

        <section className="automation-editor-section">
          <h3>{t.work.location}</h3>
          {!state.contextHints.length ? <p>{preview?.defaultWorkLocation ?? t.inherited}</p> : null}
          <div className="automation-settings-group">
            <Field className="automation-setting-row" label={t.project} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={props.busy}
                label={t.project}
                onChange={(event) => {
                  const projectMode = event.target.value as ProjectMode;
                  setState({
                    ...state,
                    contextHints: projectMode === 'none'
                      ? []
                      : state.contextHints.length === 0
                        ? [{ id: crypto.randomUUID(), cwd: '', executionMode: projectMode }]
                        : state.contextHints.map((binding, index) => (
                            index === 0 ? { ...binding, executionMode: projectMode } : binding
                          )),
                  });
                }}
                value={state.contextHints[0]?.executionMode ?? 'none'}
                variant="popup"
              >
                <option value="none">{t.projects.none}</option>
                <option value="local">{t.projects.local}</option>
                <option value="worktree">{t.projects.worktree}</option>
              </SelectControl>
            </Field>
            <details><summary>{t.work.advanced}</summary>
            <Field className="automation-setting-row" label={t.model} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={props.busy}
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
                {/* "Inherit" overrides nothing — it stores null for BOTH provider and
                    model. It is not the composer's "always newest", which pins a
                    provider; keep the two distinct. */}
                <option value="">{t.inherited}</option>
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
            <Field className="automation-setting-row" label={t.reasoning} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={props.busy}
                label={t.reasoning}
                onChange={(event) => setState({ ...state, reasoningEffort: event.target.value as ReasoningEffort | '' })}
                value={state.reasoningEffort}
                variant="popup"
              >
                <option value="">{t.inherited}</option>
                {REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </SelectControl>
            </Field>
            </details>
          </div>

          {state.contextHints.length > 0 ? (
            <div className="automation-project-details">
              {projects.error ? <p className="automation-error" role="alert">{projects.error}</p> : null}
              {state.contextHints.map((binding, index) => (
                <div className={`automation-project-binding${index === 0 ? ' is-primary' : ''}`} key={binding.id || index}>
                  {index > 0 ? (
                    <SelectControl
                      disabled={props.busy}
                      label={t.projectMode({ index: index + 1 })}
                      onChange={(event) => setState({
                        ...state,
                        contextHints: replaceBinding(state.contextHints, index, {
                          ...binding,
                          executionMode: event.target.value as ContextHintDraft['executionMode'],
                        }),
                      })}
                      value={binding.executionMode}
                      variant="boxed"
                    >
                      <option value="local">{t.projects.local}</option>
                      <option value="worktree">{t.projects.worktree}</option>
                    </SelectControl>
                  ) : null}
                  <Field label={projectLabels.title}>
                    <SelectControl label={projectLabels.title} value={binding.projectId ?? ''}
                      disabled={props.busy || projects.loading || !!projects.error} variant="boxed"
                      onChange={(event) => setState({ ...state, contextHints: replaceBinding(state.contextHints, index, {
                        ...binding, projectId: event.target.value || undefined,
                      }) })}>
                      <option value="">{projectLabels.directory}</option>
                      {binding.projectId && !projects.view.projects.some((project) => project.id === binding.projectId)
                        ? <option value={binding.projectId}>{projectLabels.unavailable}</option> : null}
                      {projects.view.projects.map((project) => <option key={project.id} value={project.id} disabled={!project.primaryFolder}>{project.name}</option>)}
                    </SelectControl>
                  </Field>
                  {binding.projectId ? <p className="project-path">{projects.view.projects.find((project) => project.id === binding.projectId)?.primaryFolder ?? projectLabels.unavailable}</p> : <Field label={t.projectPath({ index: index + 1 })}>
                    <Input
                      disabled={props.busy}
                      label={t.projectPath({ index: index + 1 })}
                      onChange={(event) => setState({
                        ...state,
                        contextHints: replaceBinding(state.contextHints, index, {
                          ...binding,
                          cwd: event.target.value,
                        }),
                      })}
                      value={binding.cwd}
                    />
                  </Field>}
                  {index > 0 ? (
                    <IconButton
                      disabled={props.busy}
                      icon={CloseIcon}
                      label={t.removeProject({ index: index + 1 })}
                      onClick={() => setState({
                        ...state,
                        contextHints: state.contextHints.filter((_, candidate) => candidate !== index),
                      })}
                      variant="message"
                    />
                  ) : null}
                </div>
              ))}

            </div>
          ) : null}
        </section>

        <section className="automation-editor-section">
          <h3>{t.frequency}</h3>
          <p>{t.work.local}</p>
          <p>{preview?.nextOccurrenceAt == null ? t.noNext : new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: state.timezone }).format(preview.nextOccurrenceAt)} · {state.timezone}</p>
          {previewError ? <p role="alert">{previewError}</p> : null}
          <AutomationScheduleEditor
            disabled={props.busy}
            onChange={(schedule) => setState({ ...state, schedule })}
            onTimezoneChange={(timezone) => setState({ ...state, timezone })}
            schedule={state.schedule}
            timezone={state.timezone}
            timezones={timezones}
          />
        </section>



        {props.automation && dirty && !props.busy && revisionRef.current !== props.automation.revision ? <details className="scheduled-revision-conflict">
          <summary>{t.work.changed}</summary>
          <strong>{props.automation.name}</strong><p>{props.automation.prompt}</p>
          <Button size="sm" variant="ghost" onClick={() => {
            const saved = editorState(props.automation);
            setState(saved); setBaselineSignature(stateSignature(saved)); revisionRef.current = props.automation!.revision;
            setError(null); props.onDirtyChange(false); promptRef.current?.focus();
          }}>{t.work.reload}</Button>
        </details> : null}

        {error || props.actionError ? (
          <p className="automation-error" role="alert">{error ?? props.actionError}</p>
        ) : null}
      </div>
      <footer className="automation-editor-actions">
        {props.automation && props.onPause && props.automation.status === 'active' ? <Button variant="ghost" disabled={props.busy}
          onClick={() => { void props.onPause!(revisionRef.current ?? props.automation!.revision).then((task) => { revisionRef.current = task.revision; }).catch((reason) => setError(errorMessage(reason))); }}>{t.work.pause}</Button> : null}
        <Button disabled={props.busy} onClick={props.onCancel} variant="ghost">{t.cancel}</Button>
        <Button disabled={props.busy || (Boolean(props.automation) && !dirty)} type="submit" variant="primary">
          {props.automation ? t.save : t.create}
        </Button>
      </footer>
    </form>
  );
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

function replaceBinding(
  bindings: readonly ContextHintDraft[],
  index: number,
  value: ContextHintDraft,
): readonly ContextHintDraft[] {
  return bindings.map((binding, candidate) => candidate === index ? value : binding);
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
