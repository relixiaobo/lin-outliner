import type { ReactNode } from 'react';
import { ICON_SIZE, WarningIcon, type AppIcon } from '../icons';
import { Button } from './Button';
import { cx } from './cx';

type FeedbackSize = 'inline' | 'panel';

interface EmptyStateProps {
  action?: ReactNode;
  body?: ReactNode;
  className?: string;
  icon?: AppIcon;
  iconClassName?: string;
  loading?: boolean;
  // 'presentation' lets a host (e.g. an empty outliner inside role="tree") keep
  // the placeholder from being announced as structural content.
  role?: 'status' | 'alert' | 'presentation';
  size?: FeedbackSize;
  title: ReactNode;
}

interface ErrorStateProps {
  className?: string;
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: ReactNode;
  size?: FeedbackSize;
}

export function EmptyState({
  action,
  body,
  className,
  icon: Icon,
  iconClassName,
  loading = false,
  role,
  size = 'panel',
  title,
}: EmptyStateProps) {
  const classes = cx(
    'feedback-state',
    `feedback-state-${size}`,
    loading && 'is-loading',
    className,
  );

  return (
    <div className={classes} role={role}>
      {Icon ? <Icon className={iconClassName} size={ICON_SIZE.menu} aria-hidden /> : null}
      <div className="feedback-state-copy">
        <div className="feedback-state-title">{title}</div>
        {body ? <div className="feedback-state-body">{body}</div> : null}
      </div>
      {action ? <div className="feedback-state-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  className,
  message,
  onRetry,
  retryLabel = 'Retry',
  size = 'panel',
}: ErrorStateProps) {
  return (
    <EmptyState
      action={onRetry ? (
        <Button onClick={onRetry} size="sm" variant="ghost">
          {retryLabel}
        </Button>
      ) : undefined}
      className={cx('is-error', className)}
      icon={WarningIcon}
      role="alert"
      size={size}
      title={message}
    />
  );
}
