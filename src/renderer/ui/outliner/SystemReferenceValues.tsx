import { useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { EMPTY_RICH_TEXT, type NodeId, type NodeProjection } from '../../api/types';
import { DAY_FIELD, OWNER_FIELD, REF_COUNT_FIELD, systemFieldDisplay } from '../../../core/systemFields';
import type { DocumentIndex, UiState } from '../../state/document';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { OutlinerView } from './OutlinerView';

// The read-only system fields that resolve to other nodes: References (backlink
// sources), Owner (the parent), Day (the nearest day-tagged ancestor). They are
// computed, not stored — see docs/plans/archive/reference-field-type.md (decision A).
const NODE_REFERENCE_SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  REF_COUNT_FIELD,
  OWNER_FIELD,
  DAY_FIELD,
]);

/** Whether this system field's value is a set of node references (vs a date / checkbox / tags). */
export function isNodeReferenceSystemField(systemFieldId: string): boolean {
  return NODE_REFERENCE_SYSTEM_FIELDS.has(systemFieldId);
}

/** The target node ids a node-reference system field resolves to, in display order. */
function systemReferenceTargets(owner: NodeProjection, systemFieldId: string, byId: Map<NodeId, NodeProjection>): NodeId[] {
  const display = systemFieldDisplay(owner, systemFieldId, byId);
  if (display.kind === 'nodeRefs') return display.refs.map((ref) => ref.id);
  if (display.kind === 'dayRef') return display.nodeId ? [display.nodeId] : [];
  return [];
}

interface SystemReferenceValuesProps {
  panelId: string;
  entryId: NodeId;
  ownerId: NodeId;
  systemFieldId: string;
  selectionRootId: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  index: DocumentIndex;
  ui: UiState;
  uiRef: MutableRefObject<UiState>;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
}

/**
 * Renders a read-only node-reference system field (References / Owner / Day) as
 * real reference rows — the same presentation used everywhere else, so each value
 * is a full reference node: double-click edits the target (the change flows to the
 * original node) and the row expands to view it. The value *set* is read-only: it
 * is computed from the document, so there is no trailing draft (no add) and the
 * synthetic references carry an id core never stored (no delete — Backspace on a
 * reference row only steps up).
 *
 * Synthesis is render-time (not in core's incremental projection): References is a
 * global reverse index, so it is resolved here over the full `byId` and injected
 * into an augmented index for this entry's subtree only.
 */
export function SystemReferenceValues(props: SystemReferenceValuesProps) {
  const owner = props.index.byId.get(props.ownerId);

  const { index, isEmpty } = useMemo(() => {
    if (!owner) return { index: props.index, isEmpty: true };
    const targets = systemReferenceTargets(owner, props.systemFieldId, props.index.byId);
    if (targets.length === 0) return { index: props.index, isEmpty: true };

    const byId = new Map(props.index.byId);
    const refIds: NodeId[] = [];
    for (const targetId of targets) {
      const refId = `sysref:${props.entryId}:${targetId}`;
      refIds.push(refId);
      byId.set(refId, {
        id: refId,
        type: 'reference',
        targetId,
        parentId: props.entryId,
        children: [],
        content: EMPTY_RICH_TEXT,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: true,
        autoCollected: false,
      } as NodeProjection);
    }
    const entry = byId.get(props.entryId);
    if (entry) byId.set(props.entryId, { ...entry, children: refIds });

    return { index: { ...props.index, byId }, isEmpty: false };
  }, [owner, props.entryId, props.systemFieldId, props.index]);

  if (isEmpty) {
    return (
      <div className="field-value-cell">
        <div className="field-value-system" data-field-value aria-readonly="true">
          <span className="field-value-system-empty">—</span>
        </div>
      </div>
    );
  }

  // Reuse the exact value-column container the editable field values use
  // (`field-value-outliner` + `field-value-node-preview`): `.field-value-cell` is
  // a flex row, so the OutlinerView MUST sit inside this single full-width block
  // child (`.field-value-cell > .field-value-outliner { flex: 1 1 auto }`) for its
  // rows to stack top-to-bottom like every other outline. Dropping the rows
  // straight into the flex cell makes each one a horizontal flex item (squished
  // side-by-side). The rows themselves are the standard reference rows — same
  // style as everywhere else, just read-only.
  return (
    <div className="field-value-cell">
      <div className="field-value-outliner field-value-node-preview" data-field-value aria-readonly="true">
        <OutlinerView
          panelId={props.panelId}
          parentId={props.entryId}
          rootId={props.entryId}
          selectionRootId={props.selectionRootId}
          onRoot={props.onRoot}
          depth={0}
          index={index}
          ui={props.ui}
          uiRef={props.uiRef}
          setUi={props.setUi}
          run={props.run}
          trigger={props.trigger}
          setTrigger={props.setTrigger}
          dragId={props.dragId}
          setDragId={props.setDragId}
          referencePath={[props.entryId]}
          trailingDraft="none"
          showViewToolbar={false}
        />
      </div>
    </div>
  );
}
