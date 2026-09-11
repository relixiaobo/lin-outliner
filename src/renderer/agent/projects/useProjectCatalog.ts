import { useCallback, useEffect, useState } from 'react';
import type { ProjectCatalogView, ProjectManageRequest } from '../../../core/agent/project';
import { api } from '../../api/client';

const changed = new Set<() => void>();
const EMPTY_CATALOG: ProjectCatalogView = { projects: [], memberships: [], workFolders: [], unavailableFolders: [], applicationDefault: { path: null, available: false } };
export function invalidateProjectCatalog(): void { for (const listener of changed) listener(); }
export async function manageProject(request: ProjectManageRequest) {
  const result = await api.agentCoreRequest('project/manage', request);
  invalidateProjectCatalog();
  return result;
}

export function useProjectCatalog(threadIds: readonly string[] = []) {
  const key = [...new Set(threadIds)].sort().join(',');
  const [view, setView] = useState<ProjectCatalogView>(EMPTY_CATALOG);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    changed.add(refresh);
    window.addEventListener('focus', refresh);
    const unsubscribe = api.onAgentCoreNotification((notification) => {
      if (notification.type === 'turn/completed' || notification.type === 'thread/started' || notification.type === 'project/catalog/changed') refresh();
    });
    return () => { changed.delete(refresh); window.removeEventListener('focus', refresh); unsubscribe(); };
  }, [refresh]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const ids = key ? key.split(',') : [];
    const pages = ids.length ? Array.from({ length: Math.ceil(ids.length / 200) }, (_, index) => ids.slice(index * 200, index * 200 + 200)) : [[]];
    void Promise.all(pages.map((threadIds) => api.agentCoreRequest('project/inspect', { threadIds })))
      .then((views) => {
        if (!live) return;
        setView({ ...views[0]!, memberships: views.flatMap((entry) => entry.memberships),
          workFolders: views.flatMap((entry) => entry.workFolders),
          unavailableFolders: [...new Set(views.flatMap((entry) => entry.unavailableFolders))] });
        setError(null);
      }).catch((error: unknown) => { if (live) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [key, revision]);
  return { view, error, loading, refresh };
}
