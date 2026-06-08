import { useMemo, useState } from 'react';
import type {
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentPermissionMode,
  AgentReasoningLevel,
  AgentStorageLocation,
  SkillDefinition,
} from '../../api/types';
import { parseAgentAuthoringInput, serializeAgentMarkdown } from '../../../core/agentMarkdown';
import { useT } from '../../i18n/I18nProvider';
import { ButtonControl } from '../primitives/ButtonControl';
import { FormField } from '../primitives/FormField';
import { NumberInputControl } from '../primitives/NumberInputControl';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { TextInputControl } from '../primitives/TextInputControl';
import { InsetGroup, InsetRow } from './SettingsInsetList';

// The create/edit surface for a user-authored agent definition. Two modes that
// convert on toggle (the form decision in [[agent-authoring]]): a structured
// **Form** and a raw **AGENT.md** editor — switching Form→Raw serializes the
// current fields, Raw→Form re-parses, so the two are always the same data. A
// built-in renders read-only with a one-click "Duplicate to my agents". The
// component owns its form state and is reset by the parent via `key`.

const REASONING_OPTIONS: readonly AgentReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// The common subagent tools offered as toggles (curated — the outliner/node and
// helper tools are omitted as too internal). Names are the canonical lowercase
// forms the runtime tool filter matches (agentTools.ts:filterAgentTools).
const TOOL_CATALOG: readonly string[] = [
  'file_read', 'file_glob', 'file_grep', 'file_edit', 'file_write',
  'bash', 'web_search', 'web_fetch', 'agent',
];

type EditorMode = 'form' | 'raw';

interface AgentEditorProps {
  // null → create mode (blank form). Otherwise edit (user/project) or read-only
  // display (built-in).
  agent: AgentDefinitionView | null;
  availableSkills: SkillDefinition[];
  busy: boolean;
  onCreate: (input: AgentAuthoringInput, storage: AgentStorageLocation) => void;
  onUpdate: (agentId: string, input: AgentAuthoringInput) => void;
  onDelete: (agent: AgentDefinitionView) => void;
  onDuplicate: (agent: AgentDefinitionView) => void;
}

interface AgentFormState {
  name: string;
  description: string;
  body: string;
  model: string;
  effort: string;
  permissionMode: '' | AgentPermissionMode;
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

export function AgentEditor({ agent, availableSkills, busy, onCreate, onUpdate, onDelete, onDuplicate }: AgentEditorProps) {
  const t = useT().settings.agents;
  const isBuiltIn = agent?.source === 'built-in';
  const skillNames = useMemo(() => availableSkills.map((skill) => skill.name), [availableSkills]);
  const [form, setForm] = useState<AgentFormState>(() => seedForm(agent, skillNames));
  const [mode, setMode] = useState<EditorMode>('form');
  const [rawText, setRawText] = useState('');
  const [storage, setStorage] = useState<AgentStorageLocation>('user');
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
    if (agent) onUpdate(agent.agentId, input);
    else onCreate(input, storage);
  }

  // Read-only built-in: specs + the only available action (duplicate).
  if (agent && isBuiltIn) {
    return (
      <div className="agent-editor agent-editor-readonly">
        <header className="agent-editor-header">
          <h4 className="agent-profile-title">{agent.displayName || agent.name}</h4>
          <span className="agent-profile-source-label">{t.sourceLabel({ source: agent.source })}</span>
        </header>
        <p className="agent-editor-hint">{t.builtInReadOnly}</p>
        <AgentSpecsReadonly agent={agent} />
        <div className="agent-editor-actions">
          <ButtonControl className="agent-settings-primary" disabled={busy} onClick={() => onDuplicate(agent)}>
            {t.duplicateToMine}
          </ButtonControl>
        </div>
      </div>
    );
  }

  const toolsAll = TOOL_CATALOG.every((name) => form.tools.includes(name)) && form.extraTools.length === 0;

