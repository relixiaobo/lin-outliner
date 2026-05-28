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

interface OutlinerViewProps {
  panelId: string;
  parentId: NodeId;
  rootId: NodeId;
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
  // Eager-materialization trailing draft row:
  //  - 'always': always append (the panel body — there is always a place to add)
  //  - 'auto':   append when the list is empty or nav focuses the trailing line
  //  - 'none' (default): no trailing draft
  trailingDraft?: 'always' | 'auto' | 'none';
}

export function OutlinerView(props: OutlinerViewProps) {
  const parent = props.index.byId.get(props.parentId);
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
  const showDraft = Boolean(parent) && (
    trailingMode === 'always'
    || (trailingMode === 'auto' && (builtRows.length === 0 || trailingFocused))
  );
  const rows: OutlinerRowItem[] = showDraft
    ? [...builtRows, { id: draftId, type: 'content', draft: true }]
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
          />
        )}
      />
    </>
  );
}
