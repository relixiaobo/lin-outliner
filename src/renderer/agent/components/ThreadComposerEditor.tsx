import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Fragment, Schema, Slice, type Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { sanitizeFileReferenceRef } from '../../../core/referenceMarkup';
import type { AgentSlashCommandView, NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { nextMenuIndex, clampMenuIndex } from '../../ui/interactions/menuNavigation';
import { resolveEditorTriggerText } from '../../ui/interactions/rowInteractions';
import { referenceItems } from '../../ui/outliner/ReferenceSelector';
import { referenceCandidateLabels, type ReferenceCandidateLabels } from '../../ui/interactions/referenceCandidates';
import { NodeReferenceMenuIcon } from '../../ui/outliner/NodeReferenceMenuIcon';
import { PopoverEmpty, PopoverListbox, PopoverListItem } from '../../ui/outliner/PopoverList';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import {
  CommandIcon,
  DatabaseIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  ICON_SIZE,
  PresentationIcon,
  type AppIcon,
} from '../../ui/icons';
import { textOf } from '../../ui/shared';
import {
  inlineFileIconKind,
  inlineFileMentionDomChildren,
  type InlineFileIconKind,
} from '../../ui/editor/inlineFileIcon';
import { inlineFilePreviewAttrs } from '../../ui/editor/inlineFilePreviewData';
import { inlineReferenceTextColor } from '../../ui/tags/tagColors';
import { useT } from '../../i18n/I18nProvider';
import {
  threadNodeReferenceOpenOptionsFromClick,
  type ThreadNodeReferenceOpenHandler,
} from '../threadReferences';

export interface ThreadComposerNodeReference {
  nodeId: NodeId;
  title: string;
}

export interface ThreadComposerFileReference {
  attachmentId: string;
  entryKind?: 'file' | 'directory';
  iconDataUrl?: string;
  name: string;
  path?: string;
  ref: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailDataUrl?: string;
}

export interface ThreadComposerLocalFileCandidate {
  entryKind: 'file' | 'directory';
  id: string;
  path: string;
  name: string;
  parentPath: string;
  mimeType: string;
  sizeBytes: number;
  lastModified: number;
  iconDataUrl?: string;
  thumbnailDataUrl?: string;
}

export interface ThreadComposerDraft {
  content: ThreadComposerDraftContent[];
  empty: boolean;
  fileRefs: ThreadComposerFileReference[];
  text: string;
}

export type ThreadComposerDraftContent =
  | { type: 'text'; text: string }
  | { type: 'nodeReference'; reference: ThreadComposerNodeReference }
  | { type: 'fileReference'; reference: ThreadComposerFileReference };

export interface ThreadComposerEditorSnapshot {
  doc: unknown;
}

export interface ThreadComposerEditorHandle {
  clear: () => void;
  focus: () => void;
  insertFileReferences: (refs: ThreadComposerFileReference[]) => void;
  insertNodeReference: (ref: ThreadComposerNodeReference) => void;
  removeFileReferences: (attachmentIds: readonly string[]) => void;
  restore: (snapshot: ThreadComposerEditorSnapshot) => void;
  setPlainText: (text: string) => void;
  snapshot: () => ThreadComposerEditorSnapshot | null;
}

interface ThreadComposerEditorProps {
  allowFileReferences?: boolean;
  allowNodeReferences?: boolean;
  allowSlashCommands?: boolean;
  currentNodeId: NodeId | null;
  disabled?: boolean;
  index: DocumentIndex;
  initialSnapshot?: ThreadComposerEditorSnapshot | null;
  initialText?: string;
  isStreaming: boolean;
  onChange: (draft: ThreadComposerDraft) => void;
  onFilesPasted: (files: File[]) => void;
  onLocalFilePreview: (file: ThreadComposerLocalFileCandidate) => Promise<ThreadComposerLocalFileCandidate | null>;
  onLocalFileSearch: (query: string) => Promise<ThreadComposerLocalFileCandidate[]>;
  onLocalFileSelect: (file: ThreadComposerLocalFileCandidate) => Promise<ThreadComposerFileReference | null>;
  onNodeReferenceClick: ThreadNodeReferenceOpenHandler;
  recentLocalFiles: readonly ThreadComposerLocalFileCandidate[];
  onStop: () => void;
  onSubmit: () => void;
  placeholder: string;
  slashCommands: readonly AgentSlashCommandView[];
  submitOnEnter?: boolean;
}

interface ComposerTrigger {
  kind: '@' | '/';
  mode: 'mention' | 'slash';
  query: string;
  from: number;
  to: number;
  anchor: { left: number; top: number; bottom: number } | null;
}

const EMPTY_DRAFT: ThreadComposerDraft = {
  content: [],
  empty: true,
  fileRefs: [],
  text: '',
};

const LOCAL_FILE_TRIGGER_PATTERN = /(?:^|\s)(@(本机文件|file|local|localfile)(?::|\s)?([^\n@]*))$/iu;
const LOCAL_FILE_SEARCH_DEBOUNCE_MS = 160;
const LOCAL_FILE_MIN_QUERY_LENGTH = 2;
const MAX_MENTION_NODES = 6;
const MAX_MENTION_FILES = 6;
const FILE_PREVIEW_POPOVER_GAP = 8;
const FILE_PREVIEW_POPOVER_HEIGHT = 112;
const FILE_PREVIEW_POPOVER_WIDTH = 156;

interface FilePreviewAnchorRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
}

