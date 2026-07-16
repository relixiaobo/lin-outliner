import { useMemo, useState } from 'react';
import type {
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentProviderSettingsView,
  AgentReasoningLevel,
  SkillDefinition,
} from '../../api/types';
import { parseAgentAuthoringInput, serializeAgentMarkdown } from '../../../core/agentMarkdown';
import { TOOL_CATALOG } from '../../../core/agentToolCatalog';
import { AGENT_REASONING_LADDER } from '../../../core/types';
import { useT } from '../../i18n/I18nProvider';
import { AgentModelEffortSelector } from './AgentModelEffortSelector';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/FeedbackState';
import { Field } from '../primitives/Field';
import { Input } from '../primitives/Input';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';

// The edit surface for the one agent, the built-in Neva (the one-Neva invariant:
// no second agent can be created or loaded). ONE abstraction with two modes that
// convert on toggle (the form decision in [[agent-authoring]]) — a structured
// **Form** and a raw **AGENT.md** editor. Switching Form→Raw serializes the current
// fields, Raw→Form re-parses, so the two views are always the same data. Neva is
// edited in place (her edits persist to the settings overlay, not a file). The
// component owns its form state and is reset by the parent via `key`.

type EditorMode = 'form' | 'raw';

interface AgentEditorProps {
  agent: AgentDefinitionView;
  availableSkills: SkillDefinition[];
  // Provider connections, for the capability-driven model/effort selector. Null
  // while still loading.
  providerSettings: AgentProviderSettingsView | null;
  busy: boolean;
  onUpdate: (agentId: string, input: AgentAuthoringInput) => void;
  onCancel?: () => void;
}

interface AgentFormState {
  name: string;
  description: string;
  body: string;
  model: string;
  effort: string;
  maxTurns: string;
  background: boolean;
  // Allowed tools: catalog names that are checked. All-checked (or none) ⇒ the
  // agent inherits every tool (the `tools` field is omitted). A proper subset is
  // stored. `extraTools` preserves any tool in the file that is outside the
  // catalog so editing in Form mode never silently drops it.
  tools: string[];
  extraTools: string[];
  // Preloaded skills the agent may use; `extraSkills` preserves any not in the
  // installed list.
  skills: string[];
  extraSkills: string[];
  // Carried through (advanced; editable only in Raw mode).
  disallowedTools: string[];
}

