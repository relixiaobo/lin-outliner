import {
  DatabaseIcon, FileArchiveIcon, FileAudioIcon, FileCodeIcon, FileImageIcon,
  FileSpreadsheetIcon, FileTextIcon, FileVideoIcon, FolderIcon, PresentationIcon,
  type AppIcon,
} from '../icons';
import type { InlineFileIconKind } from './inlineFileIcon';

export const FILE_ICONS: Readonly<Record<InlineFileIconKind, AppIcon>> = {
  archive: FileArchiveIcon,
  audio: FileAudioIcon,
  code: FileCodeIcon,
  database: DatabaseIcon,
  folder: FolderIcon,
  image: FileImageIcon,
  presentation: PresentationIcon,
  spreadsheet: FileSpreadsheetIcon,
  text: FileTextIcon,
  video: FileVideoIcon,
};
