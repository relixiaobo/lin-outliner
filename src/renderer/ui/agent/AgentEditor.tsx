import { useState } from 'react';
import type {
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentPermissionMode,
  AgentReasoningLevel,
  AgentStorageLocation,
} from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { ButtonControl } from '../primitives/ButtonControl';
import { FormField } from '../primitives/FormField';
import { NumberInputControl } from '../primitives/NumberInputControl';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { TextInputControl } from '../primitives/TextInputControl';

// The structured create/edit surface for a user-authored agent definition. A
// built-in agent renders read-only (immutable) with a one-click "Duplicate to my
// agents". The persona body is a raw multiline editor (the form decision in
// [[agent-authoring]]); all other fields are structured controls. The component
// owns its own form state and is reset by the parent via `key` on selection.

const REASONING_OPTIONS: readonly AgentReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

interface AgentEditorProps {
  // null → create mode (blank form). Otherwise edit (user/project) or read-only
  // display (built-in).
  agent: AgentDefinitionView | null;
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
  toolsText: string;
  skillsText: string;
  background: boolean;
}

export function AgentEditor({ agent, busy, onCreate, onUpdate, onDelete, onDuplicate }: AgentEditorProps) {
  const t = useT().settings.agents;
  const isBuiltIn = agent?.source === 'built-in';
  const [form, setForm] = useState<AgentFormState>(() => seedForm(agent));
  const [storage, setStorage] = useState<AgentStorageLocation>('user');
  const [localError, setLocalError] = useState<string | null>(null);

  function update<K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setLocalError(null);
  }

  function submit() {
    if (!form.name.trim()) {
      setLocalError(t.nameRequired);
      return;
    }
    const input = toAuthoringInput(form);
    if (agent) onUpdate(agent.agentId, input);
    else onCreate(input, storage);
  }

  // Read-only built-in: show specs + the only available action (duplicate).
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

  return (
    <div className="agent-editor">
      <header className="agent-editor-header">
        <h4 className="agent-profile-title">{agent ? t.editTitle({ name: agent.displayName || agent.name }) : t.createTitle}</h4>
        {agent ? <span className="agent-profile-source-label">{t.sourceLabel({ source: agent.source })}</span> : null}
      </header>

      <div className="inset-card agent-editor-fields" role="group">
        <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.nameLabel}</span>}>
          <TextInputControl
            className="settings-sheet-row-input"
            label={t.nameLabel}
            onChange={(event) => update('name', event.target.value)}
            placeholder={t.namePlaceholder}
            value={form.name}
          />
        </FormField>
        <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.descriptionLabel}</span>}>
          <TextInputControl
            className="settings-sheet-row-input"
            label={t.descriptionLabel}
            onChange={(event) => update('description', event.target.value)}
            placeholder={t.descriptionPlaceholder}
            value={form.description}
          />
        </FormField>
        <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.modelOverride}</span>}>
          <TextInputControl
            className="settings-sheet-row-input"
            label={t.modelOverride}
            onChange={(event) => update('model', event.target.value)}
            placeholder={t.modelPlaceholder}
            value={form.model}
          />
        </FormField>
        <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.thinkingLevel}</span>}>
          <SelectControl
            className="settings-sheet-row-input"
            label={t.thinkingLevel}
            onChange={(event) => update('effort', event.target.value)}
            value={form.effort}
            variant="popup"
          >
            <option value="">{t.effortDefault}</option>
            {REASONING_OPTIONS.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </SelectControl>
        </FormField>
        <FormField as="div" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.permissionMode}</span>}>
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
          <NumberInputControl
            className="settings-sheet-row-input"
            label={t.maxTurns}
            min={1}
            onChange={(event) => update('maxTurns', event.target.value)}
            placeholder={t.maxTurnsPlaceholder}
            value={form.maxTurns}
          />
        </FormField>
        <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.toolsLabel}</span>}>
          <TextInputControl
            className="settings-sheet-row-input"
            label={t.toolsLabel}
            onChange={(event) => update('toolsText', event.target.value)}
            placeholder={t.toolsPlaceholder}
            value={form.toolsText}
          />
          <span className="agent-editor-field-hint">{t.toolsSublabel}</span>
        </FormField>
        <FormField as="label" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.skillsLabel}</span>}>
          <TextInputControl
            className="settings-sheet-row-input"
            label={t.skillsLabel}
            onChange={(event) => update('skillsText', event.target.value)}
            value={form.skillsText}
          />
          <span className="agent-editor-field-hint">{t.skillsSublabel}</span>
        </FormField>
        <div className="settings-sheet-row settings-sheet-row-switch">
          <div className="settings-sheet-row-text">
            <span className="settings-sheet-row-label">{t.backgroundLabel}</span>
            <span className="agent-editor-field-hint">{t.backgroundSublabel}</span>
          </div>
          <SwitchControl
            checked={form.background}
            label={t.backgroundLabel}
            onCheckedChange={(background) => update('background', background)}
          >
            <SwitchMark checked={form.background} />
          </SwitchControl>
        </div>
      </div>

      <FormField as="label" className="agent-editor-persona" label={<span className="agent-profile-field-label">{t.personaPromptLabel}</span>}>
        <textarea
          className="agent-profile-prompt-editor"
          onChange={(event) => update('body', event.target.value)}
          placeholder={t.personaPlaceholder}
          value={form.body}
        />
      </FormField>

      {!agent ? (
        <FormField as="div" className="settings-sheet-row" label={<span className="settings-sheet-row-label">{t.storageLabel}</span>}>
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

function seedForm(agent: AgentDefinitionView | null): AgentFormState {
  if (!agent) {
    return { name: '', description: '', body: '', model: '', effort: '', permissionMode: '', maxTurns: '', toolsText: '', skillsText: '', background: false };
  }
  return {
    name: agent.displayName || agent.name,
    description: agent.description,
    body: agent.body,
    model: agent.model ?? '',
    effort: typeof agent.effort === 'string' ? agent.effort : '',
    permissionMode: agent.permissionMode ?? '',
    maxTurns: agent.maxTurns ? String(agent.maxTurns) : '',
    toolsText: (agent.tools ?? []).join(', '),
    skillsText: (agent.skills ?? []).join(', '),
    background: agent.background ?? false,
  };
}

function toAuthoringInput(form: AgentFormState): AgentAuthoringInput {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    body: form.body,
    model: form.model.trim() || undefined,
    effort: form.effort || undefined,
    permissionMode: form.permissionMode || undefined,
    maxTurns: parsePositiveInt(form.maxTurns),
    tools: splitList(form.toolsText),
    skills: splitList(form.skillsText),
    background: form.background || undefined,
  };
}

function splitList(value: string): string[] | undefined {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : undefined;
}

function parsePositiveInt(value: string): number | undefined {
  const numeric = Number(value.trim());
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}
