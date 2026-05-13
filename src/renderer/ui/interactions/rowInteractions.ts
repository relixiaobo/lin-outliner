export type EditorTriggerKind = '#' | '@' | '/' | '>';
export type DropdownTriggerKind = Exclude<EditorTriggerKind, '>'>;

export interface ResolvedEditorTrigger {
  kind: DropdownTriggerKind;
  query: string;
  from: number;
  to: number;
}

export function resolveEditorTriggerText(params: {
  text: string;
  cursorOffset: number;
}): ResolvedEditorTrigger | null {
  const { text, cursorOffset } = params;
  const beforeCursor = text.slice(0, cursorOffset);
  const afterCursor = text.slice(cursorOffset);

  const hashMatch = beforeCursor.match(/#([^\s#@]*)$/u);
  if (hashMatch?.index !== undefined) {
    return {
      kind: '#',
      query: hashMatch[1] ?? '',
      from: hashMatch.index,
      to: cursorOffset,
    };
  }

  const referenceMatch = beforeCursor.match(/@([^\s]*)$/u);
  if (referenceMatch?.index !== undefined) {
    return {
      kind: '@',
      query: referenceMatch[1] ?? '',
      from: referenceMatch.index,
      to: cursorOffset,
    };
  }

  const slashMatch = beforeCursor.match(/^\s*\/([^\s/]*)$/u);
  if (slashMatch && afterCursor.trim() === '') {
    return {
      kind: '/',
      query: slashMatch[1] ?? '',
      from: cursorOffset - ((slashMatch[1] ?? '').length + 1),
      to: cursorOffset,
    };
  }

  return null;
}

export type ContentRowUpdateAction =
  | { type: 'none' }
  | { type: 'create_field' };

export function resolveContentRowUpdateAction(params: {
  text: string;
  inlineRefCount: number;
  enableFieldTrigger: boolean;
}): ContentRowUpdateAction {
  if (
    params.enableFieldTrigger
    && params.inlineRefCount === 0
    && params.text === '>'
  ) {
    return { type: 'create_field' };
  }
  return { type: 'none' };
}

export type ContentRowBackspaceAtStartIntent =
  | 'merge_with_previous'
  | 'delete_empty'
  | 'block_delete_parent';

export function resolveContentRowBackspaceAtStartIntent(params: {
  isEmpty: boolean;
  hasChildren: boolean;
}): ContentRowBackspaceAtStartIntent {
  if (!params.isEmpty) return 'merge_with_previous';
  return params.hasChildren ? 'block_delete_parent' : 'delete_empty';
}

export type ReferenceSelectionAction = 'tree_reference' | 'inline_reference';

export function resolveReferenceSelectionAction(params: {
  text: string;
  inlineRefCount: number;
  triggerFrom: number;
  triggerTo: number;
  canCreateTreeReference: boolean;
}): ReferenceSelectionAction {
  if (!params.canCreateTreeReference || params.inlineRefCount > 0) {
    return 'inline_reference';
  }

  const beforeTrigger = params.text.slice(0, params.triggerFrom);
  const afterTrigger = params.text.slice(params.triggerTo);
  return beforeTrigger.trim() === '' && afterTrigger.trim() === ''
    ? 'tree_reference'
    : 'inline_reference';
}

export type TriggerForceCreateIntent =
  | 'hashtag_create'
  | 'reference_create'
  | 'noop';

export function resolveTriggerForceCreateIntent(params: {
  triggerKind: DropdownTriggerKind;
  query: string;
}): TriggerForceCreateIntent {
  const hasQuery = params.query.trim().length > 0;
  if (!hasQuery) return 'noop';
  if (params.triggerKind === '#') return 'hashtag_create';
  if (params.triggerKind === '@') return 'reference_create';
  return 'noop';
}

export type TrailingRowUpdateAction =
  | { type: 'none' }
  | { type: 'create_field' }
  | { type: 'create_trigger_node'; trigger: DropdownTriggerKind; matchText: string; textOffset: number }
  | { type: 'open_options'; query: string }
  | { type: 'close_options' };

export function resolveTrailingRowUpdateAction(params: {
  text: string;
  isOptionsField?: boolean;
}): TrailingRowUpdateAction {
  const { text, isOptionsField = false } = params;
  if (text === '>') return { type: 'create_field' };

  const triggerMatch = text.match(/(#|@|\/)$/u);
  if (triggerMatch) {
    return {
      type: 'create_trigger_node',
      trigger: triggerMatch[1] as DropdownTriggerKind,
      matchText: text,
      textOffset: text.length,
    };
  }

  if (isOptionsField) {
    return text.length > 0
      ? { type: 'open_options', query: text }
      : { type: 'close_options' };
  }

  return { type: 'none' };
}

export type TrailingRowEnterIntent =
  | 'options_confirm'
  | 'create_content_and_continue'
  | 'create_empty';

export function resolveTrailingRowEnterIntent(params: {
  optionsOpen?: boolean;
  optionCount?: number;
  hasText: boolean;
}): TrailingRowEnterIntent {
  if (params.optionsOpen && (params.optionCount ?? 0) > 0) return 'options_confirm';
  return params.hasText ? 'create_content_and_continue' : 'create_empty';
}

export type TrailingRowBackspaceIntent =
  | 'allow_default'
  | 'reset_depth_shift'
  | 'collapse_parent'
  | 'focus_last_visible'
  | 'noop';

export function resolveTrailingRowBackspaceIntent(params: {
  isEditorEmpty: boolean;
  depthShifted: boolean;
  parentChildCount: number;
  hasLastVisibleTarget: boolean;
}): TrailingRowBackspaceIntent {
  if (!params.isEditorEmpty) return 'allow_default';
  if (params.depthShifted) return 'reset_depth_shift';
  if (params.parentChildCount === 0) return 'collapse_parent';
  if (params.hasLastVisibleTarget) return 'focus_last_visible';
  return 'noop';
}

export type TrailingRowArrowDownIntent =
  | 'options_down'
  | 'navigate_out_down'
  | 'allow_default';

export function resolveTrailingRowArrowDownIntent(params: {
  optionsOpen?: boolean;
  optionCount?: number;
  hasNavigateOut: boolean;
}): TrailingRowArrowDownIntent {
  if (params.optionsOpen && (params.optionCount ?? 0) > 0) return 'options_down';
  return params.hasNavigateOut ? 'navigate_out_down' : 'allow_default';
}

export type TrailingRowArrowUpIntent =
  | 'options_up'
  | 'focus_last_visible'
  | 'navigate_out_up'
  | 'allow_default';

export function resolveTrailingRowArrowUpIntent(params: {
  optionsOpen?: boolean;
  optionCount?: number;
  hasLastVisibleTarget: boolean;
  hasNavigateOut: boolean;
}): TrailingRowArrowUpIntent {
  if (params.optionsOpen && (params.optionCount ?? 0) > 0) return 'options_up';
  if (params.hasNavigateOut) return 'navigate_out_up';
  if (params.hasLastVisibleTarget) return 'focus_last_visible';
  return 'allow_default';
}

export type TrailingRowEscapeIntent = 'close_options' | 'blur_editor';

export function resolveTrailingRowEscapeIntent(optionsOpen = false): TrailingRowEscapeIntent {
  return optionsOpen ? 'close_options' : 'blur_editor';
}
