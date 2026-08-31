import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput,
} from '../../../core/agent/automation';
import { composeProviderQualifiedModel, parseProviderQualifiedModel } from '../../../core/agentModelId';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../../core/agent/configuration';
import type { Thread } from '../projectionTypes';
import type { AgentProviderSettingsView } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, TrashIcon } from '../../ui/icons';
import { formatProviderName } from '../../ui/agent/providerNames';
import { buildModelChoices, flattenModelChoices, type ModelChoiceGroup } from '../../ui/agent/modelChoices';
import { Button } from '../../ui/primitives/Button';
import { Field } from '../../ui/primitives/Field';
import { IconButton } from '../../ui/primitives/IconButton';
import { Input } from '../../ui/primitives/Input';
import { SelectControl } from '../../ui/primitives/SelectControl';
import { Textarea } from '../../ui/primitives/Textarea';
import { AutomationScheduleEditor } from './AutomationScheduleEditor';
import {
  automationScheduleRrule,
  createAutomationScheduleDraft,
  isAutomationScheduleDraftValid,
  type AutomationScheduleDraft,
} from './AutomationScheduleDraft';

type ProjectMode = 'none' | 'local' | 'worktree';
type ProjectBindingDraft = {
  readonly id: string;
  readonly cwd: string;
  readonly executionMode: Exclude<ProjectMode, 'none'>;
};

interface AutomationEditorProps {
  readonly actionError: string | null;
  readonly automation: Automation | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onCreate: (input: AutomationCreateInput) => Promise<Automation>;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onUpdate: (input: AutomationUpdateInput) => Promise<Automation>;
  readonly providerSettings: AgentProviderSettingsView | null;
  readonly runHistory?: ReactNode;
  readonly threads: readonly Thread[];
}

