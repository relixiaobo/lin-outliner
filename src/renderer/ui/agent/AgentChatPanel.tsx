import { useEffect, useRef } from 'react';
import { useLinAgentRuntime } from '../../agent/runtime';
import { AddIcon, ICON_SIZE, MoreIcon } from '../icons';
import { AgentComposer } from './AgentComposer';
import { AgentMessageRow } from './AgentMessageRow';

const SUGGESTED_PROMPTS = [
  '总结当前大纲',
  '规划 agent 接入阶段',
  '列出下一步工具设计',
];

function shouldStickToBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 56;
}

export function AgentChatPanel() {
  const {
    entries,
    isStreaming,
    reset,
    revision,
    sendMessage,
    stop,
    toolResults,
    turnPhase,
  } = useLinAgentRuntime();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [entries.length, isStreaming, revision]);

  return (
    <div className="agent-chat-panel" data-turn-phase={turnPhase}>
      <header className="agent-dock-header">
        <div className="agent-dock-title"># conversation</div>
        <div className="agent-dock-actions">
          <span className="agent-status-dot" aria-hidden="true" />
          <span className="agent-status-dot is-muted" aria-hidden="true" />
          <button
            aria-label="New conversation"
            className="agent-menu-button"
            disabled={isStreaming || entries.length === 0}
            onClick={reset}
            title="New conversation"
            type="button"
          >
            <AddIcon size={ICON_SIZE.toolbar} />
          </button>
          <button className="agent-menu-button" disabled title="Agent menu" type="button">
            <MoreIcon size={ICON_SIZE.toolbar} />
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="agent-chat-scroll"
        onScroll={(event) => {
          stickToBottomRef.current = shouldStickToBottom(event.currentTarget);
        }}
      >
        {entries.length === 0 ? (
          <div className="agent-empty-state">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                className="agent-suggestion"
                key={prompt}
                onClick={() => {
                  void sendMessage(prompt);
                }}
                type="button"
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : (
          entries.map((entry) => (
            <AgentMessageRow entry={entry} key={entry.id} toolResults={toolResults} />
          ))
        )}
      </div>

      <AgentComposer
        isStreaming={isStreaming}
        onSend={sendMessage}
        onStop={stop}
      />
    </div>
  );
}
