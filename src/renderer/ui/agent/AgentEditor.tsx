import { useMemo, useState } from 'react';
import type {
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentDelegationPermissionMode,
  AgentProviderSettingsView,
  AgentReasoningLevel,
  AgentStorageLocation,
  SkillDefinition,
} from '../../api/types';
import { parseAgentAuthoringInput, serializeAgentMarkdown } from '../../../core/agentMarkdown';
import { TOOL_CATALOG } from '../../../core/agentToolCatalog';
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

// The create / edit / view surface for an agent definition. ONE abstraction for
// every agent: two modes that convert on toggle (the form decision in
// [[agent-authoring]]) — a structured **Form** and a raw **AGENT.md** editor.
// Switching Form→Raw serializes the current fields, Raw→Form re-parses, so the
// two views are always the same data. Non-writable definitions render through
// the SAME editor, just **read-only** (every control disabled, the only action is
// "Duplicate to my agents") — so bundled, external-directory, and user definitions
// share the same viewing surface; the difference is only whether you can change it.
// A new agent seeds a useful **scaffold** (sensible defaults + a starter persona)
// so neither mode starts blank. The component owns its form state and is reset by
// the parent via `key`.

const REASONING_OPTIONS: readonly AgentReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
type CatalogToolName = (typeof TOOL_CATALOG)[number];

type EditorMode = 'form' | 'raw';

interface AgentEditorProps {
  // null → create mode (scaffold form). Otherwise edit (user/project) or
  // read-only view (built-in / external non-writable).
  agent: AgentDefinitionView | null;
  availableSkills: SkillDefinition[];
  // Provider connections, for the capability-driven model/effort selector. Null
  // while still loading.
  providerSettings: AgentProviderSettingsView | null;
  busy: boolean;
  onCreate: (input: AgentAuthoringInput, storage: AgentStorageLocation) => void;
  onUpdate: (agentId: string, input: AgentAuthoringInput) => void;
  onDelete: (agent: AgentDefinitionView) => void;
  onDuplicate: (agent: AgentDefinitionView) => void;
  onCancel?: () => void;
}

