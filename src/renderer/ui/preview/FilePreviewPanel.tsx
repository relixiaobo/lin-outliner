import { useCallback } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { useT } from '../../i18n/I18nProvider';
import { BackIcon, ICON_SIZE, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import {
  FilePreviewGlyph,
  PreviewMessage,
  PreviewRenderer,
  canOpenPreviewSource,
  openPreviewSource,
  sourceMeta,
  sourceTitle,
  targetTitleFallback,
  usePreviewSource,
} from './previewRenderers';

interface FilePreviewPanelProps {
  canGoBack: boolean;
  onBack: () => void;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  target: PreviewTarget;
}

export function FilePreviewPanel({
  canGoBack,
  onBack,
  onOpenTarget,
  target,
}: FilePreviewPanelProps) {
  const t = useT();
  const labels = t.shell.filePreview;
  const state = usePreviewSource(target);

  const openOriginal = useCallback(() => {
    if (state.status !== 'ready') return;
    void openPreviewSource(state.source);
  }, [state]);

  const title = state.status === 'ready'
    ? sourceTitle(state.source)
    : target.label ?? targetTitleFallback(target);
  const meta = state.status === 'ready' ? sourceMeta(state.source, labels) : null;

  return (
    <section className="main-panel file-preview-panel" aria-label={title}>
      <header className="file-preview-header">
        <div className="file-preview-title-group">
          <div className="file-preview-title-row">
            {canGoBack ? (
              <IconButton
                className="file-preview-back"
                icon={BackIcon}
                label={t.nodePanel.previousPage}
                onClick={onBack}
                variant="panel"
              />
            ) : null}
            <FilePreviewGlyph source={state.status === 'ready' ? state.source : null} target={target} />
            <div className="file-preview-title-text">
              <h1 title={title}>{title}</h1>
              {meta ? <p>{meta}</p> : null}
            </div>
          </div>
        </div>
        {state.status === 'ready' && canOpenPreviewSource(state.source) ? (
          <ButtonControl className="file-preview-open-button" onClick={openOriginal}>
            <OpenIcon size={ICON_SIZE.menu} />
            <span>{labels.open}</span>
          </ButtonControl>
        ) : null}
      </header>

      <div className="file-preview-content">
        {state.status === 'loading' ? (
          <PreviewMessage>{labels.loading}</PreviewMessage>
        ) : state.status === 'missing' ? (
          <PreviewMessage>{state.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>
        ) : (
          <PreviewRenderer source={state.source} onOpenTarget={onOpenTarget} />
        )}
      </div>
    </section>
  );
}
