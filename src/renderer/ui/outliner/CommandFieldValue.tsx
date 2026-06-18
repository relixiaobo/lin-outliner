import { useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { scheduleChipSummary } from './dateRecurrence';
import { DateValuePicker } from './DateValuePicker';
import { NodeBulletDot } from './NodeBulletDot';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { CommandRunner } from '../shared';
import { requestRevealAgentConversation } from '../../agent/agentReveal';
import { CalendarIcon, PlayIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';

// The recurrence-form/summary helpers live in the shared `dateRecurrence` module
// (the generic date field uses them too); re-exported here so existing importers
// (and tests) keep pulling them from the command field surface.
export { buildScheduleString, scheduleChipSummary } from './dateRecurrence';
export type { RecurrencePreset as CommandRecurrencePreset } from './dateRecurrence';

// Labels for the command config field editors and the title Run action. Sourced
// from `i18n.outliner.field.command`. The Schedule editor itself is the shared
// date picker, so its calendar / recurrence labels live under
// `i18n.outliner.field.datePicker`.
export interface CommandFieldLabels {
  enableSchedule: string;
  runNow: string;
  edit: string;
}

// Drives an attended "run now": 1) ensure the delivery conversation exists on
// disk, 2) reveal + select it (loads the single in-memory conversation) and AWAIT that
// so the run never recreates the conversation mid-flight, then 3) run it. The run
// surfaces inline as a child run boundary in the conversation (its permanent
// record), so failures that reach the conversation show there — nothing is
// reflected on the Run button. `running` drives ONLY the command bullet's
// processing spinner (the running indicator lives at the bullet, per the design);
// a ref guards re-entry so a second click while in flight is a no-op.
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
    <button
      type="button"
      className="command-title-run"
      title={labels.runNow}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRun(); }}
    >
      <span className="command-title-run-chip">
        <PlayIcon size={12} />
        <span className="command-title-run-label">{labels.runNow}</span>
      </span>
    </button>
  );
}

// The value cell for a command node's `Schedule` system field. It mirrors the
// STANDARD date field value's interaction: empty by default with a "Press Space to
// pick a date…" placeholder, and Space (or click) summons the shared date picker
// (single-only; recurrence is the "Repeat" control). When armed it shows the
// schedule summary + a muted calendar glyph. It commits through the user-gated
// `set_command_schedule`, not the generic field-value write, so the schedule bright
// line is unchanged. `buttonRef` lets the field row focus this cell on navigation.
export function CommandScheduleFieldValue(props: {
  nodeId: NodeId;
  schedule: string | null;
  readOnly?: boolean;
  labels: CommandFieldLabels;
  run: CommandRunner;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { nodeId, schedule, readOnly, labels, run, buttonRef } = props;
  const tf = useT().outliner.field;
  const [open, setOpen] = useState(false);
  const internalRef = useRef<HTMLButtonElement>(null);
  const anchorRef = buttonRef ?? internalRef;
  const summary = useMemo(() => (schedule ? scheduleChipSummary(schedule, tf.datePicker) : ''), [schedule, tf.datePicker]);

  const setSchedule = (next: string | null) => { void run(() => api.setCommandSchedule(nodeId, next)); };

  return (
    <div className="field-value-cell command-field-value-cell">
      <CommandValueBullet />
      <button
        ref={anchorRef}
        type="button"
        className={`command-field-value command-schedule-value ${open ? 'is-open' : ''} ${summary ? '' : 'is-empty'}`.trim()}
        data-field-value
        data-armed={summary ? 'true' : undefined}
        disabled={readOnly}
        title={summary ? labels.edit : labels.enableSchedule}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => openOnSpaceOrEnter(event, () => setOpen(true))}
      >
        {summary ? (
          <>
            <span className="command-field-value-label">{summary}</span>
            <CalendarIcon size={13} strokeWidth={1.8} />
          </>
        ) : (
          <span className="command-field-placeholder">{tf.datePlaceholder}</span>
        )}
      </button>
      <DateValuePicker
        anchorRef={anchorRef}
        value={schedule ?? ''}
        open={open && !readOnly}
        onOpenChange={setOpen}
        onCommit={(value) => setSchedule(value || null)}
        allowRange={false}
      />
    </div>
  );
}

// Each command config value reads, like a Tana field value, as its own node — so
// it carries a leading bullet matching the standard value-node bullet (the same
// `.row-bullet-shape.content` + dot the outliner draws). The schedule/agent are
// scalar-backed (no value node exists to zoom into), so this bullet is purely
// decorative and stays out of the a11y tree.
function CommandValueBullet() {
  return (
    <span className="command-field-value-bullet" aria-hidden="true">
      <span className="row-bullet-shape content">
        <NodeBulletDot />
      </span>
    </span>
  );
}

// Space / Enter on a focused command value cell summons its picker — matching the
// standard date field value, where Space on the empty value opens the calendar.
function openOnSpaceOrEnter(event: ReactKeyboardEvent, open: () => void): void {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  event.stopPropagation();
  open();
}