export function AutomationEditor(props: AutomationEditorProps) {
  const t = useT().agent.automations;
  const automationKey = props.automation?.id ?? 'create';
  const initial = useMemo(() => editorState(props.automation), [automationKey]);
  const [state, setState] = useState(initial);
  const [baselineSignature, setBaselineSignature] = useState(() => stateSignature(initial));
  const [error, setError] = useState<string | null>(null);
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

  const destinationThreads = props.threads.filter((thread) => (
    !thread.ephemeral && thread.parentThreadId === null && thread.threadSource === 'user'
  ));
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (
        !state.name.trim()
        || !state.prompt.trim()
        || !isAutomationScheduleDraftValid(state.schedule)
      ) throw new Error(t.required);
      const destination = state.destination === 'standalone'
        ? { kind: 'standalone' as const }
        : { kind: 'existingThread' as const, threadId: required(state.threadId, t.fieldRequired({ field: t.thread })) };
      const projectBindings = state.projectBindings.map((binding) => ({
        ...binding,
        id: binding.id || crypto.randomUUID(),
        cwd: required(binding.cwd, t.fieldRequired({ field: t.cwd })),
      }));
      const definition: AutomationCreateInput = {
        name: state.name.trim(),
        prompt: state.prompt.trim(),
        schedule: {
          rrule: automationScheduleRrule(state.schedule),
          timezone: required(state.timezone, t.fieldRequired({ field: t.timezone })),
        },
        destination,
        projectBindings,
        configuration: {
          modelProvider: nullable(state.modelProvider),
          model: nullable(state.model),
          reasoningEffort: state.reasoningEffort || null,
        },
      };
      let saved: Automation;
      if (props.automation) {
        saved = await props.onUpdate({
          id: props.automation.id,
          expectedRevision: revisionRef.current ?? props.automation.revision,
          ...definition,
        });
      } else {
        saved = await props.onCreate(definition);
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
            <Textarea
              className="automation-prompt-input"
              disabled={props.busy}
              label={t.prompt}
              onChange={(event) => setState({ ...state, prompt: event.target.value })}
              rows={5}
              value={state.prompt}
            />
          </Field>
        </section>

        <section className="automation-editor-section">
          <h3>{t.executionDetails}</h3>
          <div className="automation-settings-group">
            <Field className="automation-setting-row" label={t.destination} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={props.busy}
                label={t.destination}
                onChange={(event) => {
                  const destination = event.target.value as EditorState['destination'];
                  setState({
                    ...state,
                    destination,
                    projectBindings: destination === 'existingThread'
                      ? state.projectBindings.slice(0, 1).map((binding) => ({
                          ...binding,
                          executionMode: 'local' as const,
                        }))
                      : state.projectBindings,
                  });
                }}
                value={state.destination}
                variant="popup"
              >
                <option value="standalone">{t.destinations.standalone}</option>
                <option value="existingThread">{t.destinations.existingThread}</option>
              </SelectControl>
            </Field>
            {state.destination === 'existingThread' ? (
              <Field className="automation-setting-row" label={t.thread} labelClassName="automation-setting-label">
                <SelectControl
                  className="automation-setting-value"
                  disabled={props.busy}
                  label={t.thread}
                  onChange={(event) => setState({ ...state, threadId: event.target.value })}
                  value={state.threadId}
                  variant="popup"
                >
                  <option value="">{t.selectThread}</option>
                  {destinationThreads.map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {thread.name || thread.preview || thread.id}
                    </option>
                  ))}
                </SelectControl>
              </Field>
            ) : null}
            <Field className="automation-setting-row" label={t.project} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={props.busy}
                label={t.project}
                onChange={(event) => {
                  const projectMode = event.target.value as ProjectMode;
                  setState({
                    ...state,
                    projectBindings: projectMode === 'none'
                      ? []
                      : state.projectBindings.length === 0
                        ? [{ id: crypto.randomUUID(), cwd: '', executionMode: projectMode }]
                        : state.projectBindings.map((binding, index) => (
                            index === 0 ? { ...binding, executionMode: projectMode } : binding
                          )),
                  });
                }}
                value={state.projectBindings[0]?.executionMode ?? 'none'}
                variant="popup"
              >
                <option value="none">{t.projects.none}</option>
                <option value="local">{t.projects.local}</option>
                {state.destination === 'standalone' ? (
                  <option value="worktree">{t.projects.worktree}</option>
                ) : null}
              </SelectControl>
            </Field>
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
          </div>

          {state.projectBindings.length > 0 ? (
            <div className="automation-project-details">
              {state.projectBindings.map((binding, index) => (
                <div className={`automation-project-binding${index === 0 ? ' is-primary' : ''}`} key={binding.id || index}>
                  {index > 0 ? (
                    <SelectControl
                      disabled={props.busy}
                      label={t.projectMode({ index: index + 1 })}
                      onChange={(event) => setState({
                        ...state,
                        projectBindings: replaceBinding(state.projectBindings, index, {
                          ...binding,
                          executionMode: event.target.value as ProjectBindingDraft['executionMode'],
                        }),
                      })}
                      value={binding.executionMode}
                      variant="boxed"
                    >
                      <option value="local">{t.projects.local}</option>
                      <option value="worktree">{t.projects.worktree}</option>
                    </SelectControl>
                  ) : null}
                  <Field label={t.projectPath({ index: index + 1 })}>
                    <Input
                      disabled={props.busy}
                      label={t.projectPath({ index: index + 1 })}
                      onChange={(event) => setState({
                        ...state,
                        projectBindings: replaceBinding(state.projectBindings, index, {
                          ...binding,
                          cwd: event.target.value,
                        }),
                      })}
                      value={binding.cwd}
                    />
                  </Field>
                  {index > 0 ? (
                    <IconButton
                      disabled={props.busy}
                      icon={TrashIcon}
                      label={t.removeProject({ index: index + 1 })}
                      onClick={() => setState({
                        ...state,
                        projectBindings: state.projectBindings.filter((_, candidate) => candidate !== index),
                      })}
                      variant="message"
                    />
                  ) : null}
                </div>
              ))}
              {state.destination === 'standalone' ? (
                <Button
                  disabled={props.busy}
                  onClick={() => setState({
                    ...state,
                    projectBindings: [...state.projectBindings, {
                      id: crypto.randomUUID(),
                      cwd: '',
                      executionMode: 'local',
                    }],
                  })}
                  size="sm"
                  variant="ghost"
                >
                  <AddIcon size={12} />{t.addProject}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="automation-editor-section">
          <h3>{t.frequency}</h3>
          <AutomationScheduleEditor
            disabled={props.busy}
            onChange={(schedule) => setState({ ...state, schedule })}
            onTimezoneChange={(timezone) => setState({ ...state, timezone })}
            schedule={state.schedule}
            timezone={state.timezone}
            timezones={timezones}
          />
        </section>

        {props.automation ? (
          <section className="automation-editor-section automation-runs-section">
            {props.runHistory}
          </section>
        ) : null}

        {error || props.actionError ? (
          <p className="automation-error" role="alert">{error ?? props.actionError}</p>
        ) : null}
      </div>
      <footer className="automation-editor-actions">
        <Button disabled={props.busy} onClick={props.onCancel} variant="ghost">{t.cancel}</Button>
        <Button disabled={props.busy || (Boolean(props.automation) && !dirty)} type="submit" variant="primary">
          {props.automation ? t.save : t.create}
        </Button>
      </footer>
    </form>
  );
}

interface EditorState {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationScheduleDraft;
  readonly timezone: string;
  readonly destination: 'standalone' | 'existingThread';
  readonly threadId: string;
  readonly projectBindings: readonly ProjectBindingDraft[];
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
    name: automation?.name ?? '',
    prompt: automation?.prompt ?? '',
    schedule: createAutomationScheduleDraft(automation?.schedule.rrule),
    timezone: automation?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    destination: automation?.destination.kind ?? 'standalone',
    threadId: automation?.destination.kind === 'existingThread' ? automation.destination.threadId : '',
    projectBindings: automation?.projectBindings.map((binding) => ({ ...binding })) ?? [],
    modelProvider: automation?.configuration.modelProvider ?? '',
    model: automation?.configuration.model ?? '',
    reasoningEffort: automation?.configuration.reasoningEffort ?? '',
  };
}

function stateSignature(state: EditorState): string {
  return JSON.stringify(state);
}

function replaceBinding(
  bindings: readonly ProjectBindingDraft[],
  index: number,
  value: ProjectBindingDraft,
): readonly ProjectBindingDraft[] {
  return bindings.map((binding, candidate) => candidate === index ? value : binding);
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
