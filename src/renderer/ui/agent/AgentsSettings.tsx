import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  IDENTITY_COLORS,
  IDENTITY_COLOR_TINT,
  MAIN_PRESENTATION_KEY,
  type IdentityColor,
} from '../../../core/agent/configuration';
import type {
  AgentBuiltInDefinition,
  AgentCapabilityCatalog,
  AgentEditableRole,
  AgentEditorView,
  AgentIdentityEntry,
  AgentPresentationOverrideRow,
  AgentProfileView,
} from '../../api/types';
import { api } from '../../api/client';
import { AgentMark } from '../../agent/components/AgentMark';
import { identityCatalogFrom, resolveAgentIdentity } from '../../agent/agentIdentity';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { CheckboxControl } from '../primitives/CheckboxControl';
import { IconButton } from '../primitives/IconButton';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { Dialog } from '../primitives/Dialog';
import { Input } from '../primitives/Input';
import { SelectControl } from '../primitives/SelectControl';
import { Textarea } from '../primitives/Textarea';
import { AddIcon, ICON_SIZE } from '../icons';
import { InsetGroup, InsetRow } from './SettingsInsetList';

/** Before the view loads there is nothing to narrow; an empty catalogue reads as "no choices yet", not "none allowed". */
const EMPTY_CAPABILITIES: AgentCapabilityCatalog = { tools: [], skills: [] };

/** The loader's `validateDefinitionName` rule, mirrored so the editor can say it. */
const DEFINITION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * The Agents page: who is in the conversation, and who the user may change.
 *
 * Two populations, one list. Built-in types are frozen definitions — the editor
 * re-skins them (a name, a colour) and never pretends their behaviour can be
 * rewritten in place. Roles the user writes are theirs entirely: description,
 * instructions, and identity alike.
 *
 * Every write goes through main (A2) and is validated by the LOADER before it
 * lands, so an edit that would produce a configuration the app cannot read is
 * refused with the file untouched. Each write answers with the same catalog the
 * transcript draws from, so this list is never a second opinion about what
 * shipped.
 */