interface AgentFormState {
  name: string;
  description: string;
  body: string;
  model: string;
  effort: string;
  permissionMode: '' | AgentDelegationPermissionMode;
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

export function AgentEditor({ agent, availableSkills, providerSettings, busy, onCreate, onUpdate, onDelete, onDuplicate, onCancel }: AgentEditorProps) {
  const messages = useT();
  const t = messages.settings.agents;
  // The built-in assistant (Neva) is directly editable — its edits persist to the
  // settings overlay, not a file — but it can't be deleted (no file to remove); we
  // still suppress the Delete action for it below. Other non-writable definitions
  // (external read-only agent dirs) render through the SAME editor, just read-only.
  const isBuiltIn = agent?.source === 'built-in';
  const readOnly = agent ? !isWritableAgentDefinition(agent) : false;
  const skillNames = useMemo(() => availableSkills.map((skill) => skill.name), [availableSkills]);
  const [form, setForm] = useState<AgentFormState>(() => seedForm(agent, skillNames, newAgentScaffold(t)));
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

  const toolsAll = TOOL_CATALOG.every((name) => form.tools.includes(name)) && form.extraTools.length === 0;
  const headerTitle = agent
    ? (readOnly ? (agent.displayName || agent.name) : t.editTitle({ name: agent.displayName || agent.name }))
    : t.createTitle;

  return (
    <div className="agent-editor">
      <header className="agent-editor-header">
        <h4 className="agent-profile-title">{headerTitle}</h4>
        {/* The mode toggle stays interactive even for a read-only built-in, so a
            user can flip to Raw to read its AGENT.md before duplicating. */}
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
            readOnly={readOnly}
            spellCheck={false}
            value={rawText}
          />
        </Field>
      ) : (
        <>
          <div className="inset-card agent-editor-fields" role="group">
            <Field as="label" className="settings-sheet-row" label={t.nameLabel} labelClassName="settings-sheet-row-label">
              <Input className="settings-sheet-row-input" label={t.nameLabel} onChange={(e) => update('name', e.target.value)} placeholder={t.namePlaceholder} readOnly={readOnly} value={form.name} variant="bare" />
            </Field>
            <Field as="label" className="settings-sheet-row" label={t.descriptionLabel} labelClassName="settings-sheet-row-label">
              <Input className="settings-sheet-row-input" label={t.descriptionLabel} onChange={(e) => update('description', e.target.value)} placeholder={t.descriptionPlaceholder} readOnly={readOnly} value={form.description} variant="bare" />
            </Field>
            <AgentModelEffortSelector
              disabled={readOnly}
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
            <Field as="div" className="settings-sheet-row settings-sheet-row-control" label={t.permissionMode} labelClassName="settings-sheet-row-label">
              <SegmentedControl<'' | AgentDelegationPermissionMode>
                disabled={readOnly}
                label={t.permissionMode}
                onChange={(value) => update('permissionMode', value)}
                options={[
                  { value: '', label: t.permissionInherit },
                  { value: 'restricted', label: t.restricted },
                ]}
                value={form.permissionMode}
              />
            </Field>
            <Field as="label" className="settings-sheet-row" label={t.maxTurns} labelClassName="settings-sheet-row-label">
              <Input className="settings-sheet-row-input" label={t.maxTurns} min={1} onChange={(e) => update('maxTurns', e.target.value)} placeholder={t.maxTurnsPlaceholder} readOnly={readOnly} type="number" value={form.maxTurns} variant="bare" />
            </Field>
            <div className="settings-sheet-row settings-sheet-row-switch">
              <div className="settings-sheet-row-text">
                <span className="settings-sheet-row-label">{t.backgroundLabel}</span>
                <span className="agent-editor-field-hint">{t.backgroundSublabel}</span>
              </div>
              <SwitchControl checked={form.background} disabled={readOnly} label={t.backgroundLabel} onCheckedChange={(v) => update('background', v)}>
                <SwitchMark checked={form.background} />
              </SwitchControl>
            </div>
          </div>

          <ToggleList
            ariaLabel={t.toolsLabel}
            disabled={readOnly}
            footnote={toolsAll ? t.toolsAllEnabled : t.toolsSublabel}
            items={TOOL_CATALOG.map((name) => ({ key: name, label: name, on: form.tools.includes(name) }))}
            label={t.toolsLabel}
            onToggle={(name) => update('tools', toggleMember(form.tools, name))}
            toggleLabel={(name) => t.toggleTool({ name })}
          />

          <ToggleList
            ariaLabel={t.skillsLabel}
            disabled={readOnly}
            emptyText={t.skillsEmpty}
            footnote={t.skillsSublabel}
            items={availableSkills.map((skill) => ({ key: skill.name, label: skill.displayName || skill.name, on: form.skills.includes(skill.name) }))}
            label={t.skillsLabel}
            onToggle={(name) => update('skills', toggleMember(form.skills, name))}
            toggleLabel={(name) => t.toggleSkill({ name })}
          />

          <Field as="label" className="agent-editor-persona" label={t.personaPromptLabel} labelClassName="agent-profile-field-label">
            <textarea aria-label={t.personaPromptLabel} className="agent-profile-prompt-editor" onChange={(e) => update('body', e.target.value)} placeholder={t.personaPlaceholder} readOnly={readOnly} value={form.body} />
          </Field>
        </>
      )}

      {!agent ? (
        <Field as="div" className="settings-sheet-row settings-sheet-row-control" label={t.storageLabel} labelClassName="settings-sheet-row-label">
          <SegmentedControl<AgentStorageLocation>
            label={t.storageLabel}
            onChange={setStorage}
            options={[
              { value: 'user', label: t.storageUser },
              { value: 'project', label: t.storageProject },
            ]}
            value={storage}
          />
        </Field>
      ) : null}

      {localError ? <div className="agent-settings-alert" role="alert"><span>{localError}</span></div> : null}

