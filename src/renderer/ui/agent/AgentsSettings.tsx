import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  IDENTITY_COLORS,
  IDENTITY_COLOR_TINT,
  MAIN_PRESENTATION_KEY,
} from '../../../core/agent/configuration';
import type {
  AgentCapabilityCatalog,
  AgentEditorView,
  AgentPresentationOverrideRow,
  AgentProfileView,
  AgentProviderSettingsView,
} from '../../api/types';
import { api } from '../../api/client';
import { AgentMark } from '../../agent/components/AgentMark';
import { resolveAgentIdentity } from '../../agent/agentIdentity';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { CheckboxControl } from '../primitives/CheckboxControl';
import { Dialog } from '../primitives/Dialog';
import { Input } from '../primitives/Input';
import { SelectControl } from '../primitives/SelectControl';
import { Textarea } from '../primitives/Textarea';
import { InsetGroup, InsetRow } from './SettingsInsetList';

const EMPTY_CAPABILITIES: AgentCapabilityCatalog = { tools: [], skills: [] };

export function AgentsSettings({ initialAgentType: _initialAgentType, onError, onNotice, settings: _settings }: {
  readonly initialAgentType?: string;
  readonly onError: (message: string | null) => void;
  readonly onNotice: (message: string | null) => void;
  readonly settings: AgentProviderSettingsView | null;
}) {
  const t = useT();
  const [view, setView] = useState<AgentEditorView | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.agentIdentityCatalog()
      .then((next) => { if (active) setView(next); })
      .catch((caught: unknown) => { if (active) onError(errorText(caught)); });
    return () => { active = false; };
  }, [onError]);

  const save = useCallback(async (draft: MainAgentDraft, layer: 'user' | 'project') => {
    if (!view) return;
    setBusy(true);
    onError(null);
    onNotice(null);
    setEditorError(null);
    try {
      const next = await api.agentWriteProfile({
        layer,
        name: view.profile.name,
        presentation: { persona: draft.persona, color: draft.color },
        profile: {
          developerInstructions: draft.developerInstructions,
          tools: draft.tools,
          skills: draft.skills,
        },
      });
      setView(next);
      setEditing(false);
      onNotice(t.settings.agents.saved({ name: draft.persona || MAIN_PRESENTATION_KEY }));
    } catch (caught) {
      setEditorError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }, [onError, onNotice, t.settings.agents, view]);

  const entry = view?.entries.find((candidate) => candidate.agentType === MAIN_PRESENTATION_KEY);
  const identity = resolveAgentIdentity(entry ? new Map([[MAIN_PRESENTATION_KEY, entry]]) : new Map(), MAIN_PRESENTATION_KEY);

  return (
    <section aria-label={t.settings.agents.sectionAriaLabel} className="agent-settings-section">
      <InsetGroup
        ariaLabel={t.settings.agents.builtInAriaLabel}
        footnote={t.settings.agents.builtInFootnote}
        id="agents"
        label={t.settings.agents.builtInGroup}
      >
        {view === null ? (
          <InsetRow empty label={t.settings.agents.loading} />
        ) : (
          <InsetRow
            label={identity.name}
            leading={<AgentMark size={24} tint={identity.tint} />}
            onSelect={() => setEditing(true)}
            sublabel={t.settings.agents.mainSublabel}
          />
        )}
      </InsetGroup>

      {editing && view ? (
        <MainAgentEditor
          busy={busy}
          capabilities={view.capabilities ?? EMPTY_CAPABILITIES}
          error={editorError}
          onCancel={() => { setEditorError(null); setEditing(false); }}
          onSave={(draft, layer) => void save(draft, layer)}
          override={effectiveMainOverride(view.presentationOverrides)}
          profile={view.profile}
        />
      ) : null}
    </section>
  );
}

interface MainAgentDraft {
  readonly persona: string;
  readonly color: string;
  readonly developerInstructions: string;
  readonly tools: readonly string[] | null;
  readonly skills: readonly string[] | null;
}

