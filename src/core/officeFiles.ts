export interface OfficeOwnershipFileInfo {
  readonly name: string;
  readonly suggestedName: string;
}

const OFFICE_DOCUMENT_EXTENSIONS = new Set([
  '.doc',
  '.docm',
  '.docx',
  '.dot',
  '.dotm',
  '.dotx',
  '.pot',
  '.potm',
  '.potx',
  '.pps',
  '.ppsm',
  '.ppsx',
  '.ppt',
  '.pptm',
  '.pptx',
  '.xls',
  '.xlsb',
  '.xlsm',
  '.xlsx',
  '.xlt',
  '.xltm',
  '.xltx',
]);

export function officeOwnershipFileInfo(pathOrName: string): OfficeOwnershipFileInfo | null {
  const name = pathOrName.split(/[\\/]/).at(-1) ?? pathOrName;
  if (!name.startsWith('.~') && !name.startsWith('~$')) return null;
  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex < 2) return null;
  const extension = name.slice(extensionIndex).toLowerCase();
  if (!OFFICE_DOCUMENT_EXTENSIONS.has(extension)) return null;
  const suggestedName = name.slice(2);
  return suggestedName.length > extension.length ? { name, suggestedName } : null;
}

export function isOfficeOwnershipFile(pathOrName: string): boolean {
  return officeOwnershipFileInfo(pathOrName) !== null;
}
