import type { CSSProperties } from 'react';
import type { NodeId, NodeProjection } from '../../api/types';
import type { NavigateRootOptions } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import { CalendarIcon } from '../icons';
import { CheckboxMark } from '../primitives/CheckboxMark';
import type { SystemFieldDisplay } from '../../../core/systemFields';

interface SystemFieldValueProps {
  display: SystemFieldDisplay;
  byId: Map<NodeId, NodeProjection>;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  /**
   * Toggle the owner's done state. Omitted when the owner is not editable (e.g. a
   * locked daily-note date page) — the Done checkbox then renders read-only, since
   * `toggle_done` would reject a locked node.
   */
  onToggleDone?: () => void;
}

const systemEmpty = <span className="field-value-system-empty">—</span>;

/**
 * Renders a read-only system field's value by its real type — the row component
 * just hands over the structured `SystemFieldDisplay` (see `systemFieldDisplay`).
 * `Done` is the one read-write case: a checkbox that writes the owner's done state,
 * unless the owner is locked (then it shows the state read-only).
 */
export function SystemFieldValue({ display, byId, onRoot, onToggleDone }: SystemFieldValueProps) {
  if (display.kind === 'done') {
    const mark = (
      <>
        <CheckboxMark checked={display.checked} />
        <span>{display.checked ? 'Done' : 'Not done'}</span>
      </>
    );
    return (
      <div className="field-value-cell">
        {onToggleDone ? (
          <button
            type="button"
            className={`typed-field-boolean typed-field-checkbox ${display.checked ? 'checked' : ''}`}
            role="checkbox"
            aria-checked={display.checked}
            data-field-value
            onClick={onToggleDone}
          >
            {mark}
          </button>
        ) : (
          <span
            className={`typed-field-boolean typed-field-checkbox is-readonly ${display.checked ? 'checked' : ''}`}
            role="checkbox"
            aria-checked={display.checked}
            aria-readonly="true"
            aria-disabled="true"
            data-field-value
          >
            {mark}
          </span>
        )}
      </div>
    );
  }

  // Node-reference kinds (nodeRefs / dayRef → References / Owner / Day) render as
  // real reference rows via SystemReferenceValues, not here; this component now
  // only paints the scalar read-only kinds (date / tags / text).
  const modifier = display.kind === 'tags'
    ? 'field-value-system-wrap'
    : display.kind === 'date'
      ? 'field-value-system-date'
      : '';

  return (
    <div className="field-value-cell">
      <div className={`field-value-system ${modifier}`} data-field-value aria-readonly="true">
        {renderValue(display, byId, onRoot)}
      </div>
    </div>
  );
}

function renderValue(
  display: Exclude<SystemFieldDisplay, { kind: 'done' }>,
  byId: Map<NodeId, NodeProjection>,
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void,
) {
  switch (display.kind) {
    case 'date':
      return display.text
        ? (<><span>{display.text}</span><CalendarIcon size={13} strokeWidth={1.8} /></>)
        : systemEmpty;
    case 'tags':
      return display.tagIds.length === 0
        ? systemEmpty
        : display.tagIds.map((tagId) => {
          const tag = byId.get(tagId);
          const color = resolveTagColor(tag, byId);
          const label = tag?.content.text || tagId;
          return (
            <button
              key={tagId}
              type="button"
              className="tag-badge tag-badge-button"
              style={{ '--tag-bg': color.background, '--tag-text': color.text } as CSSProperties}
              title={`Open ${label}`}
              onClick={() => onRoot(tagId)}
            >
              <span className="tag-badge-hash">#</span>
              <span className="tag-badge-label">{label}</span>
            </button>
          );
        });
    case 'text':
      return display.text || systemEmpty;
    default:
      return null;
  }
}
