import { api } from '../../api/client';
import type { CommandOutcome, DocumentProjection, NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { AddIcon, ICON_SIZE } from '../icons';
import { tagSelectorItemLabel, tagSelectorItems } from '../interactions/tagSelector';
import type { CommandRunner } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import { PopoverListItem } from './PopoverList';

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
  applyTag?: (tag: NodeProjection) => Promise<CommandOutcome | DocumentProjection | null | void>;
  createTagAndApply?: (name: string) => Promise<CommandOutcome | DocumentProjection | null | void>;
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
          if (props.applyTag) {
            void props.run(async () => {
              const result = await props.applyTag?.(tag);
              return result ?? api.getProjection();
            });
            return;
          }
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
        if (props.createTagAndApply) {
          void props.run(async () => {
            const result = await props.createTagAndApply?.(item.name);
            return result ?? api.getProjection();
          });
          return;
        }
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
