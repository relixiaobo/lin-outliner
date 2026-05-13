import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { CreateNodeTree, NodeId, NodeProjection } from '../../api/types';
import { EMPTY_RICH_TEXT } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { pmSchema } from '../editor/pmSchema';
import { richTextToDoc } from '../editor/richTextCodec';
import {
  resolveTrailingRowArrowDownIntent,
  resolveTrailingRowArrowUpIntent,
  resolveTrailingRowBackspaceIntent,
  resolveTrailingRowEnterIntent,
  resolveTrailingRowEscapeIntent,
  resolveTrailingRowUpdateAction,
} from '../interactions/rowInteractions';
import { filterFieldOptions, isOptionsFieldType, resolveFieldOptions } from '../interactions/fieldOptions';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { parseOutlinerPaste } from '../interactions/pasteParser';
import { NodeBulletDot } from './NodeBulletDot';
import type { TrailingTriggerKind } from './trailingTriggers';

interface TrailingInputProps {
  parentId: NodeId;
  index: DocumentIndex;
  expanded: Set<NodeId>;
  onCreate: (parentId: NodeId, text: string) => Promise<NodeId | null> | NodeId | null | void;
  onCreateTree?: (parentId: NodeId, nodes: CreateNodeTree[]) => Promise<unknown> | unknown;
  onUpdateCreated?: (nodeId: NodeId, text: string) => Promise<void> | void;
  onToggleCreated?: (nodeId: NodeId) => Promise<void> | void;
  onCreateTrigger?: (params: { parentId: NodeId; trigger: TrailingTriggerKind; text: string }) => Promise<void> | void;
  onCreateField?: (parentId: NodeId) => Promise<void> | void;
  onExpand?: (nodeId: NodeId) => void;
  onFocusNode?: (nodeId: NodeId) => void;
  onCollapseNode?: (nodeId: NodeId) => void;
  onNavigateOut?: (direction: 'up' | 'down') => void;
  onUndo?: () => void;
  onRedo?: () => void;
  optionField?: NodeProjection;
  onSelectOption?: (optionId: NodeId) => Promise<unknown> | unknown;
  onCreateOption?: (name: string) => Promise<unknown> | unknown;
}

function emptyDoc() {
  return richTextToDoc(EMPTY_RICH_TEXT, pmSchema);
}

function resetEditorContent(view: EditorView) {
  const doc = emptyDoc();
  let tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
  tr = tr.setMeta('addToHistory', false);
  tr = tr.setSelection(TextSelection.create(tr.doc, 1));
  view.dispatch(tr);
}

function getEditorText(view: EditorView): string {
  return view.state.doc.textContent;
}

function isPlainPrintableKey(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
  );
}

function lastVisibleDescendant(
  parentId: NodeId,
  index: DocumentIndex,
  expanded: Set<NodeId>,
): NodeId | null {
  const parent = index.byId.get(parentId);
  const lastChildId = parent?.children.filter((childId) => index.byId.has(childId)).at(-1);
  if (!lastChildId) return null;
  if (!expanded.has(lastChildId)) return lastChildId;
  return lastVisibleDescendant(lastChildId, index, expanded) ?? lastChildId;
}

