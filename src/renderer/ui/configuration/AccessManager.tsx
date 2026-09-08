import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { beginKeyedMutation, isCurrentKeyedMutation } from '../keyedMutationGeneration';
import { ManagerFeedback } from './ManagerFeedback';
import type { AgentCapabilitySettingsView } from '../../api/types';
import { AccessRules } from '../agent/AccessRules';
import { capabilitySettingsRemovalPatch } from '../agent/agentCapabilitySettings';
import { withMapValue, withoutMapKey, emptyCapabilitySettings, removeCapabilityRule,
  restoreCapabilityRule, reportAppliedRefreshFailure, reportSettingsMutationError } from './mutationSupport';
export function AccessManager() {
  const [capabilitySettings, setCapabilitySettings] = useState<AgentCapabilitySettingsView | null>(null);
  const [capabilityMutationErrors, setCapabilityMutationErrors] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const readGeneration = useRef(0);
  const pendingRules = useRef(new Set<string>());
  const refreshAfterMutation = useRef(false);
  const refreshRef = useRef<() => void>(() => undefined);
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
      if (pendingRules.current.size) { refreshAfterMutation.current = true; return; }
      refreshAfterMutation.current = false;
      const request = ++readGeneration.current;
      void api.agentGetCapabilitySettings().then((next) => {
        if (active && request === readGeneration.current) setCapabilitySettings(next);
      }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); });
    };
    refreshRef.current = refresh;
    refresh();
    const off = window.lin?.onConfigurationChanged('access', refresh);
    return () => { active = false; off?.(); };
  }, []);
  const capabilityBlocks = capabilitySettings?.blocks ?? [];
  async function removeCapabilityBlock(rule: string) {
    const base = capabilitySettings ?? emptyCapabilitySettings();
    const patch = capabilitySettingsRemovalPatch(base, {
      ...base,
      blocks: base.blocks.filter((candidate) => candidate !== rule),
    });
    const mutationKey = `capability:${rule}`;
    const generation = beginMutation(mutationKey);
    pendingRules.current.add(rule);
    readGeneration.current += 1;
    setCapabilityMutationErrors((current) => withoutMapKey(current, rule));
    // Optimistic: the row leaves at once because that is what the user asked for.
    setCapabilitySettings((current) => removeCapabilityRule(current ?? base, rule));
    try {
      const next = await api.agentApplyCapabilitySettingsPatch(patch);
      if (isCurrentMutation(mutationKey, generation)) {
        // Merge only this rule. Replacing the whole response can resurrect a
        // different rule whose concurrent removal is still in flight.
        setCapabilitySettings((current) => ({
          ...next,
          blocks: removeCapabilityRule(current ?? next, rule).blocks,
        }));
      }
      await reportAppliedRefreshFailure(onApplied, 'capability-block-refresh', rule);
    } catch (caught) {
      // Put it back. A row that vanished and stayed vanished would tell the user
      // the rule is gone while the agent still enforces it.
      if (isCurrentMutation(mutationKey, generation)) {
        setCapabilitySettings((current) => restoreCapabilityRule(
          current ?? emptyCapabilitySettings(),
          base.blocks,
          rule,
        ));
        setCapabilityMutationErrors((current) => withMapValue(
          current,
          rule,
          t.settings.security.removeFailed,
        ));
        reportSettingsMutationError('capability-block-remove-failed', rule, caught);
      }
    } finally {
      if (isCurrentMutation(mutationKey, generation)) pendingRules.current.delete(rule);
      if (mountedRef.current && !pendingRules.current.size && refreshAfterMutation.current) refreshRef.current();
    }
  }

  return <>
    <AccessRules blocks={capabilityBlocks} blockErrors={capabilityMutationErrors} onRemoveBlock={(rule) => void removeCapabilityBlock(rule)} />
    <ManagerFeedback error={error} notice={notice} />
  </>;
}
