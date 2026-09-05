import type { ObjectPresentation, SystemNodeKey } from '../../../core/actions/types';
import {
  AppWindowIcon, CalendarIcon, DraftIcon, ICON_SIZE, iconSizeLength, LibraryIcon,
  OutlineIcon, SearchIcon, SettingsIcon, SupertagIcon, TrashIcon, WebPageIcon,
  type AppIcon, type AppIconProps,
} from '../icons';

const SYSTEM_ICONS = {
  today: CalendarIcon, library: LibraryIcon, schema: SupertagIcon,
  savedSearches: SearchIcon, trash: TrashIcon,
} satisfies Record<SystemNodeKey, AppIcon>;

type ObjectVisual = { kind: 'icon'; Icon: AppIcon } | { kind: 'emoji'; text: string }
  | { kind: 'bullet' } | { kind: 'empty' };

function objectVisual(object: ObjectPresentation): ObjectVisual {
  if (object.emoji) return { kind: 'emoji', text: object.emoji };
  switch (object.kind) {
    case 'node': {
      if (object.node?.kind === 'system') {
        if (Object.hasOwn(SYSTEM_ICONS, object.node.key)) return { kind: 'icon', Icon: SYSTEM_ICONS[object.node.key] };
      }
      if (object.node?.kind === 'document') return object.node.nodeType === 'tagDef'
        ? { kind: 'icon', Icon: SupertagIcon } : { kind: 'bullet' };
      break;
    }
    case 'nodeSelection': return { kind: 'icon', Icon: OutlineIcon };
    case 'draft': return { kind: 'icon', Icon: DraftIcon };
    case 'appSurface': {
      if (object.surface === 'settings') return { kind: 'icon', Icon: SettingsIcon };
      if (object.surface === 'mainWindow') return { kind: 'icon', Icon: AppWindowIcon };
      break;
    }
    case 'externalPage': {
      if (object.sourceKind === 'web') return { kind: 'icon', Icon: WebPageIcon };
      if (object.sourceKind === 'application' || object.sourceKind === 'unknown') return { kind: 'icon', Icon: AppWindowIcon };
      break;
    }
    default: {
      const unknownObject: never = object;
      console.warn('[icons] Unsupported object presentation', unknownObject);
      return { kind: 'empty' };
    }
  }
  console.warn('[icons] Missing object presentation facts', object.kind);
  return { kind: 'empty' };
}

export function ObjectGlyph({ object, size = ICON_SIZE.toolbar, className, ...props }:
  AppIconProps & { object: ObjectPresentation }) {
  const visual = objectVisual(object);
  if (visual.kind === 'icon') return <visual.Icon size={size} className={className} {...props} />;
  const length = iconSizeLength(size);
  return <span
    aria-hidden="true"
    className={['object-glyph', `object-glyph-${visual.kind}`, className].filter(Boolean).join(' ')}
    style={{ width: length, height: length, fontSize: length }}
  >{visual.kind === 'emoji' ? visual.text : null}</span>;
}
