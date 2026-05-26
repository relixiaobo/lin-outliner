import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { formatNodeReferenceMarker } from '../../../core/nodeReferenceMarkup';
import type { AgentSlashCommandView, NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { nextMenuIndex, clampMenuIndex } from '../interactions/menuNavigation';
import { resolveEditorTriggerText } from '../interactions/rowInteractions';
import { referenceItems } from '../outliner/ReferenceSelector';
import { NodeReferenceMenuIcon } from '../outliner/NodeReferenceMenuIcon';
import { PopoverEmpty, PopoverListbox, PopoverListItem } from '../outliner/PopoverList';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { CommandIcon, ICON_SIZE } from '../icons';
import { textOf } from '../shared';
import { inlineReferenceTextColor } from '../tags/tagColors';
import {
  nodeReferenceOpenOptionsFromClick,
  type AgentNodeReferenceOpenHandler,
} from './AgentInlineReferenceText';

export interface AgentComposerNodeReference {
  nodeId: NodeId;
  title: string;
}

export interface AgentComposerFileReference {
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AgentComposerDraft {
  empty: boolean;
  fileRefs: AgentComposerFileReference[];
  nodeRefs: AgentComposerNodeReference[];
  text: string;
}

export interface AgentComposerEditorSnapshot {
  doc: unknown;
}

export interface AgentComposerEditorHandle {
  clear: () => void;
  focus: () => void;
  insertFileReferences: (refs: AgentComposerFileReference[]) => void;
  removeFileReferences: (attachmentIds: readonly string[]) => void;
  restore: (snapshot: AgentComposerEditorSnapshot) => void;
  setPlainText: (text: string) => void;
  snapshot: () => AgentComposerEditorSnapshot | null;
}

interface AgentComposerEditorProps {
  currentNodeId: NodeId | null;
  index: DocumentIndex;
  isStreaming: boolean;
  onChange: (draft: AgentComposerDraft) => void;
  onFilesPasted: (files: File[]) => void;
  onNodeReferenceClick: AgentNodeReferenceOpenHandler;
  onStop: () => void;
  onSubmit: () => void;
  placeholder: string;
  slashCommands: AgentSlashCommandView[];
}

interface ComposerTrigger {
  kind: '@' | '/';
  query: string;
  from: number;
  to: number;
  anchor: { left: number; top: number; bottom: number } | null;
}

const EMPTY_DRAFT: AgentComposerDraft = {
  empty: true,
  fileRefs: [],
  nodeRefs: [],
  text: '',
};

const agentComposerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph' },
    paragraph: {
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM() {
        return ['p', 0];
      },
    },
    text: { group: 'inline' },
    hardBreak: {
      group: 'inline',
      inline: true,
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM() {
        return ['br'];
      },
    },
    nodeReference: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        targetNodeId: { default: '' },
        title: { default: '' },
        color: { default: '' },
      },
      toDOM(node) {
        const title = String(node.attrs.title ?? '');
        const displayTitle = title || 'Referenced node';
        const attrs: Record<string, string> = {
          class: 'inline-ref agent-composer-inline-ref',
          contenteditable: 'false',
          'data-inline-ref': String(node.attrs.targetNodeId ?? ''),
          'data-agent-node-ref': String(node.attrs.targetNodeId ?? ''),
          title: displayTitle,
        };
        if (node.attrs.color) {
          attrs.style = `color: ${node.attrs.color}; --inline-ref-accent: ${node.attrs.color}`;
        }
        return [
          'span',
          attrs,
          displayTitle,
        ];
      },
    },
    fileReference: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        attachmentId: { default: '' },
        name: { default: '' },
        mimeType: { default: '' },
        sizeBytes: { default: 0 },
      },
      toDOM(node) {
        const name = String(node.attrs.name ?? '') || 'file';
        const sizeBytes = Number(node.attrs.sizeBytes ?? 0);
        const detail = [
          name,
          node.attrs.mimeType ? String(node.attrs.mimeType) : null,
          Number.isFinite(sizeBytes) && sizeBytes > 0 ? formatBytes(sizeBytes) : null,
        ].filter(Boolean).join(' - ');
        return [
          'span',
          {
            class: 'agent-composer-inline-file',
            contenteditable: 'false',
            'data-agent-file-ref': String(node.attrs.attachmentId ?? ''),
            title: detail,
          },
          ['span', { class: 'agent-composer-inline-file-icon', 'data-extension': fileExtensionLabel(name, node.attrs.mimeType) }],
          ['span', { class: 'agent-composer-inline-file-name' }, name],
        ];
      },
    },
  },
});

