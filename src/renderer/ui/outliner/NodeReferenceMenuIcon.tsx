import type { NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { outlinerChildren } from '../shared';
import { tagBulletColors } from '../tags/tagColors';
import { RowMarker } from './RowMarker';

interface NodeReferenceMenuIconProps {
  index: DocumentIndex;
  node?: NodeProjection;
}

export function NodeReferenceMenuIcon({ index, node }: NodeReferenceMenuIconProps) {
  const icon = nodeIconOf(node);
  if (icon) {
    return (
      <span aria-hidden="true" className="popover-node-emoji">
        {icon}
      </span>
    );
  }

  const appliedTags = node?.tags
    .map((tagId) => index.byId.get(tagId))
    .filter((tag): tag is NodeProjection => Boolean(tag)) ?? [];

  return (
    <RowMarker
      className="popover-node-bullet"
      expanded={false}
      hasChildren={node ? outlinerChildren(node, index.byId).length > 0 : false}
      variant="content"
      bulletColors={tagBulletColors(appliedTags, index.byId)}
    />
  );
}

function nodeIconOf(node: NodeProjection | undefined): string | null {
  const icon = node?.icon;
  return typeof icon === 'string' && icon.trim() ? icon.trim() : null;
}