  return (
    <div className="agent-editor">
      <header className="agent-editor-header">
        <h4 className="agent-profile-title">{agent ? t.editTitle({ name: agent.displayName || agent.name }) : t.createTitle}</h4>
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
        <FormField as="label" className="agent-editor-persona" label={<span className="agent-profile-field-label">{t.rawLabel}</span>}>
          <textarea
            aria-label={t.rawLabel}
            className="agent-profile-prompt-editor agent-editor-raw"
            onChange={(event) => { setRawText(event.target.value); setLocalError(null); }}
            spellCheck={false}
            value={rawText}
          />
        </FormField>
      ) : (
        <>
          <div className="inset-card agent-editor-fields" role="group">
            <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.nameLabel}</span>}>
              <TextInputControl className="settings-sheet-row-input" label={t.nameLabel} onChange={(e) => update('name', e.target.value)} placeholder={t.namePlaceholder} value={form.name} />
            </FormField>
            <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.descriptionLabel}</span>}>
              <TextInputControl className="settings-sheet-row-input" label={t.descriptionLabel} onChange={(e) => update('description', e.target.value)} placeholder={t.descriptionPlaceholder} value={form.description} />
            </FormField>
            <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.modelOverride}</span>}>
              <TextInputControl className="settings-sheet-row-input" label={t.modelOverride} onChange={(e) => update('model', e.target.value)} placeholder={t.modelPlaceholder} value={form.model} />
            </FormField>
            <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.thinkingLevel}</span>}>
              <SelectControl className="settings-sheet-row-input" label={t.thinkingLevel} onChange={(e) => update('effort', e.target.value)} value={form.effort} variant="popup">
                <option value="">{t.effortDefault}</option>
                {REASONING_OPTIONS.map((level) => <option key={level} value={level}>{level}</option>)}
              </SelectControl>
            </FormField>
            <FormField as="div" className="settings-sheet-row settings-sheet-row-control" label={<span className="settings-sheet-row-label">{t.permissionMode}</span>}>
              <SegmentedControl<'' | AgentPermissionMode>
                label={t.permissionMode}
                onChange={(value) => update('permissionMode', value)}
                options={[
                  { value: '', label: t.permissionInherit },
                  { value: 'restricted', label: t.restricted },
                  { value: 'trusted', label: t.trusted },
                ]}
                value={form.permissionMode}
              />
            </FormField>
            <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.maxTurns}</span>}>
              <NumberInputControl className="settings-sheet-row-input" label={t.maxTurns} min={1} onChange={(e) => update('maxTurns', e.target.value)} placeholder={t.maxTurnsPlaceholder} value={form.maxTurns} />
            </FormField>
            <div className="settings-sheet-row settings-sheet-row-switch">
              <div className="settings-sheet-row-text">
                <span className="settings-sheet-row-label">{t.backgroundLabel}</span>
                <span className="agent-editor-field-hint">{t.backgroundSublabel}</span>
              </div>
              <SwitchControl checked={form.background} label={t.backgroundLabel} onCheckedChange={(v) => update('background', v)}>
                <SwitchMark checked={form.background} />
              </SwitchControl>
            </div>
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

          <FormField as="label" className="agent-editor-persona" label={<span className="agent-profile-field-label">{t.personaPromptLabel}</span>}>
            <textarea aria-label={t.personaPromptLabel} className="agent-profile-prompt-editor" onChange={(e) => update('body', e.target.value)} placeholder={t.personaPlaceholder} value={form.body} />
          </FormField>
        </>
      )}

      {!agent ? (
        <FormField as="div" className="settings-sheet-row settings-sheet-row-control" label={<span className="settings-sheet-row-label">{t.storageLabel}</span>}>
          <SegmentedControl<AgentStorageLocation>
            label={t.storageLabel}
            onChange={setStorage}
            options={[
              { value: 'user', label: t.storageUser },
              { value: 'project', label: t.storageProject },
            ]}
            value={storage}
          />
        </FormField>
      ) : null}

      {localError ? <div className="agent-settings-alert" role="alert"><span>{localError}</span></div> : null}

      <div className="agent-editor-actions">
        {agent ? (
          <ButtonControl className="agent-settings-secondary agent-editor-delete" disabled={busy} onClick={() => onDelete(agent)}>
            {t.deleteAgent}
          </ButtonControl>
        ) : <span />}
        <ButtonControl className="agent-settings-primary" disabled={busy} onClick={submit}>
          {agent ? t.saveAgent : t.createAgent}
        </ButtonControl>
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
        <div className="agent-settings-empty">{emptyText}</div>
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

