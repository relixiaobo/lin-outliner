import { useEffect, useId, useState, type FormEvent } from 'react';
import type { AgentConversationListMeta } from '../../api/types';
import {
  DEFAULT_DREAM_CHANNEL_ID,
  DEFAULT_GENERAL_CHANNEL_ID,
  channelIncludesInDreamData,
} from '../../../core/agentChannel';
import { channelConfigParamsFromSearch } from '../../../core/settingsWindow';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { CheckboxControl } from '../primitives/CheckboxControl';
import { EmptyState } from '../primitives/FeedbackState';
import { Field } from '../primitives/Field';
import { Input } from '../primitives/Input';
import { HashIcon, ICON_SIZE, WarningIcon } from '../icons';

const RUNTIME_UNTITLED_SENTINEL = 'Untitled';

/**
 * Single-agent collapse: a conversation has exactly {user, Neva}, so this window
 * is the remaining Channel settings surface. Primary create/rename now happens
 * inline from the dock, but this route can still edit the name and Dream setting.
 */
export function ChannelConfigWindow() {
  const t = useT();
  const titleId = useId();
  const { conversationId, mode } = channelConfigParamsFromSearch(window.location.search);
  const [conversations, setConversations] = useState<AgentConversationListMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [includeInDreamData, setIncludeInDreamData] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const close = () => { void window.lin?.closeChannelConfig?.(); };

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const nextConversations = await api.agentListConversations();
      setConversations(nextConversations);
      if (mode === 'configure') {
        const current = nextConversations.find((conversation) => conversation.id === conversationId);
        setTitle(readableConversationTitle(current?.title, t.common.untitled));
        setIncludeInDreamData(channelIncludesInDreamData(current?.id ?? '', current?.settings));
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
  const isProtectedDefault = conversation?.id === DEFAULT_GENERAL_CHANNEL_ID || conversation?.id === DEFAULT_DREAM_CHANNEL_ID;
  const canRename = mode === 'configure' && !!conversation && !isProtectedDefault;
  const canEditDreamData = mode === 'configure' && !!conversation && conversation.id !== DEFAULT_DREAM_CHANNEL_ID;
  const hasEditableSettings = !loading && (mode === 'create' || canRename || canEditDreamData);
  const saveDisabled = loading || !hasEditableSettings || saving;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!hasEditableSettings) return;
    setSaving(true);
    setError(null);
    try {
      let createdConversationId: string | null = null;
      if (mode === 'create') {
        const created = await api.agentCreateConversation(trimmed ? { title: trimmed } : {});
        createdConversationId = created.conversationId;
      } else {
        if (canRename) await api.agentRenameConversation(conversationId, trimmed);
        if (canEditDreamData) {
          await api.agentSetConversationIncludeInDreamData(conversationId, includeInDreamData);
        }
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

  const windowTitle = mode === 'create' ? t.agent.chat.newConversation : t.agent.chat.channelSettings;
  const windowSubtitle = mode === 'create' ? t.agent.chat.createChannel : t.agent.chat.channelSettings;

  return (
    <main className="provider-config-window channel-config-window" aria-busy={loading ? 'true' : undefined} aria-labelledby={titleId}>
      <header className="settings-sheet-head">
        <span className="settings-sheet-avatar" aria-hidden="true">
          <span className="settings-sheet-icon-avatar">
            <HashIcon size={ICON_SIZE.toolbar} />
          </span>
        </span>
        <span className="settings-sheet-head-text">
          <h1 className="settings-sheet-title" id={titleId}>{windowTitle}</h1>
          <p className="settings-sheet-subtitle">{windowSubtitle}</p>
        </span>
      </header>

      {mode === 'configure' && !loading && !conversation ? (
        <EmptyState className="agent-settings-empty" title={t.agent.chat.noConversations} />
      ) : (
        <form className="channel-config-form" aria-busy={loading ? 'true' : undefined} onSubmit={(event) => void submit(event)}>
          <div className="settings-sheet-body">
            <div className="inset-card" role="group">
              <Field as="label" className="settings-sheet-row" label={t.agent.chat.channelName} labelClassName="settings-sheet-row-label">
                <Input
                  className="settings-sheet-row-input"
                  disabled={loading || (mode === 'configure' && !canRename)}
                  label={t.agent.chat.channelName}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t.agent.chat.channelNamePlaceholder}
                  value={title}
                  variant="bare"
                />
              </Field>
              {mode === 'configure' ? (
                <div className="settings-sheet-row settings-sheet-row-switch">
                  <span className="settings-sheet-row-text">
                    <span className="settings-sheet-row-label">{t.agent.chat.includeInDreamData}</span>
                    <span className="agent-settings-notice">{t.agent.chat.includeInDreamDataSublabel}</span>
                  </span>
                  <CheckboxControl
                    checked={includeInDreamData}
                    className="agent-settings-checkbox"
                    disabled={loading || !canEditDreamData}
                    onCheckedChange={setIncludeInDreamData}
                  >
                    {includeInDreamData ? t.agent.chat.includedInDreamData : t.agent.chat.excludedFromDreamData}
                  </CheckboxControl>
                </div>
              ) : null}
            </div>

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
              <Button disabled={saveDisabled} type="submit" variant="primary">
                {saving ? t.common.loading : (mode === 'create' ? t.agent.chat.createChannel : t.agent.chat.saveChannelSettings)}
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
