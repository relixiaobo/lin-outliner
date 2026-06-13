import type { DocumentProjection, NodeId, NodeProjection } from '../../api/types';
import { LoaderIcon, RecentsIcon, SearchIcon, TrashIcon } from '../icons';
import { EmptyState } from '../primitives/FeedbackState';
import { useT } from '../../i18n/I18nProvider';

interface OutlinerEmptyStateProps {
  childCount: number;
  parent: NodeProjection | undefined;
  parentId: NodeId;
  projection: DocumentProjection;
  rootLevel: boolean;
  searchLoading?: boolean;
}

export function OutlinerEmptyState({
  childCount,
  parent,
  parentId,
  projection,
  rootLevel,
  searchLoading = false,
}: OutlinerEmptyStateProps) {
  const t = useT();
  if (!rootLevel || !parent || childCount > 0) return null;

  if (parentId === projection.recentsId) {
    return (
      <EmptyState
        body={t.outliner.emptyState.recentsBody}
        className="outliner-empty-state"
        icon={RecentsIcon}
        title={t.outliner.emptyState.recentsTitle}
      />
    );
  }

  if (parentId === projection.trashId) {
    return (
      <EmptyState
        body={t.outliner.emptyState.trashBody}
        className="outliner-empty-state"
        icon={TrashIcon}
        title={t.outliner.emptyState.trashTitle}
      />
    );
  }

  if (parent.type === 'search') {
    return searchLoading ? (
      <EmptyState
        className="outliner-empty-state"
        icon={LoaderIcon}
        loading
        role="status"
        title={t.common.loading}
      />
    ) : (
      <EmptyState
        body={t.outliner.emptyState.searchBody}
        className="outliner-empty-state"
        icon={SearchIcon}
        title={t.outliner.emptyState.searchTitle}
      />
    );
  }

  return null;
}
