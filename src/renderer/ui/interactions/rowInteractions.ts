import { TAG_TRIGGER_QUERY_PATTERN, isCssHexColorToken } from '../../../core/textSyntax';
import type { TreeReferenceBlockReason } from './referenceRules';

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

  const hashMatch = beforeCursor.match(TAG_TRIGGER_QUERY_PATTERN);
  if (hashMatch?.index !== undefined) {
    if (isCssHexColorToken(hashMatch[1] ?? '')) return null;
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
  | { type: 'create_field' }
  | { type: 'create_code_block' };

// A bare ``` or ~~~ that owns the whole row (no other text, no inline refs) is a
// markdown-style shortcut to turn the row into a code block, mirroring how a
// pasted fence becomes a `codeBlock` node.
const CODE_FENCE_RE = /^(```|~~~)$/u;

export function resolveContentRowUpdateAction(params: {
  text: string;
  inlineRefCount: number;
  enableFieldTrigger: boolean;
  enableCodeFence?: boolean;
}): ContentRowUpdateAction {
  if (
    params.enableFieldTrigger
    && params.inlineRefCount === 0
    && params.text === '>'
  ) {
    return { type: 'create_field' };
  }
  if (
    params.enableCodeFence
    && params.inlineRefCount === 0
    && CODE_FENCE_RE.test(params.text)
  ) {
    return { type: 'create_code_block' };
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

export type ReferenceSelectionAction = 'tree_reference' | 'inline_reference' | 'blocked';

export function resolveReferenceSelectionAction(params: {
  text: string;
  inlineRefCount: number;
  triggerFrom: number;
  triggerTo: number;
  treeBlockReason: TreeReferenceBlockReason | null;
  sourceIsReference: boolean;
}): ReferenceSelectionAction {
  const beforeTrigger = params.text.slice(0, params.triggerFrom);
  const afterTrigger = params.text.slice(params.triggerTo);
  const ownsWholeRow = beforeTrigger.trim() === '' && afterTrigger.trim() === '';
  if (!ownsWholeRow || params.inlineRefCount > 0 || params.sourceIsReference) {
    return 'inline_reference';
  }
  if (params.treeBlockReason === 'already_in_parent') {
    return 'inline_reference';
  }
  if (params.treeBlockReason) {
    return 'blocked';
  }
  return 'tree_reference';
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