function MainAgentEditor({ busy, capabilities, error, onCancel, onSave, override, profile }: {
  readonly busy: boolean;
  readonly capabilities: AgentCapabilityCatalog;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (draft: MainAgentDraft, layer: 'user' | 'project') => void;
  readonly override: AgentPresentationOverrideRow | null;
  readonly profile: AgentProfileView;
}) {
  const t = useT();
  const titleId = useId();
  const [persona, setPersona] = useState(override?.persona ?? '');
  const [color, setColor] = useState(override?.color ?? '');
  const [instructions, setInstructions] = useState(profile.developerInstructions ?? '');
  const [layer, setLayer] = useState<'user' | 'project'>(override?.layer ?? profile.layer ?? 'user');
  const toolKeys = useMemo(
    () => union(capabilities.tools.map((tool) => tool.key), profile.tools),
    [capabilities.tools, profile.tools],
  );
  const skillKeys = useMemo(
    () => union(capabilities.skills, profile.skills?.filter((name) => name !== '*') ?? null),
    [capabilities.skills, profile.skills],
  );
  const [tools, setTools] = useState<ReadonlySet<string>>(() => new Set(profile.tools ?? toolKeys));
  const [skills, setSkills] = useState<ReadonlySet<string>>(
    () => new Set(resolveSkillSelection(profile.skills, skillKeys)),
  );
  const inheritedTint = resolveAgentIdentity(new Map(), MAIN_PRESENTATION_KEY).tint;

  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      labelledBy={titleId}
      onBackdropMouseDown={onCancel}
      onEscapeKeyDown={onCancel}
      surfaceClassName="confirm-dialog agent-editor-dialog"
    >
      <h2 className="confirm-dialog-title" id={titleId}>{t.settings.agents.editTitle}</h2>

      <InsetGroup ariaLabel={t.settings.agents.identityAriaLabel} label={t.settings.agents.identityGroup}>
        <label className="settings-sheet-row">
          <span className="settings-sheet-row-label">{t.settings.agents.persona}</span>
          <Input
            className="settings-sheet-row-input"
            label={t.settings.agents.persona}
            onChange={(event) => setPersona(event.target.value)}
            placeholder={MAIN_PRESENTATION_KEY}
            value={persona}
            variant="bare"
          />
        </label>
        <div className="settings-sheet-row">
          <span className="settings-sheet-row-label">{t.settings.agents.colour}</span>
          <div aria-label={t.settings.agents.colour} className="agent-colour-choices" role="radiogroup">
            <ButtonControl
              aria-checked={color === ''}
              aria-label={t.settings.agents.colourDefault}
              className={`agent-colour-choice is-default${color === '' ? ' is-selected' : ''}`}
              onClick={() => setColor('')}
              role="radio"
              title={t.settings.agents.colourDefault}
            >
              <AgentMark size={22} tint={inheritedTint} />
            </ButtonControl>
            {IDENTITY_COLORS.map((choice) => (
              <ButtonControl
                aria-checked={color === choice}
                aria-label={t.settings.agents.colourNames[choice]}
                className={`agent-colour-choice${color === choice ? ' is-selected' : ''}`}
                key={choice}
                onClick={() => setColor(choice)}
                role="radio"
              >
                <AgentMark size={22} tint={IDENTITY_COLOR_TINT[choice]} />
              </ButtonControl>
            ))}
          </div>
        </div>
      </InsetGroup>

      <InsetGroup
        ariaLabel={t.settings.agents.definitionAriaLabel}
        footnote={t.settings.agents.mainInstructionsFootnote}
        label={t.settings.agents.definitionGroup}
      >
        <div className="settings-sheet-row settings-sheet-row-stacked">
          <span className="settings-sheet-row-label">{t.settings.agents.instructions}</span>
          <Textarea
            className="settings-sheet-row-input"
            label={t.settings.agents.instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t.settings.agents.mainInstructionsPlaceholder}
            rows={4}
            value={instructions}
            variant="bare"
          />
        </div>
      </InsetGroup>

      <InsetGroup
        ariaLabel={t.settings.agents.capabilitiesAriaLabel}
        footnote={t.settings.agents.capabilitiesMainFootnote}
        label={t.settings.agents.capabilitiesGroup}
      >
        <CapabilityList
          all={toolKeys}
          describe={(key) => capabilities.tools.find((tool) => tool.key === key)?.description ?? ''}
          label={t.settings.agents.tools}
          onChange={setTools}
          selected={tools}
        />
        <CapabilityList
          all={skillKeys}
          label={t.settings.agents.skills}
          onChange={setSkills}
          selected={skills}
        />
      </InsetGroup>

      <InsetGroup ariaLabel={t.settings.agents.layerAriaLabel}>
        <InsetRow
          label={t.settings.agents.layer}
          sublabel={t.settings.agents.layerSublabel}
          trailing={(
            <SelectControl
              label={t.settings.agents.layer}
              onChange={(event) => setLayer(event.target.value === 'project' ? 'project' : 'user')}
              value={layer}
              variant="popup"
            >
              <option value="user">{t.settings.agents.layerUser}</option>
              <option value="project">{t.settings.agents.layerProject}</option>
            </SelectControl>
          )}
          wrap
        />
      </InsetGroup>

      {error ? <p className="settings-sheet-note agent-editor-conflict" role="alert">{error}</p> : null}

      <div className="confirm-dialog-actions agent-editor-actions">
        <Button onClick={onCancel} variant="ghost">{t.dialog.cancel}</Button>
        <Button
          disabled={busy}
          onClick={() => onSave({
            persona: persona.trim(),
            color,
            developerInstructions: instructions.trim(),
            tools: narrowing(tools, toolKeys),
            skills: narrowing(skills, skillKeys),
          }, layer)}
          tone="subtle"
          variant="primary"
        >
          {t.settings.agents.save}
        </Button>
      </div>
    </Dialog>
  );
}

