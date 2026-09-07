import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManagedSkillCatalogView, ManagedSkillDiscoveryCandidateView, ManagedSkillDiscoveryView, ManagedSkillErrorView, ManagedSkillView } from '../../api/types';
import type { SkillManageRequest } from '../../../core/agent/skillOperations';
import { api, managedSkillErrorFromUnknown } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';

export type ManagedConfirmAction = { kind: 'rollback' | 'uninstall'; skill: ManagedSkillView };
export interface ManagedInstallReview { discovery: ManagedSkillDiscoveryView; candidate: ManagedSkillDiscoveryCandidateView }

/** The Library owns list state; the Host owns every review and commit. */
export function useManagedSkills(onApplied: () => Promise<void>) {
  const t = useT();
  const [catalog, setCatalog] = useState<ManagedSkillCatalogView | null>(null);
  const [skills, setSkills] = useState<ManagedSkillView[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ManagedSkillErrorView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<ManagedSkillDiscoveryView | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const mutating = useRef(false);
  const installedCatalogIds = useMemo(() => new Set(catalog?.entries.filter((entry) => entry.installedSkillId).map((entry) => entry.id) ?? []), [catalog]);

  useEffect(() => {
    mounted.current = true;
    void loadAll(true);
    const unsubscribe = window.lin?.onSkillLibraryChanged?.(() => {
      if (!mutating.current) void loadAll(false);
    });
    return () => { mounted.current = false; epoch.current += 1; unsubscribe?.(); };
  }, []);

  async function loadAll(ambient: boolean) {
    const generation = ++epoch.current;
    const current = () => mounted.current && epoch.current === generation;
    setLoading(true);
    try {
      const [nextCatalog, installed] = await Promise.all([api.agentManagedSkillCatalog(), api.agentManagedSkillList()]);
      if (!current()) return;
      setCatalog(nextCatalog); setSkills(installed); setListLoaded(true);
      if (ambient && installed.length > 0) {
        void api.agentManagedSkillCheckUpdates(undefined, { ambient: true }).then((checked) => {
          if (current()) setSkills(checked);
        }).catch((cause) => { if (current()) setError(managedSkillErrorFromUnknown(cause)); });
      }
    } catch (cause) { if (current()) setError(managedSkillErrorFromUnknown(cause)); }
    finally { if (current()) setLoading(false); }
  }

  function clearFeedback() { setError(null); setNotice(null); }
  async function run(operation: string, action: () => Promise<void>) {
    if (mutating.current) return;
    mutating.current = true;
    epoch.current += 1;
    setBusy(operation); clearFeedback();
    try { await action(); }
    catch (cause) {
      const failure = managedSkillErrorFromUnknown(cause);
      if (mounted.current && failure.code !== 'cancelled') setError(failure);
    } finally {
      mutating.current = false;
      if (mounted.current) { setBusy(null); await loadAll(false); }
    }
  }
  async function manage(request: SkillManageRequest, message: string) {
    await api.agentSkillManage(request);
    if (mounted.current) setNotice(message);
    await onApplied().catch(() => undefined);
  }
  async function install(discovery: ManagedSkillDiscoveryView, candidate: ManagedSkillDiscoveryCandidateView) {
    await manage({ operation: 'install', discoveryId: discovery.id, candidateId: candidate.id,
      expectedCommit: discovery.resolvedCommit }, t.settings.skills.managedInstalledNotice({ name: candidate.name }));
    if (mounted.current) setSourceUrl('');
  }
  async function beginDiscovery(input: { sourceUrl?: string; catalogId?: string }) {
    await run(input.catalogId ? `catalog:${input.catalogId}` : 'github', async () => {
      const discovery = await api.agentManagedSkillDiscover(input);
      if (!mounted.current) return;
      if (discovery.selectionRequired) { setSelection(discovery); setSelectedCandidateId(null); }
      else if (discovery.candidates[0]) await install(discovery, discovery.candidates[0]);
    });
  }
  function reviewSelectedCandidate() {
    const candidate = selection?.candidates.find((entry) => entry.id === selectedCandidateId);
    if (!selection || !candidate) return;
    const discovery = selection;
    setSelection(null); setSelectedCandidateId(null);
    void run(`install:${candidate.id}`, () => install(discovery, candidate));
  }
  async function checkUpdates(skillId?: string) {
    await run(skillId ? `check:${skillId}` : 'check:all', async () => {
      const next = await api.agentManagedSkillCheckUpdates(skillId);
      if (mounted.current) { setSkills(next); setNotice(t.settings.skills.managedCheckedNotice); }
    });
  }
  async function previewUpdate(skill: ManagedSkillView) {
    await run(`preview:${skill.id}`, async () => {
      const preview = await api.agentManagedSkillPreviewUpdate(skill.id, skill.active.contentHash);
      await manage({ operation: 'apply_update', skillId: skill.id, expectedRevision: skill.revision,
        previewId: preview.id, expectedActiveHash: preview.current.contentHash,
        expectedCandidateHash: preview.candidate.contentHash }, t.settings.skills.managedUpdatedNotice({ name: skill.name }));
    });
  }
  function openConfirmAction(action: ManagedConfirmAction) {
    const { skill } = action;
    const target = { skillId: skill.id, expectedRevision: skill.revision, expectedActiveHash: skill.active.contentHash };
    void run(`${action.kind}:${skill.id}`, async () => {
      if (action.kind === 'rollback') {
        if (!skill.previous) { setError({ code: 'previous_version_missing' }); return; }
        await manage({ operation: 'rollback', ...target, expectedPreviousHash: skill.previous.contentHash }, t.settings.skills.managedRolledBackNotice({ name: skill.name }));
      } else {
        await manage({ operation: 'uninstall', ...target }, t.settings.skills.managedUninstalledNotice({ name: skill.name }));
      }
    });
  }
  return { busy, catalog, clearFeedback, error, installedCatalogIds, listLoaded, loading, notice,
    selectedCandidateId, selection, skills, sourceUrl, beginDiscovery, checkUpdates, loadAll,
    openConfirmAction, previewUpdate, reviewSelectedCandidate, setSelectedCandidateId, setSelection, setSourceUrl };
}
export type ManagedSkillsController = ReturnType<typeof useManagedSkills>;
