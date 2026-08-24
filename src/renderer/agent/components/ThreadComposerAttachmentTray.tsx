import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ThreadAttachmentContent } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { inlineFileIconKind, type InlineFileIconKind } from '../../ui/editor/inlineFileIcon';
import { inlineFilePreviewAttrs } from '../../ui/editor/inlineFilePreviewData';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DatabaseIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  ICON_SIZE,
  LoaderIcon,
  PresentationIcon,
  type AppIcon,
} from '../../ui/icons';
import type {
  ThreadComposerDraft,
  ThreadComposerFileReference,
  ThreadComposerPendingFileReference,
} from './ThreadComposerEditor';

export interface ThreadComposerAttachmentTrayPending extends ThreadComposerPendingFileReference {
  readonly excerpt: string;
}

interface ThreadComposerAttachmentTrayProps {
  readonly attachments: readonly ThreadAttachmentContent[];
  readonly draft: ThreadComposerDraft;
  readonly pending: readonly ThreadComposerAttachmentTrayPending[];
  readonly previewUrls: ReadonlyMap<string, string>;
  readonly textExcerpts: ReadonlyMap<string, string>;
  readonly threadId: string;
  readonly onRemovalPreviewChange: (identity: string | null) => void;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onRemovePending: (requestId: string) => void;
}

type TrayItem =
  | {
    readonly attachment: ThreadAttachmentContent;
    readonly excerpt?: string;
    readonly identity: string;
    readonly kind: 'attachment';
    readonly previewUrl?: string;
    readonly reference: ThreadComposerFileReference;
  }
  | {
    readonly excerpt: string;
    readonly identity: string;
    readonly kind: 'pending';
    readonly name: string;
  };