export function TrailingInput(props: TrailingInputProps) {
  const [effectiveParentId, setEffectiveParentId] = useState(props.parentId);
  const [depthShift, setDepthShift] = useState(0);
  const [hasContent, setHasContent] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsQuery, setOptionsQuery] = useState('');
  const [optionsIndex, setOptionsIndex] = useState(0);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  const effectiveParentRef = useRef(props.parentId);
  const depthShiftRef = useRef(0);
  const committingRef = useRef(false);
  const composingRef = useRef(false);
  const eagerBufferRef = useRef('');
  const optionsStateRef = useRef({
    isOptionsField: false,
    optionsOpen: false,
    optionCount: 0,
    filteredOptions: [] as ReturnType<typeof filterFieldOptions>,
    optionsIndex: 0,
    canCreateOption: false,
    optionsQuery: '',
  });
  const isOptionsField = isOptionsFieldType(props.optionField?.fieldType);
  const allOptions = resolveFieldOptions(props.optionField, props.index.byId);
  const filteredOptions = filterFieldOptions(allOptions, optionsQuery);
  const canCreateOption = isOptionsField
    && Boolean(optionsQuery.trim())
    && props.optionField?.autocollectOptions !== false
    && !allOptions.some((option) => option.label.toLowerCase() === optionsQuery.trim().toLowerCase());
  const optionCount = filteredOptions.length + (canCreateOption ? 1 : 0);
  optionsStateRef.current = {
    isOptionsField,
    optionsOpen,
    optionCount,
    filteredOptions,
    optionsIndex,
    canCreateOption,
    optionsQuery,
  };

  propsRef.current = props;
  effectiveParentRef.current = effectiveParentId;
  depthShiftRef.current = depthShift;

  useEffect(() => {
    setEffectiveParentId(props.parentId);
    setDepthShift(0);
  }, [props.parentId]);

  useEffect(() => {
    setOptionsIndex(0);
  }, [optionsQuery, optionCount]);

  const resetEffectiveParent = () => {
    setEffectiveParentId(propsRef.current.parentId);
    setDepthShift(0);
  };

  const updateHasContent = (nextHasContent: boolean) => {
    setHasContent((current) => current === nextHasContent ? current : nextHasContent);
  };

  const createNode = async (parentId: NodeId, text: string) => (
    Promise.resolve(propsRef.current.onCreate(parentId, text))
  );

  const commitContent = async (view: EditorView, rawText: string, continueWithEmpty: boolean) => {
    if (committingRef.current) return;
    if (!continueWithEmpty && rawText.trim().length === 0) return;
    const targetParentId = effectiveParentRef.current;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    try {
      if (rawText.trim().length > 0) {
        await createNode(targetParentId, rawText);
      }
      if (continueWithEmpty) {
        await createNode(targetParentId, '');
      }
    } finally {
      committingRef.current = false;
    }
  };

  const createEagerNode = (view: EditorView, initialText: string) => {
    if (committingRef.current) return;
    const targetParentId = effectiveParentRef.current;
    committingRef.current = true;
    eagerBufferRef.current = initialText;
    resetEditorContent(view);
    updateHasContent(false);
    void createNode(targetParentId, initialText)
      .then(async (nodeId) => {
        const bufferedText = eagerBufferRef.current;
        if (nodeId && bufferedText !== initialText) {
          await propsRef.current.onUpdateCreated?.(nodeId, bufferedText);
        }
      })
      .finally(() => {
        committingRef.current = false;
        eagerBufferRef.current = '';
      });
  };

  const createDoneNode = async (view: EditorView, rawText: string) => {
    if (committingRef.current) return;
    const targetParentId = effectiveParentRef.current;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    try {
      const nodeId = await createNode(targetParentId, rawText);
      if (nodeId) {
        await propsRef.current.onToggleCreated?.(nodeId);
      }
    } finally {
      committingRef.current = false;
    }
  };

  const createField = (view: EditorView) => {
    if (committingRef.current || !propsRef.current.onCreateField) return;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    void Promise.resolve(propsRef.current.onCreateField(effectiveParentRef.current))
      .finally(() => {
        committingRef.current = false;
      });
  };

  const createTriggerNode = (view: EditorView, trigger: TrailingTriggerKind, text: string) => {
    if (committingRef.current || !propsRef.current.onCreateTrigger) return;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    void Promise.resolve(propsRef.current.onCreateTrigger({
      parentId: effectiveParentRef.current,
      trigger,
      text,
    })).finally(() => {
      committingRef.current = false;
    });
  };

  const closeOptions = () => {
    setOptionsOpen(false);
    setOptionsQuery('');
    setOptionsIndex(0);
  };

  const selectOption = (view: EditorView, optionId: NodeId) => {
    if (committingRef.current || !propsRef.current.onSelectOption) return;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    closeOptions();
    void Promise.resolve(propsRef.current.onSelectOption(optionId))
      .finally(() => {
        committingRef.current = false;
      });
  };

  const createOption = (view: EditorView) => {
    const name = optionsStateRef.current.optionsQuery.trim();
    if (committingRef.current || !name || !propsRef.current.onCreateOption) return;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    closeOptions();
    void Promise.resolve(propsRef.current.onCreateOption(name))
      .finally(() => {
        committingRef.current = false;
      });
  };

  const indentEffectiveParent = () => {
    const currentParentId = effectiveParentRef.current;
    const children = propsRef.current.index.byId.get(currentParentId)?.children ?? [];
    const lastChildId = children.filter((childId) => propsRef.current.index.byId.has(childId)).at(-1);
    if (!lastChildId) return;
    propsRef.current.onExpand?.(lastChildId);
    setEffectiveParentId(lastChildId);
    setDepthShift((current) => current + 1);
  };

  const outdentEffectiveParent = () => {
    if (effectiveParentRef.current === propsRef.current.parentId || depthShiftRef.current <= 0) return;
    const parentId = propsRef.current.index.byId.get(effectiveParentRef.current)?.parentId;
    if (!parentId) return;
    setEffectiveParentId(parentId);
    setDepthShift((current) => Math.max(0, current - 1));
  };

  const focusLastVisible = () => {
    const target = lastVisibleDescendant(effectiveParentRef.current, propsRef.current.index, propsRef.current.expanded);
    if (target) {
      propsRef.current.onFocusNode?.(target);
      return true;
    }
    return false;
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const view = new EditorView(mount, {
      state: EditorState.create({
        schema: pmSchema,
        doc: emptyDoc(),
      }),
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        if (!transaction.docChanged) return;

        const text = getEditorText(view);
        updateHasContent(text.length > 0);
        if (committingRef.current) return;

        const optionState = optionsStateRef.current;
        const action = resolveTrailingRowUpdateAction({
          text,
          isOptionsField: optionState.isOptionsField,
        });
        if (action.type === 'create_field') {
          createField(view);
          return;
        }
        if (action.type === 'create_trigger_node') {
          createTriggerNode(view, action.trigger as TrailingTriggerKind, action.matchText);
          return;
        }
        if (action.type === 'open_options') {
          setOptionsOpen(true);
          setOptionsQuery(action.query);
          return;
        }
        if (action.type === 'close_options') {
          closeOptions();
        }
      },
      handleDOMEvents: {
        paste(viewInstance, event) {
          const clipboardEvent = event as ClipboardEvent;
          const pastedText = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
          if (!pastedText.includes('\n')) return false;

          const parsed = parseOutlinerPaste(pastedText);
          if (parsed.length === 0) return false;

          clipboardEvent.preventDefault();
          if (committingRef.current) return true;
          committingRef.current = true;
          resetEditorContent(viewInstance);
          updateHasContent(false);
          void Promise.resolve(
            propsRef.current.onCreateTree
              ? propsRef.current.onCreateTree(effectiveParentRef.current, parsed)
              : Promise.all(parsed.map((node) => createNode(effectiveParentRef.current, node.content.text))),
          )
            .finally(() => {
              committingRef.current = false;
            });
          return true;
        },
        focus() {
          if (optionsStateRef.current.isOptionsField) {
            setOptionsOpen(true);
            setOptionsQuery('');
            setOptionsIndex(0);
          }
          return false;
        },
        blur(viewInstance) {
          composingRef.current = false;
          if (committingRef.current) return false;
          const text = getEditorText(viewInstance);
          if (text.trim().length > 0) {
            void commitContent(viewInstance, text, false).then(resetEffectiveParent);
            return false;
          }
          updateHasContent(false);
          closeOptions();
          resetEffectiveParent();
          return false;
        },
        compositionstart() {
          composingRef.current = true;
          return false;
        },
        compositionend(viewInstance) {
          composingRef.current = false;
          queueMicrotask(() => {
            if (committingRef.current || viewInstance.isDestroyed) return;
            const text = getEditorText(viewInstance);
            if (text.trim().length > 0) {
              void commitContent(viewInstance, text, false);
            }
          });
          return false;
        },
      },
      handleKeyDown(viewInstance, event) {
        if (isImeComposingEvent(event) || composingRef.current) return false;
        const mod = event.metaKey || event.ctrlKey;

        if (committingRef.current) {
          if (isPlainPrintableKey(event)) {
            event.preventDefault();
            eagerBufferRef.current += event.key;
          } else if (event.key === 'Backspace') {
            event.preventDefault();
            eagerBufferRef.current = eagerBufferRef.current.slice(0, -1);
          }
          return true;
        }

        if (mod && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) propsRef.current.onRedo?.();
          else propsRef.current.onUndo?.();
          return true;
        }

        if (mod && event.key.toLowerCase() === 'y') {
          event.preventDefault();
          propsRef.current.onRedo?.();
          return true;
        }

        if (
          getEditorText(viewInstance).length === 0
          && isPlainPrintableKey(event)
          && !['>', '#', '@', '/'].includes(event.key)
        ) {
          event.preventDefault();
          createEagerNode(viewInstance, event.key);
          return true;
        }

        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          void createDoneNode(viewInstance, getEditorText(viewInstance));
          return true;
        }

        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          const text = getEditorText(viewInstance);
          const intent = resolveTrailingRowEnterIntent({
            hasText: text.trim().length > 0,
            optionsOpen: optionsStateRef.current.optionsOpen,
            optionCount: optionsStateRef.current.optionCount,
          });
          if (intent === 'options_confirm') {
            const optionState = optionsStateRef.current;
            const option = optionState.filteredOptions[optionState.optionsIndex];
            if (option) selectOption(viewInstance, option.id);
            else if (optionState.canCreateOption) createOption(viewInstance);
            return true;
          }
          void commitContent(viewInstance, text, intent === 'create_content_and_continue' || intent === 'create_empty');
          return true;
        }

        if (event.key === 'Tab') {
          event.preventDefault();
          if (event.shiftKey) outdentEffectiveParent();
          else indentEffectiveParent();
          return true;
        }

        if (event.key === 'Backspace') {
          const text = getEditorText(viewInstance);
          const currentParentId = effectiveParentRef.current;
          const parentChildCount = propsRef.current.index.byId.get(currentParentId)?.children.length ?? 0;
          const target = lastVisibleDescendant(currentParentId, propsRef.current.index, propsRef.current.expanded);
          const intent = resolveTrailingRowBackspaceIntent({
            isEditorEmpty: text.length === 0,
            depthShifted: currentParentId !== propsRef.current.parentId,
            parentChildCount,
            hasLastVisibleTarget: Boolean(target),
          });

          if (intent === 'allow_default') return false;
          event.preventDefault();
          if (intent === 'reset_depth_shift') {
            resetEffectiveParent();
            return true;
          }
          if (intent === 'collapse_parent') {
            propsRef.current.onCollapseNode?.(currentParentId);
            propsRef.current.onFocusNode?.(currentParentId);
            return true;
          }
          if (intent === 'focus_last_visible' && target) {
            propsRef.current.onFocusNode?.(target);
          }
          return true;
        }

        if (event.key === 'ArrowUp') {
          const intent = resolveTrailingRowArrowUpIntent({
            hasLastVisibleTarget: Boolean(lastVisibleDescendant(effectiveParentRef.current, propsRef.current.index, propsRef.current.expanded)),
            hasNavigateOut: Boolean(propsRef.current.onNavigateOut),
            optionsOpen: optionsStateRef.current.optionsOpen,
            optionCount: optionsStateRef.current.optionCount,
          });
          if (intent === 'options_up') {
            event.preventDefault();
            setOptionsIndex((current) => Math.max(0, current - 1));
            return true;
          }
          if (intent === 'focus_last_visible') {
            event.preventDefault();
            focusLastVisible();
            return true;
          }
          if (intent === 'navigate_out_up') {
            event.preventDefault();
            propsRef.current.onNavigateOut?.('up');
            return true;
          }
        }

        if (event.key === 'ArrowDown') {
          const intent = resolveTrailingRowArrowDownIntent({
            hasNavigateOut: Boolean(propsRef.current.onNavigateOut),
            optionsOpen: optionsStateRef.current.optionsOpen,
            optionCount: optionsStateRef.current.optionCount,
          });
          if (intent === 'options_down') {
            event.preventDefault();
            setOptionsIndex((current) => Math.min(optionsStateRef.current.optionCount - 1, current + 1));
            return true;
          }
          if (intent === 'navigate_out_down') {
            event.preventDefault();
            propsRef.current.onNavigateOut?.('down');
            return true;
          }
        }

        if (event.key === 'Escape') {
          const intent = resolveTrailingRowEscapeIntent(optionsStateRef.current.optionsOpen);
          if (intent === 'close_options') {
            event.preventDefault();
            closeOptions();
            return true;
          }
          if (intent === 'blur_editor') {
            event.preventDefault();
            viewInstance.dom.blur();
            return true;
          }
        }

        return false;
      },
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  const wrapStyle: CSSProperties | undefined = depthShift > 0
    ? { marginLeft: `calc(var(--row-depth) * ${depthShift})` }
    : undefined;

  return (
    <div className="row control trailing-row" data-trailing-parent-id={effectiveParentId} style={wrapStyle}>
      <span className="row-leading trailing-leading">
        <span className="row-chevron-spacer" />
        <span className="row-bullet-button inert">
          <span className={`row-bullet-shape content ${hasContent ? '' : 'dimmed'}`}>
            <NodeBulletDot />
          </span>
        </span>
      </span>
      <div ref={mountRef} className="row-editor trailing-editor idle-hint" />
      {optionsOpen && isOptionsField && (
        <div className="node-picker-popover trailing-options-popover" onMouseDown={(event) => event.preventDefault()}>
          {optionCount === 0 && <div className="popover-empty">No options</div>}
          {filteredOptions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              className={`popover-item ${index === optionsIndex ? 'active' : ''}`}
              onMouseEnter={() => setOptionsIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const view = viewRef.current;
                if (view) selectOption(view, option.id);
              }}
            >
              <span className="command-item-bullet" />
              <span className="popover-item-label">{option.label}</span>
            </button>
          ))}
          {canCreateOption && (
            <button
              type="button"
              className={`popover-item ${optionsIndex === filteredOptions.length ? 'active' : ''}`}
              onMouseEnter={() => setOptionsIndex(filteredOptions.length)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const view = viewRef.current;
                if (view) createOption(view);
              }}
            >
              <span className="command-item-bullet" />
              <span className="popover-item-label">Create "{optionsQuery.trim()}"</span>
            </button>
          )}
        </div>
      )}
      <span />
    </div>
  );
}