export const AgentComposerEditor = forwardRef<AgentComposerEditorHandle, AgentComposerEditorProps>(
  function AgentComposerEditor(props, ref) {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const propsRef = useRef(props);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const itemCountRef = useRef(0);
    const selectedIndexRef = useRef(0);
    const triggerRef = useRef<ComposerTrigger | null>(null);
    const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isEmpty, setIsEmpty] = useState(true);

    propsRef.current = props;

    const itemCount = useMemo(() => {
      if (!trigger) return 0;
      if (trigger.kind === '/') return filterSlashCommands(props.slashCommands, trigger.query).length;
      return referenceMenuItems(props.index, props.currentNodeId, trigger.query).length;
    }, [props.currentNodeId, props.index, props.slashCommands, trigger]);

    const anchoredStyle = useAnchoredOverlay(menuRef, {
      anchorRect: trigger?.anchor ?? null,
      layoutKey: trigger ? `${trigger.kind}:${trigger.query}:${itemCount}` : 'closed',
      maxHeight: 260,
      placement: 'bottom-start',
      width: 260,
    });

    useImperativeHandle(ref, () => ({
      clear() {
        const view = viewRef.current;
        if (!view) return;
        const state = emptyEditorState();
        view.updateState(state);
        triggerRef.current = null;
        setTrigger(null);
        setIsEmpty(true);
        propsRef.current.onChange(EMPTY_DRAFT);
      },
      focus() {
        viewRef.current?.focus();
      },
      insertFileReferences(refs) {
        const view = viewRef.current;
        if (!view || refs.length === 0) return;
        const range = { from: view.state.selection.from, to: view.state.selection.to };
        insertFileReferenceNodes(view, range, refs);
        syncDraft(view);
        updateTrigger(view);
        view.focus();
      },
      removeFileReferences(attachmentIds) {
        const view = viewRef.current;
        if (!view || attachmentIds.length === 0) return;
        removeFileReferenceNodes(view, new Set(attachmentIds));
        syncDraft(view);
        updateTrigger(view);
      },
      restore(snapshot) {
        const view = viewRef.current;
        if (!view) return;
        view.updateState(editorStateFromSnapshot(snapshot));
        syncDraft(view);
        updateTrigger(view);
        view.focus();
      },
      setPlainText(text) {
        const view = viewRef.current;
        if (!view) return;
        view.updateState(editorStateFromText(text));
        const docSize = view.state.doc.content.size;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.max(1, docSize - 1))));
        syncDraft(view);
        updateTrigger(view);
        view.focus();
      },
      snapshot() {
        const view = viewRef.current;
        return view ? { doc: view.state.doc.toJSON() } : null;
      },
    }));

    useEffect(() => {
      setSelectedIndex(0);
    }, [trigger?.kind, trigger?.query, itemCount]);

    useEffect(() => {
      itemCountRef.current = itemCount;
    }, [itemCount]);

    useEffect(() => {
      selectedIndexRef.current = selectedIndex;
    }, [selectedIndex]);

    useEffect(() => {
      triggerRef.current = trigger;
    }, [trigger]);

    useEffect(() => {
      setSelectedIndex((current) => itemCount === 0 ? 0 : Math.min(current, itemCount - 1));
    }, [itemCount]);

    useEffect(() => {
      const mount = mountRef.current;
      if (!mount) return;

      const view = new EditorView(mount, {
        attributes: {
          'aria-label': 'Agent message',
        },
        state: emptyEditorState(),
        dispatchTransaction(transaction) {
          const nextState = view.state.apply(transaction);
          view.updateState(nextState);
          if (transaction.docChanged) syncDraft(view);
          if (transaction.docChanged || transaction.selectionSet) updateTrigger(view);
        },
        handleDOMEvents: {
          click(_view, event) {
            const target = event.target instanceof HTMLElement
              ? event.target.closest<HTMLElement>('[data-agent-node-ref]')
              : null;
            const nodeId = target?.dataset.agentNodeRef;
            if (!nodeId) return false;
            event.preventDefault();
            event.stopPropagation();
            propsRef.current.onNodeReferenceClick(nodeId, nodeReferenceOpenOptionsFromClick(event));
            return true;
          },
          focus(viewInstance) {
            updateTrigger(viewInstance);
            return false;
          },
          blur() {
            window.setTimeout(() => {
              if (!menuRef.current?.matches(':hover')) {
                triggerRef.current = null;
                setTrigger(null);
              }
            }, 120);
            return false;
          },
          paste(viewInstance, event) {
            const files = Array.from((event as ClipboardEvent).clipboardData?.files ?? []);
            if (files.length === 0) return false;
            event.preventDefault();
            propsRef.current.onFilesPasted(files);
            return true;
          },
        },
        handleKeyDown(viewInstance, event) {
          if (event.isComposing || event.keyCode === 229) return false;
          const openTrigger = triggerRef.current;
          if (openTrigger) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedIndex((current) => nextMenuIndex(current, itemCountRef.current, 'down'));
              return true;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex((current) => nextMenuIndex(current, itemCountRef.current, 'up'));
              return true;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              triggerRef.current = null;
              setTrigger(null);
              return true;
            }
            if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
              const button = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')
                ?.[clampMenuIndex(selectedIndexRef.current, itemCountRef.current)];
              if (button) {
                event.preventDefault();
                button.click();
                return true;
              }
            }
          }

          if (propsRef.current.isStreaming && (event.metaKey || event.ctrlKey) && event.key === '.') {
            event.preventDefault();
            propsRef.current.onStop();
            return true;
          }

          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            propsRef.current.onSubmit();
            return true;
          }

          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            insertHardBreak(viewInstance);
            return true;
          }

          if (event.key === 'Backspace' || event.key === 'Delete') {
            return deleteAdjacentAtom(viewInstance, event.key);
          }

          return false;
        },
      });

      viewRef.current = view;
      propsRef.current.onChange(EMPTY_DRAFT);
      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    const menu = trigger ? (
      <PopoverListbox
        ref={menuRef}
        className="trigger-popover agent-composer-trigger-popover"
        label={trigger.kind === '/' ? 'Agent slash commands' : 'Agent reference suggestions'}
        preventMouseDown={false}
        style={anchoredStyle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {trigger.kind === '/'
          ? (
              <SlashMenu
                commands={props.slashCommands}
                query={trigger.query}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                onSelect={(command) => {
                  const view = viewRef.current;
                  if (!view) return;
                  replaceWithText(view, trigger, command.insertText);
                  syncDraft(view);
                  triggerRef.current = null;
                  setTrigger(null);
                  view.focus();
                }}
              />
            )
          : (
              <ReferenceMenu
                currentNodeId={props.currentNodeId}
                index={props.index}
                query={trigger.query}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                onSelectNode={(nodeId, title) => {
                  const view = viewRef.current;
                  if (!view) return;
                  replaceWithNodeReference(view, trigger, {
                    nodeId,
                    title,
                    color: inlineReferenceTextColor(nodeId, props.index) ?? '',
                  });
                  syncDraft(view);
                  triggerRef.current = null;
                  setTrigger(null);
                  view.focus();
                }}
              />
            )}
      </PopoverListbox>
    ) : null;

    return (
      <>
        <div
          ref={mountRef}
          className={`agent-composer-editor ${isEmpty ? 'is-empty' : ''}`}
          data-placeholder={props.placeholder}
        />
        {menu ? createPortal(menu, document.body) : null}
      </>
    );

    function syncDraft(view: EditorView) {
      const draft = docToDraft(view.state.doc);
      setIsEmpty(draft.empty);
      propsRef.current.onChange(draft);
    }

    function updateTrigger(view: EditorView) {
      const nextTrigger = resolveComposerTrigger(view);
      triggerRef.current = nextTrigger;
      setTrigger(nextTrigger);
    }
  },
);

