import type { ChangeEvent, ReactNode, RefObject } from 'react';
import {
  AttachmentIcon,
  PencilIcon,
  PlayIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
} from '../icons';
import { IconButton } from '../primitives/IconButton';
import { useT } from '../../i18n/I18nProvider';

export function AgentQueuedSteer({
  note,
  onCancel,
  onEdit,
}: {
  note: string;
  onCancel: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  return (
    <div className="agent-steer-bubble">
      <div className="agent-steer-actions">
        <IconButton
          className="agent-message-action-button"
          icon={PencilIcon}
          label={t.agent.composer.editQueuedSteer}
          onClick={onEdit}
          title={t.agent.composer.editQueuedSteer}
          variant="message"
        />
        <IconButton
          className="agent-message-action-button"
          icon={TrashIcon}
          label={t.agent.composer.cancelQueuedSteer}
          onClick={onCancel}
          title={t.agent.composer.cancelQueuedSteer}
          variant="message"
        />
      </div>
      <div className="agent-steer-preview">{note}</div>
    </div>
  );
}

export function AgentComposerAttachmentButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <IconButton
      className="agent-composer-tool-button"
      disabled={disabled}
      icon={AttachmentIcon}
      label={t.agent.composer.addAttachment}
      onClick={onClick}
      title={t.agent.composer.addAttachment}
      variant="composerTool"
    />
  );
}

export function AgentComposerToolbar({
  attachmentDisabled,
  fileInputRef,
  modelControl,
  onAttachmentClick,
  onFileInputChange,
  goalAction,
  primaryAction,
}: {
  attachmentDisabled: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** The quick model/reasoning chip; omitted when no agent profile is editable yet. */
  modelControl?: ReactNode;
  onAttachmentClick: () => void;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  goalAction?: ReactNode;
  primaryAction: ReactNode;
}) {
  return (
    <div className="agent-composer-toolbar">
      <input
        ref={fileInputRef}
        className="agent-composer-file-input"
        multiple
        onChange={onFileInputChange}
        type="file"
      />
      <AgentComposerAttachmentButton
        disabled={attachmentDisabled}
        onClick={onAttachmentClick}
      />
      <div className="agent-composer-spacer" />
      <div className="agent-composer-control-group">
        {modelControl}
        {goalAction}
        {primaryAction}
      </div>
    </div>
  );
}

export function AgentComposerGoalAction({
  canStartGoal,
  onStartGoal,
}: {
  canStartGoal: boolean;
  onStartGoal: () => void;
}) {
  const t = useT();
  return (
    <IconButton
      className="agent-composer-tool-button agent-composer-goal-button"
      disabled={!canStartGoal}
      icon={PlayIcon}
      label={t.agent.composer.startGoal}
      onClick={onStartGoal}
      title={t.agent.composer.startGoal}
      variant="composerTool"
    />
  );
}

export function AgentComposerPrimaryAction({
  canSubmit,
  disabledTitle,
  hasDraft,
  isStreaming,
  onStop,
}: {
  canSubmit: boolean;
  /** Tooltip shown when the action is disabled for a specific reason (e.g. no provider). */
  disabledTitle?: string;
  hasDraft: boolean;
  isStreaming: boolean;
  onStop: () => void;
}) {
  const t = useT();
  if (isStreaming && !hasDraft) {
    return (
      <IconButton
        className="agent-composer-action-button is-stop"
        icon={StopIcon}
        iconSize={14}
        label={t.agent.composer.stopAgent}
        onClick={onStop}
        strokeWidth={0}
        title={t.agent.composer.stop}
        variant="composerAction"
      />
    );
  }

  return (
    <IconButton
      className="agent-composer-action-button"
      disabled={!canSubmit}
      icon={SendIcon}
      label={isStreaming ? t.agent.composer.steerAgent : t.agent.composer.sendMessage}
      title={
        !canSubmit && disabledTitle
          ? disabledTitle
          : isStreaming
            ? t.agent.composer.steerAgent
            : t.agent.composer.send
      }
      type="submit"
      variant="composerAction"
    />
  );
}
