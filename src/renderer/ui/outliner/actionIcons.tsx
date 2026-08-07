import type { ReactNode } from 'react';
import type { IconId } from '../../../core/actions/types';
import {
  AgentIcon,
  CheckboxIcon,
  CheckIcon,
  CopyIcon,
  DescriptionIcon,
  DuplicateIcon,
  FieldIcon,
  FilterIcon,
  GroupIcon,
  HideToolbarIcon,
  ICON_SIZE,
  MoveDownIcon,
  MoveToIcon,
  MoveUpIcon,
  NodeReadToolIcon,
  OpenIcon,
  PinIcon,
  RestoreIcon,
  ShowToolbarIcon,
  SortAscIcon,
  SupertagIcon,
  TableIcon,
  TrashIcon,
} from '../icons';

// The registry names icons by id (it is core code and cannot hold components);
// this is the single id -> component map for menu-tier surfaces.
export function actionIcon(iconId: IconId): ReactNode {
  const size = ICON_SIZE.menu;
  switch (iconId) {
    case 'agent': return <AgentIcon size={size} />;
    case 'check': return <CheckIcon size={size} />;
    case 'checkbox': return <CheckboxIcon size={size} />;
    case 'copy': return <CopyIcon size={size} />;
    case 'description': return <DescriptionIcon size={size} />;
    case 'duplicate': return <DuplicateIcon size={size} />;
    case 'field': return <FieldIcon size={size} />;
    case 'filter': return <FilterIcon size={size} />;
    case 'group': return <GroupIcon size={size} />;
    case 'hideToolbar': return <HideToolbarIcon size={size} />;
    case 'moveDown': return <MoveDownIcon size={size} />;
    case 'moveTo': return <MoveToIcon size={size} />;
    case 'moveUp': return <MoveUpIcon size={size} />;
    case 'node': return <NodeReadToolIcon size={size} />;
    case 'open': return <OpenIcon size={size} />;
    case 'outline': return <NodeReadToolIcon size={size} />;
    case 'pin': return <PinIcon size={size} />;
    case 'restore': return <RestoreIcon size={size} />;
    case 'showToolbar': return <ShowToolbarIcon size={size} />;
    case 'sortAsc': return <SortAscIcon size={size} />;
    case 'supertag': return <SupertagIcon size={size} />;
    case 'table': return <TableIcon size={size} />;
    case 'trash': return <TrashIcon size={size} />;
  }
}