      <div className="agent-editor-actions">
        {readOnly && agent ? (
          // External read-only definitions (e.g. an additional agent directory):
          // viewable here, duplicated to edit. The built-in is no longer read-only.
          <>
            {onCancel ? (
              <Button disabled={busy} onClick={onCancel} variant="ghost">
                {messages.dialog.cancel}
              </Button>
            ) : <span />}
            <span className="agent-editor-actions-right">
              <Button disabled={busy} onClick={() => onDuplicate(agent)} variant="primary">
                {t.duplicateToMine}
              </Button>
            </span>
          </>
        ) : agent ? (
          <>
            {/* The built-in assistant is editable but not deletable — it is the one
                agent that always exists, and it has no file to remove. */}
            {isBuiltIn ? <span /> : (
              <Button className="agent-editor-delete" disabled={busy} onClick={() => onDelete(agent)} variant="danger">
                {t.deleteAgent}
              </Button>
            )}
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
          </>
        ) : (
          <>
            {onCancel ? (
              <Button disabled={busy} onClick={onCancel} variant="ghost">
                {messages.dialog.cancel}
              </Button>
            ) : <span />}
            <span className="agent-editor-actions-right">
              <Button disabled={busy} onClick={submit} variant="primary">
                {t.createAgent}
              </Button>
            </span>
          </>
        )}
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
  disabled?: boolean;
  onToggle: (key: string) => void;
  toggleLabel: (key: string) => string;
}

function ToggleList({ ariaLabel, label, items, footnote, emptyText, disabled, onToggle, toggleLabel }: ToggleListProps) {
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
            <SwitchControl checked={item.on} disabled={disabled} label={toggleLabel(item.key)} onCheckedChange={() => onToggle(item.key)}>
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

// A fresh agent is pre-filled with a useful scaffold (real default values, not
// empty placeholders), so the Form starts populated and the Raw AGENT.md is a
// fill-in template rather than a bare `name: ""`. Tools default to all-on
// (unrestricted) and `model` to inherit, so neither shows in Raw — the secure,
// minimal defaults. Text comes from i18n so it follows the display language.
function newAgentScaffold(t: { namePlaceholder: string; descriptionPlaceholder: string; scaffoldBody: string }): AgentAuthoringInput {
  return {
    name: t.namePlaceholder,
    description: t.descriptionPlaceholder,
    body: t.scaffoldBody,
    effort: 'medium',
    permissionMode: 'restricted',
    maxTurns: 20,
  };
}

function seedForm(agent: AgentDefinitionView | null, skillNames: string[], scaffold: AgentAuthoringInput): AgentFormState {
  if (!agent) return inputToForm(scaffold, skillNames);
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
  const extraTools = unrestricted ? [] : rawTools.filter((tool) => tool !== '*' && !isCatalogToolName(tool.toLowerCase()));
  const rawSkills = input.skills ?? [];
  return {
    name: input.name,
    description: input.description,
    body: input.body,
    model: input.model ?? '',
    effort: normalizeReasoningEffort(input.effort),
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

function normalizeReasoningEffort(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return '';
  return isReasoningOption(normalized) ? normalized : '';
}

function isReasoningOption(value: string): value is AgentReasoningLevel {
  return (REASONING_OPTIONS as readonly string[]).includes(value);
}

function isCatalogToolName(value: string): value is CatalogToolName {
  return (TOOL_CATALOG as readonly string[]).includes(value);
}

function isWritableAgentDefinition(agent: AgentDefinitionView): boolean {
  if (typeof agent.writable === 'boolean') return agent.writable;
  if (agent.source === 'built-in' || agent.rootDir === 'built-in') return false;
  const rootDir = normalizeAgentPath(agent.rootDir);
  const agentFile = normalizeAgentPath(agent.agentFile);
  const agentFileName = '/AGENT.md';
  if (!rootDir || agentFile !== `${rootDir}${agentFileName}`) return false;
  const marker = '/.agents/agents/';
  const markerIndex = rootDir.indexOf(marker);
  if (markerIndex < 0) return false;
  const slug = rootDir.slice(markerIndex + marker.length);
  return slug.length > 0 && !slug.includes('/');
}

function normalizeAgentPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
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
