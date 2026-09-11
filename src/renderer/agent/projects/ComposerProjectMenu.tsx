import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/I18nProvider';
import { CheckIcon, ChevronRightIcon, ICON_SIZE } from '../../ui/icons';
import { MenuItem } from '../../ui/primitives/MenuItem';
import { MenuSurface } from '../../ui/primitives/MenuSurface';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { useFlyoutOverlay } from '../../ui/primitives/useFlyoutOverlay';
import { useMenuKeyboard } from '../../ui/primitives/useMenuKeyboard';
import type { ComposerProjectContext } from './ConversationControls';
import { recentProjects, selectConversationProject } from './recentProjects';
import type { Project } from '../../../core/agent/project';

export function ComposerProjectMenu({ anchorRef, context, threadId, attachmentDisabled, onAttachment, onClose }: {
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
  const [flyout, setFlyout] = useState(false);
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
  const recent = context ? recentProjects(context.view.projects, selected) : [];
  const style = useAnchoredOverlay(menuRef, { anchorRef, placement: 'top-start', width: 208, maxHeight: 320 });
  const flyoutStyle = useFlyoutOverlay(flyoutRef, rowRef, flyout, 240, 'projects', `${recent.map((entry) => entry.id).join(',')}:${error}`, 'right');
  const parentKeyboard = useMenuKeyboard({ surfaceRef: menuRef, onClose: close, kind: 'menu', getRestoreTarget: () => anchorRef.current });
  const childKeyboard = useMenuKeyboard({ surfaceRef: flyoutRef, onClose: close, kind: 'menu', active: flyout,
    getRestoreTarget: () => closingRef.current ? anchorRef.current : rowRef.current ?? anchorRef.current });
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
  const itemClass = 'thread-composer-model-item';
  return createPortal(<>
    <MenuSurface ref={menuRef} role="menu" aria-label={t.add} className="thread-composer-model-popover" style={style} onKeyDown={parentKeyboard.onKeyDown}>
      <MenuItem role="menuitem" className={itemClass} label={strings.agent.thread.addAttachment} disabled={attachmentDisabled}
        onPointerEnter={() => setFlyout(false)} onFocus={() => setFlyout(false)} onClick={() => { close(); onAttachment(); }} />
      <div role="separator" className="project-menu-separator" />
      <MenuItem ref={rowRef} role="menuitem" className={itemClass} label={t.project} aria-haspopup="menu" aria-expanded={flyout}
        labelClassName="project-menu-label" meta={<ChevronRightIcon size={ICON_SIZE.compact} />}
        onPointerEnter={() => setFlyout(true)} onClick={() => setFlyout(true)} onKeyDown={(event) => {
          if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); setFlyout(true); }
        }} />
    </MenuSurface>
    {flyout ? <MenuSurface ref={flyoutRef} role="menu" aria-label={t.chooseProject} aria-busy={busy}
      className="thread-composer-model-popover thread-composer-model-submenu" style={flyoutStyle} onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); setFlyout(false); }
        else childKeyboard.onKeyDown(event);
      }}>
      <MenuItem role="menuitemradio" aria-checked={selected === null && !unavailable} className={itemClass} label={t.none}
        labelClassName="project-menu-label" meta={selected === null && !unavailable ? <CheckIcon size={ICON_SIZE.compact} /> : null}
        disabled={busy || unavailable} onClick={() => void choose(null)} />
      {recent.map((project) => <MenuItem key={project.id} role="menuitemradio" aria-checked={selected === project.id} className={itemClass}
        label={project.name} labelClassName="project-menu-label" title={`${project.name}\n${project.primaryFolder ?? t.applicationDefault}`}
        meta={selected === project.id ? <CheckIcon size={ICON_SIZE.compact} /> : null} disabled={busy || unavailable} onClick={() => void choose(project)} />)}
      {unavailable ? <p className="project-menu-status" role="status">{context?.error ?? t.loading}</p> : null}
      {error ? <p className="project-menu-status" role="alert">{error}</p> : null}
      <div role="separator" className="project-menu-separator" />
      <MenuItem role="menuitem" className={itemClass} label={t.allProjects} disabled={busy || unavailable} onClick={() => { close(); context?.onChooseProject(); }} />
      <MenuItem role="menuitem" className={itemClass} label={t.new} disabled={busy || unavailable} onClick={() => { close(); context?.onChooseProject('new'); }} />
    </MenuSurface> : null}
  </>, document.body);
}
