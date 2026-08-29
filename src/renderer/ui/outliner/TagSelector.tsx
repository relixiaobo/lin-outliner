import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { AddIcon, ICON_SIZE } from '../icons';
import { tagSelectorItemLabel, tagSelectorItems } from '../interactions/tagSelector';
import type { CommandRunnerOperationResult } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import { PopoverListItem } from './PopoverList';

interface TagSelectorProps {
  query: string;
  index: DocumentIndex;
  existingTagIds: readonly NodeId[];
  selectedIndex: number;
  setSelectedIndex: (index: number | ((current: number) => number)) => void;
  close: () => void;
  applyTag: (tag: NodeProjection) => Promise<CommandRunnerOperationResult>;
  createTagAndApply: (name: string) => Promise<CommandRunnerOperationResult>;
}

export function TagSelector(props: TagSelectorProps) {
  const items = tagSelectorItems({
    query: props.query,
    index: props.index,
    existingTagIds: props.existingTagIds,
  }).map((item) => {
    if (item.type === 'existing') {
      const tag = item.tag;
      const color = resolveTagColor(tag, props.index.byId).text;
      return {
        key: `tag:${tag.id}`,
        label: tagSelectorItemLabel(item),
        icon: (
          <span className="tag-selector-hash" style={{ color }} aria-hidden="true">
            #
          </span>
        ),
        action: () => {
          props.close();
          void props.applyTag(tag);
        },
        create: false,
      };
    }
    return {
      key: `tag:create:${item.name}`,
      label: tagSelectorItemLabel(item),
      icon: <AddIcon size={ICON_SIZE.menu} />,
      action: () => {
        props.close();
        void props.createTagAndApply(item.name);
      },
      create: true,
    };
  });

  return (
    <>
      {items.map((item, index) => (
        <PopoverListItem
          key={item.key}
          active={index === props.selectedIndex}
          data-create-tag={item.create ? 'true' : undefined}
          icon={item.icon}
          iconClassName="popover-item-icon"
          label={item.label}
          onMouseEnter={() => props.setSelectedIndex(index)}
          onClick={item.action}
        />
      ))}
    </>
  );
}