function emptyEditorState(): EditorState {
  return EditorState.create({
    doc: agentComposerSchema.nodes.doc.create(null, agentComposerSchema.nodes.paragraph.create()),
    schema: agentComposerSchema,
  });
}

function editorStateFromText(text: string): EditorState {
  const nodes: PMNode[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line) nodes.push(agentComposerSchema.text(line));
    if (index < lines.length - 1) nodes.push(agentComposerSchema.nodes.hardBreak.create());
  });
  return EditorState.create({
    doc: agentComposerSchema.nodes.doc.create(
      null,
      agentComposerSchema.nodes.paragraph.create(null, nodes.length > 0 ? nodes : undefined),
    ),
    schema: agentComposerSchema,
  });
}

function editorStateFromSnapshot(snapshot: AgentComposerEditorSnapshot): EditorState {
  try {
    return EditorState.create({
      doc: agentComposerSchema.nodeFromJSON(snapshot.doc),
      schema: agentComposerSchema,
    });
  } catch {
    return emptyEditorState();
  }
}

function resolveComposerTrigger(view: EditorView): ComposerTrigger | null {
  const selection = view.state.selection;
  if (!selection.empty) return null;
  const parent = selection.$from.parent;
  const beforeCursor = parent.textBetween(0, selection.$from.parentOffset, '', '\n');
  const afterCursor = parent.textBetween(selection.$from.parentOffset, parent.content.size, '', '\n');
  const resolved = resolveEditorTriggerText({
    text: `${beforeCursor}${afterCursor}`,
    cursorOffset: beforeCursor.length,
  });
  if (!resolved || (resolved.kind !== '@' && resolved.kind !== '/')) return null;
  const length = resolved.to - resolved.from;
  const from = Math.max(1, selection.from - length);
  return {
    kind: resolved.kind,
    query: resolved.query,
    from,
    to: selection.from,
    anchor: caretAnchor(view),
  };
}

