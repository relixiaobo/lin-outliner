import { expect, test, type Page } from '@playwright/test';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

type AgentConfigParams = { agentId?: string; mode: 'create' | 'configure' };
type ChannelConfigParams = { conversationId?: string; mode: 'create' | 'configure' };

function surfaceFor(page: Page): string | null {
  try {
    return new URL(page.url()).searchParams.get('surface');
  } catch {
    return null;
  }
}

async function waitForSurface(smoke: SmokeApp, surface: string): Promise<Page> {
  await expect.poll(() => smoke.app.windows().filter((page) => surfaceFor(page) === surface).length).toBe(1);
  const page = smoke.app.windows().find((candidate) => surfaceFor(candidate) === surface);
  if (!page) throw new Error(`Missing ${surface} window`);
  await page.locator('#root').waitFor();
  return page;
}

async function countSurfaceWindows(smoke: SmokeApp, surface: string): Promise<number> {
  return smoke.app.windows().filter((page) => surfaceFor(page) === surface).length;
}

async function openAgentConfig(page: Page, params: AgentConfigParams) {
  await page.evaluate(async (input) => {
    const lin = (window as unknown as {
      lin?: { openAgentConfig?: (params: AgentConfigParams) => Promise<void> };
    }).lin;
    await lin?.openAgentConfig?.(input);
  }, params);
}

async function openChannelConfig(page: Page, params: ChannelConfigParams) {
  await page.evaluate(async (input) => {
    const lin = (window as unknown as {
      lin?: { openChannelConfig?: (params: ChannelConfigParams) => Promise<void> };
    }).lin;
    await lin?.openChannelConfig?.(input);
  }, params);
}

async function closeAgentConfig(page: Page) {
  await page.evaluate(async () => {
    const lin = (window as unknown as { lin?: { closeAgentConfig?: () => Promise<void> } }).lin;
    await lin?.closeAgentConfig?.();
  });
}

async function closeChannelConfig(page: Page) {
  await page.evaluate(async () => {
    const lin = (window as unknown as { lin?: { closeChannelConfig?: () => Promise<void> } }).lin;
    await lin?.closeChannelConfig?.();
  });
}

async function windowQuery(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => Object.fromEntries(new URLSearchParams(window.location.search)));
}

async function rendererSecurity(page: Page) {
  return page.evaluate(() => ({
    lin: typeof (window as unknown as { lin?: unknown }).lin,
    process: typeof (window as unknown as { process?: unknown }).process,
    require: typeof (window as unknown as { require?: unknown }).require,
  }));
}

test.describe('agent and Channel config child windows', () => {
  let smoke: SmokeApp;

  test.beforeEach(async () => {
    smoke = await launchSmokeApp();
    await smoke.window.locator('#root').waitFor();
  });

  test.afterEach(async () => {
    await closeSmokeApp(smoke);
  });

  test('opens agent config as a secure singleton child window', async () => {
    await openAgentConfig(smoke.window, { agentId: 'user:mock:self', mode: 'configure' });
    const first = await waitForSurface(smoke, 'agent-config');

    await expect.poll(async () => windowQuery(first)).toMatchObject({
      surface: 'agent-config',
      agent: 'user:mock:self',
      mode: 'configure',
    });
    await expect.poll(async () => rendererSecurity(first)).toEqual({
      lin: 'object',
      process: 'undefined',
      require: 'undefined',
    });

    const firstClosed = first.waitForEvent('close');
    await openAgentConfig(smoke.window, { mode: 'create' });
    await firstClosed;
    const second = await waitForSurface(smoke, 'agent-config');
    await expect.poll(async () => countSurfaceWindows(smoke, 'agent-config')).toBe(1);
    await expect.poll(async () => windowQuery(second)).toMatchObject({
      surface: 'agent-config',
      agent: '',
      mode: 'create',
    });

    const secondClosed = second.isClosed() ? Promise.resolve() : second.waitForEvent('close');
    await closeAgentConfig(smoke.window);
    await secondClosed;
    await expect.poll(async () => countSurfaceWindows(smoke, 'agent-config')).toBe(0);
  });

  test('opens Channel config as a secure singleton child window', async () => {
    await openChannelConfig(smoke.window, { conversationId: 'mock-agent-channel-planning', mode: 'configure' });
    const first = await waitForSurface(smoke, 'channel-config');

    await expect.poll(async () => windowQuery(first)).toMatchObject({
      surface: 'channel-config',
      conversation: 'mock-agent-channel-planning',
      mode: 'configure',
    });
    await expect.poll(async () => rendererSecurity(first)).toEqual({
      lin: 'object',
      process: 'undefined',
      require: 'undefined',
    });

    const firstClosed = first.waitForEvent('close');
    await openChannelConfig(smoke.window, { mode: 'create' });
    await firstClosed;
    const second = await waitForSurface(smoke, 'channel-config');
    await expect.poll(async () => countSurfaceWindows(smoke, 'channel-config')).toBe(1);
    await expect.poll(async () => windowQuery(second)).toMatchObject({
      surface: 'channel-config',
      conversation: '',
      mode: 'create',
    });

    const secondClosed = second.isClosed() ? Promise.resolve() : second.waitForEvent('close');
    await closeChannelConfig(smoke.window);
    await secondClosed;
    await expect.poll(async () => countSurfaceWindows(smoke, 'channel-config')).toBe(0);
  });
});