type MentionMenuItem =
  | {
    kind: 'node';
    section: 'Recent' | 'Nodes';
    key: string;
    id: NodeId;
    label: string;
    breadcrumb?: string;
    node: ReturnType<DocumentIndex['byId']['get']>;
  }
  | {
    kind: 'file';
    section: 'Recent' | 'Files';
    key: string;
    file: ThreadComposerLocalFileCandidate;
  };

const threadComposerSchema = new Schema({
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
          class: 'inline-ref thread-composer-inline-ref',
          contenteditable: 'false',
          'data-inline-ref': String(node.attrs.targetNodeId ?? ''),
          'data-thread-node-ref': String(node.attrs.targetNodeId ?? ''),
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
        entryKind: { default: 'file' },
        iconDataUrl: { default: '' },
        name: { default: '' },
        path: { default: '' },
        ref: { default: '' },
        mimeType: { default: '' },
        sizeBytes: { default: 0 },
        thumbnailDataUrl: { default: '' },
      },
      toDOM(node) {
        const name = String(node.attrs.name ?? '') || 'file';
        const mimeType = String(node.attrs.mimeType ?? '');
        const entryKind = String(node.attrs.entryKind ?? '') === 'directory' || mimeType === 'inode/directory'
          ? 'directory'
          : 'file';
        const sizeBytes = Number(node.attrs.sizeBytes ?? 0);
        const detail = [
          name,
          entryKind === 'directory' ? 'Folder' : mimeType || null,
          Number.isFinite(sizeBytes) && sizeBytes > 0 ? formatBytes(sizeBytes) : null,
        ].filter(Boolean).join(' - ');
        const iconKind = inlineFileIconKind({ entryKind, mimeType, name });
        // A file mention speaks the shared `.inline-ref` mention language (same as a
        // node reference and the outliner); the leading icon is what marks it as a
        // file. See `inlineFileIcon.ts`.
        return [
          'span',
          {
            'aria-label': detail,
            class: 'inline-ref thread-composer-inline-ref',
            contenteditable: 'false',
            'data-thread-file-ref': String(node.attrs.attachmentId ?? ''),
            ...inlineFilePreviewAttrs({
              entryKind,
              iconDataUrl: String(node.attrs.iconDataUrl ?? ''),
              mimeType,
              name,
              path: String(node.attrs.path ?? ''),
              ref: String(node.attrs.ref ?? ''),
              sizeBytes,
              thumbnailDataUrl: String(node.attrs.thumbnailDataUrl ?? ''),
            }),
          },
          ...inlineFileMentionDomChildren(iconKind, name),
        ];
      },
    },
  },
});

