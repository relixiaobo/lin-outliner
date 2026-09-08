import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project, ProjectCatalogView } from '../../../core/agent/project';
import type { Thread } from '../projectionTypes';
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
  const [name, setName] = useState('');
  const [rootHint, setRootHint] = useState('');
  const close = () => { if (!busyRef.current) onClose(); };
  async function run(operation: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function edit(project: Project | 'new') {
    setEditing(project); setName(project === 'new' ? '' : project.name);
    setRootHint(project === 'new' ? '' : project.rootHint ?? ''); setError(null);
  }
  async function bind(project: Project | null) {
    if (!thread) return;
    const membership = view.memberships.find((entry) => entry.threadId === thread.id);
    if (!membership) throw new Error('Chat membership is unavailable; reopen Projects');
    await manageProject({ operation: 'bind', threadId: thread.id, projectId: project?.id ?? null,
      expectedRevision: project?.revision ?? null, expectedMembershipRevision: membership.revision });
    onClose();
  }
  return createPortal(<Dialog backdropClassName="confirm-dialog-backdrop" surfaceClassName="confirm-dialog project-dialog"
    labelledBy={titleId} onBackdropMouseDown={close} onEscapeKeyDown={close}
    focusKey={editing === 'new' ? 'new' : editing?.id ?? deleting?.id ?? 'list'}
    initialFocus={() => editing ? nameRef.current : null}>
    <h2 className="confirm-dialog-title" id={titleId}>{deleting ? t.remove : editing ? editing === 'new' ? t.new : t.edit : thread ? t.move : t.title}</h2>
    {deleting ? <>
      <p className="confirm-dialog-message">{deleting.name}</p>
      {deleting.rootHint ? <p className="project-path">{deleting.rootHint}</p> : null}
      <p className="confirm-dialog-message">{t.deleteHelp}</p>
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={() => setDeleting(null)} variant="ghost">{t.cancel}</Button>
        <Button disabled={busy} onClick={() => void run(async () => {
          await manageProject({ operation: 'delete', projectId: deleting.id, expectedRevision: deleting.revision });
          setDeleting(null);
        })} variant="danger">{t.remove}</Button>
      </div>
    </> : editing ? <form className="project-form" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        await manageProject(editing === 'new'
          ? { operation: 'create', name, rootHint: rootHint.trim() || null }
          : { operation: 'update', projectId: editing.id, expectedRevision: editing.revision, name, rootHint: rootHint.trim() || null });
        setEditing(null);
      });
    }}>
      <Field label={t.name}><Input ref={nameRef} label={t.name} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label={t.root}><Input label={t.root} value={rootHint} disabled={busy} onChange={(event) => setRootHint(event.target.value)} /></Field>
      <p className="confirm-dialog-message">{t.rootHelp}</p>
      <div className="confirm-dialog-actions">
        <Button disabled={busy} onClick={() => setEditing(null)} variant="ghost">{t.cancel}</Button>
        <Button disabled={busy || !name.trim()} type="submit" variant="primary">{t.save}</Button>
      </div>
    </form> : <>
      {thread ? <p className="confirm-dialog-message">{thread.name || thread.preview}<br />{t.membershipHelp}</p> : null}
      {catalogError ? <p className="automation-error" role="alert">{catalogError}</p> : unavailable ? <p role="status">{t.loading}</p> : <ul className="project-list">
        {thread ? <li><button className="project-list-open" onClick={() => void run(() => bind(null))} disabled={busy} type="button">{t.none}</button></li> : null}
        {view.projects.map((project) => <li className="project-list-row" key={project.id}>
          <button className="project-list-open" disabled={busy} type="button" onClick={() => thread ? void run(() => bind(project)) : edit(project)}>
            <span>{project.name}</span>{project.rootHint ? <small className="project-path">{project.rootHint}</small> : null}
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
    {error ? <p className="automation-error" role="alert">{error}</p> : null}
  </Dialog>, document.body);
}
