import { useEffect, useMemo, useState } from 'react';
import type { Automation, AutomationCreateInput, AutomationUpdateInput } from '../../../core/agent/automation';
import type { Thread } from '../../../core/agent/protocol';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../../core/agent/configuration';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, TrashIcon } from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';
import { Field } from '../../ui/primitives/Field';
import { Input } from '../../ui/primitives/Input';
import { SegmentedControl } from '../../ui/primitives/SegmentedControl';
import { SelectControl } from '../../ui/primitives/SelectControl';
import { Textarea } from '../../ui/primitives/Textarea';
import { IconButton } from '../../ui/primitives/IconButton';

type Frequency = 'once' | 'hourly' | 'daily' | 'weekly' | 'custom';
type ProjectMode = 'none' | 'local' | 'worktree';
type ProjectBindingDraft = {
  readonly id: string;
  readonly cwd: string;
  readonly executionMode: Exclude<ProjectMode, 'none'>;
};
export interface CapabilityListDraft {
  readonly mode: 'inherit' | 'explicit';
  readonly value: string;
}

interface AutomationEditorProps {
  readonly automation: Automation | null;
  readonly threads: readonly Thread[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onCreate: (input: AutomationCreateInput) => Promise<void>;
  readonly onUpdate: (input: AutomationUpdateInput) => Promise<void>;
}

export function AutomationEditor(props: AutomationEditorProps) {
  const t = useT().agent.automations;
  const initial = useMemo(() => editorState(props.automation), [props.automation]);
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setState(initial);
    setError(null);
  }, [initial]);

  const destinationThreads = props.threads.filter((thread) => (
    !thread.ephemeral && thread.parentThreadId === null && thread.threadSource === 'user'
  ));

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
        : { kind: 'existingThread' as const, threadId: required(state.threadId, t.thread) };
      const projectBindings = state.projectBindings.map((binding) => ({
        ...binding,
        id: binding.id || crypto.randomUUID(),
        cwd: required(binding.cwd, t.cwd),
      }));
      const definition: AutomationCreateInput = {
        name: state.name.trim(),
        prompt: state.prompt.trim(),
        schedule: {
          rrule: state.frequency === 'custom'
            ? required(state.rrule, t.rrule)
            : scheduleRrule(state.startAt, state.frequency),
          timezone: required(state.timezone, t.timezone),
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
      if (props.automation) {
        await props.onUpdate({
          id: props.automation.id,
          expectedRevision: props.automation.revision,
          ...definition,
        });
      } else {
        await props.onCreate(definition);
      }
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  }

  return (
    <form className="automation-editor" onSubmit={(event) => void submit(event)}>
      <div className="automation-editor-scroll">
        <Field label={t.name}>
          <Input
            disabled={props.busy}
            label={t.name}
            onChange={(event) => setState({ ...state, name: event.target.value })}
            value={state.name}
          />
        </Field>
        <Field label={t.prompt}>
          <Textarea
            className="automation-prompt-input"
            disabled={props.busy}
            label={t.prompt}
            onChange={(event) => setState({ ...state, prompt: event.target.value })}
            rows={5}
            value={state.prompt}
          />
        </Field>

        <section className="automation-editor-section">
          <h3>{t.schedule}</h3>
          <Field as="div" label={t.frequency}>
            <SegmentedControl
              className="automation-editor-segments"
              label={t.frequency}
              onChange={(frequency) => setState({ ...state, frequency })}
              options={([
                ['once', t.frequencies.once],
                ['hourly', t.frequencies.hourly],
                ['daily', t.frequencies.daily],
                ['weekly', t.frequencies.weekly],
                ['custom', t.frequencies.custom],
              ] as const).map(([value, label]) => ({ value, label }))}
              value={state.frequency}
            />
          </Field>
          {state.frequency !== 'custom' ? (
            <Field label={t.startAt}>
              <Input
                disabled={props.busy}
                label={t.startAt}
                onChange={(event) => setState({ ...state, startAt: event.target.value })}
                type="datetime-local"
                value={state.startAt}
              />
            </Field>
          ) : null}
          <Field label={t.timezone}>
            <Input
              disabled={props.busy}
              label={t.timezone}
              onChange={(event) => setState({ ...state, timezone: event.target.value })}
              value={state.timezone}
            />
          </Field>
          {state.frequency === 'custom' ? (
            <Field label={t.rrule}>
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

        <section className="automation-editor-section">
          <h3>{t.destination}</h3>
          <SegmentedControl
            className="automation-editor-segments"
            label={t.destination}
            onChange={(destination) => setState({
              ...state,
              destination,
              projectBindings: destination === 'existingThread'
                ? state.projectBindings.slice(0, 1).map((binding) => ({
                    ...binding,
                    executionMode: 'local' as const,
                  }))
                : state.projectBindings,
            })}
            options={[
              { value: 'standalone', label: t.destinations.standalone },
              { value: 'existingThread', label: t.destinations.existingThread },
            ]}
            value={state.destination}
          />
          {state.destination === 'existingThread' ? (
            <Field label={t.thread}>
              <SelectControl
                label={t.thread}
                onChange={(event) => setState({ ...state, threadId: event.target.value })}
                value={state.threadId}
                variant="boxed"
              >
                <option value="">{t.thread}</option>
                {destinationThreads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.name || thread.preview || thread.id}
                  </option>
                ))}
              </SelectControl>
            </Field>
          ) : null}
        </section>

        <section className="automation-editor-section">
          <h3>{t.project}</h3>
          <SegmentedControl
            className="automation-editor-segments"
            label={t.project}
            onChange={(projectMode) => setState({
              ...state,
              projectBindings: projectMode === 'none'
                ? []
                : state.projectBindings.length === 0
                  ? [{ id: crypto.randomUUID(), cwd: '', executionMode: projectMode }]
                  : state.projectBindings.map((binding, index) => (
                      index === 0 ? { ...binding, executionMode: projectMode } : binding
                    )),
            })}
            options={[
              { value: 'none', label: t.projects.none },
              { value: 'local', label: t.projects.local },
              ...(state.destination === 'standalone'
                ? [{ value: 'worktree' as const, label: t.projects.worktree }]
                : []),
            ]}
            value={state.projectBindings[0]?.executionMode ?? 'none'}
          />
          {state.projectBindings.map((binding, index) => (
            <div className={`automation-project-binding${index === 0 ? ' is-primary' : ''}`} key={binding.id || index}>
              {index > 0 ? (
                <SelectControl
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
          {state.destination === 'standalone' && state.projectBindings.length > 0 ? (
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
        </section>

        <details className="automation-configuration">
          <summary>{t.configuration}</summary>
          <Field label={t.profile}>
            <Input label={t.profile} onChange={(event) => setState({ ...state, profileName: event.target.value })} placeholder={t.inherited} value={state.profileName} />
          </Field>
          <Field label={t.modelProvider}>
            <Input label={t.modelProvider} onChange={(event) => setState({ ...state, modelProvider: event.target.value })} placeholder={t.inherited} value={state.modelProvider} />
          </Field>
          <Field label={t.model}>
            <Input label={t.model} onChange={(event) => setState({ ...state, model: event.target.value })} placeholder={t.inherited} value={state.model} />
          </Field>
          <Field label={t.reasoning}>
            <SelectControl label={t.reasoning} onChange={(event) => setState({ ...state, reasoningEffort: event.target.value as ReasoningEffort | '' })} value={state.reasoningEffort} variant="boxed">
              <option value="">{t.inherited}</option>
              {REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </SelectControl>
          </Field>
          {(['tools', 'skills', 'plugins', 'mcpServers'] as const).map((key) => (
            <Field as="div" key={key} label={t[key]}>
              <div className="automation-capability-list">
                <SegmentedControl
                  className="automation-capability-mode"
                  label={t[key]}
                  onChange={(mode) => setState({ ...state, [key]: { ...state[key], mode } })}
                  options={[
                    { value: 'inherit', label: t.inherited },
                    { value: 'explicit', label: t.explicit },
                  ]}
                  value={state[key].mode}
                />
                <Input
                  disabled={props.busy || state[key].mode === 'inherit'}
                  label={t[key]}
                  onChange={(event) => setState({
                    ...state,
                    [key]: { ...state[key], value: event.target.value },
                  })}
                  value={state[key].value}
                />
              </div>
            </Field>
          ))}
        </details>
        {error ? <p className="automation-error" role="alert">{error}</p> : null}
      </div>
      <footer className="automation-editor-actions">
        <Button disabled={props.busy} onClick={props.onCancel} variant="ghost">{t.cancel}</Button>
        <Button disabled={props.busy} type="submit" variant="primary">
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
  return value === null
    ? { mode: 'inherit', value: '' }
    : { mode: 'explicit', value: value.join(', ') };
}

export function capabilityListValue(draft: CapabilityListDraft): readonly string[] | null {
  if (draft.mode === 'inherit') return null;
  return Object.freeze([...new Set(draft.value.split(',').map((item) => item.trim()).filter(Boolean))]);
}

function required(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
