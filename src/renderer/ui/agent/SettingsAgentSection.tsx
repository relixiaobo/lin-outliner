import { useEffect, useState } from 'react';
import type { AgentProviderSettingsView } from '../../api/types';
import type { AgentDelegationSettingsInput } from '../../api/types';
import { api } from '../../api/client';
import type { SettingsPageTarget } from '../../../core/settingsWindow';
import { useT } from '../../i18n/I18nProvider';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { MemorySettingsGroup } from './MemorySettingsGroup';
import { SettingsSecuritySection } from './SettingsSecuritySection';
import { resolveProviderStatus, providerStatusSentence } from './providerStatus';
import { buildProviderChoices } from './settingsProviderModel';
import { formatProviderName } from './providerCatalog';
import { SettingsDelegationGroup } from './SettingsDelegationGroup';

interface SettingsAgentSectionProps {
  settings: AgentProviderSettingsView | null;
  blocks: readonly string[];
  blockErrors: ReadonlyMap<string, string>;
  skillCount: number;
  skillUpdateCount: number;
  onOpenPage: (page: SettingsPageTarget) => void;
  onRemoveBlock: (rule: string) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onDelegationChange: (input: AgentDelegationSettingsInput) => Promise<void>;
}

/**
 * The Agent category — everything a user thinks of as "my AI": what it runs on,
 * what it can do, what it remembers, and what it is allowed to touch.
 *
 * Model services and Skills are sub-pages; Memory and Permissions are inline.
 * The rule is about the content, not the size: a collection the user installs or
 * connects, unbounded and carrying its own lifecycle, earns a page — a bounded
 * set of settings does not. Applying it to both collections is what removed the
 * earlier asymmetry where Skills drilled down and model services did not.
 */
export function SettingsAgentSection({
  settings,
  blocks,
  blockErrors,
  skillCount,
  skillUpdateCount,
  onOpenPage,
  onRemoveBlock,
  onError,
  onNotice,
  onDelegationChange,
}: SettingsAgentSectionProps) {
  const t = useT();

  // Read-only and silent on failure, like the Skill badge: a count that cannot
  // be computed is simply absent rather than an alert on a row the user has not
  // touched.
  const [agentCount, setAgentCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void api.agentIdentityCatalog()
      // The Roles the user defined — what the page's own empty state counts.
      // `entries` also holds `main` and the built-ins, so counting it made the
      // row read "4 agents" above a page saying "No agents yet".
      .then((view) => { if (active) setAgentCount(view.roles.length); })
      .catch(() => { /* no count */ });
    return () => { active = false; };
  }, []);

  // The active connection, said in the same words its own page and row use.
  const choices = settings ? buildProviderChoices(settings, '', new Map(
    (settings.availableProviders ?? []).map((provider) => [provider.providerId, provider]),
  )) : [];
  const activeChoice = choices.find((choice) => choice.active);
  const servicesValue = activeChoice
    ? `${formatProviderName(activeChoice.providerId)} · ${providerStatusSentence(resolveProviderStatus(activeChoice), t)}`
    : undefined;

  return (
    <section className="agent-settings-section" aria-label={t.settings.categories.agent.label}>
      <InsetGroup ariaLabel={t.settings.agent.capabilitiesAriaLabel} id="capabilities">
        <InsetRow
          drillsDown
          label={t.settings.pages.services}
          onSelect={() => onOpenPage('services')}
          sublabel={servicesValue ?? t.settings.agent.noServiceConnected}
        />
        <InsetRow
          drillsDown
          label={t.settings.pages.agents}
          onSelect={() => onOpenPage('agents')}
          sublabel={agentCount === null ? undefined : t.settings.agent.agentCount({ count: agentCount })}
        />
        <InsetRow
          badge={skillUpdateCount > 0 ? skillUpdateCount : undefined}
          badgeLabel={skillUpdateCount > 0 ? t.settings.skills.updatesAvailable({ count: skillUpdateCount }) : undefined}
          drillsDown
          label={t.settings.pages.skills}
          onSelect={() => onOpenPage('skills')}
          sublabel={t.settings.agent.skillCount({ count: skillCount })}
        />
      </InsetGroup>

      <SettingsDelegationGroup onChange={onDelegationChange} settings={settings} />

      <MemorySettingsGroup onError={onError} onNotice={onNotice} />

      <SettingsSecuritySection blockErrors={blockErrors} blocks={blocks} onRemoveBlock={onRemoveBlock} />
    </section>
  );
}
