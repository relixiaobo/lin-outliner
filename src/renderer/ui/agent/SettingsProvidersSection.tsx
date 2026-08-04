import { memo, useMemo, useRef, useState } from 'react';
import type { AgentProviderOption, AgentProviderSettingsView } from '../../api/types';
import { api } from '../../api/client';
import { AddIcon, ICON_SIZE } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { ProviderAvatar, formatProviderName } from './providerCatalog';
import { SettingsRowMenu, type RowMenuAction } from './SettingsRowMenu';
import {
  buildImageModelMenu,
  buildProviderChoices,
  type ProviderChoice,
  type ProviderRowHandlers,
} from './settingsProviderModel';
import { providerStatusSentence, resolveProviderStatus } from './providerStatus';

// A single provider row in the inset grouped list. Configured rows expose an
// enable switch plus details/removal actions. Unconfigured catalog rows usually
// open the config sheet, except detected external providers such as CC Switch:
// those are already configured by their own app, so the row is a direct enable
// switch that materializes Tenon's connection.
const SettingsProviderRow = memo(function SettingsProviderRow({
  provider,
  menuOpen,
  handlers,
}: {
  provider: ProviderChoice;
  menuOpen: boolean;
  handlers: ProviderRowHandlers;
}) {
  const t = useT();
  const name = formatProviderName(provider.providerId);
  const quickEnable = !provider.configured && provider.quickEnable;
  const actions: RowMenuAction[] = [];
  if (provider.configured && provider.enabled && provider.hasCredential && !provider.active) {
    actions.push({ label: t.settings.providers.setActive, onSelect: () => handlers.onActivate(provider.providerId) });
  }
  if (provider.canRefreshModels) {
    actions.push({ label: t.settings.providers.refreshModels, onSelect: () => handlers.onRefreshModels(provider.providerId) });
  }
  if (!quickEnable) {
    actions.push({ label: t.settings.providers.configureAction, onSelect: () => handlers.onConfigure(provider.providerId) });
  }
  if (provider.configured) {
    actions.push({ label: t.settings.providers.removeProvider, danger: true, onSelect: () => handlers.onRemove(provider.providerId) });
  }
  const trailing = provider.configured ? (
    <div className="settings-provider-row-actions">
      <SwitchControl
        checked={provider.enabled}
        label={t.settings.providers.enabledToggleNamed({ name })}
        onCheckedChange={(enabled) => handlers.onToggleEnabled(provider.providerId, enabled)}
      >
        <SwitchMark checked={provider.enabled} />
      </SwitchControl>
      <SettingsRowMenu
        actions={actions}
        ariaLabel={t.settings.providers.rowActionsAriaLabel({ name })}
        onOpenChange={(open) => handlers.onMenuOpenChange(provider.providerId, open)}
        open={menuOpen}
      />
    </div>
  ) : quickEnable ? (
    <SwitchControl
      checked={false}
      label={t.settings.providers.enabledToggleNamed({ name })}
      onCheckedChange={(enabled) => handlers.onToggleEnabled(provider.providerId, enabled)}
    >
      <SwitchMark checked={false} />
    </SwitchControl>
  ) : actions.length > 1 ? (
    <SettingsRowMenu
      actions={actions}
      ariaLabel={t.settings.providers.rowActionsAriaLabel({ name })}
      onOpenChange={(open) => handlers.onMenuOpenChange(provider.providerId, open)}
      open={menuOpen}
    />
  ) : (
    <Button
      aria-label={t.settings.providers.configureNamed({ name })}
      className="settings-provider-configure"
      onClick={() => handlers.onConfigure(provider.providerId)}
      size="sm"
      variant="secondary"
    >
      {t.settings.providers.configure}
    </Button>
  );
  const status = resolveProviderStatus(provider);
  const statusSentence = providerStatusSentence(status, t);
  // The row states its status only when the status is worth stating. Labelling
  // every healthy row "Ready" is noise that buries the two rows that need the
  // user — and until now the list said nothing at all, so which connection was
  // Active was visible in the detail window and nowhere else. A provider-supplied
  // explanation wins when there is one: "CC Switch has no direct-runnable
  // registry provider" tells the user more than "Unavailable" does.
  const unremarkable = status.state === 'ready' && !status.uncheckable;
  return (
    <InsetRow
      ariaLabel={t.settings.providers.rowAriaLabel({ name, status: statusSentence })}
      dimmed={(provider.configured || quickEnable) && !provider.enabled}
      label={name}
      leading={<ProviderAvatar providerId={provider.providerId} />}
      onSelect={quickEnable
        ? () => handlers.onToggleEnabled(provider.providerId, true)
        : () => handlers.onConfigure(provider.providerId)}
      sublabel={provider.connectionStatusMessage ?? (unremarkable ? undefined : statusSentence)}
      trailing={trailing}
    />
  );
});

