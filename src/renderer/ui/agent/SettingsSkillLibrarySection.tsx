import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManagedSkillView, SkillDefinition, SkillSourceKind } from '../../api/types';
import { api } from '../../api/client';
import { AddIcon, ICON_SIZE, LoaderIcon, RefreshIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { AnchoredActionMenu, type AnchoredMenuAction } from '../primitives/AnchoredActionMenu';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/FeedbackState';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { IconButton } from '../primitives/IconButton';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { SettingsRowMenu, type RowMenuAction } from './SettingsRowMenu';
import {
  ManagedSkillsSettings,
  managedSkillActions,
  managedSkillAttentionLabel,
  managedSkillErrorMessage,
} from './ManagedSkillsSettings';
import { useManagedSkills } from './useManagedSkills';
import { cx } from '../primitives/cx';
import { beginKeyedMutation, isCurrentKeyedMutation } from '../keyedMutationGeneration';

/** A fault in the Skill's own bytes or identity, as opposed to a failed check. */
function isSkillFault(skill: ManagedSkillView): boolean {
  return skill.diagnostic?.code === 'skill_modified'
    || skill.diagnostic?.code === 'duplicate_skill_name';
}

interface SettingsSkillLibrarySectionProps {
  disabledSkills: readonly string[];
  /** Directories Tenon reads Skills from. Pointed at, never copied in. */
  additionalSkillDirectories: readonly string[];
  onDirectoriesChange: (next: string[]) => Promise<readonly string[]>;
  onToggleSkill: (skillName: string) => void;
  toggleErrors?: ReadonlyMap<string, string>;
  /**
   * Persists one name's `disabledSkills` membership immediately. Used by the
   * managed toggle, whose activation half is already immediate.
   */
  onPersistSkillDisabled: (skillName: string, disabled: boolean) => Promise<boolean>;
  /** Reports the actual unified row count back to the Agent category. */
  onSkillCountChange: (count: number) => void;
  /**
   * Reports how many managed Skills currently have an update waiting. The shell
   * owns the nav badge and cannot see this list, so while the library is mounted
   * it is the authority on that count.
   */
  onUpdateCountChange: (count: number) => void;
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
/** POSIX-style parent, since main hands back an absolute resolved path. */
function parentDirectoryOf(directory: string): string {
  const trimmed = directory.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut > 0 ? trimmed.slice(0, cut) : '/';
}

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
  /** Whether typing `/name` in the composer actually invokes it. */
  userInvocable: boolean;
  description: string;
  /** The chip that names where this Skill came from. */
  sourceChip: string;
  /** Provenance / status chips shown after the source chip. */
  chips: string[];
  /**
   * Why this Skill needs attention, in words. Carried alongside the description
   * rather than replacing it — a status chip alone never says what went wrong,
   * and for an incompatible Skill the row would otherwise look ordinary while
   * the runtime is not loading it at all.
   */
  diagnostic?: string;
  /**
   * Whether the diagnostic is about the Skill itself or about Tenon's last
   * attempt to reach GitHub. An offline launch produces the latter for every
   * installed Skill, and painting those red is the repaint the description rule
   * exists to avoid.
   */
  diagnosticTone?: 'danger' | 'muted';
  enabled: boolean;
  dimmed: boolean;
  toggleLabel: string;
  onToggle: (enabled: boolean) => void;
  actions: RowMenuAction[];
  actionsLabel: string;
}

export function SettingsSkillLibrarySection({
  disabledSkills,
  additionalSkillDirectories,
  onDirectoriesChange,
  onToggleSkill,
  toggleErrors = EMPTY_STRING_MAP,
  onPersistSkillDisabled,
  onSkillCountChange,
  onUpdateCountChange,
  onError,
  onNotice,
  onApplied,
}: SettingsSkillLibrarySectionProps) {
  const t = useT();
  const [allSkills, setAllSkills] = useState<SkillDefinition[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [loadingSkills, setLoadingSkills] = useState(false);
  // Undo round-trips through main and returns the refreshed skill list; its own
  // menu action is disabled while that provenance mutation is in flight.
  const [provenanceActionBusy, setProvenanceActionBusy] = useState(false);
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [acquireOpen, setAcquireOpen] = useState(false);
  // A pick that turned out to be a Skill folder, awaiting the user's decision
  // about binding its parent instead.
  const [pendingParentBind, setPendingParentBind] = useState<{ picked: string; parent: string } | null>(null);
  // Unbinding is not destructive to files, but it is invisible in scale: the
  // action is offered on EVERY row that came from the directory, and one click
  // removes all of them at once. The confirmation exists to say how many.
  const [pendingUnbind, setPendingUnbind] = useState<{ directory: string; skillCount: number } | null>(null);
  const [managedToggleOverrides, setManagedToggleOverrides] = useState<Map<string, boolean>>(new Map());
  const [managedToggleErrors, setManagedToggleErrors] = useState<Map<string, string>>(new Map());
  const addAnchorRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(false);
  const sectionRequestRef = useRef(0);
  const disabledSkillsRef = useRef(disabledSkills);
  disabledSkillsRef.current = disabledSkills;
  const managedToggleTargetsRef = useRef(new Map<string, boolean>());
  const managedToggleQueuesRef = useRef(new Map<string, Promise<void>>());
  const managedToggleGenerationsRef = useRef(new Map<string, number>());
  const managed = useManagedSkills(onApplied, async (installed) => {
    if (!disabledSkillsRef.current.includes(installed.name)) return true;
    return onPersistSkillDisabled(installed.name, false);
  });

  // A local directory is POINTED AT, never copied in: Tenon stores the path, so
  // the user's edits are live and there is no snapshot to drift.
  async function addLocalDirectory() {
    onError(null);
    onNotice(null);
    try {
      const picked = await api.agentPickSkillDirectory();
      if (!picked.path) return;
      // Tenon reads Skills from the folders INSIDE a bound directory. When the
      // chosen folder is itself a Skill, the useful thing to bind is its
      // parent — but that is a wider scope than the user picked, and every
      // sibling folder under it becomes a putative Skill root. Ask; do not
      // decide for them and report it afterwards.
      if (picked.isSkillFolder) {
        if (!picked.nameValid) {
          onError(t.settings.skills.localDirectoryUnnameable({ directory: picked.path }));
          return;
        }
        setPendingParentBind({ picked: picked.path, parent: parentDirectoryOf(picked.path) });
        return;
      }
      await bindDirectory(picked.path);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function bindDirectory(path: string) {
    try {
      if (additionalSkillDirectories.includes(path)) {
        onNotice(t.settings.skills.localDirectoryAlreadyBound({ directory: path }));
        return;
      }
      onError(null);
      onNotice(null);
      const kept = await onDirectoriesChange([...additionalSkillDirectories, path]);
      // The stored list is bounded. Past the limit the new path is dropped on
      // write, and without this the dialog would just close and nothing would
      // appear — no row, no error, no notice.
      if (!kept.includes(path)) {
        onError(t.settings.skills.localDirectoryLimit({ count: kept.length }));
        return;
      }
      await reloadSkills();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Reveals a bound directory, and reports it when the directory is gone. */
  async function revealDirectory(directory: string) {
    onError(null);
    try {
      const { revealed } = await api.agentRevealSkillDirectory(directory);
      if (!revealed) onError(t.settings.skills.revealFailed({ directory }));
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
      if (isCurrent()) {
        setAllSkills(skills);
        setSkillsLoaded(true);
      }
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

  // Keep the shell's nav badge honest for as long as this list is mounted: the
  // shell's own read happens once, before the ambient check has run and before
  // the user applies anything.
  useEffect(() => {
    // Not before the list is read. Firing on the initial empty array reported
    // "no updates" and wiped a badge the shell had already computed — and if
    // the read then failed, nothing ever restored it.
    if (!managed.listLoaded) return;
    onUpdateCountChange(managed.skills.filter((skill) => skill.updateCommit).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managed.listLoaded, managed.skills]);

  useEffect(() => {
    if (!skillsLoaded || !managed.listLoaded) return;
    onSkillCountChange(
      allSkills.filter((skill) => skill.source !== 'managed').length + managed.skills.length,
    );
  }, [allSkills, managed.listLoaded, managed.skills, onSkillCountChange, skillsLoaded]);

  const runSkillProvenanceAction = (action: () => Promise<SkillDefinition[]>) => {
    setProvenanceActionBusy(true);
    onError(null);
    void action()
      .then((skills) => setAllSkills(skills))
      .catch((cause) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setProvenanceActionBusy(false));
  };

  // Every chip in this column is localized. Returning the raw enum for
  // built-in/user/project while managed and local were translated produced
  // mixed-language chips in one column.
  /**
   * Where each Skill actually lives on disk. Code-registered built-ins carry a
   * display-safe pseudo path (`built-in/<name>`) rather than a real one, so only
   * absolute paths get a reveal action — offering one that cannot open anything
   * is worse than not offering it.
   */
  const skillRoots = useMemo(() => {
    const roots = new Map<string, string>();
    for (const skill of allSkills) {
      if (skill.rootDir.startsWith('/')) roots.set(skill.name, skill.rootDir);
    }
    return roots;
  }, [allSkills]);

  function revealAction(skillName: string): RowMenuAction[] {
    const rootDir = skillRoots.get(skillName);
    if (!rootDir) return [];
    return [{
      label: t.settings.skills.revealInFinder,
      onSelect: () => void revealDirectory(rootDir),
    }];
  }

  /**
   * Managed Skills get no reveal, for two reasons that point the same way.
   *
   * Their content root is deliberately immutable — resolveSkillContentTarget
   * returns null for anything under it — and opening it invites the hand edit
   * that flips the record to `modified`, at which point activeRuntimeRoots
   * drops it and the Skill leaves the model's catalog until it is reinstalled.
   *
   * And the lookup is by name: a managed Skill sharing a name with a user Skill
   * would resolve to the USER Skill's folder, so the rows most in need of the
   * action — suppressed by a name conflict — are exactly the ones it would send
   * to the wrong place.
   */
  const managedRevealAction: RowMenuAction[] = [];

  const sourceChipLabel = (source: SkillSourceKind): string => {
    if (source === 'built-in') return t.settings.skills.sourceBuiltIn;
    if (source === 'project') return t.settings.skills.sourceProject;
    if (source === 'managed') return t.settings.skills.sourceManaged;
    return t.settings.skills.sourceUser;
  };

  function toggleManagedSkill(skill: ManagedSkillView) {
    const persistedEnabled = skill.enabled && !disabledSkillsRef.current.includes(skill.name);
    const enabled = !(managedToggleTargetsRef.current.get(skill.id) ?? persistedEnabled);
    const generation = beginKeyedMutation(managedToggleGenerationsRef.current, skill.id);
    managedToggleTargetsRef.current.set(skill.id, enabled);
    setManagedToggleOverrides((current) => withMapValue(current, skill.id, enabled));
    setManagedToggleErrors((current) => withoutMapKey(current, skill.name));
    managed.clearFeedback();

    const prior = managedToggleQueuesRef.current.get(skill.id) ?? Promise.resolve();
    const run = prior.then(async () => {
      const result = await managed.setEnabled(skill, enabled);
      if (!result.ok) {
        if (isCurrentManagedToggle(skill.id, generation)) {
          managedToggleTargetsRef.current.delete(skill.id);
          setManagedToggleOverrides((current) => withoutMapKey(current, skill.id));
          setManagedToggleErrors((current) => withMapValue(
            current,
            skill.name,
            managedSkillErrorMessage(result.error, t),
          ));
        }
        return;
      }

      // The managed index and disabledSkills are deliberately separate stores.
      // Keep the optimistic override visible across both writes so the one switch
      // still behaves as one control.
      if (enabled && disabledSkillsRef.current.includes(skill.name)) {
        if (!(await onPersistSkillDisabled(skill.name, false))) {
          if (isCurrentManagedToggle(skill.id, generation)) {
            managedToggleTargetsRef.current.delete(skill.id);
            setManagedToggleOverrides((current) => withoutMapKey(current, skill.id));
            managed.clearFeedback();
          }
          return;
        }
      }

      if (isCurrentManagedToggle(skill.id, generation)) {
        managedToggleTargetsRef.current.delete(skill.id);
        setManagedToggleOverrides((current) => withoutMapKey(current, skill.id));
        setManagedToggleErrors((current) => withoutMapKey(current, skill.name));
        managed.showEnabledNotice(skill.name, enabled);
      }
    });
    managedToggleQueuesRef.current.set(skill.id, run.then(() => undefined, () => undefined));
  }

  function isCurrentManagedToggle(skillId: string, generation: number): boolean {
    return mountedRef.current
      && isCurrentKeyedMutation(managedToggleGenerationsRef.current, skillId, generation);
  }

  /**
   * Managed rows come from the managed index rather than the loaded catalog,
   * because a Skill that is installed but not activated is absent from the
   * catalog and still has to appear here — installed-but-off is a state the user
   * owns and must be able to see and reverse.
   */
  const managedRows: LibraryRow[] = useMemo(() => managed.skills.map((skill) => {
    // The row reflects the same predicate main applies, so the list can never
    // claim a Skill is on while the model cannot see it.
    const persistedEnabled = skill.enabled && !disabledSkills.includes(skill.name);
    const enabled = managedToggleOverrides.get(skill.id) ?? persistedEnabled;
    const busy = managed.busy !== null;
    const attention = managedSkillAttentionLabel(skill, t);
    return {
      key: `managed:${skill.id}`,
      name: skill.name,
      displayName: skill.name,
      userInvocable: skill.userInvocable,
      // The description always survives. A failed update check is produced for
      // every installed Skill by an offline launch, from an action the user
      // never requested, so it must not repaint the library; but it still has
      // to be readable, which a generic "Needs attention" chip is not.
      description: skill.description,
      ...(skill.diagnostic ? {
        diagnostic: managedSkillErrorMessage(skill.diagnostic, t),
        // Only a fault in the Skill or its compatibility earns the status
        // colour. A failed update check says nothing is wrong with it — still
        // installed, still pinned, still invocable — and a rollback the user
        // just asked for and got is a success, not a fault; keying on
        // status === 'failed' painted that one red, because a rollback sets
        // updateCommit and so reports status 'update-available'.
        diagnosticTone: isSkillFault(skill) || skill.compatibility.status === 'incompatible'
          ? 'danger' as const
          : 'muted' as const,
      } : {}),
      sourceChip: t.settings.skills.sourceManaged,
      chips: [
        skill.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified,
        ...(attention ? [attention] : []),
      ],
      enabled,
      dimmed: !enabled || skill.status === 'modified',
      toggleLabel: t.settings.skills.managedEnableToggle({ name: skill.name }),
      onToggle: () => toggleManagedSkill(skill),
      actions: [...managedRevealAction, ...managedSkillActions(skill, {
        check: () => void managed.checkUpdates(skill.id),
        preview: () => void managed.previewUpdate(skill),
        rollback: () => managed.openConfirmAction({ kind: 'rollback', skill }),
        uninstall: () => managed.openConfirmAction({ kind: 'uninstall', skill }),
      }, t, busy)],
      actionsLabel: t.settings.skills.rowActionsAriaLabel({ name: skill.name }),
    } satisfies LibraryRow;
    // skillRoots is read through revealAction. Omitting it memoized every
    // managed row against an empty map — agent_list_all_skills resolves after
    // agent_managed_skill_list — so managed rows lost "Show in Finder" for the
    // life of the pane whenever nothing later replaced managed.skills.
    // Data only. The controller object and its methods are rebuilt on every
    // render, so depending on them would recompute every row every time and
    // defeat the memo outright. skillRoots is absent because managed rows no
    // longer resolve a folder to reveal.
  }), [disabledSkills, managed.busy, managed.skills, managedToggleOverrides, t]);

  const localRows: LibraryRow[] = useMemo(() => allSkills
    .filter((skill) => skill.source !== 'managed')
    .map((skill) => {
      const disabled = disabledSkills.includes(skill.name);
      const actions: RowMenuAction[] = [...revealAction(skill.name)];
      if (skill.canUndoLastAgentEdit) {
        actions.push({
          label: t.settings.skills.undoAgentEdit,
          disabled: provenanceActionBusy,
          onSelect: () => runSkillProvenanceAction(() => api.agentUndoSkillAgentEdit(skill.name)),
        });
      }
      const chips: string[] = [];
      const localDirectory = directoryContaining(skill.rootDir, additionalSkillDirectories);
      if (localDirectory) {
        // No second "Show in Finder" here: the row already offers one for its
        // own folder (revealAction above). A duplicate label did two different
        // things, and AnchoredActionMenu keys on the label, so the two also
        // collided as React children.
        actions.push({
          // "Unbind", never "remove" or "delete": the handler drops Tenon's
          // pointer and leaves every file where it is. The label has to say the
          // same thing the handler does.
          label: t.settings.skills.localUnbind,
          onSelect: () => setPendingUnbind({
            directory: localDirectory,
            skillCount: allSkills.filter((candidate) => directoryContaining(candidate.rootDir, additionalSkillDirectories) === localDirectory).length,
          }),
        });
      }
      return {
        key: `skill:${skill.name}`,
        name: skill.name,
        displayName: skill.displayName || skill.name,
        userInvocable: skill.userInvocable,
        description: skill.description,
        sourceChip: localDirectory ? t.settings.skills.sourceLocal : sourceChipLabel(skill.source),
        chips,
        enabled: !disabled,
        dimmed: disabled,
        toggleLabel: t.settings.skills.toggleSkill({ name: skill.name }),
        onToggle: () => onToggleSkill(skill.name),
        actions,
        actionsLabel: t.settings.skills.rowActionsAriaLabel({ name: skill.name }),
      } satisfies LibraryRow;
    }), [allSkills, disabledSkills, onToggleSkill, provenanceActionBusy, t]);

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

  // Every name the library already holds, whatever its source. Managed install
  // refuses a name that is taken, so the acquisition panel needs this to avoid
  // offering an Install that cannot succeed.
  const existingSkillNames = useMemo(
    () => new Set([...allSkills.map((skill) => skill.name), ...managed.skills.map((skill) => skill.name)]),
    [allSkills, managed.skills],
  );

  const loading = loadingSkills || managed.loading;

  // The `+` is an icon-only chrome control (B6): colour deepens on hover, no box.
  const addControl = (
    <>
      {/* Check every managed Skill at once. Only managed Skills have an
          upstream to compare against — a user, project, local, or built-in
          Skill is the user's own file, with nothing to be newer than it — so
          this is absent rather than dead when none are installed. Per-Skill
          checks live in each managed row's ⋯ menu. Both ambient triggers are
          throttled per record; neither of these is. */}
      {managed.skills.length > 0 ? (
        <IconButton
          className="rail-toggle"
          disabled={managed.busy !== null}
          icon={RefreshIcon}
          iconSize={ICON_SIZE.menu}
          label={t.settings.skills.checkUpdatesAriaLabel}
          onClick={() => void managed.checkUpdates()}
          variant="chrome"
        />
      ) : null}
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
      {pendingUnbind ? (
        <ConfirmDialog
          cancelLabel={t.dialog.cancel}
          confirmLabel={t.settings.skills.localUnbind}
          message={t.settings.skills.localUnbindConfirmMessage({
            directory: pendingUnbind.directory,
            count: pendingUnbind.skillCount,
          })}
          onCancel={() => setPendingUnbind(null)}
          onConfirm={() => {
            const directory = pendingUnbind.directory;
            setPendingUnbind(null);
            void unbindDirectory(directory);
          }}
          title={t.settings.skills.localUnbindConfirmTitle}
        />
      ) : null}
      {pendingParentBind ? (
        <ConfirmDialog
          cancelLabel={t.dialog.cancel}
          confirmLabel={t.settings.skills.localDirectoryBindParentConfirm}
          message={t.settings.skills.localDirectoryBindParentMessage({
            picked: pendingParentBind.picked,
            parent: pendingParentBind.parent,
          })}
          onCancel={() => setPendingParentBind(null)}
          onConfirm={() => {
            const parent = pendingParentBind.parent;
            setPendingParentBind(null);
            void bindDirectory(parent);
          }}
          title={t.settings.skills.localDirectoryBindParentTitle}
        />
      ) : null}
      <ManagedSkillsSettings
        controller={managed}
        existingSkillNames={existingSkillNames}
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
            <InsetRow empty label={t.settings.skills.noneInstalled} />
          ) : null}
          {rows.map((row) => (
            <InsetRow
              dimmed={row.dimmed}
              feedback={(toggleErrors.get(row.name) ?? managedToggleErrors.get(row.name)) ? (
                <span role="alert">{toggleErrors.get(row.name) ?? managedToggleErrors.get(row.name)}</span>
              ) : undefined}
              key={row.key}
              label={(
                <>
                  {/* The slash form only where typing it does something. A Skill
                      declaring `user-invocable: false` was still displayed as
                      `/foo`, advertising a command the composer filters out. */}
                  {row.userInvocable ? `/${row.displayName}` : row.displayName}
                  <span className="settings-chip">{row.sourceChip}</span>
                  {row.chips.map((chip) => (
                    <span className="settings-chip" key={chip}>{chip}</span>
                  ))}
                </>
              )}
              sublabel={(
                <>
                  {/* Keep the list scan-stable at two description lines. The full
                      text remains in the accessibility tree and in the Skill
                      source; focusing the menu or switch must not reflow rows. */}
                  <span className="settings-skill-description">
                    {row.description}
                  </span>
                  {row.diagnostic ? (
                    <span className={cx('settings-skill-diagnostic', row.diagnosticTone === 'muted' && 'is-muted')}>
                      {row.diagnostic}
                    </span>
                  ) : null}
                </>
              )}
              trailing={(
                <>
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
                      label: t.settings.skills.revealInFinder,
                      onSelect: () => void revealDirectory(directory),
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

const EMPTY_STRING_MAP: ReadonlyMap<string, string> = new Map();

function withMapValue<K, V>(current: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(current);
  next.set(key, value);
  return next;
}

function withoutMapKey<K, V>(current: ReadonlyMap<K, V>, key: K): Map<K, V> {
  if (!current.has(key)) return current as Map<K, V>;
  const next = new Map(current);
  next.delete(key);
  return next;
}
