export function safeAttachmentFileName(name: string): string {
  const base = name.split(/[\\/]+/u).filter(Boolean).pop() ?? name;
  const safe = base.replace(/[^\w.-]+/gu, '_').replace(/^_+|_+$/gu, '');
  return safe || 'attachment';
}
