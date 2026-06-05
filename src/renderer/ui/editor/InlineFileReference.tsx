import {
  INLINE_FILE_ICON_CLASS,
  INLINE_FILE_NAME_CLASS,
  inlineFileIconKind,
} from './inlineFileIcon';
import {
  inlineFilePreviewAttrs,
  localFileReferenceHref,
  type InlineFilePreviewDescriptor,
} from './inlineFilePreviewData';

interface InlineFileReferenceProps {
  className?: string;
  extraAttrs?: Record<string, string>;
  file: InlineFilePreviewDescriptor & {
    kind?: 'file' | 'image' | 'inline_text';
    mimeType: string;
    name: string;
    ref?: string;
  };
}

export function InlineFileReference({ className = '', extraAttrs = {}, file }: InlineFileReferenceProps) {
  const entryKind = file.entryKind ?? (file.mimeType === 'inode/directory' ? 'directory' : 'file');
  const attrs = inlineFilePreviewAttrs({ ...file, entryKind });
  const iconKind = inlineFileIconKind({
    entryKind,
    mimeType: file.mimeType,
    name: file.name,
  });
  const content = (
    <>
      <span
        aria-hidden="true"
        className={INLINE_FILE_ICON_CLASS}
        data-file-icon-kind={iconKind}
      />
      <span className={INLINE_FILE_NAME_CLASS}>{file.name}</span>
    </>
  );
  const title = file.name;
  const nextClassName = ['inline-ref', className].filter(Boolean).join(' ');

  if (file.path) {
    return (
      <a
        {...attrs}
        {...extraAttrs}
        aria-label={file.name}
        className={nextClassName}
        href={localFileReferenceHref(file.path, entryKind)}
        title={title}
      >
        {content}
      </a>
    );
  }

  return (
    <span
      {...attrs}
      {...extraAttrs}
      aria-label={file.name}
      className={nextClassName}
      title={title}
    >
      {content}
    </span>
  );
}
