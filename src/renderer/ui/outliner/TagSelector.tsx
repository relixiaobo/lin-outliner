import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { AddIcon, ICON_SIZE } from '../icons';
import { tagSelectorItemLabel, tagSelectorItems } from '../interactions/tagSelector';
import type { CommandRunner } from '../shared';
import { resolveTagColor } from '../tags/tagColors';

interface TagSelectorProps {
  query: string;
  index: DocumentIndex;
  nodeId: NodeId;
  existingTagIds: readonly NodeId[];
  selectedIndex: number;
  setSelectedIndex: (index: number | ((current: number) => number)) => void;
  run: CommandRunner;
  close: () => void;
  clearTriggerText: () => Promise<void>;
}

export function TagSelector(props: TagSelectorProps) {
  const items = tagSelectorItems({
    query: props.query,
    index: props.index,
    existingTagIds: props.existingTagIds,
  }).map((item) => {
    if (item.type === 'existing') {
      const tag = item.tag;
      const color = resolveTagColor(tag).text;
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
          void props.run(async () => {
            await props.clearTriggerText();
            return api.applyTag(props.nodeId, tag.id);
          });
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
        void props.run(async () => {
          const outcome = await api.createTag(item.name);
          await props.clearTriggerText();
          return api.applyTag(props.nodeId, outcome.focus?.nodeId ?? '');
        });
      },
      create: true,
    };
  });

  return (
    <>
      {items.map((item, index) => (
        <button
          key={item.key}
          className={`popover-item ${index === props.selectedIndex ? 'active' : ''}`}
          role="option"
          data-create-tag={item.create ? 'true' : undefined}
          data-selected={index === props.selectedIndex ? 'true' : undefined}
          aria-selected={index === props.selectedIndex}
          onMouseEnter={() => props.setSelectedIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={item.action}
        >
          <span className="popover-item-icon">{item.icon}</span>
          <span className="popover-item-label">{item.label}</span>
        </button>
      ))}
    </>
  );
}
