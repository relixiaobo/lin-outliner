import { expect, test, type Locator, type Page } from '@playwright/test';
import { commandCalls, emitOAuthEvent, installElectronMock, resolveOAuthLogin } from './outlinerMock';

// The provider config window renders a sign-in surface (ProviderOAuthForm) instead
// of the API-key form for providers whose `authKind` is `oauth`. main owns the real
// sign-in; the renderer subscribes to the main->renderer event stream, renders each
// interactive step, and answers the reply-needed ones. These specs drive that stream
// through the mock bridge (emitOAuthEvent / resolveOAuthLogin) so the whole flow is
// deterministic — no real provider, browser, timers, or network.
test.describe('provider OAuth sign-in', () => {
  test('renders a sign-in surface, not a key field, for an oauth provider', async ({ page }) => {
    const config = await openOAuthConfig(page);
    await expect(config.getByRole('heading', { name: /GitHub Copilot/ })).toBeVisible();
    // No key field — the credential is obtained by sign-in.
    await expect(config.getByLabel('API key')).toHaveCount(0);
    await expect(config.getByText(/Sign in with your GitHub account/)).toBeVisible();
    await expect(config.getByRole('button', { name: 'Sign in to GitHub Copilot' })).toBeVisible();
  });

  test('device-code flow shows the code, then resolves to the connected state', async ({ page }) => {
    const config = await openOAuthConfig(page);
    await config.getByRole('button', { name: 'Sign in to GitHub Copilot' }).click();

    // main pushes the device code + verification URL; the form shows both.
    await emitOAuthEvent(page, 'github-copilot', {
      kind: 'device-code',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresInSeconds: 900,
    });
    await expect(config.getByText('WDJB-MJHT')).toBeVisible();
    await expect(config.getByRole('button', { name: /github\.com\/login\/device/ })).toBeVisible();

    // A progress line replaces nothing — the code stays visible while we wait.
    await emitOAuthEvent(page, 'github-copilot', { kind: 'progress', message: 'Waiting for authorization…' });
    await expect(config.getByText('Waiting for authorization…')).toBeVisible();
    await expect(config.getByText('WDJB-MJHT')).toBeVisible();

    // login() resolved → connected state with sign-out, no key ever shown.
    await resolveOAuthLogin(page, 'github-copilot');
    await expect(config.getByText('Connected', { exact: true })).toBeVisible();
    await expect(config.getByText(/Access renews/)).toBeVisible();
    await expect(config.getByRole('button', { name: 'Sign out' })).toBeVisible();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_oauth_login')?.args;
    }).toMatchObject({ providerId: 'github-copilot' });
  });

  test('loopback flow opens the sign-in URL and offers to re-open it', async ({ page }) => {
    const config = await openOAuthConfig(page);
    await config.getByRole('button', { name: 'Sign in to GitHub Copilot' }).click();

    await emitOAuthEvent(page, 'github-copilot', {
      kind: 'auth',
      url: 'https://github.com/login/oauth/authorize?code=abc',
    });

    // The form both auto-opens the URL (via the external-url IPC) and renders a
    // manual re-open affordance.
    await expect(config.getByRole('button', { name: /Open the sign-in page/ })).toBeVisible();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_external_url')?.args;
    }).toMatchObject({ url: 'https://github.com/login/oauth/authorize?code=abc' });
  });

  test('a select reply step answers through agent_oauth_respond', async ({ page }) => {
    const config = await openOAuthConfig(page);
    await config.getByRole('button', { name: 'Sign in to GitHub Copilot' }).click();

    await emitOAuthEvent(page, 'github-copilot', {
      kind: 'select',
      requestId: 'oauth:github-copilot:1',
      message: 'Choose an account',
      options: [
        { id: 'personal', label: 'Personal account' },
        { id: 'work', label: 'Work org' },
      ],
    });
    await expect(config.getByText('Choose an account')).toBeVisible();
    await config.getByRole('button', { name: 'Work org' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_oauth_respond')?.args;
    }).toMatchObject({ requestId: 'oauth:github-copilot:1', value: 'work' });
  });

  test('cancelling an in-flight sign-in returns to the disconnected state', async ({ page }) => {
    const config = await openOAuthConfig(page);
    await config.getByRole('button', { name: 'Sign in to GitHub Copilot' }).click();
    await emitOAuthEvent(page, 'github-copilot', { kind: 'progress', message: 'Waiting for authorization…' });

    await config.getByRole('button', { name: 'Cancel sign-in' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'agent_oauth_cancel');
    }).toBe(true);
    // The flow unwinds back to the sign-in button (no lingering error).
    await expect(config.getByRole('button', { name: 'Sign in to GitHub Copilot' })).toBeVisible();
  });

  test('signing out drops the credential and returns to sign-in', async ({ page }) => {
    const config = await openOAuthConfig(page);
    await config.getByRole('button', { name: 'Sign in to GitHub Copilot' }).click();
    await resolveOAuthLogin(page, 'github-copilot');
    await expect(config.getByRole('button', { name: 'Sign out' })).toBeVisible();

    await config.getByRole('button', { name: 'Sign out' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_oauth_logout')?.args;
    }).toMatchObject({ providerId: 'github-copilot' });
    await expect(config.getByRole('button', { name: 'Sign in to GitHub Copilot' })).toBeVisible();
  });
});

async function openOAuthConfig(page: Page): Promise<Locator> {
  await installElectronMock(page, { oauthProvider: true });
  await page.goto('/?surface=provider-config&provider=github-copilot&mode=configure');
  const config = page.locator('.provider-config-window');
  await expect(config).toBeVisible();
  // Wait for the sign-in surface (after the provider-settings fetch resolves).
  await expect(config.getByRole('button', { name: 'Sign in to GitHub Copilot' })).toBeVisible();
  return config;
}
