import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AssistantMessage, ToolResultMessage } from '../../../core/agentTypes';
import type {
  AgentProviderConfigView,
  AgentProviderSettingsView,
  AgentReasoningLevel,
  AgentSessionMeta,
} from '../../api/types';
import { api } from '../../api/client';
import { useLinAgentRuntime } from '../../agent/runtime';
import type { AgentConversationEntry, AgentMessageEntry, AgentTurnPhase } from '../../agent/runtime';
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  DebugIcon,
  ICON_SIZE,
  NewConversationIcon,
  PencilIcon,
  SettingsIcon,
  TrashIcon,
  WarningIcon,
} from '../icons';
import { AgentComposer } from './AgentComposer';
import { AgentSettingsDialog } from './AgentSettingsDialog';
import { AgentMessageRow } from './AgentMessageRow';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { TextInputControl } from '../primitives/TextInputControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';

const SUGGESTED_PROMPTS = [
  '总结当前大纲',
  '规划 agent 接入阶段',
  '列出下一步工具设计',
];

interface AgentChatPanelProps {
  onOpenDebugPanel?: (sessionId: string | null) => void;
}

function shouldStickToBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 56;
}

function getActiveProvider(settings: AgentProviderSettingsView | null): AgentProviderConfigView | null {
  if (!settings) return null;
  const active = settings.activeProviderId
    ? settings.providers.find((provider) => provider.providerId === settings.activeProviderId && providerCanUseModels(settings, provider))
    : undefined;
  return active ?? settings.providers.find((provider) => providerCanUseModels(settings, provider)) ?? null;
}

function providerCanUseModels(settings: AgentProviderSettingsView, provider: AgentProviderConfigView): boolean {
  const catalog = settings.availableProviders.find((candidate) => candidate.providerId === provider.providerId);
  return provider.enabled && Boolean(provider.hasApiKey || provider.hasEnvApiKey || catalog?.hasEnvApiKey);
}

function getSupportedReasoningLevels(
  settings: AgentProviderSettingsView,
  providerId: string,
  modelId: string,
): AgentReasoningLevel[] {
  const catalog = settings.availableProviders.find((provider) => provider.providerId === providerId);
  const model = catalog?.models.find((candidate) => candidate.id === modelId);
  return model?.supportedThinkingLevels.length ? model.supportedThinkingLevels : ['off'];
}

function coerceReasoningLevel(
  reasoningLevel: AgentReasoningLevel,
  supportedLevels: AgentReasoningLevel[],
): AgentReasoningLevel {
  if (supportedLevels.includes(reasoningLevel)) return reasoningLevel;
  if (supportedLevels.includes('off')) return 'off';
  return supportedLevels[0] ?? 'off';
}

function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type AssistantEntry = AgentMessageEntry & { message: AssistantMessage };

function getEntryRole(entry: AgentConversationEntry): 'user' | 'assistant' {
  return entry.message.role;
}

function getEntryTimestamp(entry: AgentConversationEntry): number {
  return entry.message.timestamp;
}

function isAssistantEntry(entry: AgentConversationEntry): entry is AssistantEntry {
  return entry.message.role === 'assistant';
}

function mergeAssistantEntries(entries: AssistantEntry[]): AgentMessageEntry {
  const lastEntry = entries[entries.length - 1]!;
  return {
    ...lastEntry,
    message: {
      ...lastEntry.message,
      content: entries.flatMap((entry) => entry.message.content),
    },
  };
}

