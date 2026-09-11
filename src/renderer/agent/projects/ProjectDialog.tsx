import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project, ProjectCatalogView } from '../../../core/agent/project';
import type { Thread } from '../projectionTypes';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, CloseIcon, FolderIcon, TrashIcon, WarningIcon, ICON_SIZE } from '../../ui/icons';
import { Dialog } from '../../ui/primitives/Dialog';
import { Button } from '../../ui/primitives/Button';
import { Input } from '../../ui/primitives/Input';
import { Field } from '../../ui/primitives/Field';
import { IconButton } from '../../ui/primitives/IconButton';
import { manageProject } from './useProjectCatalog';
import { selectConversationProject } from './recentProjects';
import '../../styles/projects.css';

interface Props {
  readonly initialMode: 'new' | Project;
  readonly view: ProjectCatalogView;
  readonly thread: Thread;
  readonly unavailable: boolean;
  readonly catalogError: string | null;
  readonly onClose: () => void;
  readonly restoreFocus: (deleted: boolean) => HTMLElement | null;
}

export function ProjectDialog({ initialMode, view, thread, unavailable, catalogError, onClose, restoreFocus }: Props) {
  const t = useT().agent.projects;
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const deletedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Project | 'new' | null>(initialMode);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [selection, setSelection] = useState<{ project: Project | null } | null>(null);
  const [name, setName] = useState(typeof initialMode === 'object' ? initialMode.name : '');
  const [folders, setFolders] = useState<readonly string[]>(typeof initialMode === 'object' ? initialMode.folders : []);
  const [primaryFolder, setPrimaryFolder] = useState<string | null>(typeof initialMode === 'object' ? initialMode.primaryFolder : null);
  const feedback = <>
    {catalogError ? <p className="automation-error" role="alert">{catalogError}</p> : null}
    {error ? <p className="automation-error" role="alert">{error}</p> : null}
  </>;
  const close = () => { if (!busyRef.current) onClose(); };
  async function run(operation: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function select(project: Project | null) {
    if (unavailable) return;
    setSelection({ project });
    await selectConversationProject(thread.id, project, view);
    onClose();
  }
  const addFolder = () => void run(async () => {
    const { paths } = await api.agentCoreRequest('project/pickFolders', {});
    const additions = [...new Set(paths)].filter((path) => !folders.includes(path));
    if (!additions.length) return;
    if (folders.length + additions.length > 20) throw new Error(t.folderLimit);
    setFolders((current) => [...current, ...additions]);
    if (!folders.length) {
      const first = additions[0]!;
      setPrimaryFolder(first);
      if (!name.trim()) setName(first.split(/[\\/]/u).filter(Boolean).at(-1) ?? first);
    }
  });
  return createPortal(<Dialog backdropClassName="confirm-dialog-backdrop" surfaceClassName="confirm-dialog project-dialog"
    labelledBy={titleId} onBackdropMouseDown={close} onEscapeKeyDown={close}
    focusKey={deleting ? `delete:${deleting.id}` : editing === 'new' ? 'new' : editing?.id ?? 'selection'}
    initialFocus={() => editing && !deleting ? nameRef.current : null} restoreFocus={() => restoreFocus(deletedRef.current)}>
    <div className="project-dialog-header">
    <h2 className="confirm-dialog-title" id={titleId}>{deleting ? t.remove : editing ? editing === 'new' ? t.create : t.edit : t.chooseProject}</h2>
    <IconButton icon={CloseIcon} label={t.close} disabled={busy} variant="message" onClick={close} />
    </div>
    {deleting ? <>
      <p className="confirm-dialog-message">{deleting.name}</p>
      {deleting.folders.map((path) => <p key={path} className="project-path">{path}</p>)}
      <p className="confirm-dialog-message">{t.deleteHelp}</p>
      {feedback}
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={() => { setError(null); setDeleting(null); }} variant="ghost">{t.cancel}</Button>
        <Button disabled={busy || unavailable} onClick={() => void run(async () => {
          await manageProject({ operation: 'delete', projectId: deleting.id, expectedRevision: deleting.revision });
          deletedRef.current = true; onClose();
        })} variant="danger">{t.remove}</Button>
      </div>
    </> : editing ? <form className="project-form" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        const result = await manageProject(editing === 'new'
          ? { operation: 'create', name, folders, primaryFolder }
          : { operation: 'update', projectId: editing.id, expectedRevision: editing.revision, name, folders, primaryFolder });
        setEditing(null);
        if (editing === 'new' && thread && result.project) await select(result.project);
        else if (initialMode) onClose();
      });
    }}>
      <div className="project-name-input"><FolderIcon size={ICON_SIZE.menu} /><Input variant="bare" ref={nameRef} label={t.name} placeholder={t.projectName} value={name} disabled={busy || unavailable} onChange={(event) => setName(event.target.value)} /></div>
      <Field as="div" label={t.sourceFolders}>{folders.length ? <div className="project-source-folders"><ul className="project-list">
        {folders.map((path) => <li className="project-list-row" key={path}>
          <span className="project-icon-slot"><FolderIcon size={ICON_SIZE.compact} /></span>
          <span className="project-folder-path" title={path}>
            <span className="project-folder-parent">{path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)}</span>
            <span className="project-folder-name">{path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)}</span>
            {view.unavailableFolders.includes(path) ? <span className="project-folder-warning" role="img" aria-label={t.unavailable} title={t.unavailable}><WarningIcon size={ICON_SIZE.compact} /></span> : null}
          </span>
          <span className="project-primary-action">{primaryFolder === path ? <span className="project-primary-label">{t.primary}</span> : <Button size="sm" disabled={busy || unavailable} variant="ghost" onClick={() => setPrimaryFolder(path)}>{t.makePrimary}</Button>}</span>
          <IconButton icon={TrashIcon} label={t.removeFolder} disabled={busy || unavailable} variant="message" onClick={() => {
            setFolders((current) => current.filter((entry) => entry !== path));
            if (primaryFolder === path) setPrimaryFolder(null);
          }} />
        </li>)}
      </ul>
      <Button className="project-add-folder-action" disabled={busy || unavailable || folders.length >= 20} variant="ghost" onClick={addFolder}><span className="project-icon-slot"><AddIcon size={ICON_SIZE.compact} /></span><span>{t.addFolder}</span></Button>
      </div> : <button type="button" className="project-add-folders" aria-label={t.addFolder} disabled={busy || unavailable} onClick={addFolder}>
        <FolderIcon size={ICON_SIZE.large} /><span>{t.addFoldersHint}</span>
      </button>}</Field>
      {folders.length ? <p className="confirm-dialog-message">{primaryFolder ? t.rootHelp : t.choosePrimary}</p> : null}
      {feedback}
      <div className="confirm-dialog-actions project-form-actions">
        {editing !== 'new' ? <Button className="project-delete-action" disabled={busy || unavailable} variant="ghost" onClick={() => { setError(null); setDeleting(editing); }}>{t.remove}</Button> : null}
        <Button disabled={busy} onClick={close} variant="ghost">{t.cancel}</Button>
        <Button disabled={busy || unavailable || !name.trim() || (folders.length > 0 && primaryFolder === null)} type="submit" variant="primary">{editing === 'new' ? t.create : t.save}</Button>
      </div>
    </form> : <><p className="confirm-dialog-message">{selection?.project?.name}</p>{feedback}</>}
    {selection && error ? <Button disabled={busy || unavailable} onClick={() => void run(() => select(view.projects.find((project) => project.id === selection.project?.id) ?? selection.project))}>{t.retrySelection}</Button> : null}
  </Dialog>, document.body);
}