function caretAnchor(view: EditorView): ComposerTrigger['anchor'] {
  try {
    const rect = view.coordsAtPos(view.state.selection.from);
    return { left: rect.left, top: rect.top, bottom: rect.bottom };
  } catch {
    return null;
  }
}

function docToDraft(doc: PMNode): AgentComposerDraft {
  const paragraph = doc.firstChild;
  if (!paragraph) return EMPTY_DRAFT;
  let text = '';
  const nodeRefs: AgentComposerNodeReference[] = [];
  const fileRefs: AgentComposerFileReference[] = [];

  paragraph.forEach((child) => {
    if (child.isText) {
      text += child.text ?? '';
      return;
    }
    if (child.type.name === 'hardBreak') {
      text += '\n';
      return;
    }
    if (child.type.name === 'nodeReference') {
      const title = String(child.attrs.title ?? '') || 'Referenced node';
      const nodeId = String(child.attrs.targetNodeId ?? '');
      text += nodeId ? formatNodeReferenceMarker(title, nodeId) : title;
      if (nodeId) nodeRefs.push({ nodeId, title });
      return;
    }
    if (child.type.name === 'fileReference') {
      const attachmentId = String(child.attrs.attachmentId ?? '');
      const name = String(child.attrs.name ?? '') || 'file';
      const mimeType = String(child.attrs.mimeType ?? '');
      const sizeBytes = Number(child.attrs.sizeBytes ?? 0);
      text += `@${name}`;
      if (attachmentId) fileRefs.push({ attachmentId, name, mimeType, sizeBytes });
    }
  });

  return {
    empty: text.trim().length === 0 && nodeRefs.length === 0 && fileRefs.length === 0,
    fileRefs,
    nodeRefs: dedupeNodeRefs(nodeRefs),
    text,
  };
}

