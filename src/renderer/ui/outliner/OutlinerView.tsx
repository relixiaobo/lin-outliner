import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { RowHost } from './RowHost';
import { buildOutlinerRows, hiddenFieldKey, readViewConfig, type OutlinerRowItem } from './row-model';
import { useTrailingDraftId } from './draftRow';
import { ViewToolbar } from './ViewToolbar';
import { HiddenFieldReveal, ViewGroupHeading } from './OutlinerViewChrome';
import type { FieldValueContext } from '../fields/fieldValueEditors';

function insertDraftRow(
  rows: OutlinerRowItem[],
  draftRow: OutlinerRowItem,
  afterId: NodeId | null,
): OutlinerRowItem[] {
  if (!afterId) return [...rows, draftRow];
  const index = rows.findIndex((row) => row.id === afterId);
  if (index < 0) return [...rows, draftRow];
  return [...rows.slice(0, index + 1), draftRow, ...rows.slice(index + 1)];
}

interface OutlinerViewProps {
  panelId: string;
  parentId: NodeId;
  rootId: NodeId;
  selectionRootId?: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  depth: number;
  index: DocumentIndex;
  ui: UiState;
  uiRef: MutableRefObject<UiState>;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  rows?: OutlinerRowItem[];
  referencePath?: readonly NodeId[];
  showViewToolbar?: boolean;
  // When this view renders a field's values (not body content), the field-value
  // context threads field-awareness to every content row + the trailing draft so
  // creates/selects route to the field command set and the options popover shows.
  fieldValue?: FieldValueContext;
  // Eager-materialization trailing draft row:
  //  - 'always': always append (the panel body — there is always a place to add)
  //  - 'auto':   append when the list is empty or nav focuses the trailing line
  //  - 'none' (default): no trailing draft
  trailingDraft?: 'always' | 'auto' | 'none';
  // Empty-state placeholder for the trailing draft row (definition template /
  // options blocks). Only the draft row receives it.
  draftPlaceholder?: string;
}

export function OutlinerView(props: OutlinerViewProps) {
  const parent = props.index.byId.get(props.parentId);
  const selectionRootId = props.selectionRootId ?? props.rootId;
  const view = readViewConfig(parent, props.index.byId);
  const builtRows = props.rows ?? buildOutlinerRows(parent, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  });

  // The draft id is minted here (renderer-only) so it survives until the row
  // materializes; `buildOutlinerRows` stays a pure projection. The hook must run
  // unconditionally, so we always compute it and only append when shown.
  const draftId = useTrailingDraftId(props.parentId, props.index.byId);
  const trailingMode = props.trailingDraft ?? 'none';
  const trailingFocused = props.ui.focusedId === props.parentId
    && props.ui.focusSurface === 'trailing'
    && props.ui.focusedPanelId === props.panelId;
  // Once the trailing draft's editor takes focus, onFocus settles the focus
  // signal from (parent, 'trailing') to the draft row's own id (see OutlinerItem
  // trailingDraftFocused). Keep the draft mounted in that settled state too —
  // otherwise an 'auto' view that already has rows unmounts the draft the instant
  // it focuses, dropping the caret. The body uses 'always' so it never hits this;
  // field values use 'auto', which is why the bug surfaced only there.
  const draftFocused = props.ui.focusedId === draftId
    && props.ui.focusedPanelId === props.panelId;
  const placement = props.ui.trailingDraftPlacement;
  const placementAfterId = placement
    && placement.parentId === props.parentId
    && (placement.panelId === null || placement.panelId === props.panelId)
    ? placement.afterId
    : null;
  const showDraft = Boolean(parent) && (
    trailingMode === 'always'
    || (trailingMode === 'auto' && (builtRows.length === 0 || trailingFocused || draftFocused))
  );
  const draftRow: OutlinerRowItem = { id: draftId, type: 'content', draft: true, afterId: placementAfterId };
  const rows: OutlinerRowItem[] = showDraft
    ? insertDraftRow(builtRows, draftRow, placementAfterId)
    : builtRows;

  useEffect(() => {
    if (parent?.type !== 'search') return;
    void api.refreshSearchNodeResults(props.parentId).catch((error) => {
      console.error('Failed to refresh live search results', error);
    });
  }, [parent?.type, props.parentId, props.index.projection]);

  return (
    <>
      {props.showViewToolbar !== false && parent && view.toolbarVisible && (
        <ViewToolbar
          node={parent}
          view={view}
          index={props.index}
          run={props.run}
          dropdownRequest={props.ui.toolbarDropdownRequest}
          onDropdownRequestConsumed={(request) => {
            props.setUi((prev) => (
              prev.toolbarDropdownRequest === request
                ? { ...prev, toolbarDropdownRequest: null }
                : prev
            ));
          }}
        />
      )}
      <RowHost
        rows={rows}
        renderGroup={(row) => (
          <ViewGroupHeading label={row.label} />
        )}
        renderHiddenField={(row) => (
          <HiddenFieldReveal
            label={row.label}
            onReveal={() => {
              props.setUi((prev) => {
                const expandedHiddenFields = new Set(prev.expandedHiddenFields);
                expandedHiddenFields.add(hiddenFieldKey(props.parentId, row.fieldId));
                return { ...prev, expandedHiddenFields };
              });
            }}
          />
        )}
        renderField={(row, index, rows) => (
          <OutlinerFieldRow
            panelId={props.panelId}
            entryId={row.id}
            parentId={props.parentId}
            rootId={props.rootId}
            selectionRootId={selectionRootId}
            onRoot={props.onRoot}
            depth={props.depth}
            index={props.index}
            ui={props.ui}
            uiRef={props.uiRef}
            setUi={props.setUi}
            run={props.run}
            trigger={props.trigger}
            setTrigger={props.setTrigger}
            dragId={props.dragId}
            setDragId={props.setDragId}
            isFirstInFieldGroup={rows[index - 1]?.type !== 'field'}
            isLastInFieldGroup={rows[index + 1]?.type !== 'field'}
          />
        )}
        renderContent={(row) => (
          <OutlinerItem
            panelId={props.panelId}
            nodeId={row.id}
            parentId={props.parentId}
            rootId={props.rootId}
            selectionRootId={selectionRootId}
            onRoot={props.onRoot}
            depth={props.depth}
            index={props.index}
            ui={props.ui}
            uiRef={props.uiRef}
            setUi={props.setUi}
            run={props.run}
            trigger={props.trigger}
            setTrigger={props.setTrigger}
            dragId={props.dragId}
            setDragId={props.setDragId}
            referencePath={props.referencePath ?? [props.rootId]}
            draft={row.draft}
            draftAfterId={row.draft ? row.afterId ?? null : undefined}
            draftPlaceholder={row.draft ? props.draftPlaceholder : undefined}
            fieldValue={props.fieldValue}
            // An already-selected (not focused) reference value row reuses the
            // legacy read-only option picker; keep feeding it optionField +
            // onSelectOption derived from the field-value context.
            optionField={props.fieldValue?.optionField}
            onSelectOption={props.fieldValue?.onSelectOption}
          />
        )}
      />
    </>
  );
}
