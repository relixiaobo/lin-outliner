import type { ProjectCatalogView } from '../../../core/agent/project';

export function conversationLocationLabel(threadId: string, view: ProjectCatalogView, labels: {
  applicationDefault: string; unavailable: string; loading: string;
}): { project: string; location: string; text: string; detail: string; unavailable: boolean } {
  const membership = view.memberships.find((entry) => entry.threadId === threadId);
  const folder = view.workFolders.find((entry) => entry.threadId === threadId);
  if (!membership || !folder) return { project: '', location: labels.loading, text: labels.loading, detail: labels.loading, unavailable: false };
  const project = view.projects.find((entry) => entry.id === membership.projectId);
  const projectName = project?.name ?? (membership.projectId ? labels.unavailable : '');
  const unavailable = folder.path ? view.unavailableFolders.includes(folder.path) : !view.applicationDefault.available;
  const location = folder.path
    ? project?.primaryFolder === folder.path ? '' : uniqueFolderLabel(folder.path, view.workFolders.flatMap((entry) => entry.path ? [entry.path] : []))
    : projectName ? labels.applicationDefault : '';
  const showUnavailable = unavailable && Boolean(folder.path || projectName);
  const text = [projectName, location, showUnavailable ? labels.unavailable : ''].filter(Boolean).join(' · ');
  return { project: projectName, location, text, unavailable: showUnavailable,
    detail: [text, folder.path ?? `${labels.applicationDefault}: ${view.applicationDefault.path ?? labels.unavailable}`].filter(Boolean).join('\n') };
}

export function uniqueFolderLabel(path: string, paths: readonly string[]): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  const others = [...new Set(paths)].filter((entry) => entry !== path);
  for (let count = 1; count <= parts.length; count++) {
    const suffix = parts.slice(-count).join('/');
    if (!others.some((entry) => entry.split(/[\\/]/u).filter(Boolean).slice(-count).join('/') === suffix)) return suffix;
  }
  return path;
}