function dedupeNodeRefs(refs: AgentComposerNodeReference[]): AgentComposerNodeReference[] {
  const seen = new Set<NodeId>();
  const out: AgentComposerNodeReference[] = [];
  for (const ref of refs) {
    if (seen.has(ref.nodeId)) continue;
    seen.add(ref.nodeId);
    out.push(ref);
  }
  return out;
}

function replaceWithText(view: EditorView, range: Pick<ComposerTrigger, 'from' | 'to'>, text: string) {
  const tr = view.state.tr.insertText(text, range.from, range.to);
  const pos = Math.min(range.from + text.length, tr.doc.content.size - 1);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos)));
}

function replaceWithNodeReference(
  view: EditorView,
  range: Pick<ComposerTrigger, 'from' | 'to'>,
  ref: AgentComposerNodeReference & { color?: string },
) {
  const node = agentComposerSchema.nodes.nodeReference.create({
    targetNodeId: ref.nodeId,
    title: ref.title,
    color: ref.color ?? '',
  });
  const nodes = shouldInsertTrailingSpace(view.state.doc, range.to)
    ? [node, agentComposerSchema.text(' ')]
    : [node];
  let tr = view.state.tr.replaceWith(range.from, range.to, nodes);
  const insertedSize = nodes.reduce((sum, child) => sum + child.nodeSize, 0);
  const pos = Math.min(range.from + insertedSize, tr.doc.content.size - 1);
  tr = tr.setSelection(TextSelection.create(tr.doc, pos));
  view.dispatch(tr);
}

function shouldInsertTrailingSpace(doc: PMNode, position: number): boolean {
  const next = doc.textBetween(position, Math.min(position + 1, doc.content.size - 1), '', '\n');
  return next.length === 0 || !/^\s$/u.test(next);
}

function insertFileReferenceNodes(
  view: EditorView,
  range: { from: number; to: number },
  refs: AgentComposerFileReference[],
) {
  const addTrailingSpace = shouldInsertTrailingSpace(view.state.doc, range.to);
  const nodes = refs.flatMap((ref, index) => {
    const node = agentComposerSchema.nodes.fileReference.create({
      attachmentId: ref.attachmentId,
      name: ref.name,
      mimeType: ref.mimeType,
      sizeBytes: ref.sizeBytes,
    });
    return index === refs.length - 1 && !addTrailingSpace ? [node] : [node, agentComposerSchema.text(' ')];
  });
  let tr = view.state.tr.replaceWith(range.from, range.to, nodes);
  const insertedSize = nodes.reduce((sum, node) => sum + node.nodeSize, 0);
  const pos = Math.min(range.from + insertedSize, tr.doc.content.size - 1);
  tr = tr.setSelection(TextSelection.create(tr.doc, pos));
  view.dispatch(tr);
}

function insertHardBreak(view: EditorView) {
  const node = agentComposerSchema.nodes.hardBreak.create();
  let tr = view.state.tr.replaceSelectionWith(node);
  const pos = Math.min(view.state.selection.from + node.nodeSize, tr.doc.content.size - 1);
  tr = tr.setSelection(TextSelection.create(tr.doc, pos));
  view.dispatch(tr);
}

function removeFileReferenceNodes(view: EditorView, attachmentIds: ReadonlySet<string>) {
  const ranges: Array<{ from: number; to: number }> = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'fileReference' && attachmentIds.has(String(node.attrs.attachmentId ?? ''))) {
      ranges.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  if (ranges.length === 0) return;
  let tr = view.state.tr;
  for (const range of ranges.sort((left, right) => right.from - left.from)) {
    tr = tr.delete(range.from, range.to);
  }
  view.dispatch(tr);
}

function deleteAdjacentAtom(view: EditorView, key: string): boolean {
  const selection = view.state.selection;
  if (selection instanceof NodeSelection && isComposerAtom(selection.node)) {
    view.dispatch(view.state.tr.deleteSelection());
    return true;
  }
  if (!selection.empty) return false;
  const resolved = view.state.doc.resolve(selection.from);
  if (key === 'Backspace' && isComposerAtom(resolved.nodeBefore)) {
    const from = selection.from - resolved.nodeBefore.nodeSize;
    view.dispatch(view.state.tr.delete(from, selection.from));
    return true;
  }
  if (key === 'Delete' && isComposerAtom(resolved.nodeAfter)) {
    view.dispatch(view.state.tr.delete(selection.from, selection.from + resolved.nodeAfter.nodeSize));
    return true;
  }
  return false;
}