export function ThreadComposerAttachmentTray({
  attachments,
  draft,
  onRemovalPreviewChange,
  onRemoveAttachment,
  onRemovePending,
  pending,
  previewUrls,
  textExcerpts,
  threadId,
}: ThreadComposerAttachmentTrayProps) {
  const t = useT();
  const scrollRef = useRef<HTMLUListElement>(null);
  const previousLengthRef = useRef(0);
  const [edges, setEdges] = useState({ left: false, right: false });
  const items = useMemo(() => projectTrayItems({
    attachments,
    draft,
    pending,
    previewUrls,
    textExcerpts,
  }), [attachments, draft, pending, previewUrls, textExcerpts]);
  const hasItems = items.length > 0;

  useLayoutEffect(() => {
    const previousLength = previousLengthRef.current;
    previousLengthRef.current = items.length;
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (items.length > previousLength) {
      scroll.querySelector<HTMLElement>(`[data-attachment-tray-index="${items.length - 1}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    updateScrollEdges(scroll, setEdges);
  }, [items.length]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const update = () => updateScrollEdges(scroll, setEdges);
    const observer = new ResizeObserver(() => {
      const focused = scroll.querySelector<HTMLElement>('[data-attachment-tray-main]:focus');
      focused?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      update();
    });
    observer.observe(scroll);
    scroll.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', update);
    };
  }, [hasItems]);

  if (!hasItems) return null;

  const scrollByTile = (direction: -1 | 1) => {
    scrollRef.current?.scrollBy({ left: direction * 184 });
  };

  return (
    <div className="thread-composer-attachment-tray-shell">
      {edges.left ? (
        <button
          aria-label={t.agent.composer.showPreviousAttachments}
          className="thread-composer-attachment-edge is-left"
          onClick={() => scrollByTile(-1)}
          type="button"
        >
          <ChevronLeftIcon size={ICON_SIZE.menu} />
        </button>
      ) : null}
      <ul
        aria-label={t.agent.composer.attachmentTrayLabel}
        className="thread-composer-attachment-tray"
        onKeyDown={handleTrayKeyDown}
        ref={scrollRef}
      >
        {items.map((item, index) => (
          <TrayItemView
            index={index}
            item={item}
            key={`${item.kind}:${item.identity}`}
            labels={t.agent.composer}
            onRemovalPreviewChange={onRemovalPreviewChange}
            onRemove={() => item.kind === 'attachment'
              ? onRemoveAttachment(item.identity)
              : onRemovePending(item.identity)}
            threadId={threadId}
          />
        ))}
      </ul>
      {edges.right ? (
        <button
          aria-label={t.agent.composer.showMoreAttachments}
          className="thread-composer-attachment-edge is-right"
          onClick={() => scrollByTile(1)}
          type="button"
        >
          <ChevronRightIcon size={ICON_SIZE.menu} />
        </button>
      ) : null}
    </div>
  );
}

function TrayItemView({
  index,
  item,
  labels,
  onRemovalPreviewChange,
  onRemove,
  threadId,
}: {
  readonly index: number;
  readonly item: TrayItem;
  readonly labels: ReturnType<typeof useT>['agent']['composer'];
  readonly onRemovalPreviewChange: (identity: string | null) => void;
  readonly onRemove: () => void;
  readonly threadId: string;
}) {
  const name = item.kind === 'attachment' ? item.attachment.name : item.name;
  const previewAttrs = item.kind === 'attachment'
    ? inlineFilePreviewAttrs({
      attachmentId: item.attachment.id,
      entryKind: item.reference.entryKind,
      iconDataUrl: item.reference.iconDataUrl,
      mimeType: item.attachment.mimeType,
      name,
      path: item.reference.path ?? (item.attachment.source.kind === 'localFile'
        ? item.attachment.source.path
        : item.attachment.name),
      ref: item.reference.ref,
      sizeBytes: item.attachment.sizeBytes,
      thumbnailDataUrl: item.previewUrl ?? item.reference.thumbnailDataUrl,
      threadId,
    })
    : {};
  return (
    <li
      className={`thread-composer-attachment-item${item.kind === 'pending' ? ' is-pending' : ''}`}
      data-attachment-tray-index={index}
    >
      <button
        {...previewAttrs}
        aria-label={item.kind === 'pending'
          ? labels.attachingAttachment({ name })
          : labels.previewAttachment({ name })}
        className="thread-composer-attachment-main"
        data-attachment-tray-main
        data-attachment-tray-index={index}
        type="button"
      >
        <TrayVisual item={item} />
        <span className="thread-composer-attachment-copy">
          <span className="thread-composer-attachment-name" title={name}>{name}</span>
          {item.excerpt ? (
            <span className="thread-composer-attachment-excerpt">{item.excerpt}</span>
          ) : (
            <span className="thread-composer-attachment-meta">{trayItemMeta(item, labels)}</span>
          )}
        </span>
      </button>
      <button
        aria-label={labels.removeAttachmentAndReference({ name })}
        className="thread-composer-attachment-remove"
        data-attachment-tray-index={index}
        onBlur={() => onRemovalPreviewChange(null)}
        onClick={() => {
          onRemovalPreviewChange(null);
          onRemove();
        }}
        onFocus={() => onRemovalPreviewChange(item.identity)}
        onMouseEnter={() => onRemovalPreviewChange(item.identity)}
        onMouseLeave={() => onRemovalPreviewChange(null)}
        type="button"
      >
        <CloseIcon size={ICON_SIZE.tiny} />
      </button>
    </li>
  );
}

function TrayVisual({ item }: { readonly item: TrayItem }) {
  if (item.kind === 'pending') {
    return (
      <span className="thread-composer-attachment-icon is-pending" aria-hidden="true">
        <LoaderIcon size={ICON_SIZE.toolbar} />
      </span>
    );
  }
  const thumbnail = item.previewUrl ?? item.reference.thumbnailDataUrl;
  if (thumbnail && item.attachment.mimeType.startsWith('image/')) {
    return <img alt="" className="thread-composer-attachment-thumbnail" src={thumbnail} />;
  }
  if (item.reference.iconDataUrl) {
    return <img alt="" className="thread-composer-attachment-native-icon" src={item.reference.iconDataUrl} />;
  }
  const Icon = iconForKind(inlineFileIconKind({
    entryKind: item.reference.entryKind,
    mimeType: item.attachment.mimeType,
    name: item.attachment.name,
  }));
  return (
    <span className="thread-composer-attachment-icon" aria-hidden="true">
      <Icon size={ICON_SIZE.toolbar} />
    </span>
  );
}

function projectTrayItems({
  attachments,
  draft,
  pending,
  previewUrls,
  textExcerpts,
}: Pick<ThreadComposerAttachmentTrayProps, 'attachments' | 'draft' | 'pending' | 'previewUrls' | 'textExcerpts'>): TrayItem[] {
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const pendingById = new Map(pending.map((request) => [request.requestId, request]));
  const seen = new Set<string>();
  return draft.content.flatMap((part): TrayItem[] => {
    if (part.type === 'fileReference') {
      const identity = part.reference.attachmentId;
      const attachment = attachmentsById.get(identity);
      if (!attachment || seen.has(identity)) return [];
      seen.add(identity);
      const previewUrl = previewUrls.get(identity);
      const excerpt = textExcerpts.get(identity);
      return [{
        attachment,
        ...(excerpt ? { excerpt } : {}),
        identity,
        kind: 'attachment',
        ...(previewUrl ? { previewUrl } : {}),
        reference: part.reference,
      }];
    }
    if (part.type === 'pendingFileReference') {
      const identity = part.reference.requestId;
      const request = pendingById.get(identity);
      if (!request || seen.has(identity)) return [];
      seen.add(identity);
      return [{ excerpt: request.excerpt, identity, kind: 'pending', name: request.name }];
    }
    return [];
  });
}

function trayItemMeta(
  item: TrayItem,
  labels: ReturnType<typeof useT>['agent']['composer'],
): string {
  if (item.kind === 'pending') return labels.attachmentStatusAttaching;
  const type = item.reference.entryKind === 'directory'
    ? labels.attachmentKindFolder
    : item.attachment.mimeType || labels.attachmentKindFile;
  if (item.reference.entryKind === 'directory' || item.attachment.sizeBytes <= 0) return type;
  return `${type} - ${formatBytes(item.attachment.sizeBytes)}`;
}

function handleTrayKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
  if (event.key === 'Escape') {
    (event.currentTarget.ownerDocument.activeElement as HTMLElement | null)?.blur();
    return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const target = event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>('[data-attachment-tray-index]')
    : null;
  const index = Number(target?.dataset.attachmentTrayIndex);
  if (!Number.isInteger(index)) return;
  const nextIndex = index + (event.key === 'ArrowLeft' ? -1 : 1);
  const next = event.currentTarget.querySelector<HTMLElement>(
    `[data-attachment-tray-main][data-attachment-tray-index="${nextIndex}"]`,
  );
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateScrollEdges(
  scroll: HTMLElement,
  setEdges: Dispatch<SetStateAction<{ left: boolean; right: boolean }>>,
): void {
  const left = scroll.scrollLeft > 1;
  const right = scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 1;
  setEdges((current) => current.left === left && current.right === right ? current : { left, right });
}

function iconForKind(kind: InlineFileIconKind): AppIcon {
  if (kind === 'archive') return FileArchiveIcon;
  if (kind === 'audio') return FileAudioIcon;
  if (kind === 'code') return FileCodeIcon;
  if (kind === 'database') return DatabaseIcon;
  if (kind === 'folder') return FolderIcon;
  if (kind === 'image') return FileImageIcon;
  if (kind === 'presentation') return PresentationIcon;
  if (kind === 'spreadsheet') return FileSpreadsheetIcon;
  if (kind === 'video') return FileVideoIcon;
  return FileTextIcon;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
