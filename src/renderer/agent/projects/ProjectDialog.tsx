import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project, ProjectCatalogView } from '../../../core/agent/project';
import type { Thread } from '../projectionTypes';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, TrashIcon } from '../../ui/icons';
import { Dialog } from '../../ui/primitives/Dialog';
import { Button } from '../../ui/primitives/Button';
import { Input } from '../../ui/primitives/Input';
import { Field } from '../../ui/primitives/Field';
import { IconButton } from '../../ui/primitives/IconButton';
import { manageProject } from './useProjectCatalog';
import '../../styles/projects.css';

interface Props {
  readonly view: ProjectCatalogView;
  readonly thread: Thread | null;
  readonly unavailable: boolean;
  readonly catalogError: string | null;
  readonly createDisabled: boolean;
  readonly createTitle: string;
  readonly onClose: () => void;
  readonly onNewChat: (project: Project) => Promise<boolean>;
}

export function ProjectDialog({ view, thread, unavailable, catalogError, createDisabled, createTitle, onClose, onNewChat }: Props) {
  const t = useT().agent.projects;
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [selection, setSelection] = useState<{ project: Project | null } | null>(null);
  const [adoptPrimary, setAdoptPrimary] = useState(false);
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<readonly string[]>([]);
  const [primaryFolder, setPrimaryFolder] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const close = () => { if (!busyRef.current) onClose(); };
  async function run(operation: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function edit(project: Project | 'new') {
    setEditing(project); setName(project === 'new' ? '' : project.name);
    setFolders(project === 'new' ? [] : project.folders);
    setPrimaryFolder(project === 'new' ? null : project.primaryFolder); setError(null);
  }
  function select(project: Project | null) { setSelection({ project }); setAdoptPrimary(false); setError(null); }
  const currentFolder = view.workFolders.find((entry) => entry.threadId === thread?.id);
  async function bind() {
    if (!thread || !selection) return;
    const membership = view.memberships.find((entry) => entry.threadId === thread.id);
    if (!membership || !currentFolder) throw new Error('Conversation settings are unavailable; reopen Projects');
    const project = selection.project;
    await manageProject({ operation: 'bind', threadId: thread.id, projectId: project?.id ?? null,
      expectedRevision: project?.revision ?? null, expectedMembershipRevision: membership.revision,
      ...(adoptPrimary && project ? { workFolder: { path: project.primaryFolder, expectedRevision: currentFolder.revision } } : {}) });
    onClose();
  }
  return createPortal(<Dialog backdropClassName="confirm-dialog-backdrop" surfaceClassName="confirm-dialog project-dialog"
    labelledBy={titleId} onBackdropMouseDown={close} onEscapeKeyDown={close}
    focusKey={editing === 'new' ? 'new' : editing?.id ?? deleting?.id ?? (selection ? 'selection' : 'list')}
    initialFocus={() => editing ? nameRef.current : null}>
    <h2 className="confirm-dialog-title" id={titleId}>{deleting ? t.remove : editing ? editing === 'new' ? t.new : t.edit : thread ? t.chooseProject : t.title}</h2>
    {deleting ? <>
      <p className="confirm-dialog-message">{deleting.name}</p>
      {deleting.folders.map((path) => <p key={path} className="project-path">{path}</p>)}
      <p className="confirm-dialog-message">{t.deleteHelp}</p>
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={() => setDeleting(null)} variant="ghost">{t.cancel}</Button>
        <Button disabled={busy} onClick={() => void run(async () => {
          await manageProject({ operation: 'delete', projectId: deleting.id, expectedRevision: deleting.revision }); setDeleting(null);
        })} variant="danger">{t.remove}</Button>
      </div>
    </> : editing ? <form className="project-form" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        const result = await manageProject(editing === 'new'
          ? { operation: 'create', name, folders, primaryFolder }
          : { operation: 'update', projectId: editing.id, expectedRevision: editing.revision, name, folders, primaryFolder });
        setEditing(null);
        if (thread && result.project) select(result.project);
      });
    }}>
      <Field label={t.name}><Input ref={nameRef} label={t.name} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label={t.sourceFolders}><ul className="project-list">
        {folders.map((path) => <li className="project-list-row" key={path}>
          <span className="project-folder-path">{path}{view.unavailableFolders.includes(path) ? ` · ${t.unavailable}` : ''}</span>
          <Button size="sm" disabled={busy || primaryFolder === path} variant="ghost" onClick={() => setPrimaryFolder(path)}>{primaryFolder === path ? t.primary : t.makePrimary}</Button>
          <IconButton icon={TrashIcon} label={t.removeFolder} disabled={busy} variant="message" onClick={() => {
            setFolders((current) => current.filter((entry) => entry !== path));
            if (primaryFolder === path) setPrimaryFolder(null);
          }} />
        </li>)}
      </ul></Field>
      <Button disabled={busy || folders.length >= 20} variant="ghost" onClick={() => void run(async () => {
        const { path } = await api.agentCoreRequest('project/pickFolder', {});
        if (!path) return;
        if (folders.includes(path)) throw new Error(t.duplicateFolder);
        setFolders((current) => [...current, path]);
        if (!folders.length) { setPrimaryFolder(path); if (!name.trim()) setName(path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path); }
      })}>{t.addFolder}</Button>
      <p className="confirm-dialog-message">{folders.length ? primaryFolder ? t.rootHelp : t.choosePrimary : t.organizationOnly}</p>
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={() => setEditing(null)} variant="ghost">{t.cancel}</Button>
        <Button disabled={busy || !name.trim() || (folders.length > 0 && primaryFolder === null)} type="submit" variant="primary">{t.save}</Button>
      </div>
    </form> : selection ? <>
      <p>{selection.project?.name ?? t.none}</p>
      {selection.project ? <label className="project-list-row"><input type="checkbox" checked={adoptPrimary} onChange={(event) => setAdoptPrimary(event.target.checked)} disabled={busy} />{t.usePrimary}</label> : null}
      <p className="project-path">{t.workFolder}: {currentFolder ? (adoptPrimary ? selection.project?.primaryFolder : currentFolder.path) ?? t.applicationDefault : t.unavailable}</p>
      <p className="confirm-dialog-message">{t.membershipHelp}</p>
      <div className="confirm-dialog-actions"><Button disabled={busy} variant="ghost" onClick={() => setSelection(null)}>{t.back}</Button><Button disabled={busy || unavailable} variant="primary" onClick={() => void run(bind)}>{t.save}</Button></div>
    </> : <>
      <Input label={t.search} placeholder={t.search} value={search} onChange={(event) => setSearch(event.target.value)} />
      {catalogError ? <p className="automation-error" role="alert">{catalogError}</p> : unavailable ? <p role="status">{t.loading}</p> : <ul className="project-list">
        {thread ? <li><button className="project-list-open" onClick={() => select(null)} disabled={busy} type="button">{t.none}</button></li> : null}
        {view.projects.filter((project) => project.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((project) => <li className="project-list-row" key={project.id}>
          <button className="project-list-open" disabled={busy} type="button" onClick={() => thread ? select(project) : edit(project)}>
            <span>{project.name}</span><small className="project-path">{project.primaryFolder ?? t.organizationOnly}</small>
          </button>
          {!thread ? <>
            <IconButton icon={AddIcon} label={t.newChat} title={createDisabled ? createTitle : t.newChat} disabled={busy || createDisabled} variant="message" onClick={() => void run(async () => { if (await onNewChat(project)) onClose(); })} />
            <IconButton icon={TrashIcon} label={t.remove} disabled={busy} variant="message" onClick={() => setDeleting(project)} />
          </> : null}
        </li>)}
        {view.projects.length === 0 ? <li className="confirm-dialog-message">{t.empty}</li> : null}
      </ul>}
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={close} variant="ghost">{t.close}</Button>
        <Button disabled={busy || unavailable} onClick={() => edit('new')} variant="primary">{t.new}</Button>
      </div>
    </>}
    {catalogError && (editing || deleting || selection) ? <p className="automation-error" role="alert">{catalogError}</p> : null}
    {error ? <p className="automation-error" role="alert">{error}</p> : null}
  </Dialog>, document.body);
}
