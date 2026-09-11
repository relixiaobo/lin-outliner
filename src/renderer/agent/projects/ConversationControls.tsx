import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project, ProjectCatalogView } from '../../../core/agent/project';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, CloseIcon, FolderIcon, WarningIcon, ICON_SIZE } from '../../ui/icons';
import { ComposerProjectMenu } from './ComposerProjectMenu';
import { IconButton } from '../../ui/primitives/IconButton';
import { Button } from '../../ui/primitives/Button';
import { Dialog } from '../../ui/primitives/Dialog';
import { selectConversationProject } from './recentProjects';
import { conversationLocationLabel } from './locationLabel';
import '../../styles/projects.css';

export interface ComposerProjectContext {
  readonly view: ProjectCatalogView;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onChooseProject: (mode: 'new' | Project) => void;
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
  const projectAnchor = useRef<HTMLButtonElement>(null);
  const removingRef = useRef(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const titleId = useId();
  const [menu, setMenu] = useState(false);
  const membership = context?.view.memberships.find((entry) => entry.threadId === threadId);
  const project = context?.view.projects.find((entry) => entry.id === membership?.projectId);
  const label = context ? conversationLocationLabel(threadId, context.view, t) : null;
  const folder = project?.primaryFolder ?? null;
  const close = () => { setActionError(null); (projectAnchor.current ?? anchor.current)?.focus(); };
  async function removeProject() {
    if (!context || removingRef.current) return;
    removingRef.current = true; setRemoving(true); setActionError(null); setPicker(false);
    try { await selectConversationProject(threadId, null, context.view); anchor.current?.focus(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { removingRef.current = false; setRemoving(false); }
  }
  return <>
    <IconButton icon={AddIcon} label={t.add} title={t.add} variant="composerTool" ref={anchor}
      aria-expanded={menu} aria-haspopup="menu" onClick={() => { setPicker(false); setMenu((current) => !current); }} />
    {label?.text ? <div className="thread-location-chip" title={label.detail} aria-busy={context?.loading || removing}>
      <span className="thread-location-icon">
        <FolderIcon size={ICON_SIZE.compact} />
        {membership?.projectId ? <IconButton icon={CloseIcon} label={t.removeFromChat} variant="tabClose"
          disabled={removing || !context || context.loading || !!context.error} onClick={() => void removeProject()} /> : null}
      </span>
      <button ref={projectAnchor} className="thread-location-open" type="button" aria-label={t.changeProject}
        title={t.changeProject} aria-expanded={picker} aria-haspopup="menu" disabled={removing}
        onClick={() => { setMenu(false); setPicker((current) => !current); }}>
      {label.project ? <span className="thread-location-project">{label.project}</span> : null}
      {label.project && label.location ? <span aria-hidden="true"> · </span> : null}
      {label.location ? <span className={`thread-location-folder${folder === null ? ' is-application-default' : ''}`}>{label.location}</span> : null}
      {label.unavailable ? <span className="thread-location-unavailable" role="img" aria-label={t.unavailable} title={t.unavailable}><WarningIcon size={ICON_SIZE.tiny} /></span> : null}
      </button>
    </div> : null}
    {menu ? <ComposerProjectMenu anchorRef={anchor} context={context} threadId={threadId}
      attachmentDisabled={attachmentDisabled} onAttachment={onAttachment} onClose={() => setMenu(false)} /> : null}
    {picker ? <ComposerProjectMenu pickerOnly anchorRef={projectAnchor} fallbackAnchorRef={anchor} context={context} threadId={threadId}
      attachmentDisabled={attachmentDisabled} onAttachment={onAttachment} onClose={() => setPicker(false)} /> : null}
    {actionError ? createPortal(<Dialog labelledBy={titleId} backdropClassName="confirm-dialog-backdrop"
      surfaceClassName="confirm-dialog project-dialog" onEscapeKeyDown={close} onBackdropMouseDown={close}>
      <h2 id={titleId} className="confirm-dialog-title">{t.removeFromChat}</h2>
      <p className="automation-error" role="alert">{actionError}</p>
      <div className="confirm-dialog-actions project-location-actions">
        <Button variant="ghost" onClick={close}>{t.close}</Button>
        <Button variant="primary" disabled={removing || !context || context.loading || !!context.error} onClick={() => void removeProject()}>{t.removeFromChat}</Button>
      </div>
    </Dialog>, document.body) : null}
  </>;
}
