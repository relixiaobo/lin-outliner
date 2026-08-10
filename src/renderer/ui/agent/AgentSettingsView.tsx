import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppIcon } from '../icons';
import type {
  AgentProviderConfigView,
  AgentProviderSettingsView,
  AgentCapabilitySettingsView,
} from '../../api/types';
import { api } from '../../api/client';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  ICON_SIZE,
  PasswordIcon,
  SettingsIcon,
  SkillIcon,
  WarningIcon,
} from '../icons';
import {
  isSettingsAnchorTarget,
  settingsPageCategory,
  type SettingsCategoryTarget,
  type SettingsOpenTarget,
  type SettingsPageTarget,
} from '../../../core/settingsWindow';
import { serializeUnknownError } from '../../../core/errorObservability';
import { useT } from '../../i18n/I18nProvider';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { formatProviderName, resolveUsableActiveProvider } from './providerCatalog';
import { PREFERRED_PROVIDER_ORDER } from './providerOrder';
import { SettingsGeneralSection } from './SettingsGeneralSection';
import { SettingsProvidersSection } from './SettingsProvidersSection';
import { SettingsSkillLibrarySection } from './SettingsSkillLibrarySection';
import { SettingsAgentSection } from './SettingsAgentSection';
import { SettingsPreviewSection } from './SettingsPreviewSection';
import { SettingsAboutSection } from './SettingsAboutSection';
import { capabilitySettingsRemovalPatch } from './agentCapabilitySettings';
import { beginKeyedMutation, isCurrentKeyedMutation } from '../keyedMutationGeneration';
import { createSerialMutationQueue } from '../../../core/serialMutationQueue';
import { skillLibraryCount } from './skillLibraryCount';
import { isAppUpdateAvailable, type AppUpdateView } from '../../../core/appUpdate';

interface AgentSettingsViewProps {
  onClose: () => void;
  onApplied: () => Promise<void>;
  initialTarget?: SettingsOpenTarget;
}

type SettingsCategory = SettingsCategoryTarget;
/**
 * A route is a category, optionally with the page open on top of it. Until now
 * there was only ever one route type, which is why back/forward could never do
 * anything: history could only hold categories that the rail already listed two
 * inches to the left. With real second-level pages the arrows have work.
 */
type SettingsRoute = { category: SettingsCategory; page?: SettingsPageTarget; anchor?: string };

/**
 * Not a draft in the commit sense — nothing here waits for a Save. `ProviderDraft`
 * is which provider the Providers pane treats as selected; `SkillDraft` mirrors
 * the persisted disabled set so a toggle can move optimistically and be put back
 * if the write fails.
 */
interface ProviderDraft {
  providerId: string;
  baseUrl: string;
  enabled: boolean;
}

interface SkillDraft {
  disabledSkills: string[];
}

const EMPTY_PROVIDER_DRAFT: ProviderDraft = {
  providerId: '',
  baseUrl: '',
  enabled: true,
};

const EMPTY_SKILL_DRAFT: SkillDraft = {
  disabledSkills: [],
};

// Category rail order; visible labels are localized at render.
const SETTINGS_CATEGORY_IDS: readonly SettingsCategory[] = ['general', 'agent', 'preview'];
const SETTINGS_CATEGORY_ICONS = {
  general: SettingsIcon,
  agent: SkillIcon,
  preview: DatabaseIcon,
} satisfies Partial<Record<SettingsCategory, AppIcon>>;

function routeFromOpenTarget(target: SettingsOpenTarget | undefined): SettingsRoute {
  const anchor = isSettingsAnchorTarget(target?.anchor) ? target.anchor : undefined;
  if (target?.page) {
    return { category: settingsPageCategory(target.page), page: target.page, ...(anchor ? { anchor } : {}) };
  }
  if (target?.category && SETTINGS_CATEGORY_IDS.includes(target.category)) {
    return { category: target.category, ...(anchor ? { anchor } : {}) };
  }
  // General, not the first pane that needs configuring: opening Providers on every
  // Cmd+, leaked a first-run concern onto the everyday path.
  return { category: 'general' };
}

