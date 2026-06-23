import { useCallback, useMemo, useRef, useState } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { useT } from '../../i18n/I18nProvider';
import { BackIcon, ICON_SIZE, MoreIcon } from '../icons';
import { AnchoredActionMenu, type AnchoredMenuAction } from '../primitives/AnchoredActionMenu';
import { ButtonControl } from '../primitives/ButtonControl';
import {
  canOpenPreviewSource,
  canRevealPreviewSource,
  FilePreviewShell,
  openPreviewSource,
  revealPreviewSource,
  sourceTitle,
  targetTitleFallback,
  usePreviewSource,
} from '../preview/previewRenderers';
import { requestAddPreviewTargetToOutline } from '../preview/previewIngest';
import { dispatchAgentDockFilePreview } from './agentDockFilePreviewEvents';

interface AgentDockFilePreviewProps {
  onClose: () => void;
  target: PreviewTarget;
}

export function AgentDockFilePreview({ onClose, target }: AgentDockFilePreviewProps) {
  const t = useT();
  const labels = t.agent.filePreview;
  const state = usePreviewSource(target);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const title = state.status === 'ready'
    ? sourceTitle(state.source)
    : target.label ?? targetTitleFallback(target);
  const openOriginal = useCallback(() => {
    if (state.status !== 'ready') return;
    void openPreviewSource(state.source);
  }, [state]);
  const revealOriginal = useCallback(() => {
    if (state.status !== 'ready') return;
    void revealPreviewSource(state.source);
  }, [state]);
  const openNestedTarget = useCallback((nextTarget: PreviewTarget) => {
    dispatchAgentDockFilePreview({ target: nextTarget });
  }, []);
  const actions = useMemo<AnchoredMenuAction[]>(() => {
    const next: AnchoredMenuAction[] = [];
    if (state.status === 'ready' && canOpenPreviewSource(state.source)) {
      next.push({
        id: 'open-default',
        label: labels.openWithDefaultApp,
        onSelect: openOriginal,
      });
    }
    if (state.status === 'ready' && canRevealPreviewSource(state.source)) {
      next.push({
        id: 'reveal',
        label: labels.showInFinder,
        onSelect: revealOriginal,
      });
    }
    if (target.kind === 'local-file' && target.entryKind !== 'directory') {
      next.push({
        id: 'add-to-today',
        label: labels.addToToday,
        onSelect: () => {
          void requestAddPreviewTargetToOutline({ target });
        },
      });
    }
    return next;
  }, [labels.addToToday, labels.openWithDefaultApp, labels.showInFinder, openOriginal, revealOriginal, state, target]);

  return (
    <section className="agent-file-reader" aria-label={title}>
      <header className="agent-file-reader-header">
        <ButtonControl
          aria-label={labels.backToMessages}
          className="agent-file-reader-back"
          onClick={onClose}
          title={labels.backToMessages}
        >
          <BackIcon size={ICON_SIZE.toolbar} />
        </ButtonControl>
        <div className="agent-file-reader-title" title={title}>{title}</div>
        {actions.length > 0 ? (
          <>
            <ButtonControl
              ref={menuTriggerRef}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label={labels.menuLabel}
              className="agent-file-reader-menu-button"
              onClick={() => setMenuOpen((open) => !open)}
              title={labels.menuLabel}
            >
              <MoreIcon size={ICON_SIZE.toolbar} />
            </ButtonControl>
            {menuOpen ? (
              <AnchoredActionMenu
                actions={actions}
                anchorRef={menuTriggerRef}
                ariaLabel={labels.menuLabel}
                className="node-context-menu agent-file-reader-menu"
                itemClassName="node-context-item"
                onClose={() => setMenuOpen(false)}
                width={220}
              />
            ) : null}
          </>
        ) : null}
      </header>
      <div className="agent-file-reader-body">
        <FilePreviewShell
          state={state}
          onOpenTarget={openNestedTarget}
          initialExpanded
          readerMode
        />
      </div>
    </section>
  );
}
