import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadId } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { useDismissibleOverlay } from '../../ui/primitives/useDismissibleOverlay';
import { AgentIcon, GitBranchIcon, ICON_SIZE, LoaderIcon, StopIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { WorkingText } from '../../ui/primitives/WorkingText';
import type { SubagentRegistryEntry } from '../subagentPresentation';
import { subagentChipStatus } from './SubagentChip';
import { useSubagentActions } from './SubagentRegistryContext';
import { useSubagentElapsedMs } from './subagentElapsed';

/**
 * How long a settled Agent lingers in the strip before it leaves.
 *
 * Long enough that finishing is something the reader can see happen, short
 * enough that the strip never becomes an archive — the conversation is the
 * archive, and every Agent has an anchor there.
 */
export const SUBAGENT_STRIP_LINGER_MS = 8_000;

/**
 * The deck's only ambient status: one pill, present only while this
 * conversation has background work.
 *
 * Zero background Agents renders nothing at all, so the idle deck and the
 * everything-finished deck are the same deck. Foreground work never appears
 * here — it belongs to the Turn that is blocked on it, and saying it twice
 * would make the conversation look busier than it is.
 */
export function SubagentWorkStrip({
  byAgentId,
  now,
}: {
  readonly byAgentId: ReadonlyMap<ThreadId, SubagentRegistryEntry>;
  /** Injected in tests; the strip's own clock drives the fade otherwise. */
  readonly now?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const clock = useStripClock(byAgentId, now);
  const rows = useMemo(() => stripRows(byAgentId, clock), [byAgentId, clock]);
  const runningCount = rows.filter((entry) => entry.status === 'running' || entry.status === 'pendingInit').length;

  useEffect(() => {
    if (rows.length === 0) setOpen(false);
  }, [rows.length]);

  // Dismissible like every other overlay in the deck, through the same hook they
  // use: it floats over the transcript, so without this a click into the
  // conversation or the composer left it sitting on top of what the reader had
  // just gone back to.
  const strip = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissibleOverlay(strip, dismiss, { disabled: !open });

  if (rows.length === 0) return null;
  return (
    <div className="thread-work-strip" ref={strip}>
      <button
        aria-expanded={open}
        className="thread-work-strip-pill"
        onClick={() => setOpen((current) => !current)}
        title={t.agent.thread.agent.backgroundWork}
        type="button"
      >
        {runningCount > 0 ? (
          <LoaderIcon aria-hidden className="thread-work-strip-spinner" size={ICON_SIZE.tiny} />
        ) : (
          <AgentIcon aria-hidden size={ICON_SIZE.tiny} />
        )}
        <span>{runningCount > 0
          ? t.agent.thread.agent.running({ count: runningCount })
          : t.agent.thread.agent.justFinished}</span>
      </button>
      {open ? (
        <div className="thread-work-strip-list" role="group" aria-label={t.agent.thread.agent.backgroundWork}>
          {rows.map((entry) => <SubagentStripRow entry={entry} key={entry.agentId} />)}
        </div>
      ) : null}
    </div>
  );
}

function SubagentStripRow({ entry }: { readonly entry: SubagentRegistryEntry }) {
  const t = useT();
  const actions = useSubagentActions();
  const elapsedMs = useSubagentElapsedMs(entry);
  const running = entry.status === 'running' || entry.status === 'pendingInit';
  const status = running
    ? subagentChipStatus(entry, elapsedMs, false, t, true)
    : entry.stoppedByUser
      ? t.agent.thread.agent.stopped
      : t.agent.thread.agent.justFinished;
  return (
    <div className={`thread-work-strip-row thread-subagent-${entry.status}`}>
      <button
        aria-label={`${t.agent.thread.agent.openAgent({ name: entry.displayName })}. ${status}`}
        className="thread-work-strip-open"
        onClick={() => actions.openAgent(entry.agentId)}
        title={`${entry.displayName} · ${status}`}
        type="button"
      >
        <AgentIcon aria-hidden size={ICON_SIZE.rowGlyph} />
        <span className="thread-work-strip-name">{entry.displayName}</span>
        {entry.agentType ? <span className="thread-work-strip-type">{entry.agentType}</span> : null}
        {entry.worktree ? (
          <span aria-label={t.agent.thread.agent.worktree} role="img">
            <GitBranchIcon aria-hidden size={ICON_SIZE.tiny} />
          </span>
        ) : null}
        {running
          ? <WorkingText className="thread-work-strip-meta" text={status} />
          : <span className="thread-work-strip-meta">{status}</span>}
      </button>
      {running && actions.stopAgent ? (
        <IconButton
          className="thread-work-strip-stop"
          icon={StopIcon}
          iconSize={ICON_SIZE.tiny}
          label={t.agent.thread.stopSubagent({ name: entry.displayName })}
          onClick={() => void actions.stopAgent?.(entry.agentId)}
          variant="message"
        />
      ) : null}
    </div>
  );
}

/**
 * Running first, then stopped, then just-finished.
 *
 * The order is by what the reader can still act on: live work can be stopped,
 * a stopped Agent is waiting for them, and a finished one is already reported
 * in the conversation and on its way out of the strip.
 */
export function stripRows(
  byAgentId: ReadonlyMap<ThreadId, SubagentRegistryEntry>,
  now: number,
): readonly SubagentRegistryEntry[] {
  const rank = (entry: SubagentRegistryEntry): number => {
    if (entry.status === 'running' || entry.status === 'pendingInit') return 0;
    return entry.stoppedByUser ? 1 : 2;
  };
  return [...byAgentId.values()]
    // Foreground work is not background work: it lives on the Turn it blocks.
    .filter((entry) => entry.runMode === 'background' && entry.form === 'agent')
    .filter((entry) => (
      entry.status === 'running'
      || entry.status === 'pendingInit'
      // Finished rows linger briefly and leave; without a settlement time the
      // Agent finished before this conversation was opened, and a conversation
      // reopened later must not present old work as if it just happened.
      || (entry.settledAt !== null && now - entry.settledAt < SUBAGENT_STRIP_LINGER_MS)
    ))
    .sort((left, right) => (
      rank(left) - rank(right)
      || (left.settledAt ?? left.startedAt ?? 0) - (right.settledAt ?? right.startedAt ?? 0)
      || left.agentId.localeCompare(right.agentId)
    ));
}

/**
 * A clock that ticks only while something is waiting to fade.
 *
 * The strip needs the current time for exactly one decision — has this row
 * outstayed its linger? — so it wakes for that transition and otherwise leaves
 * the deck alone.
 */
function useStripClock(
  byAgentId: ReadonlyMap<ThreadId, SubagentRegistryEntry>,
  injected: number | undefined,
): number {
  const [now, setNow] = useState(() => injected ?? Date.now());
  // Derived and passed as a DEPENDENCY, not held in a ref. In a ref, the moment
  // the last fade ended changed nothing the effect could see — the Agent map is
  // identical by then — so the interval it had started ran for the rest of the
  // session, once a second, over a strip that had already returned null.
  const lingering = [...byAgentId.values()].some((entry) => (
    entry.settledAt !== null && (injected ?? now) - entry.settledAt < SUBAGENT_STRIP_LINGER_MS
  ));
  useEffect(() => {
    if (injected !== undefined) {
      setNow(injected);
      return undefined;
    }
    if (!lingering) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [injected, lingering]);
  return injected ?? now;
}
