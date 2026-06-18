import { useEffect, useId, useState } from 'react';
import type {
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentProviderSettingsView,
  AgentStorageLocation,
  SkillDefinition,
} from '../../api/types';
import { agentMentionToken } from '../../../core/agentChannel';
import { agentConfigParamsFromSearch } from '../../../core/settingsWindow';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { EmptyState } from '../primitives/FeedbackState';
import { WarningIcon, ICON_SIZE, LoaderIcon } from '../icons';
import { AgentEditor } from './AgentEditor';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';

const WORKSPACE_CONVERSATION_ID = 'workspace';

export function AgentConfigWindow() {
  const t = useT();
  const titleId = useId();
  const { agentId, mode } = agentConfigParamsFromSearch(window.location.search);
  const [agents, setAgents] = useState<AgentDefinitionView[]>([]);
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteAgent, setPendingDeleteAgent] = useState<AgentDefinitionView | null>(null);

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
      if (event.key === 'Escape' && !pendingDeleteAgent) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingDeleteAgent]);

  const selectedAgent = mode === 'configure' && agentId
    ? agents.find((agent) => agent.agentId === agentId) ?? null
    : null;
  const titleAgentName = selectedAgent?.displayName || selectedAgent?.name || '';
  const windowTitle = mode === 'create'
    ? t.settings.agents.createTitle
    : selectedAgent
      ? t.settings.agents.editTitle({ name: titleAgentName })
      : t.window.agentConfigTitle;
  const windowSubtitle = mode === 'create'
    ? t.settings.categories.agents.label
    : selectedAgent?.description || `@${agentMentionToken(agentId)}`;

  async function runAgentMutation(action: () => Promise<AgentDefinitionView[]>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await window.lin?.notifySettingsChanged?.();
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function createAgent(input: AgentAuthoringInput, storage: AgentStorageLocation) {
    void runAgentMutation(() => api.agentCreateAgentDefinition(WORKSPACE_CONVERSATION_ID, input, storage));
  }

  function updateAgent(targetAgentId: string, input: AgentAuthoringInput) {
    void runAgentMutation(() => api.agentUpdateAgentDefinition(WORKSPACE_CONVERSATION_ID, targetAgentId, input));
  }

  function deleteAgent(agent: AgentDefinitionView) {
    setPendingDeleteAgent(agent);
  }

  function confirmDeleteAgent() {
    const target = pendingDeleteAgent;
    setPendingDeleteAgent(null);
    if (!target) return;
    void runAgentMutation(() => api.agentDeleteAgentDefinition(WORKSPACE_CONVERSATION_ID, target.agentId));
  }

  function duplicateAgent(agent: AgentDefinitionView) {
    const newName = `${agent.displayName || agent.name}-copy`;
    void runAgentMutation(() => (
      api.agentDuplicateAgentDefinition(WORKSPACE_CONVERSATION_ID, agent.agentId, newName, 'user')
    ));
  }

  return (
    <main className="provider-config-window agent-config-window" aria-labelledby={titleId}>
      <header className="settings-sheet-head agent-config-head">
        <span className="settings-sheet-avatar">
          <AgentIdentityAvatar
            label={titleAgentName || t.settings.agents.createTitle}
            mention={mode === 'configure' && agentId ? agentMentionToken(agentId) : null}
            size="md"
          />
        </span>
        <span className="settings-sheet-head-text">
          <h1 className="settings-sheet-title" id={titleId}>{windowTitle}</h1>
          <p className="settings-sheet-subtitle">{windowSubtitle}</p>
        </span>
      </header>

      {loading ? (
        <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" title={t.common.loading} />
      ) : mode === 'configure' && !selectedAgent ? (
        <EmptyState className="agent-settings-empty" title={t.settings.agents.profileNotFound} />
      ) : (
        <AgentEditor
          key={selectedAgent?.agentId ?? 'agent-create-new'}
          agent={mode === 'create' ? null : selectedAgent}
          availableSkills={skills}
          providerSettings={providerSettings}
          busy={busy}
          onCreate={createAgent}
          onUpdate={updateAgent}
          onDelete={deleteAgent}
          onDuplicate={duplicateAgent}
          onCancel={close}
        />
      )}

      {error ? (
        <div className="agent-settings-alert" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{error}</span>
        </div>
      ) : null}

      {pendingDeleteAgent ? (
        <ConfirmDialog
          danger
          title={t.settings.agents.deleteConfirm({ name: pendingDeleteAgent.displayName || pendingDeleteAgent.name })}
          confirmLabel={t.settings.agents.deleteAgent}
          cancelLabel={t.dialog.cancel}
          onConfirm={confirmDeleteAgent}
          onCancel={() => setPendingDeleteAgent(null)}
        />
      ) : null}
    </main>
  );
}
