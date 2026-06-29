import { expect, test } from '@playwright/test';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

// Stage 1 security shell, formally smoke-tested against the built bundle:
//  - the strict prod CSP is injected on the packaged file:// document and is
//    *enforcing*;
//  - the session permission handlers allow only the app's narrow capability set
//    and deny capabilities outside it.
test.describe('security shell', () => {
  let smoke: SmokeApp;

  test.beforeAll(async () => {
    smoke = await launchSmokeApp();
    await smoke.window.locator('#root').waitFor();
  });

  test.afterAll(async () => {
    await closeSmokeApp(smoke);
  });

  test('the prod CSP is enforcing: self scripts run, inline scripts are blocked', async () => {
    // Positive control: the app's own bundle executed and React mounted, so
    // script-src 'self' is the *intended* policy, not an over-broad block. The
    // negative case below then proves it is enforcing rather than absent.
    await expect
      .poll(async () => (await smoke.window.locator('#root').innerHTML()).length)
      .toBeGreaterThan(0);

    const directive = await smoke.window.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const onViolation = (event: SecurityPolicyViolationEvent) => {
            document.removeEventListener('securitypolicyviolation', onViolation);
            resolve(event.violatedDirective);
          };
          document.addEventListener('securitypolicyviolation', onViolation);
          // Inline <script> has no nonce/hash and the policy has no
          // 'unsafe-inline', so CSP must refuse to execute it and fire a
          // violation naming script-src.
          const script = document.createElement('script');
          script.textContent = 'window.__cspInlineRan = true;';
          document.head.appendChild(script);
          script.remove();
          setTimeout(() => resolve('NO_VIOLATION'), 2000);
        }),
    );
    expect(directive).toMatch(/^script-src/);
    expect(await smoke.window.evaluate(() => '__cspInlineRan' in window)).toBe(false);
  });

  test('a permission we never allow (geolocation) is denied by the handler', async () => {
    // Geolocation is outside the renderer capability allow-list and must be
    // denied. PERMISSION_DENIED (code 1) — not POSITION_UNAVAILABLE (2) —
    // confirms a *permission* refusal, i.e. the request was rejected before any
    // provider was consulted, rather than the request being granted and then
    // failing for lack of a fix.
    // (Accepted brittleness: if a future Electron/Chromium surfaces a denied
    // request as code 2, this flips red — a useful canary, not a false pass. A
    // code-agnostic assertion would go green even if the handler started
    // granting, so we keep the strict === 1.)
    const outcome = await smoke.window.evaluate(
      () =>
        new Promise<{ ok: boolean; code: number | null }>((resolve) => {
          if (!('geolocation' in navigator)) {
            resolve({ ok: false, code: null });
            return;
          }
          navigator.geolocation.getCurrentPosition(
            () => resolve({ ok: true, code: null }),
            (error) => resolve({ ok: false, code: error.code }),
            { timeout: 3000 },
          );
          setTimeout(() => resolve({ ok: false, code: null }), 5000);
        }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(1);
  });
});
