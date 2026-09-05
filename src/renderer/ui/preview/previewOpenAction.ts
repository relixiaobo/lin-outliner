import type { PreviewSourceDescriptor, PreviewTarget } from '../../../core/preview';
import { OpenInBrowserIcon, OpenInDefaultAppIcon } from '../icons';
import type { FilePreviewMenuAction } from './FilePreviewPill';

export function previewOpenAction(
  target: Pick<PreviewTarget | PreviewSourceDescriptor, 'kind'>,
  labels: { openInBrowser: string; openWithDefault: string },
  run: () => void,
): FilePreviewMenuAction {
  const browser = target.kind === 'url';
  return {
    key: 'open', label: browser ? labels.openInBrowser : labels.openWithDefault,
    icon: browser ? OpenInBrowserIcon : OpenInDefaultAppIcon, run,
  };
}
