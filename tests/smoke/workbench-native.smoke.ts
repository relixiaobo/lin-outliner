import { expect, test } from '@playwright/test';
import { closeSmokeApp, launchSmokeApp } from './electronApp';

test('the built Host manages Projects and ordinary Goals with fresh isolated storage', async () => {
  const smoke = await launchSmokeApp();
  try {
    await expect.poll(() => smoke.window.evaluate(() => window.lin!.startup.get())).toEqual({ status: 'ready' });
    const result = await smoke.window.evaluate(async (rootHint) => {
      const api = window.lin!;
      const project = (await api.agentCoreRequest('project/manage', { operation: 'create', name: 'Native workflow', rootHint })).project!;
      const { thread } = await api.agentCoreRequest('thread/start', { name: 'Native workflow Chat', modelProvider: 'openai',
        project: { projectId: project.id, expectedRevision: project.revision } });
      const bound = await api.agentCoreRequest('project/inspect', { threadIds: [thread.id] });
      const created = await api.agentCoreRequest('goal/create', { threadId: thread.id, objective: 'Inspect this isolated fixture', tokenBudget: 1000 });
      const inspected = await api.agentCoreRequest('goal/get', { threadId: thread.id });
      const completed = await api.agentCoreRequest('goal/update', { threadId: thread.id, status: 'complete' });
      await api.agentCoreRequest('project/manage', { operation: 'delete', projectId: project.id, expectedRevision: project.revision });
      const detached = await api.agentCoreRequest('project/inspect', { threadIds: [thread.id] });
      const threads = await api.agentCoreRequest('thread/list', {});
      return { project, threadId: thread.id, bound, created, inspected, completed, detached,
        chatRetained: threads.data.some((entry) => entry.id === thread.id) };
    }, smoke.userDataDir);
    expect(result.bound.memberships[0]?.projectId).toBe(result.project.id);
    expect(result.created).toEqual(result.inspected);
    expect(result.inspected.goal).toMatchObject({ status: 'active', tokenBudget: 1000, tokensUsed: 0 });
    expect(result.inspected).not.toHaveProperty('verification');
    expect(result.completed.goal.status).toBe('complete');
    expect(result.detached.projects).toEqual([]);
    expect(result.detached.memberships[0]?.projectId).toBeNull();
    expect(result.chatRetained).toBe(true);
  } finally { await closeSmokeApp(smoke); }
});
