import { createElement, forwardRef, type ComponentProps, type ForwardRefExoticComponent, type RefAttributes } from 'react';
import {
  AppWindow, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Attachment,
  Backward15Seconds, Bold, BookStack, Brain, Calendar, ChatBubble, ChatBubbleQuestion,
  Check, CheckSquare, Clock, Code, Copy, Database, DesignPencil, DocMagnifyingGlass,
  EditPencil, Enlarge, Eye, EyeClosed, FilterList, Folder, Forward15Seconds,
  GitBranch, GitFork, GraduationCap, Hashtag, HSquare, InfoCircle, InputField, Italic,
  Key, KeyCommand, Language, Link, List, ListSelect, LogOut,
  LongArrowDownRight, Mail, MediaImage, MediaVideo, MoreHoriz, MouseButtonLeft,
  MultiplePagesPlus, NavArrowDown, NavArrowLeft, NavArrowRight, OpenInBrowser,
  OpenInWindow, Package, Page, PageEdit, PagePlus, Palette, Pause, Pin, PinSlash,
  Play, PlaylistPlus, Plus, PlusCircle, Presentation, Reduce, Refresh, Search, ServerConnection,
  Settings, SidebarCollapse, SidebarExpand, SortDown, SortUp, SoundHigh, SoundLow,
  SoundMin, SoundOff, Square, Strikethrough, Table2Columns, TableRows, TaskList,
  Terminal, Text, TextMagnifyingGlass, Timer, Translate, Trash, Undo, UndoAction,
  ViewColumns2, VoiceSquare, WarningTriangle, Wrench, Xmark,
} from 'iconoir-react/regular';

export const ICON_SIZE = {
  tiny: 'tiny', tag: 'tag', rowGlyph: 'rowGlyph', compact: 'compact', menu: 'menu',
  rowChevron: 'rowChevron', toolbar: 'toolbar', large: 'large', panel: 'panel', badge: 'badge',
} as const;
export type IconSize = keyof typeof ICON_SIZE;
export interface AppIconProps {
  size?: IconSize;
  className?: string;
  id?: string;
  slot?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
  role?: 'img' | 'presentation';
}
export type AppIcon = ForwardRefExoticComponent<AppIconProps & RefAttributes<SVGSVGElement>>;

const ICON_LENGTH: Record<IconSize, string> = {
  tiny: 'var(--icon-size-tiny)', tag: 'var(--icon-size-tag)',
  rowGlyph: 'var(--icon-size-xs)', compact: 'var(--icon-size-compact)',
  menu: 'var(--icon-size-sm)', rowChevron: 'var(--icon-size-disclosure)',
  toolbar: 'var(--icon-size-md)', large: 'var(--icon-size-lg)',
  panel: 'var(--icon-size-panel)', badge: 'var(--icon-size-xl)',
};

type Glyph = typeof Search;

export function iconSizeLength(size: IconSize): string {
  return ICON_LENGTH[size];
}

function defineIcon(name: string, Glyph: Glyph, visual: Partial<ComponentProps<Glyph>> = {}): AppIcon {
  const Icon = forwardRef<SVGSVGElement, AppIconProps>(function SemanticIcon({
    size = ICON_SIZE.toolbar, className, ...props
  }, ref) {
    const glyphProps: ComponentProps<Glyph> & { 'data-icon': string } = {
      'aria-hidden': true, ...props, ...visual, ref, focusable: false,
      width: ICON_LENGTH[size], height: ICON_LENGTH[size],
      className: ['app-icon', visual.className, className].filter(Boolean).join(' '),
      'data-icon': name,
    };
    return createElement(Glyph, glyphProps);
  });
  Icon.displayName = `${name}Icon`;
  return Icon;
}

