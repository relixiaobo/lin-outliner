import type { Project, ProjectCatalogView } from '../../../core/agent/project';
import { manageProject } from './useProjectCatalog';

const KEY = 'tenon.recent-projects.v1';
const LIMIT = 6;

export function readRecentProjectIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, LIMIT) : [];
  } catch { return []; }
}

export function rememberProject(id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify([id, ...readRecentProjectIds().filter((entry) => entry !== id)].slice(0, LIMIT))); }
  catch { /* Recent choices are optional UI metadata, never selection authority. */ }
}

export function recentProjects(projects: readonly Project[], currentId: string | null): Project[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const ids = readRecentProjectIds();
  if (currentId && !ids.includes(currentId)) ids.unshift(currentId);
  return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []).slice(0, LIMIT);
}

export async function selectConversationProject(threadId: string, project: Project | null, view: ProjectCatalogView): Promise<void> {
  const membership = view.memberships.find((entry) => entry.threadId === threadId);
  if (!membership) throw new Error('Conversation Project is unavailable; reopen Projects');
  await manageProject({ operation: 'bind', threadId, projectId: project?.id ?? null,
    expectedRevision: project?.revision ?? null, expectedMembershipRevision: membership.revision });
  if (project) rememberProject(project.id);
}