export function AgentsSettings({ onError, onNotice }: {
  readonly onError: (message: string | null) => void;
  readonly onNotice: (message: string | null) => void;
}) {
  const t = useT();
  const [view, setView] = useState<AgentEditorView | null>(null);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [busy, setBusy] = useState(false);
  // A refused write has to report INSIDE the dialog. The pane's shared feedback
  // block is `position: sticky; z-index: 1` and the dialog backdrop is fixed at
  // `--z-modal`, so an error raised while the editor is open landed behind it
  // and Save simply looked like it did nothing.
  const [editorError, setEditorError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.agentIdentityCatalog()
      .then((next) => { if (active) setView(next); })
      .catch((caught: unknown) => { if (active) onError(errorText(caught)); });
    return () => { active = false; };
  }, [onError]);

  const catalog = useMemo(() => identityCatalogFrom(view?.entries ?? []), [view]);
  const roleNames = useMemo(
    () => new Set((view?.roles ?? []).map((role) => role.name)),
    [view],
  );
  // A Role's own entry is already in `entries` — it is an Agent type like any
  // other. Listing it under both headings would offer two different editors for
  // one identity, so the built-in group is what remains after the user's own.
  const builtIns = (view?.entries ?? []).filter((entry) => !roleNames.has(entry.agentType));

  const run = useCallback(async (action: () => Promise<AgentEditorView>, notice: string) => {
    setBusy(true);
    onError(null);
    onNotice(null);
    setEditorError(null);
    try {
      setView(await action());
      onNotice(notice);
      setEditing(null);
    } catch (caught) {
      // Refused, not half-applied: the writer validates the candidate before
      // anything reaches disk, so the file the user had is still the file on
      // disk — and the message belongs where the user is looking.
      setEditorError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }, [onError, onNotice]);

  return (
    <section aria-label={t.settings.agents.sectionAriaLabel} className="agent-settings-section">
      <InsetGroup
        ariaLabel={t.settings.agents.customAriaLabel}
        footnote={t.settings.agents.customFootnote}
        headerAction={(
          <IconButton
            className="rail-toggle"
            icon={AddIcon}
            iconSize={ICON_SIZE.menu}
            label={t.settings.agents.create}
            onClick={() => setEditing({ kind: 'new' })}
            variant="chrome"
          />
        )}
        id="agents"
        label={t.settings.agents.customGroup}
      >
        {view === null ? (
          <InsetRow empty label={t.settings.agents.loading} />
        ) : view.roles.length === 0 ? (
          <InsetRow empty label={t.settings.agents.none} />
        ) : view.roles.map((role) => (
          <AgentListRow
            key={`${role.layer}:${role.name}`}
            entry={catalog.get(role.name)}
            name={role.name}
            onSelect={() => setEditing({ kind: 'role', role })}
            sublabel={role.description || layerLabel(role.layer, t)}
          />
        ))}
      </InsetGroup>

      <InsetGroup
        ariaLabel={t.settings.agents.builtInAriaLabel}
        footnote={t.settings.agents.builtInFootnote}
        label={t.settings.agents.builtInGroup}
      >
        {builtIns.map((entry) => (
          <AgentListRow
            key={entry.agentType}
            entry={entry}
            name={entry.agentType}
            onSelect={() => setEditing(entry.agentType === MAIN_PRESENTATION_KEY
              ? { kind: 'main', entry }
              : { kind: 'presentation', entry })}
            sublabel={entry.agentType === MAIN_PRESENTATION_KEY
              ? t.settings.agents.mainSublabel
              : entry.agentType}
          />
        ))}
      </InsetGroup>

      {editing === null ? null : (
        <AgentEditorDialog
          // Remount when the editor changes subject. Without a key React keeps
          // the same instance across `setEditing`, so the state initialisers do
          // not re-run and Duplicate would open a dialog still holding the
          // previous agent's fields.
          key={editorKey(editing)}
          busy={busy}
          error={editorError}
          onCancel={() => { setEditorError(null); setEditing(null); }}
          onDelete={editing.kind !== 'role' ? undefined : () => void run(
            () => api.agentDeleteRole({ layer: editing.role.layer, name: editing.role.name }),
            t.settings.agents.deleted({ name: editing.role.name }),
          )}
          capabilities={view?.capabilities ?? EMPTY_CAPABILITIES}
          onDuplicate={editing.kind !== 'presentation' ? undefined : () => setEditing({
            kind: 'new',
            seed: view?.builtInDefinitions.find((row) => row.agentType === editing.entry.agentType),
          })}
          onSave={(draft, layer) => void run(
            async () => {
              // The conversation agent's identity is presentation and its
              // instructions and ceiling are a Configuration Profile — two parts
              // of one file. ONE command applies both inside a single validated
              // edit: as two sequential writes, a refused second one left the
              // first already on disk while the dialog reported failure.
              if (editing.kind === 'main') {
                return api.agentWriteProfile({
                  layer,
                  name: view?.profile.name ?? 'default',
                  agentType: editing.entry.agentType,
                  presentation: { persona: draft.persona, color: draft.color },
                  profile: {
                    developerInstructions: draft.developerInstructions,
                    // Always sent, never omitted: omitting meant the writer left
                    // a stale list on disk, so a narrowing could be tightened
                    // and never widened back while the UI showed it restored.
                    tools: draft.tools,
                    skills: draft.skills,
                  },
                });
              }
              return editing.kind === 'presentation'
              ? api.agentWritePresentation({
                agentType: editing.entry.agentType,
                layer,
                // Only what the user actually set. An empty field is the
                // ABSENCE of an override, which is what makes reset reachable
                // and keeps a later change to the built-in default flowing
                // through.
                presentation: { persona: draft.persona, color: draft.color },
              })
              : api.agentWriteRole({
                layer,
                // The write is a replace, so the intent has to be explicit:
                // `create` fails closed on a name that already exists rather
                // than silently overwriting the definition behind it.
                mode: editing.kind === 'new' ? 'create' : 'update',
                role: {
                  name: draft.name,
                  description: draft.description,
                  developerInstructions: draft.developerInstructions,
                  ...(draft.persona ? { persona: draft.persona } : {}),
                  ...(draft.color ? { color: draft.color } : {}),
                  // Absent leaves whatever is on disk; `[]` clears the narrowing
                  // back to inheriting everything the parent has.
                  tools: draft.tools ?? [],
                  skills: draft.skills ?? [],
                },
              });
            },
            t.settings.agents.saved({
              name: draft.persona || draft.name
                || (editing.kind === 'presentation' ? editing.entry.agentType : ''),
            }),
          )}
          override={overrideFor(view, editing)}
          profile={view?.profile ?? null}
          takenNames={roleNames}
          target={editing}
        />
      )}
    </section>
  );
}

