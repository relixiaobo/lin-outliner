import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  ManagedSkillCatalogView,
  ManagedSkillDiscoveryCandidateView,
  ManagedSkillDiscoveryView,
  ManagedSkillErrorView,
  ManagedSkillUpdatePreviewView,
  ManagedSkillView,
} from '../../api/types';
import { api, managedSkillErrorFromUnknown } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import {
  AddIcon,
  ICON_SIZE,
  LoaderIcon,
  RefreshIcon,
  SkillIcon,
  TrashIcon,
  UndoIcon,
  WarningIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { Dialog } from '../primitives/Dialog';
import { EmptyState } from '../primitives/FeedbackState';
import { Input } from '../primitives/Input';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { SettingsRowMenu, type RowMenuAction } from './SettingsRowMenu';

interface ManagedSkillsSettingsProps {
  onApplied: () => Promise<void>;
}

type ConfirmAction =
  | { kind: 'rollback'; skill: ManagedSkillView }
  | { kind: 'uninstall'; skill: ManagedSkillView };

interface InstallReview {
  discovery: ManagedSkillDiscoveryView;
  candidate: ManagedSkillDiscoveryCandidateView;
}

export function ManagedSkillsSettings({ onApplied }: ManagedSkillsSettingsProps) {
  const t = useT();
  const [catalog, setCatalog] = useState<ManagedSkillCatalogView | null>(null);
  const [skills, setSkills] = useState<ManagedSkillView[]>([]);
  const [sourceUrl, setSourceUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ManagedSkillErrorView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [selection, setSelection] = useState<ManagedSkillDiscoveryView | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [installReview, setInstallReview] = useState<InstallReview | null>(null);
  const [updatePreview, setUpdatePreview] = useState<ManagedSkillUpdatePreviewView | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const mounted = useRef(true);

  const installedCatalogIds = useMemo(
    () => new Set(catalog?.entries.filter((entry) => entry.installedSkillId).map((entry) => entry.id) ?? []),
    [catalog],
  );

  useEffect(() => {
    mounted.current = true;
    void loadAll(true);
    return () => { mounted.current = false; };
  }, []);

  async function loadAll(checkUpdates: boolean) {
    setLoading(true);
    setError(null);
    try {
      const [nextCatalog, installed] = await Promise.all([
        api.agentManagedSkillCatalog(),
        api.agentManagedSkillList(),
      ]);
      if (!mounted.current) return;
      setCatalog(nextCatalog);
      setSkills(installed);
      if (checkUpdates && installed.length > 0) {
        void api.agentManagedSkillCheckUpdates()
          .then((checked) => { if (mounted.current) setSkills(checked); })
          .catch((cause) => { if (mounted.current) setError(managedSkillErrorFromUnknown(cause)); });
      }
    } catch (cause) {
      if (mounted.current) setError(managedSkillErrorFromUnknown(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  async function beginDiscovery(input: { sourceUrl?: string; catalogId?: string }) {
    const operation = input.catalogId ? `catalog:${input.catalogId}` : 'github';
    setBusy(operation);
    clearFeedback();
    try {
      const discovery = await api.agentManagedSkillDiscover(input);
      if (!mounted.current) return;
      if (discovery.selectionRequired) {
        setSelection(discovery);
        setSelectedCandidateId(null);
      } else {
        const candidate = discovery.candidates[0];
        if (!candidate) {
          setError({ code: 'candidate_not_found' });
          return;
        }
        setInstallReview({ discovery, candidate });
      }
    } catch (cause) {
      if (mounted.current) setError(managedSkillErrorFromUnknown(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  function reviewSelectedCandidate() {
    const candidate = selection?.candidates.find((entry) => entry.id === selectedCandidateId);
    if (!selection || !candidate) return;
    setInstallReview({ discovery: selection, candidate });
    setSelection(null);
    setSelectedCandidateId(null);
  }

  async function installSelected() {
    if (!installReview) return;
    const review = installReview;
    setBusy(`install:${review.candidate.id}`);
    clearFeedback();
    try {
      await api.agentManagedSkillInstall({
        discoveryId: review.discovery.id,
        candidateId: review.candidate.id,
        expectedCommit: review.discovery.resolvedCommit,
      });
      if (!mounted.current) return;
      setInstallReview(null);
      setSourceUrl('');
      setNotice(t.settings.skills.managedInstalledNotice({ name: review.candidate.name }));
      await loadAll(false);
      await onApplied();
    } catch (cause) {
      if (mounted.current) setError(managedSkillErrorFromUnknown(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function setEnabled(skill: ManagedSkillView, enabled: boolean) {
    setBusy(`enabled:${skill.id}`);
    clearFeedback();
    try {
      const next = await api.agentManagedSkillSetEnabled(skill.id, enabled, skill.active.contentHash);
      if (!mounted.current) return;
      replaceSkill(next);
      setNotice(enabled
        ? t.settings.skills.managedEnabledNotice({ name: skill.name })
        : t.settings.skills.managedDisabledNotice({ name: skill.name }));
      await onApplied();
    } catch (cause) {
      if (mounted.current) setError(managedSkillErrorFromUnknown(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function checkUpdates(skillId?: string) {
    setBusy(skillId ? `check:${skillId}` : 'check:all');
    clearFeedback();
    try {
      const next = await api.agentManagedSkillCheckUpdates(skillId);
      if (!mounted.current) return;
      setSkills(next);
      setNotice(t.settings.skills.managedCheckedNotice);
    } catch (cause) {
      if (mounted.current) setError(managedSkillErrorFromUnknown(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function previewUpdate(skill: ManagedSkillView) {
    setBusy(`preview:${skill.id}`);
    clearFeedback();
    try {
      const preview = await api.agentManagedSkillPreviewUpdate(skill.id, skill.active.contentHash);
      if (mounted.current) setUpdatePreview(preview);
    } catch (cause) {
      if (mounted.current) setError(managedSkillErrorFromUnknown(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function applyUpdate() {
    if (!updatePreview) return;
    const preview = updatePreview;
    setBusy(`apply:${preview.skillId}`);
    clearFeedback();
    try {
      const next = await api.agentManagedSkillApplyUpdate({
        skillId: preview.skillId,
        previewId: preview.id,
        expectedActiveHash: preview.current.contentHash,
        expectedCandidateHash: preview.candidate.contentHash,
      });
      if (!mounted.current) return;
      replaceSkill(next);
      setUpdatePreview(null);
      setNotice(t.settings.skills.managedUpdatedNotice({ name: next.name }));
      await onApplied();
    } catch (cause) {
      if (mounted.current) setError(managedSkillErrorFromUnknown(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function runConfirmedAction() {
    if (!confirmAction) return;
    const action = confirmAction;
    setBusy(`${action.kind}:${action.skill.id}`);
    clearFeedback();
    try {
      if (action.kind === 'rollback') {
        if (!action.skill.previous) {
          setError({ code: 'previous_version_missing' });
          return;
        }
        const next = await api.agentManagedSkillRollback(
          action.skill.id,
          action.skill.active.contentHash,
          action.skill.previous.contentHash,
        );
        if (mounted.current) {
          replaceSkill(next);
          setNotice(t.settings.skills.managedRolledBackNotice({ name: next.name }));
        }
      } else {
        const next = await api.agentManagedSkillUninstall(action.skill.id, action.skill.active.contentHash);
        if (mounted.current) {
          setSkills(next);
          setNotice(t.settings.skills.managedUninstalledNotice({ name: action.skill.name }));
          setCatalog((current) => current ? {
            ...current,
            entries: current.entries.map((entry) => entry.installedSkillId === action.skill.id
              ? { ...entry, installedSkillId: undefined }
              : entry),
          } : current);
        }
      }
      if (!mounted.current) return;
      setConfirmAction(null);
      await onApplied();
    } catch (cause) {
      if (mounted.current) setError(managedSkillErrorFromUnknown(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  function replaceSkill(next: ManagedSkillView) {
    setSkills((current) => current.map((skill) => skill.id === next.id ? next : skill));
  }

  function clearFeedback() {
    setError(null);
    setNotice(null);
    setOpenMenu(null);
  }

  function openConfirmAction(action: ConfirmAction) {
    clearFeedback();
    setConfirmAction(action);
  }

  return (
    <>
      <InsetGroup ariaLabel={t.settings.skills.managedCatalogAriaLabel} label={t.settings.skills.managedCatalogGroup}>
        {loading && !catalog ? (
          <InsetRow disabled label={t.settings.skills.managedCatalogLoading} leading={<LoaderIcon size={ICON_SIZE.menu} />} />
        ) : catalog?.status === 'unavailable' ? (
          <InsetRow
            label={t.settings.skills.managedCatalogUnavailable}
            sublabel={catalog.error ? managedSkillErrorMessage(catalog.error, t) : undefined}
            trailing={(
              <Button disabled={busy !== null} onClick={() => void loadAll(false)} size="sm" variant="secondary">
                <RefreshIcon size={ICON_SIZE.menu} />
                <span>{t.settings.skills.managedRetry}</span>
              </Button>
            )}
            wrap
          />
        ) : catalog?.entries.length ? catalog.entries.map((entry) => {
          const installed = Boolean(entry.installedSkillId) || installedCatalogIds.has(entry.id);
          const installing = busy === `catalog:${entry.id}`;
          return (
            <InsetRow
              key={entry.id}
              label={<>{entry.name}<span className="settings-chip">{t.settings.skills.managedRecommended}</span></>}
              sublabel={entry.description}
              trailing={installed ? (
                <span className="settings-chip">{t.settings.skills.managedInstalledChip}</span>
              ) : (
                <Button disabled={busy !== null} onClick={() => void beginDiscovery({ catalogId: entry.id })} size="sm" variant="secondary">
                  {installing ? <LoaderIcon size={ICON_SIZE.menu} /> : <AddIcon size={ICON_SIZE.menu} />}
                  <span>{installing ? t.settings.skills.managedResolving : t.settings.skills.managedInstall}</span>
                </Button>
              )}
              wrap
            />
          );
        }) : (
          <InsetRow disabled label={t.settings.skills.managedCatalogEmpty} />
        )}
        {catalog?.status === 'cached' ? (
          <InsetRow
            label={t.settings.skills.managedCatalogCached}
            sublabel={catalog.error ? managedSkillErrorMessage(catalog.error, t) : undefined}
            trailing={(
              <Button disabled={busy !== null} onClick={() => void loadAll(false)} size="sm" variant="ghost">
                <RefreshIcon size={ICON_SIZE.menu} />
                <span>{t.settings.skills.managedRefresh}</span>
              </Button>
            )}
            wrap
          />
        ) : null}
      </InsetGroup>

      <InsetGroup ariaLabel={t.settings.skills.managedGitHubAriaLabel} label={t.settings.skills.managedGitHubGroup}>
        <InsetRow
          label={t.settings.skills.managedGitHubLabel}
          trailing={(
            <div className="managed-skill-source-control">
              <Input
                autoCapitalize="none"
                autoCorrect="off"
                label={t.settings.skills.managedGitHubLabel}
                maxLength={2_048}
                onChange={(event) => setSourceUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !sourceUrl.trim() || busy !== null) return;
                  event.preventDefault();
                  void beginDiscovery({ sourceUrl });
                }}
                placeholder={t.settings.skills.managedGitHubPlaceholder}
                spellCheck={false}
                value={sourceUrl}
                variant="bare"
              />
              <Button
                disabled={!sourceUrl.trim() || busy !== null}
                onClick={() => void beginDiscovery({ sourceUrl })}
                size="sm"
                variant="secondary"
              >
                {busy === 'github' ? <LoaderIcon size={ICON_SIZE.menu} /> : <AddIcon size={ICON_SIZE.menu} />}
                <span>{busy === 'github' ? t.settings.skills.managedResolving : t.settings.skills.managedAdd}</span>
              </Button>
            </div>
          )}
          wrap
        />
      </InsetGroup>

      <InsetGroup ariaLabel={t.settings.skills.managedInstalledAriaLabel} label={t.settings.skills.managedInstalledGroup}>
        <InsetRow
          label={t.settings.skills.managedUpdateCheckLabel}
          trailing={(
            <Button disabled={busy !== null || skills.length === 0} onClick={() => void checkUpdates()} size="sm" variant="ghost">
              {busy === 'check:all' ? <LoaderIcon size={ICON_SIZE.menu} /> : <RefreshIcon size={ICON_SIZE.menu} />}
              <span>{t.settings.skills.managedCheckUpdates}</span>
            </Button>
          )}
        />
        {loading && skills.length === 0 ? (
          <InsetRow disabled label={t.settings.skills.managedInstalledLoading} leading={<LoaderIcon size={ICON_SIZE.menu} />} />
        ) : skills.length === 0 ? (
          <InsetRow disabled label={t.settings.skills.managedInstalledEmpty} />
        ) : skills.map((skill) => {
          const actions = managedSkillActions(skill, {
            check: () => void checkUpdates(skill.id),
            preview: () => void previewUpdate(skill),
            rollback: () => openConfirmAction({ kind: 'rollback', skill }),
            uninstall: () => openConfirmAction({ kind: 'uninstall', skill }),
          }, t, busy !== null);
          return (
            <InsetRow
              dimmed={!skill.enabled || skill.status === 'modified'}
              key={skill.id}
              label={(
                <>
                  /{skill.name}
                  <span className="settings-chip">{skill.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified}</span>
                  <span className="settings-chip">{managedStatusLabel(skill, t)}</span>
                </>
              )}
              leading={<SkillIcon size={ICON_SIZE.menu} />}
              sublabel={skill.diagnostic ? managedSkillErrorMessage(skill.diagnostic, t) : skill.description}
              trailing={(
                <>
                  <SettingsRowMenu
                    actions={actions}
                    ariaLabel={t.settings.skills.rowActionsAriaLabel({ name: skill.name })}
                    onOpenChange={(open) => setOpenMenu(open ? skill.id : null)}
                    open={openMenu === skill.id}
                  />
                  <SwitchControl
                    checked={skill.enabled}
                    disabled={busy !== null}
                    label={t.settings.skills.managedEnableToggle({ name: skill.name })}
                    onCheckedChange={(enabled) => void setEnabled(skill, enabled)}
                  >
                    <SwitchMark checked={skill.enabled} />
                  </SwitchControl>
                </>
              )}
              wrap
            />
          );
        })}
      </InsetGroup>

      {error && !installReview && !updatePreview && !confirmAction ? (
        <div className="agent-settings-alert" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{managedSkillErrorMessage(error, t)}</span>
        </div>
      ) : null}
      {notice ? <div className="agent-settings-notice">{notice}</div> : null}

      {selection ? (
        <CandidateSelectionDialog
          discovery={selection}
          onCancel={() => { setSelection(null); setSelectedCandidateId(null); }}
          onContinue={reviewSelectedCandidate}
          onSelect={setSelectedCandidateId}
          selectedCandidateId={selectedCandidateId}
        />
      ) : null}
      {installReview ? (
        <InstallReviewDialog
          busy={busy?.startsWith('install:') === true}
          error={error}
          onCancel={() => setInstallReview(null)}
          onInstall={() => void installSelected()}
          review={installReview}
        />
      ) : null}
      {updatePreview ? (
        <UpdatePreviewDialog
          busy={busy?.startsWith('apply:') === true}
          error={error}
          onApply={() => void applyUpdate()}
          onCancel={() => setUpdatePreview(null)}
          preview={updatePreview}
        />
      ) : null}
      {confirmAction ? (
        <ManagedSkillActionDialog
          action={confirmAction}
          busy={busy === `${confirmAction.kind}:${confirmAction.skill.id}`}
          error={error}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => void runConfirmedAction()}
        />
      ) : null}
    </>
  );
}

function CandidateSelectionDialog({
  discovery,
  onCancel,
  onContinue,
  onSelect,
  selectedCandidateId,
}: {
  discovery: ManagedSkillDiscoveryView;
  onCancel: () => void;
  onContinue: () => void;
  onSelect: (id: string) => void;
  selectedCandidateId: string | null;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      labelledBy={titleId}
      onBackdropMouseDown={onCancel}
      onEscapeKeyDown={onCancel}
      surfaceClassName="managed-skill-dialog"
    >
      <h2 className="confirm-dialog-title" id={titleId}>{t.settings.skills.managedSelectTitle}</h2>
      <InsetGroup
        ariaLabel={t.settings.skills.managedSelectAriaLabel}
        className="managed-skill-candidate-list"
      >
        {discovery.candidates.map((candidate) => (
          <InsetRow
            key={candidate.id}
            label={candidate.name}
            onSelect={() => onSelect(candidate.id)}
            selected={candidate.id === selectedCandidateId}
            sublabel={candidate.subdirectory || '/'}
          />
        ))}
      </InsetGroup>
      <div className="confirm-dialog-actions">
        <Button onClick={onCancel} variant="ghost">{t.dialog.cancel}</Button>
        <Button disabled={!selectedCandidateId} onClick={onContinue} variant="primary">{t.settings.skills.managedContinue}</Button>
      </div>
    </Dialog>
  );
}

function InstallReviewDialog({
  busy,
  error,
  onCancel,
  onInstall,
  review,
}: {
  busy: boolean;
  error: ManagedSkillErrorView | null;
  onCancel: () => void;
  onInstall: () => void;
  review: InstallReview;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      labelledBy={titleId}
      onBackdropMouseDown={busy ? undefined : onCancel}
      onEscapeKeyDown={busy ? undefined : onCancel}
      surfaceClassName="managed-skill-dialog"
    >
      <h2 className="confirm-dialog-title" id={titleId}>{t.settings.skills.managedInstallTitle({ name: review.candidate.name })}</h2>
      <ManagedSkillDetails
        commit={review.discovery.resolvedCommit}
        compatibility={review.candidate.compatibility.declaredRange ?? t.settings.skills.managedCompatibilityUnknown}
        repository={review.discovery.repository}
        scripts={review.candidate.scripts}
        subdirectory={review.candidate.subdirectory}
        trust={review.discovery.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified}
        version={review.candidate.version}
      />
      <ManagedSkillDialogError error={error} />
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={onCancel} variant="ghost">{t.dialog.cancel}</Button>
        <Button disabled={busy} onClick={onInstall} variant="primary">
          {busy ? <LoaderIcon size={ICON_SIZE.menu} /> : <AddIcon size={ICON_SIZE.menu} />}
          <span>{busy ? t.settings.skills.managedInstalling : t.settings.skills.managedInstall}</span>
        </Button>
      </div>
    </Dialog>
  );
}

function UpdatePreviewDialog({
  busy,
  error,
  onApply,
  onCancel,
  preview,
}: {
  busy: boolean;
  error: ManagedSkillErrorView | null;
  onApply: () => void;
  onCancel: () => void;
  preview: ManagedSkillUpdatePreviewView;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      labelledBy={titleId}
      onBackdropMouseDown={busy ? undefined : onCancel}
      onEscapeKeyDown={busy ? undefined : onCancel}
      surfaceClassName="managed-skill-dialog managed-skill-update-dialog"
    >
      <h2 className="confirm-dialog-title" id={titleId}>{t.settings.skills.managedUpdateTitle}</h2>
      <ManagedSkillDetails
        commit={`${shortHash(preview.current.commit)} -> ${shortHash(preview.candidate.commit)}`}
        compatibility={preview.compatibility.declaredRange ?? t.settings.skills.managedCompatibilityUnknown}
        contentHash={`${shortHash(preview.current.contentHash)} -> ${shortHash(preview.candidate.contentHash)}`}
        repository={preview.repository}
        scripts={preview.scripts}
        subdirectory={preview.subdirectory}
        trust={preview.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified}
        version={`${preview.current.version ?? t.settings.skills.managedCompatibilityUnknown} -> ${preview.candidate.version ?? t.settings.skills.managedCompatibilityUnknown}`}
      />
      <div className="managed-skill-changed-paths">
        <span>{t.settings.skills.managedChangedFiles}</span>
        <span>{preview.changedPaths.join(', ') || t.settings.skills.managedNoFileChanges}</span>
      </div>
      <pre className="managed-skill-diff">{preview.skillDiff}</pre>
      <ManagedSkillDialogError error={error} />
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={onCancel} variant="ghost">{t.dialog.cancel}</Button>
        <Button disabled={busy} onClick={onApply} variant="primary">
          {busy ? <LoaderIcon size={ICON_SIZE.menu} /> : <RefreshIcon size={ICON_SIZE.menu} />}
          <span>{busy ? t.settings.skills.managedApplying : t.settings.skills.managedApplyUpdate}</span>
        </Button>
      </div>
    </Dialog>
  );
}

function ManagedSkillDetails({
  commit,
  compatibility,
  contentHash,
  repository,
  scripts,
  subdirectory,
  trust,
  version,
}: {
  commit: string;
  compatibility: string;
  contentHash?: string;
  repository: string;
  scripts: string[];
  subdirectory: string;
  trust: string;
  version?: string;
}) {
  const t = useT();
  const rows = [
    [t.settings.skills.managedSource, subdirectory ? `${repository}/${subdirectory}` : repository],
    [t.settings.skills.managedCommit, shortHash(commit)],
    ...(version ? [[t.settings.skills.managedVersion, version]] : []),
    ...(contentHash ? [[t.settings.skills.managedContentHash, shortHash(contentHash)]] : []),
    [t.settings.skills.managedCompatibility, compatibility],
    [t.settings.skills.managedTrust, trust],
    [t.settings.skills.managedScripts, scripts.length > 0 ? scripts.join(', ') : t.settings.skills.managedNoScripts],
  ];
  return (
    <dl className="managed-skill-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ManagedSkillActionDialog({
  action,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  action: ConfirmAction;
  busy: boolean;
  error: ManagedSkillErrorView | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const uninstall = action.kind === 'uninstall';
  const version = uninstall ? action.skill.active : action.skill.previous;
  const title = uninstall ? t.settings.skills.managedUninstallTitle : t.settings.skills.managedRollbackTitle;
  const message = uninstall
    ? t.settings.skills.managedUninstallMessage({ name: action.skill.name })
    : t.settings.skills.managedRollbackMessage({
        name: action.skill.name,
        commit: shortHash(version?.commit ?? ''),
      });
  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      initialFocus={() => (uninstall ? cancelRef.current : confirmRef.current)}
      labelledBy={titleId}
      onBackdropMouseDown={busy ? undefined : onCancel}
      onEscapeKeyDown={busy ? undefined : onCancel}
      surfaceClassName="managed-skill-dialog"
    >
      <h2 className="confirm-dialog-title" id={titleId}>{title}</h2>
      <p className="confirm-dialog-message">{message}</p>
      <ManagedSkillDetails
        commit={version?.commit ?? action.skill.active.commit}
        compatibility={version?.compatibility?.declaredRange ?? action.skill.compatibility.declaredRange ?? t.settings.skills.managedCompatibilityUnknown}
        contentHash={version?.contentHash ?? action.skill.active.contentHash}
        repository={action.skill.repository}
        scripts={version?.scripts ?? action.skill.scripts}
        subdirectory={action.skill.subdirectory}
        trust={action.skill.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified}
        version={version?.version}
      />
      <ManagedSkillDialogError error={error} />
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={onCancel} ref={cancelRef} variant="ghost">{t.dialog.cancel}</Button>
        <Button
          disabled={busy}
          onClick={onConfirm}
          ref={confirmRef}
          tone={uninstall ? 'solid' : 'subtle'}
          variant={uninstall ? 'danger' : 'primary'}
        >
          {busy
            ? <LoaderIcon size={ICON_SIZE.menu} />
            : uninstall
              ? <TrashIcon size={ICON_SIZE.menu} />
              : <UndoIcon size={ICON_SIZE.menu} />}
          <span>{uninstall ? t.settings.skills.managedUninstall : t.settings.skills.managedRollback}</span>
        </Button>
      </div>
    </Dialog>
  );
}

function ManagedSkillDialogError({ error }: { error: ManagedSkillErrorView | null }) {
  const t = useT();
  return error ? (
    <div className="agent-settings-alert" role="alert">
      <WarningIcon size={ICON_SIZE.menu} />
      <span>{managedSkillErrorMessage(error, t)}</span>
    </div>
  ) : null;
}

function managedSkillActions(
  skill: ManagedSkillView,
  handlers: { check: () => void; preview: () => void; rollback: () => void; uninstall: () => void },
  t: ReturnType<typeof useT>,
  busy: boolean,
): RowMenuAction[] {
  const modified = skill.status === 'modified';
  return [
    { label: t.settings.skills.managedCheckUpdates, disabled: busy || modified, onSelect: handlers.check },
    ...(skill.updateCommit ? [{ label: t.settings.skills.managedPreviewUpdate, disabled: busy || modified, onSelect: handlers.preview }] : []),
    ...(skill.previous ? [{ label: t.settings.skills.managedRollback, disabled: busy || modified, onSelect: handlers.rollback }] : []),
    { label: t.settings.skills.managedUninstall, danger: true, disabled: busy, onSelect: handlers.uninstall },
  ];
}

function managedStatusLabel(skill: ManagedSkillView, t: ReturnType<typeof useT>): string {
  if (skill.status === 'installed-disabled') return t.settings.skills.managedStatusDisabled;
  if (skill.status === 'enabled') return t.settings.skills.managedStatusEnabled;
  if (skill.status === 'update-available') return t.settings.skills.managedStatusUpdate;
  if (skill.status === 'modified') return t.settings.skills.managedStatusModified;
  return t.settings.skills.managedStatusFailure;
}

function shortHash(hash: string): string {
  if (hash.includes(' -> ')) return hash;
  return hash.slice(0, 12);
}

function managedSkillErrorMessage(error: ManagedSkillErrorView, t: ReturnType<typeof useT>): string {
  let message: string;
  switch (error.code) {
    case 'invalid_github_url':
    case 'unsupported_github_url':
      message = t.settings.skills.managedErrorInvalidGitHubUrl;
      break;
    case 'github_not_found':
      message = t.settings.skills.managedErrorGitHubNotFound;
      break;
    case 'github_rate_limited':
      message = t.settings.skills.managedErrorGitHubRateLimited;
      break;
    case 'github_timeout':
      message = t.settings.skills.managedErrorGitHubTimeout;
      break;
    case 'github_unavailable':
      message = t.settings.skills.managedErrorGitHubUnavailable;
      break;
    case 'github_invalid_response':
    case 'github_redirect_rejected':
      message = t.settings.skills.managedErrorGitHubResponse;
      break;
    case 'github_response_too_large':
    case 'github_tree_truncated':
    case 'too_many_tree_entries':
    case 'too_many_skill_candidates':
    case 'too_many_matching_refs':
      message = t.settings.skills.managedErrorRepositoryLimits;
      break;
    case 'duplicate_skill_name':
      message = t.settings.skills.managedErrorDuplicateName;
      break;
    case 'missing_skill_file':
      message = t.settings.skills.managedErrorMissingSkill;
      break;
    case 'duplicate_skill_file':
    case 'invalid_frontmatter':
    case 'invalid_skill_name':
    case 'invalid_description':
    case 'invalid_compatibility':
      message = t.settings.skills.managedErrorInvalidManifest;
      break;
    case 'executable_file':
      message = t.settings.skills.managedErrorExecutableFiles;
      break;
    case 'embedded_shell':
      message = t.settings.skills.managedErrorEmbeddedShell;
      break;
    case 'secret_content':
      message = t.settings.skills.managedErrorSecretContent;
      break;
    case 'file_count_exceeded':
    case 'file_size_exceeded':
    case 'total_size_exceeded':
      message = t.settings.skills.managedErrorFileLimits;
      break;
    case 'invalid_path':
    case 'hidden_file':
    case 'nested_git_data':
    case 'symlink':
    case 'submodule':
    case 'unsupported_entry':
    case 'invalid_text':
    case 'unsupported_binary':
      message = t.settings.skills.managedErrorUnsafeFiles;
      break;
    case 'incompatible_tenon':
      message = t.settings.skills.managedErrorIncompatible;
      break;
    case 'missing_source':
      message = t.settings.skills.managedErrorSourceRequired;
      break;
    case 'catalog_unavailable':
    case 'invalid_catalog':
    case 'invalid_catalog_cache':
      message = t.settings.skills.managedErrorCatalogUnavailable;
      break;
    case 'catalog_entry_mismatch':
    case 'catalog_entry_not_found':
      message = t.settings.skills.managedErrorCatalogChanged;
      break;
    case 'stale_discovery':
    case 'candidate_not_found':
    case 'candidate_changed':
    case 'discovery_expired':
      message = t.settings.skills.managedErrorSelectionChanged;
      break;
    case 'stale_skill_version':
    case 'stale_update_preview':
    case 'update_preview_expired':
      message = t.settings.skills.managedErrorStateChanged;
      break;
    case 'managed_skill_not_found':
      message = t.settings.skills.managedErrorSkillMissing;
      break;
    case 'skill_disabled':
      message = t.settings.skills.managedErrorDisabled;
      break;
    case 'skill_modified':
      message = t.settings.skills.managedErrorModified;
      break;
    case 'no_update':
      message = t.settings.skills.managedErrorNoUpdate;
      break;
    case 'skill_moved':
    case 'skill_renamed':
      message = t.settings.skills.managedErrorUpdateSourceChanged;
      break;
    case 'previous_version_missing':
      message = t.settings.skills.managedErrorPreviousMissing;
      break;
    case 'previous_version_modified':
      message = t.settings.skills.managedErrorPreviousModified;
      break;
    case 'rolled_back':
      message = t.settings.skills.managedErrorRolledBack;
      break;
    case 'invalid_request':
      message = t.settings.skills.managedErrorInvalidRequest;
      break;
    case 'update_failed':
    case 'unexpected_error':
      message = t.settings.skills.managedErrorUnexpected;
      break;
  }
  return error.detail ? `${message} (${error.detail})` : message;
}
