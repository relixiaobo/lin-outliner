import type { ChangeEvent, ReactNode, RefObject } from 'react';
import type { AgentMessageAttachmentInput } from '../../../core/agentTypes';
import type { AgentReasoningLevel } from '../../api/types';
import {
  AttachmentIcon,
  ChevronDownIcon,
  CloseIcon,
  FileTextIcon,
  ICON_SIZE,
  PencilIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { REASONING_LABELS } from './AgentComposerModelMenu';

export function AgentQueuedSteer({
  note,
  onCancel,
  onEdit,
}: {
  note: string;
  onCancel: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="agent-steer-bubble">
      <div className="agent-steer-actions">
        <IconButton
          className="agent-message-action-button"
          icon={PencilIcon}
          label="Edit queued steer"
          onClick={onEdit}
          title="Edit queued steer"
          variant="message"
        />
        <IconButton
          className="agent-message-action-button"
          icon={TrashIcon}
          label="Cancel queued steer"
          onClick={onCancel}
          title="Cancel queued steer"
          variant="message"
        />
      </div>
      <div className="agent-steer-preview">{note}</div>
    </div>
  );
}

type AttachmentChipAttachment = Pick<AgentMessageAttachmentInput, 'kind' | 'name' | 'sizeBytes'> & {
  previewUrl?: string;
};

export function AgentComposerAttachmentChip({
  attachment,
  onRemove,
  sizeLabel,
}: {
  attachment: AttachmentChipAttachment;
  onRemove: () => void;
  sizeLabel: string;
}) {
  return (
    <div className="agent-attachment-chip">
      <div className="agent-attachment-preview">
        {attachment.kind === 'image' && attachment.previewUrl ? (
          <img alt="" src={attachment.previewUrl} />
        ) : (
          <FileTextIcon size={ICON_SIZE.menu} />
        )}
      </div>
      <div className="agent-attachment-meta">
        <span title={attachment.name}>{attachment.name}</span>
        <small>{sizeLabel}</small>
      </div>
      <IconButton
        className="agent-attachment-remove"
        icon={CloseIcon}
        iconSize={ICON_SIZE.tiny}
        label={`Remove ${attachment.name}`}
        onClick={onRemove}
        title="Remove attachment"
        variant="tabClose"
      />
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
  return (
    <IconButton
      className="agent-composer-tool-button"
      disabled={disabled}
      icon={AttachmentIcon}
      label="Add attachment"
      onClick={onClick}
      title="Add attachment"
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
  return (
    <ButtonControl
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label="Select model"
      className="agent-composer-model-button"
      disabled={disabled}
      onClick={onToggle}
      title={modelTitle}
    >
      <span className="agent-composer-model-name">{modelLabel}</span>
      {supportsReasoning && reasoningEnabled ? (
        <span className="agent-composer-reasoning-chip">{REASONING_LABELS[selectedReasoning]}</span>
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
  hasDraft,
  isStreaming,
  onStop,
}: {
  canSubmit: boolean;
  hasDraft: boolean;
  isStreaming: boolean;
  onStop: () => void;
}) {
  if (isStreaming && !hasDraft) {
    return (
      <IconButton
        className="agent-composer-action-button is-stop"
        icon={StopIcon}
        iconSize={10}
        label="Stop agent"
        onClick={onStop}
        strokeWidth={0}
        title="Stop"
        variant="composerAction"
      />
    );
  }

  return (
    <IconButton
      className="agent-composer-action-button"
      disabled={!canSubmit}
      icon={SendIcon}
      label={isStreaming ? 'Steer agent' : 'Send message'}
      title={isStreaming ? 'Steer agent' : 'Send'}
      type="submit"
      variant="composerAction"
    />
  );
}
