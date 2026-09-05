import type { ActionPresentation } from '../../../core/actions/types';
import type { ViewSection } from '../../../core/actions/bindings';
import {
  AddChildIcon, AgentIcon, CheckboxIcon, CopyIcon, DescriptionIcon, DuplicateIcon,
  FieldIcon, FilterIcon, GroupIcon, HideToolbarIcon, IndentIcon, MarkDoneIcon,
  MoveDownIcon, MoveToIcon, MoveUpIcon, NavigateIcon, OutdentIcon, OutlineIcon,
  PinIcon, RestoreIcon, ShowToolbarIcon, SortAscIcon, SplitPaneIcon, SupertagIcon,
  TableIcon, TrashIcon, UnpinIcon, type AppIcon, type AppIconProps,
} from '../icons';

const VIEW_SECTION_ICONS = {
  filter: FilterIcon, sort: SortAscIcon, group: GroupIcon, display: FieldIcon,
} satisfies Record<ViewSection, AppIcon>;

export function iconForViewMode(mode: 'outline' | 'table'): AppIcon {
  return mode === 'table' ? TableIcon : OutlineIcon;
}

export function iconForAction(action: ActionPresentation): AppIcon | null {
  switch (action.actionId) {
    case 'open': return NavigateIcon;
    case 'openInSplitPane': return SplitPaneIcon;
    case 'capture':
    case 'create': return AddChildIcon;
    case 'setPinned': return action.binding.state === 'ready'
      ? action.binding.arguments.pinned ? PinIcon : UnpinIcon : null;
    case 'setDone': return action.binding.state === 'ready'
      ? action.binding.arguments.done ? MarkDoneIcon : CheckboxIcon : null;
    case 'move': {
      if (action.binding.state !== 'ready') return MoveToIcon;
      const relative = action.binding.arguments.relative;
      return relative === 'up' ? MoveUpIcon : relative === 'down' ? MoveDownIcon : MoveToIcon;
    }
    case 'setViewMode': return action.binding.state === 'ready'
      ? iconForViewMode(action.binding.arguments.mode) : null;
    case 'setViewToolbarVisible': return action.binding.state === 'ready'
      ? action.binding.arguments.visible ? ShowToolbarIcon : HideToolbarIcon : null;
    case 'editViewSection': return action.binding.state === 'ready'
      ? VIEW_SECTION_ICONS[action.binding.arguments.section] ?? null : null;
    case 'addTag': return SupertagIcon;
    case 'sendToAgent': return AgentIcon;
    case 'duplicate': return DuplicateIcon;
    case 'editDescription': return DescriptionIcon;
    case 'copy': return CopyIcon;
    case 'remove':
    case 'deleteForever':
    case 'emptyTrash': return TrashIcon;
    case 'restore': return RestoreIcon;
    case 'indent': return IndentIcon;
    case 'outdent': return OutdentIcon;
    default: {
      const unknownAction: never = action;
      console.warn('[icons] Unsupported action presentation', unknownAction);
      return null;
    }
  }
}

export function ActionGlyph({ action, ...props }: AppIconProps & { action: ActionPresentation }) {
  const Icon = iconForAction(action);
  return Icon ? <Icon {...props} /> : null;
}

export function ViewModeGlyph({ mode, ...props }: AppIconProps & { mode: 'outline' | 'table' }) {
  const Icon = iconForViewMode(mode);
  return <Icon {...props} />;
}
