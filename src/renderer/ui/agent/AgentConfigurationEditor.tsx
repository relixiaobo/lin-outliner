import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_AGENT_PRESENTATIONS,
  IDENTITY_COLORS,
  IDENTITY_COLOR_TINT,
  MAIN_PRESENTATION_KEY,
} from '../../../core/agent/configuration';
import type {
  AgentCapabilityCatalog,
  AgentEditorView,
  AgentPresentationOverrideRow,
  AgentProfileView,
} from '../../api/types';
import { api } from '../../api/client';
import { AgentMark } from '../../agent/components/AgentMark';
import { resolveAgentIdentity } from '../../agent/agentIdentity';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { Dialog } from '../primitives/Dialog';
import { Input } from '../primitives/Input';
import { SelectControl } from '../primitives/SelectControl';
import { Textarea } from '../primitives/Textarea';
import { SettingsFeedback } from '../configuration/SettingsFeedback';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { AgentCapabilityPicker } from './AgentCapabilityPicker';

const EMPTY_CAPABILITIES: AgentCapabilityCatalog = { tools: [], skills: [] };

export function AgentConfigurationEditor() {
  const t = useT();
  const [error, onError] = useState<string | null>(null);
  const [notice, onNotice] = useState<string | null>(null);
  const [view, setView] = useState<AgentEditorView | null>(null);
  const [editing, setEditing] = useState<AgentEditorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const saving = useRef(false);
  const sourceObservations = useRef<AgentEditorView['sources']>([]);

  const openEditor = (next: AgentEditorView) => {
    sourceObservations.current = next.sources;
    setEditorError(null);
    setEditing(next);
  };

  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void api.agentIdentityCatalog()
        .then((next) => { if (active && request === generation) { setView(next); onError(null); } })
        .catch((caught: unknown) => { if (active && request === generation) onError(errorText(caught)); });
    };
    refresh();
    const off = window.lin?.onConfigurationChanged?.('agents', refresh);
    window.addEventListener('focus', refresh);
    return () => { active = false; off?.(); window.removeEventListener('focus', refresh); };
  }, [onError]);

  const save = useCallback(async (draft: MainAgentDraft, layer: 'user' | 'project') => {
    if (!editing || saving.current) return;
    saving.current = true;
    setBusy(true);
    onError(null);
    onNotice(null);
    setEditorError(null);
    const observation = sourceObservations.current.find((source) => source.layer === layer);
    try {
      const next = await api.agentWriteProfile({
        layer,
        sourceDigest: observation?.digest ?? null,
        name: editing.profile.name,
        presentation: { persona: draft.persona, color: draft.color },
        profile: {
          developerInstructions: draft.developerInstructions,
          tools: draft.tools,
          skills: draft.skills,
        },
      });
      setView(next);
      setEditing(null);
      onNotice(t.settings.agents.saved({ name: next.entries.find((entry) => entry.agentType === MAIN_PRESENTATION_KEY)?.persona
        || draft.persona || DEFAULT_AGENT_PRESENTATIONS[MAIN_PRESENTATION_KEY]!.persona }));
    } catch (caught) {
      let message = errorText(caught);
      try {
        const latest = await api.agentIdentityCatalog();
        const source = latest.sources.find((candidate) => candidate.layer === layer);
        // Refresh only the rejected write's admission token. Keep the dialog's
        // initial values and draft intact, and require another explicit Save.
        // Background refreshes must never silently admit a stale draft.
        if (source && source.path === observation?.path && source.digest !== observation.digest) {
          sourceObservations.current = sourceObservations.current.map((candidate) => candidate.layer === layer ? source : candidate);
          if (source.state !== 'rejected') message = t.settings.agents.sourceChanged;
        }
        setView(latest);
      } catch {
        message = `${message} ${t.settings.agents.sourceRefreshFailed}`;
      }
      setEditorError(message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }, [onError, onNotice, t.settings.agents, editing]);

  const entry = view?.entries.find((candidate) => candidate.agentType === MAIN_PRESENTATION_KEY);
  const identity = resolveAgentIdentity(entry ? new Map([[MAIN_PRESENTATION_KEY, entry]]) : new Map(), MAIN_PRESENTATION_KEY);

  return (
    <section aria-label={t.settings.agents.sectionAriaLabel} className="agent-settings-section">
      <InsetGroup
        headerFeedback={<SettingsFeedback feedback={{ error }} />}
        ariaLabel={t.settings.agents.builtInAriaLabel}
        footnote={t.settings.agents.builtInFootnote}
        id="agents"
        label={t.settings.agents.builtInGroup}
      >
        {view === null ? (
          <InsetRow empty label={t.settings.agents.loading} />
        ) : (
          <InsetRow
            feedback={<SettingsFeedback feedback={{ notice }} />}
            label={identity.name}
            leading={<AgentMark size={24} tint={identity.tint} />}
            onSelect={() => openEditor(view)}
            sublabel={t.settings.agents.mainSublabel}
            trailing={<Button size="sm" variant="secondary" onClick={() => openEditor(view)}>{t.settings.agents.editAction}</Button>}
          />
        )}
      </InsetGroup>

      {editing ? (
        <MainAgentEditor
          busy={busy}
          capabilities={editing.capabilities ?? EMPTY_CAPABILITIES}
          error={editorError}
          onCancel={() => { setEditorError(null); setEditing(null); }}
          onSave={(draft, layer) => void save(draft, layer)}
          override={effectiveMainOverride(editing.presentationOverrides)}
          userOverride={editing.presentationOverrides.find((row) => row.agentType === MAIN_PRESENTATION_KEY && row.layer === 'user') ?? null}
          profile={editing.profile}
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

function MainAgentEditor({ busy, capabilities, error, onCancel, onSave, override, userOverride, profile }: {
  readonly busy: boolean;
  readonly capabilities: AgentCapabilityCatalog;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (draft: MainAgentDraft, layer: 'user' | 'project') => void;
  readonly override: AgentPresentationOverrideRow | null;
  readonly userOverride: AgentPresentationOverrideRow | null;
  readonly profile: AgentProfileView;
}) {
  const t = useT();
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
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
  // Inheritance and an explicit list are different policies, even when the list
  // happens to contain every currently known member. Never widen it on Save.
  const [customTools, setCustomTools] = useState(profile.tools !== null);
  const [customSkills, setCustomSkills] = useState(Boolean(profile.skills && !profile.skills.includes('*')));
  const [tools, setTools] = useState<ReadonlySet<string>>(() => new Set(profile.tools ?? toolKeys));
  const [skills, setSkills] = useState<ReadonlySet<string>>(
    () => new Set(resolveSkillSelection(profile.skills, skillKeys)),
  );
  const [disabledSkills, setDisabledSkills] = useState<readonly string[] | null>(null);
  const [skillStatusError, setSkillStatusError] = useState(false);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void api.agentGetSkillSettings().then((next) => {
        if (active && request === generation) { setDisabledSkills(next.disabledSkills); setSkillStatusError(false); }
      }).catch(() => {
        if (active && request === generation) { setDisabledSkills(null); setSkillStatusError(true); }
      });
    };
    refresh();
    const off = window.lin?.onConfigurationChanged?.('skills', refresh);
    return () => { active = false; off?.(); };
  }, []);
  const defaults = DEFAULT_AGENT_PRESENTATIONS[MAIN_PRESENTATION_KEY]!;
  // Presentation overrides replace the whole object. Only clearing both fields
  // removes the project override and exposes the user presentation underneath.
  const defaultName = (layer === 'project' && !color ? userOverride?.persona : null) ?? defaults.persona;
  const defaultColor = (layer === 'project' && !persona.trim() ? userOverride?.color : null) ?? defaults.color;
  const defaultTint = IDENTITY_COLOR_TINT[defaultColor as keyof typeof IDENTITY_COLOR_TINT];
  const tint = IDENTITY_COLOR_TINT[color as keyof typeof IDENTITY_COLOR_TINT] ?? defaultTint;
  const cancel = () => { if (!busy) onCancel(); };

  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      initialFocus={() => nameRef.current}
      labelledBy={titleId}
      onBackdropMouseDown={cancel}
      onEscapeKeyDown={cancel}
      surfaceClassName="confirm-dialog agent-editor-dialog"
    >
      <form className="agent-editor-form" onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        onSave({ persona: persona.trim(), color, developerInstructions: instructions.trim(),
          tools: customTools ? [...tools] : null, skills: customSkills ? [...skills] : null }, layer);
      }}>
        <header className="agent-editor-heading">
          <AgentMark size={28} tint={tint} />
          <h2 className="confirm-dialog-title" id={titleId}>{t.settings.agents.editTitle}</h2>
        </header>
        <div className="agent-editor-body">
          <fieldset className="agent-editor-fields" disabled={busy} aria-label={t.settings.agents.editTitle}>
            <InsetGroup ariaLabel={t.settings.agents.identityAriaLabel}>
              <label className="settings-sheet-row">
                <span className="settings-sheet-row-label">{t.settings.agents.persona}</span>
                <Input ref={nameRef} className="settings-sheet-row-input" label={t.settings.agents.persona}
                  onChange={(event) => setPersona(event.target.value)} placeholder={defaultName}
                  value={persona} variant="bare" />
              </label>
              <div className="settings-sheet-row">
                <span className="settings-sheet-row-label">{t.settings.agents.colour}</span>
                <div aria-label={t.settings.agents.colour} className="agent-colour-choices" role="radiogroup"
                  onKeyDown={(event) => {
                    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
                      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
                    if (!direction || event.nativeEvent.isComposing) return;
                    const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
                    const index = choices.indexOf(event.target as HTMLButtonElement);
                    if (index < 0) return;
                    event.preventDefault();
                    const next = choices[(index + direction + choices.length) % choices.length];
                    next.focus(); next.click();
                  }}>
                  <ButtonControl aria-checked={color === ''} aria-label={t.settings.agents.colourDefault}
                    className={`agent-colour-choice${color === '' ? ' is-selected' : ''}`}
                    onClick={() => setColor('')} role="radio" tabIndex={color === '' ? 0 : -1}
                    title={t.settings.agents.colourDefault}>
                    <AgentMark size={22} tint={defaultTint} />
                  </ButtonControl>
                  <span className="agent-colour-divider" aria-hidden />
                  {IDENTITY_COLORS.map((choice) => (
                    <ButtonControl aria-checked={color === choice} aria-label={t.settings.agents.colourNames[choice]}
                      className={`agent-colour-choice${color === choice ? ' is-selected' : ''}`} key={choice}
                      onClick={() => setColor(choice)} role="radio" tabIndex={color === choice ? 0 : -1}
                      title={t.settings.agents.colourNames[choice]}>
                      <AgentMark size={22} tint={IDENTITY_COLOR_TINT[choice]} />
                    </ButtonControl>
                  ))}
                </div>
              </div>
              <InsetRow label={t.settings.agents.layer} trailing={(
                <SelectControl label={t.settings.agents.layer} value={layer} variant="popup"
                  onChange={(event) => setLayer(event.target.value === 'project' ? 'project' : 'user')}>
                  <option value="user">{t.settings.agents.layerUser}</option>
                  <option value="project">{t.settings.agents.layerProject}</option>
                </SelectControl>
              )} wrap />
            </InsetGroup>
            <InsetGroup ariaLabel={t.settings.agents.definitionAriaLabel} label={t.settings.agents.instructions}
              footnote={t.settings.agents.mainInstructionsFootnote}>
              <div className="settings-sheet-row settings-sheet-row-stacked">
                <Textarea className="settings-sheet-row-input" label={t.settings.agents.instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={t.settings.agents.mainInstructionsPlaceholder} rows={3} value={instructions} variant="bare" />
              </div>
            </InsetGroup>
            <InsetGroup ariaLabel={t.settings.agents.capabilitiesAriaLabel} label={t.settings.agents.capabilitiesGroup}
              footnote={t.settings.agents.capabilitiesMainFootnote}>
              <AgentCapabilityPicker all={toolKeys} label={t.settings.agents.tools}
                defaultLabel={t.settings.agents.allTools} custom={customTools} onCustomChange={setCustomTools}
                selected={tools} onChange={setTools}
                describe={(key) => capabilities.tools.find((tool) => tool.key === key)?.description ?? ''} />
              <AgentCapabilityPicker all={skillKeys} label={t.settings.agents.skills}
                defaultLabel={t.settings.agents.followSkillLibrary} custom={customSkills} onCustomChange={setCustomSkills}
                selected={skills} onChange={setSkills} hint={t.settings.agents.skillSelectionHint}
                status={(key) => disabledSkills?.includes(key) ? t.settings.agents.skillOffInLibrary : undefined} />
              {skillStatusError ? <p className="agent-editor-hint" role="status">{t.settings.agents.skillStatusUnavailable}</p> : null}
            </InsetGroup>
          </fieldset>
        </div>
        <footer className="agent-editor-footer">
          {error ? <p className="agent-editor-conflict" role="alert">{error}</p> : null}
          <div className="confirm-dialog-actions agent-editor-actions">
            <Button disabled={busy} onClick={cancel} variant="ghost">{t.dialog.cancel}</Button>
            <Button type="submit" disabled={busy} tone="subtle" variant="primary">
              {busy ? t.settings.agents.saving : t.settings.agents.save}
            </Button>
          </div>
        </footer>
      </form>
    </Dialog>
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
