import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { beginKeyedMutation, isCurrentKeyedMutation } from '../keyedMutationGeneration';
import { createSerialMutationQueue } from '../../../core/serialMutationQueue';
import { type SettingsFeedbackState } from './SettingsFeedback';
import { ManagerFeedback } from './ManagerFeedback';
import type { AgentProviderSettingsView } from '../../api/types';
import { ModelsList } from '../agent/ModelsList';
import { formatProviderName } from '../agent/providerCatalog';
import { type ProviderDraft, withMapValue, withoutMapKey, resolveInitialProviderDraft,
  resolveProviderDraftFor, mergeProviderEnabledResult, reportAppliedRefreshFailure, reportSettingsMutationError } from './mutationSupport';
export function ModelsManager() {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({ providerId: '', baseUrl: '', enabled: true });
  const [providerEnabledOverrides, setProviderEnabledOverrides] = useState<Map<string, boolean>>(new Map());
  const [providerToggleErrors, setProviderToggleErrors] = useState<Map<string, string>>(new Map());
  const providerSettingsRef = useRef<AgentProviderSettingsView | null>(null);
  const providerMutationQueueRef = useRef(createSerialMutationQueue());
  const providerEnabledTargetsRef = useRef(new Map<string, boolean>());
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, SettingsFeedbackState>>({});
  function report(key: string, value: SettingsFeedbackState = {}) { if (mountedRef.current) setFeedback((current) => ({ ...current, [key]: value })); }
  const mountedRef = useRef(false);
  const mutationGenerationsRef = useRef(new Map<string, number>());
  const t = useT();
  const onApplied = async () => undefined;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; mutationGenerationsRef.current.clear(); };
  }, []);
  function beginMutation(key: string) {
    return beginKeyedMutation(mutationGenerationsRef.current, key);
  }

  function isCurrentMutation(key: string, generation: number) {
    return mountedRef.current
      && isCurrentKeyedMutation(mutationGenerationsRef.current, key, generation);
  }

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void providerMutationQueueRef.current.run(async () => {
        try {
          const next = await api.agentGetProviderSettings();
          if (!active) return;
          providerSettingsRef.current = next;
          setSettings(next);
          setError(null);
          setProviderDraft(resolveInitialProviderDraft(next));
        } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : String(caught)); }
      });
    };
    refresh();
    const off = window.lin?.onConfigurationChanged('models', refresh);
    return () => { active = false; off?.(); };
  }, []);
  function toggleProviderEnabled(providerId: string, baseUrl: string | null) {
    const stored = providerSettingsRef.current?.providers.find((provider) => provider.providerId === providerId);
    const enabled = !(providerEnabledTargetsRef.current.get(providerId) ?? stored?.enabled ?? false);
    const mutationKey = `provider-enabled:${providerId}`;
    const generation = beginMutation(mutationKey);
    providerEnabledTargetsRef.current.set(providerId, enabled);
    setProviderEnabledOverrides((current) => withMapValue(current, providerId, enabled));
    setProviderToggleErrors((current) => withoutMapKey(current, providerId));
    report(providerId);

    void enqueueProviderMutation(async () => {
      let next: AgentProviderSettingsView;
      try {
        next = await api.agentUpsertProviderConfig({ providerId, baseUrl, enabled }, { probeConnection: false });
      } catch (caught) {
        if (isCurrentMutation(mutationKey, generation)) {
          providerEnabledTargetsRef.current.delete(providerId);
          setProviderEnabledOverrides((current) => withoutMapKey(current, providerId));
          setProviderToggleErrors((current) => withMapValue(
            current,
            providerId,
            t.settings.providers.toggleFailed({ name: formatProviderName(providerId) }),
          ));
          reportSettingsMutationError('provider-enabled-write-failed', providerId, caught);
        }
        return;
      }

      const merged = mergeProviderEnabledResult(providerSettingsRef.current ?? next, next, providerId, enabled);
      providerSettingsRef.current = merged;
      if (mountedRef.current) {
        setSettings((current) => mergeProviderEnabledResult(current ?? next, next, providerId, enabled));
      }
      await reportAppliedRefreshFailure(onApplied, 'provider-enabled-refresh', providerId);

      if (isCurrentMutation(mutationKey, generation)) {
        providerEnabledTargetsRef.current.delete(providerId);
        setProviderEnabledOverrides((current) => withoutMapKey(current, providerId));
      }
    });
  }

  async function runProviderMutationAsync(
    target: string,
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial = false,
  ) {
    return enqueueProviderMutation(() => runProviderMutationStep(target, action, successNotice, resetToInitial));
  }

  function enqueueProviderMutation<T>(action: () => Promise<T>): Promise<T> {
    return providerMutationQueueRef.current.run(action);
  }

  async function runProviderMutationStep(
    target: string,
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial: boolean,
  ) {
    const mutationKey = target;
    const generation = beginMutation(mutationKey);
    setProviderToggleErrors((current) => withoutMapKey(current, target));
    report(target, { notice: t.common.loading });
    try {
      const next = await action();
      providerSettingsRef.current = next;
      if (isCurrentMutation(mutationKey, generation)) {
        setSettings(next);
        setProviderDraft(resetToInitial
          ? resolveInitialProviderDraft(next)
          : resolveProviderDraftFor(next, providerDraft.providerId));
        report(target, { notice: successNotice });
      }
      await onApplied();
    } catch (caught) {
      if (isCurrentMutation(mutationKey, generation)) report(target, { error: caught instanceof Error ? caught.message : String(caught) });
    }
  }

  function runProviderMutation(
    target: string,
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial = false,
  ) {
    void runProviderMutationAsync(target, action, successNotice, resetToInitial);
  }

  return <>
    <ManagerFeedback error={error} />
    <ModelsList feedback={feedback} draftProviderId={providerDraft.providerId} enabledOverrides={providerEnabledOverrides}
      onToggleProviderEnabled={toggleProviderEnabled} runProviderMutation={runProviderMutation}
      settings={settings} toggleErrors={providerToggleErrors} />
  </>;
}
