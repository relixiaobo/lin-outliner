import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { AgentConversationListMeta, AgentDefinitionView } from '../../api/types';
import { agentMentionToken } from '../../../core/agentChannel';
import { channelConfigParamsFromSearch } from '../../../core/settingsWindow';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { CheckboxControl } from '../primitives/CheckboxControl';
import { EmptyState } from '../primitives/FeedbackState';
import { Field } from '../primitives/Field';
import { Input } from '../primitives/Input';
import { Textarea } from '../primitives/Textarea';
import { HashIcon, ICON_SIZE, LoaderIcon, WarningIcon } from '../icons';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';

const WORKSPACE_CONVERSATION_ID = 'workspace';
const RUNTIME_UNTITLED_SENTINEL = 'Untitled';

export function ChannelConfigWindow() {
  const t = useT();
  const titleId = useId();
  const { conversationId, mode } = channelConfigParamsFromSearch(window.location.search);
  const [conversations, setConversations] = useState<AgentConversationListMeta[]>([]);
  const [agents, setAgents] = useState<AgentDefinitionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingAgentId, setAddingAgentId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [seedText, setSeedText] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const close = () => { void window.lin?.closeChannelConfig?.(); };

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [nextConversations, nextAgents] = await Promise.all([
        api.agentListConversations(),
        api.agentListAllDefinitions(WORKSPACE_CONVERSATION_ID),
      ]);
      setConversations(nextConversations);
      setAgents(nextAgents);
      if (mode === 'configure') {
        const current = nextConversations.find((conversation) => conversation.id === conversationId);
        setTitle(readableConversationTitle(current?.title, t.common.untitled));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
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

  const conversation = mode === 'configure'
    ? conversations.find((candidate) => candidate.id === conversationId) ?? null
    : null;
  const agentById = useMemo(() => {
    const map = new Map<string, AgentDefinitionView>();
    for (const agent of agents) map.set(agent.agentId, agent);
    return map;
  }, [agents]);
  const memberAgentIds = useMemo(
    () => new Set(conversation?.members.flatMap((member) => member.type === 'agent' ? [member.agentId] : []) ?? []),
    [conversation],
  );
  const builtInCoordinatorAgentId = useMemo(
    () => agents.find((agent) => agent.source === 'built-in' && agent.name === 'assistant')?.agentId ?? null,
    [agents],
  );
  const memberAgents = useMemo(
    () => Array.from(memberAgentIds).map((agentId) => ({
      agentId,
      label: agentLabel(
        agentById.get(agentId),
        agentId,
        readableConversationTitle(
          conversations.find((candidate) => candidate.canonicalDmAgentId === agentId)?.title,
          '',
        ),
      ),
      mention: agentMentionToken(agentId),
    })),
    [agentById, conversations, memberAgentIds],
  );
  const addableAgents = useMemo(
    () => agents.filter((agent) => agent.agentId !== builtInCoordinatorAgentId && !memberAgentIds.has(agent.agentId)),
    [agents, builtInCoordinatorAgentId, memberAgentIds],
  );

  function toggleSelectedAgent(agentId: string) {
    setSelectedAgentIds((current) => (
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId]
    ));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError(t.agent.chat.channelNameRequired);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let createdConversationId: string | null = null;
      if (mode === 'create') {
        const created = await api.agentCreateConversation({
          title: trimmed,
          ...(selectedAgentIds.length > 0 ? { agentIds: selectedAgentIds } : {}),
          ...(seedText.trim() ? { seedText: seedText.trim() } : {}),
        });
        createdConversationId = created.conversationId;
      } else {
        await api.agentRenameConversation(conversationId, trimmed);
      }
      await window.lin?.notifySettingsChanged?.();
      if (createdConversationId) await window.lin?.agentNavigateToConversation?.(createdConversationId);
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function addMember(agentId: string) {
    setAddingAgentId(agentId);
    setError(null);
    try {
      await api.agentAddConversationMember(conversationId, agentId);
      await window.lin?.notifySettingsChanged?.();
      setConversations(await api.agentListConversations());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAddingAgentId(null);
    }
  }

  const windowTitle = mode === 'create' ? t.agent.chat.newConversation : t.agent.chat.channelSettings;

  return (
    <main className="provider-config-window channel-config-window" aria-labelledby={titleId}>
      <header className="settings-sheet-head">
        <span className="settings-sheet-avatar" aria-hidden="true">
          <span className="settings-sheet-icon-avatar">
            <HashIcon size={ICON_SIZE.toolbar} />
          </span>
        </span>
        <span className="settings-sheet-head-text">
          <h1 className="settings-sheet-title" id={titleId}>{windowTitle}</h1>
          <p className="settings-sheet-subtitle">
            {mode === 'create' ? t.agent.chat.createChannel : t.agent.chat.addChannelMembers}
          </p>
        </span>
      </header>

      {loading ? (
        <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" title={t.common.loading} />
      ) : mode === 'configure' && !conversation ? (
        <EmptyState className="agent-settings-empty" title={t.agent.chat.noConversations} />
      ) : (
        <form className="channel-config-form" onSubmit={(event) => void submit(event)}>
          <div className="settings-sheet-body">
            <div className="inset-card" role="group">
              <Field as="label" className="settings-sheet-row" label={t.agent.chat.channelName} labelClassName="settings-sheet-row-label">
                <Input
                  className="settings-sheet-row-input"
                  label={t.agent.chat.channelName}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t.agent.chat.channelNamePlaceholder}
                  value={title}
                  variant="bare"
                />
              </Field>
              {mode === 'create' ? (
                <Field as="label" className="settings-sheet-row settings-sheet-row-stack" label={t.agent.chat.channelSeed} labelClassName="settings-sheet-row-label">
                  <Textarea
                    className="settings-sheet-row-input channel-config-seed"
                    label={t.agent.chat.channelSeed}
                    onChange={(event) => setSeedText(event.target.value)}
                    placeholder={t.agent.chat.channelSeedPlaceholder}
                    rows={3}
                    value={seedText}
                    variant="bare"
                  />
                </Field>
              ) : null}
            </div>

            {mode === 'configure' ? (
              <InsetGroup ariaLabel={t.agent.chat.channelMembers} label={t.agent.chat.channelMembers}>
                {memberAgents.length === 0 ? (
                  <InsetRow disabled label={t.agent.chat.noAddableAgents} />
                ) : memberAgents.map((agent) => (
                  <InsetRow
                    key={agent.agentId}
                    leading={<AgentIdentityAvatar label={agent.label} mention={agent.mention} size="sm" />}
                    label={agent.label}
                    sublabel={`@${agent.mention}`}
                  />
                ))}
              </InsetGroup>
            ) : null}

            <InsetGroup
              ariaLabel={mode === 'create' ? t.agent.chat.channelAgents : t.agent.chat.addChannelMembers}
              label={mode === 'create' ? t.agent.chat.channelAgents : t.agent.chat.addChannelMembers}
            >
              {addableAgents.length === 0 ? (
                <InsetRow disabled label={t.agent.chat.noAddableAgents} />
              ) : addableAgents.map((agent) => {
                const label = agentLabel(agent, agent.agentId);
                const mention = agentMentionToken(agent.agentId);
                const checked = selectedAgentIds.includes(agent.agentId);
                return mode === 'create' ? (
                  <InsetRow
                    key={agent.agentId}
                    leading={<AgentIdentityAvatar label={label} mention={mention} size="sm" />}
                    label={label}
                    onSelect={() => toggleSelectedAgent(agent.agentId)}
                    sublabel={`@${mention}`}
                    trailing={(
                      <CheckboxControl
                        aria-label={t.agent.chat.addAgentMember({ name: label })}
                        checked={checked}
                        className="agent-settings-checkbox channel-config-member-checkbox"
                        onCheckedChange={() => toggleSelectedAgent(agent.agentId)}
                      >
                        <span className="channel-config-member-checkbox-label">{label}</span>
                      </CheckboxControl>
                    )}
                  />
                ) : (
                  <InsetRow
                    key={agent.agentId}
                    leading={<AgentIdentityAvatar label={label} mention={mention} size="sm" />}
                    label={label}
                    sublabel={`@${mention}`}
                    trailing={(
                      <Button
                        disabled={addingAgentId !== null}
                        onClick={() => void addMember(agent.agentId)}
                        size="sm"
                        variant="secondary"
                      >
                        {addingAgentId === agent.agentId ? t.common.loading : t.agent.chat.addAgentMember({ name: label })}
                      </Button>
                    )}
                    wrap
                  />
                );
              })}
            </InsetGroup>

            {error ? (
              <div className="agent-settings-alert" role="alert">
                <WarningIcon size={ICON_SIZE.menu} />
                <span>{error}</span>
              </div>
            ) : null}
          </div>

          <div className="settings-sheet-actions">
            <div className="settings-sheet-actions-left" />
            <div className="settings-sheet-actions-right">
              <Button onClick={close} variant="ghost">
                {t.agent.chat.cancel}
              </Button>
              <Button disabled={!title.trim() || saving} type="submit" variant="primary">
                {saving ? t.common.loading : (mode === 'create' ? t.agent.chat.createChannel : t.agent.chat.saveChannelName)}
              </Button>
            </div>
          </div>
        </form>
      )}
    </main>
  );
}

function readableConversationTitle(title: string | null | undefined, fallback: string): string {
  const readable = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!readable || readable === RUNTIME_UNTITLED_SENTINEL) return fallback;
  return readable;
}

function agentLabel(agent: AgentDefinitionView | undefined, agentId: string, fallback = ''): string {
  return agent?.displayName?.trim() || agent?.name || fallback || `@${agentMentionToken(agentId)}`;
}