function CapabilityList({ label, all, selected, onChange, describe }: {
  readonly label: string;
  readonly all: readonly string[];
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
  readonly describe?: (key: string) => string;
}) {
  const t = useT();
  if (all.length === 0) return null;
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  return (
    <div className="settings-sheet-row settings-sheet-row-stacked">
      <span className="settings-sheet-row-label">
        {label}
        <span className="agent-capability-count">
          {t.settings.agents.capabilityCount({ selected: selected.size, total: all.length })}
        </span>
      </span>
      <div className="agent-capability-list">
        {all.map((key) => (
          <CheckboxControl
            checked={selected.has(key)}
            className="agent-capability-item"
            key={key}
            onCheckedChange={() => toggle(key)}
            title={describe?.(key) || undefined}
          >
            {key}
          </CheckboxControl>
        ))}
      </div>
    </div>
  );
}

function effectiveMainOverride(rows: readonly AgentPresentationOverrideRow[]): AgentPresentationOverrideRow | null {
  const matching = rows.filter((row) => row.agentType === MAIN_PRESENTATION_KEY);
  return matching.find((row) => row.layer === 'project')
    ?? matching.find((row) => row.layer === 'user')
    ?? null;
}

function resolveSkillSelection(
  stored: readonly string[] | null | undefined,
  all: readonly string[],
): readonly string[] {
  if (!stored || stored.includes('*')) return all;
  return stored;
}

function union(known: readonly string[], stored: readonly string[] | null): readonly string[] {
  if (!stored) return known;
  return [...known, ...stored.filter((key) => !known.includes(key))];
}

function narrowing(selected: ReadonlySet<string>, all: readonly string[]): readonly string[] | null {
  return selected.size === all.length && all.every((key) => selected.has(key))
    ? null
    : [...selected];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
