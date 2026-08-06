import { useId, useRef } from 'react';
import type {
  ManagedSkillDiscoveryView,
  ManagedSkillErrorView,
  ManagedSkillUpdatePreviewView,
  ManagedSkillView,
} from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import {
  AddIcon,
  ICON_SIZE,
  LoaderIcon,
  RefreshIcon,
  TrashIcon,
  UndoIcon,
  WarningIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { Dialog } from '../primitives/Dialog';
import { EmptyState } from '../primitives/FeedbackState';
import { Input } from '../primitives/Input';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import type { RowMenuAction } from './SettingsRowMenu';
import type { ManagedConfirmAction, ManagedInstallReview, ManagedSkillsController } from './useManagedSkills';

interface ManagedSkillsAcquisitionProps {
  controller: ManagedSkillsController;
  /** Whether the acquisition panel itself is open. Its dialogs show regardless. */
  open: boolean;
  onClose: () => void;
  /**
   * Every Skill name already in the library, whatever its source. Managed
   * install refuses a name that is taken — including by a `user` or `project`
   * Skill it does not own — so a recommendation whose name is spoken for must
   * not offer an Install that is certain to fail.
   */
  existingSkillNames: ReadonlySet<string>;
}

type ConfirmAction = ManagedConfirmAction;

/**
 * Acquiring a managed skill: the recommended catalog, a GitHub URL, and the
 * review/confirm dialogs the two share. Installed skills are NOT listed here —
 * they are rows in the one Skill library list, alongside every other source.
 *
 * Browsing the catalog and pasting a URL are two inputs to the same act, so they
 * are one panel rather than two page sections. The panel is a dialog-class
 * surface: opaque `--bg-elevated` at level-2, matching .confirm-dialog and the
 * managed review dialogs. Translucent material in this app is level-1 chrome
 * (menus, rails); the `+` menu that opens this panel is that, and it reuses the
 * already-registered popover glass rather than introducing a new surface.
 */
export function ManagedSkillsSettings({
  controller,
  open,
  onClose,
  existingSkillNames,
}: ManagedSkillsAcquisitionProps) {
  const t = useT();
  const acquireTitleId = useId();
  const {
    busy,
    catalog,
    confirmAction,
    error,
    installReview,
    installedCatalogIds,
    loading,
    notice,
    selectedCandidateId,
    selection,
    sourceUrl,
    updatePreview,
    applyUpdate,
    beginDiscovery,
    installSelected,
    loadAll,
    reviewSelectedCandidate,
    runConfirmedAction,
    setConfirmAction,
    setInstallReview,
    setSelectedCandidateId,
    setSelection,
    setSourceUrl,
    setUpdatePreview,
  } = controller;
  return (
    <>
      {open ? (
        <Dialog
          backdropClassName="confirm-dialog-backdrop"
          labelledBy={acquireTitleId}
          onBackdropMouseDown={onClose}
          onEscapeKeyDown={onClose}
          surfaceClassName="managed-skill-dialog skill-acquire-dialog"
        >
          <h2 className="confirm-dialog-title" id={acquireTitleId}>{t.settings.skills.acquireTitle}</h2>
          <InsetGroup ariaLabel={t.settings.skills.managedCatalogAriaLabel} label={t.settings.skills.managedCatalogGroup}>
        {loading && !catalog ? (
          <InsetRow empty label={t.settings.skills.managedCatalogLoading} leading={<LoaderIcon size={ICON_SIZE.menu} />} />
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
          // Not installed as managed, but the name is already taken by a Skill
          // from another source. Install would reach assertNameAvailable and
          // fail, so say so instead of offering the button.
          const nameTaken = !installed && existingSkillNames.has(entry.name);
          const installing = busy === `catalog:${entry.id}`;
          return (
            <InsetRow
              key={entry.id}
              label={<>{entry.name}<span className="settings-chip">{t.settings.skills.managedRecommended}</span></>}
              sublabel={entry.description}
              trailing={installed ? (
                <span className="settings-chip">{t.settings.skills.managedInstalledChip}</span>
              ) : nameTaken ? (
                // The chip states the whole outcome, so the reason no longer hides
                // in a mouse-only `title` — the same unreachable tooltip the
                // clamped Skill description used to depend on.
                <span className="settings-chip">{t.settings.skills.managedNameTaken}</span>
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
          <InsetRow empty label={t.settings.skills.managedCatalogEmpty} />
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
        {/* A field is not a trailing control. As one it was pinned to a
            viewport-relative width unrelated to the dialog's, so it took half the
            row and wrapped the label beside it onto two lines — a label that
            repeated the group header and the placeholder anyway. The input spans
            the row and keeps its accessible name; what to paste is shown by the
            placeholder, which is the example the label was describing. */}
        <div className="inset-row managed-skill-github-row" role="listitem">
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
        </div>
      </InsetGroup>
          {/* Inside the dialog, because outside it is behind the backdrop. Every
              failure of the GitHub flow — bad URL, rate limit, timeout, repo too
              large, no SKILL.md — rendered into page flow under a dimming
              overlay, so the primary error path of this panel was invisible and
              the button simply returned from "Resolving…" to "Add". */}
          {error && !installReview && !updatePreview && !confirmAction ? (
            <div className="agent-settings-alert" role="alert">
              <WarningIcon size={ICON_SIZE.menu} />
              <span>{managedSkillErrorMessage(error, t)}</span>
            </div>
          ) : null}
          {/* Installing is not "confirming" this panel — each entry commits
              through its own review dialog — so the only action here is to
              dismiss it. Without a visible one, the panel could be left only by
              Escape or a backdrop click. */}
          <div className="confirm-dialog-actions">
            <Button onClick={onClose} variant="secondary">
              {t.settings.skills.acquireClose}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {error && !open && !installReview && !updatePreview && !confirmAction ? (
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
  review: ManagedInstallReview;
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
        distribution={review.discovery.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified}
        version={review.candidate.version}
      />
      {/* What the Skill will tell the model, shown because installing enables and
          enabling puts this text into the agent's context. The update path has
          always shown its diff; only the initial install asked people to consent
          to a file list, which was survivable while a second toggle stood between
          the bytes and the model and is not now. */}
      {review.candidate.description ? (
        <p className="managed-skill-review-description">{review.candidate.description}</p>
      ) : null}
      {review.candidate.skillBody ? (
        <>
          <p className="managed-skill-review-body-label">{t.settings.skills.managedSkillBodyLabel}</p>
          <pre className="managed-skill-diff">{review.candidate.skillBody}</pre>
          {review.candidate.skillBodyTruncated ? (
            <p className="managed-skill-review-truncated">{t.settings.skills.managedSkillBodyTooLargeToInstall}</p>
          ) : null}
        </>
      ) : null}
      <ManagedSkillDialogError error={error} />
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={onCancel} variant="ghost">{t.dialog.cancel}</Button>
        <Button disabled={busy || review.candidate.skillBodyTruncated === true} onClick={onInstall} variant="primary">
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
        distribution={preview.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified}
        version={`${preview.current.version ?? t.settings.skills.managedCompatibilityUnknown} -> ${preview.candidate.version ?? t.settings.skills.managedCompatibilityUnknown}`}
      />
      <div className="managed-skill-changed-paths">
        <span>{t.settings.skills.managedChangedFiles}</span>
        <span>{preview.changedPaths.join(', ') || t.settings.skills.managedNoFileChanges}</span>
      </div>
      <pre className="managed-skill-diff">{preview.skillDiff}</pre>
      {/* `diffTruncated` was produced and never read, so a review gate that exists
          to let the user consent to specific bytes could silently hide the rest. */}
      {preview.diffTruncated ? (
        <p className="managed-skill-review-truncated">{t.settings.skills.managedSkillBodyTruncated}</p>
      ) : null}
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
  distribution,
  repository,
  scripts,
  subdirectory,
  version,
}: {
  commit: string;
  compatibility: string;
  contentHash?: string;
  distribution: string;
  repository: string;
  scripts: string[];
  subdirectory: string;
  version?: string;
}) {
  const t = useT();
  const rows = [
    [t.settings.skills.managedSource, subdirectory ? `${repository}/${subdirectory}` : repository],
    [t.settings.skills.managedCommit, shortHash(commit)],
    ...(version ? [[t.settings.skills.managedVersion, version]] : []),
    ...(contentHash ? [[t.settings.skills.managedContentHash, shortHash(contentHash)]] : []),
    [t.settings.skills.managedCompatibility, compatibility],
    [t.settings.skills.managedDistribution, distribution],
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
        distribution={action.skill.recommended ? t.settings.skills.managedRecommended : t.settings.skills.managedUnverified}
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

export function managedSkillActions(
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

export function managedSkillAttentionLabel(
  skill: ManagedSkillView,
  t: ReturnType<typeof useT>,
): string | undefined {
  // Enabled/disabled is already stated by the adjacent switch. Only states that
  // need attention earn a chip, so the two representations cannot contradict.
  if (skill.status === 'installed-disabled' || skill.status === 'enabled') return undefined;
  if (skill.status === 'update-available') return t.settings.skills.managedStatusUpdate;
  if (skill.status === 'modified') return t.settings.skills.managedStatusModified;
  return t.settings.skills.managedStatusFailure;
}

function shortHash(hash: string): string {
  if (hash.includes(' -> ')) return hash;
  return hash.slice(0, 12);
}

export function managedSkillErrorMessage(error: ManagedSkillErrorView, t: ReturnType<typeof useT>): string {
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