export const AddIcon = /* @__PURE__ */ defineIcon('Add', Plus);
export const AddChildIcon = /* @__PURE__ */ defineIcon('AddChild', PlaylistPlus);
export const AgentIcon = /* @__PURE__ */ defineIcon('Agent', Brain);
export const AppWindowIcon = /* @__PURE__ */ defineIcon('AppWindow', AppWindow);
export const AttachmentIcon = /* @__PURE__ */ defineIcon('Attachment', Attachment);
export const BackIcon = /* @__PURE__ */ defineIcon('Back', ArrowLeft);
export const BoldIcon = /* @__PURE__ */ defineIcon('Bold', Bold);
export const CalendarIcon = /* @__PURE__ */ defineIcon('Calendar', Calendar);
export const CheckIcon = /* @__PURE__ */ defineIcon('Check', Check);
export const CheckboxCheckIcon = /* @__PURE__ */ defineIcon('CheckboxCheck', Check, { strokeWidth: 3 });
export const CheckboxIcon = /* @__PURE__ */ defineIcon('Checkbox', Square);
export const ChevronDownIcon = /* @__PURE__ */ defineIcon('ChevronDown', NavArrowDown);
export const ChevronLeftIcon = /* @__PURE__ */ defineIcon('ChevronLeft', NavArrowLeft);
export const ChevronRightIcon = /* @__PURE__ */ defineIcon('ChevronRight', NavArrowRight);
export const ClickIcon = /* @__PURE__ */ defineIcon('Click', MouseButtonLeft);
export const ClockIcon = /* @__PURE__ */ defineIcon('Clock', Clock);
export const CloseIcon = /* @__PURE__ */ defineIcon('Close', Xmark);
export const CodeIcon = /* @__PURE__ */ defineIcon('Code', Code);
export const CollapseIcon = /* @__PURE__ */ defineIcon('Collapse', Reduce);
export const CollapseAgentPanelIcon = /* @__PURE__ */ defineIcon('CollapseAgentPanel', SidebarCollapse, { transform: 'scale(-1 1)' });
export const CollapseSidebarIcon = /* @__PURE__ */ defineIcon('CollapseSidebar', SidebarCollapse);
export const ColorIcon = /* @__PURE__ */ defineIcon('Color', Palette);
export const CommandIcon = /* @__PURE__ */ defineIcon('Command', KeyCommand);
export const CopyIcon = /* @__PURE__ */ defineIcon('Copy', Copy);
export const DatabaseIcon = /* @__PURE__ */ defineIcon('Database', Database);
export const DescriptionIcon = /* @__PURE__ */ defineIcon('Description', PageEdit);
export const DraftIcon = /* @__PURE__ */ defineIcon('Draft', PlusCircle);
export const DuplicateIcon = /* @__PURE__ */ defineIcon('Duplicate', MultiplePagesPlus);
export const DurationIcon = /* @__PURE__ */ defineIcon('Duration', Timer);
export const EmailIcon = /* @__PURE__ */ defineIcon('Email', Mail);
export const ExpandIcon = /* @__PURE__ */ defineIcon('Expand', Enlarge);
export const ExpandAgentPanelIcon = /* @__PURE__ */ defineIcon('ExpandAgentPanel', SidebarExpand, { transform: 'scale(-1 1)' });
export const ExpandSidebarIcon = /* @__PURE__ */ defineIcon('ExpandSidebar', SidebarExpand);
export const FieldIcon = /* @__PURE__ */ defineIcon('Field', InputField);
export const FileArchiveIcon = /* @__PURE__ */ defineIcon('FileArchive', Package);
export const FileAudioIcon = /* @__PURE__ */ defineIcon('FileAudio', VoiceSquare);
export const FileCodeIcon = /* @__PURE__ */ defineIcon('FileCode', Code);
export const FileCreateToolIcon = /* @__PURE__ */ defineIcon('FileCreateTool', PagePlus);
export const FileDeleteToolIcon = /* @__PURE__ */ defineIcon('FileDeleteTool', Trash);
export const FileEditToolIcon = /* @__PURE__ */ defineIcon('FileEditTool', PageEdit);
export const FileGlobToolIcon = /* @__PURE__ */ defineIcon('FileGlobTool', DocMagnifyingGlass);
export const FileGrepToolIcon = /* @__PURE__ */ defineIcon('FileGrepTool', TextMagnifyingGlass);
export const FileImageIcon = /* @__PURE__ */ defineIcon('FileImage', MediaImage);
export const FileReadToolIcon = /* @__PURE__ */ defineIcon('FileReadTool', Page);
export const FileSpreadsheetIcon = /* @__PURE__ */ defineIcon('FileSpreadsheet', Table2Columns);
export const FileTextIcon = /* @__PURE__ */ defineIcon('FileText', Page);
export const FileVideoIcon = /* @__PURE__ */ defineIcon('FileVideo', MediaVideo);
export const FileWriteToolIcon = /* @__PURE__ */ defineIcon('FileWriteTool', PageEdit);
export const FilterIcon = /* @__PURE__ */ defineIcon('Filter', FilterList);
export const FolderIcon = /* @__PURE__ */ defineIcon('Folder', Folder);
export const GenericToolIcon = /* @__PURE__ */ defineIcon('GenericTool', Wrench);
export const GitBranchIcon = /* @__PURE__ */ defineIcon('GitBranch', GitBranch);
export const GitForkIcon = /* @__PURE__ */ defineIcon('GitFork', GitFork);
export const GroupIcon = /* @__PURE__ */ defineIcon('Group', TableRows);
export const HeadingIcon = /* @__PURE__ */ defineIcon('Heading', HSquare);
export const HideIcon = /* @__PURE__ */ defineIcon('Hide', EyeClosed);
export const HideToolbarIcon = /* @__PURE__ */ defineIcon('HideToolbar', SidebarCollapse, { transform: 'rotate(90)' });
export const HighlightIcon = /* @__PURE__ */ defineIcon('Highlight', DesignPencil);
export const ImageIcon = /* @__PURE__ */ defineIcon('Image', MediaImage);
export const IndentIcon = /* @__PURE__ */ defineIcon('Indent', ArrowRight);
export const InfoIcon = /* @__PURE__ */ defineIcon('Info', InfoCircle);
export const ItalicIcon = /* @__PURE__ */ defineIcon('Italic', Italic);
export const LanguagesIcon = /* @__PURE__ */ defineIcon('Languages', Translate);
export const LibraryIcon = /* @__PURE__ */ defineIcon('Library', BookStack);
export const LoaderIcon = /* @__PURE__ */ defineIcon('Loader', Refresh, { className: 'app-icon-busy' });
export const MarkDoneIcon = /* @__PURE__ */ defineIcon('MarkDone', CheckSquare);
export const McpToolIcon = /* @__PURE__ */ defineIcon('McpTool', ServerConnection);
export const MessageAgentIcon = /* @__PURE__ */ defineIcon('MessageAgent', ChatBubble);
export const MoreIcon = /* @__PURE__ */ defineIcon('More', MoreHoriz);
export const MoveDownIcon = /* @__PURE__ */ defineIcon('MoveDown', ArrowDown);
export const MoveToIcon = /* @__PURE__ */ defineIcon('MoveTo', ArrowRight);
export const MoveUpIcon = /* @__PURE__ */ defineIcon('MoveUp', ArrowUp);
export const NavigateIcon = /* @__PURE__ */ defineIcon('Navigate', ArrowRight);
export const NumberFieldIcon = /* @__PURE__ */ defineIcon('NumberField', Hashtag);
export const OpenInBrowserIcon = /* @__PURE__ */ defineIcon('OpenInBrowser', OpenInBrowser);
export const OpenInDefaultAppIcon = /* @__PURE__ */ defineIcon('OpenInDefaultApp', OpenInWindow);
export const OptionsIcon = /* @__PURE__ */ defineIcon('Options', ListSelect);
export const OutdentIcon = /* @__PURE__ */ defineIcon('Outdent', ArrowLeft);
export const OutlineIcon = /* @__PURE__ */ defineIcon('Outline', List);
export const PasswordIcon = /* @__PURE__ */ defineIcon('Password', Key);
export const PauseIcon = /* @__PURE__ */ defineIcon('Pause', Pause);
export const PencilIcon = /* @__PURE__ */ defineIcon('Pencil', EditPencil);
export const PinIcon = /* @__PURE__ */ defineIcon('Pin', Pin);
export const PlainTextIcon = /* @__PURE__ */ defineIcon('PlainText', Text);
export const PlanToolIcon = /* @__PURE__ */ defineIcon('PlanTool', TaskList);
export const PlayIcon = /* @__PURE__ */ defineIcon('Play', Play);
export const PresentationIcon = /* @__PURE__ */ defineIcon('Presentation', Presentation);
export const QuestionToolIcon = /* @__PURE__ */ defineIcon('QuestionTool', ChatBubbleQuestion);
export const QuitIcon = /* @__PURE__ */ defineIcon('Quit', LogOut);
export const RecentsIcon = /* @__PURE__ */ defineIcon('Recents', Clock);
export const ReferenceIcon = /* @__PURE__ */ defineIcon('Reference', LongArrowDownRight);
export const RefreshIcon = /* @__PURE__ */ defineIcon('Refresh', Refresh);
export const RestoreIcon = /* @__PURE__ */ defineIcon('Restore', UndoAction);
export const ScheduledIcon = /* @__PURE__ */ defineIcon('Scheduled', Calendar);
export const SearchIcon = /* @__PURE__ */ defineIcon('Search', Search);
export const SeekBackwardIcon = /* @__PURE__ */ defineIcon('SeekBackward', Backward15Seconds);
export const SeekForwardIcon = /* @__PURE__ */ defineIcon('SeekForward', Forward15Seconds);
export const SendIcon = /* @__PURE__ */ defineIcon('Send', ArrowUp);
export const SettingsIcon = /* @__PURE__ */ defineIcon('Settings', Settings);
export const ShowIcon = /* @__PURE__ */ defineIcon('Show', Eye);
export const ShowToolbarIcon = /* @__PURE__ */ defineIcon('ShowToolbar', SidebarExpand, { transform: 'rotate(90)' });
export const SkillIcon = /* @__PURE__ */ defineIcon('Skill', GraduationCap);
export const SortAscIcon = /* @__PURE__ */ defineIcon('SortAsc', SortUp);
export const SortDescIcon = /* @__PURE__ */ defineIcon('SortDesc', SortDown);
export const SplitPaneIcon = /* @__PURE__ */ defineIcon('SplitPane', ViewColumns2);
export const StopIcon = /* @__PURE__ */ defineIcon('Stop', Square, { fill: 'currentColor' });
export const StrikeIcon = /* @__PURE__ */ defineIcon('Strike', Strikethrough);
export const SupertagIcon = /* @__PURE__ */ defineIcon('Supertag', Hashtag);
export const TableIcon = /* @__PURE__ */ defineIcon('Table', Table2Columns);
export const TerminalIcon = /* @__PURE__ */ defineIcon('Terminal', Terminal);
export const TrashIcon = /* @__PURE__ */ defineIcon('Trash', Trash);
export const UndoIcon = /* @__PURE__ */ defineIcon('Undo', Undo);
export const UnpinIcon = /* @__PURE__ */ defineIcon('Unpin', PinSlash);
export const UrlIcon = /* @__PURE__ */ defineIcon('Url', Link);
export const VolumeHighIcon = /* @__PURE__ */ defineIcon('VolumeHigh', SoundHigh);
export const VolumeLowIcon = /* @__PURE__ */ defineIcon('VolumeLow', SoundMin);
export const VolumeMediumIcon = /* @__PURE__ */ defineIcon('VolumeMedium', SoundLow);
export const VolumeOffIcon = /* @__PURE__ */ defineIcon('VolumeOff', SoundOff);
export const WarningIcon = /* @__PURE__ */ defineIcon('Warning', WarningTriangle);
export const WebFetchToolIcon = /* @__PURE__ */ defineIcon('WebFetchTool', Language);
export const WebPageIcon = /* @__PURE__ */ defineIcon('WebPage', Language);
export const WebSearchToolIcon = /* @__PURE__ */ defineIcon('WebSearchTool', Search);
