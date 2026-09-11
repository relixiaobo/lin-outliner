import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectCatalogView } from '../../../core/agent/project';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, WarningIcon, ICON_SIZE } from '../../ui/icons';
import { AnchoredActionMenu } from '../../ui/primitives/AnchoredActionMenu';
import { IconButton } from '../../ui/primitives/IconButton';
import { Button } from '../../ui/primitives/Button';
import { Dialog } from '../../ui/primitives/Dialog';
import { conversationLocationLabel } from './locationLabel';
import { manageProject } from './useProjectCatalog';
import '../../styles/projects.css';

export interface ComposerProjectContext {
  readonly view: ProjectCatalogView;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onChooseProject: () => void;
}

export function ConversationControls({ threadId, context, attachmentDisabled, onAttachment }: {
  readonly threadId: string;
  readonly context?: ComposerProjectContext;
  readonly attachmentDisabled: boolean;
  readonly onAttachment: () => void;
}) {
  const strings = useT();
  const t = strings.agent.projects;
  const anchor = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const folder = context?.view.workFolders.find((entry) => entry.threadId === threadId);
  const membership = context?.view.memberships.find((entry) => entry.threadId === threadId);
  const project = context?.view.projects.find((entry) => entry.id === membership?.projectId);
  const label = context ? conversationLocationLabel(threadId, context.view, t) : null;
  const unknown = context?.error ? t.unavailable : t.loading;
  const unavailable = !context || context.loading || Boolean(context.error) || !folder || !membership;
  const close = () => { if (!busyRef.current) { setDetails(false); anchor.current?.focus(); } };
  async function update(pick: boolean) {
    if (busyRef.current || !folder) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const path = pick ? (await api.agentCoreRequest('project/pickFolder', {})).path : null;
      if (pick && path === null) return;
      await manageProject({ operation: 'setWorkFolder', threadId, path, expectedRevision: folder.revision });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const openDetails = () => { setError(null); setDetails(true); };
  return <>
    <IconButton icon={AddIcon} label={t.add} title={t.add} variant="composerTool" ref={anchor}
      aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((current) => !current)} />
    {label?.text ? <button className="thread-location-chip" type="button" onClick={openDetails}
      aria-label={label.detail} title={label.detail} aria-busy={context?.loading}>
      {label.project ? <span className="thread-location-project">{label.project}</span> : null}
      {label.project && label.location ? <span aria-hidden="true"> · </span> : null}
      {label.location ? <span className={`thread-location-folder${folder?.path === null ? ' is-application-default' : ''}`}>{label.location}</span> : null}
      {label.unavailable ? <span className="thread-location-unavailable" role="img" aria-label={t.unavailable} title={t.unavailable}><WarningIcon size={ICON_SIZE.tiny} /></span> : null}
    </button> : null}
    {menu ? <AnchoredActionMenu anchorRef={anchor} onClose={() => setMenu(false)} ariaLabel={t.add}
      className="thread-composer-model-popover" actions={[
        { label: strings.agent.thread.addAttachment, disabled: attachmentDisabled, onSelect: onAttachment },
        { label: t.chooseProject, disabled: !context, onSelect: () => context?.onChooseProject() },
        { label: t.setWorkFolder, disabled: !context, onSelect: openDetails },
      ]} /> : null}
    {details ? createPortal(<Dialog labelledBy={titleId} backdropClassName="confirm-dialog-backdrop"
      surfaceClassName="confirm-dialog project-dialog" onEscapeKeyDown={close} onBackdropMouseDown={close}>
      <h2 id={titleId} className="confirm-dialog-title">{t.locationDetails}</h2>
      <p>{!membership ? unknown : project?.name ?? (membership.projectId ? t.unavailable : t.none)}</p>
      <p className="project-path">{folder ? folder.path ?? t.applicationDefault : unknown}</p>
      {folder?.path === null ? <p className="project-path">{context?.view.applicationDefault.path ?? t.unavailable}</p> : null}
      {folder?.path && context?.view.unavailableFolders.includes(folder.path)
        || folder?.path === null && context && !context.view.applicationDefault.available ? <p role="status">{t.unavailable}</p> : null}
      {project ? <><h3>{t.sourceFolders}</h3><ul className="project-list">{project.folders.map((path) => <li className="project-path" key={path}>
        {path}{path === project.primaryFolder ? ` · ${t.primary}` : ''}{context?.view.unavailableFolders.includes(path) ? ` · ${t.unavailable}` : ''}
      </li>)}</ul></> : null}
      {context?.loading ? <p role="status">{t.loading}</p> : null}
      {error || context?.error ? <p className="automation-error" role="alert">{error ?? context?.error}</p> : null}
      <div className="confirm-dialog-actions project-location-actions">
        <Button variant="ghost" disabled={busy} onClick={close}>{t.close}</Button>
        <Button variant="ghost" disabled={busy || !context} onClick={() => { close(); context?.onChooseProject(); }}>{t.chooseProject}</Button>
        <Button variant="ghost" disabled={busy || unavailable || folder?.path === null} onClick={() => void update(false)}>{t.clearWorkFolder}</Button>
        <Button disabled={busy || unavailable} onClick={() => void update(true)}>{t.setWorkFolder}</Button>
      </div>
    </Dialog>, document.body) : null}
  </>;
}
