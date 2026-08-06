import type { AgentProviderSettingsView } from '../../api/types';
import type { SettingsPageTarget } from '../../../core/settingsWindow';
import { useT } from '../../i18n/I18nProvider';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { MemorySettingsGroup } from './MemorySettingsGroup';
import { SettingsSecuritySection } from './SettingsSecuritySection';
import { resolveProviderStatus, providerStatusSentence } from './providerStatus';
import { buildProviderChoices } from './settingsProviderModel';
import { formatProviderName } from './providerCatalog';

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
}: SettingsAgentSectionProps) {
  const t = useT();

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
          badge={skillUpdateCount > 0 ? skillUpdateCount : undefined}
          badgeLabel={skillUpdateCount > 0 ? t.settings.skills.updatesAvailable({ count: skillUpdateCount }) : undefined}
          drillsDown
          label={t.settings.pages.skills}
          onSelect={() => onOpenPage('skills')}
          sublabel={t.settings.agent.skillCount({ count: skillCount })}
        />
      </InsetGroup>

      <MemorySettingsGroup onError={onError} onNotice={onNotice} />

      <SettingsSecuritySection blockErrors={blockErrors} blocks={blocks} onRemoveBlock={onRemoveBlock} />
    </section>
  );
}
