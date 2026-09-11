import type { ProjectCatalogView } from '../../../core/agent/project';

export function conversationLocationLabel(threadId: string, view: ProjectCatalogView, labels: {
  applicationDefault: string; unavailable: string; loading: string;
}): { project: string; location: string; text: string; detail: string; unavailable: boolean } {
  const membership = view.memberships.find((entry) => entry.threadId === threadId);
  if (!membership) return { project: '', location: labels.loading, text: labels.loading, detail: labels.loading, unavailable: false };
  const project = view.projects.find((entry) => entry.id === membership.projectId);
  if (membership.projectId && !project) return { project: labels.unavailable, location: '', text: labels.unavailable, detail: labels.unavailable, unavailable: true };
  const folder = project?.primaryFolder ?? null;
  const projectName = project?.name ?? (membership.projectId ? labels.unavailable : '');
  const unavailable = folder ? view.unavailableFolders.includes(folder) : !view.applicationDefault.available;
  const location = project && !folder ? labels.applicationDefault : '';
  const showUnavailable = unavailable && Boolean(projectName);
  const text = [projectName, location, showUnavailable ? labels.unavailable : ''].filter(Boolean).join(' · ');
  return { project: projectName, location, text, unavailable: showUnavailable,
    detail: [text, folder ?? `${labels.applicationDefault}: ${view.applicationDefault.path ?? labels.unavailable}`].filter(Boolean).join('\n') };
}