function AgentSpecsReadonly({ agent }: { agent: AgentDefinitionView }) {
  const t = useT().settings.agents;
  return (
    <>
      <div className="agent-profile-field">
        <span className="agent-profile-field-label">{t.personaPromptLabel}</span>
        <textarea className="agent-profile-prompt-preview" readOnly value={agent.body || t.noInstructionBody} />
      </div>
      <div className="agent-profile-specs">
        <div className="spec-item">
          <span className="spec-label">{t.modelOverride}</span>
          <span className="spec-value">{agent.model || t.inheritParent}</span>
        </div>
        <div className="spec-item">
          <span className="spec-label">{t.thinkingLevel}</span>
          <span className="spec-value">{typeof agent.effort === 'string' && agent.effort ? agent.effort : t.defaultValue}</span>
        </div>
        <div className="spec-item">
          <span className="spec-label">{t.permissionMode}</span>
          <span className="spec-value">{agent.permissionMode || t.restricted}</span>
        </div>
        <div className="spec-item">
          <span className="spec-label">{t.maxTurns}</span>
          <span className="spec-value">{agent.maxTurns || t.unlimited}</span>
        </div>
      </div>
      {agent.tools && agent.tools.length > 0 ? (
        <div className="agent-profile-field">
          <span className="agent-profile-field-label">{t.enabledTools}</span>
          <div className="agent-profile-tags-container">
            {agent.tools.map((tool) => <span className="settings-chip" key={tool}>{tool}</span>)}
          </div>
        </div>
      ) : null}
    </>
  );
}

function toggleMember(list: string[], member: string): string[] {
  return list.includes(member) ? list.filter((item) => item !== member) : [...list, member];
}

function seedForm(agent: AgentDefinitionView | null, skillNames: string[]): AgentFormState {
  if (!agent) {
    return {
      name: '', description: '', body: '', model: '', effort: '', permissionMode: '', maxTurns: '', background: false,
      tools: [...TOOL_CATALOG], extraTools: [], skills: [], extraSkills: [], disallowedTools: [],
    };
  }
  return inputToForm(
    {
      name: agent.displayName || agent.name,
      description: agent.description,
      body: agent.body,
      model: agent.model,
      effort: typeof agent.effort === 'string' ? agent.effort : undefined,
      permissionMode: agent.permissionMode,
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
  const extraTools = unrestricted ? [] : rawTools.filter((tool) => tool !== '*' && !TOOL_CATALOG.includes(tool.toLowerCase()));
  const rawSkills = input.skills ?? [];
  return {
    name: input.name,
    description: input.description,
    body: input.body,
    model: input.model ?? '',
    effort: input.effort ?? '',
    permissionMode: input.permissionMode ?? '',
    maxTurns: input.maxTurns ? String(input.maxTurns) : '',
    background: input.background ?? false,
    tools,
    extraTools,
    skills: rawSkills.filter((skill) => skillNames.includes(skill)),
    extraSkills: rawSkills.filter((skill) => !skillNames.includes(skill)),
    disallowedTools: input.disallowedTools ?? [],
  };
}

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
    permissionMode: form.permissionMode || undefined,
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
