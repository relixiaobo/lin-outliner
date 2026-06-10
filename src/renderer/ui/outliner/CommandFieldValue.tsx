import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { scheduleChipSummary } from './dateRecurrence';
import { DateValuePicker } from './DateValuePicker';
import { PopoverBulletIcon, PopoverListbox, PopoverListItem } from './PopoverList';
import { NodeBulletDot } from './NodeBulletDot';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { CommandRunner } from '../shared';
import { requestRevealAgentConversation } from '../../agent/agentReveal';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { CalendarIcon, ChevronDownIcon, PlayIcon } from '../icons';
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
  mainAgent: string;
  selectAgent: string;
  agentPlaceholder: string;
}

/** One selectable executing agent (an `AgentDefinition` projected for the picker). */
export interface CommandAgentOption {
  /** The `AgentDefinition.name` stored on the node. */
  name: string;
  /** The human-facing label (displayName ?? name). */
  label: string;
}

// The selectable agents are global and rarely change, so fetch the list once and
// share it across every command row (the cache survives remounts within the
// conversation). The conversation id is irrelevant here — the main process falls back
// to a registry listing when the id resolves to no live conversation.
let commandAgentOptionsCache: CommandAgentOption[] | null = null;
let commandAgentOptionsInflight: Promise<CommandAgentOption[]> | null = null;

export function useCommandAgentOptions(): readonly CommandAgentOption[] {
  const [options, setOptions] = useState<readonly CommandAgentOption[]>(commandAgentOptionsCache ?? []);
  useEffect(() => {
    if (commandAgentOptionsCache) return;
    let cancelled = false;
    commandAgentOptionsInflight ??= api.agentListAllDefinitions('')
      .then((defs) => defs.map((def): CommandAgentOption => ({ name: def.name, label: def.displayName || def.name })))
      .catch(() => []);
    void commandAgentOptionsInflight.then((resolved) => {
      commandAgentOptionsCache = resolved;
      if (!cancelled) setOptions(resolved);
    });
    return () => { cancelled = true; };
  }, []);
  return options;
}

// Drives an attended "run now": 1) ensure the delivery conversation exists on
// disk, 2) reveal + select it (loads the single in-memory conversation) and AWAIT that
// so the run never recreates the conversation mid-flight, then 3) run it. The run
// surfaces inline as a subagent boundary in the conversation (its permanent
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

// The value cell for a command node's `Agent` system field. Mirrors the standard
// field value interaction: empty by default ("Press Space to pick an agent…"), with
// Space (or click) summoning a registry listbox. When set it shows the agent as
// plain text + a chevron. Writes the (ungated) `commandAgent` scalar via
// `set_command_agent`; empty/null = the main agent (a context fork of the delivery
// conversation). `buttonRef` lets the field row focus this cell on navigation.
export function CommandAgentFieldValue(props: {
  nodeId: NodeId;
  agent: string | null;
  readOnly?: boolean;
  labels: CommandFieldLabels;
  run: CommandRunner;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { nodeId, agent, readOnly, labels, run, buttonRef } = props;
  const agents = useCommandAgentOptions();
  const [open, setOpen] = useState(false);
  const internalRef = useRef<HTMLButtonElement>(null);
  const anchorRef = buttonRef ?? internalRef;
  const selectedLabel = agent
    ? (agents.find((option) => option.name === agent)?.label ?? agent)
    : '';

  const choose = (name: string | null) => {
    setOpen(false);
    void run(() => api.setCommandAgent(nodeId, name));
  };

  return (
    <div className="field-value-cell command-field-value-cell">
      <CommandValueBullet />
      <button
        ref={anchorRef}
        type="button"
        className={`command-field-value command-agent-value ${open ? 'is-open' : ''} ${selectedLabel ? '' : 'is-empty'}`.trim()}
        data-field-value
        disabled={readOnly}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={labels.selectAgent}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => openOnSpaceOrEnter(event, () => setOpen(true))}
      >
        {selectedLabel ? (
          <>
            <span className="command-field-value-label">{selectedLabel}</span>
            <ChevronDownIcon size={13} strokeWidth={1.8} />
          </>
        ) : (
          <span className="command-field-placeholder">{labels.agentPlaceholder}</span>
        )}
      </button>
      <CommandAgentPicker
        anchorRef={anchorRef}
        agents={agents}
        selected={agent}
        mainAgentLabel={labels.mainAgent}
        listLabel={labels.selectAgent}
        open={open && !readOnly}
        onOpenChange={setOpen}
        onSelect={choose}
      />
    </div>
  );
}

// The agent registry listbox: the standard outliner popover list (same surface as
// the field-name / options pickers), anchored under the Agent value. `null` is the
// Main agent. Click / Arrow+Enter selects; Escape / outside-pointer closes.
function CommandAgentPicker(props: {
  anchorRef: RefObject<HTMLElement | null>;
  agents: readonly CommandAgentOption[];
  selected: string | null;
  mainAgentLabel: string;
  listLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (name: string | null) => void;
}) {
  const items = useMemo<Array<{ name: string | null; label: string }>>(
    () => [{ name: null, label: props.mainAgentLabel }, ...props.agents.map((agent) => ({ name: agent.name, label: agent.label }))],
    [props.agents, props.mainAgentLabel],
  );
  const selectedIndex = items.findIndex((item) => item.name === props.selected);
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef: props.anchorRef,
    disabled: !props.open,
    layoutKey: `${items.length}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 220,
  });

  // Open onto the stored selection so Arrow keys move from the current choice.
  useEffect(() => {
    if (props.open) setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const stateRef = useRef({ items, activeIndex });
  stateRef.current = { items, activeIndex };

  useEffect(() => {
    if (!props.open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && props.anchorRef.current?.contains(target)) return;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      props.onOpenChange(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isImeComposingEvent(event)) return;
      const state = stateRef.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        props.onOpenChange(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => Math.min(state.items.length - 1, current + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (event.key === 'Enter') {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
        const item = state.items[state.activeIndex];
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        props.onSelect(item.name);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  if (!props.open) return null;

  return createPortal(
    <PopoverListbox
      ref={menuRef}
      className="node-picker-popover command-agent-popover"
      label={props.listLabel}
      style={menuStyle}
    >
      {items.map((item, index) => (
        <PopoverListItem
          key={item.name ?? '__main__'}
          active={index === activeIndex}
          aria-selected={item.name === props.selected}
          icon={<PopoverBulletIcon />}
          label={item.label}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => props.onSelect(item.name)}
        />
      ))}
    </PopoverListbox>,
    document.body,
  );
}