export function AgentEditor({ agent, availableSkills, providerSettings, busy, onUpdate, onCancel }: AgentEditorProps) {
  const messages = useT();
  const t = messages.settings.agents;
  const skillNames = useMemo(() => availableSkills.map((skill) => skill.name), [availableSkills]);
  const [form, setForm] = useState<AgentFormState>(() => seedForm(agent, skillNames));
  const [mode, setMode] = useState<EditorMode>('form');
  const [rawText, setRawText] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function update<K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setLocalError(null);
  }

  function switchMode(next: EditorMode) {
    if (next === mode) return;
    if (next === 'raw') {
      setRawText(serializeAgentMarkdown(buildInput(form)));
    } else {
      setForm(inputToForm(parseAgentAuthoringInput(rawText), skillNames));
    }
    setMode(next);
    setLocalError(null);
  }

  function currentInput(): AgentAuthoringInput {
    return mode === 'raw' ? parseAgentAuthoringInput(rawText) : buildInput(form);
  }

  function submit() {
    const input = currentInput();
    if (!input.name.trim()) {
      setLocalError(t.nameRequired);
      return;
    }
    onUpdate(agent.agentId, input);
  }

  const toolsAll = TOOL_CATALOG.every((name) => form.tools.includes(name)) && form.extraTools.length === 0;

  return (
    <div className="agent-editor">
      <header className="agent-editor-header">
        <h4 className="agent-profile-title">{t.editTitle({ name: agent.displayName || agent.name })}</h4>
        <SegmentedControl<EditorMode>
          label={t.modeLabel}
          onChange={switchMode}
          options={[
            { value: 'form', label: t.modeForm },
            { value: 'raw', label: t.modeRaw },
          ]}
          value={mode}
        />
      </header>

      {mode === 'raw' ? (
        <Field as="label" className="agent-editor-persona" label={t.rawLabel} labelClassName="agent-profile-field-label">
          <textarea
            aria-label={t.rawLabel}
            className="agent-profile-prompt-editor agent-editor-raw"
            onChange={(event) => { setRawText(event.target.value); setLocalError(null); }}
            spellCheck={false}
            value={rawText}
          />
        </Field>
      ) : (
        <>
          <div className="inset-card agent-editor-fields" role="group">
            <Field as="label" className="settings-sheet-row" label={t.nameLabel} labelClassName="settings-sheet-row-label">
              <Input className="settings-sheet-row-input" label={t.nameLabel} onChange={(e) => update('name', e.target.value)} placeholder={t.namePlaceholder} value={form.name} variant="bare" />
            </Field>
            <Field as="label" className="settings-sheet-row" label={t.descriptionLabel} labelClassName="settings-sheet-row-label">
              <Input className="settings-sheet-row-input" label={t.descriptionLabel} onChange={(e) => update('description', e.target.value)} placeholder={t.descriptionPlaceholder} value={form.description} variant="bare" />
            </Field>
            <AgentModelEffortSelector
              effort={form.effort}
              effortLabel={t.thinkingLevel}
              inheritLabel={t.effortDefault}
              model={form.model}
              modelLabel={t.modelOverride}
              providerLabel={t.providerOverride}
              onEffortChange={(value) => update('effort', value)}
              onModelChange={(value) => update('model', value)}
              settings={providerSettings}
            />
          </div>

          <ToggleList
            ariaLabel={t.toolsLabel}
            footnote={toolsAll ? t.toolsAllEnabled : t.toolsSublabel}
            items={TOOL_CATALOG.map((name) => ({ key: name, label: name, on: form.tools.includes(name) }))}
            label={t.toolsLabel}
            onToggle={(name) => update('tools', toggleMember(form.tools, name))}
            toggleLabel={(name) => t.toggleTool({ name })}
          />

          <ToggleList
            ariaLabel={t.skillsLabel}
            emptyText={t.skillsEmpty}
            footnote={t.skillsSublabel}
            items={availableSkills.map((skill) => ({ key: skill.name, label: skill.displayName || skill.name, on: form.skills.includes(skill.name) }))}
            label={t.skillsLabel}
            onToggle={(name) => update('skills', toggleMember(form.skills, name))}
            toggleLabel={(name) => t.toggleSkill({ name })}
          />

          <Field as="label" className="agent-editor-persona" label={t.personaPromptLabel} labelClassName="agent-profile-field-label">
            <textarea aria-label={t.personaPromptLabel} className="agent-profile-prompt-editor" onChange={(e) => update('body', e.target.value)} placeholder={t.personaPlaceholder} value={form.body} />
          </Field>
        </>
      )}

      {localError ? <div className="agent-settings-alert" role="alert"><span>{localError}</span></div> : null}

      <div className="agent-editor-actions">
        <span />
        <span className="agent-editor-actions-right">
          {onCancel ? (
            <Button disabled={busy} onClick={onCancel} variant="ghost">
              {messages.dialog.cancel}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={submit} variant="primary">
            {t.saveAgent}
          </Button>
        </span>
      </div>
    </div>
  );
}

interface ToggleListProps {
  ariaLabel: string;
  label: string;
  items: Array<{ key: string; label: string; on: boolean }>;
  footnote?: string;
  emptyText?: string;
  onToggle: (key: string) => void;
  toggleLabel: (key: string) => string;
}

function ToggleList({ ariaLabel, label, items, footnote, emptyText, onToggle, toggleLabel }: ToggleListProps) {
  if (items.length === 0 && emptyText) {
    return (
      <InsetGroup ariaLabel={ariaLabel} label={label} footnote={footnote}>
        <EmptyState className="agent-settings-empty" size="inline" title={emptyText} />
      </InsetGroup>
    );
  }
  return (
    <InsetGroup ariaLabel={ariaLabel} label={label} footnote={footnote}>
      {items.map((item) => (
        <InsetRow
          key={item.key}
          label={item.label}
          trailing={(
            <SwitchControl checked={item.on} label={toggleLabel(item.key)} onCheckedChange={() => onToggle(item.key)}>
              <SwitchMark checked={item.on} />
            </SwitchControl>
          )}
        />
      ))}
    </InsetGroup>
  );
}

function toggleMember(list: string[], member: string): string[] {
  return list.includes(member) ? list.filter((item) => item !== member) : [...list, member];
}

function seedForm(agent: AgentDefinitionView, skillNames: string[]): AgentFormState {
  return inputToForm(
    {
      name: agent.displayName || agent.name,
      description: agent.description,
      body: agent.body,
      model: agent.model,
      effort: typeof agent.effort === 'string' ? agent.effort : undefined,
      maxTurns: agent.maxTurns,
      tools: agent.tools,
      disallowedTools: agent.disallowedTools,
      skills: agent.skills,
      background: agent.background,
    },
    skillNames,
  );
}

function inputToForm(input: AgentAuthoringInput, skillNames: string[]): AgentFormState {
  const rawTools = input.tools ?? [];
  const unrestricted = rawTools.length === 0 || rawTools.some((tool) => tool === '*');
  const tools = unrestricted ? [...TOOL_CATALOG] : TOOL_CATALOG.filter((name) => rawTools.some((tool) => tool.toLowerCase() === name));
  const extraTools = unrestricted ? [] : rawTools.filter((tool) => tool !== '*' && !isCatalogToolName(tool.toLowerCase()));
  const rawSkills = input.skills ?? [];
  return {
    name: input.name,
    description: input.description,
    body: input.body,
    model: input.model ?? '',
    effort: normalizeReasoningEffort(input.effort),
    maxTurns: input.maxTurns ? String(input.maxTurns) : '',
    background: input.background ?? false,
    tools,
    extraTools,
    skills: rawSkills.filter((skill) => skillNames.includes(skill)),
    extraSkills: rawSkills.filter((skill) => !skillNames.includes(skill)),
    disallowedTools: input.disallowedTools ?? [],
  };
}

function normalizeReasoningEffort(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return '';
  return isReasoningOption(normalized) ? normalized : '';
}

function isReasoningOption(value: string): value is AgentReasoningLevel {
  return (AGENT_REASONING_LADDER as readonly string[]).includes(value);
}

function isCatalogToolName(value: string): value is (typeof TOOL_CATALOG)[number] {
  return (TOOL_CATALOG as readonly string[]).includes(value);
}

// `maxTurns` / `background` have no dedicated Form control (only
// name / description / model / effort / tools / skills / persona do). They are still
// seeded and re-serialized here so a Form-mode save never clobbers values authored in
// Raw mode — the same lossless-preservation rule as non-catalog tools. Edit them in Raw.
function buildInput(form: AgentFormState): AgentAuthoringInput {
  const selected = TOOL_CATALOG.filter((name) => form.tools.includes(name));
  const unrestricted = selected.length === TOOL_CATALOG.length && form.extraTools.length === 0;
  const tools = unrestricted ? undefined : [...selected, ...form.extraTools];
  const skills = [...form.skills, ...form.extraSkills];
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    body: form.body,
    model: form.model.trim() || undefined,
    effort: form.effort || undefined,
    maxTurns: parsePositiveInt(form.maxTurns),
    tools: tools && tools.length > 0 ? tools : undefined,
    disallowedTools: form.disallowedTools.length > 0 ? form.disallowedTools : undefined,
    skills: skills.length > 0 ? skills : undefined,
    background: form.background || undefined,
  };
}

function parsePositiveInt(value: string): number | undefined {
  const numeric = Number(value.trim());
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}