function isComposerAtom(node: PMNode | null | undefined): node is PMNode {
  return node?.type.name === 'nodeReference' || node?.type.name === 'fileReference';
}

function filterSlashCommands(commands: readonly AgentSlashCommandView[], query: string): AgentSlashCommandView[] {
  const normalized = query.trim().toLowerCase();
  const items = normalized
    ? commands.filter((command) => (
        command.label.toLowerCase().includes(normalized)
        || command.description?.toLowerCase().includes(normalized)
      ))
    : [...commands];
  return items.slice(0, 12);
}

function SlashMenu({
  commands,
  onSelect,
  query,
  selectedIndex,
  setSelectedIndex,
}: {
  commands: readonly AgentSlashCommandView[];
  onSelect: (command: AgentSlashCommandView) => void;
  query: string;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((current: number) => number)) => void;
}) {
  const items = filterSlashCommands(commands, query);
  if (items.length === 0) return <PopoverEmpty>No commands</PopoverEmpty>;
  return (
    <>
      {items.map((command, index) => (
        <PopoverListItem
          key={command.id}
          active={index === selectedIndex}
          icon={<CommandIcon size={ICON_SIZE.menu} />}
          iconClassName="popover-item-icon"
          label={(
            <>
              <span>{command.label}</span>
              {command.description ? <span className="popover-item-meta">{command.description}</span> : null}
            </>
          )}
          onClick={() => onSelect(command)}
          onMouseEnter={() => setSelectedIndex(index)}
        />
      ))}
    </>
  );
}

function ReferenceMenu({
  currentNodeId,
  index,
  onSelectNode,
  query,
  selectedIndex,
  setSelectedIndex,
}: {
  currentNodeId: NodeId | null;
  index: DocumentIndex;
  onSelectNode: (nodeId: NodeId, title: string) => void;
  query: string;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((current: number) => number)) => void;
}) {
  const items = referenceMenuItems(index, currentNodeId, query);
  if (items.length === 0) return <PopoverEmpty>No references</PopoverEmpty>;
  return (
    <>
      {items.map((item, itemIndex) => (
        <PopoverListItem
          key={item.key}
          active={itemIndex === selectedIndex}
          icon={<NodeReferenceMenuIcon index={index} node={item.node} />}
          iconClassName="popover-item-icon"
          label={(
            <>
              <span>{item.label}</span>
              {item.breadcrumb ? <span className="popover-item-meta">{item.breadcrumb}</span> : null}
            </>
          )}
          onClick={() => onSelectNode(item.id, item.label)}
          onMouseEnter={() => setSelectedIndex(itemIndex)}
        />
      ))}
    </>
  );
}

function referenceMenuItems(index: DocumentIndex, currentNodeId: NodeId | null, query: string) {
  if (!currentNodeId) return [];
  return referenceItems({
    currentNodeId,
    index,
    query,
  }).flatMap((item) => {
    if (item.type !== 'node' || item.disabledReason) return [];
    const node = index.byId.get(item.id);
    return [{
      type: 'node' as const,
      key: item.id,
      id: item.id,
      label: item.label || textOf(node),
      breadcrumb: item.breadcrumb,
      node,
    }];
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileExtensionLabel(name: string, mimeType: unknown): string {
  const extension = name.match(/\.([a-z0-9]{1,6})$/iu)?.[1];
  if (extension) return extension.toUpperCase();
  const type = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
  if (type.includes('pdf')) return 'PDF';
  if (type.includes('presentation') || type.includes('powerpoint')) return 'PPT';
  if (type.includes('spreadsheet') || type.includes('excel')) return 'XLS';
  if (type.includes('word')) return 'DOC';
  if (type.startsWith('image/')) return 'IMG';
  return 'FILE';
}
