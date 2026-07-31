import { useEffect, useMemo, useRef, useState } from 'react';
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

export type ManagedConfirmAction =
  | { kind: 'rollback'; skill: ManagedSkillView }
  | { kind: 'uninstall'; skill: ManagedSkillView };

export interface ManagedInstallReview {
  discovery: ManagedSkillDiscoveryView;
  candidate: ManagedSkillDiscoveryCandidateView;
}

/**
 * Managed-skill state and operations for the Skill library.
 *
 * This is a hook rather than component state because the library now shows
 * managed skills as rows in the one list while acquiring them happens in a
 * separate surface. Both need the same catalog, the same installed list, and the
 * same busy/error envelope, so neither can own it.
 */
export function useManagedSkills(onApplied: () => Promise<void>) {
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
  const [installReview, setInstallReview] = useState<ManagedInstallReview | null>(null);
  const [updatePreview, setUpdatePreview] = useState<ManagedSkillUpdatePreviewView | null>(null);
  const [confirmAction, setConfirmAction] = useState<ManagedConfirmAction | null>(null);
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

  async function loadAll(checkUpdatesOnLoad: boolean) {
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
      if (checkUpdatesOnLoad && installed.length > 0) {
        // Opening the pane is not a request to check — it is ambient, so main
        // throttles it on each record's lastCheckedAt.
        void api.agentManagedSkillCheckUpdates(undefined, { ambient: true })
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

  function openConfirmAction(action: ManagedConfirmAction) {
    clearFeedback();
    setConfirmAction(action);
  }

  return {
    busy,
    catalog,
    confirmAction,
    error,
    installReview,
    installedCatalogIds,
    loading,
    notice,
    openMenu,
    selectedCandidateId,
    selection,
    skills,
    sourceUrl,
    updatePreview,
    applyUpdate,
    beginDiscovery,
    checkUpdates,
    installSelected,
    loadAll,
    openConfirmAction,
    previewUpdate,
    reviewSelectedCandidate,
    runConfirmedAction,
    setEnabled,
    setConfirmAction,
    setInstallReview,
    setOpenMenu,
    setSelectedCandidateId,
    setSelection,
    setSourceUrl,
    setUpdatePreview,
  };
}

export type ManagedSkillsController = ReturnType<typeof useManagedSkills>;