/**
 * The re-skin written down for whatever the editor is open on, in the layer the
 * dialog will write to. A Role carries its own presentation, so only a built-in
 * looks here.
 */
function overrideFor(
  view: AgentEditorView | null,
  target: EditorTarget,
): AgentPresentationOverrideRow | null {
  if (view === null || (target.kind !== 'presentation' && target.kind !== 'main')) return null;
  const rows = view.presentationOverrides.filter((row) => row.agentType === target.entry.agentType);
  // Project wins over user, matching how the layers resolve — so the dialog
  // shows the value that is actually in force.
  return rows.find((row) => row.layer === 'project') ?? rows.find((row) => row.layer === 'user') ?? null;
}

/** Identifies the editor's subject, so switching subjects remounts it. */
function editorKey(target: EditorTarget): string {
  if (target.kind === 'role') return `role:${target.role.layer}:${target.role.name}`;
  if (target.kind === 'new') return `new:${target.seed?.agentType ?? ''}`;
  return `${target.kind}:${target.entry.agentType}`;
}

/** What the editor is open on: an existing Role, a new one, or a built-in's skin. */
type EditorTarget =
  | { readonly kind: 'role'; readonly role: AgentEditableRole }
  | { readonly kind: 'presentation'; readonly entry: AgentIdentityEntry }
  /** The conversation agent: identity, standing instructions, and the ceiling. */
  | { readonly kind: 'main'; readonly entry: AgentIdentityEntry }
  /** A new Role, optionally seeded from a built-in the user duplicated. */
  | { readonly kind: 'new'; readonly seed?: AgentBuiltInDefinition };

/**
 * One list row, wearing the same mark the transcript gives this Agent — so the
 * editor and the conversation are visibly about the same participant, which is
 * the whole point of the identity being configuration rather than decoration.
 */
function AgentListRow({ entry, name, sublabel, onSelect }: {
  readonly entry: AgentIdentityEntry | undefined;
  readonly name: string;
  readonly sublabel: string;
  readonly onSelect: () => void;
}) {
  const identity = resolveAgentIdentity(entry ? new Map([[name, entry]]) : new Map(), name);
  return (
    <InsetRow
      label={identity.name}
      leading={<AgentMark size={24} tint={identity.tint} />}
      onSelect={onSelect}
      sublabel={sublabel}
    />
  );
}

interface EditorDraft {
  readonly name: string;
  readonly description: string;
  readonly developerInstructions: string;
  readonly persona: string;
  readonly color: string;
  /**
   * The narrowed sets, or null for "inherit everything". Never today's full
   * catalogue written out: a frozen list would silently exclude every tool or
   * Skill added later.
   */
  readonly tools: readonly string[] | null;
  readonly skills: readonly string[] | null;
}

/**
 * The editor itself. A built-in shows only what it may change; a Role shows
 * everything. Both commit through the same Save, because from the user's side
 * "change this agent" is one gesture regardless of which half of the file it
 * lands in.
 */
