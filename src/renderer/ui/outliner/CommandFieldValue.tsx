import { useCallback, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import { requestRevealAgentConversation } from '../../agent/agentReveal';
import { PlayIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';

export interface CommandFieldLabels {
  runNow: string;
}

// Drives an attended "run now": 1) ensure the delivery conversation exists on
// disk, 2) reveal + select it (loads the single in-memory conversation) and AWAIT
// that so the run never recreates the conversation mid-flight, then 3) run it.
// The run surfaces through the conversation's ordinary agent run/task surfaces,
// so failures that reach the conversation show there — nothing is reflected on
// the Run button. `running` drives ONLY the command bullet's processing spinner
// (the running indicator lives at the bullet, per the design); a ref guards
// re-entry so a second click while in flight is a no-op.
export function useCommandRun(nodeId: NodeId): { running: boolean; run: () => void } {
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const run = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    void (async () => {
      try {
        const { conversationId } = await api.ensureCommandConversation(nodeId);
        await requestRevealAgentConversation(conversationId);
        await api.runCommandNow(nodeId);
      } catch {
        // Surfaced inline in the revealed conversation; the button shows no state.
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    })();
  }, [nodeId]);
  return { running, run };
}

// The Run action at the start of a command node's title: a labelled button with a
// background (a text action button, not an icon-only chrome control), aligned with
// the title text. The running state is shown ONLY on the command bullet (its
// spinner), never on this button.
export function CommandRunButton(props: { labels: CommandFieldLabels; onRun: () => void }) {
  const { labels, onRun } = props;
  return (
    <ButtonControl
      className="command-title-run"
      title={labels.runNow}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRun(); }}
    >
      <span className="command-title-run-chip">
        <PlayIcon size={12} />
        <span className="command-title-run-label">{labels.runNow}</span>
      </span>
    </ButtonControl>
  );
}
