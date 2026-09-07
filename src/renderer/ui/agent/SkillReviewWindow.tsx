import { useEffect, useState } from 'react';
import type { SkillReview } from '../../../core/agent/skillOperations';
import { InstallReviewDialog, ManagedSkillActionDialog, UpdatePreviewDialog } from './ManagedSkillsSettings';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { Dialog } from '../primitives/Dialog';
import { Button } from '../primitives/Button';
import { useT } from '../../i18n/I18nProvider';

export function SkillReviewWindow() {
  const t = useT();
  const [review, setReview] = useState<SkillReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.lin!.skillReview.get().then((value) => { if (active) setReview(value); })
      .catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);
  const decide = (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    void window.lin!.skillReview.decide(approved).catch((cause) => { setError(String(cause)); setBusy(false); });
  };
  if (error || !review) return <div className="skill-review-window">
    <Dialog backdropClassName="confirm-dialog-backdrop" surfaceClassName="managed-skill-dialog"
      label={t.settings.skills.managedInstall} onEscapeKeyDown={() => window.close()}>
      <div />
      <div className="managed-skill-review-content">
        {error ? <ErrorState message={error} /> : <EmptyState title={t.settings.loading} loading role="status" />}
      </div>
      <div className="confirm-dialog-actions">
        <Button onClick={() => window.close()} variant="ghost">{t.dialog.cancel}</Button>
      </div>
    </Dialog>
  </div>;
  const common = { busy, error: null, onCancel: () => decide(false) };
  return <div className="skill-review-window">
    {review.kind === 'install' ? <InstallReviewDialog {...common} review={review} onInstall={() => decide(true)} />
      : review.kind === 'update' ? <UpdatePreviewDialog {...common} preview={review.preview} skillBody={review.skillBody} onApply={() => decide(true)} />
        : <ManagedSkillActionDialog {...common} action={review} onConfirm={() => decide(true)} />}
  </div>;
}