function AgentEditorDialog({
  target, override, takenNames, profile, capabilities, busy, error, onSave, onCancel, onDelete, onDuplicate,
}: {
  readonly target: EditorTarget;
  /** What is actually written down for this identity, or null when nothing is. */
  readonly override: AgentPresentationOverrideRow | null;
  /** Role names already defined, so create can refuse before the user loses their typing. */
  readonly takenNames: ReadonlySet<string>;
  /** The conversation agent's own configuration, for the `main` editor. */
  readonly profile: AgentProfileView | null;
  readonly capabilities: AgentCapabilityCatalog;
  readonly busy: boolean;
  /** A refused write, said where the user is looking rather than behind the backdrop. */
  readonly error: string | null;
  readonly onSave: (draft: EditorDraft, layer: 'user' | 'project') => void;
  readonly onCancel: () => void;
  readonly onDelete?: () => void;
  readonly onDuplicate?: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const role = target.kind === 'role' ? target.role : null;
  const entry = target.kind === 'presentation' || target.kind === 'main' ? target.entry : null;
  const isMain = target.kind === 'main';
  // A built-in's behaviour is code; everyone else's is theirs to write.
  const editable = target.kind !== 'presentation';

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(role?.name ?? '');
  // Seeded from what is WRITTEN, never from what is resolved. Opening `explore`
  // and changing only its colour must not also write `persona: 'Rena'` — that
  // pins today's default as a permanent override and silently opts the user out
  // of every future change to it.
  const [persona, setPersona] = useState(role?.persona ?? override?.persona ?? '');
  const [color, setColor] = useState(role?.color ?? override?.color ?? '');
  const seed = target.kind === 'new' ? target.seed : undefined;
  const [description, setDescription] = useState(role?.description ?? seed?.description ?? '');
  const [instructions, setInstructions] = useState(
    role?.developerInstructions ?? seed?.developerInstructions ?? (isMain ? profile?.developerInstructions ?? '' : ''),
  );
  const [layer, setLayer] = useState<'user' | 'project'>(
    role?.layer ?? (isMain ? profile?.layer ?? 'user' : 'user'),
  );
  // What is stored may name things the catalogue does not: an MCP or extension
  // tool, or a Skill declared but not installed. Those rows are RENDERED, so the
  // user can see and keep them — filtering the save against the catalogue alone
  // deleted them silently.
  const storedTools = isMain ? profile?.tools ?? null : role?.tools ?? null;
  const storedSkills = isMain ? profile?.skills ?? null : role?.skills ?? null;
  const toolKeys = useMemo(
    () => union(capabilities.tools.map((tool) => tool.key), storedTools),
    [capabilities.tools, storedTools],
  );
  const skillKeys = useMemo(
    () => union(capabilities.skills, storedSkills?.filter((name) => name !== '*') ?? null),
    [capabilities.skills, storedSkills],
  );
  // Checked means available. Nothing stored means everything is inherited, so
  // everything starts checked.
  const [tools, setTools] = useState<ReadonlySet<string>>(() => new Set(storedTools ?? toolKeys));
  const [skills, setSkills] = useState<ReadonlySet<string>>(
    () => new Set(resolveSkillSelection(storedSkills, skillKeys)),
  );

  // A Role needs the two fields that make it dispatchable at all: what it is
  // for (how the main agent chooses it) and what it should do. Identity is
  // optional — an unnamed Role is drawn from its own name, which is the
  // intended first appearance rather than an error state.
  // A name already in use is refused at the write boundary too; saying so here
  // is what keeps the user from losing everything else they typed.
  const nameTaken = target.kind === 'new' && takenNames.has(name.trim());
  // The loader's own rule, said here rather than only at decode. A space in the
  // name used to be refused into a banner the dialog covers, so Save read as
  // doing nothing at all.
  const nameInvalid = target.kind === 'new' && name.trim().length > 0
    && !DEFINITION_NAME_PATTERN.test(name.trim());
  const canSave = isMain || !editable
    ? true
    : name.trim().length > 0 && description.trim().length > 0
      && instructions.trim().length > 0 && !nameTaken && !nameInvalid;

  // The mark beside the title is the actual component the transcript draws, so
  // a colour is chosen against the thing it will produce rather than a swatch
  // that approximates it. With no colour set it shows what derivation gives —
  // which is what an unconfigured Role will really wear.
  const inheritedTint = entry !== null && Object.hasOwn(IDENTITY_COLOR_TINT, entry.color)
    ? IDENTITY_COLOR_TINT[entry.color as IdentityColor]
    : resolveAgentIdentity(new Map(), name.trim() || entry?.agentType || null).tint;
  const previewTint = Object.hasOwn(IDENTITY_COLOR_TINT, color)
    ? IDENTITY_COLOR_TINT[color as IdentityColor]
    : inheritedTint;

  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      labelledBy={titleId}
      onBackdropMouseDown={onCancel}
      onEscapeKeyDown={onCancel}
      surfaceClassName="agent-editor-dialog"
    >
      <div className="agent-editor-heading">
        <AgentMark mood="idle" size={40} tint={previewTint} />
        <h2 className="confirm-dialog-title" id={titleId}>
          {target.kind === 'new' ? t.settings.agents.createTitle : t.settings.agents.editTitle}
        </h2>
      </div>

      <InsetGroup ariaLabel={t.settings.agents.identityAriaLabel} label={t.settings.agents.identityGroup}>
        <label className="settings-sheet-row">
          <span className="settings-sheet-row-label">{t.settings.agents.persona}</span>
          <Input
            className="settings-sheet-row-input"
            label={t.settings.agents.persona}
            onChange={(event) => setPersona(event.target.value)}
            placeholder={entry?.persona ?? name.trim() ?? ''}
            value={persona}
            variant="bare"
          />
        </label>
        <div className="settings-sheet-row">
          <span className="settings-sheet-row-label">{t.settings.agents.colour}</span>
          <div aria-label={t.settings.agents.colour} className="agent-colour-choices" role="radiogroup">
            {/* Without a way to choose "none" the documented reset is
                unreachable: `writePresentation` removes the entry only when
                every field is empty, and a picker of hues alone can never send
                an empty colour. The swatch shows what would be inherited. */}
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

      {isMain ? (
        // The conversation agent has no type and no "use it for": there is one
        // of it and the reader is already talking to it. What it does have is
        // standing instructions — the one authored part of its system prompt.
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
      ) : editable ? (
        <InsetGroup ariaLabel={t.settings.agents.definitionAriaLabel} label={t.settings.agents.definitionGroup}>
          <label className="settings-sheet-row">
            <span className="settings-sheet-row-label">{t.settings.agents.name}</span>
            <Input
              className="settings-sheet-row-input"
              // A Role's name IS its Agent type — the key the main agent
              // dispatches by and identity is stored under. Renaming in place
              // would silently orphan both, so an existing Role's name is fixed
              // and a different name is a different Role.
              disabled={role !== null}
              label={t.settings.agents.name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t.settings.agents.namePlaceholder}
              value={name}
              variant="bare"
            />
          </label>
          {nameTaken || nameInvalid ? null : (
            <p className="settings-sheet-note agent-editor-hint">{t.settings.agents.nameSublabel}</p>
          )}
          {nameInvalid ? (
            <p className="settings-sheet-note agent-editor-conflict" role="alert">
              {t.settings.agents.nameInvalid}
            </p>
          ) : null}
          {nameTaken ? (
            // Said before Save is pressed. The write boundary refuses this name
            // too, but finding out there costs the user everything else they
            // typed into the dialog.
            <p className="settings-sheet-note agent-editor-conflict" role="alert">
              {t.settings.agents.nameTaken}
            </p>
          ) : null}
          <label className="settings-sheet-row">
            <span className="settings-sheet-row-label">{t.settings.agents.description}</span>
            <Input
              className="settings-sheet-row-input"
              label={t.settings.agents.description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t.settings.agents.descriptionPlaceholder}
              value={description}
              variant="bare"
            />
          </label>
          <div className="settings-sheet-row settings-sheet-row-stacked">
            <span className="settings-sheet-row-label">{t.settings.agents.instructions}</span>
            <Textarea
              className="settings-sheet-row-input"
              label={t.settings.agents.instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t.settings.agents.instructionsPlaceholder}
              rows={4}
              value={instructions}
              variant="bare"
            />
          </div>
        </InsetGroup>
      ) : (
        // A built-in's behaviour is code, so the way to change it is to own a
        // copy — seeded from the real definition, not from a blank form.
        <div className="settings-sheet-note agent-editor-builtin">
          <p>{t.settings.agents.builtInNote}</p>
          {onDuplicate ? (
            <Button onClick={onDuplicate} variant="secondary">{t.settings.agents.duplicate}</Button>
          ) : null}
        </div>
      )}

      {editable ? (
        <InsetGroup
          ariaLabel={t.settings.agents.capabilitiesAriaLabel}
          footnote={isMain
            ? t.settings.agents.capabilitiesMainFootnote
            : t.settings.agents.capabilitiesFootnote}
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
      ) : null}

      <InsetGroup ariaLabel={t.settings.agents.layerAriaLabel}>
        <InsetRow
          label={t.settings.agents.layer}
          sublabel={t.settings.agents.layerSublabel}
          trailing={(
            <SelectControl
              disabled={role !== null}
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

      {error ? (
        <p className="settings-sheet-note agent-editor-conflict" role="alert">{error}</p>
      ) : null}

      <div className="confirm-dialog-actions agent-editor-actions">
        {onDelete ? (
          // Quiet at rest, loud only in the confirmation: a Delete that is
          // already a solid red block reads as the dialog's main action, beside
          // a Save it is meant to be secondary to.
          <Button className="agent-editor-delete" disabled={busy} onClick={() => setConfirmingDelete(true)} variant="danger">
            {t.settings.agents.delete}
          </Button>
        ) : null}
        <Button onClick={onCancel} variant="ghost">{t.dialog.cancel}</Button>
        <Button
          disabled={busy || !canSave}
          onClick={() => onSave({
            name: name.trim(),
            description: description.trim(),
            developerInstructions: instructions.trim(),
            persona: persona.trim(),
            color,
            tools: narrowing(tools, toolKeys),
            skills: narrowing(skills, skillKeys),
          }, layer)}
          tone="subtle"
          variant="primary"
        >
          {t.settings.agents.save}
        </Button>
      </div>

      {confirmingDelete && onDelete ? (
        <ConfirmDialog
          confirmLabel={t.settings.agents.delete}
          danger
          // Says what deleting actually costs, and what it does not: a running
          // child keeps the configuration it started with, and past transcripts
          // still render their speaker.
          message={t.settings.agents.deleteMessage}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => { setConfirmingDelete(false); onDelete(); }}
          title={t.settings.agents.deleteTitle({ name: persona.trim() || name })}
        />
      ) : null}
    </Dialog>
  );
}

function layerLabel(layer: 'user' | 'project', t: ReturnType<typeof useT>): string {
  return layer === 'project' ? t.settings.agents.layerProject : t.settings.agents.layerUser;
}

/**
 * One capability list: every entry the install has, all checked by default.
 *
 * Checked is what this agent MAY use, and the list can only ever be shorter
 * than the parent's — unchecking is the whole gesture. Nothing here can grant a
 * capability the parent lacks, so the count states the ceiling rather than
 * implying the user is authorising each row.
 */
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

/**
 * Which Skills a stored narrowing means. `['*']` is the wildcard the loader
 * ships as the default — it means every Skill, so it selects all of them rather
 * than one Skill literally named `*`.
 */
function resolveSkillSelection(
  stored: readonly string[] | null | undefined,
  all: readonly string[],
): readonly string[] {
  if (!stored || stored.includes('*')) return all;
  return stored;
}

/** The catalogue plus anything already written that it does not know about. */
function union(known: readonly string[], stored: readonly string[] | null): readonly string[] {
  if (!stored) return known;
  return [...known, ...stored.filter((key) => !known.includes(key))];
}

/**
 * What to write for a checkbox list.
 *
 * Everything checked → `null`, which REMOVES the narrowing. Writing today's
 * catalogue out instead would freeze it, excluding every tool or Skill added
 * later by a list the user never meant as exhaustive.
 *
 * Anything unchecked → the exact remaining set, and that includes the empty
 * set: a user who unchecks every row means "none", and collapsing that to
 * `null` would turn their ban into a grant of everything the parent has.
 */
function narrowing(selected: ReadonlySet<string>, all: readonly string[]): readonly string[] | null {
  if (all.every((key) => selected.has(key))) return null;
  return all.filter((key) => selected.has(key));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