function toolResultCopyText(result: ToolResultMessage | undefined): string {
  if (!result) return '';
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function buildAssistantTurnCopyText(
  entries: AgentConversationEntry[],
  lastEntryIndex: number,
  toolResults: Map<string, ToolResultMessage>,
): string {
  let turnStart = lastEntryIndex;
  while (turnStart > 0) {
    const previous = entries[turnStart - 1]!;
    if (previous.message.role === 'user') break;
    turnStart -= 1;
  }

  const parts: string[] = [];
  for (let i = turnStart; i <= lastEntryIndex; i += 1) {
    const entry = entries[i]!;
    if (entry.message.role !== 'assistant') continue;

    for (const block of entry.message.content) {
      if (block.type === 'text') {
        const trimmed = block.text.trim();
        if (trimmed) parts.push(trimmed);
        continue;
      }
      if (block.type === 'toolCall') {
        parts.push(`\`\`\`tool ${block.name}\n${JSON.stringify(block.arguments ?? {}, null, 2)}\n\`\`\``);
        const resultText = toolResultCopyText(toolResults.get(block.id));
        if (resultText) {
          const tag = toolResults.get(block.id)?.isError ? 'tool-error' : 'tool-result';
          parts.push(`\`\`\`${tag}\n${resultText}\n\`\`\``);
        }
      }
    }
  }

  return parts.join('\n\n');
}

export function AgentChatPanel({ onOpenDebugPanel }: AgentChatPanelProps) {
  const {
    entries,
    error,
    isStreaming,
    clearFollowUp,
    editMessage,
    pendingToolCallIds,
    queueFollowUp,
    regenerateMessage,
    reloadSession,
    newSession,
    revision,
    retryMessage,
    selectSession,
    sendMessage,
    sessionId,
    sessionTitle,
    switchBranch,
    stop,
    toolResults,
    turnPhase,
  } = useLinAgentRuntime();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [steeringNote, setSteeringNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const mountedRef = useRef(false);
  const providerSettingsRequestRef = useRef(0);
  const sessionsRequestRef = useRef(0);

  const loadProviderSettings = useCallback(async () => {
    const requestId = providerSettingsRequestRef.current + 1;
    providerSettingsRequestRef.current = requestId;
    try {
      const next = await api.agentGetProviderSettings();
      if (!mountedRef.current || requestId !== providerSettingsRequestRef.current) return null;
      setProviderSettings(next);
      setSettingsError(null);
      return next;
    } catch (caught) {
      if (mountedRef.current && requestId === providerSettingsRequestRef.current) {
        setSettingsError(caught instanceof Error ? caught.message : String(caught));
      }
      return null;
    }
  }, []);

  const loadSessions = useCallback(async () => {
    const requestId = sessionsRequestRef.current + 1;
    sessionsRequestRef.current = requestId;
    setSessionsLoading(true);
    try {
      const next = await api.agentListSessions();
      if (!mountedRef.current || requestId !== sessionsRequestRef.current) return null;
      setSessions(next);
      return next;
    } catch (caught) {
      if (mountedRef.current && requestId === sessionsRequestRef.current) {
        setSettingsError(caught instanceof Error ? caught.message : String(caught));
      }
      return null;
    } finally {
      if (mountedRef.current && requestId === sessionsRequestRef.current) {
        setSessionsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [entries.length, isStreaming, revision]);

  useEffect(() => {
    mountedRef.current = true;
    void loadProviderSettings();
    return () => {
      mountedRef.current = false;
      providerSettingsRequestRef.current += 1;
      sessionsRequestRef.current += 1;
    };
  }, [loadProviderSettings]);

  useEffect(() => {
    if (!isStreaming) {
      setSteeringNote(null);
    }
  }, [isStreaming]);

  useEffect(() => {
    if (historyOpen) void loadSessions();
  }, [historyOpen, loadSessions]);

  useEffect(() => {
    if (!historyOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && headerRef.current?.contains(target)) return;
      if (target instanceof Node && historyMenuRef.current?.contains(target)) return;
      setHistoryOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [historyOpen]);

  async function updateProviderConfig(
    providerId: string,
    patch: { modelId?: string; reasoningLevel?: AgentReasoningLevel },
  ) {
    if (!providerSettings) return;
    const provider = providerSettings.providers.find((candidate) => candidate.providerId === providerId);
    const catalog = providerSettings.availableProviders.find((candidate) => candidate.providerId === providerId);
    const modelId = patch.modelId ?? provider?.modelId ?? catalog?.models[0]?.id;
    if (!modelId) return;
    const supportedLevels = getSupportedReasoningLevels(providerSettings, providerId, modelId);
    const reasoningLevel = coerceReasoningLevel(
      patch.reasoningLevel ?? provider?.reasoningLevel ?? 'off',
      supportedLevels,
    );
    const requestId = providerSettingsRequestRef.current + 1;
    providerSettingsRequestRef.current = requestId;
    try {
      setSettingsError(null);
      await api.agentUpsertProviderConfig({
        providerId,
        modelId,
        reasoningLevel,
        baseUrl: provider?.baseUrl ?? null,
        enabled: provider?.enabled ?? true,
      });
      const next = await api.agentSetActiveProvider(providerId);
      if (mountedRef.current && requestId === providerSettingsRequestRef.current) {
        setProviderSettings(next);
      }
      await reloadSession();
    } catch (caught) {
      if (mountedRef.current && requestId === providerSettingsRequestRef.current) {
        setSettingsError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  async function updateActiveProviderConfig(patch: { modelId?: string; reasoningLevel?: AgentReasoningLevel }) {
    if (!providerSettings) return;
    const activeProvider = getActiveProvider(providerSettings);
    const providerId = activeProvider?.providerId ?? providerSettings.availableProviders[0]?.providerId;
    if (!providerId) return;
    await updateProviderConfig(providerId, patch);
  }

  async function applySettingsDialogChanges() {
    await loadProviderSettings();
    await reloadSession();
  }

  async function handleSteerMessage(message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;
    const combined = steeringNote ? `${steeringNote}\n${trimmed}` : trimmed;
    setSteeringNote(combined);
    const queued = await queueFollowUp(combined);
    if (!queued) {
      setSteeringNote(null);
    }
  }

  async function handleCancelSteer() {
    setSteeringNote(null);
    await clearFollowUp();
  }

  async function handleNewSession() {
    setHistoryOpen(false);
    setEditingSessionId(null);
    await newSession();
    await loadSessions();
  }

  async function handleSelectSession(targetSessionId: string) {
    if (isStreaming || targetSessionId === sessionId) return;
    setHistoryOpen(false);
    setEditingSessionId(null);
    await selectSession(targetSessionId);
  }

  async function handleRenameSession(targetSessionId: string) {
    const trimmed = editingTitle.trim();
    if (!trimmed) return;
    await api.agentRenameSession(targetSessionId, trimmed);
    setEditingSessionId(null);
    await loadSessions();
  }

  async function handleDeleteSession(targetSessionId: string, title: string | null) {
    const label = title?.trim() || 'Untitled';
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
    await api.agentDeleteSession(targetSessionId);
    if (targetSessionId === sessionId) {
      await newSession();
      setHistoryOpen(false);
    }
    await loadSessions();
  }

  function renderConversationEntries(): ReactNode[] {
    const rendered: ReactNode[] = [];

    const turnEndedByEndIndex = new Map<number, boolean>();
    for (let i = 0; i < entries.length; i += 1) {
      let hasNextUserMessage = false;
      for (let j = i + 1; j < entries.length; j += 1) {
        const next = entries[j]!;
        if (next.message.role === 'user') {
          hasNextUserMessage = true;
          break;
        }
      }
      turnEndedByEndIndex.set(i, hasNextUserMessage || turnPhase === 'idle');
    }

    const renderEntry = (
      entry: AgentConversationEntry,
      startIndex: number,
      endIndex: number,
      key?: string,
      contentKey?: string,
    ) => {
      const isLastAssistantEntry = endIndex === entries.length - 1 && getEntryRole(entry) === 'assistant';
      const entryTurnPhase: AgentTurnPhase = isLastAssistantEntry ? turnPhase : 'idle';
      const streaming = isLastAssistantEntry && turnPhase === 'streaming_text';
      const isLastInTurn = endIndex === entries.length - 1
        || getEntryRole(entries[endIndex + 1]!) !== getEntryRole(entry);
      const copyAssistantTurn = isLastInTurn && getEntryRole(entry) === 'assistant'
        ? async () => {
            const text = buildAssistantTurnCopyText(entries, endIndex, toolResults);
            if (text) await navigator.clipboard.writeText(text);
          }
        : undefined;
      const entryKey = key
        ?? entry.nodeId
        ?? `${entry.kind}-${getEntryTimestamp(entry)}-${startIndex}`;

      rendered.push(
        <AgentMessageRow
          busy={isStreaming}
          contentKey={contentKey}
          entry={entry}
          isLastInTurn={isLastInTurn}
          key={entryKey}
          onCopy={copyAssistantTurn}
          onEdit={editMessage}
          onRegenerate={regenerateMessage}
          onRetry={retryMessage}
          onSwitchBranch={switchBranch}
          pendingToolCallIds={pendingToolCallIds}
          streaming={streaming}
          toolResults={toolResults}
          turnEnded={turnEndedByEndIndex.get(endIndex) ?? true}
          turnPhase={entryTurnPhase}
        />,
      );
    };

    let index = 0;
    while (index < entries.length) {
      const entry = entries[index]!;

      if (isAssistantEntry(entry)) {
        const runStart = index;
        const assistantEntries: AssistantEntry[] = [];
        while (index < entries.length) {
          const candidate = entries[index]!;
          if (!isAssistantEntry(candidate)) break;
          assistantEntries.push(candidate);
          index += 1;
        }

        const stableKey = `assistant-turn-${assistantEntries[0]!.id}`;
        const mergedEntry = assistantEntries.length >= 2
          ? mergeAssistantEntries(assistantEntries)
          : assistantEntries[0]!;
        renderEntry(mergedEntry, runStart, index - 1, stableKey, stableKey);
        continue;
      }

      renderEntry(entry, index, index);
      index += 1;
    }

    return rendered;
  }

  const visibleError = error ?? settingsError;
  const displayTitle = sessionTitle || 'conversation';
  const historyMenuStyle = useAnchoredOverlay(historyMenuRef, {
    anchorRef: historyButtonRef,
    disabled: !historyOpen,
    layoutKey: `${sessions.length}:${sessionsLoading ? 'loading' : 'ready'}`,
    maxHeight: 420,
    placement: 'bottom-start',
    width: 326,
  });

  return (
    <div className="agent-chat-panel" data-turn-phase={turnPhase}>
      <header className="agent-dock-header" ref={headerRef}>
        <ButtonControl
          ref={historyButtonRef}
          aria-expanded={historyOpen}
          aria-label="Show conversations"
          className="agent-dock-title-button"
          onClick={() => setHistoryOpen((open) => !open)}
          title="Show conversations"
        >
          <span className="agent-dock-title"># {displayTitle}</span>
          <ChevronDownIcon
            className={historyOpen ? 'agent-title-chevron is-open' : 'agent-title-chevron'}
            size={ICON_SIZE.menu}
          />
        </ButtonControl>
        <div className="agent-dock-actions">
          <IconButton
            className="agent-menu-button"
            disabled={isStreaming}
            icon={NewConversationIcon}
            label="New conversation"
            onClick={() => void handleNewSession()}
            title="New conversation"
            variant="composerTool"
          />
          <IconButton
            className="agent-menu-button"
            icon={DebugIcon}
            label="Open agent debug"
            onClick={() => onOpenDebugPanel?.(sessionId)}
            title="Open agent debug"
            variant="composerTool"
          />
          <IconButton
            className="agent-menu-button"
            icon={SettingsIcon}
            label="Agent settings"
            onClick={() => setSettingsOpen(true)}
            title="Agent settings"
            variant="composerTool"
          />
        </div>
        {historyOpen ? createPortal(
          <div
            ref={historyMenuRef}
            className="agent-session-menu"
            role="dialog"
            aria-label="Conversations"
            style={historyMenuStyle}
          >
            <div className="agent-session-menu-header">
              <span>Conversations</span>
              <IconButton
                className="agent-message-action-button"
                disabled={isStreaming}
                icon={NewConversationIcon}
                label="New conversation"
                onClick={() => void handleNewSession()}
                title="New conversation"
                variant="message"
              />
            </div>
            <div className="agent-session-list">
              {sessionsLoading ? (
                <div className="agent-session-empty">Loading...</div>
              ) : sessions.length === 0 ? (
                <div className="agent-session-empty">No conversations</div>
              ) : sessions.map((session) => {
                const isCurrent = session.id === sessionId;
                const title = session.title?.trim() || 'Untitled';
                if (editingSessionId === session.id) {
                  return (
                    <div className="agent-session-row is-editing" key={session.id}>
                      <TextInputControl
                        autoFocus
                        className="agent-session-title-input"
                        label="Conversation title"
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setEditingSessionId(null);
                          if (event.key === 'Enter') void handleRenameSession(session.id);
                        }}
                        value={editingTitle}
                      />
                      <IconButton
                        className="agent-message-action-button"
                        icon={CloseIcon}
                        label="Cancel rename"
                        onClick={() => setEditingSessionId(null)}
                        variant="message"
                      />
                      <IconButton
                        className="agent-message-action-button"
                        icon={CheckIcon}
                        label="Save rename"
                        onClick={() => void handleRenameSession(session.id)}
                        variant="message"
                      />
                    </div>
                  );
                }
                return (
                  <div
                    className={isCurrent ? 'agent-session-row is-current' : 'agent-session-row'}
                    key={session.id}
                  >
                    <ButtonControl
                      className="agent-session-select"
                      disabled={isStreaming}
                      onClick={() => void handleSelectSession(session.id)}
                    >
                      <span className="agent-session-name">{title}</span>
                      <span className="agent-session-meta">
                        {formatSessionTime(session.updatedAt)}
                        {session.messageCount > 0 ? ` · ${session.messageCount}` : ''}
                      </span>
                    </ButtonControl>
                    <div className="agent-session-row-actions">
                      <IconButton
                        className="agent-message-action-button"
                        disabled={isStreaming}
                        icon={PencilIcon}
                        label="Rename conversation"
                        onClick={() => {
                          setEditingSessionId(session.id);
                          setEditingTitle(title);
                        }}
                        title="Rename"
                        variant="message"
                      />
                      <IconButton
                        className="agent-message-action-button"
                        disabled={isStreaming}
                        icon={TrashIcon}
                        label="Delete conversation"
                        onClick={() => void handleDeleteSession(session.id, session.title)}
                        title="Delete"
                        variant="message"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        ) : null}
      </header>

      <div
        ref={scrollRef}
        className="agent-chat-scroll"
        onScroll={(event) => {
          stickToBottomRef.current = shouldStickToBottom(event.currentTarget);
        }}
      >
        {visibleError ? (
          <div className="agent-message-error" role="status">
            <WarningIcon size={14} />
            <span>{visibleError}</span>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="agent-empty-state">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <ButtonControl
                className="agent-suggestion"
                key={prompt}
                onClick={() => {
                  void sendMessage(prompt);
                }}
              >
                {prompt}
              </ButtonControl>
            ))}
          </div>
        ) : renderConversationEntries()}
      </div>

      <AgentComposer
        isStreaming={isStreaming}
        onModelChange={(providerId, modelId) => updateProviderConfig(providerId, { modelId })}
        onReasoningChange={(reasoningLevel) => updateActiveProviderConfig({ reasoningLevel })}
        onCancelSteer={handleCancelSteer}
        onSend={sendMessage}
        onStop={stop}
        onSteer={handleSteerMessage}
        settings={providerSettings}
        steeringNote={steeringNote}
      />
      <AgentSettingsDialog
        onApplied={applySettingsDialogChanges}
        onClose={() => setSettingsOpen(false)}
        open={settingsOpen}
      />
    </div>
  );
}
