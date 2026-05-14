import { useEffect, useRef, useState } from 'react';
import { ICON_SIZE, SendIcon, StopIcon } from '../icons';

interface AgentComposerProps {
  isStreaming: boolean;
  onSend: (message: string) => Promise<void>;
  onStop: () => void;
}

export function AgentComposer({ isStreaming, onSend, onStop }: AgentComposerProps) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0 && !isStreaming && !submitting;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 34), 140)}px`;
  }, [value]);

  async function submit() {
    if (!canSend) return;
    const message = value.trim();
    setValue('');
    setSubmitting(true);
    try {
      await onSend(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label="Agent message"
        className="agent-composer-input"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Send message..."
        rows={1}
        value={value}
      />
      {isStreaming ? (
        <button
          aria-label="Stop agent"
          className="agent-composer-button"
          onClick={onStop}
          title="Stop"
          type="button"
        >
          <StopIcon size={ICON_SIZE.toolbar} />
        </button>
      ) : (
        <button
          aria-label="Send message"
          className="agent-composer-button"
          disabled={!canSend}
          title="Send"
          type="submit"
        >
          <SendIcon size={ICON_SIZE.toolbar} />
        </button>
      )}
    </form>
  );
}
