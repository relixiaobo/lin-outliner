import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManagedSkillView, SkillDefinition, SkillSourceKind } from '../../api/types';
import { api } from '../../api/client';
import { AddIcon, ICON_SIZE, LoaderIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { AnchoredActionMenu, type AnchoredMenuAction } from '../primitives/AnchoredActionMenu';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { SettingsRowMenu, type RowMenuAction } from './SettingsRowMenu';
import {
  ManagedSkillsSettings,
  managedSkillActions,
  managedSkillErrorMessage,
  managedStatusLabel,
} from './ManagedSkillsSettings';
import { useManagedSkills } from './useManagedSkills';

interface SettingsSkillLibrarySectionProps {
  disabledSkills: readonly string[];
  /** Directories Tenon reads Skills from. Pointed at, never copied in. */
  additionalSkillDirectories: readonly string[];
  onDirectoriesChange: (next: string[]) => Promise<void>;
  onToggleSkill: (skillName: string) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onApplied: () => Promise<void>;
}

/**
 * True when a Skill was loaded out of one of the user's own directories. Local
 * Skills are ordinary user/project Skills to the runtime; the only thing that
 * marks them is the directory they came from, so the row is identified by path
 * rather than by source.
 */
function directoryContaining(
  rootDir: string,
  directories: readonly string[],
): string | undefined {
  return directories.find((dir) => rootDir === dir || rootDir.startsWith(`${dir}/`));
}

/**
 * One row in the library, whatever the Skill's origin. A user thinks "my
 * Skills"; where one came from is an attribute of the row, not a section it
 * lives in.
 */
interface LibraryRow {
  key: string;
  name: string;
  displayName: string;
  description: string;
  /** The chip that names where this Skill came from. */
  sourceChip: string;
  /** Trust / status chips shown after the source chip. */
  chips: string[];
  enabled: boolean;
  /** Controls are quiet while a mutation for this row is in flight. */
  busy: boolean;
  dimmed: boolean;
  toggleLabel: string;
  onToggle: (enabled: boolean) => void;
  actions: RowMenuAction[];
  actionsLabel: string;
  /** Row-level accept action, used by unratified user/project Skills. */
  accept?: { label: string; ariaLabel: string; onSelect: () => void };
}

export function SettingsSkillLibrarySection({
  disabledSkills,
  additionalSkillDirectories,
  onDirectoriesChange,
  onToggleSkill,
  onError,
  onNotice,
  onApplied,
}: SettingsSkillLibrarySectionProps) {
  const t = useT();
  const [allSkills, setAllSkills] = useState<SkillDefinition[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  // Skill trust actions (accept / revoke / undo) round-trip through main and return
  // the refreshed skill list; one shared busy flag keeps the row controls quiet
  // while a mutation is in flight.
  const [skillTrustBusy, setSkillTrustBusy] = useState(false);
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [acquireOpen, setAcquireOpen] = useState(false);
  const addAnchorRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(false);
  const sectionRequestRef = useRef(0);
  const managed = useManagedSkills(onApplied);

  // A local directory is POINTED AT, never copied in: Tenon stores the path, so
  // the user's edits are live and there is no snapshot to drift.
  async function addLocalDirectory() {
    onError(null);
    onNotice(null);
    try {
      const { path } = await api.agentPickSkillDirectory();
      if (!path) return;
      if (additionalSkillDirectories.includes(path)) return;
      await onDirectoriesChange([...additionalSkillDirectories, path]);
      await reloadSkills();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * Unbinds a directory. This removes Tenon's pointer to it and NOTHING else —
   * the directory and every file in it are the user's and are left untouched.
   */
  async function unbindDirectory(directory: string) {
    onError(null);
    onNotice(null);
    try {
      await onDirectoriesChange(additionalSkillDirectories.filter((dir) => dir !== directory));
      await reloadSkills();
      onNotice(t.settings.skills.localUnboundNotice({ directory }));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // Acquisition lives behind `+` instead of occupying the page. The menu is the
  // level-1 chrome surface here and reuses the registered popover glass, which
  // carries the prefers-reduced-transparency opaque fallback with it.
  const addActions: AnchoredMenuAction[] = [
    { label: t.settings.skills.addSkill, onSelect: () => setAcquireOpen(true) },
    { label: t.settings.skills.addLocalDirectory, onSelect: () => void addLocalDirectory() },
  ];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sectionRequestRef.current += 1;
    };
  }, []);

  async function reloadSkills(): Promise<void> {
    sectionRequestRef.current += 1;
    const id = sectionRequestRef.current;
    const isCurrent = () => mountedRef.current && id === sectionRequestRef.current;
    setLoadingSkills(true);
    try {
      const skills = await api.agentListAllSkills();
      if (isCurrent()) setAllSkills(skills);
    } catch (caught) {
      if (isCurrent()) onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrent()) setLoadingSkills(false);
    }
  }

  useEffect(() => {
    onError(null);
    onNotice(null);
    void reloadSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSkillTrustAction = (action: () => Promise<SkillDefinition[]>) => {
    setSkillTrustBusy(true);
    onError(null);
    void action()
      .then((skills) => setAllSkills(skills))
      .catch((cause) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSkillTrustBusy(false));
  };

  const sourceChipLabel = (source: SkillSourceKind): string => source;

  /**
   * Managed rows come from the managed index rather than the loaded catalog,
   * because a Skill that is installed but not activated is absent from the
   * catalog and still has to appear here — installed-but-off is a state the user
   * owns and must be able to see and reverse.
   */
  const managedRows: LibraryRow[] = useMemo(() => managed.skills.map((skill) => {
    // The row reflects the same predicate main applies, so the list can never
    // claim a Skill is on while the model cannot see it.
    const enabled = skill.enabled && !disabledSkills.includes(skill.name);
    const busy = managed.busy !== null;
    return {
      key: `managed:${skill.id}`,
      name: skill.name,
      displayName: skill.name,
      description: skill.diagnostic ? managedSkillErrorMessage(skill.diagnostic, t) : skill.description,
      sourceChip: t.settings.skills.sourceManaged,
      chips: [
        skill.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified,
        managedStatusLabel(skill, t),
      ],
      enabled,
      busy,
      dimmed: !enabled || skill.status === 'modified',
      toggleLabel: t.settings.skills.managedEnableToggle({ name: skill.name }),
      onToggle: (next: boolean) => {
        void managed.setEnabled(skill, next);
        // A managed Skill can also be named in disabledSkills. Clearing it on
        // enable keeps the control from looking stuck: activation alone would
        // not be enough to turn the row back on.
        if (next && disabledSkills.includes(skill.name)) onToggleSkill(skill.name);
      },
      actions: managedSkillActions(skill, {
        check: () => void managed.checkUpdates(skill.id),
        preview: () => void managed.previewUpdate(skill),
        rollback: () => managed.openConfirmAction({ kind: 'rollback', skill }),
        uninstall: () => managed.openConfirmAction({ kind: 'uninstall', skill }),
      }, t, busy),
      actionsLabel: t.settings.skills.rowActionsAriaLabel({ name: skill.name }),
    } satisfies LibraryRow;
  }), [disabledSkills, managed.busy, managed.skills, onToggleSkill, t]);

  const localRows: LibraryRow[] = useMemo(() => allSkills
    .filter((skill) => skill.source !== 'managed')
    .map((skill) => {
      const disabled = disabledSkills.includes(skill.name);
      // Trust state is derived in main. Mutable skills are model-usable
      // by default; acceptedHash is only a retained management fact.
      const pending = !skill.ratified;
      const actions: RowMenuAction[] = [];
      if (skill.accepted) {
        actions.push({
          label: t.settings.skills.revokeAcceptance,
          disabled: skillTrustBusy,
          onSelect: () => runSkillTrustAction(() => api.agentRevokeSkillAcceptance(skill.name)),
        });
      }
      if (skill.canUndoLastAgentEdit) {
        actions.push({
          label: t.settings.skills.undoAgentEdit,
          disabled: skillTrustBusy,
          onSelect: () => runSkillTrustAction(() => api.agentUndoSkillAgentEdit(skill.name)),
        });
      }
      const chips: string[] = [];
      if (pending) {
        chips.push(skill.source === 'project'
          ? t.settings.skills.pendingWorkspaceChip
          : t.settings.skills.pendingChip);
      } else if (skill.accepted) {
        chips.push(t.settings.skills.acceptedChip);
      }
      const localDirectory = directoryContaining(skill.rootDir, additionalSkillDirectories);
      if (localDirectory) {
        actions.push({
          label: t.settings.skills.localReveal,
          onSelect: () => void api.agentRevealSkillDirectory(localDirectory),
        });
        actions.push({
          // "Unbind", never "remove" or "delete": the handler drops Tenon's
          // pointer and leaves every file where it is. The label has to say the
          // same thing the handler does.
          label: t.settings.skills.localUnbind,
          onSelect: () => void unbindDirectory(localDirectory),
        });
      }
      return {
        key: `skill:${skill.name}`,
        name: skill.name,
        displayName: skill.displayName || skill.name,
        description: skill.description,
        sourceChip: localDirectory ? t.settings.skills.sourceLocal : sourceChipLabel(skill.source),
        chips,
        enabled: !disabled,
        busy: skillTrustBusy,
        dimmed: disabled,
        toggleLabel: t.settings.skills.toggleSkill({ name: skill.name }),
        onToggle: () => onToggleSkill(skill.name),
        actions,
        actionsLabel: t.settings.skills.rowActionsAriaLabel({ name: skill.name }),
        ...(pending ? {
          accept: {
            label: t.settings.skills.acceptButton,
            ariaLabel: t.settings.skills.acceptSkill({ name: skill.name }),
            onSelect: () => runSkillTrustAction(() => api.agentAcceptSkill(skill.name, skill.contentHash ?? '')),
          },
        } : {}),
      } satisfies LibraryRow;
    }), [allSkills, disabledSkills, onToggleSkill, skillTrustBusy, t]);

  // One list, sorted by the name the user reads, so a Skill's position never
  // depends on where it came from.
  const rows = useMemo(
    () => [...managedRows, ...localRows].sort((left, right) => left.name.localeCompare(right.name)),
    [localRows, managedRows],
  );

  // A bound directory that currently yields no Skills would otherwise be
  // invisible — and so impossible to unbind. Showing it keeps pointing at the
  // wrong folder a reversible mistake.
  const emptyDirectories = useMemo(
    () => additionalSkillDirectories.filter((dir) => !allSkills.some(
      (skill) => directoryContaining(skill.rootDir, [dir]),
    )),
    [additionalSkillDirectories, allSkills],
  );

  const loading = loadingSkills || managed.loading;

  // The `+` is an icon-only chrome control (B6): colour deepens on hover, no box.
  const addControl = (
    <>
      <IconButton
        aria-expanded={addMenuOpen}
        aria-haspopup="menu"
        className="rail-toggle"
        icon={AddIcon}
        iconSize={ICON_SIZE.menu}
        label={t.settings.skills.addAriaLabel}
        onClick={() => setAddMenuOpen((current) => !current)}
        ref={addAnchorRef}
        variant="chrome"
      />
      {addMenuOpen ? (
        <AnchoredActionMenu
          actions={addActions}
          anchorRef={addAnchorRef}
          ariaLabel={t.settings.skills.addMenuAriaLabel}
          className="settings-row-menu"
          itemClassName="settings-row-menu-item"
          itemLabelClassName="settings-row-menu-item-label"
          onClose={() => setAddMenuOpen(false)}
          width={208}
        />
      ) : null}
    </>
  );

  return (
    <section className="agent-settings-section settings-skills-section" aria-label={t.settings.skills.sectionAriaLabel}>
      <ManagedSkillsSettings
        controller={managed}
        onClose={() => setAcquireOpen(false)}
        open={acquireOpen}
      />

      {loading && rows.length === 0 && emptyDirectories.length === 0 ? (
        <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" size="inline" title={t.settings.skills.loadingInstalled} />
      ) : (
        <InsetGroup
          ariaLabel={t.settings.skills.installedAriaLabel}
          headerAction={addControl}
          label={t.settings.skills.installedGroup}
        >
          {rows.length === 0 && emptyDirectories.length === 0 ? (
            <InsetRow disabled label={t.settings.skills.noneInstalled} />
          ) : null}
          {rows.map((row) => (
            <InsetRow
              dimmed={row.dimmed}
              key={row.key}
              label={(
                <>
                  /{row.displayName}
                  <span className="settings-chip">{row.sourceChip}</span>
                  {row.chips.map((chip) => (
                    <span className="settings-chip" key={chip}>{chip}</span>
                  ))}
                </>
              )}
              sublabel={row.description}
              trailing={(
                <>
                  {row.accept ? (
                    <Button
                      aria-label={row.accept.ariaLabel}
                      className="settings-skill-accept"
                      disabled={row.busy}
                      onClick={row.accept.onSelect}
                      size="sm"
                      variant="secondary"
                    >
                      {row.accept.label}
                    </Button>
                  ) : null}
                  {row.actions.length > 0 ? (
                    <SettingsRowMenu
                      actions={row.actions}
                      ariaLabel={row.actionsLabel}
                      onOpenChange={(open) => setOpenRowMenu(open ? row.key : null)}
                      open={openRowMenu === row.key}
                    />
                  ) : null}
                  <SwitchControl
                    checked={row.enabled}
                    disabled={row.busy}
                    onCheckedChange={row.onToggle}
                    label={row.toggleLabel}
                  >
                    <SwitchMark checked={row.enabled} />
                  </SwitchControl>
                </>
              )}
              wrap
            />
          ))}
          {emptyDirectories.map((directory) => (
            <InsetRow
              key={`dir:${directory}`}
              label={(
                <>
                  {directory}
                  <span className="settings-chip">{t.settings.skills.sourceLocal}</span>
                </>
              )}
              sublabel={t.settings.skills.localDirectoryEmpty}
              trailing={(
                <SettingsRowMenu
                  actions={[
                    {
                      label: t.settings.skills.localReveal,
                      onSelect: () => void api.agentRevealSkillDirectory(directory),
                    },
                    {
                      label: t.settings.skills.localUnbind,
                      onSelect: () => void unbindDirectory(directory),
                    },
                  ]}
                  ariaLabel={t.settings.skills.localDirectoryActions({ directory })}
                  onOpenChange={(open) => setOpenRowMenu(open ? `dir:${directory}` : null)}
                  open={openRowMenu === `dir:${directory}`}
                />
              )}
              wrap
            />
          ))}
        </InsetGroup>
      )}
    </section>
  );
}
