import { useEffect, useRef, useState } from 'react';
import type { DocumentIndexStore } from '../../state/documentIndexStore';
import { ThreadComposerEditor, type ThreadComposerEditorHandle, type ThreadComposerDraftContent } from '../components/ThreadComposerEditor';
import { scheduledBriefContent, scheduledBriefText, scheduledFileReference } from './scheduledBriefEditor';
import { useT } from '../../i18n/I18nProvider';
import { textOf } from '../../ui/shared';
import { IconButton } from '../../ui/primitives/IconButton';
import { AddIcon, FolderIcon, CloseIcon, ICON_SIZE } from '../../ui/icons';
import { ComposerProjectMenu, type ComposerDraftProjectSelection } from '../projects/ComposerProjectMenu';
import type { ComposerProjectContext } from '../projects/ConversationControls';

interface Props {
  indexStore: DocumentIndexStore;
  value: string;
  disabled: boolean;
  active: boolean;
  projectContext: ComposerProjectContext;
  projectSelection: ComposerDraftProjectSelection;
  onChange: (text: string) => void;
  onValidityChange: (valid: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onError: (message: string) => void;
}

/** The Agent editing surface, adapted to persistent reference markup, not attachments. */
export function ScheduledBriefInput({ indexStore, value, disabled, active, projectContext, projectSelection, onChange, onValidityChange, onPendingChange, onError }: Props) {
  const messages = useT();
  const t = messages.agent.automations.editor;
  const addRef = useRef<HTMLButtonElement | null>(null);
  const projectRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<'add' | 'project' | null>(null);
  const editor = useRef<ThreadComposerEditorHandle | null>(null);
  const currentValue = useRef(value);
  const alive = useRef(true);
  const pickerPending = useRef(false);
  const [picking, setPicking] = useState(false);
  useEffect(() => { if (!active || disabled) setMenu(null); }, [active, disabled]);
  const title = (id: string) => textOf(indexStore.getCurrent().byId.get(id)) || t.unavailableReference;
  const initial = useRef<readonly ThreadComposerDraftContent[]>(scheduledBriefContent(value, title));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (value === currentValue.current) return;
    currentValue.current = value;
    editor.current?.setContent(scheduledBriefContent(value, title));
  }, [value, indexStore]);

  async function pickFiles() {
    if (disabled || pickerPending.current) return;
    pickerPending.current = true; setPicking(true); onPendingChange(true);
    try {
      if (!window.lin?.pickLocalFiles) throw new Error(t.pickerUnavailable);
      const result = await window.lin.pickLocalFiles({ maxFiles: 32 });
      if (!alive.current || result.canceled) return;
      editor.current?.insertFileReferences(result.files.map((file) => scheduledFileReference(file.path, file.name, file.entryKind)));
    } catch (error) { if (alive.current) onError(error instanceof Error ? error.message : String(error)); }
    finally { pickerPending.current = false; if (alive.current) { setPicking(false); onPendingChange(false); } }
  }

  return <div className="scheduled-brief-input"
    onDragOverCapture={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDropCapture={(event) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation(); onError(t.useSavedFile);
    }}>
    <ThreadComposerEditor ref={editor} ariaLabel={t.task} placeholder={t.placeholder} placeholderAtCaret indexStore={indexStore}
      initialContent={initial.current} disabled={disabled || picking} draftHistory inDialog submitOnEnter={false}
      currentNodeId={null} isStreaming={false} allowThreadReferences={false} allowSlashCommands={false}
      slashCommands={[]} recentLocalFiles={[]}
      onChange={(draft) => {
        try { const text = scheduledBriefText(draft.content); currentValue.current = text; onValidityChange(true); onChange(text); }
        catch (error) { onValidityChange(false); onError(error instanceof Error ? error.message : String(error)); }
      }}
      onLocalFileSearch={async (query) => {
        if (!window.lin?.searchLocalFiles) return [];
        const result = await window.lin.searchLocalFiles({ query, limit: 20 });
        return result.files;
      }}
      onLocalFileSelect={async (file) => scheduledFileReference(file.path, file.name, file.entryKind)}
      onLocalFilePreview={async (file) => file}
      onNodeReferenceClick={() => undefined} onThreadReferenceClick={() => undefined} onThreadReferenceSearch={async () => []}
      onFilesPasted={() => onError(t.useSavedFile)} onLargeTextPaste={() => { onError(t.longPaste); return null; }}
      onTextPasteRejected={() => onError(t.longPaste)} onSubmit={() => undefined} onStop={() => undefined} />
    <div className="scheduled-brief-toolbar">
      <IconButton ref={addRef} icon={AddIcon} label={messages.agent.projects.add} disabled={disabled || picking}
        aria-haspopup="menu" aria-expanded={menu === 'add'} onMouseDown={(event) => event.preventDefault()}
        onClick={() => setMenu((value) => value === 'add' ? null : 'add')} variant="composerTool" />
      {projectSelection.selectedLabel ? <div className="thread-location-chip" title={projectSelection.selectedLabel}>
        <span className="thread-location-icon"><FolderIcon size={ICON_SIZE.compact} />
          <IconButton icon={CloseIcon} label={t.removeProject} disabled={disabled || picking} variant="tabClose"
            onClick={() => { void Promise.resolve().then(() => projectSelection.onSelect(null)).catch((reason) => onError(String(reason))); }} />
        </span>
        <button ref={projectRef} className="thread-location-open" type="button" aria-label={messages.agent.projects.changeProject}
          aria-expanded={menu === 'project'} aria-haspopup="menu" disabled={disabled || picking}
          onClick={() => setMenu((value) => value === 'project' ? null : 'project')}>
          <span className="thread-location-project">{projectSelection.selectedLabel}</span>
        </button>
      </div> : null}
    </div>
    {active && menu ? <ComposerProjectMenu anchorRef={menu === 'project' ? projectRef : addRef} fallbackAnchorRef={addRef}
      pickerOnly={menu === 'project'} context={projectContext} draftSelection={projectSelection}
      attachmentDisabled={disabled || picking} onAttachment={() => void pickFiles()} onClose={() => setMenu(null)} /> : null}
  </div>;
}
