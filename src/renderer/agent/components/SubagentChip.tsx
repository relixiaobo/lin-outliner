import type { ThreadId } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';
import {
  AgentIcon,
  ChevronRightIcon,
  GitForkIcon,
  ICON_SIZE,
  RefreshIcon,
  SkillIcon,
  StopIcon,
} from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { WorkingText } from '../../ui/primitives/WorkingText';
import { userFacingAgentError } from '../threadErrorMessage';
import type { SubagentAnchorKind, SubagentRegistryEntry } from '../subagentPresentation';
import { useSubagentActions, useSubagentEntry } from './SubagentRegistryContext';
import { formatSubagentDuration, useSubagentElapsedMs } from './subagentElapsed';

/**
 * One delegation, at the point in the conversation where it happened.
 *
 * The chip is an anchor, not a status board: it names the Agent, says how it is
 * doing in one trailing segment, and opens the one surface that holds the whole
 * story. It reads its subject from the registry rather than from the Item that
 * placed it, so the same chip keeps speaking for that Agent across every later
 * generation — a resume six Turns later updates this chip too, because there is
 * only ever one Agent behind it.
 *
 * Like every delegation surface it speaks time and status only: no token
 * quantity reaches its text, its title, or its accessible name.
 */
export function SubagentChip({
  agentId,
  fallbackName,
  kind,
}: {
  readonly agentId: ThreadId;
  /** Named from the canonical Item when the Agent's record is gone. */
  readonly fallbackName: string;
  readonly kind: SubagentAnchorKind;
}) {
  const t = useT();
  const entry = useSubagentEntry(agentId);
  const actions = useSubagentActions();
  const elapsedMs = useSubagentElapsedMs(entry ?? { status: 'notFound', startedAt: null });
  const name = entry?.displayName ?? fallbackName;
  // Foreground work shares the parent Turn's lifetime by contract, so a live
  // foreground chip is not a background task the reader may ignore — it is what
  // the conversation is currently blocked on, and it says so.
  const waiting = entry?.runMode === 'foreground' && entry.status === 'running';
  const status = subagentChipStatus(entry, elapsedMs, waiting, t, true);
  const error = entry?.status === 'errored' && entry.error
    ? userFacingAgentError(entry.error, t.agent.thread.resourceLimitReached)
    : null;
  const running = entry?.status === 'running' || entry?.status === 'pendingInit';
  const KindIcon = kind === 'resume'
    ? RefreshIcon
    : entry?.form === 'isolatedSkill'
      ? SkillIcon
      : AgentIcon;
  // The glyph is the only thing that tells a resume chip from a spawn chip, so
  // the accessible name has to say it in words.
  const openLabel = kind === 'resume'
    ? `${t.agent.thread.agent.openAgent({ name })} · ${t.agent.thread.agent.resumed}`
    : t.agent.thread.agent.openAgent({ name });
  return (
    <div
      className={`thread-item thread-agent-chip-block thread-subagent-${entry?.status ?? 'notFound'}`}
      data-agent-waiting={waiting ? 'true' : undefined}
    >
      <div className="thread-agent-chip-line">
      <button
        aria-label={`${openLabel}. ${status}${error ? `. ${error}` : ''}`}
        className="thread-agent-chip"
        onClick={() => actions.openAgent(agentId)}
        title={error ?? `${name} · ${status}`}
        type="button"
      >
        <KindIcon aria-hidden size={ICON_SIZE.rowGlyph} />
        <span className="thread-agent-chip-name">{name}</span>
        {entry?.agentType ? (
          <span className="thread-agent-chip-type">{entry.agentType}</span>
        ) : null}
        {entry?.worktree ? (
          <span
            aria-label={t.agent.thread.agent.worktree}
            className="thread-agent-chip-worktree"
            role="img"
            title={t.agent.thread.agent.worktree}
          >
            <GitForkIcon aria-hidden size={ICON_SIZE.tiny} />
          </span>
        ) : null}
        {running
          ? <WorkingText className="thread-agent-chip-meta" text={status} />
          : <span className="thread-agent-chip-meta">{status}</span>}
        {/* Says where the click goes. The tool rows beside this one carry a
            disclosure chevron at their LEFT edge that rotates open in place;
            a trailing `›` is the ordinary mark for a control that opens
            somewhere else, so the two affordances stop looking alike. */}
        <ChevronRightIcon aria-hidden className="thread-agent-chip-open" size={ICON_SIZE.tiny} />
      </button>
      {running && actions.stopAgent ? (
        <IconButton
          icon={StopIcon}
          iconSize={ICON_SIZE.tiny}
          label={t.agent.thread.stopSubagent({ name })}
          onClick={() => void actions.stopAgent?.(agentId)}
          variant="message"
        />
      ) : null}
      </div>
      {/* Its own line, wrapping in full: a failure the chip had to truncate is
          a failure the reader cannot act on. */}
      {error ? <small className="thread-agent-chip-error">{error}</small> : null}
    </div>
  );
}

/**
 * Time and state, in that order of usefulness.
 *
 * A running Agent's clock IS its status, so the compact form drops the word:
 * a chip in a 344px deck has one line for a name, a type, and a state, and
 * `Running · 1m 36s` spends half of it saying what the moving text already
 * says. A settled Agent has no clock left, so it states the outcome and the
 * span its generation recorded.
 */
export function subagentChipStatus(
  entry: SubagentRegistryEntry | null,
  elapsedMs: number | null,
  waiting: boolean,
  t: Messages,
  compact = false,
): string {
  if (!entry) return t.agent.thread.subagentStatuses.notFound;
  if (entry.stoppedByUser && entry.status !== 'running') return t.agent.thread.agent.stopped;
  const label = t.agent.thread.subagentStatuses[entry.status];
  const durationMs = elapsedMs ?? entry.durationMs;
  const elapsed = durationMs !== null && durationMs >= 1_000
    ? formatSubagentDuration(durationMs)
    : null;
  const timed = elapsed === null
    ? label
    : compact && elapsedMs !== null
      ? elapsed
      : `${label} · ${elapsed}`;
  const descendants = entry.liveDescendantCount > 0
    ? `${timed} · ${t.agent.thread.agent.childTasks({ count: entry.liveDescendantCount })}`
    : timed;
  // A foreground child shares the parent Turn's lifetime, so the parent line
  // says out loud that it is blocked rather than merely quiet.
  return waiting ? `${descendants} · ${t.agent.thread.agent.waitingForAgent}` : descendants;
}