function navFromOpenTarget(target: SettingsOpenTarget | undefined): { stack: SettingsRoute[]; index: number } {
  return { stack: [routeFromOpenTarget(target)], index: 0 };
}

function routeCategory(route: SettingsRoute): SettingsCategory {
  return route.category;
}

function routesEqual(left: SettingsRoute, right: SettingsRoute): boolean {
  return left.category === right.category && left.page === right.page && left.anchor === right.anchor;
}

/**
 * The settings shell. It owns what every category shares — navigation history,
 * the loaded settings, and the single error/notice surface — and renders exactly
 * one category component beneath it. Category-local state lives in that
 * category's component.
 *
 * Every control commits where it sits. There is no footer, no draft, and so no
 * way for closing the window or switching category to discard work.
 */
export function AgentSettingsView({ onApplied, onClose, initialTarget }: AgentSettingsViewProps) {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [capabilitySettings, setCapabilitySettings] = useState<AgentCapabilitySettingsView | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT);
  const [skillDraft, setSkillDraft] = useState<SkillDraft>(EMPTY_SKILL_DRAFT);
  // Route navigation history for macOS System Settings-style back/forward chrome.
  const [nav, setNav] = useState<{ stack: SettingsRoute[]; index: number }>({
    stack: [routeFromOpenTarget(initialTarget)],
    index: 0,
  });
  const [targetGeneration, setTargetGeneration] = useState(0);
  const route = nav.stack[nav.index];
  const category = routeCategory(route);
  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.stack.length - 1;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capabilityMutationErrors, setCapabilityMutationErrors] = useState<Map<string, string>>(new Map());
  const [providerEnabledOverrides, setProviderEnabledOverrides] = useState<Map<string, boolean>>(new Map());
  const [providerToggleErrors, setProviderToggleErrors] = useState<Map<string, string>>(new Map());
  const [skillToggleErrors, setSkillToggleErrors] = useState<Map<string, string>>(new Map());
  // Notices are transient. A stale "Unbound /x" that lingers until some unrelated
  // action happens to clear it reads as a report on whatever the user did next.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  // How many managed Skills have an update waiting. The shell reads this once so
  // the badge is right while the user is in some other category — the library is
  // not mounted then. Whenever the library IS mounted it owns the list, so it
  // pushes the count back through onUpdateCountChange; without that the badge
  // would keep reporting the mount-time value, missing an update discovered
  // afterwards and still claiming one the user had just applied.
  const [skillUpdateCount, setSkillUpdateCount] = useState(0);
  // How many Skills exist, for the Agent pane's row. Read here for the same
  // reason as the badge: the library owns the list but is only mounted on its
  // own page, and the row has to be right before anyone opens it.
  const [skillCount, setSkillCount] = useState(0);
  const [appUpdate, setAppUpdate] = useState<AppUpdateView | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  // The persisted disabledSkills as of the last completed write, and a queue so
  // concurrent toggles cannot each write a whole array from the same stale read.
  const latestDisabledSkillsRef = useRef<readonly string[]>([]);
  const skillDraftRef = useRef<SkillDraft>(EMPTY_SKILL_DRAFT);
  const skillDisabledTargetsRef = useRef(new Map<string, boolean>());
  const skillDisableQueueRef = useRef(createSerialMutationQueue());
  // Every provider command returns a complete settings snapshot. Serialize those
  // responses as one family so an older Set active / Remove / Refresh response
  // cannot land after a newer enable toggle and replace that row with stale state.
  // Controls still move optimistically, so coordination never makes the UI inert.
  const providerMutationQueueRef = useRef(createSerialMutationQueue());
  const providerSettingsRef = useRef<AgentProviderSettingsView | null>(null);
  const providerEnabledTargetsRef = useRef(new Map<string, boolean>());
  const settingsRequestRef = useRef(0);
  const providerRefreshRequestRef = useRef(0);
  const settingsInitializedRef = useRef(false);
  const mutationGenerationsRef = useRef(new Map<string, number>());
  const t = useT();
  const updateAvailable = isAppUpdateAvailable(appUpdate);
  // The toolbar names where you are, which on a sub-page is the page — the rail
  // already shows which category owns it.
  const categoryLabel = route.page ? t.settings.pages[route.page] : t.settings.categories[category].label;

  useEffect(() => {
    let active = true;
    const allSkillsRequest = api.agentListAllSkills();
    const managedSkillsRequest = api.agentManagedSkillList();
    // Read-only, and silent on failure: a badge that cannot be computed is
    // simply absent. It never blocks the page or raises an alert.
    void managedSkillsRequest
      .then((skills) => {
        if (active) setSkillUpdateCount(skills.filter((skill) => skill.updateCommit).length);
      })
      .catch(() => { /* no badge */ });
    void Promise.all([allSkillsRequest, managedSkillsRequest])
      .then(([allSkills, managedSkills]) => {
        if (active) setSkillCount(skillLibraryCount(allSkills, managedSkills));
      })
      .catch(() => { /* the row falls back to zero rather than blocking the pane */ });
    return () => { active = false; };
  }, []);

  // App update state has two consumers (the General rail and About), so the
  // shell owns the one global subscription. Page components receive the same
  // snapshot and cannot accumulate listeners as navigation mounts/unmounts them.
  useEffect(() => {
    let active = true;
    const unsubscribe = window.lin?.appUpdate?.onChanged((view) => {
      if (active) setAppUpdate(view);
    });
    void window.lin?.appUpdate?.get()
      .then((view) => {
        if (active) setAppUpdate(view);
      })
      .catch(() => { /* update status is inspection-only */ });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      settingsRequestRef.current += 1;
      providerRefreshRequestRef.current += 1;
      mutationGenerationsRef.current.clear();
    };
  }, []);

  useEffect(() => window.lin?.onSettingsNavigate?.((target) => {
    setNav(navFromOpenTarget(target));
    setTargetGeneration((current) => current + 1);
    setError(null);
    setNotice(null);
  }), []);

  // A page reached from below the fold must not inherit the previous pane's
  // scroll position. Reset before paint; the anchor effect below can then move
  // an explicit deep link to its requested group.
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [route.category, route.page]);

  useEffect(() => {
    if (loading || !route.anchor) return;
    const target = document.querySelector<HTMLElement>(`[data-settings-anchor="${route.anchor}"]`);
    if (!target) return;
    target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    target.classList.add('is-settings-anchor-target');
    const timer = window.setTimeout(() => target.classList.remove('is-settings-anchor-target'), 1_600);
    return () => {
      window.clearTimeout(timer);
      target.classList.remove('is-settings-anchor-target');
    };
  }, [loading, route.anchor, route.category, route.page, targetGeneration]);

  function beginSettingsRequest() {
    settingsRequestRef.current += 1;
    return settingsRequestRef.current;
  }

  function isCurrentSettingsRequest(requestId: number) {
    return mountedRef.current && requestId === settingsRequestRef.current;
  }

  function beginMutation(key: string) {
    return beginKeyedMutation(mutationGenerationsRef.current, key);
  }

  function isCurrentMutation(key: string, generation: number) {
    return mountedRef.current
      && isCurrentKeyedMutation(mutationGenerationsRef.current, key, generation);
  }

  // Navigate to a route, recording history for back / forward. Re-selecting the
  // current route is a no-op (no duplicate history entry).
  function navigateRoute(next: SettingsRoute) {
    // An error raised in one pane used to survive into every other pane, and was
    // cleared only by happening to pass through the Skill library, whose mount
    // effect reset it — the same gesture produced different results depending on
    // where you were going, which reads as flakiness.
    setError(null);
    setNotice(null);
    setNav((current) => {
      if (routesEqual(current.stack[current.index], next)) return current;
      const stack = [...current.stack.slice(0, current.index + 1), next];
      return { stack, index: stack.length - 1 };
    });
  }

  function navigateCategory(next: SettingsCategory) {
    navigateRoute({ category: next });
  }

  // Opening a page pushes it onto the same history the arrows walk, so Back
  // returns to the category rather than closing the window.
  function openPage(page: SettingsPageTarget) {
    navigateRoute({ category: settingsPageCategory(page), page });
  }

  function goBack() {
    setNav((current) => (current.index > 0 ? { ...current, index: current.index - 1 } : current));
  }

  function goForward() {
    setNav((current) =>
      current.index < current.stack.length - 1 ? { ...current, index: current.index + 1 } : current,
    );
  }

  function applyLoadedSettings(next: AgentProviderSettingsView, applySkillState = true) {
    providerSettingsRef.current = next;
    setSettings(next);
    setProviderDraft(resolveInitialProviderDraft(next));
    if (applySkillState) {
      latestDisabledSkillsRef.current = next.agent.disabledSkills ?? [];
      const nextSkillDraft = resolveSkillDraft(next);
      skillDraftRef.current = nextSkillDraft;
      setSkillDraft(nextSkillDraft);
    }
    settingsInitializedRef.current = true;
  }

  useEffect(() => {
    const requestId = beginSettingsRequest();
    setLoading(true);
    setError(null);
    setNotice(null);
    setNav(navFromOpenTarget(initialTarget));

    void Promise.all([
      api.agentGetProviderSettings(),
      api.agentGetCapabilitySettings(),
    ])
      .then(([next, nextCapabilities]) => {
        if (!isCurrentSettingsRequest(requestId)) return;
        setCapabilitySettings(nextCapabilities);
        applyLoadedSettings(next);
      })
      .catch((caught) => {
        if (isCurrentSettingsRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (isCurrentSettingsRequest(requestId)) setLoading(false);
      });
  }, []);

  // The per-provider config window commits in its own process surface and asks the
  // main process to broadcast a settings-changed; refetch so the list reflects the
  // new configured provider row without a manual reopen.
  useEffect(() => {
    const off = window.lin?.onSettingsChanged?.(() => {
      const refreshId = ++providerRefreshRequestRef.current;
      void Promise.all([
        api.agentGetProviderSettings(),
        api.agentGetCapabilitySettings(),
      ])
        .then(([next, nextCapabilities]) => {
          if (!mountedRef.current || refreshId !== providerRefreshRequestRef.current) return;
          // Invalidate an older initial load only after this replacement is known
          // to be complete. A failed refresh must not strand the window in its
          // loading state with the successful initial response marked stale.
          beginSettingsRequest();
          setCapabilitySettings(nextCapabilities);
          applyLoadedSettings(next, !settingsInitializedRef.current);
          setLoading(false);
        })
        .catch(() => { /* a refetch failure leaves the prior list in place */ });
    });
    return off;
  }, []);

  const capabilityBlocks = capabilitySettings?.blocks ?? [];

  /**
   * Removing a block commits on the row, like every other control in this window.
   *
   * It used to stage into a draft that a footer Save committed — a footer whose
   * visibility was keyed to the current category while the draft was global, so
   * navigating away hid a pending removal with no indication it still existed,
   * and pressing Save from another pane committed it blind.
   */
  async function removeCapabilityBlock(rule: string) {
    const base = capabilitySettings ?? emptyCapabilitySettings();
    const patch = capabilitySettingsRemovalPatch(base, {
      ...base,
      blocks: base.blocks.filter((candidate) => candidate !== rule),
    });
    const mutationKey = `capability:${rule}`;
    const generation = beginMutation(mutationKey);
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
    }
  }

  /**
   * Binding or unbinding a Skill directory is a structural action like
   * installing, not a preference — it applies immediately rather than waiting
   * for the footer Save. It deliberately does NOT reset the drafts: a directory
   * change is orthogonal to the toggles the user may have pending.
   */
  async function changeSkillDirectories(next: string[]): Promise<readonly string[]> {
    const mutationKey = 'skill-directories';
    const generation = beginMutation(mutationKey);
    const updated = await api.agentUpdateRuntimeSettings({ additionalSkillDirectories: next });
    if (isCurrentMutation(mutationKey, generation)) {
      setSettings((current) => current ? { ...current, agent: updated.agent } : updated);
    }
    await reportAppliedRefreshFailure(onApplied, 'skill-directories-refresh', mutationKey);
    // Returned so the caller can see what main actually kept. The list is
    // bounded, and a request that silently lost its entry would otherwise
    // look like nothing happened at all.
    return updated.agent.additionalSkillDirectories;
  }

  /**
   * Persists one Skill's `disabledSkills` membership immediately.
   *
   * The managed toggle activates through the managed index at once, so its other
   * half cannot be a draft the footer Save commits later: flipping a managed
   * Skill on and then cancelling would leave it activated on disk but still
   * named in disabledSkills, which the unified predicate reads as off — the
   * model could not invoke it and the row would come back off with no
   * explanation. One user action, one commit model.
   *
   * The write is derived from the PERSISTED list, never from view state, so a
   * queued write cannot smuggle another row's in-flight change onto disk.
   *
   * Serialized for the same reason. Two toggles inside one IPC round trip both
   * read the same settings state and each wrote a whole array, so the second
   * silently undid the first: the Skill's activation had succeeded and its notice
   * said so, but the row came back off and the model could not invoke it, with no
   * error anywhere. Chaining makes the second read the result of the first.
  */
  async function persistSkillDisabled(skillName: string, disabled: boolean): Promise<boolean> {
    const mutationKey = `skill:${skillName}`;
    // Allocate the generation when intent is expressed, not when this queued step
    // eventually starts. A second click must supersede the first immediately.
    const generation = beginMutation(mutationKey);
    skillDisabledTargetsRef.current.set(skillName, disabled);
    applySkillDisabledToView(skillName, disabled);
    setSkillToggleErrors((current) => withoutMapKey(current, skillName));

    return skillDisableQueueRef.current.run(async () => {
      const persisted = latestDisabledSkillsRef.current;
      const next = disabled
        ? [...new Set([...persisted, skillName])]
        : persisted.filter((name) => name !== skillName);
      try {
        const updated = await api.agentUpdateRuntimeSettings({ disabledSkills: next });
        // Recorded outside the isCurrentRequest guard: the next queued write
        // must build on what main actually stored, even if this reply is too
        // late to be applied to the view.
        latestDisabledSkillsRef.current = updated.agent.disabledSkills ?? [];
        if (isCurrentMutation(mutationKey, generation)) {
          skillDisabledTargetsRef.current.delete(skillName);
          applySkillDisabledToView(skillName, latestDisabledSkillsRef.current.includes(skillName));
          setSettings((current) => current ? { ...current, agent: updated.agent } : updated);
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
          setNotice(null);
        }
        return false;
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

  /**
   * Provider activation is a targeted local preference, not a connection save.
   * The synchronous target ref makes two clicks before React renders mean off,
   * then on — not two identical off writes from one stale closure. The actual IPC
   * step joins the provider snapshot queue because every provider command returns
   * the whole collection, even when it mutates only one row.
   */
  function toggleProviderEnabled(providerId: string, baseUrl: string | null) {
    const stored = providerSettingsRef.current?.providers.find((provider) => provider.providerId === providerId);
    const enabled = !(providerEnabledTargetsRef.current.get(providerId) ?? stored?.enabled ?? false);
    const mutationKey = `provider-enabled:${providerId}`;
    const generation = beginMutation(mutationKey);
    providerEnabledTargetsRef.current.set(providerId, enabled);
    setProviderEnabledOverrides((current) => withMapValue(current, providerId, enabled));
    setProviderToggleErrors((current) => withoutMapKey(current, providerId));
    setError(null);
    setNotice(null);

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
        setNotice(enabled ? t.settings.providers.enabledNotice : t.settings.providers.disabledNotice);
      }
    });
  }

  // There is no `save()`. Every control in this window commits where it is, so
  // there is nothing left for a footer to collect — and with no draft to lose,
  // closing the window, switching category, or ⌘W can no longer discard work.

  // Per-row ⋯ actions operate on an explicit providerId (independent of the draft
  // selection); they share one refetch/notice/error envelope.
  async function runProviderMutationAsync(
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial = false,
  ) {
    return enqueueProviderMutation(() => runProviderMutationStep(action, successNotice, resetToInitial));
  }

  function enqueueProviderMutation<T>(action: () => Promise<T>): Promise<T> {
    return providerMutationQueueRef.current.run(action);
  }

  async function runProviderMutationStep(
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial: boolean,
  ) {
    const mutationKey = 'providers';
    const generation = beginMutation(mutationKey);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      providerSettingsRef.current = next;
      if (isCurrentMutation(mutationKey, generation)) {
        setSettings(next);
        setProviderDraft(resetToInitial
          ? resolveInitialProviderDraft(next)
          : resolveProviderDraftFor(next, providerDraft.providerId));
        setNotice(successNotice);
      }
      await onApplied();
    } catch (caught) {
      if (isCurrentMutation(mutationKey, generation)) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function runProviderMutation(
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial = false,
  ) {
    void runProviderMutationAsync(action, successNotice, resetToInitial);
  }

  return (
    <main className="settings-window" aria-labelledby="settings-page-title">
      {/* Frameless window: this top strip is the drag region that stands in for the
          native title bar. The OS traffic lights overlay it; the rail title/nav and
          content controls all sit below --chrome-height, so none overlaps it. The
          back / forward arrows are no-drag DOM CHILDREN of the strip — the only
          reliable carve-out from a drag region on macOS — anchored over the content
          column, on the traffic-light centreline, like System Settings' toolbar. */}
      <div className="settings-drag-region">
        <div className="settings-toolbar">
          <div className="settings-history-nav">
            {/* The same chrome control as the main window's rail toggles
                (IconButton variant="chrome" + .rail-toggle): icon-only, colour
                deepens on hover. The Settings-only wrapper supplies the neutral
                capsule group, so individual arrows do not get bespoke boxes. */}
            <IconButton
              className="rail-toggle"
              disabled={!canGoBack}
              icon={ChevronLeftIcon}
              iconSize={ICON_SIZE.toolbar}
              label={t.settings.navigation.back}
              onClick={goBack}
              strokeWidth={1.7}
              variant="chrome"
            />
            <span className="settings-history-divider" aria-hidden="true" />
            <IconButton
              className="rail-toggle"
              disabled={!canGoForward}
              icon={ChevronRightIcon}
              iconSize={ICON_SIZE.toolbar}
              label={t.settings.navigation.forward}
              onClick={goForward}
              strokeWidth={1.7}
              variant="chrome"
            />
          </div>
          <h1 className="settings-toolbar-title" id="settings-page-title">{categoryLabel}</h1>
        </div>
      </div>
      <div className="settings-layout">
        <aside className="settings-rail">
          <h2 className="settings-rail-title">{t.settings.railTitle}</h2>
          <nav className="settings-nav" aria-label={t.settings.categoriesAriaLabel}>
            {SETTINGS_CATEGORY_IDS.map((id) => {
              const cat = t.settings.categories[id];
              const CategoryIcon = SETTINGS_CATEGORY_ICONS[id]!;
              return (
                <ButtonControl
                  aria-current={category === id ? 'page' : undefined}
                  className={`settings-nav-item ${category === id ? 'is-active' : ''}`}
                  key={id}
                  onClick={() => navigateCategory(id)}
                >
                  <span className="settings-nav-icon" aria-hidden="true">
                    <CategoryIcon size={ICON_SIZE.menu} strokeWidth={1.75} />
                  </span>
                  <span className="settings-nav-copy">
                    <span className="settings-nav-label">{cat.label}</span>
                  </span>
                  {/* Skills is a page inside Agent now, so its update count
                      surfaces on the Agent rail row — one level up, still
                      impossible to miss. */}
                  {id === 'agent' && skillUpdateCount > 0 ? (
                    <span
                      role="status"
                      aria-label={t.settings.skills.updatesAvailable({ count: skillUpdateCount })}
                      className="settings-nav-badge"
                    >
                      {skillUpdateCount}
                    </span>
                  ) : null}
                  {id === 'general' ? (
                    <span
                      aria-hidden={updateAvailable ? undefined : 'true'}
                      aria-label={updateAvailable ? t.settings.about.updateAvailableIndicator : undefined}
                      className={`settings-status-dot${updateAvailable ? '' : ' is-hidden'}`}
                      role={updateAvailable ? 'img' : undefined}
                    />
                  ) : null}
                </ButtonControl>
              );
            })}
          </nav>
        </aside>

        <div ref={contentRef} className="settings-content" aria-busy={loading ? 'true' : undefined}>
            {route.page === 'skills' ? (
              <SettingsSkillLibrarySection
                additionalSkillDirectories={settings?.agent.additionalSkillDirectories ?? []}
                disabledSkills={skillDraft.disabledSkills}
                onApplied={onApplied}
                onDirectoriesChange={changeSkillDirectories}
                onError={setError}
                onNotice={setNotice}
                onPersistSkillDisabled={persistSkillDisabled}
                onSkillCountChange={setSkillCount}
                onToggleSkill={toggleSkill}
                onUpdateCountChange={setSkillUpdateCount}
                toggleErrors={skillToggleErrors}
              />
            ) : route.page === 'services' ? (
              <SettingsProvidersSection
                draftProviderId={providerDraft.providerId}
                enabledOverrides={providerEnabledOverrides}
                onToggleProviderEnabled={toggleProviderEnabled}
                runProviderMutation={runProviderMutation}
                settings={settings}
                toggleErrors={providerToggleErrors}
              />
            ) : route.page === 'about' ? (
              <SettingsAboutSection
                appUpdate={appUpdate}
                onAppUpdateChange={setAppUpdate}
                onError={setError}
                onNotice={setNotice}
              />
            ) : category === 'general' ? (
              <SettingsGeneralSection
                onError={setError}
                onNotice={setNotice}
                onOpenPage={openPage}
                updateAvailable={updateAvailable}
              />
            ) : category === 'agent' ? (
              <SettingsAgentSection
                blockErrors={capabilityMutationErrors}
                blocks={capabilityBlocks}
                onError={setError}
                onNotice={setNotice}
                onOpenPage={openPage}
                onRemoveBlock={removeCapabilityBlock}
                settings={settings}
                skillCount={skillCount}
                skillUpdateCount={skillUpdateCount}
              />
            ) : (
              <SettingsPreviewSection onError={setError} onNotice={setNotice} settings={settings} />
            )}

            {/* Pinned to the bottom of the pane rather than sitting at the end of
                its scroll content. An export that failed used to report into a
                block below the fold of a six-group pane, so from the user's
                viewport the button simply did nothing. Which control failed is
                already answered by the control itself — an optimistic write that
                fails snaps its switch back — so this says what happened, and the
                row says where. */}
            {error || notice ? (
              <div className="agent-settings-feedback">
                {error ? (
                  <div className="agent-settings-alert" role="alert">
                    <WarningIcon size={ICON_SIZE.menu} />
                    <span>{error}</span>
                  </div>
                ) : null}
                {/* role=status, because a success that is never announced is a
                    success only sighted users who are looking down get. */}
                {notice ? <div className="agent-settings-notice" role="status">{notice}</div> : null}
              </div>
            ) : null}

          </div>
        </div>
    </main>
  );
}

function resolveInitialProviderDraft(settings: AgentProviderSettingsView): ProviderDraft {
  const active = resolveUsableActiveProvider(settings);
  const existing = active ?? settings.providers[0];
  if (existing) return providerToDraft(existing);

  const preferredCatalog = PREFERRED_PROVIDER_ORDER
    .map((providerId) => settings.availableProviders.find((provider) => provider.providerId === providerId))
    .find(Boolean) ?? settings.availableProviders[0];
  return {
    providerId: preferredCatalog?.providerId ?? 'anthropic',
    baseUrl: '',
    enabled: true,
  };
}

function resolveProviderDraftFor(settings: AgentProviderSettingsView, providerId: string): ProviderDraft {
  const existing = settings.providers.find((provider) => provider.providerId === providerId);
  if (existing) return providerToDraft(existing);
  return resolveInitialProviderDraft(settings);
}

function resolveSkillDraft(settings: AgentProviderSettingsView): SkillDraft {
  return { disabledSkills: settings.agent.disabledSkills ?? [] };
}

function emptyCapabilitySettings(): AgentCapabilitySettingsView {
  return { blocks: [], diagnostics: [] };
}

function providerToDraft(provider: AgentProviderConfigView): ProviderDraft {
  return {
    providerId: provider.providerId,
    baseUrl: provider.baseUrl ?? '',
    enabled: provider.enabled,
  };
}

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

function removeCapabilityRule(settings: AgentCapabilitySettingsView, rule: string): AgentCapabilitySettingsView {
  return { ...settings, blocks: settings.blocks.filter((candidate) => candidate !== rule) };
}

function restoreCapabilityRule(
  settings: AgentCapabilitySettingsView,
  originalOrder: readonly string[],
  rule: string,
): AgentCapabilitySettingsView {
  if (settings.blocks.includes(rule)) return settings;
  const blocks = [...settings.blocks];
  const originalIndex = originalOrder.indexOf(rule);
  const nextKnownRule = originalOrder
    .slice(originalIndex + 1)
    .find((candidate) => blocks.includes(candidate));
  const insertionIndex = nextKnownRule ? blocks.indexOf(nextKnownRule) : blocks.length;
  blocks.splice(insertionIndex, 0, rule);
  return { ...settings, blocks };
}

function mergeProviderEnabledResult(
  current: AgentProviderSettingsView,
  response: AgentProviderSettingsView,
  providerId: string,
  enabled: boolean,
): AgentProviderSettingsView {
  const responseProvider = response.providers.find((provider) => provider.providerId === providerId);
  if (!responseProvider) return current;
  const index = current.providers.findIndex((provider) => provider.providerId === providerId);
  const providers = [...current.providers];
  if (index >= 0) providers[index] = responseProvider;
  else providers.push(responseProvider);
  return {
    ...current,
    providers,
    // Enabling never selects a provider. Disabling the active row does, however,
    // make main resolve a fallback, so only that targeted transition adopts the
    // response's active id instead of overwriting an unrelated concurrent choice.
    activeProviderId: !enabled && current.activeProviderId === providerId
      ? response.activeProviderId
      : current.activeProviderId,
  };
}

function reportSettingsMutationError(code: string, key: string, error: unknown): void {
  window.lin?.reportRendererError?.({
    domain: 'persistence',
    severity: 'error',
    code,
    message: 'Failed to persist an immediate Settings mutation.',
    context: { key },
    error: serializeUnknownError(error),
  });
}

async function reportAppliedRefreshFailure(
  onApplied: () => Promise<void>,
  code: string,
  key: string,
): Promise<void> {
  try {
    await onApplied();
  } catch (error) {
    // The write already committed. A secondary refresh failure must not roll the
    // control back and claim persistence failed.
    reportSettingsMutationError(code, key, error);
  }
}
