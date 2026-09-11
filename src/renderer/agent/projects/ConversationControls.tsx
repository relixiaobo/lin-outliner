import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectCatalogView } from '../../../core/agent/project';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, WarningIcon, ICON_SIZE } from '../../ui/icons';
import { ComposerProjectMenu } from './ComposerProjectMenu';
import { IconButton } from '../../ui/primitives/IconButton';
import { Button } from '../../ui/primitives/Button';
import { Dialog } from '../../ui/primitives/Dialog';
import { conversationLocationLabel } from './locationLabel';
import '../../styles/projects.css';

export interface ComposerProjectContext {
  readonly view: ProjectCatalogView;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onChooseProject: (mode?: 'new') => void;
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
  const membership = context?.view.memberships.find((entry) => entry.threadId === threadId);
  const project = context?.view.projects.find((entry) => entry.id === membership?.projectId);
  const label = context ? conversationLocationLabel(threadId, context.view, t) : null;
  const folder = project?.primaryFolder ?? null;
  const locationKnown = membership && (!membership.projectId || project);
  const unknown = context?.error ? t.unavailable : t.loading;
  const close = () => { setDetails(false); anchor.current?.focus(); };
  const openDetails = () => setDetails(true);
  return <>
    <IconButton icon={AddIcon} label={t.add} title={t.add} variant="composerTool" ref={anchor}
      aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((current) => !current)} />
    {label?.text ? <button className="thread-location-chip" type="button" onClick={openDetails}
      aria-label={label.detail} title={label.detail} aria-busy={context?.loading}>
      {label.project ? <span className="thread-location-project">{label.project}</span> : null}
      {label.project && label.location ? <span aria-hidden="true"> · </span> : null}
      {label.location ? <span className={`thread-location-folder${folder === null ? ' is-application-default' : ''}`}>{label.location}</span> : null}
      {label.unavailable ? <span className="thread-location-unavailable" role="img" aria-label={t.unavailable} title={t.unavailable}><WarningIcon size={ICON_SIZE.tiny} /></span> : null}
    </button> : null}
    {menu ? <ComposerProjectMenu anchorRef={anchor} context={context} threadId={threadId}
      attachmentDisabled={attachmentDisabled} onAttachment={onAttachment} onClose={() => setMenu(false)} /> : null}
    {details ? createPortal(<Dialog labelledBy={titleId} backdropClassName="confirm-dialog-backdrop"
      surfaceClassName="confirm-dialog project-dialog" onEscapeKeyDown={close} onBackdropMouseDown={close}>
      <h2 id={titleId} className="confirm-dialog-title">{t.locationDetails}</h2>
      <p>{!membership ? unknown : project?.name ?? (membership.projectId ? t.unavailable : t.none)}</p>
      <p className="project-path">{locationKnown ? folder ?? t.applicationDefault : membership ? t.unavailable : unknown}</p>
      {locationKnown && folder === null ? <p className="project-path">{context?.view.applicationDefault.path ?? t.unavailable}</p> : null}
      {folder && context?.view.unavailableFolders.includes(folder)
        || folder === null && context && !context.view.applicationDefault.available ? <p role="status">{t.unavailable}</p> : null}
      {project ? <><h3>{t.sourceFolders}</h3><ul className="project-list">{project.folders.map((path) => <li className="project-path" key={path}>
        {path}{path === project.primaryFolder ? ` · ${t.primary}` : ''}{context?.view.unavailableFolders.includes(path) ? ` · ${t.unavailable}` : ''}
      </li>)}</ul></> : null}
      {context?.loading ? <p role="status">{t.loading}</p> : null}
      {context?.error ? <p className="automation-error" role="alert">{context.error}</p> : null}
      <div className="confirm-dialog-actions project-location-actions">
        <Button variant="ghost" onClick={close}>{t.close}</Button>
        <Button variant="ghost" disabled={!context || context.loading || !!context.error} onClick={() => { close(); context?.onChooseProject(); }}>{t.chooseProject}</Button>
      </div>
    </Dialog>, document.body) : null}
  </>;
}
