import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManagedSkillCatalogView, ManagedSkillDiscoveryCandidateView, ManagedSkillDiscoveryView, ManagedSkillView } from '../../api/types';
import type { SkillManageRequest } from '../../../core/agent/skillOperations';
import { api, managedSkillErrorFromUnknown } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { managedSkillErrorMessage } from './ManagedSkillsSettings';
import type { SettingsFeedbackState } from '../configuration/SettingsFeedback';

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
  const [feedback, setFeedback] = useState<Record<string, SettingsFeedbackState>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
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
      setLoadError(null);
      if (ambient && installed.length > 0) {
        void api.agentManagedSkillCheckUpdates(undefined, { ambient: true }).then((checked) => {
          if (current()) setSkills(checked);
        }).catch((cause) => { if (current()) setLoadError(managedSkillErrorMessage(managedSkillErrorFromUnknown(cause), t)); });
      }
    } catch (cause) { if (current()) setLoadError(managedSkillErrorMessage(managedSkillErrorFromUnknown(cause), t)); }
    finally { if (current()) setLoading(false); }
  }

  function report(target: string, value: SettingsFeedbackState = {}) {
    if (mounted.current) setFeedback((current) => ({ ...current, [target]: value }));
  }
  async function run(operation: string, target: string, action: () => Promise<void>) {
    if (mutating.current) return;
    mutating.current = true;
    epoch.current += 1;
    setBusy(operation); report(target, { notice: operation.startsWith('check:') ? t.settings.skills.managedChecking : t.common.loading });
    try { await action(); }
    catch (cause) {
      const failure = managedSkillErrorFromUnknown(cause);
      report(target, failure.code === 'cancelled' ? {} : { error: managedSkillErrorMessage(failure, t) });
    } finally {
      mutating.current = false;
      if (mounted.current) { setBusy(null); await loadAll(false); }
    }
  }
  async function manage(request: SkillManageRequest, message: string, target: string) {
    await api.agentSkillManage(request);
    report(target, { notice: message });
    await onApplied().catch(() => undefined);
  }
  async function install(discovery: ManagedSkillDiscoveryView, candidate: ManagedSkillDiscoveryCandidateView) {
    await manage({ operation: 'install', discoveryId: discovery.id, candidateId: candidate.id,
      expectedCommit: discovery.resolvedCommit }, t.settings.skills.managedInstalledNotice({ name: candidate.name }), 'acquisition');
    if (mounted.current) setSourceUrl('');
  }
  async function beginDiscovery(input: { sourceUrl?: string; catalogId?: string }) {
    await run(input.catalogId ? `catalog:${input.catalogId}` : 'github', 'acquisition', async () => {
      const discovery = await api.agentManagedSkillDiscover(input);
      if (!mounted.current) return;
      if (discovery.selectionRequired) { setSelection(discovery); setSelectedCandidateId(null); report('acquisition'); }
      else if (discovery.candidates[0]) await install(discovery, discovery.candidates[0]);
      else report('acquisition');
    });
  }
  function reviewSelectedCandidate() {
    const candidate = selection?.candidates.find((entry) => entry.id === selectedCandidateId);
    if (!selection || !candidate) return;
    const discovery = selection;
    setSelection(null); setSelectedCandidateId(null);
    void run(`install:${candidate.id}`, 'acquisition', () => install(discovery, candidate));
  }
  async function checkUpdates(skillId?: string) {
    const target = skillId ? `skill:${skillId}` : 'library';
    await run(skillId ? `check:${skillId}` : 'check:all', target, async () => {
      const next = await api.agentManagedSkillCheckUpdates(skillId);
      if (!mounted.current) return;
      setSkills(next);
      const checked = skillId ? next.filter((skill) => skill.id === skillId) : next;
      for (const skill of checked) {
        report(`skill:${skill.id}`, skill.diagnostic && skill.diagnostic.code !== 'rolled_back'
          ? { error: managedSkillErrorMessage(skill.diagnostic, t) }
          : { notice: skill.updateCommit ? t.settings.skills.managedStatusUpdate : t.settings.skills.managedUpToDate });
      }
      if (!skillId) report('library', { notice: t.settings.skills.managedCheckSummary({
        updates: checked.filter((skill) => skill.updateCommit).length,
        failed: checked.filter((skill) => skill.diagnostic && skill.diagnostic.code !== 'rolled_back').length,
      }) });
      else if (!checked.length) report(target, { error: t.settings.skills.managedErrorSkillMissing });
    });
  }
  async function previewUpdate(skill: ManagedSkillView) {
    const target = `skill:${skill.id}`;
    await run(`preview:${skill.id}`, target, async () => {
      const preview = await api.agentManagedSkillPreviewUpdate(skill.id, skill.active.contentHash);
      await manage({ operation: 'apply_update', skillId: skill.id, expectedRevision: skill.revision,
        previewId: preview.id, expectedActiveHash: preview.current.contentHash,
        expectedCandidateHash: preview.candidate.contentHash }, t.settings.skills.managedUpdatedNotice({ name: skill.name }), target);
    });
  }
  function openConfirmAction(action: ManagedConfirmAction) {
    const { skill } = action;
    const target = { skillId: skill.id, expectedRevision: skill.revision, expectedActiveHash: skill.active.contentHash };
    const feedbackTarget = `skill:${skill.id}`;
    void run(`${action.kind}:${skill.id}`, feedbackTarget, async () => {
      if (action.kind === 'rollback') {
        if (!skill.previous) { report(feedbackTarget, { error: t.settings.skills.managedErrorPreviousMissing }); return; }
        await manage({ operation: 'rollback', ...target, expectedPreviousHash: skill.previous.contentHash }, t.settings.skills.managedRolledBackNotice({ name: skill.name }), feedbackTarget);
      } else {
        await manage({ operation: 'uninstall', ...target }, t.settings.skills.managedUninstalledNotice({ name: skill.name }), 'library');
        report(feedbackTarget);
      }
    });
  }
  return { busy, catalog, feedback, loadError, installedCatalogIds, listLoaded, loading,
    selectedCandidateId, selection, skills, sourceUrl, beginDiscovery, checkUpdates, loadAll,
    openConfirmAction, previewUpdate, reviewSelectedCandidate, setSelectedCandidateId, setSelection, setSourceUrl };
}
export type ManagedSkillsController = ReturnType<typeof useManagedSkills>;