interface SettingsProvidersSectionProps {
  settings: AgentProviderSettingsView | null;
  draftProviderId: string;
  saving: boolean;
  /**
   * The shared mutation envelope. Provider rows commit through the parent because
   * a provider mutation writes the settings, drafts, saving flag, and
   * error/notice surface the whole page shares.
   */
  runProviderMutation: (
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial?: boolean,
  ) => void;
}

/**
 * The Providers category — the reference pane for the settings idiom (flat base
 * plus grouped inset cards). It owns only its own row-menu state; everything it
 * mutates goes through the parent's envelope.
 */
export function SettingsProvidersSection({
  settings,
  draftProviderId,
  saving,
  runProviderMutation,
}: SettingsProvidersSectionProps) {
  const t = useT();
  // The per-row ⋯ actions menu (only one open at a time, keyed by providerId). The
  // per-provider config opens in its own native window, not an in-renderer sheet.
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);

  const providerCatalog = useMemo(() => {
    const catalog = new Map<string, AgentProviderOption>();
    for (const provider of settings?.availableProviders ?? []) {
      catalog.set(provider.providerId, provider);
    }
    return catalog;
  }, [settings]);

  const providerChoices = useMemo(
    () => settings ? buildProviderChoices(settings, draftProviderId, providerCatalog) : [],
    [draftProviderId, providerCatalog, settings],
  );
  // Grouped inset list: "Configured" = a provider row Tenon owns or an external
  // provider already configured by its own app; "Add Providers" = catalog
  // rows that still need Tenon's config window.
  const configuredChoices = useMemo(
    () => providerChoices.filter((choice) => choice.configured || choice.quickEnable),
    [providerChoices],
  );
  const availableChoices = useMemo(
    () => providerChoices.filter((choice) => !choice.configured && !choice.quickEnable),
    [providerChoices],
  );
  const imageModelMenu = useMemo(
    () => settings ? buildImageModelMenu(settings, providerCatalog) : { groups: [], defaultUnavailable: false },
    [providerCatalog, settings],
  );

  // Custom (OpenAI-compatible) providers are configured in the same native window,
  // in 'custom' mode (the window enters the provider id + model itself).
  function startCustomProvider() {
    void window.lin?.openProviderConfig?.({ providerId: '', mode: 'custom' });
  }

  function activateProvider(providerId: string) {
    runProviderMutation(() => api.agentSetActiveProvider(providerId), t.settings.providers.setActiveNotice);
  }

  function refreshProviderModels(providerId: string) {
    runProviderMutation(() => api.agentRefreshProviderModels(providerId), t.settings.providers.modelsRefreshedNotice);
  }

  function changeDefaultImageModel(defaultModel: string) {
    runProviderMutation(
      () => api.agentUpdateImageGenerationSettings({ defaultModel: defaultModel || null }),
      t.settings.providers.defaultImageModelSavedNotice,
    );
  }

  function toggleProviderEnabled(providerId: string, enabled: boolean) {
    const provider = settings?.providers.find((candidate) => candidate.providerId === providerId);
    const catalogEntry = providerCatalog.get(providerId);
    if (!provider && !enabled) return;
    if (!provider && !catalogEntry?.defaultBaseUrl) {
      void window.lin?.openProviderConfig?.({ providerId, mode: 'configure' });
      return;
    }
    const notice = enabled ? t.settings.providers.enabledNotice : t.settings.providers.disabledNotice;
    runProviderMutation(
      () => api.agentUpsertProviderConfig({
        providerId,
        baseUrl: provider?.baseUrl ?? catalogEntry?.defaultBaseUrl ?? null,
        enabled,
      }),
      notice,
    );
  }

  function deleteProviderFor(providerId: string) {
    runProviderMutation(() => api.agentDeleteProviderConfig(providerId), t.settings.providers.removedNotice, true);
  }

  // Open the per-provider config in its OWN native window (a modal child of
  // settings — the macOS idiom), not an in-renderer overlay. Clicking a row or
  // "Configure…" asks the main process to open it; the window commits via IPC and
  // broadcasts a settings-changed, which refetches the list.
  function openProviderConfig(providerId: string) {
    void window.lin?.openProviderConfig?.({ providerId, mode: 'configure' });
  }

  // Stable per-row handlers via a latest-ref so the memoized provider rows keep a
  // constant identity and never re-render while another row's menu toggles. The ref
  // always points at the freshest closures (no stale reads).
  const rowHandlersImpl = { openProviderConfig, activateProvider, refreshProviderModels, toggleProviderEnabled, deleteProviderFor, setOpenRowMenu };
  const rowHandlersRef = useRef(rowHandlersImpl);
  rowHandlersRef.current = rowHandlersImpl;
  const rowHandlers = useMemo<ProviderRowHandlers>(() => ({
    onConfigure: (id) => rowHandlersRef.current.openProviderConfig(id),
    onActivate: (id) => rowHandlersRef.current.activateProvider(id),
    onRefreshModels: (id) => rowHandlersRef.current.refreshProviderModels(id),
    onToggleEnabled: (id, enabled) => rowHandlersRef.current.toggleProviderEnabled(id, enabled),
    onRemove: (id) => rowHandlersRef.current.deleteProviderFor(id),
    onMenuOpenChange: (id, open) => rowHandlersRef.current.setOpenRowMenu(open ? id : null),
  }), []);

  const renderProviderRow = (provider: ProviderChoice) => (
    <SettingsProviderRow
      handlers={rowHandlers}
      key={provider.providerId}
      menuOpen={openRowMenu === provider.providerId}
      provider={provider}
    />
  );

  return (
    <section className="agent-settings-section settings-providers-section" aria-label={t.settings.categories.providers.label}>
      {/* Providers is the reference pane: flat base + grouped inset cards.
          The other panes were migrated onto this idiom. */}
      {/* No "Providers" title — the selected rail category already names
          the pane. Custom providers are added from the last row of the
          add-provider list (no separate floating add control). */}
      <div className="settings-provider-groups">
        <InsetGroup
          ariaLabel={t.settings.providers.imageGenerationAriaLabel}
          label={t.settings.providers.imageGenerationGroup}
        >
          <InsetRow
            label={t.settings.providers.defaultImageModelLabel}
            sublabel={imageModelMenu.defaultUnavailable
              ? t.settings.providers.defaultImageModelUnavailable
              : t.settings.providers.defaultImageModelSublabel}
            trailing={(
              <SelectControl
                className="settings-image-model-select"
                disabled={saving}
                label={t.settings.providers.defaultImageModelLabel}
                onChange={(event) => changeDefaultImageModel(event.target.value)}
                value={settings?.imageGeneration.defaultModel ?? ''}
                variant="popup"
              >
                <option value="">{t.settings.providers.imageModelAuto}</option>
                {imageModelMenu.defaultUnavailable && settings?.imageGeneration.defaultModel ? (
                  <option value={settings.imageGeneration.defaultModel}>
                    {t.settings.providers.imageModelUnavailableOption({ model: settings.imageGeneration.defaultModel })}
                  </option>
                ) : null}
                {imageModelMenu.groups.map((group) => (
                  <optgroup key={group.providerId} label={group.label}>
                    {group.models.map((model) => (
                      <option key={model.value} value={model.value}>{model.label}</option>
                    ))}
                  </optgroup>
                ))}
              </SelectControl>
            )}
            wrap
          />
        </InsetGroup>
        {configuredChoices.length > 0 ? (
          <InsetGroup ariaLabel={t.settings.providers.connectedAriaLabel} label={t.settings.providers.connectedGroup}>
            {configuredChoices.map(renderProviderRow)}
          </InsetGroup>
        ) : null}
        <InsetGroup ariaLabel={t.settings.providers.availableAriaLabel} label={t.settings.providers.availableGroup}>
          {availableChoices.map(renderProviderRow)}
          <InsetRow
            ariaLabel={t.settings.providers.addCustom}
            label={t.settings.providers.addCustom}
            leading={(
              <span className="settings-provider-add-leading" aria-hidden="true">
                <AddIcon size={ICON_SIZE.menu} />
              </span>
            )}
            onSelect={startCustomProvider}
          />
        </InsetGroup>
      </div>
    </section>
  );
}
