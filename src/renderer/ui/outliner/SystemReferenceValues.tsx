import { useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { EMPTY_RICH_TEXT, type NodeId, type NodeProjection } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import {
  isNodeReferenceSystemField,
  syntheticSystemReferenceId,
  systemReferenceTargets,
} from '../../state/systemReferenceRows';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { OutlinerView } from './OutlinerView';

export { isNodeReferenceSystemField };

interface SystemReferenceValuesProps {
  panelId: string;
  entryId: NodeId;
  ownerId: NodeId;
  systemFieldId: string;
  selectionRootId: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  ui: UiState;
  uiRef: MutableRefObject<UiState>;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  onTogglePin: (nodeId: NodeId) => void;
}

function mapIterator<T>(iterator: IterableIterator<T>): MapIterator<T> {
  return Object.assign(iterator, { [Symbol.dispose]: () => undefined }) as MapIterator<T>;
}

class OverlayMap<K, V> extends Map<K, V> {
  constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly overlay: ReadonlyMap<K, V>,
  ) {
    super();
  }

  get size(): number {
    let size = this.base.size;
    for (const key of this.overlay.keys()) {
      if (!this.base.has(key)) size += 1;
    }
    return size;
  }

  clear(): void {
    throw new TypeError('OverlayMap is read-only');
  }

  delete(_key: K): boolean {
    throw new TypeError('OverlayMap is read-only');
  }

  get(key: K): V | undefined {
    return this.overlay.has(key) ? this.overlay.get(key) : this.base.get(key);
  }

  has(key: K): boolean {
    return this.overlay.has(key) || this.base.has(key);
  }

  set(_key: K, _value: V): this {
    throw new TypeError('OverlayMap is read-only');
  }

  private *entryGenerator(): IterableIterator<[K, V]> {
    for (const [key, value] of this.base) {
      yield [key, this.overlay.has(key) ? this.overlay.get(key)! : value];
    }
    for (const [key, value] of this.overlay) {
      if (!this.base.has(key)) yield [key, value];
    }
  }

  entries(): MapIterator<[K, V]> {
    return mapIterator(this.entryGenerator());
  }

  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  private *keyGenerator(): IterableIterator<K> {
    for (const key of this.base.keys()) {
      yield key;
    }
    for (const key of this.overlay.keys()) {
      if (!this.base.has(key)) yield key;
    }
  }

  keys(): MapIterator<K> {
    return mapIterator(this.keyGenerator());
  }

  private *valueGenerator(): IterableIterator<V> {
    for (const [, value] of this.entries()) {
      yield value;
    }
  }

  values(): MapIterator<V> {
    return mapIterator(this.valueGenerator());
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

export function deriveSystemReferenceValueIndex(
  index: DocumentIndex,
  ownerId: NodeId,
  entryId: NodeId,
  systemFieldId: string,
): { index: DocumentIndex; isEmpty: boolean } {
  const owner = index.byId.get(ownerId);
  if (!owner) return { index, isEmpty: true };

  const targets = systemReferenceTargets(owner, systemFieldId, index.byId);
  if (targets.length === 0) return { index, isEmpty: true };

  const overlay = new Map<NodeId, NodeProjection>();
  const refIds: NodeId[] = [];
  for (const targetId of targets) {
    const refId = syntheticSystemReferenceId(entryId, targetId);
    refIds.push(refId);
    overlay.set(refId, {
      id: refId,
      type: 'reference',
      targetId,
      parentId: entryId,
      children: [],
      content: EMPTY_RICH_TEXT,
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      locked: true,
      autoCollected: false,
    } as NodeProjection);
  }

  const entry = index.byId.get(entryId);
  if (entry) overlay.set(entryId, { ...entry, children: refIds });

  return {
    index: { ...index, byId: new OverlayMap(index.byId, overlay) },
    isEmpty: false,
  };
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
  const { index, isEmpty } = useMemo(() => {
    return deriveSystemReferenceValueIndex(
      props.index,
      props.ownerId,
      props.entryId,
      props.systemFieldId,
    );
  }, [props.entryId, props.index, props.ownerId, props.systemFieldId]);

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
          isNodePinned={props.isNodePinned}
          ui={props.ui}
          uiRef={props.uiRef}
          setUi={props.setUi}
          run={props.run}
          onTogglePin={props.onTogglePin}
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