export const ThreadComposerEditor = forwardRef<ThreadComposerEditorHandle, ThreadComposerEditorProps>(
  function ThreadComposerEditor(props, ref) {
    const t = useT();
    const mountRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const propsRef = useRef(props);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const itemCountRef = useRef(0);
    const selectedIndexRef = useRef(0);
    const triggerRef = useRef<ComposerTrigger | null>(null);
    const previewRequestIdsRef = useRef(new Set<string>());
    const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isEmpty, setIsEmpty] = useState(true);
    const [filePreviewThumbnails, setFilePreviewThumbnails] = useState<Record<string, string>>({});
    const [localFileSearch, setLocalFileSearch] = useState<{
      error: string | null;
      query: string;
      results: ThreadComposerLocalFileCandidate[];
      status: 'idle' | 'loading' | 'ready' | 'error';
    }>({ error: null, query: '', results: [], status: 'idle' });
    const [filePreviewAnchor, setFilePreviewAnchor] = useState<FilePreviewAnchorRect | null>(null);
    // The editor view is created once (empty-deps effect); read the latest aria-label
    // through a ref so a language switch is picked up on the next view creation
    // without recreating the editor (and losing in-progress draft state) on each render.
    const editorAriaLabelRef = useRef(t.agent.composer.editorAriaLabel);
    editorAriaLabelRef.current = t.agent.composer.editorAriaLabel;

    propsRef.current = props;
    const allowFileReferences = props.allowFileReferences ?? true;
    const allowNodeReferences = props.allowNodeReferences ?? true;
    const allowSlashCommands = props.allowSlashCommands ?? true;

    const rawMentionItems = useMemo(() => trigger?.mode === 'mention'
      ? mentionMenuItems({
          allowFileReferences,
          allowNodeReferences,
          currentNodeId: props.currentNodeId,
          index: props.index,
          localFileSearch,
          query: trigger.query,
          recentLocalFiles: props.recentLocalFiles,
          labels: referenceCandidateLabels(t),
        })
      : [], [
        allowFileReferences,
        allowNodeReferences,
        localFileSearch,
        props.currentNodeId,
        props.index,
        props.recentLocalFiles,
        trigger?.mode,
        trigger?.query,
        t,
      ]);
    const mentionItems = useMemo(
      () => applyMentionFilePreviewThumbnails(rawMentionItems, filePreviewThumbnails),
      [filePreviewThumbnails, rawMentionItems],
    );

    const itemCount = useMemo(() => {
      if (!trigger) return 0;
      if (trigger.mode === 'slash') {
        return allowSlashCommands ? filterSlashCommands(props.slashCommands, trigger.query).length : 0;
      }
      return mentionItems.length;
    }, [allowSlashCommands, mentionItems.length, props.slashCommands, trigger]);

    const anchoredStyle = useAnchoredOverlay(menuRef, {
      anchorRect: trigger?.anchor ?? null,
      layoutKey: trigger ? `${trigger.kind}:${trigger.mode}:${trigger.query}:${itemCount}` : 'closed',
      maxHeight: trigger?.mode === 'mention' ? 320 : 260,
      placement: 'bottom-start',
      width: 260,
    });
    const selectedMentionFile = trigger?.mode === 'mention'
      ? selectedMentionFileItem(mentionItems, selectedIndex)
      : null;
    const selectedPreviewFile = selectedMentionFile?.thumbnailDataUrl && isImagePreviewFile(selectedMentionFile)
      ? selectedMentionFile
      : null;
    const filePreviewStyle = selectedPreviewFile && filePreviewAnchor
      ? mentionFilePreviewStyle(filePreviewAnchor)
      : undefined;

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
      insertNodeReference(ref) {
        const view = viewRef.current;
        if (!view) return;
        const range = { from: view.state.selection.from, to: view.state.selection.to };
        replaceWithNodeReference(view, range, {
          ...ref,
          color: inlineReferenceTextColor(ref.nodeId, propsRef.current.index) ?? '',
        });
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
    }, [trigger?.kind, trigger?.mode, trigger?.query, itemCount]);

    useEffect(() => {
      itemCountRef.current = itemCount;
    }, [itemCount]);

    useLayoutEffect(() => {
      if (!selectedMentionFile) {
        setFilePreviewAnchor(null);
        return;
      }
      const option = menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[selectedIndex];
      const rect = option?.getBoundingClientRect();
      if (!rect) {
        setFilePreviewAnchor(null);
        return;
      }
      setFilePreviewAnchor({
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      });
    }, [
      selectedIndex,
      selectedMentionFile?.id,
      itemCount,
      anchoredStyle?.left,
      anchoredStyle?.top,
    ]);

    useEffect(() => {
      selectedIndexRef.current = selectedIndex;
    }, [selectedIndex]);

    useEffect(() => {
      if (!selectedMentionFile || selectedMentionFile.thumbnailDataUrl || !isImagePreviewFile(selectedMentionFile)) return;
      if (previewRequestIdsRef.current.has(selectedMentionFile.id)) return;
      previewRequestIdsRef.current.add(selectedMentionFile.id);
      let canceled = false;
      propsRef.current.onLocalFilePreview(selectedMentionFile)
        .then((file) => {
          if (canceled || !file?.thumbnailDataUrl) return;
          setFilePreviewThumbnails((current) => current[file.id]
            ? current
            : { ...current, [file.id]: file.thumbnailDataUrl! });
        })
        .catch(() => {
          // Preview is optional; the list can still use the normal file icon.
        });
      return () => {
        canceled = true;
      };
    }, [selectedMentionFile?.id, selectedMentionFile?.thumbnailDataUrl]);

    useEffect(() => {
      if (!trigger || trigger.mode !== 'mention' || propsRef.current.allowFileReferences === false) {
        setLocalFileSearch((current) => current.status === 'idle'
          ? current
          : { error: null, query: '', results: [], status: 'idle' });
        return;
      }
      const query = trigger.query.trim();
      if (query.length < LOCAL_FILE_MIN_QUERY_LENGTH) {
        setLocalFileSearch({ error: null, query: trigger.query, results: [], status: 'idle' });
        return;
      }
      let canceled = false;
      setLocalFileSearch({ error: null, query: trigger.query, results: [], status: 'loading' });
      const timer = window.setTimeout(() => {
        propsRef.current.onLocalFileSearch(query)
          .then((results) => {
            if (canceled) return;
            setLocalFileSearch({ error: null, query: trigger.query, results, status: 'ready' });
          })
          .catch((error) => {
            if (canceled) return;
            setLocalFileSearch({
              error: error instanceof Error ? error.message : String(error),
              query: trigger.query,
              results: [],
              status: 'error',
            });
          });
      }, LOCAL_FILE_SEARCH_DEBOUNCE_MS);
      return () => {
        canceled = true;
        window.clearTimeout(timer);
      };
    }, [trigger?.mode, trigger?.query]);

    useEffect(() => {
      triggerRef.current = trigger;
    }, [trigger]);

    useEffect(() => {
      setSelectedIndex((current) => itemCount === 0 ? 0 : Math.min(current, itemCount - 1));
    }, [itemCount]);

    useEffect(() => {
      const mount = mountRef.current;
      if (!mount) return;

      const initialState = propsRef.current.initialSnapshot
        ? editorStateFromSnapshot(propsRef.current.initialSnapshot)
        : propsRef.current.initialText
          ? editorStateFromText(propsRef.current.initialText)
          : emptyEditorState();

      const view = new EditorView(mount, {
        attributes: {
          'aria-multiline': 'true',
          'aria-label': editorAriaLabelRef.current,
          role: 'textbox',
        },
        state: initialState,
        dispatchTransaction(transaction) {
          const nextState = view.state.apply(transaction);
          view.updateState(nextState);
          if (transaction.docChanged) syncDraft(view);
          if (transaction.docChanged || transaction.selectionSet) updateTrigger(view);
        },
        handleDOMEvents: {
          click(_view, event) {
            const target = event.target instanceof HTMLElement
              ? event.target.closest<HTMLElement>('[data-thread-node-ref]')
              : null;
            const nodeId = target?.dataset.threadNodeRef;
            if (!nodeId) return false;
            event.preventDefault();
            event.stopPropagation();
            propsRef.current.onNodeReferenceClick(nodeId, threadNodeReferenceOpenOptionsFromClick(event));
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
            if (propsRef.current.disabled) {
              event.preventDefault();
              return true;
            }
            const clipboard = (event as ClipboardEvent).clipboardData;
            const files = Array.from(clipboard?.files ?? []);
            if (files.length > 0) {
              event.preventDefault();
              propsRef.current.onFilesPasted(files);
              return true;
            }
            const text = clipboard?.getData('text/plain') ?? '';
            if (!text) return false;
            // This composer is a single paragraph that carries newlines as
            // hardBreaks (the same shape Shift+Enter produces). ProseMirror's
            // default paste splits text into paragraphs that the one-paragraph
            // schema then collapses to a single line, so we insert it ourselves
            // and map each newline to a hardBreak.
            event.preventDefault();
            insertPlainTextWithBreaks(viewInstance, text);
            return true;
          },
        },
        handleKeyDown(viewInstance, event) {
          if (propsRef.current.disabled) return true;
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
            if (propsRef.current.submitOnEnter === false) insertHardBreak(viewInstance);
            else propsRef.current.onSubmit();
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
      syncDraft(view);
      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.setProps({
        attributes: {
          'aria-multiline': 'true',
          'aria-label': editorAriaLabelRef.current,
          ...(props.disabled ? { 'aria-disabled': 'true' } : {}),
          role: 'textbox',
        },
        editable: () => !propsRef.current.disabled,
      });
      if (props.disabled) {
        triggerRef.current = null;
        setTrigger(null);
      }
    }, [props.disabled, t.agent.composer.editorAriaLabel]);

    const menu = trigger ? (
      <>
        <PopoverListbox
          ref={menuRef}
          className="trigger-popover thread-composer-trigger-popover"
          label={trigger.mode === 'slash'
            ? t.agent.composer.slashCommandsLabel
            : t.agent.composer.mentionSuggestionsLabel}
          preventMouseDown={false}
          style={anchoredStyle}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {trigger.mode === 'slash'
            ? (
                <SlashMenu
                  commands={props.slashCommands}
                  noCommandsLabel={t.agent.composer.noCommands}
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
                <MentionMenu
                  index={props.index}
                  items={mentionItems}
                  labels={{
                    couldNotSearchFiles: t.agent.composer.couldNotSearchFiles,
                    noMentions: t.agent.composer.noMentions,
                    noRecentMentions: t.agent.composer.noRecentMentions,
                    searchingFiles: t.agent.composer.searchingFiles,
                  }}
                  query={trigger.query}
                  search={localFileSearch}
                  selectedIndex={selectedIndex}
                  setSelectedIndex={setSelectedIndex}
                  onSelect={async (item) => {
                    const view = viewRef.current;
                    if (!view) return;
                    if (item.kind === 'node') {
                      replaceWithNodeReference(view, trigger, {
                        nodeId: item.id,
                        title: item.label,
                        color: inlineReferenceTextColor(item.id, props.index) ?? '',
                      });
                    } else {
                      const ref = await propsRef.current.onLocalFileSelect(item.file);
                      if (!ref) return;
                      insertFileReferenceNodes(view, trigger, [ref]);
                    }
                    syncDraft(view);
                    triggerRef.current = null;
                    setTrigger(null);
                    view.focus();
                  }}
                />
              )}
        </PopoverListbox>
        {selectedPreviewFile && filePreviewStyle ? (
          <MentionFilePreview file={selectedPreviewFile} style={filePreviewStyle} />
        ) : null}
      </>
    ) : null;

    return (
      <>
        <div
          ref={mountRef}
          className={`thread-composer-editor ${isEmpty ? 'is-empty' : ''}`}
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
      const nextTrigger = filterComposerTrigger(resolveComposerTrigger(view), propsRef.current);
      triggerRef.current = nextTrigger;
      setTrigger(nextTrigger);
    }
  },
);

function filterComposerTrigger(
  trigger: ComposerTrigger | null,
  props: ThreadComposerEditorProps,
): ComposerTrigger | null {
  if (!trigger) return null;
  if (trigger.mode === 'slash' && props.allowSlashCommands === false) return null;
  if (
    trigger.mode === 'mention'
    && props.allowNodeReferences === false
    && props.allowFileReferences === false
  ) {
    return null;
  }
  return trigger;
}

function emptyEditorState(): EditorState {
  return EditorState.create({
    doc: threadComposerSchema.nodes.doc.create(null, threadComposerSchema.nodes.paragraph.create()),
    schema: threadComposerSchema,
  });
}

// Map plain text to inline paragraph content: one text node per non-empty line,
// a hardBreak between consecutive lines. `\r\n?` is normalized first so CRLF text
// (pasted from another app, or a loaded draft) never leaves a stray carriage
// return inside a node.
function linesToInlineNodes(text: string): PMNode[] {
  const nodes: PMNode[] = [];
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  lines.forEach((line, index) => {
    if (line) nodes.push(threadComposerSchema.text(line));
    if (index < lines.length - 1) nodes.push(threadComposerSchema.nodes.hardBreak.create());
  });
  return nodes;
}

function editorStateFromText(text: string): EditorState {
  const nodes = linesToInlineNodes(text);
  return EditorState.create({
    doc: threadComposerSchema.nodes.doc.create(
      null,
      threadComposerSchema.nodes.paragraph.create(null, nodes.length > 0 ? nodes : undefined),
    ),
    schema: threadComposerSchema,
  });
}

function editorStateFromSnapshot(snapshot: ThreadComposerEditorSnapshot): EditorState {
  try {
    return EditorState.create({
      doc: threadComposerSchema.nodeFromJSON(snapshot.doc),
      schema: threadComposerSchema,
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
  const localFileTrigger = resolveLocalFileTrigger(beforeCursor, selection.from);
  if (localFileTrigger) return { ...localFileTrigger, anchor: caretAnchor(view) };
  const resolved = resolveEditorTriggerText({
    text: `${beforeCursor}${afterCursor}`,
    cursorOffset: beforeCursor.length,
  });
  if (!resolved || (resolved.kind !== '@' && resolved.kind !== '/')) return null;
  const length = resolved.to - resolved.from;
  const from = Math.max(1, selection.from - length);
  return {
    kind: resolved.kind,
    mode: resolved.kind === '/' ? 'slash' : 'mention',
    query: resolved.query,
    from,
    to: selection.from,
    anchor: caretAnchor(view),
  };
}

function resolveLocalFileTrigger(
  beforeCursor: string,
  selectionFrom: number,
): Omit<ComposerTrigger, 'anchor'> | null {
  const match = beforeCursor.match(LOCAL_FILE_TRIGGER_PATTERN);
  if (!match || match.index === undefined) return null;
  const triggerText = match[1] ?? '';
  const alias = match[2] ?? '';
  if (!triggerText || !alias) return null;
  const query = (match[3] ?? '').trim();
  const triggerStartTextOffset = match.index + match[0].length - triggerText.length;
  const triggerLength = beforeCursor.length - triggerStartTextOffset;
  return {
    kind: '@',
    mode: 'mention',
    query,
    from: Math.max(1, selectionFrom - triggerLength),
    to: selectionFrom,
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

function docToDraft(doc: PMNode): ThreadComposerDraft {
  const paragraph = doc.firstChild;
  if (!paragraph) return EMPTY_DRAFT;
  const content: ThreadComposerDraftContent[] = [];
  let text = '';
  const fileRefs: ThreadComposerFileReference[] = [];

  const appendText = (value: string) => {
    text += value;
    const previous = content.at(-1);
    if (previous?.type === 'text') previous.text += value;
    else content.push({ type: 'text', text: value });
  };

  paragraph.forEach((child) => {
    if (child.isText) {
      appendText(child.text ?? '');
      return;
    }
    if (child.type.name === 'hardBreak') {
      appendText('\n');
      return;
    }
    if (child.type.name === 'nodeReference') {
      const title = String(child.attrs.title ?? '') || 'Referenced node';
      const nodeId = String(child.attrs.targetNodeId ?? '');
      if (nodeId) content.push({ type: 'nodeReference', reference: { nodeId, title } });
      return;
    }
    if (child.type.name === 'fileReference') {
      const attachmentId = String(child.attrs.attachmentId ?? '');
      const name = String(child.attrs.name ?? '') || 'file';
      const path = String(child.attrs.path ?? '');
      const ref = sanitizeFileReferenceRef(String(child.attrs.ref ?? '') || name);
      const mimeType = String(child.attrs.mimeType ?? '');
      const iconDataUrl = String(child.attrs.iconDataUrl ?? '');
      const sizeBytes = Number(child.attrs.sizeBytes ?? 0);
      const thumbnailDataUrl = String(child.attrs.thumbnailDataUrl ?? '');
      const entryKind = String(child.attrs.entryKind ?? '') === 'directory' || mimeType === 'inode/directory'
        ? 'directory'
        : 'file';
      if (attachmentId) {
        const reference: ThreadComposerFileReference = {
          attachmentId,
          entryKind,
          ...(iconDataUrl ? { iconDataUrl } : {}),
          name,
          ...(path ? { path } : {}),
          ref,
          mimeType,
          sizeBytes,
          ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
        };
        fileRefs.push(reference);
        content.push({ type: 'fileReference', reference });
      }
    }
  });

  return {
    content,
    empty: text.trim().length === 0 && content.some((part) => part.type !== 'text') === false,
    fileRefs,
    text,
  };
}

function replaceWithText(view: EditorView, range: Pick<ComposerTrigger, 'from' | 'to'>, text: string) {
  const tr = view.state.tr.insertText(text, range.from, range.to);
  const pos = Math.min(range.from + text.length, tr.doc.content.size - 1);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos)));
}

function replaceWithNodeReference(
  view: EditorView,
  range: Pick<ComposerTrigger, 'from' | 'to'>,
  ref: ThreadComposerNodeReference & { color?: string },
) {
  const node = threadComposerSchema.nodes.nodeReference.create({
    targetNodeId: ref.nodeId,
    title: ref.title,
    color: ref.color ?? '',
  });
  const nodes = shouldInsertTrailingSpace(view.state.doc, range.to)
    ? [node, threadComposerSchema.text(' ')]
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
  refs: ThreadComposerFileReference[],
) {
  const addTrailingSpace = shouldInsertTrailingSpace(view.state.doc, range.to);
  const nodes = refs.flatMap((ref, index) => {
    const node = threadComposerSchema.nodes.fileReference.create({
      attachmentId: ref.attachmentId,
      entryKind: ref.entryKind ?? (ref.mimeType === 'inode/directory' ? 'directory' : 'file'),
      iconDataUrl: ref.iconDataUrl ?? '',
      name: ref.name,
      path: ref.path ?? '',
      ref: ref.ref,
      mimeType: ref.mimeType,
      sizeBytes: ref.sizeBytes,
      thumbnailDataUrl: ref.thumbnailDataUrl ?? '',
    });
    return index === refs.length - 1 && !addTrailingSpace ? [node] : [node, threadComposerSchema.text(' ')];
  });
  let tr = view.state.tr.replaceWith(range.from, range.to, nodes);
  const insertedSize = nodes.reduce((sum, node) => sum + node.nodeSize, 0);
  const pos = Math.min(range.from + insertedSize, tr.doc.content.size - 1);
  tr = tr.setSelection(TextSelection.create(tr.doc, pos));
  view.dispatch(tr);
}

function insertHardBreak(view: EditorView) {
  const node = threadComposerSchema.nodes.hardBreak.create();
  let tr = view.state.tr.replaceSelectionWith(node);
  const pos = Math.min(view.state.selection.from + node.nodeSize, tr.doc.content.size - 1);
  tr = tr.setSelection(TextSelection.create(tr.doc, pos));
  view.dispatch(tr);
}

// Inserts pasted plain text at the selection, mapping each newline to a
// hardBreak so multi-line content survives the single-paragraph schema. Mirrors
// how `editorStateFromText` builds the paragraph body from a draft string.
function insertPlainTextWithBreaks(view: EditorView, text: string): void {
  const nodes = linesToInlineNodes(text);
  if (nodes.length === 0) return;
  const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
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
  noCommandsLabel,
  onSelect,
  query,
  selectedIndex,
  setSelectedIndex,
}: {
  commands: readonly AgentSlashCommandView[];
  noCommandsLabel: string;
  onSelect: (command: AgentSlashCommandView) => void;
  query: string;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((current: number) => number)) => void;
}) {
  const items = filterSlashCommands(commands, query);
  if (items.length === 0) return <PopoverEmpty>{noCommandsLabel}</PopoverEmpty>;
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

function MentionMenu({
  index,
  items,
  labels,
  onSelect,
  query,
  search,
  selectedIndex,
  setSelectedIndex,
}: {
  index: DocumentIndex;
  items: MentionMenuItem[];
  labels: {
    couldNotSearchFiles: string;
    noMentions: string;
    noRecentMentions: string;
    searchingFiles: string;
  };
  onSelect: (item: MentionMenuItem) => void;
  query: string;
  search: {
    error: string | null;
    query: string;
    results: ThreadComposerLocalFileCandidate[];
    status: 'idle' | 'loading' | 'ready' | 'error';
  };
  selectedIndex: number;
  setSelectedIndex: (index: number | ((current: number) => number)) => void;
}) {
  const trimmedQuery = query.trim();
  if (items.length === 0) {
    if (trimmedQuery.length >= LOCAL_FILE_MIN_QUERY_LENGTH && search.status === 'loading') {
      return <PopoverEmpty>{labels.searchingFiles}</PopoverEmpty>;
    }
    if (trimmedQuery.length >= LOCAL_FILE_MIN_QUERY_LENGTH && search.status === 'error') {
      return <PopoverEmpty>{search.error ?? labels.couldNotSearchFiles}</PopoverEmpty>;
    }
    return <PopoverEmpty>{trimmedQuery ? labels.noMentions : labels.noRecentMentions}</PopoverEmpty>;
  }
  let previousSection: MentionMenuItem['section'] | null = null;
  return (
    <>
      {items.flatMap((item, itemIndex) => {
        const sectionHeader = item.section !== previousSection
          ? <div className="thread-composer-mention-section" key={`section-${item.section}`}>{item.section}</div>
          : null;
        previousSection = item.section;
        const option = (
          <PopoverListItem
            key={item.key}
            active={itemIndex === selectedIndex}
            icon={item.kind === 'node'
              ? <NodeReferenceMenuIcon index={index} node={item.node} />
              : <MentionFileIcon file={item.file} />}
            iconClassName="popover-item-icon"
            label={item.kind === 'node'
              ? (
                  <>
                    <span>{item.label}</span>
                    {item.breadcrumb ? <span className="popover-item-meta">{item.breadcrumb}</span> : null}
                  </>
                )
              : (
                    <>
                      <MiddleTruncatedFilename name={item.file.name} />
                      <span className="popover-item-meta">{item.file.parentPath}</span>
                    </>
                  )}
            {...(item.kind === 'file' ? { 'data-entry-kind': item.file.entryKind } : {})}
            onClick={() => onSelect(item)}
            onMouseEnter={() => setSelectedIndex(itemIndex)}
          />
        );
        return sectionHeader ? [sectionHeader, option] : [option];
      })}
      {trimmedQuery.length >= LOCAL_FILE_MIN_QUERY_LENGTH && search.status === 'loading' ? (
        <div className="thread-composer-mention-status">{labels.searchingFiles}</div>
      ) : null}
      {trimmedQuery.length >= LOCAL_FILE_MIN_QUERY_LENGTH && search.status === 'error' ? (
        <div className="thread-composer-mention-status">{search.error ?? labels.couldNotSearchFiles}</div>
      ) : null}
    </>
  );
}

function MentionFileIcon({ file }: { file: ThreadComposerLocalFileCandidate }) {
  if (file.thumbnailDataUrl && isImagePreviewFile(file)) {
    return (
      <img
        alt=""
        className="thread-composer-mention-file-native-icon is-thumbnail"
        data-file-icon="thumbnail"
        src={file.thumbnailDataUrl}
      />
    );
  }
  if (file.iconDataUrl) {
    return (
      <img
        alt=""
        className="thread-composer-mention-file-native-icon"
        data-file-icon="native"
        src={file.iconDataUrl}
      />
    );
  }
  const iconKind = inlineFileIconKind(file);
  const Icon = iconForLocalFileKind(iconKind);
  return <Icon data-file-icon={iconKind} size={ICON_SIZE.menu} />;
}

function MentionFilePreview({ file, style }: { file: ThreadComposerLocalFileCandidate; style: CSSProperties }) {
  if (!file.thumbnailDataUrl || !isImagePreviewFile(file)) return null;
  return (
    <div className="thread-composer-file-preview-popover" data-file-preview style={style}>
      <img alt="" src={file.thumbnailDataUrl} />
    </div>
  );
}

function selectedMentionFileItem(
  items: readonly MentionMenuItem[],
  selectedIndex: number,
): ThreadComposerLocalFileCandidate | null {
  const item = items[selectedIndex];
  if (!item || item.kind !== 'file') return null;
  return item.file;
}

function applyMentionFilePreviewThumbnails(
  items: readonly MentionMenuItem[],
  thumbnails: Record<string, string>,
): MentionMenuItem[] {
  if (items.length === 0 || Object.keys(thumbnails).length === 0) return [...items];
  return items.map((item) => {
    if (item.kind !== 'file' || item.file.thumbnailDataUrl) return item;
    const thumbnailDataUrl = thumbnails[item.file.id];
    return thumbnailDataUrl
      ? {
          ...item,
          file: {
            ...item.file,
            thumbnailDataUrl,
          },
        }
      : item;
  });
}

function mentionFilePreviewStyle(anchor: FilePreviewAnchorRect): CSSProperties {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const margin = 8;
  const rightSideLeft = anchor.right + FILE_PREVIEW_POPOVER_GAP;
  const previewLeft = rightSideLeft + FILE_PREVIEW_POPOVER_WIDTH + margin <= viewportWidth
    ? rightSideLeft
    : Math.max(margin, anchor.left - FILE_PREVIEW_POPOVER_WIDTH - FILE_PREVIEW_POPOVER_GAP);
  const previewTop = Math.min(
    Math.max(
      margin,
      anchor.top + (anchor.height / 2) - (FILE_PREVIEW_POPOVER_HEIGHT / 2),
    ),
    Math.max(margin, viewportHeight - FILE_PREVIEW_POPOVER_HEIGHT - margin),
  );
  return {
    left: previewLeft,
    position: 'fixed',
    top: previewTop,
    width: FILE_PREVIEW_POPOVER_WIDTH,
  };
}

function isImagePreviewFile(file: Pick<ThreadComposerLocalFileCandidate, 'entryKind' | 'mimeType' | 'name'>): boolean {
  if (file.entryKind === 'directory' || file.mimeType === 'inode/directory') return false;
  const mimeType = file.mimeType.toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  const extension = file.name.match(/\.([a-z0-9]{1,8})$/iu)?.[1]?.toLowerCase() ?? '';
  return ['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'].includes(extension);
}

function MiddleTruncatedFilename({ name }: { name: string }) {
  const parts = middleTruncateFilenameParts(name);
  return (
    <span className="thread-composer-file-name-middle" title={name}>
      <span className="thread-composer-file-name-start">{parts.start}</span>
      <span className="thread-composer-file-name-end">{parts.end}</span>
    </span>
  );
}

function middleTruncateFilenameParts(name: string): { start: string; end: string } {
  const normalizedName = name.trim();
  if (normalizedName.length <= 28) return { start: normalizedName, end: '' };
  const extensionMatch = normalizedName.match(/(\.[^.\s]{1,12})$/u);
  const extension = extensionMatch?.[1] ?? '';
  const stem = extension ? normalizedName.slice(0, -extension.length) : normalizedName;
  if (stem.length <= 24) return { start: normalizedName, end: '' };
  const tailStemLength = extension ? 5 : 8;
  return {
    start: stem.slice(0, -tailStemLength),
    end: `${stem.slice(-tailStemLength)}${extension}`,
  };
}

function iconForLocalFileKind(kind: InlineFileIconKind): AppIcon {
  if (kind === 'archive') return FileArchiveIcon;
  if (kind === 'audio') return FileAudioIcon;
  if (kind === 'code') return FileCodeIcon;
  if (kind === 'database') return DatabaseIcon;
  if (kind === 'folder') return FolderIcon;
  if (kind === 'image') return FileImageIcon;
  if (kind === 'presentation') return PresentationIcon;
  if (kind === 'spreadsheet') return FileSpreadsheetIcon;
  if (kind === 'video') return FileVideoIcon;
  return FileTextIcon;
}

function mentionMenuItems({
  allowFileReferences,
  allowNodeReferences,
  currentNodeId,
  index,
  localFileSearch,
  query,
  recentLocalFiles,
  labels,
}: {
  allowFileReferences: boolean;
  allowNodeReferences: boolean;
  currentNodeId: NodeId | null;
  index: DocumentIndex;
  localFileSearch: {
    query: string;
    results: ThreadComposerLocalFileCandidate[];
    status: 'idle' | 'loading' | 'ready' | 'error';
  };
  query: string;
  recentLocalFiles: readonly ThreadComposerLocalFileCandidate[];
  labels: ReferenceCandidateLabels;
}): MentionMenuItem[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [
      ...(allowNodeReferences
        ? recentNodeMenuItems(index, currentNodeId, MAX_MENTION_NODES, labels).map((item): MentionMenuItem => ({
            ...item,
            section: 'Recent',
          }))
        : []),
      ...(allowFileReferences
        ? recentLocalFiles.slice(0, MAX_MENTION_FILES).map((file): MentionMenuItem => ({
            kind: 'file',
            section: 'Recent',
            key: `file:${file.id}`,
            file,
          }))
        : []),
    ].slice(0, MAX_MENTION_NODES + MAX_MENTION_FILES);
  }
  const nodeItems = allowNodeReferences
    ? referenceMenuItems(index, currentNodeId, trimmedQuery, labels)
      .slice(0, MAX_MENTION_NODES)
      .map((item): MentionMenuItem => ({
        ...item,
        section: 'Nodes',
      }))
    : [];
  const fileItems = allowFileReferences && localFileSearch.query === query && localFileSearch.status === 'ready'
    ? localFileSearch.results.slice(0, MAX_MENTION_FILES).map((file): MentionMenuItem => ({
        kind: 'file',
        section: 'Files',
        key: `file:${file.id}`,
        file,
      }))
    : [];
  return [...nodeItems, ...fileItems];
}

function recentNodeMenuItems(index: DocumentIndex, currentNodeId: NodeId | null, limit: number, labels: ReferenceCandidateLabels) {
  return referenceMenuItems(index, currentNodeId, '', labels)
    .sort((left, right) => {
      const leftUpdatedAt = left.node?.updatedAt ?? 0;
      const rightUpdatedAt = right.node?.updatedAt ?? 0;
      return rightUpdatedAt - leftUpdatedAt;
    })
    .slice(0, limit);
}

function referenceMenuItems(index: DocumentIndex, currentNodeId: NodeId | null, query: string, labels: ReferenceCandidateLabels) {
  // The composer is not itself a node, so it has no "self" to exclude: the
  // focused/context node must stay mentionable, and node search must work even
  // with no current node. (The outliner keeps the default self-exclusion.)
  return referenceItems({
    currentNodeId,
    index,
    query,
    excludeCurrentNode: false,
    includeFileNodes: true,
    labels,
  }).flatMap((item) => {
    if (item.type !== 'node' || item.disabledReason) return [];
    const node = index.byId.get(item.id);
    return [{
      kind: 'node' as const,
      key: `node:${item.id}`,
      id: item.id,
      label: item.label || textOf(node) || labels.untitled,
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
