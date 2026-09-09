import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { beginKeyedMutation, isCurrentKeyedMutation } from '../keyedMutationGeneration';
import { createSerialMutationQueue } from '../../../core/serialMutationQueue';
import { ManagerFeedback } from './ManagerFeedback';
import type { AgentSkillSettingsView, AgentSkillSourceMode } from '../../api/types';
import { SkillLibrary } from '../agent/SkillLibrary';
import { withMapValue, withoutMapKey, reportAppliedRefreshFailure, reportSettingsMutationError } from './mutationSupport';
interface SkillDraft { disabledSkills: string[] }
const EMPTY_SKILL_DRAFT: SkillDraft = { disabledSkills: [] };
export function SkillsManager({ active, toolbarTarget }: { active: boolean; toolbarTarget: HTMLElement | null }) {
  const [skillDraft, setSkillDraft] = useState<SkillDraft>(EMPTY_SKILL_DRAFT);
  const [skillSources, setSkillSources] = useState<AgentSkillSettingsView['sourceBindings']>([]);
  const [skillToggleErrors, setSkillToggleErrors] = useState<Map<string, string>>(new Map());
  const latestDisabledSkillsRef = useRef<readonly string[]>([]);
  const skillDraftRef = useRef<SkillDraft>(EMPTY_SKILL_DRAFT);
  const skillDisabledTargetsRef = useRef(new Map<string, boolean>());
  const skillDisableQueueRef = useRef(createSerialMutationQueue());
  const skillSettingsEpochRef = useRef(0);
  const skillSettingsPendingRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
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

  function applyLoadedSkillSettings(next: AgentSkillSettingsView, expectedEpoch?: number): void {
    if (expectedEpoch !== undefined
      && (expectedEpoch !== skillSettingsEpochRef.current || skillSettingsPendingRef.current > 0)) return;
    latestDisabledSkillsRef.current = [...next.disabledSkills];
    const nextSkillDraft: SkillDraft = { disabledSkills: [...next.disabledSkills] };
    skillDraftRef.current = nextSkillDraft;
    setSkillDraft(nextSkillDraft);
    setSkillSources(next.sourceBindings);
  }

  function beginSkillSettingsMutation(): void {
    skillSettingsPendingRef.current += 1;
    skillSettingsEpochRef.current += 1;
  }

  function finishSkillSettingsMutation(): void {
    skillSettingsPendingRef.current = Math.max(0, skillSettingsPendingRef.current - 1);
    // A refresh that started while the write was pending is stale even if it
    // captured the same epoch. Settlement is part of the mutation lifetime.
    skillSettingsEpochRef.current += 1;
  }

  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      const epoch = skillSettingsEpochRef.current;
      void api.agentGetSkillSettings().then((next) => {
        if (active && request === generation) { applyLoadedSkillSettings(next, epoch); setError(null); }
      }).catch((caught) => { if (active && request === generation) setError(caught instanceof Error ? caught.message : String(caught)); });
    };
    refresh();
    const off = window.lin?.onConfigurationChanged('skills', refresh);
    return () => { active = false; off?.(); };
  }, []);
  async function changeSkillDirectories(next: string[], mode?: AgentSkillSourceMode): Promise<readonly string[]> {
    const mutationKey = 'skill-directories';
    const generation = beginMutation(mutationKey);
    beginSkillSettingsMutation();
    const currentModes = Object.fromEntries(skillSources.map((source) => [source.path, source.mode]));
    const additionalSkillSourceBindings = mode === undefined
      ? undefined
      : next.map((path) => ({
        path,
        mode: currentModes[path] ?? mode,
      }));
    try {
      const updated = await api.agentUpdateSkillSettings({
        sourceBindings: additionalSkillSourceBindings ?? next.map((path) => ({
          path,
          mode: currentModes[path] ?? 'container',
        })),
      });
      if (isCurrentMutation(mutationKey, generation)) {
        setSkillSources(updated.sourceBindings);
      }
      await reportAppliedRefreshFailure(onApplied, 'skill-directories-refresh', mutationKey);
      // Returned so the caller can see what main actually kept. The list is
      // bounded, and a request that silently lost its entry would otherwise
      // look like nothing happened at all.
      return updated.sourceBindings.map((source) => source.path);
    } finally {
      finishSkillSettingsMutation();
    }
  }

  async function persistSkillDisabled(skillName: string, disabled: boolean): Promise<boolean> {
    const mutationKey = `skill:${skillName}`;
    // Allocate the generation when intent is expressed, not when this queued step
    // eventually starts. A second click must supersede the first immediately.
    const generation = beginMutation(mutationKey);
    beginSkillSettingsMutation();
    skillDisabledTargetsRef.current.set(skillName, disabled);
    applySkillDisabledToView(skillName, disabled);
    setSkillToggleErrors((current) => withoutMapKey(current, skillName));

    return skillDisableQueueRef.current.run(async () => {
      const persisted = latestDisabledSkillsRef.current;
      const next = disabled
        ? [...new Set([...persisted, skillName])]
        : persisted.filter((name) => name !== skillName);
      try {
        const updated = await api.agentUpdateSkillSettings({ disabledSkills: next });
        // Recorded outside the isCurrentRequest guard: the next queued write
        // must build on what main actually stored, even if this reply is too
        // late to be applied to the view.
        latestDisabledSkillsRef.current = updated.disabledSkills;
        if (isCurrentMutation(mutationKey, generation)) {
          skillDisabledTargetsRef.current.delete(skillName);
          applySkillDisabledToView(skillName, latestDisabledSkillsRef.current.includes(skillName));
        }
        await reportAppliedRefreshFailure(onApplied, 'skill-toggle-refresh', skillName);
        return true;
      } catch (caught) {
        // Revert the optimistic flip: a switch that stayed where the user put it
        // after the write failed would claim a state the model does not see.
        if (isCurrentMutation(mutationKey, generation)) {
          skillDisabledTargetsRef.current.delete(skillName);
          applySkillDisabledToView(skillName, latestDisabledSkillsRef.current.includes(skillName));
          setSkillToggleErrors((current) => withMapValue(
            current,
            skillName,
            t.settings.skills.toggleFailed({ name: skillName }),
          ));
          reportSettingsMutationError('skill-toggle-write-failed', skillName, caught);
        }
        return false;
      } finally {
        finishSkillSettingsMutation();
      }
    });
  }

  /**
   * The non-managed half of the Skill toggle. It used to stage into a draft while
   * the managed half committed immediately, so two identical-looking switches in
   * one list meant different things and Cancel reverted only one of them. Both
   * now take the same path.
  */
  function toggleSkill(skillName: string) {
    const disabled = !(skillDisabledTargetsRef.current.get(skillName)
      ?? skillDraftRef.current.disabledSkills.includes(skillName));
    void persistSkillDisabled(skillName, disabled);
  }

  function applySkillDisabledToView(skillName: string, disabled: boolean) {
    const next: SkillDraft = {
      disabledSkills: disabled
        ? [...new Set([...skillDraftRef.current.disabledSkills, skillName])]
        : skillDraftRef.current.disabledSkills.filter((name) => name !== skillName),
    };
    skillDraftRef.current = next;
    setSkillDraft(next);
  }

  return <>
    <ManagerFeedback error={error} />
    <SkillLibrary additionalSkillDirectories={skillSources.map((source) => source.path)}
      active={active} toolbarTarget={toolbarTarget}
      disabledSkills={skillDraft.disabledSkills} onApplied={onApplied} onDirectoriesChange={changeSkillDirectories}
      onToggleSkill={toggleSkill} toggleErrors={skillToggleErrors} />
  </>;
}
