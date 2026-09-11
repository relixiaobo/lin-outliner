import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, AttachmentIcon, PencilIcon, CheckIcon, CloseIcon, ChevronRightIcon, FolderIcon, SearchIcon, ICON_SIZE } from '../../ui/icons';
import { Input } from '../../ui/primitives/Input';
import { isImeComposingEvent } from '../../ui/interactions/imeKeyboard';
import { MenuItem } from '../../ui/primitives/MenuItem';
import { MenuSurface } from '../../ui/primitives/MenuSurface';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { useFlyoutOverlay } from '../../ui/primitives/useFlyoutOverlay';
import { useMenuKeyboard } from '../../ui/primitives/useMenuKeyboard';
import type { ComposerProjectContext } from './ConversationControls';
import { recentProjects, selectConversationProject } from './recentProjects';
import type { Project } from '../../../core/agent/project';

export function ComposerProjectMenu({ anchorRef, context, threadId, attachmentDisabled, onAttachment, onClose, pickerOnly = false, fallbackAnchorRef }: {
  pickerOnly?: boolean;
  fallbackAnchorRef?: RefObject<HTMLButtonElement | null>;
  anchorRef: RefObject<HTMLButtonElement | null>;
  context?: ComposerProjectContext;
  threadId: string;
  attachmentDisabled: boolean;
  onAttachment: () => void;
  onClose: () => void;
}) {
  const strings = useT();
  const t = strings.agent.projects;
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [flyout, setFlyout] = useState(pickerOnly);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const closingRef = useRef(false);
  // Mark parent unmount before either menu restores focus, including trigger toggles.
  useLayoutEffect(() => {
    closingRef.current = false;
    return () => { closingRef.current = true; };
  }, []);
  const close = () => { closingRef.current = true; onClose(); };
  const closeRef = useRef(close);
  closeRef.current = close;
  const unavailable = !context || context.loading || !!context.error || !context.view.memberships.some((entry) => entry.threadId === threadId);
  const selected = context?.view.memberships.find((entry) => entry.threadId === threadId)?.projectId ?? null;
  const selectedProject = context?.view.projects.find((project) => project.id === selected);
  const recent = context ? recentProjects(context.view.projects, selected) : [];
  const recentIds = new Set(recent.map((project) => project.id));
  const projects = [...recent, ...(context?.view.projects ?? []).filter((project) => !recentIds.has(project.id))];
  const query = search.trim().toLocaleLowerCase();
  const filtered = projects.filter((project) => project.name.toLocaleLowerCase().includes(query));
  const style = useAnchoredOverlay(pickerOnly ? flyoutRef : menuRef, { anchorRef, placement: 'top-start', width: pickerOnly ? 240 : 208, maxHeight: 320 });
  const flyoutStyle = useFlyoutOverlay(flyoutRef, rowRef, flyout, 240, 'projects', `${filtered.map((entry) => entry.id).join(',')}:${error}`, 'right');
  const parentKeyboard = useMenuKeyboard({ surfaceRef: menuRef, onClose: close, kind: 'menu', active: !pickerOnly, getRestoreTarget: () => anchorRef.current });
  const childKeyboard = useMenuKeyboard({ surfaceRef: flyoutRef, onClose: close, kind: 'menu', active: flyout,
    getRestoreTarget: () => (closingRef.current ? anchorRef.current : rowRef.current ?? anchorRef.current) ?? fallbackAnchorRef?.current ?? null });
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || flyoutRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [anchorRef]);
  async function choose(project: Project | null) {
    if (busyRef.current || unavailable || !context) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await selectConversationProject(threadId, project, context.view); close(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const itemClass = 'thread-composer-model-item project-menu-item';
  return createPortal(<>
    {!pickerOnly ? <MenuSurface ref={menuRef} role="menu" aria-label={t.add} className="thread-composer-model-popover" style={style} onKeyDown={parentKeyboard.onKeyDown}>
      <MenuItem role="menuitem" className={itemClass} iconClassName="project-icon-slot" icon={<AttachmentIcon size={ICON_SIZE.compact} />} labelClassName="project-menu-label" label={strings.agent.thread.addAttachment} disabled={attachmentDisabled}
        onPointerEnter={() => setFlyout(false)} onFocus={() => setFlyout(false)} onClick={() => { close(); onAttachment(); }} />
      <div role="separator" className="project-menu-separator" />
      <MenuItem ref={rowRef} role="menuitem" className={itemClass} iconClassName="project-icon-slot" label={selectedProject?.name ?? t.chooseProject} title={selectedProject?.name} icon={<FolderIcon size={ICON_SIZE.compact} />} aria-haspopup="menu" aria-expanded={flyout}
        labelClassName="project-menu-label" meta={<ChevronRightIcon size={ICON_SIZE.compact} />}
        onPointerEnter={() => setFlyout(true)} onClick={() => setFlyout(true)} onKeyDown={(event) => {
          if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); setFlyout(true); }
        }} />
    </MenuSurface> : null}
    {flyout ? <MenuSurface ref={flyoutRef} role="menu" aria-label={t.chooseProject} aria-busy={busy}
      className="thread-composer-model-popover thread-composer-model-submenu project-picker-menu" style={pickerOnly ? style : flyoutStyle} onKeyDown={(event) => {
        if (isImeComposingEvent(event)) return;
        const inSearch = event.target instanceof HTMLInputElement;
        if (inSearch && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        if (inSearch && event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation();
          if (query && filtered[0]) void choose(filtered[0]);
        } else if (event.key === 'ArrowLeft' && !pickerOnly) { event.preventDefault(); event.stopPropagation(); setFlyout(false); }
        else {
          childKeyboard.onKeyDown(event);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            (document.activeElement as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
          }
        }
      }}>
      {projects.length > 0 ? <div className="project-menu-search">
        <span className="project-icon-slot"><SearchIcon size={ICON_SIZE.compact} /></span>
        <Input variant="bare" label={t.search} placeholder={t.search} value={search} onChange={(event) => setSearch(event.target.value)} />
      </div> : null}
      {projects.length > 0 ? <div className="project-menu-list">
      {filtered.map((project) => <MenuItem key={project.id} role="menuitemradio" aria-checked={selected === project.id} className={itemClass} iconClassName="project-icon-slot"
        icon={<FolderIcon size={ICON_SIZE.compact} />} label={project.name} labelClassName="project-menu-label" title={`${project.name}\n${project.primaryFolder ?? t.applicationDefault}`}
        meta={selected === project.id ? <CheckIcon size={ICON_SIZE.compact} /> : null} disabled={busy || unavailable} onClick={() => void choose(project)} />)}
      {!unavailable && filtered.length === 0 ? <p className="project-menu-status" role="status">{t.noResults}</p> : null}
      </div> : null}
      {unavailable ? <p className="project-menu-status" role="status">{context?.error ?? t.loading}</p> : null}
      {error ? <p className="project-menu-status" role="alert">{error}</p> : null}
      {projects.length > 0 || unavailable || error ? <div role="separator" className="project-menu-separator" /> : null}
      {selectedProject ? <MenuItem role="menuitem" className={itemClass} iconClassName="project-icon-slot" icon={<PencilIcon size={ICON_SIZE.compact} />} disabled={busy || unavailable} labelClassName="project-menu-label" label={t.edit} onClick={() => { close(); context?.onChooseProject(selectedProject); }} /> : null}
      <MenuItem role="menuitem" className={itemClass} iconClassName="project-icon-slot" icon={<AddIcon size={ICON_SIZE.compact} />} labelClassName="project-menu-label" label={t.new} disabled={busy || unavailable} onClick={() => { close(); context?.onChooseProject('new'); }} />
      {selected !== null ? <MenuItem role="menuitem" className={itemClass} iconClassName="project-icon-slot" icon={<CloseIcon size={ICON_SIZE.compact} />} labelClassName="project-menu-label" label={t.withoutProject}
        disabled={busy || unavailable} onClick={() => void choose(null)} /> : null}
    </MenuSurface> : null}
  </>, document.body);
}
