import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput,
} from '../../../core/agent/automation';
import { composeProviderQualifiedModel, parseProviderQualifiedModel } from '../../../core/agentModelId';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../../core/agent/configuration';
import type { Thread } from '../../../core/agent/protocol';
import type { AgentProviderSettingsView } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, TrashIcon } from '../../ui/icons';
import { isProviderUsable } from '../../ui/agent/providerUsability';
import { Button } from '../../ui/primitives/Button';
import { Field } from '../../ui/primitives/Field';
import { IconButton } from '../../ui/primitives/IconButton';
import { Input } from '../../ui/primitives/Input';
import { SegmentedControl } from '../../ui/primitives/SegmentedControl';
import { SelectControl } from '../../ui/primitives/SelectControl';
import { Textarea } from '../../ui/primitives/Textarea';

type Frequency = 'once' | 'hourly' | 'daily' | 'weekly' | 'custom';
type ProjectMode = 'none' | 'local' | 'worktree';
type ProjectBindingDraft = {
  readonly id: string;
  readonly cwd: string;
  readonly executionMode: Exclude<ProjectMode, 'none'>;
};

export interface CapabilityListDraft {
  readonly mode: 'inherit' | 'none' | 'allowlist';
  readonly value: string;
}

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
  const modelGroups = useMemo(
    () => automationModelGroups(props.providerSettings, state.modelProvider),
    [props.providerSettings, state.modelProvider],
  );
  const selectedModel = automationModelValue(state.modelProvider, state.model, modelGroups);
  const knownModelValues = useMemo(
    () => new Set(modelGroups.flatMap((group) => group.models.map((model) => model.value))),
    [modelGroups],
  );
  const timezones = useMemo(() => automationTimezones(state.timezone), [state.timezone]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (
        !state.name.trim()
        || !state.prompt.trim()
        || (state.frequency !== 'custom' && !state.startAt)
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
          rrule: state.frequency === 'custom'
            ? required(state.rrule, t.fieldRequired({ field: t.rrule }))
            : scheduleRrule(state.startAt, state.frequency),
          timezone: required(state.timezone, t.fieldRequired({ field: t.timezone })),
        },
        destination,
        projectBindings,
        configuration: {
          profileName: nullable(state.profileName),
          modelProvider: nullable(state.modelProvider),
          model: nullable(state.model),
          reasoningEffort: state.reasoningEffort || null,
          tools: capabilityListValue(state.tools),
          skills: capabilityListValue(state.skills),
          plugins: capabilityListValue(state.plugins),
          mcpServers: capabilityListValue(state.mcpServers),
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
                <option value="">{t.inherited}</option>
                {selectedModel && !knownModelValues.has(selectedModel) ? (
                  <option value={selectedModel}>{state.model}</option>
                ) : null}
                {modelGroups.map((group) => (
                  <optgroup key={group.providerId} label={group.providerId}>
                    {group.models.map((model) => (
                      <option key={model.value} value={model.value}>{model.name}</option>
                    ))}
                  </optgroup>
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
          <div className="automation-settings-group">
            <Field className="automation-setting-row" label={t.repeat} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={props.busy}
                label={t.repeat}
                onChange={(event) => setState({ ...state, frequency: event.target.value as Frequency })}
                value={state.frequency}
                variant="popup"
              >
                <option value="once">{t.frequencies.once}</option>
                <option value="hourly">{t.frequencies.hourly}</option>
                <option value="daily">{t.frequencies.daily}</option>
                <option value="weekly">{t.frequencies.weekly}</option>
                <option value="custom">{t.frequencies.custom}</option>
              </SelectControl>
            </Field>
            {state.frequency !== 'custom' ? (
              <Field className="automation-setting-row" label={t.startAt} labelClassName="automation-setting-label">
                <Input
                  className="automation-setting-input"
                  disabled={props.busy}
                  label={t.startAt}
                  onChange={(event) => setState({ ...state, startAt: event.target.value })}
                  size="sm"
                  type="datetime-local"
                  value={state.startAt}
                  variant="bare"
                />
              </Field>
            ) : null}
            <Field className="automation-setting-row" label={t.timezone} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={props.busy}
                label={t.timezone}
                onChange={(event) => setState({ ...state, timezone: event.target.value })}
                value={state.timezone}
                variant="popup"
              >
                {timezones.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
              </SelectControl>
            </Field>
          </div>
          {state.frequency === 'custom' ? (
            <Field className="automation-schedule-detail" label={t.rrule}>
              <Textarea
                className="automation-rrule-input"
                disabled={props.busy}
                label={t.rrule}
                onChange={(event) => setState({ ...state, rrule: event.target.value })}
                rows={3}
                value={state.rrule}
              />
            </Field>
          ) : null}
        </section>

        {props.automation ? (
          <section className="automation-editor-section automation-runs-section">
            <h3>{t.previousRuns}</h3>
            {props.runHistory}
          </section>
        ) : null}

        <details className="automation-configuration">
          <summary>{t.advancedCapabilities}</summary>
          <div className="automation-configuration-fields">
            <div className="automation-editor-field-grid">
              <Field label={t.profile}>
                <Input disabled={props.busy} label={t.profile} onChange={(event) => setState({ ...state, profileName: event.target.value })} placeholder={t.inherited} value={state.profileName} />
              </Field>
            </div>
            {(['tools', 'skills', 'plugins', 'mcpServers'] as const).map((key) => (
              <Field as="div" key={key} label={t[key]}>
                <div className="automation-capability-list">
                  <SegmentedControl
                    className="automation-capability-mode"
                    disabled={props.busy}
                    label={t[key]}
                    onChange={(mode) => setState({ ...state, [key]: { ...state[key], mode } })}
                    options={[
                      { value: 'inherit', label: t.capabilityModes.inherit },
                      { value: 'none', label: t.capabilityModes.none },
                      { value: 'allowlist', label: t.capabilityModes.allowlist },
                    ]}
                    value={state[key].mode}
                  />
                  {state[key].mode === 'allowlist' ? (
                    <Input
                      disabled={props.busy}
                      label={t[key]}
                      onChange={(event) => setState({
                        ...state,
                        [key]: { ...state[key], value: event.target.value },
                      })}
                      placeholder={t.capabilityListPlaceholder}
                      value={state[key].value}
                    />
                  ) : null}
                </div>
              </Field>
            ))}
          </div>
        </details>

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
  readonly frequency: Frequency;
  readonly startAt: string;
  readonly timezone: string;
  readonly rrule: string;
  readonly destination: 'standalone' | 'existingThread';
  readonly threadId: string;
  readonly projectBindings: readonly ProjectBindingDraft[];
  readonly profileName: string;
  readonly modelProvider: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | '';
  readonly tools: CapabilityListDraft;
  readonly skills: CapabilityListDraft;
  readonly plugins: CapabilityListDraft;
  readonly mcpServers: CapabilityListDraft;
}

interface AutomationModelChoice {
  readonly value: string;
  readonly name: string;
}

interface AutomationModelGroup {
  readonly providerId: string;
  readonly models: readonly AutomationModelChoice[];
}

function automationModelGroups(
  settings: AgentProviderSettingsView | null,
  selectedProviderId: string,
): readonly AutomationModelGroup[] {
  if (!settings) return [];
  const usableProviderIds = settings.providers
    .filter((provider) => isProviderUsable(settings, provider))
    .map((provider) => provider.providerId);
  const providerIds = [...new Set([selectedProviderId, ...usableProviderIds].filter(Boolean))];
  return providerIds.flatMap((providerId) => {
    const models = settings.availableProviders.find((provider) => provider.providerId === providerId)?.models ?? [];
    return models.length === 0 ? [] : [{
      providerId,
      models: models.map((option) => ({
        value: composeProviderQualifiedModel(providerId, option.id),
        name: option.name || option.id,
      })),
    }];
  });
}

function automationModelValue(
  providerId: string,
  model: string,
  groups: readonly AutomationModelGroup[],
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
  const frequency = automation ? frequencyFromRrule(automation.schedule.rrule) : 'daily';
  return {
    name: automation?.name ?? '',
    prompt: automation?.prompt ?? '',
    frequency,
    startAt: automation ? startAtFromRrule(automation.schedule.rrule) : defaultStartAt(),
    timezone: automation?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule: automation?.schedule.rrule ?? '',
    destination: automation?.destination.kind ?? 'standalone',
    threadId: automation?.destination.kind === 'existingThread' ? automation.destination.threadId : '',
    projectBindings: automation?.projectBindings.map((binding) => ({ ...binding })) ?? [],
    profileName: automation?.configuration.profileName ?? '',
    modelProvider: automation?.configuration.modelProvider ?? '',
    model: automation?.configuration.model ?? '',
    reasoningEffort: automation?.configuration.reasoningEffort ?? '',
    tools: capabilityListDraft(automation?.configuration.tools ?? null),
    skills: capabilityListDraft(automation?.configuration.skills ?? null),
    plugins: capabilityListDraft(automation?.configuration.plugins ?? null),
    mcpServers: capabilityListDraft(automation?.configuration.mcpServers ?? null),
  };
}

function stateSignature(state: EditorState): string {
  return JSON.stringify(state);
}

export function scheduleRrule(startAt: string, frequency: Exclude<Frequency, 'custom'>): string {
  const stamp = startAt.replace(/[-:]/g, '');
  const date = new Date(startAt);
  const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][date.getDay()] ?? 'MO';
  const rule = frequency === 'once'
    ? 'FREQ=DAILY;COUNT=1'
    : frequency === 'hourly'
      ? 'FREQ=HOURLY'
      : frequency === 'daily'
        ? 'FREQ=DAILY'
        : `FREQ=WEEKLY;BYDAY=${weekday}`;
  return `DTSTART:${stamp.length === 13 ? `${stamp}00` : stamp}\nRRULE:${rule}`;
}

function replaceBinding(
  bindings: readonly ProjectBindingDraft[],
  index: number,
  value: ProjectBindingDraft,
): readonly ProjectBindingDraft[] {
  return bindings.map((binding, candidate) => candidate === index ? value : binding);
}

export function frequencyFromRrule(rrule: string): Frequency {
  const start = /^DTSTART:(\d{4})(\d{2})(\d{2})T\d{4}(\d{2})$/m.exec(rrule);
  const rule = /^RRULE:(.+)$/m.exec(rrule)?.[1]?.trim().toUpperCase();
  if (!start || start[4] !== '00' || !rule) return 'custom';
  if (rule === 'FREQ=DAILY;COUNT=1') return 'once';
  if (rule === 'FREQ=HOURLY') return 'hourly';
  if (rule === 'FREQ=DAILY') return 'daily';
  const weekly = /^FREQ=WEEKLY;BYDAY=(SU|MO|TU|WE|TH|FR|SA)$/.exec(rule);
  if (weekly) {
    const startDay = new Date(Date.UTC(Number(start[1]), Number(start[2]) - 1, Number(start[3]))).getUTCDay();
    if (weekly[1] === (['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][startDay] ?? 'MO')) return 'weekly';
  }
  return 'custom';
}

function startAtFromRrule(rrule: string): string {
  const match = /DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(rrule);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}` : defaultStartAt();
}

function defaultStartAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1_000);
  date.setMinutes(0, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function nullable(value: string): string | null {
  return value.trim() || null;
}

export function capabilityListDraft(value: readonly string[] | null): CapabilityListDraft {
  if (value === null) return { mode: 'inherit', value: '' };
  if (value.length === 0) return { mode: 'none', value: '' };
  return { mode: 'allowlist', value: value.join(', ') };
}

export function capabilityListValue(draft: CapabilityListDraft): readonly string[] | null {
  if (draft.mode === 'inherit') return null;
  if (draft.mode === 'none') return [];
  return Object.freeze([...new Set(draft.value.split(',').map((item) => item.trim()).filter(Boolean))]);
}

function required(value: string, message: string): string {
  if (!value.trim()) throw new Error(message);
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
