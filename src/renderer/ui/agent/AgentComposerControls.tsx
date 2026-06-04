import type { ChangeEvent, ReactNode, RefObject } from 'react';
import type { AgentReasoningLevel } from '../../api/types';
import {
  AttachmentIcon,
  ChevronDownIcon,
  ICON_SIZE,
  PencilIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { reasoningLabels } from './AgentComposerModelMenu';
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

export function AgentComposerModelButton({
  disabled,
  modelLabel,
  modelTitle,
  onToggle,
  open,
  reasoningEnabled,
  selectedReasoning,
  supportsReasoning,
}: {
  disabled: boolean;
  modelLabel: string;
  modelTitle: string;
  onToggle: () => void;
  open: boolean;
  reasoningEnabled: boolean;
  selectedReasoning: AgentReasoningLevel;
  supportsReasoning: boolean;
}) {
  const t = useT();
  return (
    <ButtonControl
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={t.agent.composer.selectModel}
      className="agent-composer-model-button"
      disabled={disabled}
      onClick={onToggle}
      title={modelTitle}
    >
      <span className="agent-composer-model-name">{modelLabel}</span>
      {supportsReasoning && reasoningEnabled ? (
        <span className="agent-composer-reasoning-chip">{reasoningLabels(t.agent.composer.reasoningLevels)[selectedReasoning]}</span>
      ) : null}
      <ChevronDownIcon size={ICON_SIZE.tiny} />
    </ButtonControl>
  );
}

export function AgentComposerToolbar({
  attachmentDisabled,
  fileInputRef,
  modelControl,
  onAttachmentClick,
  onFileInputChange,
  primaryAction,
}: {
  attachmentDisabled: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  modelControl: ReactNode;
  onAttachmentClick: () => void;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
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
        {primaryAction}
      </div>
    </div>
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
        iconSize={10}
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
