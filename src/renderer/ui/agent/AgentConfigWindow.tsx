import { useEffect, useId, useState } from 'react';
import type {
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentProviderSettingsView,
  SkillDefinition,
} from '../../api/types';
import { agentMentionToken } from '../../../core/agentChannel';
import { agentConfigParamsFromSearch } from '../../../core/settingsWindow';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/FeedbackState';
import { WarningIcon, ICON_SIZE } from '../icons';
import { AgentEditor } from './AgentEditor';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';

const WORKSPACE_CONVERSATION_ID = 'workspace';

// Configures the one agent, the built-in Neva (the one-Neva invariant: no second
// agent can be created, so this window only ever edits an existing definition).
export function AgentConfigWindow() {
  const t = useT();
  const titleId = useId();
  const { agentId } = agentConfigParamsFromSearch(window.location.search);
  const [agents, setAgents] = useState<AgentDefinitionView[]>([]);
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => { void window.lin?.closeAgentConfig?.(); };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      api.agentListAllDefinitions(WORKSPACE_CONVERSATION_ID),
      api.agentListAllSkills(WORKSPACE_CONVERSATION_ID).catch(() => [] as SkillDefinition[]),
      api.agentGetProviderSettings().catch(() => null),
    ])
      .then(([nextAgents, nextSkills, nextProviders]) => {
        if (!active) return;
        setAgents(nextAgents);
        setSkills(nextSkills);
        setProviderSettings(nextProviders);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectedAgent = agentId ? agents.find((agent) => agent.agentId === agentId) ?? null : null;
  const titleAgentName = selectedAgent?.displayName || selectedAgent?.name || '';
  const windowTitle = selectedAgent
    ? t.settings.agents.editTitle({ name: titleAgentName })
    : t.window.agentConfigTitle;
  const windowSubtitle = selectedAgent?.description || `@${agentMentionToken(agentId)}`;

  function updateAgent(targetAgentId: string, input: AgentAuthoringInput) {
    setBusy(true);
    setError(null);
    api.agentUpdateAgentDefinition(WORKSPACE_CONVERSATION_ID, targetAgentId, input)
      .then(async () => {
        await window.lin?.notifySettingsChanged?.();
        close();
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusy(false));
  }

  return (
    <main className="provider-config-window agent-config-window" aria-busy={loading ? 'true' : undefined} aria-labelledby={titleId}>
      <header className="settings-sheet-head agent-config-head">
        <span className="settings-sheet-avatar">
          <AgentIdentityAvatar
            label={titleAgentName || t.window.agentConfigTitle}
            mention={agentId ? agentMentionToken(agentId) : null}
            size="md"
          />
        </span>
        <span className="settings-sheet-head-text">
          <h1 className="settings-sheet-title" id={titleId}>{windowTitle}</h1>
          <p className="settings-sheet-subtitle">{windowSubtitle}</p>
        </span>
      </header>

      {loading ? (
        <AgentConfigLoadingBody onCancel={close} />
      ) : !selectedAgent ? (
        <EmptyState className="agent-settings-empty" title={t.settings.agents.profileNotFound} />
      ) : (
        <AgentEditor
          key={selectedAgent.agentId}
          agent={selectedAgent}
          availableSkills={skills}
          providerSettings={providerSettings}
          busy={busy}
          onUpdate={updateAgent}
          onCancel={close}
        />
      )}

      {error ? (
        <div className="agent-settings-alert" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{error}</span>
        </div>
      ) : null}
    </main>
  );
}

function AgentConfigLoadingBody({ onCancel }: { onCancel: () => void }) {
  const messages = useT();
  const t = messages.settings.agents;

  return (
    <div className="agent-editor agent-editor-loading" aria-busy="true">
      <header className="agent-editor-header" aria-hidden="true">
        <span className="agent-profile-title">{messages.common.loading}</span>
      </header>

      <div className="inset-card agent-editor-fields" role="group">
        <div className="settings-sheet-row">
          <span className="settings-sheet-row-label">{t.nameLabel}</span>
          <span className="settings-sheet-row-input settings-sheet-placeholder">{messages.common.loading}</span>
        </div>
        <div className="settings-sheet-row">
          <span className="settings-sheet-row-label">{t.descriptionLabel}</span>
          <span className="settings-sheet-row-input settings-sheet-placeholder">{messages.common.loading}</span>
        </div>
        <div className="settings-sheet-row">
          <span className="settings-sheet-row-label">{t.providerOverride}</span>
          <span className="settings-sheet-row-input settings-sheet-placeholder">{messages.common.loading}</span>
        </div>
        <div className="settings-sheet-row">
          <span className="settings-sheet-row-label">{t.thinkingLevel}</span>
          <span className="settings-sheet-row-input settings-sheet-placeholder">{messages.common.loading}</span>
        </div>
      </div>

      <div className="agent-editor-actions">
        <span />
        <span className="agent-editor-actions-right">
          <Button onClick={onCancel} variant="ghost">
            {messages.dialog.cancel}
          </Button>
          <Button disabled variant="primary">
            {t.saveAgent}
          </Button>
        </span>
      </div>
    </div>
  );
}
