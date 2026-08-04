import { useEffect, useRef, useState } from 'react';
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
  settingsPageCategory,
  type SettingsCategoryTarget,
  type SettingsOpenTarget,
  type SettingsPageTarget,
} from '../../../core/settingsWindow';
import { useT } from '../../i18n/I18nProvider';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { resolveUsableActiveProvider } from './providerCatalog';
import { PREFERRED_PROVIDER_ORDER } from './providerOrder';
import { SettingsGeneralSection } from './SettingsGeneralSection';
import { SettingsProvidersSection } from './SettingsProvidersSection';
import { SettingsSkillLibrarySection } from './SettingsSkillLibrarySection';
import { SettingsAgentSection } from './SettingsAgentSection';
import { SettingsPreviewSection } from './SettingsPreviewSection';
import { SettingsAboutSection } from './SettingsAboutSection';
import { capabilitySettingsRemovalPatch } from './agentCapabilitySettings';

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
type SettingsRoute = { category: SettingsCategory; page?: SettingsPageTarget };
type RequestScope = 'settings' | 'mutation';

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
  if (target?.page) return { category: settingsPageCategory(target.page), page: target.page };
  if (target?.category && SETTINGS_CATEGORY_IDS.includes(target.category)) {
    return { category: target.category };
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
  return left.category === right.category && left.page === right.page;
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
  const route = nav.stack[nav.index];
  const category = routeCategory(route);
  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.stack.length - 1;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const mountedRef = useRef(false);
  // The persisted disabledSkills as of the last completed write, and a queue so
  // concurrent toggles cannot each write a whole array from the same stale read.
  const latestDisabledSkillsRef = useRef<readonly string[]>([]);
  const skillDisableQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Provider writes serialize on their own queue for the reason the Skill writes
  // needed one: each sends a whole settings object built from what it read, so two
  // overlapping writes let the second silently undo the first. Instant-apply makes
  // that easy to trigger — a slow keychain write looks like nothing happened, and
  // the natural response is to click again.
  const providerMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const settingsRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);
  const t = useT();
  // The toolbar names where you are, which on a sub-page is the page — the rail
  // already shows which category owns it.
  const categoryLabel = route.page ? t.settings.pages[route.page] : t.settings.categories[category].label;

  useEffect(() => {
    let active = true;
    // Read-only, and silent on failure: a badge that cannot be computed is
    // simply absent. It never blocks the page or raises an alert.
    void api.agentManagedSkillList()
      .then((skills) => {
        if (active) setSkillUpdateCount(skills.filter((skill) => skill.updateCommit).length);
      })
      .catch(() => { /* no badge */ });
    void api.agentListAllSkills()
      .then((skills) => { if (active) setSkillCount(skills.length); })
      .catch(() => { /* the row falls back to zero rather than blocking the pane */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      settingsRequestRef.current += 1;
      mutationRequestRef.current += 1;
    };
  }, []);

  useEffect(() => window.lin?.onSettingsNavigate?.((target) => {
    setNav(navFromOpenTarget(target));
    setError(null);
    setNotice(null);
  }), []);

  function requestRefFor(scope: RequestScope) {
    if (scope === 'settings') return settingsRequestRef;
    return mutationRequestRef;
  }

  function beginRequest(scope: RequestScope) {
    const ref = requestRefFor(scope);
    ref.current += 1;
    return ref.current;
  }

  function isCurrentRequest(scope: RequestScope, requestId: number) {
    return mountedRef.current && requestId === requestRefFor(scope).current;
  }

  // Navigate to a route, recording history for back / forward. Re-selecting the
  // current route is a no-op (no duplicate history entry).
  function navigateRoute(next: SettingsRoute) {
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

  function applyLoadedSettings(next: AgentProviderSettingsView) {
    latestDisabledSkillsRef.current = next.agent.disabledSkills ?? [];
    setSettings(next);
    setProviderDraft(resolveInitialProviderDraft(next));
    setSkillDraft(resolveSkillDraft(next));
  }

  useEffect(() => {
    const requestId = beginRequest('settings');
    setLoading(true);
    setError(null);
    setNotice(null);
    setNav(navFromOpenTarget(initialTarget));

    void Promise.all([
      api.agentGetProviderSettings(),
      api.agentGetCapabilitySettings(),
    ])
      .then(([next, nextCapabilities]) => {
        if (!isCurrentRequest('settings', requestId)) return;
        setCapabilitySettings(nextCapabilities);
        applyLoadedSettings(next);
      })
      .catch((caught) => {
        if (isCurrentRequest('settings', requestId)) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (isCurrentRequest('settings', requestId)) setLoading(false);
      });
  }, []);

  // The per-provider config window commits in its own process surface and asks the
  // main process to broadcast a settings-changed; refetch so the list reflects the
  // new configured provider row without a manual reopen.
  useEffect(() => {
    const off = window.lin?.onSettingsChanged?.(() => {
      const requestId = beginRequest('settings');
      void api.agentGetProviderSettings()
        .then((next) => {
          if (!isCurrentRequest('settings', requestId)) return;
          applyLoadedSettings(next);
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
    const requestId = beginRequest('mutation');
    // Optimistic: the row leaves at once because that is what the user asked for.
    setCapabilitySettings({ ...base, blocks: base.blocks.filter((candidate) => candidate !== rule) });
    try {
      const next = await api.agentApplyCapabilitySettingsPatch(patch);
      if (isCurrentRequest('mutation', requestId)) setCapabilitySettings(next);
      await onApplied();
    } catch (caught) {
      // Put it back. A row that vanished and stayed vanished would tell the user
      // the rule is gone while the agent still enforces it.
      if (isCurrentRequest('mutation', requestId)) {
        setCapabilitySettings(base);
        setError(caught instanceof Error ? caught.message : String(caught));
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
    const requestId = beginRequest('mutation');
    setSaving(true);
    try {
      const updated = await api.agentUpdateRuntimeSettings({ additionalSkillDirectories: next });
      if (isCurrentRequest('mutation', requestId)) setSettings(updated);
      await onApplied();
      // Returned so the caller can see what main actually kept. The list is
      // bounded, and a request that silently lost its entry would otherwise
      // look like nothing happened at all.
      return updated.agent.additionalSkillDirectories;
    } finally {
      if (isCurrentRequest('mutation', requestId)) setSaving(false);
    }
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
    const run = skillDisableQueueRef.current.then(async () => {
      const persisted = latestDisabledSkillsRef.current;
      const next = disabled
        ? [...new Set([...persisted, skillName])]
        : persisted.filter((name) => name !== skillName);
      const requestId = beginRequest('mutation');
      setSaving(true);
      try {
        const updated = await api.agentUpdateRuntimeSettings({ disabledSkills: next });
        // Recorded outside the isCurrentRequest guard: the next queued write
        // must build on what main actually stored, even if this reply is too
        // late to be applied to the view.
        latestDisabledSkillsRef.current = updated.agent.disabledSkills ?? [];
        if (isCurrentRequest('mutation', requestId)) {
          setSettings(updated);
          // Adjusted by the same SINGLE change, never overwritten wholesale, so a
          // reply arriving while another row is mid-flight cannot revert it.
          setSkillDraft((current) => ({
            disabledSkills: disabled
              ? [...new Set([...current.disabledSkills, skillName])]
              : current.disabledSkills.filter((name) => name !== skillName),
          }));
        }
        await onApplied();
        return true;
      } catch (caught) {
        // Revert the optimistic flip: a switch that stayed where the user put it
        // after the write failed would claim a state the model does not see.
        if (isCurrentRequest('mutation', requestId)) {
          setSkillDraft((current) => ({
            disabledSkills: disabled
              ? current.disabledSkills.filter((name) => name !== skillName)
              : [...new Set([...current.disabledSkills, skillName])],
          }));
        }
        setError(caught instanceof Error ? caught.message : String(caught));
        setNotice(null);
        return false;
      } finally {
        if (isCurrentRequest('mutation', requestId)) setSaving(false);
      }
    });
    skillDisableQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The non-managed half of the Skill toggle. It used to stage into a draft while
   * the managed half committed immediately, so two identical-looking switches in
   * one list meant different things and Cancel reverted only one of them. Both
   * now take the same path.
   */
  function toggleSkill(skillName: string) {
    const disabled = !skillDraft.disabledSkills.includes(skillName);
    // Optimistic: the switch moves now, and `persistSkillDisabled` puts it back
    // if the write fails.
    setSkillDraft((current) => ({
      disabledSkills: disabled
        ? [...new Set([...current.disabledSkills, skillName])]
        : current.disabledSkills.filter((name) => name !== skillName),
    }));
    void persistSkillDisabled(skillName, disabled);
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
    const run = providerMutationQueueRef.current.then(() => runProviderMutationStep(action, successNotice, resetToInitial));
    providerMutationQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }

  async function runProviderMutationStep(
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial: boolean,
  ) {
    const requestId = beginRequest('mutation');
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (isCurrentRequest('mutation', requestId)) {
        setSettings(next);
        setProviderDraft(resetToInitial
          ? resolveInitialProviderDraft(next)
          : resolveProviderDraftFor(next, providerDraft.providerId));
        setSkillDraft(resolveSkillDraft(next));
        setNotice(successNotice);
      }
      await onApplied();
    } catch (caught) {
      if (isCurrentRequest('mutation', requestId)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrentRequest('mutation', requestId)) setSaving(false);
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
                </ButtonControl>
              );
            })}
          </nav>
        </aside>

        <div className="settings-content" aria-busy={loading ? 'true' : undefined}>
            {route.page === 'skills' ? (
              <SettingsSkillLibrarySection
                additionalSkillDirectories={settings?.agent.additionalSkillDirectories ?? []}
                disabledSkills={skillDraft.disabledSkills}
                onApplied={onApplied}
                onDirectoriesChange={changeSkillDirectories}
                onError={setError}
                onNotice={setNotice}
                onPersistSkillDisabled={persistSkillDisabled}
                onToggleSkill={toggleSkill}
                onUpdateCountChange={setSkillUpdateCount}
              />
            ) : route.page === 'services' ? (
              <SettingsProvidersSection
                draftProviderId={providerDraft.providerId}
                runProviderMutation={runProviderMutation}
                saving={saving}
                settings={settings}
              />
            ) : route.page === 'about' ? (
              <SettingsAboutSection onError={setError} onNotice={setNotice} />
            ) : category === 'general' ? (
              <SettingsGeneralSection
                onError={setError}
                onNotice={setNotice}
                onOpenPage={openPage}
              />
            ) : category === 'agent' ? (
              <SettingsAgentSection
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
              <SettingsPreviewSection onError={setError} onNotice={setNotice} />
            )}

            {error ? (
              <div className="agent-settings-alert" role="alert">
                <WarningIcon size={ICON_SIZE.menu} />
                <span>{error}</span>
              </div>
            ) : null}
            {notice ? <div className="agent-settings-notice">{notice}</div> : null}

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


